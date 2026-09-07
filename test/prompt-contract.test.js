/**
 * dsh-plugin-teamflow — Prompt 行为级契约测试（L1 评测层）。
 *
 * 定位：smoke.js 是「源码子串断言」（对 prompts/index.ts 源文本 grep）；本文件更进一步——
 * **直接调用 prompt 工厂（纯函数），断言其产出的真实指令文本**仍携带关键契约锚点。
 * 这样即使工厂内部被重构/移动段落/改写措辞，只要产出契约仍在即通过；锚点丢失即失败并指明
 * 断的是哪条契约（id）、哪一级保障（level）、原本意图（intent）。
 *
 * level 语义（与 prompts 头注释对齐）：
 * - HOST-ENFORCED：host 有真实解析/硬失败后果（验收结论行、QA 单轨、缺陷表 import）
 * - policy：靠模型自律 + guard 观测（warn/轻提醒），措辞必须诚实描述真实机制
 * - structural：纯结构锚（state 块、产物路径、蓝图 JSON 形状），非措辞约束
 *
 * 维护约定：prompt 有意改动导致锚点变化时，必须同步更新本清单条目并评审 intent
 * ——这是评测门禁的本意，不是「测试拖累开发」。
 */
import {
  prdPrompt, designPrompt, scaffoldPrompt, techPrompt, architectPrompt,
  devPrompt, qaPrompt, qaFixPrompt, acceptancePrompt, TRIAGE_PROMPT,
  techChangePrompt, patchConfirmPrompt, VISUAL_POLICY,
} from '../host/prompts/index.ts'

let failed = 0
const fail = (msg) => { console.error(`    ✗ ${msg}`); failed++ }

/** 最小夹具 state（stateSliceFor 只读这些字段；无磁盘副作用）。 */
const ST = {
  version: 1, projectName: 'tetris', updatedAt: null,
  product: { summary: '俄罗斯方块', techStack: 'vanilla-js' },
  modules: { '/game.js': '核心逻辑' }, verifyScripts: ['node test/verify.js'],
  acIndex: { 'AC-1': '最高分持久化' }, stages: { prd: '摘要' }, lastRun: null,
  __runCtx: { runDocs: 'docs/teamflow/20260910-r9-persist', blueprint: '<!-- blueprint -->{"summary":"s"}<!-- /blueprint -->' },
}
const PRD = `# PRD\n基线依赖：无\nAC-1：最高分 localStorage 持久化（reload 后保留）`
const QA_REPORT = `# QA-REPORT\n## 结论：通过\n| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |\n| BUG-1 | **P1** | persist.js | reload | 保留 | 丢失 | AC-1 |`
const DEV_SUMMARY = '实现完成，verify 全绿'
const ROOT = 'products/tetris'
const RUN_ID = 'tf-eval-run'

/** 全部工厂的真实产出（评测语料 = 当前实现文本，勿手工伪造）。 */
const out = {
  prdPrompt: prdPrompt('给游戏加最高分本地持久化', ROOT, RUN_ID, ST),
  designPrompt: designPrompt(PRD, ROOT, RUN_ID, ST),
  scaffoldPrompt: scaffoldPrompt('初始化 Tetris 项目', '无', ROOT, RUN_ID, ST),
  techPrompt: techPrompt(PRD, null, null, [], ROOT, RUN_ID, ST),
  architectPrompt: architectPrompt(PRD, ROOT, RUN_ID, ST),
  devPrompt: devPrompt({ title: 'T1 实现持久化', files: ['/persist.js'], spec: '实现 storage 封装' }, PRD, PRD, ROOT, RUN_ID, ST),
  qaPrompt: qaPrompt(PRD, DEV_SUMMARY, ROOT, RUN_ID, ST, true),
  qaFixPrompt: qaFixPrompt([{ id: 'BUG-1', severity: 'P1', module: 'persist.js' }], QA_REPORT, PRD, PRD, ROOT, RUN_ID, ST),
  acceptancePrompt: acceptancePrompt(PRD, QA_REPORT, DEV_SUMMARY, ROOT, RUN_ID, ST, true),
  techChangePrompt: techChangePrompt('重构持久化为独立模块', ROOT, RUN_ID, ST),
  patchConfirmPrompt: patchConfirmPrompt('修复一处按钮样式', ROOT, RUN_ID, ST),
  triagePrompt: TRIAGE_PROMPT('给游戏加本地持久化', { needDesign: true }, { rationale: ['持久化 → medium'] }),
  visualOn: VISUAL_POLICY(true),
  visualOff: VISUAL_POLICY(false),
}

