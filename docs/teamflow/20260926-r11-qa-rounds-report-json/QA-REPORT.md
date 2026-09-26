# QA-REPORT — `scripts/qa-rounds-report.mjs --json`（r11）

## 0. 结论（先行）

**可验收**。12 条 AC 全部通过；**无 P0/P1/P2 缺陷**，仅 5 项 P3 观察（口径/文档级，不阻塞）。

- 独立校验（自建、不复用 dev 探针）：`qa-r11-verify.mjs` **91 断言全绿 / exit 0**，覆盖 AC-1~AC-11；1 条 `OBS-1` 为刻意标注的边界观察，不参与判定。
- 既有门禁：`pnpm run typecheck` / `pnpm run lint` / `pnpm test` / `pnpm run prepublishOnly` **全部 exit 0**，新套件在两条链末尾真实执行。
- 架构核验：交付与蓝图一致，未发现重复实现或结构破坏（1 处向后兼容的可选参数偏离，见 OBS-3）。

## 1. 范围与环境

| 项 | 内容 |
|---|---|
| 交付面 | `scripts/qa-rounds-report.mjs`(M)、`test/qa-rounds-report.test.js`(新)、`package.json`(双链)、`.gitignore`(+9 行)、`docs/teamflow/memory.md`(+1 行约定) |
| 基线 | 分支 `release-v0.2.3`，HEAD `e5382c9`；改动全部留工作区未提交（按 [Git discipline] 交 host 收口） |
| 运行时 | Windows 10 / node v22.22.3 / pnpm；DSH 文件沙箱 workspace-write |
| 沙箱约束 | 子进程管道 stdio 触发 EPERM → 全部子进程捕获改用**文件句柄 stdio**（与仓库既有手法一致） |
| 独立校验器 | `logs/teamflow/tf-muie9t3q-fjcl96/scripts/qa-r11-verify.mjs`（自造 fixture + 自取 HEAD 旧版，避免自证） |
| 真实数据 | `$DSH_HOME/teamflow` 实存工作区（含带 `qaRounds` 的 run），用于 AC-1 真实路径字节比对 |

## 2. 用例与结果（AC 逐条）

| AC | 判据 | 检测命令（均在本仓运行） | 结果 |
|---|---|---|---|
| AC-1 默认零回归 | stdout 与改动前逐字节相同 | `node logs/teamflow/tf-muie9t3q-fjcl96/scripts/qa-r11-verify.mjs` → AC-1 段 8/8（fixture A 无参/单 runId/无命中、空目录、`DSH_HOME` 不存在、**真实 `$DSH_HOME` 无参与单 run**、畸形数据），新旧 stdout 与退出码全等 | PASS |
| AC-1 材质保真 | 对比用的旧版必须真等于 HEAD | 同 checker：`git rev-parse HEAD:scripts/qa-rounds-report.mjs` == `git hash-object <物化副本>`（`eaf62dae…`） | PASS |
| AC-2 JSON 合法且纯 | 可 `JSON.parse`、零人读文案、exit 0 | `node scripts/qa-rounds-report.mjs --json` + checker AC-2/4 段 | PASS |
| AC-3 参数位置无关 | 3 形态等价、runId=首个非 `-` 参数 | checker AC-3 段 6/6（`--json`、`--json tf-x`、`tf-x --json`、`--nope`、`-x r1`、空 argv） | PASS |
| AC-4 结构稳定可 diff | 键序固定、schema 常量、两次逐字节相同、无路径泄漏 | checker：顶层/round(14 键)/aggregate/roundCosts/defect(4 键) 键序断言 + 两次运行全等 + 无 `$TMP`/仓库绝对路径 | PASS |
| AC-5 runs/rounds 有据 | 覆盖全部带 `qaRounds` 的 run、`workspace→runId` 排序、缺失补 `null`、`defects` 缺失补 `[]` | checker AC-5 段（乱序多工作区 + 缺字段 + 非数组 `defects` + 空串 `sev`） | PASS |
| AC-6 两态同源 | 文本数字 == JSON 聚合 | checker AC-6 段：从**运行输出**正则回抽 收敛/停滞、`checks/blocking`（%）/门禁/均值/样本串，逐项等于 `aggregate`；样本真值 {9,9,4}、`avg=7`、`converging/stalling=0/1` | PASS |
| AC-7 空态与容错 | 空态/坏 journal 不提前退出且仍合法 JSON | checker AC-7 段 7/7（`teamflow` 空目录、`DSH_HOME` 不存在、坏 JSON 与 `stages:[]` 被跳过、文本空态保留原提示语且无聚合段） | PASS |
| AC-8 只读无副作用 | 不写盘、import 零 stdout、不读 `$DSH_HOME` | checker AC-8 段：源码正则无写盘/子进程调用、import 期劫持 stdout 实测 0 字节、真实 journal **SHA256 与 mtime 前后不变** | PASS |
| AC-9 永久门禁 | 新套件免 spawn、登记双链、`pnpm test` 全绿 | `node test/qa-rounds-report.test.js`（全绿）＋ `grep child_process\|spawn` → **0 命中** ＋ `package.json` 两链各出现 1 次且位于链尾 | PASS |
| AC-10 既有门禁零回归 | typecheck/lint/test 全绿、零新增依赖 | `pnpm run typecheck` 0 / `pnpm run lint` 0 warning 0 error / `pnpm test` 0 / `pnpm run prepublishOnly` 0；脚本 import 仅 `node:` 内置 | PASS |
| AC-11 用法文档同步 | 头注释含 `--json` 与 JSON 结构、字段名一致 | checker AC-11 段：抽查 `schema`/`checksRatio`/`roundCosts`/`hasRework`/`withCriterion`/`runs-with-rework` 与用法两行全部命中 | PASS |
| AC-12 边界与收口合规 | 白名单外零改动、logs 不入提交 | `git status --porcelain` = 5 个文件；`git status --porcelain -- host client teams.json AGENTS.md` 为空；`git add --dry-run -A -- .` 恰列这 5 个 | PASS |

