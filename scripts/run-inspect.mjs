#!/usr/bin/env node
/**
 * run 巡检（只读）——给定 runId，打印该 run 的阶段状态/耗时/token/失败原因原文 + 任务夹路径。
 *
 * 为什么需要：run 失败后，「哪个阶段挂了、原文是什么、烧了多少 token、任务夹在哪」散落在
 * `$DSH_HOME/teamflow/<workspace>/runs/<runId>.json` 里。本脚本把它读成一张人读清单（默认），
 * 或一份定键序 JSON（`--json`，`schema=teamflow.run-inspect/v1`）。
 *
 * 用法（插件仓根目录）：
 *   node scripts/run-inspect.mjs <runId>          # 人读巡检清单
 *   node scripts/run-inspect.mjs <runId> --json   # 机读 JSON（schema=teamflow.run-inspect/v1）
 *   node scripts/run-inspect.mjs --json <runId>   # 等价写法
 *   node scripts/run-inspect.mjs --help           # 用法，退出码 0
 *
 * 只读三重（AC-10）：① 全部 IO 经可注入的 io 适配器，只暴露 existsSync/readdirSync/readFileSync
 * 三个读函数；② 入口守卫（import.meta.url 与 argv[1] 比对）保证 import 期零 IO、零输出；
 * ③ 源码不引用任何写盘 API 与子进程模块。
 * 退出码：0 成功（含 --help）；1 未找到 / 多工作区歧义；2 缺 runId（用法错误）。
 * 文本态与 JSON 态共用同一个 Report（buildReport 是唯一计算点）→ 两态数字同源是结构事实。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** JSON schema 常量（AC-6 顶层首键）。 */
const SCHEMA = 'teamflow.run-inspect/v1'
/** 固定 phase 定序（AC-4；与 host/constants.ts PHASE_ORDER 同序，独立 CLI 不引 host 代码）。 */
const PHASE_ORDER = ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance']
/** usage 五桶定序（求和与投影都按此序）。 */
const BUCKETS = ['input', 'cacheRead', 'cacheWrite', 'output', 'calls']
/** 零 usage（缺失桶按 0）。 */
const ZERO_USAGE = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }

/** 真实 fs 适配器（可注入替身：仅这三个读函数，任何写调用因方法不存在直接失败）。 */
const nodeIo = { existsSync, readdirSync, readFileSync }

/**
 * 用法文案（AC-2：与脚本头部注释同源——同一组命令串两处都出现）。
 * `--help` 渲染 = USAGE_LINES.join('\n') + '\n'。
 */
export const USAGE_LINES = [
  '用法（插件仓根目录）：',
  '  node scripts/run-inspect.mjs <runId>          # 人读巡检清单',
  '  node scripts/run-inspect.mjs <runId> --json   # 机读 JSON（schema=teamflow.run-inspect/v1）',
  '  node scripts/run-inspect.mjs --json <runId>   # 等价写法',
  '  node scripts/run-inspect.mjs --help           # 用法，退出码 0',
  '',
  'runId = 首个不以 "-" 开头的参数；未知 "-" 前缀参数静默忽略。',
  '只读 $DSH_HOME/teamflow/<workspace>/runs/<runId>.json（DSH_HOME 缺省 ~/.dsh）。',
  '退出码：0 成功；1 未找到 / 多工作区歧义；2 缺 runId（用法错误）。',
]

/** 逐字符比较（不用 localeCompare，避免 locale 依赖，AC-3 逐字节稳定）。 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/** 非空字符串判定（不 trim 返回值本身：原文不加改写）。 */
const hasText = (v) => typeof v === 'string' && v.trim().length > 0

/** 有限数 → 原值，否则 null（D6：不做归一化，缺即 null）。 */
const numOrNull = (v) => (Number.isFinite(v) ? v : null)

/**
 * 解析 argv（不含 node/script 两个前缀）。纯函数：不抛、不读环境、不打印。
 * `--help`/`-h` 归一为 help；`--json` 只看是否存在；runId = 首个不以 `-` 开头的参数（AC-7）。
 */
