/**
 * dsh-plugin-teamflow — Prompt 模板（阶段提示词 + 团队模板）。
 * 依赖：util.ts（clip）、core/state.ts（stateSliceFor / STATE_BLOCK_INSTRUCTION）。
 *
 * 【产物收口约定】（v0.13，ADR-0008 任务夹制）
 * - 每个需求一个自包含任务夹：docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/，收口本需求的
 *   PRD/DESIGN/TECHNICAL/QA-REPORT/ACCEPTANCE。夹由 host 创建命名（journal.runDocs），
 *   建后不可变、阶段重试与断点续跑复用同夹——无版本切片、无归档动作。
 * - 产品层只保留 docs/teamflow/memory.md（团队约定/技术栈/待办，低频幂等更新）。
 * - 回归基线：新 PRD 头部「基线依赖：<其他任务夹>」声明；跨代变更用「取代：<夹>#AC-n」；
 *   硬保障在项目 verify-* 可执行套件。
 * - 命令输出日志照旧收口 logs/teamflow/<runId>/。
 */
import { clip } from '../util.ts'
import { stateSliceFor, STATE_BLOCK_INSTRUCTION } from '../core/state.ts'

/** 产品层文档根（memory.md 等跨任务资产；任务产物在其中的任务夹内）。 */
const TF_DOCS = 'docs/teamflow'

/** 本次任务产物夹相对路径（ADR-0008）：host 在启动时注入 state.__runCtx.runDocs。 */
function RUN(state: unknown): string {
  const rd = state && (state as { __runCtx?: { runDocs?: unknown } }).__runCtx && (state as { __runCtx?: { runDocs?: unknown } }).__runCtx!.runDocs
  return typeof rd === 'string' && rd ? rd : `${TF_DOCS}/current-run`
}

/**
 * AGENTS.md 模板 —— 共识层 + TeamFlow 托管区（所有产物文档指向 docs/teamflow/）。
 * 原则：AGENTS.md 是团队资产（会被所有 Agent 无条件注入），只放稳定共识层与文档索引；
 * 产品记忆/待办等高频运营数据放 docs/teamflow/memory.md（按需读取），绝不写进本文件。
 * TeamFlow 只维护 <!-- teamflow:begin/end --> 托管区；其余内容团队所有，不得改写。
 */
export const AGENTS_TEMPLATE = `# AGENTS.md — 团队协作守则与文档索引（{{PRODUCT}} 产品线）

> 任何新加入本产品的 Agent（团队成员）必须先通读本文件，再按 §2 文档索引读取相关文档与任务卡片，不要自行全量探索项目。
> 维护者：团队本身 + TeamFlow 研发流水线（TeamFlow 仅维护文末 <!-- teamflow --> 托管区，其余内容为团队资产，不得改写）。

## 1. 产品是什么

- 产品：{{PRODUCT_DESC}}
- 产品根：{{PRODUCT_ROOT}}/（工作区产品线约定：products/<product>/）
- 当前版本：{{VERSION}}（{{DATE}} 交付）

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| 产品入口 | README.md | 玩法/操作/运行/验收速览（团队资产的入口文档） |
| 任务产物 | ${TF_DOCS}/<yyyyMMdd-rN-slug>/ | 每个需求一个自包含任务夹：PRD/设计/技术方案/QA 报告/验收报告（按日期倒序即迭代史） |
| 架构总览 | ${TF_DOCS}/architecture/ARCHITECTURE.md | 工程方案与脚手架说明（产品级长期文档） |
| 产品记忆 | ${TF_DOCS}/memory.md | 团队约定/技术栈/已知待办（低频更新） |
| 运行日志 | logs/teamflow/<runId>/ | TeamFlow 流水线各阶段命令日志（日常不读） |

## 3. 团队角色与标准流程

**角色**：产品经理 / UI/UX 设计师 / 架构师 / 高级全栈工程师 / QA 测试工程师。

**标准流程**：需求 → PRD →（UI 改造时）UI/UX 设计 →（新项目时）架构规划 → 技术方案 → 并行开发 → QA 测试 → 产品验收。

**产出物落盘约定**：每个需求的所有产物写入该需求的任务夹 ${TF_DOCS}/<任务夹>/（夹名与路径由 TeamFlow 指定，见各阶段指令）；ARCHITECTURE.md 与 memory.md 是产品级长期文档。**除实际产品代码改造与 AGENTS.md 托管区外，TeamFlow 只在 ${TF_DOCS}/ 与 logs/teamflow/ 下写文件，绝不写入宿主 docs/<职责>/ 或项目根。**

**完成度自查**：每个环节交付前对照职责清单自查，未完成不得流转；架构师对新项目必须实际初始化脚手架文件与 AGENTS.md 草稿。

## 4. 工程约定

（架构师按实际技术栈填写：代码形态、契约、验证命令、风格约定）

<!-- teamflow:begin -->
## TeamFlow 托管区（本块由 TeamFlow 自动维护，团队请勿手改）

- 团队文档根：${TF_DOCS}/（每需求一个任务夹 + memory.md + architecture/）
- 运行日志：logs/teamflow/<runId>/
- 需求/任务/缺陷 backlog：持久化镜像位于 $DSH_HOME/teamflow/<workspace>/（按工作区/项目隔离）
- 规则：TeamFlow 只维护本块、${TF_DOCS}/ 与 logs/teamflow/；本文件其余内容为团队资产。
<!-- teamflow:end -->

## 5. 变更记录

- {{DATE}}：创建本文件（TeamFlow 脚手架）。
`

