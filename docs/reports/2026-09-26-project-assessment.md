# dsh-plugin-teamflow 项目评估（2026-09-26）

> 评估方式：静态代码通读（host/ 全部 23 个 .ts、store.ts、prompts、util 关键纯函数、测试与语料）+ 实测执行  
> （`tsc --noEmit` 0 错；`test/conformance.test.js` 23/23；`smoke`/`locale`/`overlap-merge` 全绿）。  
> 版本：v0.2.1，仓库全量 164 文件 / 27,866 行（含文档与测试）。

---

## 一、项目概览

| 项     | 结论                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 一句话定位 | **不是通用 Agent 框架**，而是"寄生在 DeepSeek Harness（dsh）宿主里的多智能体研发流水线编排层"——把「一句话需求 → PRD → 设计 → 架构 → 并行开发 → QA → 验收 → 收口提交」做成宿主级能力                                                                                                                                                                   |
| 技术栈   | TypeScript（TS ^6.0.3，`strict:false`）+ Cordis service + React 18 客户端 + tsdown 打包 + `node:fs` 持久化；**零运行时依赖**（`dependencies: {}`），宿主能力全部走 optional `peerDependencies`                                                                                                                         |
| 规模    | host 侧 23 个 .ts ≈ 7.5k 行（pipeline 1554 / util 1312 / index 1136 / triage 645 / locales 776+230 / prompts 741 / backlog 537 / store 477 / guard 416 / runner 430 / metering 215 / context 211）；client ≈ 2.9k 行（index 1288 / panel 844 / locales 620 / shared 296）；23 个测试文件；9 个 ADR；23 份评测语料 |
| 状态    | v0.2.1 开发线，已发布 npm（`files` 白名单 = lib + patch + README×2 + CHANGELOG）                                                                                                                                                                                                                       |

---

## 二、架构分析

**1. 分层与依赖方向（清晰，且有明文约束）**

```
接口层  ctx.tools.register(teamflow_*)  +  ctx.typert.register(strict descriptors)   ← host/index.ts
编排层  pipeline(阶段机) / triage(分诊路由) / runner(子代理执行+重试+熔断) / guard(运行中护栏)
领域层  backlog(需求-任务-缺陷卡) / state(跨 run 索引) / products(装配) / runlogs(归档) / metering(计量)
持久层  store.ts（纯 node:fs，原子写 + .bak + 损坏自愈）—— ADR-0001 自研 journal，不引 LangGraph
展示层  client/（会话内 tab + 全局面板 + 右栏 run 详情）
```

`AGENTS.md` §3 明文规定：`types/constants/util → prompts/core/* → index`，**严禁反向/循环**。实测 `core/context.ts`  
是共享状态单例、被 core 各模块单向 import，符合约束。依赖方向**靠文档约定 + smoke 正则门禁**守，不是编译期强制。

**2. Agent 范式选型（合理，且选型理由自洽）**

| 范式                 | 是否使用                   | 证据                                                                                        |
| ------------------ | ---------------------- | ----------------------------------------------------------------------------------------- |
| ReAct 单循环          | ❌ 不作为主范式（留给子代理自己在会话内用） | 阶段产物由子代理自行完成，host 不做 tool loop                                                            |
| Workflow / DAG 阶段机 | ✅ 主范式                  | `constants.STAGE_POLICY` 五档策略表 + `resolveStages()` 纯函数（pipeline:459）；档位→阶段集差异执行（ADR-0004） |
| Plan-and-Execute   | ✅                      | 架构师阶段产出蓝图 JSON → `extractBlueprint` → `buildDevTaskDefs` → `planDevWaves` 分波并行            |
| Multi-Agent（弱）     | ✅                      | 每阶段 spawn one-shot 子代理，上下文物理隔离；交接靠**任务夹文件 + state block**，不靠聊天历史                          |

选型与场景匹配：研发流水线天然是"有门控的阶段机"，用 ReAct 反而不可控。作者刻意选了**阶段机 + 文件交接**，  
代价是 token 高（每阶段重付 system/tools），收益是可审计、可续跑、可并行。

