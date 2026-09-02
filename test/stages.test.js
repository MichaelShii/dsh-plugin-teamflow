/**
 * dsh-plugin-teamflow — 档位→阶段集（resolveStages）行为测试（ADR-0004 差异执行）。
 * 纯函数测试：直接 import host/constants.ts（零依赖），验证五档阶段集展开逻辑。
 */
import { resolveStages, STAGE_POLICY } from '../host/constants.ts'

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

console.log(failed === 0 ? '\n✅ stages 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
