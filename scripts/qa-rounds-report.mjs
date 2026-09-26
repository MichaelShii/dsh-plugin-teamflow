/**
 * QA 轮次收敛报告（D 方案的**读侧**）——只读，不改任何数据。
 *
 * 为什么需要：QA 的逐轮阻断集合已经由 pipeline 埋点进 `journal.qaRounds`
 * （`{round, seq, blocking, p3, defects:[{id,sev,module,fp}], newFps, repeats, resolved,
 *   withCheck, withCriterion, qaCalls, fixCalls, gate, outcome}`）。
 * 本脚本把它读成一张表，回答「要不要把 `QA_REWORK_LIMIT` 的硬上限换成收敛判据」这个问题需要的三件事：
 *   ① 真实复验轮里，阻断集合是在**收敛**（resolved > 0 且 repeats = 0）还是在**停滞**（repeats > 0）？
 *   ② 缺陷行带「检测命令」的比例有多高（= 稳定身份可用率；B 方案的落地率）？
 *   ③ 修复轮有没有落「类别门禁」（`gate`），以及每轮的真实调用数（成本）。
 *
 * 用法（插件仓根目录）：
 *   node scripts/qa-rounds-report.mjs                 # 扫 $DSH_HOME/teamflow 下全部 run
 *   node scripts/qa-rounds-report.mjs <runId>         # 只看某个 run
 *   node scripts/qa-rounds-report.mjs --json          # 机读输出（JSON v1）
 *   node scripts/qa-rounds-report.mjs --json <runId>  # 等价于 <runId> --json
 * 典型输出（默认）：每个有复验的 run 一张轮次表 + 全局聚合（收敛/停滞次数、检测命令可用率、轮次成本）。
 *
 * JSON v1（`--json`）结构概要——顶层固定键序，`JSON.stringify(..., null, 2)` + 一个结尾换行：
 *   schema   : "teamflow.qa-rounds-report/v1"（常量）
 *   filter   : { runId }            命中的 runId 过滤（未传 → null）
 *   scanned  : { runs, withRounds, withRework }
 *   runs[]   : { runId, workspace, status, humanIntervention, hasRework, rounds[] }
 *              runs 在**渲染期**按 workspace → runId 字典序排序（文本态保持 fs 枚举序，两态刻意不同）
 *   rounds[] : { round, seq, blocking, p3, newFps, repeats, resolved, withCheck, withCriterion,
 *                qaCalls, fixCalls, gate, outcome, defects[{id, sev, module, fp}] }
 *              缺失字段补 null（`defects` 非数组 → `[]`）
 *   aggregate: { scope, converging, stalling, checks, blockingDefects, checksRatio,
 *                fixRounds, gates, roundCosts { samples, avg } }
 *              scope = "runs-with-rework"；checksRatio 为 0–1（无阻断缺陷 → null）
 * 文本态与 JSON 态共用同一个 Report 对象（buildReport 是唯一计算点）→ 两态数字同源是结构事实。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'

/** 真实 fs 适配器（可注入替身：仅这三个函数，测试用内存实现即可覆盖全部扫描分支）。 */
const nodeIo = { existsSync, readdirSync, readFileSync }

/**
 * 解析 argv（不含 node/script 两个前缀）。
 * `--json` 只看是否存在；runId = **首个不以 `-` 开头的参数**（未知 `-` 前缀参数静默忽略）。
 * 纯函数：不抛、不读环境、不打印。
 */
export function parseArgs(argv) {
  const json = argv.includes('--json')
  const runId = argv.find((a) => !a.startsWith('-')) ?? null
  return { json, runId }
}

/**
 * 收集全部 journal（每个工作区一个 runs/）——纯 IO 适配层：只读、无副作用、不打印。
 * 容错口径：root 不存在 → []；目录项非目录跳过；文件须 .json；onlyRun 命中 `${onlyRun}.json`；
 * JSON.parse 失败 / 无 stages / stages 为空 → 跳过该文件，不影响同目录其余文件。
 * **保持 readdir 枚举顺序**（文本态的顺序即由此决定，AC-1）。
 */
export function collectJournals({ root, onlyRun = null, io = nodeIo }) {
  const out = []
  if (!io.existsSync(root)) return out
  for (const ws of io.readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const runsDir = join(root, ws.name, 'runs')
    if (!io.existsSync(runsDir)) continue
    for (const f of io.readdirSync(runsDir)) {
      if (!f.endsWith('.json')) continue
      if (onlyRun && f !== `${onlyRun}.json`) continue
      try {
        const j = JSON.parse(io.readFileSync(join(runsDir, f), 'utf8'))
        if (j && Array.isArray(j.stages) && j.stages.length) out.push({ ws: ws.name, j })
      } catch (e) { /* 损坏的 journal 跳过 */ }
    }
  }
  return out
}

