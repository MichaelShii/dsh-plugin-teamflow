/**
 * dsh-plugin-teamflow — 产品线装配（全局面板数据面）测试。
 *
 * 全局面板（侧边栏图标 + root `main` 面板）没有会话上下文，宿主改由「产品线 key」
 * 装配数据：本测试覆盖 core/products.ts 的纯装配逻辑 + 两个空态：
 *   1) runAddress：host 生成的右栏 tab 地址（编码 + 形状）
 *   2) productKeyOf：产品线 key 白名单（拒绝盘符/穿越/空白）
 *   3) runsFor：按产品线过滤 + 按 startedAt 倒序
 *   4) runBrief：run 摘要形状（阶段进度 + 官方口径 usage 汇总 + 地址）
 *   5) listProducts：$DSH_HOME/teamflow 扫描（state.json 标题 / workspacePath 兜底标题 /
 *      排序 / 跳过 runs 与无 backlog 无 runs 的目录）+ 空态
 *   6) productMetaOf：无 state.json 时从最近 run 的 workspacePath 取标题
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runs } from '../host/core/context.ts'
import {
  runsFor, runAddress, productKeyOf, runVisibleIn, runUsageSum, runBrief, productMetaOf, listProducts,
} from '../host/core/products.ts'
import { teamflowRoot } from '../store.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

const home = mkdtempSync(join(tmpdir(), 'tf-products-'))
process.env.DSH_HOME = home

console.log('── 1) runAddress（host 生成右栏 tab 地址）──')
ok(runAddress('ws-tetris-3f9a2c7b', 'tf-abc') === 'dsh-resource://teamflow/run/ws-tetris-3f9a2c7b/tf-abc', '产品线 + runId 组成地址')
ok(runAddress(null, 'tf-abc') === 'dsh-resource://teamflow/run/default/tf-abc', '缺产品线 → default 兜底')
ok(runAddress('a/b', 'x y') === 'dsh-resource://teamflow/run/a%2Fb/x%20y', '路径分隔/空格被编码（地址段安全）')

console.log('── 2) productKeyOf（白名单，防穿越 $DSH_HOME）──')
ok(productKeyOf('ws-tetris-3f9a2c7b') === 'ws-tetris-3f9a2c7b', '合法 key 原样通过')
ok(productKeyOf('a/b_c-1') === 'a/b_c-1', '合法多段通过')
for (const bad of ['..', '../../etc', 'C:\\x', '/abs', '', '  ', 'a b', 'x//y', null, 42]) {
  ok(productKeyOf(bad) === null, `非法输入被拒：${JSON.stringify(bad)}`)
}

console.log('── 3) runsFor / runVisibleIn ──')
const mkRun = (id, ws, startedAt, extra = {}) => ({
  id, workspace: ws, status: 'completed', requirement: `需求 ${id}`, startedAt, endedAt: startedAt + 1000,
  agentsStarted: 1, options: { mode: 'lite' }, stages: [], logs: [], ...extra,
})
runs.clear()
runs.set('r-old', mkRun('r-old', 'ws-a', 1000))
runs.set('r-new', mkRun('r-new', 'ws-a', 3000))
runs.set('r-other', mkRun('r-other', 'ws-b', 2000))
runs.set('r-legacy', mkRun('r-legacy', null, 500))
const wsA = runsFor('ws-a')
ok(wsA.length === 2 && wsA[0].id === 'r-new' && wsA[1].id === 'r-old', '按产品线过滤 + startedAt 倒序')
ok(runsFor('ws-c').length === 0, '无 run 的产品线 → 空数组（空态）')
ok(runsFor('default').some((j) => j.id === 'r-legacy'), 'default 兜底可见无 workspace 的旧 run')
ok(runsFor(null).length === 4, '未指定产品线 → 全部')

console.log('── 4) runBrief（run 摘要形状）──')
const rich = mkRun('r-rich', 'ws-a', 4000, {
  stages: [
    { seq: 1, status: 'done', usage: { input: 100, cacheRead: 900, cacheWrite: 0, output: 50, calls: 2 } },
    { seq: 2, status: 'running', usage: { input: 10, cacheRead: 0, cacheWrite: 5, output: 7, calls: 1 } },
  ],
})
const brief = runBrief(rich)
ok(brief.id === 'r-rich' && brief.mode === 'lite', 'id/mode 透出')
ok(brief.stageCount === 2 && brief.doneStages === 1 && brief.incompleteStages === true, '阶段进度（total/done/incomplete）')
ok(brief.usage.input === 110 && brief.usage.cacheRead === 900 && brief.usage.cacheWrite === 5 && brief.usage.output === 57 && brief.usage.calls === 3, '官方口径 usage 汇总（逐 stage 累加）')
ok(brief.address === 'dsh-resource://teamflow/run/ws-a/r-rich', 'run 摘要自带右栏地址')
ok(brief.ownerSession === null && runBrief(mkRun('r-own', 'ws-a', 1, { ownerSession: 'session-abc' })).ownerSession === 'session-abc', 'run 摘要携带 ownerSession（全局面板据此跳发起会话；缺省 null 不伪造）')
ok(runUsageSum(mkRun('r-none', 'ws-a', 1)).calls === 0, '无 usage 的 run → 全 0（不虚报）')
ok(runVisibleIn(mkRun('x', 'ws-a', 1), 'ws-a') === true && runVisibleIn(mkRun('x', 'ws-b', 1), 'ws-a') === false, '跨产品线不可见')

console.log('── 5) listProducts（$DSH_HOME 扫描 + 空态）──')
const root = teamflowRoot()
mkdirSync(join(root, 'ws-empty'), { recursive: true })            // 无 backlog 也无 runs → 跳过
mkdirSync(join(root, 'runs'), { recursive: true })                // 全局 runs 目录 → 跳过
mkdirSync(join(root, 'ws-alpha', 'backlog'), { recursive: true })
mkdirSync(join(root, 'ws-alpha', 'runs'), { recursive: true })
mkdirSync(join(root, 'ws-beta', 'backlog'), { recursive: true })
writeFileSync(join(root, 'ws-alpha', 'state.json'), JSON.stringify({
  version: 1, projectName: '俄罗斯方块', updatedAt: 9000, lastRun: { requirement: '加一个消行动画', verdict: 'accepted' },
}))
writeFileSync(join(root, 'active-teams.json'), '{}')              // 根下普通文件 → 跳过
runs.clear()
runs.set('r-a', mkRun('r-a', 'ws-alpha', 7000))
runs.set('r-b', mkRun('r-b', 'ws-alpha', 8000, { status: 'running' }))
runs.set('r-c', mkRun('r-c', 'ws-beta', 6000, { workspacePath: 'C:\\Code\\OpenSource\\DSH-Plugin\\plugins\\tetris' }))

const before = listProducts()
ok(before.length === 2, `只收录带 backlog/runs 的产品线（得到 ${before.length} 条）`)
ok(before[0].key === 'ws-alpha', '按 updatedAt 倒序（state.json 9000 在前）')
ok(before[0].title === '俄罗斯方块' && before[0].totalRuns === 2 && before[0].activeRuns === 1, 'state.json 标题 + run 计数（含活跃）')
ok(before[0].lastRequirement === '加一个消行动画' && before[0].lastVerdict === 'accepted', '最近需求/结论来自 state.json')
ok(before[1].key === 'ws-beta' && before[1].title === 'tetris', '无 state.json → 标题取最近 run 的 workspacePath basename')
ok(before[1].path === 'C:\\Code\\OpenSource\\DSH-Plugin\\plugins\\tetris', 'workspacePath 透出（面板可显示磁盘位置）')

runs.clear()
const emptyMeta = productMetaOf('ws-none')
ok(emptyMeta.title === 'ws-none' && emptyMeta.totalRuns === 0 && emptyMeta.updatedAt === null, '不存在的产品线 → 空态元信息（标题回落 key）')

const homeSnapshot = home
rmSync(root, { recursive: true, force: true })
ok(listProducts().length === 0, '产品线根不存在 → 空数组（空态，不抛错）')
ok(homeSnapshot === process.env.DSH_HOME, 'DSH_HOME 未被改写')
rmSync(home, { recursive: true, force: true })

if (failed) { console.error(`\n❌ product-scope 有 ${failed} 条失败`); process.exit(1) }
console.log('\n✅ product-scope 全部通过')
