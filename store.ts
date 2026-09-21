/**
 * dsh-plugin-teamflow — 持久化层（纯 node:fs，无 cordis 依赖，可独立测试）。
 *
 * 职责：
 * - $DSH_HOME/teamflow 目录布局（backlog 产品目录 + runs 运行日志目录）
 * - 原子写 + .bak 备份 + 损坏自动恢复（backlog 与 journal 共用）
 * - journal 序列化/持久化/加载（断点续跑基座，LangGraph checkpointer 语义）
 */

import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import {
  mkdirSync, readFileSync, writeFileSync, existsSync, copyFileSync, renameSync, readdirSync,
} from 'node:fs'
import { homedir } from 'node:os'

/** 运行阶段（journal 序列化/续跑重建单元）。 */
export interface JournalStage {
  seq: number
  label: string
  /** 阶段英文键（2026-09-06 英文化：prd/design/scaffold/tech/dev/qa/acceptance；存量中文经迁移脚本映射）。 */
  phase: string
  /** 任务键（dev 子任务聚合用：任务 title 数据值；非任务型阶段为 null）。
   *  ⚠️ **仅作展示/子卡命名**——判定请看 `taskIds`（title 会因任务合并而被拼接，不是稳定身份）。 */
  taskKey?: string | null
  /** **开发任务身份**（host 按蓝图定义顺序生成的 `dt-N`；2026-09-18 新增）。
   *  合并任务（files 有交集被并成一个子代理）时是**数组**，如 `['dt-1','dt-7','dt-8']`。
   *  resume 的「哪些任务已完成」判定**只认它**，不认 title（见 pipeline.devTaskStatuses）。
   *  存量 stage 无此字段 → 判定回退 taskKey/label（只增不改，不影响历史 run）。 */
  taskIds?: string[] | null
  status: string
  outcome?: string | null
  childId?: string | null
  startedAt?: number | null
  endedAt?: number | null
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number } | null
  handoff?: string | null
  summary?: string | null
  output?: string | null
  /** 单调用护栏中止原因（进行中退化检测触发时记录；outcome 相应为 degenerated/stalled）。 */
  guardReason?: string | null
  /** 护栏中止分类：degenerated（复读，可干净重试）/ stalled（挂死/空转，走预算门转人工）。 */
  guardOutcome?: 'degenerated' | 'stalled' | null
  /** dev/qaFix 回复中的「验证证据」块原文（提取自 [Verification evidence] 块；审计用，可对照 logs/ 命令输出）。 */
  verifyEvidence?: string | null
  /** 该阶段**实际生效的模型路由**（2026-09-18 新增）：子代理路由跟随主线程/团队配置，
   *  可能与 run 起始默认不同（见 runner.resolveChildRoute）。回答「是不是模型的锅」靠它。 */
  provider?: string | null
  model?: string | null
}