export const MEMORY_TEMPLATE = `# {{PRODUCT}} 产品记忆与待办（TeamFlow 维护）

> 本文件是**产品约定层**：只记录跨需求长期有效的信息（技术栈、团队规矩、已知待办）。
> 每个需求的迭代细节在各自任务夹 docs/teamflow/<日期-rN-slug>/ 内，不写进本文件。

## 团队约定与技术栈

- （架构师初始化脚手架时填写：代码形态、模块边界、验证命令）

## 已知待办（下一批）

- （验收后由产品经理更新：划掉已完成、补充新发现）

## 说明

- 任务产物：docs/teamflow/<日期-rN-slug>/（一需求一夹，建后不可变）
- backlog（需求/任务/缺陷）事实源：$DSH_HOME/teamflow/<workspace>/（按工作区/项目隔离）
- 运行日志：logs/teamflow/<runId>/
`

export function productCtx(root) {
  const base = root || 'products/<product>'
  return `【产品线约定】本需求属于产品 ${base}（当前工作区即其项目根）。
开工前先读 ${base}/AGENTS.md（团队守则与文档索引；先读摘要、按需精读，不要无目的全量通读）；
【任务夹制 · ADR-0008】每个需求一个自包含任务夹 docs/teamflow/<yyyyMMdd-rN-slug>/（本需求的夹路径见下方各阶段指令），夹内收口本需求全部产物（PRD/设计/技术方案/QA 报告/验收报告），**夹建后不可变、不归档、不升版**——重试/续跑写同一个夹；跨需求的产品级文档只有 ${TF_DOCS}/memory.md（约定/待办）与 architecture/；
【回归基线】新 PRD 头部声明「基线依赖：<既往任务夹名>」，跨代变更行为用「取代：<某夹>#AC-n」显式标注——历史夹永不改动；
【文档边界 · 硬约束】TeamFlow 契约文档只写 ${base}/${TF_DOCS}/ 下（目录不存在则创建），**绝不写宿主 docs/<职责>/、绝不往项目根散落日志文件**；命令输出等日志写 logs/teamflow/<runId>/；
【AGENTS.md 边界 · 硬约束】AGENTS.md 是团队资产（会被无条件注入，只放共识层/索引/托管区）：**禁止在迭代中新增/追加「产品记忆、待办、变更记录」等流水账章节**（这类数据只写 ${TF_DOCS}/memory.md 与任务夹）；除文末 <!-- teamflow:begin/end --> 托管区外，任何环节都不得改写、重排或覆盖 AGENTS.md 其他内容；
backlog（需求/任务/缺陷）事实源在 ${base}/backlog/ 的持久化镜像 $DSH_HOME/teamflow/<workspace>/：任务为单卡轮转模型（待办→开发中→待测试→测试中→待验收→已验收），devAssign/qaAssign 记录在任务卡上。
`
}

/** 头尾组合切片：保留头部(背景/基线) + 尾部(新增 AC/修订)，预算不变但覆盖增量段。 */
function headTailClip(text: unknown, head: number, tail: number): string {
  const s = text === null || text === undefined ? '' : String(text)
  if (s.length <= head + tail) return s
  return s.slice(0, head) + '\n...\n【本次变更段】\n' + s.slice(-tail)
}

