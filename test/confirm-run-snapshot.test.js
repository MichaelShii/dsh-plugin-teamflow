/**
 * dsh-plugin-teamflow — PRD 确认单的「按 run 快照」（修「汇报层串了模版」）。
 *
 * 实锤 tf-mvaubzdz-5w606x（工作区 E:\Code\Agent\YiGui）：
 *   r5（tech 档，四柱节气精度 + 六爻装卦）的完成汇报里，**PRD 确认单的目标 / 12 条 AC / 8 项待拍板
 *   全是上一轮 r4（64 卦 Wiki）的**；而同一份汇报的「假设」段却是 r5 正确的。
 * 根因：`state.json` **按项目累积、跨 run**，确认单的 目标/AC/待澄清项此前读它；`mergeStateBlock`
 *   又是**条件式覆盖**（acIndex 按键累加 / summary 仅非空覆盖 / openQuestions 缺键保持原值）⇒ 本轮
 *   PRD 没回写这些 `extra` 键时，确认单拿到上一轮 run 的残留。「假设」读的是 run 级 journal 所以是对的。
 * 修法：PRD 阶段合并 state 时**捕获本轮快照**（`prdSnapshotFromBlock`），确认单/闸门只认它。
 *
 * 本文件同时覆盖：① 纯提取器的边界；② **反回归**——慢照为空时确认单不得显示上一轮内容。
 */
import { prdSnapshotFromBlock, buildConfirmSheet } from '../host/core/confirm.ts'

let failed = 0
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}
const ok = (c, m) => { if (!c) { failed++; console.log('  ✗', m) } else console.log('  ✓', m) }

console.log('── 1) prdSnapshotFromBlock：本轮 PRD 的结构化输出快照（按 run）──')

// 正常捕获
const full = prdSnapshotFromBlock({
  phase: 'prd',
  summary: '阶段摘要（不参与快照）',
  extra: { summary: 'S', acIndex: { 'AC-1': 'a', 'AC-2': 'b' }, openQuestions: [{ q: 'Q1', why: 'w', changes: 'c', default: 'd', kind: 'taste' }] },
})
eq(full.summary, 'S', 'summary 捕获（取自 extra，不取块顶层 summary）')
eq(full.acIndex, { 'AC-1': 'a', 'AC-2': 'b' }, 'acIndex 捕获')
eq(full.openQuestions.length, 1, 'openQuestions 捕获 1 条')
eq(full.openQuestions[0].kind, 'taste', 'kind 保留')

// 无 extra / 空 / 非法 block ⇒ 三项皆 null（= 本轮 PRD 确实没给，**不回落累积 state**）
const NONE = { summary: null, acIndex: null, openQuestions: null }
eq(prdSnapshotFromBlock({ phase: 'prd' }), NONE, '无 extra → 三项皆 null')
eq(prdSnapshotFromBlock({}), NONE, '空块 → 三项皆 null')
eq(prdSnapshotFromBlock(null), NONE, 'block=null → 三项皆 null')
eq(prdSnapshotFromBlock(undefined), NONE, 'block=undefined → 三项皆 null')
eq(prdSnapshotFromBlock([]), NONE, 'block=[] → 三项皆 null')
eq(prdSnapshotFromBlock('prd'), NONE, 'block=字符串 → 三项皆 null')
eq(prdSnapshotFromBlock({ extra: null }), NONE, 'extra=null → 三项皆 null')
eq(prdSnapshotFromBlock({ extra: [] }), NONE, 'extra=[] → 三项皆 null')

// 值层清洗
eq(prdSnapshotFromBlock({ extra: { summary: '   ' } }).summary, null, 'summary 全空白 → null')
eq(prdSnapshotFromBlock({ extra: { summary: '  S  ' } }).summary, 'S', 'summary 去首尾空白')
eq(prdSnapshotFromBlock({ extra: { acIndex: { 'AC-1': 'a', 'AC-2': '  ' } } }).acIndex, { 'AC-1': 'a' }, 'acIndex 过滤空白项')
eq(prdSnapshotFromBlock({ extra: { acIndex: { 'AC-1': '   ' } } }).acIndex, null, 'acIndex 全空白 → null')
eq(prdSnapshotFromBlock({ extra: { acIndex: [] } }).acIndex, null, 'acIndex 数组 → null')
eq(prdSnapshotFromBlock({ extra: { acIndex: 'AC-1 x' } }).acIndex, null, 'acIndex 字符串 → null')

// openQuestions 走容错归一（缺 kind 归 fact + 打 kindMissing）
const q = prdSnapshotFromBlock({ extra: { openQuestions: [{ q: 'Q' }] } }).openQuestions
eq(q[0].kind, 'fact', '缺 kind → 归 fact（不暂停）')
eq(q[0].kindMissing, true, '缺 kind → 打 kindMissing（可数，空值必须可见）')
eq(prdSnapshotFromBlock({ extra: { openQuestions: 'x' } }).openQuestions, null, 'openQuestions 非数组 → null')
eq(prdSnapshotFromBlock({ extra: { openQuestions: [{ notQ: 1 }] } }).openQuestions, [], 'openQuestions 无 q 项 → 归一后空数组')

console.log('── 2) 反回归：本轮 PRD 没给时，确认单不得显示上一轮 run 的内容 ──')
const R4_AC_TEXT = 'src/main/resources/wiki/ 新增 64 个 kebab-case 卦 md'
const r5PrdText = '# 技术变更单 · r5 四柱节气精度 + 六爻装卦深度\n把固定近似节气日期换成天文精确节气时刻……（无 AC-n 形式的条目）'

// 模拟本 run：PRD 阶段没产出任何 extra（快照全 null），而项目级 state 仍是 r4 的（此处不去读它）
const snap = prdSnapshotFromBlock({ phase: 'prd' })
const sheet = buildConfirmSheet({
  summary: snap.summary, acIndex: snap.acIndex, prdText: r5PrdText,
  openQuestions: snap.openQuestions, assumptions: null, runDocs: 'docs/teamflow/20261016-r5-x',
})
eq(sheet.acSource, 'none', '本轮无 AC 且正文抽不到 → acSource=none（诚实，不冒充 state）')
eq(sheet.ac.length, 0, 'AC 段为空（不显示上一轮）')
eq(sheet.questions.length, 0, '待拍板为空（不显示上一轮）')
ok(!sheet.summary, '目标为空（不显示上一轮目标）')
ok(!JSON.stringify(sheet).includes('64 个 kebab-case'), '确认单全文不含 r4 的 AC 文本（核心反回归）')
ok(!JSON.stringify(sheet).includes(R4_AC_TEXT), '确认单全文不含 r4 的 AC 原文（逐字）')

// 对照：本轮真给了 ⇒ 正常显示（证明快照链路不是「一律清空」）
const snap2 = prdSnapshotFromBlock({ extra: { summary: 'r5 目标一句话', acIndex: { 'AC-1': '节气精算 + 真太阳时校正' } } })
const sheet2 = buildConfirmSheet({ summary: snap2.summary, acIndex: snap2.acIndex, prdText: r5PrdText, openQuestions: snap2.openQuestions })
eq(sheet2.acSource, 'state', '本轮给了 AC → acSource=state')
eq(sheet2.ac.length, 1, '显示本轮 AC 条数')
eq(sheet2.ac[0].text, '节气精算 + 真太阳时校正', '显示本轮 AC 文本')
eq(sheet2.summary, 'r5 目标一句话', '显示本轮目标')

console.log(failed === 0 ? '\n✅ confirm-run-snapshot 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
