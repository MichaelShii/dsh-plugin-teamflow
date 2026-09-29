/**
 * host 侧浏览器可用性探测（2026-09-29）。
 *
 * **要回答的问题**：插件自己的代码（跑在 dsh web 服务进程里）能不能起浏览器？
 *
 * 背景（用户实测，机制已确认）：agent（含 QA 子代理）在受限令牌下**必死** ——
 * crashpad 启动时用 `PROCESS_ALL_ACCESS` 开自身 PID（crashpad_client_win.cc:421 OpenProcess），
 * 而 DSH 受限令牌的两个掩码并集恰好都缺 `0x200`(SET_INFORMATION) / `0x800`(SUSPEND_RESUME)
 * ⇒ 恒 DENY ⇒ exit -36863（kTerminationCodeCrashNoDump）。逐位 P/Invoke 与对象 DACL 都已实测吻合。
 *
 * 受限令牌由 `sandbox-windows-acl/runner.ts` 在**启动 agent 进程**时套上去 —— 插件自己的
 * `spawnSync` 不经过那层 ⇒ **机制上应不受限**。但**机制推断 ≠ 实测**（本项目已经因为
 * 「在别处测通就当本环境事实」栽过一次），所以这里真跑一次最小截图，把结果落盘。
 *
 * 结果写 `$DSH_HOME/teamflow/host-browser-probe.json`；返回单行摘要供启动日志。
 * 约束：**绝不抛错、绝不阻断插件加载**（best-effort），超时 20s（失败通常即时返回）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dshHome } from '../../../store.ts'
import { listDeliverableFiles } from '../../util.ts'

export interface HostBrowserProbe {
  /** ok=host 侧能截图（不受限） blocked=与 agent 同样被令牌拦死 no-browser=找不到可执行文件 error=其它 */
  status: 'ok' | 'blocked' | 'no-browser' | 'error'
  chrome: string | null
  exitCode: number | null
  shotBytes: number
  error: string
  at: number
  /** 探测耗时 ms（用于判断是否值得在启动路径上同步跑） */
  ms: number
}

/** 常见安装位置（先探测、不写死：找不到再看 PATH）。 */
const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
]

/** 定位一个可用的 Chromium 系可执行文件（先常见路径，再 where/which）。找不到返回 null。 */
export function findBrowser(): string | null {
  for (const c of CANDIDATES) {
    try { if (existsSync(c)) return c } catch (e) { /* 忽略 */ }
  }
  const probe = process.platform === 'win32' ? 'where' : 'which'
  for (const bin of ['chrome', 'google-chrome', 'chromium', 'msedge', 'microsoft-edge']) {
    try {
      const r = spawnSync(probe, [bin], { stdio: 'ignore', windowsHide: true, timeout: 4000 })
      if (r.status === 0) return bin
    } catch (e) { /* 忽略 */ }
  }
  return null
}

const PROBE_HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0">'
  + '<canvas id="c" width="120" height="120"></canvas>'
  + '<script>const g=document.getElementById("c").getContext("2d");'
  + 'g.fillStyle="#22c55e";g.fillRect(10,10,100,100);</script></body>'

/** 跑一次最小截图探测。**任何异常都转成 status:'error'，不向外抛。** */
export function probeHostBrowser(timeoutMs = 20000): HostBrowserProbe {
  const t0 = Date.now()
  const out: HostBrowserProbe = { status: 'error', chrome: null, exitCode: null, shotBytes: 0, error: '', at: t0, ms: 0 }
  try {
    const chrome = findBrowser()
    if (!chrome) { out.status = 'no-browser'; out.ms = Date.now() - t0; return out }
    out.chrome = chrome

    const dir = join(dshHome(), 'teamflow', '.probe')
    mkdirSync(dir, { recursive: true })
    const html = join(dir, 'probe.html')
    const shot = join(dir, 'probe.png')
    try { unlinkSync(shot) } catch (e) { /* 不存在即可 */ }
    writeFileSync(html, PROBE_HTML, 'utf8')

    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      `--user-data-dir=${join(dir, 'ud')}`,
      '--window-size=140,140', `--screenshot=${shot}`,
      pathToFileURL(html).href,
    ], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' })

    out.exitCode = typeof r.status === 'number' ? r.status : null
    try { out.shotBytes = statSync(shot).size } catch (e) { out.shotBytes = 0 }
    const stderr = String(r.stderr || '')
    const spawnErr = r.error ? `${String((r.error as { code?: string }).code || '')} ${r.error.message}`.trim() : ''
    if (out.shotBytes > 0 && r.status === 0) {
      out.status = 'ok'
    } else if (spawnErr || r.status === null) {
      // ⚠️ 进程**根本没起来**（EBUSY/ENOENT/超时…）—— 与「起来了但被令牌拦死」是**完全不同**的失败：
      // 前者说明这个进程环境不允许 spawn（本仓已知：bash 内嵌 node 再 spawnSync 会 EBUSY/status=null），
      // 后者才是 crashpad 被 0x200/0x800 拦。混在一起会让排查方向错。
      out.status = 'error'
      out.error = `spawn did not start a process: ${spawnErr || 'status=null'}`.slice(0, 400)
    } else if (/crashpad|OpenProcess|拒绝访问|access is denied/i.test(stderr) || r.status === -36863) {
      out.status = 'blocked'
      out.error = stderr.slice(0, 400)
    } else {
      out.error = (stderr || `exit ${String(r.status)}`).slice(0, 400)
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 400)
  }
  out.ms = Date.now() - t0
  return out
}

