# ADR-0007：QA 发现缺陷 → 打回开发修复 → 复验 → 干净才验收（有界循环 + 人工兜底）

- 状态：已接受（Accepted）
- 日期：2026-08（v0.12）
- 关联：`host/core/pipeline.ts`、`host/core/backlog.ts`、`host/constants.ts`、`host/prompts/index.ts`、`test/smoke.js`

## 背景

对照实验 run `tf-mt317a5e-0iwvuy`（干净分支 feat/persistence-localStorage2，tech 档）实测暴露两个流程缺陷：

1. **QA 发现的缺陷没有被解析**。QA 报告缺陷行按 markdown 加粗写严重级（`| BUG-P1-1 | **P1** | …`），
   `parseDefects` 旧正则是 `(P[0-3])\s*\|`，要求严重级后**紧跟管道符** → `**P1**` 匹配失败 → 缺陷 0 条。
   于是日志记录「QA 未发现 P0/P1/P2 缺陷（未登记 Bug）」，任务静默进入 `pending-acceptance`。
2. **没有 QA→开发 打回闭环**。即使解析出缺陷，旧逻辑也只是登记 bug 后照样进产品验收；
   QA 的负向结论要等到验收（PM）再拦一次（本次是资深 PM 源码复核拦下的），
   既浪费一次验收调用，也让「QA 报告已给出可执行缺陷」的事实被流程白白放过。

用户反馈明确要求：QA 发现缺陷 → **打回开发确认是否属实 → 属实则直接修复 → 复验 QA →
QA 干净才到产品最终验收**；该循环需**限制轮次上限**（防无限循环），超限才转人工介入。

## 决策

### 1. 修复缺陷解析（`backlog.ts` `parseDefects`）
- 改为按管道单元格解析：容忍 markdown 加粗（`**P1**`）、反引号、行首 `|` 偏移；不再要求固定列数。
- 只认「三要素齐全（id / P0-P3 严重级 / 模块）+ 非表头 + 非 OBS」的行 → 真实缺陷（含 `**P1**`）必被解析。
- 语义保持不变：P0/P1/P2 = 阻断缺陷；P3 = 观察项（非阻断）。

### 2. QA→开发→复验 有界闭环（`pipeline.ts`）
- QA 阶段改为 `do…while` 循环，最多 `1 + QA_REWORK_LIMIT` 轮：
  - 第一轮：常规 QA（label「QA 测试工程师 · 功能测试」）。
  - 解析缺陷 → 阻断缺陷（P0-P2）> 0：
    - 未超上限 → `advanceTask('rework')`，启动开发修复子代理（新 prompt `qaFixPrompt`，
      指令「**先确认缺陷是否属实 → 属实在既有架构上修复 → 交还复验**」，防"修错/臆造/无视误报"）。
    - 修复摘要拼接进下一轮 QA 的开发结果上下文 → 复验（label「QA 复验 · 第N轮修复后」）。
    - 复验无阻断缺陷 → `verifyReqBugs` 关单 + `advanceTask('pending-acceptance')` → 进入产品验收。
- **QA 干净是进产品验收的充分条件**：验收块由 `if (!qaBlocked)` 门控；QA 不干净绝不自动跑验收，
  杜绝「QA 报告已列缺陷 → 还进验收 → 验收再打回」的浪费。

### 3. 轮次上限 + 人工兜底（`constants.ts` / `pipeline.ts`）
- `QA_REWORK_LIMIT = 2`：最多 2 轮「打回开发修复 + 复验」；配合首轮共 3 次 QA 执行，防无限循环。
- 超限 → `qaBlocked = true`：task/req 置 `needs-human`、`humanIntervention = true`、
  日志明示「超出复验上限，需人工介入」，跳过产品验收，流水线以需人工收尾。

### 4. 缺陷单幂等 + 关单（`backlog.ts`）
- `syncQaDefects`：按 `reqId + defectId` 幂等登记（多轮复验同一缺陷不重复建卡，只刷新严重级/状态）。
- `verifyReqBugs`：QA 复验通过 / 验收通过时，关闭该需求全部 open 的 P0-P2 缺陷（P3 观察项保留）。
- 验收通过分支复用 `verifyReqBugs`（原「存在未关闭缺陷 → pending-acceptance」逻辑中避免遗留僵尸 open 单）。

## 理由

- **QA 是第一质量门禁**：它的负向结论应当驱动最近的正向反馈环（开发修复），而不是被推给下一阶段的验收。
- **有界性是必须的**：无限复议 = 无限 token 烧毁 + 任务无终止；上限处转人工，让"工具化复盘"让位于"人的判断"。
- 与 ADR-0006 一脉相承：M3 门禁管"验收拦截"，本 ADR 管"QA 打回后快速自愈"，两处都不可省。

## 影响

- QA 阶段可能多次执行（最多 3 轮），token/调用数上升是**可预期成本**，换取「缺陷在 QA 内闭环」。
- `advanceTask('rework')` 现用于 QA 打回（此前仅验收 rework 用）；任务卡状态机本就含 `rework`，无需扩展。
- `parseDefects` 行为收紧：表头/观察项/非管道行不再可能被误认作缺陷。
- run 日志可见「QA 打回开发修复（第 N/N+1 轮）」「QA 复验通过（第 N 轮修复后）」等新阶段轨迹。

## 后续

- 用「持久化修复」类需求实测一条完整打回链：QA 报 P1 → 开发修复 → 复验通过 → 验收 ✅，验证闭环行为与 token 成本。
- 观察超限打回（needs-human）的人工介入路径是否顺畅（`teamflow_update`/认领后重跑）。