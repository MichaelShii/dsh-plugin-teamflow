/**
 * dsh-plugin-teamflow core — 流水线编排中枢（阶段执行 / 入口 / 取消 / 断点续跑）。
 * 依赖：context/backlog/metering/runner/report + prompts + util/constants/types + store。
 * 【档位阶段集】按 mode（full/medium/lite/tech/patch）经 STAGE_POLICY（constants.ts）
 * 展开实际执行阶段集（resolveStages），再与团队阶段取交集——见 ADR-0004。
 */
import { runtime, runs, inFlight, activeProducts, providerName, workspaceScopeOf } from './context.ts'
import { initPipelineBacklog, advanceTask, storeFor, parseDefects, syncQaDefects, verifyReqBugs, noteTaskStageUsage, noteTaskAssign, createSubtask, completeSubtask, noteSubtaskUsage, getSubtasks, hasOpenBlockingBugs } from './backlog.ts'
import { withRetry, runPool, resolveChildRoute } from './runner.ts'
import { deliverCompletion } from './report.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, architectPrompt, devPrompt, qaPrompt, acceptancePrompt, techChangePrompt, patchConfirmPrompt, qaFixPrompt } from '../prompts/index.ts'
import { clip, snippet, normalizeRoot, normalizeTasks, sanitizeSnapOptions, parseAcceptanceVerdict, extractBlueprint, runFolderName, deriveBranchSlug } from '../util.ts'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { RETRY_LIMIT, QA_REWORK_LIMIT, PHASE_ORDER, PHASE_KEY_BY_NAME, resolveStages, STAGE_TOKEN_BUDGET } from '../constants.ts'
import { persistJournal, readJsonAny, journalFile } from '../../store.ts'
import type { JournalRecord } from '../../store.ts'
import type { Journal, PipelineOptions, ResumeContext } from '../types.ts'
import { normalizeMode, runTriage } from './triage.ts'
import { loadTeams, findTeam, getActiveStages } from './teams.ts'
import { loadState, extractStateBlock, mergeStateBlock, noteRun } from './state.ts'
import { runSanityCheck, gitCmd } from './sanity.ts'
import { currentModelSupportsVision } from './context.ts'

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
 * 断点续跑起点：第一个「没有任意 done 尝试」的阶段。
 * ⚠️ 按阶段而非尝试判断（实锤 tf-mtcomxpq）：PRD 第 1 次尝试 failed（护栏退化）但第 2 次重试 done——
 * 旧实现取第一个非 done stage → 断点错误回到 PRD，PRD/技术方案被无谓重跑。
 * 全部完成仍被中断（理论极端）→ 从产品验收继续。
 */
export function interruptedPhaseOf(journal) {
  // QA 打回未闭环（实锤 run tf-mte906e9）：P0-P2 缺陷仍 open → 无论如何回到 QA 修复-复验闭环。
  // 必须在「第一个无 done 阶段」之前判定——否则验收阶段失败过（无 done）时断点又定位到验收，
  // 带缺陷继续验收必再次失败（用户实锤：resume 进验收 2 次失败，再 resume 仍定位验收，缺陷未闭环）。
  if (hasOpenBlockingBugs(journal)) return 'QA 测试'
  for (const phase of PHASE_ORDER) {
    const phaseStages = (journal.stages || []).filter((s) => s.phase === phase)
    if (phaseStages.length === 0) continue
    if (!phaseStages.some((s) => s.status === 'done')) return phase
  }
  return '产品验收'
}

/** 开发任务定义（单一来源）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
 * resume 补跑与正常执行共用（defByTitle 按 title 匹配失败子卡）。 */
