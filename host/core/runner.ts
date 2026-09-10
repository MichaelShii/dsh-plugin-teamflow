/**
 * dsh-plugin-teamflow core — 子代理执行器（并发池 / 单阶段运行 / 重试与熔断）。
 * 依赖：util/constants/types + core(context/metering)。
 */
import { runtime, inFlight, providerName } from './context.ts'
import { accumulateSessionUsage, totalTokensOf } from './metering.ts'
import { startStageGuard } from './guard.ts'
import { clip, extractText, normalizeSignal, hasSubstance, isUnretryable, handoffBrief, refusalHit, buildRetryDiagnostic } from '../util.ts'
import { RETRY_LIMIT, STAGE_TOKEN_BUDGET, STAGE_MIN_LENGTH } from '../constants.ts'
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
    if (Array.isArray(efforts)) out = efforts.filter((e) => typeof e === 'string') as string[]
  } catch (e) { out = null }
  effortSupportCache.set(key, out)
  return out
}

/**
 * 解析本阶段要下发的推理强度：
 * - 阶段未要求降档（effortHint 空）→ undefined = 不传，宿主默认（DeepSeek high）
 * - 第 1 次尝试用 hint；**重试回升 'high'**（质量优先，ADR-0006）
 * - 只有探测到该路由支持该档位才返回，否则一律 undefined（防硬失败）
 */
async function resolveStageEffort(route: { provider?: string; model?: string }, attempt: number, effortHint?: string | null): Promise<string | undefined> {
  const base = effortHint && String(effortHint).trim() ? String(effortHint).trim() : null
  if (!base) return undefined
  const wanted = attempt > 1 ? 'high' : base
  const supported = await supportedEfforts(route)
  if (!supported || supported.indexOf(wanted) === -1) return undefined
  return wanted
}

/** 并发池：按 max 个 worker 消费 items，返回同序结果。 */
export async function runPool(items, max, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, max), items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
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

