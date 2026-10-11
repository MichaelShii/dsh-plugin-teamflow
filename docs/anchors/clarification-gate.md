# 锚点详情：需求澄清闸门（Phase 1，2026-09-16）

> 本文件是 `AGENTS.md` §5 中「需求澄清闸门（Phase 1，2026-09-16）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

**启动前**：`teamflow_start` 在分支决策之前跑 `clarificationPreflight`（**复用分诊那一次模型调用**，不额外花钱）：`runTriage` 新增 `intent`（requirement/exploration/feedback）+ `blockers[]`；**合格线由 host 判**（`qualifyBlockers`：① ≥2 个互斥读法 ② 改变哪个产物/AC/范围 ③ 猜错返工什么——三项缺一即丢并记 `log.triageBlockersDropped`，上限 3 条；**④ 自洽门禁（2026-09-18 probe-v2 实锤，勿回退）**：blocker 带机器可读字段 `settles`（`installable|artifact|host|scope|ui|data|other` = 这条问出来是为了定哪个裁决字段），**同一次裁决已明确判过 `installable: true` 时，`settles='installable'` 的条目与之自相矛盾 → 丢弃并计数**（同型扩展：**已判定 `host !== 'unknown'` 时 `settles='host'` 同样丢弃**）——实锤：需求原文结尾写着「装进我的 dsh web profile 里真实可用」、分诊自己也已输出 `installable: true`，却仍抛出「要不要真能装」的 blocker（prompt 里 `Do not ask it when the requirement already states the form` 就在同一份 prompt 里）→ 凭空一轮澄清（问了用户 3 个问题）→ 输入变了 → 缓存键必不同 → **同一需求被分诊两次**；**禁止**退化成「解析问句关键词」（拿文本长相当判据已同型踩过两次）。只按 `true` 判：`false` 是「模型没给该字段」的默认值，既可能「不需要装」也可能「还不知道」——后者是 must-ask 缺口的合法形态，丢了会重演 dddd「插件装不进 profile」），命中 `intent !== 'requirement' || blockers.length > 0` → 返回 `needs-clarification`，**不建 run**（实锤社区讨论 deepseek-ai/deepseek-harness#6405：「我想开发一个 dsh 插件」直接跑完整条流水线），主线程在对话里问清后**把答复放进 `requirementSupplement` 重调**（原始 requirement 保持逐字不变，是可审计的「用户原话」）。**豁免范围（2026-09-16 收紧，勿回退）**：**只有 `patch` 档豁免**——显式 `lite`/`mode` 一律跑分诊。原因：实测模型**系统性**自选档位（33 次启动 14 次显式传入、0 次先 `teamflow_triage` 预览；根因是旧 `lite` 描述里的 "(recommended)" 被逐字引用）→ 若继续豁免，闸门与架构护栏会在 **42% 的启动**上静默失效。分诊裁决同时用于**架构护栏强升**（`guardrailUpgrade(explicit, lite, triaged, { needDesign })`：调用方选轻档位而分诊判 ≥medium → 升档 + `log.modeUpgraded`；调用方已选 medium/full 则保持，不放大 token；**另有 `needDesign` 档位下限（2026-09-18 probe-v2 实锤，勿回退）**：调用方**没给档位**却显式传了 `needDesign=true`（= 明确要求设计阶段）而分诊回 `lite`/`patch`/`tech` → **宿主抬到 `medium`**——`lite` 的档位定义就是「no UI design」，两者语义冲突，而 prompt 里那句 `needDesign=true → 强升 medium` 只是 regex **预筛提示**（实测被模型无视）；调用方**显式给了** `mode`/`lite` 时仍以调用方为准，设计阶段由 `resolveStages` 按 flag 追加，不吞显式请求）。**参数描述口径**：`lite`/`mode`/工具描述统一写「默认不要自己选档位，省略它们交给自动分诊」——**禁止再出现 "(recommended)" 之类的推荐措辞**（smoke 有闸）。② 分诊不可用/超时 → `fallbackVerdict` 给 `intent='requirement'` + 空 blockers → **放行**（绝不因分诊失效拦启动）。裁决经 `options.__triage` 透传 pipeline（`normalizeTriagePassthrough` 只收形状正确的对象，坏掉则回退内部再跑）→ `journal.triage` 落盘 = **Phase 2 定闸门强度的 shadow 埋点**。**假设可见化（同批）**：`prdPrompt` 增**必填**「假设与待澄清」段（`doc.assumptionsQ`）并镜像 state 块 `openQuestions`，tech 变更单 / patch 确认单各加一句；PRD 收口 `notePrdAssumptions` 摘段 → `journal.assumptions`（**缺段记 warn 不硬失败**，policy 级），完成汇报用 `report.assumptions` 显式回带「本次基于以下假设启动」。门禁：`test/triage-gate.test.js`（49 断言：意图归一 / 合格线真值表 / **自洽门禁与 needDesign 下限真值表** / 兜底绝不拦 / 缓存与待决策状态机）+ `test/smoke.js` 23 条 + L1 四条契约（TRIAGE-INTENT-BLOCKERS（**五字段含 `settles`**） / PRD-ASSUMPTIONS-SECTION ×zh·en / TECH-PATCH-ASSUMPTIONS）。**选团队注入必须闭环**（同日实测补充，勿删）：实测会话 `session-518e9188`（工作区 `plugins\test`）里注入已下发、用户说「我想开发一个 dsh 插件」，**模型 0 次调用 `teamflow_start`**（runs=0）——第一道「模型自觉」生效、第二道闸门没机会跑，而旧注入只写「不明确就别调用」、没写「澄清完要回来开工」→ 三段必须都在 `tool.ctx.team` 里（zh/en 同形）：**澄清前置**（给 2–4 个方向候选、只问 must-know）/ **澄清后务必调用 `teamflow_start`**（原话进 `requirement`、澄清结论进 `requirementSupplement`）/ **`needs-clarification` 处理**（按 blockers 问 → 带 supplement 重调，禁止替用户假设）；smoke 三条守门（注入文案属 prompt 面，改它要连 L1 一起跑）。**权威判定在 pipeline，不在工具内预检**（2026-09-16 实测 `tf-mu35oza7-wmuckz`，勿回退）：预检在**工具调用内**跑，模型分诊一旦在此失败会**静默退正则兜底**（那次 0.4s 返回 `source=fallback`，根因是漏传 `exec.signal`）→ 因此：① 预检必须传工具 signal，失败原因写 `__triageError`；② pipeline 对「没有透传裁决」的启动**除 `patch` 外一律自己再跑一次分诊**（含显式 `lite`/`mode`），并在此处做**架构护栏强升**与**闸门兜底**：`verdict.intent !== 'requirement' || blockers.length > 0` → `abortForClarification`（`status=interrupted` + `humanIntervention`，**不建任何阶段**，日志给 `log.clarifyAbort`/`log.clarifyBlocker`，汇报带 `run.needsClarification`）——只有 tool 侧快路径没拦住时才会走这条（代价是一个零阶段 run，远小于静默开跑）。**闸门必须收敛**（2026-09-16 `dddd` 实测，勿回退）：① 分诊输入**必须带 `requirementSupplement`**（`[CLARIFIED]` 块、并写明 "do NOT re-ask"）——否则分诊只看到那句原话，用户已逐项答复也照问不误（实测 6 轮追问、零 run）；② **收敛规则**：调用方**没给过** `requirementSupplement` 时才拦；已给过（说明用户已澄清一轮）→ **不再拦**，残余 blocker 当作假设开工并记 warn `log.clarifyProceedWithAssumptions`（假设进 PRD「假设与待澄清」段 + 汇报高亮 `report.assumptions`）。tool 侧与 pipeline 侧**同规则**。**续跑不重跑分诊**（2026-09-17 `dddd` 续跑实测）：档位在首次启动已定稿，`} else if (resume) {` 分支直接沿用 `journal.options.mode`，只在 `journal.triage` 缺失时补一条 `source: 'resume'` 的 shadow 记录并记 `log.triageResumed`——续跑重跑分诊会白花一次模型调用、并可能让档位在续跑路径上漂移（护栏强升不得二次触发）。