export const TOKEN_HYGIENE = (runId) => `【token 卫生 · 硬约束】上下文很贵，以下是必须遵守的预算纪律（超配额会记录 warning，不打断）：
- 【文件作用域】只整文件 read 任务 spec 明确列出的目标文件；需要了解其他文件的接口时，用 grep 搜索关键词（不要 read 全文）。不在任务范围内的源码文件禁止整文件读取。
- 【禁止重复读】同一文件 read ≤1 次；如需确认改动结果，用 grep 搜索变更点而非重新 read 全文。
- 【grep 优先】动手前优先用 1 次综合检索（grep）定位，再批量分段读取；避免对同一文件反复小步 read/grep。
- 【批量修复】验证失败时：一次性读取所有失败项 → 一次性修完（1 次 edit） → 再跑 1 次验证。禁止"修一个→跑→修一个→跑"。最多 3 轮修→跑循环；超过则输出诊断摘要并停止。
- 禁止全量 read 超过 200 行的文件（超出部分用 grep + limit 分段）；全量 read 的目标文件 ≤2 个；其余一律 grep 定位 + limit 分段读取。
- 运行命令时把完整输出重定向到文件（写到 logs/teamflow/${runId || '<runId>'}/ 下），再读取尾部摘要，不要把几百行输出直接回显。
- 报告与摘要一律精简（QA ≤150 行、验收 ≤80 行、开发 ≤40 行），细节落盘文件。
- AGENTS.md 与产品记忆索引已在上下文中自动注入，无需花调用读取全文；如需查找特定规则，grep 关键词定位。
- 本迭代的契约/验收标准已在下文【上下文包/交接摘要】或本任务夹 PRD 中给出：不得重新全量 read 任务夹内 PRD.md / DESIGN.md / TECHNICAL.md 全文，只需按需 grep/read 目标代码。
`

/** 一次成型纪律：目标文档 write ≤1 次 + read ≤2 次，严禁 read→edit→read 循环。 */
export const ONCE_DISCIPLINE = `【一次成型纪律 · 硬约束】这是最关键的效率约束，违反会浪费大量 token：
- 目标交付文档（PRD/DESIGN/TECHNICAL/QA-REPORT/memory）只允许 **write 1 次完整新版** + **最多 read 2 次**（write 前确认结构 1 次、write 后校验格式 ≤1 次）。
- **严禁 read→edit→read 循环**：不要反复打开同一文件"微调"；不要为确认改动而反复 read 全文。
- 需要看细节用 grep 定位 + limit 分段读，绝不整文件 read 大文档。
- 一次性想清楚再 write；write 完就进入下一阶段，不回头精修。
- 产出末尾必须附带 state 块，供 host 沉淀索引、下一轮免重读。
`

export const prdPrompt = (requirement, root, runId, state) => `你是资深产品经理。当前工作区即为目标项目（若为空表示项目尚未建立）。
${productCtx(root)}${stateSliceFor(state, 'pm')}
${ONCE_DISCIPLINE}【原始需求】
${requirement}
【本次产物落点】${RUN(state)}/PRD.md（write 1 次；目录不存在则创建）。
【要求】
1. 先看上方 state 索引与 AGENTS.md 文档索引，判断是否为迭代需求、既往哪些任务夹与本需求相关（夹名含日期与主题，按日期倒序即演进史）；不要全量通读历史文档。
2. 【AC 编号】本夹内从 AC-1 连续编起——AC 归属本需求，不沿用任何全局编号。
3. 【头部声明 · 必写】PRD.md 开头依次：
   - \`<!-- meta: summary="<一句话概括本需求交付了什么>" -->\`
   - \`基线依赖：<本需求依赖的既往任务夹名>（其既定行为不得回退）\`；无依赖写「基线依赖：无」
   - \`取代：<某任务夹>#<AC 编号>：<一句话说明>\`（仅当本需求显式改变某既有行为时写；没有就省略）
4. 输出完整 PRD（Markdown）：背景与目标、用户故事（含逐条可测试的验收标准）、功能范围与非目标、交互流程概述、优先级(P0/P1/P2)、依赖与风险、里程碑建议。验收标准可测试可量化，精炼优先。**不要写修订记录表，不要写「版本：vX.Y / 状态：进行中」等版本管理字段**（任务夹即档案，身份由夹名承载）。
5. 【memory 回写 · 仅限约定变更】只有当本需求引入新的团队约定/技术栈决策时，才更新 docs/teamflow/memory.md（同主题替换原行，幂等，不追加流水账）；否则不动 memory。
6. 【工程动作承接】原始需求中的工程指令（新建/切换分支、提交、打 tag 等）必须原样保留到 PRD 的「工程约束」小节：写明动作、时机与基线（如「从当前主干最新提交新建分支 feat/<名> 后实施」）；工作区已有未提交改动时注明处理方式。不得静默丢弃或改写工程指令。
7. 【state 沉淀】结尾输出 state 块（phase="prd"），summary 含本次 AC 要点与一句话产品语义，extra 放 { "acIndex": {...}, "summary": "产品一句话", "techStack": "..." }。${STATE_BLOCK_INSTRUCTION}`

