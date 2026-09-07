/**
 * dsh-plugin-teamflow — 重试诊断包（refusalHit / buildRetryDiagnostic）回归测试。
 * 背景：withRetry 原样重试 = 盲试——子代理不知道上次为什么失败（拒绝词？过短？stopReason？护栏？）。
 * 修复：重试 prompt 附诊断块（失败分类/详情/护栏原因/产出尾部），insubstantial 细分拒绝词命中点。
 */
import { refusalHit, buildRetryDiagnostic } from '../host/util.ts'

let failed = 0
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${actual}, want ${expected}`); failed++ }
}
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

console.log('── 拒绝词命中点（refusalHit）──')
const hit = refusalHit('我先确认一下，抱歉，我无法完成这个任务，因为涉及安全边界。后续如有其他问题欢迎继续。')
ok(hit !== null, '拒绝措辞命中')
expect(hit ? hit.phrase : '', '抱歉', '命中短语「抱歉」（正则最左匹配优先）')
ok(hit ? hit.context.includes('抱歉') && hit.context.includes('安全边界') : false, '原文上下文片段覆盖命中处前后')

expect(refusalHit('正常产出，无拒绝措辞。'), null, '无拒绝措辞 → null')
expect(refusalHit(''), null, '空文本 → null')
expect(refusalHit(null), null, 'null → null')

console.log('── 重试诊断包（buildRetryDiagnostic）──')
const diag = buildRetryDiagnostic(2, {
  outcome: 'insubstantial',
  summary: '产出未通过实质校验：命中拒绝词「我无法完成」（原文：抱歉，我无法完成这个任务），视为未交付',
  output: '正常开头正文'.repeat(300),
})
ok(diag.includes('[重试诊断 · 第 2 次尝试]'), '诊断块标注尝试次数')
ok(diag.includes('失败分类：insubstantial'), '失败分类入块')
ok(diag.includes('命中拒绝词「我无法完成」'), '拒绝词命中点入块（详情引用 summary）')
ok(diag.endsWith('[/重试诊断结束]'), '诊断块闭合标记')
ok(diag.length < 2000, '产出尾部已截断（块总长受控，不撑爆重试 prompt）')

const diagGuard = buildRetryDiagnostic(3, {
  outcome: 'stalled',
  summary: '进行中护栏中止（空转（15 分钟内无任何工具调用，但会话仍在产出）），本次尝试无有效产出',
  guardReason: '空转（15 分钟内无任何工具调用，但会话仍在产出）',
  output: '',
})
ok(diagGuard.includes('护栏中止原因：空转'), '护栏原因入块')
ok(!diagGuard.includes('上一轮产出末尾'), '无产出时不带产出尾部段')

const diagNoDiag = buildRetryDiagnostic(2, { outcome: 'error', summary: null, output: null })
ok(diagNoDiag.includes('失败分类：error') && !diagNoDiag.includes('详情：'), '缺省字段容错（无 summary/无产出）')

console.log(failed === 0 ? '\n✅ diagnostic 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)