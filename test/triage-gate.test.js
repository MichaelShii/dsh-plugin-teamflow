/**
 * dsh-plugin-teamflow — 需求澄清闸门（Phase 1）纯函数与兜底行为测试。
 *
 * 覆盖两件容易悄悄回退的东西：
 *  1) **合格线（qualifyBlockers）**：三条证据（≥2 互斥读法 / 影响面 / 返工代价）齐备才留，
 *     缺一即丢并计数 —— 这是「防仪式化」的判定点（模型几乎总能为任何需求凑出问题）。
 *  2) **兜底绝不拦启动**：分诊不可用（无 subagents）走 fallbackVerdict → intent=requirement、blockers=[]，
 *     即零回归（闸门只在模型明确说「这还不是明确需求」时才拦）。
 * 另外锁住意图归一（非法值一律 requirement，绝不因字段缺失拦启动）。
 */
import { qualifyBlockers, normalizeIntent, runTriage, TRIAGE_INTENTS } from '../host/core/triage.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

console.log('\n[1] 意图归一：非法/缺失一律 requirement（绝不因模型没给字段就拦启动）')
ok(normalizeIntent('requirement') === 'requirement', "requirement → requirement")
ok(normalizeIntent('exploration') === 'exploration', "exploration → exploration")
ok(normalizeIntent('feedback') === 'feedback', "feedback → feedback")
ok(normalizeIntent(undefined) === 'requirement', 'undefined → requirement')
ok(normalizeIntent(null) === 'requirement', 'null → requirement')
ok(normalizeIntent('') === 'requirement', '空串 → requirement')
ok(normalizeIntent('EXPLORATION') === 'requirement', '大小写不匹配 → requirement（不做模糊匹配，避免误拦）')
ok(normalizeIntent(0) === 'requirement' && normalizeIntent({}) === 'requirement', '非字符串 → requirement')
ok(TRIAGE_INTENTS.length === 3, '意图枚举恰为三档（requirement/exploration/feedback）')

console.log('\n[2] 合格线：三条证据齐备才留')
const full = { question: '要不要兼容旧 API？', readings: ['保持旧签名并新增可选参数', '直接改签名（破坏性）'], changes: 'PRD 的兼容性 AC 与 dev 改动面', rework: 'dev 全部任务 + QA 回归重跑' }
ok(qualifyBlockers([full]).blockers.length === 1, '齐备 → 保留')
ok(qualifyBlockers([full]).dropped === 0, '齐备 → dropped 0')
ok(qualifyBlockers([{ ...full, readings: ['只有一种读法'] }]).blockers.length === 0, '只有 1 种读法 → 丢弃（不是真歧义）')
ok(qualifyBlockers([{ ...full, readings: [] }]).blockers.length === 0, '读法为空 → 丢弃')
ok(qualifyBlockers([{ ...full, readings: ['a', '', '   ', 'b'] }]).blockers.length === 1, '读法里的空串被过滤后仍够 2 条 → 保留')
ok(qualifyBlockers([{ ...full, readings: ['a', '', ''] }]).blockers.length === 0, '过滤后只剩 1 条 → 丢弃')
ok(qualifyBlockers([{ ...full, changes: '' }]).blockers.length === 0, '缺「影响面」→ 丢弃')
ok(qualifyBlockers([{ ...full, rework: '   ' }]).blockers.length === 0, '缺「返工代价」→ 丢弃')
ok(qualifyBlockers([{ ...full, question: '' }]).blockers.length === 0, '缺问题本身 → 丢弃')
ok(qualifyBlockers([full, { question: 'x' }]).dropped === 1, '一好一坏 → 坏的计入 dropped（诊断可见）')
ok(qualifyBlockers([null, 'x', 3, []].length ? [null, 'x', 3, []] : []).dropped === 4, '非对象条目全部计入 dropped')
ok(qualifyBlockers(undefined).blockers.length === 0 && qualifyBlockers(undefined).dropped === 0, '非数组输入 → 空且 dropped 0（不误报）')
ok(qualifyBlockers('nope').blockers.length === 0, '字符串输入 → 空')
const five = [full, { ...full, question: 'b' }, { ...full, question: 'c' }, { ...full, question: 'd' }, { ...full, question: 'e' }]
const capped = qualifyBlockers(five)
ok(capped.blockers.length === 3, '上限 3 条（超过的不问，防一次抛一堆问题）')
ok(capped.dropped === 2, '超额部分计入 dropped')
ok(qualifyBlockers([{ ...full, question: 'q'.repeat(999) }]).blockers[0].question.length <= 300, '问题文本截断 ≤300 字符')
const longReadings = qualifyBlockers([{ ...full, readings: ['r'.repeat(999), 'r2'] }]).blockers[0].readings
ok(longReadings.length === 2 && longReadings[0].length <= 200, '读法截断 ≤200 字符、条数 ≤4')

console.log('\n[3] 兜底路径绝不拦启动（无 subagents → fallbackVerdict）')
const fx = await runTriage('给登录页加个记住我勾选框', { needDesign: false }, undefined, undefined, 'zh')
ok(fx.source === 'fallback', '无 subagents → source=fallback（分诊不可用时退回正则兜底）')
ok(fx.intent === 'requirement', '兜底 intent=requirement（绝不拦）')
ok(Array.isArray(fx.blockers) && fx.blockers.length === 0, '兜底 blockers 为空（绝不拦）')
ok(fx.blockersDropped === 0, '兜底 blockersDropped=0')
ok(typeof fx.mode === 'string' && fx.mode.length > 0, '兜底仍给出档位（路由不因闸门失效）')

console.log(failed ? `\n✗ triage-gate：${failed} 条失败\n` : '\n✓ triage-gate：全部通过\n')
process.exit(failed ? 1 : 0)
