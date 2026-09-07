# TeamFlow 待办（TODO）— 未完成事项，按需查阅

> **本文件不注入 agent 会话**（AGENTS.md 只含当前态约束）；维护者/按需查阅用。
> 已完成条目直接删除（不留 ✅ 残骸，git log 可追溯）。

## 真待办（需人决策/行动）

- 🔜 **用「持久化」类需求重跑验证 ADR-0006**：确认 M0 状态核对注入、M1 蓝图产出（架构阶段不再被 lite 跳过）、M2 dev 按蓝图拆任务、M3 验收架构核验（重复适配器应被打回）全链路生效。
- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别"需求与现状不符"即停，避免走完开发/验收。
- `STAGE_TOKEN_BUDGET=60k` 硬编码 → 可升级为 service Config（熔断阈值可调）。
- 🔜 **给官方提交 PR（低侵入原则下不自改 DSH）**：`conversation` 服务增加 `setView(viewId)`（复用内部 `store.actions.setView`），使「查看子代理会话」可一键跳转并自动切到「对话」tab；PR 合并前暂用 B 方案（按钮加引导文案：「跳转后请切「对话」tab 查看轨迹」）。
- 🔜 **跨会话跳转子代理（同 PR 范畴）**：DSH 子代理目录按父会话加载，`selectSubagent` 不支持跨父导航。已记录 `journal.ownerSession`（发起会话，下发于 stageDetail），跳转按钮在 ownerSession≠当前会话时**禁用 + title/文案提示**；待官方支持跨父会话导航后再解锁（数据已备好）。