# TeamFlow 待办（TODO）— 未完成事项，按需查阅

> **本文件不注入 agent 会话**（AGENTS.md 只含当前态约束）；维护者/按需查阅用。
> 已完成条目直接删除（不留 ✅ 残骸，git log 可追溯）。

## 真待办（需人决策/行动）

- 🔜 **D（QA 轮次改成收敛判据）——先埋点再定**：52 个历史 run 实测——发生打回 **7/52**（每次至多 1 轮，唯一 2 轮那次是幻影）、**触达复验上限 1/52**、验收未跑 1/52，即「真正需要第 3 轮修复」**从未真实发生**；且「同一缺陷原样复现就早停」**按缺陷 id 判不出来**（QA 每轮重新编号：r9 三轮分别是 `QA-*` → `R2-*` → `R3-*`），稳定身份键只有 B 方案刚加的「检测命令」。**待定**：是否先在 QA 循环里埋点、把每轮阻断集合（id + 检测命令 + 类别命中数）记进 journal，等攒到若干真实复验轮数据，再决定要不要把 `QA_REWORK_LIMIT` 的硬上限换成收敛判据（阻断数严格下降且缺陷不重复 → 允许再来一轮；停滞 → 立即转人工）。**先定判据再动状态机**（ADR-0007 语义，回滚成本高）。**E 已落地**（超限时以「已知问题」只读模式跑验收，结论强制需人工裁定）。**D 埋点已落地（2026-09-15）**：QA 循环每轮把阻断集合的稳定身份与增/减/停滞计数写进 `journal.qaRounds`（`{round, seq, blocking, p3, defects:[{id,sev,module,fp}], withCheck, withCriterion, qaCalls, fixCalls, gate, newFps, repeats, resolved, outcome}`，留最近 12 轮），配只读读侧 **`node scripts/qa-rounds-report.mjs`**（每 run 轮次表 + 聚合：收敛 vs 停滞次数、检测命令可用率、门禁落地率、单轮成本）。**待定**：等攒到若干真实复验轮（最好含至少一次 `repeats > 0` 的停滞样本）后再决定要不要动 `QA_REWORK_LIMIT` 的语义。
- 🔜 **流水线执行体数量 = 阶段 × 子任务 × 打回轮次（文件/成本的最大乘数；需人决策）**：r9 实测（`tf-mu2ioilr-95l4th`）一次 full run 起了 **10 个子代理**（PRD 1 + 技术 1 + 开发 5 = T1–T5 三个并发执行体 + 两轮 QA 打回修复 + QA 首轮 + 两轮复验），**718 次模型调用 / 59 分钟**，其中**首轮 QA + 2 轮打回 + 2 轮复验 = 440 次（61%）**花在打回闭环，且该轮最终因一个 P2 走到复验超限、**验收被跳过**（status=completed + humanIntervention）。这也解释了「为什么一次 run 会有上百个日志文件」（每个执行体各自留痕；生成量纪律已单独收敛，见 AGENTS §5 日志生命周期锚点）。**待定**：QA 独立探针/复验的输入能否复用（当前 prompt 明令独立，防同源假绿）、打回上限与轮次成本是否要按缺陷严重级分档（P3 观察项不该触发整轮复验）、以及 dev 子任务拆分的粒度收益是否值这份上下文开销。**先定判据再动**（回滚成本高、质量是这个项目的第一约束）。
- 🔜 **P2 双语遗留的 P3（原 6 项，2026-09-15 已清 4 项）**：
  - **`clip()` 截断标记未本地化**（`host/util.ts` 的 `…[已截断 N 字符]` 会出现在 en 注入文本/Remote 报文里）：41 个调用点需加 locale 参数——**风险在 zh 逐字平价**（AC-9 只增不改），建议按面分批（先 prompts/state 注入面，再 Remote/持久化面）。
  - **`teamflow_*` 工具描述内嵌中文**（`host/index.ts` 的状态名与中文短语示例）：插件**加载期**注册 = 此时无语言源（客户端还没推），改双语需先定方案（惰性 description / 注册后更新）；且中文短语对**中文需求的工具触发**有正向作用，直接删反而有害——**先定判据再动手**。
  - **R3-5 口径确认**：zh prompt 文本有 7 处语义等价改动（`(Markdown)`→`(Chinese Markdown)` + 中英混排处插空格），需确认 AC-9「逐字不变」是否覆盖 prompt 文本；不覆盖则关闭为备案。
  - **R3-6 备案**：`resolveLocale({get client(){throw}})` 自身无 try/catch（生产调用方 `ambientLocale()` 已整体兜住，实际不可达）——是否加防御由维护者定。
