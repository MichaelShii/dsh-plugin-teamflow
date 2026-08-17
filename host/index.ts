/**
 * dsh-plugin-teamflow — host half（阶段 3：TypertRemoteService 版本）。
 *
 * TeamFlow 团队研发流水线宿主数据层：
 * - backlog 持久化到 $DSH_HOME/teamflow/<product>/backlog/{requirements,tasks,bugs}.json
 * - 状态机 + 事件日志 + 打回阈值 + 并发池 + QA 缺陷登记 + token 计量
 * - 以 Cordis service `teamflow` 提供 7 个 Remote 方法（client 经 ctx.remote.teamflow.* 调用），
 *   strict descriptors 由 ctx.typert.register 注册（免 @Remote 装饰器）
 * - 注册 teamflow_* 模型工具（供 Agent 调用）
 *
 * 运行环境：宿主组合（web profile）的真实 Node 进程。
 */
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { TEAMFLOW_DESCRIPTORS } from '../descriptors.ts'
import {
  dshHome, teamflowRoot, productDir, fileFor,
  readJson, readJsonAny, writeJson, persistJournal, loadJournals, journalFile,
} from '../store.ts'
import type { JournalRecord, JournalStage } from '../store.ts'

/* ── 核心类型（strip-types 可剥离：无 enum/namespace/装饰器） ─────── */
/** 流水线运行日志（运行时对象，含 result 等非持久化字段）。 */
interface Journal extends JournalRecord {
  result?: { requirement?: string; options?: unknown; timeline?: Record<string, unknown> } | null
  stages: JournalStage[]
  logs: Array<{ t: number; level: string; message: string }>
}
/** backlog 记录（需求/任务/缺陷通用形状）。 */
interface BacklogItem {
  id: string
  status: string
  title?: string
  humanIntervention?: boolean
  retries?: number
  severity?: string
  owner?: string | null
  summary?: string | null
  [key: string]: unknown
}
/** 流水线启动选项。 */
interface PipelineOptions {
  needDesign?: boolean
  needScaffold?: boolean
  tasks?: unknown
  productRoot?: string | null
  maxConcurrency?: number
}
/** 断点续跑上下文。 */
interface ResumeContext {
  phase: string
  products: Record<string, unknown>
}
/** 子代理运行句柄的鸭子类型（避免强依赖内部类型）。 */
interface SubagentRunLike {
  id: string
  result: Promise<unknown>
  dispose(): Promise<void> | void
  localAgent?: { session?: unknown }
}

const RETRY_LIMIT = 2
/** 单阶段 token 熔断预算（子代理会话上下文压力估算累计）。 */
const STAGE_TOKEN_BUDGET = 60000
/** 假阳性完成检测：明确拒绝/放弃模式的输出视为未产出。 */
const REFUSAL_PATTERN = /(无法完成|不能完成|无法继续|抱歉|对不起|我(无法|不能)|无法执行|cannot complete|unable to)/i
/** 各阶段最小产出长度（防"假完成"：空话/一句话冒充交付）。 */
const STAGE_MIN_LENGTH = { prd: 400, design: 250, arch: 250, tech: 350, dev: 60, qa: 250, acceptance: 150 }

/** 产出物实质校验：非空 + 无拒绝词 + 达到阶段长度下限。 */
function hasSubstance(phase: string, text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false
  if (REFUSAL_PATTERN.test(text)) return false
  const min = STAGE_MIN_LENGTH[phase] ?? 100
  return text.trim().length >= min
}

/** 不可重试的失败原因（上下文耗尽/超长等——重试同一 prompt 大概率复现）。 */
function isUnretryable(reason: unknown, outcome: unknown): boolean {
  const r = String(reason || outcome || '')
  return /context|limit|max-token|token|tool-error/i.test(r)
}

/* ── 状态机 ───────────────────────────────────────────────────────── */
const STATUS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human', 'closed'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}

