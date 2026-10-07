/**
 * dsh-plugin-teamflow — 流水线编排行为测试（v0.2.5：把 executePipeline 从「不可测」变成可测）。
 *
 * **为什么需要它**：此前编排层没有任何行为级回归——1,078 行的 `executePipeline` 只能靠源码正则
 * （smoke 那几十条 `pipeline：…`）和人工跑真机来验证。改一行编排逻辑，影响面要跑一整轮 LLM 才知道。
 * 本文件用 **stub 子代理**（不发真实模型请求）直接驱动真实 `executePipeline`，让「阶段怎么走、
 * 什么时候跳过、复用什么产物、失败怎么归一」都变成确定性断言。
 *
 * **冻结语料思路**：子代理的「产出」是固定的一段文本（含 [Verification evidence] 块），
 * 失败场景由 `emptyNext`（首轮空产出 → 触发重试）与 `failLabel`（按 label 命中持续空产出）驱动——
 * 全部可在毫秒级复现，不依赖网络、不烧 token。
 *
 * ⚠️ **要跑起来需要 `@deepseek-ai/*` 可解析**：pipeline → report → `@deepseek-ai/dsh-llm` 是静态
 * import，而这一族是**宿主私有 peer**（运行时由 dsh profile 注入，仓库里不安装）。
 *
 * 本机（Windows）已用 **directory junction** 解决（无需管理员权限，见下面 SKIP 提示里的命令）：
 *   node_modules/@deepseek-ai  ->  ~/.dsh/profiles/node_modules/@deepseek-ai
 * 于是 `pnpm test` 默认就会真跑本文件（58 条断言）。
 *
 * 在**没有 profile 的环境**（CI / 新 clone 未配置）解析不到时，本文件 **明确打印 SKIP 并退出 0**
 * —— 不是静默通过，而是把「本环境跑不了」说清楚，同时保留 TF_ORCH_BASE 兜底：
 *   TF_ORCH_BASE=<能解析 peer 的源码副本> node test/orchestration.test.js
 * 等价的 A/B 对照脚本见 `.workbuddy/verify-2026-09-26/h5-stage-convergence.mjs`。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = process.env.TF_ORCH_BASE || join(here, '..')

/* ⚠️ $DSH_HOME 必须在 import pipeline 之前落定：store/context 在模块加载期就可能取用它。 */
const sandboxRoot = mkdtempSync(join(tmpdir(), 'tf-orch-'))
process.env.DSH_HOME = `${sandboxRoot}/home`

/* ── 加载编排核心（解析不到 → 明确跳过） ── */
let executePipeline = null
let interruptedPhaseOf = null
let resumeRun = null
let setRuntime = null
let runtime = null
try {
  // 目录结构可能变（core 已按职责分过子目录），按候选路径依次尝试 —— 让本文件锁的是**行为**而非结构，
  // 也便于拿它去跑旧结构的源码副本做等价性对照。
  const loadCore = async (...cands) => {
    let lastErr = null
    for (const c of cands) {
      try { return await import(`${pathToFileURL(join(base, 'host/core', c)).href}`) } catch (e) { lastErr = e }
    }
    throw lastErr
  }
  const ctxMod = await loadCore('agent/context.ts', 'context.ts')
  const pipeMod = await loadCore('pipeline.ts')
  executePipeline = pipeMod.executePipeline
  interruptedPhaseOf = pipeMod.interruptedPhaseOf
  resumeRun = pipeMod.resumeRun
  setRuntime = ctxMod.setRuntime
  runtime = ctxMod
} catch (e) {
  if (e && (e.code === 'ERR_MODULE_NOT_FOUND' || e.code === 'MODULE_NOT_FOUND')) {
    console.log('⚠️ SKIP 编排行为测试：宿主私有 peer `@deepseek-ai/*` 不可解析')
    console.log(`   尝试解析位置：${base}`)
    console.log('   跳过原因见本文件头注释（仓库默认环境没有这一族包，不是测试失败）。')
    console.log(`   原始错误：${String(e.message || e).slice(0, 160)}`)
    console.log('   本机修复（Windows junction，无需管理员）：')
    console.log('     node_modules/@deepseek-ai  ->  ~/.dsh/profiles/node_modules/@deepseek-ai')
    console.log('   临时兜底：TF_ORCH_BASE=<能解析 peer 的源码副本> node test/orchestration.test.js')
    process.exit(0)
  }
  throw e
}

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

/* ── 冻结语料：子代理的「标准产出」（够长，且带契约要求的证据块） ── */
const LONG = '## 阶段产出\n' + '本阶段已按契约完成，逐条对应验收条件并附实测数据。'.repeat(30) +
  '\n\n[Verification evidence]\n- 命令：node test/smoke.js\n- 退出码：0\n- 断言计数：509 passed\n'

const BLUEPRINT_JSON = JSON.stringify({
  summary: '存档蓝图摘要（resume 复用）',
  modules: { m1: { files: ['a.ts'], responsibility: '模块 A 的职责' } },
  tasks: [{ id: 'T1', title: '任务一', files: ['a.ts'], reads: [] }],
})
const TECH_ARCHIVED = '存档技术方案正文（resume 复用）\n\n<!-- blueprint -->\n' + BLUEPRINT_JSON +
  '\n<!-- /blueprint -->\n'

/**
 * QA / 验收是「**文件即产物**」单轨契约：host 只读任务夹里的 `QA-REPORT.md` / `ACCEPTANCE.md`，
 * 回复只当摘要。故要驱动 QA 主循环与验收分支，stub 必须**顺带把产物文件写出来**
 * （路径 = `${workspacePath}/${runDocs}/`，runDocs 在 pipeline 早期就写进 journal 了）。
 * 语料格式已实测：缺陷行走 markdown 表格（`| 缺陷 ID | 严重度 | …`），
 * 结论行走 `## 验收结论：✅ 通过 / ❌ 不通过 / 需求不适用`，缺失即 needs-human。
 */
const QA_TABLE = (id, sev) => [
  '# QA 报告', '',
  '| 缺陷 ID | 严重度 | 模块 | 描述 | 复现 | 期望 | 实际 | 检测命令 |',
  '|---|---|---|---|---|---|---|---|',
  `| ${id} | ${sev} | 模块A | 描述文本 | r | e | a | node -e "1" |`,
  '',
].join('\n')
/** 仅 P3 观察项 → 非阻断（P3 不参与打回判定） */
const QA_CLEAN = QA_TABLE('D9', 'P3')
/** P1 → 阻断，触发「打回开发修复 → 复验」闭环 */
const QA_BLOCKING = QA_TABLE('D1', 'P1')
const ACC = {
  pass: '# 验收报告\n\n## 验收结论：✅ 通过\n',
  rework: '# 验收报告\n\n## 验收结论：❌ 不通过\n',
  reject: '# 验收报告\n\n## 验收结论：需求不适用\n',
  noVerdict: '# 验收报告\n\n正文有内容，但没有结论行。\n',
}
/** 分诊裁决：intent 非 requirement ⇒ 澄清闸门应拦下（不得开工）。
 *  ⚠️ intent 必须取 `TRIAGE_INTENTS = ['requirement','exploration','feedback']` 白名单内的值——
 *  normalizeIntent 对白名单外/缺失一律归一成 'requirement'（有意设计：不因模型漏字段就拦启动），
 *  早先用 'chat' 就被静默归一，闸门没触发（实测踩过）。
 *  runTriage 要求子代理回复以 JSON 对象开头，故这里直接给 JSON 文本。 */
const TRIAGE_EXPLORE = JSON.stringify({
  mode: 'full', kind: 'feature', complexity: 'medium', confidence: 'high',
  intent: 'exploration', blockers: [{ question: '要改哪个文件？', changes: '不确定', rework: '可能返工' }],
  slug: 'clarify-probe',
})

