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
import { RETRY_LIMIT, STAGE_TOKEN_BUDGET, STATUS, COST_BUDGET_TOKENS, PHASE_ORDER, PHASE_KEY_OF, PHASE_KEY_BY_NAME } from './constants.ts'
import { toText, clip, extractText, normalizeRoot, normalizeTasks, sanitizeSnapOptions, normalizeSignal, hasSubstance, isUnretryable, handoffBrief } from './util.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, devPrompt, qaPrompt, acceptancePrompt } from './prompts/index.ts'
import { runtime, runs, inFlight, activeProducts, providerName, setRuntime } from './core/context.ts'
import { storeFor, backlogSummary, transitionBacklog, parseDefects, initPipelineBacklog, advanceTask } from './core/backlog.ts'
import { measureTokens, accumulateSessionUsage, costTokensOf } from './core/metering.ts'
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

function listRuns() {
  const arr = []
  for (const j of runs.values()) arr.push(j)
  arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
  return arr.slice(0, 30).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, requirement: clip(j.requirement, 60) }))
}

function snapshotOf(j) {
  return {
    id: j.id, name: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    requirement: clip(j.requirement, 2000), options: sanitizeSnapOptions(j.options), agentsStarted: j.agentsStarted,
    humanIntervention: j.humanIntervention === true,
    stages: j.stages.map((s) => ({ seq: s.seq, label: s.label, phase: s.phase, status: s.status, outcome: s.outcome, childId: s.childId, startedAt: s.startedAt, endedAt: s.endedAt, tokens: s.tokens, summary: clip(s.summary || '', 3000) })),
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
    description: '启动团队研发流水线：产品经理产出 PRD（基于既有模式/产品记忆，文档归档防臃肿）→（涉及 UI 改造时）UI/UX 设计 →（新项目时）架构师规划并落地脚手架 + AGENTS.md → 高级全栈工程师技术方案（与派发任务对齐）→ 可拆分任务时按并发并行开发 → QA 功能测试（结构化缺陷→登记 Bug）→ 产品验收（更新产品记忆）。阶段失败自动重试，超阈值打回并需人工介入；每阶段记录 token 用量；backlog 持久化到 $DSH_HOME/teamflow/<product>/。**缺省会自动对需求分诊选择轻重流程（patch/lite/tech/medium/full），无需手动指定**；高级调用可显式传 mode 覆盖。当用户提出开发需求时调用它，带上 productRoot（如 products/tetris）。',
    parameters: {
      requirement: { type: 'string', required: true, description: '用户的需求描述' },
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
      try {
        const requirement = typeof args.requirement === 'string' && args.requirement.trim() ? args.requirement.trim() : '(未提供需求)'
        const options = {
          needDesign: !!args.needDesign,
          needScaffold: !!args.needScaffold,
          lite: !!args.lite,
          mode: normalizeMode(args.mode) || undefined,
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
    description: '查询团队研发流水线状态。带 runId 返回该运行完整进度（阶段/每 Agent 状态与 token/日志/结果/是否需人工）；不带 runId 返回最近运行列表。',
    parameters: { runId: { type: 'string', description: '流水线运行 ID（可选）' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      if (id) {
        const j = runs.get(id)
        if (!j) return { error: `未找到运行：${id}` }
        return { runId: j.id, status: j.status, snapshot: snapshotOf(j) }
      }
      return { runs: listRuns().slice(0, 10) }
    },
  })

  T({
    name: 'teamflow_backlog',
    description: '查看团队 backlog：给定产品线（缺省返回默认产品）展示需求/任务/缺陷及其状态机（需求: 立项→进行中→待验收/已验收；任务: 待办→开发中→待测试→测试中→待验收→完成|打回|需人工；缺陷: 待认领→处理中→已修复待验→已关闭）。返回 persistence（mode=fs/durable=true，含真实落盘路径）。',
    parameters: { product: { type: 'string', description: '产品线目录（如 products/tetris）；缺省看默认产品' } },
    output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
    async execute(args) {
      const product = args && typeof args.product === 'string' ? normalizeRoot(args.product) : null
      return backlogSummary(product)
    },
  })

  T({
    name: 'teamflow_claim',
    description: '开发认领 backlog 里的任务或缺陷（task 置为 running 开发中 / bug 置为 claimed 处理中），设置 owner。用于认领待办或 QA 登记的缺陷。',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: '记录 id（如 task-3 / bug-1）' },
      product: { type: 'string', description: '产品线目录' },
    },
    output: { schema: simple, render: simpleRender },
    async execute(args) {
      const store = storeFor(normalizeRoot(args.product))
      const item = store.find(String(args.kind), String(args.id))
      if (!item) return { ok: false, error: `找不到 ${args.kind} #${args.id}` }
      const to = String(args.kind) === 'bug' ? 'claimed' : String(args.kind) === 'task' ? 'running' : 'in-progress'
      store.pushEvent(item, item.status, to, '开发认领')
      item.owner = (item.owner || '') || `team${Math.floor(Math.random() * 900 + 100)}`
      store.persist()
      return { ok: true, item: { id: item.id, status: item.status, owner: item.owner } }
    },
  })

  T({
    name: 'teamflow_update',
    description: '人工推进/处理 backlog 记录的状态，用于处理「需人工介入」或缺陷循环：task→accepted(完成)/rework(打回)/running/testable/testing/pending-acceptance；bug→claimed(认领)/fixed(已修复)/verified(已验证关闭)/reopened(重开)/needs-human；req→accepted(验收通过)/closed(关闭)/needs-human。处理 needs-human 时请用一个合法终态（如 accepted/verified/closed）清除标记。',
    parameters: {
      kind: { type: 'string', required: true, description: 'req | task | bug' },
      id: { type: 'string', required: true, description: '记录 id' },
      to: { type: 'string', required: true, description: '目标状态' },
      product: { type: 'string', description: '产品线目录' },
      reason: { type: 'string', description: '变更原因' },
    },
    output: { schema: simple, render: simpleRender },
    execute: async (args) => transitionBacklog(normalizeRoot(args.product), String(args.kind), String(args.id), String(args.to), args.reason ? String(args.reason) : '人工流转'),
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
export class TeamflowService extends TypertRemoteService {
  static inject = ['agents', 'subagents', 'tokenMeter', 'typert', 'tools']

  constructor(ctx) {
    super(ctx, 'teamflow')
    setRuntime(ctx.get('agents'), ctx.get('subagents'), ctx.get('tokenMeter'))
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
      + `工具 6 个${interruptedCount > 0 ? `，⚠ 发现 ${interruptedCount} 条中断的流水线（可用 teamflow_resume 从断点重跑）` : ''}`,
    )
  }

  /* ── Remote 方法（client 经 ctx.remote.teamflow.* 调用） ─────────── */

  ping() {
    return { ok: true }
  }

  list() {
    return { runs: listRuns() }
  }

  snapshot(runId) {
    if (runId && typeof runId === 'string') {
      const j = runs.get(runId)
      return j ? snapshotOf(j) : null
    }
    const latest = listRuns()[0]
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
      return { ok: true, runId, product: opts.productRoot ? normalizeRoot(opts.productRoot) : null }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  cancel(runId) {
    const id = typeof runId === 'string' ? runId : null
    if (!id) return { ok: false, error: '缺少 runId' }
    return { ok: cancelRun(id) }
  }

  backlog(product) {
    return backlogSummary(normalizeRoot(product))
  }

  backlogUpdate(kind, id, to, product, reason) {
    const k = String(kind || '')
    const i = String(id || '')
    const t = String(to || '')
    if (!k || !i || !t) return { ok: false, error: '缺少 kind/id/to' }
    return transitionBacklog(normalizeRoot(product), k, i, t, reason ? String(reason) : '人工流转')
  }

  /** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑。 */
  resume(runId, sessionId) {
    return resumeRun(runId, sessionId)
  }
}

export default TeamflowService
