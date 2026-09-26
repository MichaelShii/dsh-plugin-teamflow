/**
 * dsh-plugin-teamflow — `scripts/qa-rounds-report.mjs` 永久门禁（r11）。
 *
 * **为什么存在**：这个脚本的默认文本态是给维护者看的，`--json` 是给程序看的，
 * 两者的正确方向相反——文本要**字节零变化**（旧模板逐字保留，缺字段仍输出 `undefined`），
 * JSON 要**键集合固定**（缺失键补 `null`、`defects` 缺失补 `[]`）、并且**排序只在 JSON 渲染器**。
 * 任何"顺手统一"（把排序搬进文本态、把归一化共享给文本态）都会静默破一条 AC 而不报错，
 * 所以这里用 fixture 把两条方向相反的规则同时钉死。
 *
 * **设计约束（都来自既有约定，不是新发明）**：
 *  1. 只 import 导出契约、只喂**内存 fixture**：受限沙箱下 piped-stdio 子进程会 EPERM
 *     （`commit-path.test.js` 有 SKIP 先例），因此本文件禁止任何子进程；`io` 注入是脚本侧
 *     为此付出的唯一抽象。
 *  2. 绝不读写真实 `$DSH_HOME`：收集路径全部走假 `io`，或走一个确定不存在的真实路径。
 *  3. 黄金文本是**手写**的（按 HEAD 旧源码的 `console.log` 模板逐字转写），
 *     不是从新实现输出反抄——否则重构改错时测试会跟着一起改对。
 *  4. 风格与既有套件同形：无框架、`✓`/`✗`、失败非零退出。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
/** 值相等（失败时打印期望/实得，长度受限）。 */
const eq = (actual, expected, msg) => {
  if (actual === expected) { console.log(`  ✓ ${msg}`); return }
  failed++
  console.error(`  ✗ ${msg}\n      期望 ${JSON.stringify(expected)}\n      实得 ${JSON.stringify(actual)}`)
}
/** 键集合/数组深比较（顺序敏感，`JSON.stringify` 足够）。 */
const deepEq = (actual, expected, msg) => {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) { console.log(`  ✓ ${msg}`); return }
  failed++
  console.error(`  ✗ ${msg}\n      期望 ${b}\n      实得 ${a}`)
}
/** 长文本逐字符比较，只打印首个差异附近，避免刷屏。 */
const textEq = (actual, expected, msg) => {
  if (actual === expected) { console.log(`  ✓ ${msg}`); return }
  failed++
  let i = 0
  while (i < actual.length && i < expected.length && actual[i] === expected[i]) i++
  console.error(`  ✗ ${msg}\n      首个差异 @${i}（长度 期望${expected.length}/实得${actual.length}）`)
  console.error(`      期望 …${JSON.stringify(expected.slice(Math.max(0, i - 40), i + 40))}`)
  console.error(`      实得 …${JSON.stringify(actual.slice(Math.max(0, i - 40), i + 40))}`)
}

// 禁词字面量拆写：本文件自身也要通过"不得出现子进程/写盘调用"的静态检查，
// 直接写字面量会让检查自伤，所以用拼接构造。
const BANNED = ['write' + 'File', 'append' + 'File', 'm' + 'kdir', 'rm' + 'Sync', 'un' + 'link', 'child_' + 'process', 'sp' + 'awn']

const SCRIPT_URL = new URL('../scripts/qa-rounds-report.mjs', import.meta.url)
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL)

// ── G0) 导入面：import 期零 stdout、导出契约、源码只读 + 入口守卫 ──
console.log('\n[G0] 导入面（AC-8）：import 不产生 stdout / 导出契约 / 源码无写盘')
const stdoutChunks = []
const origWrite = process.stdout.write
process.stdout.write = function (chunk) { stdoutChunks.push(String(chunk)); return true }
let mod
try {
  mod = await import(SCRIPT_URL.href)
} finally {
  process.stdout.write = origWrite
}
ok(!!mod, '模块动态导入成功')
eq(stdoutChunks.length, 0, 'import 期零 stdout（若 CLI 体未守卫会在此写入整份报告）')
const api = ['parseArgs', 'collectJournals', 'buildReport', 'renderText', 'renderJson']
for (const name of api) ok(typeof mod[name] === 'function', `导出 ${name} 为 function`)
const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf8')
const bannedHit = BANNED.find((t) => SCRIPT_SRC.includes(t))
ok(bannedHit === undefined, `脚本源码无写盘/子进程调用（命中：${bannedHit ?? '无'}）`)
ok(/const invoked = process\.argv\[1\]/.test(SCRIPT_SRC) && /if \(invoked\) main\(\)/.test(SCRIPT_SRC),
  'CLI 体被入口守卫包裹（仅直跑执行）')