/** 构造一次 run：stub 子代理 + 隔离的 $DSH_HOME / 工作区。 */
async function runScenario(
  name,
  { options, resume = null, emptyNext = false, failLabel = null, artifacts = null, cancelAfter = 0, triage = null, extraFiles = 0, presetSupplement = null, prdOutput = null },
) {
  const rootTmp = mkdtempSync(join(tmpdir(), `tf-orch-${name}-`))
  process.env.DSH_HOME = `${rootTmp}/home`
  const work = `${rootTmp}/work`
  mkdtempSync(work)
  // 洪水填充：普通目录 + **无扩展名** 文件（点目录会被扫描器跳过，所以不能用 `.pnpm-store`）。
  // 用来把交付枚举顶到 400 上限，验证「截断 ⇒ host 侧发可判提示」这条**接线**。
  if (extraFiles > 0) {
    const flood = join(work, 'flood')
    mkdirSync(flood, { recursive: true })
    for (let i = 0; i < extraFiles; i++) writeFileSync(join(flood, `blob${i}`), 'x')
  }

  const children = []
  let doEmpty = emptyNext
  let qaRound = 0
  const stubStart = async (_provider, init) => {
    const label = String((init && init.label) || '')
    // 捕获阶段 prompt（锁「同一 run 内 state 刷新」用：后续阶段的 state slice 必须带上 PRD 写下的东西）
    const promptText = String(((init && init.prompt && init.prompt[0] && init.prompt[0].text) || ''))
    children.push({ id: `c-${children.length + 1}`, label, prompt: promptText })
    // 按 label 判定阶段并落产物文件（QA 每轮一份报告 → 用轮次索引取语料）
    if (artifacts) {
      if (/^QA (测试|复验)/.test(label) && artifacts.qa && artifacts.qa.length) {
        putArtifact('QA-REPORT.md', artifacts.qa[Math.min(qaRound, artifacts.qa.length - 1)])
        qaRound++
      } else if (/最终验收/.test(label) && artifacts.acceptance) {
        putArtifact('ACCEPTANCE.md', artifacts.acceptance)
      }
    }
    // 取消注入：起够 N 个子代理后置 cancelled（模拟用户在 dev 期间按了中断）
    if (cancelAfter && children.length >= cancelAfter) journal.cancelled = true
    const labelHit = failLabel && label.includes(failLabel)
    let text = labelHit || doEmpty ? '' : LONG
    // 分诊裁决注入：子代理直接回 JSON（runTriage 期望回复以 JSON 对象开头）
    if (triage && /需求分诊/.test(label)) text = triage
    // PRD 产出覆盖：用来注入带 `extra.*` 的 state 块 —— 锁「同一 run 内 state 必须刷新」
    if (prdOutput && !labelHit && !doEmpty && /梳理 PRD/.test(label)) text = prdOutput
    doEmpty = false
    return {
      id: `c-${children.length}`,
      localAgent: { session: null },
      result: (async () => ({ stopReason: 'completed', output: [{ type: 'text', text }] }))(),
      dispose: async () => {},
    }
  }
  setRuntime({}, { start: stubStart })

  const journal = {
    id: `tf-orch-${name}`, name: 'teamflow-pipeline', status: 'running',
    requirement: '验证流水线编排行为', workspace: `ws-${name}`, workspacePath: work,
    ownerSession: 'sid-orch', locale: 'zh', product: null,
    startedAt: null, endedAt: null, agentsStarted: 0, stages: [], logs: [], result: null,
    error: null, cancelled: false, humanIntervention: false, interrupted: false,
    interruptedAt: null, supersededBy: null,
  }
  // 模拟「journal 里已经存着澄清答复」的续跑（补录入口写入的那一份）：用来验 executePipeline 不把它清成 null
  if (presetSupplement != null) journal.requirementSupplement = presetSupplement
  /** 落一份任务夹产物（QA-REPORT.md / ACCEPTANCE.md），模拟子代理把交付写进文件。 */
  const putArtifact = (fileName, text) => {
    if (!journal.workspacePath || !journal.runDocs || text == null) return
    const dir = join(journal.workspacePath, String(journal.runDocs))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, fileName), text, 'utf8')
  }
  const parent = {
    session: { id: 'sid-orch', header: { cwd: work }, append() {} },
    status: 'idle', followup() {}, inject() {}, options: {},
  }
  runtime.runs.set(journal.id, journal)
  try {
    await executePipeline(journal, parent, journal.requirement, options, undefined, resume)
  } catch (e) {
    journal.error = String((e && e.message) || e)
  }
  const logOf = (l) => journal.logs.filter((x) => x.level === l).map((x) => x.message)
  const out = {
    journal, status: journal.status, error: journal.error,
    logs: journal.logs.map((l) => `${l.level}: ${l.message}`),
    warnLogs: logOf('warn'), childLabels: children.map((c) => c.label),
    childCount: children.length, blueprint: journal.blueprint,
    humanIntervention: !!journal.humanIntervention,
    // PRD 确认单（ADR-0011 ①）：暂停后必须能读到落盘的 sheet（进程重启后主线程还要靠它讲「批准什么」）
    confirmSheet: journal.confirmSheet ?? null,
    journalSupplement: journal.requirementSupplement ?? null,
    timelineKeys: Object.keys((journal.result && journal.result.timeline) || {}).sort(),
    // 各阶段真实 prompt（按 label；同名取最后一次）—— 供「同一 run 内 state 刷新」这类**注入面**断言
    promptsByLabel: Object.fromEntries(children.map((c) => [c.label, c.prompt])),
  }
  rmSync(rootTmp, { recursive: true, force: true })
  return out
}

const FULL_OPTS = {
  needDesign: true, needScaffold: true, lite: false, tasks: [], productRoot: null,
  maxConcurrency: null, branchPolicy: 'keep', preAction: 'keep-nogit', mode: 'full',
}
const PATCH_OPTS = { ...FULL_OPTS, mode: 'patch', needDesign: false, needScaffold: false }
/** full 档但省掉设计/脚手架两阶段（QA/验收覆盖不需要它们，省两次 stub 往返） */
const QA_OPTS = { ...FULL_OPTS, needDesign: false, needScaffold: false }
const has = (labels, kw) => labels.some((l) => String(l).includes(kw))

/* ── ① 档位护栏：patch 档不得派生独立 QA / 验收子代理 ── */
console.log('\n[1] 档位阶段集：patch = 单点确认 + 开发自测兜底')
{
  const r = await runScenario('patch', { options: PATCH_OPTS })
  ok(r.status === 'completed', `run completed（实测 ${r.status}）`)
  ok(r.timelineKeys.join(',') === 'dev,prd', `仅 prd/dev 两段产物进入 timeline（实测 ${r.timelineKeys}）`)
  ok(!has(r.childLabels, 'QA') && !has(r.childLabels, '验收'), 'patch 档不派生独立 QA / 验收子代理')
  ok(has(r.childLabels, '整体开发'), '单点修复仍起一个整体开发子代理')
  ok(!r.humanIntervention, 'patch 正常收口不置需人工')
}

/* ── ② full 档：同形四阶段 + QA 都要真起子代理 ── */
console.log('\n[2] 档位阶段集：full = PRD → 设计 → 脚手架 → 技术方案 → 开发 → QA')
{
  const r = await runScenario('full', { options: FULL_OPTS })
  const t = r.timelineKeys.join(',')
  ok(['prd', 'design', 'scaffold', 'tech', 'dev'].every((k) => t.includes(k)),
    `prd/design/scaffold/tech/dev 全部产出（实测 ${t}）`)
  ok(has(r.childLabels, '梳理 PRD') && has(r.childLabels, '设计说明'), 'PRD 与 UI/UX 设计各起一个子代理')
  ok(has(r.childLabels, '脚手架规划与落地') && has(r.childLabels, '技术方案'), 'needScaffold 时脚手架与技术方案各起一个子代理')
  ok(has(r.childLabels, 'QA 测试'), 'full 档含独立 QA 子代理')
  // stub 不写 QA-REPORT.md ⇒ 单轨契约硬失败（文件即产物），这正是要锁的行为
  ok(r.status === 'failed' && /QA 测试/.test(String(r.error)),
    'QA-REPORT.md 未落盘 → QA 阶段硬失败（回退解析摘要 = 静默假交付）')
}

/* ── ③ 波次调度：多任务开发按依赖分波，且各自一张子卡 ── */
console.log('\n[3] 波次调度：调用方声明 files/reads → 依赖边排序而非整批串行')
{
  const opts = {
    ...FULL_OPTS, needDesign: false, needScaffold: false,
    tasks: [
      { id: 'T1', title: '任务一', spec: '实现模块一', files: ['a.ts'], reads: [] },
      { id: 'T2', title: '任务二', spec: '实现模块二', files: ['b.ts'], reads: [] },
      { id: 'T3', title: '任务三', spec: '串联两个模块', files: ['c.ts'], reads: ['a.ts'] },
    ],
  }
  const r = await runScenario('devmulti', { options: opts })
  const devChildren = r.childLabels.filter((l) => String(l).startsWith('开发 · '))
  ok(devChildren.length === 3, `三个写集互不重叠的任务各自起一个子代理（实测 ${devChildren.length}）`)
  ok(['任务一', '任务二', '任务三'].every((t) => has(devChildren, t)), '每个任务的标题都出现在子代理 label 里')
  ok(r.timelineKeys.includes('dev'), 'dev 产物进入 timeline')
}

