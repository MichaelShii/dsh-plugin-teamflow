# ADR-0002：AGENTS.md 最小侵入（共识层 / 运营数据分离）

- 状态：已接受（Accepted）
- 日期：2026-08（v0.3.0）
- 关联：`host/index.js`（AGENTS_TEMPLATE v2 / MEMORY_TEMPLATE / productCtx 边界约束）

## 背景

产品经理/验收环节把迭代历史（产品记忆表）、待办清单直接写进产品 `AGENTS.md`。已有项目团队接入时，这是他们的团队资产（被 harness 无条件注入每次会话）。

## 决策

- AGENTS.md 只放**稳定共识层**：团队角色流程、工程约定、文档索引、`<!-- teamflow:begin/end -->` 托管区（仅指针）
- 产品记忆/待办放独立活文档 `docs/teamflow/memory.md`（按需读取）
- 已有项目：检测到 AGENTS.md 已存在 → 绝不重写/重排/覆盖，仅在文末追加托管块（若没有）
- TeamFlow 只维护托管区与 `docs/teamflow/`；停用时删这两处即完全复原

## 理由

- **覆写风险**：已有团队自己的 AGENTS.md 约定会被流水账重排/覆盖，破坏其 agent 体系
- **职责混淆 → token 注入成本**：AGENTS.md 每次会话无条件注入，高频运营数据（每迭代追加）塞进去 = 文档膨胀 × 每次都读
- **退出残留**：团队停用后账本死数据留在 AGENTS.md 继续注入

## 影响

- 新项目脚手架创建"共识层 AGENTS.md + memory.md 骨架"两个文件
- 各环节提示词（PRD/验收）的记忆回写目标改为 memory.md，并明示不得触碰托管区外内容
- 多产品线各自独立 memory.md + backlog，不串味
