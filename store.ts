/**
 * dsh-plugin-teamflow — 持久化层（纯 node:fs，无 cordis 依赖，可独立测试）。
 *
 * 职责：
 * - $DSH_HOME/teamflow 目录布局（backlog 产品目录 + runs 运行日志目录）
 * - 原子写 + .bak 备份 + 损坏自动恢复（backlog 与 journal 共用）
 * - journal 序列化/持久化/加载（断点续跑基座，LangGraph checkpointer 语义）
 */

import { join, dirname } from 'node:path'
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
  product?: string | null
  reqId?: string | null
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
    product: journal.product || null,
    reqId: journal.reqId || null,
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

/** 原子写 journal 文件。 */
export function persistJournal(journal: JournalRecord): boolean {
  return writeJson(journalFile(journal.id), serializeJournal(journal))
}

/**
 * 启动时扫描磁盘 journal：
 * - 正常状态（completed/failed/cancelled/interrupted）原样载入；
 * - running/pending → 标记 interrupted（进程崩溃/重启残留），并就地持久化。
 * @returns 全部历史 run（含是否本次被标记中断）。
 */
export function loadJournals(): Array<{ journal: JournalRecord; wasInterrupted: boolean }> {
  const out: Array<{ journal: JournalRecord; wasInterrupted: boolean }> = []
  try {
    if (!existsSync(runsDir())) return out
    for (const f of readdirSync(runsDir())) {
      if (!f.endsWith('.json') || f.includes('.bak') || f.includes('.tmp') || f.includes('.corrupt')) continue
      const j = readJsonAny<JournalRecord | null>(join(runsDir(), f), null)
      if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue
      let wasInterrupted = false
      if (j.status === 'running' || j.status === 'pending') {
        j.status = 'interrupted'
        j.interrupted = true
        j.interruptedAt = Date.now()
        j.endedAt = j.endedAt || Date.now()
        for (const s of (j.stages || [])) {
          if (s.status === 'running') { s.status = 'interrupted'; s.endedAt = s.endedAt || Date.now() }
        }
        writeJson(journalFile(j.id), j)
        wasInterrupted = true
        out.push({ journal: j, wasInterrupted })
      } else {
        out.push({ journal: j, wasInterrupted })
      }
    }
  } catch (e) {
    console.error('[teamflow] loadJournals failed', (e as Error)?.message)
  }
  return out
}
