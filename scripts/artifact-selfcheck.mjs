/**
 * 产物自洽探针（host 侧客观判定，模型无关）
 *
 * 解决 A/B 对照实验（docs/benchmarks/craft-ab-pomodoro.md）里暴露的一个真问题：
 * **「写详细」不等于「写完自洽」** —— A 组 DESIGN 一边给 r=130/stroke16、一边给字号 clamp(…,112px)，
 * 两者必然压线，dev 忠实照做 ⇒ 冲突被原样实现。当时这两个数是人工量的，跑一次换一轮，不可复现。
 *
 * 本探针把三判据固化成可复跑命令（纯静态解析，不需要浏览器，不假设模型能力）：
 *   [geo]  几何自洽   —— 圆环/定尺容器的可用半径 vs 居中文字的外接半对角
 *   [bind] 未绑定按钮 —— DOM/JSX 里声明了 <button>，产物源码却完全没提它的 id/class/data-* ⇒ 点击无反应
 *   [bind] 歧义选择器 —— querySelector('[attr]') 命中多个元素时只有首个拿到 handler，其余是死的
 *
 * ⚠ **必须打覆盖，不许空集通过**（2026-10-02：原版只把 `.js` 当 JS 源，遇 Vite+React+TS(X)
 * 产物时源码全是 `.tsx/.ts/.css` ⇒ 零文件被扫，bind 判据完全空转，输出「全部通过」是假绿）。
 * 因此：① 源码语料 = `.js/.jsx/.ts/.tsx/.mjs/.cjs`（含内联 <script>）；② 每条判据结束时打印
 * 「扫了多少文件 / 多少条声明」；③ 该判据无判定时显式打印 N/A，而不是什么都不说。
 *
 * 用法：node scripts/artifact-selfcheck.mjs <产物目录> [<产物目录> ...]
 * 退出码：任一 FAIL ⇒ 1；全部通过 ⇒ 0（unresolved 只算提示，不算失败）
 */
import fs from 'node:fs'
import path from 'node:path'

// ⚠ `.pnpm-store` 必须跳过：它是 pnpm 内容寻址库，几千个无扩展名文件，
// 既不是产物源码又会把遍历拖到分钟级（R1 首次跑就踩了）。
const SKIP_DIRS = new Set(['docs', 'node_modules', '.git', '.pnpm-store'])
const VIEWPORT_PX = 1200 // vw 单位换算用的保守视口宽度

/** 源码语料：.js/.mjs/.cjs/.jsx/.ts/.tsx —— 现代产物（Vite+React+Vue+Svelte）主体在 tsx/ts 里 */
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs)$/i
/** 声明可交互元素的标签（HTML 静态产物与 JSX 通用） */
const ACTIVE_RE = /<(button|a|input|select|summary)\b([^>{}]*)/gi
/** 事件绑定写法：JSX 的 onClick={…} / HTML 的 onclick= / addEventListener */
const HANDLER_RE = /on[A-Z][\w]*=|onclick\s*=|addEventListener\s*\(/i

function walkFiles(dir, out = []) {
  let ents = []
  try { ents = fs.readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walkFiles(p, out) }
    else out.push(p)
  }
  return out
}

/** 归一化字号：clamp 取上限（保守），vw 按 VIEWPORT_PX 折算，缺省视为未解析 */
function toPx(raw) {
  if (!raw) return null
  const s = raw.trim()
  const clampMax = s.match(/clamp\([^,]+,[^,]+,\s*([^)]+)\)/)
  const v = (clampMax ? clampMax[1] : s).trim()
  const m = v.match(/^([\d.]+)\s*(px|rem|em|vw)?$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  if (!isFinite(n)) return null
  const u = (m[2] || 'px').toLowerCase()
  if (u === 'px') return n
  if (u === 'rem' || u === 'em') return n * 16
  if (u === 'vw') return (n * VIEWPORT_PX) / 100
  return n
}

