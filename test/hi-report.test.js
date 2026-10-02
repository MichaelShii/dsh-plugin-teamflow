/**
 * dsh-plugin-teamflow — `scripts/hi-report.mjs` 测试。
 *
 * 它守的是**度量本身**：本仓曾长期按「humanIntervention 8/23 = 35%」排优先级，而那个数字取自
 * 早于 2026-09-17 的 23 个 run。**没有可复跑的度量，旧数字就会一直驱动错误的优先级**。
 * 故这里除了功能断言，还要锁住：① 只读三重（不许变成写盘/子进程脚本）；② 分层口径；
 * ③ knownIssues 单独成桶（否则「剩下的人工介入其实都是设计使然」这件事会看不出来）。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildScan, buildReport, classify, renderText, runCli, startedAtOf, SCHEMA } from '../scripts/hi-report.mjs'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => { if (cond) console.log(`  ✓ ${msg}`); else { failed++; console.log(`  ✗ ${msg}`) } }
const eq = (a, b, msg) => ok(a === b, `${msg}（实得 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`)

/* ── ① 只读三重（源码级） ── */
console.log('\n── 只读三重（与 run-inspect.mjs 同款约定）──')
const src = readFileSync(join(here, '../scripts/hi-report.mjs'), 'utf8')
ok(!/writeFileSync|mkdirSync|rmSync|appendFileSync|unlinkSync|copyFileSync|renameSync|truncateSync/.test(src),
  '源码不引用任何写盘 API（只读脚本）')
