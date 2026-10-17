/**
 * dsh-plugin-teamflow — 确认单「人工批准」判据（纯函数行为断言）。
 *
 * 背景（2026-10-17 实锤 tf-mvc4jrl7-7g6hnb）：插件把暂停汇报作为 `user/message` **注入**主会话
 * （`source.kind = 'plugin:dsh-plugin-teamflow'`），模型把它当用户指令 ⇒ 08:33:36 暂停、08:34:02
 * **模型自己**调 `teamflow_resume` 把确认单批了（窗口内零条人类消息）。ADR-0011 ① 要的是**人工**批准。
 *
 * 判据：宿主会话日志里人类消息带 `data.source.kind === 'user'`，注入消息带 `plugin:*` /
 * `time-context` / `model-selection` 等 ⇒ 「暂停之后有没有人说过话」可机器判定，不靠模型自律。
 *
 * 三态是重点：`null`（读不到）必须与 `false`（确实没人说话）区分开——前者放行但留痕，后者拒绝。
 */
import { hasHumanMessageSince } from '../host/util.ts'

let failed = 0
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}

const PAUSE = 1792220016000 // 暂停时刻（08:33:36）
const userMsg = (t) => ({ type: 'user/message', time: t, data: { content: [{ type: 'text', text: '批准' }], source: { kind: 'user' } } })
const pluginNotice = (t) => ({ type: 'user/message', time: t, data: { content: [{ type: 'text', text: '【团队研发流水线汇报】…' }], source: { kind: 'plugin:dsh-plugin-teamflow', form: 'notice' } } })
const timeCtx = (t) => ({ type: 'user/message', time: t, data: { content: [{ type: 'text', text: 'Time sampled…' }], source: { kind: 'time-context' } } })
const asst = (t) => ({ type: 'assistant/message', time: t, data: { junk: 'teamflow_resume' } })
const sessionOf = (events) => ({ ownEvents: () => events })

console.log('── 1. 读不到 ⇒ null（绝不当成 false）──')
eq(hasHumanMessageSince(undefined, PAUSE), null, 'session 缺失 → null')
eq(hasHumanMessageSince(null, PAUSE), null, 'session=null → null')
eq(hasHumanMessageSince({}, PAUSE), null, 'session 没有 ownEvents/snapshotEvents → null')
eq(hasHumanMessageSince({ ownEvents: () => { throw new Error('boom') } }, PAUSE), null, 'ownEvents 抛错 → null')
eq(hasHumanMessageSince({ ownEvents: () => 'not-an-array' }, PAUSE), null, 'ownEvents 返回非数组 → null')
eq(hasHumanMessageSince({ ownEvents: () => undefined }, PAUSE), null, 'ownEvents 返回 undefined → null')

console.log('── 2. 能读到但没有人类消息 ⇒ false（这就是本次事故的形态）──')
eq(hasHumanMessageSince(sessionOf([]), PAUSE), false, '空日志 → false')
eq(hasHumanMessageSince(sessionOf([pluginNotice(PAUSE + 1000), timeCtx(PAUSE + 1001)]), PAUSE), false, '只有插件汇报 + 时间上下文 → false（模型据此自批就是事故）')
eq(hasHumanMessageSince(sessionOf([pluginNotice(PAUSE + 1000), asst(PAUSE + 2000)]), PAUSE), false, '助手消息里出现 teamflow_resume 字样也不算（类型过滤）')

console.log('── 3. 有人说过话 ⇒ true ──')
eq(hasHumanMessageSince(sessionOf([pluginNotice(PAUSE + 1000), userMsg(PAUSE + 5000)]), PAUSE), true, '人类消息晚于暂停 → true')
eq(hasHumanMessageSince(sessionOf([userMsg(PAUSE + 5000), pluginNotice(PAUSE + 6000)]), PAUSE), true, '人类已答复后再来一条汇报 → 仍 true')
eq(hasHumanMessageSince(sessionOf([userMsg(PAUSE - 60000), pluginNotice(PAUSE + 1000)]), PAUSE), false, '人类消息**早于**暂停（那是原需求）→ false，不能拿旧消息当批准')
eq(hasHumanMessageSince(sessionOf([userMsg(PAUSE), pluginNotice(PAUSE + 1)]), PAUSE), false, '恰好等于暂停时刻 → false（严格晚于）')

console.log('── 4. 兜底通道与脏数据 ──')
eq(hasHumanMessageSince({ snapshotEvents: () => [userMsg(PAUSE + 1)] }, PAUSE), true, '没有 ownEvents 时用 snapshotEvents → true')
eq(hasHumanMessageSince({ ownEvents: () => [null, 123, {}, { type: 'user/message' }] }, PAUSE), false, '脏事件不炸：缺 time/source 一律不计')
eq(hasHumanMessageSince(sessionOf([{ type: 'user/message', time: PAUSE + 1, data: {} }]), PAUSE), false, 'user/message 缺 source → 不计（宁可不认）')
eq(hasHumanMessageSince(sessionOf([userMsg(PAUSE + 1)]), Number.NaN), true, 'sinceMs 非法 → 按 0 处理（不因参数错误静默变成 false）')

console.log(failed === 0 ? '\n✅ human-approval 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
