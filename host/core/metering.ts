/**
 * dsh-plugin-teamflow core — token 计量（官方口径）。
 * 依赖：types.ts、context.ts（runtime.sessionProjections）。
 *
 * 口径与模型 provider 账单一致（模型无关）：
 *  - input      : 输入（缓存未命中）
 *  - cacheRead  : 输入（缓存命中）
 *  - cacheWrite : 输入写入缓存
 *  - output     : 输出
 *  billed input = input + cacheRead + cacheWrite。
 * 缓存命中率 = cacheRead / (input + cacheRead)。
 *
 * 来源优先级（2026-09-10 适配 dsh 0.1.5-rc.2）：
 *  1) **官方 Session 投影**（首选）：`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶 +
 *     `'sessionStats'` 取调用数——零历史扫描，且与官方 token-meter 同一份 fold（不再自行复刻口径）。
 *  2) **事件扫描回退**（存量路径）：宿主未挂载投影（最小 profile/未来移除）或投影无 provider usage 时，
 *     沿用 events → snapshotEvents() → ownEvents() 多源回退。宿主自 2026-09-09 起把这三个同步历史读取器
 *     标记为 deprecated（存量可留、新调用禁止），本路径仅为无投影宿主保底，不再扩展（见 docs/TODO.md）。
 */
import { runtime } from './context.ts'
import type { SubagentRunLike, UsageBuckets } from '../types.ts'

/** 投影字段读数（宽进严出：非法/非正一律 0，不虚报）。 */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 官方 Session 投影注册表（ctx.sessionProjections）的鸭子形状；未挂载 → 回退事件扫描。 */
interface SessionProjectionsLike {
  stateOf?: (session: unknown, key: string) => unknown
}

/**
 * 投影路径（官方口径首选）：
 *  - `tokenUsage`（dsh-token-meter 注册，stateVersion 2）→ totals 四桶：与官方同一份 fold，
 *    `assistant/attempt` 内嵌 stream usage 同样计入、`llm/retry-started` 会先关掉被替换的重试槽位
 *    ——比旧事件扫描（只认 assistant/message）更准，重试不重复计。
 *  - `sessionStats`（dsh-session-stats 注册）steps → 调用数（一个 step = 一次模型请求；
 *    旧扫描按 assistant/message 的 turn.step 去重，语义等价）。
 * 返回 null = 投影不可用或该会话无 provider usage —— 交给事件扫描回退（不虚报 0）。
 */
function projectedUsageOf(run: SubagentRunLike | null | undefined): UsageBuckets | null {
  try {
    const projections = runtime.sessionProjections as SessionProjectionsLike | undefined
    if (!projections || typeof projections.stateOf !== 'function') return null
    const session = run && run.localAgent ? run.localAgent.session : null
    if (!session) return null
    const usage = projections.stateOf(session, 'tokenUsage') as { totals?: Record<string, unknown> } | undefined
    const totals = usage && usage.totals
    if (!totals) return null
    const buckets: UsageBuckets = {
      input: countOf(totals.uncachedInputTokens),
      cacheRead: countOf(totals.cacheReadTokens),
      cacheWrite: countOf(totals.cacheWriteTokens),
      output: countOf(totals.outputTokens),
      calls: 0,
    }
    if (totalTokensOf(buckets) <= 0) return null
    const stats = projections.stateOf(session, 'sessionStats') as { steps?: unknown } | undefined
    buckets.calls = countOf(stats && stats.steps) || 1
    return buckets
  } catch (e) { return null }
}

/**
 * 采集子代理会话事件（存量回退路径——2026-09-07 实锤 r38 usage 全空）：
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
 * 来源优先级：官方 Session 投影（首选，零历史扫描）→ 事件扫描（无投影宿主的存量回退）。
 * 返回 null 表示两条路径都拿不到 usage（会话未暴露投影与事件 / 无数据）。
 */
export function accumulateSessionUsage(run: SubagentRunLike | null | undefined): UsageBuckets | null {
  const projected = projectedUsageOf(run)
  if (projected) return projected
  return scannedUsageOf(run)
}

