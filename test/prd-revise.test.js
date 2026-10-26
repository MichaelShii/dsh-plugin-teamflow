/**
 * dsh-plugin-teamflow — PRD **续跑改写**的判据（纯函数 + 可 mock 的投递循环）。
 *
 * 背景（2026-10-17，issue #11 后续）：确认单上「要改」此前是**重跑整个 PRD 子代理**。
 * 阶段子代理本来就是 continuable，可以对同一个 child 投一条修改要求，让它带着上下文只改那处
 * （实测：第二轮复用第一轮口令，usage input 180 / cacheRead 8448 / output 6）。
 *
 * 本文件锁三件最容易被改坏的事：
 * ① **取文本的字段名** —— `assistant/message` 的文本在 `data.message.content`，**不是** `data.content`
 *    （实机踩过：写成后者会得到空串，然后误判「第二轮没回答」）。
 * ② **结束判据** —— 必须等到 `turn/end`，否则会把第一轮的旧 assistant 文本当第二轮结果。
 * ③ **失败必须回落** —— 超时/空文本/投递失败一律返回 null，绝不返回空串（空串会让 PRD 被写空）。
 */
import { assistantTextOf, lastAssistantText, sumRevisionUsage, canReviseViaChild, revisePrdViaChild, REVISE_WAIT_MS, REVISE_IDLE_MS } from '../host/core/prd-revise.ts'

let failed = 0
const eq = (a, b, m) => {
  const pass = JSON.stringify(a) === JSON.stringify(b)
  if (!pass) { failed++; console.log('  ✗', m, '→ got', JSON.stringify(a), 'want', JSON.stringify(b)) }
  else console.log('  ✓', m)
}
const ok = (c, m) => { if (!c) { failed++; console.log('  ✗', m) } else console.log('  ✓', m) }

const userEv = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } })
const asstEv = (text, usage) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] }, ...(usage ? { usage } : {}) } })
const turnEnd = () => ({ type: 'turn/end', data: {} })

console.log('── 1) assistantTextOf：字段名必须是 data.message.content ──')
eq(assistantTextOf(asstEv('OK-1')), 'OK-1', 'data.message.content → 取到文本')
eq(assistantTextOf({ type: 'assistant/message', data: { content: [{ type: 'text', text: 'X' }] } }), 'X', '兼容旧形态 data.content（只作为兜底）')
eq(assistantTextOf({ type: 'assistant/message', data: {} }), '', '没有 content → 空串（不抛）')
eq(assistantTextOf({ type: 'user/message', data: { content: [{ type: 'text', text: 'U' }] } }), '', 'user/message 不算 assistant 输出')
eq(assistantTextOf(null), '', 'null → 空串')
eq(assistantTextOf({ type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'ans' }] } } }), 'thinkans', '多 block 拼接（reasoning 也有 text，不丢）')

console.log('── 2) lastAssistantText：取 offset 之后最后一个非空 ──')
const evs = [asstEv('第一轮'), userEv('改一下'), asstEv(''), asstEv('第二轮答案'), turnEnd()]
eq(lastAssistantText(evs, 0), '第二轮答案', '全量 → 最后一条非空')
eq(lastAssistantText(evs, 2), '第二轮答案', '从 offset=2 起 → 跳过第一轮')
eq(lastAssistantText(evs, 3), '第二轮答案', 'offset 落在中间也取得到')
eq(lastAssistantText(evs, 99), '', 'offset 越界 → 空串（不抛）')
eq(lastAssistantText(null), '', 'null → 空串')
eq(lastAssistantText([asstEv('  ')], 0), '', '全空白 → 空串（调用方据此回落）')

console.log('── 3) sumRevisionUsage：事件字段 → 插件口径 ──')
const u = sumRevisionUsage(evs, 0)
eq(u, null, '事件里没有 usage 字段 → null（不编造 0 桶；与 accumulateSessionUsage 的空值语义一致）')
const withUsage = [asstEv('a', { inputTokens: 180, outputTokens: 6, cacheReadTokens: 8448, cacheWriteTokens: 0 })]
eq(sumRevisionUsage(withUsage, 0), { input: 180, cacheRead: 8448, cacheWrite: 0, output: 6, calls: 1 }, '单条 usage 正确映射（实机那组数）')
const two = [asstEv('a', { inputTokens: 10, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 2 }), asstEv('b', { inputTokens: 5, outputTokens: 3, cacheReadTokens: 50, cacheWriteTokens: 0 })]
eq(sumRevisionUsage(two, 0), { input: 15, cacheRead: 150, cacheWrite: 2, output: 4, calls: 2 }, '多条累加')
eq(sumRevisionUsage(two, 1), { input: 5, cacheRead: 50, cacheWrite: 0, output: 3, calls: 1 }, '按 offset 切（不重复计第一轮）')
eq(sumRevisionUsage([asstEv('a', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })], 0), null, '全 0 usage → null（不编造 0 桶）')
eq(sumRevisionUsage(null, 0), null, 'null → null')
eq(sumRevisionUsage([asstEv('a', { inputTokens: 'x', outputTokens: -5 })], 0), null, '脏值（字符串/负数）不计 → null')