---

## 补记（2026-10-05）：实机确证「子代理不能问用户」（`DELEGATED_CALLER`）

上文的「澄清只能由 host 发起、落主线程」此前是**源码推断**；现已用实机探针确证。

**判据链（四层，逐层 file:line）**

1. **闸门本体** `dsh-user-questions/lib/index.js:52-60`：`ask_user_question` 要求呼叫方 `agents.get(id) === agent`（否则 `CALLER_NOT_LIVE`）**且** `agents.roots().includes(agent)`（否则 `DELEGATED_CALLER`）；该检查在 answerer waterfall **之前**，所以即便没有 answerer 也先命中它。
2. **root 的定义** `dsh-agent/lib/index.js:621-623`：`roots()` = `entries.filter(e => e.owner === void 0)` —— 判的是**创建时的 owner 作用域**，注释原文「durable session lineage does not affect this runtime relation」。
3. **owner 从哪来** `dsh-agent-loop/lib/index.js:1852（create）/ 1955（resume）`：两条路径都传 `options.parentAgent`，**无它即 root**；而 `dsh-subagent/lib/index.js:1078/1084` 委派时明确传 `parentAgent: parent` ⇒ **子代理必然是 owned**。
4. **UI 打开子会话 ≠ 升 root**：`dsh-client-ui-workspace/lib/types/client/navigation.js:88 → :256` → `sessions.retain(target, {source:'mainView'})`；`dsh-api-session-controller/lib/types/client/sessions/manager.js:63-77` 对 durable 子代理地址只做 `configureSubagent(address, parentAvailable)`，而它是**纯客户端**（`.../client/sessions/session.js:457`，只影响面包屑与 subagent-chat 视图）—— **不物化宿主 agent、不改 owner**。

