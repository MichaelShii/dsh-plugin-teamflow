/**
 * dsh-plugin-teamflow core — token 计量（双口径：真实累计 usage + 上下文压力快照 + 计费当量）。
 * 依赖：types.ts、context.ts（runtime.tokenMeter）。
 * 口径详见 ADR-0003。
 */
import type { SubagentRunLike, UsageBuckets } from '../types.ts'
import { runtime } from './context.ts'

/** 上下文压力快照（原 tokenMeter.measure：尾声上下文大小，非累计）。 */
export const measureTokens = (run: unknown): number | null => {
  const tokenMeter = runtime.tokenMeter as { measure?: (session: unknown) => { totalTokens?: number } } | undefined
  if (!tokenMeter || !run || !(run as { localAgent?: unknown }).localAgent) return null
  try {
    const m = tokenMeter.measure((run as { localAgent: { session: unknown } }).localAgent.session)
    return (m && typeof m.totalTokens === 'number') ? m.totalTokens : null
  } catch (e) { return null }
}

/**
 * 累计子代理会话中所有 LLM 调用的真实 usage（input/cacheRead/cacheWrite/output + 调用数）。
 * 与「measure 快照」不同：这是生命周期累计 API token，能如实反映 loop 重放的成本。
 * 返回 null 表示拿不到 usage（会话未暴露 events / 无数据），调用方回退到上下文压力。
 */
export function accumulateSessionUsage(run: SubagentRunLike | null | undefined): UsageBuckets | null {
  const local = run && run.localAgent
  const session = (local && local.session) as { events?: unknown } | null | undefined
  if (!session) return null
  const rawEvents = session.events
  const events = Array.isArray(rawEvents) ? (rawEvents as unknown[]) : (typeof rawEvents === 'function' ? (rawEvents as () => unknown[] | null)() : null)
  if (!Array.isArray(events)) return null
  const buckets: UsageBuckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  const seen = new Set<string>()
  for (const ev of events) {
    const e = ev as { type?: string; data?: { turn?: number; step?: number; usage?: { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number } } } | null
    if (!e || e.type !== 'assistant/message') continue
    const d = e.data || {}
    if (typeof d.turn === 'number' && typeof d.step === 'number') seen.add(`${d.turn}.${d.step}`)
    const u = d.usage
    if (u) {
      buckets.input += u.inputTokens || 0
      buckets.cacheRead += u.cacheReadTokens || 0
      buckets.cacheWrite += u.cacheWriteTokens || 0
      buckets.output += u.outputTokens || 0
    }
  }
  if (buckets.input + buckets.cacheRead + buckets.cacheWrite + buckets.output <= 0) return null
  buckets.calls = seen.size || 1
  return buckets
}

/** 计费当量：cacheRead 按 1/10 折算（DeepSeek cache hit 成本约 input 的 1/10），用于成本观测。 */
export function costTokensOf(buckets: UsageBuckets | null): number {
  if (!buckets) return 0
  return Math.round(buckets.input + buckets.cacheWrite + buckets.output + buckets.cacheRead * 0.1)
}
