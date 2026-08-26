# ADR-0001：断点续跑自研 journal，不引入 LangGraph

- 状态：已接受（Accepted）
- 日期：2026-08（v0.1.0）
- 关联：`store.js`（journal 三件套）、`host/index.js`（executePipeline resume）

## 背景

流水线要跑 10+ 个子代理、30-60 分钟，进程重启后需要可恢复。候选方案：

1. 自研 journal checkpoint（`$DSH_HOME/teamflow/runs/<runId>.json`）
2. 引入 `@langchain/langgraph`（JS 版）做编排 + checkpoint

## 决策

自研（LangGraph checkpointer 语义的务实子集），不引入 LangGraph。

## 理由

- **LLM 编排不可重放**：LangGraph 的恢复 = 从 checkpoint 重放节点代码产生相同结果，对纯函数节点成立；我们的节点是子代理（LLM 调用），重放 = 重新烧 token 且结果不同。"跳过已完成阶段复用产物"（resume）两种方案都得自己写——checkpoint 的核心价值对我们失效一半。
- **分发风险**：LangGraph JS 开箱持久化 checkpointer 用 `better-sqlite3`（原生模块，Windows 安装可能失败）；纯 JS 文件版要么自写 `BaseCheckpointSaver`（回到自研），要么依赖尚不成熟的 node:sqlite 适配。DSH 插件分发要求薄依赖。
- **替换率 ~30%**：子代理编排、token 计量、backlog 落盘、文档归档都是 LangGraph 不管的；它只替换"编排骨架 + checkpoint"，而面板/工具/测试已按自研写好。迁移 = 重写 + 回归。
- **状态 schema 化成本**：LangGraph 要求 zod schema + 严格 JSON state；我们的 backlog/journal 自由 JSON 更灵活。

## 已对齐的概念（将来迁移概念兼容）

| LangGraph | TeamFlow |
|---|---|
| thread_id | runId |
| checkpointer | runs/<runId>.json |
| interrupt() | needs-human |
| Command(resume=) | 从断点重跑（teamflow_resume） |
| durable execution | 启动扫描标记 interrupted |

## 触发迁移的信号

- 编排复杂度显著上升（动态分支、`Send` 级扇出、多层循环）
- 需要 time travel / 历史版本重放 / 审计回滚
- 团队拥抱 LangChain 生态（LangSmith、LangGraph Platform）

## 若迁移的选型要点

- checkpointer 用 node:sqlite 适配，不用 better-sqlite3（避免原生编译）
- 子代理调用包成幂等节点：state 带产物缓存 + 节点入口检查缓存，让重放真正跳过
- 锁死 LangGraph 版本
- `store.js` 保留做 backlog——backlog 与 checkpoint 是两层，不冲突
