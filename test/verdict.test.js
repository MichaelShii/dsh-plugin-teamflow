/**
 * dsh-plugin-teamflow — 验收结论解析（parseAcceptanceVerdict）回归测试。
 * 背景（历史 bug tf-msytlok5）：验收报告 ✅ 通过，但记忆回写段「SUMMARY.md 结构无需改动」
 * 被旧正则「无需改动」子串命中 → 误判 reject → 整条流水线置 failed。
 * 修复原则：只以显式「验收结论 / 整体结论」行为准，正文散文不做朴素子串匹配。
 */
import { parseAcceptanceVerdict, extractBlueprint, defectFingerprint, qaRoundEntry } from '../host/util.ts'
import { parseDefects, parseDefectRows } from '../host/core/backlog.ts'

let failed = 0
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${actual}, want ${expected}`); failed++ }
}
const eqJson = (actual, expected, msg) => expect(JSON.stringify(actual), JSON.stringify(expected), msg)

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
expect(parseAcceptanceVerdict(noConclusion), 'needs-human', '无结论行 → needs-human（不再默认 accepted——防漏报，需人工确认）')

console.log('── 漏报护栏（2026-09-03）：模型写 ❌ 但漏写「验收结论：」前缀 → 不得判 accepted ──')
expect(parseAcceptanceVerdict('逐条核对后，❌ 不通过，存在 P0 缺陷。'), 'needs-human', '正文写 ❌ 但无结论行 → needs-human（旧实现漏报为 accepted）')
expect(parseAcceptanceVerdict('## 验收结论：❌ 不通过\n存在 P0 缺陷。'), 'rework', '结论行 ❌ 不通过（有前缀）→ rework（正常路径不受影响）')
expect(parseAcceptanceVerdict('## 验收结论：✅ 通过\n全部 AC 绿。'), 'accepted', '结论行 ✅ 通过 → accepted（正常路径不受影响）')
expect(parseAcceptanceVerdict('逐条核对后 📝 需求不适用，现状已满足。'), 'reject', '无结论行但全文「📝 需求不适用」→ reject（强结论词优先于 needs-human）')

console.log('── 空结论行 / 裸否定词（2026-09-03）：四档词校验只覆盖 reject 分支的漏报变体 ──')
expect(parseAcceptanceVerdict('## 验收结论：\n全部 AC 绿。'), 'needs-human', '空结论行（前缀残留非空，旧实现漏回 accepted）→ needs-human')
expect(parseAcceptanceVerdict('## 验收结论：（待定）\n人工确认后再定。'), 'needs-human', '结论行无四档词（待定）→ needs-human')
expect(parseAcceptanceVerdict('## 验收结论：不通过\n存在 P0 缺陷。'), 'rework', '裸「不通过」（无 ❌ 前缀，旧实现被「通过」子串吞成 accepted）→ rework')
expect(parseAcceptanceVerdict('## 验收结论：未通过\n存在 P1 缺陷。'), 'rework', '结论行「未通过」→ rework（正常路径）')
expect(parseAcceptanceVerdict('## 验收结论：✅ 通过（未发现不通过项）'), 'accepted', '✅ 通过 + 双重否定（未发现不通过项）→ accepted（否定保护不误杀）')
expect(parseAcceptanceVerdict('## 验收结论：✅ 通过\n全部 AC 绿。'), 'accepted', '结论行 ✅ 通过 → accepted（正常路径不受影响）')

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

console.log('── M3 回归（tf-mt1pulkw）：架构「PASS/无返工」不得误杀（否定式保护）──')
expect(parseAcceptanceVerdict('## 验收结论：⚠️ 有条件通过\n架构一致性核验（M3 质量门禁）— PASS，无返工项，无该抽象未抽象，无架构打回项，非漂移。'), 'accepted', '「M3 PASS，无返工/非漂移/无该抽象未抽象/无架构打回项」→ accepted（否定式不误判 rework，回归核心）')
expect(parseAcceptanceVerdict('## 验收结论：⚠️ 有条件通过\n但检测到重复实现：两套安全存储适配器；偏离蓝图、该拆未拆，需架构返工。'), 'rework', '「存在重复实现/偏离蓝图/需架构返工」→ rework（真打回仍识别）')

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

console.log('── 回归：蓝图「顶层值提前闭合」抢救（实锤 tf-mt85o5jj：duplications 后多一个 }，tasks 被判为块外内容 → 静默回退整体开发）──')
const broken = `<!-- blueprint -->{"summary":"踢墙开关","modules":{"/game.js":{"responsibility":"引擎","why":"状态闭环"}},"duplications":["与 ghost/BGM 开关模式不同，需 README 标注"]},"tasks":[{"title":"T1: game.js 引擎踢墙开关","files":["/game.js"],"spec":"偏移表+开关"},{"title":"T2: ui.js 面板开关","files":["/ui.js"],"spec":"开关控件"}]}<!-- /blueprint -->`
const bdb = extractBlueprint(broken)
expect(bdb !== null, true, '提前闭合的畸形蓝图可被抢救（不再回退 null）')
expect((bdb && bdb.tasks ? bdb.tasks.length : -1), 2, '抢救后 tasks 不丢失（并行拆解保住）')
expect((bdb && bdb.summary) || '', '踢墙开关', '抢救后 summary 完整')
expect(extractBlueprint('<!-- blueprint -->完全不是 JSON<!-- /blueprint -->'), null, '彻底非 JSON 仍返回 null')

console.log('── en 结论行（AC-6 只增不改：英文新增识别，中文用例逐字不动）──')
expect(parseAcceptanceVerdict('## Acceptance verdict: ✅ Pass\nAll ACs verified green.'), 'accepted', 'en ✅ Pass → accepted')
expect(parseAcceptanceVerdict('## Acceptance verdict: ⚠️ Conditional pass (rework items listed)\nTwo P3 observations remain open.'), 'accepted', 'en ⚠️ Conditional pass（正文含裸 rework）→ accepted（禁止把裸 rework 当否定词，防误判打回）')
expect(parseAcceptanceVerdict('## Acceptance verdict: ❌ Fail\nBUG-1 (P1) is still open.'), 'rework', 'en ❌ Fail → rework')
expect(parseAcceptanceVerdict('## Acceptance verdict: 📝 Not applicable\nThe shipped product already has this behavior.'), 'reject', 'en 📝 Not applicable → reject（ADR-0005 的 en 等价物）')
expect(parseAcceptanceVerdict('## Overall verdict: Not applicable\nRequirement does not match the shipped product.'), 'reject', 'en Overall verdict + not applicable（无 emoji）→ reject')
expect(parseAcceptanceVerdict('## Acceptance verdict: Pass\nAll checks green.'), 'accepted', 'en 裸 Pass（无 emoji）→ accepted（四档兜底）')
expect(parseAcceptanceVerdict('## Acceptance verdict: Fail\nRegression found in audio.js.'), 'rework', 'en 裸 Fail（无 emoji）→ rework（四档兜底）')
expect(parseAcceptanceVerdict('## Acceptance verdict: ❌ Not passed\nTwo checks failed.'), 'rework', 'en ❌ Not passed → rework（「passed」子串不得翻成 accepted）')
expect(parseAcceptanceVerdict('## Acceptance verdict: ✅ Pass (no failed checks)'), 'accepted', 'en ✅ Pass + 否定保护（no failed）→ accepted')
expect(parseAcceptanceVerdict('Verification completed, but the report carries no verdict line.'), 'needs-human', 'en 无结论行 → needs-human（漏报护栏对 en 同样生效）')

console.log('── extractBlueprint locale（尾参可选：缺省 zh 逐字不变）──')
const bdEn = extractBlueprint(blueprinted, 'en')
const bdEnRender = bdEn ? bdEn.render : ''
const bdRender = bd ? bd.render : ''
expect(bdEnRender.includes('Architecture judgment:') && bdEnRender.includes('Decomposed tasks:'), true, 'en render 用英文小标题（架构判断/拆解任务）')
expect(bdEnRender.includes('架构判断：') || bdEnRender.includes('架构拆解任务：'), false, 'en render 不出现中文包裹标签')
expect(bdRender.includes('架构判断：') && bdRender.includes('【架构蓝图（tech 阶段产出，dev 须在既有架构上实现，勿重建）】'), true, 'zh render 逐字不变（缺省 locale）')
expect(bdRender.includes('Architecture judgment:'), false, 'zh render 不出现英文包裹标签')

console.log('── parseDefects：按表头认表（2026-09-15 停线回归 tf-mu2ioilr-95l4th）──')
// 停线根因：复验对照表（第 2 列 P 级 + 第 3 列结论「已关闭」）被按列位置当成缺陷表，
// 每轮复验重生一个 P2 → 复验必然超限 → 跳过验收。以下第 1 条即该形态的回归门禁。
const reverifyTable = `## 3. round-2 缺陷复验对照

