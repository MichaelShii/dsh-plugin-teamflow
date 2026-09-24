/**
 * dsh-plugin-teamflow — dev 任务「文件交集合并」护栏（GitHub issue #4）。
 *
 * **被修的 bug**（实锤 run `tf-mu6tb281-4n43oc`，2026-09-24 扫本机 58 个 run 捞出来的）：
 *  正常开发路径有「文件有交集 → 合并成一个任务」的护栏，但 **resume 补跑路径**（`executePipeline`
 *  里 `resume` 分支）把过滤出来的**未合并**任务直接丢给了 `runPool` —— 首次开发有护栏、
 *  失败重跑反而没有。该 run 的第三轮补跑里 T0/T5/T6 同时起跑，而 T0∩T6 =
 *  {package.json, tsdown.config.ts, README.md}，正是 issue 描述的「两个子代理抢同一文件」。
 *
 * **修法**：冲突合并抽成 `util.mergeFileOverlaps` 纯函数，两条路径共用。
 * 本文件锁三件事：① 函数本身的不变量；② resume 路径确实走了它（源码级断言，防再次绕过）；
 * ③ `planDevWaves` 的波次不变量（2026-09-25 升级：write∩write 仍合并，依赖边改为**排序**）。
 *
 * **演进**：初版用「任一无 files ⇒ 整批合并串行」堵住并发写冲突（最保守等价手段）。Run 3 实锤其代价——
 * 5 个任务里 1 个（提交任务）声明空 files，把 4 个本可并行的任务一起拖成串行（实测只多花 ~0s 墙钟，
 * 但规则本身被证明会把无关任务陪葬）。于是把「合并换互斥」拆成两半：write∩write 仍合并
 * （同一作者调和优于两个 agent 先后覆盖），依赖边（reads / dependsOn / 未声明写集）改为**分波排序**，
 * 即 issue 的 AC3。三层护栏（合并/分波、宿主 CAS、事后检测）在分波后依然全部生效。
 */
import { readFileSync } from 'node:fs'
import { mergeFileOverlaps, concurrentWriteConflicts, normalizeTasks, TASK_FILES_LIMIT, planDevWaves } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const groups = (files) => files.map((f, i) => ({ id: `dt-${i + 1}`, title: `T${i}`, files: f, spec: `spec-${i}` }))

const pipeSrc = readFileSync(new URL('../host/core/pipeline.ts', import.meta.url), 'utf8')

// ── 1) 无交集 → 不合并（并行度不受损） ──
console.log('\n[1] 无交集时不合并')
const disjoint = mergeFileOverlaps(groups([['/a.ts'], ['/b.ts'], ['/c.ts']]))
ok(disjoint.length === 3, '三个互不相交的任务 → 仍是 3 组（不得因护栏白白牺牲并行度）')

// ── 2) 有交集 → 合并，且 ids 累加 ──
console.log('\n[2] 有交集时必须合并到一个子代理')
const hit0 = mergeFileOverlaps(groups([['/a.ts', '/shared.ts'], ['/b.ts', '/shared.ts']]))
ok(hit0.length === 1, '两个共享 /shared.ts 的任务 → 合并为 1 组')
ok(hit0[0].ids.join(',') === 'dt-1,dt-2', 'tasks id 全部累加到 ids（丢失 → resume 判定「没做过」而重复补跑）')
ok(hit0[0].files.includes('/a.ts') && hit0[0].files.includes('/b.ts') && hit0[0].files.includes('/shared.ts'), '合并后 files 取并集')

// ── 3) 传递闭包：A∩B、B∩C，即使 A∩C 为空也必须同组 ──
console.log('\n[3] 传递闭包（最容易漏的形状）')
const chain = mergeFileOverlaps(groups([['/a', '/b'], ['/b', '/c'], ['/d', '/c'], ['/z']]))
ok(chain.length === 2, 'a-b / b-c / c-d 串成一条 → 连同空闲任务共 2 组')
ok(chain[0].ids.length === 3 && chain[0].files.includes('/d'), '链路上的 3 个任务在同一组')
ok(chain[1].ids.join(',') === 'dt-4', '无关任务 /z 独立成组')

