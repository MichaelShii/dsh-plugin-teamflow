/**
 * instruction-budget test（无外部依赖，node test/instruction-budget.test.js 直接运行）
 *
 * 守门对象 = AGENTS.md —— 每个会话都会进上下文的「当前状态」入口文件。
 *
 * 1) 总体积 ≤ INSTRUCTION_BUDGET_BYTES：宿主 workspace 指令预算是 64 KiB，本文件不得吃掉大半。
 *    实锤：本文件曾涨到 64,134 B（占预算 98%），宿主直接 `omitted ~/.dsh/AGENTS.md`
 *    —— 用户自己的全局规则被整份丢弃。
 * 2) §5 行为锚点 ≤ ANCHOR_SECTION_BYTES，每行 ≤ ANCHOR_ROW_CHARS：§5 是唯一会持续膨胀的段落，
 *    曾占全文 74%（47,456 B / 19 行，最长单行 7,386 B ≈ 2k token）。
 * 3) 本文件**不得写历史**——日期 / runId / 「实锤」一律迁 docs/anchors/（可检索层，不注入会话）。
 *    这条正是 AGENTS.md §6 自己定的规则（「历史不注入本文件」），此前被 §5 的事故复盘违反。
 * 4) §5 每行末尾的锚点详情文档必须真实存在（防指针悬空）；docs/anchors/ 里不得有孤儿文件。
 * 5) §2 文档索引提到的每个 test/*.js 必须真实存在（防"索引写了、门禁没跑"）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const AGENTS = join(rootDir, 'AGENTS.md')
const ANCHOR_DIR = join(rootDir, 'docs', 'anchors')

/** 全文体积上限（含 §1-4 的结构树与文档索引）。 */
const INSTRUCTION_BUDGET_BYTES = 22 * 1024
/** §5 行为锚点段体积上限。 */
const ANCHOR_SECTION_BYTES = 6 * 1024
/** §5 单行「不变量」字符数上限。 */
const ANCHOR_ROW_CHARS = 400
/** §5 至少要有多少条锚点（防"把锚点删空"式通过）。 */
const ANCHOR_MIN_ROWS = 15

let failed = 0
const ok = (label, detail = '') => console.log(`✅ ${label}${detail ? ` —— ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failed++
  console.log(`❌ ${label}${detail ? ` —— ${detail}` : ''}`)
}
const bytes = (s) => Buffer.byteLength(s, 'utf8')

// ── 读文件 + 切段 ────────────────────────────────────────────────────────────
if (!existsSync(AGENTS)) {
  bad('AGENTS.md 存在')
  process.exit(1)
}
const text = readFileSync(AGENTS, 'utf8')
const lines = text.split('\n')
const i5 = lines.findIndex((l) => l.startsWith('## 5.'))
const i6 = lines.findIndex((l) => l.startsWith('## 6.'))
if (i5 < 0 || i6 <= i5) {
  bad('AGENTS.md 含有 §5 / §6 两段')
  process.exit(1)
}

// ── 1) 总体积 ───────────────────────────────────────────────────────────────
const total = bytes(text)
if (total <= INSTRUCTION_BUDGET_BYTES) {
  const left = INSTRUCTION_BUDGET_BYTES - total
  ok('总体积在预算内', `${total} B ≤ ${INSTRUCTION_BUDGET_BYTES} B（余 ${left} B）`)
} else {
  bad('总体积超预算', `${total} B > ${INSTRUCTION_BUDGET_BYTES} B —— 论证迁 docs/anchors/，本文件只留不变量`)
}

// ── 2) §5 体积与单行长度 ────────────────────────────────────────────────────
const anchorLines = lines.slice(i5, i6)
const sectionBytes = bytes(anchorLines.join('\n'))
if (sectionBytes <= ANCHOR_SECTION_BYTES) {
  ok('§5 体积在预算内', `${sectionBytes} B ≤ ${ANCHOR_SECTION_BYTES} B`)
} else {
  bad('§5 超预算', `${sectionBytes} B > ${ANCHOR_SECTION_BYTES} B —— 把论证/实锤迁到 docs/anchors/<主题>.md`)
}
const rows = anchorLines.filter((l) => l.startsWith('| ') && !l.startsWith('|---') && !/^\|\s*锚点\s*\|/.test(l))
if (rows.length >= ANCHOR_MIN_ROWS) ok('§5 锚点条数', `${rows.length} 条 ≥ ${ANCHOR_MIN_ROWS}`)
else bad('§5 锚点条数不足', `${rows.length} < ${ANCHOR_MIN_ROWS}`)
for (const row of rows) {
  const name = (row.split('|')[1] || '').trim()
  const cell = (row.split('|')[2] || '').trim()
  if (cell.length > ANCHOR_ROW_CHARS) {
    bad('§5 锚点行过长', `「${name}」${cell.length} 字符 > ${ANCHOR_ROW_CHARS} —— 只留不变量，论证迁 anchors/`)
  }
}

