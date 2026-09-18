/**
 * dsh-plugin-teamflow core — Backlog 数据层与状态机（$DSH_HOME/teamflow/<product>/backlog/*）。
 * 依赖：store.ts（原子读写）、context.ts（stores 缓存）。
 */
import { fileFor, readJson, writeJson, teamflowRoot, persistJournal } from '../../store.ts'
import type { BacklogItem } from '../types.ts'
import { stores } from './context.ts'
import { STATUS, PHASE_ROLE } from '../constants.ts'
import { clip, snippet } from '../util.ts'
import { t } from '../locales.ts'
import { ambientLocale, runLocaleOf } from './locale.ts'

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
  if (!item) return { ok: false, error: t(ambientLocale(), 'backlog.notFound', { kind, id }) }
  if (STATUS[kind].indexOf(to) === -1) return { ok: false, error: t(ambientLocale(), 'backlog.badStatus', { to }) }
  if (to === 'needs-human') item.humanIntervention = true
  if (to === 'accepted' || to === 'verified' || to === 'closed') item.humanIntervention = false
  store.pushEvent(item, item.status, to, reason || '')
  store.persist()
  return { ok: true, item: { id: item.id, status: item.status, humanIntervention: item.humanIntervention } }
}

/** 去 markdown 修饰（加粗/反引号/引用符/首尾引号）后比对。 */
function cellText(cell: unknown): string {
  return String(cell === null || cell === undefined ? '' : cell).replace(/[*`>]/g, '').replace(/^["']|["']$/g, '').trim()
}

/**
 * 按**未转义**的 `|` 切分表格行，并把契约要求的转义 `\|` 还原成字面量管道符。
 *
 * 为什么需要（2026-09-15 追加，配合缺陷表新增「检测命令」列）：qaPrompt 的 HOST-ENFORCED 条款要求
 * 单元格内的字面量 `|` 转义为 `\|`（否则 markdown 渲染会切开单元格），但旧实现无条件 `split('|')`
 * ——**转义过的行照样被切开**：转义只救了渲染，解析器自己仍会错列（实锤：R3-2 的「实际行为」串进了
 * 「关联验收项」）。检测命令列几乎必然含 `|`（如 `grep -E 'a|b'`），所以这里必须按转义语义切。
 */
function splitTableRow(raw: string): string[] {
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\\' && raw[i + 1] === '|') { cur += '|'; i++; continue }
    if (ch === '|') { cells.push(cur); cur = ''; continue }
    cur += ch
  }
  cells.push(cur)
  return cells.map((s) => s.trim())
}

/**
 * 由表头行判断这是不是缺陷表，并给出各列位置与表头名。
 * **严重级列必须由表头显式声明**——这是与「复验对照表」区分的唯一可靠信号。
 * @returns 列映射（含表头名数组）；非缺陷表返回 null。
 */
function defectHeaderCols(cells: string[]) {
  const sev = cells.findIndex((c) => /严重级|严重度|等级|级别|severity|\bsev\b/i.test(cellText(c)))
  if (sev === -1) return null
  const mod = cells.findIndex((c) => /功能模块|模块|^module$/i.test(cellText(c)))
  const id = cells.findIndex((c) => /编号|^id$|^no\.?$/i.test(cellText(c)))
  return { id: id === -1 ? 0 : id, sev, mod: mod === -1 ? sev + 1 : mod, headers: cells.map((c) => cellText(c)) }
}

/** 缺陷行：核心三要素（契约）+ 报告里同行的其余列（人看详情用）。 */
export interface DefectRow {
  id: string
  severity: string
  module: string
  /** 复现步骤（表头含 复现/重现/steps/reproduce）。 */
  reproduce?: string
  /** 期望行为。 */
  expected?: string
  /** 实际行为。 */
  actual?: string
  /** 关联验收项。 */
  ac?: string
  /** 检测命令（2026-09-15）：**当前就能失败**的命令——dev 用它验收、复验轮用它回归。
   *  QA 侧对 P0–P2 必填（缺陷的可执行定义）；缺列时为空串（旧报告零回归）。 */
  check?: string
  /** 通过判据：修复后该命令应输出什么（判定标准，供 dev/复验双方对齐）。 */
  criterion?: string
  /** 原始「表头 → 单元格」映射（列名随报告可变，全部带出以免遗漏）。 */
  columns?: Record<string, string>
}

/**
 * 解析 QA 报告中的缺陷行（**富行**：保留同一行的所有列）。
 *
 * 2026-09-15 追加（用户实锤：backlog 缺陷卡详情「看不出这条缺陷是啥」）：此前只留
 * `{id, severity, module}` → 缺陷卡只有「QA 缺陷：R3-1」这种合成标题，QA 报告里写好的
 * 复现步骤/期望行为/实际行为**全部被丢掉**，卡详情只剩关联 run 的原始需求。
 * 富行同时让 `qaFixPrompt` 的 [DEFECTS POINTED OUT BY QA] 从三要素升级为完整缺陷描述。
 * 解析规则见 {@link parseDefects}（两者同一实现，本函数是超集）。
 */
export function parseDefectRows(qaText: string): DefectRow[] {
  const rows: DefectRow[] = []
  let cols: ReturnType<typeof defectHeaderCols> = null
  for (const raw of String(qaText === null || qaText === undefined ? '' : qaText).split('\n')) {
    if (raw.indexOf('|') === -1) { cols = null; continue }   // 非表格行 → 结束当前表格
    const cells = splitTableRow(raw)
    if (cells.length && cells[0] === '') cells.shift()        // 行首 `|` → 首格为空
    if (cells.length && cells[cells.length - 1] === '') cells.pop()
    if (cells.length < 3) { cols = null; continue }
    // 分隔行（|---|---|）不改变表格上下文
    if (cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')))) continue
    if (cols === null) { cols = defectHeaderCols(cells); continue }  // 表头行
    if (!cols) continue                                              // 非缺陷表：整表跳过
    const id = cellText(cells[cols.id])
    const sev = cellText(cells[cols.sev])
    const mod = cellText(cells[cols.mod])
    if (!id || !mod) continue
    if (!/^P[0-3]$/.test(sev)) continue
    if (id === '编号' || /^(id|no\.?|severity)$/i.test(id)) continue
    if (id.indexOf('OBS') === 0) continue
    const columns: Record<string, string> = {}
    cols.headers.forEach((hd, i) => { if (hd && cells[i] !== undefined) columns[hd] = cellText(cells[i]) })
    const pick = (re: RegExp): string => {
      const k = Object.keys(columns).find((hd) => re.test(hd))
      return k ? columns[k] : ''
    }
    rows.push({
      id, severity: sev, module: mod,
      reproduce: pick(/复现|重现|steps|reproduce/i),
      expected: pick(/期望|expected/i),
      actual: pick(/实际|actual/i),
      ac: pick(/关联验收|验收项|related\s*ac/i),
      check: pick(/检测命令|检测|check\s*command|check\s*cmd|^command$/i),
      criterion: pick(/通过判据|判据|criterion|pass\s*(criterion|condition)/i),
      columns,
    })
  }
  return rows
}

/**
 * 解析 QA 报告中的结构化缺陷行（**瘦身契约**：`{id, severity, module}`），跳过表头与 OBS 观察项。
 *
 * **2026-09-15 修正（实锤 tf-mu2ioilr-95l4th 停线）：改为按表头认表，不再只看列位置。**
 * 旧实现「任一含 `|` 的行 + 第 2 格 ∈ P0-P3」会把 QA 报告里的**复验对照表**
 * （`| 编号 | round-2 级 | 复验结论 | 独立证据 |`，R2-1 那行第 3 格写着「已关闭」）登记成一个新的
 * P2 缺陷 → 每轮复验都重生一个阻断缺陷 → 复验必然超限停线（**自我实现的停线**，与交付质量无关）。
 * 现规则：
 *   1) 只解析**表头声明了严重级列**的表格，列位置由表头决定（不再假定必须是第 1/2/3 列）；
 *   2) 非表格行结束当前表格上下文（markdown 表格是连续行块），无严重级表头的表格整体跳过；
 *   3) 仍容忍 markdown 加粗/反引号（`**P1**` / `` `P1` ``）、跳过表头行与 OBS 观察项。
 * 契约：QA 缺陷表必须带标准表头（zh `严重级(P0/P1/P2/P3)` / en `Severity (P0/P1/P2/P3)`，
 * 见 qaPrompt 的 HOST-ENFORCED 条款与 L2 语料）。
 * ⚠ 返回形状受**冻结语料逐字节比对**（`test/conformance.test.js`）——需要更多字段请用
 * {@link parseDefectRows}，不要改本函数的投影形状。
 */
export function parseDefects(qaText: string) {
  return parseDefectRows(qaText).map((r) => ({ id: r.id, severity: r.severity, module: r.module }))
}

/** 流水线启动时建立需求 backlog（req + 唯一轮转任务卡；任务不再按角色拆分）。 */
export function initPipelineBacklog(journal, requirement, options) {
  const key = journal.workspace || 'default'
  const locale = runLocaleOf(journal) // run 快照语言（QA-2：卡片标题/事件时间线随 run，不随界面）
  const store = storeFor(key)
  const reqId = store.nextId('req')
  const req = {
    id: reqId, product: key, productRoot: options.productRoot || null,
      title: String(requirement || t(locale, 'backlog.untitled')).replace(/\s+/g, ' ').trim().slice(0, 120), status: 'created',
    createdAt: Date.now(), updatedAt: Date.now(), events: [], taskIds: [], bugIds: [], humanIntervention: false,
  }
  store.requirements.push(req)
  store.pushEvent(req, null, 'created', t(locale, 'event.created'))
  // 单任务模型：一个需求 = 一个轮转任务（dev/qa/验收 在同一张卡上流转）
  const taskId = store.nextId('task')
  const task = {
    id: taskId, reqId, product: key, type: 'task',
    title: t(locale, 'backlog.reqTitle', { title: snippet(requirement, 100) }),
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
  store.pushEvent(req, 'created', 'in-progress', t(locale, 'event.started'))
  store.persist()
  return { reqId, req, taskId }
}

/** 阶段 → 角色键（单一事实来源 constants.PHASE_ROLE；任务卡按角色累计 token 用）。 */


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
    applyStageUsage(task, PHASE_ROLE[s.phase] || 'other', s)
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
 *  role='dev' → devAssign；role='qa' → qaAssign；role='accept' → acceptBy。 */
export function noteTaskAssign(journal, role: string, assignee) {
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
  if (role === 'accept' && assignee) task.acceptBy = String(assignee)
  store.persist()
  persistJournal(journal)
}

/* ── Dev 子卡（每个并行 dev agent 一张） ───────────────────────────── */

/** 创建 dev 子卡：流水线 dev 阶段开始时，为每个 devTaskDef 建一张子卡。 */
export function createSubtask(journal, title, spec, dtId?: string | null) {
  const store = storeFor(journal.workspace || 'default')
  const mainTask = journal.taskId ? store.find('task', journal.taskId) : null
  if (!mainTask) return null
  const fullTitle = t(runLocaleOf(journal), 'backlog.devTitle', { title })
  // 同任务复用（2026-09-06，实锤 json-parse r1）：子卡 = 业务任务实体（同任务一张，状态流转），
  // 执行历史在 journal stages（每次尝试独立记录）——不因重试/补跑新建卡导致看板膨胀。
  // retries 语义 = 本任务已被执行的次数 - 1（复用即递增）。
  // **匹配键 = dtId（host 生成的任务身份，2026-09-18 修正，勿回退）**：旧实现按 `taskKey`（title）匹配，
  // 而 title 会因「合并执行」被拼接（`T0 + T6 + T7`），resume 时补跑的单个任务 title 与之不等 →
  // **同一任务建出第二张卡**（probe-cache 实锤 `tf-mu6tb281`：`dev-1` 与 `dev-7` 同为 T0、`dev-8` 同为 T6，
  // 重复卡让看板与判定双双失真）。`dtId` 由 host 按蓝图顺序稳定生成，合并/补跑/重试下都不变。
  // 存量兼容：老卡无 `dtId` → 回退 `taskKey`/`title` 匹配（只增不改）。
  const key = dtId ? String(dtId) : null
  const existing = store.tasks.find((t) => t.reqId === journal.reqId && t.parentId === journal.taskId
    && (key
      ? (t.dtId ? t.dtId === key : false)
      : ((t.taskKey && t.taskKey === title) || (!t.taskKey && !t.dtId && t.title === fullTitle))))
  if (existing) {
    existing.status = 'pending'
    existing.failed = false
    existing.summary = null
    existing.endedAt = null
    existing.retries = (existing.retries || 0) + 1
    existing.taskKey = existing.taskKey || title
    if (key) existing.dtId = key
    existing.updatedAt = Date.now()
    store.persist()
    persistJournal(journal)
    return existing
  }
  const id = store.nextId('dev')
  const sub = {
    id, reqId: journal.reqId, parentId: journal.taskId, product: journal.workspace || 'default',
    type: 'subtask', title: fullTitle, taskKey: title, dtId: key, spec: spec || '',
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
  if (!item) return { ok: false, error: t(ambientLocale(), 'backlog.notFound', { kind, id }) }
  if (kind === 'task') {
    if (role === 'dev') item.devAssign = assignee
    else if (role === 'qa') item.qaAssign = assignee
    else if (role === 'accept') item.acceptBy = assignee
    else return { ok: false, error: t(ambientLocale(), 'backlog.unknownRole', { role }) }
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
      // 幂等：只刷新严重级/模块/缺陷描述与状态（若复验仍出现 → 保持 open/reopened 信号）
      exist.severity = String(d.severity)
      exist.module = String(d.module || '')
      exist.reproduce = String(d.reproduce || '')
      exist.expected = String(d.expected || '')
      exist.actual = String(d.actual || '')
      exist.ac = String(d.ac || '')
      exist.check = String(d.check || '')
      exist.criterion = String(d.criterion || '')
      exist.updatedAt = Date.now()
    } else {
      const bug = {
        id: store.nextId('bug'), defectId: id, reqId: journal.reqId, taskId: journal.taskId || null,
        severity: String(d.severity), module: String(d.module || ''),
        // 标题要能自解释：`R3-1` 这种裸编号 + 模块，比「QA 缺陷：R3-1」信息量大得多
        // （用户实锤：卡详情只看到合成标题 + 关联 run 的原始需求，看不出缺陷是什么）
        title: d.module ? `${id} · ${String(d.module)}` : t(runLocaleOf(journal), 'backlog.bugTitle', { id }),
        reproduce: String(d.reproduce || ''), expected: String(d.expected || ''),
        actual: String(d.actual || ''), ac: String(d.ac || ''),
        check: String(d.check || ''), criterion: String(d.criterion || ''),
        status: 'open', owner: null,
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

/** 该需求是否存在未闭环的阻断缺陷（P0/P1/P2 仍 open）——resume 断点定位与 QA 复用判定依赖。
 * 实锤 run tf-mte906e9：QA 修复子代理失败 → run failed，但 QA 阶段本身 done（缺陷已登记），
 * 旧 interruptedPhaseOf 直接定位产品验收 → 带缺陷代码进验收。
 * ⚠️ store key 与 resumeRun/storeFor 解析一致（workspace || product || default），否则查错 store 误判无缺陷。 */
export function hasOpenBlockingBugs(journal): boolean {
  try {
    const store = storeFor(journal.workspace || journal.product || 'default')
    return store.bugs.some((b) => b.reqId === journal.reqId && b.status === 'open' && b.severity !== 'P3')
  } catch (e) { return false }
}