**3. 状态 / 上下文 / 会话管理（本项目最强的一块）**

- **journal**（run 级 checkpointer 语义，`store.ts` JournalRecord + JournalStage），每次阶段结束 `persistJournal`；  
  resume 从磁盘读回（内存版只留 2k 摘要）。
- **任务夹**（ADR-0008）：`docs/teamflow/<yyyyMMdd>-r<N>-<slug>/`，单轨契约"文件即产物"——  
  PRD.md / QA-REPORT.md / ACCEPTANCE.md 是唯一事实来源，回复只是摘要（`util.DOC_STAGE_FILES`）。
- **并发在飞多路由**：`inFlight = Map<runId, Map<stage, run>>`（context.ts:56-73），修过"并发 dev 只能停最后一路"的实锤缺陷。
- **取消语义收敛**：`cancelRun` 只置位不改终态，终态由 `executePipeline` 的 finally 归一（pipeline:1296-1307，  
  注释写明"取消走正常 return 路径会卡在 running+cancelled"的实测事故）。

**4. 扩展性（数据驱动做得好，角色扩展仍是硬编码）**

| 扩展点                | 成本                              | 证据                                                                        |
| ------------------ | ------------------------------- | ------------------------------------------------------------------------- |
| 新增交付形态契约           | 加一行**数据**                       | `ARTIFACT_CONTRACTS`（triage.ts:251-294）注释明写"新增一类交付物 = 加一行数据，不加判定逻辑、不加正则"  |
| 新增档位/阶段集           | 改 `STAGE_POLICY` + 一个 prompt 工厂 | `resolveStages()` 纯函数                                                     |
| 新增模型               | 零成本（全走宿主 provider）              | `resolveChildRoute` 三级回退取"当前生效路由"；`currentModelSupportsVision` 按能力条件化视觉验证 |
| 新增工具               | 一条 `ctx.tools.register`         | index.ts:188-194（schema 经 `parameterSchemaSpecToJsonSchema` 编译）           |
| **新增 Agent 角色/阶段** | **要改 pipeline 主流程**（1554 行）     | prd/design/scaffold/tech/dev/qa/acceptance 是硬编码分支，无 stage runner 注册表      |

---

## 三、代码实现分析

**做得好的**

- **可测性是有意识设计的**：纯函数下沉到 `util.ts`（`judgeDeliverable` / `mergeFileOverlaps` / `planDevWaves` /  
  `defectFingerprint` / `classifyExternalFailure` / `devTaskStatuses`），注释明写理由——"pipeline 链到宿主私有 peer  
  `@deepseek-ai/dsh-llm`，测试取不到，故判定逻辑住 util"。这是把"依赖边界"当架构约束用。
- **并发正确性有实锤级注释**：`withRetry` 里 `const beforeLen = journal.stages.length`（runner.ts:326），  
  因为并发 dev 共享 `journal.stages`，用 `length-1` 取 stage 会串位；`noteVerifyEvidence` 按 stage 引用直写而非  
  `reverse().find`（注释写明"会把 A 的证据挂到 B 的 stage，审计特性自毁"）。
- **分波调度算法完整**：`planDevWaves` 写了 write∩write 合并 + 三类依赖边 + Kahn 分层 + **成环丢边（软依赖）**
  - 下标空间 remap（util.ts:919-1051），并说明"环上组各自独占一波会退化成全串行"的实测代价。

**LLM 不确定性处理（四层，覆盖完整）**