console.log('── 4) canReviseViaChild：能力判据（缺一即回落）──')
const sub = { sendMessage: async () => 'm' }
const sq = { observeSession: async () => ({ events: [] }) }
eq(canReviseViaChild({ subagents: sub, sessionQuery: sq, childId: 'c1' }), true, '三样齐 → 可用')
eq(canReviseViaChild({ subagents: sub, sessionQuery: sq, childId: '' }), false, '没有 childId → 不可用')
eq(canReviseViaChild({ subagents: sub, sessionQuery: sq, childId: null }), false, 'childId=null → 不可用')
eq(canReviseViaChild({ subagents: {}, sessionQuery: sq, childId: 'c1' }), false, '宿主没有 sendMessage → 不可用（老宿主）')
eq(canReviseViaChild({ subagents: sub, sessionQuery: {}, childId: 'c1' }), false, '没有 observeSession → 不可用')
eq(canReviseViaChild({ subagents: undefined, sessionQuery: sq, childId: 'c1' }), false, 'subagents 缺失 → 不可用')

console.log('── 5) revisePrdViaChild：投递 → 等 turn/end → 取文本 ──')
{
  // 场景 A：正常。投递后事件增长，出现 turn/end 与 assistant 文本
  // ⚠️ 第一轮**必须带 usage**：否则「忽略 offset」的变异体会算出同样的数（夹具无区分力）。
  let events = [userEv('第一轮'), asstEv('OK-1', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 0 }), turnEnd()]
  let sent = null
  const mk = (getEvents) => ({
    subagents: { sendMessage: async (sender, target, content) => { sent = { sender, target, content }; return 'mid' } },
    sessionQuery: { observeSession: async () => ({ events: getEvents() }) },
  })
  const host = mk(() => events)
  const p = revisePrdViaChild({
    ...host, parent: { id: 'p1' }, childId: 'c1', instruction: '改成四格', signal: AbortSignal.timeout(5000),
    waitMs: 400, pollMs: 10,
  })
  // 投递后模拟第二轮落盘
  const after = [userEv('第一轮'), asstEv('OK-1', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheWriteTokens: 0 }), turnEnd(), userEv('改成四格'), asstEv('新 PRD 正文', { inputTokens: 9, outputTokens: 2, cacheReadTokens: 77, cacheWriteTokens: 0 }), turnEnd()]
  const keep = setInterval(() => { events = after }, 20)
  const out = await p
  clearInterval(keep)
  ok(out !== null, '正常路径返回结果（不是 null）')
  eq(out && out.text, '新 PRD 正文', '取到的是**第二轮**文本（不是第一轮的 OK-1）')
  eq(out && out.baseEvents, 3, '基线 = 投递前事件数 3')
  eq(out && out.usage, { input: 9, cacheRead: 77, cacheWrite: 0, output: 2, calls: 1 }, 'usage 只算第二轮（不把第一轮算进去）')
  ok(!!sent && sent.target === 'c1', '确实对指定 child 投递了消息')
}

console.log('── 6) 失败必须回落（返回 null，绝不返回空串）──')
{
  // B：投递失败
  const host = {
    subagents: { sendMessage: async () => { throw new Error('NOT_RESUMABLE') } },
    sessionQuery: { observeSession: async () => ({ events: [turnEnd()] }) },
  }
  eq(await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(2000), waitMs: 100, pollMs: 10 }), null,
    'sendMessage 抛错 → null（调用方回落重跑）')

  // C：一直不长（超时）
  const fixed = [userEv('a'), asstEv('旧')]
  const host2 = {
    subagents: { sendMessage: async () => 'm' },
    sessionQuery: { observeSession: async () => ({ events: fixed }) },
  }
  eq(await revisePrdViaChild({ ...host2, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(2000), waitMs: 150, pollMs: 20 }), null,
    '事件不增长（超时）→ null')

  // D：有 turn/end 但没有 assistant 文本
  let stage = 0
  const emptyAnswer = [userEv('a'), asstEv('旧'), turnEnd()]
  const host3 = {
    subagents: { sendMessage: async () => 'm' },
    sessionQuery: { observeSession: async () => { stage++; return { events: stage === 1 ? [userEv('a'), asstEv('旧'), turnEnd()] : [...emptyAnswer, userEv('改'), turnEnd()] } } },
  }
  eq(await revisePrdViaChild({ ...host3, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(2000), waitMs: 400, pollMs: 10 }), null,
    'turn/end 但无 assistant 文本 → null（不返回空串）')

  // E：observeSession 读不到（基线拿不到）⇒ 不投递
  let sendCount = 0
  const host4 = {
    subagents: { sendMessage: async () => { sendCount++; return 'm' } },
    sessionQuery: { observeSession: async () => { throw new Error('boom') } },
  }
  eq(await revisePrdViaChild({ ...host4, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(2000), waitMs: 100, pollMs: 10 }), null,
    '读不到基线 ⇒ null')
  eq(sendCount, 0, '读不到基线时**不投递**（否则无法区分新旧文本）')

  // F：宿主能力缺失
  eq(await revisePrdViaChild({ subagents: {}, sessionQuery: {}, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(1000) }), null,
    '宿主无能力 → null')
}