// ── 3b) 二阶桥接（旧实现在这里破功：X 同时命中两个已存在的组） ──
console.log('\n[3b] 桥接场景：X 同时命中两个既有组')
const bridge = mergeFileOverlaps(groups([['/A', '/B'], ['/C'], ['/B', '/C']]))
ok(bridge.length === 1, '{A,B} / {C} / {B,C} → 必须合成 1 组（旧实现只并第一个命中组 → G1={A,B,C} 与 G2={C} 仍相交）')
ok(bridge[0].ids.length === 3, '三个任务全在同一组')

// ── 4) files 为空 = 边界未知 → **整批合并串行**（B1 严格版：未知与一切互斥） ──
console.log('\n[4] 边界未知 ⇒ 保守全串行（安全默认值）')
const empty = mergeFileOverlaps(groups([[], ['/a.ts'], []]))
ok(empty.length === 1, '只要有一个任务没声明 files → 全部合成 1 组串行（未知写集可能与任何任务相交）')
ok(empty[0].ids.length === 3, '所有任务都进了这一组（身份不丢）')
const singleUnknown = mergeFileOverlaps([{ id: 'dt-1', title: '整体开发', files: [] }])
ok(singleUnknown.length === 1 && singleUnknown[0].ids.length === 1, '单任务场景（整体开发兜底）不受影响：仍是 1 组 1 任务')
const allDeclared = mergeFileOverlaps(groups([['/a.ts'], ['/b.ts'], ['/c.ts']]))
ok(allDeclared.length === 3, '全都声明了 files 且互不相交 → 3 路并行（声明是恢复并行的唯一开关）')

// ── 4b) owns / reads：只读依赖**不**产生互斥 ──
console.log('\n[4b] reads 不参与互斥判定（回收只读接触带来的并行度）')
const ro = mergeFileOverlaps([
  { id: 'dt-1', title: 'T1', files: ['/feature.ts'], reads: ['/types.ts', '/constants.ts'] },
  { id: 'dt-2', title: 'T2', files: ['/panel.tsx'], reads: ['/types.ts'] },
])
ok(ro.length === 2, '两个任务都只读 types.ts 但各写各的 → **不合并**（旧谓词会把它们串行）')
const roBlocked = mergeFileOverlaps([
  { id: 'dt-1', title: 'T1', files: ['/types.ts'] },
  { id: 'dt-2', title: 'T2', files: ['/panel.tsx'], reads: ['/types.ts'] },
])
ok(roBlocked.length === 2, '一方 owns、另一方只读同一文件 → 不合并（只读方不会写，无冲突）')
const roOwnsWins = mergeFileOverlaps([
  { id: 'dt-1', title: 'T1', files: ['/shared.ts'], reads: ['/shared.ts'] },
  { id: 'dt-2', title: 'T2', files: ['/shared.ts'] },
])
ok(roOwnsWins.length === 1 && roOwnsWins[0].ids.length === 2, '同一文件同时出现在 owns 与 reads → **owns 胜出**（仍判定冲突）')
const roLegacy = mergeFileOverlaps([{ id: 'dt-1', title: 'T1', files: ['/a.ts'] }, { id: 'dt-2', title: 'T2', files: ['/b.ts'] }])
ok(roLegacy.length === 2, '未声明 reads（存量蓝图）→ 行为与旧实现逐字一致（安全默认：不标 = 当 owns）')

// ── 5) 不变量：任意两组之间文件集必须互斥 ──
console.log('\n[5] 不变量抽查：随机输入下分组两两互斥')
const rnd = []
for (let i = 0; i < 40; i++) rnd.push({ id: `dt-${i + 1}`, title: `T${i}`, files: [`/f${i % 7}`, `/g${i % 3}`], spec: '' })
const g = mergeFileOverlaps(rnd)
let violations = 0
for (let i = 0; i < g.length; i++) for (let k = i + 1; k < g.length; k++) {
  if (g[i].files.some((f) => g[k].files.includes(f))) violations++
}
ok(violations === 0, `40 任务的随机用例：分组间文件交集违规 ${violations} 处（须为 0）`)
ok(g.reduce((n, x) => n + x.ids.length, 0) === 40, '所有任务都被分配到了某一组（身份不丢）')