| 层    | 机制                                                                                          | 证据                                              |
| ---- | ------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 解析失败 | 分诊 2 次尝试、第 2 次带"你上一轮只输出了开场白"纠错提示；JSON 取首个 `{...}`；蓝图畸形 JSON 有 `repairBlueprintJson` 抢救      | triage.ts:618-643；语料 `tech-blueprint-malformed` |
| 内容失败 | `withRetry`（RETRY_LIMIT）+ **诊断包回灌**（`buildRetryDiagnostic`：把上次 outcome/summary/产出尾部喂回，避免盲试） | runner.ts:317-342                               |
| 外部故障 | 限流/额度/5xx **独立计数** + 退避 30→60→120→240s，**不计入熔断预算**；用尽 → `interrupted` 可续跑                   | runner.ts:350-374                               |
| 运行中  | 护栏四类检测：复读 / 挂死 / 空转 / **环境不可用**（同一工具同错持续失败）→ `dispose` 中止                                   | guard.ts:1-33                                   |
| 成本失控 | 熔断用 `freshTokens`（input+cacheWrite+output，**排除 cacheRead**）+ 缓存能力自适应（不缓存 provider ×3 放宽）    | metering.ts:172 / 207                           |

**实测发现的问题**

| # | 位置                                                              | 问题                                                                                             | 层级         |
| - | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------- |
| 1 | `runner.ts:271`                                                 | `finally` 里 `untrackInFlight(...)` 与下一行 `if (run) {...}` 写在同一物理行（编辑事故），能跑但可读性受损                | 成熟项目不该有    |
| 2 | `triage.ts:630-633`                                             | `Promise.race` 的超时 `setTimeout` **无 clearTimeout / unref** → 每次分诊成功都留一个 240s 悬挂定时器（事件循环无法及时退出） | 真实资源泄漏     |
| 3 | `runner.ts:362`                                                 | 外部退避用 `attempt--; continue` 操控循环变量，靠 `externalBackoffMs` 返回 null 兜底才保证有界                       | 易错写法（当前有界） |
| 4 | pipeline:455 / 1447                                             | 并发上限 8 在两处硬编码 `Math.min(..., 8)`，未提常量                                                          | 小          |
| 5 | 全局                                                              | `catch (e) {}` 密度很高（鲁棒 vs 静默失败）；作者对此有自觉——大量"静默失败可见化"注释与 warn 留痕，但仍是双刃剑                         | 权衡项        |
| 6 | tsconfig `strict:false` + `runtime: { agents?: any ... }` 全鸭子类型 | 类型保护弱，靠运行时归一（`normalize*` 系列）补                                                                 | 权衡项        |

**死循环风险**：`while (true)` 的 QA 打回循环有 `round > QA_REWORK_LIMIT → break`（pipeline:1123）；  
`withRetry` 的 `attempt--` 有界；`startStageGuard` 轮询有 `fired` 幂等 + `clearInterval`。**未发现无界循环**。

---

## 四、功能细节分析

**1. 功能闭环（完整到"反常"的程度）**

需求分诊 → **澄清闸门**（intent≠requirement 或有 must-know 缺口 → **不开工**，回问用户，pipeline:219/446）  
→ 档位路由（5 档）→ PRD（含"假设与待澄清"段 + 宿主契约调研硬门禁）→ 设计/架构 → 并行开发 → QA  
（P0-P2 打回 → 修复 → 复验，≤2 轮）→ 验收（只认结论行）→ 收口提交（一个 run 一个 commit）  
→ 完成汇报 → 断点续跑 / 取消 / 日志归档。

**防假交付**是贯穿全线的设计主线：证据块（`[Verification evidence]`：命令+退出码+断言数）+ 文件即产物

- 验收结论行 + 提测门禁（dev 有失败不进 QA，注释引实锤"T2 failed → QA 450k 白烧"）+ 需求不适用拦截（ADR-0005）。

**2. 工具/函数调用设计（质量高）**

- 入参 schema 经 `parameterSchemaSpecToJsonSchema` 编译（注释：宿主以"schema 缺 type: object"拒绝过）。
- 出参 schema `additionalProperties:false` 且注释记了实锤——"返回形状 vs schema 不一致 → 宿主校验拒绝 → run 都建不了，  
  而全套测试照样全绿"（index.ts:230-234）。**这是把契约形状当一等公民**。
