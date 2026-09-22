<!-- ⛔ 定稿冻结（2026-09-23 标记）——本通稿已随 **v0.1.8** 发布（GitHub Discussion），内容停止更新。
     文中版本锚定（`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`、「开发与验证锚定 v0.1.5-rc.2」）是**发布当时**的事实；
     其后 dsh 与插件均已演进（当前：dsh v0.1.7-alpha.1，下限 `>=0.1.7-alpha.1 <0.2.0`，见 README「版本锚定」段），
     此处**不再追改**——改它就等于把一份历史发言改成今天的话。
     ➜ 要发新通稿请**另建文件**，并写当时的锚定版本；本文件只作历史留存。
     ➜ v0.2.0 新通稿（2026-09-23）：`show-your-plugin-v0.2.0.zh.md` / `show-your-plugin-v0.2.0.en.md` —— 中英各一份完整正文，投放平台待定。
     （原「发布前检查」清单已随发布完成退休，如需查阅见 git 历史提交 5989395。） -->

> `dsh plugin --profile web add dsh-plugin-teamflow` → 重启 `dsh --profile web` 即可使用

**你遇到过吗**：让 agent 改个 2000 行模块，它说「做完了」，一跑测试却悄悄破坏了 3 个旧行为？长任务里模型背着越读越长的上下文、又没人验收——**上下文膨胀 + 没有门禁**，是单会话 agent 的两个死穴。

**TeamFlow 就是冲这两个来的**：会话里说一句需求，拉起一支子代理团队跑完 `需求 → PRD → （UI/UX 设计）→ （脚手架）→ 技术方案 → 并行开发 → QA → 验收`，产物全部落盘成文件、验收结论有契约、失败显式暴露、崩了能续跑、花的每分 token 都对得上官方账单——**重心在工程纪律，不是「一句话生成 App」的玩具**。

---

## 为什么做这个

单会话长任务有两个绕不开的问题：

1. **上下文膨胀**：模型反复整读同一份文件后，后续**每一次**调用都要背着不断变长的缓存前缀。一次实测的原生单会话长任务里，billed token 的 **96% 是缓存重放**（16.8M / 17.48M），真正的思考与生成只有 0.83M——token 大头不是「想」，是「同一份文件被读了又读」。流水线的对策是**上下文隔离**：任务切给多个子代理，每个只读自己需要的文件，阶段之间用文件交接，而不是靠对话记忆。
2. **没有门禁**：让模型直接干，没有 QA / 验收环节——回归盲区里的验收项会静默漏实现、测试零覆盖也能提交。同一需求的两条路径对照里，只有流水线那条逼出了 470 行专项测试 + AC 逐条核对（原生那条漏了 AC-16/17）。

---

## 它长什么样

**流水线视图** —— 阶段蛇形泳道 + 节点卡片（状态 / 耗时 / token / 子代理会话，2s 刷新）

![流水线视图](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/pipeline-view.png)

**Backlog 看板** —— 需求 / 任务 / 缺陷三组状态泳道，卡片拖拽流转（原生 HTML5 DnD，零依赖）

![Backlog 看板](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board.png)

**阶段详情** —— 阶段性产物全文 + token 明细 + 跳转子代理会话

![阶段详情](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/stage-detail.png)

**任务卡详情** —— 需求原文 / 分配 / 事件时间线 / 子卡 / 缺陷 / 按角色 token

![看板任务详情](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board-task-detail.png)

---

## 核心特性

### ① 五档阶段集 + 模型驱动分诊

`patch`（单点修复，开发自测兜底）/ `lite`（微功能，PRD 即契约）/ `tech` / `medium` / `full`。

默认由 `teamflow_triage` 读需求决定档位（正则只做确定性护栏），也可以用调用参数强制指定。分诊的意义是**把流程重量匹配到需求规模**，避免「一个微功能套完整瀑布」：`lite` 档连独立技术方案文档阶段一起省掉（PRD 即契约），`patch` 档更只有单点确认 + 开发。

### ② 产物即文件（输出单轨制）

每个需求一个自包含任务夹 `docs/teamflow/<yyyyMMdd>-r<N>-<slug>/`，PRD / DESIGN / TECHNICAL / QA-REPORT / ACCEPTANCE 全部收口其中。

**QA 与验收的完整报告只写在文件里，子代理回复仅摘要 + 路径**；host 直接读文件解析——文件缺失或为空即**硬失败转人工，不回退去解析模型回复**。这样杜绝了「回复里说全绿、文件里其实没有」的双轨不一致。

