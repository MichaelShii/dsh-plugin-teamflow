<!-- meta: summary="TECHNICAL：qa-rounds-report.mjs 分层为纯函数（parseArgs/collectJournals(io 注入)/buildReport/renderText/renderJson）+ CLI 入口守卫；文本渲染零改动保 AC-1 字节一致，JSON 投影独立做 null 补位与排序；新增免 spawn 的 test/qa-rounds-report.test.js 永久门禁。" -->
基线依赖：无（承接本任务夹 `PRD.md`；该脚本源自已发布 v0.1.9，无历史任务夹，PRD 已就地冻结其 stdout 为回归基线）

# 技术方案：`qa-rounds-report.mjs --json`

## 1. 架构判断（结论先行）

**把「计算」与「呈现」拆开，计算只做一次，呈现分两态；文本态一行不改，JSON 态是独立投影。**

- 唯一的计算点 `buildReport(entries)` 产出 `Report`；`renderText(report)` 与 `renderJson(report)` 只吃这一个对象 → AC-6「同源」由结构保证，不靠纪律。
- **文本态不做任何归一化**：`renderText` 逐行复刻现脚本 49/51–88 行的 `console.log` 模板（含 `String(r.outcome).padEnd(7)` 对缺失值输出 `undefined` 的旧行为）。JSON 需要的「缺失补 `null`」放在**独立投影函数**里做 → 两个诉求不互相污染，AC-1 字节一致几乎无风险（§6.1）。
- 脚本改为「导出纯函数 + 入口守卫」：`collectJournals` 的 `fs` 走**可注入 io**（默认真实 `node:fs`），使测试可喂内存 fixture 而不碰真实 `$DSH_HOME`、不 spawn（AC-8/AC-9）。
- 不动 journal 写侧、不动 host/client、不新增依赖、不新增构建步骤。

**唯一需要引入的抽象**：`io`（3 个函数的鸭子类型接口）。它解决的是「测试要造 fixture 但不能写盘/不能 spawn」这一个约束；没有它，AC-9 只能靠 spawn（受限沙箱 EPERM）。除此之外不引入任何新层。

## 2. 现状事实（行号依据，设计的前提）

| # | 事实 | 位置 |
|---|---|---|
| F1 | `const onlyRun = process.argv[2] \|\| null` —— `--json <runId>` 会把 `--json` 当 runId | `scripts/qa-rounds-report.mjs:23` |
| F2 | 收集/渲染/计数耦合在同一循环（`for (const { ws, j } of withRework)` 里既 `console.log` 又累加 6 个计数器） | 同上 63–80 |
| F3 | 空态提前 `process.exit(0)`，且发生在渲染循环与聚合之前 | 同上 50–53 |
| F4 | 文本排序 = 文件系统 `readdirSync` 枚举顺序（工作区目录、`runs/*.json` 均未排序） | 同上 26–43 |
| F5 | `test/smoke.js:605` 只断言该脚本**存在**，不断言其中间结构 → 重构安全 | `test/smoke.js:605` |
| F6 | `*.log` 已覆盖 `pnpm-debug.log`；`.gitignore` 无 `.pnpm-store/`、`coverage/`、`.env*` | `.gitignore:10` |
| F7 | 仓库测试风格：`ok(cond,msg)` + `✓`/`✗` + `process.exit(failed?1:0)`；测试直接用 node 跑（无测试框架） | `test/dev-task-id.test.js:20-24,134` |
| F8 | `scripts/migrate-phase-en.mjs:11` 的 flag 风格 = `argv.includes('--dry-run')`（宽松、无严格解析） | 同左 |

## 3. 数据模型

### 3.1 `Report`（内部唯一计算产物）

