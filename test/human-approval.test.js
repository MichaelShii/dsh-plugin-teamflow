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
import { hasHumanReplySince, isExplicitApproval, lastHumanReplySince, hasExplicitApprovalSince } from '../host/util.ts'

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
eq(hasHumanReplySince(undefined, PAUSE), null, 'session 缺失 → null')
eq(hasHumanReplySince(null, PAUSE), null, 'session=null → null')
eq(hasHumanReplySince({}, PAUSE), null, 'session 没有 ownEvents/snapshotEvents → null')
eq(hasHumanReplySince({ ownEvents: () => { throw new Error('boom') } }, PAUSE), null, 'ownEvents 抛错 → null')
eq(hasHumanReplySince({ ownEvents: () => 'not-an-array' }, PAUSE), null, 'ownEvents 返回非数组 → null')
eq(hasHumanReplySince({ ownEvents: () => undefined }, PAUSE), null, 'ownEvents 返回 undefined → null')

console.log('── 2. 能读到但没有人类消息 ⇒ false（这就是本次事故的形态）──')
eq(hasHumanReplySince(sessionOf([]), PAUSE), false, '空日志 → false')
eq(hasHumanReplySince(sessionOf([pluginNotice(PAUSE + 1000), timeCtx(PAUSE + 1001)]), PAUSE), false, '只有插件汇报 + 时间上下文 → false（模型据此自批就是事故）')
eq(hasHumanReplySince(sessionOf([pluginNotice(PAUSE + 1000), asst(PAUSE + 2000)]), PAUSE), false, '助手消息里出现 teamflow_resume 字样也不算（类型过滤）')

console.log('── 3. 有人说过话 ⇒ true ──')
eq(hasHumanReplySince(sessionOf([pluginNotice(PAUSE + 1000), userMsg(PAUSE + 5000)]), PAUSE), true, '人类消息晚于暂停 → true')
eq(hasHumanReplySince(sessionOf([userMsg(PAUSE + 5000), pluginNotice(PAUSE + 6000)]), PAUSE), true, '人类已答复后再来一条汇报 → 仍 true')
eq(hasHumanReplySince(sessionOf([userMsg(PAUSE - 60000), pluginNotice(PAUSE + 1000)]), PAUSE), false, '人类消息**早于**暂停（那是原需求）→ false，不能拿旧消息当批准')
eq(hasHumanReplySince(sessionOf([userMsg(PAUSE), pluginNotice(PAUSE + 1)]), PAUSE), false, '恰好等于暂停时刻 → false（严格晚于）')

console.log('── 3b. 人点 ask_user_question 的选项也算（**这是最容易漏的一半**）──')
// 实测宿主：AUQ 的回答落盘为 tool/result（data.message.source = {kind:'tool', callId}），
// **不产生 user/message**。而我们在汇报里就是让模型用 AUQ 问 ⇒ 漏掉这条 = 人答了却被拒。
const auqCall = (t, id) => ({ type: 'tool/call', time: t, data: { name: 'ask_user_question', callId: id } })
const auqResult = (t, id) => ({ type: 'tool/result', time: t, data: { toolCallId: id, message: { role: 'tool', source: { kind: 'tool', callId: id }, content: [{ type: 'text', text: '{"answers":[]}' }] } } })
const otherResult = (t, id) => ({ type: 'tool/result', time: t, data: { toolCallId: id, message: { role: 'tool', source: { kind: 'tool', callId: id }, content: [] } } })
eq(hasHumanReplySince(sessionOf([pluginNotice(PAUSE + 1000), auqCall(PAUSE + 2000, 'c1'), auqResult(PAUSE + 3000, 'c1')]), PAUSE), true,
  'AUQ 调用 + 结果（人点了选项）→ true')
eq(hasHumanReplySince(sessionOf([pluginNotice(PAUSE + 1000), auqCall(PAUSE + 2000, 'c1')]), PAUSE), false,
  '只有 AUQ 调用（模型问了，没人答）→ false —— 只认结果，不认调用')
eq(hasHumanReplySince(sessionOf([auqCall(PAUSE + 2000, 'c1'), otherResult(PAUSE + 3000, 'c9')]), PAUSE), false,
  '结果 callId 对不上（别的工具的产物）→ false')
