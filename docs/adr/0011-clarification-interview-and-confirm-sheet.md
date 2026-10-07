# ADR-0011：澄清访谈协议与 PRD 确认单（借 `interview-me` 之精华，适配本流水线）

- 状态：**已接受（Accepted，2026-10-06）**——方向＝**取其精华、适配自身，不做完整复用**；四处冲突**全部拍板**（④ 已落地，见 §落地记录；①②③ 见 §裁决）；实现前置 P1/P2 见 §前置
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

> ⚠️ **收窄（2026-10-06，拍板 ③ 时实测发现）**：上面这句只对**闸门轮数**成立，**对访谈轮数不成立**。`noteClarifyAsked` 全仓**唯一**调用点是 `host/index.ts:136`（闸门命中那一刻）⇒ `clarifyRounds` 数的是「这条需求被闸门问了几次」（通常 1 次）；而 `interview` 的多轮访谈发生在**闸门之外**（主会话纯对话，见下节 D5），**不产生 `asked`** ⇒ 宿主侧算不出访谈轮数。
> ⇒ 「不需要 `clarify-state.json`」这个结论**仍然成立**（访谈轮数压根不做 host 判据，见 §裁决 ③），但**理由换了**：不是因为「现成埋点能算轮数」，而是因为**这个数不可测、也不该由宿主判**。

## 决策：追问载体（原 D5）＝ **主会话纯对话**

| 方案 | 裁决 | 理由 |
|---|---|---|
| A. 多轮 ＝ 多次「零阶段 run」 | ❌ | 把对话塞进状态机；污染 `activeProducts` 与看板；每轮都要建/收 run |
| B. **主会话纯对话；只有「确认单」进流水线** | ✅ | 一次一问本质就是对话；**对话本身就是持久 state**（session log），不需要 TTL。⚠️ **订正（2026-10-06）**：此处原写「埋点照记（`noteClarifyAsked` 本就走这条路径）」——**错**。多轮访谈**不产生任何 `asked`**（该埋点全仓唯一调用点是 `host/index.ts:136`，闸门命中时才走）；`asked` 只在**闸门命中那一次**记一条。⇒ 访谈过程**宿主侧不可观测**，能观测的只有「首次闸门命中」与「最终有没有答复落盘（`answered`）」两端。这正是 §裁决 ③ 不给轮数做 host 判据的原因 |

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

## 裁决（2026-10-06 全部拍板，采纳作者倾向）

| # | 冲突 | 裁决与理由 |
|---|---|---|
| ① | Terminal Turn vs 自动 `resume` | ✅ **保留自动继续**。原型的「确认后立刻停手」针对**单轮对话式助手**；我们的批准语义是「放行一条**已启动**的流水线」，停手等于把一次批准拆成两次人工动作。**代价（必须明示）**：批准文案要写清「接下来会开始写代码」，别让用户以为还在讨论 |
| ② | 非交互处置 | ✅ **保留「按假设开工 ＋ 可见化」**。批量可靠交付是产品定位；headless／定时场景下「标 blocker 并停」＝ 直接交付不出来。采纳原型的**方向**（非交互不追问），不采纳其**处置** |
| ③ | 一次一问 vs 现行收敛规则 | ✅ **不改现行收敛规则；轮数上限不做 host 判据**（理由链见下）。⚠️ 2026-10-05 版本把这里写成「把收敛规则改为轮数上限／让 `interview` 走独立路径」二选一 —— 经实测，**那个二选一是伪问题**：收敛规则管不到访谈（访谈在闸门之外）。已撤回，不再作为选项 |
| ④ | **B 路径怎么收口** | ✅ 补 `teamflow_resume` 的 `supplement` 入口 ＋ 修零阶段断点 ＋ 文案收口（**已落地**，见 §落地记录） |

### ③ 的理由链（两条实测事实，非推理）

**事实 1 —「一次一问」与收敛规则不冲突。** 多轮访谈发生在**主会话**（D5 已定），`teamflow_start` 只在访谈**结束后**被调一次；启动前闸门仍是「一轮拦完、给完 blocker 就交棒」。现行收敛规则（「已给过 `requirementSupplement` 就不再拦」）的作用域是**闸门调用之间**，管不到闸门**之外**的访谈轮数 ⇒ **两者不在同一层**。要改的只是**注入文案的交付形态**（`tool.ctx.team`：「按 blockers 列出的继续问」→「**一次一问、每问带猜测**」）＋ blocker 增 `guess` 字段 —— 这两条本来就在上文「借」那一栏。

