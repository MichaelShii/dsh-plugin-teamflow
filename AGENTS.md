# AGENTS.md — TeamFlow 插件开发守则与产品记忆锚点（dsh-plugin-teamflow）

> **任何加入本插件开发的 Agent（团队成员）必须先通读本文件**，再按 §2 文档索引读取对应文档，
> 不要在未了解现状前自行全量探索代码。
> 维护者：TeamFlow 自身演进（像对待产品一样对待插件工程）。
> **本文件只承载「当前状态」；历史变更流水见 `docs/devlog.md`（不注入会话，避免 token 常驻与决策污染）。**

---

## 1. 这是什么

- **产品**：`dsh-plugin-teamflow` —— DeepSeek Harness 可分发插件，把「一句话需求 → 多 Agent 团队研发流水线」做成宿主能力。
- **形态**：host（Cordis service `teamflow`，node 侧）+ client（Web「🏭 团队工作台」tab）+ 模型工具（`teamflow_*`）。
- **运行环境**：web profile 宿主组合真实 Node 进程；`file:` 安装 + 从 profile 副本加载。
- **当前状态**（2026-08 大版本线）：
  - ✅ **领域化重构完成**：1418 行单文件 → 11 个领域文件（见 §3）
  - ✅ **token 官方口径计量**（usage = 输入未命中/命中/写缓存/输出/调用数 + 缓存命中率，ADR-0003）
  - ✅ **lite 模式 / mode 5 档 + 模型驱动 triage**（ADR-0004，`teamflow_triage`）
  - ✅ **full/medium 阶段集差异执行（ADR-0004 落地）**：`STAGE_POLICY` 五档策略表 + `resolveStages()` 纯函数，pipeline 的 design/scaffold/qa 门控改由表驱动；design/scaffold 全档位按显式 flag 条件化（不吞显式请求），patch 无独立 QA

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| **摘要索引** | 本文件 | 先读：现状 / 结构 / 工程约定 / 行为锚点 |
| 使用与架构 | `README.md` | 安装、契约速览、token/lite 说明、ADR 索引 |
| 决策记录 | `docs/adr/0001~0007` | 自研 journal(不引 LangGraph) / AGENTS 最小侵入 / 部署+token 口径 / triage+共享状态 / 需求无效→验收「需求不适用」拦截 / 认知前置+架构落地重构(质量优先) / **QA 打回修复有界闭环(ADR-0007)** |
| 开发日志 | `docs/devlog.md` | 迭代变更流水 + 功能演进史（历史；不注入会话，按需查阅） |
| 待办 | `docs/TODO.md` | 未完成事项（需人决策；不注入会话——agent 不主动做产品改进） |
| 测试 | `test/smoke.js` `test/stages.test.js` `test/verdict.test.js` `test/journal.test.js` `test/diagnostic.test.js` `test/evidence.test.js` `test/metering.test.js` `test/product-scope.test.js` | 结构/描述符 smoke + 档位阶段集 + 验收结论 + journal 行为 + 重试诊断 + 验证证据块 + token 计量宿主适配（官方投影优先 + 多源回退/usage 双路径回退） + 产品线装配（全局面板数据面：地址/白名单/过滤/摘要/空态） |
| 评测层（L1+L2） | `test/prompt-contract.test.js` `test/conformance.test.js` `docs/benchmarks/corpus/` | **评测 prompt/注入改动**：L1 行为级契约（工厂产出锚点，含 HOST-ENFORCED/policy 分级，改 prompt 必跑）+ L2 回放语料一致性（冻结真实产物喂宿主解析器，golden corpus 门禁，零 LLM 成本）；语料/清单只增不改 |

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
    ├── runner.ts       # 子代理执行（runPool/runAgent/withRetry + 重试诊断/熔断）
    ├── guard.ts        # 单调用护栏（复读/挂死/空转检测 + token 观测提醒注入）
    ├── report.ts       # 完成汇总投递（deliverCompletion，官方口径汇报）
    ├── pipeline.ts     # 编排中枢（executePipeline/start/cancel/resume + MODE 归一；【mode 路由挂载点】）
    ├── triage.ts       # 需求分诊（MODE_REGISTRY 策略表 + 正则预筛 + runTriage 模型驱动）
    ├── products.ts     # 产品线装配（runsFor/runAddress/runBrief/productMetaOf/listProducts；全局面板数据面）
    └── state.ts        # state.json 预编译索引（loadState/mergeStateBlock/stateSliceFor）
