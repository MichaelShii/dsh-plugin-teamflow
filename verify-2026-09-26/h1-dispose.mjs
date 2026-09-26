/**
 * 验证 ①：正常结算路径子代理是否被 dispose（对齐宿主 settleRun 契约）。
 * A/B：COPY=pre（b49b1ac~1，修复前源码）vs COPY=post（b49b1ac，修复后源码）。
 * 全部走真实 runAgent（含 finally 结算、guard 启动、inFlight 追踪）。
 */
const COPY = ['pre', 'head', 'post'].includes(process.env.COPY) ? process.env.COPY : 'post'
const T = process.env.T
const base = `${T}/${COPY}`
process.env.DSH_HOME = `${T}/home-h1-${COPY}`

const { setRuntime, runs, inFlight } = await import(`file:///${base}/host/core/context.ts`)
const { runAgent } = await import(`file:///${base}/host/core/runner.ts`)

const LONG = '## 产出\n' + '本阶段按契约完成既定工作，逐条对应验收条件并给出实测数据。'.repeat(12) +
  '\n\n[Verification evidence]\n- 命令：node test/smoke.js\n- 退出码：0\n- 断言计数：26 passed\n'
const SHORT = '太短了。'

const children = []
let failNext = false
async function stubStart(_provider, init) {
  const rec = { id: `child-${children.length + 1}`, label: init && init.label, disposed: 0, disposedAfterSettle: false, settled: false, disposeTimed: null }
  children.push(rec)
  const text = failNext ? SHORT : LONG
  failNext = false
  return {
    id: rec.id,
    localAgent: { session: null },
    result: (async () => {
      await new Promise((r) => setImmediate(r))
      rec.settled = true
      return { stopReason: 'completed', output: [{ type: 'text', text }] }
    })(),
    dispose: async () => { rec.disposed += 1; if (rec.settled) rec.disposedAfterSettle = true },
  }
}
setRuntime({}, { start: stubStart })

const journal = {
  id: 'tf-h1-verify', name: 'teamflow-pipeline', status: 'running',
  requirement: '验证 dispose 契约', workspace: 'ws-h1', workspacePath: null, locale: 'zh',
  startedAt: Date.now(), endedAt: null, agentsStarted: 0, stages: [], logs: [],
  cancelled: false, humanIntervention: false,
}

const results = []
for (const [label, phase] of [['产品经理', 'prd'], ['开发工程师', 'dev'], ['QA 测试工程师', 'qa'], ['验收', 'acceptance']]) {
  const before = children.length
  const text = await runAgent(journal, {}, label, phase, 'prompt', null)
  const rec = children[before]
  const inflightLeft = (inFlight.get(journal.id) || new Map()).size
  results.push({
    phase, label,
    stageStatus: journal.stages[journal.stages.length - 1].status,
    runAgentReturnedText: !!text,
    childDisposed: rec.disposed,
    disposedAfterResultSettled: rec.disposedAfterSettle,
    inFlightEntriesForRun: inflightLeft,
  })
}

// 失败结算路径（短产出 → stage failed）也必须 dispose
failNext = true
const before = children.length
await runAgent(journal, {}, '开发工程师', 'dev', 'prompt', null)
const rec = children[before]
results.push({
  phase: 'dev(failed-verdict)',
  stageStatus: journal.stages[journal.stages.length - 1].status,
  childDisposed: rec.disposed,
  disposedAfterResultSettled: rec.disposedAfterSettle,
  inFlightEntriesForRun: (inFlight.get(journal.id) || new Map()).size,
})

console.log(JSON.stringify({ copy: COPY, results, childrenSpawned: children.length }, null, 2))