export const designPrompt = (prd, root, runId, state) => `你是资深 UI/UX 设计师。当前工作区即为目标项目。
${productCtx(root)}${stateSliceFor(state, 'design')}
${ONCE_DISCIPLINE}【PRD（本次变更与相关章节）】
${clip(prd, 15000)}
【要求】
1. 若项目已有前端代码/设计系统或历史 ${TF_DOCS}/design/DESIGN.md，先 grep 定位规范要点，勿全量重读；设计必须贴合现有风格与组件规范（迭代时保留既有规范，新增/修订部分显式标注）。
2. 输出：页面/模块清单与信息架构、关键页面线框描述（布局/组件/状态）、交互与动效说明、视觉规范（配色/字号/间距，尽量复用现有 token）、可访问性要点。
3. 输出中文 Markdown，具体到可直接指导前端实现，精炼优先。
4. 产出写入 ${RUN(state)}/DESIGN.md（write 1 次）。【边界】只写 ${TF_DOCS}/ 下文件。
5. 【state 沉淀】结尾输出 state 块（phase="design"），summary 写关键设计决策。${STATE_BLOCK_INSTRUCTION}`

export const scaffoldPrompt = (req, design, root, runId, state) => `你是资深架构师。工作区为空或尚无项目骨架，请规划并**实际落地**新项目脚手架。
${productCtx(root)}${stateSliceFor(state, 'arch')}
${ONCE_DISCIPLINE}【需求】
${clip(req, 10000)}
${design ? `【设计说明】
${clip(design, 10000)}
` : ''}【要求】
1. 推荐技术栈（优先团队常用全栈栈，如 TypeScript + React + Node），说明取舍。
2. 输出完整脚手架方案：目录结构树、核心模块划分、依赖清单、构建/测试/CI 配置要点。
3. 【落地要求】除方案文档外必须实际执行初始化（工作区允许范围内）：
   a) 若产品根尚不存在，创建目录结构（${TF_DOCS}/、logs/teamflow/ 等，不创建无关的 docs/<职责>/）；
   b) 初始化脚手架文件（package.json、配置、入口等按方案实际创建，不得只写方案不落地）；
   c) 【AGENTS.md 处理】二选一：
      - 产品根已有 AGENTS.md（团队已有约定）：**绝不重写、不重排、不覆盖**。若文件末尾没有
        <!-- teamflow:begin --> 块，则原样保留全部内容，仅在文末追加一个
        <!-- teamflow:begin -->…<!-- teamflow:end --> 托管块（含指向 ${TF_DOCS}/memory.md
        与 backlog/ 的索引行）；若已有托管块，跳过。其余内容一行不动。
      - 产品根尚无 AGENTS.md：基于下方模板创建（共识层 + 文档索引 + teamflow 托管区），
        并创建 ${TF_DOCS}/memory.md（按下方的 memory.md 骨架，替换 {{占位符}}）；
   d) 输出完成度自查清单：已落地项 / 未落地项及原因——未完成项必须显式列出，不得宣称全部完成。
4. 若工作区已有部分文件，先阅读并尊重现状。
5. 输出中文 Markdown，精炼完整；方案文档写入 ${TF_DOCS}/architecture/ARCHITECTURE.md。

【AGENTS.md 模板】
${AGENTS_TEMPLATE}

【memory.md 骨架】
${MEMORY_TEMPLATE}
【state 沉淀】结尾输出 state 块（phase="scaffold"），extra 放 { "techStack": "...", "modules": {"/file": "契约"} }。${STATE_BLOCK_INSTRUCTION}`

export const techPrompt = (prd, design, scaffold, tasks, root, runId, state) => `你是高级全栈工程师。当前工作区即为目标项目，请基于已有项目产出技术方案。
${productCtx(root)}${stateSliceFor(state, 'tech')}
${ONCE_DISCIPLINE}【PRD（本次变更与相关章节）】
${clip(prd, 12000)}
${design ? `【设计说明】
${clip(design, 10000)}
` : ''}${scaffold ? `【脚手架方案】
${clip(scaffold, 10000)}
` : ''}${tasks && tasks.length > 0 ? `【流水线派发任务（必须对齐，不得另起一套）】
${JSON.stringify(tasks)}
` : ''}【要求】
1. 先阅读 AGENTS.md 与工作区现有项目（package.json、README、src 结构等），方案必须贴合现有技术栈与代码风格，并给出具体文件路径。
2. 输出：数据模型与存储、API 设计（路由/入参出参）、前端组件与页面划分、状态管理、关键实现要点与边界情况、测试策略。
3. 任务拆分：若上方【流水线派发任务】存在，你的拆分必须与之对齐——逐项校验/细化派发任务（文件边界、接口契约、验收标准），不得另起一套任务体系；未派发时给出可并行任务清单。PRD「工程约束」中的 git 动作（分支/提交要求）必须随任务传递（写进对应 task spec 或单独列出），不得丢失。
4. 输出中文 Markdown，精炼完整；产出写入 ${RUN(state)}/TECHNICAL.md（write 1 次）。【边界】只写 ${TF_DOCS}/ 下文件。
5. 【架构蓝图 JSON · 必输出（供 dev 继承 / 验收核验，M1/M2）】在文档之后，额外输出一个**架构蓝图 JSON 块**（与正文同一份输出里、文档末尾）：
<!-- blueprint -->{"summary":"一句话架构判断","modules":{"/相对路径.js":{"responsibility":"职责","dependsOn":["依赖文件"],"assemblyOrder":1,"why":"为什么这样设计/为什么独立"},"/另一个.js":{"responsibility":"","why":""}},"duplications":["检测到的重复/适配器漂移风险，如多套安全存储封装"],"tasks":[{"title":"任务名（按文件边界）","files":["/a.js"],"spec":"一句话任务说明"}]}<!-- /blueprint -->
   - modules：本次涉及每个文件的职责 + 依赖 + 装配顺序 + **架构理由（why：为什么独立/这样设计）**。
   - tasks：按文件边界拆可并行任务（files 无交集可并行）；有依赖/冲突则合并或标注先后。
   - 若发现重复/该抽独立模块（如统一 storage 封装），在 modules 里给出新模块并说明 why。
6. 【state 沉淀】结尾输出 state 块（phase="tech"），extra 放 { "verifyScripts": [...], "modules": {"/file": "契约或一句话"} }，summary 写关键架构/契约决策。${STATE_BLOCK_INSTRUCTION}`

