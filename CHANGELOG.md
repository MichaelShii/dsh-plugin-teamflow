# Changelog

> 本插件首次公开发布版本为 **v0.1.0**；发布前的内部迭代（v0.3~v0.13）记录于 `AGENTS.md` §5，对外统一归到 v0.1.0。

## [0.2.0] - 未发布

> 开发线分支：`release-v0.2.0`。`main` 与 npm `latest` 保持一致，只接收发布合入；本段随开发陆续补齐，发布时统一定稿日期与 `docs/releases/v0.2.0.md`。

### 新增
- **流水线可以直接中断了（界面三处按钮 + host 取消门禁）**：此前 `teamflow_cancel` / `teamflow.cancel(runId)` 与取消语义都在（Remote 描述符 + 服务方法 + 模型工具三件套齐备），**唯独客户端一个调用点都没有**——触发了流水线就只能等它跑完，或去跟模型说一句。现在：**会话内工作台顶栏**「⏹ 中断 #xxxxxx」、**全局面板 run 行**、**run 详情头**（右栏 tab 与面板浮层）三处入口，共用同一个 `CancelButton`（**两段式内联确认**：首次点击进入「确认中断?」、3 秒内再点才执行——客户端没有宿主 confirm/对话框依赖，不引新依赖；面板里整行可点开详情，按钮自己 `stopPropagation`）。中止动作走 **DSH 原生 `SubagentRun.dispose()`**（官方契约「cancel remaining work, reach child quiescence」；宿主另有 `subagents.interruptByParent`，但它只服务 continuable 常驻子代理，流水线用的一次性 run 不能走它）。**顺带修掉一个既有缺陷**：`cancelRun` 原先对「内存里存在」的任何 run 都置 `cancelled` 并返回成功——对已完成的 run 是污染 journal，对重启后回填的 interrupted run 是「提示成功但状态永远不变」；现加 `status !== 'running'` 门禁（running 是唯一真实活动态），取消失败对界面可见（工作台报「已不在运行中」，面板给提示），而**阶段间隙（`inFlight` 为空）仍可取消**。取消只置位不改状态机：终态由收尾逻辑落定（`cancelled` + 不提交 + 保留断点续跑入口）。已知边界（写进 `AGENTS.md` §5）：`inFlight` 每个 run 只记最后启动的那个子代理，**并发 dev 子任务的兄弟不会被立即 dispose**（跑到自然结束，下一个检查点不再启动新阶段）。回归门禁：新增 **`test/cancel.test.js`（30 断言，真行为级）**——门禁真值表 / 置位 + dispose + 落盘 / 阶段间隙可取消 / dispose 抛错不吞取消 / descriptor↔服务↔三处 UI 入口同源；为此把 `cancelRun` 从 `pipeline.ts` 移到 `core/context.ts`（pipeline 链到 `report→@deepseek-ai/dsh-llm` 这个宿主私有 peer，仓库内没有 `node_modules`，行为级测试取不到它）。**顺带修一处被实测截图暴露的文案**：阶段被中断时显示「已关闭」（en: `Closed`）——`client/locales.ts` 的 `status.*` 是 backlog 卡片词表（`closed`/`cancelled`/`verified` **都**译「已关闭」），阶段渲染此前直接复用它；现在阶段面单独取词 `stageStatus.cancelled` =「已中止 / Stopped」（不撞 `runStatus` 的「已中断 / 已取消」，其余阶段状态仍共用同一张表），并去掉两处同义重复/误标：阶段行里多余的原文 `cancelled` chip、「尝试历史」把被中止的尝试显示成「进行中」。**相位组头取色同理修正**：`layoutFlow` 的 `anyFail` 原先把 `cancelled` 与 `failed`/`needs-human` 并列 → 用户主动中断的相位组头被涂成**错误色（红）**，而同一节点里阶段卡竖条与「已中止」chip 是灰的（`STATUS_COLOR.cancelled = text2`）= 红头灰身；删掉该判定后组头与连线落到兜底灰（与 chip 同色），真失败仍为红（**不会误变绿**——`allDone` 要求每个阶段都 `done`）。**并发中断硬化（实测两个独立缺陷）**：① **队列补位**——`util.runPool` 的 worker 拿到被取消任务的 `null` 结果后立刻取下一个任务并起新子代理，表现为「中断了又自动启动一个」；现加可选 `shouldStop`（取任务前判定），dev 与 resume 补跑两处传 `() => journal.cancelled`，未启动条目结果为 `undefined`（调用方按 `r &&` 过滤，resume 补跑循环补 `if (!t) continue`）。② **只停最后一路**——`inFlight` 旧形状是每 run 一个 `{run, stage}`（后启动覆盖前一个），`cancelRun` 只 dispose 那一个，并发 dev 的兄弟继续跑（「开发的多 agent 中断不了」）；现改为 `runId → Map<stage, run>` + `trackInFlight`/`untrackInFlight`，取消**遍历 dispose 全部**在飞子代理，并对 `dispose()` 的 Promise 挂 `.catch`。**③ 取消后径直进 QA（resume 路径）**：dev 收口的两个判断（取消检查、提测门禁）原先只写在「新开发」分支里，**resume 补跑分支没有** → 从断点重跑时中断，三路 dev 全「已中止」却立刻起了一个 QA 子代理（更早的隐患：resume 补跑失败也会带着已知缺口直接进 QA，正是 r26 实锤「T2 failed → QA 450k 白烧」的形态）。现把两者移到两分支的**汇合点**，且顺序为先取消检查后提测门禁（取消时任务的 failed 只是「没跑完」，不记成提测失败转人工）。`runPool` 同步搬到 `host/util.ts`（无宿主私有依赖 → 行为级测试可直接喂 items 断言）

### 改进
- **仓库发布流程正规化（对贡献者可见）**：`main` 只承载「已发布到 npm 的内容」，日常开发与文档改动落在当前 release 分支（`release-vX.Y.Z`），**贡献者向最新 release 分支提 PR**；发布时 release 分支 → PR → squash 合入 main → 打 tag → 发 GitHub Release → 另起下一条分支。同时落定两条 SOP 判据：**发布是否成功以写路径为准**（registry 读路径 `npm view` / packument / 版本端点可滞后数分钟；重发得到的 403 `cannot publish over the previously published versions` 才是权威回执，且幂等安全无副作用）；**`git push` 连不上先查本机 VPN/TUN 状态**，不要凭「换成 HTTP/1.1 后成功」归因（实测同一 h1 命令在链路恢复前也会失败，属伪相关）。细则见 `AGENTS.md` §4 与 `CONTRIBUTING.md`

