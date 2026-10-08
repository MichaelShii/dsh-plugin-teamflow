/**
 * dsh-plugin-teamflow — 工具与分诊面词典（zh / en）。
 *
 * 消费区：host/index.ts（`teamflow_*` 工具返回/render/错误串、分支决策问句与选项）、
 * core/triage.ts（分诊理由与档位词表）、core/domain/backlog.ts（工具面错误串与默认 reason）。
 *
 * 语言规则（与流水线面不同，勿混）：**工具返回面向「当前界面」→ 环境语言 `ambientLocale()`**；
 * 流水线产出（日志/prompt/产物/汇报）面向「某个 run」→ run 快照 `journal.locale`。
 * 这正是「切语言后本 run 文案不变、工具返回立即跟随」的结构性来源（PRD §4.1）。
 *
 * 约定同 locales/pipeline.ts：zh 值 = 现状中文原文（逐字照搬）、en 值不得含 CJK、
 * zh/en key 集合同形、key 只增不改、占位符 `{name}`。
 */

/** 工具/分诊面词典。 */
export const TOOLS_DICT: Record<'zh' | 'en', Record<string, string>> = {
  zh: {
    /* ── 回复语言（2026-09-15：宿主给模型的指令必须点名语言，否则模型跟上下文走）── */
    'tool.replyLang': '【回复语言】用中文回复用户（本会话的界面语言是中文）。',
    /* ── 分支决策（teamflow_start 的 needs-decision） ──────────── */
    'tool.start.decision': '【分支决策】{question}\n{options}\n（也可自定义输入）——请询问用户选择，确认后把所选选项的 value 作为 branchPolicy 重新调用 teamflow_start（如 \'new\'/\'keep\'；脏工作区选项可拆为 branchPolicy + preAction 组合），自定义分支名则传 branchName。',
    'tool.start.gitDecision': '【改动存档决策】{question}\n{options}\n——**建议用 ask_user_question 呈现**（把选项转成点选项，另加"其他"兜底），问句用自然语言（开启=这次运行的改动会单独存档、可撤销、能看清改了什么；不开启=改动直接写入文件夹，之后无法一键撤销）。确认后把所选 value 重新调用 teamflow_start（init → branchPolicy="new" + preAction="init"；keep → branchPolicy="keep" + preAction="keep-nogit"）。',
    'tool.start.gitDecisionNote': '{question}\n{options}\n{note}',
    'tool.start.gitDecisionDanger': '【改动存档决策】{question}\n{options}\n——**建议用 ask_user_question 呈现**（点选项 + "其他"兜底）。请向用户说明原因（这个位置太靠根/太特殊，开启存档会波及大量无关文件，已被系统禁止），并建议把项目放进一个单独的文件夹后重新运行。确认后把所选 value（keep → branchPolicy="keep" + preAction="keep-nogit"）重新调用 teamflow_start。',
    'tool.start.needsConfirm': '【需求确认】{question}\n{note}——**建议用 ask_user_question 呈现**（点选项 + "其他"兜底），请按此询问用户后再决定。',
    'tool.start.needsClarification': '【需求澄清】这条消息还不足以开工（意图：{intent}）——**没有启动流水线**，也没有创建任何 run。请把每个 blocker 作为**一题 ask_user_question** 问用户（题干=question，选项=readings 里的互斥读法 + "其他"兜底），拿到全部答复后**保留原始 requirement 不变**、把答复放进 requirementSupplement 重新调用 teamflow_start。不要自行替用户假设后直接重调（这正是要拦的行为）。',
    'tool.start.blockerReadings': '两种读法',
    // 探索态加固（2026-10-08）：`intent === 'exploration'` 时**追加**在 needs-clarification 返回面之后。
    // 为什么放在**返回面**而不是 ctx 注入：ctx 只在**选团队时**注入，而分诊在 `teamflow_start` 里才跑
    // ⇒ 把分诊结果喂回 ctx 结构上不可能（迟一拍）。返回面是**同一次调用内**送达，且落 journal ⇒ 可审计。
    'tool.start.explorationProtocol': '【探索态 · 一次一问】这条需求还在探索期（用户自己可能也没想清要什么）。请用 `ask_user_question` **一次只问一个问题**（不要把问题直接打在聊天里），每问带上你的倾向和一句理由；给方向时给 2–4 个候选、每个一句话说明它做什么、什么场合用。只问无法自查、答错就要返工的关键点。满足任一条就停止追问并开工：① 你已能预测剩下的全部问题；② 用户说「够了 / 就这样 / 开始吧」；③ 同一问题问过两轮。',
    // 澄清策略段落（ADR-0011 ③；2026-10-08 **重构**）：它不再是 `tool.ctx.team` 的**追加**，
    // 而是**替换** —— `teamflowContextText` 按强度**选一段**拼在上下文与「澄清完回流水线」之间。
    //
    // 为什么改（用户 2026-10-08 指出切口错了）：旧实现里「基础文案已经写了探索态该澄清」＋
    // 「追加一段 interview」是**两份叠加的文案**；而强度靠 `clarifyStrengthForTeam` **反查历史 run**
    // 得到 —— ctx 只在**选团队时**注入，所以本 run 传的值**当次注入不进去**，只影响下一次（迟一拍）。
    // ⇒ 正确切口是**手册本身**：把「探索态 ⇒ 一次一问」写成**默认行为**，不依赖任何人去设开关。
    //
    // 默认＝`interview`（一次一问）：**一次一问是产品默认，不是可选档**。`once` 保留旧文案的
    // **对齐口径**（一轮问完），当 A/B 的对照组；`off` 只服务对照（`TEAMFLOW_CLARIFY=once|off`）。
    // ⚠️ 但**两档都必须带 `ask_user_question` 指令**（2026-10-08 补）：否则 A/B 会把「一次一问」
    // 与「AUQ vs 纯文本」两个变量混在一起；而纯文本那条路径正是用户实锤的缺陷 ——
    // 新工作区首跑时主 agent 直接把问题打在聊天里（手册只写了「问什么」，没写「怎么呈现」）。
    'tool.ctx.clarifyInterview': '【需求不明确就先澄清，不要抢跑】需求只是探索/笼统时（如「我想做个 X」「帮我搞点 Y」），先跟用户对齐：**用 `ask_user_question` 问**（不要把问题直接打在聊天里），给 2–4 个方向候选（每个一句话说明它做什么、什么场合用）。对齐时**一次只问一个问题**，每个问题都带上你的倾向和一句理由（形如「我倾向 A，因为 X；你选 A 还是 B？」），让用户一眼能答；只问**无法自查、答错就要返工**的关键点，能从代码/文档自己查到的不问。**停止追问是硬要求**，满足任一条就停下来开工：① 你已经能预测剩下的全部问题；② 用户说「够了 / 就这样 / 开始吧」；③ 同一问题已经问过两轮。绝对不要一次抛出问题清单，也不要为了显得周全而编问题——猜错代价为零的不要问。',
    'tool.ctx.clarifyOnce': '【需求不明确就先澄清，不要抢跑】需求只是探索/笼统时（如「我想做个 X」「帮我搞点 Y」），先跟用户对齐：**用 `ask_user_question` 问**（不要把问题直接打在聊天里），给 2–4 个方向候选（每个一句话说明它做什么、什么场合用），只问**无法自查、答错就要返工**的关键点；能从代码/文档自己查到的不问。',
    'tool.ctx.clarifyOff': '【不开工前澄清】收到开发需求**直接调用 teamflow_start 开工**，不要先问用户任何问题。确有无法自查的缺口时，把你的假设写进 PRD 的「假设与待澄清」段——不要在开工前打断用户。（澄清强度 = off）',
    // guess = agent 自己给的倾向（ADR-0011 批 3a 的软字段）：**没有倾向也要照问** ⇒ 显式区分「无倾向」
    'tool.start.blockerGuess': '我的倾向',
    'tool.start.blockerGuessNone': '未给倾向（由你定）',
    'tool.start.blockerChanges': '影响面',
    'tool.start.blockerRework': '猜错的代价',
    'tool.start.started': '团队研发流水线已启动（runId={runId}，{status}），正在后台执行。【重要】你现在停手：不要自行读取/修改代码实现该需求，不要重复跑测试验证——实现、QA、汇报由流水线各阶段完成。你只需告知用户流水线已启动，等待流水线完成后的官方完成汇报，再向用户转述结果。可用 teamflow_status 查询进度/阶段 token；backlog 已持久化到 $DSH_HOME/teamflow。\n【回复语言】用中文回复用户。',
    'tool.start.paused': '当前会话已暂停 teamflow。如需恢复，调用 teamflow_resume_session；或直接写代码。',
    'tool.start.noTeam': '请先通过输入框旁的 🏭 按钮选择团队，再发送需求消息。未选团队时不走 teamflow。',
    'tool.start.confirmQuestion': '这条消息（「{requirement}」）更像反馈/建议（含疑问句式）而非明确开发需求。请先向用户确认：是否要实现？',
    'tool.start.confirmNote': '用户确认要实现后，请把明确需求（如「实现 combo/t-spin 触发 Toast 提示」）作为 requirement 重新调用 teamflow_start；若用户只是表达感受/讨论，直接正常回复即可。',

    /* ── 分支决策问句与选项（4 问句 / 11 选项） ────────────────── */
    'branch.q.mainClean': '工作区 {path} 当前在 main 分支（工作区干净）。流水线默认在特性分支上开发，请选择：',
    'branch.opt.newFromMain': '基于 main 新建分支开发（推荐，分支名取需求 slug，可自定义）',
    'branch.opt.keepOnMain': '直接在 main 上开发',
    'branch.q.mainDirty': '工作区 {path} 当前在 main 分支，且有 {n} 处未提交改动。请选择启动方式：',
    'branch.opt.stashNew': 'stash 现有改动后新建分支开发（推荐，改动暂存，流水线完成后 git stash pop 恢复）',
    'branch.opt.commitNew': '提交现有改动后新建分支开发（提交信息可自定义）',
    'branch.opt.keepMainDirty': '直接在 main 上继续（未提交改动将混入本次开发）',
    'branch.q.featureClean': '工作区 {path} 当前在特性分支 {branch}（工作区干净）。请选择启动方式：',
    'branch.opt.keepFeature': '沿用当前分支开发（推荐）',
    'branch.opt.newChild': '基于当前分支再新建子分支开发',
    'branch.q.featureDirty': '工作区 {path} 当前在特性分支 {branch}，且有 {n} 处未提交改动。请选择启动方式：',
    'branch.opt.stashKeep': 'stash 现有改动后沿用当前分支开发（推荐，完成后 git stash pop 恢复）',
    'branch.opt.keepDirtyFeature': '直接沿用当前分支（未提交改动混入本次开发）',
    'branch.opt.stashNewChild': 'stash 现有改动后新建子分支开发',
    'branch.opt.commitNewChild': '提交现有改动后新建子分支开发',
    'branch.decisionNote': '选项之外可自定义输入（如指定分支名）。确认选择后，请以 teamflow_start 的 branchPolicy（回传所选选项 value，如 new/keep）与 branchName/preAction/commitMessage 参数重新调用本工具。',

    /* ── 改动存档决策（非 git 工作区，2026-09-17；方案 A：问一次、记住、人话） ── */
    'git.q.noRepo': '这个文件夹（{path}）还没有开启「改动存档」。开启后：本次运行的改动会单独存成一档，随时可以整体撤销，也能清楚看到这次改了什么；不开启：改动会直接写入文件夹，之后无法一键撤销。要开启吗？',
    'git.opt.init': '开启改动存档（推荐）——将初始化版本档案{baseline}，然后开始运行',
    'git.opt.initBaseline': '，并把文件夹里现有的 {n} 个文件记录为初始状态',
    'git.opt.initNoBaseline': '（该文件夹内容较多，只开启存档、不记录现有内容为初始状态）',
    'git.opt.keep': '不开启，直接修改（本次运行的改动将无法一键撤销，也不会记录改了什么）',
    'git.q.danger': '这个位置（{path}）不适合开启「改动存档」——它太靠近磁盘根目录或系统目录，开启会波及大量与本项目无关的文件，已被系统禁止。',
    'git.opt.keepOnly': '不开启，直接修改（建议：把项目放进一个单独的文件夹后重新运行，即可开启存档）',

    /* ── 工具返回（其余工具） ──────────────────────────────── */
    'tool.status.reminder': '流水线仍在后台执行：不要自行改代码实现该需求或重复跑验证，等待完成汇报。',
    'tool.merge.command': '请用户在项目目录执行以下命令完成合回（合回后可 git branch -d {branch} 清理特性分支）：\ngit checkout main && git merge --no-ff {branch}',
    'tool.merge.kept': '已标记暂不合回：特性分支 {branch} 保留，后续可随时调用 teamflow_merge 合回',
    'tool.merge.failed': '合并失败（工作区可能不干净或有冲突）。请人工处理：先提交/处理当前工作区改动，再执行 git merge --no-ff {branch}（冲突文件需手动解决）',
    'tool.merge.merged': '✅ 已合回 main（git merge --no-ff {branch}）。如需清理特性分支：git branch -d {branch}',
    'tool.merge.noop': '当前已在 main 分支，无需合回',
    'tool.pause.ok': '已暂停 teamflow（会话 {session}）。如需恢复，调用 teamflow_resume_session。',
    'tool.pause.done': '已暂停 teamflow，当前会话不会启动流水线。',
    'tool.pause.fail': '暂停失败',
    'tool.resumeSession.ok': '已恢复 teamflow（会话 {session}）。开发需求可走流水线。',
    'tool.resumeSession.done': '已恢复 teamflow，开发需求可走流水线。',
    'tool.resumeSession.fail': '恢复失败',
    'tool.cancel.ok': '已请求取消流水线 {runId}',
    'tool.cancel.fail': '取消失败',
    'tool.resume.ok': '流水线 {runId} 已从断点「{phase}」续跑',
    'tool.resume.fail': '续跑失败：{error}',
    'tool.ctx.team': '[TeamFlow 上下文] 用户已选择「{icon} {name}」团队。【最高优先级规则】收到开发需求（新功能/迭代/重构/bug修复/代码改动请求）时，你的**唯一**正确动作是调用 teamflow_start（teamId="{teamId}"，requirement 参数忠实转写用户原话，不要自行扩写、不要臆造文件路径或技术细节）。**无论需求多小、多简单、多明确，都禁止绕过流水线自己动手实现**——不经 teamflow_start 就自己写代码/改代码/建文件来完成开发需求是违规行为，哪怕你判断「直接做更快」；需求小不是跳过流水线的理由，流水线的价值正在于 journal 留痕、QA 验证与可审计记录。收到反馈、讨论、闲聊、UI 意见等非开发请求时，才不调用 teamflow_start，直接正常回复。',
    'tool.ctx.teamTail': '【澄清完必须回到流水线】对齐后**务必**调用 teamflow_start 开工：requirement 保留用户原话，澄清得到的补充说明放进 requirementSupplement——不要聊完就停在对话里不动手。若 teamflow_start 返回 needs-clarification，按它列出的 blockers 继续问用户，再把答复放进 requirementSupplement 重新调用；**不要自行替用户假设后直接重调**。【PRD 后可能自动停下等拍板】当 PRD 里存在**主观取舍项**（多种走法同样成立、取决于用户想要什么）时，流水线会在 PRD 完成后**自动暂停**并给出确认单——**这是正常流程，不是出错**。遇到它**别把确认单原样贴成一堆文字**，分两步：· **先单独问一次总问**（`ask_user_question`，1 题）：「全部按默认直接开工（推荐）」/「我要调整几项」。⚠️ 必须单独一次——`ask_user_question` **没有条件跳转**（一张卡里的题都要答），把「全部按默认」塞进逐项那张卡里没用；选「全部按默认」就**直接调 `teamflow_resume`**，别再问后面的题。· **只有选了「我要调整几项」**，才把每个「［主观项］」做成一道选择题（单选）：首个选项放「按推荐：<它的缺省值>」，再放题面里列出的其它候选；**一次最多 4 题，多了分批**。验收条件与假设清单**不要**做成题——那是让用户**核对**的，不是选择题。· 收尾：调 `teamflow_resume`；**带 `supplement` 会把结论固化进 PRD**（此刻 PRD 之后还没跑过任何阶段 ⇒ 会**回退重跑 PRD** 并**再出一份新确认单**），不带则直接继续。所以「改」是真的能改，**别告诉他只能重开**；也别替他决定、别绕过确认单重开需求。调用 teamflow_start 之后：流水线在后台执行，你不要再自行读取/修改代码实现该需求，也不要重复跑测试验证——只需告知用户流水线已启动，等待流水线的完成汇报后再答复用户。【回复语言】用中文回复用户（本会话界面语言为中文）。',

    /* ── 工具入参错误（工具返回面） ────────────────────────── */
    'err.tool.missingKindId': '缺少 kind/id',
    'err.tool.missingKindIdTo': '缺少 kind/id/to',
    'err.tool.missingAssign': '缺少 kind/id/role/assignee',
    'err.tool.missingSessionReq': '缺少 sessionId 或需求描述',
    'err.tool.missingSession': '缺少 sessionId',
    'err.tool.missingSessionTeam': '缺少 sessionId 或 teamId',
    'err.tool.missingRunId': '缺少 runId',
    'err.tool.noSessionId': '无法获取当前会话 ID',
    'err.tool.agentNotFound': '找不到会话对应的 Agent：{sid}',
    'err.tool.startFail': '启动流水线失败：{msg}',
    'err.tool.runNotFound': '未找到运行：{id}',
    'err.tool.unknown': '未知错误',
    'err.tool.noWorkspace': '当前会话无项目工作区',
    'err.tool.noCompletedRun': '未找到已完成流水线（可传 runId 指定）',
    'err.tool.mergeAction': 'action 必须是 merge / command / keep',
    'err.tool.teamNotFound': '团队 {teamId} 不存在',
    'err.tool.sessionAgentStart': 'teamflow_start 需要由会话内的 Agent 调用',
    'err.tool.sessionAgentResume': 'teamflow_resume 需要由会话内的 Agent 调用',

    /* ── 默认流转 reason（工具入参面；事件 reason 常量不在本表） ── */
    'tool.reason.manual': '人工流转',
    'tool.reason.claim': '开发/QA 认领',
    'tool.reason.bugClaim': 'QA 缺陷认领',

    /* ── backlog 数据层（工具返回面） ──────────────────────── */
    'backlog.notFound': '找不到 {kind} #{id}',
    'backlog.badStatus': '非法状态 {to}',
    'backlog.unknownRole': '未知角色 {role}（支持 dev/qa/accept）',
    'tool.start.noRequirement': '(未提供需求)',

    /* ── 分诊（triage） ───────────────────────────────────── */
    'triage.label': '需求分诊',
    'triage.arch': '架构护栏：需求含「{word}」→ 强升 medium（需架构阶段产蓝图，防塌）',
    'triage.ui': 'UI 护栏：需求含「{word}」→ 不低于 lite（UI 改动需 QA/验收）',
    'triage.needDesign': 'needDesign=true → 强升 medium（显式要求设计阶段）',
    'triage.noSignal': '无强护栏信号，默认 full（模型不可用时宁重勿漏）',
    'triage.fallback': '（模型分诊不可用，已用正则兜底）',
    'triage.kind.full': '完整需求',
    'triage.kind.medium': '标准功能(含UI)',
    'triage.kind.lite': '微功能',
  },

  en: {
    /* ── Reply language (2026-09-15: host instructions to the model must name the language) ── */
    'tool.replyLang': '[Reply language] Reply to the user in English (this session is running with the English UI language).',
    /* ── 分支决策 ─────────────────────────────────────────── */
    'tool.start.decision': '[Branch decision] {question}\n{options}\n(custom input is allowed too) — ask the user to choose, then call teamflow_start again passing the chosen option value as branchPolicy (e.g. \'new\'/\'keep\'; dirty-workspace options can be split into branchPolicy + preAction), or pass branchName for a custom branch name.',
    'tool.start.gitDecision': '[Change-archiving decision] {question}\n{options}\n— **present via ask_user_question** (turn the options into clickable choices plus an "Other" fallback), phrased in plain words (enabling = this run\'s changes are archived separately, can be undone as a whole, and you can see exactly what changed; not enabling = changes are written straight into the folder and cannot be undone in one step later). Then RE-CALL teamflow_start with the chosen value (init → branchPolicy="new" + preAction="init"; keep → branchPolicy="keep" + preAction="keep-nogit").',
    'tool.start.gitDecisionNote': '{question}\n{options}\n{note}',
    'tool.start.gitDecisionDanger': '[Change-archiving decision] {question}\n{options}\n— **present via ask_user_question** (clickable choices + "Other" fallback). Explain the reason (this location is too close to the disk root / a special directory; archiving here would sweep in many unrelated files and has been disallowed) and suggest putting the project in its own folder. Then RE-CALL teamflow_start with the chosen value (keep → branchPolicy="keep" + preAction="keep-nogit").',
    'tool.start.needsConfirm': '[Requirement confirmation] {question}\n{note} — **present via ask_user_question** (clickable choices + "Other" fallback), then decide accordingly.',
    'tool.start.needsClarification': '[Requirement clarification] This message is not settled enough to start (intent: {intent}) — **no pipeline was started and no run was created**. Ask each blocker as **one ask_user_question** (stem = question, choices = the competing readings + an "Other" fallback); once all answers are in, RE-CALL teamflow_start keeping the original requirement unchanged and putting the user\'s answers into requirementSupplement. Do not just assume on the user\'s behalf and re-call — that is exactly what this gate blocks.',
    'tool.start.blockerReadings': 'Competing readings',
    'tool.start.explorationProtocol': '[Exploration · one question at a time] This requirement is still being explored (the user may not know exactly what they want yet). Ask via `ask_user_question`, **exactly one question at a time** (do not type the questions straight into the chat), each carrying your leaning plus a one-line reason; when offering directions, give 2-4 options with one line each on what they do and when they are used. Ask only the must-know points you cannot check yourself and whose wrong guess would cause rework. Stop asking and start building as soon as any of these holds: (1) you can already predict every remaining question; (2) the user says "enough / just build it / go"; (3) the same question has gone two rounds.',
    // Clarify-policy paragraph (ADR-0011 ③; restructured 2026-10-08): it is no longer *appended* to
    // `tool.ctx.team` but *replaces* a slot chosen by strength — see the zh block above for the rationale.
    'tool.ctx.clarifyInterview': '[Clarify first, do not jump the gun] When the requirement is exploratory or vague ("I want to build some kind of X", "help me make a Y"), align with the user first: **ask via `ask_user_question`** (do not type the questions straight into the chat), offer 2-4 concrete direction options (one line each on what it does and when it is used). While aligning, ask **exactly one question at a time**, each carrying your leaning plus a one-line reason ("I lean A because X — A or B?"), so the user can answer at a glance; ask only the must-know points you cannot check yourself and whose wrong guess would cause rework, and do not ask what you can find in the code or docs. **Stopping is mandatory**: stop and start building as soon as any of these holds: (1) you can already predict every remaining question; (2) the user says "enough / just build it / go"; (3) the same question has gone two rounds. Never dump a list of questions at once, and never invent questions to look thorough — anything whose wrong guess costs nothing is not worth asking.',
    'tool.ctx.clarifyOnce': '[Clarify first, do not jump the gun] When the requirement is exploratory or vague ("I want to build some kind of X", "help me make a Y"), align with the user first: **ask via `ask_user_question`** (do not type the questions straight into the chat), offer 2-4 concrete direction options (one line each on what it does and when it is used) and ask only the must-know points you cannot check yourself and whose wrong guess would cause rework; do not ask what you can find in the code or docs.',
    'tool.ctx.clarifyOff': '[No pre-start clarification] On a development request, call teamflow_start **immediately — do not ask the user anything first**. Where a gap is genuinely unselfcheckable, write your assumption into the PRD "Assumptions & open questions" section instead of interrupting before work starts. (clarify strength = off)',
    'tool.start.blockerGuess': 'My leaning',
    'tool.start.blockerGuessNone': 'no leaning given (your call)',
    'tool.start.blockerChanges': 'What it changes',
    'tool.start.blockerRework': 'Cost if guessed wrong',
    'tool.start.started': 'The team R&D pipeline has started (runId={runId}, {status}) and runs in the background. [IMPORTANT] Stop now: do not read or modify code to implement this requirement yourself, and do not rerun tests for verification — implementation, QA and reporting are handled by the pipeline stages. Just tell the user the pipeline has started, wait for the official completion report, and relay its result. Use teamflow_status to check progress/stage tokens; the backlog is persisted under $DSH_HOME/teamflow.\n[Reply language] Reply to the user in English.',
    'tool.start.paused': 'teamflow is paused for the current session. Call teamflow_resume_session to resume, or just write the code directly.',
    'tool.start.noTeam': 'Pick a team via the 🏭 button next to the input box before sending the requirement. Without a team, teamflow is not used.',
    'tool.start.confirmQuestion': 'This message ("{requirement}") looks more like feedback/suggestion (interrogative phrasing) than a clear development requirement. Confirm with the user first: do they want it implemented?',
    'tool.start.confirmNote': 'Once the user confirms, call teamflow_start again with the clarified requirement (e.g. "implement a combo/t-spin triggered Toast") as the requirement argument; if the user was only sharing feelings or discussing, just reply normally.',
    'branch.q.mainClean': 'Workspace {path} is currently on branch main (clean). The pipeline normally develops on a feature branch; choose:',
    'branch.opt.newFromMain': 'Create a new branch from main (recommended; the branch name comes from the requirement slug and can be customized)',
    'branch.opt.keepOnMain': 'Develop directly on main',
    'branch.q.mainDirty': 'Workspace {path} is on branch main with {n} uncommitted change(s). Choose how to start:',
    'branch.opt.stashNew': 'Stash the current changes and create a new branch (recommended; changes are stashed and restored with git stash pop after the pipeline finishes)',
    'branch.opt.commitNew': 'Commit the current changes and create a new branch (the commit message can be customized)',
    'branch.opt.keepMainDirty': 'Continue directly on main (uncommitted changes will be mixed into this development)',
    'branch.q.featureClean': 'Workspace {path} is on feature branch {branch} (clean). Choose how to start:',
    'branch.opt.keepFeature': 'Keep developing on the current branch (recommended)',
    'branch.opt.newChild': 'Create a child branch from the current branch',
    'branch.q.featureDirty': 'Workspace {path} is on feature branch {branch} with {n} uncommitted change(s). Choose how to start:',
    'branch.opt.stashKeep': 'Stash the current changes and keep the current branch (recommended; restored with git stash pop afterwards)',
    'branch.opt.keepDirtyFeature': 'Keep the current branch as is (uncommitted changes are mixed into this development)',
    'branch.opt.stashNewChild': 'Stash the current changes and create a child branch',
    'branch.opt.commitNewChild': 'Commit the current changes and create a child branch',
    'branch.decisionNote': 'Custom input beyond these options is allowed (e.g. a specific branch name). After the user confirms, call this tool again with teamflow_start\'s branchPolicy (pass back the chosen option value, e.g. new/keep) plus branchName/preAction/commitMessage.',

    /* ── Change-archiving decision (non-git workspace, 2026-09-17; plan A: ask once, remember, plain words) ── */
    'git.q.noRepo': 'This folder ({path}) does not have change archiving enabled yet. With it on: this run\'s changes are archived separately, can be undone as a whole at any time, and you can see exactly what changed. Without it: changes are written straight into the folder and cannot be undone in one step later. Enable it?',
    'git.opt.init': 'Enable change archiving (recommended) — the version archive will be initialized{baseline}, then the run starts',
    'git.opt.initBaseline': ', with the {n} existing files recorded as the initial state',
    'git.opt.initNoBaseline': ' (this folder has many files: archiving is enabled but existing content is NOT recorded as the initial state)',
    'git.opt.keep': 'Do not enable — modify directly (this run\'s changes cannot be undone in one step and will not be recorded)',
    'git.q.danger': 'This location ({path}) is not suitable for change archiving — it is too close to the disk root or a system directory; enabling it would sweep in many unrelated files and has been disallowed.',
    'git.opt.keepOnly': 'Do not enable — modify directly (suggestion: put the project in its own folder and run again, then archiving can be enabled)',

    /* ── 工具返回（其余工具） ──────────────────────────────── */
    'tool.status.reminder': 'The pipeline is still running in the background: do not modify code for this requirement or rerun verification yourself; wait for the completion report.',
    'tool.merge.command': 'Ask the user to run the following command in the project directory to complete the merge (afterwards they can delete the feature branch with git branch -d {branch}):\ngit checkout main && git merge --no-ff {branch}',
    'tool.merge.kept': 'Marked as not merged for now: feature branch {branch} is kept and teamflow_merge can be called later',
    'tool.merge.failed': 'Merge failed (the workspace may be dirty or have conflicts). Handle it manually: commit or resolve workspace changes first, then run git merge --no-ff {branch} (conflicts must be resolved by hand)',
    'tool.merge.merged': '✅ Merged back into main (git merge --no-ff {branch}). To delete the feature branch: git branch -d {branch}',
    'tool.merge.noop': 'Already on branch main, nothing to merge back',
    'tool.pause.ok': 'teamflow paused (session {session}). Call teamflow_resume_session to resume.',
    'tool.pause.done': 'teamflow paused; this session will not start pipelines.',
    'tool.pause.fail': 'Pause failed',
    'tool.resumeSession.ok': 'teamflow resumed (session {session}). Development requirements can use the pipeline again.',
    'tool.resumeSession.done': 'teamflow resumed; development requirements can use the pipeline again.',
    'tool.resumeSession.fail': 'Resume failed',
    'tool.cancel.ok': 'Cancellation of pipeline {runId} requested',
    'tool.cancel.fail': 'Cancel failed',
    'tool.resume.ok': 'Pipeline {runId} resumed from checkpoint "{phase}"',
    'tool.resume.fail': 'Resume failed: {error}',
    'tool.ctx.team': '[TeamFlow context] The user selected the "{icon} {name}" team. [Highest-priority rule] When you receive a development requirement (new feature / iteration / refactor / bug fix / code change request), the ONLY correct action is to call teamflow_start (teamId="{teamId}", transcribe the user\'s own words faithfully into the requirement argument; do not expand it, do not invent file paths or technical details). No matter how small, simple or clear the requirement is, you are FORBIDDEN to implement it yourself bypassing the pipeline — writing/changing code or creating files yourself to fulfill a development request without teamflow_start is a violation, even if you think doing it directly is faster. A small requirement is not a reason to skip the pipeline: its value is precisely the journal trail, QA verification and auditable records. Only for feedback, discussion, small talk or UI opinions should you not call teamflow_start — just reply normally.',
    'tool.ctx.teamTail': '[After clarifying, come back to the pipeline] Once aligned you MUST call teamflow_start to start the work: keep the user\'s own words in requirement and put the clarifications into requirementSupplement — do not stop at the conversation. If teamflow_start returns needs-clarification, keep asking the user about the blockers it lists and re-call with requirementSupplement; do not silently assume on the user\'s behalf. [The pipeline may pause after the PRD for sign-off] When the PRD contains **subjective trade-offs** (several options are equally defensible and the choice is about what the user WANTS), the pipeline **pauses automatically** after the PRD and returns a confirm sheet — this is **normal flow, not an error**. When it happens, **do not paste the sheet as a wall of text** — do it in two steps: · **first ask one leading question on its own** (`ask_user_question`, a single question): "Just go with all the defaults (recommended)" / "I want to change a few items". ⚠️ This must be its own call — `ask_user_question` has **no conditional skip** (every question on a card must be answered), so stuffing "all defaults" into the per-item card does nothing. If they pick "all defaults", **call `teamflow_resume` straight away** and stop asking. · **Only if they picked "change a few items"**, turn each "[taste]" item into one single-choice question: first option = "Recommended: <its default>", then the other candidates the question text lists; **at most 4 questions per call, batch if more**. Do **not** turn acceptance criteria or the assumptions list into questions — those are for the user to **read**, not to choose. · To finish: call `teamflow_resume`; **passing `supplement` bakes the decisions into the PRD** (no stage has run after PRD yet ⇒ it **re-runs PRD** and returns a **fresh confirm sheet**), omitting it just continues. So changing really works — **never tell them the only way is starting over**; never decide for them, and never bypass the sheet by restarting the requirement. After calling teamflow_start the pipeline runs in the background: do not read or modify code for this requirement and do not rerun verification yourself — just tell the user the pipeline has started and answer them after the pipeline reports completion. [Reply language] Reply to the user in English (this session uses the English UI language).',

    /* ── 工具入参错误 ──────────────────────────────────────── */
    'err.tool.missingKindId': 'missing kind/id',
    'err.tool.missingKindIdTo': 'missing kind/id/to',
    'err.tool.missingAssign': 'missing kind/id/role/assignee',
    'err.tool.missingSessionReq': 'missing sessionId or requirement',
    'err.tool.missingSession': 'missing sessionId',
    'err.tool.missingSessionTeam': 'missing sessionId or teamId',
    'err.tool.missingRunId': 'missing runId',
    'err.tool.noSessionId': 'cannot determine the current session id',
    'err.tool.agentNotFound': 'No Agent found for the session: {sid}',
    'err.tool.startFail': 'Failed to start the pipeline: {msg}',
    'err.tool.runNotFound': 'Run not found: {id}',
    'err.tool.unknown': 'unknown error',
    'err.tool.noWorkspace': 'The current session has no project workspace',
    'err.tool.noCompletedRun': 'No completed pipeline found (pass runId to pick one)',
    'err.tool.mergeAction': 'action must be merge / command / keep',
    'err.tool.teamNotFound': 'Team {teamId} does not exist',
    'err.tool.sessionAgentStart': 'teamflow_start must be called by an Agent inside a session',
    'err.tool.sessionAgentResume': 'teamflow_resume must be called by an Agent inside a session',

    /* ── 默认流转 reason ──────────────────────────────────── */
    'tool.reason.manual': 'manual transition',
    'tool.reason.claim': 'claimed by dev/QA',
    'tool.reason.bugClaim': 'QA defect claimed',

    /* ── backlog 数据层（工具返回面） ──────────────────────── */
    'backlog.notFound': 'Cannot find {kind} #{id}',
    'backlog.badStatus': 'Invalid status {to}',
    'backlog.unknownRole': 'Unknown role {role} (supported: dev/qa/accept)',
    'tool.start.noRequirement': '(no requirement provided)',

    /* ── 分诊 ─────────────────────────────────────────────── */
    'triage.label': 'Requirement triage',
    'triage.arch': 'Architecture guardrail: the requirement contains "{word}" → forced up to medium (an architecture stage must produce a blueprint to avoid collapsing)',
    'triage.ui': 'UI guardrail: the requirement contains "{word}" → not below lite (UI changes need QA/acceptance)',
    'triage.needDesign': 'needDesign=true → forced up to medium (design stage explicitly requested)',
    'triage.noSignal': 'No strong guardrail signal; defaulting to full (prefer heavier over missing when the model is unavailable)',
    'triage.fallback': '(model triage unavailable, regex fallback used)',
    'triage.kind.full': 'Full requirement',
    'triage.kind.medium': 'Standard feature (with UI)',
    'triage.kind.lite': 'Minor feature',
  },
}
