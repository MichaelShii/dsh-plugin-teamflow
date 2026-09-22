# 锚点详情：交付判定（信号分级）

> 本文件是 `AGENTS.md` §5 中「交付判定（信号分级）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

dev/qa 产出判定 = `judgeDeliverable` 三级：① 客观形态（非空 + 阶段长度下限）→ ② **真交付信号**（`DELIVERY_EVIDENCE_PATTERN`：`[Verification evidence]` 块）→ ③ 措辞兜底（`REFUSAL_PATTERN` 仅在**无证据块**时否决）。命中拒绝词但有证据块 → 判交付 + 记 warn 留痕（措辞只作诊断）。**禁止回退为「全文拒绝词即否决」**——实锤 assetd tf-mtwvwpxa-p3vw08 T5：如实汇报「用例无法执行」被误判未交付，停线 16 分钟 + 重复补跑。失败尝试的真实产出不丢（`pipeline.stageTextOf`：证据存证 / state 回写 / 子卡产物 / 诊断包均取 `text || stage.output`）。**doc 类阶段的产物兜底（2026-09-18 probe-v2 实锤，勿回退）**：prd/design/tech/qa/acceptance 的产物**就是任务夹文件**，回复只是摘要——回复过短**不等于**没干活，故回复不合格时**回读任务夹产物**（`util.DOC_STAGE_FILES` 按阶段给候选文件名、`stageDocText` 取最长的一个；`artifactText` 住 util，pipeline/runner 共用），文件在且达该阶段长度下限 → 判交付 + warn `diag.docDelivered`（带回复长度/文件长度/文件名）。**边界（硬要求）**：① **不豁免非空回复**——pipeline 要用回复合并 state 块，空回复是真的没交付；② 只有「产物就是任务夹文件」的阶段入表——dev/qaFix 交付在代码 + 证据块、scaffold/architecture 产物是代码/蓝图对象；③ patch 档 PRD 刻意不产文件 → 无候选文件时机制自然不生效。实锤：`tf-mu71waxg-4iws10` 的 PRD 写了 4894 字节 `PRD.md`、还调了 `present` 声明交付物，却因回复只有 284 字符的 state 块被判「未交付」→ 阶段失败 → 熔断转人工
