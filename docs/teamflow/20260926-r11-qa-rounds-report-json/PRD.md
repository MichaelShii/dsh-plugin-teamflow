<!-- meta: summary="为 scripts/qa-rounds-report.mjs 增加 --json 机读输出（每 run 轮次数组 + 聚合统计），默认人读输出逐字节不变，并新增不依赖 spawn 的门禁测试。" -->
基线依赖：无（该脚本源自已发布 v0.1.9，工作区内无对应任务夹；其现有 stdout 格式在本需求中就地冻结为回归基线）

# QA 轮次报告 `--json` 机读输出

## 1. 背景与目标

**背景**：`scripts/qa-rounds-report.mjs` 是 D 方案（QA 轮次收敛判据）的**读侧**，把 `journal.qaRounds` 渲染成「每 run 一张轮次表 + 全局聚合」。它现在只能人眼阅读：`console.log` 直出十进制的收敛/停滞/检测命令可用率/门禁落地率/单轮成本。TODO.md 中「D 要不要做」这个决策若要跨 run 复算、进 dashboard 或做趋势对比，就必须有人手抄数字——这是当前唯一的瓶颈，且抄错没有门禁能发现。

**目标**：在**不改默认输出**的前提下，给脚本加 `--json`：stdout 只输出结构化 JSON（每个 run 的轮次数组 + 聚合统计），使同一份 journal 数据既能人读、也能被下游程序直接消费；并把这次改动锁进永久门禁（免 spawn 的 fixture 测试 + 既有 typecheck/lint/test）。

**成功的样子**：维护者跑 `node scripts/qa-rounds-report.mjs` 看到的表格与今天逐字节一致；跑 `node scripts/qa-rounds-report.mjs --json | jq .aggregate` 直接拿到与表格完全同源的数字。

## 2. 用户故事与验收标准

| 编号 | 用户故事 | 对应验收标准 |
|---|---|---|
| US-1 | 作为**维护者**，我仍能像今天一样跑脚本看表，不动脑子、不用重学格式 | AC-1、AC-7（文本空态保留） |
| US-2 | 作为**下游消费者**（决策脚本 / dashboard / 一次跨 52 个 run 的复算），我要把报告喂给程序，而不是抠 `console.log` 文本 | AC-2、AC-3、AC-4、AC-5、AC-6、AC-7 |
| US-3 | 作为**改这个脚本的工程师**，我希望改动被门禁锁住：默认格式不会被人无意改坏、`--json` 不会退化成半截 JSON、测试在受限沙箱里也能跑 | AC-8、AC-9、AC-10、AC-11、AC-12 |

### 验收标准（AC 明细）

