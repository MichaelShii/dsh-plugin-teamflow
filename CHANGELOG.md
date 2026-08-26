# Changelog

> 本插件首次公开发布版本为 **v0.1.0**；发布前的内部迭代（v0.3~v0.13）记录于 `AGENTS.md` §5，对外统一归到 v0.1.0。

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
