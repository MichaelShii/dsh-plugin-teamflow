# 行为验证报告：b49b1ac / 6a6a210 修复效果

- 验证时间：2026-09-26 18:00–18:10 (+08:00)
- 验证对象：`b49b1ac`（评估复核缺陷批量修复）+ `6a6a210`（oxlint 0-warning 门禁 + 存量清零），HEAD = `1051965`，分支 `release-v0.2.2`，工作树干净
- 验证方式：**A/B 行为验证**（同一套 harness 分别跑「修复前源码 b49b1ac~1」与「修复后源码」），全部走真实 host 模块（`runAgent` / `runTriage` / `executePipeline` / `resumeRun` / `getRun`），仅把宿主子代理服务与 `@deepseek-ai/dsh-llm` 换成 stub
- 未改动任何插件源码；`git status --short` 在验证前后均为空（本报告目录 `verify-2026-09-26/` 为唯一新增）

## 0. 结论总表

| # | 验证项 | 结论 | 关键证据 |
|---|---|---|---|
| ① | 正常结算路径子代理被 dispose | **通过（修复前确为死代码）** | 修复后 5/5 阶段结算均 `dispose()` 1 次且发生在 `result` 结算之后；修复前 5/5 为 0 次 |
| ② | triage `Promise.race` 超时定时器结算即清 | **通过（修复前悬挂 240s）** | 修复后 240000ms 定时器 created 1 / cleared 1 / pending 0，进程 171ms 退出；修复前 cleared 0 / pending 1，进程被吊住 >120s 不退出 |
| ③ | run 终态后 `pruneRuns` 收缩到 ≤100 条 + 历史 run 可读回 | **通过（修复前单调增长）** | 真实小型 run（patch 档，prd+dev，completed）：内存 runs 120 → **100**，淘汰 21 条最旧；被淘汰 run 经 `getRun` 完整读回且不回填。修复前 120 → **121**，淘汰 0 |
| ④ | `loadJournalById` 双路径 + resume 续跑 | **通过（修复前是隐性缺口）** | per-project 与全局 journal 均按 id 读回；白名单拒绝穿越 id；**内存里没有**的 per-project journal 也能 resume 续跑至 completed。修复前同场景 resume 返回 `Run not found` |
| 附 | 6a6a210 无行为回归 | **通过** | `oxlint --deny-warnings` 0 warning 0 error；`tsc --noEmit` exit 0；`pnpm test` 全绿 exit 0 |

## 1. 验证方法与可复现性

### 1.1 隔离手段

仓库 `node_modules` 内没有宿主私有 peer（`@deepseek-ai/dsh-llm` 等），直接 `import` host 模块会失败。因此用 `git archive` 把**指定 commit 的 host/ + store.ts** 导出到临时目录，并在副本内放一个只导出 `createUserMessage` 的 `@deepseek-ai/dsh-llm` stub，从而：

- 修复前副本 = `git archive b49b1ac~1 host store.ts`（下称 **pre**）
- 修复后副本 = `git archive b49b1ac host store.ts`（下称 **post**）
- 交付态副本 = `git archive HEAD host store.ts`（下称 **head**，含两个 commit）

三份副本各自 `DSH_HOME` 指向临时目录，绝不碰真实 `~/.dsh`。

### 1.2 harness

`verify-2026-09-26/` 下四个脚本（`COPY=pre|post|head` 切换副本）：

| 脚本 | 覆盖 |
|---|---|
| `h1-dispose.mjs` | ① 真实 `runAgent` × 5（prd/dev/qa/acceptance + 一次失败结算） |
| `h2-triage-timer.mjs` | ② 记账版 `setTimeout/clearTimeout` + 真实 `runTriage`（正常 / 重试两场景） |
| `h3-prune-e2e.mjs` | ③ 灌 120 条终态历史 run 后跑真实 `executePipeline`（patch：prd+dev） |
| `h4-journal-resume.mjs` | ④ `loadJournalById` 双路径 + 无内存兜底的 `resumeRun` |

运行方式（示例）：`COPY=head T=<临时根> node h3-prune-e2e.mjs`。

## 2. 逐项证据

### ① 正常结算路径子代理被 dispose

代码位置：`host/core/runner.ts:271-274`（`untrackInFlight` 之后单行 `if (run) { try { await run.dispose() } }`）；修复前该语句被行注释吞掉，与上一句同行。

HEAD 实测（`h1-dispose.mjs`，stub 子代理记录 `dispose()` 调用次数与「是否在 result 结算之后」）：

