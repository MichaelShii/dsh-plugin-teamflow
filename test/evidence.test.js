/**
 * dsh-plugin-teamflow — 验证证据块（dev/qaFix 输出契约）提取测试。
 * extractVerificationEvidence 从回复中提取 [Verification evidence] 块（审计存证用）。
 */
import { extractVerificationEvidence } from '../host/util.ts'

let passed = 0, failed = 0
function expect(actual, expected, label) {
  const ok = actual === expected
  if (ok) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`) }
}
function expectTruthy(actual, label) {
  if (actual) { passed++; console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

console.log('── 验证证据块提取（extractVerificationEvidence）──')
expect(extractVerificationEvidence(`实现完成。\n[Verification evidence]\n- cmd: pnpm run typecheck → exit 0, 0 errors\n- cmd: pnpm test → exit 0, 12/12 passed\n`), `- cmd: pnpm run typecheck → exit 0, 0 errors\n- cmd: pnpm test → exit 0, 12/12 passed`, '正常证据块整体提取')
expect(extractVerificationEvidence(`[Verification evidence]\n- cmd: pnpm run typecheck → exit 0, 0 errors\n<!-- state -->{"phase":"dev"}`), `- cmd: pnpm run typecheck → exit 0, 0 errors`, '证据块在 state 块前截断（不吞 state 块）')
expectTruthy(extractVerificationEvidence(`修复完成。\n[Verification evidence]\n- cmd: pnpm test → exit 1, 1 failed (test/a.test.js:42)`, ), '失败行引用（exit 1 + 失败行号）')
expect(extractVerificationEvidence(`[Verification evidence]\n- N/A: 纯配置改动，无测试可跑`), `- N/A: 纯配置改动，无测试可跑`, '显式 N/A（无测试可跑的任务合法分支）')
expect(extractVerificationEvidence('实现完成，验证通过。'), null, '无证据块 → null（契约未兑现，host 记 warn）')
expect(extractVerificationEvidence(''), null, '空文本 → null')
expect(extractVerificationEvidence(null), null, 'null → null')
expect(extractVerificationEvidence('[Verification evidence]\n  \n<!-- state -->{"phase":"dev"}'), null, '空块（无内容）→ null')

console.log(failed === 0 ? '\n✅ evidence 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)