/** 运行日志（journal）——运行时对象与磁盘可持久化形态的公共形状。 */
export interface JournalRecord {
  id: string
  name: string
  status: string
  requirement?: string
  options?: Record<string, unknown>
  /** **run 起始的引擎快照**（2026-09-18 新增）：`{ provider, model }`，由 pipeline 在起跑时用
   *  `runner.resolveChildRoute(parent)` 解析（= 主线程当前生效的模型路由）。逐阶段的真实路由见
   *  `JournalStage.provider/model`（子代理可被团队配置改道）。**留痕的理由**：一次失败排查里为了回答
   *  「是不是模型的锅」（不同 provider 的 prompt 缓存能力差 10 倍，见 FRESH_TOKEN_BUDGET），
   *  只能去解压会话文件翻 `request/header` —— run 记录里查不到。 */
  engine?: { provider?: string | null; model?: string | null } | null
  /** 工作区作用域：安全槽位（用作 $DSH_HOME/teamflow/<workspace>/ 目录键，backlog 按此隔离）。 */
  workspace?: string | null
  /** 工作区绝对路径（发起会话 cwd；docs/logs 落点与看板展示用）。 */
  workspacePath?: string | null
  /** 发起会话 id（阶段子代理的直接 parent；跨会话跳转判定用）。 */
  ownerSession?: string | null
  /** M0 状态核对结果（start 时快照；多人/场外提交检测）。 */
  sanity?: {
    ok?: boolean
    branch?: string | null
    hasDirty?: boolean
    dirty?: string
    recentCommits?: string
    summary?: string
  } | null
  /** M1/M2 架构蓝图（tech/architect 阶段产出，dev 继承）。 */
  blueprint?: {
    modules?: Record<string, unknown>
    tasks?: Array<{ title: string; files?: string[]; spec?: string }>
  } | null
  product?: string | null
  /** run 级语言快照（AC-2）：起跑时解析一次并落盘，本 run 全部文案/产物语言读此值（resume 不重解析）。
   * 升级前的历史 journal 无此字段 → 读取方按 zh 处理（见 host/core/locale.runLocaleOf）。 */
  locale?: string | null
  /** 分支策略 A 自动创建的特性分支名（feat/<slug>；非 main 沿用/keep 时为 null）。 */
  branch?: string | null
  /** 收尾合回状态（ADR-2026-08-27 交互模式）：验收通过后由 teamflow_merge 设置——'pending'（验收通过未决策）/ 'merged'（host 已合回）/ 'kept'（用户暂缓）/ 'failed'（合并冲突）。 */
  mergeStatus?: 'pending' | 'merged' | 'kept' | 'failed' | null
  reqId?: string | null
  /** ADR-0008 任务夹相对路径（docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]；需求级身份，建夹后固定，重试/续跑复用）。 */
  runDocs?: string | null
  /** 单任务模型：需求关联的唯一（轮转）任务 id。 */
  taskId?: string | null
  taskMap?: Record<string, string>
  agentsStarted?: number
  humanIntervention?: boolean
  cancelled?: boolean
  interrupted?: boolean
  interruptedAt?: number | null
  supersededBy?: string | null
  startedAt?: number | null
  endedAt?: number | null
  error?: string | null
  stages?: JournalStage[]
  logs?: Array<{ t: number; level: string; message: string }>
  /**
   * 逐轮 QA 阻断集合埋点（D 方案 2026-09-15：先测量再决定要不要把 `QA_REWORK_LIMIT` 换成收敛判据）。
   * 每轮一条：`{ round, seq, blocking, p3, defects:[{id,sev,module,fp}], withCheck, withCriterion,
   * qaCalls, fixCalls, gate, newFps, repeats, resolved, outcome }`——`fp` 是**稳定身份**
   * （检测命令优先：QA 每轮重编号，缺陷 id 跨轮不可比，见 util.defectFingerprint）。
   */
  qaRounds?: Array<Record<string, unknown>> | null
  /** **宿主契约调研**（2026-09-18 用户实锤）：交付物要被**非 dsh 宿主**（openclaw/hermes/pi…）加载时，
   *  dsh 的插件契约一条都不适用 → PRD 必须含「宿主契约调研」段（硬门禁）。`hostResearch=true` 标记
   *  「本 run 需要该段」，`hostContract` 存摘出的核实结论（人可读留痕）。 */
  hostResearch?: boolean
  hostContract?: string | null
  /** **本机安装环境**（2026-09-21）：`$DSH_HOME` + 由插件自身路径反推的 profile 名/目录 + `dsh` 是否在 PATH。
   *  路径全为运行时探测（用户环境各异，**不得写死**）；探测失败（`ok=false`）时 PRD 必须改为"问用户"。 */
  installEnv?: { dshHome?: string; profile?: string; profileDir?: string; cliOnPath?: boolean; ok?: boolean } | null
  result?: unknown
  [key: string]: unknown
}

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
export function teamflowRoot(): string {
  return join(dshHome(), 'teamflow')
}