// ── 6) 源码级：resume 补跑分支必须共用同一个函数 ──
console.log('\n[6] 源码级：两条路径共用实现（防再次绕过）')
const src = readFileSync(new URL('../host/core/pipeline.ts', import.meta.url), 'utf8')
const resumeBranch = (() => {
  const i = src.indexOf('devTaskDefsWithBackfill(journal, tasks, locale)')
  const j = src.indexOf('if (todoDefs.length === 0)', i)
  return i >= 0 && j > i ? src.slice(i, j + 4000) : ''
})()
ok(resumeBranch.length > 0, '定位到 resume 开发分支')
ok(/const todoPlan = planDevWaves\(todoDefs\)/.test(resumeBranch), 'resume 分支调用 planDevWaves(todoDefs)（合并 + 分波都不可绕过）')
ok(/runPool\(todoPlan\.waves\[w\]/.test(resumeBranch), 'resume 分支的 runPool 喂的是波次（而非未合并的原始列表）')
ok(/task\.ids\.some\(\(id\) => s\.taskIds\.includes\(id\)\)/.test(resumeBranch), '失败诊断按本组任一 id 匹配历史 stage（合并组不会找不到上次失败）')
ok(!/s\.taskIds\.includes\(task\.id\)/.test(resumeBranch), '不再残留「按单个 task.id 匹配」的旧写法')
ok((src.match(/planDevWaves\(/g) || []).length === 2, 'planDevWaves 恰好被两条 dev 路径各调用 1 次（多一处=有路径绕过，少一处=漏接）')

// ── 7) 事后并发写检测（第三道防线：前两道被绕过时仍能发现） ──
console.log('\n[7] concurrentWriteConflicts：只看「时间窗相交 + 自报 touched 相交」')
const minutes = (n) => n * 60000
const race = [
  { key: 'T0 工程约束', startedAt: 0, endedAt: minutes(10), files: ['/package.json', '/README.md'] },
  { key: 'T2 host 服务', startedAt: minutes(2), endedAt: minutes(8), files: ['/src/index.ts', '/package.json'] },
  { key: 'T5 client UI', startedAt: minutes(5), endedAt: minutes(20), files: ['/src/client/index.tsx'] },
  { key: 'T9 收口', startedAt: minutes(30), endedAt: minutes(40), files: ['/src/index.ts'] }, // 与 T2 时间不相交
]
const conflicts = concurrentWriteConflicts(race)
ok(conflicts.length === 1, '仅识别出 1 对真并发写冲突（T0 × T2 共享 /package.json）')
ok(conflicts[0].files.join(',') === '/package.json', '冲突文件 = 两者 touched 的交集')
ok(conflicts[0].overlapMs === minutes(6), '重叠时长算对（10 分钟窗口内相交 6 分钟）')
ok(!conflicts.some((c) => c.a === 'T9 收口' || c.b === 'T9 收口'), '时间窗不相交的 T2/T9 **不算**冲突（串行执行不可能抢写）')
ok(concurrentWriteConflicts([{ key: 'a', startedAt: 0, endedAt: 1, files: [] }]).length === 0, '无 touched 的舞台不参与判定（不制造噪音）')

// ── 8) 源码级：写路径必须收敛到有版本守卫的编辑工具 ──
console.log('\n[8] 源码级：禁止 shell 写源码（把写入收敛到宿主 CAS 覆盖范围）')
const promptSrc = readFileSync(new URL('../host/prompts/index.ts', import.meta.url), 'utf8')
const devSection = (() => { const i = promptSrc.indexOf('export const devPrompt'); const j = promptSrc.indexOf('export const qaPrompt'); return promptSrc.slice(i, j) })()
const fixSection = (() => { const i = promptSrc.indexOf('export const qaFixPrompt'); const j = promptSrc.indexOf('export const acceptancePrompt'); return promptSrc.slice(i, j) })()
for (const [label, sec] of [['devPrompt', devSection], ['qaFixPrompt', fixSection]]) {
  ok(/Write path · policy/.test(sec), `${label}：含 [Write path · policy] 条款`)
  ok(/str_replace_editor/.test(sec) && /Never/.test(sec), `${label}：明确只能用编辑工具、禁止 shell 改写`)
  ok(/sed -i/.test(sec) && /writeFileSync/.test(sec), `${label}：点名了具体绕行手段（sed -i / writeFileSync / 重定向）`)
}
// ── 9) 调用方 tasks 路径：files 必须能声明 + 透传清洗 ──
console.log('\n[9] normalizeTasks 透传 files（调用方声明边界的唯一入口）')
const normTasks = normalizeTasks([
  { title: 'T1', spec: 's', files: ['/a.ts', ' /a.ts ', '', null, 42, '/b.ts'] },
  { title: 'T2', spec: 's' },
  '裸字符串任务',
])
ok(normTasks.length === 3, '三类入参都保留（对象 / 无 files / 裸字符串）')
ok(JSON.stringify(normTasks[0].files) === JSON.stringify(['/a.ts', '/b.ts']), 'files 清洗：trim + 去重 + 丢空 + 丢非字符串')
ok(normTasks[1].files.length === 0, '没声明 files → 空数组（下游判定为边界未知 ⇒ 串行）')
ok(normalizeTasks([{ title: 'T', files: Array.from({ length: 40 }, (_, i) => '/f' + i) }])[0].files.length === TASK_FILES_LIMIT, 'files 数量有上限（防御：不许一个任务圈住半仓）')
const idxSrc = readFileSync(new URL('../host/index.ts', import.meta.url), 'utf8')
ok(/files: \{[\s\S]{0,400}?boundary unknown|Omitting `files` means the boundary is unknown/.test(idxSrc), '工具 schema 暴露 files 且写清「未声明 = 边界未知」')
ok(/files: t\.files \|\| \(\[\] as string\[\]\)/.test(pipeSrc), 'pipeline：调用方 tasks 的 files 真正传给了 dev 任务定义（旧实现硬编码 []）')
ok(/reads: Array\.isArray\(t\.reads\)/.test(pipeSrc), 'pipeline：蓝图任务的 reads 透传（存量无该字段 → 空数组 ⇒ 行为不变）')
ok(/READ-ONLY CONTEXT/.test(devSection), 'devPrompt：下发只读上下文段（可看不可改）')

const pipe2 = readFileSync(new URL('../host/core/pipeline.ts', import.meta.url), 'utf8')
ok(/reportDevWriteConflicts\(\)/.test(pipe2), 'pipeline：两条 dev 路径都会在收尾调用 reportDevWriteConflicts')
ok((pipe2.match(/reportDevWriteConflicts\(\)/g) || []).length === 2, '收尾调用恰好 2 处 = 正常路径 + resume 路径（少一处即漏一条执行路径）')
ok(/trackDevTouched\(task\.title, t0, Date\.now\(\), devText\)/.test(pipe2), '正常路径：子代理返回后用真实执行窗口记账 touched')
ok(/trackDevTouched\(task\.title, t0, Date\.now\(\), rerunText\)/.test(pipe2), 'resume 路径：补跑的子代理同样记账（否则整条补跑完全没监控）')
ok(/log\.devWriteConflict/.test(pipe2), '命中冲突 → 落 warn 日志（可观测，不是静默）')
// 2026-09-24 r1b 实锤：resume 分支当时只用了 overlap 文案，三个**无 files** 的任务被合并后却记成"共享文件"
ok(/logDevPlan\(devTaskDefs, devPlan\)/.test(pipe2) && /logDevPlan\(todoDefs, todoPlan\)/.test(pipe2), '两条路径共用同一个留痕函数（区分「没声明 files」与「共享可写文件」——补救方式不同）')
ok(!/log\.devOverlapMerged', \{ n: todoDefs\.length/.test(pipe2), 'resume 分支不再直接用 overlap 文案（会把无边界误报成共享文件）')
// 2026-09-24 r3 实锤：devNoBoundary 的 {n} 传的是总数（5 个任务里只有 1 个没声明 files，却写成"5 个"）
ok(/log\.devNoBoundary', \{ m: missing, n: defs\.length \}/.test(pipe2), 'devNoBoundary 同时给「缺失数 m」与「总数 n」（只给总数会夸大事实）')
ok(/log\.devWaves/.test(pipe2) && /log\.devPlanCycle/.test(pipe2), '分波与环降级都留痕（可观测，不是静默行为）')
ok((pipe2.match(/log\.devDepBlocked/g) || []).length >= 1, '失败传播有日志')

// ── 10) planDevWaves：write∩write 仍合并，依赖边改为排序（AC3），未知写集独占末波 ──
console.log('\n[10] planDevWaves：分波不变量')
const checkWaves = (plan, nTasks, label) => {
  ok(plan.groups.reduce((n2, x) => n2 + x.ids.length, 0) === nTasks, `${label}：所有任务都进了某一组（身份不丢）`)
  // 波间不变量：依赖目标必须出现在更早的波；同波组写集互斥
  let viol = 0
  const waveOf = new Map()
  plan.waves.forEach((w, wi) => w.forEach((g) => waveOf.set(plan.groups.indexOf(g), wi)))
  for (const [gi, wi] of waveOf) {
    for (const a of plan.groups[gi].after) if ((waveOf.get(a) ?? -1) >= wi) viol++
    // 未知写集（files 为空）= 可能写任何文件 ⇒ 必须独占一波（同波有第二个组即违规）
    if (plan.groups[gi].files.length === 0 && plan.waves[wi].length > 1) viol++
    for (const [gj, wj] of waveOf) {
      if (gj === gi || wj !== wi) continue
      if (plan.groups[gi].files.some((f) => plan.groups[gj].files.includes(f))) viol++ // 同波互斥
    }
  }
  ok(viol === 0, `${label}：波次违规 ${viol} 处（依赖必在更早波 + 同波写集互斥，须为 0）`)
}

// 10a) Run 3 的形状回归（精简版）：4 个已知边界 + 1 个未知（提交任务）。
// 注意真实 r3 蓝图里 T2 与 T3 **互相** reads 对方的 owns（真环）⇒ 按声明顺序丢一条边（T3 reads pkg），
// 波次不会是理想的 4+1，而是 1+2+1+1 —— 诚实的结果：未知写集不再拖累已知任务，但 reads 交叉仍会排序。
const r3 = planDevWaves([
  { id: 'dt-1', title: 'T1', files: ['/.gitignore'], reads: ['/package.json'] },
  { id: 'dt-2', title: 'T2', files: ['/package.json', '/README.md'], reads: ['/bin/dupcheck.mjs', '/src/hash.mjs'] },
  { id: 'dt-3', title: 'T3', files: ['/src/hash.mjs', '/bin/dupcheck.mjs'], reads: ['/package.json'] },
  { id: 'dt-4', title: 'T4', files: ['/scripts/verify.mjs'], reads: ['/bin/dupcheck.mjs'] },
  { id: 'dt-5', title: 'T5 提交', files: [], reads: ['/.gitignore'] },
])
ok(r3.waves.length === 4, `Run3 形状：4 波（实际 ${r3.waves.length}）`)
ok(r3.waves.map((w) => w.length).join('+') === '1+2+1+1', `Run3 形状：波次路数 1+2+1+1（实际 ${r3.waves.map((w) => w.length).join('+')}）——T2/T4 并行、未知写集独占末波`)
ok(r3.dropped === 1, `T2↔T3 互相 reads ⇒ 恰好丢 1 条边（实际 ${r3.dropped}）`)
ok(r3.missingBoundary.length === 1 && r3.missingBoundary[0] === 'dt-5', '未声明 files 的任务 id 被记录（日志口径用）')
ok(r3.groups[r3.groups.length - 1].ids.length === 1 && r3.groups[r3.groups.length - 1].files.length === 0, '未知写集组在扁平顺序的末尾')
checkWaves(r3, 5, 'Run3 形状')

// 10b) reads 依赖边：读方必须排在写方之后（AC3）
const depEdge = planDevWaves([
  { id: 'dt-1', title: '写接口', files: ['/types.ts'] },
  { id: 'dt-2', title: '读接口', files: ['/feature.ts'], reads: ['/types.ts'] },
])
ok(depEdge.waves.length === 2 && depEdge.waves[0][0].ids.join(',') === 'dt-1' && depEdge.waves[1][0].ids.join(',') === 'dt-2', 'reads 命中别人 owns ⇒ 读方排到下一波（AC3）')
ok(depEdge.deps.length === 1 && depEdge.deps[0].via === '/types.ts', '依赖边记录了成因文件（排查用）')

// 10c) 两条边交叉时分层正确：A 写 /x，B 写 /y 读 /x，C 写 /z 读 /y ⇒ 3 波
const chainPlan = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/x'] },
  { id: 'dt-2', title: 'B', files: ['/y'], reads: ['/x'] },
  { id: 'dt-3', title: 'C', files: ['/z'], reads: ['/y'] },
])
ok(chainPlan.waves.length === 3, 'A→B→C 读链 ⇒ 3 波（每波 1 组）')
ok(chainPlan.waves.map((w) => w[0].ids[0]).join(',') === 'dt-1,dt-2,dt-3', '链条顺序正确')
checkWaves(chainPlan, 3, '读链')

// 10d) 无依赖（存量蓝图：不声明 reads）⇒ 单波全并行，与合并结果一致
const noDeps = planDevWaves([{ id: 'dt-1', title: 'A', files: ['/a'] }, { id: 'dt-2', title: 'B', files: ['/b'] }])
ok(noDeps.waves.length === 1 && noDeps.waves[0].length === 2 && noDeps.deps.length === 0, '未声明 reads ⇒ 1 波 2 路、零依赖边（安全默认：行为与分波前一致）')

// 10e) dependsOn：按任务 id 与按"对方的 owns 文件"都生效
const byId = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/a'] },
  { id: 'dt-2', title: 'B', files: ['/b'], dependsOn: ['dt-1'] },
])
ok(byId.waves.length === 2 && byId.waves[0][0].ids[0] === 'dt-1', 'dependsOn 按任务 id 生效')
const byFile = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/a'] },
  { id: 'dt-2', title: 'B', files: ['/b'], dependsOn: ['/a'] },
])
ok(byFile.waves.length === 2, 'dependsOn 按对方的 owns 文件生效（模块级蓝图常写文件路径）')