```js
Report = {
  scanned: { runs, withRounds, withRework },        // number ×3
  runs: RunEntry[],                                 // 全部带 qaRounds 的 run，**保持 F4 的 fs 枚举顺序**
  aggregate: {
    scope: 'runs-with-rework',
    converging, stalling, checks, blockingDefects, fixRounds, gates,  // number
    checksRatio,                                    // 0–1 数值；blockingDefects===0 → null
    roundCosts: { samples: number[], avg: number|null }   // samples 按累加顺序；avg = Math.round(mean)
  }
}
RunEntry = { runId, workspace, status, humanIntervention, hasRework, rounds: RawRound[] }
RawRound = journal.qaRounds[i] 原对象（**浅引用，不修改、不归一化**）
```

**`runs` 与聚合口径不同是刻意的**（PRD §9 假设 2）：`runs` = 全部带 `qaRounds` 的 run（含未打回，用 `hasRework` 区分）；`aggregate` 沿用今天文本口径 = **仅发生过打回（`outcome==='rework'`）的 run 的复验轮**。`aggregate.scope` 自证口径。

### 3.2 JSON v1（**仅渲染期投影**）

顶层固定键集合与顺序：`schema` → `filter` → `scanned` → `runs` → `aggregate`。

| 字段 | 类型 | 规则 |
|---|---|---|
| `schema` | string | 常量 `"teamflow.qa-rounds-report/v1"` |
| `filter.runId` | string \| null | `parseArgs` 结果回显 |
| `scanned.{runs,withRounds,withRework}` | number | 直取 `report.scanned` |
| `runs[]` | `RunJson[]` | **渲染期按 `workspace` → `runId` 字典序排序**（`String.prototype.localeCompare` 不用；用 `<`/`>` 逐字符比较，避免 locale 依赖） |
| `runs[].{runId,workspace}` | string | 直取；缺失（理论不可能）→ `null` |
| `runs[].status` | string \| null | 缺失补 `null` |
| `runs[].humanIntervention` / `hasRework` | boolean | `Boolean(...)`/直取 |
| `runs[].rounds[]` | `RoundJson[]` | 保持 journal 内原始顺序（不重排） |
| `RoundJson` | object | 固定 14 键，顺序见下；每键 `raw[k] ?? null`，`defects` 例外：`raw.defects` 非数组 → `[]` |
| `RoundJson` 键序 | — | `round, seq, blocking, p3, newFps, repeats, resolved, withCheck, withCriterion, qaCalls, fixCalls, gate, outcome, defects` |
| `defects[]` | object | 固定 4 键 `id, sev, module, fp`，各自 `d[k] ?? null`；元素非对象 → 全 `null` |
| `aggregate` | object | 直取 `report.aggregate`（其内部键顺序即 JSON 顺序：`scope, converging, stalling, checks, blockingDefects, checksRatio, fixRounds, gates, roundCosts{samples,avg}`） |

`JSON.stringify(report, null, 2)` 两空格缩进；主入口补一个结尾 `\n`。无时间戳、无环境路径、无 Map/Set → AC-4 两次运行逐字节相同。

**排序只发生在 `renderJson` 内**（AC-5 要求确定性排序），`renderText` 坚决用 `report.runs` 原序（AC-1 要求与旧脚本逐字节一致）。这是本设计唯一一处「两态故意不同」，必须在注释里写明原因，否则后续会被"顺手统一"而打破 AC-1。

## 4. 接口设计

### 4.1 CLI 契约

| 调用 | stdout | 退出码 |
|---|---|---|
| `node scripts/qa-rounds-report.mjs` | `renderText(report) + '\n'` | 0 |
| `node scripts/qa-rounds-report.mjs <runId>` | 同上，仅该 run | 0 |
| `node scripts/qa-rounds-report.mjs --json [runId]` / `<runId> --json` | `JSON.stringify(...,null,2) + '\n'` | 0 |
| 任意模式下的未捕获异常（理论不可达） | — | 非 0（保持现状语义：空态恒 0） |

### 4.2 导出契约（唯一被测试消费的接口）

