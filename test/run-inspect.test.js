/**
 * dsh-plugin-teamflow — `scripts/run-inspect.mjs` 永久门禁（r12）。
 *
 * **为什么存在**：这是一个「只读巡检」脚本，三条性质都只靠约定就会被静默破坏：
 *  ① 只读（AC-10/11/12）——一次手滑的写盘调用不会报错，只会污染用户的 `$DSH_HOME`；
 *  ② 退出码（AC-8/9）——「未找到 run」必须是 exit 1 且 stdout **零字节**，否则调用方
 *     （未来接进 CI/流水线）会把错误当成功；而受限沙箱下子进程 piped-stdio 会 EPERM，
 *     所以行为只能在**零子进程**的纯调用里断言（脚本为此把退出码做成返回值）；
 *  ③ 两态同源（AC-3/6）——文本态不许出现绝对路径/时间戳，JSON 必须定键序、定序输出，
 *     任何「顺手归一化」都会静默破一条 AC 而不抛错。
 * 这里用内存 fixture + 只读假 io 把三条性质同时钉死。
 *
 * **设计约束（沿用既有约定，非新发明）**：
 *  1. 只 import 导出契约、只喂内存 fixture：本文件**禁止任何子进程**，也不读写真实 `$DSH_HOME`
 *     （假 io 只暴露 `existsSync/readdirSync/readFileSync`，写调用因方法不存在直接抛错）。
 *  2. 黄金文本**手写**：按 `TECHNICAL.md` §3.5 的列宽规范（phase 12 / 状态 10 / statuses 18 /
 *     耗时 10 → token 列 50）逐字转写，**不是**从新实现输出反抄——否则排版改错时测试会跟着改对。
 *  3. 风格与既有套件同形：无框架、`✓`/`✗`、失败非零退出、零新增依赖。
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
/** 值相等（失败时打印期望/实得）。 */
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

// 禁词字面量拆写：本文件自身也要通过「不得出现写盘/子进程调用」的静态检查，
// 直接写字面量会让检查自伤，所以用拼接构造。
const BANNED = ['write' + 'File', 'append' + 'File', 'm' + 'kdir', 'rm' + 'Sync', 'un' + 'link', 'child_' + 'process', 'sp' + 'awn']

const SCRIPT_URL = new URL('../scripts/run-inspect.mjs', import.meta.url)
const SCRIPT_PATH = fileURLToPath(SCRIPT_URL)
const PKG_PATH = fileURLToPath(new URL('../package.json', import.meta.url))
const REPO_ROOT = dirname(dirname(SCRIPT_PATH))
const HOME = 'X:\\dsh-home'
const TEAMFLOW_ROOT = join(HOME, 'teamflow')

// ── G0) 导入面：import 期零 stdout、导出契约、源码只读 + 入口守卫（AC-10）──
console.log('\n[G0] 导入面（AC-10）：import 期零 stdout / 导出契约冻结 / 源码只读 + 入口守卫')
const importChunks = []
const origImportWrite = process.stdout.write
process.stdout.write = function (chunk) { importChunks.push(String(chunk)); return true }
let mod
try {
  mod = await import(SCRIPT_URL.href)
} finally {
  process.stdout.write = origImportWrite
}
ok(!!mod, '模块动态导入成功')
eq(importChunks.length, 0, 'import 期零 stdout（入口守卫未生效时会在此吐出整份报告）')

const API = ['parseArgs', 'collectJournal', 'buildReport', 'renderText', 'renderJson', 'runCli', 'failureReasonOf', 'durationOf', 'sumUsage', 'clipLine', 'fmtDuration']
for (const name of API) ok(typeof mod[name] === 'function', `导出 ${name} 为 function`)
deepEq(Object.keys(mod).sort(), [...API, 'USAGE_LINES'].sort(), '导出面恰为 TECH §3.2 冻结清单（多一个少一个都红）')
ok(Array.isArray(mod.USAGE_LINES) && mod.USAGE_LINES.length >= 5, 'USAGE_LINES 为数组（4 条命令 + 说明行）')

