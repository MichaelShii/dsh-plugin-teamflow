<!-- 通稿 · 中文版 · 锚定 **v0.2.0**（2026-09-23）· 投放平台待定（GitHub Discussion / 站外中文社区均可，正文不假设平台）
     **本版默认发英文稿**（`show-your-plugin-v0.2.0.en.md`），本文件是正文首行跳转的目标。
     建议标题（发帖时用）：
       ▶ 主选 [插件] TeamFlow v0.2.0 —— dsh 多 Agent 研发流水线：一句话需求 → 可验收交付
       · 备用 [开源] TeamFlow v0.2.0 —— dsh 多 Agent 研发流水线：一句话需求 → 可验收交付，产物落盘、结论有契约、token 对得上账
     引用的一切数字都可在仓库内逐字核对（来源见各条括注）；与 v0.1.8 那份旧通稿的关系：
     旧稿 `github-discussion-show-your-plugin.md` 已冻结、只作历史留存，本文件是新通稿，版本锚定 v0.2.0。
     **上一版投放记录**：v0.1.8 通稿发于 `deepseek-ai/deepseek-harness` Discussions [#6405](https://github.com/deepseek-ai/deepseek-harness/discussions/6405)（2026-09-12 07:26 UTC / 北京 15:26），当时标题「dsh-plugin-teamflow：把「一句话需求」跑成一条带质量门禁的多 Agent 研发流水线」；该帖评论中 @boshk0 问「Is there English translation?」——本版默认发英文稿即源于此。
     **对外口径（2026-09-23 决定）**：本版**不展开**第三次对照测量（`assetd-clarity-vs-gate.md`，平局）与自评式措辞（自曝风格只留在仓库内部文档）——完整数据仍在 `docs/benchmarks/`，正文已给出目录链接，**不是删数据**。
     ➜ 发布后本文件同样停止更新；再发通稿请另建文件并写当时的锚定版本。 -->

中文 | [English](./show-your-plugin-v0.2.0.en.md)

<!-- 跳转行两套写法，别混：
     · **仓库内浏览用相对路径**（就是上面这行，与 README.md:5 / README.en.md:5 同款）——在仓库页永远有效；
     · **发出去的帖子**里必须换成帖子互链（相对路径贴进 Discussion / 站外社区就是死链）：
         英文帖第一行 → `[中文](<中文版帖子 URL>) | English`
         中文帖第一行 → `中文 | [English](<英文版帖子 URL>)`
       帖子 URL 是永久的，不依赖分支 / commit / tag —— 这也是**不钉 SHA、不用 tag** 的原因：读者该落到「帖子」，而不是某个源文件版本。
       若中文版暂时没发出去（只留在仓库里），英文帖就把这一行删掉，或直接写仓库路径。
     · 这两份新文件目前只在 release-v0.2.1 上、尚未进 main；等合入 main 后，仓库内相对路径照旧有效，无需改动。 -->

> `dsh plugin --profile web add dsh-plugin-teamflow` → 重启 `dsh --profile web` 即可使用

**你遇到过吗**：让 agent 改个 2000 行模块，它说「做完了」，一跑测试却悄悄破坏了 3 个旧行为？长任务里模型背着越读越长的上下文、又没人验收——**上下文膨胀 + 没有门禁**，是单会话 agent 的两个死穴。

**TeamFlow 就是冲这两个来的**：会话里说一句需求，拉起一支子代理团队跑完 `需求 → PRD →（UI/UX 设计）→（脚手架）→ 技术方案 → 并行开发 → QA → 验收`，产物全部落盘成文件、验收结论有契约、失败显式暴露、崩了能续跑、花的每分 token 都对得上官方账单——**重心在工程纪律，不是「一句话生成 App」的玩具**。

**当前版本 v0.2.0**（npm `latest`）。**如果你装过旧版，请先看下一节**——0.1.9 在新宿主上根本不工作。

> **看过上一版通稿（v0.1.8，[原帖 #6405](https://github.com/deepseek-ai/deepseek-harness/discussions/6405)）的读者**：建议只读这几处——「先说升级」、「核心特性」里的 ② 需求澄清闸门 / ⑧ 环境不可用早停 / ⑨ 流水线可中断 / ⑪ 最小侵入你的仓库、以及「给在做 dsh 插件的人」中标了 🆕 的条目；③④⑤⑥⑦ 与「它长什么样」「安装与上手」「实测基准」和上一版基本一致，可略过。

---

## 先说升级：为什么 0.1.9 必须换掉

dsh 从 `0.1.7-alpha.1` 起会话格式是 **v4**：宿主在事件被 Session 采纳**之前**校验 `source.kind`，要求 **producer-owned** 形态（`plugin:dsh-plugin-teamflow`）。0.1.9 发出去的还是 v3 时代的 wrapper（`{kind:'plugin', plugin}`），于是**所有实时注入事件被当场拒收**——团队上下文注入、完成汇报、护栏提醒三处全废，用户侧表现就是「插件整体不可用」。而 0.1.6-alpha.2 及更早**没有** v3→v4 迁移包，两代 source 形态互不兼容。结论：**0.2.0 是当前唯一能跑在 v4 宿主上的版本**。

| 项 | 值 |
|---|---|
| 兼容窗口 | `engines.dsh: ">=0.1.7-alpha.1 <0.2.0"`（作者声明，宿主不校验） |
| semver 实测 | `0.1.7-alpha.1/2`、`0.1.7`、`0.1.8`、`0.1.9` **通过**；`0.1.6-alpha.2`、`0.2.0*` **不通过** |
| 运行前提 | dsh **web profile**、Node ≥ 22.18、`$DSH_HOME` 可写（宿主级 `fs`） |

---

## 它长什么样

**全局面板** —— 左栏图标 → 跨会话 / 产品线视角（产品线 → run 列表 + Backlog）

![全局面板](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/global-panel.png)

**流水线视图** —— 阶段蛇形泳道 + 节点卡片（状态 / 耗时 / token / 子代理会话，2s 刷新）

![流水线视图](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/pipeline-view.png)

**阶段详情** —— 阶段性产物全文 + token 明细 + 跳转子代理会话

![阶段详情](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/stage-detail.png)

**Backlog 看板** —— 需求 / 任务 / 缺陷三组状态泳道，卡片拖拽流转（原生 HTML5 DnD，零依赖）

![Backlog 看板](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board.png)

**任务卡详情** —— 需求原文 / 分配 / 事件时间线 / 子卡 / 缺陷 / 按角色 token

![看板任务详情](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board-task-detail.png)

**团队选择** —— 一个 workspace 可配多支团队（团队 = 阶段集）

![团队选择](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/team-selector.png)

> 界面本身也**中英双语**，跟随宿主语言实时切换；英文版截图在 `docs/screenshots/en/`。

---

## 核心特性

### ① 五档阶段集 + 模型驱动分诊

`patch`（单点修复，开发自测兜底）/ `lite`（微功能，PRD 即契约）/ `tech` / `medium` / `full`。

默认由 `teamflow_triage` 读需求决定档位（正则只做确定性护栏），也可用调用参数强制指定。分诊的意义是**把流程重量匹配到需求规模**：`lite` 连独立技术方案文档阶段一起省掉（PRD 即契约），`patch` 更只有单点确认 + 开发。**🆕 v0.2.0**：档位不再任由模型随口选，架构护栏命中即强制升级到 `medium`。

### ② 🆕 需求澄清闸门（启动前拦，不建 run）

启动前复用**分诊那一次调用**跑一遍预检（合格线与自洽门禁由 host 判），命中就返回 `needs-clarification` 并**不建 run**——把「需求里没写清的边界」在你花钱之前问出来，而不是等验收阶段才发现做了个没人要的东西。**只有 `patch` 档豁免**；你已经给过补充说明就不再拦；续跑不重跑分诊（权威判定只在 pipeline 一处）。

### ③ 产物即文件（输出单轨制）

每个需求一个自包含任务夹 `docs/teamflow/<yyyyMMdd>-r<N>-<slug>/`，PRD / DESIGN / TECHNICAL / QA-REPORT / ACCEPTANCE 全部收口其中。

**QA 与验收的完整报告只写在文件里，子代理回复仅摘要 + 路径**；host 直接读文件解析——文件缺失或为空即**硬失败转人工，不回退去解析模型回复**。这样杜绝了「回复里说全绿、文件里其实没有」的双轨不一致。

### ④ 验收结论契约（v0.2.0 收紧）

验收报告的结论行必须是**字面量模板**（✅ / ⚠️ / ❌ / 📝 四档）且是**文件最后一行**。**找不到结论行 → 需人工确认，不猜结论**——旧实现会落到最乐观的「通过」，等于质量门禁漏报；正文里一句「无需改动」曾被朴素子串匹配误判成需求驳回，把整条流水线打成 failed。现在还有两条实测校准：结论行不能藏在 `## 1. 验收结论摘要` 这类标题后面（**会被标题带偏**）、📝 只认行首写法（**全文匹配会误判**）。缺陷解析同样**只认显式严重级表头**，无表头的整表跳过。

### ⑤ 断点续跑（按任务粒度）

每阶段 checkpoint 落盘 `$DSH_HOME/teamflow/<product>/runs/<runId>.json`（原子写 + `.bak` + 损坏自愈）。

进程崩溃 / 重启后自动标记 `interrupted`；`teamflow_resume` 从第一个未完成阶段继续，dev 阶段按**任务粒度**只补跑未成功的任务、复用已完成产物。重试时附「上次失败诊断包」（失败分类 / 护栏原因 / 拒绝词命中点 / 产出尾部）——把盲试变成带因重试。**🆕 v0.2.0**：任务身份只认 host 生成的 `dt-N`（标题双键会让同一任务在 backlog 里变两张卡）。

### ⑥ Token 计量走宿主官方口径 + 阶段熔断

每阶段 `usage` = 输入(未命中) / 输入(命中) / 写缓存 / 输出 + 调用数 + 缓存命中率。

来源是**官方 Session 投影**（`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶 + `'sessionStats'.steps` 取调用数），与宿主 token-meter 同一份 fold——**不自造第二份口径**。熔断用的是**新增**消耗（`input + cacheWrite + output`，**不含缓存命中**——缓存命中是廉价重放，计进去会让「任何一次失败都立刻熔断」，自动重试形同虚设），累计超 `FRESH_TOKEN_BUDGET`（默认 200k）即停止重试转人工；汇报与展示仍走官方 billed 口径。**🆕 v0.2.0**：预算随 provider 的缓存能力自适应（没有 prompt 缓存的供应商不会再因固定开销撞墙）。

### ⑦ QA 打回闭环

QA 缺陷 P0–P2 → 打回给开发确认 + 修复 → 复验 ≤2 轮，超限转人工（以「已知问题」只读跑验收，**不放行合回**）。

缺陷按 `reqId + defectId` 幂等登记，复验通过自动关单（P3 观察项保留）。dev 有失败任务时**直接拦在提测门外**，不进 QA 阶段白烧 token。

### ⑧ 进行中护栏 + 🆕 环境不可用早停

子代理跑飞了要能知道，更要**止损**。纯进度信号、**无时间配额**（慢吞吐的合法任务不该被打断）：**推理复读**（滑动窗口内同一流式片段反复出现且窗口内零写操作）、**挂死**（官方 `subagentTiming` 投影的 `active.through` 长时间不推进）、**空转**（仍在产出事件但长时间没有工具调用）。触发即 `dispose()` 中止本次尝试。背景是实测一次 QA 子代理推理复读死循环，**38 分钟烧掉 481 万 token、零产出**。

**🆕 v0.2.0 新增第五个早停信号 `env-unavailable`**：同一工具连续以**同一错误**失败（连续 2 次提醒 / 3 次中止，**不自动重试**，并且**优先于「完成了」**的判定），host 直接点名「环境不可用 + 原文错误」。这是被一次真实宿主故障打出来的——Windows 沙箱在用户自建目录上无法物化 ACL，导致该目录下所有 shell 命令 100% 失败，而模型只会反复重试再长篇推理，**一个阶段烧掉 52,588 输出 token、零产出**；加上这条判据后，同一工作区同一故障是 **1,510 token / 15 秒**收场。（该宿主问题已作为独立报告上报上游，见文末链接。）

### ⑨ 🆕 流水线可中断

三处入口共用一套两段式取消（点一下变确认），`cancelRun` 只认 `status === 'running'`；**并发多路一次全停**，取消后并发池不再取新任务。终态归一放在 `finally` 首句，取消来源落盘，且**取消态不会给模型续跑引导**（避免它自作主张重开）。

### ⑩ 团队工作台（会话内 + 全局）

会话头部一个 tab：「🏭 团队工作台」——流水线泳道图、Backlog 拖拽看板（需求 / 任务 / 缺陷）、成本中心（每阶段 token + 运行时长）、人工介入中心（needs-human 聚合 + 一键终态）、历史 run 切换。任务卡能一键把任务夹产物推到宿主**右侧栏**预览。**🆕 v0.2.0**：跨会话的**全局面板**（左栏图标 → 产品线视角）随 v0.1.8 交付；本版给它补上了中断入口（run 行直接可停）、把「跳转子代理会话」从静默降级改成**真跳转**（`uiWorkspace.openSession`），并完成中英双语。

### ⑪ 最小侵入你的仓库（旧版 ⑧「AGENTS.md 最小侵入」的完整版）

- **AGENTS.md 是你的资产，不是我们的**：检测到已存在就**绝不重写 / 重排 / 覆盖**，只在文末追加一个 `<!-- teamflow:begin/end -->` 指针托管块（已有则跳过，其余一行不碰）；产品记忆另放 `docs/teamflow/memory.md` 按需读取，不注入每次会话。停用后删掉托管块与 `docs/teamflow/` 即完全复原。
- **一个 run 一个 commit**：产品代码 + 任务夹（PRD / TECHNICAL / QA-REPORT / ACCEPTANCE）+ `memory.md` 落进同一次提交；**`logs/teamflow/` 永不入提交**（运行日志是过程证据，不是仓库内容），另有索引层摘出兜底。
- **`.gitignore` 只动一条、且只动该动的那条**：即将提交时幂等补一行 `logs/teamflow/`（插件自有日志，非交付物）；跑失败 / 被取消的 run **不会**给你留下未提交的 `.gitignore` 改动。**「你的项目该忽略什么」不由我们决定**——`node_modules/` 一类基线噪音只在 `git add` 的索引层排除（用 `git check-ignore` 判定，已被忽略的绝不点名）；旧实现曾把这些写进用户 `.gitignore`，已判为越界并回退。
- **写文件有边界，日志根不在你的项目里**：除产品代码与 AGENTS.md 托管区外，只在 `docs/teamflow/` 与本次 run 的日志暂存目录下写，**不碰你的 `docs/<职责>/`、也不往项目根扔文件**；run 期日志在工作区暂存 → 终态按白名单（检查脚本 / 笔记 / `captures.json`）归档到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删副本，每个工作区保留最近 20 次，命令输出与快照一律不落文件。

---

## 给在做 dsh 插件的人：几个踩过的坑

这部分可能比插件本身对社区更有用，都是实测结论：

- **🆕 会话 v4：注入事件的 `source.kind` 必须是 producer-owned**。宿主在采纳前校验，v3 那种 wrapper（`{kind:'plugin', plugin}`）会被**当场拒收**——注意它拒得**很安静**：插件照常加载、工具照常出现，只有注入不生效。要么 `plugin:<你的包名>`，要么别注入。（0.1.9 → 0.2.0 的整个升级动因就是这个。）
- **宿主的 strict codec 形状会变，变了就是「宿主起不来」**。v0.1.6-alpha.2 把 typert 严格描述符从 `{mode,typeSymbol,schema}` 换成 `{mode,typeSymbol,create}`，**注册即抛**——用户看到的是 dsh 启动失败，而不是插件报错。能按宿主版本探测就探测，至少要写进 README 的兼容窗口。
- **宿主级插件 vs 动态插件**：动态（会话内）插件跑在受限沙箱，`fs` 被硬限制在运行时根——实测 `file access denied under workspace-write mode`，写不了 `$DSH_HOME`。要真实 Node `fs` + 注册独立 tab，只能走宿主组合里的正式插件。
- **可以不用 `@Remote` 装饰器**：纯 JS 分发时不必引入装饰器语法 / TS 编译要求，改用 `ctx.typert.register(strict descriptors)`，描述符写成**纯数据**文件由 host / client 共用一份，endpoint 与 wire 参数不会各自漂移。
- **`cordis.patch.yml` 的 entry 名必须用包根**：用子路径会让 `clientModules` 扫不到 `dsh.client`，client **静默不注册**——这个坑非常安静，值得写进文档。
- **客户端跳会话只剩一个入口**：`uiWorkspace.openSession`。`sessions.openSubagent` / `sessions.open` 已被宿主移除，还在引用的话是「编译能过、运行时空」。
- **优先接官方通道，别自己复刻**：
  - 护栏轻提醒 → `run.localAgent.inject()`（宿主在协议安全边界整批认领，不用自己写 step/end 时序状态机）
  - 挂死检测 → `subagentTiming` 投影 `active.through`（我们读某个子代理的 `session.events` 快照视图会失明，用长度启发式误判过一次「10 分钟无事件」，实际它在正常干活）
  - 计量 → `tokenUsage` / `sessionStats` 投影；宿主改 key 我们跟着改，而不是维护第二份账单
  - 中断 → 官方 `SubagentRun.dispose()`
- **判据要用结构化字段，别猜文本**：环境故障检测我们第一版是猜错误文本，改判 `tool/result.isError === true` 之后才可靠（可用的结构化信号 + 老宿主的行首 `Error` 兜底）。
- **slot 注册要声明对应 owner 包的 optional peer**：注册进谁的 slot 就列进 `dsh.client.inject`，否则加载顺序不确定时会出现「slot 不存在」。
- **workspace 隔离 key 的真相**：宿主 `resolveByPath` 是异步的，插件同步调用拿不到 UUID，实际生效的是路径派生 `slugPath(cwd)`。我们把注释和文档改成了事实描述、把真修列进 TODO，而不是硬撑一句「优先用 UUID」。
- **`tsdown` 双配置**：host / store / descriptors 打 ESM `.mjs`，client 打 `__ModuleLoader__.load` 格式，两者出口不同不能混。
- **🆕 环境故障别让它伪装成模型故障**：宿主侧的沙箱 / 权限 / 路径问题往往只在工具结果里露一句话，模型会先重试再推理，最后撞上输出上限——你看到的是 `max-tokens`，真因在环境。给自己留一条「同一工具连续同一错误 → 停手并点名环境」的判据（我们这条叫 `env-unavailable`）。

---

## 已知限制 / 我们不承诺的事

- **只支持 web profile**（插件含浏览器端工作台，client 面向 web 平台）。
- **「7 阶段」是 full 档的最大集**：design / scaffold 是需要显式 flag 的条件阶段；`patch` 档只有 prd + dev，没有独立 QA / 验收。
- 全局产品线面板目前**只读**（没有 backlog 流转写路径）。
- dev 阶段末尾强制输出「验证证据块」（命令 + 退出码 + 断言计数 + 失败行引用），由 host 提取存证。它是**可审计的自述**，不是形式化保证——价值在于把「单方宣称全绿」变成结构化、可交叉核对的证据。
- 熔断阈值（`FRESH_TOKEN_BUDGET`，默认 200k）目前是常量，还没做成 service Config。
- 机械阶段的推理强度降档做过 A/B，但样本量还不足以支撑一个可信的节约比例，**因此我们不作宣称**。
- 质量门禁是**启发式判据**，不是形式化证明：每一条判据的来由、调整与反例都记在 ADR / benchmarks / devlog 里，可追溯、可复现。
- 跨父会话的子代理跳转受宿主能力限制（目前跨父时禁用并提示）。
- `$DSH_HOME/teamflow/` 的 `runs/` 目前**没有 TTL**（日志有遗忘机制：每工作区保留最近 20 次）。
- 目前是**单人项目**，欢迎 issue / PR。
- 本包**依赖 DeepSeek Harness 宿主，无法独立运行**（`peerDependencies` 全部由宿主注入：`@deepseek-ai/*` 若干 + `react`）。

---

## 安装与上手

```bash
# 从 npm 安装
dsh plugin --profile web add dsh-plugin-teamflow

# 或本地目录安装（开发时）
dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow

# 安装后必须重启才生效
dsh --profile web
```

装好后：

- 模型侧出现 12 个 `teamflow_*` 工具（`start` / `triage` / `status` / `backlog` / `claim` / `update` / `assign` / `cancel` / `resume` / `pause` / `resume_session` / `merge`）；
- 浏览器侧多出会话头部「🏭 团队工作台」tab，以及左栏的跨会话全局面板；
- backlog / run 记录写入 `$DSH_HOME/teamflow/<workspace>/`。

**环境要求**：dsh web profile、Node ≥ 22.18、`engines.dsh: ">=0.1.7-alpha.1 <0.2.0"`。

---

## 实测基准

同需求、同基线、两条执行路径的 A/B，做过两次，数字与复盘都在仓库里可复现：

| 基准 | 日期 | 需求规模 | 结果 |
|---|---|---|---|
| [pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/pipeline-vs-native.md) | 2026-08-20 | 较大（本地持久化改造） | 流水线**省约 39% token**、慢约 29%，功能等价 |
| [hold-pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/hold-pipeline-vs-native.md) | 2026-08-27 | 小（<300 行改动） | 流水线**多花 44% token**、慢 40%；但交付 470 行专项测试 + AC 逐条验收，原生漏实现 hold 音效（AC-16/17） |

两条数字看着方向相反，其实指向同一件事：**流水线多花的那部分成本买的是验收级质量**——专项测试、AC 逐条核对、整套文档是排他性产出，直接让模型干花不出这笔钱，代价就是漏实现悄悄过门。

**这两次跑在公开发布之前的内部版本（v0.10.x / v0.13）**；此后的质量优先改造（认知前置、QA 打回闭环、任务夹文档制）会进一步推高 token 与耗时。`docs/benchmarks/` 里还留有后续的对照测量与完整复盘，**数字与结论一律以仓库文档为准**。

**🆕 另外还有一篇不是 A/B 的对照**：我们把「TeamFlow 与 dsh 内置 Agent Teams（实验层）到底是不是同一类东西」做了一次**静态全面核对**（双方源码、文档、git 事实，逐项对照，**未做端到端对照实验**）。结论与证据都在文里，感兴趣可以直接读：[teamflow-vs-dsh-builtin-agent-team.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/teamflow-vs-dsh-builtin-agent-team.md)。

---

## 链接

- 仓库：https://github.com/MichaelShii/dsh-plugin-teamflow
- npm：https://www.npmjs.com/package/dsh-plugin-teamflow
- v0.2.0 发布说明（双语，含逐条变更与升级要点）：https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/releases/v0.2.0.md
- 架构决策记录（ADR 0001–0009）：https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/adr
- 基准与复盘（全部测量与复盘）：https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/benchmarks
- 开发日志：https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/devlog.md
- 待办与已知缺口：https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/TODO.md
- 🆕 上报给上游的宿主问题（Windows 沙箱 ACL provision 失败）：https://github.com/deepseek-ai/deepseek-harness/discussions/7538
- 🆕 上一版通稿原帖（v0.1.8，2026-09-12）：https://github.com/deepseek-ai/deepseek-harness/discussions/6405 —— 那帖评论里的「意图澄清」反馈（@tongwoojun / @zweix123）催生了本版 ②，而「有英文版吗」（@boshk0）是本版默认发英文稿的原因。

> **一致性提醒**：本文所有版本锚定（`v0.2.0` / `>=0.1.7-alpha.1 <0.2.0` / npm `latest`）写于 **2026-09-23**；发布后作者不再追改本文档（改了就等于把一份历史发言改成今天的话）——要看当前事实请以仓库 `README.md` 与 `CHANGELOG.md` 为准。
