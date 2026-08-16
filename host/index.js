/**
 * dsh-plugin-teamflow — host half.
 *
 * TeamFlow 团队研发流水线宿主数据层。
 * - backlog 持久化到 $DSH_HOME/teamflow/<product>/backlog/{requirements,tasks,bugs}.json
 * - 状态机 + 事件日志 + 打回阈值 + 并发池 + QA 缺陷登记
 * - 注册 teamflow_* 工具（供模型调用）与 harness.handle RPC（供 web client 面板调用）
 * - 运行引擎与动态插件版一致（subagents 编排），但数据层用真实 Node fs，跨重启不丢。
 *
 * 运行环境：宿主组合（web profile）的真实 Node 进程，可 require('node:*')。
 */
import { resolve, join, dirname, sep } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'

const RETRY_LIMIT = 2

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}
function teamflowRoot() {
  return join(dshHome(), 'teamflow')
}
function productDir(product) {
  const safe = String(product || 'default').replace(/[\\/]+/g, '/').replace(/^\.+/, '').trim() || 'default'
  return join(teamflowRoot(), safe)
}
function fileFor(product, name) {
  return join(productDir(product), 'backlog', name)
}

/* ── 小型持久化 store ─────────────────────────────────────────────── */
function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    const v = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(v) ? v : fallback
  } catch (e) {
    console.error('[teamflow] readJson failed', file, e?.message)
    return fallback
  }
}
function writeJson(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(value, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('[teamflow] writeJson failed', file, e?.message)
    return false
  }
}

/* ── 状态机 ───────────────────────────────────────────────────────── */
const STATUS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human', 'closed'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}

class BacklogStore {
  constructor(product) {
    this.product = product || 'default'
    this.fileReq = fileFor(this.product, 'requirements.json')
    this.fileTask = fileFor(this.product, 'tasks.json')
    this.fileBug = fileFor(this.product, 'bugs.json')
    this.requirements = readJson(this.fileReq, [])
    this.tasks = readJson(this.fileTask, [])
    this.bugs = readJson(this.fileBug, [])
  }
  persist() {
    writeJson(this.fileReq, this.requirements)
    writeJson(this.fileTask, this.tasks)
    writeJson(this.fileBug, this.bugs)
  }
  nextId(prefix) {
    const used = new Set()
    for (const r of this.requirements) used.add(r.id)
    for (const t of this.tasks) used.add(t.id)
    for (const b of this.bugs) used.add(b.id)
    let n = 1
    while (used.has(`${prefix}-${n}`)) n++
    return `${prefix}-${n}`
  }
  find(kind, id) {
    const list = kind === 'req' ? this.requirements : kind === 'task' ? this.tasks : this.bugs
    return list.find((x) => x.id === id)
  }
  pushEvent(item, from, to, reason) {
    item.status = to
    item.updatedAt = Date.now()
    item.events = item.events || []
    item.events.push({ at: Date.now(), by: 'teamflow', from, to, reason: reason || '' })
    if (item.events.length > 50) item.events = item.events.slice(-50)
    this.persist()
  }
}

/* ── 工具函数 ─────────────────────────────────────────────────────── */
function toText(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}
function clip(text, n) {
  const s = toText(text)
  return s.length > n ? s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]` : s
}
function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}
function normalizeRoot(v) {
  if (typeof v !== 'string' || !v.trim()) return null
  return v.trim().replace(/[\\/]+$/, '').replace(/^[\\/]+/, '')
}
function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return []
  const out = []
  for (const t of tasks) {
    if (t === null || t === undefined) continue
    if (typeof t === 'string') {
      const s = t.trim()
      if (s) out.push({ title: s, spec: '' })
    } else if (typeof t === 'object') {
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null
      if (title) out.push({ title, spec: typeof t.spec === 'string' ? t.spec : '' })
    }
    if (out.length >= 8) break
  }
  return out
}
function sanitizeSnapOptions(o) {
  const opts = (o && typeof o === 'object') ? o : {}
  return {
    needDesign: opts.needDesign === true,
    needScaffold: opts.needScaffold === true,
    productRoot: typeof opts.productRoot === 'string' ? opts.productRoot : null,
    maxConcurrency: (Number.isFinite(opts.maxConcurrency) && opts.maxConcurrency > 0) ? Math.min(opts.maxConcurrency, 8) : null,
    tasks: Array.isArray(opts.tasks) ? opts.tasks.map((t) => ({ title: String((t && t.title) || ''), spec: String((t && t.spec) || '') })) : [],
  }
}
const SAFE_SIGNAL = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }
function normalizeSignal(s) {
  return (s && typeof s === 'object' && typeof s.addEventListener === 'function' && typeof s.aborted === 'boolean') ? s : SAFE_SIGNAL
}

/* ── 提示词模板（与动态插件版一致）────────────────────────────────── */
const AGENTS_TEMPLATE = `# AGENTS.md — 团队协作守则与产品记忆锚点（{{PRODUCT}} 产品线）

> 任何新加入本产品的 Agent（团队成员）必须先通读本文件，再按 §2 文档索引读取相关文档与任务卡片，不要自行全量探索项目。
> 维护者：TeamFlow 研发流水线（架构师起草与更新；产品经理每次迭代核对 §5 产品记忆与 §6 待办）。

## 1. 产品是什么

