/**
 * dsh-plugin-teamflow core — 子代理单调用护栏 v2（进行中退化检测，纯进度信号）。
 * 依赖：constants + types。
 *
 * 背景（实锤）：① QA 子代理推理复读死循环 38 分钟烧 481 万 token 零产出；
 * ② v1 护栏的裸墙钟（25min）误杀了合法长任务——medium 档 UI 重构 dev 以 10.6 次工具调用/分钟
 *    的健康节奏工作到第 25 分钟被击落（tf-mt8fbavd dev 尝试一）。
 *
 * 设计原则：【只看进度信号，无任何时间配额】慢吞吐的合法任务永远不该被打断：
 *  A. 复读检测：滑动窗口内同一规范化流式片段出现 ≥ GUARD_REPEAT_LIMIT 次，且窗口内零变更进展
 *     （无 edit/write 等写操作）→ 真退化（纯推理打转）→ outcome='degenerated'（豁免预算门，允许一次干净重试）。
 *     ⚠️ 状态判定（实锤 run tf-mte906e9）：大文件 read-edit 循环是正常模式——模型反复 read 同一大文件
 *     （每次 edit 后内容已变，必须重读确认）、输出高度相似的「读后分析」，逐字片段在 400 条窗口内
 *     可累积 ≥12 次——伴随 edit/write 变更调用时只记录观察，不中止（否则大文件修改任务全被误杀）。
 *  B. 挂死检测：连续 GUARD_SILENCE_MS 没有**任何已提交事件**（provider 层挂起/连接静默死亡）
 *     → outcome='stalled'（走正常预算门 → 熔断转人工，不自动重试烧钱）。
 *     2026-09-10：时间来源改为**官方 `subagentTiming` 投影**（`active.through` = 该投影 cut 上
 *     最新事件时间，由宿主在已提交事件上折叠）——不再依赖「三源取最长视图」的长度启发式
 *     （r1 QA 误判的根因就是那个视图会失明）；投影不可用时回退旧启发式。长工具静默执行
 *     （跑 12 分钟测试无输出）仍由 agent 活动守卫豁免，不做误杀。
 *  C. 空转检测：会话仍在产出事件，但连续 GUARD_NO_TOOL_MS 没有任何工具调用
 *    （纯推理打转/改写式循环；正常 agent 每分钟都在调工具）→ outcome='stalled'。
 *    兜底关系：复读判定放宽后，edit 后陷入死循环的漏网场景由 C（长时间无工具调用）兜住。
 *
 * 中止方式：run.dispose() → run.result 结算。outcome 命名刻意避开 isUnretryable 的
 * /token|context|limit/ 正则；只有 'degenerated' 享受干净重试豁免（runner.withRetry）。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { GUARD_NO_TOOL_MS, GUARD_POLL_MS, GUARD_REPEAT_LIMIT, GUARD_SILENCE_MS, GUARD_WINDOW_SIZE } from '../constants.ts'
import { t, type HostLocale } from '../locales.ts'
import { runtime } from './context.ts'
import { runLocaleOf } from './locale.ts'
import type { Journal, SubagentRunLike } from '../types.ts'
import type { JournalStage } from '../../store.ts'

/** 进展工具（复读状态判定）：变更类写操作 + 脚本执行。
 * 「有进展」= 大文件 read-edit 循环（dev）或只读分析任务的 read+跑脚本循环（QA/验收）均属正常模式；
 * 纯 read 循环（反复整读同一文件却无变更/无脚本执行）= 真退化。实锤 run tf-mte906e9：QA 重跑
 * 只读分析（不 edit）→ 旧判定「零变更进展」误杀，第 2 次 provider error 后 450k 熔断。 */
const PROGRESS_TOOLS = /^(edit|write|create|apply_patch|patch|remove|delete|rm|mkdir|move|rename|append|bash|pwsh|shell|powershell)$/i

/** Agent 活动守卫（2026-09-06 实锤 r1）：QA 子代理正常干活却被判「10 分钟无事件」——
 * 事件视图可能失明（session.events 缓存快照不增长）。若 agent 仍非 idle（phase 在跑）
 * 且本会话动过手（lastMutationAt>0）→ 不是挂死，跳过本次判定（不中止）。
 * 纯启动静默挂死（未动手）不受影响——照常 B 触发。 */
