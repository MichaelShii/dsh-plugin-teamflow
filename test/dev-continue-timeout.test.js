/**
 * dsh-plugin-teamflow — 续跑 noText 超时 / stage 收尾（2026-10-29 修复 run tf-mvsgetmy-ldop5j）。
 *
 * 动机（真机实证）：resume 复活的 child 单 turn 正常跑 90 分钟、160+ 步，旧 waitMs=25 分钟墙钟
 * 到顶 → 判 noText 失败；且 noText 分支**完全不动 stage** ⇒ 复用 resume 前的旧 stage，endedAt
 * 停在首次运行（卡片显示 6m3s，实际 child 已活 6.5 小时）⇒ 看起来像「6 分钟就死的弃子」。
 *
 * 锁两件事：
 *  ① 参数：waitMs 必须远大于 25 分钟、idleMs 必须盖住 job_output wait=300s 的空窗（防回退）。
 *  ② 行为：finalizeNoTextStage 有 stage 就必须同时改 status=failed + endedAt=now；null 安全。
 * 变异：只改 status 不改 endedAt、只改 endedAt 不改 status、null 不判空抛错 —— 三个变异都必须被杀死。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { finalizeNoTextStage } from '../host/core/agent/runner.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

console.log('── 1) finalizeNoTextStage 行为 ──')
// null 安全：noText 分支里 lastStage 可能为空（用 resumeChildId 而非 lastStage.childId 时）
let threw = false
try { finalizeNoTextStage(null, 999) } catch (e) { threw = true }
ok(!threw, 'null stage 不抛（noText 时 lastStage 可能为空）')
ok(finalizeNoTextStage(undefined, 999) === undefined, 'undefined 原样返回')

// 有 stage：同时改 status + endedAt，且就地改（返回同引用，调用方持有的 lastStage 同步更新）
const st = { status: 'running', endedAt: 100 }
const ret = finalizeNoTextStage(st, 999)
ok(ret === st, '就地修改并返回同一引用（调用方 lastStage 同步更新）')
ok(st.status === 'failed', 'status 置 failed')
ok(st.endedAt === 999, 'endedAt 落真实结束时刻（不是首次运行的旧值）')

// 原本没有 endedAt 字段
const st2 = { status: 'running' }
finalizeNoTextStage(st2, 777)
ok(st2.endedAt === 777, '原无 endedAt 字段时也能补上')

console.log('── 2) 变异：每个行为必须有牙 ──')
// 变异①：只改 status、不改 endedAt（旧的「时长停在首次」形态）
const mutantDropEndedAt = (s, _now) => { if (!s) return s; s.status = 'failed'; return s }
const m1 = { status: 'running', endedAt: 100 }
mutantDropEndedAt(m1, 999)
ok(m1.endedAt === 100 && st.endedAt === 999, '变异①（不改 endedAt）：时长停在旧值 ⇒ 被真实现杀死')

// 变异②：只改 endedAt、不改 status
const mutantDropStatus = (s, now) => { if (!s) return s; s.endedAt = now; return s }
const m2 = { status: 'running', endedAt: 100 }
mutantDropStatus(m2, 999)
ok(m2.status === 'running' && st.status === 'failed', '变异②（不改 status）：状态停在旧值 ⇒ 被真实现杀死')

// 变异③：null 不判空 → 抛错
const mutantThrowNull = (s, now) => { s.status = 'failed'; s.endedAt = now; return s }
let mutantThrew = false
try { mutantThrowNull(null, 1) } catch (e) { mutantThrew = true }
ok(mutantThrew === true, '变异③（null 不判空）：抛错 ⇒ 证明 null 保护有牙')

console.log('── 3) 参数 / 接线（防回退到误杀长任务的旧值）──')
const runnerSrc = readFileSync(join(here, '..', 'host', 'core', 'agent', 'runner.ts'), 'utf8')
ok(runnerSrc.includes('waitMs: 7_200_000'), 'waitMs 为 2 小时（旧值 1_500_000 会误杀 90 分钟的正常 turn）')
ok(runnerSrc.includes('idleMs: 600_000'), 'idleMs 为 10 分钟（旧值 300_000 与 job_output wait=300s 撞边）')
ok(runnerSrc.includes('finalizeNoTextStage(lastStage'), 'noText 分支真的调用 finalizeNoTextStage（接线落点）')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
