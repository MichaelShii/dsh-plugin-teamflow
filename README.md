# dsh-plugin-teamflow

TeamFlow 团队研发流水线 —— DeepSeek Harness 可分发插件（`dsh plugin --profile web add` 安装）。

把「用户一句话需求 → 真实研发团队多 Agent 流水线」做成宿主级能力：

```
需求 → PRD（基于既有模式/产品记忆，文档归档防臃肿）
     → （UI 改造时）UI/UX 设计
     → （新项目时）架构师规划并落地脚手架 + AGENTS.md
     → 高级全栈工程师技术方案（与派发任务对齐）
     → 可拆分任务时按并发并行开发
     → QA 功能测试（结构化缺陷 → 登记 Bug）
     → 产品验收（更新产品记忆）
```

## 核心特性

- **防假交付（v0.6.0）**：① 实质校验——拒绝措辞（"我无法完成"等）或低于阶段长度下限的输出视为未交付，走重试/需人工；② token 熔断——单阶段累计 60k 预算，超限停止重试；③ 上下文耗尽类失败不重试（重试同一 prompt 大概率复现）；④ 产品级并发锁——同一产品同时只允许一条活跃流水线，防需求状态互踩；⑤ 内存裁剪——timeline 摘要化 + 阶段产物内存删除（磁盘保留，resume 时从磁盘加载全文）。
- **完成汇总自动汇报主线程（v0.5.0）**：流水线结束（成功/失败/取消/中断）后自动把汇总（状态/阶段统计/token 总计/backlog/后续操作指引）投递给发起会话的 Agent——空闲时唤醒（followup），忙碌时注入下一步上下文（inject），与 DSH 后台任务通知同款机制（tool-jobs 模式，但独立实现，不依赖 web 面被禁用的 tool-jobs）。用户无需盯面板，模型会转述结果或按指引继续（认领缺陷/流转/断点重跑）。
- **断点续跑（v0.4.0）**：每阶段 checkpoint 落盘 `$DSH_HOME/teamflow/runs/<runId>.json`（LangGraph checkpointer 语义）；进程崩溃/重启后自动标记 `interrupted`，可用 `teamflow_resume` / 面板「↻ 从断点重跑」从第一个未完成阶段继续（跳过已完成阶段，复用阶段产物全文）。
- **backlog 持久化到 `$DSH_HOME/teamflow/<product>/backlog/`**
  `requirements.json` / `tasks.json` / `bugs.json`，跨重启不丢、对每个安装用户可移植。
- **状态机 + 事件日志**：需求（立项→进行中→待验收→已验收）、任务（待办→开发中→待测试→测试中→待验收→完成|打回|需人工）、缺陷（待认领→处理中→已修复待验→已关闭）。
- **打回阈值**：单阶段连续 2 次 Agent 失败自动重试，仍失败 → `needs-human`，需人工介入。
- **并发池**：开发任务按 `maxConcurrency`（默认 3，最大 8）并行执行。
- **QA 缺陷登记**：QA 报告按固定表格输出 → 自动解析成 Bug 进入 backlog。
- **token 计量（v0.8.0 双口径）**：每阶段记录**真实累计 usage**（in/cacheRead/cacheWrite/out + 调用数，由子代理会话逐事件累计）+ **上下文压力快照**（原有 measure）+ **计费当量**（cacheRead×0.1 折算）；汇总汇报同时给出双口径，避免把"尾声上下文"误当真实成本（实测低估约 26 倍）。详见 ADR-0003。
- **lite 模式（v0.8.0）**：微功能轻量——`teamflow_start(lite:true)` 跳过 UI/UX 设计与独立技术方案文档阶段（PRD 即契约），直接 **PRD → 开发 → QA → 验收** 4 段；实测较完整 7 段省 ~64% 时间、~88% token。
- **成本观测线**：单阶段计费当量超 `COST_BUDGET_TOKENS`（默认 250k）时**仅记录 warn、不打断**，用于暴露高成本阶段。
- **🏭 团队工作台（Web tab）**：与 chat / 轨迹并列的会话头部 tab，含：
  - 流水线图形工作流（阶段泳道 + 节点卡片：状态/耗时/token/子代理会话，2s 实时刷新）
  - **Backlog 拖拽看板**（需求/任务/缺陷三组状态泳道，卡片拖拽流转，原生 HTML5 DnD 零依赖）
  - 成本中心（每阶段 token + 总计 + 运行时长）
  - 人工介入中心（needs-human 项聚合 + 一键终态）
  - 历史 run 切换 + 产品切换