function isAgentBusy(run: { localAgent?: unknown } | null | undefined): boolean {
  try {
    const agent = run && (run as { localAgent?: { phase?: { kind?: string } } }).localAgent
    const kind = agent && agent.phase && agent.phase.kind
    return !!kind && kind !== 'idle'
  } catch (e) { return false }
}

/** 与 metering 同款事件访问器（session.events 可能是数组或返回数组的函数）。
 * 2026-09-06 多源回退（实锤 json-parse r1：QA 子代理正常干活 254 事件 43 step 却被判「10 分钟
 * 无任何新事件」——session.events 缓存快照视图对某些子代理不增长）。回退链：
 * events（快照 getter）→ snapshotEvents()（宿主官方 API）→ ownEvents()（fork 后事件）——
 * 取信息最多（最长）的源；全部失效返回 []（stalled 触发前会记录诊断，见 fire()）。 */
function eventsOf(run: { localAgent?: { session?: unknown } } | null | undefined): unknown[] {
  try {
    const local = run && (run as { localAgent?: { session?: unknown } }).localAgent
    const session = (local && local.session) as { events?: unknown; snapshotEvents?: () => unknown; ownEvents?: () => unknown } | null | undefined
    if (!session) return []
    const candidates: unknown[] = []
    try {
      const raw = (session as { events?: unknown }).events
      if (Array.isArray(raw)) candidates.push(raw)
      else if (typeof raw === 'function') candidates.push((raw as () => unknown)())
    } catch (e) { /* 快照 getter 异常——降级下一源 */ }
    try {
      if (typeof session.snapshotEvents === 'function') candidates.push(session.snapshotEvents())
    } catch (e) { /* 忽略 */ }
    try {
      if (typeof session.ownEvents === 'function') candidates.push(session.ownEvents())
    } catch (e) { /* 忽略 */ }
    const valid = candidates.filter((c) => Array.isArray(c)) as unknown[][]
    if (valid.length === 0) return []
    // 信息最多优先：最长视图（失明的缓存快照长度 < 真实日志）
    valid.sort((a, b) => b.length - a.length)
    return valid[0]
  } catch (e) { return [] }
}

/** 规范化文本片段：小写 + 仅保留字母数字/CJK，供逐字重复比对。 */
function normalizeFragment(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '')
}

/**
 * 官方 `subagentTiming` 投影读数（挂死检测首选源，2026-09-10 改）。
 * 形状 `{settledMs, active?:{since, through}}`——`through` 是该投影 cut 上**最新事件时间**，
 * 由宿主在已提交事件上折叠，不受 session.events 快照失明影响（r1 QA 误判根因）。
 * 返回 null = 投影不可用（未挂载 / 该子代理无 descriptor）→ 回退事件数增长启发式。
 */
function timingOf(run: SubagentRunLike | null | undefined): { activeThrough: number | undefined } | null {
  try {
    const projections = runtime.sessionProjections as { stateOf?: (s: unknown, k: string) => unknown } | undefined
    if (!projections || typeof projections.stateOf !== 'function') return null
    const local = run && (run as { localAgent?: { session?: unknown } }).localAgent
    const session = local && local.session
    if (!session) return null
    const timing = projections.stateOf(session, 'subagentTiming') as { active?: { through?: unknown } } | null | undefined
    if (!timing || typeof timing !== 'object') return null
    const through = timing.active && timing.active.through
    return { activeThrough: typeof through === 'number' && Number.isFinite(through) ? through : undefined }
  } catch (e) { return null }
}

/** 观测→执行闭环：向运行中的子代理注入轻提醒（不打断，下一 step 可见）。
 *
 * 通道（2026-09-10 改）：`run.localAgent.inject()` —— 宿主官方 Agent 通道。next-step 队列由
 * agent loop 在 `preStep` 内、tool/result 之后整批认领，因此**不存在**「插进
 * assistant(tool_calls) → tool/result 之间触发 provider 400」的窗口；旧实现「先入队
 * `__teamflowPending`、观察到 step/end 再 session.append」的时序状态机整体删除。
 * （旧注释「subagents.start 句柄无 inject」是错的：`run.localAgent` 是活 Agent，
 * 有 `inject/steer/followup` —— `packages/core/agent/src/runtime-types.ts`。）
 *
 * 语义：`inject` 是 best-effort（可能晚一个 step），且不唤醒 idle driver——提醒只用于
 * 「仍在跑的 agent」；退化中止仍走 fire()/dispose()，不改为 steer 纠偏（后者是独立课题）。 */