- **README 精简（面向使用者 / 贡献者分家）**：① **核心特性 17 → 8 条**——原小节把「使用者要什么」和「实现怎么做的」混在一起（沙箱约束原委、`$DSH_HOME` 路径、LangGraph checkpointer 语义、`FRESH_TOKEN_BUDGET` 阈值、93% 实测占比、`git rm --cached` 操作指引……），中文 3 924 / 英文 8 287 字符（英文最长单条 1 193 字符），且有重复（「单任务模型」与「状态机 + 事件日志」同讲一件事、4 条都在讲「文件放哪」）；现为 8 条能力描述（中文 **968** / 英文 **2 602** 字符）。② **版本锚定压缩**：1720 → **581** 字符（en 2 156 → 1 130）——保留兼容窗口 `engines.dsh` 声明、`latest`/`next` 提醒与两条升级核对点，历次核对结论与待跟进项移交给 `CHANGELOG` 0.1.6–0.1.9 与 `docs/TODO.md`。③ **目录结构压缩**：1225 → **845** 字符（en 1 470 → 1 211）——保留顶层树与「host 必须构建」，逐文件说明指向 `CONTRIBUTING.md`。机制细节全部保留在 `AGENTS.md` §4–§5 与 `CHANGELOG`；唯一留在 README 的操作指引是「历史提交混进 `logs/teamflow/` 时用 `git rm -r --cached` 移出」。④ **架构（阶段 3）压缩**：1079 → **718** 字符（en 1 384 → 1 024）——保留宿主组合树，两条硬约束压成一句，完整论证落进 `AGENTS.md` §3（「不用 `@Remote` 装饰器」+「必须是宿主级插件」及其沙箱依据）；顺带**删掉会漂移的 Remote 方法数量**（zh 原写 22、en 原写 17，实测两者都已过期）

## [0.1.9] - 2026-09-16

### 新增
- **host 侧响应与产物语言跟随界面语言（中英双语，P2）**：英文用户此前看到的工具返回、完成汇报、流水线日志与产物正文（PRD/QA-REPORT/ACCEPTANCE）仍是中文，产品呈现割裂。语言源链＝**客户端推送**（浏览器当前语言/系统探测，经既有 Remote 面 `teamflow/setLocale`）> **宿主用户显式选择** > **`en` 默认**；run 起跑时解析一次并落 run 级快照（`journal.locale`）——**同 run 语言一致、断点续跑沿用、切语言只影响之后新起的 run**；headless（无客户端）走兜底链不报错。覆盖面：11 个 prompt 工厂 + AGENTS.md/memory 模板 + 产物语言指令 + 工具返回/分支决策/完成汇报/日志/诊断/state 注入块/triage 理由。**判据层只增不改**：验收结论行 zh 四档逐字保留并新增 en 四档（`✅ Pass / ⚠️ Conditional pass / ❌ Fail / 📝 Not applicable`；解析器同时兼收 `Not passed` 等价写法）、缺陷表新增 en 表头、triage 关键词新增英文项（中文项一字不动，实测 19 个中文样本档位 0 漂移）、L2 语料只增 6 条 en 样例。仓库 `docs/` 与代码注释**不做双语**（注释统一中文）。独立验收 46/46：11 工厂 + 2 模板 en 产出 **CJK 0 处**、zh 侧逐字不回归、语言链异常不冒泡
- **ADR-0009：不做插件级用户记忆层（否决记录）**（`docs/adr/0009-user-layer-memory.md`）——曾设计插件自建跨产品线用户层（`_user/{memory.md,index.json}` + 流水线启动时注入索引 + acceptance write-back），**经复核否决**。理由：① **场所错位**——用户偏好是多轮对话的产物，流水线是「一需求一链路」批处理，不存在该场所；② **输入不足**——流水线任一时刻只有当前产品线上下文，「跨产品可复用」的普适性只能靠猜；③ **替代路径已够且已实现**——跨产品用户约定写宿主原生的 `$DSH_HOME/AGENTS.md`（`dsh-agent-instructions` 已无条件注入，插件零代码），插件硬规矩直接进 prompt/模板（`TOKEN_HYGIENE` / `LOG-LAYOUT-SCOPED` / `DOC-BOUNDARY-POLICY` 等）；④ **突破 ADR-0002 写域边界**。**零运行时改动**，仅留决策记录与再评估触发信号。同步 ADR 索引：README / README.en / CONTRIBUTING / AGENTS 四处（AGENTS 原为 `0001~0007`，漏了 0008，一并补齐）
- **工作区 key 迁移演练脚本（只读）**：`scripts/migrate-workspace-key-dryrun.mjs`——扫描 `$DSH_HOME/teamflow/<key>/`，从 `runs/*.json` 的 `workspacePath` 反推来源路径，用与 `store.ts` 同源的 `slugPath` 重算期望 key，产出「逐目录判定（OK/DRIFT/LEGACY/EMPTY/FALLBACK）+ 按路径分组的合并计划 + 同名文件内容冲突检测」。**不写任何数据**（`--out <file>` 只写报表）。用于给「`workspaceScopeOf` 的 UUID 分支不可达 → key 绑路径字符串」这个已知风险定价：本机实测 11 个目录 → 自洽 4、**漂移 0**、旧格式 1、空壳 6，故该风险尚未造成数据分裂，迁移优先级按风险而非损失排（详见 `docs/TODO.md`）

