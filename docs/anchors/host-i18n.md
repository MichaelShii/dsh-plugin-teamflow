# 锚点详情：语言层（host i18n）

> 本文件是 `AGENTS.md` §5 中「语言层（host i18n）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

语言「从哪来」只有**一个读取点**（`core/locale.ts`，禁止消费点各自读 settings/自建语言缓存）：**客户端推送**（浏览器当前语言 + 系统探测，经既有 Remote 面 `teamflow/setLocale`；用户没在宿主显式选过语言时**这是唯一真实来源**）> **宿主 settings 只读端口**（`settings.get('locale').preference`，缺失/异常一律 null、绝不抛）> **`en` 兜底**。**run 起跑解析一次写 `journal.locale`**，此后一律读快照（`runLocaleOf`）——同 run 语言一致、断点续跑沿用、用户切语言只影响之后新起的 run；历史 journal 无该字段按 `zh`（存量文案本就是中文），`localeForMissingSnapshot(resume)` 对 resume 一律 `zh`（绝不按当前界面语言重解析）。文案一律 `t(locale, key, params)`（词典在 `host/locales{,.d}/`，`AGENTS.md`/`memory` 模板、产物语言指令 `langDirective`、阶段/档位标签同源）。**判据/解析词表只增不改**：验收结论行 zh 四档逐字保留并**新增** en 四档（`✅ Pass`/`⚠️ Conditional pass`/`❌ Fail`/`📝 Not applicable`，否定词表新增 `fail/failed/not pass/not passed`（后者为解析器兼收的等价写法，prompt 实发 `Fail`）但**刻意不含裸 `rework`**）、缺陷表新增 en 表头、`REFUSAL_PATTERN` 与 triage 关键词表**新增**英文项（中文项一字不动）、L2 语料只增；`test/locale.test.js` 守门（键唯一 / zh-en 同形 / **en 无 CJK** / 值非空）
