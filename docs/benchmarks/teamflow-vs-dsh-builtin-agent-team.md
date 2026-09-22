# TeamFlow vs dsh 内置 Agent Teams（实验层）——全面对照

> 对象：本仓库 `dsh-plugin-teamflow`（v0.2.0） ↔ dsh 宿主自带实验包
> `@deepseek-ai/dsh-experimental-agent-team` / `-tool-agent-team` / `-client-ui-agent-team` / `-agent-team-profile`
> （dsh `dsh-v0.1.7-alpha.1`，2026-09-22）。
> 目的：把「两者是不是同一类东西、谁该用什么、能不能互相借力」一次性说清，避免以后按印象讨论。

## 一句话结论

**两者不在同一个层次上，构不成替代关系。**

- dsh 内置 Agent Teams 是**通用团队运行时**（roster + 持久 mailbox + 共享任务板 + 9 个模型工具），**不含任何质量门禁、质量判据、成本计量、流程语义**；它回答「多个 agent 怎么互相找到、怎么传消息、怎么共享任务」。
- TeamFlow 是**领域化的研发流水线**（阶段集 + 门禁 + 反假交付判据 + 计量 + 看板 + 人工介入），它回答「一段需求怎么变成可验收的交付」；成员/通信/任务板这一层它是**自己实现的**（host 直接调 `ctx.subagents.start`，不经过 Team 服务）。
- 由此推出一条重要判断：**dsh 的 Team 层如果稳定下来，TeamFlow 的「编排骨架」有机会上移复用；但 TeamFlow 真正的资产（门禁、判据、计量、领域 prompt、看板语义）dsh 一个都没有，也不可能替它做。**

## 证据来源（本次核对面）

| 侧 | 核对对象 |
|---|---|
| TeamFlow | `package.json`、`README.md`、`cordis.patch.yml`、`host/constants.ts`、`host/core/{pipeline,runner,teams}.ts`、`host/index.ts`、`docs/adr/0001`、`docs/TODO.md` |
| dsh | `packages/experimental/{agent-team,tool-agent-team,client-ui-agent-team,agent-team-profile}`、`.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md`、`.agents/notes/implemented/simplification/2026-09-15-model-agent-availability-and-team-targets.zh.md`、`.agents/notes/implemented/architecture/2026-09-18-agent-teams-single-bundle.zh.md`、PR #4698（只读看板） |
| Git 事实 | `dsh-v0.1.7-alpha.1` 含全部上述提交（逐个 `merge-base --is-ancestor` 验证） |

---

## 1. 定位与形态

| 维度 | TeamFlow | dsh 内置 Agent Teams |
|---|---|---|
| 解决什么 | 需求 → PRD → 设计 → 架构 → 技术 → 并行开发 → QA → 验收 | 多 agent 的成员关系、消息、共享任务 |
| 谁在编排 | **host 代码**（`pipeline.ts` 1434 行的确定性状态机） | **Lead agent**（模型自己决定建谁、发什么消息） |
| 抽象单位 | 阶段（stage）× 子任务（dt-N）× 打回轮次 | 成员（member）× 消息（message）× 任务（task） |
| 有无「流程正确性」概念 | 有（阶段顺序、门禁、结论行、判据） | 无（只保证消息不丢不重、任务 CAS 不覆盖） |
| 交付形态 | npm 包 + `dsh.bundle.patch` + `dsh.client`（第三方可分发） | 随宿主交付的可选组合包（`OPTIONAL_BUNDLES`，默认关） |
| 稳定性承诺 | 作者承诺（语义化版本 + CHANGELOG + 兼容窗口声明） | **明确不承诺**（实验原型，约定可自由变更） |
| 激活前提 | web profile；`$DSH_HOME` 可写（宿主级 fs） | 持久会话存储（`dsh-session-persistence-jsonl`） |
| 入口 | `dsh plugin --profile web add dsh-plugin-teamflow` | 插件页「Team」开关（0.1.7 起一个组合包） |

## 2. 成员模型与寻址

