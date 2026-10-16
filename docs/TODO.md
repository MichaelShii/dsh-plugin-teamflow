# TeamFlow 待办（TODO）— 未完成事项，按需查阅

> **本文件不注入 agent 会话**（AGENTS.md 只含当前态约束）；维护者/按需查阅用。
> 三段：**真待办**（需人决策 / 行动）· **观察中**（已埋点或已上报，等数据 / 上游）· **已否决**（勿再调研 / 勿再提）。
> **已完成条目直接删除**（不留 ✅ 残骸，git log 可追溯）；论证流水下沉 `docs/devlog.md`，规格下沉 `docs/anchors/`，版本说明下沉 `docs/releases/`。

## 真待办（需人决策 / 行动）

### 需求澄清与分诊

- 🔜 **澄清闸门：Phase 2 计划确认单 + 策略档**（ADR-0010 §影响 明写：Phase 2 确认单与其 D3/D4 是同一件事的两个侧面，**须合并为一条、不得各做一套**）：
  - **已落地**（细节见 git log 与 `docs/adr/0010-clarification-observability.md`）：**Phase 1 启动前闸门**（`intent` / `blockers` 合格线 / `needs-clarification` 不建 run / `requirementSupplement` 回带）；**ADR-0010 ① 澄清埋点**（`host/core/clarify-log.ts` → `$DSH_HOME/teamflow/<product>/clarify.jsonl`，四事件 append-only，含 `triage-fallback`）；**ADR-0010 ② 失效可见化**（2026-10-04：分诊退兜底 ⇒ 闸门静默失效——两条 fallback 路径各记 `log.clarifyGateSkipped` warn ＋ 汇报 `report.clarifySkipped` 行）。
  - **① PRD 确认单（主；2026-10-07 批 1 已落地）**：`prdPrompt` 增**必填**「假设 / 待澄清」段 + 机器可读（state extra 带 `openQuestions:[{q,why,changes,default}]`）→ PRD 完成后 host **暂停**（复用 interrupted/resume 断点基座）→ 把「目标一句话 + AC + 范围/非目标 + 假设清单 + `PRD.md` 路径」**≤40 行**交主线程；**无合格待澄清项 → 直通不打断**。**2026-10-07 补齐**：`openQuestions` 已从「只要求不落盘」补成落地（`mergeStateBlock` 消费 ＋ 确认单接结构化，见 ADR §落地记录 ① 批 1.5）；批准文案已按要求明示「立即开始写代码」。批 1 落地范围＝`needConfirm` 选项（**默认关** / `patch` 恒 off / 只停一轮）+ PRD 后暂停 `abortForConfirmSheet` + `host/core/confirm.ts`（纯函数、结构化数据源、≤40 行）+ `extra.summary` 落盘 + 确认单落盘 + 汇报带确认单。**2026-10-07 C 方案落地**（`791a610` ＋ `c641ce0`，细节见 ADR §C 落地记录）：AC 的 `extra.acIndex` 契约**真实兑现率仅 ~20%**（34 份 state.json 中 7 份）⇒ 三层补偿 —— **A** `STATE_BLOCK_INSTRUCTION` 模板**本体**补 `extra`（真调用 A/B：改前 1/3、改后 4/4 含 extra，n 小不显著但机制可复现）＋ **B** `extractAcIndexFromText` host 兜底（⚠️ **源必须是 `PRD.md` 文件、不是 `stage.output`** —— 同一实现两源命中率 **95%（20/21）vs 25%（22/87）**）＋ **C** `acSource` 来源自曝（`state`/`extracted`/`none` 三态，zh/en 齐备）。**未做**：审批面**原生 seam** 接线（现为可插拔择路 + 回落 interrupted）。
    **2026-10-08 深夜补**：`redoFrom`（改计划重跑 PRD）**已部分落地** —— 判据落在**内容**上
    （`phaseAtEntry > prd` 且 `stages` 除 prd 外无记录 ＝ 作废面为零）⇒ 开放 supplement 回退重跑 PRD
    （检查点拨回 `prd`、摘旧 prd 记录、清 `confirmSheet`/`assumptions`/`state.openQuestions`，
    PRD 用 `[REVISED]` 块与澄清轮的 `[CLARIFIED]` **分叉**）。⚠️ 仅限**确认单断点**这个形态；
    其它「PRD 之后已有阶段跑过」的断点**仍拒绝**（回退会白作废 design/tech/dev）。
    **呈现**：「怎么把确认单交给用户」写进 **ctx 手册**（每个`［主观项］`一道单选 AUQ、首选项=推荐默认、
    一次 ≤4 题、AC/假设不做题、另给「全部按默认」），**刻意不进汇报**（汇报用户也看得到，会漏 meta 话）。
    **仍未做**：把判定做成可配置的「改哪几个阶段」（`redoFrom` 的完整形态）。
  - ✅ **「主观决策项」扩维（2026-10-08，第 1＋2 步均已落地）**：原判据只有
    `under-specified`（信息不足）⇒ 「我想实现一个桌宠」这类需求**必然不列**（信息足够/模型能自查/猜错不返工）
    ⇒ 风格·形象·架构选型**全由模型独裁**，用户看不到也没机会确认（用户实锤：专业用户感官差，「这插件也就给小白用用」）。
    ⚠️ **这是产品意图，不是返工数据问题** —— 那种损失表现为**流失/差评**，**用返工率量不出来**。
    **第 1 步（`7e2cf0a`）**：`prdPrompt` 假设段/`openQuestions` 明写两类都要列（(a) 信息缺口 ＋
    **(b) 主观决策项**，含「I can decide this myself **不是**省略理由」＋ 合格线防仪式化）；
    `techChangePrompt` 同类扩维（技术选型：模块边界/命名/加依赖/算法或架构）；两条 L1 契约
    （含「旧一维措辞不得复活」的 exclude）。
    **第 2 步（本次）**：`openQuestions` 每条加 `kind: 'fact' | 'taste'` ⇒ 确认单**按内容自动停**：
    **有 `taste`（主观项）才停**，纯 `fact`（信息缺口，`default` 能兜住）或没有待澄清项 ⇒ 直通。
    **不是**按数据阈值、**不是**「任何待澄清项都停」（后者会毁掉 §1「批量可靠交付」的无人值守卖点）。
    ⚠️ **缺 `kind` 一律归 `fact`（不阻断）＋ 发 warn 留痕**：依赖模型自律的判据在量出真阳性率前
    **不得有阻断权**；而「不阻断 ≠ 静默」——`kindMissing` 让契约兑现率**可数**（首次实测见 ADR §落地记录）。
    **同批顺带**：`needConfirm` / `clarifyStrength` **从公开工具 schema 摘到环境变量**
    （`TEAMFLOW_CONFIRM` / `TEAMFLOW_CLARIFY`）——用户实锤「用户又不知道这参数」，公开一个用户不会用、
    工具描述里又没说何时该设的开关 = 功能根本不存在（`craft` / `TEAMFLOW_CRAFT` 是同一模式的先例）。
    **留给实测**：一条「桌宠」需求零参数跑通，看 ① 是否自动停在品味项上、② `kind` 兑现率。
  - **② 审批面选型**：优先宿主直调 user-questions seam（`intent:{kind:'plan-review'}` + `detail` = 计划 markdown → 原生审阅卡 `Approve`/`Keep planning`/`Chat about it`）——**2026-10-07 已实机验证**（详见 `docs/adr/0011-…md` §P1 实机验证）：插件 `inject(['userQuestions','agents'])` 成功、能取到 **live root 实例**、**传实例能进桥转发**（挂到 4013ms 超时）；**但「省 `agent`」形态被证伪**（全局 dispatch 无 scope carrier ⇒ 桥第一出口 `next()` ⇒ `NO_PROVIDER`）⇒ 必须传真实例，且多 root 时按 `journal.ownerSession` 选（勿 `roots()[0]`）、必须带 `signal`。**未验**：真客户端 UI 端到端（本探针组合无 `ui-user-questions`）；兜底沿用既有的「返回 status → 主线程 `ask_user_question`」通道（已在生产验证）。
  - **③ 策略档 `interview`（与 ① 一体两面，ADR-0010 D3/D4）**：澄清强度~~进 `MODE_REGISTRY` 作为新维度~~（`off` ＝ patch 现状 / `once` ＝ 现行默认 / `interview` ＝ **显式开**；**`patch` 恒 `off`**）；**必须带硬终止**（D4：轮数上限 ＋ 置信度不再上升即停 ＋ 用户可随时「够了」，三条并存）——同一闸门早期版本因反复追问造成 **6 轮零 run**。
    **⚠️ 2026-10-08 重写这一条（原描述已不成立）**：
    - **不进 `MODE_REGISTRY`**（原措辞作废）：`PipelineMode` 决定阶段集 / PRD 形态 / 架构护栏，把「追问几次」塞进去会让同一张表承担两件正交的事。
    - **不是「显式开」、也不是 run 级选项**：`clarifyStrength` 已整体移出 `PipelineOptions`（`clarifyStrengthForTeam` 删除）。原因：它**只选 `tool.ctx.team` 中间那段文案**，而 ctx 只在**选团队时**注入 ⇒ 作为 run 参数**结构上「迟一拍」**（本 run 传的值当次不生效），反查历史 run 还带来「重启丢失」。
    - **一次一问现在是默认行为**，写在 ctx 手册里（**切口 = 告诉主 agent 怎么用这个插件**）：`tool.ctx.team` 拆为「前半 ＋ 澄清槽位 ＋ 后半」，默认档 = `interview` 文案；`once`/`off` 只留作**对照实验**（`TEAMFLOW_CLARIFY`）。
    - **「`patch` 恒 off」契约作废**：它约束的是 run 级选项，而 ctx 注入时既不知道档位、也不知道是不是 patch。
    - **硬终止已落地（文案层）**：默认档文案明写三条停止条件（能预测剩下的 / 用户说够了 / 同问题问过两轮）。⚠️ 仍属**模型自律**（§2：prompt 提标准不当保障）⇒ **未做机器侧强制**。
    - **探索态加固**：`intent === 'exploration'` 时在 `needs-clarification` **返回面**追加同一协议（工具返回面 ＋ pipeline 兜底闸门两处同形）。
  - **④ 强度按数据定（ADR-0010 待定 #3，已收窄）**：`fallbackVerdict` 仍硬编码「永不拦启动」。三候选：① 保留放行但**可见**（**已做**，见上）；② 降级为**确定性形态判据**兜底拦一次；③ ①+② 叠加。**② 属「加拦截」，按纪律要先定判据 ＋ 量真阳性率 —— 而 `clarify.jsonl` 当前样本 ≈0（1 条产品线 / 2 行）⇒ 这是真正的瓶颈，先攒。**
  - **位置论证（勿再争）**：确认单**必须放 PRD 之后、tech 之前**——放启动前只能问抽象问题，放 tech 之后是**事后追认**（驳回要连 PRD+tech 一起重做）。实测调用占比：PRD 后 ≈2–6%、dev+QA ≈89–95%。
  - **已定约束**：合格线由 host 判（每条 blocker 须同时给 ①≥2 个互斥读法 ②改变哪个 AC/范围 ③猜错要重做什么，缺一丢弃并 warn）；模态豁免 `patch` 直通 / `lite` 仅在有项时停 / `medium·full` 默认停 / headless 不停（走「假设 + 汇报高亮」）；闸门语义 ＝ 只负责「唤起第一轮对齐」，不负责「追问到满意」（多轮追问需跨调用状态：`clarify-state.json` + 轮次上限 + TTL）。
  - **设计约束（ADR-0010 D5）**：访谈只能发生在主会话（子代理不能提问）⇒ issue #11 的「新增前置阶段 `discovery`」**不成立**。
  - **纠错背景（勿再犯）**：`journal.triage.blockers` 恒为 0 是**结构性盲区**——澄清命中时 `needs-clarification` **不建 run**，那次裁决不落盘；落盘的只有澄清后建 run 那次（blockers 已被收敛规则放过）。据此统计会得出「闸门从未触发」的**反结论**（实测得 0，真实至少 **4 例**）⇒ **统计前先问「该字段在哪条路径上被写入」**，这正是 ① 埋点存在的理由。
  - 详见 `docs/adr/0010-clarification-observability.md`（埋点落点/字段、fallback 行为、`interview` 默认矩阵、去交互化机制的取舍）与 **`docs/adr/0011-clarification-interview-and-confirm-sheet.md`（草案：借 `interview-me` 精华的逐条适配裁决 · 四处冲突（**④ 已拍板并落地**：补 `teamflow_resume` 的 `supplement` 入口 ＋ 零阶段断点修正 ＋ 文案收口；①②③ 仍待拍板） · D5 结论＝主会话纯对话 · 并推翻「需要 `clarify-state.json`」）**。

