/**
 * dsh-plugin-teamflow core — Backlog 数据层与状态机（$DSH_HOME/teamflow/<product>/backlog/*）。
 * 依赖：store.ts（原子读写）、context.ts（stores 缓存）。
 */
import { fileFor, readJson, writeJson, teamflowRoot, persistJournal } from '../../store.ts'
import type { BacklogItem } from '../types.ts'
import { stores } from './context.ts'
import { STATUS } from '../constants.ts'
import { clip, snippet } from '../util.ts'

export class BacklogStore {
  product: string
  fileReq: string
  fileTask: string
  fileBug: string
  requirements: BacklogItem[]
  tasks: BacklogItem[]
  bugs: BacklogItem[]

  constructor(product: string | null | undefined) {
    this.product = product || 'default'
    this.fileReq = fileFor(this.product, 'requirements.json')
    this.fileTask = fileFor(this.product, 'tasks.json')
    this.fileBug = fileFor(this.product, 'bugs.json')
    this.requirements = readJson(this.fileReq, [])
    this.tasks = readJson(this.fileTask, [])
    this.bugs = readJson(this.fileBug, [])
  }
  persist(): void {
    writeJson(this.fileReq, this.requirements)
    writeJson(this.fileTask, this.tasks)
    writeJson(this.fileBug, this.bugs)
  }
  nextId(prefix: string): string {
    const used = new Set()
    for (const r of this.requirements) used.add(r.id)
    for (const t of this.tasks) used.add(t.id)
    for (const b of this.bugs) used.add(b.id)
    let n = 1
    while (used.has(`${prefix}-${n}`)) n++
    return `${prefix}-${n}`
  }
  find(kind: string, id: string): BacklogItem | undefined {
    const list = kind === 'req' ? this.requirements : kind === 'task' ? this.tasks : this.bugs
    return list.find((x) => x.id === id)
  }
  pushEvent(item: BacklogItem, from: string | null, to: string, reason: string | null | undefined): void {
    item.status = to
    item.updatedAt = Date.now()
    item.events = item.events || []
    item.events.push({ at: Date.now(), by: 'teamflow', from, to, reason: reason || '' })
    if (item.events.length > 50) item.events = item.events.slice(-50)
    this.persist()
  }
}

/** 获取（并缓存）某产品的 BacklogStore。 */
export function storeFor(product: string | null | undefined): BacklogStore {
  const key = product || 'default'
  let s = stores.get(key) as BacklogStore | undefined
  if (!s) { s = new BacklogStore(key); stores.set(key, s) }
  return s
}

/** backlog 摘要视图（Remote/工具层展示用，含持久化落盘路径）。 */
export function backlogSummary(product: string | null | undefined) {
  const store = storeFor(product)
  return {
    product: product || null,
    persistence: {
      mode: 'fs',
      durable: true,
      root: teamflowRoot(),
      files: {
        requirements: store.fileReq,
        tasks: store.fileTask,
        bugs: store.fileBug,
      },
    },
    requirements: store.requirements.slice(-20).map((r) => ({ id: r.id, title: r.title, status: r.status, humanIntervention: !!r.humanIntervention, taskIds: (r.taskIds || []).slice(-20), bugIds: (r.bugIds || []).slice(-20), createdAt: r.createdAt, updatedAt: r.updatedAt })).reverse(),
    tasks: store.tasks.slice(-80).map((t) => ({
      id: t.id, type: t.type || 'task', title: t.title, status: t.status,
      reqId: t.reqId || null, bugId: t.bugId || null, owner: t.owner || null,
      devAssign: t.devAssign || null, qaAssign: t.qaAssign || null, acceptBy: t.acceptBy || null,
      retries: t.retries || 0, humanIntervention: !!t.humanIntervention,
      usage: t.usage || null, byRole: t.byRole || {},
      subtaskIds: t.subtaskIds || [],
      parentId: t.parentId || null,
      failed: !!t.failed, childId: t.childId || null,
      spec: t.spec || null,
      startedAt: t.startedAt || null, endedAt: t.endedAt || null, updatedAt: t.updatedAt || null,
      summary: t.summary || '',
    })).reverse(),
    bugs: store.bugs.slice(-30).map((b) => ({ id: b.id, reqId: b.reqId || null, severity: b.severity || null, title: b.title, status: b.status, owner: b.owner || null, retries: b.retries || 0, humanIntervention: !!b.humanIntervention, updatedAt: b.updatedAt })).reverse(),
  }
}