| 维度 | TeamFlow | dsh Agent Teams |
|---|---|---|
| 成员是谁 | **角色**（产品经理 / UI-UX / 架构师 / 高级全栈 / QA），绑在阶段上，每阶段起一个**独立子代理会话** | **具名 teammate**（`reviewer` 等），由 Lead 动态创建，生命周期跨阶段 |
| 谁是发起者 | 主线程 = 只发起与汇总（README 明令「别抢活」）；host 干活 | Lead = 真 agent，自己也干活 |
| 寻址 | 隐式：host 拿 `run.id` 存进 `stage.childId`，人可点「跳转子代理会话」 | 显式：`target` = 成员名，模型可直接复制到消息/中断/任务分配 |
| 成员数量 | 每个 run 实测 4–10 个子代理（r9 full 档 10 个 / 718 次模型调用） | `maxMembers: 8`（组合包配置，服务默认上限 16） |
| 成员可否嵌套 | 不支持（阶段是平的） | 不支持（roster 扁平不可变，只有 Lead 能建） |
| 多团队 | **支持**：每 workspace 一份 `teams.json`，团队 = 阶段集（`TeamConfig.stages`），可换团队切换流程 | **不支持**：一个会话一个隐式 Team，`TeamId === SessionId` |
| 上下文隔离 | 阶段间天然隔离（各起独立会话），靠**产物文件 + handoff brief** 交接 | teammate fresh（无 Lead 记忆）或 fork（继承已完成轮次前缀） |

## 3. 工具面（模型能做什么）

| 侧 | 工具 | 语义 |
|---|---|---|
| TeamFlow | `teamflow_start / triage / status / backlog / claim / update / assign / cancel / resume / resume_session / pause / merge`（12 个） | 全部是**流水线控制面**：起跑、查进度、认领、流转、暂停/恢复会话、取消、续跑 |
| dsh | `spawn_teammate / send_message / list_agents / wait_agent / interrupt_agent / team_task_create / team_task_list / team_task_get / team_task_update`（9 个） | 全部是**协作原语**：建成员、发消息、看状态、等变化、停轮次、增删改查任务 |

关键差异：**TeamFlow 没有「对等消息」这类原语**——agent 之间不直接说话，一切经 host 中转（提示词 + 文件）。dsh 相反，**任何成员可给任何成员发消息**，且投递是持久的（离线排队、恢复后送达、`accepted` / `queued` 两态）。

dsh 的 Team 工具是 **scoped 注册**：成员 scope 上的注册会覆盖同名旧 subagent 工具（组合包 patch 里显式 `disabled: true` 掉 `tool-subagent*` 四行），即**装了 Team 就没有旧的直接委派工具了**——这是个破坏性切换，TeamFlow 不涉及（它不占用 subagent 工具名）。

## 4. 状态与持久化

| 维度 | TeamFlow | dsh Agent Teams |
|---|---|---|
| 状态存储 | **自研 journal**：`$DSH_HOME/teamflow/<ws>/runs/<runId>.json`（原子写 + `.bak` + 损坏自愈），加 `backlog/*.json`、`teams.json`、`logs/` 归档（保留最近 20 run） | **宿主会话日志**：`team/member`、`team/task`、`team/message/queued|delivered` 事件写进 Lead 会话；roster/mailbox/task 每次读取从日志回放（进程内缓存） |
| 与宿主会话的关系 | 弱耦合：只往会话里追加 `tool-workflow/agent-start` + `user/message(source.kind='plugin')` 两类事件（**必须落在宿主词表内**，新增自定义类型要带 `ignorable: true`） | 强耦合：Team 事件就是会话事件，**模型历史不包含协作记录**（只在日志里） |
| 崩溃恢复 | 启动扫描把未终结 run 标 `interrupted`；`resume` 从第一个未完成阶段续跑，已完成阶段**复用产物** | 恢复时对账未终结的 `provisioning` 记录与 child 会话：匹配 → `active`，否则 `failed`（名字永久占用） |
| Resume 语义 | 「跳过已完成阶段复用产物」——**刻意不重放**（ADR-0001：LLM 节点不可重放，重放 = 重烧 token 且结果不同） | `wait_agent` + 重新读取当前状态；消息「绝不重发」 |
| 归档/遗忘 | logs 有遗忘机制（每工作区保留最近 20 run）；`runs/` 与空壳目录**尚无 TTL**（TODO 已知） | `maxTasks: 256`、tombstone 保留已删任务但不算配额；`maxPendingMessagesPerMember: 64` |

这一格是**最本质的分歧**：TeamFlow 把状态放在**自己的库**里（可以有 schema、归档、审计、跨会话全局视图）；dsh 把状态放在**宿主的会话日志**里（天然随会话走、无需额外存储，但无法表达跨会话/跨进程的团队）。

## 5. 并发与隔离

