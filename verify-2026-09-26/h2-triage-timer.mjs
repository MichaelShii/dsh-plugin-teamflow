/**
 * 验证 ②：triage 的 Promise.race 超时定时器是否「结算即清」。
 * A/B：COPY=pre / post。做法：包住全局 setTimeout/clearTimeout 记账，
 * 跑真实 runTriage（stub 子代理），结算后检查 240000ms 定时器是否仍挂着。
 * 脚本**不调用 process.exit** —— 若仍有悬挂定时器，进程会被它吊住不退出（宿主常驻进程里就是常驻 timer）。
 */
const COPY = ['pre', 'head', 'post'].includes(process.env.COPY) ? process.env.COPY : 'post'
const T = process.env.T
const base = `${T}/${COPY}`
process.env.DSH_HOME = `${T}/home-h2-${COPY}`

const created = []
const origSet = globalThis.setTimeout
const origClear = globalThis.clearTimeout
globalThis.setTimeout = function (fn, ms, ...args) {
  const h = origSet(fn, ms, ...args)
  created.push({ h, ms, cleared: false })
  return h
}
globalThis.clearTimeout = function (h) {
  const e = created.find((x) => x.h === h)
  if (e) e.cleared = true
  return origClear(h)
}

const { setRuntime } = await import(`file:///${base}/host/core/context.ts`)
const { runTriage, TRIAGE_TIMEOUT_MS } = await import(`file:///${base}/host/core/triage.ts`)

const VERDICT = JSON.stringify({
  mode: 'medium', kind: 'feature', intent: 'requirement', complexity: 'medium', confidence: 'high',
  slug: 'verify-timer', blockers: [], needDesign: false, artifact: 'other', installable: false, host: 'dsh',
})

const runLog = []
let call = 0
async function stubStart(_p, init) {
  const n = ++call
  const rec = { n, label: init && init.label, disposed: 0, settled: false }
  runLog.push(rec)
  // 第 1 次运行：直接给合法 verdict；第 2 次运行（attempt 场景）：第 1 次尝试给非 JSON，第 2 次给合法 JSON
  const body = (process.env.SCENARIO === 'retry' && n === 1) ? 'Let me output the JSON.' : VERDICT
  return {
    id: `triage-child-${n}`,
    result: (async () => { await new Promise((r) => setImmediate(r)); rec.settled = true; return { output: [{ type: 'text', text: body }], stopReason: 'completed' } })(),
    dispose: async () => { rec.disposed += 1 },
  }
}
setRuntime({}, { start: stubStart })

const verdict = await runTriage('给插件加一个导出按钮', {}, {}, undefined, 'zh')

const timer240 = created.filter((x) => x.ms === TRIAGE_TIMEOUT_MS)
const pendingAny = created.filter((x) => !x.cleared)
console.log(JSON.stringify({
  copy: COPY,
  scenario: process.env.SCENARIO || 'ok',
  verdictSource: verdict.source,
  verdictMode: verdict.mode,
  triageSubagentCalls: runLog.length,
  triageSubagentsDisposed: runLog.map((r) => r.disposed),
  timersCreated: created.length,
  timersWithDelay240s: timer240.length,
  timersWithDelay240sCleared: timer240.filter((x) => x.cleared).length,
  anyPendingTimers: pendingAny.length,
  pendingDelays: pendingAny.map((x) => x.ms),
  TRIAGE_TIMEOUT_MS,
}, null, 2))
console.log('PROCESS_WILL_NOW_EXIT_IF_NO_PENDING_TIMER')