/**
 * 唯一计算点：entries → Report（纯函数，无 IO、无输出、不修改入参）。
 * 口径（刻意与 `runs` 不同，由 `aggregate.scope` 自证）：
 *   runs    = 全部带 qaRounds 的 run（含未打回，用 hasRework 区分）
 *   aggregate = 仅**发生过打回**的 run 的全部轮次（= 今天文本口径）
 * 聚合只从**原始** round 读（不做归一化）：`Number(x)||0`、`r.round > 1`、`r.gate === true`、
 * `typeof x === 'number'` 都已天然容忍缺失 → 归一化对数字中性。
 */
export function buildReport(entries, filter = {}) {
  const onlyRun = typeof filter === 'string' ? filter : (filter?.runId ?? null)
  const scanned = { runs: entries.length, withRounds: 0, withRework: 0 }
  const runs = []
  let converging = 0
  let stalling = 0
  let checks = 0
  let blockingDefects = 0
  let fixRounds = 0
  let gates = 0
  const samples = []

  for (const { ws, j } of entries) {
    if (!Array.isArray(j.qaRounds) || !j.qaRounds.length) continue
    scanned.withRounds += 1
    const hasRework = j.qaRounds.filter((r) => r.outcome === 'rework').length > 0
    if (hasRework) scanned.withRework += 1
    runs.push({
      runId: j.id,
      workspace: ws,
      status: j.status,
      humanIntervention: Boolean(j.humanIntervention),
      hasRework,
      rounds: j.qaRounds,
    })
    if (!hasRework) continue
    for (const r of j.qaRounds) {
      if (r.round > 1) {
        if (Number(r.repeats) > 0) stalling += 1
        else if (Number(r.resolved) > 0) converging += 1
      }
      checks += Number(r.withCheck) || 0
      blockingDefects += Number(r.blocking) || 0
      if (r.outcome === 'rework') {
        fixRounds += 1
        if (r.gate === true) gates += 1
        if (typeof r.fixCalls === 'number' && typeof r.qaCalls === 'number') samples.push(r.fixCalls + r.qaCalls)
      }
    }
  }

  // 键顺序 = JSON v1 的键顺序（§3.2）；roundCosts 内部 samples → avg
  return {
    filter: { runId: onlyRun },
    scanned,
    runs,
    aggregate: {
      scope: 'runs-with-rework',
      converging,
      stalling,
      checks,
      blockingDefects,
      checksRatio: blockingDefects ? checks / blockingDefects : null,
      fixRounds,
      gates,
      roundCosts: {
        samples,
        avg: samples.length ? Math.round(samples.reduce((x, y) => x + y, 0) / samples.length) : null,
      },
    },
  }
}

/**
 * 文本渲染（默认路径）——**逐字复刻**改造前的模板，返回不含结尾换行的完整文本（主入口补 '\n'）。
 * 硬约束：
 *   1. 每行对应旧代码的一次 console.log；带 '\n' 前缀的行拆成「空行 + 内容行」两个元素。
 *   2. 带缺陷 id 的那一行仍是**一个**元素，内容为 `${base}\n      ${ids}`（内嵌换行，勿拆勿加缩进）。
 *   3. 空态**早返回**：只有 header + 提示语，不含聚合段。
 *   4. **零归一化**：`String(r.outcome).padEnd(7)`、`r.gate === null ? '-' : r.gate` 等用原始字段，
 *      缺字段仍输出 `undefined`（旧行为）；`null` 补位只存在于 renderJson 的投影里。
 *   5. 聚合段四行 + 判据行逐字照抄（`═══`、全角括号、样本串拼接）。
 * 顺序：`report.runs` 的**原序**（fs 枚举序）——排序只在 renderJson，勿"顺手统一"（保 AC-1）。
 */