**事实 2 — 轮数在宿主侧不可测。** `noteClarifyAsked` 全仓**唯一**调用点是 `host/index.ts:136`（闸门命中那一刻）⇒ `asked` 记录的是**闸门轮数**（每条需求通常 1 次），访谈的多轮**不产生 `asked`**。⇒ host 拿不到「访谈轮数」这个真值，按仓库纪律（**真阳性/可测性不足的判据不得有阻断权**）**不给它造门禁**。

**结论**：硬终止条件（能否预测下三问 ＋ 地板 ＋ 用户可随时叫停）留在 **prompt 契约**里（`tool.ctx.team` 注入文案 ＋ `TRIAGE_PROMPT`），事后只用 `answered` / `proceeded-with-assumptions` 两端事件看收敛性。**若将来真出现「多轮仍不收敛」实例**，第一反应应是**让访谈过闸门**（每轮都产生 `asked`，轮数才可测），而不是先加一个算不出真值的上限 —— 那等于推翻 D5，属重新设计。

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
| P1 | 插件能否 `inject(['userQuestions'])`；seam 是否接受「插件代 runtime root 提问」 | ✅ **已验（2026-10-07 实机探针，见 §P1 实机验证）**：① `inject` 成功（`userQuestions`／`agents`／`tools` 全 true）；② 插件能拿到 **live root 实例**（`rootsLen: 1`、`meIsRoot: true`）；③ **`agent: undefined` ⇒ 桥第一出口放弃 ⇒ `NO_PROVIDER`**；④ **传 live root 实例 ⇒ 进入真桥转发（挂到 4013ms 超时）**；⑤ 伪造实例 ⇒ `CALLER_NOT_LIVE` |
| P2 | 「暂停」在状态机里的落点（复用 `interrupted`/`resume` vs 新状态） | ✅ **复用 `interrupted`/`resume` 基座，不新增状态**（2026-10-06 拍板）。理由：① 该状态已有三处消费——`resumeRun` 的 status 白名单、工作台终态渲染、`resumableTerminal`（据此**不归档**暂存日志，QA 复验要靠上一轮报告当回归契约）；② 「暂停等用户确认计划」与「中断等用户答复」**语义同构**：都是「因人的原因停在断点 ＋ 由同一通道回带补充输入」，而后者的 `supplement` 入口刚落地（§落地记录），正好复用；③ 新增状态要同步改四处（`STATUS` 常量 / 看板渲染 / resume 白名单 / cancel 语义），收益不明确。**具体落点**（暂停点插在 PRD 之后、如何标记「等确认中」）留实现时定 |
| P3 | ④ 若选①：`supplement` 在「断点 > PRD」时如何处置（静默无效 vs 显式拒绝） | ✅ **已裁决＝显式拒绝**（2026-10-06，已随 §落地记录 落地；静默无效正是 §7/§16 反复踩的「静默丢弃」） |

## P1 实机验证（2026-10-07）：可行，但**必须传 live root 实例**

**手法**：`dsh --profile headless --patch <overlay> "<prompt>"`（不动 web profile，命令形见 `.workbuddy/memory/MEMORY-infra.md` §G）。探针 = 一个临时插件（`inject: ['tools','userQuestions','agents']`，insert 进 headless 顶层），注册 `p1_probe` 工具，工具内跑三组调用并回传。

**探针的一处自我修正**：headless **没有**客户端桥（`api-remotes` 只属于 `dsh-web-app`）⇒ 第一版探针里 A/B **必然同码 `NO_PROVIDER`**，分不开「全局 dispatch」与「scoped dispatch」。改法：**在探针里忠实复刻桥的三条出口并打点**（逐字照抄 `dsh-api-remotes/lib/index.js:147-157`），再**补挂真 `api-remotes`** 复现一次 —— 两次结果一致。