- **需求有效性前置拦截**（ADR-0005 触发信号）：在 PRD/确认单阶段判别「需求与现状不符」即停，避免走完开发/验收。

### 编排与状态机

- 🔜 **流水线执行体数量 = 阶段 × 子任务 × 打回轮次（文件/成本的最大乘数；需人决策）**：r9 实测（`tf-mu2ioilr-95l4th`）一次 full run 起了 **10 个子代理**（PRD 1 + 技术 1 + 开发 5 = T1–T5 三个并发执行体 + 两轮 QA 打回修复 + QA 首轮 + 两轮复验），**718 次模型调用 / 59 分钟**，其中**首轮 QA + 2 轮打回 + 2 轮复验 = 440 次（61%）**花在打回闭环，且该轮最终因一个 P2 走到复验超限、**验收被跳过**（status=completed + humanIntervention）。**待定**：QA 独立探针/复验的输入能否复用（当前 prompt 明令独立，防同源假绿）、打回上限与轮次成本是否要按缺陷严重级分档（P3 观察项不该触发整轮复验）、以及 dev 子任务拆分的粒度收益是否值这份上下文开销。**先定判据再动**（回滚成本高、质量是第一约束）。

- 🔜 **熔断预算的作用域 = 单阶段单次尝试（跨 resume 累计不设闸；需产品决策）**：`tf-mucx3sq1-53262i` 实测 —— scaffold 重试链 6 次尝试累计 fresh **315,623 > `FRESH_TOKEN_BUDGET` 200k**，但单次最大仅 **122,091**，故全程未触发熔断（两次 env-unavailable 之后都是**人工 `teamflow_resume`**，每次 resume = 新的一次阶段尝试，预算重新起算）。即：预算挡得住「单次失控」，挡不住「人工反复续跑」。若要给跨 resume 的累计设闸，需在 journal 上加 run 级累计口径，**与 `freshTokensOf` 的单次口径并存、不得合并**。