| 编号 | round-2 级 | 复验结论 | 独立证据 |
|---|---|---|---|
| R2-1 en 分支 5 处中文章节名/标签 | P2 | **已关闭** | en 产出 CJK 0 处 |
| R2-2a logSkip('开发') | P3 | 误报 | phaseLabel(en, 开发) = Development |`
eqJson(parseDefects(reverifyTable), [], '复验对照表（无严重级表头）整表跳过 → 0 缺陷（停线回归核心）')

const zhStandard = [
  '| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |',
  '|---|---|---|---|---|---|---|',
  '| BUG-1 | **P1** | persist.js | reload | keep | lost | AC-1 |',
  '| OBS-1 | P3 | ui.js | click | toast | none | AC-3 |',
].join('\n')
eqJson(parseDefects(zhStandard), [{ id: 'BUG-1', severity: 'P1', module: 'persist.js' }], 'zh 标准缺陷表：**P1** 命中、OBS- 观察项跳过')

const enStandard = [
  '| ID | Severity (P0/P1/P2/P3) | Module | Steps | Expected | Actual | Related AC |',
  '|---|---|---|---|---|---|---|',
  '| BUG-2 | P2 | audio.js | mute | silent | beep | AC-2 |',
].join('\n')
eqJson(parseDefects(enStandard), [{ id: 'BUG-2', severity: 'P2', module: 'audio.js' }], 'en 标准缺陷表：en 表头识别 + 列位置由表头决定')

const reordered = [
  '| 编号 | 功能模块 | 严重级(P0/P1/P2/P3) | 备注 |',
  '|---|---|---|---|',
  '| BUG-3 | store.ts | P1 | 列序与 zh 模板不同也须命中 |',
].join('\n')
eqJson(parseDefects(reordered), [{ id: 'BUG-3', severity: 'P1', module: 'store.ts' }], '严重级列不在第 2 位时按表头定位（不再依赖固定列位置）')

const twoTables = `${reverifyTable}\n\n## 7. 缺陷表\n\n${zhStandard}`
eqJson(parseDefects(twoTables), [{ id: 'BUG-1', severity: 'P1', module: 'persist.js' }], '同一报告内对照表 + 缺陷表并存：只登记后者（多表上下文互不污染）')

