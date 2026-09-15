/**
 * dsh-plugin-teamflow — 档位→阶段集（resolveStages）行为测试（ADR-0004 差异执行）。
 * 纯函数测试：直接 import host/constants.ts（零依赖），验证五档阶段集展开逻辑。
 */
import { resolveStages, STAGE_POLICY } from '../host/constants.ts'
import { suggestMode } from '../host/core/triage.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eq = (actual, expected, msg) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg}（${actual.join('→') || '(空)'}）`)

console.log('── 1) 阶段集策略表结构 ──')
ok(['full', 'medium', 'lite', 'tech', 'patch'].every((m) => Array.isArray(STAGE_POLICY[m]) && STAGE_POLICY[m].length > 0), '五档都有定义')

console.log('── 2) full：完整 7 段，design/scaffold 按条件 ──')
eq(resolveStages('full'), ['prd', 'tech', 'dev', 'qa', 'acceptance'], 'full 无 needDesign/needScaffold → 基础 5 段')
eq(resolveStages('full', { needDesign: true }), ['prd', 'design', 'tech', 'dev', 'qa', 'acceptance'], 'full + needDesign → 含 design')
eq(resolveStages('full', { needScaffold: true }), ['prd', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'full + needScaffold → 含 scaffold')
eq(resolveStages('full', { needDesign: true, needScaffold: true }), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'full 全开 → 完整 7 段')

console.log('── 3) medium：design/scaffold 按显式 flag ──')
eq(resolveStages('medium'), ['prd', 'tech', 'dev', 'qa', 'acceptance'], 'medium 默认（无显式 flag）→ 基础 5 段')
eq(resolveStages('medium', { needScaffold: true }), ['prd', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'medium + needScaffold → 含 scaffold（显式请求不被吞）')
eq(resolveStages('medium', { needDesign: true }), ['prd', 'design', 'tech', 'dev', 'qa', 'acceptance'], 'medium + needDesign → 含 design')
eq(resolveStages('medium', { needDesign: true, needScaffold: true }), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'medium 全开 → 含 design+scaffold')

console.log('── 3b) lite：轻量 + 显式 flag 也生效 ──')
eq(resolveStages('lite'), ['prd', 'tech', 'dev', 'qa', 'acceptance'], 'lite 默认无 design/scaffold')
eq(resolveStages('lite', { needDesign: true }), ['prd', 'design', 'tech', 'dev', 'qa', 'acceptance'], 'lite + needDesign → 保留设计阶段（回归核心）')
eq(resolveStages('lite', { needScaffold: true }), ['prd', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'lite + needScaffold → 保留脚手架（显式请求不被吞）')

console.log('── 5) tech：技术变更单路径（显式 flag 仍生效）──')
eq(resolveStages('tech'), ['prd', 'tech', 'dev', 'qa', 'acceptance'], 'tech 默认 5 段')
eq(resolveStages('tech', { needDesign: true, needScaffold: true }), ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'], 'tech + 显式 design/scaffold → 含入（不缺省导出的固定排除）')

console.log('── 6) patch：单 agent 直改（无 tech/QA/验收），但显式 flag 不吞 ──')
eq(resolveStages('patch'), ['prd', 'dev'], 'patch 默认仅确认单 + 直改（兑现「单 agent 直改+自测即交付」）')
eq(resolveStages('patch', { needDesign: true, needScaffold: true }), ['prd', 'design', 'scaffold', 'dev'], 'patch + 显式 design/scaffold → 含入，但始终无 tech/QA/验收')

console.log('── 7) 档位边界 ──')
eq(resolveStages('bogus'), ['prd', 'tech', 'dev', 'qa', 'acceptance'], '未知档回退 full 默认')
eq(resolveStages(undefined), ['prd', 'tech', 'dev', 'qa', 'acceptance'], '缺省 mode 回退 full 默认')

console.log('── 8) 分诊词表双语（AC-7：只增不改，英文样本与中文等价档位）──')
// 英文架构需求 → 强升 medium（词表新增项命中）
for (const req of ['refactor the storage layer', 'optimize the database queries', 'migrate the schema', 'add a cross-module abstraction', 'split this into a standalone module']) {
  eq([suggestMode(req, {}, 'en').mode], ['medium'], `en 架构护栏升 medium：${req}`)
}
// 英文 UI 需求 → 不低于 lite
for (const req of ['add a page for settings', 'change the button style', 'make the layout responsive', 'add a visual component']) {
  eq([suggestMode(req, {}, 'en').mode], ['lite'], `en UI 护栏不低于 lite：${req}`)
}
// 无信号 → full；needDesign → medium；理由文案随语言
eq([suggestMode('do the thing', {}, 'en').mode], ['full'], 'en 无护栏信号 → full（宁重勿漏）')
eq([suggestMode('do the thing', { needDesign: true }, 'en').mode], ['medium'], 'en needDesign=true → 强升 medium')
ok(/Architecture guardrail/.test(suggestMode('refactor the storage layer', {}, 'en').rationale.join(' ')), 'en 理由文案为英文（AC-3⑥）')
ok(/架构护栏/.test(suggestMode('重构存储层', {}, 'zh').rationale.join(' ')), 'zh 理由文案逐字不变')

console.log('── 9) 中文样本档位逐一不变（AC-7/AC-9：只增词不改词）──')
const ZH_CASES = [
  ['加个按钮', 'lite'],
  ['重构存储层', 'medium'],
  ['实现一个新的数据持久化模块', 'medium'],
  ['修个错别字', 'full'],
  ['做个页面', 'lite'],
]
for (const [req, mode] of ZH_CASES) eq([suggestMode(req, {}, 'zh').mode], [mode], `zh 档位不变：${req}`)
// QA-4 回归：中文句里**夹带英文技术泛词**时不得被英文档位词表拉走档位（实锤：cache/plugin/module）
// 泛技术名词（module/api/plugin/cache/queue）已移出护栏 → 中文需求档位与 HEAD 一致。
for (const [req, mode] of [
  ['用 cache 优化加载', 'full'],
  ['plugin 系统拆分 module', 'full'],
  ['给 backlog 加一个 API 接口', 'full'],
  ['导出模块的依赖关系图', 'full'],
  // R2-3：新增英文项（ARCH_SIGNALS_EN/UI_SIGNALS_EN）只对无 CJK 的英文需求生效 → 中文句命中不了
  ['用 dependency injection 解耦', 'full'],
  ['调整 schema 定义', 'full'],
  ['migrate 到新结构', 'full'],
  ['refactor 一下', 'full'],
  ['加个 form 校验', 'full'],
  ['把 screen 适配一下', 'full'],
]) eq([suggestMode(req, {}, 'zh').mode], [mode], `QA-4 中文句含英文技术词档位不漂移：${req}`)
// 强语义英文架构词仍必须命中（护栏未被削弱，AC-7）
for (const req of ['refactor the storage layer', 'migrate the schema', 'add a cross-module abstraction', 'split this into a standalone module', 'turn the parser into a separate module']) {
  eq([suggestMode(req, {}, 'en').mode], ['medium'], `AC-7 en 架构护栏仍升 medium：${req}`)
}
eq([suggestMode('加个按钮', {}, 'zh').rationale.join(' ')], [suggestMode('加个按钮', {}).rationale.join(' ')], 'zh 缺省 locale（不传）与显式 zh 结果一致（存量调用点零改动）')

console.log(failed === 0 ? '\n✅ stages 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
