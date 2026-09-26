/**
 * changelog test（无外部依赖，node test/changelog.test.js 直接运行）
 *
 * CHANGELOG 是**随 npm 包发给用户**的升级决策文档（`package.json` files 白名单里有它），
 * 不是 agent 上下文——所以它的门禁只管两件（2026-09 定的 A 方案，不做大搬迁）：
 *
 * 1) 每个**已发布**版本段（`## [v] - YYYY-MM-DD`）必须有 `docs/releases/v.md`：
 *    详细论证（取证 / 源码坐标 / 事故复盘）的归处是发布说明，CHANGELOG 只留用户可感知的变更。
 * 2) 版本标题行之外**不得沉淀历史**——日期 / runId / 探针目录名 / 源码坐标（`x.ts:NN`）命中总数**只减不增**。
 *    存量基线见 GRANDFATHERED_HITS：门禁落地前未发布段（[0.2.0]）已累积的取证尚未迁移，
 *    发 0.2.0 时随论证一起收口到 `docs/releases/v0.2.0.md`，届时该数应归零（基线只减不增）。
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILE = join(rootDir, 'CHANGELOG.md')

/**
 * 存量历史性内容命中基线，只减不增。实测 50：
 *   未发布段 [0.2.0] 44（日期 10 / runId 7 / 探针目录名 19 / 源码坐标 8）
 *   已发布段 6 —— 仅 [0.1.9] 2 处与 [0.1.3] 4 处（其余已发布段为 0）
 * 发布 0.2.0 时应把该段论证迁入 `docs/releases/v0.2.0.md` 并把此数下调（目标 6 → 0）。
 */
const GRANDFATHERED_HITS = 50

let failed = 0
const ok = (label, detail = '') => console.log(`✅ ${label}${detail ? ` —— ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failed++
  console.log(`❌ ${label}${detail ? ` —— ${detail}` : ''}`)
}

if (!existsSync(FILE)) {
  bad('CHANGELOG.md 存在')
  process.exit(1)
}
const lines = readFileSync(FILE, 'utf8').split('\n')

// ── ① 已发布版本段必须有发布说明 ─────────────────────────────────────────────
const released = []
for (const line of lines) {
  const m = /^## \[([\d.]+)\] - \d{4}-\d{2}-\d{2}/.exec(line)
  if (m) released.push(m[1])
}
if (released.length === 0) bad('能解析出已发布版本段', '一个都没解析到，检查标题格式')
const noNote = released.filter((v) => !existsSync(join(rootDir, 'docs', 'releases', `v${v}.md`)))
if (noNote.length === 0) ok('已发布版本都有发布说明', `${released.length} 个：${released.join(', ')}`)
else bad('已发布版本缺 docs/releases/<v>.md', noNote.join(', '))

// ── ② 版本标题行之外不得沉淀历史（棘轮：只减不增） ───────────────────────────
const HISTORY_PATTERNS = [
  [/20\d\d-\d\d-\d\d/g, '日期'],
  [/tf-[a-z0-9]{6,}/gi, 'runId'],
  [/probe-[a-z0-9]+/gi, '探针目录名'],
  [/[\w./\\-]+\.ts:\d+/g, '源码坐标'],
]
const hits = []
let total = 0
lines.forEach((line, i) => {
  if (line.startsWith('## [')) return // 版本标题行：发布日期是必要信息
  for (const [re, label] of HISTORY_PATTERNS) {
    const found = line.match(re)
    if (found && found.length > 0) {
      total += found.length
      hits.push(`L${i + 1} [${label}] ${line.slice(0, 56)}`)
    }
  }
})
if (total <= GRANDFATHERED_HITS) {
  ok('历史性内容未增加', `命中 ${total} ≤ 基线 ${GRANDFATHERED_HITS}（存量债务：发布 0.2.0 时迁 docs/releases/v0.2.0.md）`)
} else {
  bad('历史性内容增加', `命中 ${total} > 基线 ${GRANDFATHERED_HITS} —— 取证/日期/runId/源码坐标请写 docs/devlog.md 或 docs/releases/<v>.md`)
  for (const h of hits.slice(0, 8)) console.log(`     ${h}`)
}

console.log(
  failed === 0
    ? `\nchangelog: 全部通过（${released.length} 个已发布版本 / 历史性命中 ${total}）`
    : `\nchangelog: ${failed} 项失败`,
)
process.exit(failed === 0 ? 0 : 1)