**实机证据**：`dsh --profile headless --patch <overlay> "<prompt>"`，主 agent 只负责 spawn 一个子代理，子代理被要求调用一次 `ask_user_question` 并逐字回传。子代理回传：

```
Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result
```

与 `:59` 的 `DELEGATED_CALLER` 文案**逐字一致**（run exit=0，非崩溃）。

**推论（勿再试）**：`continuable` / 持久谱系 /「跳进子代理会话」**都不能**让阶段子代理取得问用户的权限——这是**宿主权限架构**，不是子代理形态问题。故 issue #11 的「新增前置阶段 `discovery`」（ADR-0010 D5）在宿主层就不成立。探针手法（headless + `--patch` 挂工具 + prompt 走文件）见 `.workbuddy/memory/MEMORY-infra.md` §G。

---

## 补记（2026-10-06）：B 路径的闭环缺口与零阶段断点缺陷（已修）

上文那句「`abortForClarification` → 零阶段 interrupted run → 用户答完走 `teamflow_resume`」的 B 路径，此前有**两处缺陷 ＋ 一处文案不一致**，实测后一并修掉。

**① 断点定位错（核心）**：`interruptedPhaseOf` 只有一个循环出口（`PHASE_ORDER` 全部「有 stage 且都 done」⇒ `continue` 走完循环 → `return 'acceptance'`）⇒ **「什么都没做」与「什么都做完了」共用同一个出口**。零阶段 run 续跑时 `resumed(phase) = indexOf(phase) < indexOf(resume.phase)` 对 prd/design/scaffold/tech/dev/qa **全为真**，而零阶段的 `buildResumeProducts` 返回 `{}` ⇒ 产物全 `undefined`（**PRD 为空**）⇒ 只剩**没有 `resumed` 门控、也不做 `prd` 空值保护**的验收阶段照常开跑 = **跳过需求澄清／技术方案／开发／QA，直接拿空 PRD 跑产品验收**。是「跑错」，不只是「拿不回答复」。