export function renderText(report) {
  const { scanned, runs, aggregate: a } = report
  const lines = []
  lines.push(`扫描到 run=${scanned.runs}；带 QA 轮次埋点=${scanned.withRounds}；其中发生过打回=${scanned.withRework}`)
  if (!scanned.withRounds) {
    lines.push('')
    lines.push('（暂无埋点数据：埋点是 2026-09-15 之后才写入 journal 的，需要新的 run 来积累。）')
    return lines.join('\n')
  }

  for (const run of runs) {
    if (!run.hasRework) continue
    lines.push('')
    lines.push(`── ${run.runId}（${run.workspace}，status=${run.status}${run.humanIntervention ? ' +human' : ''}）──`)
    for (const r of run.rounds) {
      const ids = (r.defects || []).map((d) => `${d.id}${d.sev ? `(${d.sev})` : ''}`).join(' ')
      lines.push(`  R${r.round} outcome=${String(r.outcome).padEnd(7)} 阻断=${r.blocking} P3=${r.p3} 新=${r.newFps} 重复=${r.repeats} 消解=${r.resolved} 带检测命令=${r.withCheck}/${r.blocking} gate=${r.gate === null ? '-' : r.gate} qaCalls=${r.qaCalls ?? '-'} fixCalls=${r.fixCalls ?? '-'}${ids ? `\n      ${ids}` : ''}`)
    }
  }

  lines.push('')
  lines.push('═══ 聚合（决定 D 要不要做的三个数）═══')
  lines.push(`复验轮里 收敛次数=${a.converging} 停滞次数=${a.stalling}（停滞 = 上一轮修过的缺陷原样再现）`)
  lines.push(`阻断缺陷带「检测命令」的比例=${a.checksRatio === null ? 'n/a' : `${a.checks}/${a.blockingDefects}（${Math.round(a.checksRatio * 100)}%）`} —— 稳定身份的可用率（B 方案落地率）`)
  lines.push(`修复轮落「类别门禁」=${a.fixRounds ? `${a.gates}/${a.fixRounds}` : 'n/a'}（A 方案落地率）`)
  lines.push(`单轮成本（修复+复验 calls，均值）=${a.roundCosts.avg ?? 'n/a'}${a.roundCosts.samples.length ? `（样本 ${a.roundCosts.samples.length}：${a.roundCosts.samples.join(', ')}）` : ''}`)
  lines.push('')
  lines.push('判据（供人决策，非自动动作）：收敛次数 ≫ 停滞次数 且 带检测命令比例高 → 收敛判据可做；反之先修 B/A 的落地率。')
  return lines.join('\n')
}

/** 逐字符比较（不用 localeCompare，避免 locale 依赖）。 */
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * JSON v1 投影（**渲染期**）：排序 + 缺失补 null 只在这里发生，勿回流进 renderText。
 * 排序只在这里发生（AC-5：确定性排序）；文本态保持 fs 枚举序（AC-1）。两态刻意不同。
 */
function jsonProjection(report, runIdOverride) {
  const sorted = [...report.runs].sort(
    (x, y) => cmpStr(String(x.workspace), String(y.workspace)) || cmpStr(String(x.runId), String(y.runId)),
  )
  const runs = sorted.map((run) => ({
    runId: run.runId ?? null,
    workspace: run.workspace ?? null,
    status: run.status ?? null,
    humanIntervention: Boolean(run.humanIntervention),
    hasRework: Boolean(run.hasRework),
    rounds: (Array.isArray(run.rounds) ? run.rounds : []).map((raw) => {
      const r = raw ?? {}
      const defects = Array.isArray(r.defects)
        ? r.defects.map((d) => ({ id: d?.id ?? null, sev: d?.sev ?? null, module: d?.module ?? null, fp: d?.fp ?? null }))
        : []
      return {
        round: r.round ?? null,
        seq: r.seq ?? null,
        blocking: r.blocking ?? null,
        p3: r.p3 ?? null,
        newFps: r.newFps ?? null,
        repeats: r.repeats ?? null,
        resolved: r.resolved ?? null,
        withCheck: r.withCheck ?? null,
        withCriterion: r.withCriterion ?? null,
        qaCalls: r.qaCalls ?? null,
        fixCalls: r.fixCalls ?? null,
        gate: r.gate ?? null,
        outcome: r.outcome ?? null,
        defects,
      }
    }),
  }))
  const runId = runIdOverride ?? report.filter?.runId ?? null
  return {
    schema: 'teamflow.qa-rounds-report/v1',
    filter: { runId },
    scanned: { ...report.scanned },
    runs,
    aggregate: report.aggregate,
  }
}

/** JSON 渲染：`JSON.stringify(..., null, 2)`，不含结尾换行（主入口补）。纯函数。 */
export function renderJson(report, runIdOverride) {
  return JSON.stringify(jsonProjection(report, runIdOverride), null, 2)
}

/**
 * CLI 入口：**只有直跑时**才读 DSH_HOME / 写 stdout（import 期零 IO、零环境依赖）。
 * 用 `process.stdout.write` 一次写完（旧实现空态 `process.exit(0)` 有 stdout 未 flush 的隐患，
 * 去掉后字节不变、退出码默认 0）。
 */
function main() {
  const { json, runId } = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const report = buildReport(collectJournals({ root: join(dshHome, 'teamflow'), onlyRun: runId }), { runId })
  process.stdout.write((json ? renderJson(report) : renderText(report)) + '\n')
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invoked) main()