### ③ 验收结论契约

验收报告的结论行必须是字面量模板（✅ / ⚠️ / ❌ / 📝 四档）且是文件最后一行。

**找不到结论行 → 需人工确认，不猜结论。** 旧实现会落到最乐观的「通过」，等于质量门禁漏报；另外正文里一句「无需改动」曾被朴素子串匹配误判成需求驳回，把整条流水线打成 failed——现在改成「独立断言词 + 否定保护」，误杀和漏报都真实踩过。

### ④ 断点续跑

每阶段 checkpoint 落盘 `$DSH_HOME/teamflow/<product>/runs/<runId>.json`（原子写 + `.bak` 备份 + 损坏自愈）。

进程崩溃 / 重启后自动标记 `interrupted`；`teamflow_resume` 从第一个未完成阶段继续，dev 阶段按**任务粒度**只补跑未成功的任务、复用已完成产物。重试时会附「上次失败诊断包」（失败分类 / 护栏原因 / 拒绝词命中点 / 产出尾部）——把盲试变成带因重试。

### ⑤ Token 计量走宿主官方口径 + 阶段熔断

每阶段 `usage` = 输入(未命中) / 输入(命中) / 写缓存 / 输出 + 调用数 + 缓存命中率。

来源是**官方 Session 投影**（`ctx.sessionProjections.stateOf(session,'tokenUsage')` 取四桶 + `'sessionStats'.steps` 取调用数），与宿主 token-meter 同一份 fold——**不自造第二份口径**。熔断用的是**新增**消耗（`input + cacheWrite + output`，**不含缓存命中**——缓存命中是廉价重放，计进去会让「任何一次失败都立刻熔断」，自动重试形同虚设），累计超 `FRESH_TOKEN_BUDGET`（默认 200k）即停止重试转人工；汇报与展示仍走官方 billed 口径。上下文耗尽一类「重试大概率复现」的失败不重试。

### ⑥ QA 打回闭环

QA 缺陷 P0-P2 → 打回给开发确认 + 修复 → 复验 ≤2 轮，超限转人工。

缺陷按 `reqId + defectId` 幂等登记，复验通过自动关单（P3 观察项保留）。dev 有失败任务时**直接拦在提测门外**，不进 QA 阶段。

### ⑦ 进行中护栏

子代理跑飞了要能知道，更要**止损**。三条纯进度信号，**无时间配额**（慢吞吐的合法任务不该被打断）：

- **推理复读** —— 滑动窗口内同一流式片段反复出现，且窗口内零写操作（大文件 read-edit 循环属正常模式，不中止）
- **挂死** —— 官方 `subagentTiming` 投影的 `active.through` 长时间不推进
- **空转** —— 会话仍在产出事件，但长时间没有任何工具调用

触发即 `dispose()` 中止本次尝试。背景是实测一次 QA 子代理推理复读死循环，**38 分钟烧掉 481 万 token、零产出**。

### ⑧ AGENTS.md 最小侵入

AGENTS.md 会被 harness 无条件注入每个会话，是**团队资产**。检测到已存在就**绝不重写 / 重排 / 覆盖**，只在文末追加一个 `<!-- teamflow:begin/end -->` 指针托管块；产品记忆放 `docs/teamflow/memory.md` 按需读取（不注入每次会话）。停用后删掉托管块与 `docs/teamflow/` 即完全复原。

### ⑨ 团队工作台

会话头部一个 tab：「🏭 团队工作台」——流水线泳道图、Backlog 拖拽看板（需求 / 任务 / 缺陷）、成本中心（每阶段 token + 运行时长）、人工介入中心（needs-human 聚合 + 一键终态）、历史 run 切换。任务卡能一键把任务夹产物推到宿主**右侧栏**预览。

> 全局产品线面板（侧边栏图标 + 中央主区整块切换）已在 `release-v0.1.8`，随 v0.1.8 发布。

---

## 给在做 dsh 插件的人：几个踩过的坑

这部分可能比插件本身对社区更有用，都是实测结论：