| 导出 | 签名 | 契约 |
|---|---|---|
| `parseArgs` | `(argv: string[]) => { json: boolean, runId: string\|null }` | `json = argv.includes('--json')`；`runId = argv.find(a => !a.startsWith('-')) ?? null`（F1 的修法）；不抛、不读环境 |
| `collectJournals` | `({ root, onlyRun = null, io = nodeIo }) => Array<{ws, j}>` | **纯 IO 适配层**：无 `writeFile`/`mkdir`/`rm`；root 不存在 → `[]`；目录项 `!isDirectory()` 跳过；文件须 `.json`；`onlyRun` 命中文件名 `\`${onlyRun}.json\``；`JSON.parse` 失败/`!Array.isArray(j.stages)`/`stages.length===0` → 跳过；**保持 readdir 顺序**；不打印任何东西 |
| `buildReport` | `(entries) => Report` | 纯函数：无 IO、无输出、不修改入参对象；`withRounds`/`withRework` 过滤 + §3.1 聚合（含 `avg`） |
| `renderText` | `(report) => string` | 纯函数：返回**不含结尾换行**的完整文本；空态（`scanned.withRounds===0`）**只返回 header + 提示语、不返回聚合段**；表头/行模板与旧版逐字节一致（§6.1） |
| `renderJson` | `(report) => string` | 纯函数：`JSON.stringify(jsonProjection(report), null, 2)`；不打印、不写盘 |

`nodeIo = { existsSync, readdirSync, readFileSync }`（`node:fs` 直引）。测试注入 `{ existsSync, readdirSync, readFileSync }` 内存实现即可覆盖全部扫描/容错分支。

### 4.3 入口守卫（AC-8）

```js
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve, join } from 'node:path'

function main() {
  const { json, runId } = parseArgs(process.argv.slice(2))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const report = buildReport(collectJournals({ root: join(dshHome, 'teamflow'), onlyRun: runId }))
  process.stdout.write((json ? renderJson(report) : renderText(report)) + '\n')
}

const invoked = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invoked) main()
```

要点：
- `DSH_HOME`/`homedir()` **只在 `main()` 内读取** → import 期零环境依赖、零 IO（AC-8）。
- `main()` 用 `process.stdout.write` 一次写完，**不使用 `process.exit`**：旧脚本空态用 `process.exit(0)` 存在 stdout 未 flush 的隐患（管道下是异步写），去掉它既消隐患又保持字节一致（返回码默认为 0）。
- `process.argv[1]` 与 `import.meta.url` 同源比较走 `pathToFileURL(resolve(...))`；Windows 大小写/分隔符差异在此归一（两侧都过 `resolve`+`pathToFileURL`）。

## 5. 前端与状态管理（本需求无 UI，说明为何不涉及）

- **无前端组件、无页面拆分**：交付面是 CLI stdout，唯一的「呈现层」就是 §4.2 的 `renderText`/`renderJson` 两个纯渲染函数——「两态渲染」即本需求的呈现分层，等价于组件拆分，但不引入任何客户端代码。
- **无状态管理、无缓存、无持久化**：每次调用从 `$DSH_HOME/teamflow/<ws>/runs/*.json` 全量重算（现状即如此）。报告对象生命周期 = 单次进程；**不写任何缓存文件**（否则违反 AC-8 只读）。`filter.runId` 是唯一「输入态」，由 argv 单次解析得到并回显进 JSON。
- **不要新增 dashboard/HTTP 接口**：`--json` 就是给下游（决策脚本/jq/dashboard）的机读入口；本需求不建 web 面（PRD §3 非目标）。

## 6. 关键实现点与边界

### 6.1 文本态字节一致的 5 条硬约束（AC-1）