class BacklogStore {
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
/**
 * 产品名白名单归一化：只允许 [a-zA-Z0-9_-] 组成的路径段（可含 / 分隔）。
 * 拒绝：绝对路径、盘符、. / .. 段、空段、空白字符 —— 防止穿越 $DSH_HOME 写任意目录。
 * @returns {string|null} 归一化后的安全产品名，非法输入返回 null。
 */
function normalizeRoot(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim().replace(/\\/g, '/')
  if (s.startsWith('/') || s.startsWith('.')) return null // 绝对路径、./、../、..
  if (/^[a-zA-Z]:/.test(s)) return null // 盘符（C:\x）
  if (s.includes('//') || s.includes('..')) return null // 空段、穿越段
  const segments = s.split('/')
  for (const seg of segments) {
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) return null // 每段仅字母数字下划线连字符
  }
  return segments.join('/')
}
function normalizeTasks(tasks: unknown): Array<{ title: string; spec: string }> {
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
/**
 * AGENTS.md 模板 v2 —— 共识层 + TeamFlow 托管区。
 * 原则：AGENTS.md 是团队资产（会被所有 Agent 无条件注入），只放稳定共识层与文档索引；
 * 产品记忆/待办等高频运营数据放 docs/teamflow/memory.md（按需读取），绝不写进本文件。
 * TeamFlow 只维护 <!-- teamflow:begin/end --> 托管区；其余内容团队所有，不得改写。
 */
const AGENTS_TEMPLATE = `# AGENTS.md — 团队协作守则与文档索引（{{PRODUCT}} 产品线）

> 任何新加入本产品的 Agent（团队成员）必须先通读本文件，再按 §2 文档索引读取相关文档与任务卡片，不要自行全量探索项目。
> 维护者：团队本身 + TeamFlow 研发流水线（TeamFlow 仅维护文末 <!-- teamflow --> 托管区，其余内容为团队资产，不得改写）。

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
| 产品记忆/待办 | docs/teamflow/memory.md | TeamFlow 维护：迭代历史与下一批待办（按需读取） |
| 历史归档 | docs/history/<版本>/ | 已发布版本快照（日常不读） |

## 3. 团队角色与标准流程

**角色**：产品经理 / UI/UX 设计师 / 架构师 / 高级全栈工程师 / QA 测试工程师。

**标准流程**：需求 → PRD →（UI 改造时）UI/UX 设计 →（新项目时）架构规划 → 技术方案 → 并行开发 → QA 测试 → 产品验收。

**产出物落盘约定**：PRD → docs/prd/；设计 → docs/design/；架构 → docs/architecture/；技术方案 → docs/technical/；QA 报告 → docs/qa/；产品记忆 → docs/teamflow/memory.md。

**完成度自查**：每个环节交付前对照职责清单自查，未完成不得流转；架构师对新项目必须实际初始化脚手架文件与 AGENTS.md 草稿。

**文档归档**：更新活文档前，先把当前版本快照复制到 docs/history/<版本>/（防臃肿，见 docs/SUMMARY.md）。

## 4. 工程约定

（架构师按实际技术栈填写：代码形态、契约、验证命令、风格约定）

<!-- teamflow:begin -->
## TeamFlow 托管区（本块由 TeamFlow 自动维护，团队请勿手改）

- 产品记忆（迭代历史）与待办：docs/teamflow/memory.md
- 需求/任务/缺陷 backlog：backlog/（持久化镜像位于 $DSH_HOME/teamflow/<product>/）
- 规则：TeamFlow 只维护本块与 docs/teamflow/ 目录；本文件其余内容为团队资产。
<!-- teamflow:end -->

## 5. 变更记录

- {{DATE}}：创建本文件（TeamFlow 脚手架）。
`

const MEMORY_TEMPLATE = `# {{PRODUCT}} 产品记忆与待办（TeamFlow 维护）

> 由 TeamFlow 流水线的产品经理在每次验收后追加；按需读取，不注入每次会话（AGENTS.md 只放指针）。
> 这是团队资产的活文档：团队可自行增删，TeamFlow 只追加迭代记录与待办。

## 迭代历史

| 版本 | 日期 | 需求 | 结果 | runId |
|---|---|---|---|---|
|（验收后由产品经理追加一行）|

## 已知待办（下一批）

- （验收后由产品经理更新：划掉已完成、补充新发现）

## 说明

- backlog（需求/任务/缺陷）事实源：backlog/*.json（持久化镜像 $DSH_HOME/teamflow/<product>/）
- 本文件与 AGENTS.md 的 <!-- teamflow --> 托管区共同构成 TeamFlow 的记忆层
`

function productCtx(root) {
  const base = root || 'products/<product>'
  return `【产品线约定】本需求属于产品 ${base}。
开工前先读 ${base}/AGENTS.md（团队守则与文档索引）与 ${base}/docs/SUMMARY.md（文档摘要索引，先读摘要、按需精读，不要无目的全量通读）；
产品记忆（迭代历史）与待办在 ${base}/docs/teamflow/memory.md（按需读取）；
【AGENTS.md 边界】AGENTS.md 是团队资产：除文末 <!-- teamflow:begin/end --> 托管区外，任何环节都不得改写、重排或覆盖其中的内容（产品记忆请写入 docs/teamflow/memory.md）；
若目录尚不存在，按约定创建 ${base}/ 结构（docs/<职责>/、docs/teamflow/、backlog/）。
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
2. 若本产品已有历史 PRD（docs/prd/PRD.md）或 docs/teamflow/memory.md 产品记忆：这是迭代需求——先读 docs/SUMMARY.md、历史 PRD 修订记录与产品记忆，输出增量 PRD（保留既有 AC 编号与语义，压缩旧 AC 的冗长表述，显式标注本次变更），并升级版本号。
3. 【文档归档】更新活文档之前，先把当前 PRD 快照复制到 docs/history/<旧版本号>/（目录不存在则创建），再写新版；历史快照日常不读。
4. 输出完整 PRD（Markdown）：背景与目标、用户故事（含逐条可测试的验收标准）、功能范围与非目标、交互流程概述、优先级(P0/P1/P2)、依赖与风险、里程碑建议。
5. 验收标准必须可测试、可量化；文档精炼优先，避免无限膨胀。
6. 产出写入 docs/prd/PRD.md；同步更新 docs/teamflow/memory.md 的产品记忆（新迭代需求、目标版本）。【边界】不得改写 AGENTS.md 除 teamflow 托管区以外的内容。`

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
   a) 若产品根尚不存在，创建目录结构（docs/<职责>/、docs/teamflow/、backlog/ 等）；
   b) 初始化脚手架文件（package.json、配置、入口等按方案实际创建，不得只写方案不落地）；
   c) 【AGENTS.md 处理】二选一：
      - 产品根已有 AGENTS.md（团队已有约定）：**绝不重写、不重排、不覆盖**。若文件末尾没有
        <!-- teamflow:begin --> 块，则原样保留全部内容，仅在文末追加一个
        <!-- teamflow:begin -->…<!-- teamflow:end --> 托管块（含指向 docs/teamflow/memory.md
        与 backlog/ 的索引行）；若已有托管块，跳过。其余内容一行不动。
      - 产品根尚无 AGENTS.md：基于下方模板创建（共识层 + 文档索引 + teamflow 托管区），
        并创建 docs/SUMMARY.md（摘要索引）与 docs/teamflow/memory.md（按下方的 memory.md 骨架，替换 {{占位符}}）；
   d) 输出完成度自查清单：已落地项 / 未落地项及原因——未完成项必须显式列出，不得宣称全部完成。