console.log('── parseDefectRows：富行（缺陷卡详情用；2026-09-15 用户实锤「看不出缺陷是啥」）──')
const richTable = [
  '| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |',
  '|---|---|---|---|---|---|---|',
  '| R3-1 | P3 | 日志/注入面 | en 下跑 withRetry 失败分支 | en run 日志全英文 | 模板硬编码全角冒号 | AC-3 |',
].join('\n')
const rich = parseDefectRows(richTable)
eqJson(rich.map((r) => [r.id, r.severity, r.module, r.reproduce, r.expected, r.actual, r.ac]), [
  ['R3-1', 'P3', '日志/注入面', 'en 下跑 withRetry 失败分支', 'en run 日志全英文', '模板硬编码全角冒号', 'AC-3'],
], '富行取到复现/期望/实际/关联验收项（此前这四列被整列丢弃 → 卡详情空白）')
eqJson(Object.keys(rich[0]), ['id', 'severity', 'module', 'reproduce', 'expected', 'actual', 'ac', 'check', 'criterion', 'columns'], '富行字段集（含 check/criterion 与 columns 原始表头映射）')
eqJson(parseDefects(richTable), [{ id: 'R3-1', severity: 'P3', module: '日志/注入面' }], 'parseDefects 仍是瘦身契约（冻结语料逐字节比对的形状不得变）')
const enRich = parseDefectRows([
  '| ID | Severity (P0/P1/P2/P3) | Module | Steps | Expected | Actual | Related AC |',
  '|---|---|---|---|---|---|---|',
  '| R9-1 | P2 | pipeline | rerun in en | labels normalized | suffix mismatched | AC-9 |',
].join('\n'))
eqJson([enRich[0].reproduce, enRich[0].expected, enRich[0].actual, enRich[0].ac], ['rerun in en', 'labels normalized', 'suffix mismatched', 'AC-9'], 'en 表头同样取到四列（Steps/Expected/Actual/Related AC）')
eqJson([enRich[0].check, enRich[0].criterion], ['', ''], '旧报告（无检测命令/通过判据列）零回归：两字段为空串，不抛不误取')