- 🔜 **`$DSH_HOME/teamflow/` 无遗忘机制（演练脚本实测佐证）**：11 个目录里 6 个是空壳（只写过 `teams.json`，从未跑流水线）、1 个旧格式 key 残留；`runs/` 无 TTL 无归档策略（单个最大 137 KB，`ws-tetris-e22c5cf9` 累计 2.90 MB），`backlog/*.json` 各配一个等大 `.bak`，`_archive/` 只有一次手工归档。宿主自己有 `dsh-output-retention` / `dsh-compaction`，插件这块空白。待定：空壳目录自动归档阈值（如「90 天无 run 且无 backlog」）+ runs 滚动上限。**注（2026-09-15）**：`logs/` 这一块已有遗忘机制（每工作区保留最近 20 次 run，起跑时淘汰——见 AGENTS §5 日志生命周期锚点）；本条的 `runs/` 与空壳目录仍未覆盖。
- 🔜 **护栏复读检测迁出弃用读取器（唯一剩余处）**：提醒通道已改官方 `Agent.inject`、挂死检测已改官方 `subagentTiming` 投影（v0.1.7）；只剩**复读检测**仍读事件（需要流式文本内容）。官方替代是**订阅 `'session/event'` post-commit 投递**（`packages/core/session/src/index.ts:62-72`，agent-scoped 过滤）——把 15s 轮询 + 历史扫描换成增量推送。**动手前先定等价判据**（判据漂移直接影响误杀率：参考 tf-mte906e9 退化误判、json-parse r1 挂死误杀两次实锤）。
- 🔜 **工作区 key 迁移（破坏性）**：`context.ts` 的 UUID 分支**当前不可达**（宿主 `resolveByPath` 是 `async`，我们同步调用 → 永远走 `slugPath(cwd)` 路径派生 key）。要真用 UUID 须改 `await` + **迁移 `$DSH_HOME/teamflow/<key>/`**。v0.1.7 已把文档/注释改成事实。
  - **v0.1.9 已出演练脚本** `scripts/migrate-workspace-key-dryrun.mjs`（只读，反推 `runs/*.json` 的 `workspacePath` 重算期望 key + 按路径分组出合并计划 + 同名文件内容冲突检测）。
  - **实测结论（2026-09-12，本机 11 个产品线目录）**：key 与路径自洽 4 条、**漂移 0 条**、旧格式 key 1 条（`tetris-f06370e8`，无 `ws-` 前缀，0 run）、**空壳 6 条**（只写过 `teams.json`，从未跑流水线）。**即「同一项目裂成两条产品线」尚未实际发生**——此前按目录名推断的 tetris 分裂是误判（旧格式目录是空的）。
  - **因此优先级下调**：迁移按「风险」排（换盘符大小写/软链/移动目录即裂），不按「已发生损失」排。真做时先 `await` 化再合并，顺序反了会新旧 key 同时写入。
- 🔜 **用「持久化」类需求重跑验证 ADR-0006**：确认 M0 状态核对注入、M1 蓝图产出（架构阶段不再被 lite 跳过）、M2 dev 按蓝图拆任务、M3 验收架构核验（重复适配器应被打回）全链路生效。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- `STAGE_TOKEN_BUDGET=60k` 硬编码 → 可升级为 service Config（熔断阈值可调）。
- 🔜 **给官方提交 PR（低侵入原则下不自改 DSH）**：`conversation` 服务增加 `setView(viewId)`（复用内部 `store.actions.setView`），使「查看子代理会话」可一键跳转并自动切到「对话」tab；PR 合并前暂用 B 方案（按钮加引导文案：「跳转后请切「对话」tab 查看轨迹」）。
- 🔜 **跨会话跳转子代理（同 PR 范畴）**：DSH 子代理目录按父会话加载，`selectSubagent` 不支持跨父导航。已记录 `journal.ownerSession`（发起会话，下发于 stageDetail），跳转按钮在 ownerSession≠当前会话时**禁用 + title/文案提示**；待官方支持跨父会话导航后再解锁（数据已备好）。

