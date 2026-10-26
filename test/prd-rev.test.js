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
 * 其余沿用内容驱动（有 `taste` 项才停）。
 *
 * ⚠️ **改写次数不设上限**（2026-10-17 第二版）：第一版把上界定成 2（第 3 次硬拒 + 让用户重开 run），
 * 被用户当场否掉。理由是 `redoPrd` 只在 `prdOnly`（PRD 之后零阶段）成立 ⇒ 作废面恒为零，
 * 改 1 次和改 5 次成本相同；上限防不住浪费，只会把人赶去「重开 run」——那在本阶段纯损失。
 * 现在只留 `PRD_REV_HINT`（第 3 版起提示「方向未定的话整体重述更省」），不阻断。
 * 「已进 design/tech 后不许改」才是真线，由 `supplementTooLate` 保证（不属本文件）。
 */
import { confirmDecision, buildConfirmSheet, renderConfirmSheet, PRD_REV_HINT } from '../host/core/confirm.ts'

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

console.log('── 4) 改写次数：**无硬上限**（第一版设过 PRD_REV_MAX=2，被用户否掉）──')
// 为什么不设上限：`redoPrd` 的前提是 `prdOnly`（PRD 之后零阶段）⇒ 作废面恒为零，
// 改 1 次和改 5 次成本相同。上限防不住浪费，只会把用户赶去「重开 run」——那在本阶段是纯损失。
eq(PRD_REV_HINT, 3, `提示阈值 = ${PRD_REV_HINT}（只提示，不阻断）`)
eq(decision({ prdRev: 3, approvedRev: 2, tasteCount: 0 }), { ask: true, reason: 'revised' }, '第 3 版照样要确认（不被拦）')
eq(decision({ prdRev: 5, approvedRev: 4, tasteCount: 0 }), { ask: true, reason: 'revised' }, '第 5 版照样要确认（无硬上限）')
eq(decision({ prdRev: 9, approvedRev: 9 }), { ask: false, reason: 'approved' }, '第 9 版批过 ⇒ 不再打断（版本号只用来判批准失效）')
eq(decision({ prdRev: 9, approvedRev: 8 }), { ask: true, reason: 'revised' }, '第 9 版没批过 ⇒ 仍要确认')

console.log('── 5) 确认单上要能看出「这是第几版」＋ 上一版在哪 ──')
const base = { summary: '目标', acIndex: { 'AC-1': 'x' }, runDocs: '/r' }
const s1 = buildConfirmSheet({ ...base, prdRev: 1 })
eq(s1.prdRev, 1, '第 1 版')
const s2 = buildConfirmSheet({ ...base, prdRev: 2, prevDocPath: '/r/PRD.v1.md' })
eq(s2.prdRev, 2, '第 2 版')
eq(s2.prevDocPath, '/r/PRD.v1.md', '第 2 版带上一版路径（可直接对比）')
eq(buildConfirmSheet({ ...base }).prdRev, 1, '缺省 ⇒ 1')
eq(buildConfirmSheet({ ...base }).prevDocPath, '', '首版没有上一版路径（不给死链）')
eq(buildConfirmSheet({ ...base, prdRev: 0 }).prdRev, 1, '0 ⇒ 归一为 1（不出现「第 0 版」）')
eq(buildConfirmSheet({ ...base, prdRev: -3 }).prdRev, 1, '负数 ⇒ 归一为 1')
eq(buildConfirmSheet({ ...base, prdRev: Number.NaN }).prdRev, 1, 'NaN ⇒ 归一为 1')
// 渲染：第 1 版**不加**版本行（省 token）；第 2 版必须自曝 + 给上一版路径
const r1 = renderConfirmSheet(s1, 'zh')
const r2 = renderConfirmSheet(s2, 'zh')
const r2en = renderConfirmSheet(s2, 'en')
eq(/第 2 版/.test(r2), true, 'zh 第 2 版：渲染出「第 2 版」')
eq(/PRD\.v1\.md/.test(r2), true, 'zh 第 2 版：渲染出上一版路径')
eq(/第 1 版|第 0 版/.test(r1), false, 'zh 第 1 版：不渲染版本行（不刷屏）')
eq(/version 2/i.test(r2en), true, 'en 第 2 版：渲染出 "version 2"')
eq(/version 1/i.test(renderConfirmSheet(s1, 'en')), false, 'en 第 1 版：不渲染版本行')
// 提示阈值：只提示，不阻止
const r2hint = renderConfirmSheet(buildConfirmSheet({ ...base, prdRev: PRD_REV_HINT, prevDocPath: '/r/PRD.v2.md' }), 'zh')
const r2under = renderConfirmSheet(s2, 'zh')
eq(r2hint.split('\n').length > r2under.split('\n').length, true, `第 ${PRD_REV_HINT} 版起多一行成本提示（不阻断）`)
eq(/改 \d+ 次/.test(r2hint) || /重述/.test(r2hint), true, '提示内容指向「整体重述」，不是「不给改」')

console.log('── 6) 行数预算不被版本行打破（确认单 ≤40 行的硬约定）──')
eq(r2.split('\n').length <= 40, true, `第 2 版仍 ≤40 行（实际 ${r2.split('\n').length}）`)
eq(r2hint.split('\n').length <= 40, true, `第 ${PRD_REV_HINT} 版仍 ≤40 行（实际 ${r2hint.split('\n').length}）`)

console.log('── 确认单清单化：序号 + 事实/主观双标签（2026-10-18）──')
{
  // 为什么：用户要改某条时会说「第 1 条改成 GBK」⇒ 没有序号就对不上号；
  // 事实项不打标 ⇒ 用户无法分辨「哪些已按缺省定了、不用管」，只能逐条读完。
  const { buildConfirmSheet, renderConfirmSheet } = await import('../host/core/confirm.ts')
  const sheet = buildConfirmSheet({
    summary: '测试摘要',
    acIndex: { 'AC-1': '能跑' },
    openQuestions: [
      { q: '编码默认按什么处理？', why: '错误编码会静默丢字', changes: '需引入 iconv', default: 'UTF-8', kind: 'fact' },
      { q: '命令名叫什么？', why: '影响调用习惯', changes: '改 bin 字段', default: 'readme-toc', kind: 'taste' },
    ],
    prdRev: 2,
  })
  const text = renderConfirmSheet(sheet, 'zh')
  eq(text.includes('1. ［事实项］编码默认按什么处理？'), true, '第 1 条带序号 + 事实标签')
  eq(text.includes('2. ［主观项］命令名叫什么？'), true, '第 2 条带序号 + 主观标签')
  eq(text.includes('（缺省：UTF-8）'), true, '缺省值可见（用户据此决定要不要改）')
  eq(text.includes('为什么问：错误编码会静默丢字'), true, '追问理由可见（展开依据不用另开文件）')
  const textEn = renderConfirmSheet(sheet, 'en')
  eq(textEn.includes('1. [fact]'), true, 'en 版同样有序号 + fact 标签')
  eq(textEn.includes('2. [taste]'), true, 'en 版序号 + taste 标签')
}

console.log(failed === 0 ? '\n✅ prd-rev 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