1. 逐 `console.log` 复刻为文本行；`renderText` 返回 `lines.join('\n')`，主入口补 `'\n'` —— 与 N 次 `console.log` 的字节完全等价。
2. 带缺陷 id 的那一行仍是**一个数组元素**，内容为 `${base}\n      ${ids}`（内嵌换行），不要拆成两个元素后误加缩进。
3. 空态分支**早返回**：`扫描到 ...` 行 + `'\n（暂无埋点数据：埋点是 2026-09-15 之后才写入 journal 的，需要新的 run 来积累。）'`，不含聚合段（对应 F3）。
4. 文本渲染**使用原始字段**（`String(j.status)` / `String(r.outcome).padEnd(7)` / `${r.gate === null ? '-' : r.gate}`），归一化只存在于 `renderJson` 的投影里 → 缺字段的 journal 在文本态仍输出 `undefined`（旧行为）。禁止把 `null` 补位引入文本路径。
5. 聚合段的 4 行与 `判据（供人决策，非自动动作）…` 行逐字照抄（含 `═══`、全角括号、`（样本 N：…）` 拼接）。

**跨态数字一致性**（AC-6）的映射：文本百分比 = `Math.round(aggregate.checksRatio * 100)`；`n/a` 出现当且仅当 `checksRatio === null`；`单轮成本` 的样本串 = `aggregate.roundCosts.samples.join(', ')`。

### 6.2 归一化对聚合中性（AC-5 反作用力）

`RoundJson` 的 `?? null` 只影响 JSON 形状，聚合一律从**原始** round 读，且各表达式已天然容忍缺失：`Number(x) || 0`（`null`/`undefined` 同为 0）、`r.round > 1`（二者同为 false）、`r.gate === true`、`typeof r.fixCalls === 'number'`。→ 归一化不可能改变数字（测试用「缺字段 round」直接压这两条同时成立）。

### 6.3 其余边界

- `onlyRun` 传了但不命中 → `collectJournals` 返回 `[]` → `scanned.*=0`、`runs:[]`、`checksRatio:null`、`roundCosts.avg:null`，退出码 0（AC-7）。
- 坏 JSON / 无 `qaRounds` / `stages` 为空 / `qaRounds` 非数组 → 静默跳过，不影响其余文件（沿用现状 + `?`/`Array.isArray` 双保险）。
- `defects` 元素为 `null`/字符串 → 投影为全 `null` 的固定 4 键对象，不抛。
- `roundCosts.samples` 只在 `typeof fixCalls === 'number' && typeof qaCalls === 'number'` 时累加（现口径）；`0` 是合法样本，不能用 falsy 判定。
- 未知 `-` 前缀参数静默忽略（PRD §9 假设 1，与 F8 风格一致）；**不新增退出码语义**。
- 脚本头注释补 `--json` 用法 + JSON 结构概要（AC-11），字段名与 §3.2 表格一致。

### 6.4 测试的编码陷阱（AC-1 双证工程证据）

旧版脚本比对必须**字节级**，而 pwsh 重定向会把文本按 UTF-8/换行归一。取旧版用 PowerShell 管道 + node 落盘：
`git show HEAD:scripts/qa-rounds-report.mjs | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(process.argv[1],s))" <out.mjs>`
（pwsh 管道投喂进程 stdin，不经 `child_process` 捕获 → 不触发受限沙箱的 EPERM；`>` 重定向经 cmd 亦是逐字节，二选一，勿用 `Out-File`。）

## 7. 测试策略（AC-9）

新增 `test/qa-rounds-report.test.js`：**只用 `import` + 内存 fixture，无 `child_process`/`spawn`，不读写真实 `$DSH_HOME`**；风格照 F7（`ok()` + `process.exit(failed?1:0)`）。

