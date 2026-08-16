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

## 架构（阶段 3）

```
web profile 宿主组合
├── teamflow-host   (dsh-plugin-teamflow/host)      Cordis service `teamflow`
│     └── TeamflowService extends TypertRemoteService
│           ├── ctx.typert.register(strict descriptors)   ← 7 个 Remote 方法
│           ├── ctx.tools.register(teamflow_*)            ← 6 个模型工具
│           └── node:fs → $DSH_HOME/teamflow/...
└── teamflow-client (dsh-plugin-teamflow/client)
      └── ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION) ← 与 host 同一份 descriptors
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
  cordis.patch.yml    # 宿主组合补丁：teamflow-host / teamflow-client 两行
  descriptors.js      # Remote 描述符（纯数据，host/client 共用）
  host/index.js       # TeamflowService（真实 Node fs → $DSH_HOME/teamflow）
  client/index.js     # 团队工作台（conversation.view tab + 拖拽看板）
  test/smoke.js       # 无依赖 smoke 测试（node test/smoke.js）
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
node test/smoke.js      # 描述符规则 + 模块结构校验（无需任何依赖）
node --check host/index.js client/index.js descriptors.js
npm run bundle          # 发布前构建 client（tsdown；产物 lib/client.js）
```

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
