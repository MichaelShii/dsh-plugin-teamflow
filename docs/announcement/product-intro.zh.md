<!-- 站外产品宣传文草稿（首次投放：知乎 / CSDN / 博客园通用 markdown）
     定位：产品介绍 + 上手教程，面向完全不知道 dsh / TeamFlow 的冷启动读者
     锚定：插件 v0.2.1（2026-09-25，npm latest）· 宿主窗口 >=0.1.7-alpha.1 <0.2.0
     发布前待办：
     1. 截图：raw.githubusercontent 直链在三个站都会挂 → 全部上传平台图床后替换 URL
     2. 知乎需 markdown 转换（CSDN / 博客园可直接贴）
     3. 文中历史事故数字均已在文内标注版本与日期；A/B 百分比未引用（对最新版不可外推）
     4. 标题备选见文末注释 -->

# 别再让 AI「说做完了」就算完：我给多 Agent 编程做了条带验收门禁的流水线（开源）

> 你让 AI 改一个 2000 行的模块，它说「做完了」。你一跑测试——悄悄破坏了 3 个旧行为。你说它错了，它道歉、再改、又坏两处。**整个过程没有人验收，模型背着越读越长的上下文独自工作。**

## 两个死穴

用单个会话的 AI agent 做正经开发任务，我们实测下来有两个绕不开的死穴：

**上下文膨胀**：长任务里，模型背着越来越长的历史读代码，读到后面忘了前面。我们实测过一次 QA 任务里的推理死循环：**38 分钟、481 万 token、零产出**（2026-08 实测，护栏上线前的数据）。

**没有门禁**：「做完了」是模型的单方宣称。没有独立验收环节，没有可核对的证据，质量全凭运气。

TeamFlow（`dsh-plugin-teamflow`）就是冲这两个死穴来的开源项目：在会话里说一句需求，它拉起一支分工明确的子代理团队，跑完

```
需求 → PRD →（UI/UX 设计）→（脚手架）→ 技术方案 → 并行开发 → QA → 验收
```

每个阶段有独立的 agent、独立的上下文、独立的验收标准。**重心是工程纪律，不是「一句话生成 App」的玩具**——这是它和大部分 AI 编程演示的根本区别。

## 它长什么样

**流水线视图**：阶段泳道 + 节点卡片（状态 / 耗时 / token / 可点进子代理会话，2s 刷新）

![流水线视图](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/pipeline-view.png)

**全局面板**：跨会话的产品线视角，每个 run 可直接中断

![全局面板](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/global-panel.png)

**Backlog 看板**：需求 / 任务 / 缺陷三组泳道，卡片拖拽流转

![Backlog 看板](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board.png)

**任务卡详情**：需求原文 / 事件时间线 / 子卡 / 缺陷 / 按角色 token

![任务卡详情](https://raw.githubusercontent.com/MichaelShii/dsh-plugin-teamflow/main/docs/screenshots/board-task-detail.png)

界面本身中英双语，跟随宿主实时切换。

## 五个设计决策（也是它和「提示词工程」的区别）

**① 流程重量匹配需求规模。** 单点修复不必跑七阶段。每次启动由模型分诊决定档位：`patch`（单点修复）/ `lite`（PRD 即契约）/ `tech` / `medium` / `full`，也可以手动指定。小需求省 token，大需求不省门禁。

**② 产物即文件，报告只认文件。** 每个需求一个自包含任务夹，PRD / 技术方案 / QA 报告 / 验收报告全部落盘。QA 的完整报告**只写在文件里**，子代理回复仅是摘要——文件缺失即硬失败转人工，**不回退去解析模型回复**。这杜绝了「回复里说全绿、文件里其实没有」。

**③ 验收结论是字面量契约。** 验收报告最后一行必须是四档结论之一（✅/⚠️/❌/📝），找不到结论行就转人工，**不猜结论**。旧实现曾把一句「无需改动」误判成需求驳回、把整条流水线打成失败——这类反例全部沉淀成了判据。

**④ QA 打回闭环。** QA 发现 P0–P2 缺陷 → 打回给开发 agent 确认修复 → 复验，最多两轮，超限转人工。dev 有失败任务时直接拦在提测门外，不烧 QA 的 token。

**⑤ 钱，按官方账单算。** Token 计量直接读宿主官方 Session 投影，不自造第二份口径；累计新增消耗超预算（默认 200k）自动熔断转人工。UI 里每阶段的 token 都能和官方账单对上。

## 两个最近落地的问题（v0.2.1）

**并行开发不互相踩文件。** 多个开发 agent 并行时，写集有交集的任务自动合并串行；「B 要读 A 正在改的文件」这类依赖做成分波调度——波内并行、波间屏障，实测屏障精确到秒。这是社区 issue 反馈「多个 agent 抢同一个文件」的完整答案。

**Windows 新目录首跑必撞的沙箱授权失败，启动前自动自愈。** 数据盘新建目录的继承 ACL 缺一个 `WRITE_OWNER` 权限位，沙箱授权必败——以前每次都要人工排查几分钟。现在流水线启动前预检自动补 ACE（不需要管理员），实测全 run 零授权错误。

## 上手

TeamFlow 是 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai/deepseek-harness)宿主的插件。dsh 是一个开源的 agent 运行时（含桌面 web 界面），插件跑在它的 web profile 里：

```bash
# 安装插件
dsh plugin --profile web add dsh-plugin-teamflow

# 重启生效
dsh --profile web
```

装好后：模型侧出现 12 个 `teamflow_*` 工具，浏览器侧多出「🏭 团队工作台」和全局面板。模型侧自备一个 DeepSeek API key（dsh 配置里填）；环境要求：dsh web profile、Node ≥ 22.18；实测与验收都在 Windows 上，其他平台未经我们验证（ACL 自愈问题仅 Windows 存在）。

**需要诚实说的**：TeamFlow 依赖 dsh 宿主、无法独立运行；质量门禁是启发式判据不是形式化证明（每条判据的来由都记在 ADR 和基准文档里，可追溯）；机械阶段的推理降档做过 A/B 但样本量不够，**所以我们不作宣称**。完整的已知限制见仓库文档——写文章不等于藏短板。

## 链接

- 仓库（含架构文档 / ADR / 基准复盘）：https://github.com/MichaelShii/dsh-plugin-teamflow
- npm：https://www.npmjs.com/package/dsh-plugin-teamflow
- 宿主 dsh：https://github.com/deepseek-ai/deepseek-harness
- 版本说明：[v0.2.1](https://github.com/MichaelShii/dsh-plugin-teamflow/blob/main/docs/releases/v0.2.1.md)

单人项目，欢迎 issue / PR / 星。

---

<!--
标题备选：
- 主选（知乎味）：别再让 AI「说做完了」就算完：我给多 Agent 编程做了条带验收门禁的流水线（开源）
- CSDN/博客园味：开源一个多 Agent 开发流水线：一句话需求 → 并行开发 → QA 打回 → 契约验收
- 稳妥版：TeamFlow：把「一句话需求」跑成可验收交付的开源多 Agent 流水线（v0.2.1）

历史数字锚定说明（发布时保留在文内即可）：
- 38 分钟 / 481 万 token：2026-08 实测，早停护栏上线前（护栏已在现版本交付）
- 并行屏障「精确到秒」、ACL「全 run 零授权错误」：v0.2.1 发布前验收 run（2026-09-24），journal 可核对
-->