- 🔜 **用「持久化」类需求重跑验证 ADR-0006**：确认 M0 状态核对注入、M1 蓝图产出（架构阶段不再被 lite 跳过）、M2 dev 按蓝图拆任务、M3 验收架构核验（重复适配器应被打回）全链路生效。

- 🔜 **P2 双语遗留的 P3（原 6 项，2026-09-15 已清 4 项）**：
  - **`clip()` 截断标记未本地化**（`host/util.ts` 的 `…[已截断 N 字符]` 会出现在 en 注入文本/Remote 报文里）：41 个调用点需加 locale 参数——**风险在 zh 逐字平价**（AC-9 只增不改），建议按面分批（先 prompts/state 注入面，再 Remote/持久化面）。
  - **`teamflow_*` 工具描述内嵌中文**（`host/index.ts` 的状态名与中文短语示例）：插件**加载期**注册 = 此时无语言源（客户端还没推），改双语需先定方案（惰性 description / 注册后更新）；且中文短语对**中文需求的工具触发**有正向作用，直接删反而有害——**先定判据再动手**。
  - **R3-5 口径确认**：zh prompt 文本有 7 处语义等价改动（`(Markdown)`→`(Chinese Markdown)` + 中英混排处插空格），需确认 AC-9「逐字不变」是否覆盖 prompt 文本；不覆盖则关闭为备案。
  - **R3-6 备案**：`resolveLocale({get client(){throw}})` 自身无 try/catch（生产调用方 `ambientLocale()` 已整体兜住，实际不可达）——是否加防御由维护者定。

### 子代理形态