/**
 * 架构师 prompt（M1「认知前置 + 架构落地」）：全模式启用，轻量版（lite/tech/patch）只产架构蓝图 JSON，
 * 不写文档。核心：先建全局认知（允许整读关键源文件，本阶段豁免"别整读"的 token 卫生——架构决策需要全局视野），
 * 再输出结构化架构蓝图，供 dev 在既有架构上实现而非重建。
 * 与原生工作流对应：Phase2 全局 READ → Phase3 Design Decision。
 */
export const architectPrompt = (prd, root, runId, state) => `你是资深架构师。当前工作区即为目标项目。你的职责：**先建立对代码库的全局架构认知，再输出一份结构化「架构蓝图」**，让后续开发任务在既有架构上实现，而非靠局部视角重建架构。
${productCtx(root)}${stateSliceFor(state, 'arch')}【PRD/需求（本次变更与相关 AC）】
${clip(prd, 12000)}
【要求】
1. 【不可跳过 · 先建全局认知】面对一个可能有场外改动/多人协作的代码库：
   - 上方已注入本次 run 的【状态核对】（git 现状：分支/未提交改动/近期提交，可能含他人改动）——先读它，确认"看到的可能是过时认知"。
   - **本阶段允许整文件 read 关键源文件**（不要只 grep 片段）：通读一次相关模块的职责/边界/装配顺序/依赖方向。这是架构决策的前提，不是浪费。
   - 识别重复实现（如多套安全适配器/存储封装）、边界不清、可抽取的独立模块。
2. 【架构决策】基于全局认知，判断：本次改动是否应拆独立模块（如独立 storage/localStorage 封装）、依赖方向、装配顺序、哪些文件必须一起改、哪些可并行。
3. 【产出 · 只输出一个 JSON 块（不要正文，不要 Markdown 代码块围栏）】：
<!-- blueprint -->{"summary":"一句话架构判断","modules":{"/相对路径.js":{"responsibility":"职责","dependsOn":["依赖文件"],"assemblyOrder":1,"why":"为什么这样设计/为什么独立"},"/另一个.js":{"responsibility":"","why":""}},"duplications":["检测到的重复/适配器漂移风险1","风险2"],"tasks":[{"title":"任务名（按文件边界）","files":["/a.js"],"spec":"一句话任务说明"}]}<!-- /blueprint -->
   - modules：本次涉及的每个文件的职责 + 依赖 + 装配顺序 + **为什么这样设计**（架构理由，让 dev 理解而非盲从）。
   - tasks：按文件边界拆可并行任务（files 无交集者可并行、可标记并发）；有依赖/冲突则合并或标注先后。
   - 若发现重复/该抽模块，modules 里给出新模块并说明 why。
4. 只读不改代码；不写任何文档文件。${STATE_BLOCK_INSTRUCTION}`

export const devPrompt = (task, tech, prd, root, runId, state) => `你是高级全栈工程师（开发执行）。当前工作区即为目标项目，请实际实现以下任务。
${productCtx(root)}${stateSliceFor(state, 'dev')}${TOKEN_HYGIENE(runId)}【上下文包】你的目标与上下文如下：
【任务标题】${task.title}
${task.files && task.files.length ? `【任务目标文件】${task.files.join('，')}` : ''}
【任务描述】${task.spec || '（见技术方案）'}
${(tech && String(tech).trim())
  ? `【技术方案摘要（细节按需 grep，不整篇重读）】
