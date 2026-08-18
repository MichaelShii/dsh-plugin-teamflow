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
  - ✅ **token 双口径**（真实累计 usage + 上下文压力 + 计费当量，ADR-0003）
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
├── constants.ts        # 常量/阶段映射/预算（STATUS/PHASE_*/COST_BUDGET_TOKENS/MODE…）
├── util.ts             # 通用工具（clip/normalize*/suggest 辅助…）
├── prompts/index.ts    # 全部 Prompt（prd/design/scaffold/tech/dev/qa/acceptance + TRIAGE_PROMPT + 模板）
└── core/
    ├── context.ts      # 运行期共享状态单例（runtime + runs/inFlight/activeProducts + providerName）
    ├── backlog.ts      # Backlog 数据层 + storeFor + 缺陷解析 + 立项建卡 + 任务流转 + 视图/流转
    ├── metering.ts     # token 双口径计量（measure/accumulate/costTokensOf）
    ├── runner.ts       # 子代理执行（runPool/runAgent/withRetry + 重试/熔断/成本观测）
    ├── report.ts       # 完成汇总投递（deliverCompletion，双口径汇报）
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
- **token 口径**：stage 记 `usage`（真实累计 4 桶+calls）、`costTokens`（当量 cacheRead×0.1）、`tokens`（上下文压力快照）；汇报双口径（ADR-0003）。

## 5. 产品记忆（功能演进）

| 版本 | 核心变更 |
|---|---|
| v0.3~0.6 | journal 断点续跑（ADR-0001）/ AGENTS 最小侵入（ADR-0002）/ 防假交付(实质校验+熔断)/ 并发池 / QA 缺陷登记 / 完成汇报 |
| v0.8.0 | token 双口径 + 成本观测线 + lite 模式 + 部署契约（ADR-0003/0004） |
| v0.8.x(进行) | 领域化重构（11 文件）+ triage 5 档(model 驱动)+ lite/tech/patch 端到端 + 需求无效拦截（ADR-0004/0005 落地） |

## 6. 已知待办

- 🔜 **full/medium 阶段集差异执行**：`core/pipeline.ts` 按 `MODE_REGISTRY` 的 `PipelineSpec` 差异执行（lite/tech/patch 已成型；medium 应强制设计/技术方案、full 应含 PM 前置评估；取代散落 if/else）。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- **deploy.mjs FILES** 未含 `host/core/**`、`host/util.ts`、`host/constants.ts`、`host/prompts/**` 源码（运行时只看 lib，不影响功能；补上保持 profile 工作副本一致，非阻断）。
- `COST_BUDGET_TOKENS=250k` 硬编码 → 可升级为 service Config（观测线可调）。
- smoke.js 的源码断言依赖 host 目录聚合（`#region host-pool`）：新增领域文件需同步加入。

## 7. 变更记录（近期）

- 2026-08-18：领域化重构完成（11 领域文件，index 收门面）；smoke 改 host-pool 聚合断言；deploy.mjs 加运行 web 检测提示。
- 2026-08-18：triage 5 档（`MODE_REGISTRY` + `suggestMode` 正则 + `runTriage` 模型驱动 + `teamflow_triage` 工具 + `mode` 透传/归一）；许可共识：护栏角色(mode)不折叠、契约文档按档折叠、patch 档折叠独立 QA。
- 2026-08-18：`TRIAGE_PROMPT` 归入 `prompts/index.ts`（所有 prompt 统一）；本 AGENTS.md 建立（插件自身产品记忆锚点）。
- 2026-08-18：mode 路由落地（tech 技术变更单 / patch 单点确认+跳独立 QA）+ **模式透明化**（start 缺省自动模型分诊，使用者无需知道 mode）。
- 2026-08-18：端到端复验暴露三问题并修复——dev 执行纪律（任务卡唯一契约、禁核查既有功能）、patchConfirm 需求核对、验收结论解析（❌→rework / rework / 需求无效→needs-human，ADR-0005）。