/** backlog 状态流转（校验目标状态合法性，合法的终态自动清 needs-human）。
 *  只做 status + humanIntervention，不碰 assign——assign 是独立操作，由 teamflow_assign 工具或 noteTaskAssign 处理。 */
export function transitionBacklog(product: string | null | undefined, kind, id: string, to: string, reason: string | null | undefined, _meta?) {
  const store = storeFor(product)
  const item = store.find(kind, id)
  if (!item) return { ok: false, error: `找不到 ${kind} #${id}` }
  if (STATUS[kind].indexOf(to) === -1) return { ok: false, error: `非法状态 ${to}` }
  if (to === 'needs-human') item.humanIntervention = true
  if (to === 'accepted' || to === 'verified' || to === 'closed') item.humanIntervention = false
  store.pushEvent(item, item.status, to, reason || '')
  store.persist()
  return { ok: true, item: { id: item.id, status: item.status, humanIntervention: item.humanIntervention } }
}

/**
 * 解析 QA 报告中的结构化缺陷行（| 编号 | P0-3 | 模块 |...），跳过表头与 OBS 观察项。
 * 按管道单元格解析（不依赖固定列数），容忍 markdown 加粗/反引号（如 **P1** / `P1`），
 * 且只认三要素齐全 + 严重级为 P0-P3 的行——修正历史「QA 标 **P1** 却解析不到」的漏登记。
 */
export function parseDefects(qaText: string) {
  const defects = []
  const lines = qaText.split('\n')
  for (const line of lines) {
    if (line.indexOf('|') === -1) continue
    const cells = line.split('|').map((s) => (s || '').trim())
    // 行首可能以 `|` 开头 → 第一个空单元格；去掉
    if (cells.length && cells[0] === '') cells.shift()
    if (cells.length < 3) continue
    const id = cells[0]
    const sev = (cells[1] || '').replace(/[*`>]/g, '')
    const mod = (cells[2] || '').replace(/[*`]/g, '').trim()
    if (!/^P[0-3]$/.test(sev)) continue
    if (!id || id === '编号' || id.indexOf('OBS') === 0) continue
    if (!mod) continue
    defects.push({ id, severity: sev, module: mod })
  }
  return defects
}

/** 流水线启动时建立需求 backlog（req + 唯一轮转任务卡；任务不再按角色拆分）。 */
export function initPipelineBacklog(journal, requirement, options) {
  const key = journal.workspace || 'default'
  const store = storeFor(key)
  const reqId = store.nextId('req')
  const req = {
    id: reqId, product: key, productRoot: options.productRoot || null,
      title: String(requirement || '未命名需求').replace(/\s+/g, ' ').trim().slice(0, 120), status: 'created',
    createdAt: Date.now(), updatedAt: Date.now(), events: [], taskIds: [], bugIds: [], humanIntervention: false,
  }
  store.requirements.push(req)
  store.pushEvent(req, null, 'created', '流水线立项')
  // 单任务模型：一个需求 = 一个轮转任务（dev/qa/验收 在同一张卡上流转）
  const taskId = store.nextId('task')
  const task = {
    id: taskId, reqId, product: key, type: 'task',
    title: `需求任务 · ${snippet(requirement, 100)}`,
    status: 'pending', owner: null, devAssign: null, qaAssign: null, acceptBy: null,
    retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(),
    events: [], bugIds: [], usage: null, byRole: {},
    subtaskIds: [],
  }
  store.tasks.push(task)
  req.taskIds = [taskId]
  journal.reqId = reqId
  journal.taskId = taskId
  journal.taskMap = {} // 保留字段（单任务模型下为空；兼容旧序列化）
  store.pushEvent(req, 'created', 'in-progress', '流水线启动')
  store.persist()
  return { reqId, req, taskId }
}

/** 阶段 → 角色键（任务卡按角色累计 token 用）。 */
const ROLE_OF_PHASE = {
  'PRD 产品需求': 'pm',
  'UI/UX 设计': 'design',
  '架构规划': 'arch',
  '技术方案': 'tech',
  '开发': 'dev',
  'QA 测试': 'qa',
  '产品验收': 'acceptance',
}

/** 把单次 stage 的真实 usage 累计到任务卡（按角色拆分；单任务模型下所有阶段都属于该任务）。 */
function applyStageUsage(task, role, stage) {
  if (!task || !stage) return
  const u = stage && stage.usage
  if (u && (u.input || u.cacheRead || u.cacheWrite || u.output)) {
    const merge = (acc) => {
      acc.input += u.input || 0
      acc.cacheRead += u.cacheRead || 0
      acc.cacheWrite += u.cacheWrite || 0
      acc.output += u.output || 0
      acc.calls += u.calls || 0
      return acc
    }
    if (!task.usage) task.usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
    task.usage = merge(task.usage)
    task.byRole = task.byRole || {}
    task.byRole[role] = merge(task.byRole[role] || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 })
  }
}

