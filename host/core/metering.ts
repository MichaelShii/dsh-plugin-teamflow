/**
 * dsh-plugin-teamflow core — token 计量（官方口径）。
 * 依赖：types.ts、context.ts（runtime.tokenMeter）。
 *
 * 口径与模型 provider 账单一致（模型无关）：
 *  - input      : 输入（缓存未命中）
 *  - cacheRead  : 输入（缓存命中）
 *  - cacheWrite : 输入写入缓存
 *  - output     : 输出
 *  billed input = input + cacheRead + cacheWrite。
 * 缓存命中率 = cacheRead / (input + cacheRead)。
 */
import type { SubagentRunLike, UsageBuckets } from '../types.ts'

/**
 * 累计子代理会话中所有 LLM 调用的真实 usage（官方三桶 + 调用数）。
 * 返回 null 表示拿不到 usage（会话未暴露 events / 无数据）。
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

/** 官方口径总消耗（billed input + output，含 cacheRead/cacheWrite）。 */
export function totalTokensOf(usage: UsageBuckets | null | undefined): number {
  if (!usage) return 0
  return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.output || 0)
}