function buildDevTaskDefs(journal, tasks): Array<{ title: string; spec: string; files: string[] }> {
  const blueprintTasks = (journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length)
    ? journal.blueprint.tasks.map((t) => ({ title: t.title || '开发任务', files: Array.isArray(t.files) ? t.files : [], spec: t.spec || '' }))
    : []
  return blueprintTasks.length
    ? blueprintTasks
    : tasks.length > 0
      ? tasks.map((t) => ({ title: t.title, spec: t.spec, files: [] }))
      : [{ title: '整体开发', spec: '按技术方案/需求实现全部改动', files: [] }]
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
  let triageSlug = ''
  if (options.mode === undefined && !options.lite) {
    try {
      const verdict = await runTriage(requirement, { needDesign: options.needDesign }, parent, signal)
      options.mode = verdict.mode
      if (verdict.needDesign && !options.needDesign) options.needDesign = true
      triageSlug = verdict.slug || ''
      journal.options = Object.assign({}, options) as Record<string, unknown>
      journal.logs.push({ t: Date.now(), level: 'info', message: `自动分诊：${verdict.kind} → ${verdict.mode}（source=${verdict.source}）` })
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `自动分诊失败，按默认完整流程：${String((e && e.message) || e)}` })
    }
  }
  const tasks = normalizeTasks(options.tasks)
  const maxConcurrency = Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, 8) : 3
  const timeline: Record<string, unknown> = {}
  // 档位→阶段集（ADR-0004 差异执行的单一事实来源）：先按 mode + needDesign/needScaffold 展开，
  // 再与团队阶段列表取交集（团队可进一步裁剪）。取代散落的 if/else 阶段门控。
  const stageSet = resolveStages(options.mode, { needDesign: options.needDesign, needScaffold: options.needScaffold })
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
  journal.logs.push({ t: Date.now(), level: 'info', message: `档位阶段集：mode=${options.mode || 'full'} → ${stageSet.join(' → ') || '(空)'}` })
  const enabled = (key: string) => stageSet.indexOf(key as any) !== -1 && (!activeStageKeys || activeStageKeys.has(key))
  // 断点续跑：跳过 resume.phase 之前的阶段
  const resumed = (phase) => !!resume && PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(resume.phase)
  const logSkip = (phase) => journal.logs.push({ t: Date.now(), level: 'warn', message: `跳过已完成阶段：${phase}（断点续跑）` })
  /** 阶段失败错误：带真实尝试次数/末次结果/累计消耗与熔断语义（取代千篇一律的「重试 N 次后仍无产出」）。 */
  const stageFailError = (label: string, r: { attempts?: number; stageTokens?: number }): Error => {
    const last = [...(journal.stages || [])].reverse().find((s) => s.phase === label)
    const attempts = r && r.attempts ? r.attempts : RETRY_LIMIT
    const burnt = Math.round(((r && r.stageTokens) || 0) / 1000)
    const breaker = ((r && r.stageTokens) || 0) >= STAGE_TOKEN_BUDGET ? '，超出阶段预算熔断' : ''
    const detail = last ? `末次 ${last.outcome || 'unknown'}${last.summary ? `（${last.summary}）` : ''}` : '无阶段记录'
    return new Error(`${label} 阶段失败：${attempts} 次尝试未交付，${detail}，累计消耗 ${burnt}k token${breaker}，需人工介入`)
  }
  try {
    if (resume) {
      journal.logs.push({ t: Date.now(), level: 'info', message: `断点续跑：复用 backlog（req=${journal.reqId}），从「${resume.phase}」继续` })
    } else {
      const init = initPipelineBacklog(journal, requirement, options)
      journal.reqId = init.reqId
      journal.logs.push({ t: Date.now(), level: 'info', message: `backlog 已建立需求 ${init.reqId}（产品 ${root || 'unknown'}，并发 ${maxConcurrency}）` })
      // 分支策略 A 落地（ADR-2026-08-27，基调=启动前用户决策，见 index.ts needs-decision 检查）：
      // auto → 建特性分支 feat/<slug>（从当前 HEAD 派生，main 或 feature 上都建）；keep → 沿用当前分支。
      // 位置：initBacklog 之后（reqId 已生成——slug fallback 链依赖它；实锤 feat/feature：分支检查早于 reqId → fallback 'feature'）。
      if (options.branchPolicy !== 'keep' && journal.workspacePath) {
        try {
          const s = runSanityCheck(journal.workspacePath)
          if (s.ok && s.inRepo && !s.hasDirty) {
            const slug = deriveBranchSlug(requirement, journal.reqId, triageSlug, options.branchName)
            const branch = `feat/${slug}`
            const exists = gitCmd(journal.workspacePath, ['branch', '--list', branch])
            if (exists && exists.trim()) {
              journal.logs.push({ t: Date.now(), level: 'warn', message: `分支策略：分支 ${branch} 已存在，沿用现有分支` })
              gitCmd(journal.workspacePath, ['checkout', branch])
              journal.branch = branch
            } else {
              const ok = gitCmd(journal.workspacePath, ['checkout', '-b', branch])
              journal.logs.push({ t: Date.now(), level: 'info', message: ok !== null ? `分支策略：已创建特性分支 ${branch}（从 ${s.branch} 派生）` : `分支策略：自动建分支 ${branch} 失败（git 异常），沿用当前分支` })
              if (ok !== null) journal.branch = branch
            }
          } else if (s.ok && s.inRepo && s.branch) {
            journal.logs.push({ t: Date.now(), level: 'warn', message: `分支策略：工作区仍有未提交改动（${s.dirty.split(/\r?\n/).filter((l) => l.trim()).length} 处），跳过建分支，沿用 ${s.branch}——请知悉改动将混入本次开发` })
          }
        } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: `分支策略检查失败（降级沿用当前分支）：${String((e && e.message) || e)}` }) }
      }
    }
    persistJournal(journal)

    // ADR-0008 任务夹：需求级档案单元 docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/。
    // 夹名在建夹时刻固定并持久化 journal.runDocs——阶段重试/断点续跑一律复用同夹（幂等由结构保证）。
    if (!journal.runDocs && journal.reqId) {
      journal.runDocs = `${'docs/teamflow'}/${runFolderName(new Date(), journal.reqId, triageSlug)}`
      try {
        if (journal.workspacePath) {
          const abs = `${journal.workspacePath}/${journal.runDocs}`
          mkdirSync(abs, { recursive: true })
          writeFileSync(`${abs}/meta.json`, JSON.stringify({
            reqId: journal.reqId, runId: journal.id, title: String(requirement).replace(/\s+/g, ' ').trim().slice(0, 80),
            mode: options.mode || null, createdAt: Date.now(),
          }, null, 2), 'utf8')
        }
        journal.logs.push({ t: Date.now(), level: 'info', message: `任务夹就绪：${journal.runDocs}/（本需求全部产物收口于此；建后不可变，重试/续跑复用）` })
      } catch (e) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: `任务夹创建失败（不影响流程）：${String((e && e.message) || e)}` })
      }
    }

    // 分支策略 preAction（ADR-2026-08-27）：脏工作区的启动前处理，在 sanity 之前执行，
    // 使状态核对看到「处理后的干净基线」。stash 的改动由用户在流水线完成后自行 pop（完成汇报有提醒）。
    if (!resume && journal.workspacePath && options.preAction === 'stash') {
      try {
        const out = gitCmd(journal.workspacePath, ['stash', 'push', '-m', `teamflow:${journal.id} pre-pipeline`])
        if (out !== null) {
          journal.logs.push({ t: Date.now(), level: 'info', message: `分支策略：工作区改动已 stash（teamflow:${journal.id}），流水线完成后 git stash pop 恢复你的改动` })
        } else {
          journal.logs.push({ t: Date.now(), level: 'warn', message: '分支策略：stash 执行失败（可能无改动），继续' })
        }
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: `分支策略：stash 异常：${String((e && e.message) || e)}` }) }
    } else if (!resume && journal.workspacePath && options.preAction === 'commit') {
      try {
        const msg = (typeof options.commitMessage === 'string' && options.commitMessage.trim()) ? options.commitMessage.trim() : `chore(teamflow): 流水线启动前提交现有改动（${journal.id}）`
        const add = gitCmd(journal.workspacePath, ['add', '-A'])
        const cm = gitCmd(journal.workspacePath, ['commit', '-m', msg])
        journal.logs.push({ t: Date.now(), level: 'info', message: (add !== null && cm !== null) ? `分支策略：已提交现有改动（preAction=commit：${msg.slice(0, 60)}）` : '分支策略：commit 执行失败（可能无改动），继续' })
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: `分支策略：commit 异常：${String((e && e.message) || e)}` }) }
    }

    // 预编译 state（跨 run 累积索引）：各阶段 prompt 注入 slice；结束后提取/合并 state 块
    const state = loadState(journal.workspace || 'default')
    state.__runCtx = { ...(state.__runCtx || {}) }
    if (journal.runDocs) state.__runCtx.runDocs = journal.runDocs
    // M0 状态核对：核对代码库真实状态（多人/场外提交/非流水线改动），注入后续所有阶段。
    // 核心原则：认知可复用"减量"，但不替代"对现状的核对"。
    try {
      const wsCwd = workspaceScopeOf(parent).path
      const sanity = runSanityCheck(wsCwd)
      state.__runCtx = { ...(state.__runCtx || {}), sanity: sanity.summary }
      journal.sanity = { ok: sanity.ok, branch: sanity.branch, hasDirty: sanity.hasDirty, dirty: sanity.dirty.slice(0, 1000), recentCommits: sanity.recentCommits.slice(0, 1000), summary: sanity.summary }
      if (sanity.hasDirty || !sanity.ok) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: sanity.summary })
      } else {
        journal.logs.push({ t: Date.now(), level: 'info', message: sanity.summary })
      }
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: '状态核对失败（不影响流程）：' + String((e && e.message) || e) })
    }
    const mergeStageState = (phaseKey, output) => {
      const block = extractStateBlock(output)
      if (block) mergeStateBlock(journal.workspace || 'default', block, phaseKey)
    }

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
      const prdR = await withRetry(journal, parent, pForm.label, 'PRD 产品需求', pForm.fn(requirement, root, journal.id, state), signal)
      if (!prdR.text) { throw stageFailError('PRD 产品需求', prdR) }
      prd = prdR.text
      timeline.prd = prd
      mergeStageState('prd', prd)
      noteTaskStageUsage(journal) // PRD 角色的真实 token 累计到任务卡
      if (journal.cancelled) return
    }

    /* ── UI/UX 设计阶段（档位阶段集启用；lite+needDesign 也保留，显式要求的 UI 需求不被吞） ── */
    let design = null
    if (enabled('design')) {
      if (resumed('UI/UX 设计')) {
        design = resume.products.design
        timeline.design = design
        logSkip('UI/UX 设计')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：UI/UX 设计' })
        const designR = await withRetry(journal, parent, 'UI/UX 设计师 · 设计说明', 'UI/UX 设计', designPrompt(prd, root, journal.id, state), signal)
        if (!designR.text) { throw stageFailError('UI/UX 设计', designR) }
        design = designR.text
        timeline.design = design
        mergeStageState('design', design)
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 架构规划阶段（档位阶段集启用：显式 needScaffold 才含，见 STAGE_POLICY） ── */
    let scaffold = null
    if (enabled('scaffold')) {
      if (resumed('架构规划')) {
        scaffold = resume.products.scaffold
        timeline.scaffold = scaffold
        logSkip('架构规划')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：架构规划' })
        const scR = await withRetry(journal, parent, '架构师 · 脚手架规划与落地', '架构规划', scaffoldPrompt(requirement, design, root, journal.id, state), signal)
        if (!scR.text) { throw stageFailError('架构规划', scR) }
        scaffold = scR.text
        timeline.scaffold = scaffold
        mergeStageState('scaffold', scaffold)
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 技术方案/架构阶段（按档位阶段集；lite/tech 轻量产架构蓝图；patch 无 tech——单 agent 直改，见 STAGE_POLICY） ── */
    let tech = null
    if (enabled('tech')) {
      if (resumed('技术方案')) {
        tech = resume.products.tech
        timeline.tech = tech
        logSkip('技术方案')
      } else {
      const isHeavy = !options.lite && options.mode !== 'tech' && options.mode !== 'patch'
      journal.logs.push({ t: Date.now(), level: 'phase', message: isHeavy ? '进入阶段：技术方案' : '进入阶段：架构蓝图' })
      const label = isHeavy ? '高级全栈工程师 · 技术方案' : '架构师 · 架构蓝图'
      const prompt = isHeavy
        ? techPrompt(prd, design, scaffold, tasks, root, journal.id, state)
        : architectPrompt(prd, root, journal.id, state)
      const techR = await withRetry(journal, parent, label, '技术方案', prompt, signal)
      if (!techR.text) { throw stageFailError(label, techR) }
      tech = techR.text
      timeline.tech = tech
      mergeStageState('tech', tech)
      // 提取架构蓝图 JSON → 注入后续阶段（dev 继承蓝图）并用于自动拆任务。
      // 优先取 stage 回复输出；模型可能把蓝图写进任务夹 TECHNICAL.md（ADR-0008 收口约定）——回退读文件提取，绝不静默丢蓝图（实锤 r13：蓝图只在文档里，dev 退化为单任务整体开发、M2 拆卡失效）。
      let bd = extractBlueprint(tech)
      if (!bd || bd.summary === undefined) {
        try {
          const techFile = journal.runDocs && journal.workspacePath
            ? `${journal.workspacePath}/${journal.runDocs}/TECHNICAL.md`
            : null
          if (techFile && existsSync(techFile)) bd = extractBlueprint(readFileSync(techFile, 'utf8'))
          if (bd) journal.logs.push({ t: Date.now(), level: 'info', message: '蓝图从任务夹 TECHNICAL.md 提取（模型把蓝图写进了文档而非回复输出）' })
        } catch (e) { /* 回退失败走既有告警 */ }
      }
      if (bd && bd.summary !== undefined) {
        try {
          state.__runCtx = state.__runCtx || {}
          state.__runCtx.blueprint = bd.render
          journal.blueprint = { modules: bd.modules, tasks: bd.tasks }
        } catch (e) { /* 蓝图注入失败不影响 */ }
      } else if (/<!-- blueprint -->/.test(String(tech))) {
        // 蓝图块存在但解析失败：显式告警（否则静默回退整体开发，并行度丢失难排查）
        journal.logs.push({ t: Date.now(), level: 'warn', message: '技术方案蓝图块解析失败（JSON 畸形），开发任务将回退整体开发——TECHNICAL.md 蓝图块需人工检查' })
      }
      noteTaskStageUsage(journal)
      if (journal.cancelled) return
      }
    }

    /* ── 开发阶段（并发池；resume 到 QA/验收时复用旧结果） ── */
    let devResults = null
    if (resumed('开发')) {
      devResults = resume.products.dev || []
      // 提测门禁后 resume 补跑（方案 A，实锤 r26）：复用 done 任务产物，仅重跑 failed 子卡——
      // 否则 needs-human 后 resume 直接复用失败产物进 QA，拦截无意义
      const store = storeFor(scopeKey)
      const failedSubs = (store.tasks || []).filter((t) => t.reqId === journal.reqId && t.parentId === journal.taskId && (t.status === 'failed' || t.failed === true))
      if (failedSubs.length > 0) {
        const defs = buildDevTaskDefs(journal, tasks)
        const defByTitle = new Map(defs.map((d) => [d.title, d]))
        const rerunDefs = failedSubs
          .map((s) => {
            const key = String(s.title || '').replace(/^开发 · /, '')
            return defByTitle.get(key) || { title: key, spec: s.spec || '按技术方案实现该任务改动', files: [] }
          })
          .filter(Boolean)
        const reused = devResults.filter((r) => r && !rerunDefs.some((d) => d.title === r.title))
        journal.logs.push({ t: Date.now(), level: 'warn', message: `断点续跑开发：复用 ${reused.length} 个已完成任务，补跑 ${rerunDefs.length} 个失败任务` })
        const rerun = await runPool(rerunDefs, maxConcurrency, async (task) => {
          const devR = await withRetry(journal, parent, `开发 · ${task.title}（补跑）`, '开发', devPrompt(task, tech, prd, root, journal.id, state), signal)
          const ok = !!devR.text
          return { title: task.title, failed: !ok, output: devR.text || '开发失败（Agent 未产出结果）' }
        })
        for (const t of rerun) {
          const sub = failedSubs.find((s) => String(s.title || '').replace(/^开发 · /, '') === t.title)
          if (sub) completeSubtask(journal, sub.id, t.failed, t.output ? snippet(t.output, 1000) : null, null)
        }
        devResults = [...reused, ...rerun]
        timeline.dev = devResults
      } else {
        timeline.dev = devResults
        logSkip('开发')
      }
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：开发' })
      // 开发任务来源（按优先级）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
      // M2「认知前置 + 架构落地」：架构师（tech/architect 阶段）已按文件边界拆好蓝图 tasks，
      // dev 继承蓝图在既有架构上实现；无蓝图时退化为整体开发或调用方 tasks。
      const devTaskDefs = buildDevTaskDefs(journal, tasks)
      // 冲突检测：蓝图任务文件有交集 → 合并（保证并发不写同一文件）；无交集才可并行
      const mergedDefs: Array<{ title: string; files: string[]; spec: string }> = []
      for (const t of devTaskDefs) {
        const hit = t.files && t.files.length
          ? mergedDefs.find((m) => m.files.some((f) => t.files.includes(f)))
          : undefined
        if (hit) {
          hit.title = `${hit.title} + ${t.title}`
          hit.spec = `${hit.spec}${t.spec ? `；${t.spec}` : ''}`
          for (const f of (t.files || [])) if (!hit.files.includes(f)) hit.files.push(f)
        } else {
          mergedDefs.push({ title: t.title, files: t.files || [], spec: t.spec || '' })
        }
      }
      journal.logs.push({ t: Date.now(), level: 'info', message: `开发阶段开始，任务数：${mergedDefs.length}（并发 ${maxConcurrency}${journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length ? '，源自架构蓝图自动拆解' : ''}）` })
      advanceTask(journal, 'running', null, '开发开始（待办 → 开发中）', { by: 'dev' })
      // 为每个 dev 子任务建一张子卡（并行 agent 各自独立跟踪）
      const subCards = mergedDefs.map((dt) => createSubtask(journal, dt.title, dt.spec))
      devResults = await runPool(mergedDefs, maxConcurrency, async (task, idx) => {
        const sub = subCards[idx]
        if (sub) {
          completeSubtask(journal, sub.id, false, null, null) // 先标记 running（end 由 complete 设）
          const store = storeFor(scopeKey)
          const subLive = store.find('task', sub.id)
          if (subLive) { subLive.status = 'running'; subLive.startedAt = Date.now(); store.persist(); persistJournal(journal) }
        }
        const devR = await withRetry(journal, parent, `开发 · ${task.title}`, '开发', devPrompt(task, tech, prd, root, journal.id, state), signal)
        const ok = !!devR.text
        // 完成子卡：记录状态 + childId + 摘要
        if (sub) {
          completeSubtask(journal, sub.id, !ok, devR.text ? snippet(devR.text, 1000) : null, null)
          // 把对应 stage 的 usage 累计到子卡
          const devStage = journal.stages.filter((s) => s.phase === '开发').pop()
          if (devStage) noteSubtaskUsage(journal, sub.id, devStage)
        }
        return { title: task.title, failed: !ok, output: devR.text || '开发失败（Agent 未产出结果）' }
      })
      timeline.dev = devResults
      // dev 阶段 state 沉淀：汇总各 dev 产出中提取的 state 块
      for (const r of devResults) {
        if (r && r.output) mergeStageState('dev', r.output)
      }
      // 累计全部 dev stage usage 到主卡（汇总）
      noteTaskStageUsage(journal)
      const devStages = journal.stages.filter((s) => s.phase === '开发')
      noteTaskAssign(journal, 'dev', devStages.map((s) => (s.childId || '').slice(0, 8)).filter(Boolean).join(',') || '开发组')
      const failedCount = devResults.filter((r) => r && r.failed).length
      if (failedCount > 0) {
        advanceTask(journal, 'needs-human', null, '开发失败，需人工介入', { by: 'dev' })
        const req = storeFor(scopeKey).find('req', journal.reqId)
        if (req) { req.humanIntervention = true; storeFor(scopeKey).persist() }
        // 提测门禁（方案 A，实锤 r26）：任务 failed = 已知缺口——QA 检查轮必然重复报告同一缺项
        // （r26：T2 failed → QA 450k 白烧，D1-D4 全是 T2 缺项；修复子代理补做任务过重复读 27 次挂掉）。
        // 一律停止流水线不进 QA；人工处理后 teamflow_resume 从开发补跑 failed 任务（done 任务复用）。
        journal.logs.push({ t: Date.now(), level: 'error', message: `开发失败任务数：${failedCount}/${devResults.length}（提测门禁拦截）：停止流水线，需人工介入——处理后可 teamflow_resume 从开发阶段补跑失败任务（已完成任务复用）` })
        throw new Error(`开发失败任务 ${failedCount}/${devResults.length}：提测门禁拦截，不进 QA（已知缺口，QA 检查轮必然重复报告）`)
      } else {
        advanceTask(journal, 'testable', null, '开发完成待测试（开发中 → 待测试）', { by: 'dev' })
        journal.logs.push({ t: Date.now(), level: 'info', message: `开发完成，失败任务数：0（任务置为待测试，可指派 QA）` })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── QA 测试阶段（档位阶段集启用：patch 档不含 qa，见 STAGE_POLICY） ── */
    let qa = null
    let qaBlocked = false
    if (!enabled('qa')) {
      // 档位阶段集无 QA（patch）或团队未启用 QA：跳过独立 QA
      journal.logs.push({ t: Date.now(), level: 'info', message: '当前档位阶段集不含独立 QA：跳过（单点修复，开发自测兜底）' })
      qa = '（独立 QA 跳过：当前档位由开发自测兜底）'
    } else if (resumed('QA 测试') && !hasOpenBlockingBugs(journal)) {
      // 复用旧 QA 产物（QA 干净/仅 P3 时续跑）；QA 打回缺陷未闭环时不复用——重走修复-复验闭环
      qa = resume.products.qa
      timeline.qa = qa
      logSkip('QA 测试')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：QA 测试' })
      advanceTask(journal, 'testing', null, 'QA 开始（待测试 → 测试中）', { by: 'qa' })
      const store = storeFor(scopeKey)
      const qaStageChildren = () => journal.stages.filter((s) => s.phase === 'QA 测试').map((s) => (s.childId || '').slice(0, 8)).filter(Boolean).join(',') || '测试组'
      // QA → 开发修复 → 复验 打回闭环：QA 发现 P0-P2 缺陷则打回开发确认/修复，干净才进验收；超 QA_REWORK_LIMIT 轮需人工。
      let round = 0
      let qaClean = false
      const devFixRounds = []
      const qaDevSummary = () => {
        const src = JSON.stringify(timeline.dev)
        return devFixRounds.length ? `${src}\n【QA 打回后的修复摘要】\n${devFixRounds.join('\n---\n')}` : src
      }
      let defects = []
      do {
        round += 1
        const isReverify = round > 1
        const label = isReverify ? `QA 复验 · 第${round - 1}轮修复后` : 'QA 测试工程师 · 功能测试'
        const qaR = await withRetry(journal, parent, label, 'QA 测试', qaPrompt(prd, qaDevSummary(), root, journal.id, state, await currentModelSupportsVision(resolveChildRoute(parent).provider, resolveChildRoute(parent).model)), signal)
        if (!qaR.text) { advanceTask(journal, 'needs-human', null, isReverify ? `QA 复验失败（第 ${round - 1} 轮修复后）` : 'QA 失败', { by: 'qa' }); throw stageFailError(isReverify ? 'QA 测试（复验）' : 'QA 测试', qaR) }
        qa = qaR.text
        timeline.qa = qa
        mergeStageState('qa', qa)
        noteTaskStageUsage(journal) // QA 角色的真实 usage 累计
        noteTaskAssign(journal, 'qa', qaStageChildren())
        defects = parseDefects(qa)
        // 登记全部缺陷（含 P3 观察项，幂等）
        syncQaDefects(journal, defects)
        // 阻断判定：只认 P0/P1/P2（P3 观察项非阻断，记卡不循环）
        const blocking = defects.filter((d) => d.severity !== 'P3')
        if (blocking.length === 0) {
          qaClean = true
          journal.logs.push({ t: Date.now(), level: 'info', message: defects.length ? `QA 仅有 P3 观察项 ${defects.map((d) => d.id).join('、')}（非阻断）` : 'QA 未发现阻断缺陷' })
          break
        }
        if (journal.cancelled) return
        if (round > QA_REWORK_LIMIT) {
          // 超过复验轮次上限 → 需人工介入，跳过产品验收（QA 不干净不验收）
          qaBlocked = true
          journal.humanIntervention = true
          journal.logs.push({ t: Date.now(), level: 'error', message: `QA 连续 ${round} 轮（含复验）仍有 ${blocking.length} 个阻断缺陷（${blocking.map((d) => d.id).join('、')}），超出复验上限 ${QA_REWORK_LIMIT}，需人工介入` })
          advanceTask(journal, 'needs-human', snippet(qa, 3000), `QA ${round} 轮复验仍有阻断缺陷，超出上限 ${QA_REWORK_LIMIT}，需人工介入`, { by: 'qa' })
          const req = store.find('req', journal.reqId)
          if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', `QA 复验 ${QA_REWORK_LIMIT} 轮仍含阻断缺陷，需人工介入（${blocking.map((d) => d.id).join('、')}）`) }
          break
        }
        // 打回开发确认/修复 → 下一轮复验
        journal.logs.push({ t: Date.now(), level: 'warn', message: `QA 发现 ${blocking.length} 个阻断缺陷（第 ${round} 轮），打回开发确认修复后复验` })
        advanceTask(journal, 'rework', snippet(qa, 3000), `QA 打回开发修复（第 ${round}/${QA_REWORK_LIMIT + 1} 轮）`, { by: 'qa' })
        const fixR = await withRetry(journal, parent, `开发 · QA 缺陷修复（第 ${round} 轮）`, '开发', qaFixPrompt(blocking, qa, tech, prd, root, journal.id, state), signal)
        if (!fixR.text) { advanceTask(journal, 'needs-human', null, 'QA 打回后开发修复失败', { by: 'qa' }); throw stageFailError('开发（QA 打回修复）', fixR) }
        devFixRounds.push(snippet(fixR.text, 3000))
        noteTaskStageUsage(journal) // 修复子代理真实 usage 累计到任务卡
        if (journal.cancelled) return
      } while (true)
      if (!qaBlocked && qaClean) {
        verifyReqBugs(journal) // 复验通过 → 关闭全部 open 缺陷
        advanceTask(journal, 'pending-acceptance', snippet(qa, 3000), 'QA 通过（待验收）', { by: 'qa' })
        journal.logs.push({ t: Date.now(), level: 'info', message: round > 1 ? `QA 复验通过（第 ${round - 1} 轮修复后），无阻断缺陷` : 'QA 未发现 P0/P1/P2 阻断缺陷' })
      } else {
        journal.logs.push({ t: Date.now(), level: 'warn', message: 'QA 阶段打回超限结束：产品验收跳过，需求需人工介入' })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── 产品验收阶段（QA 打回未超限才执行；超限时需求已置 needs-human，跳过验收） ── */
    if (!enabled('acceptance')) {
      // patch 档：单 agent 直改 + 自测即交付（无独立 QA/验收，STAGE_POLICY 兑现 desc）——
      // dev 成功即收尾（req/task → accepted + run completed），统一收口提交走现有门控
      journal.logs.push({ t: Date.now(), level: 'info', message: 'patch 档交付完成：单 agent 直改 + 自测即收口（无独立 QA/验收）' })
      advanceTask(journal, 'accepted', null, 'patch 直改交付（自测通过）', { by: 'dev' })
      const store = storeFor(scopeKey)
      const req = store.find('req', journal.reqId)
      if (req && req.status !== 'accepted') {
        store.pushEvent(req, req.status, 'accepted', 'patch 交付通过（自测）')
        req.status = 'accepted'
        store.persist()
      }
      journal.status = 'completed'
    } else if (!qaBlocked) {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：产品验收' })
      // 单任务模型：验收前任务置「待验收」（patch/无独立 QA 时 task 仍在 testable）
      {
        const curTask = storeFor(scopeKey).find('task', journal.taskId)
        if (curTask && curTask.status !== 'pending-acceptance' && curTask.status !== 'needs-human' && curTask.status !== 'rework') {
          advanceTask(journal, 'pending-acceptance', null, '进入验收（待验收）', { by: 'pm' })
        }
      }
      const accR = await withRetry(journal, parent, '产品经理 · 最终验收', '产品验收', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root, journal.id, state, await currentModelSupportsVision(resolveChildRoute(parent).provider, resolveChildRoute(parent).model)), signal)
      if (!accR.text) { advanceTask(journal, 'needs-human', null, '验收失败', { by: 'pm' }); throw stageFailError('产品验收', accR) }
      const acceptance = accR.text
      timeline.acceptance = acceptance
      noteTaskStageUsage(journal) // 验收角色的真实 usage 累计
      const accStage = journal.stages.find((s) => s.phase === '产品验收' && s.childId)
      noteTaskAssign(journal, 'accept', accStage ? String(accStage.childId).slice(0, 8) : '验收组')
      mergeStageState('acceptance', acceptance)
      // 结论解析：见 parseAcceptanceVerdict（只认结论行，避免正文「无需改动」等否定/引用话术误杀整条流水线）
      const accVerdict = parseAcceptanceVerdict(acceptance)
      if (accVerdict === 'reject') {
        // 需求与现状不符（无有效变更）→ 拦截：task needs-human、req needs-human、流水线中断（非 accepted）
        advanceTask(journal, 'needs-human', snippet(acceptance, 3000), '需求与现状不符（无需改动），需人工决定调整或取消需求', { by: 'pm' })
        const store = storeFor(scopeKey)
        const req = store.find('req', journal.reqId)
        if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', '需求与现状不符，需人工处理（调整或取消）') }
        journal.logs.push({ t: Date.now(), level: 'error', message: '需求与现状不符（无需改动），流水线中断，需人工处理' })
        persistJournal(journal)
        throw new Error('需求与现状不符，无需改动，需人工决定调整或取消需求')
      }
      advanceTask(journal, accVerdict, snippet(acceptance, 3000), accVerdict === 'rework' ? '验收不通过（需返工）' : '验收完成（待验收 → 已验收）', { by: 'pm' })
      const store = storeFor(scopeKey)
      const req = store.find('req', journal.reqId)
      if (req) {
        const openBugs = store.bugs.filter((b) => b.reqId === req.id && b.status !== 'verified' && b.status !== 'closed' && b.severity !== 'P3')
        if (accVerdict === 'rework') {
          req.humanIntervention = true
          journal.humanIntervention = true // 汇报状态线：completed+humanIntervention → ⚠️ 已完成（需人工介入）
          store.pushEvent(req, req.status, 'needs-human', '验收不通过（需返工）')
        } else if (openBugs.length > 0) {
          store.pushEvent(req, req.status, 'pending-acceptance', '存在未关闭缺陷')
        } else {
          verifyReqBugs(journal) // 验收通过 → 关闭遗留 open 缺陷
          store.pushEvent(req, req.status, 'accepted', '验收通过')
        }
      }
      journal.logs.push({ t: Date.now(), level: 'info', message: '流水线全部完成 ✅' })
      journal.status = 'completed'
    } else {
      // QA 打回超限：验收跳过，需求已 needs-human（humanIntervention=true）
      journal.logs.push({ t: Date.now(), level: 'error', message: '产品验收跳过：QA 复验超限，需求已置 needs-human，需人工介入' })
      journal.status = 'completed'
    }
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
    // 统一收口提交兜底（ADR-2026-08-27 升级：一个 run 一个 commit，取代子代理零碎提交）：
    // try 内验收通过后已提交过（幂等：无改动时 commit 跳过）；此处兜底异常路径。
    // 只有「验收通过」才提交；failed/cancelled/打回超限 needs-human 不提交——工作区保留，人工处理或 resume 修复后再收口。
    // 结构上消灭文档漏提交（实测 r16 漏 QA-REPORT/ACCEPTANCE；统一 add -A 必然全带）。
    if (journal.workspacePath && journal.status === 'completed' && !journal.humanIntervention) {
      try {
        const reqHead = String(journal.requirement || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        const add = gitCmd(journal.workspacePath, ['add', '-A'])
        const cm = add === null ? null : gitCmd(journal.workspacePath, ['commit', '-m', `feat: ${reqHead}（runId=${journal.id}${journal.runDocs ? `，任务夹 ${journal.runDocs}` : ''}）`])
        if (cm !== null) {
          journal.logs.push({ t: Date.now(), level: 'info', message: '统一收口提交完成（代码 + 任务夹产物，验收通过后一个 commit）' })
        } else if (add !== null) {
          journal.logs.push({ t: Date.now(), level: 'info', message: '统一收口提交：无待提交改动（跳过）' })
        }
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: `统一收口提交失败（忽略）：${String((e && e.message) || e)}` }) }
    } else if (journal.workspacePath && journal.runDocs && (journal.status === 'failed' || journal.status === 'cancelled' || journal.status === 'interrupted')) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `终态非验收通过：工作区改动与任务夹产物 ${journal.runDocs}/ 保留未提交，供人工处理（resume 修复通过后自动收口提交）` })
    }
    journal.result = { requirement, options: sanitizeSnapOptions(options), timeline: summarizeTimeline(timeline) }
    persistJournal(journal) // 终态 checkpoint（含日志刷新；阶段全文保留在磁盘+内存，供详情抽屉/断点续跑读取）
    // 孤儿收尾：run 异常/取消时把未到终态的 req/task 落成可见状态（中断不再永远 in-progress；cancelled 保留 resume 入口）
    try {
      const store = storeFor(scopeKey)
      if (journal.status === 'failed') {
        const req = store.find('req', journal.reqId)
        if (req && (req.status === 'in-progress' || req.status === 'created')) {
          req.humanIntervention = true
          store.pushEvent(req, req.status, 'needs-human', `流水线异常退出（${String(journal.error || '').slice(0, 120)}），需人工确认后继续（teamflow_resume）或关闭（backlogUpdate closed）`)
          req.status = 'needs-human'
        }
        const task = journal.taskId ? store.find('task', journal.taskId) : null
        if (task && (task.status === 'running' || task.status === 'pending')) {
          store.pushEvent(task, task.status, 'needs-human', '流水线异常退出（中断），需人工确认')
          task.status = 'needs-human'
        }
        store.persist()
      } else if (journal.status === 'cancelled') {
        const req = store.find('req', journal.reqId)
        if (req && req.status === 'in-progress') store.pushEvent(req, req.status, 'in-progress', '流水线已取消（可 teamflow_resume 续跑，或 backlogUpdate → closed 放弃并关闭）')
        if (req) store.persist()
      }
    } catch (e) { /* 孤儿收尾尽力而为，不影响主收尾 */ }
    // ADR-0008：meta.json 是任务夹「静态标识卡」——reqId/runId/title/mode/createdAt 建夹即定，
    // 不再终态回写（历史：host 回写 status 导致 ①终态永远晚于 agent 提交 → 提交后再脏、②
    // run 误判时 meta 快照过时）。status/endedAt 权威在 runs/<runId>.json（journal），目录
    // 扫描聚合时以 journal 为准，勿从 meta 读动态字段。
    noteRun(journal.workspace || 'default', { id: journal.id, requirement: journal.requirement, verdict: journal.status, runDocs: journal.runDocs })
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
  // 分支策略决策（ADR-2026-08-27 基调）：已在 teamflow_start 层完成（needs-decision → 用户选择 → 带参重发），此处不再阻断。
  // mode：显式指定 / lite 兼容 / 否则留空 → 由 executePipeline 自动分诊（对调用方透明）
  const mode = normalizeMode(options.mode) ?? (options.lite ? 'lite' : undefined)
  // 发起会话 id：阶段子代理的直接 parent（跨会话跳转子代理时据此判定/兜底）
  const ownerSession = ((agent as { session?: { id?: string } } | null | undefined)?.session?.id) || null
  const journal = {
    id: `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'teamflow-pipeline', status: 'pending',
    requirement: clip(requirement, 8000),
    workspace: ws.projectKey,
    workspacePath: ws.path,
    ownerSession,
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
      branchPolicy: options.branchPolicy || undefined,
      branchName: options.branchName || undefined,
      preAction: options.preAction || undefined,
      commitMessage: options.commitMessage || undefined,
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
  // 全阶段已 done 的 failed/cancelled：没有断点可续（阶段全绿≠run 成功，如「需求与现状不符」拦截单），
  // 续跑只会兜底重跑验收、循环失败——硬拒绝，引导起新流水线（实锤 tf-mt8kxyef-29ruxt）
  if ((j.stages || []).length > 0 && (j.stages || []).every((s) => s.status === 'done')) {
    return { ok: false, error: `所有阶段均已完成，无断点可续（run=${j.status}）；如需重跑请启动新需求` }
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
    // 重置历史失败留下的需人工标记（否则完成汇报头会误标「⚠️ 已完成（需人工介入）」，实锤 tf-mt5afdch 续跑）
    j.humanIntervention = false
    // 孤儿收尾回写恢复：上次失败/取消把 req/task 落到 needs-human，续跑时恢复进行中语义
    try {
      const store = storeFor(productKey)
      const req = store.find('req', j.reqId)
      if (req && req.status === 'needs-human' && req.humanIntervention) {
        store.pushEvent(req, req.status, 'in-progress', `断点续跑（从「${resumePhase}」恢复流水线执行）`)
        req.status = 'in-progress'
        req.humanIntervention = false
      }
      const task = j.taskId ? store.find('task', j.taskId) : null
      if (task && task.status === 'needs-human') {
        store.pushEvent(task, task.status, 'running', '断点续跑（恢复流水线执行）')
        task.status = 'running'
      }
      store.persist()
    } catch (e) { /* 恢复尽力而为 */ }
    j.endedAt = null
    j.logs = (j.logs || []).slice(-200)
    j.logs.push({ t: Date.now(), level: 'warn', message: `断点续跑：从「${resumePhase}」继续（已完成阶段复用产物）` })
    j.stages = (j.stages || []).filter((s) => s.status !== 'running' && s.status !== 'pending') // 清理未完成 stage；保留 done/failed 历史（失败痕迹不消失）
    runs.set(id, j) // 内存换用磁盘完整版（含 output 全文）
    persistJournal(j)
    executePipeline(j, agent, j.requirement, j.options, undefined, { phase: resumePhase, products })
    return { ok: true, runId: id, resumedFrom: resumePhase }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
