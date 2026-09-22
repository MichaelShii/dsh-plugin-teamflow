/**
 * dsh-plugin-teamflow — 重试诊断包（refusalHit / buildRetryDiagnostic）回归测试。
 * 背景：withRetry 原样重试 = 盲试——子代理不知道上次为什么失败（拒绝词？过短？stopReason？护栏？）。
 * 修复：重试 prompt 附诊断块（失败分类/详情/护栏原因/产出尾部），insubstantial 细分拒绝词命中点。
 */
import { refusalHit, buildRetryDiagnostic, judgeDeliverable, toolResultText, isToolErrorResult, toolFailureSignature, toolFailureAction } from '../host/util.ts'

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
ok(diag.includes('上一轮尝试未成功') && diag.includes('[/重试诊断结束]'), 'zh 诊断包文案逐字不变（头部整句 + 闭合标记）')

console.log('── en 拒绝措辞 / 证据块 / 诊断包（AC-6 兜底判据在 en 下不得失效）──')
const hitEn = refusalHit('I reviewed the request, and I cannot complete it: the authorization model is unclear.')
ok(hitEn !== null, 'en 拒绝措辞命中（I cannot）')
expect(hitEn ? hitEn.phrase : '', 'I cannot', '命中短语「I cannot」')
ok(refusalHit("I can't proceed without the permission model.") !== null, "en 缩写命中（I can't）")
ok(refusalHit('The sandbox denies child process pipes, so I am not able to execute the suite.') !== null, 'en 「not able to」命中')

// en 兜底未被削弱：无证据块 + 拒绝措辞 = 未交付
const bareEn = 'I cannot finish this task: the sandbox denies the permissions this change requires, so I am stopping here instead of guessing.' + 'y'.repeat(80)
const bareEnVerdict = judgeDeliverable('dev', bareEn)
ok(!bareEnVerdict.ok && bareEnVerdict.reason === 'refusal', 'en 无证据块 + 拒绝措辞 → 未交付 reason=refusal')

// en 证据块豁免同样生效（如实汇报环境限制不是拒绝）
const envLimitEn = [
  'T5 implemented; only src/query.mjs changed.',
  'Note: this sandbox forbids child-process pipes, so I am not able to run tests/run.mjs (7 cases) here; it needs a rerun in an unrestricted shell.',
  '',
  '[Verification evidence]',
  '- cmd: node test/verify-query.mjs → exit 0, 12/12 passed',
  '',
  '<!-- state -->{"phase":"dev","summary":"T5 done"}<!-- /state -->',
].join('\n')
const envEnVerdict = judgeDeliverable('dev', envLimitEn)
ok(envEnVerdict.ok && envEnVerdict.reason === 'ok', 'en 如实汇报环境限制 + 证据块 → 判交付（豁免路径同 zh）')
ok(envEnVerdict.refusal !== null, 'en 命中措辞仍回传留痕（diagnostic only）')

const diagEn = buildRetryDiagnostic(2, {
  outcome: 'insubstantial',
  summary: 'output failed substance validation: no verification evidence block and a refusal phrase was hit',
  output: 'Previous attempt body'.repeat(80),
}, 'en')
ok(!/[\u4e00-\u9fff]/.test(diagEn), 'en 诊断包无 CJK（语言跟随 run 快照）')
ok(diagEn.includes('attempt 2') && diagEn.includes('Failure class: insubstantial'), 'en 诊断包头部与失败分类为英文')
ok(!diagEn.includes('diag.'), 'en 诊断包无未命中词典键字面量泄漏')
ok(diagEn.includes('[/Retry diagnostic end]') && diagEn.endsWith('[/Retry diagnostic end]'), 'en 诊断包闭合标记')
ok(diagEn.length < 2000, 'en 诊断包产出尾部同样截断（块长受控）')
ok(buildRetryDiagnostic(3, { outcome: 'stalled', output: '', guardReason: 'spin' }, 'en').includes('Guard abort reason: spin'), 'en 护栏原因入块')
ok(!buildRetryDiagnostic(3, { outcome: 'stalled', output: '' }, 'en').includes('End of the previous output'), 'en 无产出时不带产出尾部段')