### 修复
- **缺陷卡点开看不出「缺陷是什么」**：QA 报告里写好的复现步骤/期望行为/实际行为/关联验收项四列此前**被整列丢弃**（解析只留编号/严重级/模块，建卡时四个字段硬编码空串，下发面也没有这几个字段）→ backlog 里点开一张缺陷卡，只看到「QA 缺陷：R3-1」+ 关联 run 的原始需求。现：解析新增富行（四列 + 原始表头映射），缺陷卡存全并幂等刷新、标题自解释（`R3-1 · 日志/注入面`）、下发面补齐字段，工作台两处详情抽屉都新增「缺陷详情」块；**并让 QA 打回修复时的缺陷清单也带上完整描述**（dev 直接看到复现/期望/实际）。附带：QA 表格单元格内的字面量 `|` 现在要求转义 `\|`（不转义会切开单元格、后续列错位）
- **英文界面下「人看得见的三处」仍是中文（首次英文 run 实测发现）**：① **阶段子代理的回复语言**此前无人约束（只约束了产物文件的语言）→ 文件是英文、工作台里「阶段性产物」却是中文（子代理跟着中文上下文回复）；现由 `productCtx`（11 个阶段共用前缀）统一声明 `[Reply language]`，一处覆盖全部阶段。② **给模型的工具返回/会话注入**没点名回复语言 → 主会话模型仍用中文答复用户；现显式写入「用当前语言回复用户」。③ **团队名/描述**来自用户数据 `teams.json`（只有中文）→ 英文界面下拉里是中文；现支持可选 `nameEn`/`descriptionEn`（**不改写存量文件**，内置团队按 id 回落英文），并由宿主按当前语言本地化后下发。顺带：run 日志里的阶段名改走已有的 `phaseLabel`（原先直出 `teams.json` 的中文 label）
- **QA 缺陷解析误登记（一条流水线因此被误停线）**：旧 `parseDefects` 按**列位置**认缺陷（任一含 `|` 的行 + 第 2 格 ∈ P0-P3），于是 QA 报告里的「round-2 缺陷**复验对照**」表（第 3 格是结论「已关闭」）被登记成一个新的 P2 缺陷 → 每轮复验都重生一个阻断缺陷 → **第 3 轮必然超限停线并跳过产品验收**（自我实现的停线，与交付质量无关）。现改为**按表头认表**：只有表头显式声明严重级列（`严重级(P0/P1/P2/P3)` / `Severity (P0/P1/P2/P3)`）的表格才解析，列位置由表头决定，无严重级表头的表格整表跳过。回归门禁：L2 语料新增真实停线形态 + `test/verdict.test.js` 5 条断言（conformance 18/18 → 19/19）
- **未验收的 run 不再邀请合回 main**：完成汇报的合回指引旧条件只有「状态 completed 且无 error」——QA 超限时流程提前结束、验收被跳过，status 仍是 completed，汇报照样写「验收已通过，请询问用户是否合回」，会诱导用户在未验收时合回。现要求「已完成 + **无人工介入** + **验收阶段真的 done**」，并在需人工介入且验收未跑时显式提示「本轮未完成产品验收…不要据此合回 main」
- **en 文案残留的全角标点**：护栏中止摘要的连接符（`runner.ts`）改走词典（en 出半角冒号）；en 验收档位行的全角 `／` 改半角 ` / `（zh 侧逐字不变）；`store.ts` 运行日志**文件头**随 run 语言；`RETRY_SUFFIX` 补 `attempt N`（词典 `dev.taskRetry` 的实际产出，无 `taskKey` 的兜底路径上任务标题归一不再漏剥离）
- **收口提交静默失效 4 天：run 跑完却没有 commit（2026-09-11 → 09-15 全部如此）**：英文 lite run 验收时发现产物**全是 staged 但没有 commit**（`git log` 空、`.git` 无 reflog / 无 `COMMIT_EDITMSG`，而 12 个 blob 与索引的写入时间正是 run 收尾那一刻），而 journal 里 `commitDone`/`commitSkip`/`commitFail` **三条一条都没有**——故障完全不可见。根因：上一版「收口提交面」的两处写法互相拆台——`ensureLogGitignore()` 先把 `logs/teamflow/` 写进 `.gitignore`，紧随其后的 `tfAddArgs()` 又用**负 pathspec** `:(exclude)logs/teamflow` **点名**这个「显式点名且被忽略」的路径，git 直接报错**退出 1**（`The following paths are ignored by one of your .gitignore files`；索引其实已写好 → 现场就是「文件 staged 但没有 commit」）；而 `add === null ? null : git commit(...)` 用 add 的结果**短路**了提交，`if (cm !== null) … else if (add !== null) …` 又让三条日志一条都不触发。`:(exclude)logs/teamflow/**`、`:(exclude,glob)`、`:(exclude,literal)`、`-c advice.addIgnoredFile=false` 四种变体实测同样 exit 1。**修复（①+③）**：① `tfAddArgs()` 收敛为 `git add -A -- .`（忽略交给刚写好的 `.gitignore`，它才是整树 add 的唯一依赖），并新增 `sanity.tfUnstageArgs()`（`git rm -r --cached --ignore-unmatch -- logs/teamflow`，只动索引不删文件）作为**索引兜底**紧随 add 执行——真摘出东西会记 `log.logsUnstaged` warn（那是 `.gitignore` 防线失效的信号）；③ 提交不再被 add 结果短路：永远尝试提交，由提交结果分派 `commitDone`/`commitSkip`/`commitFail`（「无事可做」先用 `git status --porcelain` 空判定，`GIT_NOTHING_TO_COMMIT` 兜措辞），`gitCmd` 之外新增 **`gitRun`**（`{ok, out, error}`，失败原因进日志）——**失败可以处置，但不能不可见**。回归门禁：新增 **`test/commit-path.test.js`（真 git 集成）**——负 pathspec exit 1 的防回退锁、写规则→整树 add→索引兜底→commit 真跑通（断言提交树里没有 `logs/teamflow`）、兜底真摘出东西、失败分类；`test/gitignore.test.js` 与 smoke 断言同步改到新机制（smoke 新增「零回退」断点）。**部署后需重启 `dsh --profile web`**；此前失效期间产生的未提交 run（assetd 09-11、slugkit-en、durparse-en）需人工 `git add -A -- . && git commit`（插件不再回头补提交）