/* ── ④ 阶段失败：errors 文案必须带真实次数 / 末次 outcome（不得再是「重试 N 次」套话） ── */
console.log('\n[4] 阶段失败：技术方案持续空产出 → 阶段级失败 + 需人工')
{
  const r = await runScenario('techfail', { options: FULL_OPTS, failLabel: '技术方案' })
  ok(r.status === 'failed', `阶段失败 → run failed（实测 ${r.status}）`)
  ok(/技术方案/.test(String(r.error)) && /次尝试未交付/.test(String(r.error)),
    '失败文案点名阶段与真实尝试次数')
  ok(/末次/.test(String(r.error)), '失败文案带末次尝试的 outcome/summary（避免无信息量的套话）')
  ok(r.humanIntervention, '阶段失败 → journal.humanIntervention 置位（汇报不再自相矛盾）')
  ok(!r.timelineKeys.includes('dev'), '技术方案失败后不再继续起开发子代理（失败不向下传播）')
}

/* ── ⑤ 空产出重试：PRD 首轮被判空 → 自动重试后收敛 ── */
console.log('\n[5] 空产出重试：模型空收尾不代表任务失败')
{
  const r = await runScenario('fail', { options: PATCH_OPTS, emptyNext: true })
  ok(r.status === 'completed', `首轮空产出 + 重试成功 → 正常收口（实测 ${r.status}）`)
  ok(r.childLabels.filter((l) => /第 2 次重试/.test(String(l))).length >= 1, '空产出触发了自动重试')
}

/* ── ⑥ 断点续跑：复用存档产物 + 仅补跑未完成任务 + 照样提取蓝图 ── */
console.log('\n[6] 断点续跑：resume.phase=dev → 复用 prd/design/scaffold/tech，只补跑开发')
{
  const resume = {
    phase: 'dev',
    products: {
      prd: '存档 PRD 正文（resume 复用）', design: '存档设计稿正文（resume 复用）',
      scaffold: '存档脚手架正文（resume 复用）', tech: TECH_ARCHIVED,
    },
  }
  const r = await runScenario('resume', { options: FULL_OPTS, resume })
  ok(!has(r.childLabels, '梳理 PRD') && !has(r.childLabels, '技术方案'),
    'resume 不重跑 PRD / 技术方案（跳过已完成阶段）')
  ok(has(r.childLabels, '补跑'), '未完成开发任务以「补跑」形态重启')
  ok(r.blueprint && Array.isArray(r.blueprint.tasks) && r.blueprint.tasks.length > 0,
    'resume 复用 tech 产物时**照样提取蓝图**（不退化成整体单任务开发）')
  ok(r.logs.some((l) => /跳过已完成阶段/.test(l)), '跳过的阶段都留有可见日志')
}

/* ── ⑦ 终态归一：无论成功/失败/中途返回，status 必须落到终态 ── */
console.log('\n[7] 终态归一：run 不得卡在 status=running')
{
  const runs = [
    ['patch', await runScenario('norm-patch', { options: PATCH_OPTS })],
    ['techfail', await runScenario('norm-fail', { options: FULL_OPTS, failLabel: '技术方案' })],
  ]
  for (const [name, r] of runs) {
    ok(r.status !== 'running' && r.status !== 'pending',
      `${name}：status 落到终态（实测 ${r.status}；卡 running 会让中断按钮永久失效）`)
  }
}

/* ── ⑧ QA 干净：仅 P3 观察项 → 不阻断 → 进验收并通过 ── */
console.log('\n[8] QA 打回闭环①：仅 P3 观察项 → 不阻断，直接进验收')
{
  const r = await runScenario('qa-clean', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass },
  })
  ok(r.timelineKeys.includes('qa') && r.timelineKeys.includes('acceptance'),
    `QA 与验收产物都进了 timeline（实测 ${r.timelineKeys}）`)
  ok(!has(r.childLabels, 'QA 缺陷修复'), '无 P0–P2 ⇒ 未派生「QA 缺陷修复」子代理')
  ok(has(r.childLabels, '最终验收'), 'QA 干净 → 正常进入验收阶段')
  ok(r.status === 'completed' && !r.humanIntervention, `验收通过 → completed 且无需人工（实测 ${r.status}）`)
}

/* ── ⑨ QA 有 P1 → 打回开发修复 → 复验通过后进验收 ── */
console.log('\n[9] QA 打回闭环②：P1 缺陷 → 打回修复 → 复验通过')
{
  const r = await runScenario('qa-rework', {
    options: QA_OPTS, artifacts: { qa: [QA_BLOCKING, QA_CLEAN], acceptance: ACC.pass },
  })
  ok(has(r.childLabels, 'QA 缺陷修复'), 'P0–P2 ⇒ 派生「QA 缺陷修复」子代理（打回开发）')
  ok(r.childLabels.filter((l) => /QA 测试|QA 复验/.test(String(l))).length >= 2, '复验轮确实又跑了一次 QA')
  ok(r.status === 'completed', `复验通过 + 验收通过 → completed（实测 ${r.status}）`)
  ok(r.logs.some((l) => /打回|返工/.test(l)), '打回有可见日志（不是静默循环）')
}

/* ── ⑩ QA 打回超轮次上限 → qaBlocked → 走「已知问题」只读验收 ── */
console.log('\n[10] QA 打回闭环③：缺陷不收敛 → 超 QA_REWORK_LIMIT → 转人工')
{
  const r = await runScenario('qa-limit', {
    options: QA_OPTS,
    artifacts: { qa: [QA_BLOCKING, QA_BLOCKING, QA_BLOCKING], acceptance: ACC.pass },
  })
  ok(r.humanIntervention, '打回超上限 → journal.humanIntervention 置位（需人工）')
  ok(r.journal.knownIssuesAcceptance === true, '置 knownIssuesAcceptance（E 方案：只读验收，结论强制需人工裁定）')
  ok(has(r.childLabels, '最终验收'), 'QA 不干净也**不整段跳过验收**——改走已知问题只读模式')
  // 模型自己的结论不被 host 采用：即使报告写「✅ 通过」，也不能因此变成干净交付
  ok(r.humanIntervention && r.status === 'completed', '已知问题模式：仍 completed，但保留需人工标记')
}

/* ── ⑪⑫⑬ 验收结论四档：rework / reject / 无结论行 ── */
console.log('\n[11] 验收结论：❌ 不通过 → rework（保留需人工，run 仍 completed）')
{
  const r = await runScenario('acc-rework', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.rework },
  })
  ok(r.humanIntervention, '验收 rework → 置需人工')
  ok(r.status === 'completed', `rework 分支 run 仍收口为 completed（实测 ${r.status}）`)
}

console.log('\n[12] 验收结论：需求不适用 → reject（拦截，run failed）')
{
  const r = await runScenario('acc-reject', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.reject },
  })
  ok(r.status === 'failed', `reject → 中断流水线（实测 ${r.status}）`)
  ok(r.humanIntervention, 'reject → 置需人工（汇报与状态线不再自相矛盾）')
}

console.log('\n[13] 验收结论：缺结论行 → needs-human（宁严勿松，不默认放行）')
{
  const r = await runScenario('acc-noverdict', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.noVerdict },
  })
  ok(r.status === 'failed', `无结论行 → 硬失败而非默认 accepted（实测 ${r.status}）`)
  ok(/验收结论|结论行/.test(String(r.error)), `失败文案点名「结论行」缺失（实测 ${String(r.error).slice(0, 60)}）`)
}

/* ── ⑭ dev 提测门禁：有 failed 任务 → 停止流水线，不进 QA ── */
console.log('\n[14] dev 提测门禁：任务失败 ⇒ 拦住，不进 QA')
{
  const r = await runScenario('dev-gate', {
    options: {
      ...QA_OPTS,
      tasks: [
        { id: 'T1', title: '任务一', spec: 's', files: ['a.ts'], reads: [] },
        { id: 'T2', title: '任务二', spec: 's', files: ['b.ts'], reads: [] },
      ],
    },
    failLabel: '任务二',
    artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass },
  })
  ok(!has(r.childLabels, 'QA 测试'), 'dev 有失败任务 ⇒ 提测门禁拦住，不派生 QA 子代理'
    + '（r26 实锤：带已知缺口进 QA，检查轮必然重复报告，白烧 token）')
  ok(/提测门禁/.test(String(r.error)), `失败文案点名「提测门禁」并说明不进 QA 的理由（实测 ${String(r.error).slice(0, 40)}）`)
  ok(r.humanIntervention, '提测失败 → 置需人工（人工处理后 resume 从开发补跑，已完成任务复用）')
  ok(r.status === 'failed', `流水线停止（实测 ${r.status}）`)
}