- render 分支覆盖 `needs-decision` / `needs-clarification` / `paused` / `no-team`。
- 参数校验走 **宿主侧归一**而非报错：`normalizeMode/Artifact/Host/Intent/Tasks` 非法值一律归到安全默认  
  （如宿主判不出 → `unknown` → 去调研，绝不默认 dsh）。对 LLM 输出这是正确取向。

**3. 记忆机制（文件系统式，无向量检索）**

| 类型       | 实现                                                                      | 证据                                         |
| -------- | ----------------------------------------------------------------------- | ------------------------------------------ |
| 短期       | 每阶段独立子代理会话，上下文物理隔离                                                      | runner `subagents.start`                   |
| 长期（产品记忆） | `docs/teamflow/memory.md`（PM/验收写回），**不入 AGENTS.md → 不注入每次会话 → 省 token** | README §AGENTS.md 最小侵入原则；`MEMORY_TEMPLATE` |
| 跨 run 索引 | `state.json` 预编译索引（`loadState/mergeStateBlock/stateSliceFor`），按角色切片注入   | core/state.ts                              |
| 需求级档案    | 任务夹 + `meta.json` 静态标识卡                                                 | ADR-0008                                   |
| 语义检索     | **无**（实测 grep：`embedding/vector/similarity/rerank` 全仓 0 命中）             | ADR-0009 已否决插件级用户记忆层                       |

判断：记忆是**索引/路径式**而非语义式。对"研发流水线"这个场景够用（任务夹 + state 索引已能让下一轮不重读），  
但严格按通用 Agent 记忆维度打分要扣分——**且这是刻意取舍，不是不知道**。

**4. 自我反思/纠错**

- 有：QA 打回修复复验循环、验收 rework、重试诊断包回灌、护栏向在跑子代理 `inject` 轻提醒（不打断，下一 step 可见）。
- 无：模型自评/打分式 self-reflection。**用宿主侧客观判据替代模型自评**——这是更稳的选择，值得加分。
- 有"先测量再改判据"的克制：`journal.qaRounds` D 埋点逐轮记缺陷**稳定身份**（检测命令优先，因为 QA 每轮重编号），  
  注释明写"只记录、不改变任何行为，等攒够数据再决定要不要换掉 QA_REWORK_LIMIT 硬上限"。

**5. 可观测性（强）**

- token **双口径**：汇报用官方 `totalTokensOf`（含 cacheRead），熔断用 `freshTokensOf`（排除 cacheRead），  
  并给出缓存命中率与调用数；每阶段记录**实际生效的 provider/model**（"回答是不是模型的锅"）。
- 日志分级（phase/info/warn/error）+ run 结束后归档到 `$DSH_HOME/teamflow/<ws>/logs/<runId>/` 并**从项目删除**，  
  只留 code 扩展名与 captures.json，每工作区保留 20 次。
- **缺口**：无 trace / span 体系（靠 `childId` 关联子会话）；**有 token 量但无金额**（无 provider 单价表），  
  严格说"成本统计"只做了一半。

---

## 五、工程规范分析