eq(hasHumanReplySince(sessionOf([auqCall(PAUSE - 500, 'c1'), auqResult(PAUSE - 100, 'c1')]), PAUSE), false,
  'AUQ 结果**早于**暂停 → false（那不是本次批准）')
eq(hasHumanReplySince(sessionOf([auqCall(PAUSE + 2000, 'c1'), otherResult(PAUSE + 3000, 'c1')]), PAUSE), true,
  '只要 callId 与 AUQ 对得上就认（宿主不同版本可能不带 message.source，靠 toolCallId 兜）')

console.log('── 4. 兜底通道与脏数据 ──')
eq(hasHumanReplySince({ snapshotEvents: () => [userMsg(PAUSE + 1)] }, PAUSE), true, '只有 snapshotEvents（新宿主）→ true')
eq(hasHumanReplySince({ ownEvents: () => [userMsg(PAUSE + 1)] }, PAUSE), true, '只有 ownEvents（旧宿主）→ true（兜底仍在）')
// `snapshotEvents` 是**完整日志**、且未标废弃（`ownEvents` 在宿主 d.ts 已 @deprecated），必须优先。
eq(hasHumanReplySince({ snapshotEvents: () => [userMsg(PAUSE + 1)], ownEvents: () => [] }, PAUSE), true,
  '两者都在 → **优先 snapshotEvents**（否则 fork/重启后 ownEvents 只给子级事件，会漏掉人类消息而误挡续跑）')
eq(hasHumanReplySince({ ownEvents: () => [null, 123, {}, { type: 'user/message' }] }, PAUSE), false, '脏事件不炸：缺 time/source 一律不计')
eq(hasHumanReplySince(sessionOf([{ type: 'user/message', time: PAUSE + 1, data: {} }]), PAUSE), false, 'user/message 缺 source → 不计（宁可不认）')
eq(hasHumanReplySince(sessionOf([userMsg(PAUSE + 1)]), Number.NaN), true, 'sinceMs 非法 → 按 0 处理（不因参数错误静默变成 false）')

console.log('── 5) 「说过话」≠「批准」：isExplicitApproval 真值表 ──')
// 事故（2026-10-17 tf-mvckeco4-2o1p91）：确认单只剩 1 项待拍板，用户那句「加 --depth N，默认 0」
// 恰好是那项的缺省建议 ⇒ 模型判成「整版认可」⇒ 自己 resume ⇒ 直接进架构设计。无 supplement 的
// resume 是**整版放行**，所以必须要求显式批准语义。
eq(isExplicitApproval('批准'), true, '「批准」→ 批准')
eq(isExplicitApproval('可以，开工吧'), true, '「可以，开工吧」→ 批准')
eq(isExplicitApproval('同意，按这个做'), true, '「同意，按这个做」→ 批准')
eq(isExplicitApproval('approved, go ahead'), true, 'en：approved / go ahead → 批准')
// ⚠️ 刻意**不认**裸 `ok`：它太容易和「ok 但是…」混淆，误判成批准会封死修改窗口。
// 代价只是多问一句（模型有三条出路），方向是安全的。
eq(isExplicitApproval('  OK  '), false, '裸 OK → **不认**（歧义太大；多问一句比误批便宜）')
// 修改类：都不是批准
eq(isExplicitApproval('加一个 --depth N 参数，默认 0 不限制'), false, '「加一个参数」→ **不是**批准（本次事故那句话）')
eq(isExplicitApproval('把 --json 改成嵌套结构'), false, '「改成…」→ 不是批准')
eq(isExplicitApproval('去掉 --depth'), false, '「去掉…」→ 不是批准')
eq(isExplicitApproval('可以，但再加个 --json 开关'), false, '「可以，但再加…」→ 不是批准（有修改词 ⇒ 必须走 supplement）')
// ⚠️ 这条专治「批准词 + 修改词同现」：夹具必须让 CHANGE_WORDS 判定**单独有作用**，
// 否则删掉该判定的变异体会算出同样的结果（第一版就漏了这条）。
eq(isExplicitApproval('批准，但把缩进改成两格'), false, '「批准，但把X改成Y」→ 不是纯批准（要改就走 supplement）')
eq(isExplicitApproval('开工，再加个 --depth'), false, '「开工，再加个…」→ 不是纯批准')
eq(isExplicitApproval('add a --depth flag'), false, 'en：add → 不是批准')
// 否定优先
eq(isExplicitApproval('不批准'), false, '「不批准」→ 不是批准（否定优先）')
eq(isExplicitApproval('先别开工'), false, '「先别开工」→ 不是批准')
eq(isExplicitApproval('暂不开始'), false, '「暂不开始」→ 不是批准')
eq(isExplicitApproval("don't approve yet"), false, 'en：否定 → 不是批准')
// 边界
eq(isExplicitApproval(''), false, '空串 → 不是批准')
eq(isExplicitApproval(null), false, 'null → 不是批准')
eq(isExplicitApproval('嗯'), false, '模糊答复（「嗯」）→ 不是批准（保守）')
eq(isExplicitApproval('第 6 项的缺省建议我同意'), true, '「缺省建议我同意」→ 批准（有明确「同意」且无修改词）')