| 维度 | TeamFlow | dsh Agent Teams |
|---|---|---|
| 并发度 | **dev 阶段并发池**：默认 3 路，上限 8（`maxConcurrency`），可被调用方指定 | 成员天然并行（各自一个 agent），但**无并发调度器**：建了就都活着 |
| 写冲突处理 | **有**：蓝图任务文件有交集 → 合并成同一任务（保证并发不写同一文件）；`writeScopes` 提示重叠只 warn | **无**：`writeScopes` 是**规范化前缀提示**，明确「绝不阻止 claim、不授权写入」；Bash/formatter/生成器都能绕过 |
| 文件系统隔离 | 无（共享 checkout），靠任务合并规避 | 无（单进程共享 checkout），README 明写不支持 worktree / 远端成员 / merge / 文件锁 |
| 并发锁 | 工作区级并发锁（`activeProducts`，按 workspace slug 隔离，互不阻塞） | 无（单进程内 `TeamId` 归属） |
| 交付收口 | 一个 run 一个 commit，只带代码 + 任务夹（`docs/teamflow/`），日志归档出项目 | 无提交语义（不管 git） |

## 6. 质量门禁与「防假交付」（TeamFlow 的独有层）

这一整层 dsh 完全没有对应物：

| 机制 | TeamFlow 的实现 | dsh |
|---|---|---|
| 交付判据（不看措辞） | `judgeDeliverable`：客观形态 → `[Verification evidence]` 块（命令 + 退出码 + 断言数）→ 措辞兜底；doc 类阶段回读文件长度兜底 | 无 |
| 最小产出长度 | 分阶段 `STAGE_MIN_LENGTH`（prd 400 / tech 350 / qa 250…） | 无 |
| 硬门禁 | PRD 宿主契约调研硬门禁、**提测门禁**（dev 任务 failed → 不让 QA 白烧）、验收只认显式结论行（缺失即转人工） | 无 |
| QA 打回闭环 | P0–P2 缺陷 → 打回修复 → 复验，`QA_REWORK_LIMIT = 2`；超限以「已知问题」只读跑验收 + 强制人工裁定 | 无（任务只有 CAS + 依赖 DAG） |
| 退化检测 | 单调用护栏：复读（400 窗口内同片段 ≥12 次）、挂死（10 min 无事件）、空转（15 min 无工具调用） | 无 |
| 门禁留痕 | 修复轮要求证据块含 `gate:` / `class sweep:`，缺失 warn（policy 级，不硬失败——host 无法证明门禁真跑过） | 无 |
| 需求前置闸门 | 分诊 `intent/blockers` + `needs-clarification`（成立则不建 run） | 无 |

## 7. 失败语义与人工介入

| 失败类型 | TeamFlow 处置 | dsh 处置 |
|---|---|---|
| 内容失败（产出不合格） | 自动重试 `RETRY_LIMIT = 2`（第 2 次带诊断包、推理强度回升 high）→ 超限 `needs-human` | 无（不判产出好坏） |
| token 跑飞 | **新增口径熔断**：`fresh = input + cacheWrite + output`（排除 cacheRead），预算 200k 起、按 provider 缓存能力自适应放宽 | 无预算概念 |
| 外部供应商故障（限流/额度/5xx） | 与交付缺陷**解耦**：长退避 30/60/120/240s（不计熔断、不占重试次数）→ 用尽落 `interrupted/external`，明写「非交付缺陷」 | 无 |
| 挂死/退化 | 护栏中止 → **不自动重试**（实证会复现），直接 `needs-human` 引导 `resume`（全新会话） | `interrupt_agent`（仅 Lead，只停当前轮次，不删排队消息、不释放任务 owner） |
| 用户中断 | ⏹ 三处入口 + 两段式确认 + 并发一次全停 + 终态归一 | 无 UI 中断（面板只读） |
| 人工介入面 | 看板拖拽流转、`teamflow_update` 处理 `needs-human`、`claim/assign` 分离、成本中心、人工介入中心 | 任务看板**只读**（PR #4698 删掉整条浏览器写路径，净删 1244 行）；任务增改只能由 agent 通过工具做 |

## 8. 成本计量

| 维度 | TeamFlow | dsh |
|---|---|---|
| 逐阶段 token | 有：input（未命中/命中）/ cacheWrite / output / 调用数，逐阶段 + 逐 dev 子卡 byRole 累计 | 无 |
| 缓存命中率 | 有，与汇报同口径 | 无 |
| 官方口径分账 | billed（含 cacheRead）与 fresh（不含）双口径分账 | 无 |
| 预算/熔断 | 有（见上） | 无 |
| 推理强度降档 | 机械阶段降 `low`，重试回升 `high`，且**先探测宿主是否支持**（防 `UNSUPPORTED_REASONING_EFFORT` 硬失败） | 无 |