实机探针（先冻 `DSH_HOME` 再按路径 import `host/core/pipeline.ts`，直调导出的 `interruptedPhaseOf`）：

```
零阶段（澄清闸门中断）      → 断点 = "acceptance"（修前；这是错的）
零阶段 ＋ 已带 supplement   → 断点 = "acceptance"（断点判定根本不看 supplement）
仅 prd done                → 断点 = "acceptance"（这一路是对的：「都做完了」）
```

**修**：`interruptedPhaseOf` 开头加 `if ((journal.stages || []).length === 0) return 'prd'`。

**② 无 supplement 回带通道**：`teamflow_resume` 只收 `runId`（`resumeRun(runId, sessionId)`）⇒ B 拿不回用户答复。更隐蔽的一层：`executePipeline` **无条件**执行 `journal.requirementSupplement = options.requirementSupplement ? … : null`，而 resume 传进去的是 `journal.options`（**白名单字面量，本就不含该键**）⇒ 就算把答复写进 journal 也会被清成 `null`（同型第四次：白名单吃掉内部字段）。

**修**：`resumeRun(runId, sessionId, supplement?)` —— 断点 > PRD 时**显式拒绝**（`run.supplementTooLate`：PRD 是唯一消费点，静默接受＝静默丢弃），否则写回 `journal.requirementSupplement` ＋ 记 `answered` 埋点 ＋ `run.supplementApplied`；`executePipeline` 侧的赋值与 `answered` 埋点各加 `!resume`。

**③ 文案与实现不一致（顺带修）**：`pipeline.ts` 的函数头注释与 `run.needsClarification` 都写「带 `requirementSupplement` **重新启动**」——但这条路径上 **run 已经建了**，重开＝留下一个永不收敛的僵尸 run。文案已改为指向「用 `teamflow_resume` 带 `supplement` 续跑本 run」。

**规模判断依据（`$DSH_HOME/teamflow/**` 全量 95 个 journal 遍历，非抽样）**：B 路径 **0 例**（无「未进入任何阶段」、无 `status=interrupted`、`stages.length` 最小值 1）；`requirementSupplement` 非空 **5 例**（全走 A 路）；断点续跑 **25 例**，**末次断点 = PRD 只占 1/25（4%）**。⇒ 本次修的是**分支覆盖**（零阶段 run 是 `abortForClarification` 自己设计出来的状态），**不是已发生的故障**。

**门禁**：`test/smoke.js` 6 条源码锁 ＋ `test/orchestration.test.js` 第 ⑱⑲ 组 9 条**行为**断言（含「零阶段续跑后 PRD 真起子代理」与对照「断点 = `acceptance` ⇒ PRD 被跳过」）。设计裁决与逐项落地表见 `docs/adr/0011-clarification-interview-and-confirm-sheet.md` §落地记录。

---

## 补记（2026-10-07）：P1 实机验证 —— 原生审阅卡**可行**，但**必须传 live root 实例**

「插件直调 `userQuestions.ask()` 弹原生审阅卡」是 ADR-0011 审批面的首选（兜底＝「返回 status → 主线程 `ask_user_question`」）。P1 原文是「插件能否 `inject(['userQuestions'])`；seam 是否接受『插件代 runtime root 提问』」，**2026-10-07 已实机定案**。

**手法**（仍是 headless 探针，**不动 web profile**）：`dsh --profile headless --patch <overlay> "<prompt>"`，探针＝一个 insert 进顶层的临时插件（`inject: ['tools','userQuestions','agents']`），注册一个工具跑三组调用并把结果回传。

