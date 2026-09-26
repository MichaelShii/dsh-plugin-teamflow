/**
 * dsh-plugin-teamflow core — 子代理执行器（并发池 / 单阶段运行 / 重试与熔断）。
 * 依赖：util/constants/types + core(context/metering)。
 */
import { runtime, providerName, trackInFlight, untrackInFlight } from './context.ts'
import { accumulateSessionUsage, freshTokensOf, effectiveFreshBudget } from './metering.ts'
import { startStageGuard } from './guard.ts'
import { clip, extractText, blockShape, normalizeSignal, judgeDeliverable, isUnretryable, handoffBrief, buildRetryDiagnostic, classifyExternalFailure, externalBackoffMs, stageDocText } from '../util.ts'
import { RETRY_LIMIT, FRESH_TOKEN_BUDGET } from '../constants.ts'
import { t, type HostLocale } from '../locales.ts'
import { runLocaleOf } from './locale.ts'
import type { Journal, ParentAgentLike } from '../types.ts'
import type { JournalStage } from '../../store.ts'

/**
 * 推理强度能力探测（缓存，2026-09-11）：只有宿主明确声明该路由支持某档位才下发。
 * 宿主对**不支持的值硬失败且不降级**（`UNSUPPORTED_REASONING_EFFORT`），所以宁可不下发。
 * 返回 null = 探测不可用（老宿主/未声明容量）→ 调用方一律不下发，保持宿主默认。
 */
const effortSupportCache = new Map<string, string[] | null>()

