/**
 * dsh-plugin-teamflow — 验证证据块（dev/qaFix 输出契约）提取测试。
 * extractVerificationEvidence 从回复中提取 [Verification evidence] 块（审计存证用）。
 */
import { extractVerificationEvidence, assessQaRuntimeEvidence } from '../host/util.ts'

let failed = 0
function expect(actual, expected, label) {
  const ok = actual === expected
  if (ok) { console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`) }
}
function expectTruthy(actual, label) {
  if (actual) { console.log(`  ✓ ${label}`) }
  else { failed++; console.log(`  ✗ ${label}`) }
}

console.log('── 验证证据块提取（extractVerificationEvidence）──')
expect(extractVerificationEvidence('实现完成。\n[Verification evidence]\n- cmd: pnpm run typecheck → exit 0, 0 errors\n- cmd: pnpm test → exit 0, 12/12 passed\n'), '- cmd: pnpm run typecheck → exit 0, 0 errors\n- cmd: pnpm test → exit 0, 12/12 passed', '正常证据块整体提取')
expect(extractVerificationEvidence('[Verification evidence]\n- cmd: pnpm run typecheck → exit 0, 0 errors\n<!-- state -->{"phase":"dev"}'), '- cmd: pnpm run typecheck → exit 0, 0 errors', '证据块在 state 块前截断（不吞 state 块）')
expectTruthy(extractVerificationEvidence('修复完成。\n[Verification evidence]\n- cmd: pnpm test → exit 1, 1 failed (test/a.test.js:42)', ), '失败行引用（exit 1 + 失败行号）')
expect(extractVerificationEvidence('[Verification evidence]\n- N/A: 纯配置改动，无测试可跑'), '- N/A: 纯配置改动，无测试可跑', '显式 N/A（无测试可跑的任务合法分支）')
expect(extractVerificationEvidence('实现完成，验证通过。'), null, '无证据块 → null（契约未兑现，host 记 warn）')
expect(extractVerificationEvidence(''), null, '空文本 → null')
expect(extractVerificationEvidence(null), null, 'null → null')
expect(extractVerificationEvidence('[Verification evidence]\n  \n<!-- state -->{"phase":"dev"}'), null, '空块（无内容）→ null')

console.log('\n── QA 运行证据判据（assessQaRuntimeEvidence，2026-09-28 warn-only 观察期）──')
// 判据：交付含可执行入口时，QA 报告须有「命令 + 结果」证据。刻意不判形态（网站/游戏/CLI），
// 只看「有没有可执行入口文件」这个二值事实 —— 否则会滑向按形态硬编码。
// 下面两份是**真实报告样本**（B/A 两组 A/B 实测），不是编的：
const FILES_APP = ['index.html', 'js/main.js', 'js/game.js', 'css/style.css']
const FILES_DOC = ['README.md', '.gitignore']
// B 组（deepseek-flash）实拍：9 脚本 + 逐条退出码
const B_REPORT = [
  '# QA 报告（节选）',
  '结论：接受验收 —— 回归契约 9 个脚本全绿（逐字通过数见 §2）；新增 24 项探针全绿',
  '| 检查器 | 退出码 | 通过数 / 结果 |',
  '| check-syntax.mjs | 0 | 10/10 RESULT: ALL_CHECKS_PASSED |',
  '| D1 按钮焦点吞掉方向键 | node check-qa-dom.mjs --only D1 | exit 0，[PASS] D1 |',
  '降级路径：DOM 级 E2E（node:vm + Canvas 桩）+ 真实 setInterval 事件循环',
].join('\n')
// A2 组（mercury）实拍：只有表头 + 全推人工补测
const A2_REPORT = [
  '# QA 报告（节选）',
  '| 检查项 | 结果 | 命令/证据 |',
  '|---|---|---|',
  '## 人工补测清单',
  '| 测试项 | 方法 | 工具 | 原因 |',
  '| 游戏可视化渲染 | 浏览器打开 index.html 观察蛇/食物绘制 | 浏览器 | 环境限制，非交付缺陷 |',
  '| 键盘控制响应 | 使用方向键控制蛇移动 | 浏览器 | 环境限制，非交付缺陷 |',
  '所有架构验收形态验证通过。未发现功能性缺陷。需人工补测项目均为浏览器交互类（环境限制），不影响交付质量判断。',
].join('\n')

expect(assessQaRuntimeEvidence(B_REPORT, FILES_APP).verdict, 'ok', 'B 组真实样本 → ok（9 脚本 + exit 0，不误伤）')
expect(assessQaRuntimeEvidence(A2_REPORT, FILES_APP).verdict, 'missing', 'A2 真实样本（全推人工补测）→ missing（抓得住）')
expect(assessQaRuntimeEvidence(A2_REPORT, FILES_APP).hasRunnableEntry, true, '可执行入口识别（.js/.html）')
expect(assessQaRuntimeEvidence(A2_REPORT, FILES_APP).hasCommand, false, 'A2 样本无命令证据')
expect(assessQaRuntimeEvidence(A2_REPORT, FILES_DOC).verdict, 'skip', '纯文档交付（无可执行入口）→ skip（豁免）')
expect(assessQaRuntimeEvidence('因环境限制无法运行浏览器测试', FILES_APP).verdict, 'missing', '「环境限制」不构成豁免（用桩仍可验，B 组即证）——防借此推脱')
expect(assessQaRuntimeEvidence('无法自动验证：N/A（纯静态资源，无可执行路径）', FILES_APP).verdict, 'na', '显式 N/A 声明 → na（合法豁免通道）')
expect(assessQaRuntimeEvidence('跑了 node check.mjs 但没记结果', FILES_APP).verdict, 'missing', '有命令无结果 → missing（证据不完整）')
expect(assessQaRuntimeEvidence('', FILES_APP).verdict, 'missing', '报告为空 → missing')
expect(assessQaRuntimeEvidence(B_REPORT, []).verdict, 'skip', '无可执行入口的空清单 → skip')

console.log(failed === 0 ? '\n✅ evidence 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)