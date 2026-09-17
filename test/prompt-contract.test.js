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
// 形态契约夹具需要 host 数据表（纯数据；core/triage.ts 不依赖 prompts → 无循环）
import { artifactContractsFor } from '../host/core/triage.ts'

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
  /** 复验轮夹具（C 方案）：pipeline 在 QA 循环里写 state.__runCtx.qaReverify=true（round ≥ 2）。 */
  qaPromptReverify: qaPrompt(PRD, DEV_SUMMARY, ROOT, RUN_ID, { ...ST, __runCtx: { ...ST.__runCtx, qaReverify: true, qaRound: 2 } }, true),
  /** 已知问题模式验收夹具（E 方案）：QA 打回超限时 pipeline 写 state.__runCtx.knownIssues=true。 */
  acceptanceKnownIssues: acceptancePrompt(PRD, QA_REPORT, DEV_SUMMARY, ROOT, RUN_ID, { ...ST, __runCtx: { ...ST.__runCtx, knownIssues: true } }, true),
  qaFixPrompt: qaFixPrompt([{ id: 'BUG-1', severity: 'P1', module: 'persist.js' }], QA_REPORT, PRD, PRD, ROOT, RUN_ID, ST),
  acceptancePrompt: acceptancePrompt(PRD, QA_REPORT, DEV_SUMMARY, ROOT, RUN_ID, ST, true),
  techChangePrompt: techChangePrompt('重构持久化为独立模块', ROOT, RUN_ID, ST),
  patchConfirmPrompt: patchConfirmPrompt('修复一处按钮样式', ROOT, RUN_ID, ST),
  triagePrompt: TRIAGE_PROMPT('给游戏加本地持久化', { needDesign: true }, { rationale: ['持久化 → medium'] }),
  visualOn: VISUAL_POLICY(true, 'zh'),
  visualOff: VISUAL_POLICY(false, 'zh'),
}

/**
 * EN 夹具（AC-4/AC-5）：同一批工厂 + `state.__runCtx.locale='en'`。
 * en 契约必须断言**真实工厂产出**（禁手写期望文本）——模板一改即红。
 * zh 夹具（ST/out）一条不动：它是「中文零回归」的对照基准（AC-9）。
 */
const ST_EN = { ...ST, __runCtx: { ...ST.__runCtx, locale: 'en' } }
const outEn = {
  prdPrompt: prdPrompt('add local high-score persistence', ROOT, RUN_ID, ST_EN),
  designPrompt: designPrompt(PRD, ROOT, RUN_ID, ST_EN),
  scaffoldPrompt: scaffoldPrompt('scaffold the Tetris project', 'none', ROOT, RUN_ID, ST_EN),
  techPrompt: techPrompt(PRD, null, null, [], ROOT, RUN_ID, ST_EN),
  architectPrompt: architectPrompt(PRD, ROOT, RUN_ID, ST_EN),
  devPrompt: devPrompt({ title: 'T1 persistence', files: ['/persist.js'], spec: 'implement the storage wrapper' }, PRD, PRD, ROOT, RUN_ID, ST_EN),
  qaPrompt: qaPrompt(PRD, DEV_SUMMARY, ROOT, RUN_ID, ST_EN, true),
  qaFixPrompt: qaFixPrompt([{ id: 'BUG-1', severity: 'P1', module: 'persist.js' }], QA_REPORT, PRD, PRD, ROOT, RUN_ID, ST_EN),
  acceptancePrompt: acceptancePrompt(PRD, QA_REPORT, DEV_SUMMARY, ROOT, RUN_ID, ST_EN, true),
  techChangePrompt: techChangePrompt('refactor persistence into a standalone module', ROOT, RUN_ID, ST_EN),
  patchConfirmPrompt: patchConfirmPrompt('fix one button style', ROOT, RUN_ID, ST_EN),
  triagePrompt: TRIAGE_PROMPT('add local persistence', { needDesign: true }, { rationale: ['persistence → medium'] }, undefined, 'en'),
  visualOn: VISUAL_POLICY(true, 'en'),
  visualOff: VISUAL_POLICY(false, 'en'),
}

