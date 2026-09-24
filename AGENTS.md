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
- **当前状态**（v0.2.1 开发线）：
  - ✅ **领域化重构完成**：1418 行单文件 → 11 个领域文件（见 §3）
  - ✅ **token 官方口径计量**（usage = 输入未命中/命中/写缓存/输出/调用数 + 缓存命中率，ADR-0003）
  - ✅ **lite 模式 / mode 5 档 + 模型驱动 triage**（ADR-0004，`teamflow_triage`）
  - ✅ **full/medium 阶段集差异执行（ADR-0004 落地）**：`STAGE_POLICY` 五档策略表 + `resolveStages()` 纯函数，pipeline 的 design/scaffold/qa 门控改由表驱动；design/scaffold 全档位按显式 flag 条件化（不吞显式请求），patch 无独立 QA
  - ✅ **交付判定信号分级 + 熔断新增口径**（`judgeDeliverable`／`freshTokensOf`，见 §5 锚点）+ **doc 阶段产物兜底（回复过短但任务夹文件已落盘仍判交付）+ 熔断预算随缓存能力自适应（无 prompt 缓存的 provider 不再因固定开销撞 200k）**
  - ✅ **客户端界面中英双语（P1）**：走宿主 `ctx.locale`（词典注册 + slot 声明 `locale` + 名称 thunk），实时跟随宿主语言（host 侧文案/产物语言见下一条）
  - ✅ **host 侧响应/产物双语（P2）**：语言源链（客户端推送 > settings > `en`）+ run 级快照（`journal.locale`）+ host 词典与词表门禁；判据层只增不改（见 §5 语言层锚点）
  - ✅ **日志根离开用户项目 + 不制造 dump（B 方案）**：run 期在工作区暂存 → 终态按白名单（检查脚本/笔记/`captures.json`）归档 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删副本；命令/套件输出不落文件；起跑自愈清扫 + 每工作区保留最近 20 次（见 §5 日志生命周期锚点）

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| **摘要索引** | 本文件 | 先读：现状 / 结构 / 工程约定 / 行为锚点 |
| 使用与架构 | `README.md` | 安装、契约速览、token/lite 说明、ADR 索引 |
| 决策记录 | `docs/adr/0001~0009` | 自研 journal(不引 LangGraph) / AGENTS 最小侵入 / 部署+token 口径 / triage+共享状态 / 需求无效→验收「需求不适用」拦截 / 认知前置+架构落地重构(质量优先) / QA 打回修复有界闭环(ADR-0007) / 任务夹文档制(ADR-0008) / **不做插件级用户记忆层——已否决(ADR-0009)** |
| 开发日志 | `docs/devlog.md` | 迭代变更流水 + 功能演进史（历史；不注入会话，按需查阅） |
| 待办 | `docs/TODO.md` | 未完成事项（需人决策；不注入会话——agent 不主动做产品改进） |
| 测试 | `test/smoke.js` `test/locale.test.js` `test/stages.test.js` `test/verdict.test.js` `test/journal.test.js` `test/runlogs.test.js` `test/cancel.test.js` `test/diagnostic.test.js` `test/evidence.test.js` `test/metering.test.js` `test/gitignore.test.js` `test/commit-path.test.js` `test/product-scope.test.js` `test/state.test.js` `test/dev-task-id.test.js` `test/overlap-merge.test.js` `test/triage-gate.test.js` `test/instruction-budget.test.js` `test/client-host-api.test.js` | `smoke` 结构/描述符/源码断言 · `locale` 语言层 · `stages` 档位阶段集 · `verdict` 验收结论 · `journal` journal 行为 · `runlogs` 日志生命周期 · `cancel` 中断语义 · `diagnostic` 重试/交付判定 · `evidence` 证据块 · `metering` token 计量 · `gitignore`+`commit-path` 收口提交 · `product-scope` 产品线数据面 · `state`/`dev-task-id`/`triage-gate` 状态与分诊 · `overlap-merge` dev 文件交集合并护栏（`util.mergeFileOverlaps` 不变量 + resume 补跑路径必须共用同一函数） · `instruction-budget` 本文件体积守门（体积/§5 行长/禁写历史/指针双向） · `client-host-api` 宿主服务 API 面（成员白名单 + 禁已移除成员 + inject/桥接一致） · **L1 `prompt-contract` + L2 `conformance`**（改 prompt/注入必跑）→ 覆盖明细见 `anchors/tests-coverage.md` |
| 评测层（L1+L2） | `test/prompt-contract.test.js` `test/conformance.test.js` `docs/benchmarks/corpus/` | **评测 prompt/注入改动**：L1 行为级契约（工厂产出锚点，含 HOST-ENFORCED/policy 分级，改 prompt 必跑）+ L2 回放语料一致性（冻结真实产物喂宿主解析器，golden corpus 门禁，零 LLM 成本）；语料/清单只增不改 |

