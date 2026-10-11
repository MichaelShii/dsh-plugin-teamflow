# ADR-0006：流水线「认知前置 + 架构落地」重构（质量优先于 token）

- 状态：已接受（Accepted）
- 日期：2026-08（v0.1.0）
- 关联：`host/core/sanity.ts`（新）、`host/core/pipeline.ts`、`host/core/state.ts`、`host/core/triage.ts`、`host/util.ts`、`host/prompts/index.ts`、`store.ts`

## 背景

对同一持久化需求的 A/B 实测（见 `docs/benchmarks/pipeline-vs-native.md`）暴露根本问题：
- **功能等价 ≠ 代码质量等价**。流水线 dev 输出 game.js/audio.js 两套几乎重复的 safeStorage 适配器、键名分散；原生 DSH 输出独立 storage.js + PERSIST_DEFS 单一事实来源 + verify-storage 专测。
- 根因不是「流水线 vs 原生」，而是流水线**跳过了「建全局认知 → 架构决策」**：TOKEN_HYGIENE 让 dev「只读任务内文件」，state 只传"结论摘要"不传"架构蓝图" → dev 在无全局视野、无设计引导下散落实现。

原生工作流实证（`docs/benchmarks/native-workflow.md`）：原生高质量 = 环境探索 → 全局 READ → **Design Decision** → 基线验证 → 实现，**次序不可跳过**。而流水线为省 token 压掉了这个自然涌现。

DSH 无内置"认知构建"机制（standard preset persona 只有一句身份；仅 plan-mode 有 "Explore first"）。所以流水线**必须显式化**这套认知流程，不能指望模型自觉。

## 决策

### 三情况协议（认知传递的总原则）
- 情况一（全新会话 0 认知）：读索引减量 + 定向精读，建认知。
- 情况二（续会话）：**默认认知已过期**（多人/场外提交/非流水线改动）→ 先状态核对再复用。
- 情况三（新会话处理新需求）：共用 state/记忆减量 + 轻量核对现状。
- 核心：**认知资产可复用"减量"，但永不能替代"对代码库当前真实状态的核对"**。

### M0 状态核对（`core/sanity.ts`）
- `executePipeline` 开头（PRD 前）host 侧直接跑 `git branch/status/log`，产出 `externalDiffs` 摘要。
- 注入所有后续阶段 prompt（经 `state.__runCtx.sanity`，`stateSliceFor` 统一渲染）。
- 持久化到 `journal.sanity`（审计）。失败优雅降级为"无法核对"，不阻断流程。

### M1 架构阶段全模式启用
- `lite/tech/patch` 不再跳过技术/架构阶段——改为**轻量架构蓝图**（`architectPrompt`，只产蓝图 JSON，不写文档）；`full/medium` 由 `techPrompt` 产蓝图 + 完整文档。
- `architectPrompt` 明确**允许整文件 read 关键源文件**（豁免 TOKEN_HYGIENE「别整读」——架构决策需要全局视野），先读状态核对，再建全局认知，最后输出结构化蓝图。
- 架构蓝图 = `<!-- blueprint -->{json}<!-- /blueprint -->` 块，host 用 `extractBlueprint` 解析，`render` 注入 `state.__runCtx.blueprint`。

> ⚠️ **订正（2026-10-09，用户 Typora / VS Code 预览实测证伪）**：上面这两条在**形态**与**通道**上均已变更，
> 原文保留仅作历史。`render` 注入 `state.__runCtx.blueprint`（M2 继承）的机制**未变**。
>
> **① 标记形态**：open 改为 `<!-- blueprint`（**不带尾部 `-->`**），close 仍为 `<!-- /blueprint -->`。
> 旧形态的 open 是**自闭合注释**（`<!--` + 名字 + `-->`），渲染器把整条消化掉 ⇒ 紧随其后的 JSON 成为
> **裸文本**，在 Typora / VS Code 预览里直接显示给用户。实测（markdown-it `html:true` + 无头 Chrome）：
> 旧形态 `OLD=[正文A {"phase":"prd",…} 正文B]`、新形态 `NEW=[正文A 正文B]`。
> 解析器**两种形态都认**（`(?:-->)?`），兼容存量产物与模型旧习惯。
> ⚠️ `<!-- state -->` 块有**同一个缺陷** —— 它只是因为走了文件通道才没暴露。
>
> **② 通道**：蓝图**不再写进 `TECHNICAL.md`**，改为独立文件 `logs/teamflow/<runId>/blueprint.json`
> （与 state 块同构的机器通道）。理由：Tech 文档是 `TEAMFLOW_ARTIFACT_ORDER` 里的 **user-facing
> deliverable**，而蓝图块真机实测占它 **31%** 字符（5403/17583）；移出后文档回归纯人类可读，
> 且**不依赖任何 markdown 解析器的注释语义**（Typora 是自研解析器，新形态在它上面的行为未实测）。
> host 解析链为**三级回退**：① 回复正文 → ② 独立文件 → ③ `TECHNICAL.md`（历史通道，兼容存量 run）。
> 该文件是**纯中转**，host 读完即删；⚠️ 清理与「通道是否命中」必须**解耦** —— 模型「既回显又写文件」时
> ② 分支不执行，若把删除写在里面就漏删，而可续跑终态（failed/cancelled/interrupted）**不归档** ⇒ 永久残留。
>
> **③ lite 档回复**：`architectPrompt` 改为「回复给人类可读的架构摘要 + JSON 写文件」。
> 原因是它**不写文档**，回复是唯一产物，而 `STAGE_MIN_LENGTH.tech = 350` ⇒ 只回一句「已写入」会被判
> `insubstantial`；并需澄清第 4 条 `write NO document files` 不覆盖这个机器通道文件。

