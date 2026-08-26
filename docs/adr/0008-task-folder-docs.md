# ADR-0008：文档层重构——活文档版本制 → 任务夹收口制（日期+需求+slug，历史不可变）

- 状态：已接受（Accepted）
- 日期：2026-08（v0.1.0）
- 关联：`host/core/pipeline.ts`、`host/core/triage.ts`、`host/core/state.ts`、`host/core/backlog.ts`、`host/core/sanity.ts`、`host/prompts/index.ts`、`host/constants.ts`、`store.ts`、client 展示层、全部 smoke 断言

## 背景

现行文档层是「活文档 + 版本切片」模型：PRD/TECHNICAL/QA 等固定在 `docs/teamflow/{prd,technical,qa}/` 单一路径，
每次迭代先 mv 旧版到 `history/v<旧版本号>/` 再写新版，靠 prompt 纪律约束模型执行。实测暴露四类结构性缺陷：

1. **双归档升版**（实锤 tetris）：阶段重试或断点续跑重入 PRD 阶段时，把自己上次的产物当「旧版」再归档一次，
   版本号凭空 +1——已用「防双归档」prompt 补丁缓解，但补丁是概率性的。
2. **memory.md 段落堆积**（实锤 8 段「当前迭代记忆」并存）：「更新记忆」语义模糊导致追加而非替换，
   多段自称"当前"，版本互相矛盾——同样只能靠 prompt 补丁。
3. **全局串行版本假设脆弱**：v2.* 隐含"所有变更排一条时间线"。多人并行、场外改动（不走流水线的功能）、
   多分支开发任一发生，版本号即失真。tetris 三模块代码头 2.3.0/2.3.0/2.6.0 与文档 v2.9 三方漂移即实证。
4. **并行分支合并冲突**：两个分支各自迭代必然改同一份 PRD.md 的同区域（修订表/AC 清单）+ 同一份 memory.md
   ——文档层合并冲突在活文档模型下是结构必然而非偶然。

根因判断：**版本号是隐含全局锁的共享可变状态；归档是依赖模型自觉的写时动作**。两者都违背
「结构保证优于提示词恳求」原则（与 ADR-0007 同一哲学）。

## 决策

### 1. 任务夹 = 需求级档案单元

```
docs/teamflow/
├── 20260825-r8-wallkick-toggle/   ← 任务夹（建后不可变；阶段重试/断点续跑复用同夹）
│   ├── meta.json                  ← host 写：{reqId,runId,title,slug,mode,createdAt} 静态标识卡（建夹即定；status/endedAt 权威在 runs/<runId>.json journal，不落 meta——终态回写已废：避免「提交后再脏」与 run 误判时快照过时）
│   ├── PRD.md                     ← 模型写：meta 头 + 基线声明/取代声明 + 本地 AC 编号(AC-1..n)
│   ├── DESIGN.md / TECHNICAL.md   ← 按档位出现（needDesign/非 lite），不再归档
│   ├── QA-REPORT.md
│   └── ACCEPTANCE.md              ← 验收报告进夹（废除独立 acceptance/ 目录）
├── memory.md                      ← 收窄为产品约定层（技术栈/团队规矩），低频幂等更新
└── （SUMMARY.md 废除：由 host 扫描各夹 meta.json 聚合，工作台渲染）
```

- 命名 `<yyyyMMdd>-r<N>[-<slug>]`：日期=需求创建日；`r<N>` 为 reqId 序号（防撞兜底，triage 无 slug 时退化
  为 `20260825-r9/`）；slug 由 triage 新增输出（正则 `[a-z0-9-]{3,24}` 校验，非法降级）。
- **身份 = reqId**：夹名在建夹时刻固定并持久化到 `journal.runDocs`；重试、续跑、隔天重跑一律复用同夹
  ——幂等性由「夹已存在直接复用」的结构规则保证，不再依赖模型自觉。

### 2. 共享写点清零策略