| 阶段 | stage 状态 | dispose 次数 | 发生在 result 之后 | 该 run 的 inFlight 残留 |
|---|---|---|---|---|
| prd | done | 1 | 是 | 0 |
| dev | done | 1 | 是 | 0 |
| qa | done | 1 | 是 | 0 |
| acceptance | done | 1 | 是 | 0 |
| dev（判未交付 → stage failed） | failed | 1 | 是 | 0 |

控制组（pre，b49b1ac~1）同样 5 个阶段：**dispose 次数全部为 0**。

结论：修复前「正常结算路径 dispose 从未执行」成立；修复后正常/失败两条结算路径都按宿主 `settleRun` 契约（result 后必 dispose）释放子代理，且 `inFlight` 逐路注销干净。

> 限制：stub 子代理只能证明 host 侧**调用契约**恢复（dispose 被调用、顺序正确、inFlight 注销），不能证明真实子代理会话对象在宿主侧的最终回收状态——那需要一次真实 run 后看会话列表。今日（2026-09-26）`$DSH_HOME/teamflow` 下无新 run（最新一条是 2026-09-25 03:05 的 `tf-mufvwupp-uiukmu`），故未做该确认。

### ② triage 超时定时器结算即清

代码位置：`host/core/triage.ts:620`（`timeoutTimer` 声明）、`633-635`（race 中创建）、`644`（finally 里 `clearTimeout`）。

用记账版 `setTimeout/clearTimeout` 包裹全局计时器，跑真实 `runTriage`（stub 子代理返回合法 verdict JSON）：

| 副本 | 场景 | 子代理调用 | 240000ms 定时器创建 | 已 clear | 结算后仍 pending | 进程退出耗时 |
|---|---|---|---|---|---|---|
| head | 首次即合法 verdict | 1 | 1 | 1 | **0** | 171 ms |
| head | 首次不可解析 → 重试 | 2 | 2 | 2 | **0** | 166 ms |
| pre | 首次即合法 verdict | 1 | 1 | **0** | **1（240000ms）** | **>120 s 未退出**（被悬挂 timer 吊住事件循环） |

pre 的挂钩输出（进程未退出，6s 后读取 stdout）：

```json
{ "copy": "pre", "scenario": "ok", "timersCreated": 1, "timersWithDelay240s": 1,
  "timersWithDelay240sCleared": 0, "anyPendingTimers": 1, "pendingDelays": [240000] }
```

结论：修复前每跑一次分诊就在宿主常驻进程里留下一个 240s 悬挂 timer（不 ref/unref 处理，会阻止事件循环退出）；修复后无论 race 谁赢、无论第几次尝试，结算即清，零 pending。

### ③ run 终态后 pruneRuns 收缩 + 历史 run 读回

代码位置：`host/constants.ts:42`（`RUNS_MEMORY_KEEP = 100`）、`host/core/context.ts:95/113/124`（`evictableRunIds` / `pruneRuns` / `getRun`）、`host/core/pipeline.ts:1368`（终态 checkpoint 落盘后 `pruneRuns()`）。

`h3-prune-e2e.mjs`：先把 120 条历史终态 journal 同时写入内存 `runs`（模拟宿主启动 `loadJournals` 全量灌入）与磁盘，再跑一条**真实的小型 run**：`executePipeline`，`mode='patch'`（阶段集 = prd + dev），stub 子代理产出合格交付物。

| 指标 | head（修复后） | pre（修复前） |
|---|---|---|
| 该 run 终态 | **completed**（prd done / dev done） | completed |
| 跑前内存 runs | 120 | 120 |
| 跑后内存 runs | **100** | **121** |
| 被淘汰历史 run 数 | 21（`tf-seed-000`…，即最早的） | 0 |
| 刚跑完的 run 是否还在内存 | 是 | 是 |
| `activeProducts` / `inFlight` 残留 | 0 / 0 | 0 / 0 |

读回（快照/详情走同一入口 `getRun`，`context.ts:124` 内存未命中 → `store.loadJournalById` 磁盘回读、**不回填**）：

```
oldestId                = tf-seed-000
inMemory                = false          ← 已被 prune
getRun(...)             = 命中，status=completed，stage[0].output = "seed-0-payload"
getRun 之后 runs.size    = 100            ← 磁盘回读不回填，有界性不破
loadJournalById 直读     = 命中
```

pre 副本里既没有 `getRun` 也没有 `loadJournalById`，`runs.size` 从 120 单调涨到 121——与 commit 描述的「只 set 不 delete + 启动全量灌入 → 单调增长」一致。

