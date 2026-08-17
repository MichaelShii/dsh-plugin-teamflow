/**
 * dsh-plugin-teamflow core — 运行期共享状态（进程单例）。
 * - runtime（agents/subagents/tokenMeter）：由 index=TeamflowService 的 static inject 注入（setRuntime）。
 * - runs/inFlight/activeProducts：流水线运行期 Map（跨 runner/pipeline/report/服务共享）。
 * 这是 ADR-0004「共享状态」在编排层的落点：共享对象集中、单向被 core 各模块 import（不反向）。
 */
/** 子代理/计量等宿主能力（由 TeamflowService 装配时 setRuntime 注入）。字段为鸭子类型：消费方自行窄化。 */
export const runtime: {
  agents?: any
  subagents?: any
  tokenMeter?: any
} = {}

export function setRuntime(agents: unknown, subagents: unknown, tokenMeter: unknown): void {
  runtime.agents = agents
  runtime.subagents = subagents
  runtime.tokenMeter = tokenMeter
}

/** 运行期 run 注册表（runId → Journal）。 */
export const runs = new Map()
/** 进行中的 stage 注册表（runId → { run, stage }），供取消/完成清理。 */
export const inFlight = new Map()
/** 产品级 backlog 缓存（product → BacklogStore）。 */
export const stores = new Map()
/** 产品级并发锁：product → 活跃 runId（同一产品同时只允许一条流水线）。 */
export const activeProducts = new Map()

/** 可用的子代理 provider 名（优先 spawn）。 */
export function providerName(): string | null {
  const subagents = runtime.subagents as { list?: () => string[] } | undefined
  if (!subagents || typeof subagents.list !== 'function') return null
  const names = subagents.list()
  if (names.indexOf('spawn') !== -1) return 'spawn'
  return names.length > 0 ? names[0] : null
}