| 组 | fixture（内存） | 覆盖 AC | 关键断言 |
|---|---|---|---|
| G0 导入面 | 静态 import 本模块 | AC-8 | 导出 5 个函数均为 function；源码正则断言**无** `writeFile|mkdir|appendFile|rmSync|unlink|child_process|spawn`；`collectJournals({root:'<不存在路径>'})` → `[]` 不抛 |
| G1 黄金文本 | 2 个 run（1 个两家打回 run：R1 停滞/R2 收敛；1 个 `qaRounds` 无打回） | AC-1 | `renderText(report)` === **手写黄金字符串**（按 §6.1 从旧源码模板逐一转写，**不得**由新实现输出反抄）；空态另断言只含 header+提示语、无 `═══` |
| G2 JSON 合法纯 | 同 G1 | AC-2/4 | `JSON.parse(renderJson(report))` 成功；`renderJson` 两次调用 `===`；文本不含 `扫描到`/`═══`/`暂无`/`──` |
| G3 argv | `parseArgs` 3 形态：`['--json']`/`['--json','tf-x']`/`['tf-x','--json']`/`['--nope']` | AC-3 | `{json:true,runId:'tf-x'}` ×2、`{json:false,runId:null}` for `--nope` |
| G4 形状与排序 | 乱序多 run + 缺字段 round + `defects` 缺失/非数组 | AC-4/5 | 键集合 `deepStrictEqual(Object.keys(...))`；`runs` 按 workspace→runId 升序；缺失键值为 `null`；`defects` 为 `[]`；`renderText` 的 run 顺序 = 输入顺序（**排序只在 JSON**） |
| G5 同源 | 从 G1 文本用正则抽取数字/百分比/样本串 | AC-6 | 与 `aggregate` 逐项相等（含 `Math.round(checksRatio*100)` 与 `n/a`↔`null` 双向） |
| G6 容错扫描 | 注入 io：root 不存在 / 坏 JSON / 无 `qaRounds` / `onlyRun` 不命中 / 目录项非目录 | AC-7/8 | `scanned` 三项为 0、`runs:[]`、`checksRatio/avg === null`；坏文件不影响同目录好文件（一次调用里混合断言） |

**不塞进测试的东西**：真跑脚本（AC-1 双证的第二证、AC-2 的真实 stdout）——用真实环境命令 + `[Verification evidence]` 记录，理由见 PRD 风险表（spawn → 沙箱 EPERM，`commit-path.test.js` 已有 SKIP 先例）。

## 8. 任务拆分（按文件边界，互斥 → 可并行）

| 任务 | 文件（写） | 只读 | 依赖 | 出口判据 |
|---|---|---|---|---|
| **T1 分层重构 + `--json` + 头注释** | `scripts/qa-rounds-report.mjs` | — | 无（串行前缀，定了 §4.2 契约才能并行） | AC-1 文本模板逐字复刻；AC-2/3/4/5/6/7 手工验过；`--json` 真跑可 `JSON.parse`；`node scripts/...`（无参）输出与新脚本改造前 diff 为空 |
| **T2 永久门禁套件** | `test/qa-rounds-report.test.js` | `scripts/qa-rounds-report.mjs`、`.gitignore`（只需知道不改） | T1（导出契约冻结后可并行编写，**跑通必须 T1 完成**）`blocked_by: T1` | §7 的 G0–G6 全绿；`node test/qa-rounds-report.test.js` exit 0；每个 AC-2/3/4/5/6/7/8 ≥1 断言；文件内无 `spawn`/`child_process` |
| **T3 双链登记** | `package.json` | — | T2（链上文件名） | `test` 与 `prepublishOnly` **两条**链均含 `node test/qa-rounds-report.test.js`；`pnpm test` 跑到新套件；**不升 version** |
| **T4 `.gitignore` 补全** | `.gitignore` | — | 无 | 追加 `.pnpm-store/`、`pnpm-debug.log*`、`coverage/`、`.env`、`.env.*`；**`docs/teamflow/`、`logs/` 两条原样不动**（逐行 diff 核验）；不改 `*.log` 等既有行 |
| **T5 收口与工程证据** | 无（git 动作 + `logs/teamflow/<runId>/scripts/` 证据脚本，不提交） | 全部 | T1–T4 | AC-1 双证（旧版 diff 空 + 黄金字符串）；AC-10 三条命令 exit 0；AC-12 `git diff --stat` 白名单核验；一个 run 一个 commit |

