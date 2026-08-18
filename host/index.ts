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
import { backlogSummary, transitionBacklog, assignTask } from './core/backlog.ts'
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
    description: '启动团队研发流水线：按团队配置执行对应阶段（PRD→设计→技术→开发→QA→验收）。通过 teamId 指定团队（对应 teams.json 配置），或在 UI 通过 "+" 按钮选择团队后发送消息自动匹配。阶段失败自动重试，超阈值打回并需人工介入；每阶段记录 token 用量。',
    parameters: {
      requirement: { type: 'string', required: true, description: '用户的需求描述' },
      teamId: { type: 'string', description: '团队 id（对应 teams.json 中的团队；缺省使用当前会话选中的团队）' },
      needDesign: { type: 'boolean', description: '涉及 UI 改造时设为 true' },
      needScaffold: { type: 'boolean', description: '项目尚未建立时设为 true' },
      lite: { type: 'boolean', description: '微功能轻量模式（推荐小改动）：跳过 UI/UX 设计与独立技术方案文档阶段，PRD 即契约，直接开发 → QA → 验收（省 token/时间，可追溯性保留）' },
      mode: { type: 'string', description: '需求路由模式：full / medium / lite / tech / patch（缺省自动 triage；可用 teamflow_triage 预判）' },
      productRoot: { type: 'string', description: '产品线目录（如 products/tetris）' },
      maxConcurrency: { type: 'integer', description: '开发任务并发数（默认 3，最大 8）' },
      tasks: {
        type: 'array',
        description: '可拆分的开发任务列表（可选）',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '任务标题' },
            spec: { type: 'string', description: '任务描述与验收要点' },
          },
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['runId', 'status'], properties: { runId: { type: 'string' }, status: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: `团队研发流水线已启动（runId=${value.runId}，${value.status}）。可看面板或 teamflow_status 查询进度/阶段 token；backlog 已持久化到 $DSH_HOME/teamflow。` }],
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
    description: '需求分诊（可选辅助）：缺省情况下 teamflow_start 已自动分诊选模式，无需手动调用本工具。仅当你希望**预先评估**某需求适合的流程、或**强制指定**模式时使用——由一个分诊分析师 Agent 对需求思考一轮，返回建议模式、性质、是否需 UI、复杂度与论据。',
    parameters: {
      requirement: { type: 'string', required: true, description: '用户原始需求描述' },
      needDesign: { type: 'boolean', description: '涉及 UI 改造时设为 true' },
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
    description: '查询团队研发流水线状态。带 runId 返回该运行完整进度（阶段/每 Agent 状态与 token/日志/结果/是否需人工）；不带 runId 返回当前工作区最近的运行列表。',
    parameters: { runId: { type: 'string', description: '流水线运行 ID（可选）' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args, exec) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      if (id) {
        const j = runs.get(id)
        if (!j) return { error: `未找到运行：${id}` }
        return { runId: j.id, status: j.status, workspace: j.workspace || null, snapshot: snapshotOf(j) }
      }
      const sc = workspaceScopeOf(exec && exec.agent)
      const arr = runsFor(sc.projectKey).slice(0, 10).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, requirement: clip(j.requirement, 60) }))
      return { runs: arr, workspace: sc }
    },
  })

  T({
    name: 'teamflow_backlog',
    description: '查看团队 backlog：给定产品线（缺省返回当前会话所属工作区/项目）展示需求/任务/缺陷及其状态机。单任务模型：一个需求一张轮转任务卡（待办→开发中→待测试→测试中→待验收→已验收|打回|需人工），任务卡含 devAssign/qaAssign 分配人与真实 token usage。缺陷: 待认领→处理中→已修复待验→已关闭。返回 persistence（mode=fs/durable=true，含真实落盘路径）。',
    parameters: { product: { type: 'string', description: '产品线目录（如 products/tetris）；缺省按当前会话工作区' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args, exec) {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return backlogSummary(product)
    },
  })

  T({
    name: 'teamflow_claim',
    description: '认领 backlog 里的任务或缺陷（只改 status，不碰 assign）：task role=dev 认领（待办→开发中）/ role=qa 认领（待测试→测试中）；bug 认领（待认领→处理中）；req 立项（→进行中）。分配人请用 teamflow_assign 单独设置。',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: '记录 id（如 task-3 / bug-1）' },
      role: { type: 'string', description: 'task 认领角色：dev（默认，待办→开发中）| qa（待测试→测试中）' },
      product: { type: 'string', description: '产品线目录（缺省按当前会话工作区）' },
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
    description: '人工推进/处理 backlog 记录的状态（只改 status，不碰 assign）：task→accepted(完成)/rework(打回)/running(开发中)/testing(测试中)/testable(待测试)/pending-acceptance(待验收)；bug→claimed(认领)/fixed(已修复)/verified(已验证关闭)/reopened(重开)/needs-human；req→accepted(验收通过)/closed(关闭)/needs-human。处理 needs-human 时请用一个合法终态（如 accepted/verified/closed）清除标记。分配人请用 teamflow_assign 单独设置。',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: '记录 id' },
      to: { type: 'string', required: true, description: '目标状态' },
      product: { type: 'string', description: '产品线目录' },
      reason: { type: 'string', description: '变更原因' },
    },
    output: { schema: simple, render: simpleRender },
    execute: async (args, exec) => {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return transitionBacklog(product, String(args.kind || ''), String(args.id || ''), String(args.to || ''), args.reason ? String(args.reason) : '人工流转')
    },
  })

  T({
    name: 'teamflow_assign',
    description: '分配 backlog 里的任务给某个角色（只写 devAssign/qaAssign/acceptBy 字段，不碰 status，不影响状态流转）。role=dev 写入 devAssign（谁负责开发）、role=qa 写入 qaAssign（谁负责测试）、role=accept 写入 acceptBy（谁验收）。可在任意时刻调用，不依赖当前状态。',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: '记录 id（如 task-1）' },
      role: { type: 'string', required: true, description: '分配角色：dev | qa | accept' },
      assignee: { type: 'string', required: true, description: '分配人标识（子代理 ID/人名）' },
      product: { type: 'string', description: '产品线目录' },
    },
    output: { schema: simple, render: simpleRender },
    execute: async (args, exec) => {
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      return assignTask(product, String(args.kind || ''), String(args.id || ''), String(args.role || ''), String(args.assignee || ''))
    },
  })

  T({
    name: 'teamflow_pause',
    description: '暂停当前会话的 teamflow 流水线触发：调用后 teamflow_start 返回提示而非启动流水线。用于用户说「别走 teamflow 了」「直接改」「暂停 teamflow」等场景。会话级生效，重启会话自动恢复。',
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
    description: '恢复当前会话的 teamflow 流水线触发（撤销 teamflow_pause）。用户说「恢复 teamflow」「可以走 teamflow 了」时调用。',
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
    description: '取消一条正在运行的团队研发流水线。',
    parameters: { runId: { type: 'string', required: true, description: '流水线运行 ID' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? `已请求取消流水线 ${args.runId}` : '取消失败' }] },
    async execute(args) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return { ok: id ? cancelRun(id) : false }
    },
  })

  T({
    name: 'teamflow_resume',
    description: '从断点续跑一条中断/失败/已取消的团队研发流水线：跳过已完成阶段（复用产物），从第一个未完成阶段重跑。用于进程重启后发现 interrupted 运行、或阶段失败需要重试的场景。',
    parameters: {
      runId: { type: 'string', required: true, description: '流水线运行 ID' },
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
      runs: arr.slice(0, 30).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, requirement: clip(j.requirement, 60) })),
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

  start(sessionId, requirement, options) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const req = typeof requirement === 'string' && requirement.trim() ? requirement.trim() : null
    if (!sid || !req) return { ok: false, error: '缺少 sessionId 或需求描述' }
    const agent = runtime.agents && runtime.agents.get(sid)
    if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sid}` }
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
    if (agent && typeof agent.inject === 'function') {
      try {
        agent.inject({
          type: 'user',
          content: [{ type: 'text', text: `[TeamFlow 上下文] 用户已选择「${team.icon} ${team.name}」团队。只有收到明确的开发需求（新功能/迭代/重构/bug修复/代码改动请求）时才调用 teamflow_start 并指定 teamId="${tid}"。收到反馈、讨论、闲聊、UI 意见等非开发请求时，不要调用 teamflow_start，直接正常回复。` }],
          source: { kind: 'plugin', plugin: 'dsh-plugin-teamflow', form: 'context' },
        })
      } catch (e) { /* inject 失败不影响主流程 */ }
    }
    return { ok: true, team: { id: team.id, name: team.name, icon: team.icon } }
  }

  /** 获取当前会话的活跃团队。 */
  getActiveTeam(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { team: null }
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