| 维度          | 评价                                                                                                                                                                                      | 证据                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 命名/注释       | **极强**，本项目最突出的资产                                                                                                                                                                        | 注释是"决策注释"：为什么 + 实锤 run id + 日期 + "勿回退"（如 pipeline:88-104 的 `.gitignore` 两道防线、metering:177-186 的缓存自适应）  |
| 类型标注        | 中                                                                                                                                                                                       | `store.ts` 的 `JournalStage/JournalRecord` 字段级注释完整（含"仅作展示，判定看 taskIds"）；但 `strict:false` + `any` 鸭子类型普遍 |
| 配置/密钥       | **无硬编码密钥**（grep `apiKey/secret/password` 无命中）；路径**运行时探测**，`detectInstallEnv` 明写"不得写死 profile 名/路径"                                                                                      | util.ts:133 / index.ts:626-648                                                                         |
| 依赖管理        | **零运行时依赖**；peerDeps 全 optional；pnpm + lockfile 已提交；engines 声明 node≥22.18 / dsh 版本区间                                                                                                     | package.json                                                                                           |
| 测试          | 23 个文件，分层清晰：smoke（结构+源码正则）/ 行为（locale/journal/runlogs/cancel/metering/overlap-merge/triage-gate/state/dev-task-id）/ **L1 prompt-contract** / **L2 conformance（golden corpus，零 LLM 成本）** | 实测：conformance 23/23、smoke/locale/overlap-merge 全绿、`tsc --noEmit` 0 错                                  |
| 测试缺口        | **无 mock LLM 的端到端集成测试**（pipeline 依赖宿主，CI 跑不了）；`commit-path` 是真 git 集成，受限沙箱会 SKIP                                                                                                        | test/ 与 package.json scripts                                                                           |
| 文档          | README 中英双份 + 9 ADR + devlog 274 行 + CHANGELOG 266 行 + CONTRIBUTING + SECURITY + 发布 SOP 锚点 + 3 份 benchmark                                                                              | 文档密度高于多数同类开源项目                                                                                         |
| lint/format | **未见 ESLint / Prettier 配置**（devDeps 只有 typescript / tsdown / @types）                                                                                                                    | 明确缺口；一致性靠人工 + smoke 正则                                                                                 |
| 代码风格        | 一致（单引号、2 空格、尾逗号风格统一）                                                                                                                                                                    | 人工维持                                                                                                   |

---

## 六、优点清单

1. **防假交付做成体系**：证据块 + 文件即产物 + 结论行 + 提测门禁 + 需求不适用拦截，五道防线，且每道都有实锤事故背书。
2. **判据与措辞分离**：`judgeDeliverable` 换轨——"措辞不能用来判定是否交付，模型如实汇报环境限制是本分"  
   （util.ts:341-360），并用语料锁死回归（`dev-delivery-env-limitation` / `dev-delivery-bare-refusal`）。
3. **成本工程有独立口径**：熔断排除 cacheRead、按 provider 缓存能力自适应、机械阶段降档 + 重试回升 high。
4. **知道自己的知识边界**：非 dsh 宿主（openclaw/hermes/pi）→ 不下发 dsh 契约，改为强制"宿主契约调研"硬门禁，  
   注释明写"凭记忆写字段名正是 dddd 事故的成因"。
5. **可观测性按"排查成本"设计**：每阶段 provider/model、token 四桶、日志分级归档、取消来源、护栏判定依据全留痕。
6. **注释即决策日志**：大量"实锤 + 日期 + 勿回退"，新人不读代码也知道哪些地方不能乱改。
7. **依赖克制**：零运行时依赖、宿主能力全 optional peer、不引 LangGraph（ADR-0001 有论证）。
8. **评测分层且零成本**：L2 conformance 用冻结语料喂真实解析器，改 prompt/解析器立刻显形，不需要调 LLM。
9. **并发有真实的三道防线**：声明合并（事前）+ 分波（事前）+ touched 窗口交集（事后），并说明前两道都能被绕过的原因。
10. **宿主边界认知准确**：不用 `@Remote`、必须宿主级插件、子代理权限钉死工作区（"安装必须由主 agent 执行"）。

---

## 七、缺点与风险清单

**A. demo 阶段可接受 / 有意为之**

| 项              | 说明                             |
| -------------- | ------------------------------ |
| 无向量检索记忆        | 取舍明确（ADR-0009 否决记忆层），研发流水线场景够用 |
| 强依赖单一宿主 dsh    | 产品定位如此；已有 host≠dsh 的分流处理       |
| 阶段/角色硬编码 6-7 个 | 垂类产品的合理简化                      |
| `strict:false` | 与宿主私有类型打交道的现实妥协                |

**B. 成熟项目不应有（需要改）**