| AC | 判据（可量化） | 验证方式 |
|---|---|---|
| AC-1 | **默认路径零回归**：给定同一份 journal 数据，`node scripts/qa-rounds-report.mjs`（无参）与 `node scripts/qa-rounds-report.mjs <runId>` 的 stdout 与改动前**逐字节相同**；`--json` 分支不参与默认路径 | ① 门禁：文本渲染由单一纯函数产出，测试用内联黄金字符串断言逐字节相等；② 工程证据：`git show HEAD:scripts/qa-rounds-report.mjs` 取旧版，对同一 `DSH_HOME` 跑新旧脚本并 `diff` stdout = 空 |
| AC-2 | **JSON 合法且纯**：`node scripts/qa-rounds-report.mjs --json` 的 stdout 恰好是一个可被 `JSON.parse` 解析的对象（允许末尾一个换行），**零人读文案混入**（不含「扫描到」「暂无埋点数据」「═══」等）；退出码 0 | 门禁：解析 stdout 成功 + 断言不含上述字面子串 |
| AC-3 | **参数位置无关**：`--json`、`--json <runId>`、`<runId> --json` 三种形态都输出 JSON，且 runId 过滤结果等价；runId 定义为**首个不以 `-` 开头的参数** | 门禁：三种 argv 形态各跑一次，断言输出均为合法 JSON 且 `filter.runId` 正确 |
| AC-4 | **结构稳定、可 diff**：顶层固定键 `schema`/`filter`/`scanned`/`runs`/`aggregate`；`schema === "teamflow.qa-rounds-report/v1"`；同一输入连续两次运行 stdout **逐字节相同**（无时间戳、无随机序、无环境路径泄漏） | 门禁：断言固定键集合与 schema 值；同一 fixture 渲染两次比对全等 |
| AC-5 | **runs/rounds 内容有据**：`runs` 覆盖全部带 `qaRounds` 的 run，按 `workspace` → `runId` 字典序排序；每项含 `runId`/`workspace`/`status`/`humanIntervention`/`hasRework`/`rounds`；每轮含 journal 原字段 `round`/`seq`/`blocking`/`p3`/`newFps`/`repeats`/`resolved`/`withCheck`/`withCriterion`/`qaCalls`/`fixCalls`/`gate`/`outcome`/`defects`（`defects` 每项含 `id`/`sev`/`module`/`fp`）；缺失键补 `null`（`defects` 缺失补 `[]`），键集合固定，便于机器消费 | 门禁：用含「字段缺失」与「多 run 乱序」的 fixture 断言键集合、排序、null 补位 |
| AC-6 | **聚合与文本同源**：`aggregate`（`scope`/`converging`/`stalling`/`checks`/`blockingDefects`/`checksRatio`/`fixRounds`/`gates`/`roundCosts.samples`/`roundCosts.avg`）与文本渲染**由同一个 report 对象产出**；口径与现脚本一致 = 仅统计发生过打回（`outcome === "rework"`）的 run 的复验轮，`round > 1` 时 `repeats > 0` 记停滞、否则 `resolved > 0` 记收敛；`checksRatio = checks/blockingDefects`（0–1 数值，分母 0 时 `null`）；`roundCosts.avg` 为 `Math.round` 均值（无样本时 `null`） | 门禁：从文本输出正则抽取数字，与 JSON 聚合字段逐一比对相等；共享 report 对象由实现结构保证（两态渲染入口只接收 report） |
| AC-7 | **空态与容错**：`$DSH_HOME/teamflow` 不存在、无 journal、无 `qaRounds`、runId 无命中 → `--json` 仍输出合法 JSON（`runs: []`、`scanned.*` 为 0、`checksRatio: null`、`roundCosts.avg: null`）且退出码 0；坏 JSON 的 journal 继续被跳过且不影响其余；默认文本路径的「暂无埋点数据」提示保持原样 | 门禁：空 fixture / 无 `qaRounds` fixture / runId 无命中三例断言；文本空态断言包含原提示语 |
| AC-8 | **只读、无副作用**：两种模式下都不写文件、不建目录、不改 journal；**import 该脚本不产生 stdout、不读 `$DSH_HOME`**（CLI 体由入口守卫包裹，仅 `node scripts/...` 直跑时执行） | 门禁：import 后断言无输出与未触发收集；实现层断言脚本无 `writeFile`/`mkdir` 调用 |
| AC-9 | **永久门禁**：新增 `test/qa-rounds-report.test.js`，用**内存 fixture** 覆盖 AC-2/3/4/5/6/7/8（每个 AC ≥ 1 条断言），**不 spawn 子进程、不依赖真实 `$DSH_HOME`**（受限沙箱下 `child_process` 管道会 EPERM）；测试风格与既有套件一致（`✓`/`✗` + 失败非零退出），并登记进 `package.json` 的 `test` 与 `prepublishOnly` 链 | 门禁：`pnpm test` 全绿且新套件被执行；人工核验测试文件无 `child_process`/`spawn` |
| AC-10 | **既有质量门禁零回归**：`pnpm run typecheck` exit 0；`pnpm run lint` 0 warning；`pnpm test` 全绿；脚本**零新增依赖**（只用 `node:` 内置模块，不引入 commander/yargs 等） | 命令退出码 + 脚本 import 清单核验 |
| AC-11 | **用法文档同步**：脚本头部注释新增 `--json` 用法与 JSON 结构概要，且与实现**字段名一致**（QA 抽查 ≥ 3 个字段）；不新增 README/CONTRIBUTING 章节（现状无脚本清单，避免文档与实现双份维护） | 源码核查 + QA 抽查 |
| AC-12 | **边界与收口合规**：改动仅限 `scripts/qa-rounds-report.mjs`、`test/qa-rounds-report.test.js`、`package.json`（`test`/`prepublishOnly` 链）、`.gitignore` 与任务夹文档；host/client 源码零改动、`teams.json` 零改动、`AGENTS.md` 零改动；`logs/teamflow/` 不入提交；一个 run 一个 commit | `git diff --stat` 白名单核验 + 收口提交面检查 |

