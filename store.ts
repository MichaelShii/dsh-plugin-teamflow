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
  phase: string
  status: string
  outcome?: string | null
  childId?: string | null
  startedAt?: number | null
  endedAt?: number | null
  tokens?: number | null
  usage?: { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number } | null
  costTokens?: number | null
  handoff?: string | null
  summary?: string | null
  output?: string | null
}

/** 运行日志（journal）——运行时对象与磁盘可持久化形态的公共形状。 */
export interface JournalRecord {
  id: string
  name: string
  status: string
  requirement?: string
  options?: Record<string, unknown>
  /** 工作区作用域：安全槽位（用作 $DSH_HOME/teamflow/<workspace>/ 目录键，backlog 按此隔离）。 */
  workspace?: string | null
  /** 工作区绝对路径（发起会话 cwd；docs/logs 落点与看板展示用）。 */
  workspacePath?: string | null
  product?: string | null
  reqId?: string | null
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
    workspace: journal.workspace || null,
    workspacePath: journal.workspacePath || null,
    product: journal.product || null,
    reqId: journal.reqId || null,
    taskId: journal.taskId || null,
    taskMap: journal.taskMap || {},
    agentsStarted: journal.agentsStarted || 0,
    humanIntervention: journal.humanIntervention === true,
    cancelled: journal.cancelled === true,
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
      status: s.status,
      outcome: s.outcome || null,
      childId: s.childId || null,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      tokens: typeof s.tokens === 'number' ? s.tokens : null,
      usage: s.usage || null,
      costTokens: s.costTokens || null,
      handoff: clip(s.handoff || '', 2000),
      summary: clip(s.summary || '', 3000),
      output: clip(s.output || s.summary || '', STAGE_OUTPUT_CLIP),
    })),
    logs: (journal.logs || []).slice(-300).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
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

/** 工作区下日志落点：<工作区>/logs/teamflow/<runId>.log（存在 workspacePath 时才落）。 */
export function runLogFile(journal: JournalRecord): string | null {
  if (!journal.workspacePath) return null
  return join(journal.workspacePath, 'logs', 'teamflow', `${journal.id}.log`)
}

/** 把运行事件日志聚合写到 <工作区>/logs/teamflow/<runId>.log（logs 收口，防止污染宿主）。 */
export function persistRunLog(journal: JournalRecord): boolean {
  const file = runLogFile(journal)
  if (!file) return false
  const lines = [
    `# TeamFlow 运行日志（${journal.name}）`,
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