${clip(tech, 12000)}`
  : ''}
【PRD】本次相关验收标准见 ${TF_DOCS}/prd/PRD.md（按需 grep 对应 AC 编号，不必通读全文）。
【要求】
1. **架构蓝图优先**：若上方已有【架构蓝图】（tech/architect 阶段注入），按蓝图在既有架构上实现——遵循其模块拆分/装配顺序/why（理解设计意图，而非盲从或重建）；发现蓝图与现状不符时在实现摘要中说明证据。
2. 只修改与任务相关的文件（见【任务目标文件】，无则按 spec 推断）；遵守既有架构与代码风格。需要确认其他文件接口时用 grep 定位，不要整文件读无关大文件。
3. 若 spec 与现状不符，在实现摘要中明确说明并给出证据，而不是凭空宣称完成或擅自扩大改动。
4. 实际编写/修改代码（用 grep + 分段读定位文件，不要反复 read 大文件），完成后运行相关构建/验证命令确保通过。
5. 【工程动作执行】若任务 spec 或 PRD 工程约束包含 git 动作（如新建分支）：**先执行动作再写码**（如 git checkout -b <分支>）；工作区已有与本任务无关的未提交改动时，不要擅自提交/清理，在实现摘要中声明现状。
6. 【日志纪律】运行命令输出重定向到 logs/teamflow/${runId || '<runId>'}/ 下。
7. 输出实现摘要（≤40 行）：改动文件列表、关键实现点、如何验证、遗留问题。不要粘贴大段代码。
8. 【state 沉淀】结尾输出 state 块（phase="dev"），touched 放改动文件数组，summary 写实现结论。${STATE_BLOCK_INSTRUCTION}`

export const qaPrompt = (prd, devSummary, root, runId, state) => `你是资深 QA 测试工程师。当前工作区即为目标项目，请对本次交付做功能测试。
${productCtx(root)}${stateSliceFor(state, 'qa')}${TOKEN_HYGIENE(runId)}【PRD（本次变更与相关 AC）】
${headTailClip(prd, 5000, 7000)}
【开发结果摘要】
${clip(devSummary, 15000)}
【要求】
0. 【架构核验 · 必做（M3 质量门禁）】除功能测试外，对交付做一次**轻量架构检查**：
   - 若上方已注入【架构蓝图】，核对实现是否遵循蓝图（该拆的独立模块拆了没、依赖/装配是否符合、有无偏离）。
   - 检查有无**重复实现**（如多套安全存储/适配器/工具函数漂移）、**该抽象未抽象**、**明显破坏既有结构**。
   - 发现的架构问题按缺陷登记格式输出（严重级 P1，模块标「架构」）。这是交付质量门禁的一部分，不只是功能 bug。
1. 【环境限制，勿徒劳】当前沙箱禁止启动带 CDP 的 Chrome/Edge 进程：真实浏览器自动化（Playwright/Puppeteer/chromedriver/--remote-debugging-port）、听感/像素/真实时序/多浏览器/读屏等实测一律不可行——这是策略拒绝而非命令缺陷，不要尝试、不要换工具重试。验证一律走环境允许的路径：构建/装配检查、单元测试、DOM 级 E2E（jsdom 或等效）、静态代码审计、对抗性抽查。
2. 无法自动实测的验收项（听感/像素/真实时序/双分辨率/离线多浏览器/读屏等）不判失败：改为在报告「人工补测清单」一节逐项列出（验收标准 + 验证方法 + 工具），标注「环境限制，非交付缺陷」，供人工复核。
3. 先读 AGENTS.md §4 工程约定（验证命令）与代码改动，然后实际运行上述环境允许的验证。
4. 【日志纪律】运行命令的输出重定向到 logs/teamflow/${runId || '<runId>'}/ 下（如 qa-out.log），不要散落到项目根。
5. 输出测试报告（正文 ≤150 行，结论先行）：测试范围与环境、用例与结果（通过/失败/阻塞）、结论（是否达到可验收标准）。
6. 【缺陷提交格式】发现的缺陷按以下结构化清单输出（供缺陷管理系统直接收录）：
   | 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |
   若无缺陷，显式输出「未发现缺陷」。
7. 输出中文 Markdown，具体可执行；报告写入 ${RUN(state)}/QA-REPORT.md（write 1 次，正文精炼）。【边界】只写 ${TF_DOCS}/ 下文件。
8. 【state 沉淀】结尾输出 state 块（phase="qa"），summary 写测试结论/被阻断项，extra 放 { "verifyScripts": [...] }。${STATE_BLOCK_INSTRUCTION}`