| 形态 | 实测结果 | 桥的出口（观测到的 scope carrier） |
|---|---|---|
| `inject(['userQuestions','agents','tools'])` | ✅ 三个服务全部注入成功 | — |
| 插件取 live root 实例（`agents.roots()`） | ✅ `rootsLen: 1`、`meIsRoot: true` | — |
| **`ask({ questions, signal })`（无 agent）** | ❌ `NO_PROVIDER`，**0ms** | `carrier = <undefined>`、`reqAgent = <undefined>` ⇒ **`next()`：桥直接放弃** |
| **`ask({ questions, agent: <live root>, signal })`** | ✅ **`ASK_ABORTED` @4013ms（挂到探针超时）** | `carrier === reqAgent === session-52d4041f…` ⇒ **`FORWARD`：进入转发队列** |
| `ask({ questions, agent: {同 id 但不同实例}, signal })` | ❌ `CALLER_NOT_LIVE`，**0ms** | listener **未被调用**（校验层就拒了，waterfall 根本没进） |

**结论**：ADR 里「宿主直调 seam 弹原生审阅卡」**可行**，但**不能省 `agent`**：

- **省了**（`agent: undefined`）⇒ `ask()` 走**全局 waterfall**（`ctx.waterfall('user-questions/request', request, noAnswerer)`），dispatch 不带 scope carrier ⇒ 桥的第一条出口 `const carrierAgent = carrierKeyOf(this)` 得 `undefined` ⇒ **`return next()`** ⇒ 落到链尾 `noAnswerer` ⇒ 必然 `NO_PROVIDER`。
- **传 live root 实例** ⇒ 走 **scoped waterfall**（`scopeTarget(agent, agent)`）⇒ carrier 与 `request.agent` 是**同一个对象** ⇒ 桥通过 `agent !== carrierAgent` 断言 ⇒ **按 `agentId` 路由到该 agent 所属的客户端连接**。

⇒ 这不是**权限**问题（root 实例本来就有权限，`CALLER_NOT_LIVE`/`DELEGATED_CALLER` 都过了），是**路由**问题：**没有 carrier，桥就不知道该把这个问题发给哪个前端连接**。

**实现约束（落地前 checklist）**

1. 必须 `inject: ['userQuestions', 'agents']` 并**取真实例**；**禁止**自造 `{ id, ctx }` —— 实测 `CALLER_NOT_LIVE`（连 waterfall 都进不去）。
2. **多 root 时选谁**：`roots()` 返回**所有** root（本探针环境只有 1 个，所以没暴露这个面）。teamflow 有唯一答案源 —— `journal.ownerSession`（发起 run 的主会话）⇒ 用 `agents.get(journal.ownerSession)`，取不到再从 `roots()` 里按 `agent.session.id` 过滤。**不要** `roots()[0]`。
3. 必须带 `signal`（`ask()` 支持 `AbortSignal`）：**无客户端应答时会一直挂住**，不设超时会卡死 host。

**未验（诚实标注）**：**真客户端 UI 端到端**（本探针组合里没有 `ui-user-questions`，它只在 web/desktop）。但 B 组「挂到 4013ms」已证明请求**进入转发队列**；剩下的是「web 前端渲染审阅卡并回传答案」—— 那是**同一个客户端答案器**，且官方 `ask_user_question` 工具在生产走的就是这条链。⇒ 风险低，但**不是零**。

**顺带记录（与本 ADR 无关的既有环境问题）**：headless 下 `typert-loader` 的 `dsh-user-questions` 贡献者加载失败（包导出 `./typert`，但 `lib/typert.host.js` 不存在 —— 本机 harness 源码仓产物缺失）。未影响本次结论（`typertGateway` 正常）。**未动它**，只留痕。

## 落地记录（2026-10-07，① PRD 确认单 · 批 1）

| # | 改动 | 位置 |
|---|---|---|
| 1 | `needConfirm` 选项（**默认关**；`patch` 恒 off；只在非 resume 时停一轮） | `host/types.ts` · `host/index.ts`（工具参数） |
| 2 | PRD 之后暂停 `abortForConfirmSheet`（落点与 `abortForClarification` **同构** = `interrupted` + `humanIntervention`） | `host/core/pipeline.ts` |
| 3 | 确认单组装 + 渲染（≤40 行）：**纯函数 + 结构化数据源** | `host/core/confirm.ts`（新模块） |
| 4 | 目标一句话的来源补齐：PRD state 块的 `extra.summary` 落 `state.product.summary`（此前**只要求、不落盘**） | `host/core/domain/state.ts` |
| 5 | 确认单落盘（`JournalRecord.confirmSheet` ＋ `serializeJournal`） | `store.ts` |
| 6 | 完成汇报带确认单 ＋「调 `teamflow_resume` 即继续」 | `host/core/report.ts` · `host/locales/pipeline.ts` |

