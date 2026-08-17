/**
 * dsh-plugin-teamflow core — Backlog 数据层与状态机（$DSH_HOME/teamflow/<product>/backlog/*）。
 * 依赖：store.ts（原子读写）、context.ts（stores 缓存）。
 */
import { fileFor, readJson, writeJson, teamflowRoot, persistJournal } from '../../store.ts'
import type { BacklogItem } from '../types.ts'
import { stores } from './context.ts'
import { STATUS } from '../constants.ts'
import { clip, normalizeTasks } from '../util.ts'

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
    tasks: store.tasks.slice(-40).map((t) => ({
      id: t.id, type: t.type || 'task', title: t.title, status: t.status,
      reqId: t.reqId || null, bugId: t.bugId || null, owner: t.owner || null,
      retries: t.retries || 0, humanIntervention: !!t.humanIntervention,
      startedAt: t.startedAt || null, updatedAt: t.updatedAt || null,
      summary: clip(t.summary || '', 300),
    })).reverse(),
    bugs: store.bugs.slice(-30).map((b) => ({ id: b.id, reqId: b.reqId || null, severity: b.severity || null, title: b.title, status: b.status, owner: b.owner || null, retries: b.retries || 0, humanIntervention: !!b.humanIntervention, updatedAt: b.updatedAt })).reverse(),
  }
}

/** backlog 状态流转（校验目标状态合法性，合法的终态自动清 needs-human）。 */
export function transitionBacklog(product: string | null | undefined, kind, id: string, to: string, reason: string | null | undefined) {
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

/** 解析 QA 报告中的结构化缺陷行（| 编号 | P0-3 | 模块 |...），跳过表头与 OBS 观察项。 */
export function parseDefects(qaText: string) {
  const defects = []
  const lines = qaText.split('\n')
  for (const line of lines) {
    const m = line.match(/^\s*\|?\s*(\S+)\s*\|\s*(P[0-3])\s*\|\s*([^|]*)\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|[^|]*\|?/)
    if (!m) continue
    const id = m[1]
    const sev = m[2]
    const mod = m[3].trim()
    if (id === '编号' || id.indexOf('OBS') === 0) continue
    defects.push({ id, severity: sev, module: mod })
  }
  return defects
}

/** 流水线启动时建立需求 backlog（req + 各阶段任务卡；lite 模式不建 design/tech）。 */
export function initPipelineBacklog(journal, requirement, options) {
  const store = storeFor(options.productRoot)
  const reqId = store.nextId('req')
  const req = {
    id: reqId, product: options.productRoot || null, title: clip(requirement, 120), status: 'created',
    createdAt: Date.now(), updatedAt: Date.now(), events: [], taskIds: [], bugIds: [], humanIntervention: false,
  }
  store.requirements.push(req)
  store.pushEvent(req, null, 'created', '流水线立项')
  journal.reqId = reqId
  journal.taskMap = {}
  const mkTask = (type, title) => {
    const id = store.nextId('task')
    const t = { id, reqId, type, title, status: 'pending', owner: null, retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(), events: [], summary: null }
    store.tasks.push(t)
    req.taskIds.push(id)
    journal.taskMap[type] = id
    return t
  }
  const light = options.lite || options.mode === 'lite' || options.mode === 'tech' || options.mode === 'patch'
  mkTask('prd', 'PRD 产品需求')
  if (options.needDesign && !light) mkTask('design', 'UI/UX 设计')
  if (options.needScaffold && !light) mkTask('arch', '架构规划与落地')
  if (!light) mkTask('tech', '技术方案')
  const devTasks = normalizeTasks(options.tasks)
  const devTitles = devTasks.length > 0 ? devTasks.map((t) => t.title) : ['整体开发']
  devTitles.forEach((t) => {
    const id = store.nextId('task')
    const task = { id, reqId, type: 'dev', title: `开发 · ${t}`, status: 'pending', owner: null, retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(), events: [], summary: null }
    store.tasks.push(task)
    req.taskIds.push(id)
    journal.taskMap[`dev_${t}`] = id
  })
  mkTask('qa', 'QA 功能测试')
  if (options.mode === 'patch') {
    // patch 档无独立QA：移除 QA 卡（开发自测兜底）；验收卡仍在
    const qaTask = store.find('task', journal.taskMap['qa'])
    if (qaTask) {
      req.taskIds = req.taskIds.filter((x) => x !== qaTask.id)
      store.tasks = store.tasks.filter((t) => t.id !== qaTask.id)
      delete journal.taskMap['qa']
    }
  }
  mkTask('acceptance', '产品验收')
  store.pushEvent(req, 'created', 'in-progress', '流水线启动')
  store.persist()
  return { reqId, req }
}

/** 阶段任务卡流转 + journal checkpoint（阶段状态变化立即落盘）。 */
export function advanceTask(journal, type, to, summary, reason) {
  const store = storeFor(journal.product)
  const id = journal.taskMap && journal.taskMap[type]
  const task = id ? store.find('task', id) : null
  if (!task) return
  store.pushEvent(task, task.status, to, reason || '')
  task.summary = summary ? clip(summary, 300) : task.summary
  store.persist()
  persistJournal(journal) // 阶段状态变化 → checkpoint
}
