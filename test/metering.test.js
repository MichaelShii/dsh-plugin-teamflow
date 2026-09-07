/**
 * dsh-plugin-teamflow — token 计量（accumulateSessionUsage）行为测试。
 * 背景（2026-09-07 实锤 r38 usage 全空）：宿主新版 Session（session v2）已无 `events` 属性/getter，
 * 旧实现读 session.events = undefined → accumulateSessionUsage 返回 null → stage usage 全 null →
 * backlog 任务卡与流水线图卡详情无「TOKEN · 官方口径」（task-37 有、task-38 无）。
 * 修复：多源回退（events → snapshotEvents() → ownEvents()）+ 双路径取 usage（data.usage 优先，
 * 缺失时扫 data.stream 的 usage chunk，宿主 usageOf 同款）。
 * 本文件冻结新旧宿主事件形状，防计量再次静默失明。
 */
import { accumulateSessionUsage, totalTokensOf } from '../host/core/metering.ts'

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

console.log(failed === 0 ? '\n✅ metering 全部通过' : `\n❌ metering ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