- 🔜 **子代理形态：按阶段选择 one-shot / continuable（2026-09-30 立项；含 fork 评估结论与两个应用场景）**
  - **宿主事实**：子代理 = 两正交维度 —— 形态（one-shot / continuable）× 后端（spawn = 全新 / fork = 以父级**已完成轮次**为初始内容）。本机 `dsh-base` 组合**两个后端都注册**（`cordis.patch.yml:351-359`）；模型侧工具 `subagent` = spawn + **continuable**、`subagent_fork` = fork + one-shot。本插件走 `subagents.startActivation()` 直连 API = **spawn + one-shot**（调用点仅 `runner.ts:173` 与 `triage.ts:659`；入口名在宿主 alpha.2 由 `start()` 改为此名，见下方「宿主 API 破坏性变更」）。
  - **fork 已否决（对本插件不适用）**：它继承的是「发起委派那个 agent」的已完成轮次，而我们的阶段子代理由**主会话 agent** 发起 ⇒ 继承的是用户对话而非上游阶段产物；且 token 暴增（复制整段历史）、一次性快照、工具作用域与权限全不继承。
  - **continuable 的真实成本**（⚠️ 勿引用已作废旧论证「撞 8 / 无 outputSchema」——8 是**按父池**的驻留上限、混合方案不撞；`outputSchema` 全仓 0 命中 = 假障碍）：① 必须主动 `drainContinuableChildren`（驻留不释放会累积到 `maxActiveSubagents=8` → `ACTIVATION_LIMIT_REACHED`，**不排队**）；② **结算通知进父级上下文**（每个结算 Activation 往父级塞一条 `Background subagent X finished…` user 消息 → 吃主会话 token）；③ `run.result` → inbox/turn 适配层；④ `interrupt` 只停当前轮不销毁 → 取消 run 要补 drain 才是真停；⑤ 初始 prompt 会被追加 return guidance（动 prompt 契约，L1/L2 要同步）。
  - **前提 = 按阶段选择，不是一刀切**：真正需要「续」的只有 **dev**（空收尾）与 **qa / qa-fix**（复用同一 dev 子代理）；prd / design / scaffold / tech / acceptance / 分诊 一次产出 → 保持 one-shot（且**不占池**）。**机制可行**：`sendMessage` 要求 sender = 确切在线 Agent —— 我们有（`runtime.agents.get(sessionId)` → 主会话 agent，`index.ts:997`）。
  - **应用场景 (a) 空收尾续跑（2026-09-27，实测 `tf-muigy5eq-dw5dv0`）**：推理模型空收尾（`deepseek-flash`：`finish kind=stop`，reasoning 之后、正文之前被**服务端**收尾，非宿主动手）当前只能整轮重跑自愈，QA 一次实测浪费 **112 万 token + 2 分钟**（重跑那次又花 147 万）。已落地的 A 档（runner 文件兜底判交付）只救「文件已合格、只差说话」；**「干到一半死掉」（attempt3 死在第 19 步）只有续跑能救**——但 **one-shot 在 `run.dispose()` 后不可续**，须换轨 `startContinuable`。
  - **应用场景 (b) QA 打回复用同一 dev 子代理**：替掉「重开子代理 + 重灌蓝图」（`startContinuable` + `steerHostSubagentPrompt` / `queueHostSubagentPrompt` + `interrupt`）。
  - **宿主容量约束（2026-09-22 实测；⚠️ 2026-10-15 订正 —— alpha.2 起「one-shot 不占池」不再成立）**：`maxActiveSubagents`（默认 8）在 **alpha.1** 确实**只**约束 continuable 子代理的驻留数、one-shot 不占池。**alpha.2 起宿主统一了两种形态的 activation 生命周期**：`manager.materialize()` 对 local 与 external 一律 `pool.reserve(maxActiveSubagents)`（`packages/subagent/subagent/src/manager.ts:739-744`）⇒ **本插件的 one-shot 阶段子代理现在也吃池子**。故 dev 那套并发（`runPool`，默认 3、`DEV_MAX_CONCURRENCY=8` 硬截断）与宿主 8 **不再互不相干**：dev 波次顶到 8 时正好吃满整池，而池是**按父树共享**（主会话即树根）且**超限不排队**（`ACTIVATION_LIMIT_REACHED` 直接拒创建 ⇒ 该阶段失败）。**待决**：`DEV_MAX_CONCURRENCY` 是否留出余量（宿主 `config` 是私有的，读不到 `maxActiveSubagents`，只能定常量）；② `maxDepth`（默认 1）约束嵌套深度，QA 打回若走「父→子→孙」要多留一层。
  - ⚠️ **判据待定（先攒数据）—— tf-obs-r1 实测给出的反证**（`tf-muliqvaq-v8c58b`：medium，16 阶段 / 50 min / 369 调用 / 2424 万 token）：① 该 run **无空收尾**（16 阶段全 done）⇒ 主要目标场景**未发生**；② 「省重灌」可确证部分极小 —— 打回修复两轮 fresh input 仅 3.0 万 + 3.5 万，**占总 token 0.27%**（prefill 的 ~95% 落在廉价 cacheRead 上）；「复用上下文 → 减少重复探索调用」的收益**无法从现有数据推出**，须实测。**⇒ 继续攒空收尾样本；优先级低于「QA 闭环成本」与「scaffold 成本」的评估。**

### 宿主适配与兼容

