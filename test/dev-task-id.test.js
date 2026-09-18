/**
 * dsh-plugin-teamflow — dev 任务身份与 resume 判定（2026-09-18 实锤修复）。
 *
 * **被修的 bug**（probe-cache `tf-mu6tb281-4n43oc`，用户实测「T0 被触发两次，第一次明面成功了」）：
 *  1. 冲突检测把 files 有交集的任务**合并**成一个子代理执行，合并时 `title` 被**拼接**成
 *     `"T0 … + T6 … + T7 …"`（host 自己拼的）；
 *  2. 旧实现的 `taskKey` 只存 title，判定按 **title 全文精确匹配**；
 *  3. resume 时 `buildDevTaskDefs` 重新从蓝图取回**未合并**的 `T0 …`/`T6 …`/`T7 …`；
 *  4. → 三个 title 在聚合表里都查不到 → 判定「未完成」→ **重复执行已成功的工作**
 *     （backlog 里 `dev-1` 与 `dev-7` 同为 T0、`dev-8` 同为 T6，肉眼可见的重复卡）。
 *
 * **修法**：host 按定义顺序生成稳定 `dt-N` 作任务身份；合并时 `taskIds` 数组累加；
 * 判定只认 id。本文件用**真实 stage 形状**（从实锤 journal 抄下来的）锁死回归。
 *
 * **为什么不能用"按分隔符切分 title"之类的字符串规则**：那是拿文本长相当身份，
 * 同型的错已犯过两次（per-plugin 正则、固定 .gitignore 词表）——本文件的存在就是为了防止回退。
 */
import { devTaskStatuses, devTaskIdAt } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

// ── 1) 实锤场景复刻：合并执行的 stage 必须让三个任务都判「已做」 ──
console.log('\n[1] 实锤复刻：合并执行（T0+T6+T7 一个子代理）→ resume 不得重复补跑')
const merged = [
  // 合并执行的 stage（taskIds 三项）—— 这正是当初生成拼接 title 的那次
  { seq: 4, phase: 'dev', status: 'done', taskKey: 'T0 工程约束 + T6 契约收口 + T7 装入 profile', taskIds: ['dt-1', 'dt-7', 'dt-8'] },
  { seq: 5, phase: 'dev', status: 'done', taskKey: 'T1 host 纯函数', taskIds: ['dt-2'] },
  { seq: 6, phase: 'dev', status: 'done', taskKey: 'T2 host 服务', taskIds: ['dt-3'] },
  { seq: 7, phase: 'dev', status: 'done', taskKey: 'T3 client 纯函数', taskIds: ['dt-4'] },
  { seq: 8, phase: 'dev', status: 'done', taskKey: 'T4 client store', taskIds: ['dt-5'] },
  { seq: 9, phase: 'dev', status: 'failed', taskKey: 'T5 client UI', taskIds: ['dt-6'] },
]
const st = devTaskStatuses(merged)
ok(st.get('dt-1')?.done === true, '合并 stage 里的 **dt-1（T0）判已做**（旧实现查 title 落空 → 重复补跑）')
ok(st.get('dt-7')?.done === true, '合并 stage 里的 **dt-7（T6）判已做**')
ok(st.get('dt-8')?.done === true, '合并 stage 里的 **dt-8（T7）判已做**')
ok(st.get('dt-2')?.done === true, '独立执行的 dt-2 判已做')
ok(!st.get('dt-6')?.done, '失败的 dt-6 判未做（该补跑）——判定没有被"宽松化"')
// 仿真 resume：蓝图重建出 8 个任务，filter 后应**只剩 dt-6**（而不是像实锤那样补跑 4 个）
const blueprintIds = ['dt-1', 'dt-2', 'dt-3', 'dt-4', 'dt-5', 'dt-6', 'dt-7', 'dt-8']
const todo = blueprintIds.filter((id) => !st.get(id)?.done)
ok(todo.length === 1 && todo[0] === 'dt-6', `resume 待补跑 = 仅 dt-6（实锤旧实现是 4 个：dt-1/dt-6/dt-7/dt-8）——实测 ${JSON.stringify(todo)}`)