- 🔜 **需求澄清闸门缺失（启动前无 agent 侧需求探讨）**：现状 `teamflow_start` 三道预检（`no-team` / `needs-confirmation` 疑问句式正则 `host/index.ts:162` / `needs-decision` git 决策 `:191-233`）只覆盖「要不要做」「怎么开工」，**零需求澄清**；且 `needs-confirmation` 只认疑问句式，陈述式探索（「我最近在想加个 X」）直接开跑。`prdPrompt` 7 条 REQUIREMENTS（`host/prompts/index.ts`）无一条「信息不足时提问/列待澄清项」→ 歧义需求被 PM **静默假设**填满 AC；下游门禁只验「有没有实现 PRD」，无人验「PRD 是不是用户想要」。本质 = **缺一个 agent 侧的 plan / 需求探讨环节，没跟用户对齐需求就开干**。约束（决定落点）：宿主 `DELEGATED_CALLER` 禁止子代理问用户 → 澄清只能落主线程（runtime root）。方向（已与维护者对齐）：`runTriage` 多输出 `intent`（需求 vs 讨论/探索，取代疑问句式正则）+ `blockers[]`（动工前 must-know 缺口）；不齐备 → `teamflow_start` 返回 `needs-clarification`（硬 no-start）+ 结构化问题，**主线程在自己的对话里把 `blockers` 自然问出来**（复用 `needs-decision`/`needs-confirmation` 的「返回 status → 主线程问 → 回带答案重调」通道，**不新触发 `ask_user_question`**），答复作 `requirementSupplement` 回填 journal 后启动；并把「歧义/缺 must-know 的需求先问再启动」补进选团队注入的 `teamflowContextText`（`host/index.ts:486-488`，`selectTeam:824-849`）。判据：只拦 must-know（能自查的不问、答错不返工的不问）。**待维护者拍板后落地**（产品改进，agent 不主动做）；本次讨论草稿为临时文件不进项目。

## 优化候选（2026-09-10 四路调研 + 自查，按收益/成本排序）