- **宿主级插件 vs 动态插件**：动态（会话内）插件运行在受限沙箱，`fs` 被硬限制在运行时根——实测 `file access denied under workspace-write mode`，写不了 `$DSH_HOME`。要真实 Node `fs` + 注册独立 tab，只能走宿主组合里的正式插件。
- **可以不用 `@Remote` 装饰器**：宿主插件以纯 JS 分发时不必引入装饰器语法 / TS 编译要求，改用 `ctx.typert.register(strict descriptors)`，描述符写成**纯数据**文件由 host / client 共用一份，endpoint 与 wire 参数不会各自漂移。
- **`cordis.patch.yml` 的 entry 名必须用包根**：用子路径会让 `clientModules` 扫不到 `dsh.client`，client 静默不注册——这个坑非常安静，值得写进文档。
- **优先接官方通道，别自己复刻**：
  - 护栏轻提醒 → `run.localAgent.inject()`（宿主在协议安全边界整批认领，不用自己写 step/end 时序状态机）
  - 挂死检测 → `subagentTiming` 投影 `active.through`（我们读某个子代理的 `session.events` 快照视图会失明，用长度启发式误判过一次「10 分钟无事件」，实际它在正常干活）
  - 计量 → `tokenUsage` / `sessionStats` 投影；宿主改 key 我们跟着改，而不是维护第二份账单
- **slot 注册要声明对应 owner 包的 optional peer**：注册进谁的 slot 就列进 `dsh.client.inject`，否则加载顺序不确定时会出现「slot 不存在」。
- **workspace 隔离 key 的真相**：宿主 `resolveByPath` 是异步的，插件同步调用拿不到 UUID，实际生效的是路径派生 `slugPath(cwd)`。我们把注释和文档改成了事实描述、把真修列进 TODO，而不是硬撑一句「优先用 UUID」。
- **`tsdown` 双配置**：host / store / descriptors 打 ESM `.mjs`，client 打 `__ModuleLoader__.load` 格式，两者出口不同不能混。

---

## 已知限制 / 我们不承诺的事

- **只支持 web profile**（插件含浏览器端工作台，client 面向 web 平台）。
- **「7 阶段」是 full 档的最大集**：design / scaffold 是需要显式 flag 的条件阶段；`patch` 档只有 prd + dev，没有独立 QA / 验收。
- 全局产品线面板目前**只读**（没有 backlog 流转写路径）。
- dev 阶段末尾强制输出「验证证据块」（命令 + 退出码 + 断言计数 + 失败行引用），但**模型仍可以伪造**——它只是把「单方宣称全绿」变成「可审计的自述，且伪造容易被交叉核对发现」。
- 熔断阈值（`FRESH_TOKEN_BUDGET`，默认 200k）目前是常量，还没做成 service Config。
- 机械阶段推理强度降档做过 A/B，但 **n=3 下统计上不可分，所以文档里明确不宣称节约百分比**——要可信数字需要更大任务样本。
- 质量门禁全是**启发式**，不是形式化保证：误杀和漏报都真实发生过（复读误杀、挂死误杀、验收漏报），复盘都在 ADR / benchmarks / devlog 里，没有藏。
- 目前是**单人项目**，欢迎 issue / PR。
- 本包**依赖 DeepSeek Harness 宿主，无法独立运行**（`peerDependencies` 全是 `@deepseek-ai/*`）。

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
- 浏览器侧多出会话头部「🏭 团队工作台」tab；
- backlog / run 记录写入 `$DSH_HOME/teamflow/<workspace>/`。

**环境要求**：dsh web profile、Node ≥ 22.18、`engines.dsh: ">=0.1.5-rc.2 <0.2.0"`（开发与验证锚定 v0.1.5-rc.2）。

---

## 实测基准（诚实附录，含我们输的那两次）

我们做过三次**同需求、同基线、两种执行路径**的 A/B，**把我们输的那些也一起留在仓库里**：

| 基准 | 日期 | 需求规模 | 结果 |
|---|---|---|---|
| [pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/pipeline-vs-native.md) | 2026-08-20 | 较大（本地持久化改造） | 流水线**省约 39% token**、慢约 29%；功能等价，但**代码架构质量原生明显更强** |
| [hold-pipeline-vs-native.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/hold-pipeline-vs-native.md) | 2026-08-27 | 小（<300 行改动） | 流水线**多花 44% token**、慢 40%；但交付 470 行专项测试 + AC 逐条验收，原生漏实现 hold 音效 |
| [assetd-clarity-vs-gate.md](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/benchmarks/assetd-clarity-vs-gate.md) | 2026-09-11 | 中（既有代码 + 跨 8 模块 + 旧格式兼容） | **平局**：盲测 23:23、零假交付；流水线多花 **≈3.6× token / ≈1.7× 时间** |

