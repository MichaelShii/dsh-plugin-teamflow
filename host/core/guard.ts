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
 *  B. 挂死检测：连续 GUARD_SILENCE_MS 一个新事件都没有（provider 层挂起/连接静默死亡）
 *     → outcome='stalled'（走正常预算门 → 熔断转人工，不自动重试烧钱）。
 *  C. 空转检测：会话仍在产出事件，但连续 GUARD_NO_TOOL_MS 没有任何工具调用
 *    （纯推理打转/改写式循环；正常 agent 每分钟都在调工具）→ outcome='stalled'。
 *    兜底关系：复读判定放宽后，edit 后陷入死循环的漏网场景由 C（长时间无工具调用）兜住。
 *
 * 中止方式：run.dispose() → run.result 结算。outcome 命名刻意避开 isUnretryable 的
 * /token|context|limit/ 正则；只有 'degenerated' 享受干净重试豁免（runner.withRetry）。
 */
import { GUARD_NO_TOOL_MS, GUARD_POLL_MS, GUARD_REPEAT_LIMIT, GUARD_SILENCE_MS, GUARD_WINDOW_SIZE } from '../constants.ts'
import type { Journal, SubagentRunLike } from '../types.ts'
import type { JournalStage } from '../../store.ts'

/** 进展工具（复读状态判定）：变更类写操作 + 脚本执行。
 * 「有进展」= 大文件 read-edit 循环（dev）或只读分析任务的 read+跑脚本循环（QA/验收）均属正常模式；
 * 纯 read 循环（反复整读同一文件却无变更/无脚本执行）= 真退化。实锤 run tf-mte906e9：QA 重跑
 * 只读分析（不 edit）→ 旧判定「零变更进展」误杀，第 2 次 provider error 后 450k 熔断。 */
const PROGRESS_TOOLS = /^(edit|write|create|apply_patch|patch|remove|delete|rm|mkdir|move|rename|append|bash|pwsh|shell|powershell)$/i

