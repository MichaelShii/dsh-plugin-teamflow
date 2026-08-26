# AGENTS.md — TeamFlow 插件开发守则与产品记忆锚点（dsh-plugin-teamflow）

> **任何加入本插件开发的 Agent（团队成员）必须先通读本文件**，再按 §2 文档索引读取对应文档，
> 不要在未了解现状前自行全量探索代码。
> 维护者：TeamFlow 自身演进（像对待产品一样对待插件工程）。

---

## 1. 这是什么

- **产品**：`dsh-plugin-teamflow` —— DeepSeek Harness 可分发插件，把「一句话需求 → 多 Agent 团队研发流水线」做成宿主能力。
- **形态**：host（Cordis service `teamflow`，node 侧）+ client（Web「🏭 团队工作台」tab）+ 模型工具（`teamflow_*`）。
- **运行环境**：web profile 宿主组合真实 Node 进程；`file:` 安装 + 从 profile 副本加载。
- **当前状态**（2026-08 大版本线）：
  - ✅ **领域化重构完成**：1418 行单文件 → 11 个领域文件（见 §3）
  - ✅ **token 官方口径计量**（usage = 输入未命中/命中/写缓存/输出/调用数 + 缓存命中率，ADR-0003）
  - ✅ **lite 模式 / mode 5 档 + 模型驱动 triage**（ADR-0004，`teamflow_triage`）
  - ✅ **full/medium 阶段集差异执行（ADR-0004 落地）**：`STAGE_POLICY` 五档策略表 + `resolveStages()` 纯函数，pipeline 的 design/scaffold/qa 门控改由表驱动；design/scaffold 全档位按显式 flag 条件化（不吞显式请求），patch 无独立 QA——见 §6

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| **摘要索引** | 本文件 | 先读：现状 / 结构 / 工程约定 / 待办 |
| 使用与架构 | `README.md` | 安装、契约速览、token/lite 说明、ADR 索引 |
| 决策记录 | `docs/adr/0001~0007` | 自研 journal(不引 LangGraph) / AGENTS 最小侵入 / 部署+token 口径 / triage+共享状态 / 需求无效→验收「需求不适用」拦截 / 认知前置+架构落地重构(质量优先) / **QA 打回修复有界闭环(ADR-0007)** |
| 测试 | `test/smoke.js` `test/stages.test.js` `test/verdict.test.js` `test/journal.test.js` | 结构/描述符 smoke + 档位阶段集 + 验收结论 + journal 行为 |

## 3. 工程结构（领域划分，单向依赖）

```
host/
├── index.ts            # 门面：TeamflowService + 工具注册(teamflow_*) + ACTIVE 注入
├── types.ts            # 公共类型（Journal/BacklogItem/PipelineOptions/PipelineMode…）
├── constants.ts        # 常量/阶段映射/预算（STATUS/PHASE_*/STAGE_TOKEN_BUDGET/MODE…）
├── util.ts             # 通用工具（clip/normalize*/suggest 辅助…）
├── prompts/index.ts    # 全部 Prompt（prd/design/scaffold/tech/dev/qa/acceptance + TRIAGE_PROMPT + 模板）
└── core/
    ├── context.ts      # 运行期共享状态单例（runtime + runs/inFlight/activeProducts + providerName）
    ├── backlog.ts      # Backlog 数据层 + storeFor + 缺陷解析 + 立项建卡 + 任务流转 + 视图/流转
    ├── metering.ts     # token 官方口径计量（accumulate/summary 三桶+calls+命中率）
    ├── runner.ts       # 子代理执行（runPool/runAgent/withRetry + 重试/熔断）
    ├── report.ts       # 完成汇总投递（deliverCompletion，官方口径汇报）
    ├── pipeline.ts     # 编排中枢（executePipeline/start/cancel/resume + MODE 归一；【mode 路由挂载点】）
    └── triage.ts       # 需求分诊（MODE_REGISTRY 策略表 + 正则预筛 + runTriage 模型驱动）
store.ts  # 持久化层（原子写/.bak/损坏自愈 + journal 序列化），独立 lib entry
descriptors.ts  # Remote 描述符（host/client 共用，单独 entry）
```

**规则**：依赖只允许 `types/constants/util` → `prompts`/`core/*` → `index`（门面）；严禁反向/循环。所有 Prompt 文本必须进 `prompts/index.ts`。

## 4. 工程约定

