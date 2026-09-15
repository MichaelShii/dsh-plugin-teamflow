/**
 * dsh-plugin-teamflow — 中断（cancel）门禁回归测试。
 *
 * 契约（2026-09-16，加「界面中断按钮」时定）：
 * - **只有 `status === 'running'` 的 run 可取消**，其余（completed/failed/interrupted/pending/未知 id）一律 false。
 *   旧实现对任意「内存里存在」的 run 都置 cancelled 并返回 true：对已完成 run 是污染 journal（cancelled:true
 *   而 status 仍 completed），对重启后由 loadJournals() 回填的 interrupted run 是「提示取消成功、状态永不变」。
 *   界面上按钮只在 running 时出现，host 侧也必须同口径拒绝——失败要让调用方看见，不得静默成功。
 * - 取消 = 置 `cancelled` + dispose `inFlight` 里的在飞子代理，且**只置位不改状态机**（终态由 executePipeline
 *   的收尾落定：cancelled + 不提交 + 保留 resume 入口）。
 * - **阶段间隙也必须能取消**：`inFlight` 只记最后启动的那个 run（runner 每阶段覆盖/阶段末删除），host 侧
 *   IO 期间它是空的——若以此为门禁，按钮会在最需要它的时候失效。
 * - dispose 抛错不得吞掉取消（仍返回 true 且 cancelled 落盘）。
 * - wire 面锁定：descriptor `teamflow/cancel` 参数恰为 `[runId]`，host 服务方法与三处 UI 入口都接同一条。
 *
 * 本文件自带 $DSH_HOME 临时目录：cancelRun 会 persistJournal 落盘，绝不能碰真实 home。
 * 这也是 cancelRun 住在 core/context.ts（而非 pipeline.ts）的原因——pipeline 链到 report→
 * `@deepseek-ai/dsh-llm`（宿主私有 peer，仓库内未安装），行为级断言取不到它。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cancelRun } from '../host/core/context.ts'
import { runs, inFlight } from '../host/core/context.ts'
import { readJsonAny } from '../store.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eq = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

const home = mkdtempSync(join(tmpdir(), 'tf-cancel-'))
process.env.DSH_HOME = home
const WS = 'ws-cancel-test'
let seq = 0
/** 最小 journal（只带取消路径用到的字段；serializeJournal 对缺省字段全部容错）。 */
const J = (status, extra = {}) => ({
  id: `tf-cancel-${++seq}`, name: 'teamflow-pipeline', status, workspace: WS,
  requirement: 'x', logs: [], stages: [], cancelled: false, humanIntervention: false, ...extra,
})
const put = (j) => { runs.set(j.id, j); return j }
const onDisk = (id) => readJsonAny(join(home, 'teamflow', WS, 'runs', `${id}.json`), null)

console.log('── 1) 门禁：只有 running 可取消 ──')
for (const st of ['completed', 'failed', 'interrupted', 'pending', undefined]) {
  const j = put(J(st))
  eq(cancelRun(j.id), false, `status=${String(st)} → false`)
  eq(j.cancelled, false, `status=${String(st)} → cancelled 保持 false（不污染已完成 journal）`)
}
eq(cancelRun('tf-does-not-exist'), false, '未知 runId → false')
eq(cancelRun(null), false, 'null → false')
eq(cancelRun(undefined), false, 'undefined → false')

console.log('── 2) running：置位 + dispose 在飞子代理 + 落盘 ──')
const live = put(J('running'))
let disposed = 0
inFlight.set(live.id, { run: { dispose() { disposed += 1 } }, stage: { seq: 1 } })
eq(cancelRun(live.id), true, 'running → true')
eq(live.cancelled, true, 'cancelled 置位')
eq(disposed, 1, 'inFlight 里的子代理被 dispose 恰好一次')
eq(live.status, 'running', '只置位不改状态机（终态由 executePipeline 收尾）')
inFlight.delete(live.id)
const disk = onDisk(live.id)
ok(!!disk && disk.cancelled === true, `cancelled 已落盘（teamflow/${WS}/runs/${live.id}.json）`)

console.log('── 3) 阶段间隙（无在飞子代理）也能取消 ──')
const gap = put(J('running'))
inFlight.delete(gap.id)
eq(cancelRun(gap.id), true, 'inFlight 为空 → 仍 true（否则 host 侧 IO 期间按钮失效）')

console.log('── 4) dispose 抛错不吞掉取消 ──')
const bad = put(J('running'))
inFlight.set(bad.id, { run: { dispose() { throw new Error('dispose exploded') } }, stage: {} })
eq(cancelRun(bad.id), true, 'dispose 抛错 → 仍 true')
eq(bad.cancelled, true, 'dispose 抛错 → cancelled 仍置位（先置位后 dispose 的顺序保证）')
inFlight.delete(bad.id)

console.log('── 5) wire 面：descriptor + host 方法 + 三处 UI 入口同源 ──')
const here = dirname(fileURLToPath(import.meta.url))
const descriptorSrc = readFileSync(join(here, '../descriptors.ts'), 'utf8')
const hostSrc = readFileSync(join(here, '../host/index.ts'), 'utf8')
const indexSrc = readFileSync(join(here, '../client/index.tsx'), 'utf8')
const panelSrc = readFileSync(join(here, '../client/panel.tsx'), 'utf8')
const block = /id: 'dsh-plugin-teamflow#teamflow\/cancel',[\s\S]*?\n  \}/.exec(descriptorSrc)
ok(!!block, 'descriptors.ts 声明 teamflow/cancel')
ok(!!block && /method: 'cancel'/.test(block[0]), "wire method = 'cancel'")
ok(!!block && /parameters: \[p\('runId'\)\]/.test(block[0]), '参数恰为 [runId]（按钮只传这一个，无会话参数）')
ok(/cancel\(runId\) \{/.test(hostSrc) && /return \{ ok: cancelRun\(id\) \}/.test(hostSrc), 'host 服务方法 cancel(runId) → cancelRun')
ok(/teamflow_cancel/.test(hostSrc), '模型工具 teamflow_cancel 仍共用同一条路径')
ok(/api\.cancel\(id\)/.test(indexSrc), '会话内工作台有 cancel 调用点')
ok(/remote\.cancel\(runId\)/.test(panelSrc), '全局面板/右栏经 productApi.cancel 调同一条 wire 面')
ok((panelSrc.match(/h\(CancelButton/g) || []).length >= 2, '面板两处入口（run 行 + 详情头）用共享 CancelButton')
ok(/h\(CancelButton/.test(indexSrc), '工作台顶栏复用同一个 CancelButton（两段式确认只有一份实现）')
ok(/cancelSentFor/.test(indexSrc), '工作台发出中断请求后先隐藏按钮，等轮询刷新状态（不重复提示「未生效」）')

try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* ignore */ }
console.log(failed === 0 ? '\n✅ cancel 门禁测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