async function supportedEfforts(route: { provider?: string; model?: string }): Promise<string[] | null> {
  // 两者都要有才探测：只知 provider 会拿到「provider 默认模型」的能力，与本次实际路由可能不符
  if (!route.provider || !route.model) return null
  const llm = runtime.llm as { resolveModelInfo?: (p?: string, m?: string) => Promise<unknown> } | undefined
  if (!llm || typeof llm.resolveModelInfo !== 'function') return null
  const key = `${route.provider}/${route.model || ''}`
  if (effortSupportCache.has(key)) return effortSupportCache.get(key) || null
  let out: string[] | null = null
  try {
    const info = (await llm.resolveModelInfo(route.provider, route.model)) as { reasoning?: { efforts?: unknown } } | null | undefined
    const efforts = info && info.reasoning && info.reasoning.efforts
    if (Array.isArray(efforts)) {
      // ⚠️ 宿主 `LlmModelReasoningInfo.efforts` 是 **对象数组** `{id, name, description}`（不是字符串），
      // 早期实现按字符串过滤 → 恒空 → 永远判「不支持」而静默不下发（2026-09-11 实锤：候选 run 无降档日志）。
      out = efforts
        .map((e) => (typeof e === 'string'
          ? e
          : (e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' ? (e as { id: string }).id : null)))
        .filter((x): x is string => typeof x === 'string' && x.length > 0)
    }
  } catch (e) { out = null }
  effortSupportCache.set(key, out)
  return out
}

/**
 * 解析本阶段要下发的推理强度：
 * - 阶段未要求降档（effortHint 空）→ 不传，宿主默认（DeepSeek high）
 * - 第 1 次尝试用 hint；**重试回升 'high'**（质量优先，ADR-0006）
 * - 只有探测到该路由支持该档位才返回，否则不传（防 `UNSUPPORTED_REASONING_EFFORT` 硬失败）
 * - 未下发时返回原因文本 → 调用方记 warn（这类静默失败必须可见，见 2026-09-11 实锤）
 */
async function resolveStageEffort(
  route: { provider?: string; model?: string }, attempt: number, effortHint?: string | null, locale: HostLocale = 'zh',
): Promise<{ effort?: string; skip?: string }> {
  const base = effortHint && String(effortHint).trim() ? String(effortHint).trim() : null
  if (!base) return {}
  const wanted = attempt > 1 ? 'high' : base
  const supported = await supportedEfforts(route)
  if (!supported) return { skip: t(locale, 'diag.noEfforts', { provider: route.provider || '?', model: route.model || '?' }) }
  if (supported.indexOf(wanted) === -1) return { skip: t(locale, 'diag.unsupportedEffort', { wanted, list: supported.join('/') || t(locale, 'diag.listNone') }) }
  return { effort: wanted }
}

/**
 * 解析父 agent 当前生效的模型路由（provider/model）。
 *
 * 背景：子代理默认继承 `parent.options`（创建时快照），主线程在 UI 切换模型后
 * `parent.options` 不会更新，导致子代理仍打旧 provider（如已停的代理端口）。
 *
 * 三级回退，取「当前生效」而非「创建快照」：
 * 1. parent.session.requestHeader()?.config —— 主线程最近一次请求实际生效的路由（含切换后）
 * 2. runtime.agentDefaultModel?.currentSelection() —— 全局默认模型当前选择（切换即更新，可选注入）
 * 3. parent.options —— 创建快照（兜底）
 */
export function resolveChildRoute(parent: ParentAgentLike): { provider?: string; model?: string; maxTokens?: number } {
  const out: { provider?: string; model?: string; maxTokens?: number } = {}
  try {
    // 1. 最近生效路由（request header config）
    const session = (parent as { session?: { requestHeader?: () => { config?: { provider?: string; model?: string; maxTokens?: number } } | undefined } }).session
    const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const cfg = header && header.config
    if (cfg && typeof cfg.provider === 'string' && cfg.provider) {
      out.provider = cfg.provider
      if (typeof cfg.model === 'string' && cfg.model) out.model = cfg.model
      if (typeof cfg.maxTokens === 'number') out.maxTokens = cfg.maxTokens
    }
  } catch (e) { /* 回退下一级 */ }
  if (!out.provider) {
    // 2. 全局默认模型当前选择（切换即更新）
    const defaultModel = runtime.agentDefaultModel as { currentSelection?: () => { provider?: string; model?: string; maxTokens?: number } } | undefined
    if (defaultModel && typeof defaultModel.currentSelection === 'function') {
      try {
        const sel = defaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string' && sel.provider) {
          out.provider = sel.provider
          if (typeof sel.model === 'string' && sel.model) out.model = sel.model
          if (typeof sel.maxTokens === 'number') out.maxTokens = sel.maxTokens
        }
      } catch (e) { /* 回退下一级 */ }
    }
  }
  if (!out.provider) {
    // 3. 创建快照兜底
    const po = (parent as { options?: { provider?: string; model?: string; maxTokens?: number } }).options
    if (po && typeof po.provider === 'string' && po.provider) {
      out.provider = po.provider
      if (typeof po.model === 'string' && po.model) out.model = po.model
      if (typeof po.maxTokens === 'number') out.maxTokens = po.maxTokens
    }
  }
  return out
}

/** 运行单个阶段子代理：执行 + 产出实质校验 + token 双口径计量 + stage 状态流转。
 *  `taskIds`：本阶段承载的**开发任务身份**（host 生成的 `dt-N`；合并任务时是数组）。
 *  与 `taskKey`（人读标题）分家——判定只认 id，title 只作展示（见 pipeline.buildDevTaskDefs 注释）。 */
export async function runAgent(
  journal: Journal, parent: ParentAgentLike, label: string, phase: string, prompt: string, signal: unknown, taskKey?: string | null,
  attempt = 1, effortHint?: string | null, taskIds?: string[] | null,
): Promise<string | null> {
  const maxSeq = journal.stages.length ? Math.max(...journal.stages.map((s) => s.seq)) : 0
  // run 语言快照（AC-2）：诊断/日志/失败摘要一律随 run，不受界面当前语言影响
  const locale = runLocaleOf(journal)
  let stageText = null
  const stage: JournalStage = {
    seq: maxSeq + 1, label, phase, status: 'running', outcome: null,
    taskKey: taskKey || null,
    taskIds: (Array.isArray(taskIds) && taskIds.length) ? [...taskIds] : null,
    childId: null, startedAt: Date.now(), endedAt: null, summary: null,
    usage: null, handoff: null, output: null,
  }
  journal.stages.push(stage)
  journal.agentsStarted += 1
  let run = null
  let cancelGuard: (() => void) | null = null
  try {
    // 显式传当前生效路由，避免继承过期的 parent.options 快照（主线程已切换代理的情况）
    const route = resolveChildRoute(parent)
    // **引擎留痕（2026-09-18）**：逐阶段记下实际生效的 provider/model —— 子代理路由跟随主线程/团队配置，
    // 与 run 起始默认可能不同；一次真实排查里为了回答「是不是模型的锅」（不缓存的 provider 每轮调用
    // 要多付 ~15.5k，见 FRESH_TOKEN_BUDGET），只能去解压会话文件翻 request/header。
    stage.provider = route.provider || providerName() || null
    stage.model = route.model || null
    // 机械阶段降档（可选）：只在宿主声明支持时下发；重试自动回升 high（见 resolveStageEffort）
    const eff = await resolveStageEffort(route, attempt, effortHint, locale)
    const effort = eff.effort
    const agentOptions = (route.provider || route.model || effort) ? {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    } : undefined
    if (effort && !journal.cancelled) {
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, attempt > 1 ? 'diag.effortRetry' : 'diag.effort', { label, effort }) })
    } else if (eff.skip && !journal.cancelled) {
      // 静默失败可见化（2026-09-11 实锤：efforts 对象数组被当字符串过滤 → 恒判不支持却无任何痕迹）
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.effortSkip', { label, skip: eff.skip }) })
    }
    run = await runtime.subagents.start(providerName(), {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      ...(agentOptions ? { agentOptions } : {}),
      signal: normalizeSignal(signal),
    })
    stage.childId = run.id
    trackInFlight(journal.id, stage, run)
    try {
      if (parent && parent.session && typeof parent.session.append === 'function') {
        parent.session.append('tool-workflow/agent-start', {
          runId: journal.id, seq: stage.seq, label, phase, childId: run.id,
        })
      }
    } catch (e) { /* 轨迹写入失败不影响主流程 */ }
    // 单调用护栏：进行中退化检测（推理复读/墙钟超限 → dispose 中止，outcome=degenerated 走干净重试）
    cancelGuard = startStageGuard({ run, journal, label, stage })
    const result = await run.result
    const stop = result && result.stopReason
    const text = extractText(result && result.output)
    stageText = text
    // 交付判定（信号分级：客观形态 → 证据块 → 措辞兜底，见 util.judgeDeliverable）
    const verdict = judgeDeliverable(phase, text)
    // **doc 类阶段的产物兜底**（2026-09-18 probe-v2 实锤，见 util.DOC_STAGE_FILES）：这些阶段的产物
    // 是任务夹文件，回复只是摘要 —— 回复过短不等于没干活（实锤：PRD.md 4894 字节已落盘、还调了
    // `present` 声明交付物，却因回复只有 284 字符的 state 块被判「未交付」）。回读文件，达下限即判交付。
    // 前提仍是**回复非空**：pipeline 要用回复合并 state 块，空回复是真的没交付。
    let docFallback: { name: string; length: number } | null = null
    if (!verdict.ok && text && stop === 'completed') {
      const doc = stageDocText(journal, phase)
      if (doc && doc.length >= verdict.min) docFallback = { name: doc.name, length: doc.length }
    }
    if (journal.cancelled) {
      stage.status = 'cancelled'; stage.outcome = 'cancelled'
      return null
    }
    // **环境不可用优先于「完成了」**（2026-09-23 probe-v4 第二次实机，勿回退）：护栏在 WARN 档一旦记下
    // 「同一工具持续同一错误失败」，本阶段就已证明**该工作区跑不了命令**。此时模型可能改用文件工具把活干完
    // （实测：它手写 13 个文件 / 69.8k 输出，其中一个 18.7KB 的自测脚本**一次都没跑过**）——这种"完成"无法验证，
    // 而下游 dev/QA/验收更需要 shell，按**防假交付**原则不得算 done → 归 env-unavailable：不重试、汇报点名
    // 环境与原文错误、引导「先修工作区再 resume」（工作区里已落地的文件不删，resume 会带着 shell 重跑本阶段）。
    if (stage.envUnavailable) {
      stage.status = 'failed'
      stage.outcome = 'env-unavailable'
      stage.summary = t(locale, 'diag.envUnavailableStage', { label, detail: stage.envUnavailable })
      if (text) stage.output = clip(text, 4000)
      journal.logs.push({ t: Date.now(), level: 'error', message: stage.summary })
      return null
    }
    if (stop === 'completed' && text && (verdict.ok || docFallback)) {
      stage.status = 'done'; stage.outcome = 'completed'
      stage.output = clip(text, 50000) // 阶段产物全文（断点续跑重建上下文）
      if (docFallback) {
        // 留痕（visible）：判交付的依据是文件而不是回复 —— 否则"为什么这次没重试"又成黑盒
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.docDelivered', { label, length: verdict.length, min: verdict.min, name: docFallback.name, docLen: docFallback.length }) })
      }
      // 措辞只作诊断：命中拒绝词但已带验证证据块 → 仍判交付（2026-09-11 信号换轨）。
      // 留一条 warn 是为了审计可见（「为什么这句『无法执行』没判失败」有据可查），不改变结论。
      if (verdict.refusal) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.refusalWithEvidence', { label, phrase: verdict.refusal.phrase, context: verdict.refusal.context }) })
      }
      return text
    }
    if (stage.guardReason) {
      // 护栏中止优先于通用失败分类（成功产出已在上方抢救）；
      // 复读=degenerated（可干净重试），挂死/空转=stalled（走预算门转人工）
      stage.status = 'failed'
      stage.outcome = stage.guardOutcome || 'degenerated'
      stage.summary = t(locale, 'diag.guardAbort', { reason: stage.guardReason })
      if (text) stage.output = clip(text, 4000) // 失败产出截断落盘（重试诊断/详情浮层）
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} ${stage.summary}` })
      return null
    }
    stage.status = 'failed'
    stage.outcome = (stop === 'completed' && text) ? 'insubstantial' : (stop || 'error')
    // provider 错误细节记录（观测改进：此前只有 stopReason=error，无从排查瞬时/持久）
    const errDetail = result && (result as { error?: unknown }).error
    if (stage.outcome === 'insubstantial') {
      // 拒绝词命中点回灌（重试诊断需要「哪段输出被判拒绝」）；否则细分内容过短
      if (verdict.reason === 'refusal' && verdict.refusal) {
        stage.summary = t(locale, 'diag.refusalNoEvidence', { phrase: verdict.refusal.phrase, context: verdict.refusal.context })
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.refusalNoEvidenceLog', { label, phrase: verdict.refusal.phrase }) })
      } else {
        stage.summary = t(locale, 'diag.tooShort', { length: verdict.length, min: verdict.min })
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.tooShortLog', { label, length: verdict.length }) })
      }
      if (text) stage.output = clip(text, 4000)
    } else {
      // 诊断必须能自证（2026-09-26 tf-muigy5eq r12 实踩）：此前只报 stopReason，
      // 「正文为空」与「provider 报错」长得一模一样，排查只能跳子代理会话原始记录。
      // 现在带上正文长度 + **响应块构成**；且 `completed` + 0 字符 = 推理模型空收尾，给专属措辞（一眼可认）。
      // 块构成是判断「谁收的尾」的关键：空收尾形状 = 只有 reasoning、无 text、无 tool-call；
      // 宿主中断会带 aborted、预算截断会带 max-tokens，都不会是 stop（见 util.blockShape 注释与 DSH 排查记录）。
      const err = errDetail ? t(locale, 'diag.noResultError', { error: String(errDetail).slice(0, 200) }) : ''
      const shape = blockShape(result && result.output)
      stage.summary =
        !text && stop === 'completed'
          ? t(locale, 'diag.emptyTurn', { stop: stop || 'unknown', shape })
          : t(locale, 'diag.noResult', { stop: stop || 'unknown', len: (text || '').length, shape, error: err })
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} ${stage.summary}` })
      if (text) stage.output = clip(text, 4000) // 半截产出（如 stopReason=length）也落盘供诊断
    }
    return null
  } catch (e) {
    stage.status = journal.cancelled ? 'cancelled' : 'failed'
    if (!journal.cancelled && stage.guardReason) {
      stage.outcome = stage.guardOutcome || 'degenerated'
      stage.summary = `${t(locale, 'diag.guardAbort', { reason: stage.guardReason })}${t(locale, 'diag.colon')}${String((e && e.message) || e)}`
    } else {
      stage.outcome = journal.cancelled ? 'cancelled' : 'error'
      stage.summary = t(locale, 'diag.startFail', { msg: String((e && e.message) || e) })
    }
    journal.logs.push({ t: Date.now(), level: 'error', message: `${label} ${stage.summary}` })
    return null
  } finally {
    if (cancelGuard) cancelGuard()
    stage.usage = accumulateSessionUsage(run)
    stage.handoff = stageText ? handoffBrief(stageText) : null
    stage.endedAt = Date.now()
    untrackInFlight(journal.id, stage) // 只注销自己这一路（并发 dev 同 run 多路在飞，见 context.inFlight）
    // 结算后释放子代理资源（对齐宿主规范结算 dsh-subagent settleRun：result 后必 dispose）。
    // ⚠️ 2026-09-26 实锤修复：此语句曾被行注释吞掉（与上一句同行）→ 正常结算路径 dispose 从未执行。
    if (run) { try { await run.dispose() } catch (e2) { /* ignore */ } }
  }
}

