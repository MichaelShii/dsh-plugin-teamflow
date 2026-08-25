/**
 * dsh-plugin-teamflow core — 子代理单调用护栏（进行中退化检测）。
 * 依赖：constants + types + core(metering 的 events 访问器)。
 *
 * 背景（实锤 run tf-mt5afdch-7xyajm）：QA 子代理在某步陷入推理复读死循环
 * （同一句 "Let me check if there are any other issues" 重复数百次），38 分钟烧 481 万
 * token 零产出。既有熔断只在 withRetry「尝试之间」检查——单次调用内部永不返回时够不着，
 * 也没有任何超时兜底。
 *
 * 设计原则：【进度信号，不是配额】只在确认无生产价值的时刻中止，不设会误杀正常长任务的
 * 步数/token 硬上限（正常阶段之间调用数差 9 倍、计费量差 11 倍且 cacheRead 天然虚高）：
 *  A. 复读检测：滑动窗口内同一规范化片段出现 ≥ GUARD_REPEAT_LIMIT 次（正常 agent 措辞有变化，
 *     流式分片边界也不稳定，几乎不可能逐字重复同一段 ≥12 次）；
 *  B. 墙钟兜底：超过 GUARD_WALL_CLOCK_MS（远大于历史正常 p95 ~10min）强制止损。
 *
 * 中止方式：run.dispose() → run.result 结算，stage.outcome 置 'degenerated'
 * （命名刻意避开 isUnretryable 的 /token|context|limit/ 正则——护栏止损后应走干净重试）。
 */
import { GUARD_POLL_MS, GUARD_REPEAT_LIMIT, GUARD_WALL_CLOCK_MS, GUARD_WINDOW_SIZE } from '../constants.ts'
import type { Journal, SubagentRunLike } from '../types.ts'
import type { JournalStage } from '../../store.ts'

/** 与 metering 同款事件访问器（session.events 可能是数组或返回数组的函数）。 */
function eventsOf(run: SubagentRunLike | null | undefined): unknown[] {
  const local = run && (run as { localAgent?: { session?: unknown } }).localAgent
  const session = (local && local.session) as { events?: unknown } | null | undefined
  if (!session) return []
  const raw = session.events
  const events = Array.isArray(raw) ? raw : typeof raw === 'function' ? (raw as () => unknown[] | null)() : null
  return Array.isArray(events) ? events : []
}

/** 规范化文本片段：小写 + 仅保留字母数字/CJK，供逐字重复比对。 */
function normalizeFragment(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

/**
 * 启动单调用护栏轮询，返回取消函数（runAgent finally 必须调用）。
 * 触发时：stage.guardReason 记录原因 + journal 落日志 + dispose 中止本次尝试。
 */
export function startStageGuard(opts: {
  run: { id: string; result: Promise<unknown>; dispose(): Promise<void> | void }
  journal: Journal
  label: string
  stage: JournalStage
}): () => void {
  const { run, journal, label, stage } = opts
  const startedAt = Date.now()
  let fired = false
  const window: Array<{ t: number; s: string }> = []
  const timer = setInterval(() => {
    if (fired || journal.cancelled) return
    try {
      // C. 墙钟兜底：远超正常阶段时长，强制止损（不区分是否仍在产出）
      if (Date.now() - startedAt > GUARD_WALL_CLOCK_MS) {
        fire(`墙钟超限（>${Math.round(GUARD_WALL_CLOCK_MS / 60000)}min）`)
        return
      }
      // A. 复读检测：收集流式文本片段，滑窗内逐字重复即判退化
      const events = eventsOf(run)
      for (const ev of events.slice(-400)) {
        const e = ev as { type?: string; data?: { texts?: unknown }; texts?: unknown } | null
        if (!e || (e.type !== 'text-chunks' && e.type !== 'reasoning-chunks')) continue
        const arr = (e.data && e.data.texts) || e.texts
        if (!Array.isArray(arr)) continue
        for (const t of arr) {
          const s = normalizeFragment(String(t))
          if (s.length < 12) continue
          window.push({ t: Date.now(), s })
        }
      }
      if (window.length > GUARD_WINDOW_SIZE) window.splice(0, window.length - GUARD_WINDOW_SIZE)
      const counts = new Map<string, number>()
      for (const w of window) counts.set(w.s, (counts.get(w.s) || 0) + 1)
      for (const [, n] of counts) {
        if (n >= GUARD_REPEAT_LIMIT) {
          fire(`推理复读（同一片段在近 ${window.length} 条流式片段中出现 ${n} 次）`)
          return
        }
      }
    } catch (e) { /* 护栏自身异常不影响流水线 */ }
  }, GUARD_POLL_MS)
  function fire(reason: string) {
    if (fired) return
    fired = true
    clearInterval(timer)
    stage.guardReason = reason
    try {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 触发进行中护栏并中止本次尝试：${reason}` })
    } catch (e) { /* ignore */ }
    try { void Promise.resolve(run.dispose()).catch(() => {}) } catch (e) { /* ignore */ }
  }
  return () => { fired = true; clearInterval(timer) }
}
