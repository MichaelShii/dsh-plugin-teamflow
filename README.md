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
- **token 计量**：每阶段记录 token 用量（上下文压力估算）。
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
  package.json        # dsh.bundle.patch + dsh.client 声明
  cordis.patch.yml    # 宿主组合补丁：teamflow-host（client 自动扫描，无 patch 行）
  descriptors.js      # Remote 描述符（纯数据，host/client 共用）
  store.js            # 持久化层：原子写/备份/损坏自愈 + journal 序列化/加载（可独立测试）
  host/index.js       # TeamflowService（真实 Node fs → $DSH_HOME/teamflow；断点续跑）
  client/index.js     # 团队工作台（conversation.view tab + 拖拽看板 + 断点重跑）
  docs/adr/           # 架构决策记录（ADR-0001/0002…）
  test/smoke.js       # 无依赖 smoke 测试（描述符/模块结构/安全加固）
  test/journal.test.js # journal 行为测试（写入→崩溃→中断标记→重建）
  tsdown.config.ts    # 发布前构建 client 用（参考 @deepseek-ai/dsh-client-ui-*）
```

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
node --check host/index.js client/index.js store.js descriptors.js
npm run bundle          # 构建 client（tsdown → lib/client.js，__ModuleLoader__.load 注册）
```

改完代码的生效链路：`npm run bundle` → profile 重装（`pnpm update dsh-plugin-teamflow`，在
`~/.dsh/profiles/web/` 下，若显示 Already up to date 先删
`node_modules/dsh-plugin-teamflow` 再 update）→ 重启 `dsh --profile web`。

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
