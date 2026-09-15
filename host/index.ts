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
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  Journal, BacklogItem, PipelineOptions, ResumeContext, SubagentRunLike, ParentAgentLike, UsageBuckets,
} from './types.ts'
import { RETRY_LIMIT, STATUS, PHASE_ORDER, PHASE_KEY_OF, PHASE_KEY_BY_NAME, phaseKeyOf, TEAMFLOW_ARTIFACT_ORDER } from './constants.ts'
import { toText, clip, extractText, normalizeRoot, normalizeTasks, sanitizeSnapOptions, normalizeSignal, isUnretryable, handoffBrief, runPool } from './util.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, devPrompt, qaPrompt, acceptancePrompt } from './prompts/index.ts'
import { runtime, runs, inFlight, activeProducts, providerName, setRuntime, setSessionProjections, workspaceScopeOf } from './core/context.ts'
import { backlogSummary, transitionBacklog, assignTask, storeFor } from './core/backlog.ts'
import { runsFor, runAddress, productKeyOf, runVisibleIn, runBrief, productMetaOf, listProducts } from './core/products.ts'
import { loadTeams, findTeam, teamNameOf, teamDescOf, type TeamConfig } from './core/teams.ts'
import { runAgent, withRetry } from './core/runner.ts'
import { deliverCompletion } from './core/report.ts'
import { runSanityCheck, gitCmd } from './core/sanity.ts'
import { join } from 'node:path'
import { mkdirSync, readdirSync } from 'node:fs'
import { executePipeline, summarizeTimeline, startPipeline, resumeRun } from './core/pipeline.ts'
import { cancelRun } from './core/context.ts'
import { suggestMode, MODE_REGISTRY, PIPELINE_MODES, normalizeMode, runTriage, guardrailUpgrade, type TriageVerdict } from './core/triage.ts'
import { t, modeDesc } from './locales.ts'
import { setSettingsPort, noteClientLocale, ambientLocale } from './core/locale.ts'

/* BacklogStore / storeFor 见 core/backlog.ts（数据层与状态机）。 */

/**
 * 需求澄清闸门 · 启动前预检（2026-09-16 Phase 1）。
 *
 * 分诊本来就是一次模型调用——这里把它**前移到建 run 之前**，用同一份裁决判两件事：
 * ① `intent` 是否「明确需求」（`exploration` = 还在探讨、`feedback` = 对现状的反馈）；② 有没有 **must-know**
 * 缺口（`blockers`，已过 host 合格线：≥2 互斥读法 + 改变哪个产物/AC + 猜错返工什么）。命中任一 → 返回
 * `needs-clarification`，**不建 run**——实锤：社区讨论 #6405 用户说「我想开发一个 dsh 插件」→ 直接跑完整条
 * 流水线（他本人：「我都不知道自己想要啥」）。
 *
 * 边界（2026-09-16 放宽，勿回退）：**只有 `patch` 档豁免**——其余一律跑（含显式 `lite`/`mode`）。原因：实测
 * 模型**系统性**自行传档位（33 次启动里 14 次显式传入、只有 0 次先跑 `teamflow_triage` 预览），若继续豁免，
 * 澄清闸门与 ADR-0006 的架构护栏会在 **42% 的启动**上静默失效。分诊不可用/超时 → verdict=null → **放行**
 * （退回现状行为，零回归）。裁决透传 pipeline（`options.__triage`）：**不重复跑分诊**，并让 `journal.triage`
 * 拿到 shadow 样本。档位处理：调用方没给 → 用分诊档位；给了更轻的而分诊判 ≥medium → **护栏强升**
 * （`guardrailUpgrade`，ADR-0006）；调用方给的是 medium/full（或已 ≥ 分诊档位）→ 保持其选择。
 */
async function clarificationPreflight(
  requirement: string,
  options: Record<string, unknown>,
  parent: unknown,
  locale: ReturnType<typeof ambientLocale>,
): Promise<{ needsClarification: { intent: string; blockers: TriageVerdict['blockers'] } } | { verdict: TriageVerdict | null }> {
  if (options.mode === 'patch') return { verdict: null }
  let verdict: TriageVerdict | null = null
  try {
    verdict = await runTriage(requirement, { needDesign: options.needDesign === true }, parent, undefined, locale)
  } catch (e) { verdict = null }
  if (!verdict) return { verdict: null }
  if (verdict.intent !== 'requirement' || verdict.blockers.length > 0) {
    return { needsClarification: { intent: verdict.intent, blockers: verdict.blockers } }
  }
  return { verdict }
}

/* 阶段/模板提示词见 prompts/（AGENTS_TEMPLATE / MEMORY_TEMPLATE / productCtx / TOKEN_HYGIENE / *Prompt）。 */

/* 阶段提示词 prd/design/scaffold/tech/dev/qa/acceptancePrompt 见 prompts/。 */

/* 并发池见 util.ts（runPool）；单阶段执行/重试熔断见 core/runner.ts（runAgent/withRetry）。 */

/* 缺陷解析 / 立项建卡 / 任务流转见 core/backlog.ts（parseDefects / initPipelineBacklog / advanceTask）。 */

/** 阶段顺序/key 映射见 constants.ts（PHASE_ORDER/PHASE_KEY_OF/PHASE_KEY_BY_NAME）。 */

/* 流水线编排/入口/取消/续跑与 resume 辅助见 core/pipeline.ts（buildResumeProducts/interruptedPhaseOf/executePipeline/summarizeTimeline）。 */

/* 流水线入口/断点续跑见 core/pipeline.ts（startPipeline/resumeRun）；取消见 core/context.ts（cancelRun）。 */

/** 按工作区作用域过滤运行见 core/products.ts（runsFor；全局面板与远程面共用）。 */

/** 由 sessionId 推导会话所属 workspace（项目）作用域。 */
function sessionScope(sessionId: string | null | undefined) {
  const sid = typeof sessionId === 'string' && sessionId ? sessionId : null
  const agent = sid && runtime.agents ? runtime.agents.get(sid) : undefined
  return workspaceScopeOf(agent || undefined)
}