console.log('── 7) 默认等待预算 ──')
eq(REVISE_WAIT_MS, 600000, '默认 600s **绝对天花板**（真机 tf-mvovb2gb-her9mv：redo 实跑 377s ⇒ 300s 墙钟会在完工前 77s 放弃、白等 5 分钟、还让两份 PRD 并行跑 77s）')
eq(REVISE_IDLE_MS, 240000, '默认 idle 阈值 240s（真机 redo 的**最大事件间隔是 174s** ⇒ 阈值必须大于它，否则把「正在写」误判成「死了」）')

console.log('── 8) 时间锚点：补加载历史时不能重复计（2026-10-18 真机 tf-mvdixrhs）──')
{
  // 真机形态：投递前 observe 只拿到 1 条，投递后同一 child 补加载了 3 条历史（插在前面）。
  // 老实现 `events.slice(base)`（base=1）⇒ 把 2 条旧事件算进这一轮 ⇒ usage = 全会话累计
  // ⇒ 与 prdUsageAcc 相加翻倍（当时靠重复护栏兜住，但那只是止血）。
  const t0 = 1792308055000
  const oldEv = (i) => ({ type: 'assistant/message', time: t0 - 10000 + i, data: { usage: { inputTokens: 1000 }, message: { content: [{ type: 'text', text: `旧答案${i}` }] } } })
  const newEv = { type: 'assistant/message', time: t0 + 120, data: { usage: { inputTokens: 12, outputTokens: 3 }, message: { content: [{ type: 'text', text: '新 PRD' }] } } }
  const turnEnd = { type: 'turn/end', time: t0 + 200, data: {} }
  const events = [oldEv(1), oldEv(2), oldEv(3), newEv, turnEnd]
  const anchor = { since: t0, index: 1 } // 投递前只有 1 条
  const u = sumRevisionUsage(events, anchor)
  eq(u && u.input, 12, '只算锚点之后的 input（老实现会得 2012）')
  eq(u && u.calls, 1, '只算 1 次调用（老实现会得 3）')

  // 旧锚点（纯下标）用作对照：证明这个场景确实能分辨两种实现
  const byIndex = sumRevisionUsage(events, 1)
  eq(byIndex && byIndex.input, 2012, '对照：纯下标切分会多算（说明判据有牙）')

  eq(lastAssistantText(events, anchor), '新 PRD', '取文本同样只认锚点之后（不拿旧答案）')
  eq(lastAssistantText(events, 1), '新 PRD', '对照：无 time 的事件按位置回落，行为不变')

  // 无 time 的事件（夹具）⇒ 回落 index，不因缺 time 而全放行
  const noTime = [
    { type: 'assistant/message', data: { usage: { inputTokens: 500 }, message: { content: [{ type: 'text', text: '旧' }] } } },
    { type: 'assistant/message', data: { usage: { inputTokens: 7 }, message: { content: [{ type: 'text', text: '新' }] } } },
  ]
  const u2 = sumRevisionUsage(noTime, { since: t0, index: 1 })
  eq(u2 && u2.input, 7, '无 time 的事件回落下标锚点（不会全放行）')
}

