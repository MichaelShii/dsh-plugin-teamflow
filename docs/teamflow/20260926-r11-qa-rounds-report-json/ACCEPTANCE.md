<!-- meta: summary="ACCEPTANCE：r11 qa-rounds-report --json 功能面 12/12 AC 全通过（独立探针 18/18、CLI 端到端、只读实证、四门禁全绿）；架构核验发现 renderJson/jsonProjection 携带不可达第二参（蓝图 §4.3 单参契约偏离）→ ⚠️ 有条件通过，返工仅 2 条行为中性小改（删死参 + 补 buildReport 第二参注释）" -->

# 验收报告 — `scripts/qa-rounds-report.mjs --json`（r11）

- **需求**：为只读报告脚本增加 `--json` 机读输出，默认人读输出逐字节零回归（12 条局部 AC，基线依赖=无）。
- **交付面**：`scripts/qa-rounds-report.mjs`(M) / `test/qa-rounds-report.test.js`(新) / `package.json`(双链) / `.gitignore`(+9 行) / `docs/teamflow/memory.md`(+1 行约定)。
- **验收基线**：分支 `release-v0.2.3`，HEAD `e5382c9`，改动全部留工作区未提交（交 host 收口）。
- **人工补测/环境限制**：受限沙箱内 spawn git 类探测 SKIP（`commit-path` 正向块、`gitignore` 的 git 探测）；PRD 明令本次不 publish/deploy，npm 侧人工节点未走。

## 1. 结论

功能面 **12/12 AC 通过**，无 P0/P1/P2 缺陷；但架构核验（M3）发现 1 处对蓝图 §4.3 契约的偏离（`renderJson`/`jsonProjection` 携带**不可达**第二参，且为同一取值造了第二个来源）→ 按 M3 门禁判 **⚠️ 有条件通过**，返工项仅 2 条、且行为中性（见 §4）。

## 2. AC 逐条核对表

| AC | 判据（摘） | 验收方式与实测 | 结果 |
|---|---|---|---|
| AC-1 默认零回归 | 无参/单 runId stdout 与改前逐字节相同 | 物化 HEAD 副本（`git hash-object` = `eaf62dae…` = `HEAD:scripts/...`）与新脚本同一真实 `$DSH_HOME` 对比：无参 **2896 B**、单 run `tf-mu4bve7t-duux2k` **963 B**，逐字节相等（另 `pnpm test` G1 黄金串） | PASS |
| AC-2 JSON 合法且纯 | 可 `JSON.parse`、零人读文案、exit 0 | CLI 端到端：`parse=OK`、`runs=11`、`noHumanText=true`、结尾一个换行；模块态 `import` 期零 stdout | PASS |
| AC-3 参数位置无关 | 3 形态等价，runId=首个非 `-` 参数 | CLI 实测 `--json <id>` 与 `<id> --json` 的 `filter.runId` 同值且 `runs=1`；`--nope` 静默走文本态 | PASS |
| AC-4 结构稳定 | 固定键序、schema 常量、两次逐字节相同 | 两次 `--json` 全等（`twoRunsIdentical=true`）；顶层键序 `schema/filter/scanned/runs/aggregate`、round 14 键序、聚合键序断言通过 | PASS |
| AC-5 runs/rounds 有据 | 排序 workspace→runId、缺失补 `null`、`defects` 非数组归 `[]` | fixture（输入 zeta/alpha/alpha）→ JSON 序 `alpha/r-a,alpha/r-c,zeta/r-b`；**反向断言**文本态保持输入序；缺字段→`null`、`defects:'not-array'`→`[]` | PASS |
| AC-6 两态同源 | 文本数字 = JSON 聚合，口径=仅打回 run | 同一 report 抽文本数字逐项等于 `aggregate`（收敛/停滞、checks/blocking 比例、门禁、均值、样本数）；fixture 口径实测 0/1/0.5/1/3 | PASS |
| AC-7 空态容错 | 空态/坏 journal 仍合法 JSON、exit 0 | 假 io 空 root → `runs=[]`、计数 0、`checksRatio/avg=null`；文本空态保留原提示语且无聚合段 | PASS |
| AC-8 只读无副作用 | 不写盘、import 零输出 | import 期实测 **0 B**；脚本 import 仅 `node:fs/path/os/url` 且只用 `readFileSync/readdirSync/existsSync`；真实 journal `SHA256` 与 `mtime` 跑前跑后不变 | PASS |
| AC-9 永久门禁 | 免 spawn、登记双链、`pnpm test` 全绿 | `test/qa-rounds-report.test.js` 在 `test` 与 `prepublishOnly` **链尾各 1 次**并真实执行（G0–G6 全绿）；测试文件 `child_process|spawn` 命中 **0** | PASS |
| AC-10 门禁零回归 | typecheck/lint/test 全绿、零新增依赖 | `pnpm run typecheck` **0** / `pnpm run lint` **0**（61 文件、0 warning）/ `pnpm test` **0**（含新套件尾段全绿）；无新增依赖 | PASS |
| AC-11 用法文档同步 | 头注释含 `--json` 与结构、字段名一致 | 脚本 15–31 行用法 + JSON v1 结构；抽查 `schema`/`checksRatio`/`roundCosts`/`defects` 等字段名与实现一致 | PASS |
| AC-12 边界收口 | 白名单外零改动、logs 不入提交 | `git status --porcelain` 恰 5 个文件；`-- host client teams.json AGENTS.md docs/adr docs/anchors README.md` 为空；`git add --dry-run -A -- .` 恰列这 5 个；`.gitignore` 新规则实测命中（`:7 coverage`、`:12 pnpm-debug.log*`、`:27 .pnpm-store/`、`:31 .env.*`）且 `:37 docs/teamflow/`、`:38 logs/` 逐字保留 | PASS |