**为什么数据一律走结构化来源、不抽 PRD 正文**：PRD 的小节标题是**模型自由写的**，正则去抽「目标」段必然时灵时不灵 —— 本仓已因此失手过一次（`## 9. 假设与待澄清` 让内联正则误报「契约未兑现」，实锤 `tf-mu34afd2-wcjaw1`）。⇒ 目标一句话 = PRD state 块的 `extra.summary`；AC = `state.acIndex`；假设 = `journal.assumptions`（按段解析）。

**为什么默认关**：「该不该自动打断」需要一个判据，而按本仓纪律**新增判据前要先量真阳性率** —— 历史 0 样本。机制先落地，判据后补（再评估信号 1）。

**门禁**：`orchestration` 第 ⑳ 组 12 条行为断言 ＋ `smoke` 5 条源码锁。
**变异 M5**（拿掉 `return abortForConfirmSheet`）⇒ smoke 恰 1 红 ＋ 编排恰 4 红，症状实测显示「后续阶段照常跑了」，对照断言（缺省直通 / patch 不暂停 / 纯函数）**全绿**。


**批 1.5（2026-10-07 后续）：审批面做成「可插拔的择路骨架」，默认不接原生 seam。**
- `confirm.ts` 增 `confirmHook` / `setConfirmHook`（回调单例，仿 `installCtx` 搬运手法 —— pipeline 是模块级纯编排、拿不到 ctx）；`liveRootFor(agents, ownerSession)` 负责挑 live root（**多 root 且 ownerSession 匹配不上 ⇒ 返回 null 回落，不猜**）。
- 调用点：PRD 后先试已登记的批准能力；**未登记 / 返回空 / 抛错 ⇒ 一律回落**到「停在 interrupted + 汇报交主线程」。
- **为什么默认不登记原生 seam**（关键取舍）：① ① 的裁决＝「保留自动 resume」⇒ **批准 = `resume`** ⇒ 原生审批卡**不是功能必需**，只是「体验更顺」；② **P1 未验到客户端 UI**（只验到「请求进入转发队列」）；③ **`ask()` 带 carrier 且无客户端应答时会一直挂住**（实测 4013ms 超时）⇒ 放进生产路径＝常态化「流水线卡死」风险。**端到端验证前不接。**
- 已知客户端行为（源码核实，`dsh-client-ui-user-questions/lib/client.js:877`）：`pending.kind === "plan-review"` 有**独立优先级分支** ⇒ 真接上后原生审阅卡确实会优先呈现。

**未做（明确记）**：① **改计划后重跑 PRD**（`redoFrom`）—— 断点已 > PRD，`supplement` 会被 P3 裁决拒绝 ⇒ 改计划只能起新需求（拒绝文案已写明）；② 轮次上限（归 `interview` 档，见 §裁决 ③）；③ 审批面的原生 seam（批 2，见 §P1 实机验证）。

## 落地记录（2026-10-07，③ 澄清强度 · 批 3b）

| # | 改动 | 位置 |
|---|---|---|
| 1 | `ClarifyStrength` 类型（`off`/`once`/`interview`）＋ `util.normalizeClarifyStrength` 纯函数 | `host/types.ts` · `host/util.ts` |
| 2 | `clarifyStrength` 进 `PipelineOptions` ＋ `teamflow_start` 参数 ＋ 落 `journal.options` | `host/types.ts` · `host/index.ts` |
| 3 | 注入接线：`teamflowContextText` 按强度**追加** addendum（`once` 原样返回 base）；强度由 `clarifyStrengthForTeam` 从 run 快照反查 | `host/index.ts` |
| 4 | 两档 addendum 文案（zh/en）：`off`＝直接开工不追问；`interview`＝一次一问 ＋ 每问带倾向 ＋ **硬终止三条件** | `host/locales/tools.ts` |

### 一条**设计偏离**（已在 `types.ts` 注释与本节留痕）