export function parseArgs(argv) {
  const list = Array.isArray(argv) ? argv : []
  const help = list.includes('--help') || list.includes('-h')
  const json = list.includes('--json')
  const runId = list.find((a) => typeof a === 'string' && !a.startsWith('-')) ?? null
  return { help, json, runId }
}

/**
 * 按 runId 精确收集 journal——纯 IO 适配层：只读、无副作用、不打印。
 * 扫盘口径（AC-8 计数）：workspaces = root 下 isDirectory() 为真的条目数（不要求有 runs/）；
 * journals = 这些工作区 runs/ 下 .json 文件数（只按文件名统计，不解析内容）。
 * 命中判定：文件名须恰为 `<runId>.json`；JSON.parse 失败 / 非对象 / stages 非数组或为空 → 视为未命中。
 */
export function collectJournal({ root, runId, io = nodeIo }) {
  const entries = []
  const scanned = { workspaces: 0, journals: 0 }
  if (!io.existsSync(root)) return { entries, scanned }
  let top = []
  try { top = io.readdirSync(root, { withFileTypes: true }) } catch (e) { return { entries, scanned } }
  for (const item of top) {
    const isDir = typeof item === 'string' ? true : Boolean(item && typeof item.isDirectory === 'function' && item.isDirectory())
    if (!isDir) continue
    const name = typeof item === 'string' ? item : item?.name
    if (!name) continue
    scanned.workspaces += 1
    const runsDir = join(root, name, 'runs')
    if (!io.existsSync(runsDir)) continue
    let files = []
    try { files = io.readdirSync(runsDir) } catch (e) { continue }
    for (const f of files) {
      if (typeof f !== 'string' || !f.endsWith('.json')) continue
      scanned.journals += 1
      if (f !== `${runId}.json`) continue
      try {
        const j = JSON.parse(io.readFileSync(join(runsDir, f), 'utf8'))
        if (j && !Array.isArray(j) && Array.isArray(j.stages) && j.stages.length) entries.push({ ws: name, j })
      } catch (e) { /* 损坏的 journal 视为未命中 */ }
    }
  }
  return { entries, scanned }
}

/**
 * usage 五桶归一：`Number.isFinite` 才收，缺失按 0（AC-4）。
 * `usage` 非对象或五桶全非有限数 → 全 0 且 `usageMissing:true`（D5：零值不能区分「真 0」与「无计量」）。
 */
function usageOf(usage) {
  const src = usage && typeof usage === 'object' ? usage : null
  const out = {}
  let anyFinite = false
  for (const k of BUCKETS) {
    const v = src ? src[k] : undefined
    const ok = Number.isFinite(v)
    if (ok) anyFinite = true
    out[k] = ok ? v : 0
  }
  return { usage: out, usageMissing: !anyFinite }
}

/** 多阶段 usage 求和：桶和 + `usageMissing`（全部成员无计量 → true）。 */
export function sumUsage(stages) {
  const list = Array.isArray(stages) ? stages : []
  const usage = { ...ZERO_USAGE }
  let missing = 0
  for (const s of list) {
    const flag = s && typeof s.usageMissing === 'boolean' ? s.usageMissing : usageOf(s?.usage).usageMissing
    const u = usageOf(s?.usage).usage
    for (const k of BUCKETS) usage[k] += u[k]
    if (flag) missing += 1
  }
  return { usage, usageMissing: list.length === 0 ? true : missing === list.length }
}

/** 耗时严格 `endedAt - startedAt`（任一非有限数 → null；D6 不做 max(0,…)，异常如实暴露）。 */
export function durationOf(startedAt, endedAt) {
  return Number.isFinite(startedAt) && Number.isFinite(endedAt) ? endedAt - startedAt : null
}

/**
 * 失败原因原文（AC-5/D7）：优先级 `envUnavailable` > `guardReason` > `summary`（原文不改写）；
 * 三者皆空 → `outcome=<值|unknown>（无原文）`。
 */
