# Changelog

> 本插件首次公开发布版本为 **v0.1.0**；发布前的内部迭代（v0.3~v0.13）记录于 `AGENTS.md` §5，对外统一归到 v0.1.0。

## [0.1.8] - 未发布

### 新增
- **全局团队工作台（`sidebar.panellist` + `main`）**：工作台从「某个会话里的一个 tab」升级为应用级主面板——左侧边栏多一个图标（inline SVG，跟随选中态），点开中央主区即整块换成 TeamFlow：左栏是**产品线**列表（`$DSH_HOME/teamflow/<key>` 扫描，含 run 计数/活跃数/最近需求与验收结论/磁盘路径），右栏是该产品线的 **run 列表 + backlog 分组**（需求/任务/缺陷，含按角色 token）。**不依附会话**：面板在 root scope（无 `useSession`/`useProjection`），所以数据面新增按**产品线 key** 寻址的 remote 方法（`products` / `productView` / `productRunDetail` / `productStageDetail` / `productItemDetail`），与会话内工作台同源装配（同一批 journal 与 state.json，非新数据模型）
- **run 详情进右侧栏 tab**：注册 `teamflow-run` tab 类型（认领 `dsh-resource://teamflow/run/**`），在会话内点 run 即在该会话右侧栏打开完整详情（阶段表 + 官方口径 token + 阶段详情/尝试聚合/验证证据/产出/日志）。地址由 host 生成（client 不拼地址）——与产物预览同一条原则。**右侧栏的会话内容只在对话视图存在**（宿主 `RightbarRoot` 门控），所以全局面板里点 run 默认在**面板内联**显示；要并排看就点「对话右栏」——它会切回对话再打开右栏（seat 在切换后才 bind，故带小步重试）；任何一步不可用都降级面板内联并给出**可见提示**（不静默失败）

### 改进
- **客户端展示层收拢**：主题 token / 状态词表 / 格式化（token 官方口径、时间、耗时、折叠文本）从 1286 行的 `client/index.tsx` 抽到 `client/shared.tsx`，会话内工作台与全局面板共用一份——两处展示语言不会再各自漂移
- **宿主 slot 契约对齐**：`dsh.client.inject` 补 3 个 slot owner 包（`ui-layout` / `ui-sidebar` / `ui-sidebar-right`，注册进谁的 slot 就列谁）+ 对应 optional peer 声明，避免加载顺序不确定导致的「slot 不存在」

### 已知待办
- 全局面板目前**只读**（未提供 backlog 流转写路径）；两处渲染组件仍分叉（`shared.tsx` 只统一了词表/格式化）；run tab 未注册 `sidebar.right.pane.tab.title` seat（chip 标题取自类型定义）。见 `docs/TODO.md`

## [0.1.7] - 2026-09-11

### 新增
- **工作台产物一键预览**：任务卡详情里的「任务夹」现在按真实存在的产物列按钮（PRD / DESIGN / TECHNICAL / QA-REPORT / ACCEPTANCE / meta），点一下即在 DSH **右侧栏**打开预览（Markdown 由官方文档预览器接管）。地址由 host 用官方 `fileAddressFor` 生成（`dsh-resource://file/session/<id>/<相对路径>`）——客户端不拼地址、也不引宿主包进 client bundle；只列真实存在的文件（不出死按钮）；右侧栏服务缺失时静默降级
- **产物交付（`present`）**：prd/tech/qa/acceptance 四个阶段被要求把任务夹产物交给官方 `present` 工具 → 用户在该会话得到「交付文件卡」（预览 / 默认程序打开 / 文件管理器定位）。诚实标注为 `[policy]` 增强项：文件仍是唯一事实源，缺文件依旧是硬失败；卡片渲染在**该子代理会话**的轮次尾部（主会话不显示）
- **机械阶段推理强度降档（省 token）**：DeepSeek 路由默认 `reasoningEffort: high`，而推理 token **计入 output** 且**推理内容每个带推理回合原样回传**（同时抬高后续 input）。现对两处机械阶段下发 `low`——patch 档的「单点确认」与 `scaffold`（脚手架落地）；判据类阶段（PRD/设计/技术方案/QA/验收）保持宿主默认 `high`，**重试自动回升 `high`**（质量优先）。安全前提：先经 `llm.resolveModelInfo()` 探测该路由的 `reasoning.efforts`，只有声明支持才下发——宿主对不支持的值会 `UNSUPPORTED_REASONING_EFFORT` 硬失败且不降级；探测结果按 provider/model 缓存。阶段日志记录实际下发的档位

