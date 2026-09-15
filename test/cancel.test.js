/**
 * dsh-plugin-teamflow — 中断（cancel）门禁回归测试。
 *
 * 契约（2026-09-16 起，含同日实测暴露的两处修正）：
 * - **只有 `status === 'running'` 的 run 可取消**，其余（completed/failed/interrupted/pending/未知 id）一律 false。
 *   旧实现对任意「内存里存在」的 run 都置 cancelled 并返回 true：对已完成 run 是污染 journal（cancelled:true
 *   而 status 仍 completed），对重启后由 loadJournals() 回填的 interrupted run 是「提示取消成功、状态永不变」。
 *   界面上按钮只在 running 时出现，host 侧也必须同口径拒绝——失败要让调用方看见，不得静默成功。
 * - 取消 = 置 `cancelled` + dispose **全部**在飞子代理 + 只置位不改状态机（终态由 executePipeline 收尾落定：
 *   cancelled + 不提交 + 保留 resume 入口）。**并发 dev 的多路都要停**——旧 `inFlight` 形状（每 run 一个
 *   handle，后启动的覆盖前一个）只停最后一路，用户实测：「开发的多 agent 中断不了」。
 * - **阶段间隙也必须能取消**：`inFlight` 是空的（每路阶段末各自注销），host 侧 IO 期间若以它当门禁，
 *   按钮会在最需要它的时候失效。
 * - dispose 抛错 / dispose 返回 rejected Promise 都不得影响取消结果（cancelled 仍置位、不抛、无未处理拒绝）。
 * - **取消后并发池不得再取新任务**（`util.runPool` 的 `shouldStop`）：否则被 dispose 的任务一返回，
 *   worker 立刻取下一个任务并起新子代理，界面上表现为「中断了又自动启动一个」（同日用户实测）。
 * - wire 面锁定：descriptor `teamflow/cancel` 参数恰为 `[runId]`，host 服务方法与三处 UI 入口都接同一条。
 *
 * 本文件自带 $DSH_HOME 临时目录：cancelRun 会 persistJournal 落盘，绝不能碰真实 home。
 * 这也是 cancelRun / runPool 住在无宿主私有依赖的模块（core/context.ts、util.ts）的原因——pipeline/runner
 * 链到 guard→`@deepseek-ai/dsh-llm`（宿主私有 peer，仓库内未安装），行为级断言取不到它们。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { cancelRun, runs, inFlight, trackInFlight, untrackInFlight } from '../host/core/context.ts'
import { runPool } from '../host/util.ts'
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
const liveStage = { seq: 1 } // 同一 stage 引用（真实代码传的就是 stage 对象；Map 按引用做键）
trackInFlight(live.id, liveStage, { dispose() { disposed += 1 } })
eq(inFlight.get(live.id).size, 1, 'trackInFlight 登记一路（runId → Map<stage, run>）')
eq(cancelRun(live.id), true, 'running → true')
eq(live.cancelled, true, 'cancelled 置位')
eq(disposed, 1, '在飞子代理被 dispose 恰好一次')
eq(live.status, 'running', '只置位不改状态机（终态由 executePipeline 收尾）')
untrackInFlight(live.id, liveStage)
eq(inFlight.has(live.id), false, 'untrackInFlight 注销后空桶自动清掉（map 不膨胀）')
const disk = onDisk(live.id)
ok(!!disk && disk.cancelled === true, `cancelled 已落盘（teamflow/${WS}/runs/${live.id}.json）`)

console.log('── 3) 并发多路：一次全停（用户实测「开发的多 agent 中断不了」的回归锁）──')
const par = put(J('running'))
const hit = []
for (const seqNo of [1, 2, 3, 4, 5]) trackInFlight(par.id, { seq: seqNo }, { id: `child-${seqNo}`, dispose() { hit.push(seqNo) } })
eq(inFlight.get(par.id).size, 5, '5 路并发子代理同时登记（旧形状只会留下最后 1 路）')
eq(cancelRun(par.id), true, 'running → true')
eq(hit.length, 5, '5 路全部被 dispose（不是只停最后一路）')
eq(hit.slice().sort((a, b) => a - b).join(','), '1,2,3,4,5', '每一路各停一次（无重复无遗漏）')

console.log('── 4) 阶段间隙（无在飞子代理）也能取消 ──')
const gap = put(J('running'))
untrackInFlight(gap.id, { seq: 9 })
eq(cancelRun(gap.id), true, 'inFlight 为空 → 仍 true（否则 host 侧 IO 期间按钮失效）')

console.log('── 5) dispose 抛错 / 返回 rejected Promise 都不影响取消 ──')
const bad = put(J('running'))
trackInFlight(bad.id, { seq: 1 }, { dispose() { throw new Error('dispose exploded') } })
trackInFlight(bad.id, { seq: 2 }, { dispose() { return Promise.reject(new Error('dispose rejected')) } })
eq(cancelRun(bad.id), true, 'dispose 抛错 / 拒绝 → 仍 true')
eq(bad.cancelled, true, 'dispose 抛错 → cancelled 仍置位')
untrackInFlight(bad.id, { seq: 1 })
untrackInFlight(bad.id, { seq: 2 })
await sleep(10) // 给 rejected Promise 的 .catch 一个回合；若有未处理拒绝，Node 会在此后报错

console.log('── 5b) 取消来源落盘（主线程据此判断「谁停的」，实测踩过：它误以为是别的会话在自动续跑）──')
{
  const uiRun = put(J('running'))
  eq(cancelRun(uiRun.id, 'ui'), true, '界面来源 → 取消成功')
  eq(uiRun.cancelSource, 'ui', 'journal.cancelSource = ui')
  ok(!!uiRun.cancelRequestedAt, 'journal.cancelRequestedAt 已记录')
  ok((uiRun.logs || []).some((l) => /中断请求/.test(String(l.message))), 'journal.logs 留一条「收到中断请求（来源：…）」')
  ok(!!onDisk(uiRun.id) && onDisk(uiRun.id).cancelSource === 'ui', 'cancelSource 随 journal 落盘（serializeJournal 覆盖）')

  const toolRun = put(J('running'))
  eq(cancelRun(toolRun.id, 'tool'), true, '模型工具来源 → 取消成功')
  eq(toolRun.cancelSource, 'tool', 'journal.cancelSource = tool')

  const legacy = put(J('running'))
  eq(cancelRun(legacy.id), true, '缺省来源 → 取消成功')
  eq(legacy.cancelSource, 'unknown', '缺省来源记 unknown（历史调用方）')
}

console.log('── 6) 取消后并发池不再取新任务（「中断了又自动启动一个」的回归锁）──')
{
  const started = []
  let cancelled = false
  const items = [1, 2, 3, 4, 5, 6]
  const out = await runPool(items, 2, async (n) => {
    started.push(n)
    if (started.length >= 2) cancelled = true // 模拟「两路都在跑时用户按了中断 → journal.cancelled」
    await sleep(1)
    return n * 10
  }, () => cancelled)
  eq(started.length, 2, `取消后不再取新任务（启动 ${started.join(',')}，共 2 个；旧实现会把 6 个全跑完）`)
  eq(out[0], 10, '已启动任务的结果照常回填')
  eq(out[3], undefined, '未启动的条目结果为 undefined（调用方须容忍空位；pipeline 已按 r && 过滤）')

  const allOut = await runPool([1, 2, 3], 2, async (n) => n, null)
  eq(allOut.join(','), '1,2,3', 'shouldStop 省略（null）时行为不变（同序全量结果）')
  const stopOut = await runPool([1, 2, 3], 2, async (n) => n, () => true)
  eq(stopOut.every((x) => x === undefined), true, '一开始就 shouldStop → 一个都不启动（结果全空位）')
}

console.log('── 7) wire 面：descriptor + host 方法 + 三处 UI 入口同源 ──')
const here = dirname(fileURLToPath(import.meta.url))
const descriptorSrc = readFileSync(join(here, '../descriptors.ts'), 'utf8')
const hostSrc = readFileSync(join(here, '../host/index.ts'), 'utf8')
const indexSrc = readFileSync(join(here, '../client/index.tsx'), 'utf8')
const panelSrc = readFileSync(join(here, '../client/panel.tsx'), 'utf8')
const pipelineSrc = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
const reportSrc = readFileSync(join(here, '../host/core/report.ts'), 'utf8')
const block = /id: 'dsh-plugin-teamflow#teamflow\/cancel',[\s\S]*?\n  \}/.exec(descriptorSrc)
ok(!!block, 'descriptors.ts 声明 teamflow/cancel')
ok(!!block && /method: 'cancel'/.test(block[0]), "wire method = 'cancel'")
ok(!!block && /parameters: \[p\('runId'\)\]/.test(block[0]), '参数恰为 [runId]（按钮只传这一个，无会话参数）')
ok(/cancel\(runId\) \{/.test(hostSrc) && /return \{ ok: cancelRun\(id, 'ui'\) \}/.test(hostSrc), "host 服务方法 cancel(runId) → cancelRun(id, 'ui')（界面=人工来源）")
ok(/cancelRun\(id, 'tool'\)/.test(hostSrc), "模型工具传 source='tool'（与界面来源可辨：主线程据此知道「是人停的」）")
ok(/'report\.cancelSource'/.test(reportSrc) && /'report\.nextCancelled'/.test(reportSrc) && /cancelSource\.\$\{journal\.cancelSource \|\| 'unknown'\}/.test(reportSrc), 'report：取消汇报带中断来源 + 取消态换「不会自动续跑」措辞（不给模型续跑引导）')
ok(/teamflow_cancel/.test(hostSrc), '模型工具 teamflow_cancel 仍共用同一条路径')
ok(/api\.cancel\(id\)/.test(indexSrc), '会话内工作台有 cancel 调用点')
ok(/remote\.cancel\(runId\)/.test(panelSrc), '全局面板/右栏经 productApi.cancel 调同一条 wire 面')
ok((panelSrc.match(/h\(CancelButton/g) || []).length >= 2, '面板两处入口（run 行 + 详情头）用共享 CancelButton')
ok(/h\(CancelButton/.test(indexSrc), '工作台顶栏复用同一个 CancelButton（两段式确认只有一份实现）')
ok(/cancelSentFor/.test(indexSrc), '工作台发出中断请求后先隐藏按钮，等轮询刷新状态（不重复提示「未生效」）')
ok((pipelineSrc.match(/, \(\) => journal\.cancelled\)/g) || []).length >= 2, '两处并发池（dev + resume 补跑）都接了 shouldStop = () => journal.cancelled')

try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* ignore */ }
console.log(failed === 0 ? '\n✅ cancel 门禁测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