/** QA 打回后的开发修复 prompt：确认缺陷是否属实 → 修复 → 复验交接（QA→dev 打回闭环用）。 */
export const qaFixPrompt = (defects, qa, tech, prd, root, runId, state) => `你是高级全栈工程师。QA 复验报告指出了若干缺陷，本阶段请**逐一确认**并修复，随后交由 QA 复验。
${productCtx(root)}${stateSliceFor(state, 'dev')}${TOKEN_HYGIENE(runId)}
【QA 复验报告（缺陷清单在报告 §3 缺陷表）】
${clip(qa, 12000)}
【QA 指出的缺陷】
${JSON.stringify(defects, null, 2)}
【技术方案/架构蓝图摘要（修复应在既有架构上做，勿重建）】
${(tech && String(tech).trim()) ? clip(tech, 12000) : ''}
【PRD】相关验收标准见 ${RUN(state)}/PRD.md（按需 grep 对应 AC 编号，不必通读全文）。
【要求】
1. 【先确认，后修复】对每个缺陷逐条核实：它是否确实成立（读代码/复现/对照现象与期望）——
   确认属实的 → 直接把它修好；QA 误报/与现状不符 → 在摘要中明确说明证据（不得臆造改动，也不得无视真实缺陷）。
2. 只修改与缺陷相关的文件（可用 grep 定位，不要整文件读无关大文件）；遵守既有架构与代码风格。
3. 实际修复后运行相关验证命令确保通过（回归底线：既有六套验证不加后门）；命令输出重定向到 logs/teamflow/${runId || '<runId>'}/。
4. 输出修复摘要（≤40 行中文）：逐条缺陷的「属实性判断 + 修复方式 / 误报证据」，改动文件、如何验证、遗留问题。不要粘贴大段代码。
5. 【state 沉淀】结尾输出 state 块（phase="dev"），touched 放改动文件数组，summary 写修复结论。${STATE_BLOCK_INSTRUCTION}`

export const acceptancePrompt = (prd, qa, devSummary, root, runId, state) => `你是产品经理（验收负责人）。请对照 PRD 验收标准对本次交付做最终验收。
${productCtx(root)}${stateSliceFor(state, 'acceptance')}${TOKEN_HYGIENE(runId)}
${ONCE_DISCIPLINE}【PRD（修订记录 + 本次新增 AC）】
${headTailClip(prd, 4000, 5000)}
【QA 测试报告（结论）】
${clip(qa, 10000)}
【开发结果摘要】
${clip(devSummary, 8000)}
【要求】
0. 【架构一致性核验 · 必做（M3 质量门禁）】功能 AC 之外，做一次结构质量核对：
   - 若上方已注入【架构蓝图】：实现是否遵循蓝图（独立模块是否按蓝图拆、组装顺序是否正确、有无该抽象未抽象）。
   - 有无明显**重复实现 / 适配器漂移 / 破坏既有结构**（这是代码质量底线，不是可选项）。
   - **判定影响**：仅功能全绿但存在「架构偏离蓝图 / 重复实现 / 该拆未拆」→ 结论应为 **⚠️ 有条件通过**（架构打回项列出，要求返工后再验收）；**严重偏离 / 破坏结构 → ❌ 不通过**。不要把「verify 全绿」当作「无需返工」的唯一依据。
1. 逐条核对 PRD 验收标准达成情况。
2. 输出验收结论（正文 ≤80 行）：✅ 通过 / ⚠️ 有条件通过 / ❌ 不通过 / 📝 需求不适用，附逐条核对表、意见与遗留事项。
3. 【需求不适用判定】若 PRD/技术变更单/确认单已指出「需求与现状不符」，或开发结果明确为「无需改动（需求站不住/已满足）」，则结论应为 **「📝 需求不适用」** 并说明原因——不要因「无缺陷」而标 ✅ 通过。
4. 【验收报告落盘】写入 ${RUN(state)}/ACCEPTANCE.md（write 1 次，与正文一致）。【记忆回写 · 仅限约定变更】只有当本需求引入新的团队约定/技术栈决策、或「已知待办」有增删时，才更新 docs/teamflow/memory.md（同主题替换原行，幂等，不追加流水账）；否则不动 memory。【边界】只写 ${TF_DOCS}/ 下文件；不得改写 AGENTS.md 除 <!-- teamflow --> 托管区以外的内容。
5. 输出中文 Markdown。
6. 【state 沉淀】结尾输出 state 块（phase="acceptance"），summary 写验收结论、verdict 写"accepted/rework/reject/needs-human"，extra.done 写本次交付确认。${STATE_BLOCK_INSTRUCTION}`

