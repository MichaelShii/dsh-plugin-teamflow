/**
 * 验证 ④：loadJournalById 双路径（per-project + 全局 runs/）按 id 读回；resume 可续跑。
 *
 * 关键场景（commit 声称修掉的隐性缺口）：一个 **per-project** journal 不在内存中（模拟内存淘汰后 /
 * 进程重启后未回填），resume 还能不能读回并续跑？
 *   - pre（b49b1ac~1）：resumeRun 用 journalFile(id) 只查全局 runs/ → 读不到 → run.notFound
 *   - head（含 b49b1ac）：loadJournalById 双路径 → 读回 → 续跑
 */
const COPY = process.env.COPY || 'head'
const T = process.env.T
const base = `${T}/${COPY}`
const HOME = `${T}/home-h4-${COPY}`
const WORK = `${T}/work-h4-${COPY}`
process.env.DSH_HOME = HOME

const fs = await import('node:fs')
const path = await import('node:path')
fs.mkdirSync(WORK, { recursive: true })

const ctx = await import(`file:///${base}/host/core/context.ts`)
const store = await import(`file:///${base}/store.ts`)
const { resumeRun } = await import(`file:///${base}/host/core/pipeline.ts`)
const { runs, setRuntime, activeProducts, inFlight } = ctx
const hasLoadJournalById = typeof store.loadJournalById === 'function'

/* ── stub 子代理 ── */
const children = []
async function stubStart(_p, init) {
  const rec = { id: `c-${children.length + 1}`, label: init && init.label, disposed: 0 }
  children.push(rec)
  const text = '## 续跑产出\n' + 'dev 阶段已按断点续跑契约重跑并给出实测数据。'.repeat(20) +
    '\n\n[Verification evidence]\n- 命令：node test/smoke.js\n- 退出码：0\n- 断言计数：26 passed\n'
  return {
    id: rec.id, localAgent: { session: null },
    result: (async () => { await new Promise((r) => setImmediate(r)); return { stopReason: 'completed', output: [{ type: 'text', text }] } })(),
    dispose: async () => { rec.disposed += 1 },
  }
}
const agentStub = { session: { id: 'sid-h4', header: { cwd: WORK }, append() {} }, status: 'idle', followup() {}, inject() {}, options: {} }
setRuntime({ get: (sid) => (sid === 'sid-h4' ? agentStub : undefined) }, { start: stubStart })

/* ── A) per-project 路径：写 ≠ default 工作区 ── */
const projId = `tf-h4-proj-${COPY}`
const projJournal = {
  id: projId, name: 'teamflow-pipeline', status: 'failed',
  requirement: '验证 resume 读盘', workspace: 'ws-h4', workspacePath: WORK, ownerSession: 'sid-h4',
  locale: 'zh', options: { mode: 'patch', branchPolicy: 'keep', preAction: 'keep-nogit', tasks: [], needDesign: false, needScaffold: false, lite: false },
  product: null, startedAt: 1000, endedAt: 2000, agentsStarted: 1,
  stages: [
    { seq: 1, label: '单点确认', phase: 'prd', status: 'done', outcome: 'completed', output: 'prd payload from disk', startedAt: 1, endedAt: 2 },
    { seq: 2, label: '开发', phase: 'dev', status: 'failed', outcome: 'error', summary: '外部中断', output: 'partial', startedAt: 3, endedAt: 4 },
  ],
  logs: [], result: null, error: 'dev 中断', cancelled: false, humanIntervention: false,
  interrupted: false, interruptedAt: null, supersededBy: null,
}
store.persistJournal(projJournal) // workspace != default → per-project runs/
const projFile = path.join(HOME, 'teamflow', 'ws-h4', 'runs', `${projId}.json`)
const globalFile = path.join(HOME, 'teamflow', 'runs', `${projId}.json`)
const diskLayout = { perProjectFileExists: fs.existsSync(projFile), globalFileExists: fs.existsSync(globalFile) }

/* ── B) 全局兜底路径：workspace='default' ── */
const globId = `tf-h4-glob-${COPY}`
store.persistJournal({
  id: globId, name: 'teamflow-pipeline', status: 'completed', requirement: '全局路径',
  workspace: 'default', workspacePath: WORK, locale: 'zh', stages: [], logs: [], endedAt: 3000,
})
const globFile = path.join(HOME, 'teamflow', 'runs', `${globId}.json`)

const dualPath = {
  hasLoadJournalById,
  projReadBack: hasLoadJournalById ? (store.loadJournalById(projId) || {}).id : 'n/a(修复前无此函数)',
  projReadBackFromDiskStageOutput: hasLoadJournalById ? store.loadJournalById(projId).stages[0].output : null,
  globReadBack: hasLoadJournalById ? (store.loadJournalById(globId) || {}).id : 'n/a(修复前无此函数)',
  globalFileExists: fs.existsSync(globFile),
  injectionGuard: hasLoadJournalById ? store.loadJournalById('tf-../escape') : 'n/a',
  missingId: hasLoadJournalById ? store.loadJournalById('tf-h4-nope') : 'n/a',
}

/* ── C) resume：journal 只在磁盘（内存里没有），能否续跑 ── */
const inMemoryBefore = runs.has(projId)
const res = resumeRun(projId, 'sid-h4')

let afterResume = null
if (res.ok) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const j = runs.get(projId)
    if (j && j.status !== 'running') break
    await new Promise((r) => setTimeout(r, 100))
  }
  const j = runs.get(projId)
  afterResume = {
    status: j && j.status,
    endedAt: !!(j && j.endedAt),
    stages: (j && j.stages || []).map((s) => `${s.phase}:${s.status}`),
    childSubagentsDisposed: children.map((c) => c.disposed),
    inFlightSize: inFlight.size,
    activeProductsSize: activeProducts.size,
  }
}

console.log(JSON.stringify({
  copy: COPY, inMemoryBefore, diskLayout, dualPath,
  resumeResult: res,
  afterResume,
}, null, 2))