## 3. 架构一致性核验（M3）

- **蓝图存在**（TECHNICAL §11 `<!-- blueprint -->`）且分层被遵循：`parseArgs` / `collectJournals`(io 可注入) / `buildReport`(唯一计算点) / `renderText` / `renderJson` + `main()` 入口守卫；装配序 1→2→3 一致；依赖仅 `node:` 内置。
- **无重复实现**：`git ls-files` 仅 1 份实现，无并行机制/影子适配器；两态渲染共用同一 `Report`，AC-6 由结构保证（非纪律）。
- **两个刻意冲突点已注释钉死**：文本态零归一化；排序只在 `renderJson`（验收以反向断言验证）。
- **偏离（触发 ⚠️）**：`jsonProjection(report, runIdOverride)` / `renderJson(report, runIdOverride)` 的第二参**全仓无调用点**（`main()` 与测试均只传 1 参），取值实际由 `report.filter.runId` 唯一承载 → 与蓝图 §4.3 的 `renderJson(report) => string` 单参契约不符，且为同一取值留下第二个不可达来源。`buildReport(entries, filter)` 第二参为 AC-5 回显所必需（`main` 与测试均使用），但蓝图 §4.2 未记。

## 4. 返工项（有条件通过的原因，均为行为中性）

| 编号 | 级别 | 位置 | 要求 | 复验口径 |
|---|---|---|---|---|
| R-A1 | 必修（架构） | `scripts/qa-rounds-report.mjs:197,230,241-242` | 删除不可达的 `runIdOverride` 参数链（或用 `main()` 显式传参使其可达；推荐删除，`report.filter.runId` 已唯一承载该值） | 重跑 `node test/qa-rounds-report.test.js` + `pnpm test`，预期全绿 |
| R-A2 | 必修（文档） | `scripts/qa-rounds-report.mjs:85` JSDoc | 补一行 `buildReport(entries, filter = { runId })` 签名说明（现注释只讲口径）；TECHNICAL.md 在不可变任务夹内，不得回改 | 独立探针预期仍 18/18 |

## 5. 遗留观察（P3，不阻塞验收）

- 非数组 `defects` 在**文本态**抛错（`renderText:174`）——与改前脚本同形，journal 由 host 写入、生产不可达。
- 空串 `sev` 两态呈现不同（JSON 保留 `""`、文本按 falsy 省略括号）——口径未明，属字面口径边界。
- dev 报告 `.gitignore` 记为「+8 行」，实际 `git diff --numstat` 为 **9 0**；规则集合正确，仅计数不准。
- QA 报告 5 项 OBS 中其余项（OBS-1/4/5 及结构类观察）经复核成立，均不影响交付物。

## 6. 验收方式说明

本次验收**自建独立探针**（`logs/teamflow/tf-muie9t3q-fjcl96/scripts/acc-r11-independent.mjs`，18/18 PASS，exit 0），未复用 dev/QA 探针作判定依据；另用 CLI 端到端（cmd 字节级重定向对比）、真实 `$DSH_HOME` 只读实证与四道仓库门禁交叉验证。QA-REPORT 的 91 条断言与本次 18 条结论一致，未发现分歧。

验收结论：⚠️ 有条件通过
