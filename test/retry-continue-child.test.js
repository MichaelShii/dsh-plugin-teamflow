/**
 * dsh-plugin-teamflow — 重试复用同一子代理（"继续"，而不是新起一个）。
 *
 * 动机（2026-10-28 复盘 tf-mvpjqs87-14qdxa）：重试原本每次 `runAgent` 新起 child —— 新 child 对上一轮
 * 一无所知，只能从零重读 PRD / TECHNICAL / 源码。该 run 单阶段 dev 184 次调用烧 18.4M token，
 * 修复轮 96~150 次调用烧 6.5~15M，**大头是重读同样的上下文**。同一 child 续跑在 PRD 改写上已真机验过
 * （同一 child 连改 3 版、零新 spawn）。
 *
 * 这里锁两件事：
 *  ① 判定边界（纯函数）：第一次尝试绝不"继续"；没有 childId 就无从继续。
 *  ② 接线：runner 必须真的走这条通道，且**拿不到就回落新起**（假装成功是最坏的结局）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { shouldContinueChild, shouldRerouteChild } from '../host/util.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

console.log('── 1) 该不该"继续" ──')
ok(shouldContinueChild(1, 'child-abc') === false, '第一次尝试 ⇒ 不继续（那时还没有上一轮）')
ok(shouldContinueChild(2, 'child-abc') === true, '第二次尝试 + 有 childId ⇒ 继续')
ok(shouldContinueChild(3, 'child-abc') === true, '第三次尝试同样继续')
ok(shouldContinueChild(2, '') === false, '没有 childId ⇒ 不继续')
ok(shouldContinueChild(2, '   ') === false, '空白 childId ⇒ 不继续')
ok(shouldContinueChild(2, null) === false && shouldContinueChild(2, undefined) === false, 'null/undefined ⇒ 不继续')
ok(shouldContinueChild('x', 'child-abc') === false, 'attempt 非数字 ⇒ 不继续（脏数据不炸）')
ok(shouldContinueChild(0, 'child-abc') === false, 'attempt=0 ⇒ 不继续')

console.log('── 1b) 中断后 resume：attempt=1 也要能继续 ──')
// 中断 ≠ 失败：resume 时对每个未完成任务都是 attempt=1，但它不是"新任务"。
// 实测 tf-mvsgetmy-ldop5j（2026-10-29）：dev 阶段被人工中断，resume 后全部新起子代理、
// 从零重读 PRD/TECHNICAL/源码 —— 因为原来的 shouldContinueChild 要求 attempt>1，resume 永远不触发。
ok(shouldContinueChild(1, null, 'child-abc') === true, 'resume 带 childId ⇒ attempt=1 也继续')
ok(shouldContinueChild(2, null, 'child-abc') === true, 'resume 且 attempt=2 ⇒ 继续')
ok(shouldContinueChild(1, null, '') === false, 'resume 但 childId 为空 ⇒ 不继续')
ok(shouldContinueChild(1, null, null) === false, '无 childId 也无 resumeChildId ⇒ 不继续')
ok(shouldContinueChild(1, 'child-old', 'child-resume') === true, '两路都有 ⇒ 继续（重试来源优先，但不影响结论）')

console.log('── 2) 接线 ──')
const runnerSrc = readFileSync(join(here, '..', 'host', 'core', 'agent', 'runner.ts'), 'utf8')
ok(/tryContinueInChild/.test(runnerSrc), 'withRetry 里有"继续同一子代理"的实现')
ok(/canReviseViaChild/.test(runnerSrc), '先探测宿主能力（不支持就直接新起，不做无用等待）')
ok(/shouldContinueChild\(attempt, lastStage \? lastStage\.childId : null, resumeChildId\)/.test(runnerSrc), '用纯函数判定，不用临时条件')
ok(/diag\.continueFallback/.test(runnerSrc), '回落时必须留可见日志（"为什么又新起了"不能是黑盒）')
// 绝不假装成功：**没投进去**（宿主不支持 / sendMessage 抛错）⇒ 回落新起，但空文本不算"没投进去"
ok(/if \(!out \|\| !String\(out\.text \|\| ''\)\.trim\(\)\)/.test(runnerSrc) === false && /String\(out\.text \|\| ''\)\.trim\(\)/.test(runnerSrc), '正文为空不再当作"没投进去"（空正文 + 已投递 ⇒ 走 noText，不回落）')
ok(/'log\.continueChild'/.test(runnerSrc), '成功续跑时留痕（本次新增多少 token 可见）')
// 2026-10-29 实锤（tf-mvsgetmy-ldop5j）：指令投进了原 child（子会话里有 2 条注入记录），但 child 在跑
// 长命令 ⇒ 事件冻结 ⇒ idle 判据误判 ⇒ 旧实现回落新起 ⇒ **两个子代理改同一批文件**。
// 判据：**投递成功 ⇒ 永不回落新起**；宁可按失败收场转人工。
ok(/kind === 'noText'/.test(runnerSrc) && /kind: 'noText'/.test(runnerSrc), '投了但没等到正文 ⇒ 按失败收场（绝不回落新起）')
ok(!/delivered: diag\.delivered \? 'yes' : 'no'/.test(runnerSrc), '回落 warn 只允许出现在「没投进去」的分支（delivered 恒为 no）')
ok(/idleMs: 300_000/.test(runnerSrc), 'idle 给足 5 分钟（长命令期间事件冻结，120s 会误判）')
const devSrc = readFileSync(join(here, '..', 'host', 'core', 'stages', 'dev.ts'), 'utf8')
ok(/const prevChildId = prevStage && prevStage\.childId/.test(devSrc), 'dev resume 分支把上一轮的 childId 找回来')
ok(/task\.ids, prevChildId\)/.test(devSrc), 'dev resume 真的把它传给 withRetry（否则等于没接）')

console.log('── 3) 改道闸门 shouldRerouteChild（2026-10-29）──')
// 双条件：① 旧 child 上一轮因模型不可用（external）失败 ② 用户已切到别的模型（路由漂移）。
// 只满足①（没切模型）：新 child 还是老模型 ⇒ 不浪费机会、保留旧 child 上下文。
// 只满足②（老模型可用）：保持续跑。
const stage = (childId, outcome, provider, model) => ({ childId, outcome, provider, model })
const journalOf = (stages, externalFailure) => ({ stages, externalFailure })
// 命名路由，便于读
const OLD = { provider: 'p-old', model: 'm-old' }
const NEW = { provider: 'p-new', model: 'm-new' }
const SAME = OLD

// 3a) 真值表
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'c1', route: NEW }) === true,
  'external + 路由漂移 ⇒ 改道')
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'c1', route: SAME }) === false,
  'external 但用户没切模型 ⇒ 不改道（新 child 还是老模型，浪费机会）')
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'error', OLD.provider, OLD.model)]), childId: 'c1', route: NEW }) === false,
  '非 external（内容失败） + 漂移 ⇒ 不改道（保留旧 child 上下文）')
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'error', OLD.provider, OLD.model)]), childId: 'c1', route: SAME }) === false,
  '非 external + 无漂移 ⇒ 不改道')
ok(shouldRerouteChild({ journal: journalOf([]), childId: 'c1', route: NEW }) === false,
  '找不到该 child 的 stage ⇒ 不改道（保底：找不到就不动）')
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: '', route: NEW }) === false,
  'childId 为空 ⇒ 不改道')
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'cX', route: NEW }) === false,
  'childId 不匹配任何 stage ⇒ 不改道')
// run 级兜底：stage.outcome 不一定是 'external'（耗光退避的中断态），journal.externalFailure 也能触发
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'interrupted', OLD.provider, OLD.model)], true), childId: 'c1', route: NEW }) === true,
  'externalFailure 兜底（stage 非 external 但 run 标记外部失败） + 漂移 ⇒ 改道')
// 只记 provider 漂移、model 相同也算漂移
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'external', 'p-old', 'm-shared')]), childId: 'c1', route: { provider: 'p-new', model: 'm-shared' } }) === true,
  '仅 provider 漂移（model 同）⇒ 改道')
// 多条 stage 取最后一条（续跑不新增 stage，但防御性取最后）
ok(shouldRerouteChild({ journal: journalOf([stage('c1', 'error', OLD.provider, OLD.model), stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'c1', route: NEW }) === true,
  '同 child 多条 stage ⇒ 取最后一条（最后才是 external）⇒ 改道')

// 3b) 变异：每个判据必须有牙（去掉任一条件，至少一条断言变红）
const mutantDropExternal = (v) => {
  const id = typeof v.childId === 'string' ? v.childId.trim() : ''
  if (!id) return false
  const stages = Array.isArray(v.journal?.stages) ? v.journal.stages : []
  let rec
  for (const s of stages) if (String(s.childId || '') === id) rec = s
  if (!rec) return false
  const recProvider = rec.provider ?? null, recModel = rec.model ?? null
  const desiredProvider = v.route.provider ?? null, desiredModel = v.route.model ?? null
  return recProvider !== desiredProvider || recModel !== desiredModel // 漏掉 external 条件
}
const mutantDropDrift = (v) => {
  const id = typeof v.childId === 'string' ? v.childId.trim() : ''
  if (!id) return false
  const stages = Array.isArray(v.journal?.stages) ? v.journal.stages : []
  let rec
  for (const s of stages) if (String(s.childId || '') === id) rec = s
  if (!rec) return false
  const externalFailed = rec.outcome === 'external' || v.journal?.externalFailure === true
  if (!externalFailed) return false
  return true // 漏掉 drift 条件
}
ok(mutantDropExternal({ journal: journalOf([stage('c1', 'error', OLD.provider, OLD.model)]), childId: 'c1', route: NEW }) === true && shouldRerouteChild({ journal: journalOf([stage('c1', 'error', OLD.provider, OLD.model)]), childId: 'c1', route: NEW }) === false,
  '变异①（去掉 external 条件）：非 external+漂移 会被误判改道 ⇒ 该变异被杀死')
ok(mutantDropDrift({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'c1', route: SAME }) === true && shouldRerouteChild({ journal: journalOf([stage('c1', 'external', OLD.provider, OLD.model)]), childId: 'c1', route: SAME }) === false,
  '变异②（去掉 drift 条件）：external+无漂移 会被误判改道 ⇒ 该变异被杀死')

console.log('── 4) 接线 ──')
// runner 必须在"继续"判定内先算期望路由、命中改道闸门时跳过续跑、记 diag.rerouteNewChild。
ok(/const desiredRoute = resolveChildRoute\(parent\)/.test(runnerSrc), '续跑块先算期望路由（resolveChildRoute）')
ok(/shouldRerouteChild\(\{ journal, childId: continueId, route: desiredRoute \}\)/.test(runnerSrc), '用纯函数 shouldRerouteChild 判定改道，不用临时条件')
ok(/diag\.rerouteNewChild/.test(runnerSrc), '改道时留可见日志（"为什么又新起"不能是黑盒）')
ok(/不续跑 ⇒ 跳过本块，落到下方 runAgent 新起 child/.test(runnerSrc), '命中改道 ⇒ 不续跑、走 runAgent 新起 child（吃新路由）')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
