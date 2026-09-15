/**
 * dsh-plugin-teamflow — 工具与分诊面词典（zh / en）。
 *
 * 消费区：host/index.ts（`teamflow_*` 工具返回/render/错误串、分支决策问句与选项）、
 * core/triage.ts（分诊理由与档位词表）、core/backlog.ts（工具面错误串与默认 reason）。
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
    'tool.start.needsConfirm': '【需求确认】{question}\n{note}——请按此询问用户后再决定。',
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
    'tool.ctx.team': '[TeamFlow 上下文] 用户已选择「{icon} {name}」团队。只有收到明确的开发需求（新功能/迭代/重构/bug修复/代码改动请求）时才调用 teamflow_start 并指定 teamId="{teamId}"，requirement 参数忠实转写用户原话即可（不要自行扩写、不要臆造文件路径或技术细节）。收到反馈、讨论、闲聊、UI 意见等非开发请求时，不要调用 teamflow_start，直接正常回复。调用 teamflow_start 之后：流水线在后台执行，你不要再自行读取/修改代码实现该需求，也不要重复跑测试验证——只需告知用户流水线已启动，等待流水线的完成汇报后再答复用户。【回复语言】用中文回复用户（本会话界面语言为中文）。',

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
    'tool.start.needsConfirm': '[Requirement confirmation] {question}\n{note} — ask the user accordingly before deciding.',
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
    'tool.ctx.team': '[TeamFlow context] The user selected the "{icon} {name}" team. Call teamflow_start with teamId="{teamId}" only for a clear development requirement (new feature / iteration / refactor / bug fix / code change request), and transcribe the user\'s own words faithfully into the requirement argument (do not expand it, do not invent file paths or technical details). For feedback, discussion, small talk or UI opinions, do not call teamflow_start — just reply normally. After calling teamflow_start the pipeline runs in the background: do not read or modify code for this requirement and do not rerun verification yourself — just tell the user the pipeline has started and answer them after the pipeline reports completion. [Reply language] Reply to the user in English (this session uses the English UI language).',

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
