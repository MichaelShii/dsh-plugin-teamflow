# 锚点详情：宿主级插件的两条硬约束（AGENTS.md §3 原文）

> 从 AGENTS.md §3 迁出的完整论证（为何不用 `@Remote` 装饰器、为何必须是宿主组合里的正式插件，
> 含实测现象）。结论仍以 AGENTS.md §3 为准；本文件逐字保留原文。

**宿主级插件的两条硬约束（README「架构」节的那两条取舍，勿回退）**：① **不用 `@Remote` 装饰器**——插件以纯 JS 分发（宿主从 profile 的 `node_modules` 加载 `lib/`），Remote 面走 `ctx.typert.register` 的**严格描述符**（`descriptors.ts` 纯数据、host/client 共用一份，保证 endpoint 与 wire 参数一致）；② **必须是宿主组合里的正式插件**（不做动态 / 会话内插件）——动态插件的 `fs` 被硬限制在运行时根，写不了 `$DSH_HOME`（实测 `file access denied under workspace-write mode`），而 backlog / journal / 日志归档全落在 `$DSH_HOME/teamflow/`；也只有正式插件能注册独立 tab（`conversation.view` / `main` / `sidebarRightTabs`）。