/**
 * 该阶段失败是否「外部供应商不可用」（限流/无额度/上游 5xx/超时…）。
 * 判据 = `classifyExternalFailure(错误细节, stage.summary)`（纯函数，单测覆盖真值表）。
 * ⚠️ 启发式：宿主只给 `stopReason=error` + 错误文本，无结构化错误码；命中原文进日志便于日后核对。
 */
function isExternalFailure(stage: { summary?: string | null; outcome?: string | null; output?: string | null }): boolean {
  if (stage.outcome === 'insubstantial' || stage.outcome === 'degenerated' || stage.outcome === 'stalled' || stage.outcome === 'aborted' || stage.outcome === 'env-unavailable') return false
  return classifyExternalFailure(String(stage.summary || ''), String(stage.output || '').slice(-500)) === 'external'
}

/** 可取消等待：等待期间被取消/中断则立刻返回 false（不把 sleep 变成不可打断的挂起）。 */
async function sleepUnlessCancelled(ms: number, isCancelled: () => boolean): Promise<boolean> {
  const step = 1000
  let waited = 0
  while (waited < ms) {
    if (isCancelled()) return false
    const slice = Math.min(step, ms - waited)
    await new Promise((r) => setTimeout(r, slice))
    waited += slice
  }
  return !isCancelled()
}