ADR-0011 TODO ③ 原措辞是「澄清强度进 `MODE_REGISTRY` 作为新维度」。**实现改为独立字段 `clarifyStrength`，不进 MODE_REGISTRY**：
`PipelineMode`（`full`/`medium`/`lite`/`tech`/`patch`）是**流水线档位**，决定阶段集 / PRD 形态 / 架构护栏，
`resolveStages` / `MODE_RANK` / `guardrailUpgrade` 三处都按它分派；把「追问几次」塞进去会让同一张表
承担两件正交的事，并让 `interview` 变成一个**没有对应阶段集**的伪档位。

### 零回归保证（构造性的，不是靠测试兜）

`tool.ctx.team`（现行澄清引导段落）**逐字未改**；`once`（缺省）时 `teamflowContextText` **原样返回 base、一字不追加**，
只有 `off` / `interview` 才在其后**追加**一段（不重排、不删改）⇒ 存量注入按构造零回归，
并由 smoke 源码锁钉住（断言 once 分支存在）。

### 门禁与变异

- `triage-gate` **+9 条行为断言**（缺省 once / 显式 off·interview / 非法值回落 once / trim / null·undefined），
  其中 **`patch` 恒off 且优先于显式 `interview`** 是契约（策略档矩阵）。
- `smoke` **+6 条源码锁**（参数暴露 / 纯函数存在 / **判定顺序** / once 零回归 / 反查接线 / addendum 文案）。
- **变异 M7**（把 `patch` 检查挪到 `interview` 之后）⇒ `triage-gate` 恰 1 条红；**但 smoke 那条锁全绿**
  ⇒ 又一次**源码锁假绿**：它只匹配「patch 那行存在」，没锁**顺序**。已改成跨三行的顺序锁
  （`patch → interview → off` 三段必须按序出现），改后复跑变异 ⇒ 恰好那条红、还原后全绿。

### 已知缺口（明确记下）

`clarifyStrengthForTeam` 从**内存** `runs` 反查 ⇒ **重启后回落 `once`**。消除它应把强度落进 `teams.json`
或 `state.json`（跨重启），而不是给内存缓存打补丁。**未做**。


### 批 1.5 补齐（2026-10-07 傍晚，用户问「还有剩余项不」时查出）

两处**我自己拍板/陈述却漏实现**的东西：

1. **① 的代价条款漏了**——§裁决 ① 明写「批准文案要写清『接下来会开始写代码』」，但 `run.needsConfirm` / `report.confirmSheet` 都没有这句 ⇒ 已补（zh/en 两份，且 `report.confirmSheet` 是主线程真正看到的那条）。
2. **`openQuestions` 是「只要求、不落盘」**——`prdPrompt` 早已要求 PRD state 块的 `extra.openQuestions`（`prompts/index.ts:454`，且有 `prompt-contract.test.js` 的 L1 门禁锁住），但 `mergeStateBlock` **从未消费**它、`TeamflowState` 里也没这个字段 ⇒ 确认单只能退回**文本抽取**（`journal.assumptions` 的行）。已补：`TeamflowState.openQuestions` ＋ `normalizeOpenQuestions` 容错归一（模型形状不稳定：别名 `question` / 缺字段 / 非对象 / 超长，一律不抛）＋ `mergeStateBlock` 消费（**整组替换**——PRD 是本次 run 的权威，累加会让上一轮的遗留问题一直挂在确认单上）＋ 确认单接结构化（与 `assumptions` **语义不同、同时呈现**：那是「要你决定」，这是「我已经替你定了」）。

**⚠️ 记一条认知错误**：我先前两次把 `openQuestions` / 「非目标段」说成「未做」，是**把自己的工作范围当成了全仓现状** —— `openQuestions` 在 8 个文件里早有命中（含 L1 门禁）。**报「未做」前必须 grep 全仓关键词。**

**门禁**：`state` 的动态往返夹具自动覆盖了新字段（我加字段没同步夹具时它立刻红，是它该做的）＋ `state` **+14 条容错/替换行为断言** ＋ `smoke` **+7 条源码锁**。
**变异 M8**（给 `openQuestions` 的消费加 `false &&` 前缀）⇒ `state` 恰 1 条红；**但源码锁全绿** ⇒ **源码锁假绿（本日第三次，同根因）**：只锁赋值语句时，条件被否掉仍能匹配。已改成从**判定条件起锚**的整句匹配，改后复跑变异 ⇒ 同红。

