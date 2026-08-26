# Changelog

> 本插件首次公开发布版本为 **v0.1.0**；发布前的内部迭代（v0.3~v0.13）记录于 `AGENTS.md` §5，对外统一归到 v0.1.0。

## [0.1.2] - 2026-08-26

### 变更
- 提示词指令层英文化（方案 A）：指令英文 + 输出契约中文（PRD 头部声明 / QA 缺陷表 / 验收结论等解析器锚点不变）；工具描述英文化
- backlog 卡片 / 详情抽屉跳转指定 run 的流水线视图（host `backlog` 附带 `runId` 映射）
- 详情抽屉长文本折叠（概览 / 需求原文默认预览几行，可展开收起）
- 断点重跑语义修正：阶段全 done 的 failed/cancelled 不再显示续跑按钮（host 硬拒绝兜底）；按钮/pill/chip 补 runId 全名可溯
- 架构蓝图提取回退任务夹 `TECHNICAL.md`（模型把蓝图写进文档而非回复输出时 M2 拆卡不再退化为整体开发）
- `meta.json` 改为静态标识卡（废弃终态回写，status/endedAt 权威在 journal）
- 开源发布元数据：keywords / homepage / bugs；`react` 移入 peerDependencies；README.en.md 与 CHANGELOG.md 显式进包

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