const SELF_SRC = readFileSync(fileURLToPath(import.meta.url), 'utf8')
const selfHit = BANNED.find((t) => SELF_SRC.includes(t))
ok(selfHit === undefined, `本套件自身也不含写盘/子进程调用（命中：${selfHit ?? '无'}）`)
deepEq(mod.collectJournals({ root: join(process.cwd(), '.no-such-teamflow-root-r11') }), [],
  'root 不存在 → collectJournals 返回 [] 且不抛')

// ── fixture：黄金文本态（2 个 run：1 个打回 run 含 R1/R2 停滞/R3 收敛 + 1 个未打回 run）──
const def = (id, sev, module, fp) => ({ id, sev, module, fp })
const goldenBeta = {
  id: 'tf-beta-1', status: 'done', humanIntervention: false, stages: [{ phase: 'qa' }],
  qaRounds: [
    { round: 1, seq: 1, blocking: 3, p3: 1, newFps: 2, repeats: 0, resolved: 0, withCheck: 2, withCriterion: 1, qaCalls: 5, fixCalls: 4, gate: false, outcome: 'rework', defects: [def('D-1', 'P1', 'host', 'aaa'), def('D-2', 'P2', 'client', 'bbb')] },
    { round: 2, seq: 3, blocking: 2, p3: 0, newFps: 1, repeats: 2, resolved: 0, withCheck: 2, withCriterion: 2, qaCalls: 3, fixCalls: 3, gate: true, outcome: 'rework', defects: [def('D-1', 'P1', 'host', 'aaa')] },
    { round: 3, seq: 5, blocking: 1, p3: 0, newFps: 0, repeats: 0, resolved: 1, withCheck: 1, withCriterion: 1, qaCalls: 2, fixCalls: 1, gate: true, outcome: 'pass', defects: [] },
  ],
}
const goldenAlpha = {
  id: 'tf-alpha-2', status: 'running', humanIntervention: true, stages: [{ phase: 'qa' }],
  qaRounds: [
    { round: 1, seq: 1, blocking: 0, p3: 0, newFps: 0, repeats: 0, resolved: 0, withCheck: 0, withCriterion: 0, qaCalls: 1, fixCalls: 0, gate: null, outcome: 'pass', defects: [] },
  ],
}
const goldenEntries = [{ ws: 'beta', j: goldenBeta }, { ws: 'alpha', j: goldenAlpha }]

// 手写黄金文本：按 HEAD 旧源码的 console.log 模板逐字转写（`\n` 前缀行拆成空行 + 内容行；
// 缺陷 id 仍附着在同一元素内、缩进 6 空格；`padEnd(7)` 带来的空格照抄）。
const GOLDEN_TEXT = [
  '扫描到 run=2；带 QA 轮次埋点=2；其中发生过打回=1',
  '',
  '── tf-beta-1（beta，status=done）──',
  '  R1 outcome=rework  阻断=3 P3=1 新=2 重复=0 消解=0 带检测命令=2/3 gate=false qaCalls=5 fixCalls=4',
  '      D-1(P1) D-2(P2)',
  '  R2 outcome=rework  阻断=2 P3=0 新=1 重复=2 消解=0 带检测命令=2/2 gate=true qaCalls=3 fixCalls=3',
  '      D-1(P1)',
  '  R3 outcome=pass    阻断=1 P3=0 新=0 重复=0 消解=1 带检测命令=1/1 gate=true qaCalls=2 fixCalls=1',
  '',
  '═══ 聚合（决定 D 要不要做的三个数）═══',
  '复验轮里 收敛次数=1 停滞次数=1（停滞 = 上一轮修过的缺陷原样再现）',
  '阻断缺陷带「检测命令」的比例=5/6（83%） —— 稳定身份的可用率（B 方案落地率）',
  '修复轮落「类别门禁」=1/2（A 方案落地率）',
  '单轮成本（修复+复验 calls，均值）=8（样本 2：9, 6）',
  '',
  '判据（供人决策，非自动动作）：收敛次数 ≫ 停滞次数 且 带检测命令比例高 → 收敛判据可做；反之先修 B/A 的落地率。',
].join('\n')
const GOLDEN_EMPTY = [
  '扫描到 run=0；带 QA 轮次埋点=0；其中发生过打回=0',
  '',
  '（暂无埋点数据：埋点是 2026-09-15 之后才写入 journal 的，需要新的 run 来积累。）',
].join('\n')

