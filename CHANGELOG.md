# Changelog

> 本插件首次公开发布版本为 **v0.1.0**；发布前的内部迭代（v0.3~v0.13）记录于 `AGENTS.md` §5，对外统一归到 v0.1.0。

## [0.1.4] - 2026-08-29

### 修复
- **分支决策死循环**：裸 `auto` 无法区分「未决策」与「已确认新建分支」，重发 `branchPolicy=auto` 再次触发 needs-decision（实锤 run：用户已选新建分支仍循环）。修复：新建分支选项 value 改显式确认值 `'new'`（选项 value 即回传协议），显式 `branchName`/`preAction` 视为确认信号
- **护栏复读判定升级为状态判定**：大文件 read-edit 循环（有 edit/write 变更进展）不再被误杀，仅零变更进展的纯复读中止（实锤 tf-mte906e9：一次 run 6 次误杀，技术方案/T2/QA 修复/验收全挂）
- **进展信号扩展含脚本执行**：QA/验收等只读分析任务（read + 跑测试脚本）不再被误杀
- **退化中止不再自动重试**：污染会话内重试实证全失败（12→27 递增）→ 直接 needs-human 引导 `teamflow_resume`（全新会话一次成功）
- **resume 断点尊重 QA 缺陷未闭环**：P0-P2 缺陷仍 open → 断点回 QA 修复-复验闭环（不再带缺陷代码进验收；判定提前防验收失败后仍定位验收）
- **resume 不再删除失败 stage 记录**（历史失败痕迹保留）
- `hasOpenBlockingBugs` store key 统一（workspace||product||default），防老 run 查错 store

### 新增
- **提测门禁**：开发任务失败（哪怕 1 个）→ needs-human 拦截不进 QA（failed = 已知缺口，QA 检查轮必然重复报告）；resume 精确补跑 failed 子卡（done 任务产物复用）
- **README 界面预览**：5 张真实工作台截图（流水线视图/看板/阶段详情/看板任务详情/团队选择）

### 其他
- pnpm-lockfile 同步（react 移 peerDependencies 后 lockfile 未更新 → CI frozen-lockfile 失败）

## [0.1.3] - 2026-08-29

### 新增
- **分支策略闭环（ADR-2026-08-27）**：启动前用户决策（`needs-decision` 四情况：main+干净/main+脏/feature+干净/feature+脏，stash/commit/新建/沿用/自定义兜底）；`branchPolicy`/`branchName`/`preAction`/`commitMessage` 决策参数；auto=建 `feat/<slug|branchName>`、keep=沿用；`preAction`（stash/commit）在 sanity 前执行
- **收尾合回决策（对称交互）**：完成汇报带「合回决策邀请」，新工具 `teamflow_merge`（host 代为合回 / 给命令自行合回 / 暂缓）；`journal.mergeStatus` 持久化（pending/merged/kept/failed）
- **统一收口提交**：子代理只改不提交（Git discipline 硬约束），host 验收通过后单 commit（代码+任务夹产物）；结构性消灭文档漏提交与未验收中间态
- **视觉验证能力条件化**：`llm.resolveModelInfo` 探测模型多模态能力 → QA/验收视觉条款动态生成（支持视觉=DOM 计算断言+截图看图+人工收窄；不支持=禁截图看图防幻觉/循环，只走 DOM 断言）；QA 人工补测清单收窄为音频/真机/FPS/读屏
- **需求意图预检**：疑问/建议/反馈句式（「是不是应该」「要不要」等）→ `needs-confirmation` 不启动，主线程先向用户确认
- **activeTeams 持久化**：会话→团队映射落盘，重启/刷新后恢复（UI 状态与启动通道一致）

### 修复
- **护栏注入通道**：`subagents.start` 句柄无 inject → 改用 DSH 官方 `session.append('user/message')`；注入改安全窗口（step/end 后 flush，防插进 tool_calls→tool/result 序列导致 provider 400，实测 tf-mtcnejqj 烧 1.98M）
- **复读检测重复计数 bug**：轮询重复收集事件导致计数虚增（实际 4 次 × 3 轮 = 12 压线误杀，实测 tf-mtcomxpq 开发两次）→ 增量收集
- **`isUnretryable` 覆盖 400/invalid_request**（provider 客户端拒绝不再重试烧钱）
- **开发任务全部失败停止流水线**（无产物可测时不再继续 QA 误测；部分失败仍继续）
- **resume 断点按阶段定位**（PRD 重试成功后不再被失败尝试带回重跑）
- **分支 slug 派生**（branchName > triageSlug > 需求英文词 > r<N> > feature；分支检查移到 initBacklog 之后）
- **journal.options 透传 branchPolicy 等决策参数**（keep 不再被吞，实测 tf-mtd6mbeq）
- **DSH 0.1.2-alpha.1 事件词汇适配**（text-chunks/reasoning-chunks → assistant/chunk 双兼容）；schema 校验兼容（needs-decision 不返回 runId 字段）

### 其他
- 执行路径基准（小需求样本）与假优化判定收敛：`docs/benchmarks/hold-pipeline-vs-native.md`（多花 44% 是质量预算非浪费，cacheRead 命中价≈1/10）

## [0.1.2] - 2026-08-26

### 修复
- host 就绪日志工具数改为动态计数（消除「工具 8 个」写死文案，与实际注册数一致）

### 变更
- 开源发布收尾：README 中英双语修正（架构计数 17/11、防假交付真实语义、快速上手、环境要求）；npm 元数据（keywords / homepage / bugs）；`react` 移入 peerDependencies + `peerDependenciesMeta`（防私有包 ERESOLVE）；CI 触发扩展 `main` + `release-*`；构建关闭 sourcemap（npm 包 -58%）；新增 SECURITY.md / CONTRIBUTING.md；deploy 同步清单移除 `.map`

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
