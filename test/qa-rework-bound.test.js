/**
 * dsh-plugin-teamflow — QA 打回轮次「跨 resume 累计」的界线测试。
 *
 * 事故（2026-10-27 tf-mvpjqs87-14qdxa）：轮次计数是 QA 阶段内的局部变量（`let round = 0`），
 * 用户在 20:09 点了中断、8 小时后 resume —— QA 又从「第 1 轮」开始打回，同一个 run 一路打到第 3 轮，
 * 而日志和界面上都显示「第 1 轮」。ADR-0007 的「有界闭环」在续跑后就失效了。
 * 判据：**上限必须跨进程存活**；人工介入可以给一次新预算，但追加次数本身必须有限。
 */
import { planQaRoundStart } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}
const LIMIT = 2
const BUDGET = 2

console.log('── 1) 首次进入：从 0 开始 ──')
const first = planQaRoundStart(null, false, LIMIT, BUDGET)
ok(first.round === 0 && first.resumes === 0 && !first.reset, '无历史 ⇒ round=0，不算重置')
ok(planQaRoundStart({ round: 1, resumes: 0 }, false, LIMIT, BUDGET).round === 1, '上一轮用了 1 轮 ⇒ 续跑接着用 1（不清零）')

console.log('── 2) 超限后自动续跑：**不给**新预算（这正是原来的漏洞）──')
const auto = planQaRoundStart({ round: 3, resumes: 0 }, false, LIMIT, BUDGET)
ok(auto.round === 3 && !auto.reset, '非人工续跑 ⇒ 仍是 3 轮（>上限），下次 QA 立刻转人工')
ok(auto.resumes === 0, '不消耗人工预算')

console.log('── 3) 人工 resume：追加一次预算，从 1 重新计 ──')
const human = planQaRoundStart({ round: 3, resumes: 0 }, true, LIMIT, BUDGET)
ok(human.reset && human.round === 0, '人工续跑 ⇒ 重置为 0（下一轮是第 1 轮）')
ok(human.resumes === 1, '人工预算记账 +1')
ok(human.used === 3, '把「已用 3 轮」带回日志（可观测，不是静默重置）')

console.log('── 4) 人工预算也有上限（否则又变无限循环）──')
const capped = planQaRoundStart({ round: 3, resumes: BUDGET }, true, LIMIT, BUDGET)
ok(!capped.reset && capped.round === 3, `人工预算用尽（${BUDGET}/${BUDGET}）⇒ 再 resume 也不重置`)
ok(planQaRoundStart({ round: 3, resumes: 1 }, true, LIMIT, BUDGET).reset, '还剩 1 次预算 ⇒ 仍可重置')

console.log('── 5) 脏数据不许炸 ──')
ok(planQaRoundStart({ round: 'x', resumes: null }, true, LIMIT, BUDGET).round === 0, 'round 非数字 ⇒ 当 0')
ok(planQaRoundStart({ round: -5, resumes: -1 }, false, LIMIT, BUDGET).round === 0, '负数 ⇒ 夹到 0')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