### 修复
- **token 计量改走官方 Session 投影（宿主弃用同步事件读取器）**：dsh 0.1.5-rc.2 起 `Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 标记为 deprecated（存量可留、新调用禁止，宿主方向是不再把完整事件序列常驻内存）。计量来源改为**官方投影优先**——`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶（与宿主 token-meter 同一份 fold，重试替换语义更准）+ `'sessionStats'.steps` 取调用数，**零历史扫描**；投影缺失/无数据/读取异常时静默回退原事件扫描（最小 profile 与存量宿主不受影响，不虚报 0，不中断流水线）。`sessionProjections` 走可选 `ctx.inject`，不进 `static inject`——服务缺失时插件照常加载
- **护栏适配官方通道（提醒 + 挂死检测）**：轻提醒从手写 `session.append('user/message')` + step/end flush 时序状态机，改为官方 `run.localAgent.inject()`（宿主在协议安全边界整批认领，旧注释声称的「会插进 tool_calls→tool_result 触发 400」不成立）；挂死检测从「多源取最长事件视图」长度启发式改为官方 **`subagentTiming` 投影**的 `active.through`（已提交事件时间，不受视图失明影响——上次 QA 误判 stalled 的根因）。长工具静默执行仍由 agent 活动守卫豁免；投影不可用时回退旧启发式。中止语义未变

### 改进
- **声明宿主兼容窗口**：`package.json` 新增 `engines.dsh: ">=0.1.5-rc.2 <0.2.0"` 与 `dsh.manifestVersion: 1`（dsh 0.1.5 起支持的公共 manifest 字段；当前宿主不校验，属作者声明）；README「版本锚定」段同步到 v0.1.5-rc.2，并记录本次兼容核对结论与两个待跟进项
- **清理死注入**：`static inject` 长期硬注入 `tokenMeter` 却全仓从未使用 → 从 static inject / setRuntime / runtime 三处移除（假依赖会拖累插件的加载条件）
- **工作区 key 文档纠偏**：`workspaceScopeOf` 的「优先用 DSH workspace UUID」分支**当前不可达**（宿主 `resolveByPath` 是异步、我们同步调用），实际生效的是路径派生 `slugPath(cwd)`；注释与 AGENTS.md 改为事实描述，真修（改异步 + 存储 key 迁移）列入 `docs/TODO.md` 待 v0.1.8

### 已知待办
- **护栏复读检测仍读已弃用的事件读取器**（提醒通道与挂死检测已改官方；复读需要流式文本内容）：官方替代是订阅 `'session/event'` post-commit 投递，需先定等价判据，见 `docs/TODO.md`（当前行为不变，存量调用被宿主明确允许）

## [0.1.6] - 2026-09-07

### 新增
- **评测层 L1+L2（prompt/注入改动收益评测）**：每次改 prompt/注入后可直接验证收益——L1 行为级契约测试（直接调用 prompt 工厂断言产出锚点，29 条契约分 HOST-ENFORCED/policy/structural 三级，改 prompt 一眼看出断了哪条、丢哪级保障）+ L2 回放语料一致性门禁（冻结真实形状的 QA-REPORT/ACCEPTANCE/dev 回复/蓝图产物，喂宿主真实解析器做 golden corpus 回归，零 LLM 成本）。语料只增不改，防评测过拟合
- **dev/qaFix 验证证据块**：开发回复末尾强制「[Verification evidence]」块（命令+退出码+断言计数+失败行引用，或显式 N/A），host 提取存证、阶段详情可见、可与命令日志交叉核对——开发阶段从「单方宣称全绿」升级为「可审计的具体自述」
- **代码级英文化（为 UI i18n 铺路）**：代码判断/命名全英文（阶段键 prd/design/scaffold/tech/dev/qa/acceptance、任务结构化键 taskKey），中文只留展示层；存量数据提供迁移脚本

### 改进
- **resume 断点续跑状态机化**：两级状态（大阶段 + 子图任务）聚合判定——有 done 尝试的任务即成功（历史失败不算失败），resume 只补跑「聚合后未成功」任务、复用已完成产物；不再读 backlog 子卡（残留失败卡不再污染判定）；dev 部分成功时起点精确回开发补跑未完成，全 done 时正确落在 QA/验收
- **输出单轨制**：QA/验收的完整报告只写在任务夹文件（QA-REPORT.md/ACCEPTANCE.md），子代理回复仅摘要+路径——host 直接导入文件（缺陷表/核对表），杜绝「回复与文件不一致」的双轨问题
- **验收结论契约强度**：验收报告结论行必须为字面量模板（✅/⚠️/❌/📝 四档）且为文件最后一行；无结论行/空结论行 → 需人工确认（不再默认通过，防质量门禁漏报）
- **prompt 约束分级**：区分 [HOST-ENFORCED]（host 真实强制，如单轨产物/结论行）与 [policy]（自律 + 轻提醒），prompt 内不再自称 hard constraint
- **重试诊断包**：重试时把上次失败详情（outcome/护栏原因/拒绝词命中点/产出尾部）附进 prompt——盲试 → 带因重试；stalled（挂死/空转）不再自动重试