console.log('── 缺陷行：检测命令 / 通过判据（B 方案 2026-09-15；含转义管道符）──')
const checkTable = [
  '| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |',
  '|---|---|---|---|---|---|---|---|---|',
  '| R2-1 | P2 | prompt 语言面 | 复跑 en 工厂 | en 无中文字面量 | 5 处中文章节名 | AC-5 | `node logs/.../scripts/r3-scan.mjs` | CJK 命中 0 |',
  '| R2-2 | P1 | 解析面 | 跑解析器 | 只出 2 条 | 多出 1 条（`a\\|b` 转义行） | AC-9 | `grep -E "alpha\\|beta" src/` | exit 1 |',
].join('\n')
const checkRows = parseDefectRows(checkTable)
eqJson([checkRows[0].check, checkRows[0].criterion], ['node logs/.../scripts/r3-scan.mjs', 'CJK 命中 0'], 'zh 表头：检测命令/通过判据按表头取到')
eqJson([checkRows[1].check, checkRows[1].criterion], ['grep -E "alpha|beta" src/', 'exit 1'], '单元格内的转义管道符 \\| 还原为字面量（命令里的 `a|b` 不被切开）')
eqJson(checkRows.map((r) => r.id), ['R2-1', 'R2-2'], '转义行不得错列：两条缺陷都按行解析（R3-2 错列实锤的回归门禁）')
eqJson(checkRows[1].actual, '多出 1 条（a|b 转义行）', '转义行其余列同样不错位（cellText 会剥离行内反引号）')
const enCheck = parseDefectRows([
  '| ID | Severity (P0/P1/P2/P3) | Module | Steps | Expected | Actual | Related AC | Check command | Pass criterion |',
  '|---|---|---|---|---|---|---|---|---|',
  '| R9-2 | P2 | prompts | rerun factory | no CJK | 5 sections | AC-5 | node scripts/scan.mjs | 0 hits |',
].join('\n'))
eqJson([enCheck[0].check, enCheck[0].criterion], ['node scripts/scan.mjs', '0 hits'], 'en 表头：Check command / Pass criterion 取到（P0–P2 必填列）')

console.log('── D 埋点：QA 逐轮收敛数据（稳定身份 + 增/减/停滞；2026-09-15）──')
expect(defectFingerprint({ check: '  node  scripts/scan.mjs  ' }), 'cmd:node scripts/scan.mjs', '指纹优先用检测命令（去空白、归一化；机器写给机器看，最稳定）')
expect(defectFingerprint({ module: 'Prompts', actual: '5 处中文章节名' }), 'txt:prompts|5 处中文章节名', '没有检测命令 → 回落 模块+实际行为文本')
expect(defectFingerprint({ id: 'R2-1' }), 'id:r2-1', '两者都缺 → 最后回落 id（最不稳定）')
expect(defectFingerprint({ check: '`grep -E "a|b" src/`' }), 'cmd:grep -e "a|b" src/', '命令里的反引号被剥离（身份比较不受 markdown 表示影响）')
expect(defectFingerprint(null), '', '空输入不抛（防御）')

const d1 = [
  { id: 'QA-1', severity: 'P2', module: 'locale', check: 'node scripts/a.mjs' },
  { id: 'QA-2', severity: 'P1', module: 'prompts', check: 'node scripts/b.mjs' },
  { id: 'QA-3', severity: 'P3', module: 'logging' },
]
const r1 = qaRoundEntry(1, 3, d1, [], 71, 2)
eqJson([r1.round, r1.blocking, r1.p3, r1.outcome, r1.withCheck, r1.qaCalls], [1, 2, 1, 'rework', 2, 71], '第 1 轮：阻断 2 / P3 1 / outcome=rework / 带检测命令 2 / QA 调用数记录')
eqJson([r1.newFps, r1.repeats, r1.resolved], [2, 0, 0], '第 1 轮全部算「新」，无重复无消解')
eqJson(r1.defects.map((d) => d.fp), ['cmd:node scripts/a.mjs', 'cmd:node scripts/b.mjs'], '埋点里存稳定身份（不含 P3 观察项）')

const d2 = [
  { id: 'R2-1', severity: 'P2', module: 'prompts', check: 'node scripts/b.mjs' },
  { id: 'R2-2', severity: 'P2', module: 'tools', check: 'node scripts/c.mjs' },
]
const r2 = qaRoundEntry(2, 7, d2, [r1], 39, 2)
eqJson([r2.blocking, r2.outcome], [2, 'rework'], '第 2 轮：阻断 2 / 仍打回')
eqJson([r2.newFps, r2.repeats, r2.resolved], [1, 1, 1], '与历史轮对比：新 1（c）/ 重复 1（b 原样再现）/ 消解 1（a 已消失）')

const r3 = qaRoundEntry(3, 10, [{ id: 'R3-1', severity: 'P3', module: 'logging' }], [r1, r2], 109, 2)
eqJson([r3.blocking, r3.outcome, r3.resolved], [0, 'pass', 2], '第 3 轮干净：outcome=pass，上一轮 2 条全部消解')
expect(qaRoundEntry(3, 10, [{ id: 'R3-1', severity: 'P1', module: 'x' }], [r1, r2], 109, 2).outcome, 'limit', '超出上限时 outcome=limit（与 pass/rework 区分，供后续判据取数）')

console.log(failed === 0 ? '\n✅ verdict 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