## 9. Web UI

| 维度 | TeamFlow | dsh Agent Teams |
|---|---|---|
| 会话内 | 「🏭 团队工作台」tab：蛇形泳道流水线图 + 拖拽看板 + 成本中心 + 人工介入中心 | `ui-agent-team` 面板：roster + 任务看板（**只读**） |
| 应用级 | **左栏「团队工作台」图标**：跨会话 / 产品线视角（产品线上 → run 列表 + backlog） | 无 |
| 右栏 | 右栏 run 详情（与任务夹产物并排） | 无 |
| 深链 | 「🎬 跳转子代理会话」（跨父会话时禁用并提示，宿主能力缺口，TODO 记录） | 无 |
| 写操作 | 看板拖拽、取消、续跑（两段式确认） | **无写操作**（刻意删除，任务增改归 agent 工具） |
| i18n | 中英双语，界面 + host 回复 + 流水线日志 + 产物文档全跟随（run 起跑时定一次） | 中英（README 双语），运行期不涉及 |

## 10. 依赖、分层与耦合风险

| 维度 | TeamFlow | dsh Agent Teams |
|---|---|---|
| 分层 | **host 级插件**（因为动态插件的 fs 被沙箱限制在运行时根，写不了 `$DSH_HOME`——实测 `FS_SANDBOX_DENIED`） | 宿主 in-tree 包 |
| 依赖声明 | `dependencies: {}`，peerDeps 全是 `@deepseek-ai/dsh-*` + react（宿主注入）+ `optional: true` | workspace 内 first-party |
| 读宿主内部面 | **较深**：`parent.session.requestHeader()`、`ctx.subagents.start`、`llm.resolveModelInfo()`、`tokenUsage`/`sessionStats` 投影 key、typert strict codec（`create()` 工厂）、client slot 名、会话事件词表 | 就是宿主本身，随宿主一起演进 |
| 已知破坏点 | ① v0.1.6-alpha.2 的 strict codec 由 `{mode,typeSymbol,schema}` 变 `{mode,typeSymbol,create}`，**注册即抛** → 表现为「dsh 起不来」，已修；② v0.1.7-alpha.1 的 session **v4** 要求每条 message 带 producer-owned `source.kind`（`plugin:<name>`），v3 退役 wrapper（`{kind:'plugin',…}`）被当场拒 → 新 run 写入即失败，已修（两条均写进 README） | 无（第一方） |
| 兼容声明 | `engines.dsh: ">=0.1.7-alpha.1 <0.2.0"`（作者声明，宿主不校验；下限随 v4 要求收窄——semver 7.7.4 实测 `0.1.7-alpha.*`/`0.1.7`/`0.1.8`/`0.1.9` PASS、`0.1.6-alpha.2` 与 `0.2.0*` fail） | 无（随宿主版本同发） |
| 分发要求 | 薄依赖（ADR-0001 明确拒绝 LangGraph，理由之一就是 `better-sqlite3` 原生模块在 Windows 上可能装不上） | 无 |

## 11. 规模对照（本次实测）

| 项 | TeamFlow | dsh Agent Teams（4 包合计） |
|---|---|---|
| 源码 | **约 13.4k 行 / 31 文件**（host 9390 + client 3047 + 根 store/descriptors/deploy 936） | **3.3k 行 / 24 文件** |
| 测试 | 18 套 / 4.2k 行（`test/*.js`，含 smoke 793 行、triage-gate、prompt-contract、verdict） | 10 套 / 4.3k 行（vitest，含 built-lib e2e、browser spec） |
| 最大单文件 | `host/core/pipeline.ts` 1434 行；`host/index.ts` 1132；`host/prompts/index.ts` 736 | `agent-team/src/*` 16 文件 2442 行（最大约数百行） |
| 文档 | 54 篇 md：AGENTS 62.7 KB、CHANGELOG 122.7 KB、devlog 224.6 KB、9 篇 ADR、3 篇基准 | 4 包 README（中英）+ 3 篇 agent note |
| 测试与源码比 | 0.32 | **1.31** |

注意最后一行的含义：dsh 的测试密度**高出 4 倍**（第一方库、覆盖式 CI 要求 100% per-file），TeamFlow 的测试偏「行为契约 + 守门」（smoke / prompt-contract / triage-gate）。

---

## 互补性：能不能互相借力