/**
 * 工作区 → 稳定安全槽位：以路径 basename 为可读前缀 + sha1 短哈希，保证同路径稳定、
 * 跨路径唯一，且只含 [a-zA-Z0-9_-]（可安全作目录段，不穿越 $DSH_HOME）。
 * 例：C:\...\tetris → ws-tetris-3f9a2c7b
 */
export function slugPath(p: string | null | undefined): string {
  const raw = String(p || '').replace(/\\/g, '/')
  const base = raw.split('/').filter(Boolean).pop() || 'root'
  const tag = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws'
  const hash = createHash('sha1').update(raw || 'default').digest('hex').slice(0, 8)
  return `ws-${tag}-${hash}`
}

/** 工作区绝对路径 → 该工作区的 `$DSH_HOME/teamflow/<slug>/backlog` 等目录基座。 */
export function workspaceDir(workspacePath: string | null | undefined): string {
  return join(teamflowRoot(), slugPath(workspacePath || null))
}
export function productDir(product: string | null | undefined): string {
  // 双保险：危险路径退化到 default（与 host normalizeRoot 白名单一致）。
  let safe = String(product || 'default').replace(/\\/g, '/').trim() || 'default'
  if (safe.startsWith('/') || safe.startsWith('.') || /^[a-zA-Z]:/.test(safe) || safe.includes('..')) safe = 'default'
  if (!safe.split('/').every((seg) => /^[a-zA-Z0-9_-]+$/.test(seg))) safe = 'default'
  return join(teamflowRoot(), safe)
}
export function fileFor(product: string | null | undefined, name: string): string {
  return join(productDir(product), 'backlog', name)
}
export function runsDir(): string {
  return join(teamflowRoot(), 'runs')
}
export function journalFile(runId: string): string {
  return join(runsDir(), `${runId}.json`)
}

/* ── 原子读/写（备份 + 损坏自愈） ────────────────────────────────── */
/** 通用 JSON 读取（对象或数组），主文件损坏自动 .bak 恢复。 */
export function readJsonAny<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch (e) {
    console.error('[teamflow] readJson 主文件损坏', file, (e as Error)?.message)
    try {
      if (existsSync(file + '.bak')) {
        const b = JSON.parse(readFileSync(file + '.bak', 'utf8')) as T
        console.warn('[teamflow] 已从 .bak 恢复', file)
        return b
      }
    } catch (e2) { /* 备份也损坏 */ }
    console.error('[teamflow] .bak 也损坏，返回空（数据可能丢失）', file)
    return fallback
  }
}

/** 数组 JSON 读取（backlog 专用），非数组视为无效。 */
export function readJson<T>(file: string, fallback: T): T {
  const v = readJsonAny<T>(file, fallback)
  return Array.isArray(v) ? v : fallback
}

/**
 * 原子写 JSON：先 .tmp 再 rename（崩溃无半截文件）；
 * 只把「可解析的完整数组」备份为 .bak；损坏主文件改名 .corrupt-<ts> 保留现场。
 */
export function writeJson(file: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) {
      try {
        const cur = JSON.parse(readFileSync(file, 'utf8'))
        if (Array.isArray(cur)) copyFileSync(file, file + '.bak')
      } catch (e) {
        try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch (e2) { /* 保留现场失败可忽略 */ }
      }
    }
    const tmp = file + '.tmp'
    writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    console.error('[teamflow] writeJson failed', file, (e as Error)?.message)
    return false
  }
}

/* ── journal（运行日志）序列化 / 持久化 / 加载 ────────────────────── */
/** 阶段产物全文保留上限（dev 任务等大输出裁剪；重跑时足够重建上下文）。 */
export const STAGE_OUTPUT_CLIP = 50000

function clip(text: unknown, n: number): string {
  const s = text === null || text === undefined ? '' : String(text)
  return s.length > n ? s.slice(0, n) : s
}

