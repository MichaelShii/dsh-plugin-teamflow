# 锚点详情：prompt 约束分级

> 本文件是 `AGENTS.md` §5 中「prompt 约束分级」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

prompt 内**禁止自称 hard constraint**（措辞硬与 enforcement 脱节→模型对 high-signal 词脱敏，实证 17 条 warn 零削减）；分级 `[HOST-ENFORCED]`（host 真实强制：单轨产物/验收结论行，必须描述真实后果）+ `[policy]`（自律 + guard warn/轻提醒）
