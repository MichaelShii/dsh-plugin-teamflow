/**
 * dsh-plugin-teamflow core — 子代理执行器（并发池 / 单阶段运行 / 重试与熔断）。
 * 依赖：util/constants/types + core(context/metering)。
 */
import { runtime, inFlight, providerName } from './context.ts'
import { measureTokens, accumulateSessionUsage, costTokensOf } from './metering.ts'
import { clip, extractText, normalizeSignal, hasSubstance, isUnretryable, handoffBrief } from '../util.ts'
import { RETRY_LIMIT, STAGE_TOKEN_BUDGET, COST_BUDGET_TOKENS } from '../constants.ts'
import type { Journal, ParentAgentLike } from '../types.ts'

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

/** 运行单个阶段子代理：执行 + 产出实质校验 + token 双口径计量 + stage 状态流转。 */
export async function runAgent(
  journal: Journal, parent: ParentAgentLike, label: string, phase: string, prompt: string, signal: unknown,
): Promise<string | null> {
  const maxSeq = journal.stages.length ? Math.max(...journal.stages.map((s) => s.seq)) : 0
  let stageText = null
  const stage = {
    seq: maxSeq + 1, label, phase, status: 'running', outcome: null,
    childId: null, startedAt: Date.now(), endedAt: null, summary: null,
    tokens: null, usage: null, costTokens: null, handoff: null, output: null,
  }
  journal.stages.push(stage)
  journal.agentsStarted += 1
  let run = null
  try {
    run = await runtime.subagents.start(providerName(), {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
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
    stage.outcome = journal.cancelled ? 'cancelled' : 'error'
    stage.summary = `启动/执行失败：${String((e && e.message) || e)}`
    journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 启动/执行失败：${String((e && e.message) || e)}` })
    return null
  } finally {
    const usage = accumulateSessionUsage(run)
    stage.usage = usage
    stage.costTokens = usage ? costTokensOf(usage) : null
    stage.tokens = measureTokens(run) // 兼容字段：上下文压力快照
    stage.handoff = stageText ? handoffBrief(stageText) : null
    stage.endedAt = Date.now()
    if (inFlight.get(journal.id) && inFlight.get(journal.id).stage === stage) inFlight.delete(journal.id)
    if (run) { try { await run.dispose() } catch (e2) { /* ignore */ } }
  }
}

/** 单阶段重试 + token 熔断（上下文压力）+ 成本观测（当量，仅记录不打断）。 */
export async function withRetry(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown,
): Promise<{ text: string | null; attempts: number; stageTokens: number; stageCost: number }> {
  let attempts = 0
  let stageTokens = 0
  let stageCost = 0
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    attempts = attempt
    const labelNow = attempt > 1 ? `${label}（第 ${attempt} 次重试）` : label
    const result = await runAgent(journal, parent, labelNow, phase, prompt, signal)
    // 累计本阶段各次尝试的 token 用量（熔断预算）与计费当量（成本观测）
    const lastStage = journal.stages[journal.stages.length - 1]
    if (lastStage && lastStage.phase === phase) {
      if (typeof lastStage.tokens === 'number') stageTokens += lastStage.tokens
      if (typeof lastStage.costTokens === 'number') stageCost += lastStage.costTokens
    }
    if (result) return { text: result, attempts, stageTokens, stageCost }
    // 成本观测：计费当量超阈值 → 仅记录 warn，不打断（本次目标为观测修正）
    if (stageCost >= COST_BUDGET_TOKENS) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 累计计费当量 ${Math.round(stageCost / 1000)}k 超出成本观测阈值 ${Math.round(COST_BUDGET_TOKENS / 1000)}k（仅记录，不打断）` })
    }
    if (journal.cancelled) return { text: null, attempts, stageTokens, stageCost }
    // 不可重试失败（上下文耗尽等）：重试同一 prompt 大概率复现 → 直接需人工
    if (lastStage && isUnretryable(lastStage.outcome, lastStage.outcome)) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 失败原因不可重试（${lastStage.outcome}），跳过重试，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stageCost }
    }
    // token 熔断：本阶段累计用量超预算 → 停止重试
    if (stageTokens >= STAGE_TOKEN_BUDGET) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 累计 token ${Math.round(stageTokens / 1000)}k 超出阶段预算 ${Math.round(STAGE_TOKEN_BUDGET / 1000)}k，熔断，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens, stageCost }
    }
    if (attempt < RETRY_LIMIT) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 第 ${attempt} 次尝试未成功，自动重试…` })
    } else {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 连续 ${RETRY_LIMIT} 次尝试失败，超出重试阈值，需人工介入` })
      journal.humanIntervention = true
    }
  }
  return { text: null, attempts, stageTokens, stageCost }
}