/** 与 metering 同款事件访问器（session.events 可能是数组或返回数组的函数）。 */
function eventsOf(run: { localAgent?: { session?: unknown } } | null | undefined): unknown[] {
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

/** 观测→执行闭环：向运行中的子代理注入轻提醒（不打断，下一轮 step 可见）。
 * 通道：subagents.start 句柄无 inject——用 DSH 官方 session.append('user/message')（in-process driver 同款用法）。
 * ⚠️ 安全窗口（实锤 tf-mtcnejqj）：绝不能插在 assistant(tool_calls) → tool/result 之间——
 * provider 校验「tool 消息必须响应前序 tool_calls」，插入 user 消息会 400 invalid_request_error。
 * 因此只入队（pendingInjects），在观察到 step/end（该 step 的 tool/result 已写入）后统一 flush。 */
function injectReminder(run: SubagentRunLike, text: string): void {
  const queue = (run as unknown as { __teamflowPending?: string[] })
  try {
    if (!Array.isArray(queue.__teamflowPending)) (queue as { __teamflowPending: string[] }).__teamflowPending = []
    ;(queue as { __teamflowPending: string[] }).__teamflowPending.push(text)
  } catch (e) { /* 入队失败静默 */ }
}

function flushReminders(run: SubagentRunLike): void {
  try {
    const queue = (run as unknown as { __teamflowPending?: string[] }).__teamflowPending
    if (!queue || queue.length === 0) return
    const local = run.localAgent as { session?: { append?: (type: string, payload: unknown, opts?: { surfaceOp?: string }) => void } } | null | undefined
    if (!local || typeof local.session?.append !== 'function') return
    for (const text of queue.splice(0)) {
      local.session.append('user/message', {
        id: crypto.randomUUID(),
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'teamflow' },
      }, { surfaceOp: 'append' })
    }
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

  function warnOnce(key: string, set: Set<string>, message: string, hint?: string) {
    if (set.has(key)) return
    set.add(key)
    try { journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} [token 观测] ${message}` }) } catch (e) { /* ignore */ }
    // 观测→执行闭环：轻提醒入队（不打断；安全窗口=step/end 后 flush，避免插进 tool_calls→tool/result 序列）。
    // 只提醒不强制——重复读常是写断言的合理需求。
    if (hint) injectReminder(run, `[TOKEN GUARD · reminder] ${hint}`)
  }

  function fire(reason: string, outcome: 'degenerated' | 'stalled') {
    if (fired) return
    fired = true
    clearInterval(timer)
    stage.guardReason = reason
    stage.guardOutcome = outcome
    try {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 触发进行中护栏并中止本次尝试（${outcome}）：${reason}` })
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
                try { journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 复读计数达阈值但检测到变更进展（read-edit 循环属正常模式），不中止；仅零变更进展的纯复读才中止` }) } catch (e) { /* ignore */ }
              }
            } else {
              fire(`推理复读（同一片段在近 ${window.length} 条流式片段中出现 ${n} 次，且窗口内零变更进展）`, 'degenerated')
              return
            }
          }
        }
        // token 观测（只记 warning）：增量处理新完成的工具调用
        observeToolCalls(newEvents)
        // 提醒注入安全窗口（实锤 tf-mtcnejqj）：step/end 出现 = 该 step 的 tool/result 已全部写入，
        // 此刻 flush user/message 不会插进 assistant(tool_calls)→tool/result 序列（否则 provider 400）。
        if (newEvents.some((ev) => (ev as { type?: string })?.type === 'step/end')) flushReminders(run)
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

      // B. 挂死检测：事件数完全不增长超过 GUARD_SILENCE_MS（provider 挂起/静默死亡）
      if (events.length !== lastEventCount) {
        lastEventCount = events.length
        lastGrowthAt = Date.now()
      } else if (Date.now() - lastGrowthAt > GUARD_SILENCE_MS) {
        fire(`挂死（${Math.round(GUARD_SILENCE_MS / 60000)} 分钟无任何新事件）`, 'stalled')
        return
      }

      // C. 空转检测：事件仍在增长但长期没有工具调用（正常 agent 每分钟都在调工具；
      //    纯推理打转/改写式循环只会持续吐文本）。要求已见过至少一次工具调用，
      //    排除「启动阶段长推理」的误伤。
      if (seenToolCall && Date.now() - lastToolSignalAt > GUARD_NO_TOOL_MS) {
        fire(`空转（${Math.round(GUARD_NO_TOOL_MS / 60000)} 分钟内无任何工具调用，但会话仍在产出）`, 'stalled')
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
        if (n === 3) warnOnce(key, warnedReads, `同一文件重复 read ${n} 次：${m[1].split(/[\\\\/]/).pop()}（TOKEN_HYGIENE 上限 1 次，多余读取在为后续每一步付 cache 重放费）`, `你已整读 ${m[1].split(/[\\\\/]/).pop()} 第 3 次（TOKEN_HYGIENE 上限 1 次）。停止整读：需要确认细节时用 grep 定位行号 + 限量片段读取。`)
      } else if (/bash|pwsh|shell|powershell/i.test(name || '')) {
        const sm = String(args).match(/(verify-[a-z0-9-]+\.cjs|assembly-check\.cjs|qa-e2e-jsdom\.cjs)/)
        if (!sm) continue
        const key = sm[1]
        const n = (scriptCounts.get(key) || 0) + 1
        scriptCounts.set(key, n)
        if (n === 3) warnOnce(key, warnedScripts, `验证脚本重复执行 ${n} 次：${key}（批量修复纪律：一次修完所有失败再跑，≤3 轮）`, `验证脚本 ${key} 已重复执行 3 次。遵守批量修复纪律：一次读完所有失败用例 → 一次全修 → 再跑一次；超出 3 轮请输出诊断摘要并停止。`)
      }
    }
  }

  return () => { fired = true; clearInterval(timer) }
}
