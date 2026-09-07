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
 * 采集子代理会话事件（多源回退——2026-09-07 实锤 r38 usage 全空）：
 * 宿主新版 Session（session v2）已无 `events` 属性/getter（仅私有 eventsSnapshot 缓存 +
 * 官方 snapshotEvents()/ownEvents() 方法），旧实现读 session.events = undefined → usage 全 null。
 * 回退链（与 guard.eventsOf 同款语义）：events（老宿主快照，兼容）→ snapshotEvents()（官方完整日志）
 * → ownEvents()（fork 后本 agent 自己的事件）。取信息最多（含 usage 事件数最多）的源。
 */
function sessionEventsOf(run: SubagentRunLike | null | undefined): unknown[] {
  try {
    const local = run && run.localAgent
    const session = (local && local.session) as {
      events?: unknown
      snapshotEvents?: () => unknown
      ownEvents?: () => unknown
    } | null | undefined
    if (!session) return []
    const candidates: unknown[] = []
    try {
      const raw = session.events
      if (Array.isArray(raw)) candidates.push(raw)
      else if (typeof raw === 'function') candidates.push((raw as () => unknown)())
    } catch (e) { /* 老快照访问异常——降级下一源 */ }
    try {
      if (typeof session.snapshotEvents === 'function') candidates.push(session.snapshotEvents())
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof session.ownEvents === 'function') candidates.push(session.ownEvents())
    } catch (e) { /* 忽略 */ }
    const valid = candidates.filter((c) => Array.isArray(c)) as unknown[][]
    if (valid.length === 0) return []
    // 取含 usage 的 assistant/message 事件最多的源（失明的空视图/无 usage 视图靠边）
    const countUsage = (arr: unknown[]) => arr.filter((ev) => {
      const e = ev as { type?: string; data?: { usage?: unknown } }
      return e && e.type === 'assistant/message' && e.data && typeof e.data.usage === 'object' && e.data.usage !== null
    }).length
    valid.sort((a, b) => countUsage(b) - countUsage(a))
    return valid[0]
  } catch (e) { return [] }
}

/** 从单个 assistant/message 事件取 usage（宿主 usageOf 同款双路径：data.usage 优先，
 * 缺失时从 data.stream 的 usage chunk 取——v2 事件 usage 可能只在 stream 里）。 */
function usageOfEvent(e: { type?: string; data?: unknown } | null): { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number } | undefined {
  if (!e || e.type !== 'assistant/message') return undefined
  const d = (e.data || {}) as { usage?: unknown; stream?: unknown[] }
  if (d.usage && typeof d.usage === 'object') return d.usage as { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
  if (Array.isArray(d.stream)) {
    for (const member of [...d.stream].reverse()) {
      const chunk = (member as { chunk?: { type?: string; usage?: unknown } })?.chunk
      if (chunk && chunk.type === 'usage' && chunk.usage && typeof chunk.usage === 'object') {
        return chunk.usage as { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number }
      }
    }
  }
  return undefined
}

/**
 * 累计子代理会话中所有 LLM 调用的真实 usage（官方三桶 + 调用数）。
 * 返回 null 表示拿不到 usage（会话未暴露 events / 无数据）。
 */
export function accumulateSessionUsage(run: SubagentRunLike | null | undefined): UsageBuckets | null {
  const events = sessionEventsOf(run)
  if (events.length === 0) return null
  const buckets: UsageBuckets = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  const seen = new Set<string>()
  for (const ev of events) {
    const e = ev as { type?: string; data?: { turn?: number; step?: number } } | null
    if (!e || e.type !== 'assistant/message') continue
    const d = e.data || {}
    if (typeof d.turn === 'number' && typeof d.step === 'number') seen.add(`${d.turn}.${d.step}`)
    const u = usageOfEvent(e)
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