4. 若工作区已有部分文件，先阅读并尊重现状。
5. 输出中文 Markdown，精炼完整；方案文档写入 docs/architecture/ARCHITECTURE.md。

【AGENTS.md 模板】
${AGENTS_TEMPLATE}

【memory.md 骨架】
${MEMORY_TEMPLATE}`

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
3. 【记忆回写】产品记忆写入 docs/teamflow/memory.md：在「迭代历史」表追加一行（版本/日期/需求/结果/runId），更新「已知待办」（划掉已完成、补充新发现）；若 PRD 结构变化，同步更新 docs/SUMMARY.md。【边界】不得改写 AGENTS.md 除 <!-- teamflow --> 托管区以外的内容（托管区也不放流水账，只放指针）。
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

/* ── 模块级运行状态（service 为进程单例）─────────────────────────── */
const runs = new Map()
const inFlight = new Map()
const stores = new Map()
/** 产品级并发限制：product → 活跃 runId（同一产品同时只允许一条流水线，防 req 状态互踩）。 */
const activeProducts = new Map()
let ACTIVE = { agents: undefined, subagents: undefined, tokenMeter: undefined }

const storeFor = (product) => {
  const key = product || 'default'
  let s = stores.get(key)
  if (!s) { s = new BacklogStore(key); stores.set(key, s) }
  return s
}
const providerName = () => {
  const subagents = ACTIVE.subagents
  if (!subagents) return null
  const names = subagents.list()
  if (names.indexOf('spawn') !== -1) return 'spawn'
  return names.length > 0 ? names[0] : null
}
const measureTokens = (run) => {
  const tokenMeter = ACTIVE.tokenMeter
  if (!tokenMeter || !run || !run.localAgent) return null
  try {
    const m = tokenMeter.measure(run.localAgent.session)
    return (m && typeof m.totalTokens === 'number') ? m.totalTokens : null
  } catch (e) { return null }
}

async function runAgent(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown,
): Promise<string | null> {
  const maxSeq = journal.stages.length ? Math.max(...journal.stages.map((s) => s.seq)) : 0
  const stage = {
    seq: maxSeq + 1, label, phase, status: 'running', outcome: null,
    childId: null, startedAt: Date.now(), endedAt: null, summary: null, tokens: null, output: null,
  }
  journal.stages.push(stage)
  journal.agentsStarted += 1
  let run = null
  try {
    run = await ACTIVE.subagents.start(providerName(), {
      label,
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: normalizeSignal(signal),
    })
    stage.childId = run.id
    inFlight.set(journal.id, { run, stage })
    try {
      if (parent && parent.session && typeof parent.session.append === 'function') {
        parent.session.append('tool-workflow/agent-start', {
          runId: journal.id, seq: stage.seq, label, phase, childId: run.id,
        })
      }
    } catch (e) { /* 轨迹写入失败不影响主流程 */ }
    const result = await run.result
    const stop = result && result.stopReason
    const text = extractText(result && result.output)
    if (journal.cancelled) {
      stage.status = 'cancelled'; stage.outcome = 'cancelled'
      return null
    }
    if (stop === 'completed' && text && hasSubstance(phase, text)) {
      stage.status = 'done'; stage.outcome = 'completed'
      stage.output = clip(text, 50000) // 阶段产物全文（断点续跑重建上下文）
      return text
    }
    stage.status = 'failed'
    stage.outcome = (stop === 'completed' && text) ? 'insubstantial' : (stop || 'error')
    if (stage.outcome === 'insubstantial') {
      stage.summary = '产出未通过实质校验（含拒绝措辞或内容过短），视为未交付'
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 产出未通过实质校验（拒绝措辞/内容过短）` })
    } else {
      stage.summary = `未产出有效结果（stopReason=${stop || 'unknown'}）`
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 未产出有效结果（stopReason=${stop || 'unknown'}）` })
    }
    return null
  } catch (e) {
    stage.status = journal.cancelled ? 'cancelled' : 'failed'
    stage.outcome = journal.cancelled ? 'cancelled' : 'error'
    stage.summary = `启动/执行失败：${String((e && e.message) || e)}`
    journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 启动/执行失败：${String((e && e.message) || e)}` })
    return null
  } finally {
    stage.tokens = measureTokens(run)
    stage.endedAt = Date.now()
    if (inFlight.get(journal.id) && inFlight.get(journal.id).stage === stage) inFlight.delete(journal.id)
    if (run) { try { await run.dispose() } catch (e2) { /* ignore */ } }
  }
}