function injectReminder(run: SubagentRunLike, text: string, locale: HostLocale): void {
  try {
    const agent = run && (run as { localAgent?: { inject?: (m: unknown) => void } }).localAgent
    if (!agent || typeof agent.inject !== 'function') return
    agent.inject(createUserMessage({
      content: [{ type: 'text', text }],
      // form:'notice' 必须带 summary（宿主 ContextFormed 判别式要求一行说明）
      source: { kind: 'plugin', plugin: 'dsh-plugin-teamflow', form: 'notice', summary: t(locale, 'guard.noticeSummary') },
    }))
  } catch (e) { /* 注入失败静默 */ }
}

export interface StageGuardTarget {
  run: SubagentRunLike
  journal: Journal
  label: string
  stage: JournalStage
}

/**
 * 启动单调用护栏轮询，返回取消函数（runAgent finally 必须调用）。
 * 触发时：stage.guardReason/guardOutcome 记录原因 + journal 落日志 + dispose 中止本次尝试。
 */
export function startStageGuard(opts: StageGuardTarget): () => void {
  const { run, journal, label, stage } = opts
  // 护栏文案随 run 语言快照（AC-3③④）：journal 在作用域内，无需新增传参链路
  const locale = runLocaleOf(journal)
  let fired = false
  // B/C 用计数而非时间戳判断（规避事件对象时间格式差异）
  let lastEventCount = -1
  let lastGrowthAt = Date.now()
  let lastToolSignalAt = Date.now()
  let seenToolCall = false
  const window: string[] = []
  // token 观测（ADR 复盘 2026-08-25）：只记 warning 不中止——重复读 / 验证脚本循环
  let processed = 0
  const readCounts = new Map<string, number>()
  const warnedReads = new Set<string>()
  const scriptCounts = new Map<string, number>()
  const warnedScripts = new Set<string>()
  // 进展信号（复读状态判定）：出现过变更写操作或脚本执行 = 会话有实际产出能力。
  // 初始 0 表示「尚未动手」——读文件读到复读仍未 edit/跑脚本 = 真退化；动手过之后只读不写再久也是正常模式。
  let lastMutationAt = 0
  let repeatWarned = false
  let busyWarned = false

  function warnOnce(key: string, set: Set<string>, message: string, hint?: string) {
    if (set.has(key)) return
    set.add(key)
    try { journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} ${t(locale, 'guard.observeTag')} ${message}` }) } catch (e) { /* ignore */ }
    // 观测→执行闭环：轻提醒直接经官方 Agent 通道 inject（不打断；协议安全边界由宿主保证）。
    // 只提醒不强制——重复读常是写断言的合理需求。
    if (hint) injectReminder(run, `[TOKEN GUARD · reminder] ${hint}`, locale)
  }

  function fire(reason: string, outcome: 'degenerated' | 'stalled') {
    if (fired) return
    fired = true
    clearInterval(timer)
    stage.guardReason = reason
    stage.guardOutcome = outcome
    // 挂死诊断（2026-09-06 实锤 r1：QA 正常干活被判「10 分钟无事件」——记录判定依据；
    // 2026-09-10 起首选源是 subagentTiming 投影，只有回退路径才读旧事件源视图长度）
    if (outcome === 'stalled') {
      try {
        const timing = timingOf(run)
        let detail: string
        if (timing) {
          detail = t(locale, 'guard.diagTiming', { through: timing.activeThrough === undefined ? t(locale, 'guard.diagNoTurn') : timing.activeThrough })
        } else {
          const local = (run as { localAgent?: { session?: { events?: unknown; snapshotEvents?: () => unknown; ownEvents?: () => unknown } } }).localAgent
          const session = local && local.session
          const lens: string[] = []
          if (session) {
            try { const r = session.events; lens.push(`events=${Array.isArray(r) ? r.length : typeof r === 'function' ? (r() as unknown[]).length : '?'}`) } catch (e) { lens.push('events=err') }
            try { lens.push(`snap=${typeof session.snapshotEvents === 'function' ? (session.snapshotEvents() as unknown[]).length : '-'}`) } catch (e) { lens.push('snap=err') }
            try { lens.push(`own=${typeof session.ownEvents === 'function' ? (session.ownEvents() as unknown[]).length : '-'}`) } catch (e) { lens.push('own=err') }
          }
          detail = t(locale, 'guard.diagFallback', { detail: lens.join(' / ') || t(locale, 'guard.noSession') })
        }
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'guard.stallDiag', { label, detail }) })
      } catch (e) { /* 诊断失败不影响中止 */ }
    }
    try {
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'guard.fire', { label, outcome, reason }) })
    } catch (e) { /* ignore */ }
    try { void Promise.resolve(run.dispose()).catch(() => {}) } catch (e) { /* ignore */ }
  }

  const timer = setInterval(() => {
    if (fired || journal.cancelled) return
    try {
      const events = eventsOf(run)

      // A. 复读检测 + token 观测 + 提醒注入：共用一次增量（只处理新事件，processed 单一指针）。
      // ⚠️ 必须增量收集（实锤 tf-mtcomxpq 开发两次「恰好 12 次」压线）：轮询每 15s 把 events.slice(-400)
      // 重新收集（window 不清空），同一片段被重复计数（实际 4 次 × 3 轮轮询 = 12）——调研型推理
      // （正常引用同一代码 3-4 次）被误杀为退化。
      if (events.length > processed) {
        const newEvents = events.slice(processed)
        for (const ev of newEvents) {
          const e = ev as { type?: string; data?: { texts?: unknown; chunk?: { type?: string; text?: string } } | null; texts?: unknown } | null
          if (!e) continue
          let streamText: string | null = null
          if (e.type === 'text-chunks' || e.type === 'reasoning-chunks') {
            const arr = (e.data && e.data.texts) || e.texts
            if (Array.isArray(arr)) streamText = arr.map(String).join('')
          } else if (e.type === 'assistant/chunk') {
            const chunk = (e.data && e.data.chunk) || null
            if (chunk && (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && typeof chunk.text === 'string') {
              streamText = chunk.text
            }
          }
          if (streamText !== null && streamText.length > 0) {
            const s = normalizeFragment(streamText)
            if (s.length >= 12) window.push(s)
            // 文本在流出 → 会话仍活着
            lastGrowthAt = Date.now()
          }
        }
        if (window.length > GUARD_WINDOW_SIZE) window.splice(0, window.length - GUARD_WINDOW_SIZE)
        const counts = new Map<string, number>()
        for (const w of window) counts.set(w, (counts.get(w) || 0) + 1)
        for (const [, n] of counts) {
          if (n >= GUARD_REPEAT_LIMIT) {
            // 状态判定（实锤 run tf-mte906e9）：大文件 read-edit 循环 = 正常模式——模型反复 read 同一文件、
            // 输出高度相似的读后分析，逐字片段可在 400 条窗口内累积 ≥12 次。此类循环伴随 edit/write 变更
            // 调用（有实际进展），不应中止；只有「复读 + 窗口内零变更调用」（纯推理打转，还没动手或已无产出）
            // 才是真退化。edit 后陷入死循环的漏网场景由 C 空转检测（长时间无工具调用）兜底。
            if (lastMutationAt > 0) {
              if (!repeatWarned) {
                repeatWarned = true
                try { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'guard.repeatProgress', { label }) }) } catch (e) { /* ignore */ }
              }
            } else {
              fire(t(locale, 'guard.reasonRepeat', { window: window.length, n }), 'degenerated')
              return
            }
          }
        }
        // token 观测（只记 warning）：增量处理新完成的工具调用
        observeToolCalls(newEvents)
        processed = events.length
      }

      // 工具活动信号（空转检测 C 依赖）：每次轮询扫描最近 200 条事件；同时提取变更类写操作
      // （edit/write/create/patch 等——复读状态判定依赖：有过写操作 = 会话有产出能力）
      for (const ev of events.slice(-200)) {
        const e = ev as { type?: string; data?: { name?: string } } | null
        if (!e) continue
        if (e.type === 'tool-call-chunks' || e.type === 'tool/call') {
          seenToolCall = true; lastToolSignalAt = Date.now()
          const d = e.data || (e as unknown as { name?: string })
          if (d && typeof d.name === 'string' && PROGRESS_TOOLS.test(d.name)) lastMutationAt = Date.now()
          break
        }
      }

      // B. 挂死检测（2026-09-10 改）：首选官方 subagentTiming 投影的 active.through
      // （已提交事件时间，权威且不受视图失明影响）；投影不可用才回退事件数增长启发式。
      const timing = timingOf(run)
      if (timing) {
        if (timing.activeThrough === undefined) {
          // 无 open turn（尚未开跑 / 该 turn 已收尾）——不判挂死，保持窗口新鲜
          lastGrowthAt = Date.now()
        } else if (Date.now() - timing.activeThrough > GUARD_SILENCE_MS) {
          // 长时间无已提交事件。长工具静默执行（跑十几分钟测试无输出）仍由活动守卫豁免：
          // agent 非 idle 且本会话动过手 → 不是挂死，记一次诊断并给新窗口。
          if (lastMutationAt > 0 && isAgentBusy(run)) {
            if (!busyWarned) {
              busyWarned = true
              try { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'guard.busyTiming', { label, seconds: Math.round((Date.now() - timing.activeThrough) / 1000) }) }) } catch (e) { /* ignore */ }
            }
            lastGrowthAt = Date.now()
          } else {
            fire(t(locale, 'guard.reasonStallTiming', { minutes: Math.round(GUARD_SILENCE_MS / 60000) }), 'stalled')
            return
          }
        } else {
          lastGrowthAt = Date.now()
        }
      } else if (events.length !== lastEventCount) {
        lastEventCount = events.length
        lastGrowthAt = Date.now()
      } else if (Date.now() - lastGrowthAt > GUARD_SILENCE_MS) {
        // 回退路径（投影不可用）：沿用旧启发式 + agent 活动守卫（实锤 r1：QA 正常干活 254 事件
        // 却被判「10 分钟无事件」——事件视图失明）。agent 仍非 idle 且本会话动过手 → 视为视图
        // 失明而非挂死：记一次诊断并给新窗口，不中止（纯启动静默挂死不受影响）。
        if (lastMutationAt > 0 && isAgentBusy(run)) {
          if (!busyWarned) {
            busyWarned = true
            try { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'guard.busyEvents', { label }) }) } catch (e) { /* ignore */ }
          }
          lastGrowthAt = Date.now()
        } else {
          fire(t(locale, 'guard.reasonStallEvents', { minutes: Math.round(GUARD_SILENCE_MS / 60000) }), 'stalled')
          return
        }
      }

      // C. 空转检测：事件仍在增长但长期没有工具调用（正常 agent 每分钟都在调工具；
      //    纯推理打转/改写式循环只会持续吐文本）。要求已见过至少一次工具调用，
      //    排除「启动阶段长推理」的误伤。
      if (seenToolCall && Date.now() - lastToolSignalAt > GUARD_NO_TOOL_MS) {
        fire(t(locale, 'guard.reasonIdle', { minutes: Math.round(GUARD_NO_TOOL_MS / 60000) }), 'stalled')
        return
      }
    } catch (e) { /* 护栏自身异常不影响流水线 */ }
  }, GUARD_POLL_MS)

  /** token 观测：增量处理已完成工具调用（tool/call 事件带完整参数）。 */
  function observeToolCalls(events: unknown[]) {
    for (const ev of events) {
      const e = ev as { type?: string; data?: { name?: string; arguments?: string } } | null
      if (!e || (e.type !== 'tool/call' && e.type !== 'tool-call')) continue
      const d = (e as { data?: { name?: string; arguments?: string } }).data || (e as unknown as { name?: string; arguments?: string })
      const name = d && d.name
      const args = (d && d.arguments) || ''
      if (name === 'read') {
        const m = String(args).match(/"file_path"\s*:\s*"([^"]+)"/)
        if (!m) continue
        const key = m[1].replace(/\\\\/g, '\\').toLowerCase()
        const n = (readCounts.get(key) || 0) + 1
        readCounts.set(key, n)
        if (n === 3) warnOnce(key, warnedReads, t(locale, 'guard.repeatRead', { n, file: m[1].split(/[\\/]/).pop() }), t(locale, 'guard.reminderRead', { file: m[1].split(/[\\/]/).pop() }))
      } else if (/bash|pwsh|shell|powershell/i.test(name || '')) {
        const sm = String(args).match(/(verify-[a-z0-9-]+\.cjs|assembly-check\.cjs|qa-e2e-jsdom\.cjs)/)
        if (!sm) continue
        const key = sm[1]
        const n = (scriptCounts.get(key) || 0) + 1
        scriptCounts.set(key, n)
        if (n === 3) warnOnce(key, warnedScripts, t(locale, 'guard.repeatScript', { n, file: key }), t(locale, 'guard.reminderScript', { file: key }))
      }
    }
  }

  return () => { fired = true; clearInterval(timer) }
}