### 修复
- **token 计量适配宿主 session v2**：宿主新版会话已无 `events` 属性，计量读不到 → 流水线卡与图卡无「TOKEN · 官方口径」。修复：多源回退（snapshotEvents/ownEvents）+ usage 双路径（含 stream 内嵌），新 run 计量恢复
- **护栏挂死误杀**：QA 子代理正常干活却被判「10 分钟无事件」（宿主事件视图失明）——事件读取多源回退 + agent 活动守卫（非 idle 且已动手即不中止）
- **任务卡 token 统计**：子卡 usage 按 stage 引用直写（并发下不再错位/超计）
- **存量迁移脚本 taskKey 误判**：合法中文括号结尾的任务键不再被当作历史残留（幂等无损但计数虚高）
- **验收空结论行/裸否定词漏报**：四档词白名单校验覆盖 accepted 分支

### 其他
- AGENTS.md 注入面瘦身 64%；dsh 0.1.3-alpha.1 兼容性核对（依赖包名更新）

## [0.1.5] - 2026-09-01

### 新增
- **patch 档兑现「单 agent 直改 + 自测即交付」**：阶段集精简为确认单 → 单 agent 直改（2 段，无技术方案/QA/验收），开发完成（自测通过）即统一收口提交。UI 微调（按钮换位置/挪控件/改文案/间距/颜色）、常量调整、单点修复、回滚、笔误修正走最轻路径

### 改进
- **需求分诊重构为模型主导**：档位判断交给模型（自然语言语义，天然双语）；正则收窄为确定性护栏（架构信号强升/UI 不低于轻量档/显式设计升档）。UI 微调类需求（不改变行为/交互逻辑）不再误判标准档
- **分诊输出失败自动纠错重试**：只输出开场白无 JSON 时带提示重试一次，仍失败才走正则兜底

### 修复
- **外部中止（aborted）不再误报「预算熔断」**：重启等外部中止单独标记，明确引导断点续跑（补跑失败任务，已完成任务复用）
- **patch 档不再误跑架构蓝图**（技术方案块补 `enabled('tech')` 门控）
- **分支名不再被档位词污染**（「显式的用 patch 模式」不再产出 `feat/patch`）
- **provider 错误细节记录**（阶段失败记录底层错误信息）

## [0.1.4] - 2026-08-29

### 修复
- **分支决策死循环**：用户确认「新建分支」后重发启动参数仍会再次弹出分支决策（干净工作区场景）。修复：决策选项增加显式确认值，自定义分支名/工作区处理参数均视为已确认
- **护栏误杀大文件任务**：大文件「读-改-读-改」是正常模式（每次修改后必须重读确认），可能被误判为推理复读而中止。修复：复读判定升级为状态判定——有实际修改进展时不中止，仅纯复读（零进展）才中止
- **QA/验收只读任务不再被误杀**：执行测试脚本视为进展信号，只读分析任务（不做文件修改）不再被复读检测误伤
- **退化中止不再自动重试**：真退化（推理复读死循环）后自动重试大概率在污染会话内复现且持续烧钱——改为直接需人工介入，引导 `teamflow_resume`（全新会话续跑）
- **断点续跑尊重未闭环的 QA 缺陷**：阻断缺陷仍 open 时 resume 回到 QA 修复-复验闭环，不再带着已知缺陷直接进产品验收；验收失败过的 run 同样正确回 QA
- **历史失败记录保留**：resume 不再清除失败的阶段记录（审计可追溯）

### 新增
- **提测门禁**：开发阶段有任务失败（哪怕 1 个）→ 需人工介入，不再自动进入 QA（失败任务是已知缺口，QA 检查必然重复报告）；resume 精确补跑失败任务（已完成任务产物复用，不重跑）
- **README 界面预览**：5 张真实工作台截图（流水线视图/看板/阶段详情/看板任务详情/团队选择）

### 其他
- pnpm-lockfile 同步（依赖调整后 CI 的 frozen-lockfile 校验失败，已修复）

## [0.1.3] - 2026-08-29

