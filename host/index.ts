/**
 * dsh-plugin-teamflow — host half（阶段 3：TypertRemoteService 版本）。
 *
 * TeamFlow 团队研发流水线宿主数据层：
 * - backlog 持久化到 $DSH_HOME/teamflow/<product>/backlog/{requirements,tasks,bugs}.json
 * - 状态机 + 事件日志 + 打回阈值 + 并发池 + QA 缺陷登记 + token 计量
 * - 以 Cordis service `teamflow` 提供 7 个 Remote 方法（client 经 ctx.remote.teamflow.* 调用），
 *   strict descriptors 由 ctx.typert.register 注册（免 @Remote 装饰器）
 * - 注册 teamflow_* 模型工具（供 Agent 调用）
 *
 * 运行环境：宿主组合（web profile）的真实 Node 进程。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { TEAMFLOW_DESCRIPTORS } from '../descriptors.ts'
import {
  dshHome, teamflowRoot, productDir, fileFor,
  readJson, readJsonAny, writeJson, persistJournal, loadJournals, journalFile,
} from '../store.ts'
import type { JournalRecord, JournalStage } from '../store.ts'
import type {
  Journal, BacklogItem, PipelineOptions, ResumeContext, SubagentRunLike, ParentAgentLike, UsageBuckets,
} from './types.ts'
import { RETRY_LIMIT, STAGE_TOKEN_BUDGET, STATUS, PHASE_ORDER, PHASE_KEY_OF, PHASE_KEY_BY_NAME } from './constants.ts'
import { toText, clip, extractText, normalizeRoot, normalizeTasks, sanitizeSnapOptions, normalizeSignal, hasSubstance, isUnretryable, handoffBrief } from './util.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, devPrompt, qaPrompt, acceptancePrompt } from './prompts/index.ts'
import { runtime, runs, inFlight, activeProducts, providerName, setRuntime, workspaceScopeOf } from './core/context.ts'
import { backlogSummary, transitionBacklog, assignTask, storeFor } from './core/backlog.ts'
import { loadTeams, findTeam, type TeamConfig } from './core/teams.ts'
import { runPool, runAgent, withRetry } from './core/runner.ts'
import { deliverCompletion } from './core/report.ts'
import { executePipeline, summarizeTimeline, startPipeline, cancelRun, resumeRun } from './core/pipeline.ts'
import { suggestMode, MODE_REGISTRY, PIPELINE_MODES, normalizeMode, runTriage } from './core/triage.ts'

/* BacklogStore / storeFor 见 core/backlog.ts（数据层与状态机）。 */

/* 阶段/模板提示词见 prompts/（AGENTS_TEMPLATE / MEMORY_TEMPLATE / productCtx / TOKEN_HYGIENE / *Prompt）。 */

/* 阶段提示词 prd/design/scaffold/tech/dev/qa/acceptancePrompt 见 prompts/。 */

/* 并发池/单阶段执行/重试熔断见 core/runner.ts（runPool/runAgent/withRetry）。 */

/* 缺陷解析 / 立项建卡 / 任务流转见 core/backlog.ts（parseDefects / initPipelineBacklog / advanceTask）。 */

/** 阶段顺序/key 映射见 constants.ts（PHASE_ORDER/PHASE_KEY_OF/PHASE_KEY_BY_NAME）。 */

/* 流水线编排/入口/取消/续跑与 resume 辅助见 core/pipeline.ts（buildResumeProducts/interruptedPhaseOf/executePipeline/summarizeTimeline）。 */

/* 流水线入口/取消/断点续跑见 core/pipeline.ts（startPipeline/cancelRun/resumeRun）。 */

/** 按工作区作用域过滤运行（sessionId 推导出 workspace slug；未落 workspace 的旧运行只见于 default）。 */
function runsFor(ws: string | null | undefined) {
  const arr = []
  for (const j of runs.values()) {
    if (ws) {
      const jws = j.workspace || (ws === 'default' ? 'default' : null)
      if (jws !== ws) continue
    }
    arr.push(j)
  }
  arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return arr
}

