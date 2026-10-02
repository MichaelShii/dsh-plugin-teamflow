#!/usr/bin/env node
/**
 * 人工介入（humanIntervention）归因巡检 —— 只读。
 *
 * 为什么需要：本仓曾长期按 **「humanIntervention 8/23 = 35%」** 排优先级，而那个数字取自
 * **早于 2026-09-17** 的 23 个 run。2026-10-02 用本脚本分层实测 91 个 run：
 *   | 分段                    | run | humanIntervention | failed |
 *   | 09-17 之前              | 58  | 20.7%             | 12     |
 *   | 09-17 之后（当前代码）  | 33  | 9.1%（3/33）      | 0      |
 * 且剩下的 3 次**全部**是 `knownIssuesAcceptance=true`（QA 复验超限 → 产品决策刻意交给人）。
 * ⇒ **没有可复跑的度量，旧数字就会一直驱动错误的优先级**。本脚本就是那个度量。
 *
 * 用法（插件仓根目录）：
 *   node scripts/hi-report.mjs                        # 人读归因清单（全部 run）
 *   node scripts/hi-report.mjs --since 2026-09-17     # 只看该日期（含）之后
 *   node scripts/hi-report.mjs --json [--since ...]   # 机读 JSON（schema=teamflow.hi-report/v1）
 *   node scripts/hi-report.mjs --help                 # 用法
 *
 * 只读三重（与 run-inspect.mjs 同款约定）：① 全部 IO 经可注入的 io 适配器，只暴露
 * existsSync / readdirSync / readFileSync 三个读函数；② 入口守卫（import.meta.url 与 argv[1]
 * 比对）保证 import 期零 IO、零输出；③ 源码不引用任何写盘 API 与子进程模块。
 * CLI 只返回**退出码**，不在内部调 process.exit（便于断言 0/1/2）。
 *
 * ⚠ 归因分桶只是**错误原文归类**，不是根因分析：桶名说「哪一类文案」，真实根因仍需看具体 run。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** JSON schema 常量（顶层首键）。 */
export const SCHEMA = 'teamflow.hi-report/v1'

const nodeIo = { existsSync, readdirSync, readFileSync }

/**
 * 归因分桶：只按 error 原文与 knownIssuesAcceptance 归类。
 * ⚠ 顺序敏感：先判「刻意设计」，再判错误文案 —— 否则 knownIssues 会被 H 桶吃掉，
 *   报表就看不出「剩下的人工介入其实都是设计使然」。
 */
export const CLASSES = [
  ['K knownIssues 验收（QA 超限，产品决策交人——刻意设计，非缺陷）', null, 'knownIssues'],
  ['A 验收产物缺结论行', /ACCEPTANCE\.md 缺少验收结论行|验收结论/, null],
  ['B 阶段预算熔断（未交付）', /超出阶段预算熔断/, null],
  ['C 阶段多次尝试未交付', /次尝试未交付/, null],
  ['D 提测门禁拦截', /提测门禁拦截/, null],
  ['E 需求与现状不符', /需求与现状不符/, null],
  ['F 环境 / 外部故障', /环境不可用|外部故障|external|envUnavailable/i, null],
  ['G 上下文 / 超长', /context|上下文|max-token|超长/i, null],
]

/** 单个 run 的归因。 */
export function classify(journal) {
  const j = journal || {}
  if (j.knownIssuesAcceptance === true) return CLASSES[0][0]
  const err = j.error || j.reason || null
  if (!err) return 'H 无 error（人工介入但已收口）'
  for (const [name, re] of CLASSES) if (re && re.test(String(err))) return name
  return 'Z 其它：' + String(err).slice(0, 60)
}

/**
 * 起跑时刻归一：journal 里既可能是 epoch 毫秒（当前格式），也可能是 ISO 字符串（早期格式）。
 * ⚠ 不能只写 `Number(v)` —— ISO 串会被算成 NaN，进而被 `|| 0` 吞成 0，**所有 run 都塌到同一时刻**，
 * 分层（--since）就会整段失灵（首跑实测即踩：夹具用 ISO 串时 `--since` 过滤出 0 条）。
 */
export function startedAtOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (v === null || v === undefined || v === '') return null
  const p = Date.parse(String(v))
  return Number.isFinite(p) ? p : null
}

/** 扫全部 run journal（只读，逐文件容错）。 */
export function buildScan(io, root) {
  const entries = []
  if (!io.existsSync(root)) return entries
  let wss = []
  try { wss = io.readdirSync(root) } catch (e) { return entries }
  for (const ws of wss) {
    const runsDir = join(root, ws, 'runs')
    if (!io.existsSync(runsDir)) continue
    let files = []
    try { files = io.readdirSync(runsDir) } catch (e) { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      let j
      try { j = JSON.parse(io.readFileSync(join(runsDir, f), 'utf8')) } catch (e) { continue }
      entries.push({
        id: j.id || j.runId || f.replace(/\.json$/, ''),
        ws,
        started: startedAtOf(j.startedAt),
        status: j.status || 'unknown',
        hi: j.humanIntervention === true,
        knownIssuesAcceptance: j.knownIssuesAcceptance === true,
        error: j.error || null,
        cls: classify(j),
      })
    }
  }
  return entries.sort((a, b) => (a.started || 0) - (b.started || 0))
}