/** .em → px：字号已知时把 rem/em/vw 都折算掉 */
function fontSizePx(css, selectorHint) {
  if (selectorHint) {
    const re = new RegExp('\\' + selectorHint + '\\s*\\{[^}]*?font-size:\\s*([^;}]+)', 'i')
    const m = css.match(re)
    if (m) return toPx(m[1])
  }
  const any = css.match(/font-size:\s*([^;}]+)/i)
  return any ? toPx(any[1]) : null
}

function checkGeometry(html, css, label, report) {
  const svgs = html.match(/<svg[\s\S]*?<\/svg>/gi) || []
  svgs.forEach((svg, i) => {
    const circles = [...svg.matchAll(/<circle\b([^>]*)>/gi)]
    if (!circles.length) return
    let r = null, sw = null
    for (const c of circles) {
      const rr = c[1].match(/\br="([\d.]+)"/i)
      const swA = c[1].match(/stroke-width="?([\d.]+)"?/i)
      if (rr) r = parseFloat(rr[1])
      if (swA) sw = parseFloat(swA[1])
    }
    // CSS 里的 stroke-width 兜底
    if (sw == null) {
      const m = svg.match(/stroke-width:\s*([\d.]+)/i)
      if (m) sw = parseFloat(m[1])
    }
    if (r == null) return
    const text = svg.match(/<text\b[^>]*class="([^"]+)"[\s\S]*?>([\s\S]*?)<\/text>/i)
    const rawText = text ? text[2].replace(/\s/g, '') : (svg.match(/<text\b[^>]*>([\s\S]*?)<\/text>/i) || [])[1]
    if (!rawText) return
    const chars = (rawText.match(/[0-9]/g) || []).length
    if (!chars) return
    const fsHint = text ? text[1].split(/\s+/)[0] : null
    const fsPx = fontSizePx(css, fsHint) ?? (svg.match(/font-size:\s*([^;}]+)/i) ? toPx(svg.match(/font-size:\s*([^;}]+)/i)[1]) : null)
    if (fsPx == null) {
      report.unresolved.push(`${label} svg#${i}: 未解析到字号（默认按 SVG 16px 计算）`)
    }
    const px = fsPx ?? 16
    const w = chars * px * 0.58 // 等宽数字的经验宽度
    const h = px * 1.0
    const halfDiag = Math.hypot(w / 2, h / 2)
    const inner = r - (sw ?? 1) // 整条描边都算不可用区（与 A/B 实测口径一致）
    const slack = inner - halfDiag
    const rec = { where: `${label} svg#${i}`, r, sw: sw ?? 1, fs: px, chars, inner: +inner.toFixed(1), halfDiag: +halfDiag.toFixed(1), slack: +slack.toFixed(1) }
    if (slack < 0) report.fails.push(`[geo] ${rec.where}: 文字外接半对角 ${rec.halfDiag}px > 可用半径 ${rec.inner}px（r=${r} sw=${sw ?? 1} 字号=${px}px，${chars} 位数字）余量 ${slack.toFixed(1)}px —— 数字压环/压线`)
    else report.passes.push(`[geo] ${rec.where}: 余量 +${rec.slack.toFixed(1)}px（可用半径 ${rec.inner} / 半对角 ${rec.halfDiag}）`)
    report.rows.push(rec)
  })
}

/** 收集源码语料（含内联 <script>），返回 {files:[{f,text}], all: joined} */
function sourceCorpus(files, html) {
  const inline = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n')
  const list = []
  for (const f of files) {
    if (!SRC_RE.test(f)) continue
    list.push({ f, text: fs.readFileSync(f, 'utf8') })
  }
  const all = (inline ? inline + '\n' : '') + list.map((x) => x.text).join('\n')
  return { files: list, all }
}

/**
 * 从 `idx`（标签名起点）扫到该标签的 `>`，把属性原文取出来。
 * ⚠ 不图省事用正则 `[^>]*`：JSX 里 `onClick={(e) => …}` 自带 `>`，正则会在箭头处截腰，
 * 把事件绑定漏掉（→ 假绿）。这里按花括号深度成对吞掉表达式原文。
 */