线上副本一致性（运行中的 web profile）：`profiles/web/node_modules/dsh-plugin-teamflow/lib/host.mjs`（2026-09-26 18:01:05 构建）内 `getRun` 出现 6 次（1 处定义 + **5 处调用点**，对应 snapshot / status / stageDetail / merge 等消费面），`pruneRuns(` 出现 2 次（1 处定义 + pipeline 收尾 1 处）；`pruneRuns(keep = 100)` 常量已内联。

> 边界：`pruneRuns` 只在**有 run 跑到终态收尾时**触发，不是定时或启动时清扫。若宿主长时间不跑新 run，启动时灌入的历史不会被自动收缩（设计取向：磁盘权威、内存懒淘汰）。「收缩到 100 内」的前提是发生过一次 run 收尾。

### ④ loadJournalById 双路径 + resume 续跑

代码位置：`store.ts:428`（`loadJournalById`：先扫 `$DSH_HOME/teamflow/*/runs/<id>.json`，再兜底全局 `$DSH_HOME/teamflow/runs/<id>.json`，`^[A-Za-z0-9-]+$` 白名单）、`host/core/pipeline.ts:1497`（`resumeRun` 改用它读盘）。

`h4-journal-resume.mjs` 关键场景：一条 **workspace≠default** 的 journal，只存在于 `$DSH_HOME/teamflow/ws-h4/runs/`，**内存 `runs` 里没有**（模拟淘汰后 / 重启未回填），直接 resume。

| 断言 | head | pre |
|---|---|---|
| per-project 文件存在 / 全局文件存在 | true / false | true / false |
| 内存中是否已有该 run | false | false |
| `loadJournalById(projId)` | 返回 id + `stages[0].output = "prd payload from disk"` | 函数不存在（`n/a`） |
| `loadJournalById(globalId)`（default → 全局路径） | 命中 | 函数不存在 |
| `loadJournalById('tf-../escape')` | `null`（白名单拒绝） | n/a |
| `loadJournalById('tf-h4-nope')` | `null` | n/a |
| `resumeRun(projId,'sid-h4')` | **`{ok:true, runId, resumedFrom:'acceptance'}`** | **`{ok:false, error:'Run not found: tf-h4-proj-pre'}`** |
| 续跑后终态 | `completed`、`endedAt` 已落；阶段 `prd:done → dev:failed → dev:done`（补跑路径起了一个新的 dev 阶段并 dispose 了 1 个子代理）；`inFlight=0`、`activeProducts=0` | 未续跑 |

结论：双路径读回成立（per-project 优先、全局兜底、注入防御有效）；并且修复掉的是**真缺口**——旧实现 `journalFile(id)` 只查全局 `runs/`，per-project 新格式 journal 一旦不在内存（淘汰/重启）就永久续不上；修复后才可用。

## 3. 6a6a210（lint 门禁 + 存量清零）回归证据

该提交按 diff 只做死 import 删除、`startsWith/endsWith` 等价改写、不可达常量的测试断言同步、CI 增加 lint 步骤，无运行时语义改动；实测：

| 检查 | 命令 | 结果 |
|---|---|---|
| lint 门禁 | `pnpm run lint`（`oxlint --deny-warnings`） | `Found 0 warnings and 0 errors`，60 files / 93 rules，exit 0 |
| 类型 | `pnpm run typecheck` | exit 0（`tsc --noEmit` 无输出） |
| 全量测试 | `pnpm test` | exit 0；24 个测试文件全部通过（日志内 `❌` 11 处均为用例名/断言文本里的字面量，非失败） |
| runs-eviction 专项 | `node test/runs-eviction.test.js` | 26 项全绿（含淘汰真值表、双路径读回、磁盘回读不回填） |
| 工作树 | `git status --short` | 空（验证未污染仓库） |

## 4. 未覆盖 / 需人工确认

1. **真实子代理会话回收**：① 用 stub 验证 host 调用契约，未观察真实宿主会话对象的最终状态。建议在修复版部署后跑一次真实 run，核对 run 结束后子代理会话不再 `running`（当前 profile 的 lib 已是修复版，见下一条）。
2. **部署生效时点**：`profiles/web/node_modules/dsh-plugin-teamflow/lib/*`（18:01:05）与 profile 内 host 源码均已含两个 commit 的修复；但**当前正在运行的 `dsh --profile web` 进程是何时加载的**无法从本会话确认。按 ADR-0003，需重启宿主后新 run 才用到修复版。
3. ③ 的收缩只发生在 run 收尾（见 ③ 边界），未验证「长时间不跑 run 时内存是否回落」——按设计不会回落。
