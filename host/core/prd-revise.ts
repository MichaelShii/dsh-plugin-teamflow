/**
 * dsh-plugin-teamflow core — PRD **续跑改写**（2026-10-17，issue #11 后续）。
 *
 * **为什么要有这个模块**：确认单上「要改」此前的做法是**重跑整个 PRD 子代理**（新 spawn、从零读需求/文档、
 * 重新生成整份 PRD）。这不只是贵：重新生成会**漂移**——用户只要求改一处，没提的部分也可能被顺手改写。
 *
 * 而阶段子代理**本来就是 continuable**（`startActivation` 内部 `provider.prepareContinuable ?
 * startLocal : startExternal`，`spawn` provider 有该能力）⇒ 可以对同一个 child 投递一条修改要求，
 * 它会带着自己的上下文只改那处。
 *
 * **实机验证（headless 探针，本仓 2026-10-17）**：子代理 settle 后 `sendMessage` 仍被接受（走 coldResume
 * 重建）；第二轮 `turn/start`+`turn/end` 各两条、事件 19→30；第一轮给的口令在第二轮被正确复述
 * ⇒ 上下文确实复用。usage 示例：`input 180 / cacheRead 8448 / output 6`（复用上下文缓存，不是重发整包）。
 *
 * **取文本的正确姿势（踩过三版坑，别改）**：
 * - ❌ `activation.result`：只 resolve 一次 ⇒ 恒为**第一轮**旧值。
 * - ❌ `sessions.get(childId)`：settle 后 agent/session 已 dispose，拿不到。
 * - ✅ `sessionQuery.observeSession(childId).events` → `assistant/message` → **`data.message.content`**
 *   （⚠️ 不是 `data.content`，那个字段在 assistant 事件上不存在）；usage 在 `data.usage`。
 *
 * **失败语义**：任何异常/超时/形状不认识 ⇒ 返回 `null`，**调用方回落为「重跑 PRD」**。
 * 续跑是加速路径，不是唯一路径；绝不能因为续跑失败就让用户改不了。
 */

/** 续跑等待上限（PRD 改写实测 1–3 分钟；给足余量，超时即回落重跑）。 */
export const REVISE_WAIT_MS = 300_000
/** 轮询间隔（宿主的 session 落盘不是事件推送，只能轮询；1s 粒度对分钟级任务足够）。 */
export const REVISE_POLL_MS = 1000

/**
 * 续跑失败的诊断数据（2026-10-18 加，真机 `tf-mvcl5m8t` 逼出来的）。
 *
 * 教训：第一版的回落文案把「子代理已释放 / 宿主无 sessionQuery / 超时 / 拿到空文本」四个原因
 * 写在同一句话里 ⇒ 真机等满 3 分钟回落后，**完全无法区分**是「投递后事件零增长（第二轮没启动）」
 * 还是「跑了但没结束」。以后凡「失败即回落」的路径，必须把可区分的观测值带出来。
 */
export interface RevisionDiag {
  /** 投递前的基线事件数 */
  base: number
  /** 结束（或超时）时的事件数 */
  end: number
  /** 等了多少毫秒 */
  waitedMs: number
  /** 投递是否被接受 */
  delivered: boolean
}

/** 一条 assistant/message 事件的可见文本（字段名见文件头：`data.message.content` 才是对的）。 */
export function assistantTextOf(event: unknown): string {
  const e = (event || {}) as { type?: unknown; data?: unknown }
  if (e.type !== 'assistant/message') return ''
  const d = (e.data || {}) as Record<string, unknown>
  const blocks = (d.message && (d.message as Record<string, unknown>).content) ?? d.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? String((b as { text: string }).text) : ''))
    .join('')
}

/**
 * 取「第 `fromIndex` 条之后最后一个非空 assistant 文本」。
 *
 * 为什么要「最后一个」：第二轮可能跨多个 step（先推理再答），中间可能夹着空文本的 assistant/message。
 * 纯函数，便于行为测试（不读文件、不认宿主私有类型）。
 */