**T5 承接 PRD §7 的 git 动作（不得丢失）**：
1. 在 `release-v0.2.3` **就地实现，不新建、不切换分支**；
2. 开工工作区干净 → **不做** `stash`/预处理；
3. **一个 run 一个 commit**，提交内容 = 代码 + 任务夹 + `memory.md`；
4. `logs/teamflow/` **永不入提交**（AC-1 证据脚本、legacy 副本一律落 `logs/teamflow/<runId>/scripts/`，项目根不得出现散落探针）；
5. **不执行** `npm publish`、不打 tag、不跑 `node deploy.mjs`（纯仓库工具脚本，与宿主运行时无关）；
6. **不碰** `host/`、`client/`、`teams.json`、`AGENTS.md`、`README.md`、`CONTRIBUTING.md`、`docs/TODO.md`、`docs/devlog.md`。

**并行度**：T1 先起（唯一写脚本的人）；T2/T3/T4 文件互斥可同批并行；T5 收口串行在最后。任何任务都不得改他人文件；发现需要改他人文件 = 改契约（回到本方案）而不是抢写。

## 9. 风险与缓解

| 风险 | 影响 | 缓解（已落到方案） |
|---|---|---|
| 重构改坏空格/措辞/顺序 | AC-1 直接破功 | §6.1 五条硬约束 + G1 手写黄金字符串 + T5 旧版字节级 diff |
| 顺手把 `runs` 排序统一进 `renderText` | 多工作区时文本顺序变化 → AC-1 静默破功 | §3.2 明令「排序只在 `renderJson`」+ G4 反向断言（文本顺序 = 输入顺序） |
| 归一化泄进文本路径（`null` vs `undefined`） | 缺字段 journal 输出变化 | §6.1-4 + §6.2 聚合中性说明 |
| 测试用 spawn | 受限沙箱 EPERM → 门禁形同虚设 | §7 io 注入 + 内存 fixture；真跑证据走命令输出 |
| 真跑证据被 pwsh 重定向改编码 → 假 diff | 双证失效或误判 | §6.4 管道喂 node stdin 落盘 |
| 改动越界（host/client/文档） | 需重新 bundle/deploy | T5 白名单核验 + AC-12 |

**PRD §9 七项假设在本设计中的承接**：①未知 flag 静默忽略（§6.3）；②`runs` 全集合 / `aggregate` 仅打回 run（§3.1 + `scope` 自证）；③允许最小重构抽纯函数（§4.2/4.3，默认输出零变化）；④`schema=…/v1`、camelCase、`checksRatio` 用 0–1（§3.2）；⑤`.gitignore` 最小集（T4，含「`*.log` 已覆盖 `pnpm-debug.log` 故该行是对称冗余、保留无害」的说明）；⑥不新增 README/CONTRIBUTING（只改脚本头注释）；⑦不升版/不发布/不部署（T5-5）。

## 10. 验证脚本清单（写进 dev 的 `[Verification evidence]`）

```
node test/qa-rounds-report.test.js          # 新门禁（G0–G6）
pnpm run typecheck                          # tsc --noEmit
pnpm run lint                               # oxlint --deny-warnings
pnpm test                                   # 全量（含新套件）
node scripts/qa-rounds-report.mjs --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{JSON.parse(s);console.log('json ok')})"
# AC-1 双证（证据脚本落 logs/teamflow/<runId>/scripts/，不提交）：
#   r11-legacy-diff.mjs：git show HEAD:scripts/qa-rounds-report.mjs → legacy 副本，同一 DSH_HOME 跑新旧、逐字节比对（空=通过）
ls logs/teamflow/<runId>/scripts/            # 证据白名单（检查脚本/笔记），项目根零散落探针
```

## 11. 架构蓝图