### 改进
- **QA 轮次收敛埋点（D 方案先测量再立法）**：52 个历史 run 的实测显示「真正需要第 3 轮修复」**从未发生**（打回 7/52、触达上限 1/52，且唯一那次是幻影），而「同一缺陷原样复现就早停」这条判据**按缺陷 id 判不出来**——QA 每轮重新编号（r9 三轮分别 `QA-*` / `R2-*` / `R3-*`）。所以不急着动状态机，先把数据攒起来：QA 循环每轮把阻断集合的**稳定身份**与增/减/停滞计数写进 `journal.qaRounds`（`{round, seq, blocking, p3, defects:[{id,sev,module,fp}], withCheck, withCriterion, qaCalls, fixCalls, gate, newFps, repeats, resolved, outcome}`，留最近 12 轮）。**身份优先级**：缺陷行自带的**检测命令**（B 方案起 QA 必填，机器写给机器看，最稳）> 模块+实际行为文本 > 缺陷 id（最不稳）。配套**只读读侧** `node scripts/qa-rounds-report.mjs`：逐 run 轮次表 + 聚合（收敛 vs 停滞次数、检测命令可用率 = B 落地率、门禁落地率 = A 落地率、单轮成本），让「要不要把 `QA_REWORK_LIMIT` 换成收敛判据」这个问题有数据可答。**埋点只记录、不改变任何行为**（纯函数 `util.defectFingerprint`/`compareDefectRounds`/`qaRoundEntry`，可单测）
- **QA 打回超限时不再「验收整段跳过」（E 方案：已知问题只读验收）**：旧行为是 QA 复验超限 → 跳过产品验收 → 人工只拿到一个 needs-human 旗标，**任务夹里连 `ACCEPTANCE.md` 都没有**（实锤 tf-mu2ioilr-95l4th：那份验收记录是维护者事后手写的）。现在改成：超限时仍以 **「已知问题」只读模式**跑一次验收，产出交付级视图（逐条 AC 核对表 + **未闭环阻断缺陷清单**，含各自的检测命令）。**硬约束（信息而非判定）**：结论一律**强制为需人工裁定**——prompt 明写"结论只能是 ⚠️/❌，且本 run 不会被提交或合回"，host 侧照旧 `humanIntervention=true`、`mergeEligible` 保持 false（`accepted` 永不放行），验收失败也**不改变 run 结局**（只记 warn，保持 completed + needs-human）。汇报里新增 `report.knownIssuesNoMerge`：显式说「结论被强制为需人工裁定，不要据此合回 main」——否则 `acceptanceDone` 变真会让旧的「验收未跑、不要合回」警告消失（这正是这条改动最容易踩的坑）。定价依据（52 个真实 run）：验收阶段 **p50 10 / p90 21 calls ≈ 一个 run 的 6%**，而「需人工介入且验收未跑」历史发生 1 次——便宜且不是假设。回归：L1 新增 `ACCEPTANCE-KNOWN-ISSUES`／`ACCEPTANCE-NORMAL-NO-KNOWN-ISSUES`（后者保证常规验收 prompt 零回归），smoke 新增 5 条；`log.accSkipped`（旧的「跳过验收」文案）随之删除
- **QA 打回闭环：治「修复不完整」而不是「少发现缺陷」（A/C/B 三件套）**：先纠正一个前提——维护者问「打回→修→打回→修 有没有解」，实测 r9 那次的停线**是幻影**（报告第 3 节的「round-2 缺陷复验对照」表被旧位置判定读成新 P2 缺陷；用修好后的解析器现场重放该真实报告 → **0 阻断**），真实轨迹是 **6 → 1 → 0 在收敛**，唯一那轮真实返工的病因是**修复不完整 / 扫描面不完整**（round-1 只改了看得见的实例，同类 4 处留在 `prompts/index.ts`）。故落地三件套：**A. 类别门禁**——`qaFixPrompt` 要求每个 P0–P2 修复落**永久可执行门禁**（verify 套件断言，或随检查一起提交的 grep/脚本断言：修复前失败、修复后通过）+ 证据块给 `gate:` 与 `class sweep:`（类别命中数 before→after）；policy 级，缺失由新增的 `FIX_GATE_PATTERN` 记 warn 留痕（host 证明不了门禁真存在，不做硬失败，避免形式主义）。**B. 缺陷的「可执行定义」**——QA 缺陷表新增 `检测命令` + `通过判据` 两列（P0–P2 必填）：`检测命令` 是**现在就能失败**的那条命令、`通过判据` 是修好后的期望输出；修复方据此验收、复验方据此回归、**误报用它当场证伪**（r9 的 R2-2a QA 误报在 round-3 就是靠一条命令自证的）。同步：富行解析新增两字段（`parseDefects` 瘦身投影形状不变、旧报告零回归）、缺陷卡持久化两列、`itemDetail` 下发、两处详情抽屉渲染；新增 L2 语料 `qa-report-check-columns.md`（conformance 19/19 → **20/20**）。**顺带修一个真 bug**：表格行原先无条件 `split('|')`——QA 按契约转义的 `\|` 照样被切开（R3-2 的「实际」串进「关联验收项」的实锤根因），而检测命令列几乎必然含 `|`；现改为**按未转义管道符切分并还原 `\|`**。**C. 复验复用**——复验轮经 `state.__runCtx.qaReverify` 显式声明（`QAREVERIFY`，不改 11 个工厂签名）：**先原样重跑上一轮探针**（就在 `logs/teamflow/<runId>/scripts/`，正是日志收口决定归档留存的那一类）**再补上一轮没覆盖的面并说明漏在哪**，必须重跑缺陷行自带的检测命令、**不得重造已有基线**（r9 实测后一轮重做了一整份 HEAD 副本 = 50 文件/1 MB）。回归：L1 新增 `FIX-CLASS-GATE`／`QA-DEFECT-EXECUTABLE-DEFINITION`／`QA-REVERIFY-REUSE`／`QA-FIRST-PASS-NO-REVERIFY-NOISE` + `test/verdict.test.js` 新增 6 条断言（含转义管道符与错列门禁）。**未动流程语义**（轮次上限、QA 独立探针要求保持原样——质量第一约束，见 `docs/TODO.md`）
- **运行日志的根离开用户项目 + 只留有用的（`logs/teamflow` 不再长期躺在你的仓库里）**：此前命令日志直接落在项目内**没有任何清理逻辑**（实测 `products/tetris` 累计 1042 文件/17.3 MB、本插件仓 136 文件/3.0 MB），文件树遍历类工具（eslint/prettier/IDE 索引/agent 全局 grep/无 `.npmignore` 的 npm publish）都会看到它。为什么不干脆一步写进 `$DSH_HOME`：**子代理受 DSH 文件沙箱约束**——`workspace-write` 只允许写会话工作区 + 平台临时区，写 `$DSH_HOME` 直接 `FS_SANDBOX_DENIED`（实测：子代理写 `C:\Users\<u>\.dsh\...` 三步全拒，同构命令写工作区内 exit 0；`$env:TEMP` 又是**每会话**子目录、不可依赖），而 host 进程不受该约束。故改为**两段式**：子代理在工作区暂存（`logs/teamflow/<runId>/`）→ **run 终态由 host 过滤归档到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删除项目内副本**（host 自身事件日志 `run.log` 直接落归档位）。**归档只留有用的**：维护者一句「logs 里的文件基本都是没用的吧」促使实测——一次真实 run 130 文件/3.03 MB 里 **93% 是可重跑的命令输出或 git 里一模一样的源码快照**（41% `regression-*.log`+`*.out`、35% `probe/head/**` 快照、17% prompt JSON dump），唯一不可重跑且真被用过的 7% 就是检查脚本。因此归档面收敛为**白名单**：code 扩展名（`.mjs/.cjs/.js/.sh/.ps1/.py/.md`）+ `captures.json` 保留，命令输出（`*.log`/`*.out`/`*.txt`）与快照**一律丢弃**（命令输出在运行期仍有价值——把几百行输出挡在上下文之外；但**不是审计资产**，durable claim 是回复里的 `[Verification evidence]` 块）。配套：① **自愈清扫**——run 起跑按同一白名单处理上次崩溃/被 kill 残留的暂存目录与历史散落的 `<runId>.log`/笔记（`<runId>.log` 直接丢弃：内容与 journal 同源）；② **保留 K 次**——每个工作区只留最近 `LOG_ARCHIVE_KEEP=20` 次 run，按 mtime 淘汰；③ 正在运行的 run（暂存目录与归档）一律跳过；④ 归档失败只 warn，暂存留待下次自愈，**run 收尾绝不被日志管理打断**。prompt 侧新增 `[Log lifecycle · policy]`（三处 `[Log discipline]` + `TOKEN_HYGIENE` + 资源表 + AGENTS/memory 模板同源），明确「项目内只是暂存、只留脚本与笔记、dump 不留存、不得提交/自行清理/当项目产物」。收口提交面的两道防线（pathspec 排除 + `.gitignore` 幂等补写）保留，覆盖「run 进行中用户自己提交」的窗口。**存量已按新白名单就地瘦身**：本插件仓归档 136 文件/3.03 MB → **43 文件/278 KB**（丢弃 93 个可重跑输出/快照，2.7 MB）。
- **生成量纪律：不再制造输出 dump（改由宿主截尾 + spill 承担）**：维护者追问「**为啥会产生这么多文件？是我们流水线带来的，还是 DSH 本身也会有？**」——实测两边都有，但性质不同：**DSH 原生**会把过大的工具结果截成 tail 并把全文 **spill 到会话临时区**（`dsh-spill-*`/`dsh-subprocess-*`，不进你的仓库，`dsh-spill-local` 有启动 TTL 清扫；本机 temp 里 149 个 `dsh-*` 目录共 8.4 MB，主要是 Node 编译缓存）；**我们的流水线额外要求**每个执行体把命令输出与临时脚本**落到项目内**。真正制造数量的是**执行体数量**：r9 一次 full run 起了 **10 个子代理**（PRD 1 + 技术 1 + 开发 5 = T1–T5 三个并发 + 两轮 QA 打回修复 + QA 首轮 + 两轮复验；**718 次调用 / 59 分钟，其中 61% 花在打回闭环**），每个都按旧 prompt 把整套件输出 dump 成 `regression-*.log`（一次 443 KB、同一套件重复两遍）与 23 个 per-command `.out`。故**删掉旧约定、改为不落盘**：`TOKEN_HYGIENE` 新增 `[No dump manufacturing]`（**禁止**把命令/套件输出重定向进文件；长输出由宿主截尾并把全文 spill 到你被报告的路径，需要细节时读那里），`logs/teamflow/<runId>/` 只放**要留存**的三类——一次性检查脚本 `scripts/`、不可重跑的命令载荷 `captures.json`、结论 `.md`；并要求**同一用途不得新增编号变体**（`-run2`/`dbg-repro2`/`dbg-scan3` 一律就地覆盖）、**改动前基线只物化一次**（`probe/head/` 共享，实测一次 run 因后一阶段重做而留下两整份 50 文件/1 MB）。少掉的正是「41% 的 `.out` + `regression-*.log`（1.2 MB）」与「35% 的源码快照」这两类。回归：L1 契约改写为 `LOG-NO-DUMP-MANUFACTURE`／`LOG-KEEP-ONLY-DURABLE`／`LOG-DISCIPLINE-NO-REDIRECT`（含**防回退**断点：旧写法 `APPENDED on re-run`、`regression-dev.log` 等出现即失败）；执行体数量的收敛留 `docs/TODO.md`（需人决策，先定判据）。回归：新增 `test/runlogs.test.js`（60 断言：路径契约/白名单矩阵/过滤归档/合并语义/自愈清扫/活跃 run 豁免/K 次淘汰/永不抛）+ `test/journal.test.js` 与 smoke 断言改到新落点 + L1 契约 `LOG-LIFECYCLE-ARCHIVED`／`LOG-LIFECYCLE-FILTERED`
- **客户端界面中英双语（P1：客户端展示层，走宿主 locale 服务）**：工作台文案跟随宿主语言（设置 → 通用 → 语言）**实时切换、无需重启**，机制全部复用宿主能力——`ctx.locale.register(NS, {zh,en})` 注册词典 + `ctx.locale.bind(NS)` 取翻译函数 + slot 注册项声明 `locale: NS`（宿主切语言时重渲染每个 outlet；`sidebar.panellist` / `conversation.view` 的名称用 thunk `() => t(...)`，宿主读时求值）。落地：新增 `client/locales.ts`（247 条 key，zh/en 逐条同形）+ `scripts/i18n-client-codemod.mjs`（一次性改写脚本，186 处字面量 → `t('key')`，保留映射留痕）；`client/shared.tsx` 词表**函数化**（`runStatusText`/`kindTitle`/`roleChip`/`stText`，删掉切语言后会变陈旧的模块级常量表）+ `localeTag()` 取代硬编码 `toLocaleTimeString('zh-CN')`；`apply()` 把翻译函数注入纯函数层（词表/格式化/折叠件拿不到组件 prop，只能走模块注入）。**门禁**：smoke 新增「词典 zh/en key 集合逐条一致（en 是兜底语言，漏 key 会让用户看到 raw key）+ 客户端除 console 诊断与存量 phaseKeyOf 映射外零中文字面量 + 5 处 slot 声明 locale + 名称 thunk」。**范围边界（刻意未做）**：host 生成的完成汇报/工具返回/流水线日志、以及流水线产物文档（PRD/QA-REPORT/ACCEPTANCE…）仍是中文——产物语言与「验收结论」字面量是 host 解析契约（`util.parseAcceptanceVerdict` + 冻结语料只增不改），属 P3，见 `docs/TODO.md`