function snapshotOf(j) {
  return {
    id: j.id, name: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
    // 右栏 run 详情 tab 的地址（host 生成；client 直接 openResource）
    address: runAddress(j.workspace || 'default', j.id),
    // 发起会话：全局面板据此跳到"这条 run 所属的会话"再开右栏（否则会挂到用户当前所在会话上，无意义）
    ownerSession: j.ownerSession || null,
    requirement: clip(j.requirement, 2000), options: sanitizeSnapOptions(j.options), agentsStarted: j.agentsStarted,
    humanIntervention: j.humanIntervention === true,
    // ⚠️ `taskKey` 必须在投影里（2026-09-16 回归修正）：client 的 `stageLabelOf` 靠它区分「任务级阶段
    // （dev 子卡，保留任务名）」与「其余阶段（走 phase 词表本地化）」。此前漏了它 → 所有 dev 卡片退化成
    // 只显示阶段名「开发」（实锤：截图里的 tf-mtr9mi37-m9zx1u 三张卡片，journal 里标题完好，UI 却只剩「开发」）。
    stages: j.stages.map((s) => ({ seq: s.seq, label: s.label, phase: s.phase, taskKey: s.taskKey || null, status: s.status, outcome: s.outcome, childId: s.childId, startedAt: s.startedAt, endedAt: s.endedAt, usage: s.usage, summary: clip(s.summary || '', 3000) })),
    logs: j.logs.slice(-200).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
    error: j.error, resultPreview: j.result ? clip(JSON.stringify(j.result), 6000) : null,
  }
}

/* backlog 视图/流转见 core/backlog.ts（backlogSummary/transitionBacklog）。 */
/* 产品线装配（runsFor/runAddress/runBrief/productMetaOf/listProducts）见 core/products.ts。 */

/* ── 模型工具注册 ─────────────────────────────────────────────────── */
const simple = { type: 'object', additionalProperties: true }
const simpleRender = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 4000) }]