| 旧共享写点 | 新方案 |
|---|---|
| prd/PRD.md（每分支必改） | 各分支写各的任务夹，路径不相交 |
| memory.md 当前迭代段落 | 「当前迭代」制度废除——迭代细节天然在夹内；memory 收窄为约定层 |
| SUMMARY.md 登记表 | 废除静态文件：host 扫描 meta.json 聚合，工作台按需渲染 |

memory.md 仅在真正新增团队约定时追加一行（幂等：同主题替换），写入频率从每迭代一次降到偶发。

### 3. 回归基线：局部编号 + 显式指针 + 硬保障在代码层

- AC 编号回归需求本体（夹内 AC-1..n），废除全局账本（中央登记表会重新引入共享写点）。
- 新 PRD 头部两行声明：
  - `基线依赖：<其他任务夹名列表>（其既定行为不得回退）`
  - `取代：<某夹>#AC-n（语义变更说明）`——历史夹永不改动；查最新真相 = 按日期倒序找最后一条取代链。
- 回归的硬保障仍是项目 verify-* 可执行套件（本就不依赖文档编号）；QA 阶段照旧全量运行。

### 4. host/model 职责切分：结构归 host，内容归 model

- host：建夹、命名、meta.json 静态标识卡（建夹一次写入，无终态回写）、journal.runDocs/state.__runCtx 注入；动态状态（status/endedAt）唯一权威 = runs/<runId>.json，目录聚合扫描时以 journal 为准。
- model：只写自己夹内的产物文件；对索引零写入权。PRD 头部输出一行机器可读 meta
  （`<!-- meta: summary="…" -->`）供未来聚合使用（YAGNI：本轮不做解析消费）。

### 5. 代码头 VERSION 解耦

devPrompt 明确：模块头部 VERSION 是发布版本，仅对外发版时升位；流水线迭代不碰。
（修复 game.js 2.3.0 型漂移的再发——迭代计数器不得误植进代码。）

### 6. 存量过渡：零迁移

旧 `prd/`、`technical/`、`history/`、既有 SUMMARY.md 原样留存（历史可追溯性不受影响）；
新需求自然落新夹。项目侧 verify 脚本的文档路径断言由项目自行调整（不在插件范围）。

## 理由

- **结构消灭 bug 类别**：双归档/版本虚增/memory 堆积的全部前提是「固定路径上的覆盖式写入」；
  任务夹让该前提取消，prompt 补丁（防双归档条款等）随之整体删除而非叠加。
- **容忍乱序与旁路**：日期命名不假设任何全局顺序；场外改动、多分支、多团队并行都不再使任何计数器失真。
- **审计单元对齐心智**：「一个需求的所有产物在一个文件夹」与 backlog req/task、journal run 天然一一对应；
  review/回滚/交接以文件夹为单位。
- **已有先例**：`logs/teamflow/<runId>/` 早已是 per-run 收口模式，docs 对齐反而统一。
- **resume 不受影响**：断点续跑的产物重建走 journal stage.output 全文，不依赖文档路径——改造影响面收敛在
  prompt 注入与展示层。

## 影响

- 全部 10 个 prompt 的路径注入改为 `TF_RUN_DOCS`（本任务夹）+ `TF_PRODUCT_DOCS`（memory 层）两个变量。
- triage 输出协议扩展 `slug` 字段（向后兼容：缺省为空）。
- state.json `product.currentVersion` 废弃，改记 `lastRunFolder`。
- client 文档引用路径跟随 journal.runDocs；目录浏览器不做（YAGNI）。
- smoke 断言大改：删除版本切片/mv 归档/防双归档族断言，新增 runDocs 注入/meta.json/命名格式断言。
- 单 commit 可整体回滚；运行中流水线不受影响，重启宿主生效。

## 后续

- 用下一条真实需求实测完整生命周期：建夹命名 → 各阶段产物落位 → 续跑复用同夹 → 验收后由 runs/<runId>.json 反映终态。
- 观察两分支并行迭代的真实合并场景，确认文档层零冲突。
- 工作台聚合视图（扫 meta.json 渲染产品时间线）作为后续增强候选，本轮不做。