- **按阶段下发 `reasoningEffort`（token 大杠杆）**：✅ v0.1.7 已落地两处机械阶段降档（patch 单点确认 + scaffold → `low`；重试回升 high；先经 `resolveModelInfo` 探测能力再下发），链路正确性已证（降档日志只在 low 臂出现）。**A/B（n=3/臂，同需求同档位，只比「单点确认」阶段）**：均值 output 8,774 → 5,047（−42.5%）、每次调用 output 1,211 → 612（−49.5%）、耗时 96.4s → 42.9s，但 **计费总量只 −12.8%**，且**区间大量重叠**（low 的 L4 自己探索 13 次调用，反比 high 的 H6 更贵）——**n=3 下差异统计上不可分**，因此**不宣称节约百分比**。**剩余**：① 要可信数字需要更大任务样本或固定调用数的评测场（本任务 run 间方差压倒 effort 效应）；② 是否把 `dev` 的机械改动也纳入降档（当前保守不动——判据型阶段，需更多证据）。
- **产物可见性（客户端）**：✅ v0.1.8 已做完（v0.1.7 的 present 交付卡 + 工作台 `openResource` 预览 + v0.1.8 的 `main`+`sidebar.panellist` 全局面板 + 右栏 run 详情 tab）。**剩余**：run tab 的 `sidebar.right.pane.tab.title` seat（chip 标题现取 `definition.title`）；全局面板**只读**——没有 backlog 流转写路径（缺 product-keyed 的 `productBacklogUpdate`；补写要带审计 reason 且服务端仍有状态机守卫）。
- **客户端渲染组件分叉**：`client/shared.tsx` 只统一了主题/词表/格式化，`TeamFlowView`/`PipelinePanel`（会话内）与 `panel.tsx` 的 `RunList`/`BacklogGroups`/`RunDetailPane`（全局 + 右栏）仍是两套渲染实现——收敛成一个组件族（数据源差异用 adapter 表达：sessionId 寻址 vs 产品线寻址），否则后续每加一个字段都要改两处。
- 🔜 **已核实的宿主门控（勿重复踩）**：**右侧栏的会话内容只在对话视图存在**——`ui-sidebar-right/src/client/shell/RightbarRoot.tsx:13` 用 `activePanelId === null` 门控（源码注释原文「or no content for a global panel」）。任何占 `main` 的面板里调 `ctx.sidebarRight.openResource` 都会抛 `no session surface is mounted`（binding 未发布）；正确姿势是先 `layout.selectPanel(null)` 切回对话、等 seat 挂载 bind（切换后的 effect）再打开——本项目已按此法实现并带小步重试（实测 tf-mtvrsakj-l2vj5u）。
- **工作台「列出子代理」改用 `ctx.subagents.listChildren`**（官方 API，覆盖 one-shot + continuable，带 `activity`）；注意它**无 `createdAt`/`runId`/`outcome`**——run 顺序与归属仍以 journal 为准。
- 🔜 **continuable 试点（独立 ADR 规模）**：QA 打回复用**同一个** dev 子代理（`startContinuable` + `steerHostSubagentPrompt`/`queueHostSubagentPrompt` + `interrupt`），替掉「重开子代理 + 重灌蓝图」。代价明确：无 `run.result`（改走 `subagent/end` + `finalAssistantOutput`）、**不支持 `outputSchema`**、初始 prompt 会被追加 return guidance（动 prompt 契约，L1/L2 要同步）、web 主流程**无人 drain**（须自行 `drainContinuableChildren`）、中断语义变化。
- **评估过但否决（勿重复调研）**：
  - **插件级用户记忆层（ADR-0009，2026-09-12 否决）**：曾设计 `$DSH_HOME/teamflow/_user/{memory.md,index.json}` + 流水线启动时注入索引。否决理由：① **场所错位**——用户偏好是多轮对话的产物，流水线是「一需求一链路」批处理，没有这个场所；② **输入不足以判断普适性**——流水线任一时刻只有当前产品线上下文，归纳出的「通用约定」都是当前需求里的约定，普适性是猜的；③ **两条替代路径已够**——跨产品用户约定写宿主原生的 `$DSH_HOME/AGENTS.md`（`dsh-agent-instructions` 无条件注入，插件零代码），插件硬规矩直接进 prompt/模板（已在做）；④ **突破 ADR-0002 写域边界**。再评估触发信号见 ADR-0009 末节（宿主取消该能力 / 出现用户无法用一次文件表达的真实需求 / 流水线形态变为长期持续交互）。
  - 迁移到 `dsh-workflow` 原语（`agent/pipeline/parallel/phase`）：host plane 解析不到 `ctx.workflowEngine`（标准 preset 把它 `isolate` 在 agent 组内）+ 前台运行/无持久化/**无重试** → 等于丢掉 resume/熔断/护栏。
  - 依赖实验性 Agent Teams 包（`@deepseek-ai/dsh-experimental-*` 5 个）：无稳定性承诺、**稳定包被禁止依赖实验包**、用户须显式加 profile → 与「可分发插件」定位冲突。
  - **`subagent.toolFilter` 做宿主强制工具裁剪**：`tools.restrict()` 对**未知工具名 fail-loud 抛错**，而子代理工具集随 preset/深度变化（如 maxDepth 下没有 subagent）→ 跨 profile 会让子代理 **start 直接失败**；`maxDepth` 也不是嵌套约束（`resolveChildDepth` 超限只是抛错，不传播限制）。即「QA 禁改产品代码」这类按名字裁剪无法安全表达。
  - 把阶段指令搬进 system prompt（会作废跨子代理前缀复用，冒烟 93% 命中率靠它）；`contextBreakdown` 当熔断/计费依据（官方明确是启发式）。