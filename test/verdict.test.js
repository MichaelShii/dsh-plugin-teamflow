/**
 * dsh-plugin-teamflow — 验收结论解析（parseAcceptanceVerdict）回归测试。
 * 背景（历史 bug tf-msytlok5）：验收报告 ✅ 通过，但记忆回写段「SUMMARY.md 结构无需改动」
 * 被旧正则「无需改动」子串命中 → 误判 reject → 整条流水线置 failed。
 * 修复原则：只以显式「验收结论 / 整体结论」行为准，正文散文不做朴素子串匹配。
 */
import { parseAcceptanceVerdict } from '../host/util.ts'

let failed = 0
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${actual}, want ${expected}`); failed++ }
}

console.log('── 回归：验收通过却误判 reject（历史 bug）──')
const buggy = `# 产品验收报告 — Tetris v2.4
## 验收结论：✅ 通过
逐条核对表全绿，无 P0/P1/P2 缺陷。
## 记忆回写
已更新 memory.md：OBS-12-1 关闭确认、OBS-12-2 新增；SUMMARY.md 结构无需改动
<!-- state -->{"phase":"acceptance"}<!-- /state -->`
expect(parseAcceptanceVerdict(buggy), 'accepted', '正文「结构无需改动」不触发 reject（回归核心）')

const negated = `## 验收结论：通过
不存在需求与实际不符、需求站不住的情形，本轮为有效修复，全部验证通过。`
expect(parseAcceptanceVerdict(negated), 'accepted', '正文否定式「需求与实际不符」不触发 reject')

const passWithChg = `## 验收结论：✅ 通过（其他模块代码无需改动，均可继续）`
expect(parseAcceptanceVerdict(passWithChg), 'accepted', '结论行含「通过」+「无需改动」→ accepted（通过词优先）')

const noConclusion = `主体内容未按格式写结论行。需求无效这类词出现在正文讨论里，不应判拒绝。`
expect(parseAcceptanceVerdict(noConclusion), 'accepted', '无结论行 + 正文出现 reject 词 → 保守 accepted（不误杀）')

console.log('── 真 reject / rework 仍能识别 ──')
expect(parseAcceptanceVerdict('## 验收结论：📝 需求不适用\n开发结果已满足现状，无有效变更。'), 'reject', '📝 需求不适用 → reject')
expect(parseAcceptanceVerdict('## 验收结论：需求与实际不符\n建议取消改动或调整需求。'), 'reject', '结论行「需求与实际不符」无通过词 → reject')
expect(parseAcceptanceVerdict('## 整体结论：需求无效，无需改动。'), 'reject', '结论行「需求无效，无需改动」→ reject')
expect(parseAcceptanceVerdict('## 验收结论：❌ 不通过\n存在 P0 缺陷。'), 'rework', '结论行 ❌ 不通过 → rework')
expect(parseAcceptanceVerdict('## 验收结论：需返工\n部分验收项未达标。'), 'rework', '结论行 需返工 → rework')

console.log(failed === 0 ? '\n✅ verdict 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
