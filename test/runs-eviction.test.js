/**
 * dsh-plugin-teamflow — 内存 run 注册表有界化（淘汰决策 + 磁盘回读）回归测试。
 *
 * 契约（2026-09-26 起）：
 * - `runs` 只 set 不 delete（旧实现，全仓 grep 实锤）+ 启动 loadJournals 全量灌入 → 常驻宿主跨工作区
 *   单调增长。磁盘（persistJournal）是权威，内存降级为「最近 N 条终态 + 全部活跃」的有界缓存。
 * - 淘汰只针对**终态且已落 endedAt** 的 run；running（cancelRun 门禁只认它）与活跃引用
 *   （inFlight 的 key / activeProducts 的值）一律保护。
 * - 决策（evictableRunIds）与执行（pruneRuns）分离：决策纯函数可锁真值表；执行只在终态
 *   checkpoint 落盘**之后**触发（pipeline 收尾），磁盘确认写完才允许内存放手。
 * - `getRun`：内存未命中 → 磁盘回读（loadJournalById 双路径），**不回填** runs——回填会让
 *   「浏览历史 run」重新撑大内存；resume 需要驻留时自己显式 runs.set（pipeline.ts 原有行为）。
 * - `loadJournalById`：per-project runs/ 优先、全局 runs/ 兜底（与 persistJournal 写路径一一对应），
 *   runId 走 `^[A-Za-z0-9-]+$` 白名单（journal.id 形如 tf-xxx-xxx）防路径拼接注入。
 *
 * 本文件自带 $DSH_HOME 临时目录，绝不碰真实 home。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const home = mkdtempSync(join(tmpdir(), 'tf-evict-'))
process.env.DSH_HOME = home

const { runs, inFlight, activeProducts, evictableRunIds, pruneRuns, getRun } = await import('../host/core/context.ts')
const { persistJournal, loadJournalById } = await import('../store.ts')

let failed = 0
const eq = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

let seq = 0
/** 最小终态 journal（endedAt 可指定，决定「最近」排序）。 */
const J = (endedAt, extra = {}) => ({
  id: `tf-evict-${String(++seq).padStart(3, '0')}`, name: 'teamflow-pipeline', status: 'completed',
  workspace: 'ws-evict-test', requirement: 'x', logs: [], stages: [], endedAt, ...extra,
})
const put = (j) => { runs.set(j.id, j); return j }
const clear = () => { runs.clear(); inFlight.clear(); activeProducts.clear() }

console.log('── 1) 淘汰决策：只有「终态 + 已落 endedAt」可淘汰 ──')
clear()
put(J(100, { status: 'running', endedAt: null }))
put(J(200, { status: 'pending', endedAt: null }))
put(J(300, { endedAt: null })) // completed 但未落终态时间
eq(evictableRunIds(10).length, 0, 'running / pending / 未落 endedAt 一律不可淘汰')

console.log('── 2) 淘汰决策：活跃引用保护（受保护 run 占排序位但不淘汰） ──')
clear()
const lockA = put(J(400)) // inFlight 保护（最新）
put(J(300))
put(J(250))
const lockB = put(J(200)) // activeProducts 保护（已越过 keep 线）
put(J(100))
inFlight.set(lockA.id, new Map())
activeProducts.set('ws-a', lockB.id)
eq(evictableRunIds(2).length, 2, 'keep=2 → 线外共 3 条，保护豁免 1 条 → 淘 2 条')
eq(evictableRunIds(2).includes(lockA.id), false, 'inFlight 在飞的 run 不淘汰')
eq(evictableRunIds(2).includes(lockB.id), false, 'activeProducts 锁定的 run 越过 keep 线也不淘汰')

