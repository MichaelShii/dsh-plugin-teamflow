# ADR-0011：澄清访谈协议与 PRD 确认单（借 `interview-me` 之精华，适配本流水线）

- 状态：**草案（Proposed）**——方向已定（**取其精华、适配自身，不做完整复用**）；四处冲突，**其 ④ 已拍板并落地（2026-10-06，见 §落地记录）**；①②③ 仍待拍板，未拍板不进实现
- 日期：2026-10-05
- 关联：ADR-0010（澄清的可观测性与失效路径；本文是它「§影响」所指「Phase 2 与 D3/D4 应合并」的落地设计）、ADR-0005（需求无效）、ADR-0004（分诊与共享状态）、`docs/anchors/clarification-gate.md`（Phase 1 详情 ＋「子代理不能问用户」的实机确证）、`host/core/clarify-log.ts`（埋点）、`host/index.ts`（`clarificationPreflight`）

## 背景

ADR-0010 定下顺序「① 埋点 → ② 修失效 → ③ 再谈策略」，并要求 **Phase 2 的 PRD 确认单与它的 D3/D4（澄清强度档）是同一件事的两个侧面，不应各做一套**。①② 已落地（① `host/core/clarify-log.ts` 四事件埋点；② 分诊退兜底时的闸门失效可见化）。本文处理 ③。

**输入**：一份社区原型 skill `interview-me`（多轮意图抽取协议；用户提供，原文在本仓之外，本文按要点转述、不内联全文）。它针对同一个病根——**agent 替用户做的判断静默变成 spec**——但走的是另一条路：**多轮、一次一问的访谈**。

## 原型要点（我们的转述）

| # | 机制 | 一句话 |
|---|---|---|
| 1 | **HYPOTHESIS ＋ CONFIDENCE** | 先写下「我理解你想要什么」的一句话 ＋ 一个 0–100% 信心数；<70% 必须附**一句原因**（还缺什么） |
| 2 | **一次一问、每问带 GUESS** | 每问附「我猜你会答 X，因为…」，等用户反应再问下一个。理由：**反应比从零生成快**，且把自己的假设摆上台面 |
| 3 | **「想要 vs 应该想要」探针** | 听到 best-practice / 惯例 / buzzword 时改问：「若无需向任何人交代，你真正想要什么？」 |
| 4 | **restate 6 行** | Outcome / User / Why now / Success / Constraint / **Out of scope**（末行**不可省**：一半错位来自对「不做什么」的沉默分歧） |
| 5 | **显式 yes 才算确认** | "whatever you think" / "sounds good" / 沉默**都不算**；含糊回答要 reframe 成二选一再问 |
| 6 | **Terminal Turn ＆ Stop** | 拿到 yes 后**立刻停手**，不得在同一轮调工具或开下游 |
| 7 | **停止判据 ＋ 地板** | 判据＝「能否预测用户对下三个问题的反应」；**地板**＝几轮仍预测不了 ⇒ 有更根本的东西缺失，退一步问用户 |
| 8 | **非交互场景禁用** | CI / 定时 / 自主循环**不得调用**，应把「需求不明确」标为 blocker |

## 决策：取其精华、适配自身

逐条裁决「借 / 改造 / 不借」：