// 10f) 环：互相 reads 对方的 owns ⇒ 不抛错，**按声明顺序丢弃会成环的边**（软依赖），其余照常排序
const cyc = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/a'], reads: ['/b'] },
  { id: 'dt-2', title: 'B', files: ['/b'], reads: ['/a'] },
])
ok(cyc.dropped === 1, `环处理：恰好丢弃 1 条边（实际 ${cyc.dropped}）——不抛错、不全串行`)
ok(cyc.waves.length === 2 && cyc.waves[0][0].ids[0] === 'dt-2' && cyc.waves[1][0].ids[0] === 'dt-1', '保留先声明的边（B→A），A 排到 B 之后')
checkWaves(cyc, 2, '环')

// 10g) write∩write 仍合并（分波不接管这件事）+ merged 计数
const wr = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/s1', '/s2'] },
  { id: 'dt-2', title: 'B', files: ['/s2'] },
  { id: 'dt-3', title: 'C', files: ['/c'] },
])
ok(wr.groups.length === 2 && wr.merged === 1, '写集相交的两个任务仍合并成 1 组（merged=1），第三个任务独立并行')
checkWaves(wr, 3, '写合并')

// 10h) 合并组吸收成员的 reads：dt-1+dt-2 合并后，读它们 owns 的人排在合并组之后
const absorbed = planDevWaves([
  { id: 'dt-1', title: 'A', files: ['/s'] },
  { id: 'dt-2', title: 'B', files: ['/s'] },
  { id: 'dt-3', title: 'C', files: ['/c'], reads: ['/s'] },
])
ok(absorbed.waves.length === 2 && absorbed.waves[1][0].ids.join(',') === 'dt-3', 'reads 指向合并组的任一成员 ⇒ 排在合并组之后（不是排在首个成员之前）')

