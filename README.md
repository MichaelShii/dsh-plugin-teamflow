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
- **打回阈值**：单阶段连续 2 次 Agent 失败自动重试，仍失败 → `needs-human`，需人工介入（可用 `teamflow_update` 用终态清除）。
- **并发池**：开发任务按 `maxConcurrency`（默认 3，最大 8）并行执行。
- **QA 缺陷登记**：QA 报告按固定表格输出 → 自动解析成 Bug 进入 backlog。
- **token 计量**：每阶段记录 token 用量（上下文压力估算）。
- **Web 面板**：conversation Chat Node 展示阶段看板 + backlog 摘要 + 落盘路径。

## 为什么是宿主级插件（而不是动态插件）

动态（会话内）插件宿主运行在受限沙箱：其 `fs` 被硬限制在运行时根，**无法写入
`$DSH_HOME` 或会话工作区**（实测：`file access denied under workspace-write mode`）。
只有宿主组合里的正式插件才拥有真实 Node `fs`，能把 backlog 落到 `$DSH_HOME`。

## 目录结构

```
dsh-plugin-teamflow/
  package.json        # dsh.bundle.patch + dsh.client 声明
  cordis.patch.yml    # 宿主组合补丁：teamflow-host / teamflow-client 两行
  host/index.js       # 宿主插件（真实 Node fs → $DSH_HOME/teamflow）
  client/index.tsx    # 浏览器面板（conversation Chat Node）
```

## 安装（对使用者）

```bash
# 从 npm 安装（发布后）
dsh plugin --profile web add dsh-plugin-teamflow

# 或本地目录安装（开发时）
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow
```

安装后重启 `dsh --profile web`，宿主行 `teamflow-host` 生效：
- 模型侧出现 `teamflow_start / teamflow_status / teamflow_backlog / teamflow_claim / teamflow_update / teamflow_cancel` 六个工具；
- 浏览器侧出现「团队研发流水线」面板；
- backlog 写入 `$DSH_HOME/teamflow/<product>/backlog/*.json`。

## 发布

```bash
npm login
npm publish
```

## TODO（client 接入）

`client/index.tsx` 的 `callHost()` 尚未接入当前 web client runtime 的远程桥。
参考 `packages/client/ui-workflow-run` 与 `packages/client/ui-trajectory`（deepseek-harness 仓库内）：
面板应注入 `@deepseek-ai/dsh-client-runtime`，通过 runtime 的远程通道调用宿主
`harness.handle('teamflow/*')`。接入后运行 `pnpm bundle`（tsdown）产出 `lib/client.js`
并调整 `package.json` 的 `exports["./client"]`。

## 契约速览

| 工具 | 作用 |
|---|---|
| `teamflow_start` | 启动流水线（requirement / needDesign / needScaffold / productRoot / maxConcurrency / tasks[]） |
| `teamflow_status` | 查询运行进度（阶段 / 状态 / token / 日志 / 是否需人工） |
| `teamflow_backlog` | 查看 backlog（需求 / 任务 / 缺陷 + persistence 落盘路径） |
| `teamflow_claim` | 认领任务或缺陷 |
| `teamflow_update` | 人工流转状态（处理 needs-human） |
| `teamflow_cancel` | 取消运行 |

RPC（web 面板）：`teamflow/ping` `teamflow/list` `teamflow/snapshot` `teamflow/start`
`teamflow/cancel` `teamflow/backlog` `teamflow/backlogUpdate`。