function scanTagAttrs(text, idx, tagLen) {
  let i = idx + tagLen
  let out = ''
  while (i < text.length) {
    const ch = text[i]
    if (ch === '{') {
      const s = i
      let d = 0
      while (i < text.length) {
        if (text[i] === '{') d++
        else if (text[i] === '}') { d--; if (d === 0) { i++; break } }
        i++
      }
      out += text.slice(s, i)
      continue
    }
    if (ch === '>' || ch === '<') return { attrs: out, end: i }
    out += ch
    i++
  }
  return { attrs: out, end: i }
}

/** 扫一份源码/HTML 里所有可交互元素声明 → [{file,line,where,kind,attrs}] */
function collectActive(text, file, tagRe) {
  const out = []
  tagRe.lastIndex = 0
  let m
  while ((m = tagRe.exec(text)) !== null) {
    const trail = m[2] || ''
    const attrs = scanTagAttrs(text, m.index, m[0].length - trail.length).attrs
    const line = text.slice(0, m.index).split('\n').length
    // `<` 只当标签起点：JS/TS 里的比较 `i<a && a<b` 同样命中 ACTIVE_RE，必须排除，否则全是噪声
    const prev = m.index > 0 ? text[m.index - 1] : ''
    if (!/^[\s>(]?$/.test(prev) && prev !== '') continue
    out.push({
      file,
      line,
      where: `${path.basename(file)}:${line}`,
      kind: m[1].toLowerCase(),
      attrs: attrs || '',
    })
  }
  return out
}

/** 从一段标签属性里抽出绑定句柄：id / class(+className) / data-* */
function handlesOf(attrs) {
  const id = (attrs.match(/\bid="([^"]+)"/i) || [])[1] || null
  const cls = (attrs.match(/\bclass(?:Name)?="([^"]+)"/i) || [])[1] || ''
  const classes = cls.split(/\s+/).filter(Boolean)
  const data = [...attrs.matchAll(/\bdata-[\w-]+/gi)].map((m) => m[0])
  return { id, classes, data: [...new Set(data)] }
}

/**
 * [bind] 两条判据。
 * HTML 静态产物走 checkBindHtml；React/Vue 产物（JSX 里才有 <button>）走 checkBindSource。
 * 两者都先打印覆盖数 —— 扫到 0 个源文件 / 0 条声明时必须显式报 N/A，绝不留空集通过。
 */
function checkBind(files, html, label, report) {
  const { files: srcFiles, all } = sourceCorpus(files, html)

  // ---- 覆盖口径 ----
  const seen = []
  for (const s of srcFiles) seen.push(...collectActive(s.text, s.f, ACTIVE_RE))
  for (const m of html.matchAll(/<(button|a|input|select|summary)\b([^>]*)>/gi)) {
    seen.push({ file: '(html)', line: '?', kind: m[1], attrs: m[2] })
  }
  report.binding = {
    srcFiles: srcFiles.length,
    srcList: srcFiles.slice(0, 12).map((x) => `${path.basename(x.f)}(${path.extname(x.f).slice(1)})`).join(' ') + (srcFiles.length > 12 ? ` …+${srcFiles.length - 12}` : ''),
    srcDecls: seen.length,
    jsLen: all.length,
  }

  // ⚠ 空集硬闸门：语料里连一份源文件都没有 ⇒ 本判据整个空转，绝不许算通过
  if (!srcFiles.length) {
    report.fails.push(`[bind] ${label}: 空集 —— 语料里没有 .js/.jsx/.ts/.tsx/.mjs/.cjs 源文件（扫到 ${srcFiles.length} 份），本判据正在空转，不算通过`)
  }

  // 1) orphan 按钮：声明了但源码里既没事件绑定、句柄也没被别的文件引用的
  for (const d of seen) {
    const h = handlesOf(d.attrs)
    if (HANDLER_RE.test(d.attrs)) continue // 声明处就有事件绑定，绑定成立
    const other = srcFiles.filter((x) => x.f !== d.file).map((x) => x.text).join('\n')
    const tokens = [h.id, ...h.classes, ...h.data].filter(Boolean)
    const hit = tokens.some((t) => other.includes(t) || all.includes(t + '"') || all.includes("'" + t))
    if (!hit) {
      report.fails.push(`[bind] ${label}: <${d.kind}>（${d.where}）既无事件绑定，id/class/data-* 也从未在产物里被引用 —— 点击不会有反应`)
    }
  }

  // 2) 歧义选择器：querySelector('[x]') 命中的属性在 DOM 里出现 >1 次 ⇒ 只有首个拿到 handler
  const declsAttrs = []
  for (const s of srcFiles) {
    for (const m of s.text.matchAll(ACTIVE_RE)) declsAttrs.push(handlesOf(m[2]))
  }
  for (const m of html.matchAll(/<(button|a|input|select|summary)\b([^>]*)>/gi)) declsAttrs.push(handlesOf(m[2]))
  for (const call of all.match(/\.querySelector(?:All)?\([^)]*\)/g) || []) {
    const a = call.indexOf('[')
    if (a < 0) continue
    const b = call.indexOf(']', a + 1)
    if (b < 0) continue
    const name = call.slice(a + 1, b).replace(/["']/g, '')
    if (!/^[a-z][a-z-]*$/.test(name)) continue
    const n = declsAttrs.filter((h) => h.data.includes(name)).length
    const nHtml = (html.match(new RegExp('\\s' + name + '=', 'gi')) || []).length
    const total = Math.max(n, nHtml)
    if (total > 1) {
      report.fails.push(`[bind] ${label}: querySelector('[${name}]') 命中 ${total} 个元素（可交互元素共用该属性 ${n} 次${nHtml ? `、DOM 里出现 ${nHtml} 次` : ''}）⇒ 只有首个拿到 handler，其余是死按钮；改用具体选择器`)
    }
  }
  if (!seen.length) report.bindNA = true
}

/** HTML 文字 vs 同产物圆环：A 组是 HTML 数字 + CSS 圆环（不是 svg <text>），这一类必须也能抓到 */
function checkGeometryHtml(html, css, label, report) {
  const rings = []
  for (const m of html.matchAll(/<circle\b([^>]*)>/gi)) {
    const r = m[1].match(/\br="([\d.]+)"/i)
    if (!r) continue
    rings.push({ r: parseFloat(r[1]), sw: parseFloat((m[1].match(/stroke-width[:=]"?\s*([\d.]+)/i) || [])[1] || '0') || null })
  }
  // 描边宽度常常只写在 CSS 里（A 组就是），属性上取不到时从样式补
  const cssStroke = (css.match(/stroke-width:\s*(\d+(?:\.\d+)?)/i) || [])[1]
  if (cssStroke && !rings.some((x) => x.sw != null)) {
    for (const rg of rings) rg.sw = parseFloat(cssStroke)
  }
  if (!rings.length) return
  // class → font-size 映射
  const cssFs = new Map()
  for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)\s*\{[^}]*?font-size:\s*([^;}]+)/gi)) {
    const px = toPx(m[2])
    if (px != null) cssFs.set(m[1], Math.max(cssFs.get(m[1]) || 0, px))
  }
  let worst = null
  for (const m of html.matchAll(/<(\w+)\b([^>]*)>([^<]*)<\/\1>/gi)) {
    const txt = m[3].trim()
    const digits = (txt.match(/[0-9]/g) || [])
    if (digits.length < 2) continue
    const cls = (m[2].match(/class="([^"]+)"/i) || [])[1]
    const ids = ((m[2].match(/\bid="([^"]+)"/i) || [])[1] || '')
    let px = cls ? cssFs.get(cls.split(/\s+/)[0]) : null
    if (px == null && ids) {
      const rm = css.match(new RegExp('#' + ids + '\\s*\\{[^}]*?font-size:\\s*([^;}]+)', 'i'))
      if (rm) px = toPx(rm[1])
    }
    if (px == null) continue
    const w = digits.length * px * 0.58
    const half = Math.hypot(w / 2, px / 2)
    for (const rg of rings) {
      const inner = rg.r - (rg.sw ?? 1)
      const slack = +(inner - half).toFixed(1)
      if (!worst || slack < worst.slack) worst = { where: `${label} html:<${m[1]} class="${cls || ''}">(${txt.slice(0, 12)})`, r: rg.r, sw: rg.sw ?? 1, fs: px, chars: digits.length, inner: +inner.toFixed(1), half: +half.toFixed(1), slack }
    }
  }
  if (!worst) return
  if (worst.slack < 0) report.fails.push(`[geo] ${worst.where}: 数字外接半对角 ${worst.half}px > 可用半径 ${worst.inner}px（r=${worst.r} sw=${worst.sw} 字号=${worst.fs}px，${worst.chars} 位数字）余量 ${worst.slack}px —— 数字压环`)
  else report.geo.push(`[geo] ${worst.where}: 余量 +${worst.slack}px（可用半径 ${worst.inner} / 半对角 ${worst.half}）`)
}

/**
 * [craft] 反馈态规则计数 —— **本轮 A/B 判决的主指标**。
 * craft 收窄后只剩一个被量化的增益面：交互反馈下限（hover / active / focus / disabled 到底写了几条）。
 * 纯静态数选择器里的状态伪类，不需要浏览器，天然模型无关（不会被「模型写不写」污染读数）。
 * ⚠ 只做计数不做门禁：写不出来是弱模型的现实，判 FAIL 等于插件不可用（与 0d 同一处置）。
 */
function checkFeedback(files, html, label, report) {
  const cssAll = [...files.filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(f, 'utf8')),
    ...[...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])].join('\n')
  const STATES = ['hover', 'active', 'focus-visible', 'focus', 'disabled', 'focus-within']
  const cnt = {}
  // ⚠ 前缀不能写 `\s:`：选择器是 `.sp-seg-item:hover`，冒号紧跟类名、前面没有空白（写错会全数 0，静默）。
  // 后缀用 `(?![\w-])`：否则 `:focus` 会把 `:focus-visible` 一并吃掉。
  for (const s of STATES) {
    const re = new RegExp(':' + s + '(?!([\\w-]))', 'gi')
    cnt[s] = (cssAll.match(re) || []).length
  }
  const attr = (cssAll.match(/\[disabled\]/gi) || []).length
  const total = Object.values(cnt).reduce((a, b) => a + b, 0) + attr
  report.feedback = { cnt, attr, total }
}

/**
 * [state] 演示页是不是「死快照」—— 用户一上手就露馅的那一条。
 * 场景（2026-10-02 实测触发）：组件内部 onPointerDown/Move/onKeyDown 全都齐，
 * 但入口把 `value={60}` 写死、onValueChange 只 console.log，全仓没有 useState
 * ⇒ 拖不动、点不动，交付物看着像产品、手一碰就废。静态可判，符合模型无关。
 * ⚠ 这条是用户实测（「图1滑块动不了」）逼出来的 —— 反馈态规则数、AC 数、bind/geo 全绿，
 * 却漏了这个，说明**原主指标选错了**：craft 真正影响的不是「CSS 多几条 :hover」。
 */
function checkInteractive(files, html, label, report) {
  const src = files.filter((f) => SRC_RE.test(f) && !/(test|spec)/i.test(path.basename(f)))
  const entryNames = ['main', 'app', 'index']
  const entryFiles = src.filter((f) => entryNames.includes(path.basename(f).replace(/\.[^.]+$/, '').toLowerCase()))
  const entry = entryFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  const scope = entry || src.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  // ⚠ 状态只看入口链（main/app/index）：R1 的 SliderArea 里有 `useState(false)` 管 dragging，
  // 拿全仓 useState 当证据会判假阴性（明明点不动却说「可驱动」，2026-10-02 实测踩到）。
  const stateful = /\buse(?:State|Reducer)\s*\(/.test(entry)
  const literal = /value=\{\s*['"]?\d+(?:\.\d+)?['"]?\s*\}/.test(scope)
  report.interactive = { stateful, literal, entries: entryFiles.map((f) => path.basename(f)), files: src.length }
  // 只有「入口写死常量 + 入口链没有状态」才算死快照
  if (entry && literal && !stateful) {
    report.fails.push(`[state] ${label}: 死快照 —— 入口（${report.interactive.entries.join('/')}）把 value 写死成常量，且入口链没有 useState/useReducer ⇒ 拖动/点击不会更新，用户拿到的是点不动的静态面板`)
  }
}

function checkPersistence(files, html, label, report) {
  const src = [...files.filter((f) => SRC_RE.test(f) || /\.html$/i.test(f)).map((f) => fs.readFileSync(f, 'utf8')), html].join('\n')
  const hasStorage = /localStorage|sessionStorage|indexedDB|document\.cookie/.test(src)
  if (hasStorage) report.passes.push(`${label}: 存在存储 API`)
  else report.passes.push(`${label}: 无存储 API ⇒ 「今日累计 / 轮次」刷新即归零（功能缺口，不是「等价更便宜」；四维里的可见性分不算持久化）`)
}

const ALL_FAILS = []
for (const dir of process.argv.slice(2)) {
  const files = walkFiles(dir)
  const htmlFiles = files.filter((f) => f.endsWith('.html'))
  const cssFiles = files.filter((f) => f.endsWith('.css'))
  const html = htmlFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  const css = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
    .join('\n') + cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n')

  const report = { fails: [], passes: [], unresolved: [], rows: [], geo: [] }
  const label = path.basename(dir.replace(/[\\/]+$/, ''))
  console.log(`\n===== ${label}  (${dir}) =====`)
  checkGeometry(html, css, label, report)
  checkGeometryHtml(html, css, label, report)
  if (!report.rows.length && !report.geo.length && !report.fails.some((f) => f.startsWith('[geo]'))) {
    const svgs = (html.match(/<svg\b/gi) || []).length
    const circles = (html.match(/<circle\b/gi) || []).length
    console.log(`  🔎 [geo] 覆盖：产物里 ${svgs} 个 <svg> / ${circles} 个 <circle> ⇒ 无定尺容器，本判据 N/A`)
  }
  checkBind(files, html, label, report)
  checkFeedback(files, html, label, report)
  checkInteractive(files, html, label, report)
  checkPersistence(files, html, label, report)
  if (report.interactive) {
    const s = report.interactive
    console.log(`  🔎 [state] 覆盖：可运行源码 ${s.files} 份 / 有 useState=${s.stateful} / 入口写死常量值=${s.literal}${s.literal && !s.stateful ? ' ⇒ 死快照' : ' ⇒ 可驱动'}`)
  }
  if (report.feedback) {
    const f = report.feedback
    const detail = Object.entries(f.cnt).map(([k, v]) => `${k} ${v}`).join(' / ') + (f.attr ? ` / [disabled] ${f.attr}` : '')
    console.log(`  🔎 [craft] 反馈态规则：${detail} —— 合计 ${f.total} 条`)
  }
  // 覆盖口径：判据有没有真的扫到东西，必须肉眼可核（空集通过是这脚本第一版的假绿）
  const b = report.binding || { srcFiles: 0, srcList: '—', srcDecls: 0, jsLen: 0 }
  console.log(`  🔎 [bind] 覆盖：源码语料 ${b.srcFiles} 份（${b.srcList}）/ 可交互声明 ${b.srcDecls} 条 / 语料 ${b.jsLen} 字符${report.bindNA ? ' —— 无判定，N/A' : ''}`)
  for (const p of report.geo) console.log(`  ✅ ${p}`)
  for (const p of report.passes) console.log(`  ✅ ${p}`)
  for (const u of report.unresolved) console.log(`  ⚠️  ${u}`)
  for (const f of report.fails) { console.log(`  ❌ ${f}`); ALL_FAILS.push(`${label}: ${f}`) }
  if (report.rows.length) {
    console.log('  几何明细：' + report.rows.map((r) => `内半径 ${r.inner} / 半对角 ${r.halfDiag} / 余量 ${r.slack}`).join('；'))
  }
  if (!report.fails.length) console.log(`  ⇒ ${label} 自洽检查通过`)
}
if (!process.argv[2]) {
  console.log('用法：node scripts/artifact-selfcheck.mjs <产物目录> [<产物目录> ...]')
  process.exit(2)
}
console.log(ALL_FAILS.length ? `\n合计 ${ALL_FAILS.length} 项失败` : '\n全部通过')

process.exit(ALL_FAILS.length ? 1 : 0)