### ⚠️ 批 1.6（2026-10-07 傍晚）：**确认单与澄清强度在真实路径下根本不生效**（P0）

用户问「下一步是流水线验证还是还有要修的」时去核，发现两个新功能**都是死的**：

**根因**：`startPipeline` 里 `journal.options` 是**白名单字面量**，而
`execOptions = Object.assign({}, journal.options, {…具名内部字段…})` ⇒ **白名单漏一个字段，`executePipeline` 就永远收不到它**。
`needConfirm` 与 `clarifyStrength` 都漏在这里 ⇒
- `options.needConfirm === true` **永远不成立** ⇒ 确认单**从不暂停**；
- `clarifyStrengthForTeam` 读 `journal.options.clarifyStrength` 也读不到 ⇒ **永远回落 `once`**。

**为什么全套测试没抓到**：`test/orchestration.test.js` 的 `runScenario` 是**直调 `executePipeline`**、
把 options 原样传进去 ⇒ **绕过 `startPipeline` 的白名单**。既有那条 execOptions 门禁只检查**硬编码的
内部字段清单**，覆盖不到「`PipelineOptions` 接口新增了什么」。⇒ 又一个 §14「全绿而功能坏着」实例。

**修**：两个字段进 `journal.options` 白名单（白名单带上后 `execOptions` 自动继承；`clarifyStrengthForTeam`
的反查也同时通）。

**门禁（结构性，防复发）**：`smoke` 新增 —— 解析 `host/types.ts` 的 **`PipelineOptions` 接口键**，
断言每个键**要么在 `journal.options` 白名单、要么在 `execOptions` 的具名补充段**（同 `state.test.js`
对 `TeamflowState` 的做法）。**变异 M9**（摘掉 `clarifyStrength`）⇒ 该条 + 「两个实锤字段已进白名单」
共 2 条红，并**点名** `漏了：clarifyStrength`。

**踩坑留痕**：门禁第一版被**插进了一个 `for` 循环体**里 ⇒ 同一断言跑 6 次、报 6 条重复；且第一版正则
用 `\b${k}\s*:` ⇒ 匹配不到白名单里的**简写属性** `mode,`（误报 `漏了：mode`）。两处都已修
（重插到顶层 ＋ 正则改 `(^|[^A-Za-z0-9_$])${k}\s*[:,]`）。

## 影响

- `docs/TODO.md` 的「澄清闸门」条按本文收敛（Phase 2 与强度档合并设计）。
- 触及交付面：`host/index.ts`（`clarificationPreflight`、`teamflow_resume` 参数与 schema）、`host/core/triage.ts`（`qualifyBlockers` / verdict 字段）、`host/prompts/index.ts`（`TRIAGE_PROMPT` ＋ 注入块）、`host/core/clarify-log.ts`（记录 `guess` / `confidence`）、`host/core/pipeline.ts`（确认单暂停；④ 则另加 `interruptedPhaseOf` 零阶段断点 ＋ `resumeRun` 签名）、`host/locales/pipeline.ts`（`run.needsClarification` 收口措辞）。
- 判据层**只增不改**；动手时 `prompt-contract` ＋ `conformance` ＋ `locale` 三套门禁都要过；改 `pipeline.ts` 另跑 `test/orchestration.test.js`。

## 再评估的触发信号

1. 埋点样本攒到足量后，看 blockers 合格率 / 用户答复率 / 答复是否真改了范围；
2. 出现真实的「多轮仍不收敛」实例 ⇒ 停止判据要收紧；
3. ~~P1 验伪 ⇒ 确认单退回「状态回传 → 主线程问」~~ —— **P1 已于 2026-10-07 验真**（`inject` 成功 · live root 实例可拿 · 传实例能进桥转发）⇒「原生审阅卡」这条审批面**可行**，唯一被证伪的是「省 `agent`」这一形态。**触发条件改写**：**web 端到端若失败**（真客户端不渲染审阅卡 / 不回传答案）⇒ 退回既有的「返回 status → 主线程 `ask_user_question`」通道；
4. 出现**第一个真实的 B 路径实例**（日志含「未进入任何阶段」/ `status=interrupted`）⇒ ④ 已按①落地（2026-10-06），届时需**验证补录真被 PRD 消费**（看 journal 里 `requirementSupplement` 与 PRD 的 `[CLARIFIED]` 段），而不是只看到「续跑成功」。