| 方向 | 可行性 | 说明 |
|---|---|---|
| TeamFlow 复用 dsh 的 roster / mailbox / 任务板 | **低（现阶段）** | ① dsh 是单进程、单 Team（`TeamId === SessionId`），TeamFlow 需要**跨会话的产品线/backlog**；② dsh 的 mailbox 不做跨进程 exactly-once，而 TeamFlow 的 journal 必须跨进程可恢复；③ dsh 的 roster 只有 Lead 能建成员、名字永久占用，而 TeamFlow 的角色是**每次 run 重新起会话**、需要复用角色名；④ dsh 明确无 worktree/merge/文件锁，TeamFlow 的并行 dev 写冲突靠**任务合并**规避——这套逻辑 dsh 不管。 |
| TeamFlow 上移「编排骨架」到 dsh workflow 层 | **中（长期）** | dsh 有 `workflow/` 与 `agent-team` 两块在演进；若 workflow 层出现稳定的「阶段 + 可恢复 + 可观测」原语，TeamFlow 的 `pipeline.ts` 里**通用的那部分**（重试/熔断/护栏/恢复）可以下沉。但 ADR-0001 已给出判据：LLM 节点不可重放，"跳过已完成阶段复用产物"必须自己写——这与 dsh 的 "从日志回放" 是两套不同假设。 |
| dsh 借 TeamFlow 的门禁/计量思路 | **高（作为输入）** | TeamFlow 已有的「客观形态判据优先于措辞」「fresh vs billed 双口径」「外部故障与交付缺陷解耦」都是 dsh 当前**空白**且被真实 run 打出来过的经验（见 `host/constants.ts` 里逐条实锤注释）。 |

## 双方当前缺口（各自 TODO 里的真话）

**TeamFlow**
- `$DSH_HOME/teamflow/` 无遗忘机制：`runs/` 无 TTL，11 个目录里 6 个是空壳（TODO）。
- 复读检测仍读**已弃用的事件读取器**（宿主有官方增量替代，未迁）。
- 需求澄清/计划确认闸门只完成 Phase 1（启动前 + 假设可见化）；PRD 确认单 Phase 2 未做。
- 打回轮次仍是硬上限 2 而不是收敛判据（等 `qaRounds` 埋点攒够数据）。
- 一次 full run 的执行体数量 = 阶段 × 子任务 × 打回轮次，是成本最大乘数（r9：10 个子代理 / 718 次调用 / 59 分钟，其中 61% 花在打回闭环）。
- 「跳转子代理会话」受宿主能力限制（无法一键切 tab、不支持跨父会话导航）。

**dsh Agent Teams**
- 实验原型，**无稳定性承诺**；默认关闭，需持久会话存储。
- 单进程、共享 checkout、无 worktree/merge/文件锁；`writeScopes` 仅提示。
- 任务 owner **不自动释放**（不活动/中断/退出都不释放）。
- mailbox **不保证跨进程 exactly-once**；不支持多 harness 进程操作同一 Team。
- 无嵌套 Team、无重命名/删除/名字复用。
- **零质量语义**：不判产出、不计成本、不设门禁、不做恢复策略。

## 结论

1. **不要问「哪个更好」**——TeamFlow 把 dsh 的 Team 层当作**可替换的底座**看是不成立的：它要的东西（跨会话产品线、跨进程可恢复 journal、多团队、失败语义、成本账）dsh 的 Team 服务一个都不提供，而且短期内也不打算提供（README 明确列为不支持项）。
2. **真正的分工**：dsh 负责「一个进程内、几个 agent 之间怎么说话」；TeamFlow 负责「一段需求怎么变成可验收的交付」。前者是**通信层**，后者是**流程 + 质量 + 账本层**。
3. **值得互看的两点**：① dsh 若要把 Team 层升到产品级，TeamFlow 里那批「被真实 run 打出来」的判据（客观证据块、fresh/billed 双口径、外部故障解耦、退化护栏）是可以直接抄的经验；② TeamFlow 若哪天要支持「干活途中 agent 之间直接商量」（现在的模型是 host 中转、agent 之间不说话），dsh 的 mailbox 是最省事的参考实现——但那会带来跨进程持久化的一致性代价，与 ADR-0001 的取舍正面冲突，**动手前先定判据**。

---
*本文数据来自仓库静态核对（2026-09-22），未做端到端对照实验；如需要「同需求双路径时间/token/质量」的量化对照，沿用 `docs/benchmarks/` 里既有的 A/B 方法（如 `hold-pipeline-vs-native.md`）。*
