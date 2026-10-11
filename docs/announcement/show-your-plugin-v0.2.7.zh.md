<!-- 通稿 · 中文版 · 锚定 **v0.2.7**（2026-10-11）· 投放平台待定（GitHub Discussion / 站外中文社区均可，正文不假设平台）
     **本版默认发英文稿**（`show-your-plugin-v0.2.7.en.md`），本文件是正文首行跳转的目标。
     建议标题（发帖时用）：
       ▶ 主选 dsh-plugin-teamflow v0.2.7：先确认「你要的」，再动手做
         （血缘：v0.1.8 原帖标题是「dsh-plugin-teamflow：把「一句话需求」跑成一条带质量门禁的多 Agent 研发流水线」；
           v0.2.0 通稿补了版本号。本版沿用「包名 + 版本 + 动词句」。）
       · 备用 [插件] TeamFlow v0.2.7 —— PRD 确认单 + 交付物不再混入机器契约
     本版是**短稿**：v0.2.0 那份 230 行的通稿仍在 `show-your-plugin-v0.2.0.zh.md`，产品全貌看它；
     本文只讲**这一版改了什么、为什么值得升**。历史通稿（v0.1.8）见 `github-discussion-show-your-plugin.md`（已冻结）。
     **上一版投放记录**：v0.1.8 通稿发于 `deepseek-ai/deepseek-harness` Discussions [#6405](https://github.com/deepseek-ai/deepseek-harness/discussions/6405)（2026-09-12）；v0.2.0 通稿发于同仓库 Discussions 中文 [#7539](https://github.com/deepseek-ai/deepseek-harness/discussions/7539) / 英文 [#7540](https://github.com/deepseek-ai/deepseek-harness/discussions/7540)（2026-09-22，均在 `Show Your Plugins!` 分类）。
     ⚠️ **订正（2026-10-11）**：本行原文误记「v0.2.0 通稿迄今未投放」——实为 2026-09-22 已投放（#7539 / #7540）。误因：查投放记录时只取了该仓库**最新 50 帖**的时间窗，未用全量检索；v0.2.0 已落到窗口之外，于是把「查不到」当成了「没发过」。⇒ 查外部投放记录一律走**全量 search**，不要用 `first:N` 的时间窗。
     **本版投放记录**：英文 [#9446](https://github.com/deepseek-ai/deepseek-harness/discussions/9446) / 中文 [#9447](https://github.com/deepseek-ai/deepseek-harness/discussions/9447)（2026-10-11，`Show Your Plugins!`）。
     引用的一切数字都可在仓库内逐字核对（来源见各条括注）。
     ➜ 发布后本文件同样停止更新；再发通稿请另建文件并写当时的锚定版本。 -->

中文 | [English](./show-your-plugin-v0.2.7.en.md)

> `dsh plugin --profile web add dsh-plugin-teamflow` → 重启 `dsh --profile web` 即可使用

**你遇到过吗**：一句话丢给 agent，它做完了，你一看——**不是你要的**。它没做错，是你没说过；而它把「没说过」的部分当成了自己的假设，安静地写进了规格里。

**TeamFlow 就是冲这个来的**：说一句需求，拉起一支子代理团队跑完 `需求 → PRD → 技术方案 → 并行开发 → QA → 验收`，产物全部落盘成文件、验收结论有契约、失败显式暴露、崩了能续跑。

**当前版本 v0.2.7**（44 笔提交 / 39 个文件 / +3724 −279 行）。本版**无破坏性**，装完重启即可。

---

## 这一版改了什么

### ① PRD 确认单：先确认「你要的」，再动手

流水线跑到 PRD 结束后会**停下来问你**——但只在**真的需要你定**的时候：

- 需求里出现**主观品味项**（美术风格 / 交互形态 / 人设 / 数据怎么存……）⇒ 暂停，把假设摊开给你，你改完再开工；
- 纯**信息缺口**（「用哪个库」这种有客观答案的）⇒ **不打断**，按推荐值继续跑。

这条设计有个刻意的取向：**不靠模型能力强度来替代这层把控**。好模型会越来越不需要澄清，但「产品长什么样」是你的决定——插件的作用是引导 + 降低你的理解成本，不是替你把主观项拍死。

> 落点：PRD 的假设段现在分两类——**未定事实** 与 **主观品味项**，确认单只对后者停。

### ② 交付物里不再混进机器契约

以前，流水线用来在阶段之间传递结构的那两段机器数据（状态块 / 架构蓝图），会**出现在你能看到的文本里**——子任务卡片上、Markdown 预览里、交付文档末尾。有用户截图反馈过：**一大段 JSON 就这么摊在眼前**。

本版把它从「人类可读通道」里**彻底移出**：

- 架构蓝图改走**独立文件**（不再写进 `TECHNICAL.md`——真机实测它曾占该文档 **31%** 的字符）；
- 状态块同理，文件里就是**纯 JSON**，连包裹标记都去掉了；
- 交付文档（PRD / TECHNICAL / QA-REPORT / ACCEPTANCE）现在**不含任何机器标记**，在 Typora / VS Code 里打开就是干净的正文。

### ③ 断点续跑四处修复

- **确认单暂停后无法续跑** —— 无断点判据用错了代理（「已记录阶段全 done」在零阶段 run 上恒为假）；
- **同一 run 内状态不刷新** —— 合并函数返回新对象而调用点丢了返回值，导致前一个阶段写下的结论，后续阶段**看不见**；
- **零阶段 run 断点错位** —— 「什么都没做」与「什么都做完了」共用同一个返回值，续跑会**跳过需求澄清与开发、直接拿空 PRD 跑验收**；
- **任务标签把「首次尝试」说成「补跑」** —— 确认单暂停后续跑，开发明明一次都没跑过，12 个任务全标着「补跑」，读起来像上次跑挂了。

---

## 升级

**无破坏性**，直接升即可：

```
dsh plugin --profile web add dsh-plugin-teamflow   # 或应用内插件市场
# 重启 dsh --profile web / 桌面版重启桌面应用
```

两个从公开工具参数里**摘掉**的字段（`needConfirm` / `clarifyStrength`）改由环境变量控制（`TEAMFLOW_CONFIRM` / `TEAMFLOW_CLARIFY`）；若你的调用里传过它们，**不会报错，只是被忽略** —— 这两个开关现在由需求内容自动驱动，不需要你手动设。

---

## 链接

- 仓库：https://github.com/MichaelShii/dsh-plugin-teamflow
- 本版 Release（完整变更清单，中英双语）：https://github.com/MichaelShii/dsh-plugin-teamflow/releases/tag/v0.2.7
- 上一版通稿（产品全貌，230 行）：[v0.2.0](./show-your-plugin-v0.2.0.zh.md)
- 反馈：issue 或 Discussions 均可；提缺陷时附上 `dsh --version` 与插件版本
