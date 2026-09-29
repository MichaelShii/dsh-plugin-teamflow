/**
 * dsh-plugin-teamflow — host 侧冒烟测试。
 *
 * 它验证的是「**不依赖模型**」这件事：0a2 / 证据探针都要求模型自己写「我跑了，exit 0」，
 * 而本插件面向任意模型（含本地小模型）—— 弱模型实测三次全写不出。host 侧冒烟把取证
 * 从模型自律搬到了机器，与模型能力无关。
 *
 * 真浏览器那段**若本机找不到浏览器会大声 SKIP**（不静默通过）；其余断言都不需要浏览器。
 */
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { injectSmokeProbe, runHostSmoke } from '../host/core/workspace/smoke-check.ts'
import { findBrowser } from '../host/core/workspace/browser-probe.ts'

let failed = 0
let skipped = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ ${msg}`) }
}
const skip = (msg) => { skipped++; console.log(`  ⏭ ${msg}`) }
const mktmp = (tag) => mkdtempSync(join(tmpdir(), `tf-smoke-${tag}-`))
const put = (root, rel, text) => {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text, 'utf8')
}

/* ── ① 注入器（纯函数，不需要浏览器） ── */
console.log('\n── injectSmokeProbe：注入正确性 ──')
const injected = injectSmokeProbe('<html><head><meta charset="utf-8"></head><body>hi</body></html>')
ok(injected.includes('window.__tf'), '计数器已注入（window.__tf 出现）')
ok(injected.includes('TFSMOKE='), '上报器已注入（TFSMOKE= 标记出现）')
ok(injected.indexOf('window.__tf') < injected.indexOf('TFSMOKE='), '计数器在上报器之前（否则拦不到绘制）')
ok(injected.indexOf('window.__tf') > injected.indexOf('<head'), '计数器在 <head> 之后（早于页面模块）')
ok(injected.includes('</body>'), '原 </body> 仍保留')
const noHead = injectSmokeProbe('<html><body>no head</body></html>')
ok(noHead.includes('TFSMOKE='), '无 </body> 之外的场景：无 <head> 的页面也能注入上报器')
ok(noHead.includes('window.__tf'), '**无 <head> 时计数器也必须注入** —— 否则计数全 0、把有动画的页面误判成 no-motion')
ok(noHead.indexOf('window.__tf') < noHead.indexOf('<body'), '无 <head> 时计数器落在 <body> 之前（仍早于页面脚本）')

/* ── ② skip 路径（都不应起浏览器） ── */
console.log('\n── runHostSmoke：skip 路径 ──')
ok(runHostSmoke(null).status === 'skip', 'root=null → skip（不得抛、不得编造结论）')
const NoHtml = mktmp('nohtml')
put(NoHtml, 'js/a.js', 'export function f() {}\n')
put(NoHtml, 'README.md', '# x\n')
ok(runHostSmoke(NoHtml).status === 'skip', '无 HTML 入口 → skip')
const NoScript = mktmp('noscript')
put(NoScript, 'index.html', '<html><body><p>static</p></body></html>\n')
const sc = runHostSmoke(NoScript)
ok(sc.status === 'skip', '入口无 <script> → skip（静态页面不该被判「不动」）')
ok(sc.entry === 'index.html', `entry 仍记下来了（实测 ${sc.entry}）`)

/* ── ③ 真浏览器（有浏览器才断言；否则大声 SKIP） ── */
console.log('\n── runHostSmoke：真浏览器 ──')
const Chrome = findBrowser()
if (!Chrome) {
  skip('本机未找到 Chromium 可执行 → 跳过真实冒烟断言（**非通过**）')
} else {
  const Live = mktmp('live')
  put(Live, 'index.html',
    '<!doctype html><meta charset="utf-8"><body style="margin:0">'
    + '<canvas id="c" width="200" height="200"></canvas>'
    + '<script>const g=document.getElementById("c").getContext("2d");'
    + 'let i=0;function f(){g.fillStyle="#22c55e";g.fillRect(i%180,10,20,20);i++;requestAnimationFrame(f)}'
    + 'requestAnimationFrame(f);</script></body>')
  // 环境容忍：浏览器起不来（skip）→ 大声跳过，**不算通过**；但 error（副本/解析失败）
  // 是代码问题，必须红 —— 否则代码坏了也会因为“环境跳过”而蒙混过关。
  const live = runHostSmoke(Live)
  if (live.status === 'skip') {
    skip(`浏览器未产出结论（${live.note || 'skip'}）→ 跳过真实冒烟断言（**非通过**）`)
  } else {
    ok(live.status === 'ok', `有动画的页面 → ok（实测 ${live.status}）`)
    ok(live.draw > 0, `绘制调用 > 0（实测 ${live.draw}）`)
    ok(live.raf > 0, `rAF 被调度（实测 ${live.raf}）`)
  }

  // 复刻贪吃蛇 A 组的事故形态：**有 canvas，脚本也在跑，但 draw() 永不执行** ——
  // 画面全黑、控制台干净，「文件存在 / 有 export」级别的检查全绿。
  // ⚠️ 语料必须带 canvas：无 canvas 时页面解析本身就会产生 DOM 变更（mut 恒 >0），
  // 判据会退化成「永远 ok」—— 所以「有画布却一次没画」才是可用的强信号。
  const Inert = mktmp('inert')
  put(Inert, 'index.html',
    '<!doctype html><meta charset="utf-8"><body>'
    + '<canvas id="c" width="200" height="200"></canvas>'
    + '<script>window.__ctx=document.getElementById("c").getContext("2d");'
    + 'var n=0;function f(){n++;requestAnimationFrame(f)}requestAnimationFrame(f);</script></body>')
  const inert = runHostSmoke(Inert)
  if (inert.status === 'skip') {
    skip(`浏览器未产出结论（${inert.note || 'skip'}）→ 跳过事故形态断言（**非通过**）`)
  } else {
    ok(inert.status === 'no-motion', `**有 canvas 但从未绘制 → no-motion**（实测 ${inert.status}）`)
    ok(inert.draw === 0, `绘制数为 0（实测 ${inert.draw}）`)
    ok(inert.canvas >= 1, `canvas 被识别到（实测 ${inert.canvas}）`)
  }
  rmSync(Live, { recursive: true, force: true })
  rmSync(Inert, { recursive: true, force: true })
}

for (const d of [NoHtml, NoScript]) rmSync(d, { recursive: true, force: true })

console.log(failed === 0
  ? `\n✅ smoke-check 全部通过${skipped ? `（${skipped} 项因环境跳过）` : ''}`
  : `\n❌ smoke-check ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