/** 探测 + 落盘 + 返回一行摘要（供启动日志）。**不抛错**。 */
export function probeHostBrowserAndLog(): string {
  let p: HostBrowserProbe
  try { p = probeHostBrowser() } catch (e) {
    return `浏览器探测异常：${String((e && e.message) || e)}`
  }
  try {
    const file = join(dshHome(), 'teamflow', 'host-browser-probe.json')
    mkdirSync(join(dshHome(), 'teamflow'), { recursive: true })
    writeFileSync(file, JSON.stringify(p, null, 2), 'utf8')
  } catch (e) { /* 落盘失败不影响摘要 */ }
  const label = p.status === 'ok' ? '✅ host 侧可起浏览器（截图 ' + p.shotBytes + 'B）'
    : p.status === 'blocked' ? '✖ host 侧同样被受限令牌拦死（与 agent 一致）'
      : p.status === 'no-browser' ? '· 未找到浏览器可执行文件'
        : '? 探测出错'
  return `浏览器探测：${label}｜${p.chrome || 'n/a'}｜exit=${String(p.exitCode)}｜${p.ms}ms`
}

/**
 * host 侧「加载检查」（2026-09-29）—— 对**含 HTML 入口的交付**跑一次真浏览器加载，
 * 捕获未捕获异常（Uncaught TypeError / ReferenceError / SyntaxError…）。
 *
 * 为什么由 host 做：**子代理永远做不到** —— agent 进程套了受限令牌，crashpad 需要
 * `PROCESS_ALL_ACCESS` 开自身（缺 0x200/0x800 ⇒ 恒 DENY ⇒ -36863）。而 host 侧已实测可起浏览器
 * （截图 447B / exit 0），所以「打开就崩」这一类**能在这里客观检出**，不必依赖 QA 自觉。
 *
 * 覆盖范围与边界（勿夸大）：只抓**加载/初始化期抛出的未捕获错误**。
 * 抓不到「静默不动」（如循环判定写反、不抛错但什么都不做）—— 那需要像素/绘制统计，本轮不做。
 * 纯记录：**不参与任何判定、不影响流水线行为**，调用方自行决定怎么用。
 */
export interface LoadCheck {
  status: 'ok' | 'no-html' | 'spawn-failed' | 'error'
  entry: string | null
  /** 未捕获错误消息（截断、去重、最多 5 条） */
  errors: string[]
  ms: number
}

const HTML_ENTRY = /\.html?$/i

/** 挑一个入口：优先 index.html，其次任意 html（相对 root）。 */
export function pickHtmlEntry(root: string): string | null {
  const files = listDeliverableFiles(root)
  const htmls = files.filter((f) => HTML_ENTRY.test(f))
  if (!htmls.length) return null
  return htmls.find((f) => /(^|\/)index\.html?$/i.test(f)) || htmls[0]
}

export function captureLoadCheck(root: string | null | undefined, timeoutMs = 20000): LoadCheck {
  const t0 = Date.now()
  const out: LoadCheck = { status: 'error', entry: null, errors: [], ms: 0 }
  try {
    if (!root) { out.status = 'no-html'; out.ms = Date.now() - t0; return out }
    const entry = pickHtmlEntry(root)
    if (!entry) { out.status = 'no-html'; out.ms = Date.now() - t0; return out }
    out.entry = entry
    const chrome = findBrowser()
    if (!chrome) { out.status = 'spawn-failed'; out.ms = Date.now() - t0; return out }

    const dir = join(dshHome(), 'teamflow', '.probe')
    mkdirSync(dir, { recursive: true })
    // --enable-logging=stderr + --dump-dom：stdout（DOM）丢弃、只收 stderr，避免大页面把内存撑爆。
    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      `--user-data-dir=${join(dir, 'ud-load')}`,
      '--enable-logging=stderr', '--v=0', '--dump-dom',
      pathToFileURL(join(root, entry)).href,
    ], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] })

    if (r.error || r.status === null) {
      out.status = 'spawn-failed'
      out.ms = Date.now() - t0
      return out
    }
    const stderr = String(r.stderr || '')
    const hits = new Set<string>()
    for (const line of stderr.split('\n')) {
      if (!/(Uncaught|TypeError|ReferenceError|SyntaxError|is not a function|is not defined)/.test(line)) continue
      const msg = line.replace(/^\[[^\]]*\]\s*/, '').replace(/^ERROR:\S+\]?\s*/, '').trim()
      if (msg) hits.add(msg.slice(0, 200))
      if (hits.size >= 5) break
    }
    out.errors = [...hits]
    out.status = 'ok'
  } catch (e) {
    out.status = 'error'
  }
  out.ms = Date.now() - t0
  return out
}