/* ── ⑮ 取消路径：dev 期间取消 → 终态归一到 cancelled ── */
console.log('\n[15] 取消：dev 期间取消 → 终态归一（不卡 running）')
{
  const r = await runScenario('dev-cancel', {
    options: QA_OPTS, cancelAfter: 2, artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass },
  })
  ok(r.status === 'cancelled', `取消 → status 落 cancelled（实测 ${r.status}；`
    + '卡 running 会让中断按钮永久失效、续跑一轮又一轮）')
  ok(!has(r.childLabels, 'QA 测试'), '取消后不再继续起 QA 子代理')
  ok(r.journal.cancelled === true, 'journal.cancelled 置位（汇报据此渲染「已取消」）')
}

/* ── ⑯ 澄清闸门：分诊判定非需求 → 不开工 ── */
console.log('\n[16] 澄清闸门：分诊 intent 非需求 + must-know 缺口 → 不开工，落可续跑中断态')
{
  const r = await runScenario('triage-clarify', { options: QA_OPTS, triage: TRIAGE_EXPLORE })
  ok(r.journal.interrupted === true, '落 interrupted（可续跑的中断态，不是失败）')
  ok(r.humanIntervention, '置需人工（等澄清）')
  ok(!has(r.childLabels, '梳理 PRD'), '未进入 PRD 阶段（闸门在任何阶段之前——不得先干再问）')
  ok(/澄清|尚未对齐/.test(String(r.error)), `错误文案要求先向用户澄清（实测 ${String(r.error).slice(0, 40)}）`)
  ok(r.status !== 'running', `澄清中止后 status 不卡 running（实测 ${r.status}）`)
  // 探索态加固（2026-10-08）：`intent === 'exploration'` ⇒ 中止文案**追加**「一次一问」协议。
  // 这是**行为断言**（不是源码锁）：工具返回面与 pipeline 兜底闸门两条路径必须同形，
  // 否则「谁先命中」会决定主 agent 拿到什么行为指令。
  ok(/一次只问一个问题/.test(String(r.error)), `探索态 ⇒ 中止文案带「一次一问」协议（实测尾部 ${String(r.error).slice(-56)}）`)
  ok(/停止追问/.test(String(r.error)), '协议同时给**硬终止**条件（只教「一次一问」不教「何时停」＝把用户拖进无限追问）')
  // 对照：**非探索态**不得加协议 —— 否则等于每次澄清都被强制成访谈模式。
  // （intent=requirement 但仍有 blocker ⇒ 同样走 needs-clarification，路径相同、只有 intent 不同。）
  const reqClarify = await runScenario('triage-clarify-req', {
    options: QA_OPTS,
    triage: JSON.stringify({
      mode: 'full', kind: 'feature', complexity: 'medium', confidence: 'high',
      // ⚠️ blocker 必须**过 host 合格线**（≥2 个互斥读法 ＋ changes ＋ rework，见 `qualifyBlockers`）：
      // 少了 `readings` 会被丢掉 ⇒ blockers 为空 ⇒ 闸门不触发，这条对照就测了个寂寞（第一版踩过）。
      intent: 'requirement', blockers: [{ question: '用哪个库？', readings: ['A 库', 'B 库'], changes: '换库', rework: '重写' }], slug: 'clarify-req',
    }),
  })
  ok(/澄清|尚未对齐/.test(String(reqClarify.error)) && !/一次只问一个问题/.test(String(reqClarify.error)),
    `对照：intent=requirement ⇒ 同一路径**不加**协议（实测尾部 ${String(reqClarify.error).slice(-50)}）`)
}

console.log('\n[17] host 侧两项检查必须「可观测」—— 不许静默空转')
{
  // 回归 2026-09-29 实测事故：两项 host 侧检查直接拿 `root`(=options.productRoot) 当路径，
  // 而工作区模式下它**恒为 null**（5/5 真实 run）⇒ listDeliverableFiles(null)=[] ⇒
  // 加载检查静默 no-html、证据探针静默 skip，两个功能一起空转且 journal 里零痕迹。
  // 这里同时锁两件事：① 必须留痕；② 留痕里必须带**解析出的真实路径**（而不是 null）。
  const r = await runScenario('host-observability', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass },
  })
  const loadLog = (r.logs || []).find((l) => l.includes('host 侧加载检查'))
  ok(!!loadLog, `host 加载检查必须留痕（即使不适用）—— 实测 ${loadLog ? '有' : '无（=静默空转，本次要防的正是这个）'}`)
  ok(/no-html/.test(String(loadLog)), `本场景工作区无 HTML 入口 → 记为 no-html（实测 ${String(loadLog).slice(0, 90)}）`)
  ok(/根=\S/.test(String(loadLog)) && !/根=n\/a/.test(String(loadLog)),
    '留痕必须带解析出的 workspacePath（root=null 时回落 workspacePath，不得记成 n/a）')
  const evLog = (r.logs || []).find((l) => l.includes('QA 验证证据观察'))
  ok(!!evLog, `证据探针的 skip 也要留痕（否则「路径算错扫到 0 文件」与「真的纯文档」无法区分）—— 实测 ${evLog ? '有' : '无'}`)
}

/* ── ⑨ 枚举截断 ⇒ host 侧必须发「本次不可判」提示（接线层，2026-10-02）──
 * 为什么单列：今天修的枚举截断只测了**扫描器**（smoke-check.test.js），接线层当时裸奔 ——
 * 真实事故是「四项检查同时静默跳过、日志读起来像交付里什么都没有」，而那正是 qa.ts 这一段。
 * 变异：把 qa.ts 里 `load.truncated || ic.truncated || sm.truncated` 的判断去掉 ⇒ 本组立刻红。 */
console.log('\n[9] 交付枚举被上限截断 ⇒ 负结论被显式撤回')
{
  const r = await runScenario('scan-truncated', { options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass }, extraFiles: 430 })
  ok(r.status === 'completed', `run 仍要跑完（实测 ${r.status}）`)
  const logs = r.logs || []
  const truncAt = logs.findIndex((l) => /截断|hit the file cap/.test(l))
  ok(truncAt >= 0, `枚举被顶到上限时必须发 hostScanTruncated 提示（否则负结论会被读成事实）—— 实测 ${truncAt >= 0 ? '有' : '无'}`)
  ok(/400/.test(String(logs[truncAt])), `提示要带上限值（实测 ${String(logs[truncAt]).slice(0, 80)}）`)
  ok(logs.some((l) => /host 侧加载检查|host-side load/.test(l)), '三项检查仍各自留痕（截断不等于不检查）')
  // 三条负结论**原文保留**（它们确实没执行），撤回靠的是**后一条 warn 点名它们** ⇒
  // 顺序也是契约：warn 必须在三条之后，否则读者先看到「事实」再看到解释。
  const negIdx = logs.findIndex((l) => /no-html|源文件 0 个/.test(l))
  ok(negIdx >= 0 && truncAt > negIdx, `撤回提示必须排在负结论**之后**（实测 neg@${negIdx} / warn@${truncAt}）`)
  ok(/不是事实|只是没枚举到|not facts/.test(String(logs[truncAt])),
    `撤回提示要点名那三条「不是事实」（实测 ${String(logs[truncAt]).slice(0, 100)}）`)
}

/* ── ⑩ 零阶段 run 的断点必须 = PRD（ADR-0011 ④，2026-10-06）──
 * 为什么单列：`interruptedPhaseOf` 的循环出口只有一个（`return 'acceptance'`），于是
 * **「什么都没做」与「什么都做完了」共用同一个出口** —— 零阶段 run（澄清闸门兜底 `abortForClarification`
 * 落下的零阶段 interrupted run）续跑时 `resumed()` 对 prd/design/scaffold/tech/dev/qa 全为真，
 * 而零阶段的 `buildResumeProducts` 返回 `{}` ⇒ 产物全 undefined（PRD 为空）⇒ 跳过整条流水线
 * 直接拿空 PRD 跑验收。**是「跑错」，不只是「拿不回答复」**（实机探针：断点实测 = acceptance）。
 * 变异：删掉 `if ((journal.stages || []).length === 0) return 'prd'` ⇒ 本组第 1 条立刻红。 */