## 3. 工程结构（领域划分，单向依赖）

```
host/
├── index.ts            # 门面：TeamflowService + 工具注册(teamflow_*) + ACTIVE 注入
├── types.ts            # 公共类型（Journal/BacklogItem/PipelineOptions/PipelineMode…）
├── constants.ts        # 常量/阶段映射/预算（STATUS/PHASE_*/FRESH_TOKEN_BUDGET/MODE…）
├── util.ts             # 通用纯工具（clip/normalize*/suggest 辅助/**并发池 runPool**…）
├── locales.ts          # host 词典（zh/en 两份区 + t()/langDirective/phaseLabel/dictProblems 自检）
├── locales/            # 分面词典（pipeline.ts / tools.ts：日志·事件·注入块 / 工具返回·分支决策）
├── prompts/index.ts    # 全部 Prompt（prd/design/scaffold/tech/dev/qa/acceptance + TRIAGE_PROMPT + 双语模板）
└── core/
    ├── context.ts      # 运行期共享状态单例（runtime + runs/inFlight + activeProducts + providerName + **cancelRun/trackInFlight/untrackInFlight**；inFlight = runId→Map<stage,run> 多路追踪）
    ├── locale.ts       # 语言源唯一读取点（client 推送槽 + settings 只读端口 + run 快照解析）
    ├── backlog.ts      # Backlog 数据层 + storeFor + 缺陷解析 + 立项建卡 + 任务流转 + 视图/流转
    ├── metering.ts     # token 官方口径计量（accumulate/summary 三桶+calls+命中率）
    ├── runner.ts       # 子代理执行（runAgent/withRetry + 重试诊断/熔断；并发池在 util.ts）
    ├── guard.ts        # 单调用护栏（复读/挂死/空转检测 + token 观测提醒注入）
    ├── report.ts       # 完成汇总投递（deliverCompletion，官方口径汇报）
    ├── pipeline.ts     # 编排中枢（executePipeline/start/resume + MODE 归一；【mode 路由挂载点】）
    ├── triage.ts       # 需求分诊（MODE_REGISTRY 策略表 + 正则预筛 + runTriage 模型驱动）
    ├── runlogs.ts      # 运行日志生命周期（暂存→白名单过滤归档 $DSH_HOME + 起跑自愈清扫 + 保留 K 次）
    ├── products.ts     # 产品线装配（runsFor/runAddress/runBrief/productMetaOf/listProducts；全局面板数据面）
    └── state.ts        # state.json 预编译索引（loadState/mergeStateBlock/stateSliceFor）
store.ts  # 持久化层（原子写/.bak/损坏自愈 + journal 序列化），独立 lib entry
descriptors.ts  # Remote 描述符（host/client 共用，单独 entry）
client/
├── locales.ts          # 客户端文案词典（zh/en 逐条同形；走宿主 ctx.locale，不自建 i18n）
├── shared.tsx          # 共享展示层（主题 token/状态词表/格式化；会话内与全局面板共用，纯展示无数据逻辑）
├── index.tsx           # 会话内工作台（conversation.view tab + 输入框团队选择）+ 全部 slot 注册（含全局面板）
└── panel.tsx           # 全局面板（sidebar.panellist + main key=teamflow）+ 右栏 run 详情 tab（类型/正文/地址解析）
```

