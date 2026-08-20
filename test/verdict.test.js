/**
 * dsh-plugin-teamflow — 验收结论解析（parseAcceptanceVerdict）回归测试。
 * 背景（历史 bug tf-msytlok5）：验收报告 ✅ 通过，但记忆回写段「SUMMARY.md 结构无需改动」
 * 被旧正则「无需改动」子串命中 → 误判 reject → 整条流水线置 failed。
 * 修复原则：只以显式「验收结论 / 整体结论」行为准，正文散文不做朴素子串匹配。
 */
import { parseAcceptanceVerdict, extractBlueprint } from '../host/util.ts'

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

console.log('── M3 架构门禁：验收看架构，不只 verify 全绿 ──')
expect(parseAcceptanceVerdict('## 验收结论：⚠️ 有条件通过\n功能 AC 全绿，但检测到重复实现：game 与 audio 各自维护 safeStorage 适配器，应抽独立 storage 模块。架构返工项：合并重复封装。'), 'rework', '内有「重复实现…架构返工」→ rework（M3 架构打回）')
expect(parseAcceptanceVerdict('## 验收结论：⚠️ 有条件通过\n偏离蓝图：未按架构蓝图拆独立模块，该抽象未抽象。'), 'rework', '「偏离蓝图+该抽象未抽象」→ rework（M3 架构打回）')
expect(parseAcceptanceVerdict('## 验收结论：✅ 通过\n已按架构蓝图实现，无重复、无偏离，模块边界清晰，架构一致性良好。'), 'accepted', '通过 + 架构一致 → accepted（架构词不误杀正常通过）')
expect(parseAcceptanceVerdict('## 验收结论：✅ 通过\n无 P0/P1/P2 缺陷。'), 'accepted', '纯功能通过 → accepted（不受架构词影响）')

console.log('── M1 架构蓝图提取（extractBlueprint）──')
const blueprinted = `# 技术方案
<!-- blueprint -->{"summary":"应抽独立 storage 封装","modules":{"/storage.js":{"responsibility":"持久化封装","why":"消除 game/audio 两套适配器重复"}},"duplications":["game.safeStorage 与 audio.resolveStorage 重复"],"tasks":[{"title":"拆 storage 模块","files":["/storage.js"],"spec":"独立 UMD 存储层"}]}<!-- /blueprint -->`
const bd = extractBlueprint(blueprinted)
expect(bd !== null, true, '合法蓝图 JSON 块可提取')
expect(bd ? bd.summary : '', '应抽独立 storage 封装', '提取 summary')
expect(bd && Array.isArray(bd.tasks) && bd.tasks.length === 1, true, '提取 tasks')
expect(bd && Object.keys(bd.modules || {}).length === 1, true, '提取 modules')
expect(extractBlueprint('没有蓝图块'), null, '无蓝图块 → null')
expect(extractBlueprint('<!-- blueprint -->{bad json}<!-- /blueprint -->'), null, '非法 JSON → null')

console.log(failed === 0 ? '\n✅ verdict 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
