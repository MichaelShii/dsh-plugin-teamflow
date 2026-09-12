/**
 * dsh-plugin-teamflow — 重试诊断包（refusalHit / buildRetryDiagnostic）回归测试。
 * 背景：withRetry 原样重试 = 盲试——子代理不知道上次为什么失败（拒绝词？过短？stopReason？护栏？）。
 * 修复：重试 prompt 附诊断块（失败分类/详情/护栏原因/产出尾部），insubstantial 细分拒绝词命中点。
 */
import { refusalHit, buildRetryDiagnostic, judgeDeliverable } from '../host/util.ts'

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

console.log('── 交付判定（judgeDeliverable：信号分级，措辞不再是门禁）──')
// 长度门是形态约束（客观），先于措辞判据
expect(judgeDeliverable('dev', '').reason, 'empty', '空产出 → empty')
expect(judgeDeliverable('dev', null).reason, 'empty', 'null 产出 → empty')
expect(judgeDeliverable('dev', '太短').reason, 'too-short', '未达阶段长度下限 → too-short')
ok(judgeDeliverable('dev', '实现完成，改动 a.js。' + 'x'.repeat(80)).ok, '正常产出 → 交付')

// 实锤回归（assetd tf-mtwvwpxa-p3vw08 的 T5）：如实汇报环境限制 + 证据块齐全 → 交付。
// 旧判据（全文拒绝词）把它判成 insubstantial「视为未交付」→ 提测门禁停线 + 人工 resume。
const envLimit = [
  'T5 实现完成，仅改 src/query.mjs。',
  '重点：本沙箱禁止子进程管道，tests/run.mjs 的 7 个 runCli 用例与 spec/verify.mjs 全部 26 例无法执行，属环境性失败；T11 需在无限制 shell 复跑。',
  '',
  '[Verification evidence]',
  '- cmd: node logs/teamflow/tf-x/smoke-lib.mjs → exit 0, 34/34 asserts',
  '',
  '<!-- state -->{"phase":"dev","summary":"T5 完成"}<!-- /state -->',
].join('\n')
const envVerdict = judgeDeliverable('dev', envLimit)
ok(envVerdict.ok, '如实汇报环境限制（含「无法执行」）+ 证据块 → 判交付（假阳性 root cause 回归）')
ok(envVerdict.reason === 'ok', '豁免路径 reason=ok')
ok(envVerdict.refusal !== null && envVerdict.refusal.phrase === '无法执行', '命中措辞仍回传（留痕/诊断不丢信号）')

// 兜底仍然有效：没有证据块 + 命中拒绝词 = 「光说不做 / 自称做不到」的形态
const bareRefusal = '抱歉，我无法完成这个任务，因为涉及安全边界。' + 'y'.repeat(80)
const bareVerdict = judgeDeliverable('dev', bareRefusal)
ok(!bareVerdict.ok, '无证据块 + 命中拒绝词 → 判未交付（兜底未被削弱）')
expect(bareVerdict.reason, 'refusal', '兜底路径 reason=refusal（供重试诊断回灌命中点）')

// 顺序语义：长度门是客观形态下限，优先于证据块豁免（qa 下限 250）
ok(!judgeDeliverable('qa', '[Verification evidence]\n过短').ok, '长度门先于证据块豁免（极短产出不给豁免）')

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