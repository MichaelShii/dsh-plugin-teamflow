/**
 * 工作区 key 迁移 —— 演练（**只读**）
 *
 * 背景：`workspaceScopeOf` 的「用 DSH workspace UUID 作 key」分支当前不可达（宿主
 * `resolveByPath` 是 async，插件同步调用 → `ws.id` 恒 undefined），实际生效的 key 是
 * `slugPath(cwd)` = `ws-<basename>-<sha1(路径)前 8 位>`（见 store.ts）。
 * 后果：key 绑定**路径字符串**——盘符大小写 / 软链 / 尾斜杠 / 移动目录都会裂出一条新产品线，
 * backlog 与 runs 全留在旧 key 下，全局面板里同一个项目出现两条。
 *
 * 本脚本只做演练，不写任何数据：
 *   1. 扫描 `$DSH_HOME/teamflow/<key>/`
 *   2. 从 `runs/*.json` 的 `workspacePath` 反推「这条数据本来属于哪个路径」
 *   3. 用同一套 `slugPath` 重算期望 key，与实际目录名比对 → 分类
 *   4. 按规范化路径分组，产出「并入哪个 key + 有哪些同名内容冲突」的合并计划
 *
 * 运行：node scripts/migrate-workspace-key-dryrun.mjs [--out <report.md>]
 * 注意：本脚本**不修改** `$DSH_HOME` 下任何文件；`--out` 只写报表到指定路径。
 */
import { readdirSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'teamflow')

/** 与 store.ts slugPath 逐字一致（改动必须同步，否则演练结论失真）。 */
function slugPath(p) {
  const raw = String(p || '').replace(/\\/g, '/')
  const base = raw.split('/').filter(Boolean).pop() || 'root'
  const tag = base.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ws'
  const hash = createHash('sha1').update(raw || 'default').digest('hex').slice(0, 8)
  return `ws-${tag}-${hash}`
}

/** 分组用的路径归一化：只抹掉「同一目录的不同写法」，不改语义。 */
function normPath(p) {
  if (!p) return null
  let s = String(p).replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1) // 盘符大小写
  return s
}

const CURRENT_KEY_RE = /^ws-[a-zA-Z0-9_-]+-[0-9a-f]{8}$/
const SKIP_FILE = /\.(bak|tmp|corrupt|bak-manual)$/

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** 递归收集文件 → { rel: {size, sha1} }（只读，不跟随符号链接以外的东西）。 */
function inventory(dir, prefix = '') {
  const out = new Map()
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) { for (const [k, v] of inventory(p, rel)) out.set(k, v); continue }
    if (SKIP_FILE.test(e.name)) continue
    let st, buf
    try { st = statSync(p); buf = readFileSync(p) } catch { continue }
    out.set(rel, { size: st.size, sha1: createHash('sha1').update(buf).digest('hex').slice(0, 12) })
  }
  return out
}