- 产品：{{PRODUCT_DESC}}
- 产品根：{{PRODUCT_ROOT}}/（工作区产品线约定：products/<product>/）
- 当前版本：{{VERSION}}（{{DATE}} 交付）

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| 摘要索引 | docs/SUMMARY.md | 先读：每文档用途/关键章节/读取指引（token 预算） |
| 产品入口 | README.md | 玩法/操作/运行/验收速览 |
| 需求（PRD） | docs/prd/PRD.md | 验收唯一依据（AC 清单 + 数值规格） |
| 设计 | docs/design/DESIGN.md | 视觉/交互/动效/a11y 规范 |
| 架构 | docs/architecture/ARCHITECTURE.md | 工程方案与脚手架说明 |
| 技术方案 | docs/technical/TECHNICAL.md | 模块契约与任务拆分 |
| QA | docs/qa/QA-REPORT.md | 测试报告 + 人工补测清单 |
| 历史归档 | docs/history/<版本>/ | 已发布版本快照（日常不读） |
| 待办 | 本文件 §6 | 下一批需求与遗留事项 |

## 3. 团队角色与标准流程

**角色**：产品经理 / UI/UX 设计师 / 架构师 / 高级全栈工程师 / QA 测试工程师。

**标准流程**：需求 → PRD →（UI 改造时）UI/UX 设计 →（新项目时）架构规划 → 技术方案 → 并行开发 → QA 测试 → 产品验收。

**产出物落盘约定**：PRD → docs/prd/；设计 → docs/design/；架构 → docs/architecture/；技术方案 → docs/technical/；QA 报告 → docs/qa/；产品现状 → 更新本文件 §1/§5/§6。

**完成度自查**：每个环节交付前对照职责清单自查，未完成不得流转；架构师对新项目必须实际初始化脚手架文件与 AGENTS.md 草稿。

**文档归档**：更新活文档前，先把当前版本快照复制到 docs/history/<版本>/（防臃肿，见 docs/SUMMARY.md）。

## 4. 工程约定

（架构师按实际技术栈填写：代码形态、契约、验证命令、风格约定）

## 5. 产品记忆（迭代历史）

| 版本 | 日期 | 需求 | 结果 |
|---|---|---|---|
| {{VERSION}} | {{DATE}} | {{REQUIREMENT_SUMMARY}} | 交付中 |

## 6. 已知待办（下一批）

（产品经理与 QA 每次迭代后更新）

## 7. 变更记录

- {{DATE}}：创建本文件。
`

function productCtx(root) {
  const base = root || 'products/<product>'
  return `【产品线约定】本需求属于产品 ${base}。
开工前先读 ${base}/AGENTS.md（团队守则与产品记忆）与 ${base}/docs/SUMMARY.md（文档摘要索引，先读摘要、按需精读，不要无目的全量通读）；
若目录尚不存在，按约定创建 ${base}/ 结构（docs/<职责>/、backlog/）。
`
}
const TOKEN_HYGIENE = `【token 卫生】上下文很贵：禁止用 read 全量读取超过 200 行的文件（改用 grep 定位 + 分段读取）；
运行命令时把完整输出重定向到文件（如 > log.txt）再读取尾部摘要，不要把几百行输出直接回显；
报告与摘要一律精简（QA ≤150 行、验收 ≤80 行、开发 ≤40 行），细节落盘文件。
`

const prdPrompt = (requirement, root) => `你是资深产品经理。当前工作区即为目标项目（若为空表示项目尚未建立）。
${productCtx(root)}【原始需求】
${requirement}
【要求】
1. 先检查工作区中是否已有 PRD 模板、需求文档或既有开发模式（如 docs/、README、历史文档等），若有必须遵循其结构与规范（基于现有模式开发）。
2. 若本产品已有历史 PRD（docs/prd/PRD.md）或 AGENTS.md §5 产品记忆：这是迭代需求——先读 docs/SUMMARY.md、历史 PRD 修订记录与产品记忆，输出增量 PRD（保留既有 AC 编号与语义，压缩旧 AC 的冗长表述，显式标注本次变更），并升级版本号。
3. 【文档归档】更新活文档之前，先把当前 PRD 快照复制到 docs/history/<旧版本号>/（目录不存在则创建），再写新版；历史快照日常不读。
4. 输出完整 PRD（Markdown）：背景与目标、用户故事（含逐条可测试的验收标准）、功能范围与非目标、交互流程概述、优先级(P0/P1/P2)、依赖与风险、里程碑建议。
5. 验收标准必须可测试、可量化；文档精炼优先，避免无限膨胀。
6. 产出写入 docs/prd/PRD.md；若 AGENTS.md 存在，同步在 §5/§6 更新产品记忆与待办。`

const designPrompt = (prd, root) => `你是资深 UI/UX 设计师。当前工作区即为目标项目。
${productCtx(root)}【PRD（本次变更与相关章节）】
${clip(prd, 15000)}
【要求】
1. 若项目已有前端代码/设计系统或历史 DESIGN.md，先阅读，设计必须贴合现有风格与组件规范（迭代时保留既有规范，新增/修订部分显式标注）。
2. 输出：页面/模块清单与信息架构、关键页面线框描述（布局/组件/状态）、交互与动效说明、视觉规范（配色/字号/间距，尽量复用现有 token）、可访问性要点。
3. 输出中文 Markdown，具体到可直接指导前端实现，精炼优先。
4. 产出写入 docs/design/DESIGN.md（迭代时保留既有规范，新增/修订部分标注）。`

const scaffoldPrompt = (req, design, root) => `你是资深架构师。工作区为空或尚无项目骨架，请规划并**实际落地**新项目脚手架。
${productCtx(root)}【需求】
${clip(req, 10000)}
${design ? `【设计说明】
${clip(design, 10000)}
` : ''}【要求】
1. 推荐技术栈（优先团队常用全栈栈，如 TypeScript + React + Node），说明取舍。
2. 输出完整脚手架方案：目录结构树、核心模块划分、依赖清单、构建/测试/CI 配置要点。
3. 【落地要求】除方案文档外必须实际执行初始化（工作区允许范围内）：
   a) 若产品根尚不存在，创建目录结构（docs/<职责>/、backlog/ 等）；
   b) 初始化脚手架文件（package.json、配置、入口等按方案实际创建，不得只写方案不落地）；
   c) 基于下方 AGENTS.md 模板起草产品 AGENTS.md（替换 {{占位符}} 为实际内容，填写 §4 工程约定），并创建 docs/SUMMARY.md（摘要索引）；
   d) 输出完成度自查清单：已落地项 / 未落地项及原因——未完成项必须显式列出，不得宣称全部完成。
