/**
 * 验证 ③：run 终态后内存 runs 注册表被 pruneRuns 收缩到 ≤100 条，
 *         且被淘汰的更早 run 仍能经 getRun（磁盘回读）读回完整快照。
 *
 * 做法：真实 executePipeline（patch 档 = prd + dev 两阶段，stub 子代理）跑一次小型 run；
 * 跑前先把 120 条历史终态 journal 同时灌进内存 runs（模拟宿主启动 loadJournals 全量灌入）与磁盘。
 */
const COPY = process.env.COPY || 'head'
const T = process.env.T
const base = `${T}/${COPY}`
const HOME = `${T}/home-h3-${COPY}`
const WORK = `${T}/work-h3-${COPY}`
process.env.DSH_HOME = HOME

const { mkdirSync, existsSync } = await import('node:fs')
mkdirSync(WORK, { recursive: true })

const ctx = await import(`file:///${base}/host/core/context.ts`)
const store = await import(`file:///${base}/store.ts`)
const { executePipeline } = await import(`file:///${base}/host/core/pipeline.ts`)
const { RUNS_MEMORY_KEEP } = await import(`file:///${base}/host/constants.ts`)
const { runs, setRuntime, activeProducts, inFlight } = ctx
const getRun = ctx.getRun || ((id) => runs.get(id) || null) // pre 副本无 getRun（修复前无磁盘回读入口）
const hasGetRun = typeof ctx.getRun === 'function'

/* ── 1) 灌入 120 条历史终态 run（内存 + 磁盘） ── */
const SEED = 120
const seeded = []
for (let i = 0; i < SEED; i++) {
  const j = {
    id: `tf-seed-${String(i).padStart(3, '0')}`,
    name: 'teamflow-pipeline', status: 'completed',
    requirement: `历史 run #${i}`, workspace: 'ws-h3', workspacePath: WORK, locale: 'zh',
    startedAt: 1000 + i, endedAt: 1000 + i, agentsStarted: 1, agentsFinished: 1,
    stages: [{ seq: 1, label: 'L', phase: 'prd', status: 'done', outcome: 'completed', output: `seed-${i}-payload`, startedAt: 1, endedAt: 2 }],
    logs: [], result: null, error: null, cancelled: false, humanIntervention: false,
    interrupted: false, interruptedAt: null, supersededBy: null,
  }
  seeded.push(j)
  runs.set(j.id, j)
  store.persistJournal(j)
}
const before = { runsSize: runs.size, oldestSeededInMemory: runs.has(seeded[0].id) }

/* ── 2) 真实跑一条小型 run（patch 档：prd + dev） ── */
const children = []
async function stubStart(_p, init) {
  const rec = { id: `c-${children.length + 1}`, label: init && init.label, disposed: 0, settled: false }
  children.push(rec)
  const text = '## 阶段产出\n' + '本阶段已按契约完成，逐条对应验收条件并附实测数据。'.repeat(30) +
    '\n\n[Verification evidence]\n- 命令：node test/smoke.js\n- 退出码：0\n- 断言计数：26 passed\n'
  return {
    id: rec.id,
    localAgent: { session: null },
    result: (async () => { await new Promise((r) => setImmediate(r)); rec.settled = true; return { stopReason: 'completed', output: [{ type: 'text', text }] } })(),
    dispose: async () => { rec.disposed += 1 },
  }
}
setRuntime({}, { start: stubStart })

const runId = `tf-verify-prune-${COPY}`
const journal = {
  id: runId, name: 'teamflow-pipeline', status: 'running',
  requirement: '验证 runs 注册表有界化', workspace: 'ws-h3', workspacePath: WORK,
  ownerSession: 'sid-verify', locale: 'zh',
  product: null, startedAt: null, endedAt: null, agentsStarted: 0,
  stages: [], logs: [], result: null, error: null, cancelled: false, humanIntervention: false,
  interrupted: false, interruptedAt: null, supersededBy: null,
}
const options = {
  mode: 'patch', needDesign: false, needScaffold: false, lite: false,
  tasks: [], productRoot: null, maxConcurrency: null,
  branchPolicy: 'keep', preAction: 'keep-nogit',
}
const parent = {
  session: { id: 'sid-verify', header: { cwd: WORK }, append() {} },
  status: 'idle', followup() {}, inject() {}, options: {},
}
runs.set(runId, journal)

let err = null
try {
  await executePipeline(journal, parent, journal.requirement, options, undefined, null)
} catch (e) { err = String((e && e.message) || e) }

const after = {
  runStatus: journal.status,
  runError: journal.error || null,
  thrown: err,
  stages: journal.stages.map((s) => ({ phase: s.phase, status: s.status, outcome: s.outcome })),
  childSubagentsDisposed: children.map((c) => c.disposed),
  runsSize: runs.size,
  runsMemoryKeep: RUNS_MEMORY_KEEP,
  activeProductsSize: activeProducts.size,
  inFlightSize: inFlight.size,
  newRunStillInMemory: runs.has(runId),
  seededStillInMemory: seeded.filter((j) => runs.has(j.id)).length,
  seededEvicted: seeded.filter((j) => !runs.has(j.id)).length,
  evictedIdsSample: seeded.filter((j) => !runs.has(j.id)).slice(0, 3).map((j) => j.id),
}

/* ── 3) 被淘汰的最早 run 仍能经 getRun 读回完整内容（快照/详情路径） ── */
const oldest = seeded[0]
const back = getRun(oldest.id)
const readback = { hasGetRunInSource: hasGetRun,
  oldestId: oldest.id,
  inMemory: runs.has(oldest.id),
  getRunReturns: !!back,
  getRunId: back && back.id,
  getRunStatus: back && back.status,
  getRunStagePayload: back && back.stages && back.stages[0] && back.stages[0].output,
  getRunDidNotRefillMemory: !runs.has(oldest.id),
  loadJournalByIdDirect: typeof store.loadJournalById === 'function' ? !!store.loadJournalById(oldest.id) : 'n/a(修复前无此函数)',
  runsSizeAfterReadback: runs.size,
}
/* 最新一条（刚跑完的 run）也在内存里，磁盘同步落盘 */
const newest = getRun(runId)

console.log(JSON.stringify({ copy: COPY, before, after, readback, newestRunFromGetRun: { id: newest && newest.id, status: newest && newest.status, endedAt: !!(newest && newest.endedAt) }, logTail: journal.logs.slice(-6).map((l) => `${l.level}: ${l.message}`) }, null, 2))