ok(!/child_process|spawnSync|execSync|execFile|fork\(/.test(src), '源码不引用子进程模块（D2：零子进程可断言）')
ok(/const nodeIo = \{ existsSync, readdirSync, readFileSync \}/.test(src), 'io 适配器只暴露三个读函数')
ok(/pathToFileURL\(resolve\(process\.argv\[1\]\)\)\.href === import\.meta\.url/.test(src), '入口守卫：import 期零 IO、零输出')
ok(!/process\.exit\(/.test(src) && /process\.exitCode = runCli/.test(src), 'CLI 只回退出码，内部不调 process.exit')

/* ── ② 内存 io 夹具 ── */
const K = (...p) => join(...p)
const tree = {
  [K('root')]: ['ws-a', 'ws-b', 'not-a-dir'],
  [K('root', 'ws-a')]: ['runs'],
  [K('root', 'ws-a', 'runs')]: ['r1.json', 'r2.json', 'ignored.txt'],
  [K('root', 'ws-b')]: ['runs'],
  [K('root', 'ws-b', 'runs')]: ['r3.json', 'broken.json'],
  [K('root', 'not-a-dir')]: [],
  [K('root', 'ws-a', 'runs', 'r1.json')]: JSON.stringify({
    id: 'r1', status: 'completed', humanIntervention: true, knownIssuesAcceptance: true,
    startedAt: '2026-09-20T00:00:00Z',
  }),
  [K('root', 'ws-a', 'runs', 'r2.json')]: JSON.stringify({
    id: 'r2', status: 'completed', humanIntervention: false, startedAt: '2026-09-21T00:00:00Z',
  }),
  [K('root', 'ws-b', 'runs', 'r3.json')]: JSON.stringify({
    id: 'r3', status: 'failed', humanIntervention: true,
    error: 'ACCEPTANCE.md 缺少验收结论行，需人工确认结论', startedAt: '2026-09-05T00:00:00Z',
  }),
  [K('root', 'ws-b', 'runs', 'broken.json')]: '{ not json',
}
const io = {
  existsSync: (p) => Object.prototype.hasOwnProperty.call(tree, p),
  readdirSync: (p) => (Object.prototype.hasOwnProperty.call(tree, p) ? tree[p] : []),
  readFileSync: (p) => {
    if (!Object.prototype.hasOwnProperty.call(tree, p)) throw new Error('ENOENT ' + p)
    return tree[p]
  },
}

console.log('\n── 扫描与归因 ──')
// ⚠ 起跑时刻两种格式都要认：journal 既有 epoch 毫秒（当前格式）也有 ISO 字符串（早期格式）。
// 只写 Number(v) 会把 ISO 串算成 NaN → 被 `|| 0` 吞成 0 ⇒ 所有 run 塌到同一时刻、--since 整段失灵。
eq(startedAtOf(1758000000000), 1758000000000, 'epoch 毫秒原样取值')
eq(startedAtOf('2026-09-20T00:00:00Z'), Date.parse('2026-09-20T00:00:00Z'), 'ISO 字符串按 Date.parse 归一')
eq(startedAtOf(null), null, '缺失 → null（不塌成 0）')
eq(startedAtOf('不是时间'), null, '垃圾值 → null（不塌成 0）')
const entries = buildScan(io, K('root'))
eq(entries.length, 3, '扫到 3 个合法 journal（.txt 与坏 JSON 跳过、不抛）')
eq(entries[0].id, 'r3', '按 startedAt 升序（r3 最早）')
eq(classify({ knownIssuesAcceptance: true, error: null }), 'K knownIssues 验收（QA 超限，产品决策交人——刻意设计，非缺陷）',
  'knownIssues 优先成 K 桶（否则「剩下的都是设计使然」看不出来）')
eq(classify({ error: 'ACCEPTANCE.md 缺少验收结论行，需人工确认结论' }), 'A 验收产物缺结论行', '验收缺结论行 → A 桶')
eq(classify({ error: '开发失败任务 1/1：提测门禁拦截，不进 QA' }), 'D 提测门禁拦截', '提测门禁 → D 桶')
eq(classify({ humanIntervention: true }), 'H 无 error（人工介入但已收口）', '无 error → H 桶')
ok(classify({ error: '某个全新的失败文案' }).startsWith('Z 其它'), '未识别 → Z 桶（不静默丢）')

console.log('\n── 分层（--since）与两态同源 ──')
const all = buildReport(entries, {})
eq(all.total, 3, '不分层 = 全部 3 个')
eq(all.humanIntervention.count, 2, '人工介入 2 个（r1 + r3）')
eq(all.failed.count, 1, 'failed 1 个（r3）')
const since = buildReport(entries, { since: '2026-09-17' })
eq(since.total, 2, '--since 2026-09-17 → 只剩 r1 / r2（r3 是 09-05，被切掉）')
eq(since.humanIntervention.count, 1, '分层后人工介入 1 个')
eq(since.humanIntervention.byClass[0].cls, 'K knownIssues 验收（QA 超限，产品决策交人——刻意设计，非缺陷）',
  '分层后剩下的正是 K 桶（刻意设计）')
eq(since.failed.count, 0, '分层后 failed = 0 —— 这就是「35% 是过期数字」的复现')
eq(all.schema, SCHEMA, 'schema 常量')

const text = renderText(all)
ok(text.includes('人工介入：2 / 3'), '文本态含人工介入计数（与 JSON 同源）')
ok(text.includes('A 验收产物缺结论行'), '文本态含归因桶')
ok(text.includes('K 桶 = 刻意设计的产品决策'), '文本态明说 K 桶不计入缺陷（防误读成待修）')

console.log('\n── CLI 退出码与输出 ──')
let out = null
const deps = { io, env: {}, root: K('root'), log: (s) => { out = s } }
eq(runCli(['--help'], deps), 0, '--help → 0')
ok(String(out).includes('hi-report — humanIntervention 归因巡检'), '--help 打出用法')
eq(runCli(['--nope'], deps), 2, '未识别参数 → 2')
eq(runCli(['--since', '2026/09/17'], deps), 2, '--since 格式非 YYYY-MM-DD → 2')
eq(runCli([], deps), 0, '默认（无参数）→ 0')
ok(String(out).includes('run 总数：3'), '默认输出走注入的 io（不碰真实磁盘）')
eq(runCli(['--json'], deps), 0, '--json → 0')
ok(JSON.parse(out).schema === SCHEMA, '--json 输出可解析且首键为 schema')

console.log(failed === 0 ? '\n✅ hi-report 全部通过' : `\n❌ hi-report ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