<!-- blueprint -->
{"summary":"把只读报告脚本分层为「io 注入的收集 / 单点 buildReport / 两态渲染」，文本态逐字复刻旧模板保零回归、JSON 投影独立做排序与 null 补位，并用免 spawn 的内存 fixture 套件锁死全部契约。","modules":{"/scripts/qa-rounds-report.mjs":{"responsibility":"唯一交付物：CLI 解析（--json + 首个非 - 参数作 runId）→ collectJournals（io 可注入、只读、容错跳过）→ buildReport（唯一计算点：scanned / runs 原序 / aggregate）→ renderText（旧模板逐字复刻，不含结尾换行）或 renderJson（v1 投影：排序 + 缺失补 null）；入口守卫 main() 仅在直跑时读 DSH_HOME 并写 stdout。","dependsOn":["node:fs","node:path","node:os","node:url"],"assemblyOrder":1,"why":"两态渲染共享同一个 Report 对象，才使『文本与 JSON 数字同源』成为结构事实而非纪律；io 注入是『测试免 spawn 且不碰真实 $DSH_HOME』的唯一成本，故保留；文本态不做归一化、JSON 投影单独做归一化，是为了在同一份代码里同时满足『字节零回归』与『键集合固定』两个方向相反的诉求。"},"/test/qa-rounds-report.test.js":{"responsibility":"永久门禁：import 纯函数 + 内存 fixture（含假 io）覆盖 AC-2/3/4/5/6/7/8，含手写黄金文本逐字节断言、JSON 键集合/排序/null 补位、跨态数字同源、扫描容错、只读无副作用（含源码正则）。","dependsOn":["../scripts/qa-rounds-report.mjs"],"assemblyOrder":2,"why":"既有套件全是无框架 node 断言，新套件同形零新增依赖；不 spawn 是对受限沙箱 EPERM 的既有约定（commit-path.test.js 已有 SKIP 先例），因此测试必须消费导出契约，反过来约束了脚本必须做入口守卫的分层。"},"/package.json":{"responsibility":"把新套件登记进 test 与 prepublishOnly 两条链，使门禁在本地与发版前都被执行。","dependsOn":[],"assemblyOrder":3,"why":"两链并存是本仓既有事实（prepublishOnly 不继承 test），只登记一条会让发版前门禁漏掉新套件。"},"/.gitignore":{"responsibility":"按本栈补全 .pnpm-store/、pnpm-debug.log*、coverage/、.env、.env.*，防止收口整树 add 把噪音写进永久历史；docs/teamflow/ 与 logs/ 两条原样保留。","dependsOn":[],"assemblyOrder":4,"why":"收口提交是整树 add，仓库自身 .gitignore 是唯一防线；与 host 运行期『不替用户决定忽略什么』（方案 B）不冲突——本条只改本仓库自己的文件。"}},"duplications":["renderText 与 renderJson 对 run 的遍历顺序刻意不同（文本=fs 枚举序，JSON=字典序），不是重复而是两个 AC 的冲突点，必须靠注释钉死，否则会被后续『顺手统一』破坏 AC-1","'缺失→null' 的补位逻辑集中在 jsonProjection 一处，禁止在 renderText 复用（会让文本从 undefined 变 null）","报告数字只有一个来源（buildReport），文本百分比只做 Math.round(ratio*100) 的呈现换算，禁止在渲染层重新累加"],"tasks":[{"title":"T1 分层重构 + --json + 头注释（零回归）","files":["/scripts/qa-rounds-report.mjs"],"reads":["/.gitignore"],"spec":"按 §4.2 导出 parseArgs/collectJournals(io 注入)/buildReport/renderText/renderJson 与入口守卫；文本态逐字复刻旧模板（§6.1 五条硬约束，含 `\\n      ${ids}` 内嵌换行与空态早返回），JSON 态按 §3.2 固定键序投影并排序；补脚本头 --json 用法与结构概要。"},{"title":"T2 永久门禁套件（免 spawn / 内存 fixture）","files":["/test/qa-rounds-report.test.js"],"reads":["/scripts/qa-rounds-report.mjs","/test/dev-task-id.test.js"],"spec":"按 §7 G0–G6 实现，ok()/✓/✗ 风格 + exit(failed?1:0)；黄金文本手写不从新实现反抄；每个 AC-2/3/4/5/6/7/8 至少一条断言；文件内不得出现 child_process/spawn，不读写真实 $DSH_HOME。"},{"title":"T3 package.json 双链登记","files":["/package.json"],"reads":["/test/qa-rounds-report.test.js"],"spec":"在 test 与 prepublishOnly 两条链末尾各追加 `&& node test/qa-rounds-report.test.js`；不升 version、不改 files 白名单、不引入依赖。"},{"title":"T4 .gitignore 补全","files":["/.gitignore"],"reads":[],"spec":"追加 .pnpm-store/、pnpm-debug.log*、coverage/、.env、.env.*；docs/teamflow/ 与 logs/ 两条零改动（diff 核验）。"},{"title":"T5 收口与工程证据（git 动作）","files":[],"reads":["/scripts/qa-rounds-report.mjs","/test/qa-rounds-report.test.js","/package.json","/.gitignore"],"spec":"就地 release-v0.2.3 不切分支、工作区干净不做预处理；跑 AC-1 双证（旧版字节级 diff 空 + 黄金字符串）与 AC-10 三条命令；证据脚本落 logs/teamflow/<runId>/scripts/ 不入提交；一个 run 一个 commit（代码+任务夹+memory.md），不 publish/deploy/tag；AC-12 白名单核验（host/client/teams.json/AGENTS.md 零改动）。"}]}
<!-- /blueprint -->