- 🔜 **`DEV_MAX_CONCURRENCY` 是否要为宿主容量池留余量（2026-10-15 立项，随 issue #20 迁移浮出）**：宿主 alpha.2 起 activation 统一，**one-shot 也占 `maxActiveSubagents` 池**（默认 8，按父树共享、**超限不排队**直接 `ACTIVATION_LIMIT_REACHED`）。本插件 `DEV_MAX_CONCURRENCY` 恰好也是 8（只影响 dev 波次；其余阶段串行，同时最多 1 个子代理）⇒ 顶格运行时整池吃满，此时**主会话若有任何其它委派**（或别的插件走同一棵树）就会撞拒。宿主 `SubagentRuntime.config` 是私有字段，**读不到** `maxActiveSubagents`，只能定常量。候选：保持 8（承认边界）／降到 6（留 2 席）／按 `dsh plugin` 配置暴露成插件选项。**决策前先量**：真机上 dev 波次 >6 的 run 占比、以及是否真出现过 `ACTIVATION_LIMIT_REACHED`（当前代码对该错误码**无专门识别**，只会落到通用阶段失败路径）。⚠️ 判据细节与证据见本节「子代理形态」条的容量订正。

- 🔜 **宿主事件 source v4 适配缺直接断言**：目前只有间接证据（整条流水线跑通、20 阶段无事件格式报错、`agentsStarted=20`）。建议补一条 L2 conformance 语料（把 v4 `kind: 'plugin:dsh-plugin-teamflow'` 的 source 形态冻结进 `docs/benchmarks/corpus/` 回放），避免宿主下次再改 source 形态时又是「用起来才发现」。

- 🔜 **跨父会话跳转子代理 —— 新 API 可能已支持，待实测解锁**：现状是 `client/index.tsx` 的 `crossSession` 守卫在 `ownerSession ≠ 当前会话` 时**禁用按钮**（旧依据：DSH 子代理目录按父会话加载，`selectSubagent` 不支持跨父导航）。**新证据（2026-09-23）**：宿主 0.1.7-alpha.1 的 `uiWorkspace.openSession(target)` 接受持久子代理地址，`ui-workspace/README.zh.md:68` 明写「显式地址不需要预加载父会话目录」——跨父导航的宿主前提可能已消失。**测法**：会话 A 跑一个 run，在会话 B 的工作台打开该 run 的阶段详情，看按钮是否变亮、点击是否真跳到 A 的子代理会话；通过则删掉 `crossSession` 守卫（数据面已备好：`journal.ownerSession` + stageDetail 下发）。

- 🔜 **护栏复读检测迁出弃用读取器（唯一剩余处）**：提醒通道已改官方 `Agent.inject`、挂死检测已改官方 `subagentTiming` 投影（v0.1.7）；只剩**复读检测**仍读事件（需要流式文本内容）。官方替代是**订阅 `'session/event'` post-commit 投递**（`packages/core/session/src/index.ts:62-72`，agent-scoped 过滤）——把 15s 轮询 + 历史扫描换成增量推送。**动手前先定等价判据**（判据漂移直接影响误杀率：参考 tf-mte906e9 退化误判、json-parse r1 挂死误杀两次实锤）。

- 🔜 **AGENTS.md 预算余量已近见底（2026-10-12 复测，比原记录紧得多）**：`test/instruction-budget.test.js` 实测 §5 **6,119 B / 上限 6,144 B（余量仅 25 B）**、全文 **22,210 B / 22,528 B（余 318 B）**（原记录 5,907 / 20,297 已过期；本日仅给 §2 添 1 条 ADR 指针就吃掉约 100 B）。门禁读的是**工作树原样字节**，Windows 下 `core.autocrlf` 交付 CRLF（同一份内容为 LF 时约少 120 B），余量随 checkout 波动。⇒ **下一条 §5 锚点加入前必须先压缩**（把某行论证再迁 `docs/anchors/`），否则门禁直接红；§2 的 ADR 清单也在同一份预算里，继续追加需一并考虑。

- **`STAGE_TOKEN_BUDGET=60k` 硬编码** → 可升级为 service Config（熔断阈值可调）。

### 存储与日志生命周期

- 🔜 **`$DSH_HOME/teamflow/` 无遗忘机制（演练脚本实测佐证）**：11 个目录里 6 个是空壳（只写过 `teams.json`，从未跑流水线）、1 个旧格式 key 残留；`runs/` 无 TTL 无归档策略（单个最大 137 KB，`ws-tetris-e22c5cf9` 累计 2.90 MB），`backlog/*.json` 各配一个等大 `.bak`，`_archive/` 只有一次手工归档。宿主自己有 `dsh-output-retention` / `dsh-compaction`，插件这块空白。待定：空壳目录自动归档阈值（如「90 天无 run 且无 backlog」）+ runs 滚动上限。**注**：`logs/` 已有遗忘机制（每工作区保留最近 20 次 run，起跑时淘汰——见 AGENTS §5 日志生命周期锚点）；本条的 `runs/` 与空壳目录仍未覆盖。

- 🔜 **工作区 key 迁移（破坏性）**：`context.ts` 的 UUID 分支**当前不可达**（宿主 `resolveByPath` 是 `async`，我们同步调用 → 永远走 `slugPath(cwd)` 路径派生 key）。要真用 UUID 须改 `await` + **迁移 `$DSH_HOME/teamflow/<key>/`**（顺序反了会新旧 key 同时写入）。v0.1.9 已出只读演练脚本 `scripts/migrate-workspace-key-dryrun.mjs`（反推 `runs/*.json` 的 `workspacePath` 重算期望 key + 按路径分组合并计划 + 同名文件内容冲突检测）。**实测（2026-09-12，本机 11 个产品线目录）**：key 与路径自洽 4、**漂移 0**、旧格式 1（`tetris-f06370e8`，0 run）、**空壳 6** ⇒ 「同一项目裂成两条产品线」**尚未实际发生**。**因此优先级按「风险」排**（换盘符大小写 / 软链 / 移动目录即裂），不按「已发生损失」排。

