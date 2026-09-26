/**
 * dsh-plugin-teamflow — token 计量（accumulateSessionUsage）行为测试。
 * 背景（2026-09-07 实锤 r38 usage 全空）：宿主新版 Session（session v2）已无 `events` 属性/getter，
 * 旧实现读 session.events = undefined → accumulateSessionUsage 返回 null → stage usage 全 null →
 * backlog 任务卡与流水线图卡详情无「TOKEN · 官方口径」（task-37 有、task-38 无）。
 * 修复：多源回退（events → snapshotEvents() → ownEvents()）+ 双路径取 usage（data.usage 优先，
 * 缺失时扫 data.stream 的 usage chunk，宿主 usageOf 同款）。
 * 2026-09-10 增补（dsh 0.1.5-rc.2 同步事件读取器弃用）：来源优先级改为
 * **官方 Session 投影优先**（tokenUsage 四桶 + sessionStats.steps 调用数），事件扫描降级为
 * 无投影宿主的回退——本文件同时冻结两条路径与回退触发条件。
 */
import { accumulateSessionUsage, totalTokensOf, cacheHitRatioOf, effectiveFreshBudget } from '../host/core/metering.ts'
import { runtime } from '../host/core/context.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eqJson = (actual, expected, msg) => ok(JSON.stringify(actual) === JSON.stringify(expected), `${msg}（got ${JSON.stringify(actual)}）`)

/** 构造 assistant/message 事件：usage 可放 data.usage 或 stream chunk（宿主双路径）。 */
function ev(step, { dataUsage, streamUsage }) {
  const d = { turn: 1, step }
  if (dataUsage) d.usage = dataUsage
  const stream = streamUsage ? [{ chunk: { type: 'usage', usage: streamUsage } }] : []
  if (stream.length) d.stream = stream
  return { type: 'assistant/message', data: d }
}

/** 官方 Session 投影注册表桩：stateOf(session, key) 按 key 返回；throwOn 模拟投影读取异常。 */
function projectionsStub({ usage, stats, throwOn }) {
  return {
    stateOf: (session, key) => {
      if (throwOn === key) throw new Error(`projection boom: ${key}`)
      if (key === 'tokenUsage') return usage
      if (key === 'sessionStats') return stats
      return undefined
    },
  }
}

console.log('── 1) 宿主新版 v2：无 events 属性，仅 snapshotEvents()，usage 在 data.usage ──')
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [ev(1, { dataUsage: { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 30 } }), ev(2, { dataUsage: { inputTokens: 50, outputTokens: 10 } })] } } }),
  { input: 150, cacheRead: 900, cacheWrite: 50, output: 40, calls: 2 },
  'snapshotEvents + data.usage → 正常累计（r38 失明场景回归核心）')

console.log('── 2) 宿主新版 v2：usage 只在 stream chunk（data.usage 缺失）──')
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [ev(1, { streamUsage: { inputTokens: 200, outputTokens: 40 } }), ev(2, { streamUsage: { inputTokens: 60, cacheReadTokens: 300, outputTokens: 15 } })] } } }),
  { input: 260, cacheRead: 300, cacheWrite: 0, output: 55, calls: 2 },
  'usage 藏 stream chunk 也能取到（宿主 usageOf 双路径）')

console.log('── 3) fork 子代理：ownEvents() 才有本 agent 事件（snapshotEvents 空）──')
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [], ownEvents: () => [ev(1, { dataUsage: { inputTokens: 80, outputTokens: 20 } })] } } }),
  { input: 80, cacheRead: 0, cacheWrite: 0, output: 20, calls: 1 },
  'ownEvents 回退可用')

console.log('── 4) 老宿主兼容：events 为数组 ──')
eqJson(
  accumulateSessionUsage({ localAgent: { session: { events: [ev(1, { dataUsage: { inputTokens: 10, outputTokens: 5 } })] } } }),
  { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, calls: 1 },
  '老宿主 events 数组兼容（r37 正常路径不回归）')

console.log('── 5) 边界：无事件源 / 无 usage → null ──')
ok(accumulateSessionUsage({ localAgent: { session: {} } }) === null, 'session 无任何事件源 → null（不虚报 0）')
ok(accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [{ type: 'user/message', data: {} }] } } }) === null, '有事件但无 assistant/message usage → null')
ok(accumulateSessionUsage(null) === null, 'null run → null')
ok(accumulateSessionUsage({ localAgent: undefined }) === null, 'localAgent 缺失（remote 子代理）→ null')
ok(totalTokensOf({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4, calls: 1 }) === 10, 'totalTokensOf 官方总消耗口径')

console.log('── 6) 投影路径优先（官方 Session 投影取代历史事件扫描，dsh 0.1.5-rc.2）──')
// 同一份会话故意给出与投影冲突的事件读数：投影可用时事件扫描必须完全不参与
const conflictingSession = { snapshotEvents: () => [ev(1, { dataUsage: { inputTokens: 999, outputTokens: 999 } })], ownEvents: () => [] }
runtime.sessionProjections = projectionsStub({
  usage: { totals: { uncachedInputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50, outputTokens: 30 } },
  stats: { steps: 4 },
})
eqJson(
  accumulateSessionUsage({ localAgent: { session: conflictingSession } }),
  { input: 100, cacheRead: 900, cacheWrite: 50, output: 30, calls: 4 },
  'tokenUsage 四桶 + sessionStats.steps → 以官方投影为准（事件扫描数字被忽略）')