const SCRIPT_SRC = readFileSync(SCRIPT_PATH, 'utf8')
const bannedHit = BANNED.find((t) => SCRIPT_SRC.includes(t))
ok(bannedHit === undefined, `脚本源码无写盘/子进程调用（命中：${bannedHit ?? '无'}）`)
ok(!/process\.exit\s*\(/.test(SCRIPT_SRC), '脚本不调 process.exit（退出码走返回值 + process.exitCode，D2）')
ok(/const invoked = process\.argv\[1\]/.test(SCRIPT_SRC) && /if \(invoked\) process\.exitCode = runCli\(/.test(SCRIPT_SRC),
  'CLI 体被入口守卫包裹（仅直跑执行 → import 期零 IO）')
const ALLOWED_MODULES = new Set(['node:fs', 'node:path', 'node:os', 'node:url'])
const imports = [...SCRIPT_SRC.matchAll(/from '([^']+)'/g)].map((m) => m[1])
ok(imports.length > 0 && imports.every((m) => ALLOWED_MODULES.has(m)), `只依赖 node 内置白名单模块（实得 ${imports.join(', ')}）`)
const headerComment = SCRIPT_SRC.slice(0, SCRIPT_SRC.indexOf('*/'))
const usageCmds = [
  'node scripts/run-inspect.mjs <runId>',
  'node scripts/run-inspect.mjs <runId> --json',
  'node scripts/run-inspect.mjs --json <runId>',
  'node scripts/run-inspect.mjs --help',
]
for (const c of usageCmds) {
  ok(headerComment.includes(c) && mod.USAGE_LINES.some((l) => l.includes(c)), `用法两处同源（AC-2）：${c}`)
}
const SELF_SRC = readFileSync(fileURLToPath(import.meta.url), 'utf8')
const selfHit = BANNED.find((t) => SELF_SRC.includes(t))
ok(selfHit === undefined, `本套件自身也不含写盘/子进程调用（命中：${selfHit ?? '无'}）`)

// ── 内存假 fs：只暴露三个读函数（AC-12 的第三条腿）──
function makeIo({ dirs, files }) {
  const calls = []
  const io = {
    existsSync(p) { calls.push(`existsSync:${p}`); return dirs.has(p) || files.has(p) },
    readdirSync(p, opts) {
      calls.push(`readdirSync:${p}`)
      const list = dirs.get(p)
      if (!list) throw new Error(`ENOTDIR：${p}`)
      return opts && opts.withFileTypes
        ? list.map((e) => ({ name: e.name, isDirectory: () => e.dir }))
        : list.map((e) => e.name)
    },
    readFileSync(p) {
      calls.push(`readFileSync:${p}`)
      if (!files.has(p)) throw new Error(`ENOENT：${p}`)
      return files.get(p)
    },
  }
  return { io, calls, dirs, files }
}

/** 造一棵内存 `$DSH_HOME/teamflow` 树：spec = { <workspace>: { <文件名>: 对象/字符串 } | null（无 runs/） }。 */
function fakeTeamflow(spec) {
  const dirs = new Map([[TEAMFLOW_ROOT, []]])
  const files = new Map()
  for (const [ws, runs] of Object.entries(spec)) {
    dirs.get(TEAMFLOW_ROOT).push({ name: ws, dir: true })
    if (!runs) continue
    const runsDir = join(TEAMFLOW_ROOT, ws, 'runs')
    dirs.set(runsDir, [])
    for (const [name, content] of Object.entries(runs)) {
      dirs.get(runsDir).push({ name, dir: false })
      if (content != null) files.set(join(runsDir, name), typeof content === 'string' ? content : JSON.stringify(content))
    }
  }
  return makeIo({ dirs, files })
}

/** 非白名单 io 方法一旦被触碰立刻抛错（把「只读」从约定变成可执行断言）。 */
const strictIo = (io) => new Proxy(io, {
  get(target, prop) {
    if (typeof prop === 'string' && !(prop in target)) throw new Error(`非白名单 io 成员被读取：${prop}`)
    return target[prop]
  },
})

const usage5 = (input, cacheRead, cacheWrite, output, calls) => ({ input, cacheRead, cacheWrite, output, calls })

// ── G1) argv 解析：位置无关，runId = 首个非 `-` 参数（AC-7）──
console.log('\n[G1] argv 解析（AC-7）：--json 与 runId 位置无关、未知短横参数忽略')
deepEq(mod.parseArgs(['--json', 'tf-x']), { help: false, json: true, runId: 'tf-x' }, "['--json','tf-x'] → {help:false,json:true,runId:'tf-x'}")
deepEq(mod.parseArgs(['tf-x', '--json']), { help: false, json: true, runId: 'tf-x' }, "['tf-x','--json'] 与上等价")
eq(mod.parseArgs(['tf-x', '--json']).runId, mod.parseArgs(['--json', 'tf-x']).runId, '两种位置形态的 runId 相等')
deepEq(mod.parseArgs(['-x', 'tf-x']), { help: false, json: false, runId: 'tf-x' }, "['-x','tf-x'] → 未知短横参数忽略，runId 仍为首个非短横参数")
deepEq(mod.parseArgs(['--help']), { help: true, json: false, runId: null }, "['--help'] → help=true")
deepEq(mod.parseArgs(['-h']), { help: true, json: false, runId: null }, "['-h'] 与 --help 归一")
deepEq(mod.parseArgs(['tf-x', '--help']), { help: true, json: false, runId: 'tf-x' }, '--help 与 runId 并存 → help 仍为 true（优先级由 runCli 兑现）')
deepEq(mod.parseArgs([]), { help: false, json: false, runId: null }, '空 argv → 全 false / runId=null（不抛）')

// ── G2) 收集：只按 `<runId>.json` 精确命中、坏数据容忍、计数精确（AC-8）──
console.log('\n[G2] 收集（AC-8）：精确文件名命中 / 坏数据跳过 / scanned 计数精确')
const missingIo = makeIo({ dirs: new Map(), files: new Map() })
deepEq(mod.collectJournal({ root: TEAMFLOW_ROOT, runId: 'tf-x', io: missingIo.io }),
  { entries: [], scanned: { workspaces: 0, journals: 0 } }, 'root 不存在 → 0 命中 0 扫描（不抛）')

const jGood = { id: 'tf-x', status: 'done', startedAt: 1, endedAt: 2, stages: [{ seq: 1, phase: 'prd', status: 'done' }] }
const jEmptyStages = { id: 'tf-x', status: 'done', stages: [] }
const collectIo = fakeTeamflow({
  wsA: { 'tf-x.json': jGood, 'tf-other.json': 'not-json{', 'tf-xy.json': jGood, 'note.txt': 'x' },
  wsB: { 'tf-x.json': jEmptyStages },
  wsC: null,
})
const collected = mod.collectJournal({ root: TEAMFLOW_ROOT, runId: 'tf-x', io: collectIo.io })
eq(collected.entries.length, 1, '只命中文件名恰为 `<runId>.json` 且 stages 非空的文件')
eq(collected.entries[0].ws, 'wsA', '命中条目带出 workspace 名')
deepEq(collected.scanned, { workspaces: 3, journals: 4 }, 'scanned：workspaces 计目录数（含无 runs/ 的 wsC）、journals 计 .json 数（含坏 JSON/空 stages）')
ok(!collectIo.calls.some((c) => c.includes('note.txt')), '非 .json 文件从未被 readFileSync')
ok(!collectIo.calls.some((c) => c.endsWith('tf-xy.json')), '前缀相似文件名未误命中（精确等于 `<runId>.json`）')

const strIo = {
  existsSync: (p) => p === TEAMFLOW_ROOT || p === join(TEAMFLOW_ROOT, 'wsA', 'runs'),
  readdirSync: (p) => (p === TEAMFLOW_ROOT ? ['wsA'] : ['tf-x.json']),
  readFileSync: () => JSON.stringify(jGood),
}
deepEq(mod.collectJournal({ root: TEAMFLOW_ROOT, runId: 'tf-x', io: strIo }).scanned,
  { workspaces: 1, journals: 1 }, 'readdirSync 只返回字符串名（不支持 withFileTypes）也能扫描（分支兜底）')

// ── G3) 退出码与 stdout 零写（AC-2/8/9）──
console.log('\n[G3] 退出码（AC-2/8/9）：help→0 / 缺 runId→2 / 未找到或歧义→1 且 stdout 零字节')
const outChunks = []
const errChunks = []
let outCalls = 0
const out = (s) => { outCalls++; outChunks.push(String(s)); return true }
const err = (s) => { errChunks.push(String(s)); return true }
const run = (argv, io) => {
  outChunks.length = 0
  errChunks.length = 0
  outCalls = 0
  const code = mod.runCli(argv, { io: strictIo(io), env: { DSH_HOME: HOME }, out, err })
  return { code, stdout: outChunks.join(''), stderr: errChunks.join(''), outCalls }
}

const helpRun = run(['--help'], collectIo.io)
eq(helpRun.code, 0, '--help → 退出码 0')
eq(helpRun.stderr, '', '--help → stderr 空')
for (const c of usageCmds) ok(helpRun.stdout.includes(c), `--help stdout 含用法命令：${c}`)
const helpPrecedence = run(['tf-x', '--help'], collectIo.io)
eq(helpPrecedence.code, 0, '--help 优先于 runId → 退出码 0')
eq(helpPrecedence.stdout, helpRun.stdout, '--help 优先：与纯 --help 输出逐字节相同')

const noRunId = run([], collectIo.io)
eq(noRunId.code, 2, '缺 runId → 退出码 2（用法错误）')
eq(noRunId.outCalls, 0, '缺 runId → stdout 零写（不是空串，是零次调用）')
ok(noRunId.stderr.includes('用法错误：缺少 runId') && noRunId.stderr.includes('node scripts/run-inspect.mjs <runId>'), '缺 runId stderr 含错误原文 + 用法')

for (const argv of [['tf-nope'], ['tf-nope', '--json'], ['--json', 'tf-nope']]) {
  const r = run(argv, collectIo.io)
  const shape = argv.join(' ')
  eq(r.code, 1, `未找到 run（${shape}）→ 退出码 1`)
  eq(r.outCalls, 0, `未找到 run（${shape}）→ stdout 零写`)
  ok(r.stderr.includes('未找到 run「tf-nope」'), `未找到 run（${shape}）stderr 含 runId 原文`)
  ok(r.stderr.includes('已扫描 3 个工作区 / 4 个 journal'), `未找到 run（${shape}）stderr 含精确扫描计数`)
}

const ambIo = fakeTeamflow({ wsB: { 'tf-x.json': jGood }, wsA: { 'tf-x.json': jGood } })
const ambiguous = run(['tf-x'], ambIo.io)
eq(ambiguous.code, 1, '同一 runId 命中 2 个工作区 → 退出码 1')
eq(ambiguous.outCalls, 0, '歧义 → stdout 零写')
ok(ambiguous.stderr.includes('在 2 个工作区同时命中：wsA, wsB'), '歧义 stderr：候选工作区按字典序列出（不静默取首个）')
ok(ambiguous.stderr.includes('请人工确认'), '歧义 stderr 含人工确认指引')

// ── 黄金 fixture：手写文本态基线（AC-3）──
const GOLDEN_J = {
  id: 'tf-inspect-gold',
  workspacePath: 'D:\\work\\ddd',
  status: 'failed',
  humanIntervention: true,
  runDocs: 'docs/teamflow/20260926-r12-run-inspect',
  error: '外部供应商 503（连续 3 次）',
  startedAt: 1000,
  endedAt: 4000,
  stages: [
    { seq: 1, label: 'PRD', phase: 'prd', status: 'done', startedAt: 1000, endedAt: 2000, usage: usage5(100, 200, 10, 50, 3) },
    { seq: 2, label: 'T1 脚本实现', phase: 'dev', taskKey: 'dt-1', taskIds: ['dt-1'], status: 'failed', outcome: 'error', startedAt: 2000, endedAt: 4000, usage: usage5(10, 20, 0, 5, 1), summary: '未产出有效结果（stopReason=error）' },
  ],
}
// 手写黄金文本：按 TECH §3.5 的列宽规范逐字转写（phase 12 / 状态 10 / statuses 18 / 耗时 10 → token 列 50，
// 每行 token 段 = `calls <n>` 右补至 8 列 + `  in <n> / hit <n> / out <n>`；gapTo 至少 2 空格）。
// 空格数用 pad 显式给出，避免人工数空格数错（数值全部来自上面的列宽规范，不是从实现输出反抄）。
const pad = (s, n) => s + ' '.repeat(n)
const GOLDEN_PRD = pad('prd', 9) + pad('全部完成', 2) + pad('done', 14) + pad('1s', 10) + pad('calls 3', 3) + 'in 100 / hit 200 / out 50'
const GOLDEN_DEV_ROLLUP = pad('dev', 9) + pad('失败 1/1', 2) + pad('failed', 12) + pad('2s', 10) + pad('calls 1', 3) + 'in 10 / hit 20 / out 5'
const GOLDEN_DEV_DETAIL = '  [2] T1 脚本实现  dt-1  dt-1  failed  error  2s' + '  ' + pad('calls 1', 3) + 'in 10 / hit 20 / out 5'
const GOLDEN_TEXT = [
  'run        tf-inspect-gold',
  'workspace  alpha',
  'status     failed（humanIntervention=true）',
  '任务夹     docs/teamflow/20260926-r12-run-inspect',
  '耗时       3s（1000 → 4000）',
  'token      input 110 / cacheRead 220 / cacheWrite 10 / output 55 / calls 4',
  '失败原因   外部供应商 503（连续 3 次）',
  '',
  '阶段（7 类，按 prd→design→scaffold→tech→dev→qa→acceptance）',
  GOLDEN_PRD,
  'design      未经历',
  'scaffold    未经历',
  'tech        未经历',
  GOLDEN_DEV_ROLLUP,
  GOLDEN_DEV_DETAIL,
  '      原文：未产出有效结果（stopReason=error）',
  'qa          未经历',
  'acceptance  未经历',
].join('\n')
const goldenIo = fakeTeamflow({ alpha: { 'tf-inspect-gold.json': GOLDEN_J } })

// ── G4) 成功文本态：黄金文本 + 两次运行逐字节相同 + 无绝对路径（AC-3）──
console.log('\n[G4] 成功文本态（AC-3）：手写黄金文本 / 连跑两次逐字节相同 / 无绝对路径')
const text1 = run(['tf-inspect-gold'], goldenIo.io)
eq(text1.code, 0, '命中 run → 退出码 0')
eq(text1.stderr, '', '成功路径 stderr 为空')
eq(text1.outCalls, 1, '成功路径 stdout 恰好写一次（不是分片多次）')
textEq(text1.stdout, `${GOLDEN_TEXT}\n`, 'renderText 输出 === 手写黄金文本 + 单个结尾换行')
ok(text1.stdout.endsWith('\n') && !text1.stdout.endsWith('\n\n'), 'stdout 恰有一个结尾换行')
const text2 = run(['tf-inspect-gold'], goldenIo.io)
eq(text2.stdout, text1.stdout, '同 fixture 连跑两次逐字节相同（无时间戳/随机量/排序）')
ok(!/[A-Za-z]:[\\/]/.test(text1.stdout), '文本态无盘符绝对路径（D3）')
ok(!text1.stdout.includes('D:\\work\\ddd'), '文本态不输出 workspacePath')
for (const slot of ['run', 'workspace', 'status', '任务夹', '耗时', 'token', '失败原因']) {
  ok(text1.stdout.includes(`${slot}`), `文本态含槽位：${slot}`)
}
const phaseLines = text1.stdout.split('\n').filter((l) => /^(prd|design|scaffold|tech|dev|qa|acceptance)\s/.test(l))
eq(phaseLines.length, 7, '文本态恒 7 条 phase 行（固定序）')
deepEq(phaseLines.map((l) => l.split(/\s+/)[0]), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'phase 行按 prd→design→scaffold→tech→dev→qa→acceptance 定序')

// ── G5) 阶段覆盖与 rollup（AC-4）──
console.log('\n[G5] 阶段覆盖（AC-4）：7 类定长 / dev 逐条展开 / rollup 数字 / 无计量标注')
const RICH_J = {
  id: 'tf-inspect-rich',
  status: 'cancelled',
  cancelled: true,
  humanIntervention: true,
  runDocs: null,
  startedAt: 500,
  endedAt: 400,
  stages: [
    { seq: 5, label: 'T4 收口', phase: 'dev', taskKey: 'dt-4', taskIds: ['dt-4', 'dt-7'], status: 'done', startedAt: 100, endedAt: 400, usage: usage5(1, 2, 3, 4, 5) },
    { seq: 2, label: 'T1 实现', phase: 'dev', taskKey: 'dt-1', taskIds: ['dt-1'], status: 'failed', outcome: 'error', startedAt: 10, endedAt: 20 },
    { seq: 3, label: 'T2 测试', phase: 'dev', taskKey: 'dt-2', status: 'done', startedAt: 20, endedAt: 30, usage: usage5(0, 0, 0, 0, 0) },
    { seq: 4, label: 'T3 接线', phase: 'dev', taskKey: 'dt-3', status: 'cancelled', startedAt: 30, endedAt: 40 },
    { seq: 1, label: 'PRD', phase: 'prd', status: 'done', startedAt: 1, endedAt: 2, usage: usage5(7, 8, 9, 10, 11) },
    { seq: 6, label: 'QA', phase: 'qa', status: 'done', startedAt: 50, endedAt: 60, usage: usage5(1, 1, 1, 1, 1) },
  ],
}
const richReport = mod.buildReport([{ ws: 'wsRich', j: RICH_J }], { runId: 'tf-inspect-rich' })
eq(richReport.phases.length, 7, 'phases 恒 7 条（未经历不消失）')
deepEq(richReport.phases.map((p) => p.phase), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'phases 顺序固定')
deepEq(richReport.phases.map((p) => p.visited), [true, false, false, false, true, true, false], 'visited 与 stages 有无一致')
for (const p of richReport.phases.filter((x) => !x.visited)) {
  eq(p.stages, 0, `未经历 phase ${p.phase}：stages=0`)
  eq(p.usageMissing, true, `未经历 phase ${p.phase}：usageMissing=true`)
}
const devPhase = richReport.phases.find((p) => p.phase === 'dev')
eq(devPhase.stages, 4, 'dev phase：stages 是**计数** 4（非数组）')
eq(typeof devPhase.stages, 'number', 'phase.stages 类型为 number（JSON 顶层另有真数组 stages）')
deepEq(devPhase.statuses, ['failed', 'done', 'cancelled'], 'phase.statuses 按 seq 升序去重保序')
eq(devPhase.failed, 2, 'phase.failed = status !== done 的成员数（failed + cancelled）')
eq(devPhase.startedAt, 10, 'phase.startedAt = 成员有限值 min')
eq(devPhase.endedAt, 400, 'phase.endedAt = 成员有限值 max')
eq(devPhase.durationMs, 390, 'phase.durationMs = endedAt - startedAt（严格相减）')
deepEq(devPhase.usage, usage5(1, 2, 3, 4, 5), 'phase.usage = 成员桶和（缺计量的按 0）')
eq(devPhase.usageMissing, false, 'phase.usageMissing：仅部分成员缺计量 → false')
eq(devPhase.failureReason, 'outcome=error（无原文）', 'phase.failureReason = 首个失败成员的 failureReason')
deepEq(richReport.stages.map((s) => s.seq), [1, 2, 3, 4, 5, 6], 'stages 按 seq 升序（输入是乱序 5,2,3,4,1,6）')
deepEq(richReport.stages[1].usage, usage5(0, 0, 0, 0, 0), '缺 usage 的 stage：五桶全 0')
eq(richReport.stages[1].usageMissing, true, '缺 usage 的 stage：usageMissing=true（零值 ≠ 无计量）')
eq(richReport.stages[2].usageMissing, false, 'usage 五桶全 0 但字段存在 → usageMissing=false（真 0）')
eq(richReport.durationMs, -100, 'run 级耗时严格 endedAt-startedAt，负值如实暴露（D6 不做 max(0,…)）')
deepEq(richReport.usage, usage5(9, 11, 13, 15, 17), 'run 级 usage = 全部 stage 桶和')

const richText = mod.renderText(richReport)
ok(richText.includes('未建任务夹'), 'runDocs=null → 文本态「未建任务夹」')
eq([...richText.matchAll(/^ {2}\[\d+\] /gm)].length, 4, 'dev 逐条展开 4 行 stage 明细（并发/补跑可见）')
eq((richText.match(/未经历/g) ?? []).length, 4, '4 条未经历 phase 各出一行「未经历」')
ok(richText.includes('-100ms'), '负耗时如实显示，不被归零')
const missingPhaseReport = mod.buildReport([{ ws: 'w', j: { id: 'tf-missing', stages: [{ seq: 1, phase: 'prd', status: 'done' }] } }])
eq(missingPhaseReport.phases[0].usageMissing, true, '阶段无 usage 字段 → phase.usageMissing=true')
ok(mod.renderText(missingPhaseReport).includes('（无计量）'), '无计量在 token 行显式标注「（无计量）」')
deepEq(mod.sumUsage([]), { usage: usage5(0, 0, 0, 0, 0), usageMissing: true }, 'sumUsage([]) → 零桶 + usageMissing=true')
eq(mod.durationOf(5, 3), -2, 'durationOf(5,3) = -2（不 clamp）')
eq(mod.durationOf(undefined, 3), null, 'durationOf 缺 startedAt → null')
eq(mod.durationOf(NaN, 3), null, 'durationOf 非有限数 → null')
eq(mod.fmtDuration(null), '未记录', 'fmtDuration(null) = 未记录')
eq(mod.fmtDuration(999), '999ms', 'fmtDuration(999) = 999ms')
eq(mod.fmtDuration(1000), '1s', 'fmtDuration(1000) = 1s')
eq(mod.fmtDuration(61000), '1m 1s', 'fmtDuration(61000) = 1m 1s（前导 0 单位省略）')
eq(mod.fmtDuration(3661000), '1h 1m 1s', 'fmtDuration(3661000) = 1h 1m 1s')
eq(mod.clipLine('第一行\n第二行', 10), '第一行', 'clipLine 只取首行')
eq(mod.clipLine('abcde', 3), 'abc…', 'clipLine 超长截断并追加 …')
eq(mod.clipLine(null, 3), '', 'clipLine(null) = 空串')

// ── G6) 失败原文：优先级 / 不截断 / 文本截断（AC-5）──
console.log('\n[G6] 失败原文（AC-5）：D7 优先级 / JSON 不截断 / 文本首行+200 截断')
eq(mod.failureReasonOf({ envUnavailable: 'ENV', guardReason: 'GUARD', summary: 'SUM', outcome: 'error' }), 'ENV', '优先级 envUnavailable > guardReason > summary')
eq(mod.failureReasonOf({ guardReason: 'GUARD', summary: 'SUM' }), 'GUARD', '次优先 guardReason')
eq(mod.failureReasonOf({ summary: 'SUM' }), 'SUM', '再次 summary')
eq(mod.failureReasonOf({ outcome: 'error' }), 'outcome=error（无原文）', '三空回落 outcome=<值>（无原文）')
eq(mod.failureReasonOf({}), 'outcome=unknown（无原文）', '连 outcome 都缺 → outcome=unknown（无原文）')
eq(mod.failureReasonOf({ envUnavailable: '   ', summary: 'SUM' }), 'SUM', '纯空白不算原文（hasText 口径）')
const doneStage = mod.buildReport([{ ws: 'w', j: { id: 'tf-done', stages: [{ seq: 1, phase: 'prd', status: 'done', summary: '不该出现的原文' }] } }]).stages[0]
eq(doneStage.failureReason, null, 'status=done 的 stage → failureReason=null（只有失败才算原文）')

const LONG = '甲'.repeat(300)
const longJ = {
  id: 'tf-long',
  status: 'failed',
  error: `E${'乙'.repeat(250)}`,
  stages: [
    { seq: 1, phase: 'dev', label: 'T1', taskKey: 'dt-1', status: 'failed', outcome: 'error', summary: LONG, guardReason: `GUARD${LONG}`, guardOutcome: 'guard-abort', envUnavailable: `ENV${LONG}` },
    { seq: 2, phase: 'qa', label: 'QA', status: 'failed', outcome: 'error', summary: '第一行\n第二行' },
  ],
}
const longReport = mod.buildReport([{ ws: 'w', j: longJ }])
const longJson = JSON.parse(mod.renderJson(longReport))
eq(longJson.stages[0].summary, LONG, 'JSON stage.summary 原文不截断')
eq(longJson.stages[0].guardReason, `GUARD${LONG}`, 'JSON stage.guardReason 原文不截断')
eq(longJson.stages[0].guardOutcome, 'guard-abort', 'JSON 保留 guardOutcome 原文')
eq(longJson.stages[0].envUnavailable, `ENV${LONG}`, 'JSON stage.envUnavailable 原文不截断')
eq(longJson.stages[0].failureReason, `ENV${LONG}`, 'JSON failureReason 走 D7 优先级且不截断')
eq(longJson.error, `E${'乙'.repeat(250)}`, 'JSON run 级 error 原文不截断')
const longText = mod.renderText(longReport)
ok(longText.includes(`      原文：ENV${'甲'.repeat(197)}…`), '文本态原文首行 >200 字符 → 截断并追加 …（D7 取 envUnavailable）')
eq(longText.split('\n').filter((l) => l.startsWith('      原文：'))[1], '      原文：第一行', '文本态原文只取首行')
ok(longText.includes(`失败原因   E${'乙'.repeat(199)}…`), 'run 级 error 文本态同样截断至 200 + …')

// ── G7) JSON 态：定键序 / 定序 / 缺失补 null（AC-6/7）──
console.log('\n[G7] JSON 态（AC-6/7）：18 键定序 / phases 定序 / stages 升序 / 缺失补 null')
const jsonText1 = run(['tf-inspect-rich', '--json'], fakeTeamflow({ wsRich: { 'tf-inspect-rich.json': RICH_J } }).io)
eq(jsonText1.code, 0, '--json 命中 → 退出码 0')
eq(jsonText1.stderr, '', '--json 成功路径 stderr 为空')
const parsedRich = JSON.parse(jsonText1.stdout)
ok(parsedRich && typeof parsedRich === 'object' && !Array.isArray(parsedRich), 'stdout 恰为一个 JSON 对象（可 parse）')
eq(JSON.stringify(parsedRich, null, 2) + '\n', jsonText1.stdout, 'stdout = JSON 对象 + 单个结尾换行（无额外内容）')
deepEq(Object.keys(parsedRich), ['schema', 'runId', 'workspace', 'workspacePath', 'status', 'humanIntervention', 'cancelled', 'interrupted', 'supersededBy', 'requirement', 'runDocs', 'error', 'startedAt', 'endedAt', 'durationMs', 'usage', 'phases', 'stages'], 'JSON 顶层 18 键与顺序冻结（AC-6）')
eq(parsedRich.schema, 'teamflow.run-inspect/v1', 'JSON schema 常量 = teamflow.run-inspect/v1')
deepEq(Object.keys(parsedRich.phases[0]), ['phase', 'visited', 'stages', 'statuses', 'startedAt', 'endedAt', 'durationMs', 'usage', 'usageMissing', 'failed', 'failureReason'], 'phase 11 键与顺序冻结')
deepEq(Object.keys(parsedRich.stages[0]), ['seq', 'label', 'phase', 'taskKey', 'taskIds', 'status', 'outcome', 'startedAt', 'endedAt', 'durationMs', 'usage', 'usageMissing', 'failureReason', 'summary', 'guardReason', 'guardOutcome', 'envUnavailable', 'provider', 'model'], 'stage 19 键与顺序冻结')
deepEq(parsedRich.phases.map((p) => p.phase), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'JSON phases 恒 7 条定序')
deepEq(parsedRich.stages.map((s) => s.seq), [1, 2, 3, 4, 5, 6], 'JSON stages 按 seq 升序（输入乱序）')
deepEq(Object.keys(parsedRich.usage), ['input', 'cacheRead', 'cacheWrite', 'output', 'calls'], 'run 级 usage 五桶定序')
ok(parsedRich.phases.every((p) => p.usageMissing === true || p.usageMissing === false), 'usageMissing 为布尔（不输出 undefined）')

const minimalReport = mod.buildReport([{ ws: 'w', j: { id: 'tf-min', stages: [{ seq: 1, phase: 'prd', status: 'done' }] } }], { runId: 'tf-min' })
const minimalJson = JSON.parse(mod.renderJson(minimalReport))
for (const key of ['supersededBy', 'requirement', 'runDocs', 'error', 'startedAt', 'endedAt', 'durationMs']) {
  eq(minimalJson[key], null, `缺失标量补 null：${key}`)
}
deepEq(minimalJson.stages[0].taskIds, [], '缺失数组 taskIds 补 []')
deepEq(minimalJson.stages[0].statuses, undefined, 'stage 无 statuses 键（不在 19 键内）')
eq(minimalJson.humanIntervention, false, '缺失布尔归一 false（不输出 undefined）')
eq(minimalJson.cancelled, false, '缺失 cancelled 归一 false')
ok(!/undefined/.test(mod.renderJson(minimalReport)), 'JSON 文本中不出现 undefined 字面量')

const jsonByPos = run(['--json', 'tf-inspect-rich'], fakeTeamflow({ wsRich: { 'tf-inspect-rich.json': RICH_J } }).io)
eq(jsonByPos.stdout, jsonText1.stdout, '--json 在 runId 前后两种位置 → stdout 逐字节相同（AC-7）')
const goldenJson = JSON.parse(run(['tf-inspect-gold', '--json'], goldenIo.io).stdout)
eq(goldenJson.workspacePath, 'D:\\work\\ddd', 'workspacePath 只进 JSON（文本态结构上不接收，AC-3/D3）')
eq(goldenJson.runId, 'tf-inspect-gold', 'JSON runId 取自 journal.id')

// ── G8) 只读：假 io 仅三读函数 / fixture 逐字节不变 / stdout 未直写（AC-10/12）──
console.log('\n[G8] 只读（AC-10/12）：io 仅三读函数 / fixture 逐字节不变 / 无旁路 stdout')
deepEq(Object.keys(goldenIo.io).sort(), ['existsSync', 'readFileSync', 'readdirSync'], '假 io 仅暴露 existsSync/readdirSync/readFileSync（写调用不可达）')
const snapshot = (fsx) => JSON.stringify([[...fsx.dirs.entries()], [...fsx.files.entries()]])
const before = snapshot(collectIo)
const probeIo = fakeTeamflow({ wsProbe: { 'tf-x.json': jGood } })
const probeBefore = snapshot(probeIo)
mod.collectJournal({ root: TEAMFLOW_ROOT, runId: 'tf-x', io: probeIo.io })
mod.buildReport([{ ws: 'wsProbe', j: jGood }])
mod.renderText(mod.buildReport([{ ws: 'wsProbe', j: jGood }]))
mod.renderJson(mod.buildReport([{ ws: 'wsProbe', j: jGood }]))
run(['tf-x'], probeIo.io)
run(['tf-x', '--json'], probeIo.io)
run(['--help'], probeIo.io)
run([], probeIo.io)
eq(snapshot(probeIo), probeBefore, '只读：假 fs 内容在收集/构建/渲染/CLI 全程逐字节不变')
eq(snapshot(collectIo), before, '只读：被读过的 fixture 也未被改写')

const directChunks = []
const origDirectWrite = process.stdout.write
process.stdout.write = function (chunk) { directChunks.push(String(chunk)); return true }
let successOutCalls = 0
let errorOutCalls = 0
try {
  outCalls = 0
  mod.runCli(['tf-x'], { io: strictIo(probeIo.io), env: { DSH_HOME: HOME }, out, err })
  mod.runCli(['--help'], { io: strictIo(probeIo.io), env: { DSH_HOME: HOME }, out, err })
  successOutCalls = outCalls
  outCalls = 0
  mod.runCli(['tf-nope'], { io: strictIo(probeIo.io), env: { DSH_HOME: HOME }, out, err })
  errorOutCalls = outCalls
} finally {
  process.stdout.write = origDirectWrite
}
eq(directChunks.length, 0, 'deps.out/err 提供时 runCli 不直写 process.stdout（零旁路）')
eq(successOutCalls, 2, '命中 run / --help 各经 deps.out 写 stdout 一次')
eq(errorOutCalls, 0, '错误路径（未找到 run）在 deps.out 下零写 stdout')

// ── G9) 接线：bin / files 白名单 / 双链登记（AC-1/12）──
console.log('\n[G9] 接线（AC-1/12）：bin 指向脚本 + files 白名单 + test/prepublishOnly 双链')
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
eq(pkg.bin?.['dsh-teamflow-run-inspect'], 'scripts/run-inspect.mjs', 'package.json bin.dsh-teamflow-run-inspect → scripts/run-inspect.mjs')
const binTarget = pkg.bin?.['dsh-teamflow-run-inspect']
ok(existsSync(join(REPO_ROOT, binTarget)), `bin 目标真实存在：${binTarget}`)
ok(Array.isArray(pkg.files) && pkg.files.includes('scripts/run-inspect.mjs'), 'files[] 白名单含 scripts/run-inspect.mjs（否则发布包内命令悬空）')
deepEq(Object.keys(pkg.dsh ?? {}), ['manifestVersion', 'bundle', 'client'], 'package.json dsh 块键集合未变（本需求不动）')
ok(pkg.scripts?.test?.includes('node test/run-inspect.test.js'), 'test 链已登记本套件')
ok(pkg.scripts?.prepublishOnly?.includes('node test/run-inspect.test.js'), 'prepublishOnly 链已登记本套件')

// ── 收口 ──
if (failed) {
  console.error(`\n❌ run-inspect 门禁失败 ${failed} 项`)
  process.exit(1)
}
console.log('\n✅ run-inspect 门禁全绿')
process.exit(0)