- **构建/验证**（插件目录下）：
  - `pnpm run typecheck` —— tsc --noEmit（改 type 后必跑）
  - `pnpm run bundle` —— tsdown → `lib/`（host.mjs/client.js/store.mjs/descriptors.mjs）
  - `pnpm test` —— smoke + journal（smoke 对 host 目录做源码断言：新增/移动函数后要同步指向）
  - **部署**：`node deploy.mjs`（构建+测试+同步 profile 副本 + 检测运行 web 提示）→ **重启 `dsh --profile web` 才生效**（易踩坑，ADR-0003）。
  - **发布**：`npm publish`（升 `package.json` version 后；`files` 白名单仅含 `lib`/`cordis.patch.yml`/`README.md`，`prepublishOnly` 自动 bundle+test；包名无 scope 默认公开，registry 为 npmjs.org）。
- **类型**：全 TS；host 必须构建（`node_modules` 下 strip-types 不生效）；`peerDeps`(@deepseek-ai/*) 宿主注入。
- **运行时**：零新增运行时依赖（依赖 `store.ts` 的 `node:fs` 与宿主 `ctx`）。
- **数据**：backlog/journal 持久化于 `$DSH_HOME/teamflow/<product>/`；`stores`/`runs`/`activeProducts` 走 `core/context.ts`（进程单例）。
- **token 口径**（官方口径）：stage 记 `usage` = `{ input(未命中), cacheRead(命中), cacheWrite, output, calls }`；billed input = input+cacheRead+cacheWrite，缓存命中率 = cacheRead/(input+cacheRead)。熔断预算用官方总消耗（input+cacheRead+cacheWrite+output 累计）。汇报与工作台卡片均按官方口径展示。

## 5. 产品记忆（功能演进）

> v0.3~v0.13 为发布前的内部迭代记录；对外统一归到首次公开发布版本 **v0.1.0**（见 `CHANGELOG.md`）。下表按时间顺序记录各阶段核心变更。

| 版本 | 核心变更 |
|---|---|
| v0.3~0.6 | journal 断点续跑（ADR-0001）/ AGENTS 最小侵入（ADR-0002）/ 防假交付(实质校验+熔断)/ 并发池 / QA 缺陷登记 / 完成汇报 |
| v0.8.0 | token 双口径 + 成本观测线 + lite 模式 + 部署契约（ADR-0003/0004） |
| v0.8.x | 领域化重构（11 文件）+ triage 5 档(model 驱动)+ lite/tech/patch 端到端 + 需求无效拦截（ADR-0004/0005 落地） |
| v0.10 | 多团队架构(teams.json)+UI"+团队"触发+workspace 级隔离(UUID)+单任务轮转+dev 子卡+官方口径 token 展示+会话暂停/resume+state.json 预编译索引+版本切片/一次成型纪律+子代理路由跟随主线程 |
| v0.10.1 | **验收结论解析修复**（误报实锤 run tf-msytlok5：验收 ✅ 通过，记忆回写段「SUMMARY.md 结构无需改动」命中旧正则「无需改动」→ 误判 reject 杀整条流水线）。`parseAcceptanceVerdict` 移入 util.ts：只认显式「验收结论/整体结论」行 + 专用「📝 需求不适用」全文命中，正文散文不再朴素子串匹配；verdict.test.js 回归覆盖 |
| v0.10.2 | **执行路径基准**（同一持久化需求 A/B）：流水线 38m/164 调用/11.6M billed vs 原生 DSH 27m/115 调用/19.1M billed。流水线省 ~39% token（阶段/子代理上下文隔离），原生快 ~29%（少门禁但单 agent 上下文膨胀）；质量等价。**拆分价值在「上下文隔离」而非并行次数**。详见 `docs/benchmarks/pipeline-vs-native.md` |
| v0.11 | **「认知前置 + 架构落地」重构（破坏性，ADR-0006）**：① M0 状态核对（core/sanity.ts，start 跑 git 现状注入各阶段，治"认知过期/场外提交"）；② M1 架构阶段全模式启用（lite 也跑轻量架构蓝图，architectPrompt/techPrompt 产结构化 JSON 蓝图，state.__runCtx 统一注入）；③ M2 dev 继承蓝图 + 按蓝图自动拆任务（devTaskDefs 蓝图优先+文件冲突检测合并）；④ M3 质量门禁（QA/验收加架构核验，parseAcceptanceVerdict 识别架构打回）；⑤ triage 架构护栏（持久化/存储/独立模块等 → 强升 medium）。质量优先于 token：不砍「建全局认知」；原生工作流基线见 `docs/benchmarks/native-workflow.md` |
| v0.12 | **QA 打回修复闭环（ADR-0007）**：QA 发现 P0-P2 阻断缺陷 → 打回开发确认+修复（qaFixPrompt）→ 复验 QA → 干净才进产品验收；`QA_REWORK_LIMIT=2` 上限防无限循环、超限转 needs-human 人工介入；`parseDefects` 容忍 `**P1**` 加粗严重级（修对照实验 tf-mt317a5e 缺陷漏登记）；缺陷卡按 reqId+defectId 幂等登记、复验通过 `verifyReqBugs` 关单（P3 观察项保留）。实证：docs/benchmarks/pipeline-vs-native.md「复核」节 |
| v0.1.0（首次公开发布） | **文档层重构：活文档版本制 → 任务夹收口制（ADR-0008，破坏性）**：每需求一个自包含任务夹 `docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/`（PRD/TECHNICAL/QA-REPORT/ACCEPTANCE 收口其中），host 建夹命名+meta.json，`journal.runDocs` 固定需求级身份——重试/续跑复用同夹，双归档/版本虚增/memory 堆积三类 bug 结构性消失；SUMMARY.md 废除（扫描 meta 聚合）、memory.md 收窄为约定层；AC 局部编号+基线依赖/取代声明；代码头 VERSION 解耦为发布版本；triage 新增 slug 输出。存量项目零迁移 |

## 6. 已知待办

- 🔜 **用「持久化」类需求重跑验证 ADR-0006**：确认 M0 状态核对注入、M1 蓝图产出（架构阶段不再被 lite 跳过）、M2 dev 按蓝图拆任务、M3 验收架构核验（重复适配器应被打回）全链路生效。
- ✅ **full/medium 阶段集差异执行（ADR-0004 已落地）**：`host/constants.ts` 新增 `STAGE_POLICY`（五档阶段集策略表，单一事实来源）+ `resolveStages()` 纯函数；`pipeline.ts` 的 design/scaffold/qa 门控改由该表驱动（`enabled()`），取代散落 if/else。**design/scaffold 全档位按显式 flag（needDesign/needScaffold）条件化——显式请求永不被档位吞掉（v0.8.1 原则泛化）**；patch 始终无独立 QA；与团队阶段交集裁剪。`test/stages.test.js` 覆盖五档展开。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- **deploy.mjs FILES** 未含 `host/core/**`、`host/util.ts`、`host/constants.ts`、`host/prompts/**` 源码（运行时只看 lib，不影响功能；补上保持 profile 工作副本一致，非阻断）。
- `STAGE_TOKEN_BUDGET=60k` 硬编码 → 可升级为 service Config（熔断阈值可调）。
- smoke.js 的源码断言依赖 host 目录聚合（`#region host-pool`）：新增领域文件需同步加入。
- 🔜 **给官方提交 PR（低侵入原则下不自改 DSH）**：`conversation` 服务增加 `setView(viewId)`（复用内部 `store.actions.setView`），使「查看子代理会话」可一键跳转并自动切到「对话」tab；PR 合并前暂用 B 方案（按钮加引导文案：「跳转后请切「对话」tab 查看轨迹」）。
- 🔜 **跨会话跳转子代理（同 PR 范畴）**：DSH 子代理目录按父会话加载，`selectSubagent` 不支持跨父导航。已记录 `journal.ownerSession`（发起会话，下发于 stageDetail），跳转按钮在 ownerSession≠当前会话时**禁用 + title/文案提示**；待官方支持跨父会话导航后再解锁（数据已备好）。

## 7. 变更记录（近期）

- 2026-08-25：**任务夹文档制落地（ADR-0008，破坏性）**——按头脑风暴定稿实施：① **结构**：每需求一个自包含任务夹 `docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/`（PRD/DESIGN/TECHNICAL/QA-REPORT/ACCEPTANCE 收口其中），host 在 initBacklog 后建夹（mkdir+meta.json）并持久化 `journal.runDocs`——重试/续跑复用同夹，双归档/版本虚增/memory 堆积三类 bug 结构性消失；② **slug**：triage 输出协议新增 `slug` 字段（`[a-z0-9-]{3,24}` 校验，非法/缺失退化为 `<date>-r<N>`）；③ **prompt 全改**：TF_DOCS 拆产品层/任务夹两层，`RUN(state)` 读 `state.__runCtx.runDocs`（stateSliceFor 首行注入），删除 VERSION_SLICE_BLOCK 与全部 mv 归档/防双归档话术；PRD 头部三行声明（meta summary/基线依赖/取代）、AC 夹内从 1 编起、修订表废除；④ **SUMMARY.md 废除**（host 扫 meta 聚合，本轮只做注入不做浏览器）、memory.md 收窄为约定层（仅约定变更时幂等更新）；⑤ **VERSION 解耦**：代码头是发布版本，迭代不碰；state.currentVersion→lastRunFolder；⑥ smoke 拆旧断言加 3i 断言组。存量项目零迁移。设计文档 docs/adr/0008-task-folder-docs.md。
- 2026-08-24：**主线程停手契约 + 单调用护栏 + 工程动作承接（实锤 run tf-mt3s9ej7/tf-mt5afdch）**——三连修复：① **主线程停手契约**：`teamflow_start` 返回 render/工具描述/TeamFlow 注入三处一致约束「start 后不得自行改代码/跑验证，等完成汇报」（收敛为 `teamflowContextText()` 单一来源）+ `teamflow_status` 运行中带 `reminder`；requirement 参数强制忠实转写用户原话。实证：无踢墙需求主线程 17s 结束回合零工具调用、requirement 一字未改。② **单调用护栏（`core/guard.ts` 新文件）**：进行中退化检测——复读检测（滑动窗口内同一规范化流式片段 ≥12 次）+ 墙钟兜底 25min → `run.dispose()` 中止，outcome=`degenerated`（命名避开 isUnretryable 正则），豁免预算门允许一次干净重试。根因：熔断只在 withRetry「尝试之间」检查，单调用死循环永不返回时够不着（QA 复读 38min 烧 481 万 token 零产出）。设计原则：**进度信号而非配额**——正常阶段间调用数差 9 倍/计费差 11 倍，硬上限必误杀。③ **工程动作承接 + 杂项**：PRD prompt 新增「工程动作承接」（分支/提交类指令必须落「工程约束」小节，实锤「新起一个分支」被整条流水线静默丢弃）、tech 蓝图传递、dev prompt「先执行动作再写码」；`resumeRun` 重置 `journal.humanIntervention`（否则续跑完成汇报误标 ⚠️）；7 处阶段失败 throw 收口为 `stageFailError()`（真实次数/末次 outcome/熔断语义）。smoke 增补 3h 断言。④ **文档归档/记忆写入幂等（已被 ADR-0008 结构性取代）**：PRD prompt 版本切片加「防双归档」、memory.md 幂等替换语义、DESIGN/TECHNICAL/QA-REPORT 归档同需求草稿跳过条款——本日全部随版本切片制度一并删除。
- 2026-08-21：**QA 打回修复闭环（ADR-0007）**——对照实验 run tf-mt317a5e 实锤流程双缺口：① `parseDefects` 旧正则要求严重级后紧跟 `|`，QA 报告写 `**P1**`（markdown 加粗）→ 缺陷解析为 0 →「QA 未发现缺陷」日志 + 静默进验收（验收源码复核才拦住 BUG-P1-1）；② QA 阶段无「缺陷→打回开发→复验」闭环，缺陷只登记不回流。落地：`parseDefects` 改按管道单元格解析（容忍 `**P1**`/反引号/行首 `|`，只认 id+P0-P3+模块三要素非 OBS 行）；`pipeline.ts` QA 改 `do…while` 有界闭环——P0-P2 阻断缺陷 → `advanceTask('rework')` + 开发修复子代理（新 `qaFixPrompt`，指令「先确认属实→修复→交还复验」）→ 复验，干净才 `pending-acceptance` 进产品验收；`QA_REWORK_LIMIT=2` 超限 → task/req needs-human + humanIntervention，跳过验收；验收块 `if (!qaBlocked)` 门控。`backlog.ts` 新增 `syncQaDefects`（按 reqId+defectId 幂等建卡/刷新）+ `verifyReqBugs`（复验/验收通过关 P0-P2 open 单，P3 观察项保留）。smoke 增补 3g 断言，typecheck/bundle/全套测试通过。
- 2026-08-20：**档位阶段集差异执行落地（ADR-0004 待办清理）**——`host/constants.ts` 新增 `STAGE_POLICY` 五档策略表（单一事实来源）+ `resolveStages()` 纯函数；`pipeline.ts` 的 design/scaffold/qa 门控改由 `enabled()`（档位阶段集 × 团队阶段交集）驱动，**取代散落 if/else**。语义关键：**design/scaffold 全档位按显式 flag 条件化（不吞显式请求，v0.8.1 原则泛化）**；patch 始终无独立 QA。初版曾把「medium 去 scaffold」做成结构化排除，审计发现会吞显式 needScaffold/needDesign → 已回正。新增 `test/stages.test.js`（五档展开行为测试，含「显式 flag 不被吞」回归断言），smoke 增补 `3f`，package.json test 链挂上。
- 2026-08-20：**【认知前置 + 架构落地】重构（ADR-0006，破坏性）**——从「持久化需求 A/B 实测」提炼：流水线质量低于原生的根因是跳过「建全局认知 → 架构决策」。落地：M0 状态核对（`core/sanity.ts`，start 跑 git 现状，注入所有阶段）；M1 架构阶段全模式启用（lite 轻量蓝图 / full-medium 蓝图+文档，`architectPrompt` 允许整读关键文件，产出 `<!-- blueprint -->` JSON）；M2 dev 继承蓝图 + 蓝图自动拆任务（文件冲突检测合并）；M3 QA/验收架构核验（`parseAcceptanceVerdict` 识别架构打回 → rework）；triage 架构护栏（持久化/存储/独立模块 → 强升 medium）。质量优先于 token：不砍「建全局认知」。
- 2026-08-20：**延迟注入修复**——新会话选团队时 agent 可能尚未加载（懒加载），导致 `agent.inject` 静默失败、模型无团队上下文→不走 teamflow。修复：选团队时若 agent 不可用，存入 `pendingInjections` 队列；在 `start`（流水线启动前）和 `getActiveTeam`（UI 加载时）补发注入。
- 2026-08-20：**TOKEN_HYGIENE v2 + PRD head+tail 切片**——通用 token 治理：文件作用域（只 read 任务目标文件）、禁止重复读（同文件 read ≤1 次）、批量修复（一次修完所有失败再跑，最多 3 轮）、AGENTS.md/SUMMARY.md 已注入无需重读；QA/验收 PRD 内联改 head+tail 组合切片（覆盖头部基线+尾部新增 AC，预算不变）。基于 BGM run 实际数据对比正常会话，只砍"正常会话不会做的操作"，零质量损失。
- 2026-08-19：**lite × needDesign 语义修复**：lite 模式不再吞掉显式要求的「UI/UX 设计」——去掉 pipeline 设计阶段闸门里的 `!options.lite`(design 以 `needDesign` 为准启用);lite 仍跳过独立技术方案文档(PRD/变更单即契约)。工具描述/types/triage/README 同步注明「lite + needDesign:true 保留设计阶段」。

- 2026-08-19：`journal.ownerSession` 溯源（发起会话 id，下发于 stageDetail）；跳转子代理按钮增加跨会话判定——ownerSession≠当前会话时禁用并 title/文案提示（DSH 目录按父会话加载、跨父导航待官方 PR）。
- 2026-08-19：PRD/活文档升级改 **mv 归档 + 增量干净文件**（结构上杜绝 edit-in-place）：`VERSION_SLICE_BLOCK` 真正接入 PRD prompt；旧版整文件 git mv 到 history/<旧版本>/，新文件只写增量 US/AC + 压缩回归基线（AC 仅编号+一行语义+指针，严禁照抄全文，防 35KB 巨无霸）；design/tech/QA 归档话术同步。

- 2026-08-19：token 计量收敛为官方口径（去除计费当量/上下文压力自定义概念）：`usage` = 输入未命中/命中/写缓存/输出/调用数 + 缓存命中率；熔断预算用官方总消耗；工作台卡片/任务卡/汇报均按官方口径展示。
- 2026-08-19：流水线视图重设计 —— 横向蛇形流程（相位从左至右、上下波浪错位 + SVG 弧线连接 + 沿路径流动高亮虚线 + 箭头终点），整块画布默认可拖拽平移 + 滚轮缩放 + 适应/± 控制簇，点阵网格背景与步骤序号徽标提升质感；历史 run 选择器门控到流水线 tab。验收结论解析修复为只认「验收结论」行（parseAcceptanceVerdict，误报实锤 tf-msytlok5）。
- 2026-08-19：阶段卡点击查看详情 —— 悬浮于画布右上的浮层（不挤占画布宽度；画布加高至 560；浮层内原生 wheel stopPropagation，滚轮只滚正文不触发画布缩放），官方口径 usage 全字段 + 阶段性产物全文 +「🎬 跳转子代理会话」（sessions.openSubagent，mode one-shot；按钮带引导文案「跳转后请切「对话」tab 查看轨迹」——DSH 未向第三方暴露切视图接口，待官方 conversation.setView PR 后一键直达）；host 新增 stageDetail RPC（读 stage.output 全文）；终态 checkpoint 不再删 stage.output（磁盘+内存保留全文，供详情/断点续跑，smoke 断言同步）。
- 2026-08-19：dev 子卡模型（一个需求一张轮转主卡 + 并行 dev 子卡）、assign 与 status 分离（teamflow_assign）、workspace 级隔离（DSH workspace UUID）、UI"+团队"触发 + teamflow_pause/resume、子代理路由跟随主线程、state.json 预编译索引 + 版本切片/一次成型纪律、backlogUpdate 参数对齐修复。