### 新增
- **分支策略闭环（ADR-2026-08-27）**：启动前用户决策（`needs-decision` 四情况：main+干净/main+脏/feature+干净/feature+脏，stash/commit/新建/沿用/自定义兜底）；`branchPolicy`/`branchName`/`preAction`/`commitMessage` 决策参数；auto=建 `feat/<slug|branchName>`、keep=沿用；`preAction`（stash/commit）在 sanity 前执行
- **收尾合回决策（对称交互）**：完成汇报带「合回决策邀请」，新工具 `teamflow_merge`（host 代为合回 / 给命令自行合回 / 暂缓）；`journal.mergeStatus` 持久化（pending/merged/kept/failed）
- **统一收口提交**：子代理只改不提交（Git discipline 硬约束），host 验收通过后单 commit（代码+任务夹产物）；结构性消灭文档漏提交与未验收中间态
- **视觉验证能力条件化**：`llm.resolveModelInfo` 探测模型多模态能力 → QA/验收视觉条款动态生成（支持视觉=DOM 计算断言+截图看图+人工收窄；不支持=禁截图看图防幻觉/循环，只走 DOM 断言）；QA 人工补测清单收窄为音频/真机/FPS/读屏
- **需求意图预检**：疑问/建议/反馈句式（「是不是应该」「要不要」等）→ `needs-confirmation` 不启动，主线程先向用户确认
- **activeTeams 持久化**：会话→团队映射落盘，重启/刷新后恢复（UI 状态与启动通道一致）

### 修复
- **护栏注入通道**：`subagents.start` 句柄无 inject → 改用 DSH 官方 `session.append('user/message')`；注入改安全窗口（step/end 后 flush，防插进 tool_calls→tool/result 序列导致 provider 400，实测 tf-mtcnejqj 烧 1.98M）
- **复读检测重复计数 bug**：轮询重复收集事件导致计数虚增（实际 4 次 × 3 轮 = 12 压线误杀，实测 tf-mtcomxpq 开发两次）→ 增量收集
- **`isUnretryable` 覆盖 400/invalid_request**（provider 客户端拒绝不再重试烧钱）
- **开发任务全部失败停止流水线**（无产物可测时不再继续 QA 误测；部分失败仍继续）
- **resume 断点按阶段定位**（PRD 重试成功后不再被失败尝试带回重跑）
- **分支 slug 派生**（branchName > triageSlug > 需求英文词 > r<N> > feature；分支检查移到 initBacklog 之后）
- **journal.options 透传 branchPolicy 等决策参数**（keep 不再被吞，实测 tf-mtd6mbeq）
- **DSH 0.1.2-alpha.1 事件词汇适配**（text-chunks/reasoning-chunks → assistant/chunk 双兼容）；schema 校验兼容（needs-decision 不返回 runId 字段）

### 其他
- 执行路径基准（小需求样本）与假优化判定收敛：`docs/benchmarks/hold-pipeline-vs-native.md`（多花 44% 是质量预算非浪费，cacheRead 命中价≈1/10）

## [0.1.2] - 2026-08-26

### 修复
- host 就绪日志工具数改为动态计数（消除「工具 8 个」写死文案，与实际注册数一致）

### 变更
- 开源发布收尾：README 中英双语修正（架构计数 17/11、防假交付真实语义、快速上手、环境要求）；npm 元数据（keywords / homepage / bugs）；`react` 移入 peerDependencies + `peerDependenciesMeta`（防私有包 ERESOLVE）；CI 触发扩展 `main` + `release-*`；构建关闭 sourcemap（npm 包 -58%）；新增 SECURITY.md / CONTRIBUTING.md；deploy 同步清单移除 `.map`

## [0.1.1] - 2026-08-26

### 修复
- npm 发布包 `files` 白名单收窄为 `lib` / `cordis.patch.yml` / `README.md`，不再携带 `AGENTS.md` 与 `docs/adr`（开发者文档仅保留在 GitHub 仓库）

## [0.1.0] - 2026-08-26

### 初始公开发布
- 一句话需求 → 多 Agent 研发流水线（PRD / 设计 / 架构 / 技术方案 / 并行开发 / QA / 验收）
- backlog 持久化 + 断点续跑（自研 journal，不依赖 LangGraph）
- 防假交付：实质校验 + token 熔断 + 产品级并发锁 + 内存裁剪
- 完成汇总自动汇报主线程（空闲唤醒 / 忙碌注入）
- token 官方口径计量（输入未命中 / 命中 / 写缓存 / 输出 + 调用数 + 缓存命中率）
- lite / tech / patch 模式 + 模型驱动需求分诊（`teamflow_triage`）
- 🏭 团队工作台 Web tab：阶段泳道 / 拖拽看板 / 成本中心 / 人工介入中心
- QA 打回修复有界闭环（ADR-0007，超限转 needs-human）
- 任务夹文档制（ADR-0008）：每需求自包含任务夹，消除双归档 / memory 堆积