/**
 * 单阶段重试 + token 熔断（**新增口径**：input+cacheWrite+output，排除 cacheRead——见
 * `FRESH_TOKEN_BUDGET` 与 metering.freshTokensOf；汇报仍走官方 totalTokensOf 口径）。
 * 顺序：不可重试/外部中止/护栏中止 → 预算门 → 自动重试（预算合理时重试优先于熔断，2026-09-11 修正）。
 * `effortHint`：机械阶段的推理强度降档提示（第 1 次尝试生效，重试自动回升 high，见 resolveStageEffort）。 */
export async function withRetry(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown, taskKey?: string | null, effortHint?: string | null,
  taskIds?: string[] | null,
): Promise<{ text: string | null; attempts: number; freshTokens: number; stage: JournalStage | null }> {
  let attempts = 0
  let freshTokens = 0
  // 熔断预算的缓存能力判据：累计本次调用各次尝试的 usage（只看本阶段，见 metering.effectiveFreshBudget）
  let usageAcc: { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number } = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  let lastStage: JournalStage | null | undefined = null
  // 外部供应商故障的独立计数（不受 RETRY_LIMIT 约束：那是"换做法重试"的次数，
  // 外部故障是"等窗口过去"，两件事不能共用一个计数器）
  let externalAttempts = 0
  // 重试诊断包与重试日志同样随 run 语言（诊断包是喂回子代理的注入文本）
  const locale = runLocaleOf(journal)
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    attempts = attempt
    const labelNow = attempt > 1 ? t(locale, 'dev.taskRetry', { label, n: attempt }) : label
    // 重试诊断包：原样重试=盲试（子代理不知道上次为什么失败，重试即碰运气）。
    // 诊断源现成：stage.summary（含拒绝词命中点/过短/stopReason 细节）+ guardReason + 失败产出尾部。
    const promptNow = attempt > 1 && lastStage ? prompt + buildRetryDiagnostic(attempt, lastStage, locale) : prompt
    // ⚠️ 并发安全（并行 dev 子任务共享同一 journal.stages）：必须在调用前记录长度——
    // runAgent 同步 push 本次尝试的 stage（第一个 await 前），期间其他任务的 runAgent
    // 可能已 push 新 stage；用 length-1 取 stage 会错位（证据块/重试诊断/usage 累计全串）。
    const beforeLen = journal.stages.length
    const result = await runAgent(journal, parent, labelNow, phase, promptNow, signal, taskKey, attempt, effortHint, taskIds)
    lastStage = journal.stages[beforeLen] || null
    // 累计本次调用各次尝试的**新增**消耗（input+cacheWrite+output；cacheRead 是廉价重放，
    // 不计入熔断——旧口径含 cacheRead 导致「一次失败必熔断」，见 FRESH_TOKEN_BUDGET 注释）
    if (lastStage && lastStage.phase === phase) {
      freshTokens += freshTokensOf(lastStage.usage)
      const u = (lastStage.usage || {}) as { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; calls?: number }
      usageAcc = {
        input: usageAcc.input + (u.input || 0),
        cacheRead: usageAcc.cacheRead + (u.cacheRead || 0),
        cacheWrite: usageAcc.cacheWrite + (u.cacheWrite || 0),
        output: usageAcc.output + (u.output || 0),
        calls: usageAcc.calls + (u.calls || 0),
      }
    }
    if (result) return { text: result, attempts, freshTokens, stage: lastStage }
    if (journal.cancelled) return { text: null, attempts, freshTokens, stage: lastStage }
    // 不可重试失败（上下文耗尽等）：重试同一 prompt 大概率复现 → 直接需人工
    if (lastStage && isUnretryable(lastStage.outcome, lastStage.outcome)) {
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'diag.unretryable', { label, outcome: lastStage.outcome }) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // **外部供应商不可用**（限流 / 无额度 / 上游 5xx / 超时…；2026-09-17 dddd 实测：同请求 16 分钟后成功）
    // ——这不是内容失败，重试同样的请求只是"等窗口过去"。处置：**长退避重试**（30s→60s→120s→240s），
    // 而不是像内容失败那样快速失败两次就转人工。退避**不计入熔断预算**（等待不烧 token）。
    if (lastStage && isExternalFailure(lastStage)) {
      const wait = externalBackoffMs(externalAttempts + 1)
      if (wait !== null) {
        externalAttempts++
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.externalBackoff', { label, n: externalAttempts, sec: Math.round(wait / 1000), detail: clip(String(lastStage.summary || ''), 200) }) })
        if (!(await sleepUnlessCancelled(wait, () => journal.cancelled))) {
          return { text: null, attempts, freshTokens, stage: lastStage } // 等待期间被取消 → 按取消收尾（不重试）
        }
        // 退避后重试同一阶段（attempt 计数不推进 RETRY_LIMIT：这是"等窗口"而非"换做法重试"）
        attempt--
        continue
      }
      // 退避用尽：仍失败 → **可续跑的外部中断态**（不是内容失败，也不要求改需求）：
      // run 落 interrupted、阶段标 interrupted，汇报明写"疑似限流/额度，窗口恢复后 resume 只补这一段"。
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'diag.externalExhausted', { label, n: externalAttempts }) })
      if (lastStage) { lastStage.status = 'interrupted'; lastStage.outcome = 'external' }
      journal.interrupted = true
      journal.interruptedAt = Date.now()
      journal.externalFailure = true
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // 外部中止（aborted：用户重启/进程被杀等）：非模型失败、非烧钱——不熔断、不自动重试，
    // needs-human 引导 resume 续跑（resume 精确补跑失败任务，已完成任务复用；实证 r29 重启后 resume 成功）。
    // 旧行为结算成「熔断」误导（freshTokens 是本次调用累计，含成功任务消耗；真实原因是外部中止）。
    if (lastStage && lastStage.outcome === 'aborted') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.aborted', { label }) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // **环境不可用**（2026-09-23 probe-v4 实锤）：命令工具持续以同一错误失败（如 Windows 沙箱 ACL
    // provision 失败 → 该工作区所有命令全废）。重试/换命令/更多推理都修不好**环境**，自动重试只会把同样的
    // 钱再烧一遍（实锤那次白烧 52.6k 输出，且汇报把真因误写成 max-tokens）→ 直接 needs-human，
    // 并明确点名「环境不可用、先修工作区再 resume」（已完成阶段与产物全部复用）。
    if (lastStage && lastStage.outcome === 'env-unavailable') {
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'diag.envUnavailable', { label }) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // 护栏中止（degenerated）= 主动止损：退化会话内自动重试大概率复现且烧钱（实证 run tf-mte906e9：
    // 6 次中止全部自动重试失败，复读计数 12→27 递增；resume 以全新会话续跑一次成功）→ 不再自动重试，
    // 直接 needs-human，引导 teamflow_resume（全新子代理会话 = 干净上下文）
    if (lastStage && lastStage.outcome === 'degenerated') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.degenerated', { label }) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // 护栏中止（stalled = 挂死/空转）：对齐 guard 注释「走预算门转人工，不自动重试烧钱」——
    // 挂死无产出可救、空转已在烧钱，自动重试大概率复现（实证与 degenerated 同理）→ needs-human 引导 resume
    if (lastStage && lastStage.outcome === 'stalled') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.stalled', { label }) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    // token 熔断（新增口径）：本次调用累计新增消耗超预算 → 停止重试转人工。
    // 位置在「自动重试」之前是刻意的：预算合理（≈2 轮尝试量级）时，首次失败走下方重试；
    // 只有该量级数倍的真跑飞才熔断——旧口径把 cacheRead 算进来，等于取消了自动重试（2026-09-11 修）。
    // **预算随缓存能力自适应**（2026-09-18 probe-v2 实锤）：不缓存的 provider 上每轮调用都要重付
    // system+tools（实测 ~15.5k/次），200k 会退化成「约 13 次调用上限」→ 按倍数放宽（见 metering）。
    const eff = effectiveFreshBudget(usageAcc, FRESH_TOKEN_BUDGET)
    if (freshTokens >= eff.budget) {
      const params = {
        label, fresh: Math.round(freshTokens / 1000), budget: Math.round(eff.budget / 1000),
        calls: eff.calls, ratio: Math.round(eff.ratio * 100),
      }
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, eff.uncached ? 'diag.breakerUncached' : 'diag.breaker', params) })
      journal.humanIntervention = true
      return { text: null, attempts, freshTokens, stage: lastStage }
    }
    if (attempt < RETRY_LIMIT) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.retry', { label, n: attempt, outcome: lastStage ? lastStage.outcome || 'unknown' : 'unknown' }) })
    } else {
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'diag.retryExhausted', { label, n: RETRY_LIMIT }) })
      journal.humanIntervention = true
    }
  }
  return { text: null, attempts, freshTokens, stage: lastStage }
}