export function failureReasonOf(stage) {
  const s = stage && typeof stage === 'object' ? stage : {}
  if (hasText(s.envUnavailable)) return s.envUnavailable
  if (hasText(s.guardReason)) return s.guardReason
  if (hasText(s.summary)) return s.summary
  const outcome = hasText(s.outcome) ? s.outcome : 'unknown'
  return `outcome=${outcome}（无原文）`
}

/** 取首行；超过 n 字符则截断并追加 `…`（AC-5 文本态）。 */
export function clipLine(s, n) {
  const text = s == null ? '' : String(s)
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  return first.length > n ? `${first.slice(0, n)}…` : first
}

/** 耗时显示：null → `未记录`；<1000ms → `<n>ms`；否则 `<h>h <m>m <s>s`（前导 0 单位省略，秒恒出）。 */
export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '未记录'
  if (ms < 1000) return `${ms}ms`
  const total = Math.floor(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const out = []
  if (h) out.push(`${h}h`)
  if (h || m) out.push(`${m}m`)
  out.push(`${s}s`)
  return out.join(' ')
}

/** stage 归一（Report 规范形状，§3.3）：标量缺 → null，taskIds 非数组 → []。 */
function stageOf(raw) {
  const s = raw && typeof raw === 'object' ? raw : {}
  const u = usageOf(s.usage)
  const startedAt = numOrNull(s.startedAt)
  const endedAt = numOrNull(s.endedAt)
  const status = hasText(s.status) ? s.status : (s.status == null ? null : String(s.status))
  return {
    seq: numOrNull(s.seq),
    label: s.label == null ? null : String(s.label),
    phase: s.phase == null ? null : String(s.phase),
    taskKey: s.taskKey == null ? null : String(s.taskKey),
    taskIds: Array.isArray(s.taskIds) ? [...s.taskIds] : [],
    status,
    outcome: s.outcome == null ? null : String(s.outcome),
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    usage: u.usage,
    usageMissing: u.usageMissing,
    failureReason: status === 'done' ? null : failureReasonOf(s),
    summary: s.summary == null ? null : String(s.summary),
    guardReason: s.guardReason == null ? null : String(s.guardReason),
    guardOutcome: s.guardOutcome == null ? null : String(s.guardOutcome),
    envUnavailable: s.envUnavailable == null ? null : String(s.envUnavailable),
    provider: s.provider == null ? null : String(s.provider),
    model: s.model == null ? null : String(s.model),
  }
}

/** seq 排序键：非有限数视作 Infinity（稳定排序兜底，AC-6）。 */
const seqKey = (s) => (Number.isFinite(s.seq) ? s.seq : Infinity)

/** phase 汇总（AC-4）：`stages` 是**计数**，不是数组；`statuses` 去重保序；未经历 phase 也在列。 */
function phaseOf(phase, members) {
  const started = members.map((m) => m.startedAt).filter(Number.isFinite)
  const ended = members.map((m) => m.endedAt).filter(Number.isFinite)
  const startedAt = started.length ? Math.min(...started) : null
  const endedAt = ended.length ? Math.max(...ended) : null
  const statuses = []
  for (const m of members) {
    if (m.status == null) continue
    if (!statuses.includes(m.status)) statuses.push(m.status)
  }
  const failed = members.filter((m) => m.status !== 'done').length
  const firstFailed = members.find((m) => m.status !== 'done')
  const agg = sumUsage(members)
  return {
    phase,
    visited: members.length > 0,
    stages: members.length,
    statuses,
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    usage: agg.usage,
    usageMissing: agg.usageMissing,
    failed,
    failureReason: firstFailed ? firstFailed.failureReason : null,
  }
}

/**
 * 唯一计算点（AC-3/4/5/6）：entries → Report（纯函数，无 IO、无输出、不修改入参）。
 * runId 取 journal.id，缺则回落到 filter.runId（0 命中时仍可产出规范形状）。
 */
