# dsh-plugin-teamflow

[![npm version](https://img.shields.io/npm/v/dsh-plugin-teamflow)](https://www.npmjs.com/package/dsh-plugin-teamflow) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

中文 | [English](./README.en.md)

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

## 界面预览

1. 流水线视图——阶段蛇形泳道 + 节点卡片（状态/耗时/token/子代理会话）

   ![流水线视图](docs/screenshots/pipeline-view.png)

2. Backlog 看板——需求/任务/缺陷拖拽泳道

   ![Backlog 看板](docs/screenshots/board.png)

3. 阶段详情抽屉——阶段性产物全文 + token 明细 +「🎬 跳转子代理会话」

   ![阶段详情](docs/screenshots/stage-detail.png)

4. 看板任务详情——任务卡抽屉（需求原文/分配/事件时间线/子卡/缺陷/token）

   ![看板任务详情](docs/screenshots/board-task-detail.png)

5. 团队选择——🏭 按钮 + 团队下拉

   ![团队选择](docs/screenshots/team-selector.png)

## 核心特性

- **一句话需求 → 可验收的交付**：从需求到 PRD / 技术方案 / 并行开发 / QA / 验收全链路自动编排，每个阶段有任务卡、有产物、有结论；机械小改动可用 `patch` / `lite` 档裁剪阶段集，不必为一行改动跑完整瀑布。
- **多 Agent 团队 + 并行开发**：按架构蓝图把需求拆成可并行任务（默认 3 路并发，上限 8），产品 / 架构 / 开发 / QA 各自独立上下文，互不污染。
- **防假交付**：交付看证据不看措辞——阶段必须给出「命令 + 退出码 + 断言数」的验证证据，QA 有独立对抗探针，验收只认显式结论行（缺失即停线转人工）。
- **QA 打回闭环**：P0–P2 缺陷自动打回修复 → 复验（≤2 轮），每条缺陷都带「检测命令 + 通过判据」；超限转人工，不会伪装成「已完成」。
- **断点续跑 + 完成汇报**：进程崩溃 / 重启后从第一个未完成阶段继续（已完成阶段复用产物）；流水线结束时自动把汇总（状态 / 阶段 / token / 后续指引）投递回发起会话。
- **你的仓库保持干净**：流水线文档收口在 `docs/teamflow/` 任务夹，插件自己的运行日志在 run 结束时归档出项目，收口提交只带**代码 + 任务夹**（一个 run 一个 commit，**不需要你预先配置 `.gitignore`**）。若历史提交里已经混进过 `logs/teamflow/`，在目标仓库执行 `git rm -r --cached logs/teamflow` 移出即可（本地文件保留）。
- **🏭 团队工作台（Web 双入口）**：会话内 tab（流水线图 + 拖拽看板 + 成本中心 + 人工介入中心）与应用级主面板（产品线视角，跨会话可用）；点开 run 看阶段、token、验证证据与产物。**界面中英双语**，跟随宿主语言实时切换；host 侧的回复、流水线日志与产物文档同样跟随语言（run 起跑时定一次，同一条 run 内一致）。
- **token 有账可查**：按官方口径记录每个阶段的输入（未命中 / 命中）/ 写缓存 / 输出与调用数，并给出缓存命中率，汇报与看板同口径；机械阶段自动降档推理强度，重试时回升。


## AGENTS.md 最小侵入原则（重要）

AGENTS.md 会被 harness 无条件注入每个会话，是**团队资产**。TeamFlow 遵循职责分离：

- **AGENTS.md 只放稳定共识层**：团队角色流程、工程约定、文档索引、`<!-- teamflow:begin/end -->` 托管区（仅指针）。
- **产品记忆/待办放独立活文档** `docs/teamflow/memory.md`（按需读取，不注入每次会话 → 省 token）。
- **已有项目接入**：检测到 AGENTS.md 已存在 → 绝不重写/重排/覆盖，仅在文末追加托管块（若没有）；团队原有约定一行不动。
- **退出干净**：团队停用 TeamFlow 后，删除托管块与 `docs/teamflow/` 即完全复原，AGENTS.md 无残留账本。

## 架构（阶段 3）

```
web profile 宿主组合
├── teamflow-host   (dsh-plugin-teamflow/host)      Cordis service `teamflow`
│     └── TeamflowService extends TypertRemoteService
│           ├── ctx.typert.register(strict descriptors)   ← 22 个 Remote 方法
│           ├── ctx.tools.register(teamflow_*)            ← 12 个模型工具
│           └── node:fs → $DSH_HOME/teamflow/...
└── teamflow-client (dsh-plugin-teamflow/client，自动扫描)  ← package.json 声明 dsh.client，
      └── ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)     无需 patch 行，clientModules 自动注册
            ├── conversation.view tab「🏭 团队工作台」（会话内）
            ├── sidebar.panellist + main/teamflow（全局产品线面板）
            └── sidebarRightTabs「teamflow-run」（右栏 run 详情 tab）
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
  host/core/products.ts # 产品线装配（全局面板数据面：清单/摘要/地址）
  client/index.tsx    # 会话内团队工作台 + 全部 slot 注册（TSX；构建为 lib/client.js）
  client/panel.tsx    # 全局面板（sidebar.panellist + main）+ 右栏 run 详情 tab
  client/shared.tsx   # 共享展示层（主题 token / 状态词表 / 格式化）
  test/smoke.js       # 无依赖 smoke 测试（描述符/模块结构/安全加固）
  test/product-scope.test.js # 产品线装配测试（地址/白名单/过滤/摘要/空态）
  test/journal.test.js # journal 行为测试（直跑 store.ts 源码）
```

**TypeScript 说明**：全仓 TS/TSX。host 之所以**必须构建**（不能靠 Node strip-types 直跑）——Node 22 的 type stripping 对 `node_modules` 下的文件不生效（"unsupported for files under node_modules"），而宿主组合从 profile/node_modules 加载插件。与 DSH 生态一致（`@deepseek-ai/dsh-*` 宿主包 exports 均指向 lib/*.js）。改动源码后需 `pnpm bundle` 重建并同步 profile 副本的 `lib/`。

## 环境要求

- DeepSeek Harness（dsh）宿主，**web profile**（插件含浏览器端工作台，client 面向 web 平台）；
- Node.js ≥ 22.18；
- 依赖宿主提供的 `@deepseek-ai/dsh-*` 与 `react`（peerDependencies，宿主注入，无需单独安装）。

### 版本锚定（dsh 宿主兼容性）

本插件开发与验证基于 **dsh v0.1.5-rc.2（2026-09-10，tag `dsh-v0.1.5-rc.2`）**；npm 侧 `next`=0.1.5-rc.2、`latest`=0.1.5-rc.1（`latest` 常滞后于 `next`，勿以 latest 判断发布线）。`peerDependencies` 保持 `*`（宿主注入，宽松兼容），并在 `package.json` 声明兼容窗口 **`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`** 与 **`dsh.manifestVersion: 1`**——当前 dsh 不读取/校验这两个字段（源码内仅有类型声明），属作者声明性元数据。

2026-09-10 兼容性核对（dsh 0.1.5-rc.2）：插件面板 Slot（原 `conversation` 根 slot → `main` 下的 `conversation` key）、会话格式 V3 + Session 生命周期（`SessionHandle`、异步 `agentLoop.create()`、会话锁）、`ctx.agent` 移除与 Inbox 类型化、SDK/Headless/ACP 默认工具调整、subprocess handle 去除 pid——**插件全部兼容**（未使用被改动的接口；`conversation.view` / `conversation.input.right` 声明未变，slot 树无删除）。其中一项需要跟进：

- **Session 同步事件读取器已弃用**（`session.eventAt()` / `snapshotEvents()` / `ownEvents()`，宿主 2026-09-09 起「存量可留、新调用禁止」，方向是不再把完整事件序列常驻内存）：**token 计量已改为官方 Session 投影优先**（`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶 + `'sessionStats'.steps` 取调用数），事件扫描降级为无投影宿主的回退；**护栏的提醒通道已改官方 `Agent.inject()`、挂死判据已改用官方 `subagentTiming` 投影的 `active.through`**（长工具静默仍由 agent 活动守卫豁免），只剩**复读检测**仍在读事件（需要流式文本内容，官方替代＝订阅 `'session/event'` post-commit 投递，需先定等价判据，见 `docs/TODO.md`）。

2026-09-04 核对（dsh 0.1.3-alpha.1）：session 持久化 v2（write-lease/JSONL 快照/版本化导出）、attachment/file-upload 收口、Windows 子进程隐藏、workspace 全限定路径硬化——全部兼容，插件无需调整。

插件侧契约约束（dsh 升级后若行为异常先核对本段；锚定版本变更会在此更新）：
- 插件注入的 session 事件（`tool-workflow/agent-start`、`user/message` 带 `source.kind='plugin'`）均在宿主 `known-event-types` 词表内；**未来新增自定义事件类型须带 `ignorable: true`**，已知类型载荷不加词表外键；
- `@deepseek-ai/dsh-client-modules` 自 0.1.2-rc.1 起替代 `@deepseek-ai/dsh-client-runtime`（后者已从 monorepo 移除）；
- 计量读的是**宿主投影 key**（`tokenUsage` / `sessionStats`）而非插件自有格式：宿主若改 key 或 state 版本，此段与 `host/core/metering.ts` 同步更新。

## 安装（对使用者）

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-plugin-teamflow

# 或本地目录安装（开发时）
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow
```

安装后**重启** `dsh --profile web`，宿主行 `teamflow-host` 生效：
- 模型侧出现 12 个 `teamflow_*` 工具：`start / triage / status / backlog / claim / update / assign / cancel / resume / pause / resume_session / merge`；
- 浏览器侧：会话头部「🏭 团队工作台」tab（会话内）+ **左侧边栏「团队工作台」图标**（全局面板，产品线视角）；
- backlog 写入 `$DSH_HOME/teamflow/<product>/backlog/*.json`。

> 注意：`@deepseek-ai/*` 为宿主私有包，运行需 DeepSeek Harness（dsh）宿主环境；本包不发布也无法独立运行。

## 快速上手

1. **选团队**：会话输入框旁点「🏭」按钮，选择团队（或选「无团队」= 不走流水线，直接对话）；
2. **发需求**：直接说需求，模型会自动调用 `teamflow_start`（自动分诊模式：patch / lite / tech / medium / full）——也可以用「直接跑 medium 模式做这个」等指定档位；
3. **看进展**：会话头部切到「🏭 团队工作台」tab——流水线图实时刷新（每阶段 token / 耗时 / 子代理会话），Backlog 看板可拖拽流转、点卡片看详情；点「⇥ 右栏打开」把该 run 详情放到右侧栏（与任务夹产物并排）。想看**跨会话/全局**的情况，点左侧边栏「团队工作台」图标（产品线视角：产品线 → run 列表 + backlog）；
4. **收结果**：流水线完成后自动向当前会话汇报（状态 / 阶段统计 / token / 后续指引）；中断/失败的运行可「↻ 从断点重跑」。

> 使用规则提醒：`teamflow_start` 调用后**主线程不要自行改代码或跑验证**——实现、QA、汇报由流水线各阶段子代理完成（避免与流水线抢活）。

## 卸载（对使用者）

```bash
dsh plugin --profile web remove dsh-plugin-teamflow
```

重启 `dsh --profile web` 后插件完全移除（模型侧 `teamflow_*` 工具与「🏭 团队工作台」tab 消失）。

可选清理（卸载**不会**自动清，按需执行）：
- **运行数据**：删除 `$DSH_HOME/teamflow/`（backlog / 运行记录，删除前确认不再需要）。
- **项目痕迹**：若某项目用过 TeamFlow，删除该项目 `AGENTS.md` 中的 `<!-- teamflow:begin/end -->` 托管块与 `docs/teamflow/` 目录，即可完全复原（AGENTS.md 最小侵入原则的"退出干净"）。

## 开发与验证

```bash
npm test                # smoke（描述符/结构/安全）+ journal（断点续跑行为）
npm run typecheck       # tsc --noEmit 类型检查（需本机 dsh profile 提供 @deepseek-ai/* 类型）
node --check lib/host.mjs lib/client.js lib/store.mjs lib/descriptors.mjs
npm run bundle          # 构建 client（tsdown → lib/client.js，__ModuleLoader__.load 注册）
```

**插件开发者**（本插件的本地开发链路）见仓库内 [`AGENTS.md`](./AGENTS.md) 与 [`docs/adr/`](./docs/adr)——含部署同步（`node deploy.mjs` → 重启 `dsh --profile web`）、生效前提（运行中 web 从 profile 部署副本加载 host，只构建源码不生效）、设计决策记录（ADR-0001~0009）与基准对比（`docs/benchmarks/`）。本仓库其余源码均为 TS/TSX，需先 `pnpm bundle` 构建后再运行（`node_modules` 下 strip-types 不生效）。

注意：`lib/` 被 `.gitignore` 排除，但发布必须带上构建产物（`files` 白名单已含 `lib/`；`exports["./client"]` 指向 `./lib/client.js`）。

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
| `teamflow_triage` | 需求分诊预览（默认 start 自动分诊，仅在想预评估/强制 mode 时使用） |
| `teamflow_assign` | 指定任务/缺陷的负责人（与 claim 分离：claim 只改状态） |
| `teamflow_pause` / `teamflow_resume_session` | 当前会话暂停/恢复 teamflow 触发（会话级，新会话自动重置） |

## License

MIT —— 详见 [LICENSE](./LICENSE)。