**规则**：依赖只允许 `types/constants/util` → `prompts`/`core/*` → `index`（门面）；严禁反向/循环。所有 Prompt 文本必须进 `prompts/index.ts`。
**宿主级插件的两条硬约束**：① **不用 `@Remote` 装饰器**——Remote 面走 `ctx.typert.register` 的严格描述符（`descriptors.ts` 纯数据、host/client 共用一份）；② **必须是宿主组合里的正式插件**——动态/会话内插件的 `fs` 写不了 `$DSH_HOME`，也注册不了独立 tab。论证与实测见 `anchors/host-plugin-constraints.md`。
**客户端文案规则**：一切用户可见文案进 `client/locales.ts`，组件里写 `t('key')`（禁止裸中文字面量；`test/smoke.js` 有闸）。
**host 文案规则**：一切用户/模型可见文案进 `host/locales{,.d}/`，调用 `t(locale, key, params)`；语言一律取 run 快照（`runLocaleOf(journal)`）或环境语言（`ambientLocale()`），**不得在消费点各自读 settings/自建语言缓存**；判据/解析词表只增不改（见 §5 语言层锚点）。

## 4. 工程约定

- **构建/验证**（插件目录下）：
  - `pnpm run typecheck` —— tsc --noEmit（改 type 后必跑）
  - `pnpm run bundle` —— tsdown → `lib/`（host.mjs/client.js/store.mjs/descriptors.mjs）
  - `pnpm test` —— smoke + locale + journal + runlogs + cancel + verdict + stages + diagnostic + evidence + metering + gitignore + commit-path + product-scope + prompt-contract + conformance + changelog + instruction-budget + client-host-api（smoke 对 host 目录做源码断言：新增/移动函数后要同步指向；**改 prompt/注入必跑 L1 prompt-contract + L2 conformance；改语言层/文案必跑 locale（词典键唯一 + zh/en 同形 + en 无 CJK）；改计量/宿主适配必跑 metering；改收口提交面/日志忽略必跑 gitignore + commit-path（后者是真 git 集成：需要能 spawn git 的终端，受限沙箱下自动 SKIP）；改日志生命周期/归档落点必跑 runlogs；改取消语义/中断入口必跑 cancel（含 descriptor↔服务↔三处 UI 入口的同源断言）；改产品线装配/全局面板数据面必跑 product-scope**）
  - **部署**：`node deploy.mjs`（构建+测试+同步 profile 副本 + 检测运行 web 提示）→ **重启 `dsh --profile web` 才生效**（易踩坑，ADR-0003）。
  - **发布**：`npm publish`（先升 `package.json` version；`files` 白名单 = `lib`/`cordis.patch.yml`/`README.md`/`README.en.md`/`CHANGELOG.md`；`prepublishOnly` 自动 bundle + 全套测试）。**发版 SOP**（2FA 人工节点、release note 由 `git log <上一tag>..HEAD` 生成、已知坑清单）见 skill `release-npm-package`；**分支模型**：`main` = 只承载已发布内容、不接日常提交（含文档），日常开发与贡献者 PR 一律走当前 `release-vX.Y.Z` —— 完整流程与沿革见 `anchors/release-process.md`。**判定发布成功看写路径**：registry 读路径可滞后数分钟；重发得到 403 `cannot publish over the previously published versions` 才是权威回执（幂等安全）。