async function withRetry(
  journal: Journal, parent: unknown, label: string, phase: string, prompt: string, signal: unknown,
): Promise<{ text: string | null; attempts: number; stageTokens: number }> {
  let attempts = 0
  let stageTokens = 0
  for (let attempt = 1; attempt <= RETRY_LIMIT; attempt++) {
    attempts = attempt
    const labelNow = attempt > 1 ? `${label}（第 ${attempt} 次重试）` : label
    const result = await runAgent(journal, parent, labelNow, phase, prompt, signal)
    // 累计本阶段各次尝试的 token 用量（熔断预算）
    const lastStage = journal.stages[journal.stages.length - 1]
    if (lastStage && lastStage.phase === phase && typeof lastStage.tokens === 'number') {
      stageTokens += lastStage.tokens
    }
    if (result) return { text: result, attempts, stageTokens }
    if (journal.cancelled) return { text: null, attempts, stageTokens }
    // 不可重试失败（上下文耗尽等）：重试同一 prompt 大概率复现 → 直接需人工
    if (lastStage && isUnretryable(lastStage.outcome, lastStage.outcome)) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 失败原因不可重试（${lastStage.outcome}），跳过重试，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens }
    }
    // token 熔断：本阶段累计用量超预算 → 停止重试
    if (stageTokens >= STAGE_TOKEN_BUDGET) {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 累计 token ${Math.round(stageTokens / 1000)}k 超出阶段预算 ${Math.round(STAGE_TOKEN_BUDGET / 1000)}k，熔断，需人工介入` })
      journal.humanIntervention = true
      return { text: null, attempts, stageTokens }
    }
    if (attempt < RETRY_LIMIT) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: `${label} 第 ${attempt} 次尝试未成功，自动重试…` })
    } else {
      journal.logs.push({ t: Date.now(), level: 'error', message: `${label} 连续 ${RETRY_LIMIT} 次尝试失败，超出重试阈值，需人工介入` })
      journal.humanIntervention = true
    }
  }
  return { text: null, attempts, stageTokens }
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
  mkTask('prd', 'PRD 产品需求')
  if (options.needDesign) mkTask('design', 'UI/UX 设计')
  if (options.needScaffold) mkTask('arch', '架构规划与落地')
  mkTask('tech', '技术方案')
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
  persistJournal(journal) // 阶段状态变化 → checkpoint
}

const PHASE_ORDER = ['PRD 产品需求', 'UI/UX 设计', '架构规划', '技术方案', '开发', 'QA 测试', '产品验收']
const PHASE_KEY_OF = { prd: 'PRD 产品需求', design: 'UI/UX 设计', scaffold: '架构规划', tech: '技术方案', dev: '开发', qa: 'QA 测试', acceptance: '产品验收' }
const PHASE_KEY_BY_NAME = { 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' }

/** 从 journal 已完成阶段重建断点续跑产物（prd/design/scaffold/tech/qa/acceptance/dev）。 */
function buildResumeProducts(journal) {
  const products = {}
  for (const s of journal.stages) {
    if (s.status !== 'done' || !s.output) continue
    const key = PHASE_KEY_BY_NAME[s.phase]
    if (!key) continue
    if (key === 'dev') {
      products.dev = journal.stages
        .filter((x) => x.phase === '开发' && x.status === 'done' && x.output)
        .map((x) => ({ title: x.label.replace(/^开发 · /, ''), failed: false, output: x.output }))
    } else {
      products[key] = s.output
    }
  }
  return products
}

/**
 * 断点续跑起点：journal 中第一个未完成阶段（磁盘上 interrupted/running 所在阶段）。
 * 全部完成仍被中断（理论极端）→ 从产品验收继续。
 */
function interruptedPhaseOf(journal) {
  const stage = (journal.stages || []).find((s) => s.status !== 'done')
  if (stage && PHASE_ORDER.indexOf(stage.phase) !== -1) return stage.phase
  return '产品验收'
}

/**
 * 执行流水线。resume = null 全新运行；resume = { phase, products } 从断点续跑：
 * phase 之前的阶段直接复用 products 产物（跳过执行），从 phase 阶段开始重跑。
 */
async function executePipeline(
  journal: Journal, parent: unknown, requirement: string, options: PipelineOptions,
  signal: unknown, resume: ResumeContext | null = null,
): Promise<void> {
  journal.status = 'running'
  if (!resume) journal.startedAt = Date.now()
  const root = options.productRoot || null
  journal.product = root
  const productKey = root || 'default'
  // 产品级并发限制（防御：正常入口 startPipeline/resumeRun 已预检）
  if (activeProducts.has(productKey) && activeProducts.get(productKey) !== journal.id) {
    journal.status = 'failed'
    journal.error = `产品 ${productKey} 已有流水线 ${activeProducts.get(productKey)} 运行中`
    journal.endedAt = Date.now()
    persistJournal(journal)
    return
  }
  activeProducts.set(productKey, journal.id)
  const tasks = normalizeTasks(options.tasks)
  const maxConcurrency = Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, 8) : 3
  const timeline = {}
  // 断点续跑：跳过 resume.phase 之前的阶段
  const resumed = (phase) => !!resume && PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(resume.phase)
  const logSkip = (phase) => journal.logs.push({ t: Date.now(), level: 'warn', message: `跳过已完成阶段：${phase}（断点续跑）` })
  try {
    if (resume) {
      journal.logs.push({ t: Date.now(), level: 'info', message: `断点续跑：复用 backlog（req=${journal.reqId}），从「${resume.phase}」继续` })
    } else {
      const init = initPipelineBacklog(journal, requirement, options)
      journal.reqId = init.reqId
      journal.logs.push({ t: Date.now(), level: 'info', message: `backlog 已建立需求 ${init.reqId}（产品 ${root || 'unknown'}，并发 ${maxConcurrency}）` })
    }
    persistJournal(journal)

    /* ── PRD 阶段 ── */
    let prd = null
    if (resumed('PRD 产品需求')) {
      prd = resume.products.prd
      timeline.prd = prd
      logSkip('PRD 产品需求')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：PRD 产品需求' })
      advanceTask(journal, 'prd', 'running', null, '进入流水线')
      const prdR = await withRetry(journal, parent, '产品经理 · 梳理 PRD', 'PRD 产品需求', prdPrompt(requirement, root), signal)
      if (!prdR.text) { advanceTask(journal, 'prd', 'needs-human', null, 'PRD 失败'); throw new Error(`PRD 阶段失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      prd = prdR.text
      timeline.prd = prd
      advanceTask(journal, 'prd', 'accepted', clip(prd, 300), 'PRD 完成')
      if (journal.cancelled) return
    }

    /* ── UI/UX 设计阶段 ── */
    let design = null
    if (options.needDesign) {
      if (resumed('UI/UX 设计')) {
        design = resume.products.design
        timeline.design = design
        logSkip('UI/UX 设计')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：UI/UX 设计' })
        advanceTask(journal, 'design', 'running', null, '进入流水线')
        const designR = await withRetry(journal, parent, 'UI/UX 设计师 · 设计说明', 'UI/UX 设计', designPrompt(prd, root), signal)
        if (!designR.text) { advanceTask(journal, 'design', 'needs-human', null, 'UI 设计失败'); throw new Error(`UI/UX 设计失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        design = designR.text
        timeline.design = design
        advanceTask(journal, 'design', 'accepted', clip(design, 300), 'UI 设计完成')
        if (journal.cancelled) return
      }
    }

    /* ── 架构规划阶段 ── */
    let scaffold = null
    if (options.needScaffold) {
      if (resumed('架构规划')) {
        scaffold = resume.products.scaffold
        timeline.scaffold = scaffold
        logSkip('架构规划')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：架构规划' })
        advanceTask(journal, 'arch', 'running', null, '进入流水线')
        const scR = await withRetry(journal, parent, '架构师 · 脚手架规划与落地', '架构规划', scaffoldPrompt(requirement, design, root), signal)
        if (!scR.text) { advanceTask(journal, 'arch', 'needs-human', null, '架构规划失败'); throw new Error(`架构规划失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
        scaffold = scR.text
        timeline.scaffold = scaffold
        advanceTask(journal, 'arch', 'accepted', clip(scaffold, 300), '架构完成')
        if (journal.cancelled) return
      }
    }

    /* ── 技术方案阶段 ── */
    let tech = null
    if (resumed('技术方案')) {
      tech = resume.products.tech
      timeline.tech = tech
      logSkip('技术方案')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：技术方案' })
      advanceTask(journal, 'tech', 'running', null, '进入流水线')
      const techR = await withRetry(journal, parent, '高级全栈工程师 · 技术方案', '技术方案', techPrompt(prd, design, scaffold, tasks, root), signal)
      if (!techR.text) { advanceTask(journal, 'tech', 'needs-human', null, '技术方案失败'); throw new Error(`技术方案失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      tech = techR.text
      timeline.tech = tech
      advanceTask(journal, 'tech', 'accepted', clip(tech, 300), '技术方案完成')
      if (journal.cancelled) return
    }

    /* ── 开发阶段（并发池；resume 到 QA/验收时复用旧结果） ── */
    let devResults = null
    if (resumed('开发')) {
      devResults = resume.products.dev || []
      timeline.dev = devResults
      logSkip('开发')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：开发' })
      const devTaskDefs = tasks.length > 0 ? tasks : [{ title: '整体开发', spec: '按技术方案实现全部需求' }]
      journal.logs.push({ t: Date.now(), level: 'info', message: `开发阶段开始，任务数：${devTaskDefs.length}（并发 ${maxConcurrency}）` })
      const store = storeFor(root)
      devResults = await runPool(devTaskDefs, maxConcurrency, async (task) => {
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
      journal.logs.push({ t: Date.now(), level: 'info', message: `开发完成，失败任务数：${failedCount}` })
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── QA 测试阶段 ── */
    let qa = null
    if (resumed('QA 测试')) {
      qa = resume.products.qa
      timeline.qa = qa
      logSkip('QA 测试')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：QA 测试' })
      advanceTask(journal, 'qa', 'running', null, '进入流水线')
      const qaR = await withRetry(journal, parent, 'QA 测试工程师 · 功能测试', 'QA 测试', qaPrompt(prd, JSON.stringify(timeline.dev), root), signal)
      if (!qaR.text) { advanceTask(journal, 'qa', 'needs-human', null, 'QA 失败'); throw new Error(`QA 失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
      qa = qaR.text
      timeline.qa = qa
      advanceTask(journal, 'qa', 'accepted', clip(qa, 300), 'QA 完成')
      const store = storeFor(root)
      const defects = parseDefects(qa)
      if (defects.length > 0) {
        const req = store.find('req', journal.reqId)
        defects.slice(0, 8).forEach((d) => {
          const id = store.nextId('bug')
          const b = { id, reqId: journal.reqId, taskId: journal.taskMap['qa'] || null, severity: d.severity, title: `QA 缺陷：${d.module || d.id}`, reproduce: '', expected: '', actual: '', ac: '', status: 'open', owner: null, retries: 0, humanIntervention: false, createdAt: Date.now(), updatedAt: Date.now(), events: [] }
          store.bugs.push(b)
          if (req) { req.bugIds.push(id); req.status = 'pending-acceptance'; req.updatedAt = Date.now() }
        })
        store.persist()
        journal.logs.push({ t: Date.now(), level: 'warn', message: `QA 发现 ${defects.length} 个缺陷，已登记到 backlog（需开发认领）` })
      } else {
        journal.logs.push({ t: Date.now(), level: 'info', message: 'QA 未发现 P0/P1/P2 缺陷（未登记 Bug）' })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

    /* ── 产品验收阶段（总是执行） ── */
    journal.logs.push({ t: Date.now(), level: 'phase', message: '进入阶段：产品验收' })
    advanceTask(journal, 'acceptance', 'running', null, '进入流水线')
    const accR = await withRetry(journal, parent, '产品经理 · 最终验收', '产品验收', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root), signal)
    if (!accR.text) { advanceTask(journal, 'acceptance', 'needs-human', null, '验收失败'); throw new Error(`验收失败：重试 ${RETRY_LIMIT} 次后仍无产出，需人工介入`) }
    const acceptance = accR.text
    timeline.acceptance = acceptance
    advanceTask(journal, 'acceptance', 'accepted', clip(acceptance, 300), '验收完成')
    const store = storeFor(root)
    const req = store.find('req', journal.reqId)
    if (req) {
      const openBugs = store.bugs.filter((b) => b.reqId === req.id && b.status !== 'verified' && b.status !== 'closed')
      if (openBugs.length > 0) {
        store.pushEvent(req, req.status, 'pending-acceptance', '存在未关闭缺陷')
      } else {
        store.pushEvent(req, req.status, 'accepted', '验收通过')
      }
    }
    journal.logs.push({ t: Date.now(), level: 'info', message: '流水线全部完成 ✅' })
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
    journal.endedAt = Date.now()
    inFlight.delete(journal.id)
    activeProducts.delete(productKey) // 释放产品级并发锁
    journal.result = { requirement, options: sanitizeSnapOptions(options), timeline: summarizeTimeline(timeline) }
    for (const s of journal.stages) delete s.output // 内存只留摘要（磁盘 journal 已持久化全文）
    persistJournal(journal) // 终态 checkpoint
    deliverCompletion(journal, parent) // 汇总投递回发起会话（主线程）
    console.log(`[teamflow] 运行结束 ${journal.id} → ${journal.status}`)
  }
}

/** 结果 timeline 摘要化（内存只留 2k 级摘要，全文在磁盘 journal/backlog）。 */
function summarizeTimeline(timeline) {
  const out = {}
  for (const key of Object.keys(timeline || {})) {
    const val = timeline[key]
    if (Array.isArray(val)) {
      out[key] = val.map((x) => (x && typeof x === 'object'
        ? { title: x.title, failed: !!x.failed, output: clip(x.output || '', 2000) }
        : clip(x, 2000)))
    } else {
      out[key] = clip(val, 2000)
    }
  }
  return out
}

function startPipeline(agent: unknown, requirement: string, options: PipelineOptions, signal: unknown): string {
  const provider = providerName()
  if (!provider) throw new Error('没有可用的子代理提供者（subagents 注册表为空）')
  const productKey = normalizeRoot(options.productRoot) || 'default'
  const active = activeProducts.get(productKey)
  if (active) throw new Error(`产品 ${productKey} 已有流水线 ${active} 运行中——请等待完成、取消（teamflow_cancel）或先处理中断（teamflow_resume）`)
  const journal = {
    id: `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
    interrupted: false, interruptedAt: null, supersededBy: null,
  }
  runs.set(journal.id, journal)
  if (runs.size > 30) {
    const firstKey = runs.keys().next().value
    if (firstKey !== undefined) runs.delete(firstKey)
  }
  persistJournal(journal) // 首次 checkpoint（断点续跑基座）
  executePipeline(journal, agent, journal.requirement, journal.options, signal)
  return journal.id
}

function cancelRun(runId) {
  const j = runs.get(runId)
  if (!j) return false
  j.cancelled = true
  const entry = inFlight.get(runId)
  if (entry && entry.run) { try { entry.run.dispose() } catch (e) { /* ignore */ } }
  persistJournal(j)
  return true
}

/**
 * 流水线结束汇总投递：把结果通知给发起会话的 Agent（主线程）。
 * - idle Agent → followup（唤醒新 turn，模型可见汇报）
 * - running Agent → inject（注入下一个 step 的上下文，不打断）
 * 投递失败静默（Agent 已销毁/会话关闭等场景）。
 */
function deliverCompletion(journal: Journal, parent: unknown): void {
  try {
    if (!parent || typeof parent.inject !== 'function' || typeof parent.followup !== 'function') return
    const stages = journal.stages || []
    const done = stages.filter((s) => s.status === 'done').length
    const failed = stages.filter((s) => s.status === 'failed' || s.status === 'needs-human').length
    const cancelledStages = stages.filter((s) => s.status === 'cancelled').length
    const totalTokens = stages.reduce((a, s) => a + (typeof s.tokens === 'number' ? s.tokens : 0), 0)
    const statusLine = {
      completed: '✅ 已完成',
      failed: '❌ 失败',
      cancelled: '⏹ 已取消',
      interrupted: '⚠ 中断（可用 teamflow_resume 从断点重跑）',
    }[journal.status] || journal.status
    const stagesLine = stages.length === 0
      ? '尚未进入任何阶段'
      : `${stages.length} 个阶段 · ${done} 完成${failed > 0 ? ` · ${failed} 失败` : ''}${cancelledStages > 0 ? ` · ${cancelledStages} 取消` : ''}`
    const text = [
      `【团队研发流水线汇报】runId=${journal.id}`,
      `状态：${statusLine}${journal.error ? `（${clip(journal.error, 300)}）` : ''}`,
      `阶段：${stagesLine}`,
      `Agent：共启动 ${journal.agentsStarted || 0} 个子代理`,
      totalTokens > 0 ? `Token：∑ ${(totalTokens / 1000).toFixed(1)}k（上下文压力估算）` : 'Token：—',
      journal.product ? `产品：${journal.product}` : '',
      `backlog：需求 ${journal.reqId || '—'}（$DSH_HOME/teamflow/ 持久化）`,
      '用户可打开「🏭 团队工作台」tab 查看阶段泳道、拖拽看板与 token 明细。',
      '如需继续处理：可认领缺陷（teamflow_claim）、人工流转（teamflow_update）、断点重跑（teamflow_resume）。',
      '若用户在场请简明转述以上要点；若无人值守仅记录即可，不必长篇回复。',
    ].filter(Boolean).join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-plugin-teamflow',
        form: 'notice',
        summary: `团队研发流水线 ${journal.status === 'completed' ? '已完成' : journal.status}（runId=${journal.id}）`,
      },
    })
    if (parent.status === 'idle') parent.followup(message)
    else parent.inject(message)
  } catch (e) {
    console.warn('[teamflow] 完成汇报投递失败（忽略）', e?.message)
  }
}

/** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑（service 与工具共用）。 */
function resumeRun(runId: string | null | undefined, sessionId: string | null | undefined): { ok: boolean; runId?: string; resumedFrom?: string; error?: string } {
  const id = typeof runId === 'string' ? runId : null
  if (!id) return { ok: false, error: '缺少 runId' }
  // 从磁盘加载完整 journal（内存版已裁剪 output，磁盘保留阶段产物全文）
  let j = null
  try {
    const disk = readJsonAny(journalFile(id), null)
    if (disk && typeof disk === 'object' && disk.id === id) j = disk
  } catch (e) { /* 落到内存版 */ }
  if (!j) j = runs.get(id)
  if (!j) return { ok: false, error: `未找到运行：${id}` }
  if (j.status !== 'interrupted' && j.status !== 'failed' && j.status !== 'cancelled') {
    return { ok: false, error: `只有 interrupted/failed/cancelled 可续跑（当前 ${j.status}）` }
  }
  const productKey = j.product || 'default'
  if (activeProducts.has(productKey) && activeProducts.get(productKey) !== id) {
    return { ok: false, error: `产品 ${productKey} 已有流水线 ${activeProducts.get(productKey)} 运行中` }
  }
  const sid = typeof sessionId === 'string' ? sessionId : null
  const agent = sid && ACTIVE.agents ? ACTIVE.agents.get(sid) : undefined
  if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sid}` }
  try {
    const resumePhase = interruptedPhaseOf(j)
    const products = buildResumeProducts(j)
    j.status = 'running'
    j.cancelled = false
    j.interrupted = false
    j.interruptedAt = null
    j.error = null
    j.endedAt = null
    j.logs = (j.logs || []).slice(-200)
    j.logs.push({ t: Date.now(), level: 'warn', message: `断点续跑：从「${resumePhase}」继续（已完成阶段复用产物）` })
    j.stages = (j.stages || []).filter((s) => s.status === 'done') // 清理未完成 stage
    runs.set(id, j) // 内存换用磁盘完整版（含 output 全文）
    persistJournal(j)
    executePipeline(j, agent, j.requirement, j.options, undefined, { phase: resumePhase, products })
    return { ok: true, runId: id, resumedFrom: resumePhase }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}

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

/* ── 模型工具注册 ─────────────────────────────────────────────────── */
const simple = { type: 'object', additionalProperties: true }
const simpleRender = (args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2).slice(0, 4000) }]

function registerTools(ctx) {
  // ctx.tools.register() 把 parameters 原样送到 wire：必须先编译成
  // { type: 'object', properties, required } 完整 JSON Schema，否则提供方
  // 以「schema 缺 type: object」拒绝（如 teamflow_backlog invalid_request_error）。
  const T = (tool) => ctx.tools.register({
    ...tool,
    parameters: parameterSchemaSpecToJsonSchema(tool.parameters),
  })

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
      schema: { type: 'object', additionalProperties: false, required: ['runId', 'status'], properties: { runId: { type: 'string' }, status: { type: 'string' } } },
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

  T({
    name: 'teamflow_resume',
    description: '从断点续跑一条中断/失败/已取消的团队研发流水线：跳过已完成阶段（复用产物），从第一个未完成阶段重跑。用于进程重启后发现 interrupted 运行、或阶段失败需要重试的场景。',
    parameters: {
      runId: { type: 'string', required: true, description: '流水线运行 ID' },
    },
    output: { schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' }, runId: { type: 'string' }, resumedFrom: { type: 'string' }, error: { type: 'string' } } }, render: (args, value) => [{ type: 'text', text: value.ok ? `流水线 ${value.runId} 已从断点「${value.resumedFrom}」续跑` : `续跑失败：${value.error || '未知错误'}` }] },
    async execute(args, exec) {
      const parent = exec && exec.agent
      if (!parent) throw new Error('teamflow_resume 需要由会话内的 Agent 调用')
      const id = args && typeof args.runId === 'string' ? args.runId : null
      return resumeRun(id, parent.session.id)
    },
  })
}

/* ── Teamflow Service（宿主 Cordis service + Remote 方法）────────── */
export class TeamflowService extends TypertRemoteService {
  static inject = ['agents', 'subagents', 'tokenMeter', 'typert', 'tools']

  constructor(ctx) {
    super(ctx, 'teamflow')
    ACTIVE = {
      agents: ctx.get('agents'),
      subagents: ctx.get('subagents'),
      tokenMeter: ctx.get('tokenMeter'),
    }
    // 断点续跑基座：加载磁盘 journal；running/pending 残留 → 标记 interrupted
    let interruptedCount = 0
    try {
      for (const { journal, wasInterrupted } of loadJournals()) {
        runs.set(journal.id, journal)
        if (wasInterrupted) interruptedCount++
      }
    } catch (e) {
      console.error('[teamflow] 启动加载 journal 失败', e?.message)
    }
    ctx.typert.register({
      package: 'dsh-plugin-teamflow',
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: TEAMFLOW_DESCRIPTORS,
    })
    registerTools(ctx)
    console.log(
      `[teamflow] host 就绪：backlog 根 ${teamflowRoot()}，Remote ${TEAMFLOW_DESCRIPTORS.length} 个，`
      + `工具 6 个${interruptedCount > 0 ? `，⚠ 发现 ${interruptedCount} 条中断的流水线（可用 teamflow_resume 从断点重跑）` : ''}`,
    )
  }

  /* ── Remote 方法（client 经 ctx.remote.teamflow.* 调用） ─────────── */

  ping() {
    return { ok: true }
  }

  list() {
    return { runs: listRuns() }
  }

  snapshot(runId) {
    if (runId && typeof runId === 'string') {
      const j = runs.get(runId)
      return j ? snapshotOf(j) : null
    }
    const latest = listRuns()[0]
    if (!latest) return null
    const j = runs.get(latest.id)
    return j ? snapshotOf(j) : null
  }

  start(sessionId, requirement, options) {
    const sid = typeof sessionId === 'string' ? sessionId : null
    const req = typeof requirement === 'string' && requirement.trim() ? requirement.trim() : null
    if (!sid || !req) return { ok: false, error: '缺少 sessionId 或需求描述' }
    const agent = ACTIVE.agents && ACTIVE.agents.get(sid)
    if (agent === undefined) return { ok: false, error: `找不到会话对应的 Agent：${sid}` }
    try {
      const opts = (options && typeof options === 'object') ? options : {}
      const runId = startPipeline(agent, req, opts)
      return { ok: true, runId, product: opts.productRoot ? normalizeRoot(opts.productRoot) : null }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) }
    }
  }

  cancel(runId) {
    const id = typeof runId === 'string' ? runId : null
    if (!id) return { ok: false, error: '缺少 runId' }
    return { ok: cancelRun(id) }
  }

  backlog(product) {
    return backlogSummary(normalizeRoot(product))
  }

  backlogUpdate(kind, id, to, product, reason) {
    const k = String(kind || '')
    const i = String(id || '')
    const t = String(to || '')
    if (!k || !i || !t) return { ok: false, error: '缺少 kind/id/to' }
    return transitionBacklog(normalizeRoot(product), k, i, t, reason ? String(reason) : '人工流转')
  }

  /** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑。 */
  resume(runId, sessionId) {
    return resumeRun(runId, sessionId)
  }
}

export default TeamflowService