const iso = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '-')

/** 计算报表（纯函数：文本态与 JSON 态共用，两态数字同源是结构事实）。 */
export function buildReport(entries, filter = {}) {
  const sinceMs = filter.since ? Date.parse(filter.since + 'T00:00:00Z') : null
  const set = Number.isFinite(sinceMs)
    ? entries.filter((e) => e.started && e.started >= sinceMs)
    : entries.slice()
  const hi = set.filter((e) => e.hi)
  const failed = set.filter((e) => e.status === 'failed')
  const byClass = (list) => {
    const m = {}
    for (const e of list) {
      m[e.cls] = m[e.cls] || { cls: e.cls, count: 0, runs: [] }
      m[e.cls].count++
      m[e.cls].runs.push({ id: e.id, status: e.status, date: iso(e.started), error: e.error })
    }
    return Object.values(m).sort((a, b) => b.count - a.count)
  }
  const status = {}
  for (const e of set) status[e.status] = (status[e.status] || 0) + 1
  return {
    schema: SCHEMA,
    since: filter.since || null,
    total: set.length,
    statusCounts: status,
    humanIntervention: {
      count: hi.length,
      rate: set.length ? Number(((hi.length / set.length) * 100).toFixed(1)) : null,
      byClass: byClass(hi),
    },
    failed: { count: failed.length, byClass: byClass(failed) },
  }
}

const USAGE = [
  'hi-report — humanIntervention 归因巡检（只读）',
  '',
  '用法：',
  '  node scripts/hi-report.mjs [--since YYYY-MM-DD] [--json]',
  '  node scripts/hi-report.mjs --help',
  '',
  '说明：扫描 $DSH_HOME/teamflow/<workspace>/runs/*.json，统计人工介入率并按错误原文归因。',
  '⚠ 分桶只是文案归类，不是根因分析；真实根因仍需 run-inspect 单条查看。',
].join('\n')

/** 文本态渲染（与 JSON 态共用 buildReport）。 */
export function renderText(r) {
  const L = []
  L.push(`humanIntervention 归因巡检（schema=${r.schema}）`)
  L.push(r.since ? `范围：${r.since} 之后（含）` : '范围：全部 run')
  L.push('')
  L.push(`run 总数：${r.total}   status：${JSON.stringify(r.statusCounts)}`)
  L.push(`人工介入：${r.humanIntervention.count} / ${r.total} = ${r.humanIntervention.rate !== null ? r.humanIntervention.rate + '%' : '-'}    failed：${r.failed.count}`)
  L.push('')
  L.push('── 人工介入归因（按次数降序）──')
  if (!r.humanIntervention.byClass.length) L.push('  （无）')
  for (const g of r.humanIntervention.byClass) {
    L.push(`  ${String(g.count).padStart(3)}  ${g.cls}`)
    for (const x of g.runs) L.push(`          ${x.id}  [${x.status}] ${x.date}  ${String(x.error || '').slice(0, 70)}`)
  }
  L.push('')
  L.push('── failed 归因（按次数降序）──')
  if (!r.failed.byClass.length) L.push('  （无）')
  for (const g of r.failed.byClass) {
    L.push(`  ${String(g.count).padStart(3)}  ${g.cls}`)
    for (const x of g.runs) L.push(`          ${x.id}  [${x.status}] ${x.date}  ${String(x.error || '').slice(0, 70)}`)
  }
  L.push('')
  L.push('（人工介入率 ' + (r.humanIntervention.rate !== null ? r.humanIntervention.rate + '%' : '-') +
    '；K 桶 = 刻意设计的产品决策，不计入缺陷）')
  return L.join('\n')
}

/** CLI 入口：返回退出码，绝不内部 process.exit。 */
export function runCli(argv, deps = {}) {
  const args = argv || []
  const io = deps.io || nodeIo
  const emit = (s) => { if (deps.log) deps.log(s); else console.log(s) }
  if (args.includes('--help') || args.includes('-h')) { emit(USAGE); return 0 }
  let since = null
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--since') { since = args[i + 1] || null; i++; continue }
    if (a === '--json') { json = true; continue }
    emit(`未识别参数：${a}\n\n${USAGE}`)
    return 2
  }
  if (since && !/^\d{4}-\d{2}-\d{2}$/.test(since)) {
    emit(`--since 需为 YYYY-MM-DD：${since}`)
    return 2
  }
  const env = deps.env || process.env
  // root 也可注入（与 io 同款）：测试用内存目录时不必构造真实的 $DSH_HOME 路径。
  const root = deps.root || join(env.DSH_HOME || join(homedir(), '.dsh'), 'teamflow')
  const r = buildReport(buildScan(io, root), { since: since || undefined })
  emit(json ? JSON.stringify(r, null, 2) : renderText(r))
  return 0
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invoked) process.exitCode = runCli(process.argv.slice(2))