/** 事件扫描回退（投影未挂载/无数据时使用；沿用 2026-09-07 的多源回退语义，不改行为）。 */
function scannedUsageOf(run: SubagentRunLike | null | undefined): UsageBuckets | null {
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

/** 官方口径总消耗（billed input + output，含 cacheRead/cacheWrite）——**汇报/展示**口径。 */
export function totalTokensOf(usage: UsageBuckets | null | undefined): number {
  if (!usage) return 0
  return (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.output || 0)
}

/**
 * 熔断口径「新增消耗」= input + cacheWrite + output（**排除 cacheRead**）。
 *
 * 为什么与汇报口径分家（2026-09-11）：cacheRead 是上下文复用的缓存重放，单价低且是
 * **复用证据**而非烧钱信号；把它计入熔断，会让预算被「每步 1M 量级的命中」瞬间打爆——
 * 实锤 assetd tf-mtwvwpxa-p3vw08 的 T5：报「累计 token 1886k 超出阶段预算 60k」，
 * 其中 1830k 是 cacheRead，真实新增仅 55k；后果是任何 dev 任务一失败就熔断，
 * RETRY_LIMIT 永不生效。汇报仍用 `totalTokensOf`（官方口径，AGENTS §4 不变）。
 */
export function freshTokensOf(usage: UsageBuckets | null | undefined): number {
  if (!usage) return 0
  return (usage.input || 0) + (usage.cacheWrite || 0) + (usage.output || 0)
}

/* ── 熔断预算的**缓存能力自适应**（2026-09-18 probe-v2 实锤） ──────────────────────────
 * `FRESH_TOKEN_BUDGET = 200k` 的立论默认「cacheRead 是廉价重放、新增只是零头」（有缓存的
 * provider 上实测每次调用新增 1.2–2.4k）。**这个前提对不缓存的 provider 不成立**：system
 * prompt + 工具定义（该会话实测 ~15.5k token）每轮工具调用都要整体重发一次，于是
 * 「新增 token」实际是「调用次数 × 15.5k」，200k ≈ 一个阶段最多 13 次调用 —— 阈值从
 * 「真跑飞才熔断」退化成「调用多一点就熔断」。
 * 实锤：probe-v2 `tf-mu71waxg-4iws10` 的 PRD 阶段用 `inception/mercury-2.5`（命中率 10.4%、
 * cacheWrite=0）跑了 17 次调用 → 259k → 熔断转人工；同一阶段在命中 90%+ 的 provider 上
 * 17 次调用只需 ~25–40k。故：**观测到「不缓存」时按倍数放宽预算**（有缓存的 provider 分毫不动）。
 */

/** 「不缓存」判定阈值：命中率低于它且调用数够多（单次调用的样本没有意义）。 */
export const UNCACHED_HIT_RATIO = 0.5
export const UNCACHED_MIN_CALLS = 5
/** 放宽倍数 = 原设计的相对余量（200k ≈ 两轮尝试）→ 无缓存下同样要留两轮尝试。 */
export const UNCACHED_BUDGET_FACTOR = 3

/** 官方口径缓存命中率 = cacheRead/(input+cacheRead)（无输入记 0，不做除零外推）。 */
export function cacheHitRatioOf(usage: UsageBuckets | null | undefined): number {
  const input = (usage && usage.input) || 0
  const cacheRead = (usage && usage.cacheRead) || 0
  const total = input + cacheRead
  return total > 0 ? cacheRead / total : 0
}

/**
 * 该阶段**有效的新增 token 预算** + 判定依据（供熔断日志留痕）。
 * @returns budget = 基础预算（无缓存 ×`UNCACHED_BUDGET_FACTOR`）；uncached = 是否放宽；
 *          ratio/calls = 依据（命中率与累计调用数），未放宽时也为真实值。
 */
export function effectiveFreshBudget(
  usage: UsageBuckets | null | undefined,
  base: number,
): { budget: number; uncached: boolean; ratio: number; calls: number } {
  const calls = (usage && usage.calls) || 0
  const ratio = cacheHitRatioOf(usage)
  const uncached = calls >= UNCACHED_MIN_CALLS && ratio < UNCACHED_HIT_RATIO
  return { budget: uncached ? base * UNCACHED_BUDGET_FACTOR : base, uncached, ratio, calls }
}
