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

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
export function teamflowRoot() {
  return join(dshHome(), 'teamflow')
}
export function productDir(product) {
  // 双保险：危险路径退化到 default（与 host normalizeRoot 白名单一致）。
  let safe = String(product || 'default').replace(/\\/g, '/').trim() || 'default'
  if (safe.startsWith('/') || safe.startsWith('.') || /^[a-zA-Z]:/.test(safe) || safe.includes('..')) safe = 'default'
  if (!safe.split('/').every((seg) => /^[a-zA-Z0-9_-]+$/.test(seg))) safe = 'default'
  return join(teamflowRoot(), safe)
}
export function fileFor(product, name) {
  return join(productDir(product), 'backlog', name)
}
export function runsDir() {
  return join(teamflowRoot(), 'runs')
}
export function journalFile(runId) {
  return join(runsDir(), `${runId}.json`)
}

/* ── 原子读/写（备份 + 损坏自愈） ────────────────────────────────── */
/** 通用 JSON 读取（对象或数组），主文件损坏自动 .bak 恢复。 */
export function readJsonAny(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    console.error('[teamflow] readJson 主文件损坏', file, e?.message)
    try {
      if (existsSync(file + '.bak')) {
        const b = JSON.parse(readFileSync(file + '.bak', 'utf8'))
        console.warn('[teamflow] 已从 .bak 恢复', file)
        return b
      }
    } catch (e2) { /* 备份也损坏 */ }
    console.error('[teamflow] .bak 也损坏，返回空（数据可能丢失）', file)
    return fallback
  }
}

/** 数组 JSON 读取（backlog 专用），非数组视为无效。 */
export function readJson(file, fallback) {
  const v = readJsonAny(file, fallback)
  return Array.isArray(v) ? v : fallback
}

/**
 * 原子写 JSON：先 .tmp 再 rename（崩溃无半截文件）；
 * 只把「可解析的完整数组」备份为 .bak；损坏主文件改名 .corrupt-<ts> 保留现场。
 */
export function writeJson(file, value) {
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
    console.error('[teamflow] writeJson failed', file, e?.message)
    return false
  }
}

/* ── journal（运行日志）序列化 / 持久化 / 加载 ────────────────────── */
/** 阶段产物全文保留上限（dev 任务等大输出裁剪；重跑时足够重建上下文）。 */
export const STAGE_OUTPUT_CLIP = 50000

function clip(text, n) {
  const s = text === null || text === undefined ? '' : String(text)
  return s.length > n ? s.slice(0, n) : s
}

/** journal → 可持久化 JSON（阶段含 output，供断点续跑重建产物）。 */
export function serializeJournal(journal) {
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
      summary: clip(s.summary || '', 3000),
      output: clip(s.output || s.summary || '', STAGE_OUTPUT_CLIP),
    })),
    logs: (journal.logs || []).slice(-300).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
  }
}

/** 原子写 journal 文件。 */
export function persistJournal(journal) {
  return writeJson(journalFile(journal.id), serializeJournal(journal))
}

/**
 * 启动时扫描磁盘 journal：
 * - 正常状态（completed/failed/cancelled/interrupted）原样载入；
 * - running/pending → 标记 interrupted（进程崩溃/重启残留），并就地持久化。
 * @returns {Array<{journal: object, wasInterrupted: boolean}>} 全部历史 run。
 */
export function loadJournals() {
  const out = []
  try {
    if (!existsSync(runsDir())) return out
    for (const f of readdirSync(runsDir())) {
      if (!f.endsWith('.json') || f.includes('.bak') || f.includes('.tmp') || f.includes('.corrupt')) continue
      const j = readJsonAny(join(runsDir(), f), null)
      if (!j || typeof j !== 'object' || typeof j.id !== 'string') continue
      const wasInterrupted = false
      if (j.status === 'running' || j.status === 'pending') {
        j.status = 'interrupted'
        j.interrupted = true
        j.interruptedAt = Date.now()
        j.endedAt = j.endedAt || Date.now()
        for (const s of (j.stages || [])) {
          if (s.status === 'running') { s.status = 'interrupted'; s.endedAt = s.endedAt || Date.now() }
        }
        writeJson(journalFile(j.id), j)
        out.push({ journal: j, wasInterrupted: true })
      } else {
        out.push({ journal: j, wasInterrupted })
      }
    }
  } catch (e) {
    console.error('[teamflow] loadJournals failed', e?.message)
  }
  return out
}