### 已知待办
- 沿用 [0.1.8] 的待办项，并新增本轮产物，见 `docs/TODO.md`

## [0.1.8] - 2026-09-12

### 新增
- **全局团队工作台（`sidebar.panellist` + `main`）**：工作台从「某个会话里的一个 tab」升级为应用级主面板——左侧边栏多一个图标（inline SVG，跟随选中态），点开中央主区即整块换成 TeamFlow：左栏是**产品线**列表（`$DSH_HOME/teamflow/<key>` 扫描，含 run 计数/活跃数/最近需求与验收结论/磁盘路径），右栏是该产品线的 **run 列表 + backlog 分组**（需求/任务/缺陷，含按角色 token）。**不依附会话**：面板在 root scope（无 `useSession`/`useProjection`），所以数据面新增按**产品线 key** 寻址的 remote 方法（`products` / `productView` / `productRunDetail` / `productStageDetail` / `productItemDetail`），与会话内工作台同源装配（同一批 journal 与 state.json，非新数据模型）
- **run 详情进右侧栏 tab**：注册 `teamflow-run` tab 类型（认领 `dsh-resource://teamflow/run/**`），在会话内点 run 即在该会话右侧栏打开完整详情（阶段表 + 官方口径 token + 阶段详情/尝试聚合/验证证据/产出/日志）。地址由 host 生成（client 不拼地址）——与产物预览同一条原则。**右侧栏的会话内容只在对话视图存在**（宿主 `RightbarRoot` 门控），所以全局面板里点 run 默认在**面板内联**显示；要并排看就点「对话右栏」——它会切回对话再打开右栏（seat 在切换后才 bind，故带小步重试）；任何一步不可用都降级面板内联并给出**可见提示**（不静默失败）
- **状态徽章可点筛选（多选）**：分组行上的每个状态计数徽章升级为可点 `filterChip`（选中态实心 + 状态色边框），**多选 toggle**——真实问法是「还没结束的有哪些」（进行中 / 待验收 / 需人工的并集），单选会逼人来回点。**筛选优先于折叠**：选中含终态时自动展开（否则点了「已验收 19」却看不到卡片），清掉筛选回到默认折叠；行尾显示「筛选中 N 项 · 显示 x/y × 清除」，无筛选时不出现（不加噪音）。作用域：backlog **每组独立**，run 标签加同款一行（7 个状态），run 的折叠（最近 8 条 + 进行中置顶）**只作用于筛选结果**；切产品线清空筛选与展开态（面板不重挂载，显式 reset）。**纯客户端过滤**，host 数据面与 slice 上限一律不动（数据不丢，清除即见全部）
- **右栏入口改为「去发起会话」**：右侧栏是**会话级**的（`RightbarRoot` 只渲染当前会话），旧「切回对话」跳回的仍是用户来时的会话、与 run 无关。改为 `goOwnerSessionAndOpen(target)`：host 侧 `runBrief`/`snapshotOf`/`itemDetail.runInfo` **新增 `ownerSession` 透出**（journal 早有该字段）+ 产物地址的会话段改用 run 的发起会话，client 先 `sessions.open(ownerSession)`、等 `sessions.list.getSnapshot().current` 真的切过去**且**对话 seat 挂载 bind 后再 `openResource`（带就绪判据的小步重试）；会话已清理时只提示不跳转，老数据无该字段退回旧行为