> ⚠️ **探针自身的一处修正值得留痕**：headless 组合里**没有客户端桥**（`dsh-api-remotes` 只属于 `dsh-web-app`）⇒ 第一版探针 A/B **必然同码 `NO_PROVIDER`**，根本分不开「全局 dispatch」与「scoped dispatch」。改法＝在探针里**忠实复刻桥的三条出口并打点**（逐字照抄 `dsh-api-remotes/lib/index.js:147-157`），再**补挂真 `api-remotes`** 复现一次 —— **两次结果一致**。
> 教训：**对照实验前先确认「两个对照组在这个环境里本来就会给出不同结果」**，否则测的是环境，不是机制。

**结果**

| 形态 | 实测 | 桥出口（观测到的 scope carrier） |
|---|---|---|
| `inject(['userQuestions','agents','tools'])` | ✅ 三个服务全注入成功 | — |
| 插件取 live root 实例 | ✅ `rootsLen: 1`、`meIsRoot: true` | — |
| `ask({questions, signal})` —— **无 agent** | ❌ `NO_PROVIDER` @**0ms** | `carrier = <undefined>`、`reqAgent = <undefined>` ⇒ **`next()`：桥直接放弃** |
| `ask({questions, agent: <live root>, signal})` | ✅ **`ASK_ABORTED` @4013ms**（挂到探针超时） | `carrier === reqAgent` ⇒ **`FORWARD`：进入转发队列** |
| `ask({questions, agent: {同 id 不同实例}, signal})` | ❌ `CALLER_NOT_LIVE` @**0ms** | listener **未被调用**（校验层就拒了） |

**机制**：`ask(request)` 只有两条路 ——

- `request.agent === undefined` ⇒ `ctx.waterfall('user-questions/request', request, noAnswerer)`（**不带 scope carrier**）⇒ 桥里 `carrierKeyOf(this) === undefined` ⇒ `next()` ⇒ 落到链尾 `noAnswerer` ⇒ 必然 `NO_PROVIDER`。
- 有 agent ⇒ `ctx.waterfall(scopeTarget(agent, agent), 'user-questions/request', {...request, agent}, noAnswerer)` ⇒ carrier 与 `request.agent` 是**同一个对象** ⇒ 桥通过 `agent !== carrierAgent` 断言 ⇒ 按 `agentId` **路由到该 agent 所属的客户端连接**。

⇒ **是路由问题，不是权限问题**：`CALLER_NOT_LIVE` / `DELEGATED_CALLER` 两道权限闸都过了（传的是真 root 实例），死在「没有 carrier，桥不知道该把问题发给哪个前端连接」。

**实现约束（三条，落地前必看）**：① 必须取**真实例**（`agents.get(sessionId)`，或 `roots()` 里按 `session.id` 过滤），**禁止**自造 `{id, ctx}`；② **多 root 时按 `journal.ownerSession` 选，勿 `roots()[0]`**（本探针环境只有 1 个 root，这个面**没被暴露**）；③ 必须带 `signal` —— 无客户端应答会**一直挂住**，不设超时卡死 host。

**未验**：真客户端 UI 端到端（本组合无 `ui-user-questions`，它只在 web/desktop）。B 组「挂到 4013ms」已证明请求**进入转发队列**，剩下的是「web 前端渲染审阅卡并回传答案」—— 同一个客户端答案器，且官方 `ask_user_question` 在生产走的就是这条链。⇒ **风险低，但不是零。**

完整论证、对照表与未验项见 `docs/adr/0011-clarification-interview-and-confirm-sheet.md` §P1 实机验证。

**顺带（与本锚点无关的既有环境问题，只留痕）**：headless 下 `typert-loader` 的 `dsh-user-questions` 贡献者加载失败（包导出 `./typert` 但 `lib/typert.host.js` 不存在 —— 本机 harness 源码仓产物缺失）。未影响本次结论（`typertGateway` 正常），**未动它**。