// ── 3) 不许写历史（日期 / runId / 实锤） ─────────────────────────────────────
const HISTORY_PATTERNS = [
  [/20\d\d-\d\d/, '日期'],
  [/tf-[a-z0-9]{6,}/i, 'runId'],
  [/probe-[a-z0-9]+/i, '探针目录名'],
  [/实锤/, '「实锤」式事故复盘'],
]
const historyHits = []
lines.forEach((line, i) => {
  for (const [re, label] of HISTORY_PATTERNS) {
    if (re.test(line)) historyHits.push(`L${i + 1} [${label}] ${line.slice(0, 60)}`)
  }
})
if (historyHits.length === 0) {
  ok('未写历史（无日期 / runId / 实锤）', '历史进 docs/devlog.md 与 docs/anchors/')
} else {
  bad('本文件含历史内容', `${historyHits.length} 处 → 迁 docs/anchors/ 或 docs/devlog.md`)
  for (const h of historyHits.slice(0, 8)) console.log(`     ${h}`)
}

// ── 4) 锚点指针双向校验 ─────────────────────────────────────────────────────
const referenced = new Set()
const missing = []
for (const row of rows) {
  const name = (row.split('|')[1] || '').trim()
  const found = [...row.matchAll(/`(anchors\/[a-z0-9-]+\.md)`/g)].map((m) => m[1].replace('anchors/', ''))
  if (found.length === 0) {
    bad('§5 锚点缺少详情指针', `「${name}」应以 \`anchors/<主题>.md\` 结尾`)
    continue
  }
  for (const file of found) {
    referenced.add(file)
    if (!existsSync(join(ANCHOR_DIR, file))) missing.push(`「${name}」→ docs/anchors/${file}`)
  }
}
if (missing.length === 0) ok('§5 锚点详情文档均存在', `${referenced.size} 份`)
else {
  bad('§5 指针悬空', `${missing.length} 处`)
  for (const m of missing) console.log(`     ${m}`)
}
// 反向：AGENTS.md 任何地方提到的 anchors/*.md 都必须存在（§2/§3/§4 也有指针）
const allRefs = [...text.matchAll(/anchors\/([a-z0-9-]+\.md)/g)].map((m) => m[1])
for (const file of new Set(allRefs)) {
  if (!existsSync(join(ANCHOR_DIR, file))) bad('AGENTS.md 指针悬空', `docs/anchors/${file} 不存在`)
}
const orphans = existsSync(ANCHOR_DIR)
  ? readdirSync(ANCHOR_DIR).filter((f) => f.endsWith('.md') && f !== 'README.md' && !allRefs.includes(f))
  : []
if (orphans.length === 0) ok('docs/anchors/ 无孤儿文档')
else bad('docs/anchors/ 存在未被 AGENTS.md 引用的文档', orphans.join(', '))

// ── 5) §2 索引里的 test/*.js 必须真实存在 ───────────────────────────────────
const indexed = [...lines.slice(0, i5).join('\n').matchAll(/`test\/([a-z0-9-]+\.(?:test\.)?js)`/g)].map((m) => m[1])
const noFile = [...new Set(indexed)].filter((f) => !existsSync(join(rootDir, 'test', f)))
if (noFile.length === 0) ok('§2 索引的测试文件都存在', `${new Set(indexed).size} 个`)
else bad('§2 索引指向不存在的测试文件', noFile.join(', '))

console.log(
  failed === 0
    ? `\ninstruction-budget: 全部通过（AGENTS.md ${total} B / §5 ${sectionBytes} B / ${rows.length} 条锚点）`
    : `\ninstruction-budget: ${failed} 项失败`,
)
process.exit(failed === 0 ? 0 : 1)
