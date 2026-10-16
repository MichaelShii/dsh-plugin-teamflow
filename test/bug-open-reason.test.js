/**
 * dsh-plugin-teamflow — 缺陷「为什么还停在待认领」可见原因（纯函数行为断言）。
 *
 * 背景（2026-10-16 诊断）：bug 卡 `status.open` 在界面统一显示「待认领」，
 * 但 open 分两类原因且不可区分：
 *   ① P3 观察项 —— 设计上永不自动关闭，不是「没修好」；
 *   ② 非 P3 未闭环 —— 真缺陷没修好（来源需求以 needs-human 收尾 ⇒ 按设计不关闭）。
 * 这条判据是「空值必须可见」的同族问题：状态由 host 自动推进的实体，UI 必须能回答
 * 「为什么还停在这个状态」。纯函数便于无 React 单测，且分离自渲染组件。
 */
import { bugOpenReasonKey } from '../client/bug-open-reason.ts'

let failed = 0
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}

console.log('── bugOpenReasonKey：缺陷「为什么还停在待认领」可见原因 ──')

// 非 open 一律 null（verified/closed/claimed/fixed/空）
for (const st of ['verified', 'closed', 'claimed', 'fixed', 'reopened', undefined, null, '']) {
  eq(bugOpenReasonKey({ status: st, severity: 'P0' }, null), null, `status=${JSON.stringify(st)} → 无原因`)
}

// ① P3 观察项：设计上不自动关闭（大小写不敏感）
eq(bugOpenReasonKey({ status: 'open', severity: 'P3' }, null).key, 'panel.bugOpenP3', 'P3 open → P3 观察项')
eq(bugOpenReasonKey({ status: 'open', severity: 'p3' }, null).key, 'panel.bugOpenP3', 'p3 小写也归 P3 观察项')
eq(bugOpenReasonKey({ status: 'open', severity: 'P3' }, null).tone, 'muted', 'P3 语气=muted（非阻断）')

// ② 非 P3 + 来源需求 needs-human ⇒ 点明根因（humanIntervention 优先于 status）
eq(bugOpenReasonKey({ status: 'open', severity: 'P1', reqId: 'req-3' }, { status: 'needs-human' }).key, 'panel.bugOpenNeedsHuman', '非P3 + 需求needs-human → 未闭环·需人工裁定')
eq(bugOpenReasonKey({ status: 'open', severity: 'P0' }, { humanIntervention: true }).key, 'panel.bugOpenNeedsHuman', '非P3 + 需求humanIntervention → 同上')
eq(bugOpenReasonKey({ status: 'open', severity: 'P1' }, { humanIntervention: true, status: 'accepted' }).key, 'panel.bugOpenNeedsHuman', 'humanIntervention 优先于 accepted')

// ② 非 P3 + 来源需求正常 / 未提供 ⇒ 通用未闭环（待修复/复验）
eq(bugOpenReasonKey({ status: 'open', severity: 'P1' }, { status: 'accepted' }).key, 'panel.bugOpenUnclosed', '非P3 + 需求accepted → 未闭环·待修复')
eq(bugOpenReasonKey({ status: 'open', severity: 'P2' }, null).key, 'panel.bugOpenUnclosed', '非P3 + 无需求 → 通用未闭环')
eq(bugOpenReasonKey({ status: 'open', severity: 'P2' }, null).tone, 'warn', '非P3 语气=warn（阻断）')

// 边界：item 缺字段 / 空
eq(bugOpenReasonKey(null, null), null, 'item null → null')
eq(bugOpenReasonKey(undefined, null), null, 'item undefined → null')
eq(bugOpenReasonKey({}, null), null, 'item 无 status → null')
eq(bugOpenReasonKey({ status: 'open' }, null).key, 'panel.bugOpenUnclosed', 'severity 缺省且非 P3 → 通用未闭环')

console.log(failed === 0 ? '\n✅ bug-open-reason 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
