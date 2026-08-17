# ADR-0004：需求分诊路由 + 共享状态分层（full / lite / tech + Context Bundle）

- 状态：已接受为设计方向（实现分二期，见「影响」）
- 日期：2026-08（v0.8.0 起规划）
- 关联：`host/index.ts`（lite 已实现）、`docs/adr/0001`（编排仍自研，不引入 LangGraph）、`docs/adr/0003`（token 累计口径）

## 背景

1. **不是所有需求都该走完整 PRD**（用户反馈）：
   - 完整新功能 → 产品/技术 leader 评估是否接 → 完整流程；
   - 微功能小改动 → 轻量（已由 `lite` 覆盖）；
   - **技术驱动改造**（架构升级、代码优化、重构、hotfix）→ 产品只需要"知道并同步记忆"，不需要完整 PRD：变更单 → 开发 → QA → 上线。
2. **token 随工程增长呈指数风险**：每个子代理是新会话（零父上下文），各自重新读 AGENTS/SUMMARY/PRD/TECH 全文 → read 重复 + cacheRead 重放（实测占 95%）。痛点 = **共享状态缺失 / 每个"会话"都要重新建立全量认知**。

## 决策

### 1. 需求分诊路由：三档流水线形态 `mode: full | lite | tech`
| mode | 适用 | 阶段 |
|---|---|---|
| `full`（默认） | 完整新需求 / 跨模块 | 现状 7 段（PM 先评估是否接）|
| `lite`（已实现）| 单模块小功能 / 微增强 | PRD → 开发 → QA → 验收（4 段，跳过 design/tech 文档阶段）|
| `tech`（待实现）| 技术驱动改造 / hotfix | **技术变更单**（非完整 PRD：PM 只做范围评估 + 任务卡 + 记忆同步）→ 开发 → QA → 上线 |

- 路由时机：调用方（模型）在 `teamflow_start` 前判断需求类型；提供 `lite` 已支持，`tech` 新增；可选提供 `teamflow_triage` 辅助判定（启发式关键词 + 让模型评估），并允许显式传 `mode`。
- `tech` 的关键差异：PRD 环节不产出 `docs/prd/PRD.md` 全文，改为极简「技术变更单」+ `memory.md` 记忆回写（见 ADR-0002 的产品记忆通道），开发按任务卡 + 技术契约实施。

### 2. 共享状态分层（回应 LangGraph "shared state" 概念，但不换编排）
沿 ADR-0001 的结论：编排/checkpoint 继续自研（journal）；这里补的是**输入侧状态共享**，目标是"少读、精读、跨流水线复用"，不是替换 checkpoint。

**Context Bundle（产品上下文包，两级落地）**：
- **B 期（prompt 层，低风险快见效）**：host 侧预构建"产品认知切片"（AGENTS 要旨 / 文档索引 / 关键契约摘录），随阶段 prompt 注入；结合 ADR-0003 的 TOKEN_HYGIENE 硬约束 + 超配额 warn，让子代理**不再自行全量重读**公共文档。
- **A 期（state 文件，跨流水线复用）**：产品级 `.teamflow/state.json` 持久化上下文包（由各阶段 contributor 更新：PM→prd 摘要、tech→接口契约、QA→结论），子代理只拿相关 slice；跨流水线复用（无需每个新 run 重建全量认知）→ 直接应对"工程变大 token 指数增长"。

- 与现有构件的关系：`memory.md`（ADR-0002）是**权威运营记忆**（人工可读）；`state.json` 是它的**预编译索引缓存**（机器喂给子代理切片，避免子代理去 parse 文档）。`journal` 仍是 checkpoint（断点续跑），二者不冲突。

## 理由

- 分级路由把流程重量匹配到需求规模，避免"一个微功能套完整瀑布"（实测 lite 省 64% 时间 / 88% token）。
- 共享状态直击 cacheRead 占比 95% 的根因：重复读 + 全量上下文重放；索引化 + 切片注入把"每次新会话重建认知"降为"读一次索引"。
- 不引 LangGraph 本体（ADR-0001 理由仍成立：LLM 节点不可重放、薄依赖、替换率低）；只借用其"统一 state + 子图共享"思想，落在自研分层上。

## 影响

- 已交付：`lite`（v0.8.0）。`tech` 路由、`teamflow_triage`、Context Bundle B/A 期为下阶段实现项。
- PRD 提示词按 mode 分流；新增 `mode` 选项 + 分诊工具描述。
- state.json 的构建/失效/并发锁（与现有产品级并发锁共用一个入口）需设计。

## 触发信号 / 后续

- cacheRead 占比仍在 70%+ 且 `COST_BUDGET_TOKENS` 持续触发 → 优先做 Context Bundle A 期。
- 出现"技术驱动改造"类需求反馈 → 优先补 `tech` 路由。
- 需要 time travel / 历史重放 / 强审计 → 才重新评估 LangGraph（见 ADR-0001 触发信号）。
