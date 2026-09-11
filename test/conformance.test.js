/**
 * dsh-plugin-teamflow — L2 回放语料一致性评测（conformance）。
 *
 * 行业对应物：golden corpus 回归门禁（确定性判据，零 LLM 成本）。
 * 语料 = docs/benchmarks/corpus/ 冻结的真实形状阶段产物（含历史实证坑）；
 * 本运行器把每份语料喂给**宿主真实解析器**（host/util.ts + core/backlog.ts），
 * 断言解析结果 == manifest 期望值。
 *
 * 用途：改动 prompt / 解析器 / 注入格式后跑本文件——任何冻结边界回归立刻显形
 * （如验收结论行措辞改了 → parseAcceptanceVerdict 解析的语料失配）。
 * 新增语料：corpus/ 放新文件 + manifest.json 加条目（parser 须为本文件支持的真实解析器）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseAcceptanceVerdict, extractVerificationEvidence, extractBlueprint, judgeDeliverable } from '../host/util.ts'
import { parseDefects } from '../host/core/backlog.ts'

const here = dirname(fileURLToPath(import.meta.url))
const corpusDir = join(here, '../docs/benchmarks/corpus')
const manifestPath = join(corpusDir, 'manifest.json')

if (!existsSync(manifestPath)) {
  console.error(`✗ manifest 缺失：${manifestPath}`)
  process.exit(1)
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

let failed = 0
const fail = (msg) => { console.error(`    ✗ ${msg}`); failed++ }

/** 解析器分发（manifest.parsers 声明的真实宿主解析器；`meta` = manifest 条目，供阶段相关解析器取 phase）。 */
function runParser(parser, text, meta) {
  switch (parser) {
    case 'parseDefects': return parseDefects(text)
    case 'parseAcceptanceVerdict': return parseAcceptanceVerdict(text)
    case 'extractVerificationEvidence': return extractVerificationEvidence(text)
    case 'extractBlueprint': return extractBlueprint(text)
    case 'judgeDeliverable': return judgeDeliverable((meta && meta.phase) || 'dev', text)
    default: throw new Error(`未知 parser: ${parser}`)
  }
}

/** 期望值比较（按 parser 语义不同）。返回是否通过。 */
function matches(parser, actual, expect, caseId) {
  if (parser === 'parseDefects') {
    const same = JSON.stringify(actual) === JSON.stringify(expect)
    if (!same) fail(`${caseId} 期望 ${JSON.stringify(expect)}，实得 ${JSON.stringify(actual)}`)
    return same
  }
  if (parser === 'parseAcceptanceVerdict') {
    if (actual !== expect) fail(`${caseId} 期望 verdict=${expect}，实得 ${actual}`)
    return actual === expect
  }
  if (parser === 'extractVerificationEvidence') {
    if (expect === null) {
      if (actual !== null) fail(`${caseId} 期望无证据块(null)，实得块内容`)
      return actual === null
    }
    const need = (expect && expect.contains) || []
    const misses = need.filter((s) => !actual || !actual.includes(s))
    if (misses.length) fail(`${caseId} 证据块缺片段: ${misses.join(' | ')}`)
    return misses.length === 0
  }
  if (parser === 'extractBlueprint') {
    if (expect === null) {
      if (actual !== null) fail(`${caseId} 期望蓝图解析失败(null)，实得对象`)
      return actual === null
    }
    const problems = []
    if (expect.nonNull && actual === null) problems.push('期望解析成功，实得 null')
    if (actual !== null) {
      if (typeof expect.taskCount === 'number' && actual.tasks.length !== expect.taskCount) {
        problems.push(`期望任务数 ${expect.taskCount}，实得 ${actual.tasks.length}`)
      }
      if (typeof expect.summaryContains === 'string' && !actual.summary.includes(expect.summaryContains)) {
        problems.push(`期望 summary 含「${expect.summaryContains}」，实得「${actual.summary}」`)
      }
    }
    problems.forEach((p) => fail(`${caseId} ${p}`))
    return problems.length === 0
  }
  if (parser === 'judgeDeliverable') {
    const problems = []
    if (typeof expect.ok === 'boolean' && actual.ok !== expect.ok) problems.push(`期望 ok=${expect.ok}，实得 ${actual.ok}`)
    if (typeof expect.reason === 'string' && actual.reason !== expect.reason) problems.push(`期望 reason=${expect.reason}，实得 ${actual.reason}`)
    if (typeof expect.refusalPhrase === 'string' && (!actual.refusal || actual.refusal.phrase !== expect.refusalPhrase)) {
      problems.push(`期望命中措辞「${expect.refusalPhrase}」，实得 ${actual.refusal ? actual.refusal.phrase : 'null'}`)
    }
    problems.forEach((p) => fail(`${caseId} ${p}`))
    return problems.length === 0
  }
  fail(`${caseId} 未知 parser 语义: ${parser}`)
  return false
}

console.log(`── L2 回放语料一致性（corpus/${manifest.cases.length} 份 · manifest v${manifest.version}）──`)
const unused = readdirSync(corpusDir).filter((f) => f !== 'manifest.json' && f.endsWith('.md'))
let passed = 0
for (const c of manifest.cases) {
  const file = join(corpusDir, c.file)
  if (!existsSync(file)) { fail(`${c.id} 语料文件缺失: ${c.file}`); continue }
  const text = readFileSync(file, 'utf8')
  let actual
  try {
    actual = runParser(c.parser, text, c)
  } catch (e) {
    fail(`${c.id} 解析器执行异常: ${e && e.message}`)
    continue
  }
  if (matches(c.parser, actual, c.expect, c.id)) {
    passed++
    console.log(`  ✓ ${c.id} [${c.parser}] — ${c.note || c.file}`)
  } else {
    console.error(`  ✗ ${c.id} [${c.parser}] — ${c.note || c.file}`)
  }
}
// 防呆：语料文件必须都被 manifest 引用（新增未登记的语料 = 没有评测，等于没测）
const referenced = manifest.cases.map((c) => c.file)
const orphans = unused.filter((f) => !referenced.includes(f))
if (orphans.length) {
  console.error(`  ⚠ 未登记语料文件（无评测=无门禁）：${orphans.join(', ')}`)
  failed++
}

console.log(failed === 0 ? `\n✅ conformance 全部通过（${passed}/${manifest.cases.length}）` : `\n❌ conformance ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