/**
 * 把 journal 中「新出现」的已完成阶段 usage 累计到唯一任务卡（按角色拆分）。
 * 幂等：task.accruedSeq 记录已累计的最大 stage.seq，断点续跑不会重复累计。
 */
export function noteTaskStageUsage(journal) {
  const store = storeFor(journal.workspace || 'default')
  const task = journal.taskId ? store.find('task', journal.taskId) : null
  if (!task) return
  let from = typeof task.accruedSeq === 'number' ? task.accruedSeq : 0
  const stages = (journal.stages || []).filter((s) => (s.seq || 0) > from)
  let touched = false
  for (const s of stages) {
    if (!s.usage) continue
    applyStageUsage(task, ROLE_OF_PHASE[s.phase] || 'other', s)
    if ((s.seq || 0) > from) from = s.seq
    touched = true
  }
  if (touched) {
    task.accruedSeq = from
    store.persist()
    persistJournal(journal)
  }
}

/**
 * 阶段任务卡流转 + journal checkpoint（阶段状态变化立即落盘）。
 * 单任务模型：按 journal.taskId 定位唯一轮转任务；token 累计走 noteTaskStageUsage。
 * 只做 status + summary + humanIntervention，不碰 assign——assign 由 noteTaskAssign 独立处理。
 * meta: { by: 'dev'|'qa'|'pm' }（仅用于事件日志标注）
 */
export function advanceTask(journal, to, summary, reason, meta) {
  const store = storeFor(journal.workspace || 'default')
  const task = journal.taskId ? store.find('task', journal.taskId) : null
  if (!task) { persistJournal(journal); return }
  const from = task.status
  store.pushEvent(task, from, to, reason || '')
  if (summary) task.summary = snippet(summary, 2000)
  if (to === 'needs-human') task.humanIntervention = true
  if (to === 'accepted') task.humanIntervention = false
  store.persist()
  persistJournal(journal) // 阶段状态变化 → checkpoint
}

/** 为唯一任务卡记录某角色的分配人（只写 assign 字段，不碰 status）。
 *  role='dev' → devAssign；role='qa' → qaAssign；role='accept'/'pm' → acceptBy。 */
export function noteTaskAssign(journal, role, assignee) {
  const store = storeFor(journal.workspace || 'default')
  const task = journal.taskId ? store.find('task', journal.taskId) : null
  if (!task) return
  if (role === 'dev' && assignee) {
    task.devAssign = String(assignee)
    // 级联刷新 dev 子卡（子卡创建早于赋值的时序缺口：实锤 r9 run dev-17 devAssign 为空）
    for (const sid of task.subtaskIds || []) {
      const sub = store.find('task', sid)
      if (sub && !sub.devAssign) sub.devAssign = String(assignee)
    }
  }
  if (role === 'qa' && assignee) task.qaAssign = String(assignee)
  if ((role === 'accept' || role === 'pm') && assignee) task.acceptBy = String(assignee)
  store.persist()
  persistJournal(journal)
}

/* ── Dev 子卡（每个并行 dev agent 一张） ───────────────────────────── */

/** 创建 dev 子卡：流水线 dev 阶段开始时，为每个 devTaskDef 建一张子卡。 */
export function createSubtask(journal, title, spec) {
  const store = storeFor(journal.workspace || 'default')
  const mainTask = journal.taskId ? store.find('task', journal.taskId) : null
  if (!mainTask) return null
  const id = store.nextId('dev')
  const sub = {
    id, reqId: journal.reqId, parentId: journal.taskId, product: journal.workspace || 'default',
    type: 'subtask', title: `开发 · ${title}`, spec: spec || '',
    status: 'pending', devAssign: (mainTask && mainTask.devAssign) || null, owner: null,
    retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(),
    events: [], bugIds: [], usage: null, byRole: {},
    startedAt: null, endedAt: null, summary: null, childId: null, failed: false,
  }
  store.tasks.push(sub)
  mainTask.subtaskIds = mainTask.subtaskIds || []
  mainTask.subtaskIds.push(id)
  store.persist()
  persistJournal(journal)
  return sub
}

