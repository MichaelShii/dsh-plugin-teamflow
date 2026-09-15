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
 * 典型输出：每个有复验的 run 一张轮次表 + 全局聚合（收敛/停滞次数、检测命令可用率、轮次成本）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const root = join(dshHome, 'teamflow')
const onlyRun = process.argv[2] || null

/** 收集全部 journal（每个工作区一个 runs/）。 */
function collect() {
  const out = []
  if (!existsSync(root)) return out
  for (const ws of readdirSync(root, { withFileTypes: true })) {
    if (!ws.isDirectory()) continue
    const runsDir = join(root, ws.name, 'runs')
    if (!existsSync(runsDir)) continue
    for (const f of readdirSync(runsDir)) {
      if (!f.endsWith('.json')) continue
      if (onlyRun && f !== `${onlyRun}.json`) continue
      try {
        const j = JSON.parse(readFileSync(join(runsDir, f), 'utf8'))
        if (j && Array.isArray(j.stages) && j.stages.length) out.push({ ws: ws.name, j })
      } catch (e) { /* 损坏的 journal 跳过 */ }
    }
  }
  return out
}

const all = collect()
const withRounds = all.filter(({ j }) => Array.isArray(j.qaRounds) && j.qaRounds.length)
const withRework = withRounds.filter(({ j }) => j.qaRounds.filter((r) => r.outcome === 'rework').length > 0)

console.log(`扫描到 run=${all.length}；带 QA 轮次埋点=${withRounds.length}；其中发生过打回=${withRework.length}`)
if (!withRounds.length) {
  console.log('\n（暂无埋点数据：埋点是 2026-09-15 之后才写入 journal 的，需要新的 run 来积累。）')
  process.exit(0)
}

let converging = 0
let stalling = 0
let checks = 0
let defects = 0
let gates = 0
let fixRounds = 0
const roundCosts = []

for (const { ws, j } of withRework) {
  console.log(`\n── ${j.id}（${ws}，status=${j.status}${j.humanIntervention ? ' +human' : ''}）──`)
  for (const r of j.qaRounds) {
    const ids = (r.defects || []).map((d) => `${d.id}${d.sev ? `(${d.sev})` : ''}`).join(' ')
    console.log(`  R${r.round} outcome=${String(r.outcome).padEnd(7)} 阻断=${r.blocking} P3=${r.p3} 新=${r.newFps} 重复=${r.repeats} 消解=${r.resolved} 带检测命令=${r.withCheck}/${r.blocking} gate=${r.gate === null ? '-' : r.gate} qaCalls=${r.qaCalls ?? '-'} fixCalls=${r.fixCalls ?? '-'}${ids ? `\n      ${ids}` : ''}`)
    if (r.round > 1) {
      if (Number(r.repeats) > 0) stalling += 1
      else if (Number(r.resolved) > 0) converging += 1
    }
    checks += Number(r.withCheck) || 0
    defects += Number(r.blocking) || 0
    if (r.outcome === 'rework') {
      fixRounds += 1
      if (r.gate === true) gates += 1
      if (typeof r.fixCalls === 'number' && typeof r.qaCalls === 'number') roundCosts.push(r.fixCalls + r.qaCalls)
    }
  }
}

const avg = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null)
console.log('\n═══ 聚合（决定 D 要不要做的三个数）═══')
console.log(`复验轮里 收敛次数=${converging} 停滞次数=${stalling}（停滞 = 上一轮修过的缺陷原样再现）`)
console.log(`阻断缺陷带「检测命令」的比例=${defects ? `${checks}/${defects}（${Math.round((checks / defects) * 100)}%）` : 'n/a'} —— 稳定身份的可用率（B 方案落地率）`)
console.log(`修复轮落「类别门禁」=${fixRounds ? `${gates}/${fixRounds}` : 'n/a'}（A 方案落地率）`)
console.log(`单轮成本（修复+复验 calls，均值）=${avg(roundCosts) ?? 'n/a'}${roundCosts.length ? `（样本 ${roundCosts.length}：${roundCosts.join(', ')}）` : ''}`)
console.log('\n判据（供人决策，非自动动作）：收敛次数 ≫ 停滞次数 且 带检测命令比例高 → 收敛判据可做；反之先修 B/A 的落地率。')
