/**
 * dsh-plugin-teamflow core — 子代理执行器（并发池 / 单阶段运行 / 重试与熔断）。
 * 依赖：util/constants/types + core(context/metering)。
 */
import { runtime, inFlight, providerName } from './context.ts'
import { accumulateSessionUsage, totalTokensOf } from './metering.ts'
import { startStageGuard } from './guard.ts'
import { clip, extractText, normalizeSignal, hasSubstance, isUnretryable, handoffBrief } from '../util.ts'
import { RETRY_LIMIT, STAGE_TOKEN_BUDGET } from '../constants.ts'
import type { Journal, ParentAgentLike } from '../types.ts'
import type { JournalStage } from '../../store.ts'

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
  journal: Journal, parent: ParentAgentLike, label: string, phase: string, prompt: string, signal: unknown,
): Promise<string | null> {
  const maxSeq = journal.stages.length ? Math.max(...journal.stages.map((s) => s.seq)) : 0
  let stageText = null
  const stage: JournalStage = {
    seq: maxSeq + 1, label, phase, status: 'running', outcome: null,
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
    const agentOptions = (route.provider || route.model) ? {
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.model ? { model: route.model } : {}),
      ...(route.maxTokens ? { maxTokens: route.maxTokens } : {}),
    } : undefined
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
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} ${stage.summary}` })
      return null
    }
    stage.status = 'failed'
    stage.outcome = (stop === 'completed' && text) ? 'insubstantial' : (stop || 'error')
    if (stage.outcome === 'insubstantial') {
      stage.summary = '产出未通过实质校验（含拒绝措辞或内容过短），视为未交付'
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 产出未通过实质校验（拒绝措辞/内容过短）` })
    } else {
      stage.summary = `未产出有效结果（stopReason=${stop || 'unknown'}）`
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 未产出有效结果（stopReason=${stop || 'unknown'}）` })
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

/** 单阶段重试 + token 熔断（官方口径：input+cacheRead+cacheWrite+output 累计）。 */
export async function withRetry(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown,
): Promise<{ text: string | null; attempts: number; stageTokens: number }> {
  let attempts = 0
  let stageTokens = 0
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    attempts = attempt
    const labelNow = attempt > 1 ? `${label}（第 ${attempt} 次重试）` : label
    const result = await runAgent(journal, parent, labelNow, phase, prompt, signal)
    // 累计本阶段各次尝试的总消耗（官方口径：input+cacheRead+cacheWrite+output）
    const lastStage = journal.stages[journal.stages.length - 1]
    if (lastStage && lastStage.phase === phase) {
      stageTokens += totalTokensOf(lastStage.usage)
    }
    if (result) return { text: result, attempts, stageTokens }
    if (journal.cancelled) return { text: null, attempts, stageTokens }
    // 不可重试失败（上下文耗尽等）：重试同一 prompt 大概率复现 → 直接需人工
    if (lastStage && isUnretryable(lastStage.outcome, lastStage.outcome)) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 失败原因不可重试（${lastStage.outcome}），跳过重试，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens }
    }
    // 护栏中止（degenerated）= 主动止损：退化会话内自动重试大概率复现且烧钱（实证 run tf-mte906e9：
    // 6 次中止全部自动重试失败，复读计数 12→27 递增；resume 以全新会话续跑一次成功）→ 不再自动重试，
    // 直接 needs-human，引导 teamflow_resume（全新子代理会话 = 干净上下文）
    if (lastStage && lastStage.outcome === 'degenerated') {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 进行中护栏中止（退化/推理复读），不再自动重试（污染会话内重试大概率复现且烧钱）；可 teamflow_resume 以全新会话续跑` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens }
    }
    // token 熔断：本阶段累计总消耗超预算 → 停止重试
    if (stageTokens >= STAGE_TOKEN_BUDGET) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 累计 token ${Math.round(stageTokens / 1000)}k 超出阶段预算 ${Math.round(STAGE_TOKEN_BUDGET / 1000)}k，熔断，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens }
    }
    if (attempt < RETRY_LIMIT) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 第 ${attempt} 次尝试未成功，自动重试…` })
    } else {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 连续 ${RETRY_LIMIT} 次尝试失败，超出重试阈值，需人工介入` })
      journal.humanIntervention = true
    }
  }
  return { text: null, attempts, stageTokens }
}
