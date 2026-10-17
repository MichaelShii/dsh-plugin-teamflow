/**
 * dsh-plugin-teamflow — PRD 版本 / 确认单「批准失效」判据（纯函数行为断言）。
 *
 * 背景（2026-10-17，issue #11 实锤 `tf-mv5xkem-imgt7v`）：用户在确认单暂停期间用
 * `teamflow_resume` + `supplement` 改了需求 ⇒ PRD 被重跑（redo），但**第二张确认单没来**，
 * 流水线直接进开发。旧判据是 `shouldConfirm && !resume`，注释写着「确认单只做一轮」——
 * 把**轮次**当成了不变量，而真正可变的是**被批准的对象**：redo 走的正是 resume 路径。
 * 模型自己都许诺 "a fresh confirm sheet will arrive"，汇报文案也一直许诺「会再出一份新确认单」
 * ⇒ 旧实现是假承诺。
 *
 * 现判据（`confirmDecision`）：`approvedRev >= prdRev` ⇒ 已批过；`prdRev > 1` ⇒ 改写后无条件再确认；
 * 其余沿用内容驱动（有 `taste` 项才停）。上界 `PRD_REV_MAX` 封住改写次数 ——
 * 没有上界就是 `/plan` 模式（反复修正需求），与本产品「批量可靠交付」的定位互斥。
 */
import { confirmDecision, redoAllowed, buildConfirmSheet, renderConfirmSheet, PRD_REV_MAX } from '../host/core/confirm.ts'

let failed = 0
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}
const decision = (v) => confirmDecision({ mode: 'full', confirmMode: 'auto', tasteCount: 0, prdRev: 1, approvedRev: null, ...v })

console.log('── 1) 首版：内容驱动（有 taste 才停），与旧行为一致 ──')
eq(decision({ tasteCount: 0 }), { ask: false, reason: 'none' }, '首版 + 无 taste ⇒ 不停（保住无人值守卖点）')
eq(decision({ tasteCount: 2 }), { ask: true, reason: 'taste' }, '首版 + 有 taste ⇒ 停')
eq(decision({ tasteCount: 0, confirmMode: 'always' }), { ask: true, reason: 'taste' }, 'confirmMode=always ⇒ 强制停')
eq(decision({ tasteCount: 5, confirmMode: 'never' }), { ask: false, reason: 'off' }, 'confirmMode=never ⇒ 连改写后也不停（显式关闸）')
eq(decision({ mode: 'patch', tasteCount: 5 }), { ask: false, reason: 'patch' }, 'patch 档 ⇒ 恒不停（ADR-0011 档位矩阵）')

console.log('── 2) 批准过的版本不再打断（否则续跑会反复拦同一版）──')
eq(decision({ prdRev: 1, approvedRev: 1, tasteCount: 3 }), { ask: false, reason: 'approved' }, '第 1 版已批 ⇒ 续跑不重复打断')
eq(decision({ prdRev: 1, approvedRev: 2 }), { ask: false, reason: 'approved' }, 'approvedRev 领先（跨版本残留）⇒ 视为已批，不误拦')
eq(decision({ prdRev: 0, approvedRev: 0 }), { ask: false, reason: 'none' }, 'prdRev=0（PRD 还没跑）⇒ 不因 approved 判定跳过内容判据')

console.log('── 3) 改写后的版本：**无条件**再确认（本次修的核心）──')
eq(decision({ prdRev: 2, approvedRev: 1, tasteCount: 0 }), { ask: true, reason: 'revised' },
  '第 2 版 + 无 taste ⇒ **仍要停**（用户刚改了需求，他要确认改对了，不由模型判断「要不要紧」）')
eq(decision({ prdRev: 2, approvedRev: 1, tasteCount: 2 }), { ask: true, reason: 'revised' }, '第 2 版 + 有 taste ⇒ 停（reason 报 revised）')
eq(decision({ prdRev: 2, approvedRev: 2, tasteCount: 0 }), { ask: false, reason: 'approved' }, '第 2 版也批过 ⇒ 不再停')
eq(decision({ prdRev: 2, approvedRev: 0, mode: 'patch' }), { ask: false, reason: 'patch' }, 'patch 档改写后仍不停')

console.log('── 4) 改写次数上界（没有上界 = /plan 循环）──')
eq(PRD_REV_MAX, 2, `上限 = ${PRD_REV_MAX} 版（首版 + 一次改写）`)
eq(redoAllowed(0), true, '还没跑过 PRD ⇒ 允许（老 journal 无该字段）')
eq(redoAllowed(undefined), true, 'undefined（存量 run）⇒ 允许，不因缺字段锁死')
eq(redoAllowed(null), true, 'null ⇒ 允许')
eq(redoAllowed(1), true, '第 1 版 ⇒ 允许改写（出第 2 版）')
eq(redoAllowed(2), false, `第 ${PRD_REV_MAX} 版 ⇒ **拒绝改写**（必须报错，不能静默当批准）`)
eq(redoAllowed(3), false, '超过上限 ⇒ 拒绝')

console.log('── 5) 确认单上要能看出「这是第几版」──')
const base = { summary: '目标', acIndex: { 'AC-1': 'x' }, runDocs: '/r' }
const s1 = buildConfirmSheet({ ...base, prdRev: 1 })
eq(s1.prdRev, 1, '第 1 版')
const s2 = buildConfirmSheet({ ...base, prdRev: 2 })
eq(s2.prdRev, 2, '第 2 版')
eq(buildConfirmSheet({ ...base }).prdRev, 1, '缺省 ⇒ 1')
eq(buildConfirmSheet({ ...base, prdRev: 0 }).prdRev, 1, '0 ⇒ 归一为 1（不出现「第 0 版」）')
eq(buildConfirmSheet({ ...base, prdRev: -3 }).prdRev, 1, '负数 ⇒ 归一为 1')
eq(buildConfirmSheet({ ...base, prdRev: Number.NaN }).prdRev, 1, 'NaN ⇒ 归一为 1')
// 渲染：第 1 版**不加**版本行（省 token）；第 2 版必须自曝 + 说清封顶
const r1 = renderConfirmSheet(s1, 'zh')
const r2 = renderConfirmSheet(s2, 'zh')
const r2en = renderConfirmSheet(s2, 'en')
eq(/第 2 版/.test(r2), true, 'zh 第 2 版：渲染出「第 2 版」')
eq(/第 1 版|第 0 版/.test(r1), false, 'zh 第 1 版：不渲染版本行（不刷屏）')
eq(new RegExp(String(PRD_REV_MAX)).test(r2), true, '渲染里带出封顶数字')
eq(/version 2/i.test(r2en), true, 'en 第 2 版：渲染出 "version 2"')
eq(/version 1/i.test(renderConfirmSheet(s1, 'en')), false, 'en 第 1 版：不渲染版本行')

console.log('── 6) 行数预算不被版本行打破（确认单 ≤40 行的硬约定）──')
eq(r2.split('\n').length <= 40, true, `第 2 版仍 ≤40 行（实际 ${r2.split('\n').length}）`)

console.log(failed === 0 ? '\n✅ prd-rev 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
