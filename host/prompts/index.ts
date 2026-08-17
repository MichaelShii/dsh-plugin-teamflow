/**
 * dsh-plugin-teamflow — Prompt 模板（阶段提示词 + 团队模板）。
 * 依赖：util.ts（clip）；本目录后续随 mode（full/lite/tech…）扩展各变体。
 */
import { clip } from '../util.ts'

/**
 * AGENTS.md 模板 v2 —— 共识层 + TeamFlow 托管区。
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

export const MEMORY_TEMPLATE = `# {{PRODUCT}} 产品记忆与待办（TeamFlow 维护）

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

export function productCtx(root) {
  const base = root || 'products/<product>'
  return `【产品线约定】本需求属于产品 ${base}。
开工前先读 ${base}/AGENTS.md（团队守则与文档索引）与 ${base}/docs/SUMMARY.md（文档摘要索引，先读摘要、按需精读，不要无目的全量通读）；
产品记忆（迭代历史）与待办在 ${base}/docs/teamflow/memory.md（按需读取）；
【AGENTS.md 边界】AGENTS.md 是团队资产：除文末 <!-- teamflow:begin/end --> 托管区外，任何环节都不得改写、重排或覆盖其中的内容（产品记忆请写入 docs/teamflow/memory.md）；
若目录尚不存在，按约定创建 ${base}/ 结构（docs/<职责>/、docs/teamflow/、backlog/）。
`
}
export const TOKEN_HYGIENE = `【token 卫生 · 硬约束】上下文很贵，以下是必须遵守的预算纪律（超配额会记录 warning，不打断）：
- 禁止全量 read 超过 200 行的文件；同一文件 read/grep 合计 ≤3 次；全量 read 的目标文件 ≤2 个；其余一律 grep 定位 + limit 分段读取。
- 动手前优先用 1 次综合检索（grep）定位，再批量分段读取；避免对同一文件反复小步 read/grep。
- 运行命令时把完整输出重定向到文件（如 > log.txt）再读取尾部摘要，不要把几百行输出直接回显。
- 报告与摘要一律精简（QA ≤150 行、验收 ≤80 行、开发 ≤40 行），细节落盘文件。
- 本迭代的契约/验收标准已在下文【上下文包/交接摘要】或对应技术方案中给出：不得重新全量 read AGENTS.md / SUMMARY.md / PRD.md / DESIGN.md / TECHNICAL.md 全文，只需按需 grep/read 目标代码。
`

export const prdPrompt = (requirement, root) => `你是资深产品经理。当前工作区即为目标项目（若为空表示项目尚未建立）。
${productCtx(root)}【原始需求】
${requirement}
【要求】
1. 先检查工作区中是否已有 PRD 模板、需求文档或既有开发模式（如 docs/、README、历史文档等），若有必须遵循其结构与规范（基于现有模式开发）。
2. 若本产品已有历史 PRD（docs/prd/PRD.md）或 docs/teamflow/memory.md 产品记忆：这是迭代需求——先读 docs/SUMMARY.md、历史 PRD 修订记录与产品记忆，输出增量 PRD（保留既有 AC 编号与语义，压缩旧 AC 的冗长表述，显式标注本次变更），并升级版本号。
3. 【文档归档】更新活文档之前，先把当前 PRD 快照复制到 docs/history/<旧版本号>/（目录不存在则创建），再写新版；历史快照日常不读。
4. 输出完整 PRD（Markdown）：背景与目标、用户故事（含逐条可测试的验收标准）、功能范围与非目标、交互流程概述、优先级(P0/P1/P2)、依赖与风险、里程碑建议。
5. 验收标准必须可测试、可量化；文档精炼优先，避免无限膨胀。
6. 产出写入 docs/prd/PRD.md；同步更新 docs/teamflow/memory.md 的产品记忆（新迭代需求、目标版本）。【边界】不得改写 AGENTS.md 除 teamflow 托管区以外的内容。`

export const designPrompt = (prd, root) => `你是资深 UI/UX 设计师。当前工作区即为目标项目。
${productCtx(root)}【PRD（本次变更与相关章节）】
${clip(prd, 15000)}
【要求】
1. 若项目已有前端代码/设计系统或历史 DESIGN.md，先阅读，设计必须贴合现有风格与组件规范（迭代时保留既有规范，新增/修订部分显式标注）。
2. 输出：页面/模块清单与信息架构、关键页面线框描述（布局/组件/状态）、交互与动效说明、视觉规范（配色/字号/间距，尽量复用现有 token）、可访问性要点。
3. 输出中文 Markdown，具体到可直接指导前端实现，精炼优先。
4. 产出写入 docs/design/DESIGN.md（迭代时保留既有规范，新增/修订部分标注）。`

export const scaffoldPrompt = (req, design, root) => `你是资深架构师。工作区为空或尚无项目骨架，请规划并**实际落地**新项目脚手架。
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

export const techPrompt = (prd, design, scaffold, tasks, root) => `你是高级全栈工程师。当前工作区即为目标项目，请基于已有项目产出技术方案。
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

export const devPrompt = (task, tech, prd, root) => `你是高级全栈工程师（开发执行）。当前工作区即为目标项目，请实际实现以下任务。
${productCtx(root)}${TOKEN_HYGIENE}【上下文包】你的目标与上下文如下，不需要全量探索项目：
【任务标题】${task.title}
【任务描述】${task.spec || '（见技术方案）'}
${(tech && String(tech).trim())
  ? `【技术方案】
${clip(tech, 20000)}`
  : '【技术方案】轻量/改造/hotfix 档未单列技术方案文档——**任务卡 spec 即唯一契约**；请只按 spec 做出精确改动，不要在任务范围外探索、不要重新核查/确认既有功能是否已交付。'}
【PRD】本次相关验收标准见 docs/prd/PRD.md（按需查阅对应 AC，不必通读全文）。
【要求】
1. 先读 AGENTS.md §4 工程约定（验证命令/风格/数值事实来源）与 docs/SUMMARY.md；只修改与任务相关的文件，遵守既有架构与代码风格。
2. **执行纪律（重点）**：任务卡【任务描述】是本次唯一交付契约——按它做出具体改动；坚决不做「核查/确认既存功能是否已实现」这类与交付无关的动作；若 spec 与现状不符（如需求所指位置/内容不对），在实现摘要中明确说明并给出证据，而不是凭空宣称完成或擅自扩大改动。
3. 实际编写/修改代码（使用文件工具），完成后运行相关构建/验证命令（如 AGENTS.md 约定）确保通过。
4. 输出实现摘要（≤40 行）：改动文件列表、关键实现点、如何验证、遗留问题。不要粘贴大段代码。`

export const qaPrompt = (prd, devSummary, root) => `你是资深 QA 测试工程师。当前工作区即为目标项目，请对本次交付做功能测试。
${productCtx(root)}${TOKEN_HYGIENE}【PRD（本次变更与相关 AC）】
${clip(prd, 12000)}
【开发结果摘要】
${clip(devSummary, 15000)}
【要求】
1. 【环境限制，勿徒劳】当前沙箱禁止启动带 CDP 的 Chrome/Edge 进程：真实浏览器自动化（Playwright/Puppeteer/chromedriver/--remote-debugging-port）、听感/像素/真实时序/多浏览器/读屏等实测一律不可行——这是策略拒绝而非命令缺陷，不要尝试、不要换工具重试。验证一律走环境允许的路径：构建/装配检查、单元测试、DOM 级 E2E（jsdom 或等效）、静态代码审计、对抗性抽查。
2. 无法自动实测的验收项（听感/像素/真实时序/双分辨率/离线多浏览器/读屏等）不判失败：改为在报告「人工补测清单」一节逐项列出（验收标准 + 验证方法 + 工具），标注「环境限制，非交付缺陷」，供人工复核。
3. 先读 AGENTS.md §4 工程约定（验证命令）与代码改动，然后实际运行上述环境允许的验证。
4. 输出测试报告（正文 ≤150 行，结论先行）：测试范围与环境、用例与结果（通过/失败/阻塞）、结论（是否达到可验收标准）。
5. 【缺陷提交格式】发现的缺陷按以下结构化清单输出（供缺陷管理系统直接收录）：
   | 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |
   若无缺陷，显式输出「未发现缺陷」。
6. 输出中文 Markdown，具体可执行；报告写入 docs/qa/QA-REPORT.md（迭代时保留历史章节，正文精炼）。`

export const acceptancePrompt = (prd, qa, devSummary, root) => `你是产品经理（验收负责人）。请对照 PRD 验收标准对本次交付做最终验收。
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
4. 改动集中（即便含测试/回归）→ 按性质选 lite/tech，不必 full。

【输出】只输出一个 JSON 对象（不要任何其他文字）：
{ "mode": "patch|lite|tech|medium|full", "kind": "一句话性质", "needDesign": true|false, "complexity": "small|medium|large", "rationale": ["关键论据1","关键论据2"], "confidence": "high|medium|low" }`

/** tech 档 PRD：技术变更单（无功能 AC，重范围/目标/改动面/回归）。 */
export const techChangePrompt = (requirement, root) => `你是资深技术负责人。当前工作区即为目标项目。这是一个**技术驱动改造**需求（重构/优化/升级/架构/依赖/技术债）——产品不需要完整功能 PRD，但需要一份**技术变更单**作开发/QA/验收与记忆回写的契约。
${productCtx(root)}【原始需求/改造目标】
${requirement}
【要求】
1. 产出「技术变更单」（Markdown），写入 docs/technical/ 下（如 docs/technical/changes.md 或 TECHNICAL.md 新增小节）——**不升级/不改写 docs/prd/PRD.md 的功能 AC**（技术驱动改造原则上不新增用户可见功能验收项；若确有一点用户可见行为变化，在该节显式说明）。
2. 变更单内容：改造背景与目标（一句话）、影响范围（涉及文件/模块）、技术方案要点（改动思路）、行为兼容性影响（有无用户可见变化）、回归与验证方案（跑哪些验证命令、回归底线）、风险与回滚。
3. 同步更新 docs/teamflow/memory.md 记录本次改造（版本 / 变更单位置 / 状态）；不改 AGENTS.md 除 teamflow 托管区外内容。
4. 精炼（这是给开发/QA 的契约，≤120 行），输出中文 Markdown。`

/** patch 档 PRD：单点修复快速确认（不产 PRD 文档）。 */
export const patchConfirmPrompt = (requirement, root) => `你是资深工程师。当前工作区即为目标项目。这是一个**hotfix / 单点修复**需求——不做完整 PRD，只做一次简短确认（≤40 行）。
${productCtx(root)}【原始需求】
${requirement}
【要求】
1. 判断是否确为单点/热修：是 → 输出「确认单」；否 → 显式说明"建议升级流水线模式（如 tech/lite/full）"，不要硬做。
2. 【需求核对】**先核实需求描述与工作区实际是否一致**（如需求称"某处标点错字"，实际该处是否真存在此错；是否确实需要改动）：一致 → 按下列确认单产出；不一致（无此错/现状已无需改/需求站不住）→ 在确认单中显式指出「需求与实际不符，建议取消改动或调整需求」，**不得臆造改动**。
3. 确认单内容：修复点（文件/位置）、改动概述、回归影响（极小 / 需跑哪些验证命令）、是否顺带同步版本号。
4. 只输出确认单文本，**不改任何产品文档**（本次不产 PRD；记忆回写由验收阶段负责）。`