console.log('── 9) 等待策略：idle 判据 + 「文件即产物」（2026-10-26 真机 tf-mvovb2gb-her9mv）──')
console.log('   背景：那次 redo 实跑 377s（8 次 edit + 全文重写 + 状态文件更新 + present），')
console.log('   固定 300s 墙钟 ⇒ 插件在它完工前 77s 放弃 ⇒ 白等 5 分钟、丢弃已完成的改写、')
console.log('   还让两份 PRD 并行跑了 77s。修法：放弃判据改「无进展」（idle），天花板抬高；')
console.log('   并且「回合结束但回复无正文 + 产物被改写」按文件即产物判完成。')
{
  // A：死 child（事件零增长）⇒ 在 idle 阈值内就放手，**不等天花板**
  {
    const host = {
      subagents: { sendMessage: async () => 'm' },
      sessionQuery: { observeSession: async () => ({ events: [userEv('a'), asstEv('旧')] }) },
    }
    const t0 = Date.now()
    const out = await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(9000), waitMs: 5000, idleMs: 200, pollMs: 20 })
    eq(out, null, 'A 死 child → null（回落重跑）')
    const spent = Date.now() - t0
    ok(spent < 1500, 'A 在 idle 阈值内就放手（不等 5s 天花板），实测 ' + spent + 'ms')
  }

  // B：慢 child（事件持续增长）⇒ 活到 turn/end 为止，不被 idle 误杀
  {
    const t0 = Date.now()
    const host = {
      subagents: { sendMessage: async () => 'm' },
      sessionQuery: { observeSession: async () => {
        const el = Date.now() - t0
        const n = Math.floor(el / 60) + 1
        const evs = []
        for (let i = 0; i < n; i++) evs.push({ type: 'step/start', time: t0 + 1000 + i })
        if (el > 450) evs.push({ type: 'turn/end', time: t0 + 2000, data: {} }, { type: 'assistant/message', time: t0 + 2001, data: { message: { content: [{ type: 'text', text: '新 PRD' }] } } })
        return { events: evs }
      } },
    }
    const t1 = Date.now()
    const out = await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(9000), waitMs: 5000, idleMs: 300, pollMs: 20 })
    ok(out !== null, 'B 慢 child（事件持续增长）→ 不被 idle 误杀，等到 turn/end')
    eq(out && out.text, '新 PRD', 'B 取到第二轮文本')
    const spent = Date.now() - t1
    ok(spent > 300, 'B 实耗 ' + spent + 'ms > idle 阈值（证明「idle」不是墙钟：有进展就一直等）')
  }

  // C：回合结束 + 回复无正文 + 产物被改写 ⇒ 判完成（文件即产物）
  {
    let fp = 'fp1'
    const t0 = Date.now()
    const host = {
      subagents: { sendMessage: async () => { fp = 'fp2'; return 'm' } },
      sessionQuery: { observeSession: async () => ({ events: [{ type: 'step/start', time: t0 + 1000 }, { type: 'turn/end', time: t0 + 2000, data: {} }] }) },
    }
    const out = await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(3000), waitMs: 1000, idleMs: 500, pollMs: 20, probe: () => fp })
    ok(out !== null, 'C 回合结束 + 产物被改写 + 回复无正文 → 判完成（不再白白回落重跑一遍）')
    eq(out && out.text, '', 'C 聊天正文为空（交付物是文件，不是聊天正文）')
    eq(out && out.artifactChanged, true, 'C artifactChanged=true')
  }

  // D：回合结束 + 回复无正文 + 产物**没变** ⇒ 仍回落 null（不拿旧产物冒充交付）
  {
    const t0 = Date.now()
    const host = {
      subagents: { sendMessage: async () => 'm' },
      sessionQuery: { observeSession: async () => ({ events: [{ type: 'step/start', time: t0 + 1000 }, { type: 'turn/end', time: t0 + 2000, data: {} }] }) },
    }
    const out = await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(3000), waitMs: 1000, idleMs: 500, pollMs: 20, probe: () => 'fp1' })
    eq(out, null, 'D 产物没变 → 仍回落 null（宁可不认，也不拿上一版冒充）')
  }

  // E：产物变更本身算「进展」⇒ 只有文件在动、没有新事件时也不该被判死
  {
    const t0 = Date.now()
    const host = {
      subagents: { sendMessage: async () => 'm' },
      sessionQuery: { observeSession: async () => {
        const el = Date.now() - t0
        const evs = [{ type: 'step/start', time: t0 + 1000 }]
        if (el > 450) evs.push({ type: 'turn/end', time: t0 + 2000, data: {} }, { type: 'assistant/message', time: t0 + 2001, data: { message: { content: [{ type: 'text', text: '新 PRD' }] } } })
        return { events: evs }
      } },
    }
    // 产物在 ~250ms 后被改写；此后**不再有新事件**，turn/end 迟迟不来
    const out = await revisePrdViaChild({ ...host, parent: {}, childId: 'c', instruction: 'x', signal: AbortSignal.timeout(9000), waitMs: 5000, idleMs: 300, pollMs: 20, probe: () => (Date.now() - t0 > 250 ? 'fp2' : 'fp1') })
    ok(out !== null, 'E 产物在动 ⇒ 算进展，不被判死（等到了 turn/end）')
    eq(out && out.text, '新 PRD', 'E 取到第二轮文本')
  }
}

console.log(failed === 0 ? '\n✅ prd-revise 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