/** 完成 dev 子卡：设置 status=done/failed、时间戳、摘要、childId。 */
export function completeSubtask(journal, subId, failed, summary, childId) {
  const store = storeFor(journal.workspace || 'default')
  const sub = store.find('task', subId)
  if (!sub) return
  sub.status = failed ? 'failed' : 'done'
  sub.failed = !!failed
  sub.endedAt = Date.now()
  if (summary) sub.summary = snippet(summary, 1000)
  if (childId) sub.childId = childId
  sub.updatedAt = Date.now()
  store.persist()
  persistJournal(journal)
}

/** 累计 dev 子卡的 token usage（从对应的 journal stage 累计）。 */
export function noteSubtaskUsage(journal, subId, stage) {
  const store = storeFor(journal.workspace || 'default')
  const sub = store.find('task', subId)
  if (!sub || !stage) return
  applyStageUsage(sub, 'dev', stage)
  sub.updatedAt = Date.now()
  store.persist()
  persistJournal(journal)
}

/** 获取某需求下所有子卡。 */
export function getSubtasks(journal) {
  const store = storeFor(journal.workspace || 'default')
  const mainTask = journal.taskId ? store.find('task', journal.taskId) : null
  if (!mainTask || !mainTask.subtaskIds) return []
  return mainTask.subtaskIds.map((id) => store.find('task', id)).filter(Boolean)
}

/** 独立的分配操作（teamflow_assign 工具的后端）：只写 assign 字段，不碰 status。 */
export function assignTask(product: string | null | undefined, kind: string, id: string, role: string, assignee: string) {
  const store = storeFor(product)
  const item = store.find(kind, id)
  if (!item) return { ok: false, error: `找不到 ${kind} #${id}` }
  if (kind === 'task') {
    if (role === 'dev') item.devAssign = assignee
    else if (role === 'qa') item.qaAssign = assignee
    else if (role === 'accept' || role === 'pm') item.acceptBy = assignee
    else return { ok: false, error: `未知角色 ${role}（支持 dev/qa/accept）` }
  } else {
    item.owner = assignee
  }
  item.updatedAt = Date.now()
  store.persist()
  return { ok: true, item: { id: item.id, devAssign: item.devAssign || null, qaAssign: item.qaAssign || null, acceptBy: item.acceptBy || null, owner: item.owner || null } }
}

/**
 * QA 复验循环的缺陷登记（幂等）：把本次 QA 报告解析出的缺陷登记/更新到要求下的 bug 列表。
 * - 按「reqId + defect.id」幂等：已登记过的同一缺陷（rework 多轮复现）不重复建卡，只刷新状态。
 * - severity 缺失/未知的缺陷行不建卡（防御性：只认明确 P0-P3 的缺陷）。
 * @returns 本次新增的 bug 记录（仅本轮新创建，不含续跑命中已存在者）
 */
export function syncQaDefects(journal, defects) {
  const store = storeFor(journal.workspace || 'default')
  const req = journal.reqId ? store.find('req', journal.reqId) : null
  const created = []
  for (const d of defects || []) {
    const id = String(d && d.id || '').trim()
    if (!id || !/^P[0-3]$/.test(String(d && d.severity || ''))) continue
    const exist = store.bugs.find((b) => b.reqId === journal.reqId && b.defectId === id)
    if (exist) {
      // 幂等：只刷新严重级与状态（若复验仍出现 → 保持 open/reopened 信号）
      exist.severity = String(d.severity)
      exist.module = String(d.module || '')
      exist.updatedAt = Date.now()
    } else {
      const bug = {
        id: store.nextId('bug'), defectId: id, reqId: journal.reqId, taskId: journal.taskId || null,
        severity: String(d.severity), module: String(d.module || ''), title: `QA 缺陷：${id}`,
        reproduce: '', expected: '', actual: '', ac: '', status: 'open', owner: null,
        retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(), events: [],
      }
      store.bugs.push(bug)
      if (req) { req.bugIds = req.bugIds || []; if (!req.bugIds.includes(bug.id)) { req.bugIds.push(bug.id); req.updatedAt = Date.now() } }
      created.push(bug)
    }
  }
  store.persist()
  persistJournal(journal)
  return created
}

/** 把某需求下全部 open 的阻断缺陷（P0/P1/P2）标记为已验证关闭（QA 复验通过或验收通过后调用；P3 观察项保留 open 待登记，不误关）。 */
export function verifyReqBugs(journal) {
  const store = storeFor(journal.workspace || 'default')
  let touched = false
  for (const b of store.bugs) {
    if (b.reqId === journal.reqId && b.status === 'open' && b.severity !== 'P3') {
      b.status = 'verified'
      b.updatedAt = Date.now()
      touched = true
    }
  }
  if (touched) store.persist()
}