/** 带 productCtx 的阶段 prompt（triage/visual 条款不共用产品上下文，单独 target）。 */
const STAGE_ALL = [
  'prdPrompt', 'designPrompt', 'scaffoldPrompt', 'techPrompt', 'architectPrompt',
  'devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt', 'techChangePrompt', 'patchConfirmPrompt',
]

/** 断言：targets 为 key 数组（'ALL'=STAGE_ALL）；include 须全命中、exclude 须全不命中。 */
function assertContract({ id, level, intent, targets, include = [], exclude = [] }) {
  const tNames = targets === 'ALL' ? STAGE_ALL : (typeof targets === 'string' ? [targets] : targets)
  let ok = true
  for (const name of tNames) {
    const text = out[name]
    if (text === undefined) { fail(`${id} [${name}] 工厂产出缺失（夹具未构建？）`); ok = false; continue }
    for (const anchor of include) {
      const hit = anchor instanceof RegExp ? anchor.test(text) : text.includes(anchor)
      if (!hit) {
        fail(`${id} [${name}] 缺锚点 ${anchor instanceof RegExp ? anchor : JSON.stringify(anchor)}`)
        ok = false
      }
    }
    for (const anchor of exclude) {
      const hit = anchor instanceof RegExp ? anchor.test(text) : text.includes(anchor)
      if (hit) {
        fail(`${id} [${name}] 含禁用锚点 ${anchor instanceof RegExp ? anchor : JSON.stringify(anchor)}`)
        ok = false
      }
    }
  }
  if (ok) console.log(`  ✓ [${level}] ${id} — ${intent}`)
  else console.error(`  ✗ [${level}] ${id} — ${intent}`)
}

console.log('── L1 prompt 行为级契约（工厂真实产出断言）──')

// ── HOST-ENFORCED：验收结论契约（parseAcceptanceVerdict 只认显式结论行）──
assertContract({
  id: 'ACC-VERDICT-LITERAL', level: 'HOST-ENFORCED', targets: 'acceptancePrompt',
  intent: '回复必须给出四档字面量结论行话术，host 只解析该行',
  include: [/Reply = brief summary only · HOST-ENFORCED/, /verdict line — verbatim/, /验收结论：✅ 通过 ／ ⚠️ 有条件通过 ／ ❌ 不通过 ／ 📝 需求不适用/],
})
assertContract({
  id: 'ACC-LAST-LINE-CONTRACT', level: 'HOST-ENFORCED', targets: 'acceptancePrompt',
  intent: '结论行必须是 ACCEPTANCE.md 最后一行且为字面量四档之一（缺失=契约违例→needs-human 停线）',
  include: [/MUST be the LAST line of the file, verbatim one of: 验收结论：✅ 通过/, /missing it = contract violation/, /missing file = hard failure \(needs-human, pipeline stops\)/, /host parses ONLY this line/],
})
assertContract({
  id: 'ACC-FILE-SINGLE-SOURCE', level: 'HOST-ENFORCED', targets: 'acceptancePrompt',
  intent: 'ACCEPTANCE.md 即交付物（单轨制）：完整报告写文件、回复不得重复正文',
  include: [/Acceptance report · HOST-ENFORCED/, /ACCEPTANCE\.md/, /this file IS the deliverable/, /Do NOT repeat the report body/, /≤10 lines/],
  exclude: [/SUMMARY\.md/],
})
assertContract({
  id: 'ACC-MEMORY-ONLY-CONVENTION', level: 'HOST-ENFORCED', targets: 'acceptancePrompt',
  intent: 'memory 回写仅限约定/待办变化（幂等替换，禁止 changelog 式追加）',
  include: [/Memory write-back · convention changes ONLY/, /same-topic line replace/, /no changelog appending/],
})

// ── HOST-ENFORCED：QA 单轨 + 缺陷表契约（parseDefects import QA-REPORT.md）──
assertContract({
  id: 'QA-REPLY-SUMMARY-ONLY', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: 'QA 回复收敛 ≤12 行摘要 + 报告路径；报告正文不重复（host 只 import 文件）',
  include: [/Reply = brief summary only · HOST-ENFORCED/, /≤12 lines/, /Do NOT repeat the report body/, /missing file = hard failure/, /QA-REPORT\.md/],
})
assertContract({
  id: 'QA-DEFECT-TABLE', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: '缺陷必须用结构化表（host parseDefects 按管道单元格导入）；无缺陷须显式声明',
  include: [/Defect format · HOST-ENFORCED/, /严重级\(P0\/P1\/P2\/P3\)/, /复现步骤/, /关联验收项/, /the table must be in QA-REPORT\.md/, /未发现缺陷/],
})
assertContract({
  id: 'QA-FILE-DELIVERABLE', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: 'QA-REPORT.md 是交付物与唯一事实源',
  include: [/QA-REPORT\.md/, /this file IS the deliverable/],
})
assertContract({
  id: 'QA-MANUAL-LIST', level: 'structural', targets: 'qaPrompt',
  intent: '环境限制项必须进「人工补测清单」而非判失败（QA 对抗探针盲区治理）',
  include: [/人工补测清单/, /环境限制，非交付缺陷/],
})