console.log('── 7) 投影缺 sessionStats → 调用数兜底 1（四桶仍取投影）──')
runtime.sessionProjections = projectionsStub({
  usage: { totals: { uncachedInputTokens: 10, outputTokens: 5 } },
  stats: undefined,
})
eqJson(
  accumulateSessionUsage({ localAgent: { session: conflictingSession } }),
  { input: 10, cacheRead: 0, cacheWrite: 0, output: 5, calls: 1 },
  'sessionStats 未注册 → calls=1（不虚报 0，也不退回扫描）')

console.log('── 8) 投影在但无 provider usage（四桶全 0）→ 回退事件扫描 ──')
runtime.sessionProjections = projectionsStub({ usage: { totals: { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 } }, stats: { steps: 9 } })
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [ev(1, { dataUsage: { inputTokens: 70, outputTokens: 7 } })] } } }),
  { input: 70, cacheRead: 0, cacheWrite: 0, output: 7, calls: 1 },
  '投影无数据 → 事件扫描兜底（不虚报 0）')

console.log('── 9) 投影读取抛错 / 未注册 → 回退事件扫描（不冒泡中断流水线）──')
runtime.sessionProjections = projectionsStub({ usage: { totals: { outputTokens: 1 } }, throwOn: 'tokenUsage' })
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [ev(1, { dataUsage: { inputTokens: 11, outputTokens: 2 } })] } } }),
  { input: 11, cacheRead: 0, cacheWrite: 0, output: 2, calls: 1 },
  'stateOf 抛错 → 静默回退事件扫描')
runtime.sessionProjections = undefined
eqJson(
  accumulateSessionUsage({ localAgent: { session: { snapshotEvents: () => [ev(1, { dataUsage: { inputTokens: 12, outputTokens: 3 } })] } } }),
  { input: 12, cacheRead: 0, cacheWrite: 0, output: 3, calls: 1 },
  '投影服务未挂载（最小 profile）→ 事件扫描照常工作')

console.log('\n── 熔断预算的缓存能力自适应（2026-09-18 probe-v2 实锤：inception/mercury-2.5 命中率 10.4%、')
console.log('   17 次调用 259k → 熔断；同阶段在命中 90%+ 的 provider 上 17 次调用只需 25–40k）──')
{
  const BASE = 200000
  // 无缓存：本次实锤的用量形状（input 256.7k / cacheRead 29.7k / calls 17）
  const uncached = effectiveFreshBudget({ input: 256671, cacheRead: 29717, cacheWrite: 0, output: 2146, calls: 17 }, BASE)
  ok(uncached.uncached === true && uncached.budget === BASE * 3, '无缓存（10.4%、17 次调用）→ 预算放宽 3 倍（200k → 600k）')
  ok(Math.round(uncached.ratio * 100) === 10, '判据留痕：命中率 10%（供熔断日志写依据）')
  // 有缓存：历史常态（命中 98.9%）
  const cached = effectiveFreshBudget({ input: 3000, cacheRead: 280000, cacheWrite: 0, output: 12000, calls: 115 }, BASE)
  ok(cached.uncached === false && cached.budget === BASE, '有缓存（98.9%）→ 预算分毫不动（不放大 token）')
  ok(Math.round(cached.ratio * 100) === 99, '有缓存命中率计算正确')
  // 边界：调用太少不下结论（单次调用的"没命中"没有信息量）
  ok(effectiveFreshBudget({ input: 15000, cacheRead: 0, cacheWrite: 0, output: 200, calls: 1 }, BASE).uncached === false, '仅 1 次调用 → 不判「无缓存」（样本不足，阈值 5 次）')
  ok(effectiveFreshBudget({ input: 15000, cacheRead: 0, cacheWrite: 0, output: 200, calls: 5 }, BASE).uncached === true, '恰好 5 次且全未命中 → 判「无缓存」')
  ok(effectiveFreshBudget({ input: 1000, cacheRead: 1000, cacheWrite: 0, output: 10, calls: 9 }, BASE).uncached === false, '命中率恰 50% → 不算无缓存（阈值取严格小于）')
  // 脏输入：绝不抛
  ok(effectiveFreshBudget(null, BASE).budget === BASE && effectiveFreshBudget(undefined, BASE).uncached === false, '空 usage → 基础预算、不判无缓存')
  ok(effectiveFreshBudget({ input: 0, cacheRead: 0, output: 0, calls: 0 }, BASE).ratio === 0, '无输入时不除零（命中率记 0）')
  ok(cacheHitRatioOf({ input: 500, cacheRead: 500, cacheWrite: 0, output: 0, calls: 2 }) === 0.5, 'cacheHitRatioOf = cacheRead/(input+cacheRead)')
  // 与官方口径的关系：放宽只影响熔断，不影响汇报
  ok(totalTokensOf({ input: 100, cacheRead: 900, cacheWrite: 0, output: 50 }) === 1050, '汇报口径仍是 totalTokensOf（含 cacheRead）——两套口径不合并')
}

console.log(failed === 0 ? '\n✅ metering 全部通过' : `\n❌ metering ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
