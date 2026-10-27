/**
 * dsh-plugin-teamflow — 「单条命令跑太久」告警的判定与接线。
 *
 * 事故（2026-10-28 tf-mvpjqs87-14qdxa）：QA 把 10 个 Java 探针串进一条 pwsh，第 10 个卡死
 * （`SiZhuTierSweep`，整盘排盘），整条命令跑满工具上限 600s 被杀 → 前 9 个探针的成果一起作废；
 * 转后台 job 后又轮询 14 分钟。**该阶段 34/42 分钟都在等它**，而算法本身只要 0.18 秒。
 *
 * 为什么护栏原来没抓到：`GUARD_SILENCE_MS = 600s` 恰好等于工具超时上限 —— 命令跑满 600s 时
 * 事件是冻结的，护栏看到的是"没新事件"，等它真要判定时命令已经返回。长命令期间是结构性盲区。
 * 判据：让长命令**可见**（warn），不中止（长构建/大 e2e 是合法形态）。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { longCallDue } from '../host/util.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

console.log('── 1) 判定边界 ──')
const T = 120_000
const base = 1_000_000
ok(longCallDue(base, base + 119_000, T, false) === false, '跑 119 秒 ⇒ 不报（阈值未到）')
ok(longCallDue(base, base + 120_000, T, false) === true, '跑满 120 秒 ⇒ 报')
ok(longCallDue(base, base + 600_000, T, false) === true, '跑 600 秒（工具上限）⇒ 报')
ok(longCallDue(base, base + 600_000, T, true) === false, '同一个调用只报一次（已报过 ⇒ 静默）')

console.log('── 2) 脏数据不许误报 ──')
ok(longCallDue(0, Date.now(), T, false) === false, 'startedAt=0 ⇒ 不报')
ok(longCallDue(undefined, Date.now(), T, false) === false, '缺 startedAt ⇒ 不报')
ok(longCallDue('abc', Date.now(), T, false) === false, 'startedAt 非数字 ⇒ 不报')

console.log('── 3) 接线 ──')
const guardSrc = readFileSync(join(here, '..', 'host', 'core', 'agent', 'guard.ts'), 'utf8')
const constSrc = readFileSync(join(here, '..', 'host', 'constants.ts'), 'utf8')
const promptSrc = readFileSync(join(here, '..', 'host', 'prompts', 'index.ts'), 'utf8')
ok(/GUARD_LONG_CALL_MS/.test(constSrc), '阈值常量存在（且注释写明与 GUARD_SILENCE_MS 的关系）')
ok(/noteInFlight/.test(guardSrc) && /warnLongCalls/.test(guardSrc), 'guard 维护在飞调用并检查')
ok(/longCallDue\(/.test(guardSrc), '判定走纯函数（可测边界）')
ok(/warnLongCalls\(\)/.test(guardSrc), '每次轮询都检查（长命令期间恰恰没有新事件）')
ok(/\[Command discipline · mandatory · one command = one check\]/.test(promptSrc), 'QA prompt 要求一条命令一个检查 + 超时')
ok(/terminate it immediately/.test(promptSrc), 'QA prompt 要求常驻进程探测后立即终止')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