## AGENTS.md 最小侵入原则（重要）

AGENTS.md 会被 harness 无条件注入每个会话，是**团队资产**。TeamFlow 遵循职责分离：

- **AGENTS.md 只放稳定共识层**：团队角色流程、工程约定、文档索引、`<!-- teamflow:begin/end -->` 托管区（仅指针）。
- **产品记忆/待办放独立活文档** `docs/teamflow/memory.md`（按需读取，不注入每次会话 → 省 token）。
- **已有项目接入**：检测到 AGENTS.md 已存在 → 绝不重写/重排/覆盖，仅在文末追加托管块（若没有）；团队原有约定一行不动。
- **退出干净**：团队停用 TeamFlow 后，删除托管块与 `docs/teamflow/` 即完全复原，AGENTS.md 无残留账本。

## 架构决策记录（ADR）

关键设计决策独立存档于 `docs/adr/`，README 只留索引：

- [ADR-0001 断点续跑自研 journal，不引入 LangGraph](docs/adr/0001-self-hosted-journal-vs-langgraph.md)
- [ADR-0002 AGENTS.md 最小侵入（共识层/运营数据分离）](docs/adr/0002-agents-md-minimal-invasion.md)
- [ADR-0003 部署生效契约 + token 计量口径（真实累计/当量/观测线）](docs/adr/0003-release-deploy-and-token-metering.md)
- [ADR-0004 需求分诊路由 + 共享状态分层（full/lite/tech + context bundle）](docs/adr/0004-triage-and-shared-state.md)

新增决策时：`docs/adr/NNNN-<kebab-name>.md`（背景/决策/理由/影响/触发信号），并在本索引追加一行。

## 架构（阶段 3）

```
web profile 宿主组合
├── teamflow-host   (dsh-plugin-teamflow/host)      Cordis service `teamflow`
│     └── TeamflowService extends TypertRemoteService
│           ├── ctx.typert.register(strict descriptors)   ← 7 个 Remote 方法
│           ├── ctx.tools.register(teamflow_*)            ← 6 个模型工具
│           └── node:fs → $DSH_HOME/teamflow/...
└── teamflow-client (dsh-plugin-teamflow/client，自动扫描)  ← package.json 声明 dsh.client，
      └── ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)     无需 patch 行，clientModules 自动注册
            └── conversation.view tab「🏭 团队工作台」
```

**为什么不用 @Remote 装饰器**：宿主插件以纯 JS 分发，避免装饰器语法/TS 编译要求；
用 `ctx.typert.register` 注册 strict 描述符（`descriptors.js` 纯数据，host/client 共用一份，
保证 endpoint 与 wire 参数一致）。

**为什么是宿主级插件（而不是动态插件）**：动态（会话内）插件宿主运行在受限沙箱，
其 `fs` 被硬限制在运行时根，无法写入 `$DSH_HOME` 或会话工作区（实测
`file access denied under workspace-write mode`）。只有宿主组合里的正式插件拥有真实
Node `fs`，能把 backlog 落到 `$DSH_HOME`，且 client 能注册独立 tab。

## 目录结构

```
dsh-plugin-teamflow/
  package.json        # dsh.bundle.patch + dsh.client 声明；exports 指向 lib/ 构建产物
  cordis.patch.yml    # insert 块；entry 名用包根（clientModules 才能扫到 dsh.client）
  tsdown.config.ts    # client 构建（ModuleLoader bundle → lib/client.js）
  tsdown.host.config.ts # host/store/descriptors 构建（ESM → lib/*.mjs）
  descriptors.ts      # Remote 描述符（纯数据，host/client 共用）
  store.ts            # 持久化层：原子写/备份/损坏自愈 + journal 序列化/加载（可独立测试）
  host/index.ts       # TeamflowService（TS；构建为 lib/host.mjs 供宿主加载）
  client/index.tsx    # 团队工作台（TSX；构建为 lib/client.js）
  docs/adr/           # 架构决策记录（ADR-0001/0002…）
  test/smoke.js       # 无依赖 smoke 测试（描述符/模块结构/安全加固）
  test/journal.test.js # journal 行为测试（直跑 store.ts 源码）
```

