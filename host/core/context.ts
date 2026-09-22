/**
 * dsh-plugin-teamflow core — 运行期共享状态（进程单例）。
 * - runtime（agents/subagents/workspaceRegistry/agentDefaultModel/llm）：由 index=TeamflowService 的 static inject 注入（setRuntime）。
 * - runs/inFlight/activeProducts：流水线运行期 Map（跨 runner/pipeline/report/服务共享）。
 * 这是 ADR-0004「共享状态」在编排层的落点：共享对象集中、单向被 core 各模块 import（不反向）。
 */
import { slugPath, persistJournal } from '../../store.ts'
import { t } from '../locales.ts'
import { runLocaleOf } from './locale.ts'

/** 子代理/计量等宿主能力（由 TeamflowService 装配时 setRuntime 注入）。字段为鸭子类型：消费方自行窄化。 */
export const runtime: {
  agents?: any
  subagents?: any
  sessionProjections?: any
  workspaceRegistry?: any
  agentDefaultModel?: any
  llm?: any
} = {}

export function setRuntime(agents: unknown, subagents: unknown, workspaceRegistry?: unknown, agentDefaultModel?: unknown, llm?: unknown): void {
  runtime.agents = agents
  runtime.subagents = subagents
  runtime.workspaceRegistry = workspaceRegistry
  runtime.agentDefaultModel = agentDefaultModel
  runtime.llm = llm
}

/**
 * 可选能力：官方 Session 投影注册表（ctx.sessionProjections，dsh-session-projection）。
 * 单独 setter 而非并入 setRuntime——它是**可选**依赖：用 ctx.inject 在服务可用时注册，
 * 未挂载（最小 profile）时计量自动回退事件扫描，插件照常加载。
 */
export function setSessionProjections(projections: unknown): void {
  runtime.sessionProjections = projections
}

/**
 * **宿主锚点**（2026-09-21）：TeamflowService 构造时把 `ctx.baseUrl`（= 当前 profile 目录的
 * file:// URL，宿主在挂载插件树**之前**设好）与 `dshHomePath` 记下来，供 pipeline 起跑时探测本机
 * 安装环境。**为何不由 pipeline 自己拿**：pipeline 是纯编排模块，没有 ctx；且它链到宿主私有 peer
 * （report→@deepseek-ai/dsh-llm），Behavior 测试取不到 → 锚点经此单例搬运（与 setRuntime 同款，
 * 单向依赖不破）。
 * ⚠️ 不存 `process.env.DSH_HOME`：它**不是"装了 dsh 就自带"**（可选覆盖变量，装 dsh 不写它，
 * `.env` 也设不了 DSH_ 前缀），默认安装下为 undefined。baseUrl 才是权威事实。
 */
export const installCtx: { baseUrl?: string } = {}
export function setInstallCtx(ctx: unknown): void {
  const c = ctx as { baseUrl?: unknown } | null | undefined
  const url = c && typeof c.baseUrl === 'string' ? c.baseUrl : ''
  if (url) installCtx.baseUrl = url
}

/** 运行期 run 注册表（runId → Journal）。 */
export const runs = new Map()
/** 进行中的 stage 注册表（runId → `Map<stage, run>`）。**同一 run 可有多路并发子代理**（dev 并发池），
 *  故每 run 存的是 stage→handle 的表而不是单个 handle：旧形状（每 run 一个 `{run, stage}`，后启动的覆盖前一个）
 *  让取消只能停掉最后一路，兄弟继续跑到自然结束（2026-09-16 用户实测：「开发的多 agent 中断不了」）。 */
export const inFlight = new Map()
/** 登记一路在飞子代理（runAgent 拿到 handle 后调用）。 */
export function trackInFlight(runId: unknown, stage: unknown, run: unknown): void {
  if (!runId || !stage) return
  let m = inFlight.get(runId)
  if (!m) { m = new Map(); inFlight.set(runId, m) }
  m.set(stage, run)
}
/** 注销一路在飞子代理（该阶段结束时调用）；空桶顺手清掉，避免 map 常驻膨胀。 */
export function untrackInFlight(runId: unknown, stage: unknown): void {
  const m = inFlight.get(runId)
  if (!m) return
  m.delete(stage)
  if (m.size === 0) inFlight.delete(runId)
}
/** 产品级 backlog 缓存（product → BacklogStore）。 */
export const stores = new Map()
/** 产品级并发锁：product → 活跃 runId（同一产品同时只允许一条流水线）。 */
export const activeProducts = new Map()