4. 若工作区已有部分文件，先阅读并尊重现状。
5. 输出中文 Markdown，精炼完整；方案文档写入 docs/architecture/ARCHITECTURE.md。

【AGENTS.md 模板】
${AGENTS_TEMPLATE}`

const techPrompt = (prd, design, scaffold, tasks, root) => `你是高级全栈工程师。当前工作区即为目标项目，请基于已有项目产出技术方案。
${productCtx(root)}【PRD（本次变更与相关章节）】
${clip(prd, 12000)}
${design ? `【设计说明】
${clip(design, 10000)}
` : ''}${scaffold ? `【脚手架方案】
${clip(scaffold, 10000)}
` : ''}${tasks && tasks.length > 0 ? `【流水线派发任务（必须对齐，不得另起一套）】
${JSON.stringify(tasks)}
` : ''}【要求】
1. 先阅读 docs/SUMMARY.md 与工作区现有项目（package.json、README、src 结构等）及 AGENTS.md，方案必须贴合现有技术栈与代码风格，并给出具体文件路径。
2. 输出：数据模型与存储、API 设计（路由/入参出参）、前端组件与页面划分、状态管理、关键实现要点与边界情况、测试策略。
3. 任务拆分：若上方【流水线派发任务】存在，你的拆分必须与之对齐——逐项校验/细化派发任务（文件边界、接口契约、验收标准），不得另起一套任务体系；未派发时给出可并行任务清单。
4. 输出中文 Markdown，精炼完整；产出写入 docs/technical/TECHNICAL.md。`

const devPrompt = (task, tech, prd, root) => `你是高级全栈工程师（开发执行）。当前工作区即为目标项目，请实际实现以下任务。
${productCtx(root)}${TOKEN_HYGIENE}【上下文包】你的目标与上下文如下，不需要全量探索项目：
【任务标题】${task.title}
【任务描述】${task.spec || '（见技术方案）'}
【技术方案】
${clip(tech, 20000)}
【PRD】本次相关验收标准见 docs/prd/PRD.md（按需查阅对应 AC，不必通读全文）。
【要求】
1. 先读 AGENTS.md §4 工程约定（验证命令/风格/数值事实来源）与 docs/SUMMARY.md；只修改与任务相关的文件，遵守既有架构与代码风格。
2. 任务卡中的文件/符号命名为建议值，**以技术方案契约为准**（冲突时按技术方案执行，并在实现摘要中说明）。
3. 实际编写/修改代码（使用文件工具），完成后运行相关构建/验证命令（如 AGENTS.md 约定）确保通过。
4. 输出实现摘要（≤40 行）：改动文件列表、关键实现点、如何验证、遗留问题。不要粘贴大段代码。`

const qaPrompt = (prd, devSummary, root) => `你是资深 QA 测试工程师。当前工作区即为目标项目，请对本次交付做功能测试。
${productCtx(root)}${TOKEN_HYGIENE}【PRD（本次变更与相关 AC）】
${clip(prd, 12000)}
【开发结果摘要】
${clip(devSummary, 15000)}
【要求】
1. 先读 AGENTS.md §4 工程约定（验证命令）与代码改动，然后尽可能实际运行功能验证：构建、单元测试、冒烟测试（如环境允许）。
2. 输出测试报告（正文 ≤150 行，结论先行）：测试范围与环境、用例与结果（通过/失败/阻塞）、结论（是否达到可验收标准）。
3. 【缺陷提交格式】发现的缺陷按以下结构化清单输出（供缺陷管理系统直接收录）：
   | 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |
   若无缺陷，显式输出「未发现缺陷」。