/**
 * 「某一刻之后」的事件过滤锚点。
 *
 * **为什么不能再用数组下标**（2026-10-18 真机 `tf-mvdixrhs` 实锤）：投递前 `observeSession`
 * 返回的事件数组可能**只加载了一部分**，投递后同一 child 的数组会**补加载历史**（长度暴涨、
 * 前面插入的是旧事件）⇒ `events.slice(base)` 里混进旧事件 ⇒ 这一轮的 usage 变成**全会话累计**，
 * 与 `prdUsageAcc` 相加就翻倍（当时靠「重复护栏」兜住，但那只是止血）。
 *
 * 事件自带宿主写的 `time`（epoch ms，同机同钟）⇒ 用**投递时刻**当锚点，与数组长度/顺序无关。
 */
export interface UsageSince {
  /** 投递时刻（`Date.now()`）。只统计 `time >= since` 的 assistant/message。 */
  since: number
  /** 投递前的数组长度：**仅当事件缺 `time` 时**（老格式/夹具）回落用它，真机走时间锚点。 */
  index?: number
}

/** 锚点既接受下标（旧调用/测试），也接受时间（真机路径）。 */
export type UsageAnchor = number | UsageSince

function inRound(e: unknown, index: number, anchor: UsageAnchor): boolean {
  if (typeof anchor === 'number') return index >= Math.max(0, anchor)
  const t = (e as { time?: unknown } | null)?.time
  if (typeof t === 'number' && Number.isFinite(t)) return t >= anchor.since
  // 没有 time 的事件只能按位置判（夹具就是这种）——真机的补加载问题不会出现在这里。
  return index >= Math.max(0, Number(anchor.index ?? 0))
}

export function lastAssistantText(events: readonly unknown[] | null | undefined, anchor: UsageAnchor = 0): string {
  if (!Array.isArray(events)) return ''
  let out = ''
  for (let i = 0; i < events.length; i++) {
    if (!inRound(events[i], i, anchor)) continue
    const t = assistantTextOf(events[i])
    if (t && t.trim()) out = t
  }
  return out
}

/**
 * 聚合「第 `fromIndex` 条之后」的 token usage ⇒ 插件口径 `UsageBuckets`
 * （事件里是 `inputTokens/outputTokens/cacheReadTokens/cacheWriteTokens`，字段名不同）。
 *
 * 为什么从事件取而不是 `accumulateSessionUsage(run)`：续跑那一轮没有 `run` 句柄
 * （`sendMessage` 只回 messageId，child 已 dispose）⇒ 投影通道拿不到，只能扫事件。
 * 返回 `null` = 一条 usage 都没有（不编造 0，与 `accumulateSessionUsage` 的空值语义一致）。
 */
export function sumRevisionUsage(
  events: readonly unknown[] | null | undefined,
  anchor: UsageAnchor = 0,
): { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number } | null {
  if (!Array.isArray(events)) return null
  const out = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  let seen = false
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  for (let i = 0; i < events.length; i++) {
    if (!inRound(events[i], i, anchor)) continue
    const e = events[i] as { type?: unknown; data?: unknown } | null
    if (!e || e.type !== 'assistant/message') continue
    const u = (e.data || {}) as Record<string, unknown>
    const usage = (u.usage || {}) as Record<string, unknown>
    if (!usage || typeof usage !== 'object') continue
    const input = num(usage.inputTokens)
    const output = num(usage.outputTokens)
    const cacheRead = num(usage.cacheReadTokens)
    const cacheWrite = num(usage.cacheWriteTokens)
    if (!input && !output && !cacheRead && !cacheWrite) continue
    seen = true
    out.input += input
    out.output += output
    out.cacheRead += cacheRead
    out.cacheWrite += cacheWrite
    out.calls += 1
  }
  return seen ? out : null
}

/** 宿主能力的鸭子类型（本模块刻意不 import 宿主类型：pipeline 只拿得到 ctx.get 的结果）。 */
export interface RevisionHost {
  sendMessage?: (sender: unknown, targetId: string, content: unknown[], options: { signal: AbortSignal }) => Promise<unknown>
  observeSession?: (id: string, options: { signal: AbortSignal }) => Promise<unknown>
}