**前两次跑在公开发布之前的内部版本（v0.10.x / v0.13）**——此后的「认知前置 + 架构落地」（M0 状态核对 / 蓝图全模式启用 / 按蓝图拆任务 / 架构核验）、QA 打回闭环、任务夹文档制都是**质量优先的加法**，会推高 token 与耗时。

**第三次是对当前开发线的实测**：盲测集是**对两条路径都不公开**的 held-out 用例（26 条可见 + 23 条盲测），结论是**质量完全相同**，而代价约 3.6× token。**输得这么明确的原因值得写出来**——那份需求书把验收边界写死了：23 条盲测点全部有明确依据，于是测的变成「有没有老实执行写了的」，两条路径都老实执行了。

**把它和第二次并排看，是我们目前得到的最有价值的一条结论**：

> **流水线质量门禁的边际价值 ≈ 需求书里的歧义存量。**
> 需求书把边界写全 → 门禁价值趋零，只剩成本；
> 需求书留白 → 门禁是唯一能兜住「静默漏实现」的机制（第二次基准里原生就漏了 AC-16/17 音效）。

所以**这三个数字都不适合当卖点**（方向不一致，且第三次我们明确输了）。真正的收益在别处：**那次基准反过来钉出了我们 4 个真实缺陷**（交付误判 `insubstantial`、熔断口径误计缓存命中、收口提交扫入自有日志、日志路径作用域写错），全部已在后续版本修复并配了回归测试。

能确定的趋势仍是**规模拐点**：需求越大，上下文隔离收益越大；需求越小，固定开销（文档 / 门禁 / 子代理数）占比越高，流水线可能反而更贵。**但第三次基准补上了更关键的一条**：需求书**写得多清楚**与需求**多大**同样重要，甚至更重要。

---

## 链接

- 仓库：https://github.com/MichaelShii/dsh-plugin-teamflow
- npm：https://www.npmjs.com/package/dsh-plugin-teamflow
- 架构决策记录（ADR 0001–0008）：https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/adr
- 基准与复盘（含我们输的那次）：https://github.com/MichaelShii/dsh-plugin-teamflow/tree/main/docs/benchmarks
- 开发日志：https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/devlog.md
- 待办与已知缺口：https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/TODO.md

---

## English summary

**dsh-plugin-teamflow** is a host plugin for dsh's `web` profile. Give it a one-line requirement in a session and it runs a multi-agent R&D pipeline — `requirement → PRD → (UI/UX design) → (scaffold) → technical plan → parallel dev → QA → acceptance` — with artifacts written to files, token usage read from the host's official Session projections, and crash-safe resume.

Install: `dsh plugin --profile web add dsh-plugin-teamflow`, then restart `dsh --profile web`.

Highlights: five stage-set tiers with model-driven triage · artifacts-as-files single track (QA/acceptance reports only count as files; missing file = hard fail, no fallback to parsing the reply) · literal acceptance-verdict contract (no verdict line → human needed, never assume pass) · stage-level checkpoint + resume that re-runs only failed tasks · official token accounting plus a per-stage circuit breaker · QA → dev rework loop with bounded retries · in-flight guard that aborts degenerate/stalled/reasoning-loop subagents (one real case: a QA subagent looped for 38 minutes and burned 4.81M tokens with zero output).

Honest limits: web profile only; "7 stages" is the maximum set of the `full` tier; quality gates are heuristics, not formal guarantees; the dev-evidence block can still be fabricated; it requires the DeepSeek Harness host and cannot run standalone.

Benchmarks — including the runs where the pipeline **lost** — live in `docs/benchmarks/`. The first two were measured on pre-release internal builds (v0.10.x / v0.13) and later releases added quality-first work (cognition bootstrap, QA rework loop, per-requirement task folders) that raises both tokens and wall-clock. The **third** re-measures the current dev line, and it is an honest tie: blind held-out cases (26 visible + 23 never shown to either arm) came out **23:23 with zero fake deliveries**, at **~3.6× token / ~1.7× wall-clock**. Read together they point at a single variable: **the pipeline's quality-gate value ≈ the amount of ambiguity left in the requirement doc** — write the acceptance boundary out in full and the gate's edge goes to zero, leaving only cost; leave it open and the gate is the only thing that catches silently-unimplemented acceptance items. Those runs also drove four real product fixes (delivery misjudgment, circuit-breaker basis, commit surface, log-path scope). Feedback and issues are welcome.