| 原型机制 | 裁决 | 适配后的形态 |
|---|---|---|
| 1 HYPOTHESIS ＋ CONFIDENCE | **借（改造）** | 澄清裁决在现有 `intent` ＋ `blockers[]` 之外，**增一句话假设 ＋ 0–100% 信心数（<70% 附原因）**；它同时是「给用户的信息」与「停止判据的锚」 |
| 2 一次一问 ＋ GUESS | **借** | 闸门 blocker **增 `guess` 字段**（「我猜你会答 X，因为…」）；注入文案从「列问题」改为「**一次一问、每问带猜测**」 |
| 3 「想要 vs 应该想要」探针 | **借** | 加进主会话的澄清指引（一句 prompt） |
| 4 restate 6 行 ＋ Out of scope | **借（改造）** | 在现有 `openQuestions` 之外，PRD 必填段**增「非目标 / Out of scope」一行**；确认单的交付摘要与之同构 |
| 5 显式 yes | **借** | 确认单的「批准」必须来自**显式动作**（按钮或明文 yes）；含糊回答回流成「二选一」再问 |
| 6 Terminal Turn ＆ Stop | ⚠️ **不借（冲突 ①）** | 我们是一条**已启动的流水线**，批准 ＝ 放行继续。保留自动 `resume`，但**必须明示**「接下来会开始写代码」 |
| 7 停止判据 ＋ 地板 | **借** | `interview` 档的硬终止（ADR-0010 D4）直接采用该判据：「能预测下三问」＋ 地板；**轮数上限**复用现有埋点（见下） |
| 8 非交互禁用 | 🟡 **部分借（冲突 ②）** | 方向一致（非交互不追问），**处置不同**：原型主张「标 blocker 并停」，我们主张「按假设开工 ＋ 汇报高亮」（批量可靠交付是产品定位）⇒ **保留我方处置**，原型那条限定在桌面场景 |

## ✅ 本 ADR 得出的一个简化（推翻此前待办）

ADR-0010 / TODO 此前写「多轮追问需要一个跨调用状态（`clarify-state.json` ＋ 轮次上限 ＋ TTL）」。**不需要**：`host/core/clarify-log.ts` 的 `clarifyRounds(product, requirement)`（＝同 `fp` 的 `asked` 计数）**现在就能算轮数**——事件流本身就是那个跨调用状态，且 append-only、无需新文件。

## 决策：追问载体（原 D5）＝ **主会话纯对话**

| 方案 | 裁决 | 理由 |
|---|---|---|
| A. 多轮 ＝ 多次「零阶段 run」 | ❌ | 把对话塞进状态机；污染 `activeProducts` 与看板；每轮都要建/收 run |
| B. **主会话纯对话；只有「确认单」进流水线** | ✅ | 一次一问本质就是对话；**对话本身就是持久 state**（session log），不需要 TTL；埋点照记（`noteClarifyAsked` 本就走这条路径） |

## B 路径（pipeline 侧兜底）的现状：断点定位缺陷 ＋ 无 supplement 通道（2026-10-05 实测）

全表引用的数据源＝`$DSH_HOME/teamflow/**` 全量 95 个 journal（脚本按目录遍历解析，非抽样）。

### 双路结构性差异

| | A 路（tool 侧预检） | B 路（pipeline 侧兜底） |
|---|---|---|
| 触发 | `clarificationPreflight` 判 `needs-clarification` | 预检漏过/失败后，pipeline 权威分诊仍判需澄清（`abortForClarification`，`pipeline.ts:230`） |
| run | **不建 run** | 建 run：**零阶段** ＋ `status=interrupted` ＋ `humanIntervention`（`pipeline.ts:237-238`） |
| 回带通道 | 带 `requirementSupplement` **重调 `teamflow_start`** ⇒ 新 run（`host/index.ts:228`） | ❌ **无通道**：`teamflow_resume` 只收 `runId`（`host/index.ts:657-670`） |
| 历史实锤 | 5 例（`journal.requirementSupplement` 非空）；`clarify.jsonl` 有 `asked/answered` 各 1 | **0 例** |

### 历史分布（95 run）

| 指标 | 值 |
|---|---|
| `status` | completed 70 / failed 13 / cancelled 12 / **interrupted 0** |
| `stages.length` 最小值 | **1** ⇒ **零阶段 run 从未出现过** |
| 日志含「未进入任何阶段」 | **0 例** ⇒ B 路径从未触发 |
| 断点续跑（含「跳过已完成阶段」日志） | **25 个 run**（合计 40 次续跑）⇒ resume 本身是真路径 |
| 续跑末次断点分布 | PRD **1** ／ 设计 1 ／ 架构 2 ／ 技术方案 1(+1) ／ 开发 7(+1) ／ QA 5(+1) ／ 验收 5 |

⇒ **断点落在 PRD 的只占 1/25**：把 `supplement` 定义为「只在断点 ≤ PRD 时生效」的话，历史适用面是 4%。

### 实机探针：零阶段的断点不是 PRD，而是「验收」