store.ts  # 持久化层（原子写/.bak/损坏自愈 + journal 序列化），独立 lib entry
descriptors.ts  # Remote 描述符（host/client 共用，单独 entry）
client/
├── shared.tsx          # 共享展示层（主题 token/状态词表/格式化；会话内与全局面板共用，纯展示无数据逻辑）
├── index.tsx           # 会话内工作台（conversation.view tab + 输入框团队选择）+ 全部 slot 注册（含全局面板）
└── panel.tsx           # 全局面板（sidebar.panellist + main key=teamflow）+ 右栏 run 详情 tab（类型/正文/地址解析）
```

**规则**：依赖只允许 `types/constants/util` → `prompts`/`core/*` → `index`（门面）；严禁反向/循环。所有 Prompt 文本必须进 `prompts/index.ts`。

## 4. 工程约定

- **构建/验证**（插件目录下）：
  - `pnpm run typecheck` —— tsc --noEmit（改 type 后必跑）
  - `pnpm run bundle` —— tsdown → `lib/`（host.mjs/client.js/store.mjs/descriptors.mjs）
  - `pnpm test` —— smoke + journal + verdict + stages + diagnostic + evidence + metering + product-scope + prompt-contract + conformance（smoke 对 host 目录做源码断言：新增/移动函数后要同步指向；**改 prompt/注入必跑 L1 prompt-contract + L2 conformance；改计量/宿主适配必跑 metering；改产品线装配/全局面板数据面必跑 product-scope**）
  - **部署**：`node deploy.mjs`（构建+测试+同步 profile 副本 + 检测运行 web 提示）→ **重启 `dsh --profile web` 才生效**（易踩坑，ADR-0003）。
  - **发布**：`npm publish`（升 `package.json` version 后；`files` 白名单仅含 `lib`/`cordis.patch.yml`/`README.md`，`prepublishOnly` 自动 bundle+test；包名无 scope 默认公开，registry 为 npmjs.org）。
- **类型**：全 TS；host 必须构建（`node_modules` 下 strip-types 不生效）；`peerDeps`(@deepseek-ai/*) 宿主注入。
- **运行时**：零新增运行时依赖（依赖 `store.ts` 的 `node:fs` 与宿主 `ctx`）。
- **数据**：backlog/journal 持久化于 `$DSH_HOME/teamflow/<product>/`；`stores`/`runs`/`activeProducts` 走 `core/context.ts`（进程单例）。
- **token 口径**（官方口径）：stage 记 `usage` = `{ input(未命中), cacheRead(命中), cacheWrite, output, calls }`；billed input = input+cacheRead+cacheWrite，缓存命中率 = cacheRead/(input+cacheRead)。熔断预算用官方总消耗（input+cacheRead+cacheWrite+output 累计）。汇报与工作台卡片均按官方口径展示。
- **输出单轨制**：QA/验收的产物**只在任务夹文件**（`QA-REPORT.md`/`ACCEPTANCE.md`），子代理回复仅摘要+路径+state 块；host 读文件解析（缺失 → 硬失败 needs-human，不回退解析回复）。tech 蓝图允许写文件（host 有文件 fallback）。详见 `docs/devlog.md` 2026-09-03 条目。
- **deploy 工作副本**：`deploy.mjs FILES` 不含 `host/core/**`、`host/util.ts`、`host/constants.ts`、`host/prompts/**` 源码（运行时只看 lib，不影响功能）。
- **smoke 断言聚合**：源码断言依赖 host 目录聚合（`#region host-pool`）——新增领域文件需同步加入 `test/smoke.js` 聚合列表。
- **优化禁令**：已判定假优化勿再投入（子 agent 共享已读文件全文、拆任务存在性预检、护栏强制削减、测试任务合并、tech 分层注入）——详见 `docs/benchmarks/hold-pipeline-vs-native.md` 复核节与 `docs/devlog.md` 2026-08-27 条目。
- **变更记录**：迭代流水写 `docs/devlog.md` + commit message；**不写进本文件**（本文件只承载当前状态，历史注入会污染决策与膨胀 token）。

## 5. 当前行为锚点（功能演进史见 `docs/devlog.md`）

| 锚点 | 当前行为（约束性描述，勿回退） |
|---|---|
| 领域化 + triage | mode 5 档（full/medium/lite/tech/patch）+ 模型驱动 triage（正则只做确定性护栏）；lite 不吞显式 needDesign/needScaffold；需求无效在 PRD/确认单前置拦截（ADR-0004/0005） |
| token 官方口径 | usage=输入未命中/命中/写缓存/输出/调用数+命中率；熔断预算用官方总消耗；展示同口径（ADR-0003）。**来源=官方 Session 投影**（`tokenUsage` 四桶 + `sessionStats.steps` 调用数，与宿主 token-meter 同一份 fold）；事件扫描仅为无投影宿主的回退（宿主已弃用 `snapshotEvents/ownEvents` 同步读取，护栏复读检测仍读事件——见 docs/TODO.md） |
| 多团队/工作台 | teams.json + workspace 级隔离 + 单任务轮转 + dev 子卡 + 会话暂停/resume + state.json 预编译索引 + 子代理路由跟随主线程 + 分支策略启动前 needs-decision（ADR-2026-08-27）。**隔离 key = 路径派生 `slugPath(cwd)`**（UUID 分支当前不可达：宿主 `resolveByPath` 异步、插件同步调用，见 docs/TODO.md） |
| 客户端面（产物可见 + 全局面板） | 双入口：**会话内工作台**（`conversation.view` tab，按 sessionId 寻址）+ **全局面板**（`sidebar.panellist` 图标 + `main` key=`teamflow`，按产品线 key 寻址，root scope 无会话钩子；主区为**标签页** run｜backlog，详情为**覆盖式浮层**，不并排多栏）。**两处 id 必须同值**（宿主 `layout.selectPanel` 对未注册 main key 抛错；`selectPanel(null)` 回对话）。右栏 run 详情 tab：类型进 `sidebarRightTabs` + 正文进 `sidebar.right.pane.tab`（key=definition.id），地址由 host 生成 `dsh-resource://teamflow/run/<产品线>/<runId>`；**正文读地址必须用宿主绑定的 `useTabInfo`**（slot 声明 `hooks: { tabInfo }` 会被渲染器改名为 `use<Name>`）取 `tab.navigation.address \|\| tab.contentId`。**右侧栏是会话级的**（`RightbarRoot` 门控 `activePanelId === null`，实测 tf-mtvrsakj-l2vj5u）→ 全局面板里开右栏必须走 `goOwnerSessionAndOpen`：先 `sessions.open(ownerSession)`（host 载荷已带）、等 `sessions.list.current` 真的切过去 + seat 挂载 bind 后再 `openResource`；会话已清理时只提示不跳转；产物地址的会话段也由 host 用 `ownerSession` 生成。展示层 `client/shared.tsx` 共用，渲染组件两处仍分叉（见 docs/TODO.md） |
| 认知前置 + 架构落地 | M0 sanity 状态核对 / M1 蓝图全模式启用 / M2 dev 按蓝图拆任务 / M3 QA+验收架构核验（打回=rework）/ triage 架构护栏强升 medium（ADR-0006）。质量优先于 token |
| QA 打回闭环 | QA P0-P2 → 打回开发确认+修复（qaFixPrompt）→ 复验 ≤2 轮；缺陷按 reqId+defectId 幂等登记、复验通过关单（P3 观察项保留）；parseDefects 容忍 `**P1**` 加粗（ADR-0007） |
| 输出单轨制 | QA/验收文件即产物、回复仅摘要；文件缺失硬失败；parseAcceptanceVerdict 只认显式结论行（结论行字面量模板：最后一行「验收结论：✅/⚠️/❌/📝」），**无结论行 → needs-human（不猜结论）**，📝 需求不适用全文命中仍优先 |
| 任务夹文档制 | 每需求一个自包含任务夹 `docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/`（PRD/TECHNICAL/QA-REPORT/ACCEPTANCE 收口），journal.runDocs 固定身份、重试/续跑复用同夹；SUMMARY.md 废除、memory.md 收窄为约定层；AC 局部编号（ADR-0008） |
| 重试/护栏 | withRetry 重试附诊断包（上次 outcome/summary/护栏原因/产出尾部）；退化（degenerated）与挂死/空转（stalled）不自动重试（needs-human 引导 resume）；护栏=进度信号非配额。**通道/来源**：轻提醒走官方 `run.localAgent.inject()`；挂死判据用官方 `subagentTiming` 投影的 `active.through`（不可用才回退事件视图启发式；长工具静默仍由 agent 活动守卫豁免）；复读检测仍读事件（弃用读取器唯一剩余处，见 docs/TODO.md） |
| prompt 约束分级 | prompt 内**禁止自称 hard constraint**（措辞硬与 enforcement 脱节→模型对 high-signal 词脱敏，实证 17 条 warn 零削减）；分级 `[HOST-ENFORCED]`（host 真实强制：单轨产物/验收结论行，必须描述真实后果）+ `[policy]`（自律 + guard warn/轻提醒） |
| 验证证据块 | dev/qaFix 回复末尾强制 `[Verification evidence]` 块（命令+退出码+断言计数+失败行引用，或显式 N/A）→ host 提取存证 `stage.verifyEvidence`（stageDetail 可见，可与 logs/ 命令输出对照）；policy 级——缺失记 warn 不中断 |

## 6. 变更记录（指针）

迭代变更流水见 `docs/devlog.md`（2026-08-19 起逐条，含功能演进史），未完成事项见 `docs/TODO.md`。**历史与待办不注入本文件**——避免 token 常驻、决策污染与 agent 越权做产品改进；git log 亦可追溯。功能落地后：变更流水写 `docs/devlog.md` + commit message，本文件仅在「当前状态」（§1-5）变化时更新。