/**
 * dsh-plugin-teamflow — 「信号必须是真 AbortSignal」行为门禁。
 *
 * 背景（2026-10-17 issue #20 追评）：`host/util.ts` 的 `SAFE_SIGNAL` 曾是鸭子对象
 * `{ aborted:false, addEventListener(){}, removeEventListener(){}, throwIfAborted(){} }`，
 * 被 `normalizeSignal` 的鸭子判定放行后当作 `request.signal` / `spec.signal` 交给宿主。
 * 宿主把调用方 signal 直接丢进 `AbortSignal.any([...])`：
 *   - `dsh-api-gateway/lib/client.node.js:1694`  → `AbortSignal.any([token.abort.signal, callerSignal])`
 *   - `dsh-subagent/lib/index.js:1688`          → `AbortSignal.any([inputs.signal, controller.signal])`
 * **Node 22** 的 `AbortSignal.any` 只做鸭子校验（是对象且有 `aborted` 即收）⇒ 伪 signal 蒙混过关、
 * 且语义恰好正确（composite 正常创建、真 signal abort 时能级联）⇒ 零症状、三年无人发现。
 * **Node 24** 改走 WebIDL `sequence<AbortSignal>` 真 brand 校验 ⇒
 * `TypeError: signals[1] is not of type AbortSignal.`，阶段启动即死；本插件三条传 `undefined`
 * 的入口（`resumeRun` / `api.start` / triage 预检）在 Node 24 上全部不可用。
 *
 * ⚠️ 门禁设计要点（这条比 bug 本身重要）：**不能靠「跑一遍宿主那行看抛不抛」来守**——
 * 那行在 Node 22 上对伪 signal 是绿的，同一份代码换运行时才红。所以断言必须落在**契约**上：
 * `normalizeSignal(x) instanceof AbortSignal`。它在 Node 22 上就能把伪实现判死，
 * 与运行时严格度无关。文末另附一条「复刻宿主那一行」的装配断言，作为跨版本行为的补充证据
 * （在旧实现 + Node 22 下不红，故**不可**作为唯一门禁）。
 */
import { normalizeSignal, SAFE_SIGNAL } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log('  ✓', msg)
  else { failed++; console.log('  ✗', msg) }
}
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}

const BRAND = '[object AbortSignal]'
const isGenuine = (s) => s instanceof AbortSignal && Object.prototype.toString.call(s) === BRAND

// 旧实现的伪 signal（保留字面量：它是这次事故的「证物」，也是反例输入）
const LEGACY_FAKE = { aborted: false, addEventListener: () => {}, removeEventListener: () => {}, throwIfAborted: () => {} }

console.log('── 1. 兜底常量本身必须是真 signal ──')
ok(isGenuine(SAFE_SIGNAL), 'SAFE_SIGNAL instanceof AbortSignal 且 brand 为 [object AbortSignal]')
eq(SAFE_SIGNAL.aborted, false, 'SAFE_SIGNAL 永不 abort（aborted 恒 false，语义与旧实现一致）')

console.log('── 2. 非 signal 输入一律降级为**真** signal（而不是伪对象）──')
const junk = [
  ['undefined（resume/ap.start/triage 三条入口的真实入参）', undefined],
  ['null', null],
  ['空对象 {}', {}],
  ['旧伪 signal', LEGACY_FAKE],
  ['数字 0', 0],
  ['空串', ''],
  ['布尔 false', false],
  ['函数', () => {}],
  ['只带 aborted 的对象', { aborted: false }],
  ['完整鸭子但缺 brand 的对象', { aborted: false, addEventListener: () => {}, removeEventListener: () => {}, throwIfAborted: () => {} }],
]
for (const [label, input] of junk) {
  const out = normalizeSignal(input)
  ok(isGenuine(out), `${label} → 真 AbortSignal`)
  ok(out !== input, `${label} → 不复用输入对象（伪 signal 绝不能穿透）`)
}

console.log('── 3. 真 signal 原样透传（不得替换，否则取消链路被切断）──')
const ctl = new AbortController()
eq(normalizeSignal(ctl.signal) === ctl.signal, true, '真 signal 返回同一对象（身份保持）')
eq(normalizeSignal(SAFE_SIGNAL) === SAFE_SIGNAL, true, 'SAFE_SIGNAL 自身幂等')
const abortedCtl = new AbortController()
abortedCtl.abort()
eq(normalizeSignal(abortedCtl.signal) === abortedCtl.signal, true, '已 aborted 的真 signal 也原样透传（不得被兜底掩盖）')

console.log('── 4. 反例：冒 brand 但没有真内部槽的对象必须被拒 ──')
const spoofBrandOnly = { [Symbol.toStringTag]: 'AbortSignal', aborted: false }
ok(isGenuine(normalizeSignal(spoofBrandOnly)) && normalizeSignal(spoofBrandOnly) !== spoofBrandOnly, '只有 brand 没有 throwIfAborted → 拒（降级真 signal）')

console.log('── 5. 装配断言：复刻宿主那一行（跨版本补充证据，非唯一门禁）──')
// 位置 1（callerSignal 在 index 1，与用户报错 signals[1] 对应）
{
  const c = new AbortController()
  let composite = null
  try { composite = AbortSignal.any([c.signal, normalizeSignal(undefined)]) } catch (e) { console.log('  ✗ AbortSignal.any 抛错：', e && e.message) ; failed++ }
  if (composite) {
    eq(composite.aborted, false, 'composite 创建成功且未 abort')
    c.abort()
    eq(composite.aborted, true, '真 signal abort 后 composite 级联 abort（取消链路完好）')
  }
}
// 位置 0（in-process 路径 inputs.signal 在 index 0）
{
  const c = new AbortController()
  let composite = null
  try { composite = AbortSignal.any([normalizeSignal(undefined), c.signal]) } catch (e) { console.log('  ✗ AbortSignal.any（index 0）抛错：', e && e.message); failed++ }
  if (composite) {
    c.abort()
    eq(composite.aborted, true, 'index 0 位置同样可组合、可级联')
  }
}

console.log(failed === 0 ? '\n✅ signal-brand 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