/** 需求分诊模型 prompt（模型驱动 triage；供 core/triage.runTriage 使用）。 */
export const TRIAGE_PROMPT = (requirement: string, opts: { needDesign?: boolean } | undefined, pre: { rationale: string[] }): string => `你是资深研发需求分诊分析师。请只做一件事：理性分析这条开发需求适合走哪种流水线模式，再给出结论。不要写代码、不要臆测需求范围。
【原始需求】
${requirement}
${pre.rationale.length ? `\n【正则预筛参考信号（仅供参考，请结合语义判断，勿盲从）】\n${pre.rationale.join('\n')}` : ''}
\n【可选信号】需 UI 改造：${(opts && opts.needDesign) ? '是' : '未标注'}

【五档定义】
- patch：热修/单点修复/常量/版本号/笔误——无需独立 QA，单 agent 直改即交付
- lite：单模块小功能/微增强——确认型 PRD + 开发 + QA + 验收（无 UI 设计、无独立技术方案文档）
- tech：技术驱动改造（重构/优化/架构升级/依赖/性能/技术债）——出「技术变更单」而非功能 PRD，回归加强
- medium：含 UI 的中等功能——需要设计 + 技术方案 + 完整护栏
- full：跨模块/大型新功能——完整 7 段 + 前置评估

【判断要点】
1. 区分"用户可感知的功能变更"与"内部技术改造"：重构/优化即使代码量大也往往归 tech 而非 full；
2. 涉及 UI/视觉/交互/按钮/页面 → 至少 medium（排除 patch/tech）；
3. hotfix/单点/纯数值/纯文档 → patch；明确的"新增 X 功能"按规模选 lite/medium/full；
4. 改动集中（即便含测试/回归）→ 按性质选 lite/tech，不必 full；
5. 【M1 架构判据（重要）】涉及**架构性改动**——持久化/本地存储/数据库/独立模块/抽象/跨多文件且无现有可复用封装（如 localStorage 封装、存储层、状态管理）——即使表面像"小功能"，也**至少 medium**（必须走架构阶段产蓝图，避免 dev 局部散落实现）；这类改动靠"微功能"轻档会塌。技术驱动改造（重构/优化/架构升级）本身归 tech（tech 档现也走轻量架构蓝图）。

【输出】只输出一个 JSON 对象（不要任何其他文字）：
{ "mode": "patch|lite|tech|medium|full", "slug": "本需求主题词(3-24个小写字母/数字/短横线,如 wallkick-toggle、7bag-random;用于命名任务文件夹)", "kind": "一句话性质", "needDesign": true|false, "complexity": "small|medium|large", "rationale": ["关键论据1","关键论据2"], "confidence": "high|medium|low" }`

/** tech 档 PRD：技术变更单（无功能 AC，重范围/目标/改动面/回归）。 */
export const techChangePrompt = (requirement, root, runId, state) => `你是资深技术负责人。当前工作区即为目标项目。这是一个**技术驱动改造**需求（重构/优化/升级/架构/依赖/技术债）——产品不需要完整功能 PRD，但需要一份**技术变更单**作开发/QA/验收与记忆回写的契约。
${productCtx(root)}${stateSliceFor(state, 'tech')}
${ONCE_DISCIPLINE}【原始需求/改造目标】
${requirement}
【要求】
1. 产出「技术变更单」（Markdown），写入 ${RUN(state)}/TECH-CHANGE.md——**不改写任何既往任务夹内的 PRD 功能 AC**（技术驱动改造原则上不新增用户可见功能验收项；若确有一点用户可见行为变化，在该节显式说明）。
2. 变更单内容：改造背景与目标（一句话）、影响范围（涉及文件/模块）、技术方案要点（改动思路）、行为兼容性影响（有无用户可见变化）、回归与验证方案（跑哪些验证命令、回归底线）、风险与回滚。
3. 同步更新 docs/teamflow/memory.md 记录本次改造要点（仅当涉及新约定/待办增删；同主题替换，幂等）；不改 AGENTS.md 除 teamflow 托管区外内容。
4. 精炼（这是给开发/QA 的契约，≤120 行），输出中文 Markdown。【边界】只写 ${TF_DOCS}/ 下文件。
5. 【state 沉淀】结尾输出 state 块（phase="tech"），extra 放 { "verifyScripts": [...], "scopedFiles": [...] }。${STATE_BLOCK_INSTRUCTION}`

/** patch 档 PRD：单点修复快速确认（不产 PRD 文档）。 */
export const patchConfirmPrompt = (requirement, root, runId, state) => `你是资深工程师。当前工作区即为目标项目。这是一个**hotfix / 单点修复**需求——不做完整 PRD，只做一次简短确认（≤40 行）。
${productCtx(root)}${stateSliceFor(state, 'dev')}
${ONCE_DISCIPLINE}【原始需求】
${requirement}
【要求】
1. 判断是否确为单点/热修：是 → 输出「确认单」；否 → 显式说明"建议升级流水线模式（如 tech/lite/full）"，不要硬做。
2. 【需求核对】**先核实需求描述与工作区实际是否一致**：一致 → 按下列确认单产出；不一致 → 在确认单中显式指出「需求与实际不符，建议取消改动或调整需求」，**不得臆造改动**。
3. 确认单内容：修复点（文件/位置）、改动概述、回归影响（极小 / 需跑哪些验证命令）、是否顺带同步版本号。
4. 只输出确认单文本，**不改任何产品文档**（本次不产 PRD；记忆回写由验收阶段负责）。
5. 【state 沉淀】结尾输出 state 块（phase="patch"），summary 写确认结论。${STATE_BLOCK_INSTRUCTION}`