## 3. 架构核验（M3）

- 蓝图（TECHNICAL §11）存在且被遵循：`/scripts/qa-rounds-report.mjs` 分层 = `parseArgs` / `collectJournals`(io 可注入) / `buildReport`(唯一计算点) / `renderText` / `renderJson` + `main()` 入口守卫；依赖仅 `node:` 内置，装配序 1→2→3 一致。
- **无重复实现**：`git ls-files | grep qa-rounds` 仅 1 份实现；无并行机制/影子适配器；两态渲染共用同一 `Report`（AC-6 由结构保证，非纪律）。
- 冲突点已被注释钉死：排序只发生在 `renderJson`（文本态保持 fs 枚举序）——checker 用**反向断言**验证（同一 report：文本=input 序，JSON=字典序）。
- 蓝图偏离：仅 OBS-3（可选第二参），向后兼容且为满足 §3.2 所必需。

## 4. 交付形态契约 / 提交面（0b / 0c）

- **0b**：本 run 状态切片**未注入「交付形态契约」** → N/A（无安装/加载类可执行判据）。该脚本不在 `package.json` `files` 白名单内（仓库内分析工具），不影响发布产物，故无 install/回滚演练需求。
- **0c 提交面卫生**：PASS。`git status --porcelain` 恰 5 个文件，**无** `node_modules/`、构建产物、工具缓存、IDE 文件或本地密钥；`.gitignore` 实测命中 `node_modules:2`、`lib:5`、`dist:6`、`coverage:7`、`.pnpm-store:27`、`.env:30`、`logs:38`、`docs/teamflow:37`；项目根无散落 `probe/`、无 `*.out/*.log` 残留。

## 5. 人工补测清单（环境限制，非交付缺陷）

| # | 项 | 方法 | 工具 |
|---|---|---|---|
| 1 | 收口提交门禁的真实 git 执行 | 普通终端或 CI 复跑 `pnpm test` —— 本沙箱内 `commit-path.test.js` 正向块与 `gitignore` 的 spawn git 探测自 SKIP（EPERM） | 任意可 spawn git 的终端 |
| 2 | 真实发版链（2FA / registry） | PRD 明确本次不 publish/deploy；本地 `pnpm run prepublishOnly` 已实跑 exit 0，仅 npm 侧人工节点未走 | npm 2FA + `release-npm-package` skill |
| 3 | `--json` 真实下游消费方接入 | 本环境无 dashboard/决策脚本消费方，已用 CLI 端到端 + `JSON.parse` + 键序/排序/null 补位断言替代 | 下游项目 |

## 6. 缺陷表

**未发现 P0/P1/P2 缺陷。**