/** 运行单个阶段子代理：执行 + 产出实质校验 + token 双口径计量 + stage 状态流转。 */
export async function runAgent(
  journal: Journal, parent: ParentAgentLike, label: string, phase: string, prompt: string, signal: unknown, taskKey?: string | null,
  attempt = 1, effortHint?: string | null,
): Promise<string | null> {
  const maxSeq = journal.stages.length ? Math.max(...journal.stages.map((s) => s.seq)) : 0
  let stageText = null
  const stage: JournalStage = {
    seq: maxSeq + 1, label, phase, status: 'running', outcome: null,
    taskKey: taskKey || null,
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
    // 机械阶段降档（可选）：只在宿主声明支持时下发；重试自动回升 high（见 resolveStageEffort）
    const effort = await resolveStageEffort(route, attempt, effortHint)
    const agentOptions = (route.provider || route.model || effort) ? {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
      ...(effort ? { reasoningEffort: effort } : {}),
    } : undefined
    if (effort && !journal.cancelled) {
      journal.logs.push({ t: Date.now(), level: 'info', message: `${label} 推理强度：${effort}${attempt > 1 ? '（重试回升）' : '（机械阶段降档）'}` })
    }
    run = await runtime.subagents.start(providerName(), {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      ...(agentOptions ? { agentOptions } : {}),
      signal: normalizeSignal(signal),
    })
    stage.childId = run.id
    inFlight.set(journal.id, { run, stage })
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
    if (journal.cancelled) {
      stage.status = 'cancelled'; stage.outcome = 'cancelled'
      return null
    }
    if (stop === 'completed' && text && hasSubstance(phase, text)) {
      stage.status = 'done'; stage.outcome = 'completed'
      stage.output = clip(text, 50000) // 阶段产物全文（断点续跑重建上下文）
      return text
    }
    if (stage.guardReason) {
      // 护栏中止优先于通用失败分类（成功产出已在上方抢救）；
      // 复读=degenerated（可干净重试），挂死/空转=stalled（走预算门转人工）
      stage.status = 'failed'
      stage.outcome = stage.guardOutcome || 'degenerated'
      stage.summary = `进行中护栏中止（${stage.guardReason}），本次尝试无有效产出`
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
      const hit = refusalHit(text)
      if (hit) {
        stage.summary = `产出未通过实质校验：命中拒绝词「${hit.phrase}」（原文：${hit.context}），视为未交付`
        journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 产出命中拒绝词「${hit.phrase}」` })
      } else {
        stage.summary = `产出未通过实质校验：内容过短（${text.trim().length} 字符 < ${STAGE_MIN_LENGTH[phase] ?? 100} 下限），视为未交付`
        journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 产出过短（${text.trim().length} 字符），未通过实质校验` })
      }
      if (text) stage.output = clip(text, 4000)
    } else {
      stage.summary = `未产出有效结果（stopReason=${stop || 'unknown'}${errDetail ? `，error=${String(errDetail).slice(0, 200)}` : ''}）`
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} ${stage.summary}` })
      if (text) stage.output = clip(text, 4000) // 半截产出（如 stopReason=length）也落盘供诊断
    }
    return null
  } catch (e) {
    stage.status = journal.cancelled ? 'cancelled' : 'failed'
    if (!journal.cancelled && stage.guardReason) {
      stage.outcome = stage.guardOutcome || 'degenerated'
      stage.summary = `进行中护栏中止（${stage.guardReason}）：${String((e && e.message) || e)}`
    } else {
      stage.outcome = journal.cancelled ? 'cancelled' : 'error'
      stage.summary = `启动/执行失败：${String((e && e.message) || e)}`
    }
    journal.logs.push({ t: Date.now(), level: 'error', message: `${label} ${stage.summary}` })
    return null
  } finally {
    if (cancelGuard) cancelGuard()
    stage.usage = accumulateSessionUsage(run)
    stage.handoff = stageText ? handoffBrief(stageText) : null
    stage.endedAt = Date.now()
    if (inFlight.get(journal.id) && inFlight.get(journal.id).stage === stage) inFlight.delete(journal.id)
    if (run) { try { await run.dispose() } catch (e2) { /* ignore */ } }
  }
}

/** 单阶段重试 + token 熔断（官方口径：input+cacheRead+cacheWrite+output 累计）。
 * `effortHint`：机械阶段的推理强度降档提示（第 1 次尝试生效，重试自动回升 high，见 resolveStageEffort）。 */
export async function withRetry(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown, taskKey?: string | null, effortHint?: string | null,
): Promise<{ text: string | null; attempts: number; stageTokens: number; stage: JournalStage | null }> {
  let attempts = 0
  let stageTokens = 0
  let lastStage: JournalStage | null | undefined = null
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    attempts = attempt
    const labelNow = attempt > 1 ? `${label}（第 ${attempt} 次重试）` : label
    // 重试诊断包：原样重试=盲试（子代理不知道上次为什么失败，重试即碰运气）。
    // 诊断源现成：stage.summary（含拒绝词命中点/过短/stopReason 细节）+ guardReason + 失败产出尾部。
    const promptNow = attempt > 1 && lastStage ? prompt + buildRetryDiagnostic(attempt, lastStage) : prompt
    // ⚠️ 并发安全（并行 dev 子任务共享同一 journal.stages）：必须在调用前记录长度——
    // runAgent 同步 push 本次尝试的 stage（第一个 await 前），期间其他任务的 runAgent
    // 可能已 push 新 stage；用 length-1 取 stage 会错位（证据块/重试诊断/usage 累计全串）。
    const beforeLen = journal.stages.length
    const result = await runAgent(journal, parent, labelNow, phase, promptNow, signal, taskKey, attempt, effortHint)
    lastStage = journal.stages[beforeLen] || null
    // 累计本阶段各次尝试的总消耗（官方口径：input+cacheRead+cacheWrite+output）
    if (lastStage && lastStage.phase === phase) {
      stageTokens += totalTokensOf(lastStage.usage)
    }
    if (result) return { text: result, attempts, stageTokens, stage: lastStage }
    if (journal.cancelled) return { text: null, attempts, stageTokens, stage: lastStage }
    // 不可重试失败（上下文耗尽等）：重试同一 prompt 大概率复现 → 直接需人工
    if (lastStage && isUnretryable(lastStage.outcome, lastStage.outcome)) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 失败原因不可重试（${lastStage.outcome}），跳过重试，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stage: lastStage }
    }
    // 外部中止（aborted：用户重启/进程被杀等）：非模型失败、非烧钱——不熔断、不自动重试，
    // needs-human 引导 resume 续跑（resume 精确补跑失败任务，已完成任务复用；实证 r29 重启后 resume 成功）。
    // 旧行为结算成「熔断」误导（stageTokens 是阶段累计，含成功任务消耗；真实原因是外部中止）。
    if (lastStage && lastStage.outcome === 'aborted') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 被外部中止（aborted），未正常产出——非预算问题；可 teamflow_resume 续跑（补跑失败任务，已完成任务复用）` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stage: lastStage }
    }
    // 护栏中止（degenerated）= 主动止损：退化会话内自动重试大概率复现且烧钱（实证 run tf-mte906e9：
    // 6 次中止全部自动重试失败，复读计数 12→27 递增；resume 以全新会话续跑一次成功）→ 不再自动重试，
    // 直接 needs-human，引导 teamflow_resume（全新子代理会话 = 干净上下文）
    if (lastStage && lastStage.outcome === 'degenerated') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 进行中护栏中止（退化/推理复读），不再自动重试（污染会话内重试大概率复现且烧钱）；可 teamflow_resume 以全新会话续跑` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stage: lastStage }
    }
    // 护栏中止（stalled = 挂死/空转）：对齐 guard 注释「走预算门转人工，不自动重试烧钱」——
    // 挂死无产出可救、空转已在烧钱，自动重试大概率复现（实证与 degenerated 同理）→ needs-human 引导 resume
    if (lastStage && lastStage.outcome === 'stalled') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 进行中护栏中止（挂死/空转），不再自动重试（会话已无有效产出）；可 teamflow_resume 以全新会话续跑` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stage: lastStage }
    }
    // token 熔断：本阶段累计总消耗超预算 → 停止重试
    if (stageTokens >= STAGE_TOKEN_BUDGET) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 累计 token ${Math.round(stageTokens / 1000)}k 超出阶段预算 ${Math.round(STAGE_TOKEN_BUDGET / 1000)}k，熔断，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stage: lastStage }
    }
    if (attempt < RETRY_LIMIT) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 第 ${attempt} 次尝试未成功（${lastStage ? lastStage.outcome || 'unknown' : 'unknown'}），自动重试（重试 prompt 已附上一轮失败诊断）…` })
    } else {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 连续 ${RETRY_LIMIT} 次尝试失败，超出重试阈值，需人工介入` })
      journal.humanIntervention = true
    }
  }
  return { text: null, attempts, stageTokens, stage: lastStage }
}