/** 由 sessionId 推导会话所属 workspace（项目）作用域。 */
function sessionScope(sessionId: string | null | undefined) {
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : null
  const agent = sid && runtime.agents ? runtime.agents.get(sid) : undefined
  return workspaceScopeOf(agent || undefined)
}

function snapshotOf(j) {
  return {
    id: j.id, name: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    requirement: clip(j.requirement, 2000), options: sanitizeSnapOptions(j.options), agentsStarted: j.agentsStarted,
    humanIntervention: j.humanIntervention === true,
    stages: j.stages.map((s) => ({ seq: s.seq, label: s.label, phase: s.phase, status: s.status, outcome: s.outcome, childId: s.childId, startedAt: s.startedAt, endedAt: s.endedAt, usage: s.usage, summary: clip(s.summary || '', 3000) })),
    logs: j.logs.slice(-200).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
    error: j.error, resultPreview: j.result ? clip(JSON.stringify(j.result), 6000) : null,
  }
}

/* backlog 视图/流转见 core/backlog.ts（backlogSummary/transitionBacklog）。 */

/* ── 模型工具注册 ─────────────────────────────────────────────────── */
const simple = { type: 'object', additionalProperties: true }
const simpleRender = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 4000) }]

function registerTools(ctx) {
  // ctx.tools.register() 把 parameters 原样送到 wire：必须先编译成
  // { type: 'object', properties, required } 完整 JSON Schema，否则提供方
  // 以「schema 缺 type: object」拒绝（如 teamflow_backlog invalid_request_error）。
  const T = (tool) => ctx.tools.register({
    ...tool,
    parameters: parameterSchemaSpecToJsonSchema(tool.parameters),
  })

  T({
    name: 'teamflow_start',
    description: 'Start the team R&D pipeline (background async): runs the stages per team config (PRD→design→tech→dev→QA→acceptance). Specify teamId (matches teams.json) or pick a team via the UI "+" button first so messages auto-match. Stage failures auto-retry; beyond threshold → rework/human intervention; per-stage token usage recorded. NOTE: after calling, the implementation work is done by pipeline subagents — the main thread MUST NOT write code or run verifications for it. requirement must be a faithful transcription of the user\'s words; do not invent file paths / tech claims without code verification (downstream stages build the PRD from it).',
    parameters: {
      requirement: { type: 'string', required: true, description: 'The user requirement — faithful transcription of the user\'s words; no fabricated file paths, tech designs, or unverified claims' },
      teamId: { type: 'string', description: 'Team id (matches teams.json; defaults to the currently selected team of this session)' },
      needDesign: { type: 'boolean', description: 'Set true when the change involves UI' },
      needScaffold: { type: 'boolean', description: 'Set true when the project does not exist yet' },
      lite: { type: 'boolean', description: 'Lightweight mode for small changes (recommended): still runs the lightweight architecture stage (blueprint for dev, no full TECHNICAL.md), then dev → QA → acceptance; if needDesign=true the UI/UX design stage stays (saves tokens/time, traceability preserved)' },
      mode: { type: 'string', description: 'Route mode: full / medium / lite / tech / patch (auto-triage by default; use teamflow_triage to preview)' },
      productRoot: { type: 'string', description: 'Product line directory (e.g. products/tetris)' },
      maxConcurrency: { type: 'integer', description: 'Dev task concurrency (default 3, max 8)' },
      tasks: {
        type: 'array',
        description: 'Optional splittable dev task list',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Task title' },
            spec: { type: 'string', description: 'Task description & acceptance points' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['runId', 'status'], properties: { runId: { type: 'string' }, status: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: `团队研发流水线已启动（runId=${value.runId}，${value.status}），正在后台执行。【重要】你现在停手：不要自行读取/修改代码实现该需求，不要重复跑测试验证——实现、QA、汇报由流水线各阶段完成。你只需告知用户流水线已启动，等待流水线完成后的官方完成汇报，再向用户转述结果。可用 teamflow_status 查询进度/阶段 token；backlog 已持久化到 $DSH_HOME/teamflow。` }],
    },
    async execute(args, exec) {
      const parent = exec && exec.agent
      if (!parent) throw new Error('teamflow_start 需要由会话内的 Agent 调用')
      // 暂停检查：会话级暂停时拒绝启动
      const sessionId = parent.session && parent.session.id
      if (sessionId && pausedSessions.has(String(sessionId))) {
        return { runId: null, status: 'paused', message: '当前会话已暂停 teamflow。如需恢复，调用 teamflow_resume_session；或直接写代码。' }
      }
      // 团队检查：必须先通过 UI "+" 按钮选择团队，否则拒绝
      const teamId = (args && typeof args.teamId === 'string' && args.teamId.trim())
        || (sessionId && activeTeams.get(String(sessionId)))
        || null
      if (!teamId) {
        return { runId: null, status: 'no-team', message: '请先通过输入框旁的 🏭 按钮选择团队，再发送需求消息。未选团队时不走 teamflow。' }
      }
      try {
        const requirement = typeof args.requirement === 'string' && args.requirement.trim() ? args.requirement.trim() : '(未提供需求)'
        const options = {
          needDesign: !!args.needDesign,
          needScaffold: !!args.needScaffold,
          lite: !!args.lite,
          mode: normalizeMode(args.mode) || undefined,
          teamId,
          tasks: normalizeTasks(args.tasks),
          productRoot: normalizeRoot(args.productRoot),
          maxConcurrency: args.maxConcurrency,
        }
        const runId = startPipeline(parent, requirement, options, exec && exec.signal)
        return { runId, status: 'running' }
      } catch (e) {
        throw new Error(`启动流水线失败：${String((e && e.message) || e)}`)
      }
    },
  })

  T({
    name: 'teamflow_triage',
    description: 'Requirement triage (optional helper): teamflow_start already auto-triages by default — no need to call this manually. Use it only when you want to **pre-evaluate** which pipeline mode a requirement fits, or **force** a mode: a triage analyst Agent thinks one round and returns a suggested mode, nature, UI-need, complexity and rationale.',
    parameters: {
      requirement: { type: 'string', required: true, description: 'The user raw requirement' },
      needDesign: { type: 'boolean', description: 'Set true when the change involves UI' },
    },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args, exec) {
      const requirement = typeof args.requirement === 'string' ? args.requirement : ''
      const t = await runTriage(requirement, { needDesign: !!args.needDesign }, exec && exec.agent, exec && exec.signal)
      return {
        suggestedMode: t.mode,
        kind: t.kind,
        needDesign: t.needDesign,
        complexity: t.complexity,
        confidence: t.confidence,
        rationale: t.rationale,
        source: t.source,
        stages: MODE_REGISTRY[t.mode].desc,
        allModes: PIPELINE_MODES,
      }
    },
  })

  T({
    name: 'teamflow_status',
    description: 'Query the team R&D pipeline status. With runId: full progress of that run (stages / per-agent status & tokens / logs / result / human-intervention). Without runId: recent runs of the current workspace.',
    parameters: { runId: { type: 'string', description: 'Pipeline run id (optional)' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args, exec) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      if (id) {
        const j = runs.get(id)
        if (!j) return { error: `未找到运行：${id}` }
        const running = j.status === 'running'
        return { runId: j.id, status: j.status, workspace: j.workspace || null, reminder: running ? '流水线仍在后台执行：不要自行改代码实现该需求或重复跑验证，等待完成汇报。' : null, snapshot: snapshotOf(j) }
      }
      const sc = workspaceScopeOf(exec && exec.agent)
      const arr = runsFor(sc.projectKey).slice(0, 10).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, incompleteStages: (j.stages || []).some((x) => x.status !== 'done'), requirement: clip(j.requirement, 60) }))
      return { runs: arr, workspace: sc }
    },
  })

  T({
    name: 'teamflow_backlog',
    description: 'Read the team backlog: for the given product line (default = current session workspace/root) shows requirements/tasks/defects with their state machines. Single-task model: one requirement = one rotating task card (待办→开发中→待测试→测试中→待验收→已验收|打回|需人工); the task card carries devAssign/qaAssign and real token usage. Defects: 待认领→处理中→已修复待验→已关闭. Returns persistence (mode=fs/durable=true with real disk paths).',
    parameters: { product: { type: 'string', description: 'Product line directory (e.g. products/tetris); default = current session workspace' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args, exec) {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return backlogSummary(product)
    },
  })

  T({
    name: 'teamflow_claim',
    description: 'Claim a backlog task or defect (status only, no assign): task role=dev (待办→开发中) / role=qa (待测试→测试中); bug (待认领→处理中); req (→进行中). Set the assignee separately via teamflow_assign.',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: 'Record id (e.g. task-3 / bug-1)' },
      role: { type: 'string', description: 'Task claim role: dev (default, 待办→开发中) | qa (待测试→测试中)' },
      product: { type: 'string', description: 'Product line directory (default = current session workspace)' },
    },
    output: { schema: simple, render: simpleRender },
    async execute(args, exec) {
      const kind = String((args && args.kind) || '')
      const id = String((args && args.id) || '')
      if (!kind || !id) return { ok: false, error: '缺少 kind/id' }
      const role = args && typeof args.role === 'string' ? String(args.role) : (kind === 'task' ? 'dev' : null)
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      let to = 'running'
      if (kind === 'bug') to = 'claimed'
      else if (kind === 'req') to = 'in-progress'
      else if (kind === 'task') to = role === 'qa' ? 'testing' : 'running'
      return transitionBacklog(product, kind, id, to, kind === 'bug' ? 'QA 缺陷认领' : '开发/QA 认领')
    },
  })

  T({
    name: 'teamflow_update',
    description: 'Manually advance a backlog record\'s status (status only, no assign): task→accepted/rework/running/testing/testable/pending-acceptance; bug→claimed/fixed/verified/reopened/needs-human; req→accepted/closed/needs-human. When resolving needs-human, pick a legal terminal state (e.g. accepted/verified/closed) to clear the flag. Set the assignee separately via teamflow_assign.',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: 'Record id' },
      to: { type: 'string', required: true, description: 'Target status' },
      product: { type: 'string', description: 'Product line directory' },
      reason: { type: 'string', description: 'Change reason' },
    },
    output: { schema: simple, render: simpleRender },
    execute: async (args, exec) => {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return transitionBacklog(product, String(args.kind || ''), String(args.id || ''), String(args.to || ''), args.reason ? String(args.reason) : '人工流转')
    },
  })

  T({
    name: 'teamflow_assign',
    description: 'Assign a backlog task to a role (writes devAssign/qaAssign/acceptBy only; no status impact, no state-machine interference). role=dev → devAssign (who develops), role=qa → qaAssign (who tests), role=accept → acceptBy (who accepts). Callable anytime, independent of current state.',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: 'Record id (e.g. task-1)' },
      role: { type: 'string', required: true, description: 'Assign role: dev | qa | accept' },
      assignee: { type: 'string', required: true, description: 'Assignee id (subagent id / person name)' },
      product: { type: 'string', description: 'Product line directory' },
    },
    output: { schema: simple, render: simpleRender },
    execute: async (args, exec) => {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return assignTask(product, String(args.kind || ''), String(args.id || ''), String(args.role || ''), String(args.assignee || ''))
    },
  })

  T({
    name: 'teamflow_pause',
    description: 'Pause teamflow triggering for the CURRENT session: after calling, teamflow_start returns a hint instead of launching. For user phrases like「别走 teamflow 了」「直接改」「暂停 teamflow」. Session-scoped; auto-resets on new session.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.message || (value.ok ? '已暂停 teamflow，当前会话不会启动流水线。' : '暂停失败') }] },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.id
      if (!sessionId) return { ok: false, message: '无法获取当前会话 ID' }
      pausedSessions.add(String(sessionId))
      return { ok: true, message: `已暂停 teamflow（会话 ${String(sessionId).slice(-6)}）。如需恢复，调用 teamflow_resume_session。` }
    },
  })

  T({
    name: 'teamflow_resume_session',
    description: 'Resume teamflow triggering for the CURRENT session (undo teamflow_pause). For user phrases like「恢复 teamflow」「可以走 teamflow 了」.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.message || (value.ok ? '已恢复 teamflow，开发需求可走流水线。' : '恢复失败') }] },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.id
      if (!sessionId) return { ok: false, message: '无法获取当前会话 ID' }
      pausedSessions.delete(String(sessionId))
      return { ok: true, message: `已恢复 teamflow（会话 ${String(sessionId).slice(-6)}）。开发需求可走流水线。` }
    },
  })

  T({
    name: 'teamflow_cancel',
    description: 'Cancel a running team R&D pipeline.',
    parameters: { runId: { type: 'string', required: true, description: 'Pipeline run id' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? `已请求取消流水线 ${args.runId}` : '取消失败' }] },
    async execute(args) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return { ok: id ? cancelRun(id) : false }
    },
  })

  T({
    name: 'teamflow_resume',
    description: 'Resume an interrupted/failed/cancelled pipeline from its checkpoint: skip completed stages (reuse artifacts), rerun from the first incomplete stage. For interrupted runs found after process restart, or stage-failure retries.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Pipeline run id' },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, runId: { type: 'string' }, resumedFrom: { type: 'string' }, error: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? `流水线 ${value.runId} 已从断点「${value.resumedFrom}」续跑` : `续跑失败：${value.error || '未知错误'}` }] },
    async execute(args, exec) {
      const parent = exec && exec.agent
      if (!parent) throw new Error('teamflow_resume 需要由会话内的 Agent 调用')
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return resumeRun(id, parent.session.id)
    },
  })
}