/** journal → 可持久化 JSON（阶段含 output，供断点续跑重建产物）。 */
export function serializeJournal(journal: JournalRecord): JournalRecord {
  return {
    id: journal.id,
    name: journal.name,
    status: journal.status,
    requirement: journal.requirement,
    options: journal.options,
    // 引擎留痕（2026-09-18）：run 起始模型路由（provider/model）——排查「是不是模型的锅」的第一手依据
    engine: journal.engine || null,
    workspace: journal.workspace || null,
    workspacePath: journal.workspacePath || null,
    ownerSession: journal.ownerSession || null,
    product: journal.product || null,
    locale: journal.locale || null,
    sanity: journal.sanity || null,
    blueprint: journal.blueprint || null,
    reqId: journal.reqId || null,
    runDocs: journal.runDocs || null,
    // 分支与合回决策留痕（结构性门禁发现：这两个字段也曾**只写不落盘**）
    branch: journal.branch || null,
    mergeStatus: journal.mergeStatus || null,
    taskId: journal.taskId || null,
    taskMap: journal.taskMap || {},
    agentsStarted: journal.agentsStarted || 0,
    humanIntervention: journal.humanIntervention === true,
    /** E 方案（2026-09-15）：本轮验收是「已知问题」只读模式（QA 打回超限后补跑）——report 据此给
     *  「结论被强制为需人工裁定、不要据此合回」的显式提示（持久化：重启/resume 后仍可判）。 */
    knownIssuesAcceptance: journal.knownIssuesAcceptance === true,
    cancelled: journal.cancelled === true,
    /** 取消来源（ui=界面按钮/人工，tool=模型工具，unknown=历史 run）：主线程据此判断「谁停的」。 */
    cancelSource: journal.cancelSource || null,
    cancelRequestedAt: journal.cancelRequestedAt || null,
    /** 需求澄清闸门（2026-09-16 Phase 1）：分诊裁决（intent/blockers）+ PRD 假设段 + 澄清答复。
     *  裁决是 shadow 埋点（Phase 2 定闸门强度的数据源）；假设段是「agent 替你决定了什么」的可见化。 */
    triage: journal.triage || null,
    assumptions: journal.assumptions || null,
    hostResearch: journal.hostResearch === true,
    hostContract: journal.hostContract || null,
    installEnv: journal.installEnv || null,
    requirementSupplement: journal.requirementSupplement || null,
    /** 外部供应商故障标记（限流/无额度/上游故障/超时）：run 落可续跑中断态时置位，汇报据此讲清「非交付缺陷」。 */
    externalFailure: journal.externalFailure === true,
    interrupted: journal.interrupted === true,
    interruptedAt: journal.interruptedAt || null,
    supersededBy: journal.supersededBy || null,
    startedAt: journal.startedAt,
    endedAt: journal.endedAt,
    error: journal.error || null,
    stages: (journal.stages || []).map((s) => ({
      seq: s.seq,
      label: s.label,
      phase: s.phase,
      taskKey: s.taskKey || null,
      taskIds: (Array.isArray(s.taskIds) && s.taskIds.length) ? s.taskIds : null,
      // 该阶段**实际生效**的模型路由（子代理可被改道，故逐阶段记）
      provider: s.provider || null,
      model: s.model || null,
      status: s.status,
      outcome: s.outcome || null,
      childId: s.childId || null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      usage: s.usage || null,
      handoff: clip(s.handoff || '', 2000),
      summary: clip(s.summary || '', 3000),
      // 护栏中止留痕（结构性门禁发现：这两个字段曾**只写不落盘**——内存里写了、serialize 丢了）
      guardReason: s.guardReason || null,
      guardOutcome: s.guardOutcome || null,
      output: clip(s.output || s.summary || '', STAGE_OUTPUT_CLIP),
      verifyEvidence: s.verifyEvidence ? clip(s.verifyEvidence, 8000) : null,
    })),
    logs: (journal.logs || []).slice(-300).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
    // D 埋点（2026-09-15）：逐轮 QA 阻断集合（稳定身份 = 检测命令优先）。留最近 12 轮、每轮最多 20 条缺陷。
    qaRounds: (journal.qaRounds || []).slice(-12).map((r) => ({
      round: r.round, seq: r.seq, blocking: r.blocking, p3: r.p3,
      defects: Array.isArray(r.defects)
        ? (r.defects as Array<Record<string, unknown>>).slice(0, 20).map((d) => ({ id: clip(d.id, 40), sev: d.sev, module: clip(d.module, 60), fp: clip(d.fp, 200) }))
        : [],
      withCheck: r.withCheck, withCriterion: r.withCriterion,
      qaCalls: r.qaCalls, fixCalls: r.fixCalls, gate: r.gate,
      newFps: r.newFps, repeats: r.repeats, resolved: r.resolved,
      outcome: r.outcome,
    })),
  }
}