| 项                                      | 风险                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `pipeline.ts` 1554 行单体编排               | 新增阶段/角色必须改主流程；核心逻辑无法在 CI 内测（依赖宿主 peer）→ **回归只能靠 smoke 正则**              |
| 无 ESLint/Prettier/CI 配置                | 风格与质量靠人工；PR 无自动门禁                                                       |
| `triage.ts` 超时定时器未 clear/unref         | 真实资源泄漏（240s 悬挂 timer）                                                   |
| `runner.ts:271` 断行事故                   | 可维护性信号：说明该文件缺少 lint 兜底                                                  |
| `activeProducts` / `runs` 是**进程内** Map | 多实例/多进程下工作区级并发锁失效；`runs` 超 30 条按插入序淘汰，长跑宿主会丢内存态（磁盘有，但跨会话 resume 路径要能恢复） |
| 成本只有 token 量、无金额                       | "成本中心"名不副实（用户看不到钱）                                                      |
| 大量 `catch(e){}`                        | 鲁棒但有静默失败风险；虽有"可见化"补偿，仍应分级（policy vs 阻断）                                 |
| 并发上限 8 硬编码两处                           | 小，但说明常量治理不彻底                                                            |



---

## 八、开发者画像与水平定位

**定位：高级（Senior）偏架构型，且是"从真实事故中迭代"的类型。**

判断依据（均为代码实证，非印象）：

1. **决策来自实测而非推演**：几乎每个非平凡机制都带"实锤 run id + 日期 + 勿回退"。例如"52 个历史 run 里从未出现
   真正需要第 3 轮修复"、"33 次启动 14 次显式传档位 → 护栏在 42% 启动上失效"、"64/64 run 的 triage 都缺 artifact
   → 契约防线从未生效"。这是**在真实使用中量化问题**的人，不是写 demo 的人。
2. **会反思自己的错误类型并提炼成通则**：注释里两次出现"拿文本长相当身份/判据，本项目已踩过多次"
   （dev 任务的 title vs id、`forceHost` 不覆盖 `other`、blockers 用 `settles` 字段而非问句文本）。这是抽象能力。
3. **懂成本工程**：双 token 口径、缓存能力自适应、推理强度按阶段降档、ONCE_DISCIPLINE / TOKEN_HYGIENE
   直接写进 prompt 约束子代理的读文件行为（"整文件读 >200 行禁止"）。
4. **克制**：D 埋点"只记录不改行为"、语料"只增不改"、判据层"只增不改"——先测量再改判据，不凭直觉动状态机。
5. **知道能力边界**：不凭记忆写别的框架的字段名、不为每个宿主写一套契约（"无界增长 + 必然过期 + 我们没有权威"）。

**能力偏向**：工程/系统能力 ≫ prompt 能力（prompt 也很好，但真正的护城河在判据设计、状态机、并发、可观测、日志生命周期）。

**到"专家"的差距**：
- 抽象层还能再收一层（编排中枢应是可注册的 stage runner，而不是 switch 式阶段分支）；
- **可测性没有贯彻到底**（领域层做得很好，编排层几乎不可测）；
- 依赖单向靠文档 + 正则守，没有编译期/架构测试强制；
- 评测只覆盖解析器与 prompt 工厂，未覆盖编排决策（分诊路由、档位护栏、波次调度只有行为级单测）。

**是"跟着教程抄"还是"独立设计"**：明确是后者。这里的机制（澄清闸门、形态契约表、环境不可用检测、
touched 事后检测、日志生命周期、doc 类阶段产物兜底）在公开教程里找不到对应物，且都指向具体事故的复盘。

---

## 九、综合结论

**一句话结论：不是 demo，是一个有真实生产使用痕迹、工程成熟度明显高于版本号的垂类插件——v0.2.1 的号，成熟项目的骨。**

**评分：8.3 / 10**