4. 输出中文 Markdown，具体可执行；报告写入 docs/qa/QA-REPORT.md（迭代时保留历史章节，正文精炼）。`

const acceptancePrompt = (prd, qa, devSummary, root) => `你是产品经理（验收负责人）。请对照 PRD 验收标准对本次交付做最终验收。
${productCtx(root)}${TOKEN_HYGIENE}【PRD（修订记录 + 本次新增 AC）】
${clip(prd, 8000)}
【QA 测试报告（结论）】
${clip(qa, 10000)}
【开发结果摘要】
${clip(devSummary, 8000)}
【要求】
1. 逐条核对 PRD 验收标准达成情况。
2. 输出验收结论（正文 ≤80 行）：✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过，附逐条核对表、意见与遗留事项。
3. 若 AGENTS.md 存在：在 §5 追加本次迭代记录（版本/日期/需求/结果），更新 §6 待办（划掉已完成、补充新发现）；若 PRD 结构变化，同步更新 docs/SUMMARY.md。
4. 输出中文 Markdown。`

/* ── 并发池 ──────────────────────────────────────────────────────── */
async function runPool(items, max, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, max), items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

export default {
  inject: ['agents', 'subagents', 'tokenMeter'],
  apply(ctx) {
    const agents = ctx.agents
    const subagents = ctx.subagents
    const tokenMeter = ctx.tokenMeter

    const runs = new Map()
    const inFlight = new Map()
    const now = () => Date.now()

    const measureTokens = (run) => {
      if (!tokenMeter || !run || !run.localAgent) return null
      try {
        const m = tokenMeter.measure(run.localAgent.session)
        return (m && typeof m.totalTokens === 'number') ? m.totalTokens : null
      } catch (e) { return null }
    }
    const providerName = () => {
      const names = subagents.list()
      if (names.indexOf('spawn') !== -1) return 'spawn'
      return names.length > 0 ? names[0] : null
    }

    const stores = new Map()
    const storeFor = (product) => {
      const key = product || 'default'
      let s = stores.get(key)
      if (!s) { s = new BacklogStore(key); stores.set(key, s) }
      return s
    }

    async function runAgent(journal, parent, label, phase, prompt, signal) {
      const stage = {
        seq: journal.stages.length + 1, label, phase, status: 'running', outcome: null,
        childId: null, startedAt: now(), endedAt: null, summary: null, tokens: null,
      }
      journal.stages.push(stage)
      journal.agentsStarted += 1
      let run = null
      try {
        run = await subagents.start(providerName(), {
          label,
          prompt: [{ type: 'text', text: prompt }],
          parent,
          signal: normalizeSignal(signal),
        })
        stage.childId = run.id
        inFlight.set(journal.id, { run, stage })
        const result = await run.result
        const stop = result && result.stopReason
        const text = extractText(result && result.output)
        if (journal.cancelled) {
          stage.status = 'cancelled'; stage.outcome = 'cancelled'
          return null
        }
        if (stop === 'completed' && text) {
          stage.status = 'done'; stage.outcome = 'completed'
          return text
        }
        stage.status = 'failed'
        stage.outcome = stop || 'error'
        stage.summary = `未产出有效结果（stopReason=${stop || 'unknown'}）`
        journal.logs.push({ t: now(), level: 'error', message: `${label} 未产出有效结果（stopReason=${stop || 'unknown'}）` })
        return null
      } catch (e) {
        stage.status = journal.cancelled ? 'cancelled' : 'failed'
        stage.outcome = journal.cancelled ? 'cancelled' : 'error'
        stage.summary = `启动/执行失败：${String((e && e.message) || e)}`
        journal.logs.push({ t: now(), level: 'error', message: `${label} 启动/执行失败：${String((e && e.message) || e)}` })
        return null
      } finally {
        stage.tokens = measureTokens(run)
        stage.endedAt = now()
        if (inFlight.get(journal.id) && inFlight.get(journal.id).stage === stage) inFlight.delete(journal.id)
        if (run) { try { await run.dispose() } catch (e2) { /* ignore */ } }
      }
    }

    async function withRetry(journal, parent, label, phase, prompt, signal) {
      let attempts = 0
      for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
        attempts = attempt
        const labelNow = attempt > 1 ? `${label}（第 ${attempt} 次重试）` : label
        const result = await runAgent(journal, parent, labelNow, phase, prompt, signal)
        if (result) return { text: result, attempts }
        if (journal.cancelled) return { text: null, attempts }
        if (attempt < RETRY_LIMIT) {
          journal.logs.push({ t: now(), level: 'warn', message: `${label} 第 ${attempt} 次尝试未成功，自动重试…` })
        } else {
          journal.logs.push({ t: now(), level: 'error', message: `${label} 连续 ${RETRY_LIMIT} 次尝试失败，超出重试阈值，需人工介入` })
          journal.humanIntervention = true
        }
      }
      return { text: null, attempts }
    }

    function parseDefects(qaText) {
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

    function initPipelineBacklog(journal, requirement, options) {
      const store = storeFor(options.productRoot)
      const reqId = store.nextId('req')
      const req = {
        id: reqId, product: options.productRoot || null, title: clip(requirement, 120), status: 'created',
        createdAt: now(), updatedAt: now(), events: [], taskIds: [], bugIds: [], humanIntervention: false,
      }
      store.requirements.push(req)
      store.pushEvent(req, null, 'created', '流水线立项')
      journal.reqId = reqId
      journal.taskMap = {}
      const mkTask = (type, title) => {
        const id = store.nextId('task')
        const t = { id, reqId, type, title, status: 'pending', owner: null, retries: 0, humanIntervention: false, createdAt: now(), updatedAt: now(), events: [], summary: null }
        store.tasks.push(t)
        req.taskIds.push(id)
        journal.taskMap[type] = id
        return t
      }
      mkTask('prd', 'PRD 产品需求')
      if (options.needDesign) mkTask('design', 'UI/UX 设计')
      if (options.needScaffold) mkTask('arch', '架构规划与落地')
      mkTask('tech', '技术方案')
      const devTasks = normalizeTasks(options.tasks)
      const devTitles = devTasks.length > 0 ? devTasks.map((t) => t.title) : ['整体开发']
      devTitles.forEach((t) => {
        const id = store.nextId('task')
        const task = { id, reqId, type: 'dev', title: `开发 · ${t}`, status: 'pending', owner: null, retries: 0, humanIntervention: false, createdAt: now(), updatedAt: now(), events: [], summary: null }
        store.tasks.push(task)
        req.taskIds.push(id)
        journal.taskMap[`dev_${t}`] = id
      })
      mkTask('qa', 'QA 功能测试')
      mkTask('acceptance', '产品验收')
      store.pushEvent(req, 'created', 'in-progress', '流水线启动')
      store.persist()
      return { reqId, req }
    }

    function advanceTask(journal, type, to, summary, reason) {
      const store = storeFor(journal.product)
      const id = journal.taskMap && journal.taskMap[type]
      const task = id ? store.find('task', id) : null
      if (!task) return
      store.pushEvent(task, task.status, to, reason || '')
      task.summary = summary ? clip(summary, 300) : task.summary
      store.persist()
    }

    async function executePipeline(journal, parent, requirement, options, signal) {
      journal.status = 'running'
      journal.startedAt = now()
      const root = options.productRoot || null
      journal.product = root
      const tasks = normalizeTasks(options.tasks)
      const maxConcurrency = Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, 8) : 3
      const timeline = {}
      try {
        const init = initPipelineBacklog(journal, requirement, options)
        journal.reqId = init.reqId
        journal.logs.push({ t: now(), level: 'info', message: `backlog 已建立需求 ${init.reqId}（产品 ${root || 'unknown'}，并发 ${maxConcurrency}）` })

        journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：PRD 产品需求' })
        advanceTask(journal, 'prd', 'running', null, '进入流水线')
        const prdR = await withRetry(journal, parent, '产品经理 · 梳理 PRD', 'PRD 产品需求', prdPrompt(requirement, root), signal)
        if (!prdR.text) { advanceTask(journal, 'prd', 'needs-human', null, 'PRD 失败'); throw new Error(`PRD 阶段失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        const prd = prdR.text
        timeline.prd = prd
        advanceTask(journal, 'prd', 'accepted', clip(prd, 300), 'PRD 完成')
        if (journal.cancelled) return

        let design = null
        if (options.needDesign) {
          journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：UI/UX 设计' })
          advanceTask(journal, 'design', 'running', null, '进入流水线')
          const designR = await withRetry(journal, parent, 'UI/UX 设计师 · 设计说明', 'UI/UX 设计', designPrompt(prd, root), signal)
          if (!designR.text) { advanceTask(journal, 'design', 'needs-human', null, 'UI 设计失败'); throw new Error(`UI/UX 设计失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
          design = designR.text
          timeline.design = design
          advanceTask(journal, 'design', 'accepted', clip(design, 300), 'UI 设计完成')
          if (journal.cancelled) return
        }

        let scaffold = null
        if (options.needScaffold) {
          journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：架构规划' })
          advanceTask(journal, 'arch', 'running', null, '进入流水线')
          const scR = await withRetry(journal, parent, '架构师 · 脚手架规划与落地', '架构规划', scaffoldPrompt(requirement, design, root), signal)
          if (!scR.text) { advanceTask(journal, 'arch', 'needs-human', null, '架构规划失败'); throw new Error(`架构规划失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
          scaffold = scR.text
          timeline.scaffold = scaffold
          advanceTask(journal, 'arch', 'accepted', clip(scaffold, 300), '架构完成')
          if (journal.cancelled) return
        }

        journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：技术方案' })
        advanceTask(journal, 'tech', 'running', null, '进入流水线')
        const techR = await withRetry(journal, parent, '高级全栈工程师 · 技术方案', '技术方案', techPrompt(prd, design, scaffold, tasks, root), signal)
        if (!techR.text) { advanceTask(journal, 'tech', 'needs-human', null, '技术方案失败'); throw new Error(`技术方案失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        const tech = techR.text
        timeline.tech = tech
        advanceTask(journal, 'tech', 'accepted', clip(tech, 300), '技术方案完成')
        if (journal.cancelled) return

        journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：开发' })
        const devTaskDefs = tasks.length > 0 ? tasks : [{ title: '整体开发', spec: '按技术方案实现全部需求' }]
        journal.logs.push({ t: now(), level: 'info', message: `开发阶段开始，任务数：${devTaskDefs.length}（并发 ${maxConcurrency}）` })
        const store = storeFor(root)
        const devResults = await runPool(devTaskDefs, maxConcurrency, async (task) => {
          const devId = journal.taskMap[`dev_${task.title}`]
          const devTask = devId ? store.find('task', devId) : null
          if (devTask) store.pushEvent(devTask, devTask.status, 'running', '开发开始')
          const devR = await withRetry(journal, parent, `开发 · ${task.title}`, '开发', devPrompt(task, tech, prd, root), signal)
          const ok = !!devR.text
          if (devTask) {
            if (ok) {
              store.pushEvent(devTask, 'running', 'accepted', '开发完成')
              devTask.summary = clip(devR.text, 300)
            } else {
              devTask.retries = (devTask.retries || 0) + (devR.attempts || 1)
              devTask.humanIntervention = devTask.retries >= RETRY_LIMIT
              store.pushEvent(devTask, 'running', devTask.humanIntervention ? 'needs-human' : 'rework', '开发失败')
              const req = store.find('req', journal.reqId)
              if (req && devTask.humanIntervention) req.humanIntervention = true
            }
            store.persist()
          }
          return { title: task.title, failed: !ok, output: devR.text || '开发失败（Agent 未产出结果）' }
        })
        timeline.dev = devResults
        const failedCount = devResults.filter((r) => r && r.failed).length
        journal.logs.push({ t: now(), level: 'info', message: `开发完成，失败任务数：${failedCount}` })
        if (journal.cancelled) return

        journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：QA 测试' })
        advanceTask(journal, 'qa', 'running', null, '进入流水线')
        const qaR = await withRetry(journal, parent, 'QA 测试工程师 · 功能测试', 'QA 测试', qaPrompt(prd, JSON.stringify(timeline.dev), root), signal)
        if (!qaR.text) { advanceTask(journal, 'qa', 'needs-human', null, 'QA 失败'); throw new Error(`QA 失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        const qa = qaR.text
        timeline.qa = qa
        advanceTask(journal, 'qa', 'accepted', clip(qa, 300), 'QA 完成')
        const defects = parseDefects(qa)
        if (defects.length > 0) {
          const req = store.find('req', journal.reqId)
          defects.slice(0, 8).forEach((d) => {
            const id = store.nextId('bug')
            const b = { id, reqId: journal.reqId, taskId: journal.taskMap['qa'] || null, severity: d.severity, title: `QA 缺陷：${d.module || d.id}`, reproduce: '', expected: '', actual: '', ac: '', status: 'open', owner: null, retries: 0, humanIntervention: false, createdAt: now(), updatedAt: now(), events: [] }
            store.bugs.push(b)
            if (req) { req.bugIds.push(id); req.status = 'pending-acceptance'; req.updatedAt = now() }
          })
          store.persist()
          journal.logs.push({ t: now(), level: 'warn', message: `QA 发现 ${defects.length} 个缺陷，已登记到 backlog（需开发认领）` })
        } else {
          journal.logs.push({ t: now(), level: 'info', message: 'QA 未发现 P0/P1/P2 缺陷（未登记 Bug）' })
        }
        if (journal.cancelled) return

        journal.logs.push({ t: now(), level: 'phase', message: '进入阶段：产品验收' })
        advanceTask(journal, 'acceptance', 'running', null, '进入流水线')
        const accR = await withRetry(journal, parent, '产品经理 · 最终验收', '产品验收', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root), signal)
        if (!accR.text) { advanceTask(journal, 'acceptance', 'needs-human', null, '验收失败'); throw new Error(`验收失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        const acceptance = accR.text
        timeline.acceptance = acceptance
        advanceTask(journal, 'acceptance', 'accepted', clip(acceptance, 300), '验收完成')
        const req = store.find('req', journal.reqId)
        if (req) {
          const openBugs = store.bugs.filter((b) => b.reqId === req.id && b.status !== 'verified' && b.status !== 'closed')
          if (openBugs.length > 0) {
            store.pushEvent(req, req.status, 'pending-acceptance', '存在未关闭缺陷')
          } else {
            store.pushEvent(req, req.status, 'accepted', '验收通过')
          }
        }
        journal.logs.push({ t: now(), level: 'info', message: '流水线全部完成 ✅' })
        journal.status = 'completed'
      } catch (e) {
        if (journal.cancelled) {
          journal.status = 'cancelled'
          journal.error = '运行已取消'
        } else {
          journal.status = 'failed'
          journal.error = String((e && e.message) || e)
        }
      } finally {
        journal.endedAt = now()
        inFlight.delete(journal.id)
        journal.result = { requirement, options: sanitizeSnapOptions(options), timeline }
        console.log(`[teamflow] 运行结束 ${journal.id} → ${journal.status}`)
      }
    }

    function startPipeline(agent, requirement, options, signal) {
      const provider = providerName()
      if (!provider) throw new Error('没有可用的子代理提供者（subagents 注册表为空）')
      const journal = {
        id: `tf-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        name: 'teamflow-pipeline', status: 'pending',
        requirement: clip(requirement, 8000),
        options: {
          needDesign: !!options.needDesign,
          needScaffold: !!options.needScaffold,
          tasks: normalizeTasks(options.tasks),
          productRoot: normalizeRoot(options.productRoot),
          maxConcurrency: (Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0) ? Math.min(options.maxConcurrency, 8) : null,
        },
        startedAt: null, endedAt: null, agentsStarted: 0,
        stages: [], logs: [], result: null, error: null, cancelled: false, humanIntervention: false,
      }
      runs.set(journal.id, journal)
      if (runs.size > 30) {
        const firstKey = runs.keys().next().value
        if (firstKey !== undefined) runs.delete(firstKey)
      }
      executePipeline(journal, agent, journal.requirement, journal.options, signal)
      return journal.id
    }

    function cancelRun(runId) {
      const j = runs.get(runId)
      if (!j) return false
      j.cancelled = true
      const entry = inFlight.get(runId)
      if (entry && entry.run) { try { entry.run.dispose() } catch (e) { /* ignore */ } }
      return true
    }

    /* ── RPC（供 web client 面板） ─────────────────────────────────── */
    harness.handle('teamflow/ping', async () => ({ ok: true }))
    harness.handle('teamflow/list', async () => {
      const arr = []
      for (const j of runs.values()) arr.push(j)
      arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      return { runs: arr.slice(0, 30).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, requirement: clip(j.requirement, 60) })) }
    })
    harness.handle('teamflow/snapshot', async (args) => {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      if (id) {
        const j = runs.get(id)
        return j ? snapshotOf(j) : null
      }
      const latest = listRuns()[0]
      if (!latest) return null
      const j = runs.get(latest.id)
      return j ? snapshotOf(j) : null
    })
    harness.handle('teamflow/start', async (args) => {
      const sessionId = args && typeof args.sessionId === 'string' ? args.sessionId : null
      const requirement = args && typeof args.requirement === 'string' && args.requirement.trim() ? args.requirement.trim() : null
      if (!sessionId || !requirement) return { ok: false, error: '缺少 sessionId 或需求描述' }
      const agent = agents.get(sessionId)
      if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sessionId}` }
      try {
        const opts = (args && args.options && typeof args.options === 'object') ? args.options : {}
        const runId = startPipeline(agent, requirement, opts)
        return { ok: true, runId, product: opts.productRoot ? normalizeRoot(opts.productRoot) : null }
      } catch (e) {
        return { ok: false, error: String((e && e.message) || e) }
      }
    })
    harness.handle('teamflow/cancel', async (args) => {
      const id = args && typeof args.runId === 'string' ? args.runId : null
      if (!id) return { ok: false, error: '缺少 runId' }
      return { ok: cancelRun(id) }
    })
    harness.handle('teamflow/backlog', async (args) => {
      const product = args && typeof args.product === 'string' ? normalizeRoot(args.product) : null
      return backlogSummary(product)
    })
    harness.handle('teamflow/backlogUpdate', async (args) => {
      const kind = args && String(args.kind || '')
      const id = args && String(args.id || '')
      const to = args && String(args.to || '')
      if (!kind || !id || !to) return { ok: false, error: '缺少 kind/id/to' }
      const product = args && typeof args.product === 'string' ? normalizeRoot(args.product) : null
      return transitionBacklog(product, kind, id, to, args.reason ? String(args.reason) : '人工流转')
    })

    function listRuns() {
      const arr = []
      for (const j of runs.values()) arr.push(j)
      arr.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
      return arr.slice(0, 30).map((j) => ({ id: j.id, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt, agentsStarted: j.agentsStarted, stageCount: j.stages.length, requirement: clip(j.requirement, 60) }))
    }
    function snapshotOf(j) {
      return {
        id: j.id, name: j.name, status: j.status, startedAt: j.startedAt, endedAt: j.endedAt,
        requirement: clip(j.requirement, 2000), options: sanitizeSnapOptions(j.options), agentsStarted: j.agentsStarted,
        humanIntervention: j.humanIntervention === true,
        stages: j.stages.map((s) => ({ seq: s.seq, label: s.label, phase: s.phase, status: s.status, outcome: s.outcome, childId: s.childId, startedAt: s.startedAt, endedAt: s.endedAt, tokens: s.tokens, summary: clip(s.summary || '', 3000) })),
        logs: j.logs.slice(-200).map((l) => ({ t: l.t, level: l.level, message: clip(l.message, 500) })),
        error: j.error, resultPreview: j.result ? clip(JSON.stringify(j.result), 6000) : null,
      }
    }
    function backlogSummary(product) {
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
    function transitionBacklog(product, kind, id, to, reason) {
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

    /* ── 模型工具 ──────────────────────────────────────────────────── */
    const simple = { type: 'object', additionalProperties: true }
    const simpleRender = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 4000) }]
    const T = (tool) => ctx.tools.register(tool)

    T({
      name: 'teamflow_start',
      description: '启动团队研发流水线：产品经理产出 PRD（基于既有模式/产品记忆，文档归档防臃肿）→（涉及 UI 改造时）UI/UX 设计 →（新项目时）架构师规划并落地脚手架 + AGENTS.md → 高级全栈工程师技术方案（与派发任务对齐）→ 可拆分任务时按并发并行开发 → QA 功能测试（结构化缺陷→登记 Bug）→ 产品验收（更新产品记忆）。阶段失败自动重试，超阈值打回并需人工介入；每阶段记录 token 用量；backlog 持久化到 $DSH_HOME/teamflow/<product>/。当用户提出开发需求时调用它，带上 productRoot（如 products/tetris）。',
      parameters: {
        requirement: { type: 'string', required: true, description: '用户的需求描述' },
        needDesign: { type: 'boolean', description: '涉及 UI 改造时设为 true' },
        needScaffold: { type: 'boolean', description: '项目尚未建立时设为 true' },
        productRoot: { type: 'string', description: '产品线目录（如 products/tetris）' },
        maxConcurrency: { type: 'integer', description: '开发任务并发数（默认 3，最大 8）' },
        tasks: {
          type: 'array',
          description: '可拆分的开发任务列表（可选）',
          items: {
            type: 'object', additionalProperties: false,
            properties: {
              title: { type: 'string', required: true, description: '任务标题' },
              spec: { type: 'string', description: '任务描述与验收要点' },
            },
          },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { runId: { type: 'string', required: true }, status: { type: 'string', required: true } } },
        render: (args, value) => [{ type: 'text', text: `团队研发流水线已启动（runId=${value.runId}，${value.status}）。可看面板或 teamflow_status 查询进度/阶段 token；backlog 已持久化到 $DSH_HOME/teamflow。` }],
      },
      async execute(args, exec) {
        const parent = exec && exec.agent
        if (!parent) throw new Error('teamflow_start 需要由会话内的 Agent 调用')
        try {
          const requirement = typeof args.requirement === 'string' && args.requirement.trim() ? args.requirement.trim() : '(未提供需求)'
          const options = {
            needDesign: !!args.needDesign,
            needScaffold: !!args.needScaffold,
            tasks: normalizeTasks(args.tasks),
            productRoot: normalizeRoot(args.productRoot),
            maxConcurrency: args.maxConcurrency,
          }
          const runId = startPipeline(parent, requirement, options, exec && exec.signal)
          return { runId, status: 'running' }
        } catch (e) {
          throw new Error(`启动流水线失败：${String((e && e.message) || e)}`)
        }
      },
    })

    T({
      name: 'teamflow_status',
      description: '查询团队研发流水线状态。带 runId 返回该运行完整进度（阶段/每 Agent 状态与 token/日志/结果/是否需人工）；不带 runId 返回最近运行列表。',
      parameters: { runId: { type: 'string', description: '流水线运行 ID（可选）' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
      async execute(args) {
        const id = args && typeof args.runId === 'string' ? args.runId : null
        if (id) {
          const j = runs.get(id)
          if (!j) return { error: `未找到运行：${id}` }
          return { runId: j.id, status: j.status, snapshot: snapshotOf(j) }
        }
        return { runs: listRuns().slice(0, 10) }
      },
    })

    T({
      name: 'teamflow_backlog',
      description: '查看团队 backlog：给定产品线（缺省返回默认产品）展示需求/任务/缺陷及其状态机（需求: 立项→进行中→待验收/已验收；任务: 待办→开发中→待测试→测试中→待验收→完成|打回|需人工；缺陷: 待认领→处理中→已修复待验→已关闭）。返回 persistence（mode=fs/durable=true，含真实落盘路径）。',
      parameters: { product: { type: 'string', description: '产品线目录（如 products/tetris）；缺省看默认产品' } },
      output: { schema: { type: 'object', additionalProperties: true }, render: simpleRender },
      async execute(args) {
        const product = args && typeof args.product === 'string' ? normalizeRoot(args.product) : null
        return backlogSummary(product)
      },
    })

    T({
      name: 'teamflow_claim',
      description: '开发认领 backlog 里的任务或缺陷（task 置为 running 开发中 / bug 置为 claimed 处理中），设置 owner。用于认领待办或 QA 登记的缺陷。',
      parameters: {
        kind: { type: 'string', required: true, description: 'req | task | bug' },
        id: { type: 'string', required: true, description: '记录 id（如 task-3 / bug-1）' },
        product: { type: 'string', description: '产品线目录' },
      },
      output: { schema: simple, render: simpleRender },
      async execute(args) {
        const store = storeFor(normalizeRoot(args.product))
        const item = store.find(String(args.kind), String(args.id))
        if (!item) return { ok: false, error: `找不到 ${args.kind} #${args.id}` }
        const to = String(args.kind) === 'bug' ? 'claimed' : String(args.kind) === 'task' ? 'running' : 'in-progress'
        store.pushEvent(item, item.status, to, '开发认领')
        item.owner = (item.owner || '') || `team${Math.floor(Math.random() * 900 + 100)}`
        store.persist()
        return { ok: true, item: { id: item.id, status: item.status, owner: item.owner } }
      },
    })

    T({
      name: 'teamflow_update',
      description: '人工推进/处理 backlog 记录的状态，用于处理「需人工介入」或缺陷循环：task→accepted(完成)/rework(打回)/running/testable/testing/pending-acceptance；bug→claimed(认领)/fixed(已修复)/verified(已验证关闭)/reopened(重开)/needs-human；req→accepted(验收通过)/closed(关闭)/needs-human。处理 needs-human 时请用一个合法终态（如 accepted/verified/closed）清除标记。',
      parameters: {
        kind: { type: 'string', required: true, description: 'req | task | bug' },
        id: { type: 'string', required: true, description: '记录 id' },
        to: { type: 'string', required: true, description: '目标状态' },
        product: { type: 'string', description: '产品线目录' },
        reason: { type: 'string', description: '变更原因' },
      },
      output: { schema: simple, render: simpleRender },
      execute: async (args) => transitionBacklog(normalizeRoot(args.product), String(args.kind), String(args.id), String(args.to), args.reason ? String(args.reason) : '人工流转'),
    })

    T({
      name: 'teamflow_cancel',
      description: '取消一条正在运行的团队研发流水线。',
      parameters: { runId: { type: 'string', required: true, description: '流水线运行 ID' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? `已请求取消流水线 ${args.runId}` : '取消失败' }] },
      async execute(args) {
        const id = args && typeof args.runId === 'string' ? args.runId : null
        return { ok: id ? cancelRun(id) : false }
      },
    })

    console.log(`[teamflow] host 就绪：backlog 根 ${teamflowRoot()}，工具 6 个，RPC 8 个`)
  },
}