## 3. 范围与非目标

**范围内**
- `scripts/qa-rounds-report.mjs`：参数解析（`--json` + runId）、数据收集、聚合计算、两态渲染（文本 / JSON）的**分层**，且默认文本路径逐字节不变。
- 脚本可测性的最小重构：把「收集 journals / 计算 report / 渲染文本 / 渲染 JSON」抽为可导出的纯函数，CLI 入口加守卫（`process.argv[1]` 与 `import.meta.url` 同源判定）。**零行为变化**是硬条件（AC-1）。
- `test/qa-rounds-report.test.js` 新门禁 + `package.json` 两处链登记。
- 脚本头注释的 `--json` 用法与 JSON 结构说明。
- 仓库 `.gitignore` 按本栈补全（见 §7）。

**非目标**
- 不改 `journal.qaRounds` 的写入侧（本需求是**读侧**，埋点字段零改动）。
- 不改任何 host/client TS 源码、不碰流水线行为、不需要 `node deploy.mjs`（与宿主运行时不相关）。
- 不做 dashboard / 网页可视化 / 趋势数据库；不引入新依赖或新构建步骤。
- 不删改现有文本输出内容（含中文措辞、空格、提示语）；不新增退出码语义（仍只在异常时非零，空态保持 0）。
- 不改 `docs/TODO.md` 的 D 方案结论（本需求只为该决策提供机读数据，不代替决策）。
- 不写 `docs/devlog.md`（r10 未写，not per-run 必需；迭代流水由 commit message 承载）。

## 4. 交互流程摘要

**调用契约**

| 调用 | stdout | 退出码 |
|---|---|---|
| `node scripts/qa-rounds-report.mjs` | 今天的文本表 + 聚合（逐字节不变） | 0 |
| `node scripts/qa-rounds-report.mjs <runId>` | 同上，仅该 run | 0 |
| `node scripts/qa-rounds-report.mjs --json [runId]` / `[runId] --json` | **仅**一个 JSON 对象（`JSON.stringify(..., null, 2)`） | 0 |

带 `-` 前缀的未知参数：不做严格解析（静默忽略，与 `scripts/migrate-phase-en.mjs` 的 `argv.includes('--dry-run')` 风格一致）——见 §9 待澄清 1。

**数据流**：`collectJournals({ root, onlyRun })` → 过滤出 `withRounds` / `withRework` → `buildReport(entries)`（唯一的计算点）→ `renderText(report)` 或 `renderJson(report)`；两种渲染只吃同一个 report，保证 AC-6 的「同源」。

**JSON 结构（v1，示例）**

```json
{
  "schema": "teamflow.qa-rounds-report/v1",
  "filter": { "runId": null },
  "scanned": { "runs": 52, "withRounds": 12, "withRework": 7 },
  "runs": [
    {
      "runId": "tf-xxxx",
      "workspace": "products/tetris",
      "status": "completed",
      "humanIntervention": false,
      "hasRework": true,
      "rounds": [
        {
          "round": 2, "seq": 7, "blocking": 3, "p3": 1, "newFps": 1, "repeats": 0,
          "resolved": 2, "withCheck": 3, "withCriterion": 3,
          "qaCalls": 4, "fixCalls": 5, "gate": true, "outcome": "rework",
          "defects": [{ "id": "QA-1", "sev": "P1", "module": "host/core/pipeline.ts", "fp": "cmd:pnpm test" }]
        }
      ]
    }
  ],
  "aggregate": {
    "scope": "runs-with-rework",
    "converging": 4, "stalling": 1,
    "checks": 9, "blockingDefects": 11, "checksRatio": 0.8181818181818182,
    "fixRounds": 7, "gates": 5,
    "roundCosts": { "samples": [9, 7, 11], "avg": 9 }
  }
}
```

## 5. 优先级