console.log('\n[18] 零阶段 run 的断点 = PRD（不得跳过整条流水线直接验收）')
{
  const zeroStage = {
    id: 'tf-zero', requirement: 'r', status: 'interrupted', locale: 'zh',
    workspace: 'ws-zero', stages: [], logs: [], options: { mode: 'full' },
  }
  ok(interruptedPhaseOf(zeroStage) === 'prd', `零阶段 → 断点 prd（实测 ${interruptedPhaseOf(zeroStage)}）`)

  // 确认单形态（2026-10-07 第二层修正）：**PRD done、其后全空**。现实现在这里会一路 continue
  // 到 `return 'acceptance'` ⇒ 跳过 design/tech/dev/qa 直接验收。改后应落在「启用但从未尝试」的阶段。
  const afterPrd = interruptedPhaseOf({ ...zeroStage, options: QA_OPTS, stages: [{ phase: 'prd', status: 'done' }] })
  ok(afterPrd === 'tech', `PRD done 且其后全空（full 档无 design/scaffold）→ 断点 tech（实测 ${afterPrd}）`)
  const afterPrdFull = interruptedPhaseOf({
    ...zeroStage, options: { mode: 'full', needDesign: true, needScaffold: true }, stages: [{ phase: 'prd', status: 'done' }],
  })
  ok(afterPrdFull === 'design', `同上但 needDesign=true → 断点 design（实测 ${afterPrdFull}）`)

  // 对照：所有阶段都 done ⇒ 断点仍是 acceptance（「都做完了」那一路不能被这两次修正带偏）
  const allDone = ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance'].map((p) => ({ phase: p, status: 'done', taskKey: 'T1' }))
  ok(interruptedPhaseOf({ ...zeroStage, options: { mode: 'full', needDesign: true, needScaffold: true }, stages: allDone }) === 'acceptance',
    '对照：全部阶段 done → 断点 acceptance（不是被「启用但未尝试」这条抢走）')

  // 行为侧：用零阶段算出的断点驱动 executePipeline ⇒ PRD 必须真起子代理
  const r = await runScenario('zero-stage-resume', {
    options: QA_OPTS, resume: { phase: interruptedPhaseOf(zeroStage), products: {} },
  })
  ok(has(r.childLabels, '梳理 PRD'), `零阶段续跑后 PRD 真跑（实测子代理 ${JSON.stringify(r.childLabels).slice(0, 130)}）`)

  // 对照：断点 = acceptance 时 PRD 被跳过 ⇒ 证明「跳过」确实由 resume.phase 驱动（上面那条有牙）
  const skipped = await runScenario('late-phase-resume', {
    options: QA_OPTS, resume: { phase: 'acceptance', products: {} },
  })
  ok(!has(skipped.childLabels, '梳理 PRD'), '对照：断点 = acceptance 时 PRD 被跳过（跳过由 resume.phase 驱动，非偶然）')
}

/* ── ⑪ 续跑补录入口：`supplement` 只在断点 ≤ PRD 时接受，晚于 PRD 显式拒绝 ──
 * PRD 是 supplement 的**唯一消费点**（`prdInput` 拼 `[CLARIFIED]`）⇒ 断点晚于 PRD 时本轮没有任何阶段会读它。
 * 拒绝而非接受，是因为「静默丢弃」正是本仓反复踩的坑（§7 工具返回体被 schema 吃掉 / §16 白名单吃掉内部字段）。
 * 变异：把拒绝分支改成直接 `j.requirementSupplement = supp` ⇒ 本组第 1 条立刻红。 */
console.log('\n[19] 续跑补录（supplement）：断点晚于 PRD ⇒ 显式拒绝')
{
  const home = join(tmpdir(), 'tf-orch-supp')
  process.env.DSH_HOME = home
  const mk = (ws, id, stages) => {
    const dir = join(home, 'teamflow', ws, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, requirement: '验证续跑补录校验', status: 'interrupted', locale: 'zh',
      workspace: ws, logs: [], options: { mode: 'full' }, stages,
    }), 'utf8')
  }
  mk('ws-stage-late', 'tf-late-supp', [{ phase: 'prd', status: 'done' }, { phase: 'tech', status: 'failed' }])
  const bad = resumeRun('tf-late-supp', null, '用户答复：用 A 方案')
  ok(bad.ok === false && /补录被拒绝/.test(String(bad.error)),
    `断点晚于 PRD ⇒ 拒绝补录（实测 ${String(bad.error).slice(0, 100)}）`)

  mk('ws-stage-zero', 'tf-zero-supp', [])
  const zero = resumeRun('tf-zero-supp', null, '用户答复：用 A 方案')
  ok(zero.ok === false && !/补录被拒绝/.test(String(zero.error)),
    `零阶段断点 ≤ PRD ⇒ 补录过校验（此处因无 agent 停在 agentNotFound，实测 ${String(zero.error).slice(0, 80)}）`)
  rmSync(home, { recursive: true, force: true })

  // 行为侧（比源码锁强）：journal 里已存的答复，续跑时**不得被清成 null** ——
  // `executePipeline` 收到的是 `journal.options`（白名单字面量，不含该键），无条件赋值就会清空。
  const kept = await runScenario('resume-keeps-supplement', {
    options: QA_OPTS, artifacts: { qa: [QA_CLEAN], acceptance: ACC.pass },
    resume: { phase: 'tech', products: {} }, presetSupplement: '用户此前给的澄清答复',
  })
  ok(kept.journalSupplement === '用户此前给的澄清答复',
    `续跑保留 journal 里已有的答复（实测 ${JSON.stringify(kept.journalSupplement)}）`)
}

/* ── ⑳ PRD 确认单（ADR-0011 ①，2026-10-08 第 2 步）：触发判据是**内容**，不是一个用户要敲的开关 ──
 * 触发 = PRD 的 `openQuestions` 里存在 `kind: "taste"`（**主观品味项**）⇒ PRD 后暂停等用户拍板。
 * 为什么单列：确认单的落点是 `interrupted`，而「PRD done、其后全空」正是上一批断点第二层修的那一种形态。
 * 两者是**绑定关系** —— 断点修错，用户批准后 resume 会跳过 design/tech/dev/qa 直接验收。
 * 为什么不是「任何待澄清项都停」：信息缺口有 `default` 兜底，而品味项猜错的代价是「成品不是我要的」
 *   （表现为流失/差评，**不表现为 QA 打回**）⇒ 分开判据才既保住 §1 的无人值守卖点、又不让品味项溜过去。
 * 变异：① 删掉 PRD 后的 `return abortForConfirmSheet(...)` ⇒ 暂停三条立刻红；
 *       ② 判据退化成 `openQuestions.length > 0`（任何项都停）⇒ 「只有 fact 不停」立刻红；
 *       ③ 判据里的 `'taste'` 写成 `'fact'` ⇒ 暂停条红、fact 条绿（单维度可分辨）。 */