### 修复
- **交付判定信号分级（`judgeDeliverable`）**：dev/qa 产出判定由「全文拒绝词命中即否决」改为三级——① 客观形态（非空 + 阶段长度下限）→ ② **真交付信号**（`DELIVERY_EVIDENCE_PATTERN`：prompt 强制的 `[Verification evidence]` 块 = 命令 + 退出码 + 断言计数）→ ③ 措辞兜底（`REFUSAL_PATTERN` 仅在**无证据块**时才否决）。**修「如实汇报环境限制被判未交付」**：子代理自述「7 个用例与 26 项校验无法执行，属环境性失败」因命中「无法执行」被判 `insubstantial` → 提测门禁停线 → 人工 resume + 重复补跑（已完成任务被重做）。修后命中拒绝词**但有证据块** → 判交付 + 记 warn 留痕（措辞只作诊断，不再是门禁）。删 `hasSubstance`
- **熔断改用「新增」口径（`freshTokensOf`）**：熔断预算 = `input + cacheWrite + output`（**排除 `cacheRead`**），阈值 `FRESH_TOKEN_BUDGET`（默认 200k）。旧口径把缓存重放计入——实测某 dev 任务 `totalTokens` 1,885,583 ≥ 60k 触发熔断，**真实新增仅 55,439** ⇒ **任何任务失败一次都立刻熔断、`RETRY_LIMIT` 连一次重试都走不到**。修后重试优先于熔断恢复。**汇报/展示口径 `totalTokensOf`（官方 billed）不变**，两套口径不得合并（已在 AGENTS §4/§5 锚定）
- **收口提交面排除自有日志**：`sanity.tfAddArgs()` = `git add -A -- . ':(exclude)logs/teamflow'`（magic pathspec 强制排除，**不依赖目标仓库有没有配 `.gitignore`**；`-- .` 同时把提交面收敛到工作区），两处提交点（收口提交 + `preAction=commit`）统一走它，**禁止再出现裸 `add -A`**；新增 `util.mergeGitignore()` + `pipeline.ensureLogGitignore()` **提交前幂等补写**工作区 `.gitignore`（覆盖判定含更宽规则 `logs/`、`logs/**`；`changed=false` 时不落盘，不留无谓 diff；写失败只 warn——pathspec 仍兜底）。**修一次收口提交 227 文件里 208 个（92%）是自有日志**（真交付仅 19）——子代理 git 纪律无问题（交付报告写「logs/ remain untracked」当时属实），是 host 在最后一刻扫进去的
- **prompt 日志布局收口**：`TOKEN_HYGIENE` 新增 `[Log layout · policy]`——**每用途一个文件**：套件输出 → `regression-<phase>.log` 且**重跑时追加**带 `--- <timestamp> <task> ---` 表头（禁止 `-run2`/`-nopipe`/`-shim` 同名变体）、一次性校验脚本 → `scripts/`、命令载荷 → 合并进 `captures.json`、探针/草稿 → `probe/`；dev/qa/qaFix 三处 `[Log discipline]` 指向该布局。**实测消灭 51 份重复套件输出（占 `.log` 78%，267.5 KB）**，同一沙箱绕行被各 agent 重新发明 6+ 次的问题一并收敛
- **日志布局路径作用域**：上条的四条路径写成**未限定相对昵称**（`scripts/`、`probe/`）→ 模型按「最像项目约定」解析成**项目根** → 在仓库根建了 `scripts/`(5) 与 `probe/`(1) 且被收口提交扫进去（32 文件里占 6 个）。修复：四条路径全部改写为**完整限定** `logs/teamflow/<runId>/...`，段首加粗「never create scripts/ or probe/ at the project root」，三处 `[Log discipline]` 各自重申；L1 契约新增 `LOG-LAYOUT-SCOPED`（断言完整路径 + 项目根禁令，`exclude` 未限定旧写法防回退）。**教训：给模型指路径必须给完整限定路径，不能给通用昵称**
- **右栏 run tab 卡在「读取中」**：正文读地址必须用宿主绑定的 **`useTabInfo`**（slot 声明 `hooks: { tabInfo }` 会被渲染器改名为 `use<Name>`），prop 名写成 `tabInfo` 取不到 `tab.navigation.address || tab.contentId`
- **二次 unwrap / 空信封静默失败**：去掉阶段详情 / 条目详情 / 面板内联 run 详情的**二次 unwrap**（首层已解包，二次解包取到 `undefined` → 表现为「读取中」或空白）；`unwrap` 对 `ok=true` 但无 `value` 的**空信封显式报错**，不再静默返回 `undefined`
- **React #310（hook 归属错位）**：`FoldableText` 被当普通函数调用（`FoldableText(...)`）而非作为组件渲染 → hook 挂到父组件，叠加条件渲染导致**每次渲染 hook 数变化**。改为组件用法
- **工作台顶出外层页面滚动条**：面板改用宿主 `.viewArea` **高度契约**布局（不再用 `100vh` 一类硬高度），消除「页面级滚动条 + 面板内滚动条」双层滚动；并恢复看板**列内滚动**（限高 340）+ 列头/分组标题 sticky
- **同值点击产品线卡在「读取产品线数据中…」**：重复点击同一产品线不再无响应——`viewTick` 重载 + 选中态提示
- **窄列卡片内容溢出**：等宽数字行（token/耗时）在窄列顶破面板 → 收敛为可换行/截断
- **详情浮层单一事实源**：修「run 详情与 backlog 详情同时存在、要关两次」——详情状态收敛为单一来源
- **分栏改用 `grid auto-fit`**：修 `flex-wrap` 多行 flex 行高随内容 → 列被撑高、`overflow` 永不触发导致「展开后无法滚动」

### 改进
- **客户端展示层收拢**：主题 token / 状态词表 / 格式化（token 官方口径、时间、耗时、折叠文本）从 1286 行的 `client/index.tsx` 抽到 `client/shared.tsx`，会话内工作台与全局面板共用一份——两处展示语言不会再各自漂移
- **宿主 slot 契约对齐**：`dsh.client.inject` 补 3 个 slot owner 包（`ui-layout` / `ui-sidebar` / `ui-sidebar-right`，注册进谁的 slot 就列谁）+ 对应 optional peer 声明，避免加载顺序不确定导致的「slot 不存在」
- **全局面板第三版布局 —— 主区标签页 + 详情覆盖式浮层**：第二版把 **rail + run 栏 + backlog 栏 + 详情栏**四栏并排并叠了 `grid auto-fit` 自适应，在 1100–1400px 窗口**必然超载**（卡片被压到 ~200px、run 行折成多行、详情栏还和列表抢宽度），并触发连环故障（`flex-wrap` 行高随内容 → 列被撑高、`overflow` 永不触发 → 展开后无法滚动）。第三版**做减法**：① 主区改为**标签页**（🚀 流水线 run N ｜ 📋 Backlog M），一次只显示一个列表——宽度全给它、只剩一个滚动区；② 详情改为**覆盖式浮层**（绝对定位 + 独立滚动，与会话内两个抽屉同款），不再参与横向宽度分配；③ 删掉 panel 级 grid/flex 两栏自适应（backlog 卡片自身的 `auto-fill` 网格保留）。折叠 / 进行中置顶 / 终态收起 / 需人工不折等已确认行为全部保留。**教训：并排面板数量必须由可用宽度决定，不是由信息架构决定**

### 已知待办
- 全局面板目前**只读**（未提供 backlog 流转写路径）；run tab 未注册 `sidebar.right.pane.tab.title` seat（chip 标题取自类型定义）；两处渲染组件仍分叉（`shared.tsx` 只统一了词表/格式化）。见 `docs/TODO.md`
- 熔断阈值（`FRESH_TOKEN_BUDGET`，默认 200k）仍是常量，未做成 service Config；护栏**复读检测**仍读已弃用的事件读取器（提醒通道与挂死判据已迁官方投影）。见 `docs/TODO.md`

## [0.1.7] - 2026-09-11

### 新增
- **工作台产物一键预览**：任务卡详情里的「任务夹」现在按真实存在的产物列按钮（PRD / DESIGN / TECHNICAL / QA-REPORT / ACCEPTANCE / meta），点一下即在 DSH **右侧栏**打开预览（Markdown 由官方文档预览器接管）。地址由 host 用官方 `fileAddressFor` 生成（`dsh-resource://file/session/<id>/<相对路径>`）——客户端不拼地址、也不引宿主包进 client bundle；只列真实存在的文件（不出死按钮）；右侧栏服务缺失时静默降级
- **产物交付（`present`）**：prd/tech/qa/acceptance 四个阶段被要求把任务夹产物交给官方 `present` 工具 → 用户在该会话得到「交付文件卡」（预览 / 默认程序打开 / 文件管理器定位）。诚实标注为 `[policy]` 增强项：文件仍是唯一事实源，缺文件依旧是硬失败；卡片渲染在**该子代理会话**的轮次尾部（主会话不显示）
- **机械阶段推理强度降档（省 token）**：DeepSeek 路由默认 `reasoningEffort: high`，而推理 token **计入 output** 且**推理内容每个带推理回合原样回传**（同时抬高后续 input）。现对两处机械阶段下发 `low`——patch 档的「单点确认」与 `scaffold`（脚手架落地）；判据类阶段（PRD/设计/技术方案/QA/验收）保持宿主默认 `high`，**重试自动回升 `high`**（质量优先）。安全前提：先经 `llm.resolveModelInfo()` 探测该路由的 `reasoning.efforts`，只有声明支持才下发——宿主对不支持的值会 `UNSUPPORTED_REASONING_EFFORT` 硬失败且不降级；探测结果按 provider/model 缓存。阶段日志记录实际下发的档位