/** 通用文本写（原子写 + 递归建目录），供 run 日志等使用。 */
export function writeText(file: string, text: string): boolean {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = file + '.tmp'
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, file)
    return true
  } catch (e) {
    console.error('[teamflow] writeText failed', file, (e as Error)?.message)
    return false
  }
}

/* ── 运行日志落点（B 方案 2026-09-15：日志根离开用户项目） ──────────────
 * 背景：子代理受 DSH 文件沙箱约束（workspace-write = **只允许写会话工作区 + 平台临时区**，
 * 实测 `$DSH_HOME` 写入被拒），所以子代理产出的命令日志只能先在**工作区内暂存**；
 * run 结束由 host（进程侧无沙箱限制）归档到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/`
 * 并把暂存目录从项目里删掉——项目内不留存、`$DSH_HOME` 侧按最近 K 次保留（见 host/core/runlogs.ts）。
 */

/** 工作区内暂存目录段（与 host/constants.TF_LOG_DIR 同址；store 是独立 entry、刻意不引 host 代码，一致性由 test/runlogs.test.js 守门）。 */
const STAGING_SEGMENTS = ['logs', 'teamflow'] as const

/** 归档用的工作区槽位：优先 journal.workspace，缺失/兜底时按 workspacePath 派生（与 backlog 同键）。 */
function logWorkspaceKey(journal: JournalRecord): string | null {
  const w = journal && typeof journal.workspace === 'string' ? journal.workspace.trim() : ''
  if (w && w !== 'default') return w
  const p = journal ? journal.workspacePath : null
  return p ? slugPath(p) : null
}

/** 归档根（工作区级）：`$DSH_HOME/teamflow/<workspace>/logs/`（每个 run 一个子目录）。 */
export function logsArchiveRoot(journal: JournalRecord): string | null {
  const key = logWorkspaceKey(journal)
  return key ? join(teamflowRoot(), key, 'logs') : null
}

/** 归档落点（run 级目录）：`$DSH_HOME/teamflow/<workspace>/logs/<runId>/`（与 journal/backlog 同槽位）。 */
export function runLogArchiveDir(journal: JournalRecord): string | null {
  const root = logsArchiveRoot(journal)
  return root ? join(root, journal.id) : null
}

/** 工作区内暂存落点（子代理写、run 结束归档后删除）：`<workspacePath>/logs/teamflow/<runId>/`。 */
export function runLogStagingDir(journal: JournalRecord): string | null {
  if (!journal.workspacePath) return null
  return join(journal.workspacePath, ...STAGING_SEGMENTS, journal.id)
}

/** host 事件日志落点：`<归档 run 目录>/run.log`（run 期间即写终态位置，无需搬运）。 */
export function runLogFile(journal: JournalRecord): string | null {
  const dir = runLogArchiveDir(journal)
  return dir ? join(dir, 'run.log') : null
}