<!-- state -->{"phase":"tech","summary":"TECHNICAL 完稿：qa-rounds-report.mjs 分层为 parseArgs / collectJournals(io 可注入) / buildReport(唯一计算点) / renderText(旧模板逐字复刻) / renderJson(v1 投影：workspace→runId 排序 + 缺失补 null) + main() 入口守卫(仅在直跑时读 DSH_HOME)；关键裁定：排序只发生在 JSON 渲染器、文本态不做任何归一化（缺字段仍输出 undefined）以保 AC-1 字节零回归，聚合只从原始 round 读故归一化对数字中性；测试用 import + 内存 fixture + 假 io，零 spawn、不碰真实 $DSH_HOME（G0–G6 覆盖 AC-2/3/4/5/6/7/8）；5 任务文件边界互斥（T1 脚本先行 → T2 测试 / T3 package.json 双链 / T4 .gitignore 并行 → T5 收口），PRD 的 git 动作（不切分支、一 run 一 commit、logs 不入提交、不 publish/deploy、临时脚本落 logs/teamflow/<runId>/scripts/）全部落在 T5。","memory":["r11 技术方案：文本态零归一化 + JSON 投影独立归一化；排序只在 renderJson（renderText 保持 fs 枚举序）——这两条是 AC-1 与 AC-5 的冲突点，后续勿统一","qa-rounds-report.mjs 导出契约：parseArgs/collectJournals({root,onlyRun,io})/buildReport/renderText/renderJson；io 注入是测试免 spawn 的唯一手段（受限沙箱 child_process EPERM）","AC-1 双证：① 手写黄金字符串（从旧源码模板转写）② git show HEAD 取旧版字节级 diff；取旧版用 pwsh 管道喂 node stdin 落盘，忌 Out-File 编码归一","新测试文件 test/qa-rounds-report.test.js 须同时登记 package.json 的 test 与 prepublishOnly 两条链","git 动作：release-v0.2.3 就地、一 run 一 commit、logs/teamflow 不入提交、不 publish/deploy、证据脚本落 logs/teamflow/<runId>/scripts/"]}<!-- /state -->