- **类型**：全 TS；host 必须构建（`node_modules` 下 strip-types 不生效）；`peerDeps`(@deepseek-ai/*) 宿主注入。
- **运行时**：零新增运行时依赖（依赖 `store.ts` 的 `node:fs` 与宿主 `ctx`）。
- **数据**：backlog/journal 持久化于 `$DSH_HOME/teamflow/<product>/`；`stores`/`runs`/`activeProducts` 走 `core/context.ts`（进程单例）。
- **token 口径**（官方口径）：stage 记 `usage` = `{ input(未命中), cacheRead(命中), cacheWrite, output, calls }`；billed input = input+cacheRead+cacheWrite，缓存命中率 = cacheRead/(input+cacheRead)。汇报与工作台卡片均按官方口径展示（`totalTokensOf`）。**熔断是另一套口径**：`freshTokensOf` = input+cacheWrite+output（**排除 cacheRead**）+ `FRESH_TOKEN_BUDGET`——缓存命中是廉价重放，计入熔断等于「任何任务失败一次必熔断、RETRY_LIMIT 失效」（见 §5 交付判定锚点）；不得把两套口径再合并。
- **输出单轨制**：QA/验收的产物**只在任务夹文件**（`QA-REPORT.md`/`ACCEPTANCE.md`），子代理回复仅摘要+路径+state 块；host 读文件解析（缺失 → 硬失败 needs-human，不回退解析回复）。tech 蓝图允许写文件（host 有文件 fallback）。详见 `anchors/single-track-output.md`。
- **deploy 工作副本**：`deploy.mjs FILES` 覆盖**全部** host/client 源码（含 `host/core/**`、`host/util.ts`、`host/constants.ts`、`host/prompts/**`、`descriptors.ts`、`store.ts`）+ 4 个 `lib/` 产物 + `package.json`/`cordis.patch.yml`/`AGENTS.md`。**运行时只加载 `lib/`**，源码同步只为让 profile 副本可读/可与仓库对照——但清单漏项会让「profile 里那份源码」长期陈旧（实测漏过 `guard.ts`/`products.ts`/`runlogs.ts`/`state.ts`/`teams.ts` 五个）。清单完整性由 smoke 门禁守（真实文件 ⊆ FILES，漏一个即红），不靠人记。
- **smoke 断言聚合**：源码断言依赖 host 目录聚合（`#region host-pool`）——新增领域文件需同步加入 `test/smoke.js` 聚合列表。
- **优化禁令**：已判定假优化勿再投入（子 agent 共享已读文件全文、拆任务存在性预检、护栏强制削减、测试任务合并、tech 分层注入）——详见 `docs/benchmarks/hold-pipeline-vs-native.md` 复核节与 `docs/devlog.md`。
- **变更记录**：迭代流水写 `docs/devlog.md` + commit message；**不写进本文件**（本文件只承载当前状态，历史注入会污染决策与膨胀 token）。

## 5. 当前行为锚点（一行一条不变量；论证与门禁见 `docs/anchors/`）

> **本表只写不变量**——日期、runId、事故复盘、门禁清单一律不进本表（写 `docs/anchors/<主题>.md`），
> 由 `test/instruction-budget.test.js` 机器守门。每行末尾即该锚点的详情文档。

| 锚点 | 不变量 |
|---|---|
| 领域化 + triage | mode 5 档（full/medium/lite/tech/patch）+ 模型驱动 triage（正则只做确定性护栏）；lite 不吞显式 needDesign/needScaffold；需求无效在 PRD/确认单前置拦截。`anchors/domain-triage.md` |
| token 官方口径 | usage = 未命中/命中/写缓存/输出/调用数 + 命中率，**来源优先官方 Session 投影**（事件扫描仅回退）；**熔断另走 `freshTokensOf`（排除 cacheRead），两套口径不得合并**；预算随缓存能力自适应；`journal.engine` 与逐阶段 provider/model 必须落盘。`anchors/token-metering.md` |
| 交付判定（信号分级） | `judgeDeliverable` 三级：客观形态 → 证据块 → 措辞兜底；**禁止「全文拒绝词即否决」**；doc 类阶段回复过短时回读任务夹产物判交付，但**不豁免空回复**。`anchors/deliverable-verdict.md` |
| 多团队/工作台 | teams.json + workspace 隔离 + 单任务轮转 + dev 子卡 + 分支策略启动前 needs-decision；**dev 任务身份只认 host 生成的 `dt-N`**（禁 title 双键、禁切分 title）；改动存档两态 `gitMode`：入口问、出口遵。`anchors/multi-team-workbench.md` |
| 客户端面 | 双入口（会话内 tab / 全局面板），两处 main key 必须同值；右栏是会话级 → 开右栏走 `goOwnerSessionAndOpen`；**跳会话只有 `uiWorkspace.openSession` 一个入口**（`sessions.openSubagent`/`sessions.open` 已被宿主移除，勿再引用）；快照投影必须带 `taskKey`；en 是兜底 → zh/en key 同形、客户端无裸中文字面量。`anchors/client-surface.md` |
| 语言层（host i18n） | 语言只有一个读取点（`core/locale.ts`：客户端推送 > settings > `en`）；run 起跑快照一次写 `journal.locale`，此后只读快照；判据/解析词表只增不改。`anchors/host-i18n.md` |
| 交付形态契约 | 形态是需求的维度：triage 判 artifact/installable/host → 数据表展开 → PRD 强制写成可测 AC；**不得写死宿主字段名与安装命令**（安装环境运行时探测，主源 `ctx.baseUrl`；探测失败就问用户）；执行者 = 主 agent；接线唯一写入点 `triageRecordOf`。`anchors/artifact-contract.md` |
| 认知前置 + 架构落地 | M0 sanity 状态核对 / M1 蓝图全模式启用 / M2 按蓝图拆任务 / M3 QA+验收架构核验；triage 架构护栏强升 medium。质量优先于 token。`anchors/cognition-architecture.md` |
| QA 打回闭环 | P0–P2 打回开发修复 → 复验 ≤2 轮；超限转「已知问题」只读验收（一律需人工、**不得放行合回**）；缺陷解析**只认显式严重级表头**（无表头整表跳过）；修复必须落永久门禁 + 缺陷行给可执行定义；复验先重跑上轮探针。`anchors/qa-rework-loop.md` |
| 输出单轨制 | QA/验收产物只在任务夹文件（缺失硬失败，不回退解析回复）；验收结论只认最后一条**字面量结论行**（无结论行 → needs-human；📝 只认行首写法）。`anchors/single-track-output.md` |
| 任务夹文档制 | 每需求一个任务夹 `docs/teamflow/<yyyyMMdd>-r<N>[-slug]/`；`journal.runDocs` 是固定身份，重试/续跑复用同夹；SUMMARY.md 废除。`anchors/task-folder-docs.md` |
| 中断运行（cancel） | 三处入口共用两段式 `CancelButton` + 官方 `SubagentRun.dispose()`；`cancelRun` 只认 `status==='running'`；并发多路一次全停、取消后池不再取新任务；**终态归一放 finally 首句**；取消来源落盘、**取消态不得给模型续跑引导**。`anchors/cancel-run.md` |
| 需求澄清闸门 | 启动前复用分诊那一次调用跑预检（合格线与自洽门禁由 host 判）→ 命中即 `needs-clarification`、不建 run；**只有 patch 档豁免**；已给过 supplement 不再拦；续跑不重跑分诊；权威判定在 pipeline。`anchors/clarification-gate.md` |
| 收口提交面 | 一个 run 一个 commit（代码 + 任务夹 + memory.md），`logs/teamflow/` 永不入提交；`tfAddArgs` 默认 `git add -A -- .`、**禁止负 pathspec 点名**；三道防线（.gitignore 幂等 → 索引兜底 → 结果分派日志）；基线噪音只在索引层排除，不写用户 `.gitignore`。`anchors/commit-surface.md` |
| 日志生命周期 | 项目内暂存 → 终态按白名单（检查脚本/笔记/`captures.json`）归档 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删副本；命令输出与快照一律丢弃；起跑自愈清扫 + 每工作区保留 20 次；失败只 warn。`anchors/log-lifecycle.md` |
| 重试/护栏 | 外部供应商故障 ≠ 交付缺陷（长退避、不计熔断，用尽落 `externalFailure`）；退化/挂死/空转不自动重试；门序 = 不可重试/外部中止/护栏中止 → 熔断预算门 → 自动重试；**环境不可用（`env-unavailable`）是第五个早停信号**（连续 2 次提醒 / 3 次中止、不自动重试、**优先于「完成了」**）。`anchors/retry-guard.md` |
| prompt 约束分级 | prompt 内禁止自称 hard constraint；只分 `[HOST-ENFORCED]`（host 真强制，须写真实后果）与 `[policy]`（自律 + guard warn/轻提醒）。`anchors/prompt-constraint-levels.md` |
| 验证证据块 | dev/qaFix 回复末尾强制 `[Verification evidence]`（命令+退出码+断言计数，或显式 N/A）→ host 提取存证；policy 级缺失只 warn；**不制造输出 dump**：三类留存、项目根不得出现 `scripts/`/`probe/`。`anchors/verification-evidence.md` |

## 6. 变更记录（指针）

迭代变更流水见 `docs/devlog.md`（逐条，含功能演进史），未完成事项见 `docs/TODO.md`。**历史与待办不注入本文件**——避免 token 常驻、决策污染与 agent 越权做产品改进；git log 亦可追溯。功能落地后：变更流水写 `docs/devlog.md` + commit message，本文件仅在「当前状态」（§1-5）变化时更新。