function registerTools(ctx) {
  let registeredCount = 0
  // ctx.tools.register() 把 parameters 原样送到 wire：必须先编译成
  // { type: 'object', properties, required } 完整 JSON Schema，否则提供方
  // 以「schema 缺 type: object」拒绝（如 teamflow_backlog invalid_request_error）。
  const T = (tool) => {
    registeredCount++
    return ctx.tools.register({
      ...tool,
      parameters: parameterSchemaSpecToJsonSchema(tool.parameters),
    })
  }

  T({
    name: 'teamflow_start',
    description: 'Start the team R&D pipeline (background async): runs the stages per team config (PRD→design→tech→dev→QA→acceptance). Specify teamId (matches teams.json) or pick a team via the UI "+" button first so messages auto-match. Stage failures auto-retry; beyond threshold → rework/human intervention; per-stage token usage recorded. NOTE: after calling, the implementation work is done by pipeline subagents — the main thread MUST NOT write code or run verifications for it. Routing: omit `mode`/`lite` and let auto-triage decide the tier (it applies the architecture guardrails); pass them only when the user explicitly asked for that tier. requirement must be a faithful transcription of the user\'s words; do not invent file paths / tech claims without code verification (downstream stages build the PRD from it). Clarification gate: if the return status is "needs-clarification", this is NOT a settled requirement yet (or it has must-know gaps) — do NOT retry blindly: discuss it with the user in your own words (the returned blockers list what is missing and why), then RE-CALL this tool with the original requirement plus requirementSupplement = the user\'s answers. Branch decision: when the return status is "needs-decision", ASK THE USER to pick one of the options (or take their custom input, e.g. a branch name), then RE-CALL this tool passing the CHOSEN OPTION VALUE as branchPolicy ("new" = confirmed create branch, "keep" = stay), optionally combined with preAction / branchName / commitMessage. Pass branchPolicy="keep" when the user chooses to stay on the current branch.',
    parameters: {
      requirement: { type: 'string', required: true, description: 'The user requirement — faithful transcription of the user\'s words; no fabricated file paths, tech designs, or unverified claims' },
      teamId: { type: 'string', description: 'Team id (matches teams.json; defaults to the currently selected team of this session)' },
      needDesign: { type: 'boolean', description: 'Set true when the change involves UI' },
      needScaffold: { type: 'boolean', description: 'Set true when the project does not exist yet' },
      lite: { type: 'boolean', description: 'Lightweight mode for genuinely small single-module changes. **Do NOT pick the tier yourself by default**: omit both `mode` and `lite` and let auto-triage decide — it applies the architecture guardrails (persistence/abstraction/cross-module → at least medium) that a hand-picked tier bypasses. Set `lite=true` only when the USER explicitly asked for a lightweight/fast run, or the change is a proven single-module micro change.' },
      mode: { type: 'string', description: 'Route mode: full / medium / lite / tech / patch. **Do NOT pick the tier yourself by default** — omit it and let auto-triage decide (recommended), or preview with teamflow_triage and pass what it returns. A hand-picked lighter tier is subject to the architecture guardrail: if triage judges the requirement architectural it is upgraded (logged), so the guardrail can never be bypassed.' },
      productRoot: { type: 'string', description: 'Product line directory (e.g. products/tetris)' },
      maxConcurrency: { type: 'integer', description: 'Dev task concurrency (default 3, max 8)' },
      branchPolicy: { type: 'string', description: 'Branch policy: "auto" (default, triggers needs-decision when not yet confirmed) — create a feature branch feat/<branchName|slug> from the current HEAD; "keep" — stay on current branch; "new" — the confirmed value returned by needs-decision options (user already picked "create branch"), pass it back as-is to proceed. When auto and a decision is needed (dirty workspace / on main etc.), the tool returns needs-decision for you to ask the user first.' },
      branchName: { type: 'string', description: 'Custom branch name (used when branchPolicy=auto; defaults to the triage slug; [a-z0-9-_])' },
      preAction: { type: 'string', description: 'Pre-start handling of dirty workspace: "stash" (stash changes, restore later via git stash pop), "commit" (commit existing changes, custom commitMessage), omit = leave as-is (changes mix into this run)' },
      commitMessage: { type: 'string', description: 'Custom commit message when preAction=commit' },
      requirementSupplement: { type: 'string', description: 'Extra context the user gave during a clarification round (after a "needs-clarification" return). Kept separate from the original requirement (which stays a faithful transcription of the user\'s words) and handed to the PRD stage as authoritative input.' },
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
      schema: { type: 'object', additionalProperties: false, required: ['status'], properties: { runId: { type: 'string' }, status: { type: 'string' }, question: { type: 'string' }, options: { type: 'array' }, note: { type: 'string' }, intent: { type: 'string' }, blockers: { type: 'array' } } },
      render: (args, value) => {
        if (value && value.status === 'needs-decision') {
          const opts = Array.isArray(value.options) ? value.options.map((o, i) => `${i + 1}. ${o.label}`).join('\n') : ''
          return [{ type: 'text', text: t(ambientLocale(), 'tool.start.decision', { question: value.question, options: opts }) }]
        }
        if (value && value.status === 'needs-confirmation') {
          return [{ type: 'text', text: t(ambientLocale(), 'tool.start.needsConfirm', { question: value.question, note: value.note || '' }) }]
        }
        if (value && value.status === 'needs-clarification') {
          // 闸门文本由 host 组好交给主线程：它必须**先问用户**，拿到答复后带 requirementSupplement 重调。
          const list = Array.isArray(value.blockers)
            ? value.blockers.map((b, i) => `${i + 1}. ${b.question}\n   · ${t(ambientLocale(), 'tool.start.blockerReadings')}: ${(b.readings || []).join(' / ')}\n   · ${t(ambientLocale(), 'tool.start.blockerChanges')}: ${b.changes}\n   · ${t(ambientLocale(), 'tool.start.blockerRework')}: ${b.rework}`).join('\n')
            : ''
          return [{ type: 'text', text: t(ambientLocale(), 'tool.start.needsClarification', { intent: String(value.intent || 'requirement'), blockers: list }) }]
        }
        return [{ type: 'text', text: t(ambientLocale(), 'tool.start.started', { runId: value.runId, status: value.status }) }]
      },
    },
    async execute(args, exec) {
      const parent = exec && exec.agent
      if (!parent) throw new Error(t(ambientLocale(), 'err.tool.sessionAgentStart'))
      // 暂停检查：会话级暂停时拒绝启动
      const sessionId = parent.session && parent.session.id
      if (sessionId && pausedSessions.has(String(sessionId))) {
        return { runId: null, status: 'paused', message: t(ambientLocale(), 'tool.start.paused') }
      }
      // 团队检查：必须先通过 UI "+" 按钮选择团队，否则拒绝
      const teamId = (args && typeof args.teamId === 'string' && args.teamId.trim())
        || (sessionId && activeTeams.get(String(sessionId)))
        || null
      if (!teamId) {
        return { runId: null, status: 'no-team', message: t(ambientLocale(), 'tool.start.noTeam') }
      }
      // 需求意图预检（ADR-2026-08-28）：疑问/建议/反馈句式（「是不是应该」「要不要」）→ 更像反馈而非明确
      // 开发需求——不启动，返回确认请求由主线程 Agent 先向用户确认（实锤：用户反馈「是不是应该加个 Toast」
      // 被误判为需求启动流水线；Agent 记住 teamId 显式传入绕过了团队状态检查）。
      // 误伤处理：明确需求带疑问词时（如「是不是有 bug」）→ 用户确认一句即可重发，成本低于整条流水线误跑。
      const rawReq = typeof args.requirement === 'string' ? args.requirement : ''
      if (/是不是|要不要|需不需要|是否应该|要不要考虑|建议|我感觉|感觉不出|我们是不是|咱是不是/.test(rawReq)) {
        return {
          status: 'needs-confirmation',
          question: t(ambientLocale(), 'tool.start.confirmQuestion', { requirement: rawReq.slice(0, 60) }),
          note: t(ambientLocale(), 'tool.start.confirmNote'),
        }
      }
      try {
        const requirement = typeof args.requirement === 'string' && args.requirement.trim() ? args.requirement.trim() : t(ambientLocale(), 'tool.start.noRequirement')
        const options = {
          needDesign: !!args.needDesign,
          needScaffold: !!args.needScaffold,
          lite: !!args.lite,
          mode: normalizeMode(args.mode) || undefined,
          teamId,
          tasks: normalizeTasks(args.tasks),
          productRoot: normalizeRoot(args.productRoot),
          maxConcurrency: args.maxConcurrency,
          branchPolicy: (args.branchPolicy === 'keep' ? 'keep' : 'auto') as 'auto' | 'keep',
          branchName: typeof args.branchName === 'string' && args.branchName.trim() ? args.branchName.trim() : null,
          preAction: (args.preAction === 'stash' || args.preAction === 'commit') ? args.preAction : null,
          commitMessage: typeof args.commitMessage === 'string' && args.commitMessage.trim() ? args.commitMessage.trim() : null,
          requirementSupplement: typeof args.requirementSupplement === 'string' && args.requirementSupplement.trim() ? args.requirementSupplement.trim() : null,
        }
        // 需求澄清闸门（2026-09-16 Phase 1）：非「明确需求」或存在 must-know 缺口 → 不建 run，先让主线程问用户。
        // 放在分支决策之前：澄清是"要不要做/做成什么"的前置问题，分支是"怎么开工"，顺序反了会先问分支再问需求。
        const pre = await clarificationPreflight(requirement, options as unknown as Record<string, unknown>, parent, ambientLocale())
        if ('needsClarification' in pre) {
          return { status: 'needs-clarification', intent: pre.needsClarification.intent, blockers: pre.needsClarification.blockers }
        }
        if (pre.verdict) {
          // 复用同一份裁决：写回档位并透传给 pipeline（pipeline 不再重复跑分诊）
          // 档位：调用方没给 → 用分诊的；给了更轻的而分诊判 ≥medium → **架构护栏强升**（ADR-0006）；
          // 给了 medium/full → 保持调用方选择（避免无谓 token 放大）。
          const explicit = options.mode as typeof options.mode
          const up = guardrailUpgrade(explicit, !!options.lite, pre.verdict.mode)
          if (up) {
            if (up !== explicit) (pre.verdict as unknown as Record<string, unknown>).__upgradedFrom = explicit || (options.lite ? 'lite' : 'full')
            options.mode = up
            options.lite = up === 'lite' || up === 'tech' || up === 'patch' ? !!options.lite : false
          }
          if (pre.verdict.needDesign) options.needDesign = true
          ;(options as unknown as Record<string, unknown>).__triage = pre.verdict
        }
        // 分支策略决策（ADR-2026-08-27 基调：启动前由用户决定，选项+自定义兜底）。
        // 四种情况（main+干净 / main+脏 / feature+干净 / feature+脏）在 auto 策略下全部返回 needs-decision，
        // 由主线程 Agent 询问用户，用户选择后带 branchPolicy/branchName/preAction 重新调用。
        // 已确认信号：branchPolicy='new'（needs-decision 选项回传值，=已确认新建分支）或显式 branchName / preAction
        // ——否则裸 'auto'（默认值）无法区分「未决策」与「已确认新建」，重发后再次 needs-decision 死循环（实锤 run）。
        const branchConfirmed = args.branchPolicy === 'new'
        if (options.branchPolicy === 'auto' && !branchConfirmed && !options.branchName && !options.preAction && exec && exec.agent) {
          const sc = workspaceScopeOf(exec.agent)
          if (sc.path) {
            try {
              const s = runSanityCheck(sc.path)
              if (s.ok && s.inRepo) {
                const onMain = !!s.branch && s.branch.trim().toLowerCase() === 'main'
                const dirty = s.hasDirty
                const dirtyN = s.dirty.split(/\r?\n/).filter((l) => l.trim()).length
                let question = ''
                let optionsList: Array<{ label: string; value: string }> = []
                if (onMain && !dirty) {
                  question = t(ambientLocale(), 'branch.q.mainClean', { path: sc.path })
                  optionsList = [
                    { label: t(ambientLocale(), 'branch.opt.newFromMain'), value: 'new' },
                    { label: t(ambientLocale(), 'branch.opt.keepOnMain'), value: 'keep' },
                  ]
                } else if (onMain && dirty) {
                  question = t(ambientLocale(), 'branch.q.mainDirty', { path: sc.path, n: dirtyN })
                  optionsList = [
                    { label: t(ambientLocale(), 'branch.opt.stashNew'), value: 'stash+auto' },
                    { label: t(ambientLocale(), 'branch.opt.commitNew'), value: 'commit+auto' },
                    { label: t(ambientLocale(), 'branch.opt.keepMainDirty'), value: 'keep' },
                  ]
                } else if (!onMain && !dirty) {
                  question = t(ambientLocale(), 'branch.q.featureClean', { path: sc.path, branch: s.branch })
                  optionsList = [
                    { label: t(ambientLocale(), 'branch.opt.keepFeature'), value: 'keep' },
                    { label: t(ambientLocale(), 'branch.opt.newChild'), value: 'new' },
                  ]
                } else {
                  question = t(ambientLocale(), 'branch.q.featureDirty', { path: sc.path, branch: s.branch, n: dirtyN })
                  optionsList = [
                    { label: t(ambientLocale(), 'branch.opt.stashKeep'), value: 'stash+keep' },
                    { label: t(ambientLocale(), 'branch.opt.keepDirtyFeature'), value: 'keep' },
                    { label: t(ambientLocale(), 'branch.opt.stashNewChild'), value: 'stash+auto' },
                    { label: t(ambientLocale(), 'branch.opt.commitNewChild'), value: 'commit+auto' },
                  ]
                }
                return {
                  status: 'needs-decision',
                  question,
                  options: optionsList,
                  note: t(ambientLocale(), 'branch.decisionNote'),
                }
              }
            } catch (e) { /* 分支检查失败：放行，由 sanity 注入 git 现状 */ }
          }
        }
        const runId = startPipeline(parent, requirement, options, exec && exec.signal)
        return { runId, status: 'running' }
      } catch (e) {
        throw new Error(t(ambientLocale(), 'err.tool.startFail', { msg: String((e && e.message) || e) }))
      }
    },
  })

  T({
    name: 'teamflow_merge',
    description: 'Merge the completed run\'s feature branch back to main — the user-confirmed closing step (ADR-2026-08-27). Valid only after acceptance passed (run status=completed) while on a feature branch ahead of main. **Ask the user first** — the completion report carries the decision invitation (① host merge ② manual command ③ keep). Actions: "merge" — host performs git checkout main && git merge --no-ff <branch>; "command" — print the manual command for the user to run themselves; "keep" — defer, mark run as kept (branch stays).',
    parameters: {
      action: { type: 'string', required: true, description: '"merge" (host performs the merge) / "command" (print the manual merge command) / "keep" (defer, mark kept)' },
      runId: { type: 'string', description: 'Run id (defaults to the latest completed run of this workspace)' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, required: ['status'], properties: { status: { type: 'string' }, message: { type: 'string' }, command: { type: 'string' } } },
      render: (args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      const action = args && args.action
      if (action !== 'merge' && action !== 'command' && action !== 'keep') throw new Error(t(ambientLocale(), 'err.tool.mergeAction'))
      const sc = workspaceScopeOf(exec && exec.agent)
      if (!sc.path) throw new Error(t(ambientLocale(), 'err.tool.noWorkspace'))
      const key = sc.projectKey
      const target = (typeof args.runId === 'string' && args.runId) ? runs.get(args.runId)
        : [...runs.values()].filter((j) => j.workspace === key && j.status === 'completed').sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0))[0]
      if (!target) throw new Error(t(ambientLocale(), 'err.tool.noCompletedRun'))
      const branch = gitCmd(sc.path, ['rev-parse', '--abbrev-ref', 'HEAD'])
      if (!branch || branch === 'main') return { status: 'noop', message: t(ambientLocale(), 'tool.merge.noop') }
      if (action === 'command') {
        return { status: 'command', command: `git checkout main && git merge --no-ff ${branch}`, message: t(ambientLocale(), 'tool.merge.command', { branch }) }
      }
      if (action === 'keep') {
        target.mergeStatus = 'kept'
        persistJournal(target)
        return { status: 'kept', message: t(ambientLocale(), 'tool.merge.kept', { branch }) }
      }
      // action=merge：host 代为执行（用户已确认）
      const co = gitCmd(sc.path, ['checkout', 'main'])
      const mg = co === null ? null : gitCmd(sc.path, ['merge', '--no-ff', branch])
      if (co === null || mg === null) {
        target.mergeStatus = 'failed'
        persistJournal(target)
        return { status: 'failed', message: t(ambientLocale(), 'tool.merge.failed', { branch }) }
      }
      target.mergeStatus = 'merged'
      persistJournal(target)
      return { status: 'merged', message: t(ambientLocale(), 'tool.merge.merged', { branch }) }
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
      const t = await runTriage(requirement, { needDesign: !!args.needDesign }, exec && exec.agent, exec && exec.signal, ambientLocale())
      return {
        suggestedMode: t.mode,
        kind: t.kind,
        needDesign: t.needDesign,
        complexity: t.complexity,
        confidence: t.confidence,
        rationale: t.rationale,
        source: t.source,
        stages: modeDesc(ambientLocale(), t.mode, MODE_REGISTRY[t.mode].desc),
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
        if (!j) return { error: t(ambientLocale(), 'err.tool.runNotFound', { id }) }
        const running = j.status === 'running'
        return { runId: j.id, status: j.status, workspace: j.workspace || null, reminder: running ? t(ambientLocale(), 'tool.status.reminder') : null, snapshot: snapshotOf(j) }
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
      if (!kind || !id) return { ok: false, error: t(ambientLocale(), 'err.tool.missingKindId') }
      const role = args && typeof args.role === 'string' ? String(args.role) : (kind === 'task' ? 'dev' : null)
      const product = args && typeof args.product === 'string' && args.product.trim() ? normalizeRoot(args.product) : workspaceScopeOf(exec && exec.agent).projectKey
      let to = 'running'
      if (kind === 'bug') to = 'claimed'
      else if (kind === 'req') to = 'in-progress'
      else if (kind === 'task') to = role === 'qa' ? 'testing' : 'running'
      return transitionBacklog(product, kind, id, to, kind === 'bug' ? t(ambientLocale(), 'tool.reason.bugClaim') : t(ambientLocale(), 'tool.reason.claim'))
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
      return transitionBacklog(product, String(args.kind || ''), String(args.id || ''), String(args.to || ''), args.reason ? String(args.reason) : t(ambientLocale(), 'tool.reason.manual'))
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
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.message || (value.ok ? t(ambientLocale(), 'tool.pause.done') : t(ambientLocale(), 'tool.pause.fail')) }] },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.id
      if (!sessionId) return { ok: false, message: t(ambientLocale(), 'err.tool.noSessionId') }
      pausedSessions.add(String(sessionId))
      return { ok: true, message: t(ambientLocale(), 'tool.pause.ok', { session: String(sessionId).slice(-6) }) }
    },
  })

  T({
    name: 'teamflow_resume_session',
    description: 'Resume teamflow triggering for the CURRENT session (undo teamflow_pause). For user phrases like「恢复 teamflow」「可以走 teamflow 了」.',
    parameters: {},
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.message || (value.ok ? t(ambientLocale(), 'tool.resumeSession.done') : t(ambientLocale(), 'tool.resumeSession.fail')) }] },
    async execute(args, exec) {
      const sessionId = exec && exec.agent && exec.agent.session && exec.agent.session.id
      if (!sessionId) return { ok: false, message: t(ambientLocale(), 'err.tool.noSessionId') }
      pausedSessions.delete(String(sessionId))
      return { ok: true, message: t(ambientLocale(), 'tool.resumeSession.ok', { session: String(sessionId).slice(-6) }) }
    },
  })

  T({
    name: 'teamflow_cancel',
    description: 'Cancel a running team R&D pipeline.',
    parameters: { runId: { type: 'string', required: true, description: 'Pipeline run id' } },
    output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? t(ambientLocale(), 'tool.cancel.ok', { runId: args.runId }) : t(ambientLocale(), 'tool.cancel.fail') }] },
    async execute(args) {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return { ok: id ? cancelRun(id, 'tool') : false }
    },
  })

  T({
    name: 'teamflow_resume',
    description: 'Resume an interrupted/failed/cancelled pipeline from its checkpoint: skip completed stages (reuse artifacts), rerun from the first incomplete stage. For interrupted runs found after process restart, or stage-failure retries.',
    parameters: {
      runId: { type: 'string', required: true, description: 'Pipeline run id' },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, runId: { type: 'string' }, resumedFrom: { type: 'string' }, error: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? t(ambientLocale(), 'tool.resume.ok', { runId: value.runId, phase: value.resumedFrom }) : t(ambientLocale(), 'tool.resume.fail', { error: value.error || t(ambientLocale(), 'err.tool.unknown') }) }] },
    async execute(args, exec) {
      const parent = exec && exec.agent
      if (!parent) throw new Error(t(ambientLocale(), 'err.tool.sessionAgentResume'))
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return resumeRun(id, parent.session.id)
    },
  })
  return registeredCount
}

