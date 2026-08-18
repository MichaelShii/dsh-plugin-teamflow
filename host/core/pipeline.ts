/**
 * dsh-plugin-teamflow core — 流水线编排中枢（阶段执行 / 入口 / 取消 / 断点续跑）。
 * 依赖：context/backlog/metering/runner/report + prompts + util/constants/types + store。
 * 【mode 策略路由】后续 triage（P/L/T/M/F）将在这里挂 MODE_REGISTRY（策略表），
 * 取代 executePipeline 内散落的 if/else——见 ADR-0004 与 docs/adr/0004。
 */
import { runtime, runs, inFlight, activeProducts, providerName, workspaceScopeOf } from './context.ts'
import { initPipelineBacklog, advanceTask, storeFor, parseDefects, noteTaskStageUsage, noteTaskAssign, createSubtask, completeSubtask, noteSubtaskUsage, getSubtasks } from './backlog.ts'
import { withRetry, runPool } from './runner.ts'
import { deliverCompletion } from './report.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, devPrompt, qaPrompt, acceptancePrompt, techChangePrompt, patchConfirmPrompt } from '../prompts/index.ts'
import { clip, normalizeRoot, normalizeTasks, sanitizeSnapOptions } from '../util.ts'
import { RETRY_LIMIT, PHASE_ORDER, PHASE_KEY_BY_NAME } from '../constants.ts'
import { persistJournal, readJsonAny, journalFile } from '../../store.ts'
import type { JournalRecord } from '../../store.ts'
import type { Journal, PipelineOptions, ResumeContext } from '../types.ts'
import { normalizeMode, runTriage } from './triage.ts'
import { loadTeams, findTeam, getActiveStages } from './teams.ts'

/** 从 journal 已完成阶段重建断点续跑产物（prd/design/scaffold/tech/qa/acceptance/dev）。 */
export function buildResumeProducts(journal) {
  const products: Record<string, unknown> = {}
  for (const s of journal.stages) {
    if (s.status !== 'done' || !s.output) continue
    const key = PHASE_KEY_BY_NAME[s.phase]
    if (!key) continue
    if (key === 'dev') {
      products.dev = journal.stages
        .filter((x) => x.phase === '开发' && x.status === 'done' && x.output)
        .map((x) => ({ title: x.label.replace(/^开发 · /, ''), failed: false, output: x.output }))
    } else {
      products[key] = s.output
    }
  }
  return products
}

/**
 * 断点续跑起点：journal 中第一个未完成阶段（磁盘上 interrupted/running 所在阶段）。
 * 全部完成仍被中断（理论极端）→ 从产品验收继续。
 */
export function interruptedPhaseOf(journal) {
  const stage = (journal.stages || []).find((s) => s.status !== 'done')
  if (stage && PHASE_ORDER.indexOf(stage.phase) !== -1) return stage.phase
  return '产品验收'
}

/**
 * 执行流水线。resume = null 全新运行；resume = { phase, products } 从断点续跑：
 * phase 之前的阶段直接复用 products 产物（跳过执行），从 phase 阶段开始重跑。
 */