console.log('── 环境不可用检测（工具持续同一错误失败；2026-09-23 probe-v4 实锤）──')
// 形状复刻：宿主 tool/result 的 message 带**结构化 `isError`** + content[0].text（probe-v4 架构师会话逐字）。
const failResult = { message: { role: 'tool', toolCallId: 'call_1', isError: true, content: [{ type: 'text', text: 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\\tmp\\probe-v4)' }] } }
const okResult = { message: { role: 'tool', toolCallId: 'call_2', isError: false, content: [{ type: 'text', text: 'ok' }] } }
ok(isToolErrorResult(failResult), 'isError=true → 判失败（结构化字段，不猜文本）')
ok(!isToolErrorResult(okResult), 'isError=false → 不判失败（哪怕文本里有别的输错）')
ok(isToolErrorResult({ message: { content: [{ type: 'text', text: 'Error: boom' }] } }), '缺 isError 字段（老宿主/裁剪事件）→ 按行首 Error 前缀兜底')
ok(!isToolErrorResult({ message: { content: [{ type: 'text', text: 'no error here' }] } }), '句中 error 不算失败（宁严勿松）')
ok(!isToolErrorResult(null) && !isToolErrorResult({}) && !isToolErrorResult({ message: {} }), 'null/空/无 message → 不判失败且不抛')
expect(toolResultText(failResult).startsWith('Error: SetNamedSecurityInfoW'), true, 'toolResultText 拼接 content 的 text 块')
expect(toolResultText(null), '', 'toolResultText(null) → 空串（不抛）')
// 指纹：同一工具 + 同一错误 = 同一信号；工具不同或错误不同 = 不同信号（这是"环境坏了"而非"模型波动"的判据）
const sigA = toolFailureSignature('pwsh', 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\\tmp\\probe-v4)')
const sigB = toolFailureSignature('pwsh', 'Error:   SetNamedSecurityInfoW  failed (Win32 5): grantWrite(E:\\tmp\\probe-v4)')
const sigC = toolFailureSignature('read', 'Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(E:\\tmp\\probe-v4)')
expect(sigA, sigB, '同工具同错误（仅空白差异）→ 同一指纹')
ok(sigA !== sigC, '工具不同 → 指纹不同')
ok(toolFailureSignature('pwsh', 'x'.repeat(500)).length < 200, '指纹截断（错误文本取前 160 字符，日志不爆）')
expect(toolFailureSignature(null, null), 'tool::', '缺工具名/错误 → 不抛（降级为 tool::）')
// 阈值真值表（纯函数，动作可测）
expect(toolFailureAction(1, 3, 5), 'none', '1 次 → none（继续观察）')
expect(toolFailureAction(2, 3, 5), 'none', '2 次 → none')
expect(toolFailureAction(3, 3, 5), 'warn', '3 次（WARN 阈值）→ warn（注入提醒，请模型停手）')
expect(toolFailureAction(4, 3, 5), 'warn', '4 次 → warn')
expect(toolFailureAction(5, 3, 5), 'abort', '5 次（ABORT 阈值）→ abort（dispose，outcome=env-unavailable）')
expect(toolFailureAction(99, 3, 5), 'abort', '远超阈值仍 abort')
expect(toolFailureAction(undefined, 3, 5), 'none', '未计数 → none（不抛）')
// 生产阈值（constants 的 GUARD_TOOL_FAIL_WARN/ABORT = 2/3；2026-09-23 按实机校准：模型第 2 次就放弃 shell）
expect(toolFailureAction(1, 2, 3), 'none', '生产阈值：1 次 → none')
expect(toolFailureAction(2, 2, 3), 'warn', '生产阈值：2 次 → warn（提醒要早于模型放弃）')
expect(toolFailureAction(3, 2, 3), 'abort', '生产阈值：3 次 → abort（赶在它绕道成规模之前）')

console.log(failed === 0 ? '\n✅ diagnostic 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)