export function canReviseViaChild(v: { subagents?: unknown; sessionQuery?: unknown; childId?: unknown }): boolean {
  const sub = v.subagents as RevisionHost | undefined
  const sq = v.sessionQuery as RevisionHost | undefined
  return !!v.childId
    && typeof v.childId === 'string'
    && !!sub && typeof sub.sendMessage === 'function'
    && !!sq && typeof sq.observeSession === 'function'
}

export interface RevisionOutcome {
  text: string
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number; calls: number } | null
  /** 投递前的基线事件数（供调用方审计/日志） */
  baseEvents: number
  /** 结束时的总事件数 */
  endEvents: number
}

/**
 * 对**已存在的 PRD 子代理**投一条修改要求，等它这一轮跑完，返回新 PRD 文本。
 *
 * 返回 `null` = 不可用 / 超时 / 没拿到文本 ⇒ 调用方**必须回落为「重跑 PRD」**。
 * 这里不做任何「假装成功」的兜底（返回空串会让下游把 PRD 写空 —— 比失败更糟）。
 */
export async function revisePrdViaChild(v: {
  subagents?: unknown
  sessionQuery?: unknown
  parent: unknown
  childId: string
  instruction: string
  signal: AbortSignal
  waitMs?: number
  pollMs?: number
  onWait?: (msg: string) => void
  /** 失败时的诊断出口（调用方必须把它写进日志 —— 否则「为什么回落」永远是黑盒）。 */
  diag?: RevisionDiag | null
}): Promise<RevisionOutcome | null> {
  const putDiag = (base: number, end: number, delivered: boolean, startedAt: number): void => {
    if (v.diag) { v.diag.base = base; v.diag.end = end; v.diag.delivered = delivered; v.diag.waitedMs = Date.now() - startedAt }
  }
  const sub = v.subagents as RevisionHost | undefined
  const sq = v.sessionQuery as RevisionHost | undefined
  if (!sub || typeof sub.sendMessage !== 'function' || !sq || typeof sq.observeSession !== 'function') return null
  const signal = v.signal
  const waitMs = Number(v.waitMs || REVISE_WAIT_MS) || REVISE_WAIT_MS
  const pollMs = Number(v.pollMs || REVISE_POLL_MS) || REVISE_POLL_MS
  const observe = async (): Promise<unknown[] | null> => {
    try {
      const obs = await sq.observeSession!(v.childId, { signal })
      const events = (obs as { events?: unknown } | null)?.events
      return Array.isArray(events) ? events : null
    } catch (e) {
      return null
    }
  }
  // 基线：投递前的事件数（取不到就不投 —— 否则无法区分「第一轮旧文本」与「第二轮新文本」）
  const before = await observe()
  if (!before) return null
  const base = before.length
  // **锚点 = 我们要求改的那一刻**（投递前取），而不是投递前数组的长度：
  // cold resume 后同一 child 会补加载历史 ⇒ 长度暴涨、旧事件被插到前面 ⇒ 按下标切会重复计。
  const started = Date.now()
  const anchor: UsageAnchor = { since: started, index: base }
  try {
    await sub.sendMessage!(v.parent, v.childId, [{ type: 'text', text: v.instruction }], { signal })
  } catch (e) {
    putDiag(base, base, false, Date.now())
    return null
  }
  let events: unknown[] | null = null
  let end = base
  while (Date.now() - started < waitMs) {
    if (signal && signal.aborted) { putDiag(base, end, true, started); return null }
    await new Promise((r) => setTimeout(r, pollMs))
    events = await observe()
    if (!events) continue
    end = events.length
    // **判据换成「锚点之后有没有 turn/end」**：不能用 `events.length <= base` 继续等——
    // 补加载历史会让长度立刻变大（旧实现会在那一刻误判"有新事件"）。
    const fresh = events.filter((e, i) => inRound(e, i, anchor))
    if (!fresh.length) continue
    if (!fresh.some((e) => !!e && (e as { type?: unknown }).type === 'turn/end')) continue
    const text = lastAssistantText(events, anchor)
    if (!text || !text.trim()) { putDiag(base, end, true, started); return null }
    return { text, usage: sumRevisionUsage(events, anchor), baseEvents: base, endEvents: events.length }
  }
  if (v.onWait) v.onWait('timeout')
  putDiag(base, end, true, started)
  return null
}