console.log('\n[20] PRD 确认单：有主观项（kind=taste）⇒ 暂停；只有信息缺口 ⇒ 直通')
{
  const { buildConfirmSheet, renderConfirmSheet } = await import(pathToFileURL(join(base, 'host/core/confirm.ts')).href)

  // 造一份带 `extra.openQuestions` 的 PRD 产出 —— 判据读的就是它（`mergeStageState` 落进 `state.openQuestions`）。
  // 正文要够长：产出 <400 字符会被实质校验判「未交付」，那样就测不到确认单了。
  const prdWith = (questions) => '## 目标\n做一个小工具。\n\n## 验收标准\n- AC-1 能跑\n\n' +
    '本 PRD 按契约逐条对应验收条件并给出可测判据，范围与非目标均已写明。'.repeat(12) +
    `\n\n<!-- state -->${JSON.stringify({
      phase: 'prd', summary: '一句话目标', memory: [],
      extra: { acIndex: { 'AC-1': '能跑' }, summary: '一句话目标', openQuestions: questions },
    })}<!-- /state -->`
  const TASTE = { q: '桌宠长什么样？', why: '形象定了就不好改', changes: '换形象', default: '圆润小动物', kind: 'taste' }
  const FACT = { q: '要不要支持导出？', why: '需求没说', changes: '加导出入口', default: '不支持', kind: 'fact' }

  // ① 有主观项 ⇒ PRD 后停下，后续阶段一个都不跑
  const paused = await runScenario('confirm-taste', { options: QA_OPTS, prdOutput: prdWith([TASTE]) })
  ok(paused.status === 'interrupted', `有 kind=taste ⇒ 停成 interrupted（实测 ${paused.status}）`)
  ok(paused.humanIntervention === true, '置 humanIntervention（工作台与汇报据此标「需人工」）')
  ok(paused.confirmSheet && typeof paused.confirmSheet === 'object', `确认单已落盘（实测 ${JSON.stringify(paused.confirmSheet).slice(0, 120)}）`)
  ok((paused.confirmSheet.questions || []).some((q) => q.kind === 'taste'), '确认单带上了 kind=taste（用户能看出「哪几条必须我定」）')
  ok(renderConfirmSheet(paused.confirmSheet, 'zh').includes('［主观项］'), '**主观项要打标**（否则用户分不清「要你定」与「我已替你定」）')
  // 只算**阶段子代理**：分诊子代理（label「需求分诊」）也在 children 里，不能拿来判「跑到哪个阶段」
  const stageChildren = paused.childLabels.filter((l) => !/需求分诊|triage/i.test(String(l)))
  ok(stageChildren.length === 1 && /梳理 PRD/.test(String(stageChildren[0])),
    `只跑了 PRD，其后的 design/tech/dev/qa 一个都没起（实测阶段子代理 ${JSON.stringify(stageChildren)}）`)

  // ② **只有信息缺口 ⇒ 不打断**（「不是任何待澄清项都停」的核心断言）。
  //    断言必须证明「真的越过了 PRD 那道闸」——只写 `!== 'interrupted'` 的话，
  //    「PRD 后崩了」也会读成绿（本组正是靠这条把「停」与「没停」分开的）。
  const factOnly = await runScenario('confirm-fact-only', { options: QA_OPTS, prdOutput: prdWith([FACT]) })
  ok(factOnly.status !== 'interrupted' && factOnly.confirmSheet === null,
    `只有 kind=fact ⇒ 直通不打断（实测 status=${factOnly.status} / confirmSheet=${JSON.stringify(factOnly.confirmSheet)}）`)
  ok(has(factOnly.childLabels, '技术方案') && has(factOnly.childLabels, '功能测试'),
    `信息缺口不打断 ⇒ 后续阶段真的都跑了（实测 ${JSON.stringify(factOnly.childLabels)}）`)

  // ③ 纯缺省（PRD 没给 openQuestions）⇒ 同样直通
  const straight = await runScenario('confirm-none', { options: QA_OPTS })
  ok(straight.status !== 'interrupted' && straight.confirmSheet === null,
    `无待澄清项 ⇒ 直通（实测 status=${straight.status} / confirmSheet=${JSON.stringify(straight.confirmSheet)}）`)
  ok(has(straight.childLabels, '技术方案'), `无待澄清项 ⇒ 后续阶段真的都跑了（实测 ${JSON.stringify(straight.childLabels)}）`)

  // ④ **契约未兑现必须可见**（§7③）：模型没给 kind ⇒ 按 fact 处理（不暂停，依赖模型自律的判据在量出
  //    真阳性率前不得有阻断权），但**必须发 warn** —— 否则又是一次「静默空转、长期没人发现」。
  const untaggedRun = await runScenario('confirm-untagged', {
    options: QA_OPTS,
    prdOutput: prdWith([{ q: '没标 kind 的项', why: '?', changes: '?', default: '?' }]),
  })
  ok(untaggedRun.status !== 'interrupted', `没标 kind ⇒ 不暂停（实测 ${untaggedRun.status}）`)
  ok(untaggedRun.warnLogs.some((m) => /没标 kind/.test(String(m))),
    `没标 kind **必须发 warn**（实测 warn: ${JSON.stringify(untaggedRun.warnLogs).slice(0, 160)}）`)

  // ⑤ patch 档恒不生效（STAGE_POLICY：单 agent 直改，PRD 是机械的单点确认）
  const patchRun = await runScenario('confirm-patch', { options: PATCH_OPTS, prdOutput: prdWith([TASTE]) })
  ok(patchRun.status !== 'interrupted', `patch 档 + 有主观项 仍不暂停（实测 ${patchRun.status}）`)

  // ⑥ **内部强制位**（A/B 对照与端到端验证需要能强制开关）；它**不是工具参数**，
  //    由环境变量 TEAMFLOW_CONFIRM 注入 —— 产品路径永远是内容驱动。
  const forced = await runScenario('confirm-forced', { options: { ...QA_OPTS, confirmMode: 'always' }, prdOutput: prdWith([FACT]) })
  ok(forced.status === 'interrupted', `confirmMode=always ⇒ 只有信息缺口也停（实测 ${forced.status}）`)
  const never = await runScenario('confirm-never', { options: { ...QA_OPTS, confirmMode: 'never' }, prdOutput: prdWith([TASTE]) })
  ok(never.status !== 'interrupted' && has(never.childLabels, '技术方案'),
    `confirmMode=never ⇒ 有主观项也不停、照常往下跑（实测 ${never.status} / ${JSON.stringify(never.childLabels)}）`)

  // ④ 纯函数：结构化数据源 + 截断必须**诚实标注**（不静默截断）
  const sheet = buildConfirmSheet({
    summary: '一句话目标',
    acIndex: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`AC-${i + 1}`, `第 ${i + 1} 条`])),
    assumptions: Array.from({ length: 12 }, (_, i) => `假设 ${i + 1}`).join('\n'),
    runDocs: 'docs/teamflow/20261007-r1',
  })
  ok(sheet.ac.length === 12 && sheet.acTotal === 20, `AC 只列前 12 条但 acTotal 记 20（实测 ${sheet.ac.length}/${sheet.acTotal}）`)
  ok(sheet.assumptions.length === 8 && sheet.assumptionsTotal === 12, `假设同理（实测 ${sheet.assumptions.length}/${sheet.assumptionsTotal}）`)
  ok(sheet.docPath.endsWith('/PRD.md'), `docPath 指向 PRD 全文（实测 ${sheet.docPath}）`)
  ok(renderConfirmSheet(sheet, 'zh').split('\n').length <= 40, `渲染 ≤40 行（实测 ${renderConfirmSheet(sheet, 'zh').split('\n').length} 行）`)
  // 数据全缺 ⇒ 摘要薄但仍要暂停（缺假设恰恰最该让人看一眼）
  ok(buildConfirmSheet({}).ac.length === 0 && buildConfirmSheet({}).summary === '', '空输入不抛，产出空摘要（暂停与否由调用方判，与本函数无关）')

  // ⑦ **闭环**：确认单暂停 ⇒ `interruptedPhaseOf` 落在 design ⇒ 用该断点续跑，design 真跑且 PRD 被跳过
  const pausedFull = await runScenario('confirm-paused-full', { options: FULL_OPTS, prdOutput: prdWith([TASTE]) })
  ok(pausedFull.status === 'interrupted', `有主观项 + full ⇒ 停在 interrupted（实测 ${pausedFull.status}）`)
  ok(pausedFull.confirmSheet && typeof pausedFull.confirmSheet === 'object', '暂停时确认单落盘')
  const resumeAt = interruptedPhaseOf(pausedFull.journal)
  ok(resumeAt === 'design', `确认单暂停 ⇒ 断点 design（实测 ${resumeAt}）`)
  const afterResume = await runScenario('confirm-resumed', {
    options: { ...FULL_OPTS },
    resume: { phase: resumeAt, products: {} },
  })
  const kids = afterResume.childLabels.filter((l) => !/需求分诊|triage/i.test(String(l)))
  ok(has(kids, '设计说明'), `resume 后 design 真跑（实测 ${JSON.stringify(kids).slice(0, 150)}）`)
  ok(!has(kids, '梳理 PRD'), `PRD 被跳过（复用已完成产物）（实测 ${JSON.stringify(kids).slice(0, 150)}）`)

  // ⑧ AC 的**兜底与来源标注**（ADR-0011 C 方案）：`extra` 兑现率仅 ~20%（7/34 state.json）
  //    ⇒ 结构化优先、正文兜底、**来源必须自曝**（空壳比空更糟：会让人以为「没什么要注意的」）。
  const { extractAcIndexFromText } = await import(pathToFileURL(join(base, 'host/util.ts')).href)
  const acDoc = '| AC | 描述 |\n|---|---|\n| AC-1 | 徽章显示今日番茄数 |\n- **AC-2**：暂停不计\nAC-3 - 跨日归零'
  ok(extractAcIndexFromText(acDoc)['AC-1'] === '徽章显示今日番茄数', '抽取：表格首列形态')
  ok(extractAcIndexFromText(acDoc)['AC-2'] === '暂停不计', '抽取：加粗列表形态')
  ok(extractAcIndexFromText(acDoc)['AC-3'] === '跨日归零', '抽取：裸 `AC-n - 描述` 形态')
  ok(extractAcIndexFromText('普通段落，没有任何 AC 特征') === null, '抽取：无特征 → null（**不瞎编**）')
  ok(extractAcIndexFromText('') === null && extractAcIndexFromText(null) === null && extractAcIndexFromText(undefined) === null, '抽取：空/null/undefined → null（不炸）')
  const manyAc = Array.from({ length: 60 }, (_, i) => `| AC-${i + 1} | 第 ${i + 1} 条 |`).join('\n')
  ok(Object.keys(extractAcIndexFromText(manyAc)).length === 40, `抽取：上限 40 条（实测 ${Object.keys(extractAcIndexFromText(manyAc)).length}）`)
  // ⑨ **真实语料逼出来的两条规则**（2026-10-07，拿 21 份真实 PRD.md 量出来的）：
  //    · 最常见的故事表是 `| 用户故事 | AC-1: … |`（AC 在**第二列**）—— 只锚行首会漏（实测 tf-obs-r3 漏 4/4）；
  //    · `| Accept | AC-1…AC-8 | export …` 是**区间引用行**，不是 AC 正文 ⇒ 不得造出 `AC-1 = "…AC-8"` 的垃圾条目。
  const storyTable = '| 故事 | 验收标准 |\n|------|----------|\n| 用户可添加任务 | AC-1: 输入后立即出现 |\n| 用户可勾选任务 | AC-2: 点击后标记完成 |'
  const stGot = extractAcIndexFromText(storyTable)
  ok(stGot && stGot['AC-1'] === '输入后立即出现' && stGot['AC-2'] === '点击后标记完成', `抽取：**表格第二列** \`| 故事 | AC-1: … |\`（真实产物最常见形态，实测 ${JSON.stringify(stGot)}）`)
  ok(extractAcIndexFromText('| Accept | AC-1…AC-8 | export + unit table |') === null, '抽取：区间引用行 → null（AC 后不是冒号 ⇒ 不命中，不造垃圾条目）')

  const fromState = buildConfirmSheet({ acIndex: { 'AC-1': '结构化' }, prdText: '| AC-9 | 正文里的 |' })
  ok(fromState.acSource === 'state' && fromState.ac[0].id === 'AC-1', '结构化有值 ⇒ 用它，来源=state（不被正文覆盖）')
  const fromText = buildConfirmSheet({ acIndex: {}, prdText: acDoc })
  ok(fromText.acSource === 'extracted' && fromText.ac.length === 3, `结构化空 ⇒ 正文兜底（实测来源=${fromText.acSource} 条数=${fromText.ac.length}）`)
  ok(renderConfirmSheet(fromText, 'zh').includes('从 PRD 正文抽取'), '**抽取来的必须自曝来源**（否则用户分不清结构化与抽来的）')
  const noAc = buildConfirmSheet({ acIndex: {}, prdText: '没有任何 AC' })
  ok(noAc.acSource === 'none' && noAc.ac.length === 0, '两处都无 ⇒ 来源=none')
  ok(renderConfirmSheet(noAc, 'zh').includes('没抓到验收条件'), '**none 也要显式告警**（不能静默留空段落骗人）')
  ok(renderConfirmSheet(noAc, 'zh').split('\n').length <= 40, `无 AC 时仍 ≤40 行（实测 ${renderConfirmSheet(noAc, 'zh').split('\n').length}）`)
}