// ── HOST-ENFORCED：M3 架构质量门禁（QA + 验收）──
assertContract({
  id: 'M3-QA-ARCH-GATE', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: 'QA 必须做架构核验（蓝图遵循/重复实现/该抽未抽），架构发现按 P1 进缺陷表',
  include: [/Architecture verification · mandatory \(M3 quality gate\)/, /duplicated implementations/, /abstraction not extracted/, /severity P1, module =「架构」/],
})
assertContract({
  id: 'M3-ACC-ARCH-GATE', level: 'HOST-ENFORCED', targets: 'acceptancePrompt',
  intent: '验收架构一致性检查：功能绿但架构漂移 → ⚠️/❌，不得以 verify 全绿当无返工证据',
  include: [/Architecture consistency check · mandatory \(M3 quality gate\)/, /⚠️ 有条件通过/, /Never treat "verify all green" as the sole evidence/],
})

// ── policy：TOKEN_HYGIENE / ONCE_DISCIPLINE / 证据块诚实分级（不自称 hard constraint）──
assertContract({
  id: 'TOKEN-HYGIENE-HONEST', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: 'token 纪律标注真实机制（warn+轻提醒从不中断），不得声称 hard constraint',
  include: [/TOKEN HYGIENE · policy/, /warn \+ live reminder only \(never interrupts\)/],
  exclude: [/· hard constraint\]/],
})
assertContract({
  id: 'ONE-SHOT-HONEST', level: 'policy',
  targets: ['prdPrompt', 'designPrompt', 'scaffoldPrompt', 'techPrompt', 'acceptancePrompt', 'techChangePrompt', 'patchConfirmPrompt'],
  intent: '一次成型纪律标注真实后果（cache 重放费），不得声称 hard constraint',
  include: [/ONE-SHOT WRITE · policy/, /cache replay fees/, /No read→edit→read loops/],
  exclude: [/· hard constraint\]/],
})
assertContract({
  id: 'EVIDENCE-BLOCK-DEV', level: 'policy', targets: ['devPrompt', 'qaFixPrompt'],
  intent: 'dev/qaFix 回复必须附 [Verification evidence] 块（命令+退出码+断言计数+失败行/N/A），缺失记 warn',
  include: [/\[Verification evidence\]/, /cmd: <exact command> → exit <code>/, /<passed>\/<failed> asserts/, /N\/A: <explicit reason>/, /missing block = contract not honored/],
})
assertContract({
  id: 'NO-HARD-CLAIM-ANYWHERE', level: 'policy', targets: 'ALL',
  intent: '阶段 prompt 不得自称 hard constraint（措辞硬与 enforcement 脱节 → 模型脱敏）',
  exclude: [/· hard constraint\]/],
})