手法同 `test/orchestration.test.js`（先冻 `DSH_HOME`，再按路径 `import host/core/pipeline.ts`，直调导出的 `interruptedPhaseOf`）：

```
① 零阶段（澄清闸门中断）→ 断点 = "acceptance"
② 零阶段 + 已带 supplement → 断点 = "acceptance"   ← 断点判定根本不看 supplement
③ 仅 prd done            → 断点 = "acceptance"
```

`interruptedPhaseOf` 的出口只有一个：`PHASE_ORDER` 全部「有 stage 且都 done」⇒ `continue` 走完循环 ⇒ `return 'acceptance'`（`pipeline.ts:271`）。**「什么都没做」与「什么都做完了」共用这一个出口。**

而跳过判定是 `resumed(phase)` ＝ `PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(resume.phase)`（`pipeline.ts:497`）⇒ `resume.phase = 'acceptance'` 时 **prd/design/scaffold/tech/dev/qa 全部进「复用存档产物」分支**；零阶段的 `buildResumeProducts` 返回 `{}`（`pipeline.ts:58-73`）⇒ 各阶段产物全为 `undefined`（**PRD 为空**）⇒ 只剩**没有 `resumed` 门控、也不做 `prd` 空值保护**的验收阶段照常开跑（`host/core/stages/acceptance.ts:21`）。

**净效果：今天续跑一个澄清中断的 run，不是「带着用户答复重走 PRD」，而是「跳过需求澄清／技术方案／开发／QA，直接拿空 PRD 跑产品验收」。** 属于**跑错**，不只是**拿不回答复**——补 `supplement` 入口若不连断点一起修，参数会被静默吞掉（PRD 根本不执行）。

### 顺带暴露的文案与实现不一致

`pipeline.ts:224` 注释与 `run.needsClarification` 文案（`host/locales/pipeline.ts:307`／`:710`）都写「用户答完带 `requirementSupplement` **重新启动**」——但这条路径上 **run 已经建了**，重开＝留下一个永不收敛的僵尸 run（且它现在还是 0 例，所以没人发现）。

## 待拍板（四处冲突，未定不进实现）

| # | 冲突 | 选项 |
|---|---|---|
| ① | Terminal Turn vs 自动 `resume` | 保留自动继续（我的倾向，需向用户明示）／改为「批准即停手，由用户手动续跑」 |
| ② | 非交互处置 | 保留「按假设开工 ＋ 可见化」（我的倾向）／改为原型主张的「标 blocker 并停」 |
| ③ | 一次一问 vs 现行收敛规则 | 把收敛规则改为**轮数上限**（复用 `clarifyRounds`）／让 `interview` 走独立路径 |
| ④ | **B 路径怎么收口** | ① 补 `teamflow_resume` 的 `supplement` 入口**并同时修零阶段断点**（我的倾向：只补入口＝死代码）／② 只修断点，`supplement` 仍走「重开新 run」／③ 维持现状（B 保持 0 例，只当理论兜底）<br>**⇒ ✅ 2026-10-06 拍板选 ①，已落地**（见 §落地记录） |

## 落地记录（2026-10-06，④ 选 ①）

三件事**必须一起做**——只做第 2 件（加参数）＝死代码：断点仍是 `acceptance` ⇒ PRD 根本不执行 ⇒ 参数被静默吞掉。

| # | 改动 | 位置 |
|---|---|---|
| 1 | **零阶段 run 的断点 → `'prd'`**（原为唯一循环出口 `'acceptance'` ⇒ 「什么都没做」与「什么都做完了」共用同一出口 ⇒ 续跑跳过整条流水线、拿空 PRD 跑验收） | `pipeline.ts` · `interruptedPhaseOf` |
| 2 | **`resumeRun(runId, sessionId, supplement?)`**：断点 > PRD 时**显式拒绝**（`run.supplementTooLate`）；否则写回 `journal.requirementSupplement` ＋ 记 `answered` 埋点 ＋ `run.supplementApplied` | `pipeline.ts` · `resumeRun` |
| 3 | **`teamflow_resume` 暴露 `supplement` 参数**（parameters ＋ description） | `host/index.ts` |
| 4 | **`run.needsClarification` 文案收口**：指向「用 `teamflow_resume` 续跑本 run」而非「重新启动」（旧文案与实现不一致——这条路上 run 已建，重开＝留下一个永不收敛的僵尸 run） | `host/locales/pipeline.ts` |
| 5 | **`executePipeline` 的赋值与埋点各加 `!resume`**：否则续跑会把补录的答复清成 null（它收到的是 `journal.options` 白名单字面量，本就不含该键 —— 同型第四次） | `pipeline.ts` |