/* ── [21] 确认单暂停后的**续跑**：断点必须可续 —— 不得被「已记录阶段全 done」这条伪代理误判 ──
 * 实锤 tf-muy63zgy-octoqj（2026-10-07，真实桌面版）：确认单**如期暂停**（`stages` 只有 `[prd done]`，
 * P0 修复生效），但 `resumeRun` 里一条更早的守卫用「所有**已记录**的阶段都 done」当「全流程跑完」的
 * 代理判据 ⇒ 该形态下**恒真** ⇒ 断点被误判成「无」，用户续跑被当场拒绝
 * （而 `interruptedPhaseOf` 明明返回 `design`）。同一个「中途暂停」形态在 `interruptedPhaseOf` 里
 * 已于今天修过（第二层），**这处漏了** —— 同型「只修一处、漏另一处」。
 * 本组锁两个方向：① 该形态**必须可续**；② 真·全部完成（含 acceptance done）**仍必须拒绝**（防改过头）。 */
console.log('\n[21] 确认单暂停后的续跑：断点可续（不得被「已记录阶段全 done」误判）')
{
  const home = join(tmpdir(), 'tf-orch-confirm-resume')
  process.env.DSH_HOME = home
  const mk = (ws, id, stages, options) => {
    const dir = join(home, 'teamflow', ws, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, requirement: '验证确认单后的续跑', status: 'interrupted', locale: 'zh',
      workspace: ws, logs: [], options, stages,
    }), 'utf8')
  }
  // ① 确认单形态：PRD done、其后一个都没跑（medium + needDesign ⇒ design/tech/dev/qa/acceptance 均启用）
  mk('ws-confirm-pause', 'tf-confirm-pause', [{ phase: 'prd', status: 'done' }], { mode: 'medium', needDesign: true, needScaffold: false })
  const r1 = resumeRun('tf-confirm-pause', null)
  ok(r1.ok === false && !/无断点可续/.test(String(r1.error)),
    `确认单暂停（stages=[prd done]）⇒ **不得**判「无断点」（此处因无 agent 停在 agentNotFound，实测 ${String(r1.error).slice(0, 80)}）`)
  // ② 对照：真·全部完成（acceptance 也 done）⇒ 仍必须硬拒绝（tf-mt8kxyef 那条保护不能被改没）
  const allDoneStages = ['prd', 'design', 'tech', 'dev', 'qa', 'acceptance'].map((p) => ({ phase: p, status: 'done', taskKey: 'T1' }))
  mk('ws-confirm-all', 'tf-confirm-all', allDoneStages, { mode: 'medium', needDesign: true })
  const r2 = resumeRun('tf-confirm-all', null)
  ok(r2.ok === false && /无断点可续/.test(String(r2.error)),
    `对照：全阶段（含 acceptance）done ⇒ 仍拒绝续跑（实测 ${String(r2.error).slice(0, 80)}）`)
  rmSync(home, { recursive: true, force: true })
}

/* ── [22] 同一 run 内 state 必须刷新：PRD 写下的 `extra.*` 要**当场**被后续消费者看到 ──
 * 实锤 tf-muy63zgy-octoqj（2026-10-07 真实桌面版）：磁盘 `state.json` 里 `acIndex` 9 条、
 * `product.summary` 有值，而同一次 run 的确认单却是 `acSource=extracted`、`summary=''`。
 * 根因：`mergeStateBlock` 是 load→改→save→**返回新对象**，而调用点丢了返回值 ⇒ 内存里的 `state`
 * 停在**起跑快照** ⇒ 本次 run 里 PRD 写的东西，**同一 run 的 design/tech/qa/acceptance 与确认单全都看不见**
 * （要等下一次 run 从磁盘载入才可见，即「晚一个 run」）。这是既有缺陷，确认单把它放大成可见故障。
 * 变异：把调用改回「丢弃返回值」⇒ 本组 3 条立刻全红。 */