### 客户端

- **产物可见性剩余**（v0.1.8 已完成主体，见 `docs/releases/`）：① run 详情 tab 的 `sidebar.right.pane.tab.title` seat（chip 标题现取 `definition.title`）；② 全局面板**只读**——没有 backlog 流转写路径（缺 product-keyed 的 `productBacklogUpdate`；补写要带审计 reason 且服务端仍有状态机守卫）。

- **客户端渲染组件分叉**：`client/shared.tsx` 只统一了主题/词表/格式化，`TeamFlowView`/`PipelinePanel`（会话内）与 `panel.tsx` 的 `RunList`/`BacklogGroups`/`RunDetailPane`（全局 + 右栏）仍是两套渲染实现——收敛成一个组件族（数据源差异用 adapter 表达：sessionId 寻址 vs 产品线寻址），否则后续每加一个字段都要改两处。

- **工作台「列出子代理」改用 `ctx.subagents.listChildren`**（官方 API，覆盖 one-shot + continuable，带 `activity`）；注意它**无 `createdAt`/`runId`/`outcome`**——run 顺序与归属仍以 journal 为准。

### 升级与分发

- 🔜 **升级提示 ＋ 一键升级（ADR-0012；2026-10-12 定档）**：落点＝**宿主插件页槽位**（`plugins.detail.badge`/`.actions`，社区插件本来拿不到这个位置）＋ **TeamFlow 工作台**；动作＝**真一键**（调 `ctx.pluginManager.installBundle(spec)`——**服务层不调 `inspect`**，可原地升级，且自带备份/回滚/profile 写锁/registry 回退/兼容预检/install-script 审批，**不自己 spawn pnpm**）。根因是**发现**与**操作成本**，不是可达性（实测：两源同为 0.2.7、`dsh plugin … add` 参数逐字直通 pnpm；⚠️ `minimumReleaseAge` **是启用的**（24h 窗口，10-12 修正），但它咬的是**范围/`latest` 解析**，我们用的**精确版本 spec** 实测能装上）。实现三条硬要求：① 按钮/确认文案必须明说「将在此 profile 执行 pnpm 安装、改动依赖」——该服务路径**绕过 `plugin_manager` 工具层的审批门槛**，知情责任在我方；② **有活跃 run 时禁用或推迟**（避免抢 profile 锁、打断阶段）；③ 升完提示**需重启**才加载新代码。⚠️ **本功能对存量用户第一次触达无效**（老版本没有它）⇒ **必须配一次性、与版本无关的外部触达**（通稿 / README / issue 模板写明升级命令），这是唯一存量杠杆。未决 4 条已于 10-12 全部定档（见 ADR-0012 §已定档）。**切片 1（探测底座 ＋ 工作台提示条）与切片 3（真一键）已实现**（`host/core/update-check.ts` ＋ `test/update-check.test.js` ＋ 工作台提示条；门禁 `upgradeGate` 为纯函数、有单测；client 侧真一键做**两步确认**不直装）。

- ✅ **切片 2 已实现并在真机验证 —— 订正：我一度误判为「宿主不支持」**：`client/index.tsx` 用 `ctx.slots.inject('plugins.detail.badge'|'plugins.detail.actions', …)` 注册「有新版本 x.y.z」标签与「升级到 x.y.z」按钮，只对 `subject.kind==='bundle' && subject.pkg.name==='dsh-plugin-teamflow'` 渲染（`subjectIsOurs`）。**误判原因**：我只 grep 了 `~/.dsh/profiles/node_modules`，而桌面版**从源码仓的构建产物**（`packages/client/ui-plugin-manager/lib/client.js`）加载该页面 ⇒ **把「profile 里查不到」当成了「宿主没有」**。**判据已修正**并写进 `MEMORY-playbook` §D：问「宿主有没有这个能力」还要查**正在跑的构建产物**与**用户界面本身**。门禁：`test/client-host-api.test.js` 锁「注册名 → 守卫判据 → 渲染点调用 → 两处包名常量一致」**整条链**（变异证明：去掉包名判据 ⇒ 恰好 1 条红）。真机证据：用户在插件列表页看到该标签与按钮，点击后升级成功。

- ✅ **真一键的「非 registry 来源」判据已补（10-12 同日闭环）**：`upgradeSelf` 用 registry spec ⇒ 对 `file:`/git/tarball 安装会把依赖**静默换源**（真机把 desktop 的本地 `file:` 装成了线上 0.2.7）。已加：host 侧 `classifyInstallSource()`（纯函数，`file:`/`link:`/`workspace:`/`portal:`/`git*:`/`github:`/本地路径/tarball 直链/scp 形态 → `other`；版本范围与 `latest`/`npm:` 别名 → `registry`；认不出 → `unknown`）＋ `upgradeGate()` 新增 `not-registry-install`（**非 `registry` 一律拒，含 `unknown`**，且排在 `run-in-progress` **之前**——永久性原因压过临时性）；UI 侧 `canOneClick()` 提前不显示按钮、改显示说明。**变异证明**：去掉该维 ⇒ 恰好 4 条红（原有的 run-in-progress 等仍绿）。**真机端到端实测**：desktop 的真实 spec `file:E:/…` → `other` → 门禁 `not-registry-install` ⇒ 一键被拦下 ✓。