console.log('── 6) lastHumanReplySince：取最后一条（三态）──')
const approvalMsg = (t, text) => ({ type: 'user/message', time: t, data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
const auqCallEv = (t, id) => ({ type: 'tool/call', time: t, data: { name: 'ask_user_question', callId: id } })
const auqResultEv = (t, id, answers) => ({ type: 'tool/result', time: t, data: { toolCallId: id, message: { role: 'tool', source: { kind: 'tool', callId: id }, content: [{ type: 'text', text: JSON.stringify({ answers }) }] } } })
eq(lastHumanReplySince(undefined, PAUSE), undefined, 'session 缺失 → undefined（读不到）')
eq(lastHumanReplySince(sessionOf([]), PAUSE), null, '读到了但没人说话 → null')
const emptyMsg = { type: 'user/message', time: PAUSE + 1000, data: { source: { kind: 'user' } } }
eq(lastHumanReplySince(sessionOf([emptyMsg]), PAUSE).text, '', '没有 content ⇒ 文本为空串（但仍算一条人类答复）')
const r1 = lastHumanReplySince(sessionOf([userMsg(PAUSE + 1000)]), PAUSE)
eq(r1 && r1.kind, 'user', '人直接打字 → kind=user')
eq(lastHumanReplySince(sessionOf([auqCallEv(PAUSE + 1000, 'c1'), auqResultEv(PAUSE + 2000, 'c1', ['批准开工'])]), PAUSE).kind, 'auq', 'AUQ 答复 → kind=auq')
eq(hasExplicitApprovalSince(sessionOf([auqCallEv(PAUSE + 1000, 'c1'), auqResultEv(PAUSE + 2000, 'c1', ['批准开工'])]), PAUSE), true,
  'AUQ 选「批准开工」→ 显式批准')
eq(hasExplicitApprovalSince(sessionOf([auqCallEv(PAUSE + 1000, 'c1'), auqResultEv(PAUSE + 2000, 'c1', ['我要改几项'])]), PAUSE), false,
  'AUQ 选「我要改几项」→ **不是**批准')
eq(hasExplicitApprovalSince(sessionOf([approvalMsg(PAUSE + 1000, '加一个 --depth N 参数，默认 0')]), PAUSE), false,
  '人打字说「加一个参数」→ false（这就是本次事故的形态：说过话 ≠ 批准）')
// 以**最后一条**为准：先说「要改」，后说「批准」⇒ 批准
eq(hasExplicitApprovalSince(sessionOf([userMsg(PAUSE + 1000), approvalMsg(PAUSE + 2000, '批准')]), PAUSE), true,
  '先说改、后说批准 → 以最后一条为准（true）')
eq(hasExplicitApprovalSince(sessionOf([{ type: 'user/message', time: PAUSE + 1000, data: { content: [{ type: 'text', text: '批准' }], source: { kind: 'user' } } }, approvalMsg(PAUSE + 2000, '再改一下默认值')]), PAUSE), false,
  '先说批准、后说「再改一下」→ 最后一条是修改 ⇒ false（不拿前面的批准顶上）')
eq(hasExplicitApprovalSince(undefined, PAUSE), undefined, '读不到日志 → undefined（三态，调用方只 warn）')

console.log(failed === 0 ? '\n✅ human-approval 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