/* ── Teamflow Service（宿主 Cordis service + Remote 方法）────────── */
/** 会话级暂停标记：pausedSessions.has(sessionId) → 该会话的 teamflow_start 被拦截。 */
const pausedSessions = new Set<string>()
/** 会话级当前团队：activeTeams.get(sessionId) → 当前选中的团队 id。
 * 持久化到 $DSH_HOME/teamflow/active-teams.json——重启后恢复（实锤：重启/刷新后内存清空，
 * UI 显示无团队，但 agent 上下文记忆 teamId 显式传入仍启动流水线，UI 状态与启动通道不一致）。 */
const activeTeams = new Map<string, string>()
const ACTIVE_TEAMS_FILE = () => join(teamflowRoot(), 'active-teams.json')
function loadActiveTeams(): void {
  try {
    const raw = readJsonAny(ACTIVE_TEAMS_FILE(), null) as Record<string, unknown> | null
    if (raw && typeof raw === 'object') {
      for (const [k, v] of Object.entries(raw)) if (typeof k === 'string' && typeof v === 'string') activeTeams.set(k, v)
    }
  } catch (e) { /* 损坏静默 */ }
}
function saveActiveTeams(): void {
  try {
    mkdirSync(teamflowRoot(), { recursive: true })
    writeJson(ACTIVE_TEAMS_FILE(), Object.fromEntries(activeTeams))
  } catch (e) { /* 保存失败静默 */ }
}
/** 延迟注入队列：选团队时 agent 可能尚未加载，存入 pending，后续时机补发。 */
const pendingInjections = new Map<string, { teamName: string; teamIcon: string; teamId: string }>()