- 🔜 **上游议题（dsh 侧，**只能上报、不能提 PR**——宿主不接受外部 PR）**：宿主 `updateAvailable()` 只认官方目录的 `installTarget`（`packages/boot/plugin-manager/src/index.ts:300-303` 由 `officialBundleInstallTarget` 产出）⇒ **社区插件永远拿不到「可更新」**，文案还把第三方导向「卸载再装」。建议以 **issue 上报**（给 `updateAvailable()` 增 registry latest 比对分支 ＋ 给社区插件一条原地升级动作）。**前置**：先定供应链策略（是否自动安装最新版、与 `minimumReleaseAge` 的关系）。⚠️ **不得当成会落地的依赖**——本插件自己的三条落点（探测 / 工作台提示 / 调 `installBundle`）**都不需要宿主改码**。

### 工程与工具链

- 🔜 **`catch (e) {}` 分类 lint 规则（低优先级）**：全仓大量空 catch 有正当理由，但现 `.oxlintrc.json` 无分类手段。**实测基线（2026-09-26，57 文件 / 133 个 catch）**：裸空 `catch (e) {}` **0 个**；注释-only 静默 **81 个**；真处理 52 个 ⇒ **现有纪律已达标 → 降为低优先级**。真要做也不是加规则，而是给这 81 处静默加**可选 warn 级日志**（排障时能看到被吞的异常），不是门禁。

- 🔜 **换行/折行仍无自动手段（低优先级，唯一已知缺口）**：`max-len` 只报警不修，缩进已由 `@stylistic/indent` 兜住，但「把一行断成两行」仍靠作者/AI 手写。若日后要补，只考虑**可声明、可进门禁**的形态（不是再引一个 printer 与之互斥）。

## 观察中（已埋点 / 已上报，等数据或上游）

- **D：QA 轮次改成收敛判据（先埋点再定）**：52 个历史 run 实测——发生打回 **7/52**（每次至多 1 轮，唯一 2 轮那次是幻影）、**触达复验上限 1/52**、验收未跑 1/52 ⇒ 「真正需要第 3 轮修复」**从未真实发生**。且「同一缺陷原样复现就早停」**按缺陷 id 判不出来**（QA 每轮重新编号：r9 三轮分别是 `QA-*` → `R2-*` → `R3-*`），稳定身份键只有「检测命令」。**埋点已落地（2026-09-15）**：QA 循环每轮把阻断集合的稳定身份与增/减/停滞计数写进 `journal.qaRounds`（留最近 12 轮），配只读读侧 **`node scripts/qa-rounds-report.mjs`**。**待定**：等攒到若干真实复验轮（最好含至少一次 `repeats > 0` 的停滞样本）后，再决定要不要把 `QA_REWORK_LIMIT` 的硬上限换成收敛判据（阻断数严格下降且缺陷不重复 → 允许再来一轮；停滞 → 立即转人工）。**先定判据再动状态机**（ADR-0007 语义，回滚成本高）。

- **dev 末尾「QA 独立验证」任务：先攒拦截率数据（2026-09-25 观点已定）**：tech 蓝图模型会自发把「验证自查」拆成 dev 任务（实测 `tf-mufssxpv-o3cb3m` T7、`tf-mufvwupp-uiukmu` 第 5 任务，`files:[]` → 正确送末波串行，产出 `QA-REPORT.md`）。**观点**：保留（dev 自查是全链路唯一「发现问题 → 当场修」的环节），但改定位为「交付自检」：发现问题当场修、只记结论不写 `QA-REPORT.md`（证据链留给 QA）、措辞与 QA 解耦防「预演 QA」式全量重验。改动 = tech prompt 蓝图指引一句话（须过 `prompt-contract` + `conformance`）。**数据点 1（`tf-mufvwupp-uiukmu`）**：dev 自查正常完成后，QA 第 1 轮仍发现 **2 个阻断缺陷** ⇒ 自查拦截率 **0/1**（暂支持「自查质量有限」的担心）。**数据点 2（`tf-muzc59h9-pnbhyk`，2026-10-08）**：dev 任务「QA 三浏览器实测」**同时写了 `QA-REPORT.md` 和 `ACCEPTANCE.md`**，随后在收尾 `edit` 上失手 ⇒ **run 判 failed，而交付其实 13/14 AC 已验证**（假失败）。⇒ 支持「重新定位」，但**不支持砍掉**。**已落地**（tech/architect prompt 各一句话，锚点 `[Self-check, not a QA rehearsal]`）：dev 自查**保留**但明确降为「交付自检」——只记结论、**不许写 `QA-REPORT.md`/`ACCEPTANCE.md`**、**不许跑 QA 式全量矩阵**。⚠️ 第一版误写成「不许有验证类任务」＝砍掉它，与本节「观点已定」相反，已改回（教训：**动 tech prompt 前先读本节**）。**仍等样本**：① 自查的实际拦截率 ② 是否系统性拆任务倾向。

- **按阶段下发 `reasoningEffort`（token 大杠杆，需更大样本才能宣称节约）**：v0.1.7 已落地两处机械阶段降档（patch 单点确认 + scaffold → `low`；重试回升 high；先经 `resolveModelInfo` 探测能力再下发）。**A/B（n=3/臂，只比「单点确认」阶段）**：均值 output 8,774 → 5,047（−42.5%）、耗时 96.4s → 42.9s，但**计费总量只 −12.8%**，且**区间大量重叠**（low 的 L4 自己探索 13 次调用，反比 high 的 H6 更贵）⇒ **n=3 下统计上不可分，不宣称节约百分比**。**剩余**：① 要可信数字需更大样本或固定调用数的评测场；② 是否把 `dev` 的机械改动也纳入降档（当前保守不动——判据型阶段，需更多证据）。