**TypeScript 说明**：全仓 TS/TSX。host 之所以**必须构建**（不能靠 Node strip-types 直跑）——Node 22 的 type stripping 对 `node_modules` 下的文件不生效（"unsupported for files under node_modules"），而宿主组合从 profile/node_modules 加载插件。与 DSH 生态一致（`@deepseek-ai/dsh-*` 宿主包 exports 均指向 lib/*.js）。改动源码后需 `pnpm bundle` 重建并同步 profile 副本的 `lib/`。

## 安装（对使用者）

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-plugin-teamflow

# 或本地目录安装（开发时）
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow
```

安装后**重启** `dsh --profile web`，宿主行 `teamflow-host` 生效：
- 模型侧出现 `teamflow_start / teamflow_status / teamflow_backlog / teamflow_claim / teamflow_update / teamflow_cancel` 六个工具；
- 浏览器侧会话头部出现「🏭 团队工作台」tab；
- backlog 写入 `$DSH_HOME/teamflow/<product>/backlog/*.json`。

## 开发与验证

```bash
npm test                # smoke（描述符/结构/安全）+ journal（断点续跑行为）
npm run typecheck       # tsc --noEmit 类型检查（VSCode 同源，不飘红）
node --check host/index.js client/index.js store.js descriptors.js
npm run bundle          # 构建 client（tsdown → lib/client.js，__ModuleLoader__.load 注册）
```

**类型解析说明**：`@deepseek-ai/dsh-*` 是宿主私有包（不在公共 registry，运行时由 dsh profile
注入），类型取自本机已安装的宿主副本 `~/.dsh/profiles/node_modules/@deepseek-ai/*`——
`tsconfig.json` 的 `paths` 已映射（跨机器时把路径中的用户名改成自己的即可）。
构建（tsdown）不依赖此映射：host 构建对 `@deepseek-ai/*` 保持 external，client 不引用宿主包。

改完代码的生效链路（推荐）：`node deploy.mjs`（构建 + 测试 + 同步 profile 副本 + 检测运行中 web 并提示重启）→ 重启 `dsh --profile web`。
改完代码的生效链路（备用）：`npm run bundle` → profile 副本更新（`pnpm update dsh-plugin-teamflow`，在 `~/.dsh/profiles/web/` 下，若 Already up to date 先删 `node_modules/dsh-plugin-teamflow` 再 update）→ 重启 `dsh --profile web`。

**⚠ 生效前提（易踩坑，详见 ADR-0003）**：运行中的 web **从 profile 部署副本**（`~/.dsh/profiles/web/node_modules/dsh-plugin-teamflow/lib/`）加载 host，不是源码 `plugins/.../lib/`。只构建源码不在 profile 生效；必须 deploy 同步 + 重启进程，否则跑旧逻辑（如 lite 参数被静默忽略）。

注意：`lib/` 被 `.gitignore` 排除，但 `.npmignore` 不排除——`file:` 安装与 npm 发布
都必须带上构建产物（`exports["./client"]` 指向 `./lib/client.js`）。

## 发布

```bash
npm login
npm publish
```

## 契约速览

| 工具 / Remote | 作用 |
|---|---|
| `teamflow_start` / `teamflow.start(sessionId, requirement, options)` | 启动流水线 |
| `teamflow_status` / `teamflow.list()` + `teamflow.snapshot(runId)` | 查询运行进度（阶段/状态/token/日志/是否需人工） |
| `teamflow_backlog` / `teamflow.backlog(product)` | 查看 backlog（+ persistence 落盘路径） |
| `teamflow_claim` | 认领任务或缺陷 |
| `teamflow_update` / `teamflow.backlogUpdate(kind, id, to, product, reason)` | 人工流转状态（处理 needs-human） |
| `teamflow_cancel` / `teamflow.cancel(runId)` | 取消运行 |
| `teamflow_resume` / `teamflow.resume(runId, sessionId)` | 断点续跑（从第一个未完成阶段重跑） |