- **P0**：AC-1（默认零回归）、AC-2、AC-4、AC-5、AC-6、AC-7、AC-9 —— 特性本体 + 同源保证 + 门禁。缺任何一条，这个选项在自动化场景里都不可信。
- **P1**：AC-3（参数位置）、AC-8（只读/入口守卫）、AC-10（质量门禁）、AC-12（边界合规）、§7 的 `.gitignore` 补全。
- **P2**：AC-11（脚注文档）。

## 6. 依赖与风险

**依赖**
- 数据面：`journal.qaRounds` 埋点字段（写侧已存在，只读消费）；`$DSH_HOME/teamflow/<ws>/runs/*.json` 布局（`collect()` 现状）。
- 工具链：Node ≥ 22.18（现有 `engines`），仅 `node:fs`/`node:path`/`node:os`/`node:url`。
- 交付文档入库依赖宿主 `tfDocAddArgs -f`（`.gitignore` 已忽略 `docs/teamflow/`；本需求不改该规则）。

**风险与缓解**

| 风险 | 影响 | 缓解 |
|---|---|---|
| 重构默认文本路径时改坏空格/措辞 | US-1 直接破功 | 文本渲染抽为纯函数 + 黄金字符串逐字节断言；工程上再用旧版脚本对同一 `DSH_HOME` diff 一次（AC-1 双证） |
| 测试用 `spawn` 跑脚本 → 受限沙箱 EPERM（既有 `commit-path.test.js` 就因此 SKIP） | 门禁形同虚设 | 门禁走 import 纯函数 + 内存 fixture；「脚本能跑通」用真实环境命令 + 证据块记录，不塞进测试 |
| 聚合在文本与 JSON 各算一遍 → 数字漂移 | 机读数字不可信 | 单一 `buildReport` 计算点，两态渲染共享；加跨态一致性断言 |
| `--json` 与 runId 参数互抢位置 | 参数静默失效 | runId = 首个非 `-` 参数；三种 argv 形态各一条测试 |
| 空态/坏 journal 让 JSON 变成半截输出 | 下游解析崩 | 空态返回固定骨架（`runs: []` 等）而非提前 `process.exit`；坏文件保持跳过 |
| 误改 host/client 源码扩大爆炸半径 | 需要重新 bundle/deploy | AC-12 白名单 + `git diff --stat` 核验 |

## 7. 工程约束（原样保留原始需求中的工程动作）

- **改动位置**：`scripts/` 下的 `qa-rounds-report.mjs`；**默认输出格式保持不变**；加 `--json` 时输出结构化 JSON（每个 run 的轮次数组 + 聚合统计）。
- **自测**：必须自测——脚本能跑通（真实 `$DSH_HOME` 下 `node scripts/qa-rounds-report.mjs --json` 输出可被 `JSON.parse` 解析）**并验证输出**（默认文本与 JSON 数字同源、空态不崩）；自测证据进 `[Verification evidence]`（命令 + 退出码 + 断言计数）。
- **流程**：按**完整流程**走，**包含 QA 验证和验收**（QA 任务夹内 `QA-REPORT.md`、验收 `ACCEPTANCE.md`，均落在本任务夹）。
- **分支**：当前在 `release-v0.2.3`（仓库分支模型：`main` 只承载已发布内容，日常开发走 `release-vX.Y.Z`）→ **不新建、不切换分支**，就地在 `release-v0.2.3` 上实现。
- **工作区状态**：开工时干净（无未提交改动）→ **无需** `stash`/`commit` 预处理；也不必 `branchPolicy=keep` 之外的额外处理。开发中产生的中间脚本/探针若不能删净，必须先落到 `logs/teamflow/<runId>/` 白名单（检查脚本/笔记），项目根**不得**出现临时 `scripts/` 之外的散落探针。
- **`.gitignore` 补全（dev 阶段动作，按本栈实际工具链）**：现有规则已覆盖 `node_modules/`、`lib/`、`dist/`、`*.tsbuildinfo`、`*.log`、`.tmp-*/`、`.DS_Store`、`.idea/`、`.vscode/`、`*.swp`、`package-lock.json`、`npm-debug.log*`、`*.tgz`、`.workbuddy/`、`docs/teamflow/`、`logs/`。**缺口（至少补齐这四条）**：`.pnpm-store/`（pnpm store，本仓库即 pnpm 工程）、`pnpm-debug.log*`（与既有 `npm-debug.log*` 对称）、`coverage/`、`.env` 与 `.env.*`（本地环境变量/密钥，绝不可入库）。可选：`*.bak`（journal 原子写的备份后缀）。**禁止改动 `docs/teamflow/` 与 `logs/` 两条既有规则**——交付文档强制入库（`-f`）与宿主 `mergeGitignore` 幂等合并都依赖它们。理由：收口提交整树 add，漏进提交的噪音会成为永久历史。
- **收口提交**：一个 run 一个 commit（代码 + 任务夹 + memory.md），`logs/teamflow/` 永不入提交；**不执行** `npm publish`、不打了 tag、不跑 `node deploy.mjs`。
- **不越界**：README/CONTRIBUTING 不新增章节；`AGENTS.md` 零改动（§2 测试清单非穷举——历史新增的 `acl-preflight`/`changelog` 亦未登记）；不改 `journal.qaRounds` 写侧。