### M2 dev 继承蓝图 + 自动拆任务
- `devPrompt` 注入架构蓝图，契约升级为"按蓝图在既有架构上实现"，允许小范围核实（不整读）。
- dev 任务来源优先级：**蓝图 tasks（架构师自动拆，按文件边界）> 调用方 tasks > 整体开发**。
- 冲突检测：蓝图任务 files 有交集 → 合并（保证并发不写同一文件）；无交集才并行。

### M3 质量门禁
- QA/验收 prompt 加「架构核验」：核对是否遵循蓝图、有无重复实现/适配器漂移/该抽象未抽象。
- `parseAcceptanceVerdict` 扩展：命中架构打回信号（架构返工/重复实现/偏离蓝图/该拆未拆/该抽象未抽象/破坏既有结构）→ `rework`，即使结论行写"通过"。
- 验收不再是"verify 全绿即通过"；架构偏离 → 有条件通过（返工）或打回。

### triage 配套
- SIGNALS 增架构性词（持久化/localStorage/存储/独立模块/抽象/跨模块等）。
- 架构护栏：命中架构性信号且判 lite/tech/patch → **强制 medium**（必须有架构阶段）。
- TRIAGE_PROMPT 增第 5 条架构判据。

## 理由（质量优先于 token）

- **代码质量是生产底线**：不能为省 token 放弃架构。省 token 的正确方式是把建认知+出设计做成**一次共享**（tech→蓝图→dev 继承），而不是让每个 dev 各读一遍（重复）或都不读（没认知）。
- 让「架构阶段」全模式存在，是把原生工作流最值钱的「全局读 → Design Decision」固化成一个真实阶段 + 一种共享数据（蓝图）。
- 验收加架构门禁，把"防重复/防散落"变成可判定的门禁，而非靠各 agent 自觉。

## 影响

- lite 语义变化：仍跑轻量架构阶段（产蓝图不写文档）；triage 对架构性需求强升 medium。
- dev 任务可能被蓝图自动拆解（架构性需求不再退化为"整体开发"单任务）。
- 验收更严格：架构偏离会打回（首次可能增多返工，但这是质量投入）。
- `journal.sanity`/`journal.blueprint` 新增字段；`state.__runCtx` 为运行时注入（不持久化）。

## 后续

- 用「持久化」类需求重跑，验证：M0 状态核对注入、M1 蓝图产出、M2 dev 按蓝图拆任务、M3 验收架构核验效果。
- full/medium 阶段集差异执行仍待做（ADR-0004 §影响）。
- 认知传递的更深层（如共享向量/结构化知识）依赖 DSH 未来能力，当前用"蓝图 + 状态核对"显式化已覆盖根因。

## 修订

- **2026-10-09**：M1 的蓝图**标记形态**（open 去掉自闭合的 `-->`）与**通道**（改走独立文件
  `logs/teamflow/<runId>/blueprint.json`，不再写进 `TECHNICAL.md`）变更；lite 档回复改为「摘要 + 写文件」。
  起因：`<!-- blueprint -->` 是自闭合注释 ⇒ 紧随其后的 JSON 裸露在 markdown 预览里
  （用户 Typora / VS Code 截图证伪了「HTML 注释渲染时不显示」这一假设）。
  原文保留，逐条订正见 §M1 内的引用块；`render` 注入 `state.__runCtx.blueprint` 的机制**未变**。