/** 扫一个产品线目录，反推它的来源路径。 */
function scanProduct(key) {
  const dir = join(ROOT, key)
  const runsDir = join(dir, 'runs')
  const paths = new Map() // normPath → { raw, count, latest }
  let runCount = 0
  if (existsSync(runsDir)) {
    let files = []
    try { files = readdirSync(runsDir) } catch { /* ignore */ }
    for (const f of files) {
      if (SKIP_FILE.test(f)) continue
      const j = readJson(join(runsDir, f))
      if (!j || typeof j !== 'object') continue
      runCount++
      const raw = typeof j.workspacePath === 'string' && j.workspacePath ? j.workspacePath : null
      if (!raw) continue
      const n = normPath(raw)
      const prev = paths.get(n)
      const at = Number(j.startedAt) || 0
      if (!prev) paths.set(n, { raw, count: 1, latest: at })
      else { prev.count++; if (at > prev.latest) prev.latest = at }
    }
  }
  const inv = inventory(dir)
  let bytes = 0
  for (const v of inv.values()) bytes += v.size
  return { key, dir, runCount, bytes, files: inv.size, paths, inv }
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}
function fmtDate(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function main() {
  if (!existsSync(ROOT)) { console.error(`未找到 $DSH_HOME/teamflow：${ROOT}`); process.exit(1) }
  let ents = []
  try { ents = readdirSync(ROOT, { withFileTypes: true }) } catch (e) { console.error(`读取失败：${e.message}`); process.exit(1) }

  const dirs = ents.filter((e) => e.isDirectory() && e.name !== '_archive').map((e) => e.name).sort()
  const report = []
  const say = (s) => { console.log(s); report.push(s) }

  say('# 工作区 key 迁移演练（只读 · 未修改任何文件）')
  say('')
  say(`- 扫描根：\`${ROOT}\``)
  say(`- 产品线目录：${dirs.length} 个${ents.some((e) => e.name === '_archive') ? '（另有 `_archive/` 归档目录，本次跳过）' : ''}`)
  say('')

  // ── 1. 逐个分类 ────────────────────────────────────────────────
  const scanned = []
  say('## 一、逐目录分类')
  say('')
  say('| 判定 | 目录 | 反推路径 | runs | 体积 | 说明 |')
  say('| --- | --- | --- | --- | --- | --- |')
  for (const key of dirs) {
    const s = scanProduct(key)
    scanned.push(s)
    const ps = [...s.paths.entries()].sort((a, b) => b[1].count - a[1].count)
    let verdict, note
    const onlyTeams = s.files === 1 && s.inv.has('teams.json')
    if (key === 'default') {
      verdict = 'FALLBACK'
      note = '无 cwd 时的兜底 key（非路径派生，正常存在）'
    } else if (!CURRENT_KEY_RE.test(key)) {
      verdict = 'LEGACY'
      note = '旧格式 key（无 `ws-` 前缀），当前算法已不可能生成'
    } else if (s.paths.size === 0) {
      verdict = s.runCount === 0 ? 'EMPTY' : 'NO-PATH'
      note = s.runCount === 0
        ? (onlyTeams ? '空壳：只写过 teams.json，从未跑过流水线' : '无任何 run 记录')
        : 'journal 未记录 `workspacePath`，无法反推'
    } else if (s.paths.size > 1) {
      verdict = 'MIXED'
      note = `目录内混了 ${s.paths.size} 个不同来源路径`
    } else {
      const [, meta] = ps[0]
      const want = slugPath(meta.raw)
      if (want === key) { verdict = 'OK'; note = 'key 与路径自洽' }
      else { verdict = 'DRIFT'; note = `期望 key \`${want}\`（路径写法变了）` }
    }
    const p0 = ps[0] ? `\`${ps[0][1].raw}\`` + (ps.length > 1 ? ` +${ps.length - 1}` : '') : '—'
    say(`| **${verdict}** | \`${key}\` | ${p0} | ${s.runCount} | ${fmtBytes(s.bytes)} | ${note} |`)
  }
  say('')

  // ── 2b. 结论 ───────────────────────────────────────────────────
  let drift = 0, ok = 0, empty = 0, legacy = 0
  for (const s of scanned) {
    const ps = [...s.paths.keys()]
    if (s.key !== 'default' && !CURRENT_KEY_RE.test(s.key)) legacy++
    else if (ps.length === 1) { if (slugPath([...s.paths.values()][0].raw) === s.key) ok++; else drift++ }
    else if (s.paths.size === 0 && s.runCount === 0) empty++
  }
  say('## 二、结论')
  say('')
  say(`- key 与路径自洽：**${ok}** 条；**漂移（路径写法变了，需合并）：${drift} 条**`)
  say(`- 旧格式 key：${legacy} 条；空壳/空目录：${empty} 条`)
  say(`- **本次是否真有数据分裂：${drift > 0 ? '是' : '否'}**${drift === 0 ? '（分裂是「风险」而非「既成事实」，迁移紧迫性按风险排，不按损失排）' : ''}`)
  say('')

  // ── 3. 按路径分组 → 合并计划 ─────────────────────────────────────
  const groups = new Map() // normPath → [{scan, meta}]
  const orphans = []
  for (const s of scanned) {
    if (s.paths.size === 0) { orphans.push(s); continue }
    for (const [n, meta] of s.paths) {
      if (!groups.has(n)) groups.set(n, [])
      groups.get(n).push({ scan: s, meta })
    }
  }

  say('## 三、合并计划（按规范化路径分组）')
  say('')
  let mergeCount = 0
  for (const [, list] of [...groups.entries()].sort()) {
    if (list.length < 2) continue
    mergeCount++
    // 规范化写法取「任一 journal 里出现过的原始写法」，用它算期望 key
    const raw = list[0].meta.raw
    const want = slugPath(raw)
    const keys = [...new Set(list.map((x) => x.scan.key))]
    // canonical：目录名 == 期望 key 优先；否则 run 数最多；否则体积最大
    const canon = keys.includes(want)
      ? want
      : [...keys].sort((a, b) => {
        const A = scanned.find((s) => s.key === a), B = scanned.find((s) => s.key === b)
        return (B.runCount - A.runCount) || (B.bytes - A.bytes)
      })[0]
    say(`### 组 ${mergeCount} — \`${raw}\``)
    say('')
    say(`- 期望 key（按当前算法重算）：\`${want}\``)
    say(`- 建议保留：**\`${canon}\`**${canon === want ? '（= 期望 key，路径未变）' : '（≠ 期望 key，需连同路径写法一并核对）'}`)
    say('')
    say('| 目录 | 判定 | runs | 体积 | 最近 run |')
    say('| --- | --- | --- | --- | --- |')
    for (const k of keys) {
      const s = scanned.find((x) => x.key === k)
      const meta = list.find((x) => x.scan.key === k)?.meta
      say(`| \`${k}\` | ${k === canon ? '**保留**' : '并入'} | ${s.runCount} | ${fmtBytes(s.bytes)} | ${fmtDate(meta?.latest)} |`)
    }

    // 同名文件内容冲突
    const byRel = new Map()
    for (const k of keys) {
      const s = scanned.find((x) => x.key === k)
      for (const [rel, v] of s.inv) {
        if (!byRel.has(rel)) byRel.set(rel, new Map())
        byRel.get(rel).set(k, v.sha1)
      }
    }
    const conflicts = [], identical = []
    for (const [rel, m] of byRel) {
      if (m.size < 2) continue
      const hashes = new Set(m.values())
      if (hashes.size > 1) conflicts.push(`\`${rel}\`（${[...m.keys()].join(' / ')} 内容不同）`)
      else identical.push(`\`${rel}\`（各侧完全一致，去重即可）`)
    }
    say('')
    say(`- **冲突文件**（需人工定夺保留哪一侧）：${conflicts.length ? conflicts.join('、') : '无'}`)
    if (identical.length) say(`- 同名且内容一致：${identical.length} 个（${identical.slice(0, 5).join('、')}${identical.length > 5 ? ' …' : ''}）`)
    say('')
  }
  if (mergeCount === 0) say('当前没有需要合并的分组（每条路径只对应一个目录）。')
  say('')

  // ── 3. 无法反推 / 空目录 ────────────────────────────────────────
  say('## 四、需人工处理')
  say('')
  if (!orphans.length) say('无。')
  for (const s of orphans) {
    say(`- \`${s.key}\` — ${s.runCount === 0 ? '空目录（0 run）' : `${s.runCount} 个 run 但 journal 无 \`workspacePath\``}，体积 ${fmtBytes(s.bytes)}，文件 ${s.files} 个`)
    if (s.runCount === 0 && s.bytes < 64 * 1024) say(`  - 建议：确认无用后手工归档到 \`_archive/\`（本脚本不删）`)
    else say(`  - 建议：人工比对 run 里的 \`requirement\` / \`runDocs\` 字段找回归属路径`)
  }
  say('')

  say('## 五、下一步')
  say('')
  say('上面的计划**没有落地**。真要迁移需要：')
  say('1. `workspaceScopeOf` 改 `async`，让 UUID 分支真正可达（否则换了 UUID 仍是路径派生）')
  say('2. 按上表把非保留目录的内容合并进保留目录（冲突项逐个定夺，先备份到 `_archive/`）')
  say('3. 合并完成后才改 key 生成逻辑，否则新旧 key 会同时被写入')

  const outIdx = process.argv.indexOf('--out')
  if (outIdx > -1 && process.argv[outIdx + 1]) {
    writeFileSync(process.argv[outIdx + 1], report.join('\n'), 'utf8')
    console.log(`\n报表已写入：${process.argv[outIdx + 1]}`)
  }
}

main()
