# 锚点详情：验证证据块

> 本文件是 `AGENTS.md` §5 中「验证证据块」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

dev/qaFix 回复末尾强制 `[Verification evidence]` 块（命令+退出码+断言计数+失败行引用，或显式 N/A）→ host 提取存证 `stage.verifyEvidence`（stageDetail 可见；逐条**重跑命令**即可核对，被截断输出的全文在宿主报告的 spill 路径）；policy 级——缺失记 warn 不中断。**日志布局（同 policy）**：**不制造输出 dump**——命令/套件输出**不落文件**（长输出由宿主截尾、全文 spill 到它报告的临时路径）；`logs/teamflow/<runId>/` 只放要留存的三类：检查脚本 `scripts/`、不可重跑载荷 `captures.json`、结论 `.md`（**路径一律写全**；run 期间的项目内暂存，终态归档到 `$DSH_HOME`，见「日志生命周期」锚点）；**同一用途不得新增编号变体**（`-run2`/`dbg-repro2`/`dbg-scan3` 一律就地覆盖）、**改动前基线只物化一次共享**（`probe/head/`）；**项目根不得出现 `scripts/`、`probe/`**（实锤 tf-mtx6fi2a：未写全路径时模型在项目根建了这两个目录，6 个草稿被卷进交付提交）。实锤：旧约定下一次 run 写了 23 个 `.out` + 5 个 `regression-*.log`（1.2 MB，占其产出文件 41%），归档时全部被丢弃
