/**
 * dsh-plugin-teamflow — host 侧**接口一致性核对**测试。
 *
 * 冻结语料锁两端（都来自真实事故/真实产物，不是随手编的）：
 *   ① 温度换算（tf-mumf3bmo-yxlomp 的同构结构）→ 0 处；
 *   ② tf-mul4t5ga-ajs4i4 的事故复刻：main.js 调 GameEngine 上不存在的
 *      move() / render() / .score —— 首帧 TypeError 直接死机，而「文件存在 / 有 export」
 *      级别的检查全绿。这类 bug 静态可查，本文件保证它每次都被查出来。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { checkDeliverableInterfaces, collectModuleExports } from '../host/core/workspace/interface-check.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ ${msg}`) }
}
const mktmp = (tag) => mkdtempSync(join(tmpdir(), `tf-iface-${tag}-`))
const put = (root, rel, text) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
}

/* ── ① 正常交付：跨模块调用用到的成员都存在 ── */
const A = mktmp('ok')
put(A, 'js/units.js', 'export function cToF(c) { return c * 9 / 5 + 32 }\nexport function fToC(f) { return (f - 32) * 5 / 9 }\n')
put(A, 'js/format.js', "export function formatTemp(n, unit) { return n.toFixed(1) + '°' + unit }\n")
put(A, 'js/main.js', "import { cToF, fToC } from './units.js'\nimport { formatTemp } from './format.js'\nconst out = formatTemp(cToF(100), 'F')\nconsole.log(out, fToC(212))\n")
const a = checkDeliverableInterfaces(A)
console.log('\n── 语料①：正常交付（对应温度换算 run）──')
ok(a.status === 'ok', `→ ok（实测 ${a.status}）`)
ok(a.issues.length === 0, `零处不一致（实测 ${a.issues.length}）`)
ok(a.files === 3, `扫到 3 个源文件（实测 ${a.files}）`)

/* ── ② 事故复刻：调用了不存在的成员 ── */
const B = mktmp('bad')
put(B, 'js/GameEngine.js', 'export class GameEngine {\n  constructor() { this.speed = 100 }\n  update() {}\n  draw() {}\n}\n')
put(B, 'js/main.js', "import { GameEngine } from './GameEngine.js'\nconst engine = new GameEngine()\nengine.move()\nengine.render()\nconsole.log(engine.score)\n")
const b = checkDeliverableInterfaces(B)
console.log('\n── 语料②：事故复刻（贪吃蛇 engine.move 那一类）──')
ok(b.status === 'mismatch', `→ mismatch（实测 ${b.status}）`)
ok(b.issues.length === 3, `命中 3 处（实测 ${b.issues.length}）`)
ok(b.issues.some((i) => i.expr === 'engine.move'), 'engine.move 必须命中（真实事故里的首帧崩溃点）')
ok(b.issues.some((i) => i.expr === 'engine.render'), 'engine.render 必须命中')
ok(b.issues.some((i) => i.expr === 'engine.score'), 'engine.score 必须命中')
ok(b.issues.every((i) => i.file === 'js/main.js' && i.line > 0), '每条都带文件与行号（可定位）')
ok(!b.issues.some((i) => i.expr.includes('speed')),
  '**构造函数里的 this.speed 不得误报** —— 首版自测正是漏了这条而多报 4 处')

/* ── ③ 边界：不足两个源文件 → skip（与「查了没毛病」必须区分） ── */
const C = mktmp('skip')
put(C, 'js/only.js', 'export function a() {}\n')
console.log('\n── 语料③：边界 ──')
ok(checkDeliverableInterfaces(C).status === 'skip', '单文件 → skip（无跨模块调用可查）')
ok(checkDeliverableInterfaces(null).status === 'skip', 'root 为 null → skip（不得抛、不得编造结论）')
ok(checkDeliverableInterfaces('').status === 'skip', 'root 为空串 → skip')

/* ── ④ 抽取器单测 ── */
console.log('\n── 抽取器 collectModuleExports ──')
const e = collectModuleExports(
  'export class A {\n  constructor() { this.x = 1 }\n  foo() {}\n  static bar() {}\n}\nexport const k = 1\nexport { z as w }\n',
)
ok(e.classes.get('A').has('foo'), '类方法 foo 被收集')
ok(e.classes.get('A').has('bar'), '静态方法 bar 被收集')
ok(e.classes.get('A').has('x'), '构造函数字段 this.x 被收集')
ok(e.top.has('k'), '顶层 const k 被收集')
ok(e.top.has('w'), 'export { z as w } 取导出名 w（不是原名 z）')

for (const d of [A, B, C]) rmSync(d, { recursive: true, force: true })

console.log(failed === 0 ? '\n✅ interface-check 全部通过' : `\n❌ interface-check ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
