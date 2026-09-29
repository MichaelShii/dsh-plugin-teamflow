/**
 * dsh-plugin-teamflow — 澄清闸门埋点（clarify-log）行为测试（ADR-0010 D1/D2）。
 *
 * **为什么值得单独一个测试文件**：本模块存在的唯一理由就是「澄清命中时**不建 run**，那次裁决不落盘」——
 * 即 `journal.triage.blockers` 结构上记不到闸门有没有工作（2026-09-30 曾据此统计得出「闸门从未触发」
 * 的反结论）。所以这里必须锁住「不建 run 也留下记录」以及「事件流是追加而非覆盖」两条。
 *
 * 本文件自带 $DSH_HOME 临时目录，绝不碰真实 home。
 */
import { mkdtempSync, rmSync, appendFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  clarifyLogFile, requirementFp, noteClarifyAsked, noteTriageFallback,
  noteClarifyAnswered, noteClarifyProceeded, readClarifyLog, clarifyRounds,
} from '../host/core/clarify-log.ts'

let pass = 0, fail = 0
const ok = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label) } else { fail++; console.error('  ✗ ' + label) } }

const home = mkdtempSync(join(tmpdir(), 'tf-clarify-'))
process.env.DSH_HOME = home

const P = 'probe'
const REQ = '做一个简易版的贪吃蛇'

console.log('── 1) 落点与指纹 ──')
ok(clarifyLogFile(P) === join(home, 'teamflow', P, 'clarify.jsonl'), '落点 = $DSH_HOME/teamflow/<product>/clarify.jsonl')
ok(!existsSync(clarifyLogFile(P)), '未写入前文件不存在（不臆造空文件）')
ok(requirementFp(REQ) === requirementFp(REQ), '指纹稳定（同一需求两次相同）')
ok(requirementFp(REQ) !== requirementFp(REQ + '2'), '不同需求指纹不同')
ok(requirementFp('  ' + REQ + '  ') === requirementFp(REQ), '指纹先 trim（两侧取值路径不同，尾随空白不该裂成两个身份）')
ok(requirementFp(null).length === 12 && requirementFp(undefined).length === 12, '空值也给 12 位指纹，不抛')

console.log('── 2) asked：闸门命中（不建 run 的那一次）──')
const blockers = [
  { settles: 'ui', question: '运行形态：网页还是 CLI？', readings: ['网页版', '命令行'], changes: '交付形态与验收方式', rework: '设计+开发' },
  { settles: 'scope', question: '要不要最高分/暂停？', readings: ['基础版', '含扩展'], changes: 'AC 覆盖', rework: '开发+QA' },
]
noteClarifyAsked(P, REQ, { intent: 'exploration', blockers, blockersDropped: 1, source: 'model', mode: 'lite', confidence: 'low' }, 'preflight')
const log1 = readClarifyLog(P)
ok(log1.length === 1, '一次提问 = 一行')
ok(log1[0].event === 'asked' && log1[0].origin === 'preflight', '事件与来源正确')
ok(log1[0].fp === requirementFp(REQ), '带需求指纹（跨调用关联键）')
ok(log1[0].intent === 'exploration' && log1[0].mode === 'lite' && log1[0].confidence === 'low', '带分诊裁决字段')
ok(Array.isArray(log1[0].blockers) && log1[0].blockers.length === 2, '带提问内容（2 条）')
ok(log1[0].blockers[0].settles === 'ui' && log1[0].blockers[0].question.indexOf('运行形态') === 0, 'blocker 保留 settles + 问句')
ok(log1[0].blockersDropped === 1, '带资格线丢弃条数（连「提了不合格」也可见）')
ok(typeof log1[0].at === 'number' && log1[0].at > 0, '带时间戳')
ok(clarifyRounds(P, REQ) === 1, '轮次推导 = 1')

console.log('── 3) 截断：事件流不能无限长 ──')
const longReq = 'x'.repeat(400)
noteClarifyAsked(P, longReq, { blockers: [{ settles: 'other', question: 'q'.repeat(300) }] }, 'pipeline')
const l = readClarifyLog(P)
const rec = l[l.length - 1]
ok(rec.requirement.length === 200, '需求原文截断 200')
ok(rec.blockers[0].question.length === 160, 'blocker 问句截断 160')
ok(rec.fp === requirementFp(longReq), '指纹用完整原文（不随展示截断而变）')

console.log('── 4) 另外三类事件 ──')
noteTriageFallback(P, '我想开发一个 dsh 插件', { reason: 'empty/unparseable verdict (stopReason=completed)', mode: 'medium' }, 'preflight')
noteClarifyAnswered(P, REQ, { runId: 'tf-x', supplement: '用户澄清轮次答复：网页版', mode: 'medium' })
noteClarifyProceeded(P, REQ, { runId: 'tf-x', assumed: 2 })
const all = readClarifyLog(P)
const byEvent = (e) => all.filter((r) => r.event === e)
ok(byEvent('triage-fallback').length === 1, 'triage-fallback 落盘（闸门静默失效可见）')
ok(String(byEvent('triage-fallback')[0].reason).indexOf('unparseable') >= 0, 'fallback 带原因（能区分超时 / 解析失败）')
ok(byEvent('answered').length === 1, 'answered 落盘')
ok(byEvent('answered')[0].runId === 'tf-x' && byEvent('answered')[0].supplementLength === 12, 'answered 带 runId + 答复长度')
ok(byEvent('answered')[0].origin === 'pipeline', 'answered 来源 = pipeline')
ok(byEvent('proceeded-with-assumptions')[0].assumed === 2, 'proceeded 带残余 blocker 条数')

console.log('── 5) 事件流是追加而非覆盖（D2：不得只留最新）──')
const raw = readFileSync(clarifyLogFile(P), 'utf8')
ok(readClarifyLog(P).length === 5, '5 次调用 = 5 行（append-only）')
ok(raw.split('\n').filter((s) => s.trim()).length === 5, '每行一个 JSON（JSONL 形态）')
ok(raw.indexOf('"at"') === raw.indexOf('{') + 1, '首行以 at 开头（结构稳定，可直接 jq）')

console.log('── 6) 轮次推导：同一需求问两次 = 2 轮 ──')
noteClarifyAsked(P, REQ, { intent: 'requirement' }, 'pipeline')
ok(clarifyRounds(P, REQ) === 2, 'asked 计数 = 2')
ok(clarifyRounds(P, '另一个需求') === 0, '没问过的需求 = 0')
ok(clarifyRounds(P, longReq) === 1, '不同需求各自计数（互不串号）')

console.log('── 7) 容错：观测是旁路，绝不因坏数据 / 坏路径抛错 ──')
appendFileSync(clarifyLogFile(P), 'not-json\n\n{"broken": \n', 'utf8')
let threw = false
let after = []
try { after = readClarifyLog(P) } catch (e) { threw = true }
ok(!threw, '损坏行不抛异常')
ok(after.length === 6, '损坏行被跳过，完好事件仍可读（6 条）')
ok(readClarifyLog('不存在的产品').length === 0, '不存在的产品 → 空数组，不抛')
ok(noteClarifyAsked('../escape', REQ, {}, 'preflight') === true, '危险 product 名仍能写（退化到 default，不穿越 $DSH_HOME）')
ok(existsSync(join(home, 'teamflow', 'default', 'clarify.jsonl')), '危险名未穿越：落在 default 槽位')

rmSync(home, { recursive: true, force: true })
console.log('\nclarify-log: ' + pass + ' 通过 / ' + fail + ' 失败')
if (fail > 0) process.exit(1)