### P3 观察（`OBS-` 前缀符合本仓 `parseDefects` 的观察项约定，不登记为缺陷、不触发打回）

| 编号 | 严重级 | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 | 检测命令 | 通过判据 |
|---|---|---|---|---|---|---|---|---|
| OBS-1 | P3 | 脚本 CLI（边界） | 构造 `qaRounds:[{outcome:'rework',defects:'not-array'}]` 的 journal，各跑新旧脚本 `node <script> r-odd1`（`DSH_HOME` 指向该 fixture） | 崩溃路径至少退出码一致（已一致=1） | 退出码均 1，但 stdout 不平价：旧版崩溃前已吐 61B（header+run 头），新版 `renderText` 抛在返回前故输出 0B | AC-1（枚举外边界） | `node logs/teamflow/tf-muie9t3q-fjcl96/scripts/qa-r11-verify.mjs` | checker 末行不再打印 `OBS-1`；当前为刻意保留的观察（journal 由 host 写入，`defects` 非数组在生产不可达） |
| OBS-2 | P3 | 架构 | `grep -n runIdOverride scripts/qa-rounds-report.mjs test/qa-rounds-report.test.js` | 导出参数应有调用点 | `renderJson(report, runIdOverride)` 及 `jsonProjection` 第二参**全仓无调用点**（`main()` 与测试均不传），为满足 §3.2 预留的死参数 | AC-5 | `-` | 第二参被删除，或 `main()` 显式传入使之可达 |
| OBS-3 | P3 | 架构 | 对照 TECHNICAL §4.2/§4.3 的单参契约读源码 85 行 | `buildReport(entries)` / `renderJson(report)` 单参 | 实现新增可选 `filter`（`buildReport(entries, filter = {})`），单参调用仍成立；为满足 §3.2 `filter.runId` 回显所必需，判为**可接受偏离** | AC-5 | `-` | 蓝图补记该可选参数，或维持现状并在 §4.2 注明 |
| OBS-4 | P3 | 输出契约 | fixture 内 `defects:[{id:'D-3',sev:'',module:'m'}]` 跑 `--json` 与文本态 | 两态对同一 journal 呈现口径一致 | JSON 原样保留 `"sev":""`（符合「缺失才补 null」字面口径），文本态按 falsy 省略 `(sev)` 括号 → 呈现不同 | AC-5 | `-` | 明确口径（空串亦归 null，或两态都保留） |
| OBS-5 | P3 | 工程文档 | `git --no-pager diff --numstat -- .gitignore` | dev 报告的行数与实际一致 | 实际 `9 0 .gitignore`（2 hunk），dev T4 摘要写「+8 行」；规则集合本身正确，仅计数不准 | AC-12 | `git --no-pager diff --numstat -- .gitignore` | 报告计数与实际一致（不影响交付物） |

## 7. 关键证据（命令 → 退出码）

- `node logs/teamflow/tf-muie9t3q-fjcl96/scripts/qa-r11-verify.mjs` → **0**（`PASS=91 FAIL=0`，8/8 字节平价，1 条 OBS-1）
- `node test/qa-rounds-report.test.js` → **0**（G0–G6 全绿，链尾 `✅ qa-rounds-report 门禁全绿`）
- `pnpm test` → **0**（新套件在 `test` 链末尾真实执行；2 项既有 SKIP 见 §5）
- `pnpm run prepublishOnly` → **0**（tsdown 双构建 + 全部套件，新套件在链尾执行）
- `pnpm run typecheck` → **0**；`pnpm run lint` → **0**（`Found 0 warnings and 0 errors.` / 61 files）
- `grep -n 'child_process\|spawn' test/qa-rounds-report.test.js` → 0 命中；`package.json` 两链各 1 次且位于链尾
- 真实 journal 只读实证：`node scripts/qa-rounds-report.mjs --json` 与无参各跑一次后，`C:\Users\gyech\.dsh\teamflow\ws-assetd-a531080f\runs\tf-mtx6fi2a-ibi7lu.json` 的 **SHA256 与 LastWriteTimeUtc 均不变**
- `git status --porcelain` → 5 个文件（`.gitignore` `docs/teamflow/memory.md` `package.json` `scripts/qa-rounds-report.mjs` `?? test/qa-rounds-report.test.js`）；`git add --dry-run -A -- .` 恰列这 5 个