export async function executePipeline(
  journal: Journal, parent: unknown, requirement: string, options: PipelineOptions,
  signal: unknown, resume: ResumeContext | null = null,
): Promise<void> {
  journal.status = 'running'
  if (!resume) journal.startedAt = Date.now()
  const root = options.productRoot || null
  journal.product = root
  // 工作区（项目）作用域：workspace slug 同时是并发锁与 backlog 的隔离键
  const scopeKey = journal.workspace || root || 'default'
  // 产品级并发限制（防御：正常入口 startPipeline/resumeRun 已预检；按工作区隔离，互不阻塞）
  if (activeProducts.has(scopeKey) && activeProducts.get(scopeKey) !== journal.id) {
    journal.status = 'failed'
    journal.error = `工作区 ${journal.workspacePath || scopeKey} 已有流水线 ${activeProducts.get(scopeKey)} 运行中`
    journal.endedAt = Date.now()
    persistJournal(journal)
    return
  }
  activeProducts.set(scopeKey, journal.id)
  // 自动分诊（对调用方透明）：未显式 mode 且非 lite 且非续跑 → 内部先用模型思考一轮再路由。
  // 使用者无需了解/选择 mode；mode 是内部路由 + 可选显式覆盖（审计可见）。
  if (options.mode === undefined && !options.lite) {
    try {
      const verdict = await runTriage(requirement, { needDesign: options.needDesign }, parent, signal)
      options.mode = verdict.mode
      if (verdict.needDesign && !options.needDesign) options.needDesign = true
      journal.options = Object.assign({}, options) as Record<string, unknown>
      journal.logs.push({ t: Date.now(), level: 'info', message: `自动分诊：${verdict.kind} → ${verdict.mode}（source=${verdict.source}）` })
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `自动分诊失败，按默认完整流程：${String((e && e.message) || e)}` })
    }
  }
  const tasks = normalizeTasks(options.tasks)
  const maxConcurrency = Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, 8) : 3
  const timeline: Record<string, unknown> = {}
  // 团队配置：加载团队的阶段列表，确定哪些阶段跳过（optional + 未启用）
  let activeStageKeys: Set<string> | null = null
  if (options.teamId) {
    const teams = loadTeams(journal.workspace || 'default')
    const team = findTeam(teams, options.teamId)
    if (team) {
      const active = getActiveStages(team, { needDesign: options.needDesign, needScaffold: options.needScaffold })
      activeStageKeys = new Set(active.map((s) => s.key))
      journal.logs.push({ t: Date.now(), level: 'info', message: `团队「${team.name}」：阶段 ${active.map((s) => s.label).join(' → ')}` })
    }
  }
  const stageEnabled = (key: string) => !activeStageKeys || activeStageKeys.has(key)
  // 断点续跑：跳过 resume.phase 之前的阶段
  const resumed = (phase) => !!resume && PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(resume.phase)
  const logSkip = (phase) => journal.logs.push({ t: Date.now(), level: 'warn', message: `跳过已完成阶段：${phase}（断点续跑）` })
  try {
    if (resume) {
      journal.logs.push({ t: Date.now(), level: 'info', message: `断点续跑：复用 backlog（req=${journal.reqId}），从「${resume.phase}」继续` })
    } else {
      const init = initPipelineBacklog(journal, requirement, options)
      journal.reqId = init.reqId
      journal.logs.push({ t: Date.now(), level: 'info', message: `backlog 已建立需求 ${init.reqId}（产品 ${root || 'unknown'}，并发 ${maxConcurrency}）` })
    }
    persistJournal(journal)

    /* ── PRD 阶段 ── */
    let prd = null
    if (resumed('PRD 产品需求')) {
      prd = resume.products.prd
      timeline.prd = prd
      logSkip('PRD 产品需求')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：PRD 产品需求' })
      const pForm = options.mode === 'tech'
        ? { label: '技术负责人 · 出技术变更单', fn: techChangePrompt }
        : options.mode === 'patch'
          ? { label: '工程师 · 单点确认', fn: patchConfirmPrompt }
          : { label: '产品经理 · 梳理 PRD', fn: prdPrompt }
      const prdR = await withRetry(journal, parent, pForm.label, 'PRD 产品需求', pForm.fn(requirement, root, journal.id), signal)
      if (!prdR.text) { throw new Error(`PRD 阶段失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      prd = prdR.text
      timeline.prd = prd
      noteTaskStageUsage(journal) // PRD 角色的真实 token 累计到任务卡
      if (journal.cancelled) return
    }

    /* ── UI/UX 设计阶段 ── */
    let design = null
    if (stageEnabled('design') && options.needDesign && !options.lite) {
      if (resumed('UI/UX 设计')) {
        design = resume.products.design
        timeline.design = design
        logSkip('UI/UX 设计')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：UI/UX 设计' })
        const designR = await withRetry(journal, parent, 'UI/UX 设计师 · 设计说明', 'UI/UX 设计', designPrompt(prd, root, journal.id), signal)
        if (!designR.text) { throw new Error(`UI/UX 设计失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        design = designR.text
        timeline.design = design
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 架构规划阶段 ── */
    let scaffold = null
    if (stageEnabled('scaffold') && options.needScaffold) {
      if (resumed('架构规划')) {
        scaffold = resume.products.scaffold
        timeline.scaffold = scaffold
        logSkip('架构规划')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：架构规划' })
        const scR = await withRetry(journal, parent, '架构师 · 脚手架规划与落地', '架构规划', scaffoldPrompt(requirement, design, root, journal.id), signal)
        if (!scR.text) { throw new Error(`架构规划失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        scaffold = scR.text
        timeline.scaffold = scaffold
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 技术方案阶段 ── */
    let tech = null
    if (options.lite || options.mode === 'tech' || options.mode === 'patch') {
      // lite/tech/patch 模式：跳过独立技术方案文档阶段 —— 以「PRD/变更单 + 任务卡」为契约
      journal.logs.push({ t: Date.now(), level: 'info', message: `${options.mode || 'lite'} 模式：跳过独立技术方案阶段（PRD/变更单即契约）` })
    } else if (resumed('技术方案')) {
      tech = resume.products.tech
      timeline.tech = tech
      logSkip('技术方案')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：技术方案' })
      const techR = await withRetry(journal, parent, '高级全栈工程师 · 技术方案', '技术方案', techPrompt(prd, design, scaffold, tasks, root, journal.id), signal)
      if (!techR.text) { throw new Error(`技术方案失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      tech = techR.text
      timeline.tech = tech
      noteTaskStageUsage(journal)
      if (journal.cancelled) return
    }

    /* ── 开发阶段（并发池；resume 到 QA/验收时复用旧结果） ── */
    let devResults = null
    if (resumed('开发')) {
      devResults = resume.products.dev || []
      timeline.dev = devResults
      logSkip('开发')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：开发' })
      const devTaskDefs = tasks.length > 0 ? tasks : [{ title: '整体开发', spec: '按技术方案实现全部需求' }]
      journal.logs.push({ t: Date.now(), level: 'info', message: `开发阶段开始，任务数：${devTaskDefs.length}（并发 ${maxConcurrency}）` })
      advanceTask(journal, 'running', null, '开发开始（待办 → 开发中）', { by: 'dev' })
      // 为每个 dev 子任务建一张子卡（并行 agent 各自独立跟踪）
      const subCards = devTaskDefs.map((dt) => createSubtask(journal, dt.title, dt.spec))
      devResults = await runPool(devTaskDefs, maxConcurrency, async (task, idx) => {
        const sub = subCards[idx]
        if (sub) {
          completeSubtask(journal, sub.id, false, null, null) // 先标记 running（end 由 complete 设）
          const store = storeFor(scopeKey)
          const subLive = store.find('task', sub.id)
          if (subLive) { subLive.status = 'running'; subLive.startedAt = Date.now(); store.persist(); persistJournal(journal) }
        }
        const devR = await withRetry(journal, parent, `开发 · ${task.title}`, '开发', devPrompt(task, tech, prd, root, journal.id), signal)
        const ok = !!devR.text
        // 完成子卡：记录状态 + childId + 摘要
        if (sub) {
          completeSubtask(journal, sub.id, !ok, devR.text ? clip(devR.text, 300) : null, null)
          // 把对应 stage 的 usage 累计到子卡
          const devStage = journal.stages.filter((s) => s.phase === '开发').pop()
          if (devStage) noteSubtaskUsage(journal, sub.id, devStage)
        }
        return { title: task.title, failed: !ok, output: devR.text || '开发失败（Agent 未产出结果）' }
      })
      timeline.dev = devResults
      // 累计全部 dev stage usage 到主卡（汇总）
      noteTaskStageUsage(journal)
      const devStages = journal.stages.filter((s) => s.phase === '开发')
      noteTaskAssign(journal, 'dev', devStages.map((s) => s.childId).filter(Boolean).join(',') || '开发组')
      const failedCount = devResults.filter((r) => r && r.failed).length
      if (failedCount > 0) {
        advanceTask(journal, 'needs-human', null, '开发失败，需人工介入', { by: 'dev' })
        const req = storeFor(scopeKey).find('req', journal.reqId)
        if (req) { req.humanIntervention = true; storeFor(scopeKey).persist() }
        journal.logs.push({ t: Date.now(), level: 'warn', message: `开发完成，失败任务数：${failedCount}（需人工介入）` })
      } else {
        advanceTask(journal, 'testable', null, '开发完成待测试（开发中 → 待测试）', { by: 'dev' })
        journal.logs.push({ t: Date.now(), level: 'info', message: `开发完成，失败任务数：0（任务置为待测试，可指派 QA）` })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── QA 测试阶段 ── */
    let qa = null
    if (!stageEnabled('qa') || options.mode === 'patch') {
      // 团队无 QA 阶段 或 patch 档：跳过独立 QA
      journal.logs.push({ t: Date.now(), level: 'info', message: 'patch 模式：跳过独立 QA（单点修复，开发自测兜底）' })
      qa = 'patch 档：独立 QA 跳过（单点修复，开发自测兜底）'
    } else if (resumed('QA 测试')) {
      qa = resume.products.qa
      timeline.qa = qa
      logSkip('QA 测试')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：QA 测试' })
      advanceTask(journal, 'testing', null, 'QA 开始（待测试 → 测试中）', { by: 'qa' })
      const qaR = await withRetry(journal, parent, 'QA 测试工程师 · 功能测试', 'QA 测试', qaPrompt(prd, JSON.stringify(timeline.dev), root, journal.id), signal)
      if (!qaR.text) { advanceTask(journal, 'needs-human', null, 'QA 失败', { by: 'qa' }); throw new Error(`QA 失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      qa = qaR.text
      timeline.qa = qa
      noteTaskStageUsage(journal) // QA 角色的真实 usage 累计
      const qaStages = journal.stages.filter((s) => s.phase === 'QA 测试')
      noteTaskAssign(journal, 'qa', qaStages.map((s) => s.childId).filter(Boolean).join(',') || '测试组')
      advanceTask(journal, 'pending-acceptance', clip(qa, 300), 'QA 完成（测试中 → 待验收）', { by: 'qa' })
      const store = storeFor(scopeKey)
      const defects = parseDefects(qa)
      if (defects.length > 0) {
        const req = store.find('req', journal.reqId)
        defects.slice(0, 8).forEach((d) => {
          const id = store.nextId('bug')
          const b = { id, reqId: journal.reqId, taskId: journal.taskId || null, severity: d.severity, title: `QA 缺陷：${d.module || d.id}`, reproduce: '', expected: '', actual: '', ac: '', status: 'open', owner: null, retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(), events: [] }
          store.bugs.push(b)
          if (req) { req.bugIds.push(id); req.status = 'pending-acceptance'; req.updatedAt = Date.now() }
        })
        store.persist()
        journal.logs.push({ t: Date.now(), level: 'warn', message: `QA 发现 ${defects.length} 个缺陷，已登记到 backlog（需开发认领）` })
      } else {
        journal.logs.push({ t: Date.now(), level: 'info', message: 'QA 未发现 P0/P1/P2 缺陷（未登记 Bug）' })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── 产品验收阶段（总是执行） ── */
    journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：产品验收' })
    // 单任务模型：验收前任务置「待验收」（patch/无独立 QA 时 task 仍在 testable）
    {
      const curTask = storeFor(scopeKey).find('task', journal.taskId)
      if (curTask && curTask.status !== 'pending-acceptance' && curTask.status !== 'needs-human' && curTask.status !== 'rework') {
        advanceTask(journal, 'pending-acceptance', null, '进入验收（待验收）', { by: 'pm' })
      }
    }
    const accR = await withRetry(journal, parent, '产品经理 · 最终验收', '产品验收', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root, journal.id), signal)
    if (!accR.text) { advanceTask(journal, 'needs-human', null, '验收失败', { by: 'pm' }); throw new Error(`验收失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
    const acceptance = accR.text
    timeline.acceptance = acceptance
    noteTaskStageUsage(journal) // 验收角色的真实 usage 累计
    // 结论解析（顺序重要：reject 先于 rework——验收核对表里逐条的 ❌ 标记不能抢先判成 rework；
    // 「📝 需求不适用」等是验收负责人的整体结论，是更强的信号）
    const accVerdict = /📝\s*需求不适用|需求与实际不符|需求站不住|无需改动|无需修改|需求无效/.test(acceptance) ? 'reject'
      : /❌|不通过|需返工|未通过/.test(acceptance) ? 'rework'
      : 'accepted'
    if (accVerdict === 'reject') {
      // 需求与现状不符（无有效变更）→ 拦截：task needs-human、req needs-human、流水线中断（非 accepted）
      advanceTask(journal, 'needs-human', clip(acceptance, 300), '需求与现状不符（无需改动），需人工决定调整或取消需求', { by: 'pm' })
      const store = storeFor(scopeKey)
      const req = store.find('req', journal.reqId)
      if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', '需求与现状不符，需人工处理（调整或取消）') }
      journal.logs.push({ t: Date.now(), level: 'error', message: '需求与现状不符（无需改动），流水线中断，需人工处理' })
      persistJournal(journal)
      throw new Error('需求与现状不符，无需改动，需人工决定调整或取消需求')
    }
    advanceTask(journal, accVerdict, clip(acceptance, 300), accVerdict === 'rework' ? '验收不通过（需返工）' : '验收完成（待验收 → 已验收）', { by: 'pm' })
    const store = storeFor(scopeKey)
    const req = store.find('req', journal.reqId)
    if (req) {
      const openBugs = store.bugs.filter((b) => b.reqId === req.id && b.status !== 'verified' && b.status !== 'closed')
      if (accVerdict === 'rework') {
        req.humanIntervention = true
        store.pushEvent(req, req.status, 'needs-human', '验收不通过（需返工）')
      } else if (openBugs.length > 0) {
        store.pushEvent(req, req.status, 'pending-acceptance', '存在未关闭缺陷')
      } else {
        store.pushEvent(req, req.status, 'accepted', '验收通过')
      }
    }
    journal.logs.push({ t: Date.now(), level: 'info', message: '流水线全部完成 ✅' })
    journal.status = 'completed'
  } catch (e) {
    if (journal.cancelled) {
      journal.status = 'cancelled'
      journal.error = '运行已取消'
    } else {
      journal.status = 'failed'
      journal.error = String((e && e.message) || e)
    }
  } finally {
    journal.endedAt = Date.now()
    inFlight.delete(journal.id)
    activeProducts.delete(scopeKey) // 释放工作区级并发锁
    journal.result = { requirement, options: sanitizeSnapOptions(options), timeline: summarizeTimeline(timeline) }
    for (const s of journal.stages) delete s.output // 内存只留摘要（磁盘 journal 已持久化全文）
    persistJournal(journal) // 终态 checkpoint（含日志刷新）
    deliverCompletion(journal, parent) // 汇总投递回发起会话（主线程）
    console.log(`[teamflow] 运行结束 ${journal.id} → ${journal.status}（工作区 ${scopeKey}）`)
  }
}

/** 结果 timeline 摘要化（内存只留 2k 级摘要，全文在磁盘 journal/backlog）。 */
export function summarizeTimeline(timeline) {
  const out = {}
  for (const key of Object.keys(timeline || {})) {
    const val = timeline[key]
    if (Array.isArray(val)) {
      out[key] = val.map((x) => (x && typeof x === 'object'
        ? { title: x.title, failed: !!x.failed, output: clip(x.output || '', 2000) }
        : clip(x, 2000)))
    } else {
      out[key] = clip(val, 2000)
    }
  }
  return out
}

/** 启动流水线：预检 + 建 journal + 异步 executePipeline（按发起会话的工作区绑 scope）。 */
export function startPipeline(agent: unknown, requirement: string, options: PipelineOptions, signal: unknown): string {
  const provider = providerName()
  if (!provider) throw new Error('没有可用的子代理提供者（subagents 注册表为空）')
  const ws = workspaceScopeOf(agent)
  const productKey = ws.projectKey
  const active = activeProducts.get(productKey)
  if (active) throw new Error(`工作区 ${ws.path || ws.projectKey} 已有流水线 ${active} 运行中——请等待完成、取消（teamflow_cancel）或先处理中断（teamflow_resume）`)
  // mode：显式指定 / lite 兼容 / 否则留空 → 由 executePipeline 自动分诊（对调用方透明）
  const mode = normalizeMode(options.mode) ?? (options.lite ? 'lite' : undefined)
  const journal = {
    id: `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'teamflow-pipeline', status: 'pending',
    requirement: clip(requirement, 8000),
    workspace: ws.projectKey,
    workspacePath: ws.path,
    product: normalizeRoot(options.productRoot),
    options: {
      needDesign: !!options.needDesign,
      needScaffold: !!options.needScaffold,
      lite: !!options.lite,
      mode,
      teamId: options.teamId || undefined,
      tasks: normalizeTasks(options.tasks),
      productRoot: normalizeRoot(options.productRoot),
      maxConcurrency: (Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0) ? Math.min(options.maxConcurrency, 8) : null,
    },
    startedAt: null, endedAt: null, agentsStarted: 0,
    stages: [], logs: [], result: null, error: null, cancelled: false, humanIntervention: false,
    interrupted: false, interruptedAt: null, supersededBy: null,
  }
  runs.set(journal.id, journal)
  if (runs.size > 30) {
    const firstKey = runs.keys().next().value
    if (firstKey !== undefined) runs.delete(firstKey)
  }
  persistJournal(journal) // 首次 checkpoint（断点续跑基座）
  executePipeline(journal, agent, journal.requirement, journal.options, signal)
  return journal.id
}

/** 取消运行（置 cancelled + dispose 进行中的子代理）。 */
export function cancelRun(runId: string | null | undefined): boolean {
  const j = runs.get(runId)
  if (!j) return false
  j.cancelled = true
  const entry = inFlight.get(runId)
  if (entry && entry.run) { try { entry.run.dispose() } catch (e) { /* ignore */ } }
  persistJournal(j)
  return true
}

/** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑（service 与工具共用）。 */
export function resumeRun(runId: string | null | undefined, sessionId: string | null | undefined): { ok: boolean; runId?: string; resumedFrom?: string; error?: string } {
  const id = typeof runId === 'string' ? runId : null
  if (!id) return { ok: false, error: '缺少 runId' }
  // 从磁盘加载完整 journal（内存版已裁剪 output，磁盘保留阶段产物全文）
  let j = null
  try {
    const disk = readJsonAny(journalFile(id), null) as JournalRecord | null
    if (disk && typeof disk === 'object' && disk.id === id) j = disk
  } catch (e) { /* 落到内存版 */ }
  if (!j) j = runs.get(id)
  if (!j) return { ok: false, error: `未找到运行：${id}` }
  if (j.status !== 'interrupted' && j.status !== 'failed' && j.status !== 'cancelled') {
    return { ok: false, error: `只有 interrupted/failed/cancelled 可续跑（当前 ${j.status}）` }
  }
  const productKey = j.workspace || j.product || 'default'
  if (activeProducts.has(productKey) && activeProducts.get(productKey) !== id) {
    return { ok: false, error: `工作区 ${j.workspacePath || productKey} 已有流水线 ${activeProducts.get(productKey)} 运行中` }
  }
  const sid = typeof sessionId === 'string' ? sessionId : null
  const agent = sid && runtime.agents ? runtime.agents.get(sid) : undefined
  if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sid}` }
  try {
    const resumePhase = interruptedPhaseOf(j)
    const products = buildResumeProducts(j)
    j.status = 'running'
    j.cancelled = false
    j.interrupted = false
    j.interruptedAt = null
    j.error = null
    j.endedAt = null
    j.logs = (j.logs || []).slice(-200)
    j.logs.push({ t: Date.now(), level: 'warn', message: `断点续跑：从「${resumePhase}」继续（已完成阶段复用产物）` })
    j.stages = (j.stages || []).filter((s) => s.status === 'done') // 清理未完成 stage
    runs.set(id, j) // 内存换用磁盘完整版（含 output 全文）
    persistJournal(j)
    executePipeline(j, agent, j.requirement, j.options, undefined, { phase: resumePhase, products })
    return { ok: true, runId: id, resumedFrom: resumePhase }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