| 维度 | 分 | 理由 |
|---|---|---|
| 架构设计 | 8.5 | 分层清晰、依赖有约束、范式选型自洽；扣分在角色扩展非插件化 |
| 代码实现 | 8.0 | 并发/重试/熔断/护栏质量高；扣分在 pipeline 单体与两处实测缺陷 |
| 功能细节 | 8.5 | 闭环完整 + 防假交付体系；扣分在无语义记忆、无金额成本 |
| 工程规范 | 8.5 | 注释与文档密度罕见、测试分层好；扣分在无 lint/format/CI、无集成测试 |
| 工程判断力（加分项） | 9.5 | 对"什么该由模型判、什么必须由 host 判"的边界感，是本项目最值钱的东西 |

**走向生产最关键的 5 个改进点（按性价比排序）**

1. **拆分 `pipeline.ts` + 让编排可测**（最高优先）：把阶段抽成 `StageRunner` 注册表（每阶段 = `{key, promptFn, artifact, onDone}`），
   主流程只做"取阶段集 → 依次/分波执行 → 收口"。同时把 executePipeline 中不依赖宿主的部分（分波、门禁、终态归一）
   抽成纯函数，配 **fake subagents** 的端到端集成测试——现在核心编排零自动化测试，是最大风险。
2. **上 CI + ESLint/Prettier**：GitHub Actions 跑 `typecheck` + `pnpm test`（含 L1/L2）+ lint；
   把 smoke 的"源码正则断言"从主防线降级为补充防线（它现在承担了太多架构约束职责）。
3. **修实测缺陷**：`triage.ts` 的 race timer 加 `clearTimeout`（或 `unref`）；`runner.ts:271` 断行；
   `maxConcurrency` 上限提常量；给 `catch(e){}` 分级（policy 级必须有日志，参考现在已有的"静默失败可见化"纪律）。
4. **并发锁与 run 注册表进程外化**：`activeProducts` / `runs` 现在只在进程内有效，宿主多实例或重启后语义不完整
   → 改成文件锁（`$DSH_HOME/teamflow/<ws>/.lock`，带 mtime 心跳与超时释放）+ journal 磁盘权威，resume 一律从磁盘加载。
5. **成本从"量"到"钱"**：加可配置的 provider 单价表（`$DSH_HOME/teamflow/pricing.json`），
   按 stage / run / 需求三个维度出金额视图；现有四桶口径已经是算钱的完美基座，缺的只是乘数。

（可选第 6 项：给 `state.json` 加查询/检索接口，或按需求规模再评估是否引入轻量语义检索——
但这条应等"任务夹 + state 索引确实不够用"的实锤出现再做，符合本项目"先测量再动"的既有纪律。）

**给开发者的成长建议**

1. **把"注释即决策日志"升级为"可执行决策"**：现在大量规则靠注释 + smoke 正则守。把它们变成数据/断言
   （如 `triageRecordOf` 字段搬运已有结构化门禁——这个模式应该推广到所有白名单搬运点）。
2. **练"架构测试"**：引入 dependency-cruiser 或自写 import 图断言，把 AGENTS.md 里的依赖方向变成 CI 红灯，
   而不是靠人记住。
3. **补"编排层可测"这一课**：fake subagents + 确定性语料回放（现在只回放解析器，可以扩到"回放一次分诊裁决 →
   断言档位/护栏/澄清闸门决策"）。这会把你的 L2 评测层从"解析器一致性"升级成"决策一致性"。
4. **写对外的技术文章**：`freshTokens` 双口径、环境不可用检测、doc 阶段产物兜底、touched 事后冲突检测，
   这四个机制是社区里少见的实锤经验，输出出来既是影响力也是 recruiter 视角的强信号。
5. **在"克制"之外练"收敛"**：D 埋点攒了一年数据仍没变成判据。给自己设个阈值（如 30 条真实复验轮）
   到期必须做决策：要么换成收敛判据，要么明确写"数据证明硬上限就够"并删掉埋点代码。

**无法判断的部分**（信息不足，不臆测）：真实线上 run 的成功率与成本分布、多用户/多工作区并发下的实际表现、
宿主版本演进带来的兼容成本——这些需要运行数据，仓库里看不到。