export function buildReport(entries, filter = {}) {
  const onlyRun = typeof filter === 'string' ? filter : (filter?.runId ?? null)
  const entry = Array.isArray(entries) ? entries[0] : entries
  const j = entry && entry.j && typeof entry.j === 'object' ? entry.j : {}
  const rawStages = Array.isArray(j.stages) ? j.stages : []
  const stages = rawStages.map(stageOf).sort((a, b) => seqKey(a) - seqKey(b))
  const phases = PHASE_ORDER.map((p) => phaseOf(p, stages.filter((s) => s.phase === p)))
  const startedAt = numOrNull(j.startedAt)
  const endedAt = numOrNull(j.endedAt)
  const usage = sumUsage(stages).usage
  return {
    runId: j.id ?? onlyRun ?? null,
    workspace: entry?.ws ?? (j.workspace ?? null),
    workspacePath: j.workspacePath == null ? null : String(j.workspacePath),
    status: j.status == null ? null : String(j.status),
    humanIntervention: Boolean(j.humanIntervention),
    cancelled: Boolean(j.cancelled),
    interrupted: Boolean(j.interrupted),
    supersededBy: j.supersededBy == null ? null : String(j.supersededBy),
    requirement: j.requirement == null ? null : String(j.requirement),
    runDocs: j.runDocs == null ? null : String(j.runDocs),
    error: j.error == null ? null : String(j.error),
    startedAt,
    endedAt,
    durationMs: durationOf(startedAt, endedAt),
    usage,
    phases,
    stages,
  }
}

/** 显示列宽（CJK 计 2 列；文本态对齐用，不影响内容）。 */
function displayWidth(s) {
  let w = 0
  for (const ch of String(s)) w += ch.codePointAt(0) > 0xff ? 2 : 1
  return w
}

/** 按显示列宽右补空格（不截断）。 */
function padDisplay(s, width) {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, width - displayWidth(t)))
}

/** 补到指定显示列（至少 2 空格分隔）。 */
function gapTo(s, col) {
  return s + ' '.repeat(Math.max(2, col - displayWidth(s)))
}

/** 每行 token 段恒为 `calls <n>  in <n> / hit <n> / out <n>`（+ 无计量标注）。 */
function tokenSeg(usage, missing) {
  const u = usage ?? ZERO_USAGE
  const seg = `${padDisplay(`calls ${u.calls}`, 8)}  in ${u.input} / hit ${u.cacheRead} / out ${u.output}`
  return missing ? `${seg}（无计量）` : seg
}

/** 文本态阶段块列宽（仅排版）：phase 12 / 状态 10 / statuses 18 / 耗时 10 → token 列 50。 */
const TEXT_COL = 50

/**
 * run 级成功状态：**实测** `$DSH_HOME/teamflow` 76 个真实 journal 的 run.status 只有
 * `completed/failed/cancelled/running`（stage.status 才是 `done/cancelled/failed`）。
 * 故 run 级「未记录失败原因」的回落判定必须把 `completed` 也算成功——否则 53 个成功 run 全被
 * 打上「失败原因 未记录」（TECH §3.5 按 `status !== 'done'` 写，与真实数据不符，此处按实测收口）。
 */
const RUN_SUCCESS = new Set(['done', 'completed'])

/**
 * 文本渲染（默认路径，AC-3/4/5）：返回不含结尾换行的完整文本（runCli 补 '\n'）。
 * 硬约束：① 不输出 `workspacePath`（D3，结构上不接收）；② 无时间戳/随机量/排序（同机两次逐字节相同）；
 * ③ `phases` 恒 7 行（未经历写「未经历」）；④ 只有 dev 展开逐条 stage 明细（并发/补跑可见）。
 */