### 修复
- **token 计量改走官方 Session 投影（宿主弃用同步事件读取器）**：dsh 0.1.5-rc.2 起 `Session.eventAt()` / `snapshotEvents()` / `ownEvents()` 标记为 deprecated（存量可留、新调用禁止，宿主方向是不再把完整事件序列常驻内存）。计量来源改为**官方投影优先**——`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶（与宿主 token-meter 同一份 fold，重试替换语义更准）+ `'sessionStats'.steps` 取调用数，**零历史扫描**；投影缺失/无数据/读取异常时静默回退原事件扫描（最小 profile 与存量宿主不受影响，不虚报 0，不中断流水线）。`sessionProjections` 走可选 `ctx.inject`，不进 `static inject`——服务缺失时插件照常加载
- **护栏适配官方通道（提醒 + 挂死检测）**：轻提醒从手写 `session.append('user/message')` + step/end flush 时序状态机，改为官方 `run.localAgent.inject()`（宿主在协议安全边界整批认领，旧注释声称的「会插进 tool_calls→tool_result 触发 400」不成立）；挂死检测从「多源取最长事件视图」长度启发式改为官方 **`subagentTiming` 投影**的 `active.through`（已提交事件时间，不受视图失明影响——上次 QA 误判 stalled 的根因）。长工具静默执行仍由 agent 活动守卫豁免；投影不可用时回退旧启发式。中止语义未变

### 改进
- **声明宿主兼容窗口**：`package.json` 新增 `engines.dsh: ">=0.1.5-rc.2 <0.2.0"` 与 `dsh.manifestVersion: 1`（dsh 0.1.5 起支持的公共 manifest 字段；当前宿主不校验，属作者声明）；README「版本锚定」段同步到 v0.1.5-rc.2，并记录本次兼容核对结论与两个待跟进项
- **清理死注入**：`static inject` 长期硬注入 `tokenMeter` 却全仓从未使用 → 从 static inject / setRuntime / runtime 三处移除（假依赖会拖累插件的加载条件）
- **工作区 key 文档纠偏**：`workspaceScopeOf` 的「优先用 DSH workspace UUID」分支**当前不可达**（宿主 `resolveByPath` 是异步、我们同步调用），实际生效的是路径派生 `slugPath(cwd)`；注释与 AGENTS.md 改为事实描述，真修（改异步 + 存储 key 迁移）列入 `docs/TODO.md` 待 v0.1.8

### 已知待办
- **护栏复读检测仍读已弃用的事件读取器**（提醒通道与挂死检测已改官方；复读需要流式文本内容）：官方替代是订阅 `'session/event'` post-commit 投递，需先定等价判据，见 `docs/TODO.md`（当前行为不变，存量调用被宿主明确允许）

## [0.1.6] - 2026-09-07

### 新增
- **评测层 L1+L2（prompt/注入改动收益评测）**：每次改 prompt/注入后可直接验证收益——L1 行为级契约测试（直接调用 prompt 工厂断言产出锚点，29 条契约分 HOST-ENFORCED/policy/structural 三级，改 prompt 一眼看出断了哪条、丢哪级保障）+ L2 回放语料一致性门禁（冻结真实形状的 QA-REPORT/ACCEPTANCE/dev 回复/蓝图产物，喂宿主真实解析器做 golden corpus 回归，零 LLM 成本）。语料只增不改，防评测过拟合
- **dev/qaFix 验证证据块**：开发回复末尾强制「[Verification evidence]」块（命令+退出码+断言计数+失败行引用，或显式 N/A），host 提取存证、阶段详情可见、可与命令日志交叉核对——开发阶段从「单方宣称全绿」升级为「可审计的具体自述」
- **代码级英文化（为 UI i18n 铺路）**：代码判断/命名全英文（阶段键 prd/design/scaffold/tech/dev/qa/acceptance、任务结构化键 taskKey），中文只留展示层；存量数据提供迁移脚本

### 改进
- **resume 断点续跑状态机化**：两级状态（大阶段 + 子图任务）聚合判定——有 done 尝试的任务即成功（历史失败不算失败），resume 只补跑「聚合后未成功」任务、复用已完成产物；不再读 backlog 子卡（残留失败卡不再污染判定）；dev 部分成功时起点精确回开发补跑未完成，全 done 时正确落在 QA/验收
- **输出单轨制**：QA/验收的完整报告只写在任务夹文件（QA-REPORT.md/ACCEPTANCE.md），子代理回复仅摘要+路径——host 直接导入文件（缺陷表/核对表），杜绝「回复与文件不一致」的双轨问题
- **验收结论契约强度**：验收报告结论行必须为字面量模板（✅/⚠️/❌/📝 四档）且为文件最后一行；无结论行/空结论行 → 需人工确认（不再默认通过，防质量门禁漏报）
- **prompt 约束分级**：区分 [HOST-ENFORCED]（host 真实强制，如单轨产物/结论行）与 [policy]（自律 + 轻提醒），prompt 内不再自称 hard constraint
- **重试诊断包**：重试时把上次失败详情（outcome/护栏原因/拒绝词命中点/产出尾部）附进 prompt——盲试 → 带因重试；stalled（挂死/空转）不再自动重试

### 修复
- **token 计量适配宿主 session v2**：宿主新版会话已无 `events` 属性，计量读不到 → 流水线卡与图卡无「TOKEN · 官方口径」。修复：多源回退（snapshotEvents/ownEvents）+ usage 双路径（含 stream 内嵌），新 run 计量恢复
- **护栏挂死误杀**：QA 子代理正常干活却被判「10 分钟无事件」（宿主事件视图失明）——事件读取多源回退 + agent 活动守卫（非 idle 且已动手即不中止）
- **任务卡 token 统计**：子卡 usage 按 stage 引用直写（并发下不再错位/超计）
- **存量迁移脚本 taskKey 误判**：合法中文括号结尾的任务键不再被当作历史残留（幂等无损但计数虚高）
- **验收空结论行/裸否定词漏报**：四档词白名单校验覆盖 accepted 分支

### 其他
- AGENTS.md 注入面瘦身 64%；dsh 0.1.3-alpha.1 兼容性核对（依赖包名更新）

## [0.1.5] - 2026-09-01

### 新增
- **patch 档兑现「单 agent 直改 + 自测即交付」**：阶段集精简为确认单 → 单 agent 直改（2 段，无技术方案/QA/验收），开发完成（自测通过）即统一收口提交。UI 微调（按钮换位置/挪控件/改文案/间距/颜色）、常量调整、单点修复、回滚、笔误修正走最轻路径

### 改进
- **需求分诊重构为模型主导**：档位判断交给模型（自然语言语义，天然双语）；正则收窄为确定性护栏（架构信号强升/UI 不低于轻量档/显式设计升档）。UI 微调类需求（不改变行为/交互逻辑）不再误判标准档
- **分诊输出失败自动纠错重试**：只输出开场白无 JSON 时带提示重试一次，仍失败才走正则兜底

### 修复
- **外部中止（aborted）不再误报「预算熔断」**：重启等外部中止单独标记，明确引导断点续跑（补跑失败任务，已完成任务复用）
- **patch 档不再误跑架构蓝图**（技术方案块补 `enabled('tech')` 门控）
- **分支名不再被档位词污染**（「显式的用 patch 模式」不再产出 `feat/patch`）
- **provider 错误细节记录**（阶段失败记录底层错误信息）

## [0.1.4] - 2026-08-29

### 修复
- **分支决策死循环**：用户确认「新建分支」后重发启动参数仍会再次弹出分支决策（干净工作区场景）。修复：决策选项增加显式确认值，自定义分支名/工作区处理参数均视为已确认
- **护栏误杀大文件任务**：大文件「读-改-读-改」是正常模式（每次修改后必须重读确认），可能被误判为推理复读而中止。修复：复读判定升级为状态判定——有实际修改进展时不中止，仅纯复读（零进展）才中止
- **QA/验收只读任务不再被误杀**：执行测试脚本视为进展信号，只读分析任务（不做文件修改）不再被复读检测误伤
- **退化中止不再自动重试**：真退化（推理复读死循环）后自动重试大概率在污染会话内复现且持续烧钱——改为直接需人工介入，引导 `teamflow_resume`（全新会话续跑）
- **断点续跑尊重未闭环的 QA 缺陷**：阻断缺陷仍 open 时 resume 回到 QA 修复-复验闭环，不再带着已知缺陷直接进产品验收；验收失败过的 run 同样正确回 QA
- **历史失败记录保留**：resume 不再清除失败的阶段记录（审计可追溯）

### 新增
- **提测门禁**：开发阶段有任务失败（哪怕 1 个）→ 需人工介入，不再自动进入 QA（失败任务是已知缺口，QA 检查必然重复报告）；resume 精确补跑失败任务（已完成任务产物复用，不重跑）
- **README 界面预览**：5 张真实工作台截图（流水线视图/看板/阶段详情/看板任务详情/团队选择）

### 其他
- pnpm-lockfile 同步（依赖调整后 CI 的 frozen-lockfile 校验失败，已修复）

## [0.1.3] - 2026-08-29

### 新增
- **分支策略闭环（ADR-2026-08-27）**：启动前用户决策（`needs-decision` 四情况：main+干净/main+脏/feature+干净/feature+脏，stash/commit/新建/沿用/自定义兜底）；`branchPolicy`/`branchName`/`preAction`/`commitMessage` 决策参数；auto=建 `feat/<slug|branchName>`、keep=沿用；`preAction`（stash/commit）在 sanity 前执行
- **收尾合回决策（对称交互）**：完成汇报带「合回决策邀请」，新工具 `teamflow_merge`（host 代为合回 / 给命令自行合回 / 暂缓）；`journal.mergeStatus` 持久化（pending/merged/kept/failed）
- **统一收口提交**：子代理只改不提交（Git discipline 硬约束），host 验收通过后单 commit（代码+任务夹产物）；结构性消灭文档漏提交与未验收中间态
- **视觉验证能力条件化**：`llm.resolveModelInfo` 探测模型多模态能力 → QA/验收视觉条款动态生成（支持视觉=DOM 计算断言+截图看图+人工收窄；不支持=禁截图看图防幻觉/循环，只走 DOM 断言）；QA 人工补测清单收窄为音频/真机/FPS/读屏
- **需求意图预检**：疑问/建议/反馈句式（「是不是应该」「要不要」等）→ `needs-confirmation` 不启动，主线程先向用户确认
- **activeTeams 持久化**：会话→团队映射落盘，重启/刷新后恢复（UI 状态与启动通道一致）

### 修复
- **护栏注入通道**：`subagents.start` 句柄无 inject → 改用 DSH 官方 `session.append('user/message')`；注入改安全窗口（step/end 后 flush，防插进 tool_calls→tool/result 序列导致 provider 400，实测 tf-mtcnejqj 烧 1.98M）
- **复读检测重复计数 bug**：轮询重复收集事件导致计数虚增（实际 4 次 × 3 轮 = 12 压线误杀，实测 tf-mtcomxpq 开发两次）→ 增量收集
- **`isUnretryable` 覆盖 400/invalid_request**（provider 客户端拒绝不再重试烧钱）
- **开发任务全部失败停止流水线**（无产物可测时不再继续 QA 误测；部分失败仍继续）
- **resume 断点按阶段定位**（PRD 重试成功后不再被失败尝试带回重跑）
- **分支 slug 派生**（branchName > triageSlug > 需求英文词 > r<N> > feature；分支检查移到 initBacklog 之后）
- **journal.options 透传 branchPolicy 等决策参数**（keep 不再被吞，实测 tf-mtd6mbeq）
- **DSH 0.1.2-alpha.1 事件词汇适配**（text-chunks/reasoning-chunks → assistant/chunk 双兼容）；schema 校验兼容（needs-decision 不返回 runId 字段）

### 其他
- 执行路径基准（小需求样本）与假优化判定收敛：`docs/benchmarks/hold-pipeline-vs-native.md`（多花 44% 是质量预算非浪费，cacheRead 命中价≈1/10）

## [0.1.2] - 2026-08-26

### 修复
- host 就绪日志工具数改为动态计数（消除「工具 8 个」写死文案，与实际注册数一致）

### 变更
- 开源发布收尾：README 中英双语修正（架构计数 17/11、防假交付真实语义、快速上手、环境要求）；npm 元数据（keywords / homepage / bugs）；`react` 移入 peerDependencies + `peerDependenciesMeta`（防私有包 ERESOLVE）；CI 触发扩展 `main` + `release-*`；构建关闭 sourcemap（npm 包 -58%）；新增 SECURITY.md / CONTRIBUTING.md；deploy 同步清单移除 `.map`

## [0.1.1] - 2026-08-26

### 修复
- npm 发布包 `files` 白名单收窄为 `lib` / `cordis.patch.yml` / `README.md`，不再携带 `AGENTS.md` 与 `docs/adr`（开发者文档仅保留在 GitHub 仓库）

## [0.1.0] - 2026-08-26

### 初始公开发布
- 一句话需求 → 多 Agent 研发流水线（PRD / 设计 / 架构 / 技术方案 / 并行开发 / QA / 验收）
- backlog 持久化 + 断点续跑（自研 journal，不依赖 LangGraph）
- 防假交付：实质校验 + token 熔断 + 产品级并发锁 + 内存裁剪
- 完成汇总自动汇报主线程（空闲唤醒 / 忙碌注入）
- token 官方口径计量（输入未命中 / 命中 / 写缓存 / 输出 + 调用数 + 缓存命中率）
- lite / tech / patch 模式 + 模型驱动需求分诊（`teamflow_triage`）
- 🏭 团队工作台 Web tab：阶段泳道 / 拖拽看板 / 成本中心 / 人工介入中心
- QA 打回修复有界闭环（ADR-0007，超限转 needs-human）
- 任务夹文档制（ADR-0008）：每需求自包含任务夹，消除双归档 / memory 堆积