/** 带 productCtx 的阶段 prompt（triage/visual 条款不共用产品上下文，单独 target）。 */
const STAGE_ALL = [
  'prdPrompt', 'designPrompt', 'scaffoldPrompt', 'techPrompt', 'architectPrompt',
  'devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt', 'techChangePrompt', 'patchConfirmPrompt',
]

/** 断言：targets 为 key 数组（'ALL'=STAGE_ALL）；include 须全命中、exclude 须全不命中。
 *  en=true → 断言取自 outEn（`state.__runCtx.locale='en'` 的真实工厂产出）。 */
function assertContract({ id, level, intent, targets, include = [], exclude = [], en = false, fixture }) {
  const tNames = targets === 'ALL' ? STAGE_ALL : (typeof targets === 'string' ? [targets] : targets)
  const src = en ? outEn : out
  let ok = true
  for (const name of tNames) {
    // `fixture`：调用方直接给工厂产出文本（用于「同一工厂 + 不同 state 上下文」的契约，
    // 例如形态契约段只在 __runCtx 带 artifactContracts 时才注入）。
    const text = fixture !== undefined ? fixture : src[name]
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

// ── 需求澄清闸门（2026-09-16 Phase 1）：分诊的 intent/blockers 契约 + PRD 的假设段契约 ──
// 这两条是闸门的数据源：分诊不输出 intent/blockers → 探索态需求直接开跑；PRD 不写假设段 → 假设继续不可见。
assertContract({
  id: 'TRIAGE-INTENT-BLOCKERS', level: 'policy', targets: 'triagePrompt',
  intent: '分诊输出 intent（需求/探索/反馈）+ 合格 blocker 四字段（question/readings≥2/changes/rework）',
  include: [/"intent": "requirement\|exploration\|feedback"/, /"blockers": \[\{ "question"/, /\[INTENT — decide before mode\]/, /\[BLOCKERS — must-know gaps only\]/, /readings/, /rework/],
})
assertContract({
  id: 'PRD-ASSUMPTIONS-SECTION', level: 'policy', targets: 'prdPrompt',
  intent: 'PRD 必填「假设/待澄清」段 + 镜像进 state 块 openQuestions（假设可见化的落点）',
  include: [/\[Assumptions · mandatory\]/, /openQuestions/, /假设与待澄清/],
})
assertContract({
  id: 'PRD-ASSUMPTIONS-SECTION-EN', level: 'policy', targets: 'prdPrompt', en: true,
  intent: 'en run 的 PRD 同样要求假设段（语言跟随 run 快照，不写死中文标题）',
  include: [/\[Assumptions · mandatory\]/, /openQuestions/, /Assumptions & open questions/],
})
assertContract({
  id: 'TECH-PATCH-ASSUMPTIONS', level: 'policy', targets: ['techChangePrompt', 'patchConfirmPrompt'],
  intent: '非 PRD 档位（tech 变更单 / patch 确认单）也要一句话假设，避免覆盖缺口',
  include: [/假设与待澄清/],
})

// 交付形态契约（2026-09-17 实测：dddd 的插件"看着完整"却装不进 profile——"能被宿主加载"从未进过 AC）
assertContract({
  id: 'TRIAGE-ARTIFACT-SHAPE', level: 'policy', targets: 'triagePrompt',
  intent: '分诊必须判「交付物形态 + 是否要求可安装」（形态决定该满足哪些客观契约）',
  include: [/"artifact": "app\|plugin-host\|plugin-client\|plugin-full\|cli\|lib\|docs\|data\|other"/, /"installable": true\|false/, /\[ARTIFACT — what kind of deliverable/],
})
/** 形态契约段的夹具：`state.__runCtx` 带 artifact/installable/artifactContracts（由 pipeline 从 host 数据表展开）。
 *  缺此上下文时 prdPrompt 不注入该段——这正是设计（形态=other 的普通改动不该被套契约）。 */
const ST_ARTIFACT = { ...ST, __runCtx: { ...ST.__runCtx, artifact: 'plugin-full', installable: true, artifactContracts: artifactContractsFor('plugin-full', true) } }
const prdWithContract = prdPrompt('做一个 dsh 插件', ROOT, RUN_ID, ST_ARTIFACT)
const prdWithContractEn = prdPrompt('build a dsh plugin', ROOT, RUN_ID, { ...ST_EN, __runCtx: { ...ST_EN.__runCtx, artifact: 'plugin-full', installable: true, artifactContracts: artifactContractsFor('plugin-full', true) } })
const prdNoContract = out.prdPrompt
assertContract({
  id: 'TRIAGE-INSTALL-BLOCKER', level: 'policy', targets: 'triagePrompt',
  intent: '新交付物但需求没写「交付/安装形态」时，必须作为 must-know blocker 问用户（形态不同 → 契约集与 AC 不同）',
  include: [/One gap is must-ask whenever it applies/, /installed\/published/, /source in the repo/, /source-only, no packaging/],
})
assertContract({
  id: 'PRD-ARTIFACT-CONTRACTS', level: 'policy', targets: 'prdPrompt',
  intent: '形态契约必须落成 PRD 必填 AC（清单由 host 数据表下发；字段名要求读同仓样本核实）',
  include: [/\[交付形态契约 · 必填 AC\]/, /必须落成 PRD 里可测的 AC/, /禁止凭记忆写/, /plugins\/dsh-plugin-teamflow/],
  fixture: prdWithContract,
})
assertContract({
  id: 'PRD-ARTIFACT-CONTRACTS-EN', level: 'policy', targets: 'prdPrompt', en: true,
  intent: 'en run 同契约（语言跟随 run 快照）',
  include: [/\[DELIVERABLE SHAPE · mandatory ACs\]/, /do NOT write them from memory/],
  fixture: prdWithContractEn,
})
assertContract({
  id: 'PRD-NO-CONTRACT-WHEN-OTHER', level: 'policy', targets: 'prdPrompt',
  intent: '未判形态（other/缺上下文）时**不得**注入形态契约段（防给普通改动套错契约）',
  include: [],
  exclude: [/\[交付形态契约 · 必填 AC\]/],
  fixture: prdNoContract,
})
assertContract({
  id: 'QA-SHAPE-PROBES', level: 'policy', targets: 'qaPrompt',
  intent: 'QA 必须把形态契约逐条当探针跑（构建产物新鲜度/装载安全/安装回滚纪律——dddd 实锤：旧 lib 装上后宿主启动即炸，靠另开 agent 手术卸载才救回）',
  include: [/Deliverable-shape verification · mandatory when injected/, /roll back FIRST/, /Never silently skip/],
})
assertContract({
  id: 'PRD-GITIGNORE-PLAN', level: 'policy', targets: 'prdPrompt',
  intent: '版本化工作区：PM 必须按本项目技术栈审计/规划 .gitignore（收口提交整树 add，噪音进历史=永久）——模型规划，非固定清单',
  include: [/Version-control hygiene · mandatory when the workspace is versioned/, /read the project, don't guess from a generic list/],
})
assertContract({
  id: 'QA-COMMIT-SURFACE-PROBE', level: 'policy', targets: 'qaPrompt',
  intent: 'QA 收口探针：git status --porcelain 不得含依赖/构建产物/工具缓存/IDE/密钥；缺失 → P1 缺陷（模块=版本控制）',
  include: [/Commit-surface hygiene probe · when the workspace is versioned/, /git status --porcelain/],
})

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
  intent: '缺陷必须用结构化表（host parseDefects 按管道单元格导入）；无缺陷须显式声明；P0–P2 行必须带「检测命令 + 通过判据」两列（缺陷的可执行定义）',
  include: [/Defect format · HOST-ENFORCED/, /严重级\(P0\/P1\/P2\/P3\)/, /复现步骤/, /关联验收项/, /检测命令 \| 通过判据/, /the exact command that FAILS right now/, /the table must be in QA-REPORT\.md/, /未发现缺陷/],
})
assertContract({
  id: 'QA-FILE-DELIVERABLE', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: 'QA-REPORT.md 是交付物与唯一事实源',
  include: [/QA-REPORT\.md/, /this file IS the deliverable/],
})
assertContract({
  id: 'FIX-CLASS-GATE', level: 'policy', targets: 'qaFixPrompt',
  intent: 'A 方案：P0–P2 修复必须落「永久可执行门禁 + 命中数 before→after」（r9 实锤：round-1 只修看得见的实例，同类 4 处留在 prompts/index.ts → QA round-2 原样打回，白烧一整轮）',
  include: [/\[Class gate · policy, mandatory for P0\/P1\/P2\]/, /permanent executable gate/, /hit count \*\*before → after\*\*/, /gate: <new\/updated gate command>/, /class sweep:/],
})
assertContract({
  id: 'QA-DEFECT-EXECUTABLE-DEFINITION', level: 'HOST-ENFORCED', targets: 'qaPrompt',
  intent: 'B 方案：P0–P2 行必须给「现在就能失败的命令 + 修好后的期望输出」——修复方据此验收、复验方据此回归、误报用它当场证伪',
  include: [/\[Executable definition\]/, /the exact command that FAILS right now/, /Pass criterion/],
})
assertContract({
  id: 'QA-REVERIFY-REUSE', level: 'policy', targets: 'qaPromptReverify',
  intent: 'C 方案：复验轮先原样重跑上一轮探针（logs/teamflow/<runId>/scripts/）再补未覆盖的面，并重跑缺陷行自带的检测命令；不得重造基线（r9 实测后一轮重做了前一整份 HEAD 副本 = 50 文件/1MB）',
  include: [/\[Re-verification round · policy\]/, /FIRST re-run every probe\/checker the previous rounds left/, /state which surface was missed and why/, /Re-run each defect row's \*\*Check command\*\*/, /Do NOT re-invent a probe or a baseline/],
})
assertContract({
  id: 'QA-FIRST-PASS-NO-REVERIFY-NOISE', level: 'structural', targets: 'qaPrompt',
  intent: '零回归：首轮 QA prompt 不得出现复验轮纪律（夹具无 qaReverify 标志 = 首轮）',
  exclude: [/\[Re-verification round · policy\]/],
})
assertContract({
  id: 'ACCEPTANCE-KNOWN-ISSUES', level: 'policy', targets: 'acceptanceKnownIssues',
  intent: 'E 方案：QA 打回超限时验收不再整段跳过——以「已知问题」只读模式跑一次，产出 ACCEPTANCE.md + 未闭环清单，结论强制为需人工裁定（r9 实锤：停线后任务夹里连 ACCEPTANCE.md 都没有，人工只能补写）',
  include: [/\[Known-issues acceptance · read-only · host-overridden\]/, /P0–P2 defect\(s\) are still open/, /an explicit section listing every open blocking defect/, /the verdict line MUST be ⚠️/, /never ✅/, /this run will not be committed or merged/, /do NOT re-run QA's whole suite/],
})
assertContract({
  id: 'ACCEPTANCE-NORMAL-NO-KNOWN-ISSUES', level: 'structural', targets: 'acceptancePrompt',
  intent: '零回归：常规验收 prompt 不得出现已知问题模式（夹具无 knownIssues 标志）',
  exclude: [/\[Known-issues acceptance · read-only · host-overridden\]/],
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
  id: 'LOG-NO-DUMP-MANUFACTURE', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: '禁止制造命令输出 dump（改由宿主截尾 + spill 承担）：实测一次真实 run 写了 23 个 .out + 5 个 regression-*.log（1.2 MB，占它产出文件数的 41%），归档时全部被丢弃——两头都白费',
  include: [/\[No dump manufacturing\]/, /Do NOT redirect full command\/suite output into files/, /never create per-command \.out files/, /truncates long tool output to its tail/, /spills the complete text to a path it reports/],
  exclude: [/APPENDED on re-run/, /redirect command output to a file/],
})
assertContract({
  id: 'LOG-KEEP-ONLY-DURABLE', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: 'logs/ 只放要留存的东西（检查脚本 scripts/ / 不可重跑载荷 captures.json / 结论 .md），并禁止编号变体；对比基线只物化一次共享',
  include: [/\[Log layout · policy\]/, /one file per purpose/, /scripts\//, /captures\.json/, /number(ed)? variants/, /materialize HEAD ONCE/, /probe\/head\//],
})
assertContract({
  id: 'LOG-LAYOUT-SCOPED', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: '路径必须显式限定在 logs/teamflow/<runId>/ 内并禁止项目根建 scripts//probe/——实锤 tf-mtx6fi2a：未限定时模型在项目根建了 scripts/ 与 probe/，6 个草稿被卷进交付提交',
  include: [/INSIDE logs\/teamflow/, /never create scripts\/ or probe\/ at the project root/, /logs\/teamflow\/[^/\s]+\/scripts\//],
  exclude: [/→ scripts\/ \(name each/],
})
assertContract({
  id: 'LOG-DISCIPLINE-NO-REDIRECT', level: 'structural', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt'],
  intent: 'dev/qa/qaFix 各自重申「输出不落文件（宿主截尾 + spill）」与项目根禁令（取代旧的 regression-<phase>.log 逐阶段约定）',
  include: [/\[Log discipline\]/, /Do NOT redirect command\/suite output into files/, /Never create scripts\/ or probe\/ at the project root/],
  exclude: [/regression-dev\.log|regression-qa\.log|regression-devfix\.log/],
})
assertContract({
  id: 'LOG-LIFECYCLE-ARCHIVED', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: '日志目录定性为「项目内暂存」：run 结束由 host 归档到 $DSH_HOME/teamflow/<workspace>/logs/<runId>/ 并删除项目内副本——子代理不得提交/自行清理/当项目产物（B 方案：日志根离开用户项目）',
  include: [/\[Log lifecycle · policy\]/, /TRANSIENT scratch inside the project/, /\$DSH_HOME\/teamflow\/<workspace>\/logs\//, /Never commit it, never delete it yourself/],
  exclude: [/logs\/teamflow\/<runId>\/ is a permanent project artifact/],
})
assertContract({
  id: 'LOG-LIFECYCLE-FILTERED', level: 'policy', targets: ['devPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt'],
  intent: '归档只留检查脚本与笔记（code 扩展名 + captures.json），命令输出/快照丢弃——禁止把 dump 当成能过夜的证据（durable claim 是回复里的 [Verification evidence] 块）；实测一次真实 run 里 93% 是可重跑输出或 git 里已有的快照',
  include: [/Only your checkers and notes survive/, /are DROPPED/, /\[Verification evidence\] block is the durable claim/],
})
assertContract({
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

// ── policy：产物交付（官方 present 工具 → 交付文件卡）──
assertContract({
  id: 'ARTIFACT-PRESENT-CHANNEL', level: 'policy', targets: ['prdPrompt', 'techPrompt', 'qaPrompt', 'acceptancePrompt'],
  intent: '产物写成后调官方 present 交付（文件卡）；诚实标注为增强项（文件仍是唯一事实源）且只列交付物',
  include: [/Artifact delivery · policy/, /call the `present` tool/, /never scratch files, temp scripts or command logs/, /the file stays the single source of truth/],
  exclude: [/present is mandatory/, /hard constraint/i],
})

// ── L1 · EN 契约（run 语言=en：语言指令 / 模板 / 结论行 / 缺陷表 / triage）──
// 与上面 zh 条目成对：zh 保证没改坏（AC-9），en 保证新增生效（AC-4/AC-5/AC-6/AC-7）。
/** 产出文档的阶段 prompt（architect 只回蓝图 JSON、dev/qaFix 只写代码，均无产物语言指令）。 */
const DOC_STAGES = ['prdPrompt', 'designPrompt', 'scaffoldPrompt', 'techPrompt', 'qaPrompt', 'acceptancePrompt', 'techChangePrompt', 'patchConfirmPrompt']

assertContract({
  id: 'LANG-DIRECTIVE-ZH-ALL-STAGES', level: 'HOST-ENFORCED', targets: DOC_STAGES,
  intent: 'zh run：全部产物阶段 prompt 的语言指令仍是字面量 Chinese Markdown（零回归对照）',
  include: [/Chinese Markdown/], exclude: [/English Markdown/],
})
assertContract({
  id: 'LANG-DIRECTIVE-EN-ALL-STAGES', level: 'HOST-ENFORCED', targets: DOC_STAGES, en: true,
  intent: 'en run：产物语言指令切到 English Markdown（AC-5 产物英文正文由该指令传导），且不再出现 Chinese Markdown',
  include: [/English Markdown/], exclude: [/Chinese Markdown/],
})
assertContract({
  id: 'EN-REPLY-LANG', level: 'policy', targets: ['qaPrompt', 'qaFixPrompt', 'acceptancePrompt'], en: true,
  intent: 'en run：回复正文语言随快照（≤12/≤40/≤10 行摘要改 English），回复与产物不语言分叉',
  include: [/\(≤(12|40|10) lines, English\)/],
  exclude: [/lines, Chinese\)/],
})
assertContract({
  id: 'EN-AGENTS-MEMORY-TEMPLATE', level: 'HOST-ENFORCED', targets: 'scaffoldPrompt', en: true,
  intent: 'AGENTS.md / memory 模板随 run 语言（标题/说明/区块标签全英文），结构资产保持原样不翻译（teamflow 托管区标记、{{占位符}}、路径）',
  include: [/AGENTS\.md — Team rules & documentation index/, /product memory & todos/, /<!-- teamflow:begin -->/, /<!-- teamflow:end -->/, /\{\{PRODUCT\}\}/, /\$DSH_HOME\/teamflow/],
  exclude: [/团队协作守则/, /产品记忆与待办/],
})
assertContract({
  id: 'ZH-AGENTS-MEMORY-TEMPLATE-UNCHANGED', level: 'HOST-ENFORCED', targets: 'scaffoldPrompt',
  intent: 'zh run：AGENTS.md / memory 模板仍是原中文字面量（模板双语只对 en 生效）',
  include: [/团队协作守则与文档索引/, /产品记忆与待办/, /<!-- teamflow:begin -->/],
})
assertContract({
  id: 'EN-PRD-BASELINE-HEADER', level: 'HOST-ENFORCED', targets: 'prdPrompt', en: true,
  intent: 'en run：PRD 头部基线/取代声明用英文契约标记（与 productCtx 说明一致）',
  include: [/Baseline dependency:/, /Baseline dependency: none/, /Supersedes: <task folder>#<AC number>/],
})
assertContract({
  id: 'EN-ACC-VERDICT-LITERAL', level: 'HOST-ENFORCED', targets: 'acceptancePrompt', en: true,
  intent: 'en 结论行四档字面量（与判据层 parseAcceptanceVerdict 的 en 分支配对；⚠️ Conditional pass 含 pass → 不得误判打回）',
  include: [/Acceptance verdict: ✅ Pass/, /⚠️ Conditional pass/, /❌ Fail/, /📝 Not applicable/],
})
assertContract({
  id: 'EN-ACC-LAST-LINE-CONTRACT', level: 'HOST-ENFORCED', targets: 'acceptancePrompt', en: true,
  intent: 'en 结论行同样必须是 ACCEPTANCE.md 最后一行且为四档字面量之一（缺失=契约违例→停线）',
  include: [/MUST be the LAST line of the file, verbatim one of: Acceptance verdict: ✅ Pass/, /missing it = contract violation/, /missing file = hard failure \(needs-human, pipeline stops\)/],
})
assertContract({
  id: 'EN-QA-DEFECT-TABLE', level: 'HOST-ENFORCED', targets: 'qaPrompt', en: true,
  intent: 'en 缺陷表头列序与 zh 完全一致（含新增的 Check command / Pass criterion 两列）；无缺陷须显式声明（en）',
  include: [/\| ID \| Severity \(P0\/P1\/P2\/P3\) \| Module \| Steps \| Expected \| Actual \| Related AC \| Check command \| Pass criterion \|/, /No defects found/, /Defect format · HOST-ENFORCED/],
  exclude: [/严重级\(P0\/P1\/P2\/P3\)/],
})
assertContract({
  id: 'EN-TRIAGE-BILINGUAL', level: 'structural', targets: 'triagePrompt', en: true,
  intent: 'AC-7：triage prompt 声明英文需求一等公民 + rationale 语言指令 + 英文档位等价示例（补在中文示例之外）',
  include: [/English requirements are first-class/, /rationale strings must be written in English/, /6\. \[ENGLISH EQUIVALENTS\]/, /"add a settings page"/, /→ tech/],
})
assertContract({
  id: 'ZH-TRIAGE-UNCHANGED', level: 'structural', targets: 'triagePrompt',
  intent: 'zh run：triage prompt 不含英文增补段（输出与现状一致，既有 triage 行为零回归）',
  exclude: [/English requirements are first-class/, /ENGLISH EQUIVALENTS/],
})

assertContract({
  id: 'EN-NO-CN-SECTION-LABELS', level: 'HOST-ENFORCED',
  targets: ['prdPrompt', 'devPrompt', 'techPrompt', 'qaPrompt', 'qaFixPrompt', 'acceptancePrompt', 'architectPrompt', 'techChangePrompt', 'patchConfirmPrompt', 'triagePrompt', 'visualOn', 'visualOff'],
  en: true,
  intent: 'QA-3 / R2-1：en run 的 prompt 不得再强令中文小节名/标签（否则产物正文写成中文章节名 → AC-5 破）',
  exclude: [/人工补测清单/, /环境限制，非交付缺陷/, /已知待办/, /「架构蓝图」/, /「技术变更单」/, /「确认单」/, /「状态核对」/, /module =「架构」/, /需求与实际不符，建议取消改动或调整需求/, /待办→开发中/, /工程约束/, /统一收口提交/, /版本：vX\.Y/],
})
assertContract({
  id: 'EN-ENG-CONSTRAINTS-PRD', level: 'HOST-ENFORCED', targets: 'prdPrompt', en: true,
  intent: 'R2-1：en run 的「工程约束」节名走词典（prd 要求产出的节名与 tech/dev 引用处同一取值 → en PRD 不再被要求写中文章节名）',
  include: [/Engineering constraints/, /No revision table, no version fields like "Version: vX\.Y \/ Status: in progress"/],
})
assertContract({
  id: 'EN-ENG-CONSTRAINTS-DEV', level: 'HOST-ENFORCED', targets: 'devPrompt', en: true,
  intent: 'R2-1：en run 的 dev 引用英文节名 + 收口提交标签英文化（引用与产出同键 → 不出现指向不存在的中文章节）',
  include: [/Engineering constraints/, /ADR-2026-08-27, one consolidated commit/],
})
assertContract({
  id: 'EN-ENG-CONSTRAINTS-TECH', level: 'HOST-ENFORCED', targets: 'techPrompt', en: true,
  intent: 'R2-1：en run 的 tech 引用同一英文节名（PRD 工程约束 → Engineering constraints）',
  include: [/git actions from the PRD "Engineering constraints" section/],
})
assertContract({
  id: 'ZH-ENG-CONSTRAINTS-PRD-UNCHANGED', level: 'HOST-ENFORCED', targets: 'prdPrompt',
  intent: 'R2-1 零回归对照：zh prd 的版本反例与「工程约束」节名逐字不变（AC-9）',
  include: [/like「版本：vX\.Y \/ 状态：进行中」/, /into the "工程约束" section/],
})
assertContract({
  id: 'ZH-ENG-CONSTRAINTS-DEV-UNCHANGED', level: 'HOST-ENFORCED', targets: 'devPrompt',
  intent: 'R2-1 零回归对照：zh dev 的「工程约束」引用与「统一收口提交」标签逐字不变（AC-9）',
  include: [/If task spec or PRD 工程约束 includes/, /统一收口提交/],
})
assertContract({
  id: 'ZH-ENG-CONSTRAINTS-TECH-UNCHANGED', level: 'HOST-ENFORCED', targets: 'techPrompt',
  intent: 'R2-1 零回归对照：zh tech 的「工程约束」引用逐字不变（AC-9）',
  include: [/git actions from the PRD "工程约束" section/],
})
assertContract({
  id: 'EN-MANUAL-CHECKLIST-LABEL', level: 'HOST-ENFORCED', targets: ['qaPrompt', 'acceptancePrompt'], en: true,
  intent: 'QA-3：en run 的人工补测清单标签换英文（QA/验收报告小节名随 run 语言）',
  include: [/Manual test checklist/],
})
assertContract({
  id: 'EN-ENV-LIMIT-LABEL', level: 'HOST-ENFORCED', targets: ['qaPrompt', 'visualOff'], en: true,
  intent: 'QA-3：en run 的环境限制标签换英文（视觉能力条款 vision=false 分支）',
  include: [/"environment limitation, not a delivery defect"/],
})
assertContract({
  id: 'ZH-ARCH-BLUEPRINT-LABEL-UNCHANGED', level: 'HOST-ENFORCED', targets: 'architectPrompt',
  intent: 'QA-3 零回归对照：zh architectPrompt 标签逐字保留（架构蓝图/状态核对）',
  include: [/「架构蓝图」/, /【状态核对】/],
})
assertContract({
  id: 'ZH-TECH-CHANGE-LABEL-UNCHANGED', level: 'HOST-ENFORCED', targets: ['techChangePrompt', 'triagePrompt'],
  intent: 'QA-3 零回归对照：zh 技术变更单标签逐字保留（techChangePrompt + triage 五档说明）',
  include: [/「技术变更单」/],
})
assertContract({
  id: 'ZH-CONFIRM-LABEL-UNCHANGED', level: 'HOST-ENFORCED', targets: 'patchConfirmPrompt',
  intent: 'QA-3 零回归对照：zh patchConfirmPrompt 确认单标签逐字保留',
  include: [/「确认单」/],
})
assertContract({
  id: 'EN-ARCH-BLUEPRINT-LABEL', level: 'policy', targets: 'architectPrompt', en: true,
  intent: 'QA-3：蓝图/状态核对标签英文 + architect prompt 补语言指令（AC-4② 唯一缺指令的工厂）',
  include: [/structured "architecture blueprint"/, /\[state check\]/, /English Markdown/],
})
assertContract({
  id: 'EN-TECH-CHANGE-LABEL', level: 'policy', targets: 'techChangePrompt', en: true,
  intent: 'QA-3：技术变更单标签英文（tech 档产物标题随 run 语言）',
  include: [/tech change sheet/],
})
assertContract({
  id: 'EN-CONFIRM-SHEET-LABEL', level: 'policy', targets: 'patchConfirmPrompt', en: true,
  intent: 'QA-3：确认单标签英文（patch 档产物标题随 run 语言）',
  include: [/confirmation sheet/],
})

console.log(failed === 0 ? '\n✅ prompt-contract 全部通过' : `\n❌ prompt-contract ${failed} 项契约失败`)
process.exit(failed === 0 ? 0 : 1)