// 10i) 不变量抽查：随机输入下，波次内两两写集互斥 + 依赖方向不违反 + 身份不丢
console.log('\n[10i] planDevWaves：随机输入不变量')
let wViol = 0
for (let round = 0; round < 30; round++) {
  const rnd2 = []
  for (let i = 0; i < 12; i++) {
    const files = Math.random() < 0.2 ? [] : [`/f${i % 5}`, `/g${Math.floor(Math.random() * 3)}`]
    const reads = Math.random() < 0.5 ? [`/f${Math.floor(Math.random() * 5)}`] : []
    rnd2.push({ id: `dt-${i + 1}`, title: `T${i}`, files, reads, spec: '' })
  }
  const plan = planDevWaves(rnd2)
  if (plan.groups.reduce((n2, x) => n2 + x.ids.length, 0) !== 12) wViol++
  const waveIdx = new Map()
  plan.waves.forEach((w, wi) => w.forEach((g) => waveIdx.set(plan.groups.indexOf(g), wi)))
  for (const [gi, wi] of waveIdx) {
    for (const a of plan.groups[gi].after) if ((waveIdx.get(a) ?? -1) >= wi) wViol++
    for (const [gj, wj] of waveIdx) {
      if (gj === gi || wj !== wi) continue
      if (plan.groups[gi].files.some((f) => plan.groups[gj].files.includes(f))) wViol++
    }
  }
}
ok(wViol === 0, `30 轮随机输入 × 12 任务：波次违规 ${wViol} 处（须为 0）`)

console.log(failed === 0 ? '\n全部通过\n' : `\n失败 ${failed} 项\n`)
process.exit(failed === 0 ? 0 : 1)