## 8. 里程碑建议

| 里程碑 | 内容 | 出口条件 |
|---|---|---|
| M1 分层与零回归 | 抽 `collectJournals`/`buildReport`/`renderText` + CLI 守卫；默认文本路径不变 | AC-1 双证通过（黄金字符串 + 新旧 diff 空）；typecheck/lint 绿 |
| M2 `--json` 与同源 | 参数解析 + `renderJson` v1 结构 + 聚合单点 | AC-2/3/4/5/6/7 逐条手工验过 |
| M3 门禁与收尾 | 新测试套件 + `package.json` 双链登记 + 脚本头注释 + `.gitignore` 补全 | AC-8/9/10/11/12；`pnpm test` 全量绿 |
| M4 QA + 验收 | QA 复验（含自建独立校验，不复用 dev 断言）+ 验收架构核验 | QA-REPORT 无 P0–P2；ACCEPTANCE 结论行为通过 |

## 9. 假设与待澄清

1. **未知 flag 的处理**：假设带 `-` 前缀的未知参数**静默忽略**（与现存 `scripts/migrate-phase-en.mjs` 的 `argv.includes('--dry-run')` 风格一致，避免新增退出码语义）。若用户要求「打错就报错」，改为 stderr 打印 usage + exit 2，并补一条 AC。
2. **JSON 的 `runs` 集合与聚合口径可以不同**：假设 `runs` = **全部带 `qaRounds` 的 run**（含未打回者，用 `hasRework` 区分），而 `aggregate` 沿用现文本口径 = **仅统计发生过打回的 run**（字段 `aggregate.scope = "runs-with-rework"` 自证）。若用户希望两者同集合（`runs` 只列打回 run），则聚合数字会与今日文本口径不一致，需用户确认后改。
3. **为可测性做的最小重构是被允许的**：假设允许把脚本改成「导出纯函数 + 入口守卫」，且默认输出逐字节不变。若用户要求脚本保持单文件顶层直跑、拒绝任何结构改动，则测试只能 spawn 子进程（受限沙箱下可能 EPERM，需人工步骤兜底），门禁强度会下降。
4. **JSON 字段命名与版本号**：假设 `schema = "teamflow.qa-rounds-report/v1"`、camelCase、轮次字段与 journal 原名一致；`checksRatio` 用 0–1 数值（文本里是整数百分比），`roundCosts.avg` 与文本同为 `Math.round`。若团队有既定 schema 命名规范或希望 JSON 里也放整数百分比，需用户指定。
5. **`.gitignore` 补全的最小集**：假设必补 `.pnpm-store/`、`pnpm-debug.log*`、`coverage/`、`.env*`；若用户认为仓库不再用 pnpm 或本地不存密钥，可相应裁剪（但 `.env*` 建议保留）。
6. **不新增 README/CONTRIBUTING 说明**：假设脚本用法只更新脚本头注释（现状无脚本清单页，r10 刚补的是 Lint 门禁一节，不混入）。若用户希望有面向贡献者的脚本索引，需要在 CONTRIBUTING 新增一节并纳入本需求。
7. **版本动作**：假设本需求**不升 `package.json` version、不发布、不部署**（纯仓库工具脚本，与宿主运行时无关），因此不需要 `deploy.mjs` 与重启 web。