export function renderText(report) {
  const r = report && typeof report === 'object' ? report : {}
  const usage = r.usage ?? ZERO_USAGE
  const { usageMissing } = sumUsage(r.stages)
  const lines = []
  lines.push(`${padDisplay('run', 11)}${r.runId ?? '-'}`)
  lines.push(`${padDisplay('workspace', 11)}${r.workspace ?? '-'}`)
  const flags = [`humanIntervention=${Boolean(r.humanIntervention)}`]
  if (r.cancelled) flags.push('cancelled')
  if (r.interrupted) flags.push('interrupted')
  if (r.supersededBy != null) flags.push(`supersededBy=${r.supersededBy}`)
  lines.push(`${padDisplay('status', 11)}${r.status ?? '-'}（${flags.join(' / ')}）`)
  lines.push(`${padDisplay('任务夹', 11)}${r.runDocs == null ? '未建任务夹' : r.runDocs}`)
  lines.push(`${padDisplay('耗时', 11)}${fmtDuration(r.durationMs)}（${r.startedAt ?? '-'} → ${r.endedAt ?? '-'}）`)
  lines.push(`${padDisplay('token', 11)}input ${usage.input} / cacheRead ${usage.cacheRead} / cacheWrite ${usage.cacheWrite} / output ${usage.output} / calls ${usage.calls}${usageMissing ? '（无计量）' : ''}`)
  if (hasText(r.error)) {
    lines.push(`${padDisplay('失败原因', 11)}${clipLine(r.error, 200)}`)
  } else if (!RUN_SUCCESS.has(r.status)) {
    lines.push(`${padDisplay('失败原因', 11)}未记录（status=${r.status ?? '-'} 无 run 级原文）`)
  }
  lines.push('')
  lines.push(`阶段（7 类，按 ${PHASE_ORDER.join('→')}）`)

  const stages = Array.isArray(r.stages) ? r.stages : []
  const phases = Array.isArray(r.phases) ? r.phases : []
  for (const p of phases) {
    if (!p.visited) {
      lines.push(`${padDisplay(p.phase, 12)}未经历`)
      continue
    }
    const state = p.failed ? `失败 ${p.failed}/${p.stages}` : '全部完成'
    const rollup = padDisplay(p.phase, 12) + padDisplay(state, 10) + padDisplay(p.statuses.join(' '), 18) + padDisplay(fmtDuration(p.durationMs), 10)
    lines.push(gapTo(rollup, TEXT_COL) + tokenSeg(p.usage, p.usageMissing))
    if (p.phase === 'dev') {
      for (const s of stages.filter((x) => x.phase === 'dev')) {
        const ids = Array.isArray(s.taskIds) && s.taskIds.length ? s.taskIds.join(' ') : '-'
        const detail = `  [${s.seq ?? '-'}] ${s.label ?? '-'}  ${s.taskKey ?? '-'}  ${ids}  ${s.status ?? '-'}  ${s.outcome ?? '-'}  ${fmtDuration(s.durationMs)}`
        lines.push(gapTo(detail, TEXT_COL) + tokenSeg(s.usage, s.usageMissing))
        if (s.failureReason) lines.push(`      原文：${clipLine(s.failureReason, 200)}`)
      }
    } else if (p.failureReason) {
      lines.push(`      原文：${clipLine(p.failureReason, 200)}`)
    }
  }
  return lines.join('\n')
}

/** stage 定键序投影（19 键，§3.4）。 */
function stageJson(s) {
  const x = s && typeof s === 'object' ? s : {}
  const u = usageOf(x.usage).usage
  return {
    seq: x.seq ?? null,
    label: x.label ?? null,
    phase: x.phase ?? null,
    taskKey: x.taskKey ?? null,
    taskIds: Array.isArray(x.taskIds) ? x.taskIds : [],
    status: x.status ?? null,
    outcome: x.outcome ?? null,
    startedAt: x.startedAt ?? null,
    endedAt: x.endedAt ?? null,
    durationMs: x.durationMs ?? null,
    usage: u,
    usageMissing: Boolean(x.usageMissing),
    failureReason: x.failureReason ?? null,
    summary: x.summary ?? null,
    guardReason: x.guardReason ?? null,
    guardOutcome: x.guardOutcome ?? null,
    envUnavailable: x.envUnavailable ?? null,
    provider: x.provider ?? null,
    model: x.model ?? null,
  }
}