/* ── Teamflow Service（宿主 Cordis service + Remote 方法）────────── */
/** 会话级暂停标记：pausedSessions.has(sessionId) → 该会话的 teamflow_start 被拦截。 */
const pausedSessions = new Set<string>()
/** 会话级当前团队：activeTeams.get(sessionId) → 当前选中的团队 id。 */
const activeTeams = new Map<string, string>()
/** 延迟注入队列：选团队时 agent 可能尚未加载，存入 pending，后续时机补发。 */
const pendingInjections = new Map<string, { teamName: string; teamIcon: string; teamId: string }>()

/** 尝试补发延迟注入：agent 可用时注入上下文并清除 pending。 */
/** 会话注入的 TeamFlow 契约文案（单一事实来源）：何时走流水线 + 启动后主线程必须停手等汇报。 */
function teamflowContextText(teamIcon: string, teamName: string, teamId: string): string {
  return `[TeamFlow 上下文] 用户已选择「${teamIcon} ${teamName}」团队。只有收到明确的开发需求（新功能/迭代/重构/bug修复/代码改动请求）时才调用 teamflow_start 并指定 teamId="${teamId}"，requirement 参数忠实转写用户原话即可（不要自行扩写、不要臆造文件路径或技术细节）。收到反馈、讨论、闲聊、UI 意见等非开发请求时，不要调用 teamflow_start，直接正常回复。调用 teamflow_start 之后：流水线在后台执行，你不要再自行读取/修改代码实现该需求，也不要重复跑测试验证——只需告知用户流水线已启动，等待流水线的完成汇报后再答复用户。`
}