/** 把运行事件日志聚合写到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/run.log`（logs 离开用户项目）。 */
export function persistRunLog(journal: JournalRecord): boolean {
  const file = runLogFile(journal)
  if (!file) return false
  const lines = [
    // 文件头随 run 语言（R3-1③）：store.ts 是独立 lib entry、不引 host 词典（保持持久化层零 host 依赖），
    // 故只在这一行内联两语言取值；其余行是 `key=value` 机器可读格式，无需本地化。
    journal.locale === 'en' ? `# TeamFlow run log (${journal.name})` : `# TeamFlow 运行日志（${journal.name}）`,
    `runId=${journal.id}`,
    `workspace=${journal.workspacePath || ''}`,
    `product=${journal.product || ''}`,
    `status=${journal.status}`,
    `startedAt=${journal.startedAt ? new Date(journal.startedAt).toISOString() : ''}`,
    `endedAt=${journal.endedAt ? new Date(journal.endedAt).toISOString() : ''}`,
    `requirement=${journal.requirement || ''}`,
    '',
  ]
  for (const l of (journal.logs || []).slice(-300)) {
    lines.push(`[${l.t ? new Date(l.t).toISOString() : ''}] ${l.level}: ${l.message}`)
  }
  if (journal.error) lines.push('', `ERROR: ${journal.error}`)
  return writeText(file, lines.join('\n') + '\n')
}

/** 原子写 journal 文件（新 journal 写 per-project runs/，旧 journal 写全局 runs/）。 */
export function persistJournal(journal: JournalRecord): boolean {
  // 有 workspace 字段的新 journal → 写到 per-project runs/
  if (journal.workspace && journal.workspace !== 'default') {
    const projectDir = join(teamflowRoot(), journal.workspace, 'runs')
    const file = join(projectDir, `${journal.id}.json`)
    const ok = writeJson(file, serializeJournal(journal))
    if (ok && journal.workspacePath) persistRunLog(journal)
    return ok
  }
  // 旧格式 / 兜底 → 写到全局 runs/
  const ok = writeJson(journalFile(journal.id), serializeJournal(journal))
  if (ok && journal.workspacePath) persistRunLog(journal)
  return ok
}

/**
 * 启动时扫描磁盘 journal：
 * - 全局 $DSH_HOME/teamflow/runs/（兼容旧格式）
 * - 各 per-project $DSH_HOME/teamflow/<project>/runs/（新格式）
 * - 正常状态原样载入；running/pending → 标记 interrupted（进程崩溃/重启残留）。
 * @returns 全部历史 run（含是否本次被标记中断）。
 */
export function loadJournals(): Array<{ journal: JournalRecord; wasInterrupted: boolean }> {
  const out: Array<{ journal: JournalRecord; wasInterrupted: boolean }> = []
  const seen = new Set<string>() // 去重（同一 journal 不要重复加载）
  const loadDir = (dir: string) => {
    try {
      if (!existsSync(dir)) return
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.json') || f.includes('.bak') || f.includes('.tmp') || f.includes('.corrupt')) continue
        const j = readJsonAny<JournalRecord | null>(join(dir, f), null)
        if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue
        if (seen.has(j.id)) continue
        seen.add(j.id)
        let wasInterrupted = false
        if (j.status === 'running' || j.status === 'pending') {
          j.status = 'interrupted'
          j.interrupted = true
          j.interruptedAt = Date.now()
          j.endedAt = j.endedAt || Date.now()
          for (const s of (j.stages || [])) {
            if (s.status === 'running') { s.status = 'interrupted'; s.endedAt = s.endedAt || Date.now() }
          }
          writeJson(join(dir, f), j)
          wasInterrupted = true
          out.push({ journal: j, wasInterrupted })
        } else {
          out.push({ journal: j, wasInterrupted })
        }
      }
    } catch (e) { /* 单目录失败不影响其他 */ }
  }
  try {
    // 1. 全局 runs/（兼容旧格式 journal）
    loadDir(runsDir())
    // 2. per-project runs/（新格式 journal）
    const root = teamflowRoot()
    if (existsSync(root)) {
      for (const entry of readdirSync(root)) {
        const sub = join(root, entry)
        try {
          if (entry === 'runs') continue // 全局已扫描
          if (existsSync(sub) && readdirSync(sub).includes('runs')) {
            loadDir(join(sub, 'runs'))
          }
        } catch (e) { /* 跳过非目录 */ }
      }
    }
  } catch (e) {
    console.error('[teamflow] loadJournals failed', (e as Error)?.message)
  }
  return out
}