## 已否决（勿再调研 / 勿再提）

- ⛔ **成本从「量」到「钱」（2026-09-28 拍板）**：出金额需静态价目表（per-model 每百万单价），**判定不做**——① 每模型单价不同（同 provider 内部也分层）；② 会调价，任何静态表都会腐化且无校验；③ plan / 套餐式计费下「token × 单价」**根本不适用**，算出来的金额是假的。⇒ 计量就到 **token 量**为止（四桶 + 命中率 + 调用数），汇报与工作台维持无量纲口径；用户自己拿量对账比我们给一个可能错的钱更诚实。以后谁再提，先看这三条。

- ⛔ **移动端支持 —— 不在范围内（2026-09-29 拍板，不排期）**：宿主 dsh 自身未做移动端，本插件**目标平台是桌面浏览器**；触摸与窄屏 best-effort、**不作受支持能力、不保证回归**、**不写 README**（那是使用者上手材料，一段「移动端不承诺」对 99% 的桌面读者只是噪音，还会反过来提示这件事存在）。已做且保留（宽屏零回归，`min()` 在宽容器是 no-op）：Pointer Events + 双指捏合、<560px 默认列表视图、缩放下限**保持 0.5**（理由与实测账见 `client/viewport.ts` 注释）。以后再提移动端问题按此口径处置；要转「支持」须先补最小防线（列表视图目前**只有纯函数有单测，DOM 层无覆盖**）。

- ⛔ **插件级用户记忆层（ADR-0009，2026-09-12 否决）**：① **场所错位**——用户偏好是多轮对话的产物，流水线是「一需求一链路」批处理；② 输入不足以判断普适性（归纳出的「通用约定」都是当前需求里的）；③ 两条替代路径已够（跨产品用户约定写宿主原生 `$DSH_HOME/AGENTS.md`；插件硬规矩进 prompt/模板）；④ 突破 ADR-0002 写域边界。再评估触发信号见 ADR-0009 末节。

- ⛔ **`pipeline.ts` 巨型函数进一步重构（三块外移 + STAGES 表驱动）—— 已评估后不做**：①② 已落地（`runSimpleStage` 收敛四同形阶段 + `runDevStage`/`runQaStage`/`runAcceptanceStage` 命名单元，A/B 验零行为变化）；③ 外移需显式化约 20 个闭包变量（风险 > 收益，等真有第二消费方再动）、表驱动**不减复杂度**（阶段间有产物依赖链，表只能表达「顺序 + enabled」，真正的差异逻辑仍在各 runner 内部）。**维持现状。**

- ⛔ **迁移到 `dsh-workflow` 原语**（`agent/pipeline/parallel/phase`）：host plane 解析不到 `ctx.workflowEngine`（标准 preset 把它 `isolate` 在 agent 组内）+ 前台运行 / 无持久化 / **无重试** → 等于丢掉 resume / 熔断 / 护栏。

- ⛔ **依赖实验性 Agent Teams 包**（`@deepseek-ai/dsh-experimental-*` 5 个）：无稳定性承诺、**稳定包被禁止依赖实验包**、用户须显式加 profile → 与「可分发插件」定位冲突。

- ⛔ **`subagent.toolFilter` 做宿主强制工具裁剪**：`tools.restrict()` 对**未知工具名 fail-loud 抛错**，而子代理工具集随 preset / 深度变化（如 maxDepth 下没有 subagent）→ 跨 profile 会让子代理 **start 直接失败**；`maxDepth` 也不是嵌套约束（`resolveChildDepth` 超限只是抛错，不传播限制）。即「QA 禁改产品代码」这类按名字裁剪**无法安全表达**。

- ⛔ **把阶段指令搬进 system prompt / `contextBreakdown` 当熔断依据**：前者会作废跨子代理前缀复用（冒烟 93% 命中率靠它）；后者官方明确是启发式。

- ⛔ **宿主 Windows 沙箱 ACL provision 失败 —— 已闭环，勿再当待修 / 待跟踪项（2026-10-04）**：宿主 `grantWrite` 在一次调用里同时写 DACL 与 SACL（Low label），写 label 需 **`WRITE_OWNER`**（对象权限，**不是** `SeSecurityPrivilege`）；上游在 [Discussion #7538](https://github.com/deepseek-ai/deepseek-harness/discussions/7538) 明确这是 **documented intent**（Modify-only 目录「fails loudly」是 integrity label 层有意的代价），我们建议的「跳过 label 降级」**已被否决** ⇒ 上游**无可等**（唯一开口＝失败时点名缺 WRITE_OWNER 的诊断，属上游、非阻塞，非我方待办）。**我方早已闭环**：`host/core/workspace/acl-preflight.ts`（2026-09-25）在 `executePipeline` 内、任何阶段 / 模型调用之前预检自愈（补 `user:(OI)(CI)(WO)`，无需提权），且失败文案已点名 WRITE_OWNER。**代码实证**：`0.1.7-alpha.1` → `0.2.0-rc.2` → `0.2.1-alpha.1` 的 grant bundle sha256 逐字相同（`e6014e93…`）。详见 `docs/reports/2026-09-23-dsh-windows-sandbox-acl-provision-failure.md`（含 2026-10-04 更正块）。