/** phase 定键序投影（11 键，§3.4）。 */
function phaseJson(p) {
  const x = p && typeof p === 'object' ? p : {}
  return {
    phase: x.phase ?? null,
    visited: Boolean(x.visited),
    stages: x.stages ?? 0,
    statuses: Array.isArray(x.statuses) ? x.statuses : [],
    startedAt: x.startedAt ?? null,
    endedAt: x.endedAt ?? null,
    durationMs: x.durationMs ?? null,
    usage: usageOf(x.usage).usage,
    usageMissing: Boolean(x.usageMissing),
    failed: x.failed ?? 0,
    failureReason: x.failureReason ?? null,
  }
}

/** JSON v1 投影（顶层 18 键固定序，AC-6）：缺失标量补 null、数组缺省补 []。 */
function jsonProjection(report) {
  const r = report && typeof report === 'object' ? report : {}
  const u = usageOf(r.usage).usage
  return {
    schema: SCHEMA,
    runId: r.runId ?? null,
    workspace: r.workspace ?? null,
    workspacePath: r.workspacePath ?? null,
    status: r.status ?? null,
    humanIntervention: Boolean(r.humanIntervention),
    cancelled: Boolean(r.cancelled),
    interrupted: Boolean(r.interrupted),
    supersededBy: r.supersededBy ?? null,
    requirement: r.requirement ?? null,
    runDocs: r.runDocs ?? null,
    error: r.error ?? null,
    startedAt: r.startedAt ?? null,
    endedAt: r.endedAt ?? null,
    durationMs: r.durationMs ?? null,
    usage: u,
    phases: (Array.isArray(r.phases) ? r.phases : []).map(phaseJson),
    stages: (Array.isArray(r.stages) ? r.stages : []).map(stageJson),
  }
}

/** JSON 渲染：`JSON.stringify(..., null, 2)`，不含结尾换行（runCli 补一个 `\n`）。纯函数。 */
export function renderJson(report) {
  return JSON.stringify(jsonProjection(report), null, 2)
}

/**
 * CLI 入口（AC-2/7/8/9）：**返回退出码，绝不调 process.exit**（D2：零子进程也能断言 0/1/2，
 * 且 stdout 必然 flush）。deps 默认值只在函数体内取 → import 期零环境依赖（AC-10）。
 * 错误路径只写 `err`：stdout 字节数恒为 0（AC-8）。
 */
export function runCli(argv, deps = {}) {
  const io = deps.io ?? nodeIo
  const env = deps.env ?? process.env
  const out = deps.out ?? ((s) => process.stdout.write(s))
  const err = deps.err ?? ((s) => process.stderr.write(s))
  const usage = `${USAGE_LINES.join('\n')}\n`
  const { help, json, runId } = parseArgs(argv)

  if (help) {
    out(usage)
    return 0
  }
  if (!runId) {
    err(`用法错误：缺少 runId\n${usage}`)
    return 2
  }

  const root = join(env.DSH_HOME || join(homedir(), '.dsh'), 'teamflow')
  const { entries, scanned } = collectJournal({ root, runId, io })
  if (!entries.length) {
    err(`未找到 run「${runId}」——已扫描 ${scanned.workspaces} 个工作区 / ${scanned.journals} 个 journal\n`)
    return 1
  }
  if (entries.length > 1) {
    const hits = entries.map((e) => String(e.ws)).sort(cmpStr)
    err(`runId「${runId}」在 ${entries.length} 个工作区同时命中：${hits.join(', ')}——请人工确认（不静默取首个）\n`)
    return 1
  }

  const report = buildReport(entries, { runId })
  out(`${json ? renderJson(report) : renderText(report)}\n`)
  return 0
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invoked) process.exitCode = runCli(process.argv.slice(2))
