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
import { shouldContinueChild } from '../host/util.ts'

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

console.log('── 2) 接线 ──')
const runnerSrc = readFileSync(join(here, '..', 'host', 'core', 'agent', 'runner.ts'), 'utf8')
ok(/tryContinueInChild/.test(runnerSrc), 'withRetry 里有"继续同一子代理"的实现')
ok(/canReviseViaChild/.test(runnerSrc), '先探测宿主能力（不支持就直接新起，不做无用等待）')
ok(/shouldContinueChild\(attempt, lastStage\.childId\)/.test(runnerSrc), '用纯函数判定，不用临时条件')
ok(/diag\.continueFallback/.test(runnerSrc), '回落时必须留可见日志（"为什么又新起了"不能是黑盒）')
// 假装成功是最坏的结局：拿不到正文必须回落，而不是拿上一轮的旧文本交差
ok(/if \(!out \|\| !String\(out\.text \|\| ''\)\.trim\(\)\)/.test(runnerSrc), '拿不到正文 ⇒ 回落新起（绝不假装成功）')
ok(/'log\.continueChild'/.test(runnerSrc), '成功续跑时留痕（本次新增多少 token 可见）')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