console.log('── 3) 淘汰决策：keep 边界（endedAt 降序保最近） ──')
clear()
const oldest = put(J(100))
put(J(300))
put(J(200))
eq(evictableRunIds(3).length, 0, '恰好 keep=3 → 无淘汰')
eq(evictableRunIds(2).length, 1, 'keep=2 → 淘 1 条')
eq(evictableRunIds(2)[0], oldest.id, '淘的是最旧（endedAt=100）')
eq(evictableRunIds(1).length, 2, 'keep=1 → 淘 2 条')
eq(evictableRunIds(0).length, 0, 'keep=0（非法）→ 决策空集（防御，不清空）')
eq(evictableRunIds(-1).length, 0, 'keep<0（非法）→ 决策空集')

console.log('── 4) 执行：pruneRuns 只删可淘汰项并返回计数 ──')
clear()
const keepMe = put(J(300))
const evictMe = put(J(100))
inFlight.set(keepMe.id, new Map())
eq(pruneRuns(1), 1, 'keep=1：受保护的新 run 占最新槽位，更旧的终态 run 被淘汰')
eq(runs.has(keepMe.id), true, '被引用的保留')
eq(runs.has(evictMe.id), false, '可淘汰的已从内存删除')
clear()

console.log('── 5) loadJournalById：双路径 + 注入防御 ──')
const pj = J(100, { id: 'tf-disk-001' })
persistJournal(pj) // workspace != default → 写 per-project runs/
eq(!!loadJournalById('tf-disk-001'), true, 'per-project runs/ 的 journal 可按 id 读回')
eq(loadJournalById('tf-disk-001').id, 'tf-disk-001', '读回内容 id 一致')
const gj = J(200, { id: 'tf-disk-002', workspace: 'default' })
persistJournal(gj) // default → 全局 runs/
eq(!!loadJournalById('tf-disk-002'), true, '全局 runs/ 的 journal 可按 id 读回（兜底路径）')
mkdirSync(join(home, 'teamflow', 'ws-evil', 'runs'), { recursive: true })
writeFileSync(join(home, 'teamflow', 'ws-evil', 'runs', 'tf-disk-003.json'), JSON.stringify({ id: 'tf-disk-003' }))
eq(loadJournalById('tf-disk-003').id, 'tf-disk-003', '跨工作区也能命中（内存淘汰后不依赖启动回填）')
eq(loadJournalById(''), null, '空 id → null')
eq(loadJournalById('tf-../escape'), null, '带路径分隔/穿越的 id → 白名单拒绝')
eq(loadJournalById('tf-disk-nope'), null, '不存在的 id → null')

console.log('── 6) getRun：内存优先 → 磁盘回读不回填 ──')
clear()
put(J(100, { id: 'tf-get-001' }))
eq(getRun('tf-get-001').id, 'tf-get-001', '内存命中直接返回')
persistJournal(J(100, { id: 'tf-get-002' }))
const fromDisk = getRun('tf-get-002')
eq(!!fromDisk, true, '内存未命中 → 磁盘回读成功')
eq(runs.has('tf-get-002'), false, '磁盘回读**不回填** runs（有界性不破产）')
eq(getRun('tf-get-nope'), null, '两边都没有 → null')
eq(getRun(undefined), null, '非字符串入参 → null')

console.log('── 7) 端到端：淘汰后 getRun 仍能读回（快照/详情的兜底路径） ──')
clear()
const oldRun = put(J(100, { id: 'tf-e2e-001' }))
persistJournal(oldRun)
put(J(999))
put(J(998))
eq(pruneRuns(2), 1, 'keep=2 → 最旧被淘汰')
eq(runs.has('tf-e2e-001'), false, '最旧 run 已离开内存')
eq(getRun('tf-e2e-001').endedAt, 100, '淘汰后经磁盘回读仍完整可见（面板/详情不断档）')

const cleanup = () => { try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (e) => { cleanup(); throw e })

if (failed > 0) { console.error(`\n❌ ${failed} 项失败`); process.exit(1) }
console.log('\n✅ runs-eviction 全部通过')