/**
 * 取消运行（只对**本进程正在跑**的 run 有效：置 cancelled + dispose 进行中的子代理）。
 *
 * 为什么在本文件（而不是 pipeline.ts）：它只操作本文件声明的 `runs`/`inFlight`，且不引宿主私有依赖
 * ——放这里可被 `test/cancel.test.js` 直接加载做行为级断言（pipeline.ts 链到 report→`@deepseek-ai/dsh-llm`，
 * 仓库内无法 import，故取消门禁若留在那里就只能靠源码正则守）。
 *
 * `status !== 'running'` 门禁是必须的（2026-09-16）：旧实现只要 runId 在内存里就置 cancelled 并返回
 * true——对已 completed 的 run 会给 journal 打上 cancelled 标记（状态却仍是 completed），对重启后由
 * `loadJournals()` 回填的 interrupted run 则是「提示取消成功、状态永远不变」。running 是唯一的真实活动态
 * （`executePipeline` 首句同步写入，早于任何 await，故无窗口），取消失败必须对调用方可见（界面按钮与
 * `teamflow_cancel` 都据此提示），不得静默成功。
 *
 * 只置位、不改状态机：run 终态由 executePipeline 收尾落定（cancelled + 不提交 + 保留 resume 入口）。
 * 在飞子代理**全部** dispose（并发 dev 的多路都要停——只停最后一路是 2026-09-16 实测的缺陷）；
 * `dispose()` 是异步的，其 Promise 一律挂 `.catch`，避免拒绝变成未处理拒绝。
 *
 * **取消来源必须落盘**（2026-09-16 实测补充）：主线程收到 `⏹ 已取消` 的汇报后无从判断「谁取消的」，
 * 曾据错误前提怀疑「另一会话在自动续跑」（实际是人工点界面按钮）。来源三类：界面按钮（人工）、
 * 模型工具、未知（历史 run）。它进 journal.logs（可见）+ `journal.cancelSource`（随汇报一起给主线程）。
 */
export type CancelSource = 'ui' | 'tool' | 'unknown'
export function cancelRun(runId: string | null | undefined, source: CancelSource = 'unknown'): boolean {
  const j = runs.get(runId)
  if (!j || j.status !== 'running') return false
  j.cancelled = true
  j.cancelSource = source
  j.cancelRequestedAt = Date.now()
  try {
    const locale = runLocaleOf(j)
    j.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.cancelRequested', { source: t(locale, `cancelSource.${source}`) }) })
  } catch (e) { /* 日志失败不影响取消 */ }
  const live = inFlight.get(runId)
  if (live) {
    for (const run of live.values()) {
      try {
        const p = run && typeof run.dispose === 'function' ? run.dispose() : null
        if (p && typeof p.catch === 'function') p.catch(() => { /* 关闭失败不影响取消语义 */ })
      } catch (e) { /* ignore */ }
    }
  }
  persistJournal(j)
  return true
}

/** 可用的子代理 provider 名（优先 spawn）。 */
export function providerName(): string | null {
  const subagents = runtime.subagents as { list?: () => string[] } | undefined
  if (!subagents || typeof subagents.list !== 'function') return null
  const names = subagents.list()
  if (names.indexOf('spawn') !== -1) return 'spawn'
  return names.length > 0 ? names[0] : null
}

/** LlmModelInfo 鸭子形状（DSH llm.resolveModelInfo 返回；含 inputModalities）。 */
interface LlmModelInfoLike { inputModalities?: readonly string[] }

/**
 * 探测指定 provider/model 是否支持图像输入（多模态）。
 * 用途：QA/验收的视觉验证条款按能力条件化——不支持视觉的模型禁止「截图看图」（防幻觉/循环），
 * 只走 DOM 计算断言（evaluate 返回文本）；探测失败/未知 → false（安全侧）。
 */
