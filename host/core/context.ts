/**
 * dsh-plugin-teamflow core — 运行期共享状态（进程单例）。
 * - runtime（agents/subagents/tokenMeter/workspaceRegistry）：由 index=TeamflowService 的 static inject 注入（setRuntime）。
 * - runs/inFlight/activeProducts：流水线运行期 Map（跨 runner/pipeline/report/服务共享）。
 * 这是 ADR-0004「共享状态」在编排层的落点：共享对象集中、单向被 core 各模块 import（不反向）。
 */
import { slugPath } from '../../store.ts'

/** 子代理/计量等宿主能力（由 TeamflowService 装配时 setRuntime 注入）。字段为鸭子类型：消费方自行窄化。 */
export const runtime: {
  agents?: any
  subagents?: any
  tokenMeter?: any
  workspaceRegistry?: any
} = {}

export function setRuntime(agents: unknown, subagents: unknown, tokenMeter: unknown, workspaceRegistry?: unknown): void {
  runtime.agents = agents
  runtime.subagents = subagents
  runtime.tokenMeter = tokenMeter
  runtime.workspaceRegistry = workspaceRegistry
}

/** 运行期 run 注册表（runId → Journal）。 */
export const runs = new Map()
/** 进行中的 stage 注册表（runId → { run, stage }），供取消/完成清理。 */
export const inFlight = new Map()
/** 产品级 backlog 缓存（product → BacklogStore）。 */
export const stores = new Map()
/** 产品级并发锁：product → 活跃 runId（同一产品同时只允许一条流水线）。 */
export const activeProducts = new Map()

/** 可用的子代理 provider 名（优先 spawn）。 */
export function providerName(): string | null {
  const subagents = runtime.subagents as { list?: () => string[] } | undefined
  if (!subagents || typeof subagents.list !== 'function') return null
  const names = subagents.list()
  if (names.indexOf('spawn') !== -1) return 'spawn'
  return names.length > 0 ? names[0] : null
}

/** 会话/Agent 鸭子形状（只读所需叶子字段）。 */
interface AgentSessionLike { header?: { cwd?: string }; id?: string }
interface AgentLike { session?: AgentSessionLike }

/** workspaceRegistry.resolveByPath 返回的鸭子形状。 */
interface DshWorkspace { id: string; title: string; path: string }

/**
 * 从发起会话推导工作区作用域。
 *
 * 优先级：
 * 1. workspaceRegistry.resolveByPath(cwd) → 用 workspace.id（UUID，稳定）作 projectKey
 * 2. 回退到 session cwd 的 basename + 短 hash（兼容无 workspaceRegistry 的场景）
 * 3. 兜底 'default'
 *
 * projectKey 用于 $DSH_HOME/teamflow/<projectKey>/ 目录，要求：
 * - 同一 workspace 永远解析到同一个 key（UUID 天然满足）
 * - 不同 workspace 即使 basename 相同也不碰撞（UUID 天然满足）
 * - 目录名安全（只含 [a-zA-Z0-9_-]）
 */
export function workspaceScopeOf(agent: unknown): { projectKey: string; workspaceId: string | null; path: string | null } {
  const session = (agent as AgentLike | null | undefined)?.session
  const cwd = session && session.header && typeof session.header.cwd === 'string' && session.header.cwd ? session.header.cwd : undefined

  // 优先：通过 workspaceRegistry 拿稳定 workspace UUID
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