// ── 2) 历史失败尝试不算失败（有 done stage 即成功）──
console.log('\n[2] 同一任务多次尝试：有 done 即成功（历史失败不翻案）')
const retried = [
  { seq: 3, phase: 'dev', status: 'failed', taskIds: ['dt-1'] },
  { seq: 9, phase: 'dev', status: 'failed', taskIds: ['dt-1'] },
  { seq: 12, phase: 'dev', status: 'done', taskIds: ['dt-1'] },
]
ok(devTaskStatuses(retried).get('dt-1')?.done === true, '失败→失败→成功：判已做（不被更早的失败覆盖）')
ok(devTaskStatuses(retried).get('dt-1')?.lastSeq === 12, 'lastSeq 取最近一次尝试的 seq')
ok(devTaskStatuses(retried).get('dt-1')?.lastStatus === 'done', 'lastStatus 取最近一次尝试的状态')

// ── 3) resume 补跑后再次 resume：不该再补 ──
console.log('\n[3] 补跑成功后（补跑 stage 也带 taskIds）→ 下一次 resume 不再补')
const afterRerun = [...merged, { seq: 20, phase: 'dev', status: 'done', taskKey: 'T5 client UI（补跑）', taskIds: ['dt-6'] }]
ok(devTaskStatuses(afterRerun).get('dt-6')?.done === true, '补跑的 dt-6 判已做（补跑 stage 必须带 taskIds，否则永远补不完）')

// ── 4) 存量兼容：无 taskIds 的旧 stage 回退 title（只增不改）──
console.log('\n[4] 存量兼容：升级前的 stage 无 taskIds → 回退 taskKey/label')
const legacy = [
  { seq: 1, phase: 'dev', status: 'done', taskKey: 'T1 host 纯函数' },
  { seq: 2, phase: 'dev', status: 'done', label: '开发 · T2 host 服务' },
  { seq: 3, phase: 'dev', status: 'done', label: '开发 · T3 client（第 2 次重试）' },
]
const ls = devTaskStatuses(legacy)
ok(ls.get('T1 host 纯函数')?.done === true, '存量：taskKey 直接作 key')
ok(ls.get('T2 host 服务')?.done === true, '存量：无 taskKey 时从 label 剥「开发 · 」前缀')
ok(ls.get('T3 client')?.done === true, '存量：重试后缀（第 N 次重试）被剥离')
// 混合：新 stage 用 id、旧 stage 用 title，互不干扰
const mixed = [...legacy, { seq: 5, phase: 'dev', status: 'done', taskKey: 'X', taskIds: ['dt-1'] }]
const ms = devTaskStatuses(mixed)
ok(ms.get('dt-1')?.done === true && ms.get('T1 host 纯函数')?.done === true, '新旧混合：各按各的键归并，互不覆盖')

// ── 5) 边界 ──
console.log('\n[5] 边界')
ok(devTaskStatuses([]).size === 0, '空输入 → 空表（不抛）')
ok(devTaskStatuses([{ seq: 1, status: 'done' }]).size === 0, '无 taskKey/taskIds/label → 不产生条目（不落空 key）')
ok(devTaskStatuses([{ seq: 1, status: 'done', taskIds: [] }]).size === 0, 'taskIds 为空数组 → 回退（不被当成"有 id"）')
ok(devTaskStatuses([{ seq: 1, status: 'done', taskIds: ['', '  '] }]).size === 0, 'taskIds 全空白 → 过滤后回退（不落空 key）')
const dedup = devTaskStatuses([{ seq: 1, status: 'done', taskIds: ['dt-1', 'dt-1'] }])
ok(dedup.size === 1, '同一 id 重复出现 → 只一条（幂等）')

console.log(failed ? `\n✗ dev-task-id：${failed} 条失败\n` : '\n✓ dev-task-id：全部通过\n')
process.exit(failed ? 1 : 0)