**前置 P3 裁决**：选「**显式拒绝**」而非「静默无效」。理由同 §7／§16——静默丢弃是本仓反复踩的坑；拒绝文案同时给出替代路径（起新需求 / 不带 supplement 直接续跑），用户不会卡住。

**门禁**：`test/smoke.js` ＋6 条源码锁（零阶段断点 / 参数贯通 / 拒绝条件 / 文案齐备 / 不覆盖 / 跳过由 `resume.phase` 驱动）；`test/orchestration.test.js` ＋第 ⑩ ⑪ 组共 8 条**行为**断言（零阶段 → 断点 `prd`；**零阶段续跑后 PRD 真起子代理**；对照「断点 = `acceptance` ⇒ PRD 被跳过」；断点晚于 PRD ⇒ 拒绝补录；零阶段 ⇒ 过校验）。

**实测状态（勿误读为「修了已发生的故障」）**：截至本日 B 路径仍 **0 例**，25 例续跑里断点落在 PRD 的只有 1 例 ⇒ 本次修的是**分支覆盖**（零阶段 run 是我们自己设计出来的状态），不是已发生的故障。触发信号见文末第 4 条。

## 前置（决定方案的事实；未验先定＝猜）

| # | 事项 | 状态 |
|---|---|---|
| P1 | 插件能否 `inject(['userQuestions'])`；web 客户端答案器是否接受**无 agent 作用域**的请求 | 🟡 宿主面**已确认**（`user-questions` 在 web 组合**顶层**，不同于被 `isolate` 在 agent 组内的 `workflowEngine`）；客户端侧**未验** |
| P2 | 「暂停」在状态机里的落点（复用 `interrupted`/`resume` vs 新状态） | ❓ 需定 |
| P3 | ④ 若选①：`supplement` 在「断点 > PRD」时如何处置（静默无效 vs 显式拒绝） | ❓ 需定——静默无效正是 §7/§16 反复踩的「静默丢弃」；倾向**显式拒绝** |

## 影响

- `docs/TODO.md` 的「澄清闸门」条按本文收敛（Phase 2 与强度档合并设计）。
- 触及交付面：`host/index.ts`（`clarificationPreflight`、`teamflow_resume` 参数与 schema）、`host/core/triage.ts`（`qualifyBlockers` / verdict 字段）、`host/prompts/index.ts`（`TRIAGE_PROMPT` ＋ 注入块）、`host/core/clarify-log.ts`（记录 `guess` / `confidence`）、`host/core/pipeline.ts`（确认单暂停；④ 则另加 `interruptedPhaseOf` 零阶段断点 ＋ `resumeRun` 签名）、`host/locales/pipeline.ts`（`run.needsClarification` 收口措辞）。
- 判据层**只增不改**；动手时 `prompt-contract` ＋ `conformance` ＋ `locale` 三套门禁都要过；改 `pipeline.ts` 另跑 `test/orchestration.test.js`。

## 再评估的触发信号

1. 埋点样本攒到足量后，看 blockers 合格率 / 用户答复率 / 答复是否真改了范围；
2. 出现真实的「多轮仍不收敛」实例 ⇒ 停止判据要收紧；
3. P1 验伪 ⇒ 确认单退回「状态回传 → 主线程问」；
4. 出现**第一个真实的 B 路径实例**（日志含「未进入任何阶段」/ `status=interrupted`）⇒ ④ 已按①落地（2026-10-06），届时需**验证补录真被 PRD 消费**（看 journal 里 `requirementSupplement` 与 PRD 的 `[CLARIFIED]` 段），而不是只看到「续跑成功」。