/** 尝试补发延迟注入：agent 可用时注入上下文并清除 pending。 */
/** 会话注入的 TeamFlow 契约文案（单一事实来源）：何时走流水线 + 启动后主线程必须停手等汇报。 */
function teamflowContextText(teamIcon: string, teamName: string, teamId: string): string {
  return t(ambientLocale(), 'tool.ctx.team', { icon: teamIcon, name: teamName, teamId })
}

/**
 * 团队的下发载荷（client 直接渲染）：`name`/`description` 已按语言本地化。
 * 为什么不给 client 双语字段让它自己挑：**语言只有一个读取点**（`core/locale.ts`），
 * 且 client 侧语言与 ambient 同源（都来自浏览器），host 本地化一次即可；client 拿到即用。
 */
function teamPayload(locale: string, team: TeamConfig): { id: string; name: string; icon: string; description: string } {
  return { id: team.id, name: teamNameOf(locale, team), icon: team.icon, description: teamDescOf(locale, team) }
}

function tryFlushPendingInjections(sessionId: string): void {
  const pending = pendingInjections.get(sessionId)
  if (!pending) return
  const agent = runtime.agents ? runtime.agents.get(sessionId) : undefined
  if (!agent || typeof agent.inject !== 'function') return
  try {
    // 必须经 createUserMessage（宿主 v2 校验要求 user/message 带非空 id/role/source——
    // 裸 payload 落盘后加载即「lacks an identified message」（实锤 session-8c3f9888 seq 10））
    agent.inject(createUserMessage({
      content: [{ type: 'text', text: teamflowContextText(pending.teamIcon, pending.teamName, pending.teamId) }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-teamflow', form: 'instructions' },
    }))
    pendingInjections.delete(sessionId)
  } catch (e) { /* inject 失败静默 */ }
}

export class TeamflowService extends TypertRemoteService {
  static inject = ['agents', 'subagents', 'typert', 'tools', 'llm']

  constructor(ctx) {
    super(ctx, 'teamflow')
    // 注：曾硬注入 tokenMeter 但全仓从未使用（2026-09-10 清理）——计量走 sessionProjections 投影。
    setRuntime(ctx.get('agents'), ctx.get('subagents'), ctx.get('workspaceRegistry'), ctx.get('agentDefaultModel'), ctx.get('llm'))
    // 可选能力：官方 Session 投影注册表（计量首选来源 tokenUsage/sessionStats）。
    // 走 ctx.inject 而非 static inject——服务缺失（最小 profile）时插件仍加载，计量回退事件扫描。
    ctx.inject(['sessionProjections'], (projectionCtx) => {
      setSessionProjections(projectionCtx.get('sessionProjections'))
    })
    // 宿主显式语言（只读）：@deepseek-ai/dsh-client-locale 的 host face 注册 'locale' 命名空间；
    // 服务缺失/未注册 → undefined → 解析链降级（AC-10 不报错不阻塞）。
    ctx.inject(['settings'], (settingsCtx) => {
      setSettingsPort(() => {
        const settings = settingsCtx.get('settings')
        const v = settings && typeof settings.get === 'function' ? settings.get('locale') : null
        return v && v.preference
      })
    })
    loadActiveTeams() // 重启后恢复会话→团队映射（UI 状态与启动通道一致）
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
    const modelTools = registerTools(ctx)
    console.log(
      `[teamflow] host 就绪：backlog 根 ${teamflowRoot()}，Remote ${TEAMFLOW_DESCRIPTORS.length} 个，`
      + `工具 ${modelTools} 个${interruptedCount > 0 ? `，⚠ 发现 ${interruptedCount} 条中断的流水线（可用 teamflow_resume 从断点重跑）` : ''}`,
    )
  }

  /* ── Remote 方法（client 经 ctx.remote.teamflow.* 调用） ─────────── */

  ping() {
    return { ok: true }
  }

  /** 客户端语言上报（浏览器当前语言含系统探测结果）→ 写入运行期语言源；返回解析后的环境语言。 */
  setLocale(locale) {
    noteClientLocale(locale)
    return { ok: true, locale: ambientLocale() }
  }

  /** 工作区级看板：只返回当前会话 workspace（项目）下启动的流水线，不同 workspace 互不可见。 */
  list(sessionId) {
    const sc = sessionScope(sessionId)
    const arr = runsFor(sc.projectKey)
    return { runs: arr.slice(0, 30).map(runBrief), workspace: sc }
  }

  /** run 详情（快照）。productOverride：全局面板按产品线 key 寻址时传入（跳过会话推导）。 */
  snapshot(runId, sessionId, productOverride?) {
    const key = productOverride ? productKeyOf(productOverride) : sessionScope(sessionId).projectKey
    if (!key) return null
    if (runId && typeof runId === 'string') {
      const j = runs.get(runId)
      if (!j) return null
      // 跨 workspace 的 run 不可见（除无工作区会话的 default 兜底）
      if (!runVisibleIn(j, key)) return null
      return snapshotOf(j)
    }
    const latest = runsFor(key)[0]
    if (!latest) return null
    const j = runs.get(latest.id)
    return j ? snapshotOf(j) : null
  }

  /** 阶段详情：卡片点击查看 —— 状态/耗时/官方 usage + 产物全文（超 24k 截断）。
   * 2026-09-06 状态机化：返回同任务全部尝试（attempts 聚合——按 stage.taskKey（旧数据 label 兜底），
   * 按 seq 排序）——client 弹窗单次渲染现状、多次渲染时间线。 */
  stageDetail(runId, seq, sessionId, productOverride?) {
    if (typeof runId !== 'string' || !runId || seq === undefined || seq === null) return null
    const key = productOverride ? productKeyOf(productOverride) : sessionScope(sessionId).projectKey
    if (!key) return null
    const j = runs.get(runId)
    if (!j) return null
    // 跨 workspace 的 run 不可见（同 snapshot 守卫）
    if (!runVisibleIn(j, key)) return null
    const s = (j.stages || []).find((st) => Number(st.seq) === Number(seq))
    if (!s) return null
    // zh 存量前缀 + en 新增前缀都要剥（QA-2：en run 子卡标题为 "Dev · X"，任务键匹配不得失配）
    const taskKeyOf = (x) => String(x.taskKey || String(x.label || '').replace(/^(?:开发|Dev) · /, '').replace(/(?:（(?:第 \d+ 次重试|补跑)）| \((?:retry \d+|follow-up run)\))$/, '').trim())
    const taskKey = taskKeyOf(s)
    const attempts = taskKey
      ? (j.stages || [])
          .filter((x) => phaseKeyOf(x.phase) === phaseKeyOf(s.phase) && taskKeyOf(x) === taskKey)
          .sort((a, b) => Number(a.seq) - Number(b.seq))
          .map((x) => ({
            seq: x.seq,
            label: x.label,
            status: x.status,
            outcome: x.outcome || null,
            summary: clip(x.summary || '', 1500),
            output: clip(toText(x.output) || toText(x.handoff) || '', 12000),
            usage: x.usage || null,
            verifyEvidence: x.verifyEvidence || null,
            childId: x.childId || null,
            startedAt: x.startedAt,
            endedAt: x.endedAt,
          }))
      : null
    return {
      seq: s.seq, label: s.label, phase: s.phase, status: s.status, outcome: s.outcome,
      childId: s.childId || null, startedAt: s.startedAt, endedAt: s.endedAt,
      ownerSession: j.ownerSession || null,
      usage: s.usage || null,
      verifyEvidence: s.verifyEvidence || null,
      summary: clip(s.summary || '', 3000),
      output: clip(toText(s.output) || toText(s.handoff) || '', 24000),
      attempts,
    }
  }

  /** Backlog 条目详情：卡片点击查看 —— 完整字段 + 流转时间线 + 关联（子卡/缺陷）+ 任务夹路径。 */
  itemDetail(kind, id, sessionId, productOverride?) {
    const k = typeof kind === 'string' && ['req', 'task', 'bug'].indexOf(kind) !== -1 ? kind : null
    if (!k || typeof id !== 'string' || !id) return null
    const key = productOverride ? productKeyOf(productOverride) : sessionScope(sessionId).projectKey
    if (!key) return null
    const store = storeFor(key)
    const item = store.find(k, id)
    if (!item) return null
    const reqId = k === 'req' ? item.id : (item.reqId || null)
    // 任务夹路径（ADR-0008）+ 关联 run 信息（req 需求原文在这）：匹配该需求的 journal
    let runDocs: string | null = null
    let runDocsRoot: string | null = null
    let runInfo: { runId: string; status: string; requirement: string; startedAt: number | null; endedAt: number | null; ownerSession: string | null } | null = null
    for (const j of runsFor(key)) {
      if (j.reqId !== reqId) continue
      if (j.runDocs && !runDocs) { runDocs = j.runDocs; runDocsRoot = j.workspacePath || null }
      if (!runInfo) runInfo = { runId: j.id, status: j.status, requirement: String(j.requirement || ''), startedAt: j.startedAt || null, endedAt: j.endedAt || null, ownerSession: j.ownerSession || null }
    }
    // 任务夹产物清单（ADR-0008）：只列**真实存在**的产物文件，地址由 host 用官方
    // fileAddressFor 生成（dsh-resource://file/session/<id>/<相对路径>）——client 直接把地址
    // 交给右侧栏 openResource 预览，无需自己拼地址、也无需在 client bundle 里引宿主包。
    // 地址里的 sessionId 优先用 **run 的发起会话**：全局面板（无会话上下文）也能让产物挂到对的会话上；
    // 只有拿不到 ownerSession 时才退回调用方传入的 sessionId（会话内工作台路径行为不变）。
    const artifactSession = (runInfo && runInfo.ownerSession) || sessionId
    const runArtifacts: Array<{ name: string; address: string }> = []
    if (runDocs && runDocsRoot && typeof artifactSession === 'string' && artifactSession) {
      try {
        const present = new Set(readdirSync(join(runDocsRoot, runDocs)))
        for (const name of TEAMFLOW_ARTIFACT_ORDER) {
          if (!present.has(name)) continue
          runArtifacts.push({ name, address: fileAddressFor(artifactSession, undefined, `${runDocs}/${name}`) })
        }
      } catch (e) { /* 任务夹不存在/不可读 → 空清单（前端不渲染按钮） */ }
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
      // 缺陷卡的自解释字段（2026-09-15）：此前只下发 severity/module，卡详情看不出缺陷内容
      defectId: item.defectId || null,
      module: item.module || null,
      reproduce: item.reproduce || '',
      expected: item.expected || '',
      actual: item.actual || '',
      defectAc: item.ac || '',
      // 检测命令/通过判据（2026-09-15）：缺陷的**可执行定义**——没有它，修复方只能猜「改到哪算改完」
      defectCheck: item.check || '',
      defectCriterion: item.criterion || '',
      devAssign: item.devAssign || null, qaAssign: item.qaAssign || null,
      assignBy: item.acceptBy || null, retries: item.retries !== undefined ? item.retries : 0,
      humanIntervention: !!item.humanIntervention,
      createdAt: item.createdAt || null, updatedAt: item.updatedAt || null,
      events: (item.events || []).slice(-30),
      usage: k === 'task' ? (item.usage || null) : null,
      byRole: k === 'task' ? byRole : null,
      reqId: reqId || null,
      runDocs,
      artifacts: runArtifacts,
      runInfo,
      subtasks, bugs,
    }
  }

  /* ── 全局面板（root scope，无会话上下文）：按产品线 key 寻址 ──────────
   * 侧边栏图标 + main 面板没有会话上下文，宿主据产品线 key 装配；与上面按
   * sessionId 寻址的方法同源（productOverride 走同一实现），只是入口键不同。 */

  /** 产品线清单 + 当前会话所属产品线（client 用它做默认选中）。 */
  products(sessionId) {
    const sc = sessionScope(sessionId)
    return { current: sc.projectKey || null, products: listProducts() }
  }

  /** 产品线视图：元信息 + backlog + run 列表（全局面板一次取全，少往返）。 */
  productView(product) {
    const key = productKeyOf(product)
    if (!key) return null
    return {
      product: productMetaOf(key),
      backlog: this.backlog(null, key),
      runs: runsFor(key).slice(0, 50).map(runBrief),
    }
  }

  /** 产品线级 run 详情（右栏 tab 与面板内联共用同一形状）。 */
  productRunDetail(product, runId) {
    const key = productKeyOf(product)
    if (!key) return null
    return this.snapshot(runId, null, key)
  }

  /** 产品线级阶段详情（同 stageDetail 形状：attempts 聚合 + 验证证据）。 */
  productStageDetail(product, runId, seq) {
    const key = productKeyOf(product)
    if (!key) return null
    return this.stageDetail(runId, seq, null, key)
  }

  /** 产品线级 backlog 条目详情（sessionId 可选：仅用于把任务夹产物地址绑到某个会话）。 */
  productItemDetail(product, kind, id, sessionId) {
    const key = productKeyOf(product)
    if (!key) return null
    return this.itemDetail(kind, id, sessionId, key)
  }

  // 注：本方法 async 只因为澄清预检需要 await 一次分诊模型调用（宿主 Remote 支持 async 方法，
  // 见官方 SubagentRuntime.prompt）；返回形状不变（成功 {ok,runId,...}，被拦下 {ok:false,status:...}）。
  async start(sessionId, requirement, options) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const req = typeof requirement === 'string' && requirement.trim() ? requirement.trim() : null
    if (!sid || !req) return { ok: false, error: t(ambientLocale(), 'err.tool.missingSessionReq') }
    const agent = runtime.agents && runtime.agents.get(sid)
    if (agent === undefined) return { ok: false, error: t(ambientLocale(), 'err.tool.agentNotFound', { sid }) }
    // 补发延迟注入（选团队时 agent 可能尚未加载）
    tryFlushPendingInjections(sid)
    try {
      const opts = (options && typeof options === 'object') ? options : {}
      // 需求澄清闸门（与 tool 路径同一条：Remote/程序化调用也不能拿模糊需求直接开跑）
      const pre = await clarificationPreflight(req, opts as Record<string, unknown>, agent, ambientLocale())
      if ('needsClarification' in pre) {
        return { ok: false, status: 'needs-clarification', intent: pre.needsClarification.intent, blockers: pre.needsClarification.blockers }
      }
      if (pre.verdict) {
        const explicit = opts.mode as typeof opts.mode
        const up = guardrailUpgrade(explicit, !!(opts as Record<string, unknown>).lite, pre.verdict.mode)
        if (up) {
          if (up !== explicit) (pre.verdict as unknown as Record<string, unknown>).__upgradedFrom = explicit || ((opts as Record<string, unknown>).lite ? 'lite' : 'full')
          opts.mode = up
          if (up !== 'lite' && up !== 'tech' && up !== 'patch') (opts as Record<string, unknown>).lite = false
        }
        if (pre.verdict.needDesign) opts.needDesign = true
        ;(opts as Record<string, unknown>).__triage = pre.verdict
      }
      const runId = startPipeline(agent, req, opts, undefined)
      const sc = workspaceScopeOf(agent)
      return { ok: true, runId, workspace: sc, product: opts.productRoot ? normalizeRoot(opts.productRoot) : null }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  cancel(runId) {
    const id = typeof runId === 'string' ? runId : null
    if (!id) return { ok: false, error: t(ambientLocale(), 'err.tool.missingRunId') }
    // 来源=界面（人工点击）——与模型工具 teamflow_cancel 区分：主线程据此知道「是人停的，不是别人在自动续跑」
    return { ok: cancelRun(id, 'ui') }
  }

  /** 工作区级 backlog 视图（自动按当前会话 workspace 隔离）。productOverride：全局面板按产品线 key 寻址。 */
  backlog(sessionId, productOverride?) {
    const key = productOverride ? productKeyOf(productOverride) : sessionScope(sessionId).projectKey
    if (!key) return null
    const sum = backlogSummary(key)
    // 卡片跳流水线：req/task 附带该需求的最近一次 runId（无 run 的历史卡片为 null，不显示跳转）
    const js = runsFor(key)
    const runOf = (reqId: string | null | undefined) => {
      if (!reqId) return null
      let last: JournalRecord | null = null
      for (const j of js) if (j.reqId === reqId) last = j
      return last ? last.id : null
    }
    for (const r of sum.requirements) (r as { runId?: string | null }).runId = runOf(r.id)
    for (const t of sum.tasks) (t as { runId?: string | null }).runId = runOf(t.reqId)
    return sum
  }

  backlogUpdate(kind, id, to, sessionId, reason) {
    const k = String(kind || '')
    const i = String(id || '')
    const toSt = String(to || '')
    if (!k || !i || !toSt) return { ok: false, error: t(ambientLocale(), 'err.tool.missingKindIdTo') }
    const sc = sessionScope(sessionId)
    return transitionBacklog(sc.projectKey, k, i, toSt, reason ? String(reason) : t(ambientLocale(), 'tool.reason.manual'))
  }

  /** 分配任务卡给某角色（只写 assign 字段，不碰 status）。 */
  assign(kind, id, role, assignee, sessionId) {
    const k = String(kind || '')
    const i = String(id || '')
    const r = String(role || '')
    const a = String(assignee || '')
    if (!k || !i || !r || !a) return { ok: false, error: t(ambientLocale(), 'err.tool.missingAssign') }
    const sc = sessionScope(sessionId)
    return assignTask(sc.projectKey, k, i, r, a)
  }

  /** 暂停当前会话的 teamflow 触发（会话级）。 */
  pause(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: t(ambientLocale(), 'err.tool.missingSession') }
    pausedSessions.add(sid)
    return { ok: true }
  }

  /** 恢复当前会话的 teamflow 触发（会话级）。 */
  resumeSession(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: t(ambientLocale(), 'err.tool.missingSession') }
    pausedSessions.delete(sid)
    return { ok: true }
  }

  /** 列出当前工作区可用的团队。
   *  展示名/描述按**环境语言**（= 客户端推送的界面语言）下发：团队配置是用户数据（中文为主），
   *  英文界面下必须由 host 本地化后再给 client，否则下拉里就是中文（2026-09-15 实测）。 */
  listTeams(sessionId) {
    const sc = sessionScope(sessionId)
    const teams = loadTeams(sc.projectKey)
    const loc = ambientLocale()
    return { teams: teams.map((t) => teamPayload(loc, t)), projectKey: sc.projectKey }
  }

  /** 设置当前会话的活跃团队。同时注入上下文提示，让模型区分开发请求和普通聊天。 */
  selectTeam(sessionId, teamId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const tid = typeof teamId === 'string' ? teamId : null
    if (!sid || !tid) return { ok: false, error: t(ambientLocale(), 'err.tool.missingSessionTeam') }
    const sc = sessionScope(sid)
    const teams = loadTeams(sc.projectKey)
    const team = findTeam(teams, tid)
    if (!team) return { ok: false, error: t(ambientLocale(), 'err.tool.teamNotFound', { teamId: tid }) }
    activeTeams.set(sid, tid)
    saveActiveTeams()
    // 注入会话级上下文：告诉模型什么该走 teamflow，什么不该
    const agent = runtime.agents && runtime.agents.get(sid)
    // 必须经 createUserMessage（同上：裸 payload 缺 id/role → 宿主 v2 加载校验失败）
    const injectPayload = createUserMessage({
      content: [{ type: 'text', text: teamflowContextText(team.icon, teamNameOf(ambientLocale(), team), tid) }],
      source: { kind: 'plugin', plugin: 'dsh-plugin-teamflow', form: 'instructions' },
    })
    if (agent && typeof agent.inject === 'function') {
      try { agent.inject(injectPayload) } catch (e) { /* inject 失败不影响主流程 */ }
    } else {
      // agent 尚未加载（新会话懒加载），存入 pending，2 秒后重试（agent 通常 1-2s 内就绪）
      pendingInjections.set(sid, { teamName: teamNameOf(ambientLocale(), team), teamIcon: team.icon, teamId: tid })
      setTimeout(() => tryFlushPendingInjections(sid), 2000)
    }
    return { ok: true, team: teamPayload(ambientLocale(), team) }
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
    return team ? { team: teamPayload(ambientLocale(), team) } : { team: null }
  }

  /** 清除当前会话的活跃团队（回到原生模式）。 */
  clearTeam(sessionId) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    if (!sid) return { ok: false, error: t(ambientLocale(), 'err.tool.missingSession') }
    activeTeams.delete(sid)
    saveActiveTeams()
    return { ok: true }
  }

  /** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑。 */
  resume(runId, sessionId) {
    return resumeRun(runId, sessionId)
  }
}

export default TeamflowService