function tryFlushPendingInjections(sessionId: string): void {
  const pending = pendingInjections.get(sessionId)
  if (!pending) return
  const agent = runtime.agents ? runtime.agents.get(sessionId) : undefined
  if (!agent || typeof agent.inject !== 'function') return
  try {
    agent.inject({
      type: 'user',
      content: [{ type: 'text', text: teamflowContextText(pending.teamIcon, pending.teamName, pending.teamId) }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-teamflow', form: 'context' },
    })
    pendingInjections.delete(sessionId)
  } catch (e) { /* inject 失败静默 */ }
}

export class TeamflowService extends TypertRemoteService {
  static inject = ['agents', 'subagents', 'tokenMeter', 'typert', 'tools']

  constructor(ctx) {
    super(ctx, 'teamflow')
    setRuntime(ctx.get('agents'), ctx.get('subagents'), ctx.get('tokenMeter'), ctx.get('workspaceRegistry'), ctx.get('agentDefaultModel'))
    // 断点续跑基座：加载磁盘 journal；running/pending 残留 → 标记 interrupted
    let interruptedCount = 0
    try {
      for (const { journal, wasInterrupted } of loadJournals()) {
        runs.set(journal.id, journal)
        if (wasInterrupted) interruptedCount++
      }
    } catch (e) {
      console.error('[teamflow] 启动加载 journal 失败', e?.message)
    }
    // 团队选择已通过 UI "+" 按钮驱动，不再需要 prompt 注入引导模型
    ctx.typert.register({
      package: 'dsh-plugin-teamflow',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: TEAMFLOW_DESCRIPTORS,
    })
    registerTools(ctx)
    console.log(
      `[teamflow] host 就绪：backlog 根 ${teamflowRoot()}，Remote ${TEAMFLOW_DESCRIPTORS.length} 个，`
      + `工具 8 个${interruptedCount > 0 ? `，⚠ 发现 ${interruptedCount} 条中断的流水线（可用 teamflow_resume 从断点重跑）` : ''}`,
    )
  }

  /* ── Remote 方法（client 经 ctx.remote.teamflow.* 调用） ─────────── */

  ping() {
    return { ok: true }
  }

  /** 工作区级看板：只返回当前会话 workspace（项目）下启动的流水线，不同 workspace 互不可见。 */
  list(sessionId) {
    const sc = sessionScope(sessionId)
    const arr = runsFor(sc.projectKey)
    return {
      runs: arr.slice(0, 30).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, incompleteStages: (j.stages || []).some((x) => x.status !== 'done'), requirement: clip(j.requirement, 60) })),
      workspace: sc,
    }
  }

  snapshot(runId, sessionId) {
    const sc = sessionScope(sessionId)
    if (runId && typeof runId === 'string') {
      const j = runs.get(runId)
      if (!j) return null
      // 跨 workspace 的 run 不可见（除无工作区会话的 default 兜底）
      if (j.workspace && sc.projectKey && j.workspace !== sc.projectKey && sc.projectKey !== 'default') return null
      return snapshotOf(j)
    }
    const latest = runsFor(sc.projectKey)[0]
    if (!latest) return null
    const j = runs.get(latest.id)
    return j ? snapshotOf(j) : null
  }

  /** 阶段详情：卡片点击查看 —— 状态/耗时/官方 usage + 产物全文（超 24k 截断）。 */
  stageDetail(runId, seq, sessionId) {
    if (typeof runId !== 'string' || !runId || seq === undefined || seq === null) return null
    const sc = sessionScope(sessionId)
    const j = runs.get(runId)
    if (!j) return null
    // 跨 workspace 的 run 不可见（同 snapshot 守卫）
    if (j.workspace && sc.projectKey && j.workspace !== sc.projectKey && sc.projectKey !== 'default') return null
    const s = (j.stages || []).find((st) => Number(st.seq) === Number(seq))
    if (!s) return null
    return {
      seq: s.seq, label: s.label, phase: s.phase, status: s.status, outcome: s.outcome,
      childId: s.childId || null, startedAt: s.startedAt, endedAt: s.endedAt,
      ownerSession: j.ownerSession || null,
      usage: s.usage || null,
      summary: clip(s.summary || '', 3000),
      output: clip(toText(s.output) || toText(s.handoff) || '', 24000),
    }
  }

  /** Backlog 条目详情：卡片点击查看 —— 完整字段 + 流转时间线 + 关联（子卡/缺陷）+ 任务夹路径。 */
  itemDetail(kind, id, sessionId) {
    const k = typeof kind === 'string' && ['req', 'task', 'bug'].indexOf(kind) !== -1 ? kind : null
    if (!k || typeof id !== 'string' || !id) return null
    const sc = sessionScope(sessionId)
    const store = storeFor(sc.projectKey)
    const item = store.find(k, id)
    if (!item) return null
    const reqId = k === 'req' ? item.id : (item.reqId || null)
    // 任务夹路径（ADR-0008）+ 关联 run 信息（req 需求原文在这）：匹配该需求的 journal
    let runDocs: string | null = null
    let runInfo: { runId: string; status: string; requirement: string; startedAt: number | null; endedAt: number | null } | null = null
    for (const j of runsFor(sc.projectKey)) {
      if (j.reqId !== reqId) continue
      if (j.runDocs && !runDocs) runDocs = j.runDocs
      if (!runInfo) runInfo = { runId: j.id, status: j.status, requirement: String(j.requirement || ''), startedAt: j.startedAt || null, endedAt: j.endedAt || null }
    }
    const byRole = item.byRole || null
    let subtasks: Array<{ id: string; title: string; status: string; summary: string; devAssign: string | null; usage: unknown; failed: boolean }> = []
    let bugs: Array<{ id: string; title: string; status: string; severity: string | null }> = []
    if (k === 'task') {
      for (const sid of (item.subtaskIds || [])) {
        const s = store.find('task', sid)
        if (s) subtasks.push({ id: s.id, title: String(s.title || s.id), status: s.status, summary: String(s.summary || ''), devAssign: s.devAssign || null, usage: s.usage || null, failed: !!s.failed })
      }
      for (const bid of (item.bugIds || [])) {
        const b = store.find('bug', bid)
        if (b) bugs.push({ id: b.id, title: String(b.title || b.id), status: b.status, severity: b.severity || null })
      }
    } else if (k === 'req') {
      for (const tid of (item.taskIds || [])) {
        const t = store.find('task', tid)
        if (t && t.type !== 'subtask') subtasks.push({ id: t.id, title: String(t.title || t.id), status: t.status, summary: String(t.summary || ''), devAssign: t.devAssign || null, usage: t.usage || null, failed: !!t.failed })
      }
      for (const bid of (item.bugIds || [])) {
        const b = store.find('bug', bid)
        if (b) bugs.push({ id: b.id, title: String(b.title || b.id), status: b.status, severity: b.severity || null })
      }
    }
    return {
      kind: k, id: item.id, title: String(item.title || item.id),
      status: item.status, spec: String(item.spec || ''),
      summary: String(item.summary || ''),
      severity: item.severity || null, owner: item.owner || null,
      devAssign: item.devAssign || null, qaAssign: item.qaAssign || null,
      assignBy: item.acceptBy || null, retries: item.retries !== undefined ? item.retries : 0,
      humanIntervention: !!item.humanIntervention,
      createdAt: item.createdAt || null, updatedAt: item.updatedAt || null,
      events: (item.events || []).slice(-30),
      usage: k === 'task' ? (item.usage || null) : null,
      byRole: k === 'task' ? byRole : null,
      reqId: reqId || null,
      runDocs,
      runInfo,
      subtasks, bugs,
    }
  }

  start(sessionId, requirement, options) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const req = typeof requirement === 'string' && requirement.trim() ? requirement.trim() : null
    if (!sid || !req) return { ok: false, error: '缺少 sessionId 或需求描述' }
    const agent = runtime.agents && runtime.agents.get(sid)
    if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sid}` }
    // 补发延迟注入（选团队时 agent 可能尚未加载）
    tryFlushPendingInjections(sid)
    try {
      const opts = (options && typeof options === 'object') ? options : {}
      const runId = startPipeline(agent, req, opts, undefined)
      const sc = workspaceScopeOf(agent)
      return { ok: true, runId, workspace: sc, product: opts.productRoot ? normalizeRoot(opts.productRoot) : null }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  cancel(runId) {
    const id = typeof runId === 'string' ? runId : null
    if (!id) return { ok: false, error: '缺少 runId' }
    return { ok: cancelRun(id) }
  }

  /** 工作区级 backlog 视图（自动按当前会话 workspace 隔离）。 */
  backlog(sessionId) {
    const sc = sessionScope(sessionId)
    return backlogSummary(sc.projectKey)
  }

  backlogUpdate(kind, id, to, sessionId, reason) {
    const k = String(kind || '')
    const i = String(id || '')
    const t = String(to || '')
    if (!k || !i || !t) return { ok: false, error: '缺少 kind/id/to' }
    const sc = sessionScope(sessionId)
    return transitionBacklog(sc.projectKey, k, i, t, reason ? String(reason) : '人工流转')
  }

  /** 分配任务卡给某角色（只写 assign 字段，不碰 status）。 */
  assign(kind, id, role, assignee, sessionId) {
    const k = String(kind || '')
    const i = String(id || '')
    const r = String(role || '')
    const a = String(assignee || '')
    if (!k || !i || !r || !a) return { ok: false, error: '缺少 kind/id/role/assignee' }
    const sc = sessionScope(sessionId)
    return assignTask(sc.projectKey, k, i, r, a)
  }

  /** 暂停当前会话的 teamflow 触发（会话级）。 */
  pause(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: '缺少 sessionId' }
    pausedSessions.add(sid)
    return { ok: true }
  }

  /** 恢复当前会话的 teamflow 触发（会话级）。 */
  resumeSession(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: '缺少 sessionId' }
    pausedSessions.delete(sid)
    return { ok: true }
  }

  /** 列出当前工作区可用的团队。 */
  listTeams(sessionId) {
    const sc = sessionScope(sessionId)
    const teams = loadTeams(sc.projectKey)
    return { teams: teams.map((t) => ({ id: t.id, name: t.name, icon: t.icon, description: t.description })), projectKey: sc.projectKey }
  }

  /** 设置当前会话的活跃团队。同时注入上下文提示，让模型区分开发请求和普通聊天。 */
  selectTeam(sessionId, teamId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const tid = typeof teamId === 'string' ? teamId : null
    if (!sid || !tid) return { ok: false, error: '缺少 sessionId 或 teamId' }
    const sc = sessionScope(sid)
    const teams = loadTeams(sc.projectKey)
    const team = findTeam(teams, tid)
    if (!team) return { ok: false, error: `团队 ${tid} 不存在` }
    activeTeams.set(sid, tid)
    // 注入会话级上下文：告诉模型什么该走 teamflow，什么不该
    const agent = runtime.agents && runtime.agents.get(sid)
    const injectPayload = {
      type: 'user' as const,
      content: [{ type: 'text' as const, text: teamflowContextText(team.icon, team.name, tid) }],
      source: { kind: 'plugin' as const, plugin: 'dsh-plugin-teamflow', form: 'context' as const },
    }
    if (agent && typeof agent.inject === 'function') {
      try { agent.inject(injectPayload) } catch (e) { /* inject 失败不影响主流程 */ }
    } else {
      // agent 尚未加载（新会话懒加载），存入 pending，2 秒后重试（agent 通常 1-2s 内就绪）
      pendingInjections.set(sid, { teamName: team.name, teamIcon: team.icon, teamId: tid })
      setTimeout(() => tryFlushPendingInjections(sid), 2000)
    }
    return { ok: true, team: { id: team.id, name: team.name, icon: team.icon } }
  }

  /** 获取当前会话的活跃团队。 */
  getActiveTeam(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { team: null }
    // 补发延迟注入（UI 加载时 agent 通常已就绪）
    tryFlushPendingInjections(sid)
    const tid = activeTeams.get(sid)
    if (!tid) return { team: null }
    const sc = sessionScope(sid)
    const teams = loadTeams(sc.projectKey)
    const team = findTeam(teams, tid)
    return team ? { team: { id: team.id, name: team.name, icon: team.icon, description: team.description } } : { team: null }
  }

  /** 清除当前会话的活跃团队（回到原生模式）。 */
  clearTeam(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: '缺少 sessionId' }
    activeTeams.delete(sid)
    return { ok: true }
  }

  /** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑。 */
  resume(runId, sessionId) {
    return resumeRun(runId, sessionId)
  }
}

export default TeamflowService
