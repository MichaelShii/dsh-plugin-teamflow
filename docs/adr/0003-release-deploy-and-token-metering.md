# ADR-0003：部署生效契约 + token 计量口径（真实累计 / 当量 / 观测线）

- 状态：已接受（Accepted）
- 日期：2026-08（v0.8.0）
- 关联：`host/index.ts`（accumulateSessionUsage / costTokensOf / COST_BUDGET_TOKENS / deliverCompletion）、`store.ts`（stage.usage/costTokens/handoff）、`deploy.mjs`

## 背景

两个被实测锤出的问题：

1. **token 口径低估 26 倍**：旧 `stage.tokens` = `tokenMeter.measure(session).totalTokens`，本质是"会话尾声的上下文压力**快照**"，不是生命周期累计消耗。真实 API token（含每步上下文重放）需从子代理会话逐事件累计——实测一流水线显示 593k，真实 15.4M（cacheRead 占 95%）。
2. **改源码不生效**：运行中的 web 从 **profile 部署副本**（`~/.dsh/profiles/web/node_modules/dsh-plugin-teamflow/lib/`）加载 host，不是源码 `plugins/**/lib/`。只构建源码、不 deploy、不重启，改动被静默忽略（lite 参数被旧 host 忽略、汇报仍是旧格式）。

## 决策

### 1. token 三口径（stage 级）
| 字段 | 含义 | 来源 |
|---|---|---|
| `usage` | **真实累计** `{input, cacheRead, cacheWrite, output, calls}` | `accumulateSessionUsage`：遍历子代理 `session.events` 的 `assistant/message` 事件，按 `turn.step` 去重计调用数 |
| `costTokens` | **计费当量** = `input + cacheWrite + output + cacheRead×0.1` | `costTokensOf`（cache hit 约 input 1/10 价）|
| `tokens` | **上下文压力快照**（原字段，向后兼容）| `tokenMeter.measure(...).totalTokens` |

- 汇总汇报给双口径：`Token：∑ 当量（in / cacheRead / out · N 调用）· 上下文压力 X`
- 旧的 `tokens` 保留：老 journal / 无 usage 数据时回退显示上下文压力，不破坏 `teamflow_resume`。

### 2. 成本观测线（只记录不打断）
- `COST_BUDGET_TOKENS = 250000`（计费当量）。单阶段当量超线 → `journal.logs` 记 `warn`（"仅记录，不打断"）。
- 定位是**观测工具**（暴露高成本阶段），不是熔断（熔断仍由上下文压力 60k 预算负责）。

### 3. 部署生效契约
- 改 host/client 后的**唯一正确链路**：`node deploy.mjs`（构建 + 测试 + 同步 profile 副本）→ **重启 `dsh --profile web`**。
- `deploy.mjs` 结尾检测 3080 是否在监听 + 进程启动时间 → 提示"不重启则仍跑旧逻辑"。
- 源码 `lib/` 构建**不**等于部署；`.npmignore` 排除与否与运行时加载副本无直接关系（运行时只看 profile 副本）。

## 理由

- 快照口径让"上下文压力"被误当成本，误导成本决策；累计口径 + 当量才贴近计费（实测低估 26 倍）。
- cacheRead 重放是真实成本大头，观测它（而非隐藏）才能驱动"共享状态/精读"优化（见 ADR-0004）。
- 部署契约踩坑会浪费大量往返；显式化 + 自动提示防复发。

## 影响

- `deliverCompletion` 汇报行变化（双口径）；工作台卡片展示 `costTokens`（当量）+ tooltip 明细。
- `stage.usage/costTokens/handoff` 持久化到 journal（store.ts serializeJournal）。
- 开发循环必须走 deploy 而非"以为构建就生效"。

## 触发信号

- 需要按 provider 真实计费折算（cache 折扣变化/多 provider 差异）→ 当量折算改为可配置。
- 成本观测线需要按产品/阶段差异化 → `COST_BUDGET_TOKENS` 从常量升级为 service 配置。