console.log('\n[22] 同一 run 内 state 刷新：PRD 的 extra.* 当场可见（不得等到下一次 run）')
{
  const NESTED = {
    phase: 'prd', summary: 'PRD 阶段摘要', memory: [],
    extra: {
      acIndex: { 'AC-1': '结构化 AC 一', 'AC-2': '结构化 AC 二' },
      summary: '一句话目标',
      openQuestions: [{ q: '要问吗', why: '因为会影响 AC-1', changes: '改 AC-1' }],
    },
  }
  const r = await runScenario('state-refresh', {
    // 本组考的是**同一 run 内 state 刷新**，与确认单的触发判据无关 ⇒ 用 `always` 强制暂停，
    // 免得 NESTED 的 kind 一改就把这条断言连带弄红（判据由 [20] 单独钉）。
    options: { ...FULL_OPTS, confirmMode: 'always' },
    prdOutput: `${LONG}\n<!-- state -->${JSON.stringify(NESTED)}<!-- /state -->`,
  })
  const sheet = r.confirmSheet
  ok(sheet && sheet.acSource === 'state' && sheet.ac.length === 2,
    `PRD 的 extra.acIndex **当场**进确认单（实测来源=${sheet && sheet.acSource} 条数=${sheet && sheet.ac && sheet.ac.length}）`)
  ok(sheet && sheet.summary === '一句话目标', `extra.summary 当场可见（实测 ${JSON.stringify(sheet && sheet.summary)}）`)
  ok(sheet && sheet.questions && sheet.questions.length === 1, `extra.openQuestions 当场可见（实测 ${sheet && sheet.questions && sheet.questions.length}）`)

  // ② 不暂停跑完整条：**后续阶段的 prompt** 里必须带上本 run PRD 写下的 state（两条不同的注入面）。
  // `confirmMode: 'never'` 是**刻意**的：本组考的是 state 注入面，不该与确认单的内容判据耦合 ——
  // 否则判据一改，这两条对照断言会跟着变红（变异实测过），control 就不再是 control。
  const full = await runScenario('state-refresh-full', {
    options: { ...FULL_OPTS, confirmMode: 'never' },
    prdOutput: `${LONG}\n<!-- state -->${JSON.stringify(NESTED)}<!-- /state -->`,
  })
  const promptOf = (kw) => {
    const hit = Object.entries(full.promptsByLabel || {}).find(([l]) => String(l).includes(kw))
    return hit ? String(hit[1]) : ''
  }
  const designPrompt = promptOf('设计说明')
  const qaPrompt = promptOf('QA 测试')
  // `__runCtx.runDocs` 是**运行期字段**（loadState 不搬运）⇒ PRD 的 state 合并后若不带回，这里会整条消失
  ok(/【本次任务产物夹】/.test(designPrompt), 'design 阶段 prompt 仍带「任务产物夹」注入（__runCtx 未被 state 合并冲掉）')
  // `state.acIndex` 只注入 pm/qa/acceptance/tech 四角色 ⇒ QA 的 prompt 是这条链的证据面
  ok(/AC 索引/.test(qaPrompt) && /结构化 AC 一/.test(qaPrompt), 'QA 阶段 prompt 带上**本 run PRD** 写的 AC 索引（不是上一次 run 的遗留）')
}

/* ── [23] 确认单断点上的「改」：带 supplement 续跑 ⇒ **回退重跑 PRD**（作废面为零）──
 * 2026-10-08 用户实锤：确认单那条 AUQ 选项写着「我再更新确认单后开工」，而 `supplement` 在断点晚于 PRD 时
 * 被**明确拒绝** ⇒ 承诺无法兑现（**假承诺比「不能改」更糟**：用户以为能改，点完才发现要么重开、要么白跑）。
 * 唯一安全的例外：**PRD 之后一个阶段都没跑过**（`stages` 只有 prd）⇒ 回退重跑 PRD 不浪费任何已产出物。
 * 本组锁两个方向：① 该形态**必须接受**且检查点真的回到 prd（PRD 真跑、补录以 [REVISED] 进 prompt、
 * 旧确认单作废）；② 对照组（PRD 之后已有阶段跑过）**仍必须拒绝**（防改过头，白作废下游产物）。 */
console.log('\n[23] 确认单断点带补录续跑 ⇒ 回退重跑 PRD；PRD 之后有阶段跑过 ⇒ 仍拒绝')
{
  const home = join(tmpdir(), 'tf-orch-redo-prd')
  process.env.DSH_HOME = home
  const work = join(home, 'work')
  mkdirSync(work, { recursive: true })
  const seen = []
  // `resumeRun` 要能从 runtime.agents 取到 agent（测试 [21] 那里取不到 ⇒ 只能观测到「被拒/放行」，
  // 观测不到回退是否真的发生）。这里给它一个假 agent，才能把「PRD 真的重跑了」断言出来。
  const fakeParent = {
    session: { id: 'sid-redo', header: { cwd: work }, append() {} },
    status: 'idle', followup() {}, inject() {}, options: {},
  }
  setRuntime({ get: (sid) => (sid === 'sid-redo' ? fakeParent : undefined) }, {
    start: async (_p, init) => {
      const label = String((init && init.label) || '')
      seen.push({ label, prompt: String((init && init.prompt && init.prompt[0] && init.prompt[0].text) || '') })
      return {
        id: `c-${seen.length}`, localAgent: { session: null },
        result: (async () => ({ stopReason: 'completed', output: [{ type: 'text', text: '' }] }))(),
        dispose: async () => {},
      }
    },
  })
  const mk = (ws, id, stages) => {
    const dir = join(home, 'teamflow', ws, 'runs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.json`), JSON.stringify({
      id, requirement: '桌宠', status: 'interrupted', locale: 'zh',
      workspace: ws, workspacePath: work, logs: [],
      options: { mode: 'medium', needDesign: false, needScaffold: false },
      stages, humanIntervention: true, interrupted: true, interruptedAt: Date.now(),
      confirmSheet: { summary: '旧确认单', ac: [], questions: [], assumptions: [], at: 1 },
    }), 'utf8')
  }

  // ① 确认单形态（只有 prd done）＋ supplement ⇒ 接受，检查点回退到 prd
  mk('ws-redo', 'tf-redo', [{ phase: 'prd', status: 'done', output: '旧 PRD' }])
  const r1 = resumeRun('tf-redo', 'sid-redo', '形象改成手绘 SVG，不要 emoji')
  ok(r1.ok === true && r1.resumedFrom === 'prd',
    `确认单断点 + supplement ⇒ **接受**并回退到 prd（实测 ok=${r1.ok} from=${r1.resumedFrom} err=${String(r1.error || '').slice(0, 60)}）`)
  // ⚠️ `resumeRun` 里的 executePipeline 是**不 await** 的（fire-and-forget）⇒ 同步断言跑在流水线
  // 到达 PRD 之前。这里给一个有界等待（最多 ~1.2s；拿到 PRD 子代理就立刻继续，不固定睡满）。
  for (let i = 0; i < 60 && !seen.some((c) => /梳理 PRD/.test(String(c.label))); i++) {
    await new Promise((r) => setTimeout(r, 20))
  }
  ok(seen.some((c) => /梳理 PRD/.test(String(c.label))),
    `PRD **真的重跑了**（不是复用旧产物）（实测子代理 ${JSON.stringify(seen.map((c) => c.label)).slice(0, 120)}）`)
  ok(seen.some((c) => /\[REVISED —/.test(String(c.prompt))),
    '补录以 **[REVISED]** 块进了 PRD prompt（与澄清轮 [CLARIFIED] 分叉；不是静默丢弃）')
  ok(!seen.some((c) => /\[CLARIFIED —/.test(String(c.prompt))),
    '对照：回退路径**不得**误用 [CLARIFIED]（那会让模型去找当时还不存在的「待澄清清单」）')
  // 文件读放在等待之后：此时新 PRD 已至少尝试过一次 ⇒ 记录已重建。
  const after = JSON.parse(readFileSync(join(home, 'teamflow', 'ws-redo', 'runs', 'tf-redo.json'), 'utf8'))
  ok(after.confirmSheet === null || after.confirmSheet === undefined,
    `旧确认单已作废（它描述的是被替换掉的那份 PRD）（实测 ${JSON.stringify(after.confirmSheet)}）`)
  // 行为断言「旧 prd 记录真的被摘掉了」：源码锁只能锁住那行 `.filter(...)` 存在，
  // 锁不住它**生效**。判据用**旧产物原文**（`output: '旧 PRD'`）：留着就说明记录没摘。
  ok(!(after.stages || []).some((s) => String(s.output || '') === '旧 PRD'),
    `回退时旧 prd 记录已摘掉（否则同阶段两条记录，报告与断点定位都按「每阶段一条」读）（实测 ${JSON.stringify((after.stages || []).map((s) => s.status))}）`)

  // ② 对照：PRD 之后**已经有阶段跑过** ⇒ 仍必须拒绝（回退会白作废它们的产物）
  mk('ws-late', 'tf-late', [{ phase: 'prd', status: 'done', output: 'x' }, { phase: 'design', status: 'done', output: 'y' }])
  const r2 = resumeRun('tf-late', 'sid-redo', '改一下')
  ok(r2.ok === false && /补录被拒绝/.test(String(r2.error)),
    `对照：PRD 之后已有阶段跑过 ⇒ 仍**拒绝**补录（实测 ${String(r2.error).slice(0, 70)}）`)
  rmSync(home, { recursive: true, force: true })
}

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n✅ 编排行为测试全部通过')
