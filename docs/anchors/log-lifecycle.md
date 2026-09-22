# 锚点详情：日志生命周期（B 方案）

> 本文件是 `AGENTS.md` §5 中「日志生命周期（B 方案）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

**日志根离开用户项目**：子代理受 DSH 文件沙箱约束（`workspace-write` 只允许写会话工作区 + 平台临时区，写 `$DSH_HOME` 实测 `FS_SANDBOX_DENIED`），故为两段式——**暂存**（run 期间写 `<workspacePath>/logs/teamflow/<runId>/`）→ **过滤归档**（run 终态 `core/runlogs.archiveRunLogs`：**只留白名单**——code 扩展名 `.mjs/.cjs/.js/.sh/.ps1/.py/.md` + `captures.json`，搬到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删项目内副本；host 自身事件日志 `run.log` 直接写归档位）。**归档面 = 可重跑/人可读的检查脚本与结论笔记**——命令输出（`*.log`/`*.out`/`*.txt`）与源码快照**一律丢弃**（实测一次真实 run 130 文件/3.03 MB 里 93% 是这两类：41% 命令输出可重跑、35% 是 git 里已有一模一样的 `probe/head/**` 快照、17% prompt JSON dump；**唯一不可重跑且真被用过的 7% 就是脚本**）。命令输出在运行期仍有价值（把几百行输出挡在上下文之外，TOKEN_HYGIENE），但**不是审计资产**——durable claim 是回复里的 `[Verification evidence]` 块（随 journal 落盘、工作台可见）。**自愈清扫**：run 起跑 `sweepWorkspaceLogs` 按同一白名单处理上次崩溃/被 kill 残留的暂存目录与历史散落 `<runId>.log`／笔记（目录按名当 runId 归档；`<runId>.log` 直接丢弃——内容与 `runs/<runId>.json` 的 journal.logs 同源）；**保留 `LOG_ARCHIVE_KEEP=20` 次/工作区**（按 mtime 淘汰）；**正在运行的 run（暂存目录与归档）一律跳过**；任何失败只 warn、绝不阻断起跑/收尾。prompt 侧 `[Log lifecycle · policy]` 明确定性（暂存目录、只留脚本与笔记、dump 不留存、禁止提交/自行清理/当项目产物）。禁止回退为「日志长期留在用户项目」——实测 `products/tetris` 曾累计 1042 文件/17.3 MB 且无任何清理逻辑；禁止回退为「全量归档」——那是把 3 MB 里 2.7 MB 的噪音搬进 `$DSH_HOME`