// ── G1) 黄金文本：renderText 与旧模板逐字符一致（AC-1）──
console.log('\n[G1] 黄金文本（AC-1）：文本态逐字复刻旧模板，且不含结尾换行')
const report = mod.buildReport(goldenEntries, { runId: null })
textEq(mod.renderText(report), GOLDEN_TEXT, '非空态：renderText === 手写黄金文本')
ok(!mod.renderText(report).endsWith('\n'), 'renderText 不含结尾换行（由入口补）')
const emptyReport = mod.buildReport([], { runId: null })
textEq(mod.renderText(emptyReport), GOLDEN_EMPTY, '空态：仅 header + 提示语')
ok(!mod.renderText(emptyReport).includes('═══'), '空态早返回：不含聚合段')

// ── G2) JSON 合法且纯（AC-2/AC-4）──
console.log('\n[G2] JSON 合法且纯（AC-2/4）')
const jsonText = mod.renderJson(report)
let parsed = null
try { parsed = JSON.parse(jsonText) } catch (e) { parsed = null }
ok(parsed !== null, 'JSON.parse(renderJson(report)) 成功（stdout 恰好一个 JSON 对象）')
ok(jsonText === mod.renderJson(report), '同一 report 渲染两次逐字节相同（无时间戳/随机序）')
ok(!jsonText.endsWith('\n'), 'renderJson 不含结尾换行（由入口补）')
ok(!/扫描到|暂无埋点数据|═══|──/.test(jsonText), 'JSON 零人读文案混入（无 扫描到/═══/──/暂无）')
ok(!/[A-Za-z]:[\\/]|\/home\/|\/Users\//.test(jsonText), 'JSON 无环境绝对路径泄漏')

// ── G3) argv 三形态：位置无关，runId = 首个非 `-` 参数（AC-3）──
console.log('\n[G3] argv 解析（AC-3）：--json 与 runId 位置无关')
deepEq(mod.parseArgs(['--json']), { json: true, runId: null }, "['--json'] → {json:true,runId:null}")
deepEq(mod.parseArgs(['--json', 'tf-x']), { json: true, runId: 'tf-x' }, "['--json','tf-x'] → runId=tf-x")
deepEq(mod.parseArgs(['tf-x', '--json']), { json: true, runId: 'tf-x' }, "['tf-x','--json'] → 与上等价")
deepEq(mod.parseArgs(['--nope']), { json: false, runId: null }, "['--nope'] → 未知短横参数忽略，runId=null")
deepEq(mod.parseArgs(['--json', '--nope', 'tf-y']), { json: true, runId: 'tf-y' }, '首个非短横参数胜出')
eq(mod.parseArgs(['tf-x', '--json']).runId, mod.parseArgs(['--json', 'tf-x']).runId, '两种位置形态的 runId 相等')

// ── G4) 形状与排序：键集合固定 / 缺失补 null / 排序只在 JSON（AC-4/5）──
console.log('\n[G4] 形状与排序（AC-4/5）：键集合固定 + 缺失补 null + 排序只在 JSON')
const shapeEntries = [
  { ws: 'zeta', j: { id: 'tf-z-2', status: 'failed', stages: [{}], qaRounds: [{ round: 1, outcome: 'rework' }] } },
  { ws: 'alpha', j: { id: 'tf-a-9', status: 'done', humanIntervention: true, stages: [{}], qaRounds: [{ round: 1, outcome: 'rework', blocking: 1, defects: 'oops' }] } },
  { ws: 'alpha', j: { id: 'tf-a-1', status: 'done', stages: [{}], qaRounds: [{ round: 1, outcome: 'pass', defects: [{ id: 'D' }] }] } },
]
const shapeReport = mod.buildReport(shapeEntries, { runId: 'tf-anything' })
deepEq(Object.keys(shapeReport), ['filter', 'scanned', 'runs', 'aggregate'], 'report 顶层键顺序 = filter/scanned/runs/aggregate')
const shapeJson = JSON.parse(mod.renderJson(shapeReport))
deepEq(Object.keys(shapeJson), ['schema', 'filter', 'scanned', 'runs', 'aggregate'], 'JSON 顶层固定键集合')
eq(shapeJson.schema, 'teamflow.qa-rounds-report/v1', 'schema 为 v1 常量')
eq(shapeJson.filter.runId, 'tf-anything', 'filter.runId 透传过滤参数')
deepEq(shapeJson.runs.map((r) => `${r.workspace}/${r.runId}`), ['alpha/tf-a-1', 'alpha/tf-a-9', 'zeta/tf-z-2'],
  'JSON runs 按 workspace → runId 字典序（输入顺序是 zeta/alpha9/alpha1）')
const [alphaOne, alphaNine, zetaTwo] = shapeJson.runs
deepEq(Object.keys(alphaOne), ['runId', 'workspace', 'status', 'humanIntervention', 'hasRework', 'rounds'], 'run 键集合固定')
deepEq(Object.keys(alphaOne.rounds[0]), ['round', 'seq', 'blocking', 'p3', 'newFps', 'repeats', 'resolved', 'withCheck', 'withCriterion', 'qaCalls', 'fixCalls', 'gate', 'outcome', 'defects'], 'round 键集合固定')
deepEq(Object.keys(shapeJson.aggregate), ['scope', 'converging', 'stalling', 'checks', 'blockingDefects', 'checksRatio', 'fixRounds', 'gates', 'roundCosts'], 'aggregate 键集合固定')
deepEq(Object.keys(shapeJson.aggregate.roundCosts), ['samples', 'avg'], 'roundCosts 键集合固定')
eq(zetaTwo.rounds[0].round, 1, '缺失字段：round 保留原值')
eq(zetaTwo.rounds[0].seq, null, '缺失字段 seq → null')
eq(zetaTwo.rounds[0].gate, null, '缺失字段 gate → null')
eq(zetaTwo.rounds[0].qaCalls, null, '缺失字段 qaCalls → null')
ok(zetaTwo.rounds[0].outcome === 'rework', 'outcome 原值保留')
deepEq(zetaTwo.rounds[0].defects, [], 'defects 缺失 → []')
deepEq(alphaNine.rounds[0].defects, [], 'defects 非数组 → []')
eq(alphaNine.rounds[0].blocking, 1, '未缺失字段不被归一化覆盖')
deepEq(alphaOne.rounds[0].defects[0], { id: 'D', sev: null, module: null, fp: null }, 'defect 键集合固定且缺失补 null')
deepEq(Object.keys(alphaOne.rounds[0].defects[0]), ['id', 'sev', 'module', 'fp'], 'defect 键顺序固定')
eq(alphaOne.humanIntervention, false, 'humanIntervention 归为布尔')
eq(alphaNine.humanIntervention, true, 'humanIntervention=true 保留')
// 文本态对 `defects` 非数组**不**容错（旧模板原样 `(r.defects || []).map`），
// 所以排序反向断言单独用一个字段齐全的 fixture，不拿 shapeEntries 去撞文本态。
const orderEntries = [
  { ws: 'zeta', j: { id: 'tf-z-2', status: 'failed', stages: [{}], qaRounds: [{ round: 1, outcome: 'rework', defects: [] }] } },
  { ws: 'alpha', j: { id: 'tf-a-9', status: 'done', stages: [{}], qaRounds: [{ round: 1, outcome: 'rework', defects: [] }] } },
]
const orderReport = mod.buildReport(orderEntries, { runId: null })
const orderText = mod.renderText(orderReport)
const zPos = orderText.indexOf('tf-z-2')
const aNinePos = orderText.indexOf('tf-a-9')
ok(zPos >= 0 && aNinePos >= 0 && zPos < aNinePos, '反向断言：文本态保持输入顺序（zeta 在 alpha9 之前）')
deepEq(JSON.parse(mod.renderJson(orderReport)).runs.map((r) => r.runId), ['tf-a-9', 'tf-z-2'],
  '同一次渲染里 JSON 把 zeta 排到最后（排序只在 renderJson）')

// ── G5) 跨态数字同源：从文本抽数字与 aggregate 逐项比对（AC-6）──
console.log('\n[G5] 跨态数字同源（AC-6）：文本抽数字 vs aggregate 逐项相等')
const a = report.aggregate
const gtext = mod.renderText(report)
let m = gtext.match(/收敛次数=(\d+) 停滞次数=(\d+)/)
ok(!!m && Number(m[1]) === a.converging && Number(m[2]) === a.stalling,
  `收敛/停滞同源（文本 ${m?.[1]}/${m?.[2]} vs aggregate ${a.converging}/${a.stalling}）`)
m = gtext.match(/比例=(\d+)\/(\d+)（(\d+)%）/)
ok(!!m && Number(m[1]) === a.checks && Number(m[2]) === a.blockingDefects && Number(m[3]) === Math.round(a.checksRatio * 100),
  `checksRatio 同源（文本 ${m?.[0]} vs aggregate ${a.checks}/${a.blockingDefects}=${a.checksRatio}）`)
m = gtext.match(/「类别门禁」=(\d+)\/(\d+)/)
ok(!!m && Number(m[1]) === a.gates && Number(m[2]) === a.fixRounds,
  `门禁比例同源（文本 ${m?.[0]} vs aggregate ${a.gates}/${a.fixRounds}）`)
m = gtext.match(/均值）=(\d+)/)
ok(!!m && Number(m[1]) === a.roundCosts.avg, `roundCosts.avg 同源（文本 ${m?.[1]} vs aggregate ${a.roundCosts.avg}）`)
m = gtext.match(/样本 (\d+)：([^）]*)/)
ok(!!m && Number(m[1]) === a.roundCosts.samples.length, `样本数同源（文本 ${m?.[1]} vs aggregate ${a.roundCosts.samples.length}）`)
ok(!!m && m[2] === a.roundCosts.samples.join(', '), `样本串同源（文本 "${m?.[2]}" vs aggregate "${a.roundCosts.samples.join(', ')}"）`)
deepEq(JSON.parse(mod.renderJson(report)).aggregate, report.aggregate, 'JSON aggregate 与 report.aggregate 完全一致（同一对象投影）')
// n/a ↔ null 双向：无打回 run 时三处都必须是 null / n/a
const noReworkReport = mod.buildReport([{ ws: 'alpha', j: goldenAlpha }], { runId: null })
const ntext = mod.renderText(noReworkReport)
ok(/比例=n\/a/.test(ntext), '无阻断缺陷 → 文本 checksRatio 显示 n/a')
ok(/「类别门禁」=n\/a/.test(ntext), '无修复轮 → 文本门禁显示 n/a')
ok(/均值）=n\/a/.test(ntext) && !/样本/.test(ntext), '无成本样本 → 文本均值 n/a 且无样本串')
const nj = JSON.parse(mod.renderJson(noReworkReport))
eq(nj.aggregate.checksRatio, null, '无阻断缺陷 → JSON checksRatio = null')
eq(nj.aggregate.roundCosts.avg, null, '无样本 → JSON roundCosts.avg = null')
deepEq(nj.aggregate.roundCosts.samples, [], '无样本 → samples = []')

// ── G6) 容错扫描：假 io 覆盖 root 不存在 / 坏 JSON / 无 qaRounds / onlyRun 不命中 / 非目录（AC-7/8）──
console.log('\n[G6] 容错扫描（AC-7/8）：假 io，只读、不碰真实 $DSH_HOME')
const ROOT = join('mem', 'teamflow')
const wsDir = (w) => join(ROOT, w)
const runsDirOf = (w) => join(wsDir(w), 'runs')
const dirs = new Set([ROOT, wsDir('ws1'), runsDirOf('ws1'), wsDir('ws2')])
const files = new Map([
  [join(runsDirOf('ws1'), 'good.json'), JSON.stringify({ id: 'tf-good', status: 'done', stages: [{ phase: 'qa' }], qaRounds: [{ round: 1, outcome: 'pass' }] })],
  [join(runsDirOf('ws1'), 'bad.json'), '{ 这不是 JSON'],
  [join(runsDirOf('ws1'), 'empty.json'), JSON.stringify({ id: 'tf-empty', stages: [] })],
  [join(runsDirOf('ws1'), 'note.txt'), 'not a journal'],
  [join(runsDirOf('ws1'), 'other.json'), JSON.stringify({ id: 'tf-other', stages: [{ phase: 'dev' }] })],
])
const readLog = []
const fakeIo = {
  existsSync: (p) => dirs.has(p) || files.has(p),
  readdirSync: (p) => {
    if (p === ROOT) {
      return [
        { name: 'ws1', isDirectory: () => true },
        { name: 'ws2', isDirectory: () => true },
        { name: 'loose.txt', isDirectory: () => false },
      ]
    }
    if (p === runsDirOf('ws1')) return ['good.json', 'bad.json', 'empty.json', 'note.txt', 'other.json']
    throw new Error(`readdirSync 未预期的路径：${p}`)
  },
  readFileSync: (p) => {
    readLog.push(p)
    if (!files.has(p)) throw new Error(`ENOENT：${p}`)
    return files.get(p)
  },
}
const filesBefore = JSON.stringify([...files.entries()])
const found = mod.collectJournals({ root: ROOT, io: fakeIo })
eq(found.length, 2, '坏 JSON / stages 空 / 非 .json 被跳过，其余 2 条保留')
deepEq(found.map((e) => e.j.id), ['tf-good', 'tf-other'], '保留 readdir 枚举顺序（文本态顺序的来源）')
deepEq(found.map((e) => e.ws), ['ws1', 'ws1'], '工作区名随条目带出')
ok(!readLog.includes(join(runsDirOf('ws1'), 'note.txt')), '非 .json 文件未被读取')
const scanReport = mod.buildReport(found, { runId: null })
deepEq(scanReport.scanned, { runs: 2, withRounds: 1, withRework: 0 }, 'scanned：无 qaRounds 的 run 不计入 withRounds')
eq(scanReport.runs.length, 1, 'runs 只含带 qaRounds 的 run')
eq(scanReport.runs[0].runId, 'tf-good', 'runs[0] 身份正确')
eq(scanReport.runs[0].hasRework, false, 'outcome 无 rework → hasRework=false')
eq(scanReport.aggregate.checksRatio, null, '空聚合 → checksRatio=null')
eq(scanReport.aggregate.roundCosts.avg, null, '空聚合 → roundCosts.avg=null')
eq(mod.collectJournals({ root: ROOT, onlyRun: 'good', io: fakeIo }).length, 1, 'onlyRun 命中（按 `${runId}.json` 文件名）→ 只收集该 run')
eq(mod.collectJournals({ root: ROOT, onlyRun: 'tf-nope', io: fakeIo }).length, 0, 'onlyRun 无命中 → []（不抛）')
const emptyIo = {
  existsSync: () => false,
  readdirSync: () => { throw new Error('mock 不可达') },
  readFileSync: () => { throw new Error('mock 不可达') },
}
deepEq(mod.collectJournals({ root: ROOT, io: emptyIo }), [], 'root 不存在（假 io）→ [] 且不抛')
const emptyJson = JSON.parse(mod.renderJson(mod.buildReport([], { runId: 'tf-nope' })))
deepEq(emptyJson.scanned, { runs: 0, withRounds: 0, withRework: 0 }, '空输入 JSON：scanned 三项为 0')
deepEq(emptyJson.runs, [], '空输入 JSON：runs=[]')
eq(emptyJson.aggregate.checksRatio, null, '空输入 JSON：checksRatio=null')
eq(emptyJson.aggregate.roundCosts.avg, null, '空输入 JSON：roundCosts.avg=null')
eq(emptyJson.filter.runId, 'tf-nope', '空输入 JSON 仍回显 filter.runId（无命中不失真）')
eq(JSON.stringify([...files.entries()]), filesBefore, '只读：假 fs 内容在收集前后逐字节不变')

// ── 收口 ──
if (failed) {
  console.error(`\n❌ qa-rounds-report 门禁失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n✅ qa-rounds-report 门禁全绿')
process.exit(0)
