# QA-REPORT — 复验对照表不得被当作缺陷表（en，2026-09-15 tf-mu2ioilr-95l4th 停线形状）

> 语料用途：冻结真实停线形态——QA 复验报告里同时存在「round-2 缺陷复验对照表」（第 2 列是
> P 级、第 3 列是结论「已关闭/误报」）与标准缺陷表（仅 P3 观察项）。
> 期望：`parseDefects` **只解析表头声明了严重级列的表格** → 对照表整表跳过（R2-* 一条都不登记），
> 标准缺陷表照常解析（R3-1/R3-3 两条 P3），OBS 观察项跳过。
> 历史 bug：旧实现按列位置认缺陷，把对照表整表登记为缺陷（每轮复验重生一个 P2）→ 复验必然超限停线。

## 1. 结论

**Pass — deliverable.** typecheck exit 0; full suite green; no P0/P1/P2 defects; 6 P3 observations only (non-blocking).

## 2. round-2 defect re-verification

| 编号 | round-2 级 | 复验结论 | 独立证据 |
|---|---|---|---|
| R2-1 en 分支 5 处中文章节名/标签 | P2 | **已关闭** | en output contains CJK 0 |
| R2-2a logSkip('开发') | P3 | **QA 原判为误报（dev 结论成立）** | phaseLabel(en, 开发) = Development |
| R2-3 中文句夹英文泛词的档位漂移 | P3 | **已关闭** | 19 zh samples, 0 tier drift |
| R2-4 util.ts 自带双语三元 | P3 | **维持现状（不判缺陷）** | en diagnostic bundle has no CJK |

## 3. Defect table

| ID | Severity (P0/P1/P2/P3) | Module | Steps | Expected | Actual | Related AC |
|---|---|---|---|---|---|---|
| R3-1 | P3 | logging | run dev retry in en | en logs fully English | template hardcodes a full-width colon | AC-3 |
| R3-3 | P3 | tools | inspect teamflow_* schema | host copy follows locale | tool descriptions embed zh status names | AC-3 |
| OBS-9 | P3 | prompts | render acceptancePrompt in en | ASCII punctuation | full-width slash used | AC-5 |
