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
  - ⏳ 进行中：**full/medium 阶段集差异执行**（lite/tech/patch 档已成型并端到端验证；full/medium 仍为既有 if 语义）——见 §6

## 2. 文档索引（按职责）

| 职责 | 位置 | 说明 |
|---|---|---|
| **摘要索引** | 本文件 | 先读：现状 / 结构 / 工程约定 / 待办 |
| 使用与架构 | `README.md` | 安装、契约速览、token/lite 说明、ADR 索引 |
| 决策记录 | `docs/adr/0001~0005` | 自研 journal(不引 LangGraph) / AGENTS 最小侵入 / 部署+token 口径 / triage+共享状态 / **需求无效→验收「需求不适用」拦截** |
| 测试 | `test/smoke.js` `test/journal.test.js` | 结构/描述符 smoke + journal 行为 |

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
- **类型**：全 TS；host 必须构建（`node_modules` 下 strip-types 不生效）；`peerDeps`(@deepseek-ai/*) 宿主注入。
- **运行时**：零新增运行时依赖（依赖 `store.ts` 的 `node:fs` 与宿主 `ctx`）。
- **数据**：backlog/journal 持久化于 `$DSH_HOME/teamflow/<product>/`；`stores`/`runs`/`activeProducts` 走 `core/context.ts`（进程单例）。
- **token 口径**（官方口径）：stage 记 `usage` = `{ input(未命中), cacheRead(命中), cacheWrite, output, calls }`；billed input = input+cacheRead+cacheWrite，缓存命中率 = cacheRead/(input+cacheRead)。熔断预算用官方总消耗（input+cacheRead+cacheWrite+output 累计）。汇报与工作台卡片均按官方口径展示。

## 5. 产品记忆（功能演进）

| 版本 | 核心变更 |
|---|---|
| v0.3~0.6 | journal 断点续跑（ADR-0001）/ AGENTS 最小侵入（ADR-0002）/ 防假交付(实质校验+熔断)/ 并发池 / QA 缺陷登记 / 完成汇报 |
| v0.8.0 | token 双口径 + 成本观测线 + lite 模式 + 部署契约（ADR-0003/0004） |
| v0.8.x(进行) | 领域化重构（11 文件）+ triage 5 档(model 驱动)+ lite/tech/patch 端到端 + 需求无效拦截（ADR-0004/0005 落地） |
| v0.10(进行) | 多团队架构(teams.json)+UI"+团队"触发+workspace 级隔离(UUID)+单任务轮转+dev 子卡+官方口径 token 展示+会话暂停/resume+state.json 预编译索引+版本切片/一次成型纪律+子代理路由跟随主线程 |
| v0.10.1 | **验收结论解析修复**（误报实锤 run tf-msytlok5：验收 ✅ 通过，记忆回写段「SUMMARY.md 结构无需改动」命中旧正则「无需改动」→ 误判 reject 杀整条流水线）。`parseAcceptanceVerdict` 移入 util.ts：只认显式「验收结论/整体结论」行 + 专用「📝 需求不适用」全文命中，正文散文不再朴素子串匹配；verdict.test.js 回归覆盖 |

## 6. 已知待办

- 🔜 **full/medium 阶段集差异执行**：`core/pipeline.ts` 按 `MODE_REGISTRY` 的 `PipelineSpec` 差异执行（lite/tech/patch 已成型；medium 应强制设计/技术方案、full 应含 PM 前置评估；取代散落 if/else）。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- **deploy.mjs FILES** 未含 `host/core/**`、`host/util.ts`、`host/constants.ts`、`host/prompts/**` 源码（运行时只看 lib，不影响功能；补上保持 profile 工作副本一致，非阻断）。
- `STAGE_TOKEN_BUDGET=60k` 硬编码 → 可升级为 service Config（熔断阈值可调）。
- smoke.js 的源码断言依赖 host 目录聚合（`#region host-pool`）：新增领域文件需同步加入。
- 🔜 **给官方提交 PR（低侵入原则下不自改 DSH）**：`conversation` 服务增加 `setView(viewId)`（复用内部 `store.actions.setView`），使「查看子代理会话」可一键跳转并自动切到「对话」tab；PR 合并前暂用 B 方案（按钮加引导文案：「跳转后请切「对话」tab 查看轨迹」）。

## 7. 变更记录（近期）

- 2026-08-19：token 计量收敛为官方口径（去除计费当量/上下文压力自定义概念）：`usage` = 输入未命中/命中/写缓存/输出/调用数 + 缓存命中率；熔断预算用官方总消耗；工作台卡片/任务卡/汇报均按官方口径展示。
- 2026-08-19：流水线视图重设计 —— 横向蛇形流程（相位从左至右、上下波浪错位 + SVG 弧线连接 + 沿路径流动高亮虚线 + 箭头终点），整块画布默认可拖拽平移 + 滚轮缩放 + 适应/± 控制簇，点阵网格背景与步骤序号徽标提升质感；历史 run 选择器门控到流水线 tab。验收结论解析修复为只认「验收结论」行（parseAcceptanceVerdict，误报实锤 tf-msytlok5）。
- 2026-08-19：阶段卡点击查看详情 —— 悬浮于画布右上的浮层（不挤占画布宽度；画布加高至 560；浮层内原生 wheel stopPropagation，滚轮只滚正文不触发画布缩放），官方口径 usage 全字段 + 阶段性产物全文 +「🎬 跳转子代理会话」（sessions.openSubagent，mode one-shot；按钮带引导文案「跳转后请切「对话」tab 查看轨迹」——DSH 未向第三方暴露切视图接口，待官方 conversation.setView PR 后一键直达）；host 新增 stageDetail RPC（读 stage.output 全文）；终态 checkpoint 不再删 stage.output（磁盘+内存保留全文，供详情/断点续跑，smoke 断言同步）。
- 2026-08-19：dev 子卡模型（一个需求一张轮转主卡 + 并行 dev 子卡）、assign 与 status 分离（teamflow_assign）、workspace 级隔离（DSH workspace UUID）、UI"+团队"触发 + teamflow_pause/resume、子代理路由跟随主线程、state.json 预编译索引 + 版本切片/一次成型纪律、backlogUpdate 参数对齐修复。
