# TeamFlow 待办（TODO）— 未完成事项，按需查阅

> **本文件不注入 agent 会话**（AGENTS.md 只含当前态约束）；维护者/按需查阅用。
> 已完成条目直接删除（不留 ✅ 残骸，git log 可追溯）。

## 真待办（需人决策/行动）

- 🔜 **护栏复读检测迁出弃用读取器（唯一剩余处）**：提醒通道已改官方 `Agent.inject`、挂死检测已改官方 `subagentTiming` 投影（v0.1.7）；只剩**复读检测**仍读事件（需要流式文本内容）。官方替代是**订阅 `'session/event'` post-commit 投递**（`packages/core/session/src/index.ts:62-72`，agent-scoped 过滤）——把 15s 轮询 + 历史扫描换成增量推送。**动手前先定等价判据**（判据漂移直接影响误杀率：参考 tf-mte906e9 退化误判、json-parse r1 挂死误杀两次实锤）。
- 🔜 **工作区 key 迁移（破坏性，v0.1.8 候选）**：`context.ts` 的 UUID 分支**当前不可达**（宿主 `resolveByPath` 是 `async`，我们同步调用 → 永远走 `slugPath(cwd)` 路径派生 key）。要真用 UUID 须改 `await` + **迁移 `$DSH_HOME/teamflow/<key>/`**（backlog/journal/teams.json 全在旧 key 下）。v0.1.7 已把文档/注释改成事实，迁移需先写脚本并演练。
- 🔜 **用「持久化」类需求重跑验证 ADR-0006**：确认 M0 状态核对注入、M1 蓝图产出（架构阶段不再被 lite 跳过）、M2 dev 按蓝图拆任务、M3 验收架构核验（重复适配器应被打回）全链路生效。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- `STAGE_TOKEN_BUDGET=60k` 硬编码 → 可升级为 service Config（熔断阈值可调）。
- 🔜 **给官方提交 PR（低侵入原则下不自改 DSH）**：`conversation` 服务增加 `setView(viewId)`（复用内部 `store.actions.setView`），使「查看子代理会话」可一键跳转并自动切到「对话」tab；PR 合并前暂用 B 方案（按钮加引导文案：「跳转后请切「对话」tab 查看轨迹」）。
- 🔜 **跨会话跳转子代理（同 PR 范畴）**：DSH 子代理目录按父会话加载，`selectSubagent` 不支持跨父导航。已记录 `journal.ownerSession`（发起会话，下发于 stageDetail），跳转按钮在 ownerSession≠当前会话时**禁用 + title/文案提示**；待官方支持跨父会话导航后再解锁（数据已备好）。

## 优化候选（2026-09-10 四路调研 + 自查，按收益/成本排序）

- 🔜 **按阶段下发 `reasoningEffort`（token 大杠杆，需 A/B 定量）**：`runner.ts` 现在只传 `provider/model/maxTokens` → 全阶段吃 DeepSeek 默认 **high**；而推理 token **计入 output**，且**推理内容每个带推理回合原样回传**（同时抬高后续 input）。做法：机械阶段降 `low`/`off`、判据类阶段保持 high、重试**递进加重**。前置：`ctx.llm.resolveModelInfo()` 读 `reasoning.efforts`（不支持的值宿主会 `UNSUPPORTED_REASONING_EFFORT` **硬失败且不降级**）。基线：2026-09-10 冒烟（lite、6 阶段、99.3k 未命中 / 1.37M 命中 / 48.2k 输出 / 54 调用）。
- **产物可见性（客户端）**：✅ 已完成 ①present 交付（prd/tech/qa/acceptance）与 ②工作台 `openResource` 一键右侧栏预览（v0.1.7）。**剩余**：③ `main`+`sidebar.panellist` 注册**全局**面板（不再依附单个会话 tab）；④ run 详情进右栏 tab（`sidebarRightTabs.register` + `openTab`），替掉画布内自绘浮层。注意 `main` 是 keyed/root scope——occupant 拿不到 `useProjection`/`useSession`，全局面板里的「当前会话」指标要走 `ctx.sessions.sessionOf` 或自家 remote。
- **工作台「列出子代理」改用 `ctx.subagents.listChildren`**（官方 API，覆盖 one-shot + continuable，带 `activity`）；注意它**无 `createdAt`/`runId`/`outcome`**——run 顺序与归属仍以 journal 为准。
- 🔜 **continuable 试点（独立 ADR 规模）**：QA 打回复用**同一个** dev 子代理（`startContinuable` + `steerHostSubagentPrompt`/`queueHostSubagentPrompt` + `interrupt`），替掉「重开子代理 + 重灌蓝图」。代价明确：无 `run.result`（改走 `subagent/end` + `finalAssistantOutput`）、**不支持 `outputSchema`**、初始 prompt 会被追加 return guidance（动 prompt 契约，L1/L2 要同步）、web 主流程**无人 drain**（须自行 `drainContinuableChildren`）、中断语义变化。
- **评估过但否决（勿重复调研）**：
  - 迁移到 `dsh-workflow` 原语（`agent/pipeline/parallel/phase`）：host plane 解析不到 `ctx.workflowEngine`（标准 preset 把它 `isolate` 在 agent 组内）+ 前台运行/无持久化/**无重试** → 等于丢掉 resume/熔断/护栏。
  - 依赖实验性 Agent Teams 包（`@deepseek-ai/dsh-experimental-*` 5 个）：无稳定性承诺、**稳定包被禁止依赖实验包**、用户须显式加 profile → 与「可分发插件」定位冲突。
  - **`subagent.toolFilter` 做宿主强制工具裁剪**：`tools.restrict()` 对**未知工具名 fail-loud 抛错**，而子代理工具集随 preset/深度变化（如 maxDepth 下没有 subagent）→ 跨 profile 会让子代理 **start 直接失败**；`maxDepth` 也不是嵌套约束（`resolveChildDepth` 超限只是抛错，不传播限制）。即「QA 禁改产品代码」这类按名字裁剪无法安全表达。
  - 把阶段指令搬进 system prompt（会作废跨子代理前缀复用，冒烟 93% 命中率靠它）；`contextBreakdown` 当熔断/计费依据（官方明确是启发式）。