export async function currentModelSupportsVision(provider?: string | null, model?: string | null): Promise<boolean> {
  try {
    const llm = runtime.llm as { resolveModelInfo?: (p: string, m: string) => Promise<LlmModelInfoLike | undefined | null> } | null | undefined
    if (!llm || typeof llm.resolveModelInfo !== 'function') return false
    const p = (provider && provider.trim()) || providerName()
    const m = (model && model.trim()) || (() => {
      const adm = runtime.agentDefaultModel as { currentSelection?: () => { model?: string } } | { model?: string } | null | undefined
      if (adm && typeof (adm as { currentSelection?: () => { model?: string } }).currentSelection === 'function') {
        try { return (adm as { currentSelection: () => { model?: string } }).currentSelection()?.model } catch (e) { return undefined }
      }
      return (adm as { model?: string } | undefined)?.model
    })()
    if (!p || !m) return false
    const info = await llm.resolveModelInfo(p, m)
    return !!info && Array.isArray(info.inputModalities) && info.inputModalities.includes('image')
  } catch (e) { return false }
}

/** 会话/Agent 鸭子形状（只读所需叶子字段）。 */
interface AgentSessionLike { header?: { cwd?: string }; id?: string }
interface AgentLike { session?: AgentSessionLike }

/** workspaceRegistry.resolveByPath 返回的鸭子形状。 */
interface DshWorkspace { id: string; title: string; path: string }

/**
 * 从发起会话推导工作区作用域。
 *
 * 优先级（**实际生效的只有第 2 条**）：
 * 1. workspaceRegistry.resolveByPath(cwd) → 用 workspace.id（UUID）作 projectKey
 *    —— ⚠️ **当前不可达**：宿主 `resolveByPath` 是 `async`（返回 Promise，见
 *    `packages/workspace/workspace/src/index.ts`），本函数同步调用 → `ws.id` 恒为 undefined，
 *    永远落到第 2 条。分支保留是为将来迁移（需 await + 存储 key 迁移，见 docs/TODO.md）。
 * 2. session cwd 的 basename + 短 hash（`slugPath`）—— **当前实际使用的 key**
 * 3. 兜底 'default'
 *
 * projectKey 用于 $DSH_HOME/teamflow/<projectKey>/ 目录，要求：
 * - 同一路径永远解析到同一个 key（sha1 派生，满足）
 * - 不同 cwd 即使 basename 相同也不碰撞（hash 参与，满足）
 * - 目录名安全（只含 [a-zA-Z0-9_-]）
 * ⚠️ 代价：key 绑定**路径字符串**，同一工作区换个写法（盘符大小写/软链/尾斜杠）会得到不同 key。
 */
export function workspaceScopeOf(agent: unknown): { projectKey: string; workspaceId: string | null; path: string | null } {
  const session = (agent as AgentLike | null | undefined)?.session
  const cwd = session && session.header && typeof session.header.cwd === 'string' && session.header.cwd ? session.header.cwd : undefined

  // 分支 1（当前不可达，见上方说明）：通过 workspaceRegistry 拿稳定 workspace UUID
  if (cwd && runtime.workspaceRegistry && typeof runtime.workspaceRegistry.resolveByPath === 'function') {
    try {
      const ws = runtime.workspaceRegistry.resolveByPath(cwd) as DshWorkspace | undefined
      if (ws && typeof ws.id === 'string') {
        // 目录名：workspace title（basename）+ workspace id 前 8 位（防同名碰撞）
        const safe = (ws.title || 'ws').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws'
        const idTag = ws.id.replace(/-/g, '').slice(0, 8)
        return { projectKey: `${safe}-${idTag}`, workspaceId: ws.id, path: cwd }
      }
    } catch (e) { /* resolveByPath 失败时走回退 */ }
  }

  // 回退：basename + hash(路径)
  if (cwd) {
    return { projectKey: slugPath(cwd), workspaceId: null, path: cwd }
  }

  // 兜底
  const sid = session && typeof session.id === 'string' && session.id ? session.id : null
  if (sid) {
    return { projectKey: slugPath(`session:${sid}`), workspaceId: null, path: null }
  }
  return { projectKey: 'default', workspaceId: null, path: null }
}
