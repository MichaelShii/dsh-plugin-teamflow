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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
  { options, resume = null, emptyNext = false, failLabel = null, artifacts = null, cancelAfter = 0, triage = null, extraFiles = 0 },
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
    children.push({ id: `c-${children.length + 1}`, label })
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
    timelineKeys: Object.keys((journal.result && journal.result.timeline) || {}).sort(),
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

if (failed) {
  console.error(`\n❌ ${failed} 项断言失败`)
  process.exit(1)
}
console.log('\n✅ 编排行为测试全部通过')