// ── structural：state 块 / 产物路径 / 蓝图 JSON / git 纪律 ──
assertContract({
  id: 'STATE-BLOCK-EVERY-STAGE', level: 'structural', targets: 'ALL',
  intent: '每个阶段产出末尾必须指示附 state 块（host 提取合并 state.json 的前提）',
  include: [/STATE BLOCK · mandatory at the end/, /<!-- state -->/],
})
assertContract({
  id: 'DOC-BOUNDARY-POLICY', level: 'policy', targets: 'ALL',
  intent: '所有阶段共用 productCtx：文档只写 docs/teamflow/，日志只写 logs/teamflow/，禁宿主 docs/ 散落',
  include: [/Doc boundary · policy/, /docs\/teamflow/, /logs\/teamflow/],
  exclude: [/docs\/prd|docs\/design|docs\/technical|docs\/qa\//],
})
assertContract({
  id: 'AGENTS-BOUNDARY-POLICY', level: 'policy', targets: 'ALL',
  intent: 'AGENTS.md 是团队资产：除 teamflow 托管区外不得改写/追加 changelog 节',
  include: [/AGENTS\.md boundary · policy/, /do NOT append changelog-style sections/],
})
assertContract({
  id: 'BLUEPRINT-JSON-SHAPE', level: 'structural', targets: ['techPrompt', 'architectPrompt'],
  intent: 'tech/architect 必须产出 <!-- blueprint --> JSON 块（modules/tasks/duplications/why），dev 继承依据',
  include: [/<!-- blueprint -->/, /<!-- \/blueprint -->/, /"modules"/, /"tasks"/, /duplications/],
})
assertContract({
  id: 'DEV-ON-BLUEPRINT', level: 'structural', targets: 'devPrompt',
  intent: 'dev 必须先读蓝图再实现（既有架构上实现，勿重建）',
  include: [/Architecture blueprint first/, /implement ON the existing architecture/],

})
assertContract({
  id: 'GIT-DISCIPLINE-DEV', level: 'policy', targets: 'devPrompt',
  intent: 'dev 禁 checkout main/merge/rebase/commit（host 验收后统一收口提交）',
  include: [/Git discipline · policy/, /checkout main/, /host after acceptance/, /one commit per run/],
})
// 工程指令承接：各阶段锚点不同，逐条断言（无法共用 include 集合）
assertContract({
  id: 'ENG-ACTION-PRD', level: 'structural', targets: 'prdPrompt',
  intent: 'PRD 把需求中的工程指令原样承接进「工程约束」节',
  include: [/Engineering actions carried verbatim/, /MUST be preserved verbatim/],
})
assertContract({
  id: 'ENG-ACTION-DEV', level: 'structural', targets: 'devPrompt',
  intent: 'dev 先执行工程动作（建分支）再写码',
  include: [/execute the action BEFORE writing code/],
})
assertContract({
  id: 'ENG-ACTION-TECH', level: 'structural', targets: 'techPrompt',
  intent: 'tech 把 PRD 工程约束里的 git 动作拆进任务，不得丢失',
  include: [/git actions from the PRD/, /never lost/],
})

// ── 档位专属 prompt ──
assertContract({
  id: 'QA-FIX-CONFIRM-FIRST', level: 'structural', targets: 'qaFixPrompt',
  intent: 'QA 打回修复：先逐条确认属实再修；误报给证据不得无视',
  include: [/Confirm first, then fix/, /QA false positive/, /false-positive evidence/],
})
assertContract({
  id: 'PATCH-VS-REALITY', level: 'structural', targets: 'patchConfirmPrompt',
  intent: 'patch 档先核对需求与现状；不符 → 显式「需求与实际不符」不伪造改动',
  include: [/需求与实际不符，建议取消改动或调整需求/, /no fabricated changes/, /suggest upgrading pipeline mode/],
})
assertContract({
  id: 'TECH-CHANGE-SHEET', level: 'structural', targets: 'techChangePrompt',
  intent: 'tech 档产「技术变更单」而非功能 PRD（不改写既有功能 AC）',
  include: [/技术变更单/, /TECH-CHANGE\.md/, /do NOT rewrite any functional ACs/, /regression floor/],
})
assertContract({
  id: 'TRIAGE-JSON-ONLY', level: 'structural', targets: 'triagePrompt',
  intent: 'triage 只输出 JSON（首字符 { ），五档 mode + slug + needDesign 字段齐备',
  include: [/The FIRST character of your reply must be '\{'/, /JSON object ONLY/, /"mode": "patch\|lite\|tech\|medium\|full"/, /"slug"/, /"needDesign"/, /"confidence": "high\|medium\|low"/],
  exclude: [/hard constraint/i],
})
assertContract({
  id: 'PRD-HEADER-META', level: 'structural', targets: 'prdPrompt',
  intent: 'PRD 头部 meta 块 + 基线依赖/取代声明 + 本夹内 AC-1 起编号',
  include: [/<!-- meta: summary=/, /基线依赖：/, /取代：<task folder>#<AC number>/, /Number ACs from AC-1/],
})

// ── 视觉能力条款（按模型多模态能力动态生成，两分支互斥）──
assertContract({
  id: 'VISUAL-ON-SCRIPTED-FIRST', level: 'policy', targets: 'visualOn',
  intent: 'vision=true：截图仅限人眼类项，精确值仍走 DOM 计算断言；浏览器失败降级不重试',
  include: [/Visual verification · enabled/, /Scripted assertions first/, /offsetWidth/, /人工补测清单/, /do NOT retry more than once/],
})
assertContract({
  id: 'VISUAL-OFF-NO-SCREENSHOT', level: 'policy', targets: 'visualOff',
  intent: 'vision=false：禁截图看图（防幻觉/循环），只走 DOM 文本断言，目测项进人工补测',
  include: [/Visual verification · limited/, /You CANNOT interpret screenshots/, /do NOT take screenshots/, /人工补测清单/, /do NOT guess, do NOT retry/],
})

console.log(failed === 0 ? '\n✅ prompt-contract 全部通过' : `\n❌ prompt-contract ${failed} 项契约失败`)
process.exit(failed === 0 ? 0 : 1)
