/**
 * host 侧**冒烟**（2026-09-29）—— 把「交付有没有真的跑起来」从模型自律变成机器事实。
 *
 * 为什么必须由 host 做：
 * 0a2 / 验证证据探针都是**要求模型自己在报告里写「我跑了，exit 0」**。但本插件面向所有 dsh 用户、
 * 任意模型（含本地小模型）—— 实测弱模型三次**全部写不出**命令+结果。靠模型自律的门禁，
 * 在跨模型场景下等于「对一半用户无效」，而且**绝不能升级成硬失败**（否则不会写的模型每个 run 都失败）。
 * ⇒ 正确载体是：host 自己跑一次，得到与模型无关的事实。
 *
 * 做法（复用已实测可用的 host 浏览器能力）：
 *   ① 复制交付到临时目录（**绝不改动工作区** —— run 可能在跑，且 QA 会查「提交面无噪声」）；
 *   ② 在副本的 <head> 注入计数器：canvas 绘制调用 / rAF 调度 / DOM 变更数；
 *   ③ 真浏览器 --dump-dom 加载，中途**轻推一下**（点首个 button + 派发 ArrowRight）
 *      —— 覆盖「等输入才动」的实现（贪吃蛇那类）；
 *   ④ 解析计数：**三者全 0 = no-motion**（画面/状态全程没变化）。
 *
 * ⚠️ 局限（如实说明）：
 * - 只判「有没有产生可观测变化」，**不判玩法正确**（那是 QA 的活）；
 * - 「静默不动」能抓；逻辑算错（如 32°F 算成 33）抓不到；
 * - **rAF 回调在本机 headless 下不保证执行**（实测：只是被「调度」，回调可能一次都不跑 ——
 *   同一个机制让贪吃蛇 A 组呈现 raf=2/draw=0）。因此判据以 **draw / DOM 变更**为主，
 *   不把 raf 计入"有动静"；代价是**纯靠 rAF 动画的画布页可能被误判 no-motion**。
 *   这也是本检查只记录、不阻断的原因之一。
 * - 依赖本机 Chromium 可启动（探针已实测）；起不来就 skip，绝不因此影响流水线。
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { dshHome } from '../../../store.ts'
import { listDeliverableFiles } from '../../util.ts'
import { findBrowser, pickHtmlEntryDetailed } from './browser-probe.ts'

export interface SmokeCheck {
  status: 'ok' | 'no-motion' | 'skip' | 'error'
  entry: string | null
  draw: number
  raf: number
  mutations: number
  /** 页面里 canvas 元素个数 —— 有画布却一次没画 = 空转的强信号 */
  canvas: number
  ms: number
  note?: string
  /** 交付枚举被上限截断 ⇒ `skip/no-html` 不是「真的没有入口」，调用方须显式上报 */
  truncated: boolean
}

const MAX_FILE_BYTES = 512 * 1024

/** 注入到 <head> 的计数器（classic script，早于页面模块执行，故能拦到 getContext）。 */
const STUB_HEAD = '<script>(function(){'
  + 'var c=window.__tf={draw:0,raf:0,mut:0};'
  + 'var P=window.HTMLCanvasElement&&HTMLCanvasElement.prototype;'
  + 'if(P&&P.getContext){var g=P.getContext;P.getContext=function(){'
  + 'var x=g.apply(this,arguments);'
  + 'if(x&&!x.__tfP){x.__tfP=1;'
  + "var ops=['fillRect','strokeRect','clearRect','fillText','strokeText','drawImage','beginPath','fill','stroke','arc','moveTo','lineTo','putImageData','setTransform'];"
  + 'for(var i=0;i<ops.length;i++){(function(n){var f=x[n];'
  + 'if(typeof f!==\'function\')return;'
  + 'x[n]=function(){c.draw++;return f.apply(this,arguments)};})(ops[i]);}}'
  + 'return x;};}'
  + 'var R=window.requestAnimationFrame;'
  + 'if(R)window.requestAnimationFrame=function(){c.raf++;return R.apply(window,arguments)};'
  // ⚠️ 必须在 head 里**立即**挂 MutationObserver，不能等 DOMContentLoaded：
  // module 脚本在 DOMContentLoaded **之前**执行，顶层就渲染的页面（如任务清单）其变更
  // 会全部发生在 observer 挂上之前 ⇒ 实测 mut=0、把能用的交付误判成 no-motion。
  + 'try{'
  + 'var m=new MutationObserver(function(rs){c.mut+=rs.length});'
  + 'm.observe(document.documentElement||document,{childList:true,subtree:true,attributes:true,characterData:true});'
  + '}catch(e){}'
  + '})();</script>'

/** 注入到 </body> 前的上报器：先轻推一次（点击 + 方向键），再落计数。 */
const REPORTER = '<script>(function(){'
  // ⚠️ 必须等 load：页面脚本多为 defer/module，虚拟时间下 setTimeout 可能比它们**先**执行
  // （首版就是这么把三个正常交付全测成 0 的）。
  + 'function go(){'
  + 'setTimeout(function(){try{'
  + 'var b=document.querySelector(\'button\');if(b)b.click();'
  + 'var e=new KeyboardEvent(\'keydown\',{key:\'ArrowRight\',bubbles:true});'
  + '(document.activeElement||document.body).dispatchEvent(e);'
  + '}catch(x){}},400);'
  + 'setTimeout(function(){'
  + 'var c=window.__tf||{draw:0,raf:0,mut:0};'
  + 'try{c.cv=document.querySelectorAll(\'canvas\').length}catch(e){c.cv=0}'
  + 'var p=document.createElement(\'pre\');p.id=\'__tfsmoke\';'
  + 'p.textContent=\'TFSMOKE=\'+JSON.stringify(c);'
  + '(document.body||document.documentElement).appendChild(p);'
  + '},1600);'
  + '}'
  + 'if(document.readyState===\'complete\')go();else window.addEventListener(\'load\',go);'
  + '})();</script>'

/**
 * 把探针注入一段 HTML（纯函数，便于单测 —— 不必起浏览器就能验证注入正确）。
 * 注入点：<head> 之后插计数器（classic script 早于页面 module），</body> 之前插上报器。
 */
export function injectSmokeProbe(html: string): string {
  let out = String(html || '')
  // 计数器必须**早于页面脚本**：有 <head> 插其后，没有就插 <html> 后，再没有就置顶。
  // （首版只在 <head> 后插 —— 实测语料没写 <head> 时计数器整段没进去，draw/raf 全 0，
  //   把「有动画」误判成 no-motion。缺标签的 HTML 浏览器会隐式补齐，但字符串替换不会。）
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, (m) => m + STUB_HEAD)
  else if (/<html\b[^>]*>/i.test(out)) out = out.replace(/<html\b[^>]*>/i, (m) => m + STUB_HEAD)
  else out = STUB_HEAD + out
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, REPORTER + '</body>')
  else out = out + REPORTER
  return out
}

/** 把交付复制到临时目录（保持相对结构），返回副本根。 */
function copyToTemp(root: string, tag: string): string | null {
  const dir = join(dshHome(), 'teamflow', '.probe', `smoke-${tag}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  let n = 0
  for (const rel of listDeliverableFiles(root)) {
    const src = resolve(root, rel)
    try {
      if (!existsSync(src) || statSync(src).size > MAX_FILE_BYTES) continue
      const dst = join(dir, rel)
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(src))
      n++
    } catch (e) { /* 单文件失败不影响其余 */ }
  }
  return n ? dir : null
}

/**
 * 对含 HTML 入口的交付跑一次真浏览器冒烟。
 * `skip` = 没有 HTML 入口 / 入口无脚本 / 浏览器起不来 —— 与「跑了但没动静」区分开。
 */
export function runHostSmoke(root: string | null | undefined, timeoutMs = 25000): SmokeCheck {
  const t0 = Date.now()
  const out: SmokeCheck = { status: 'error', entry: null, draw: 0, raf: 0, mutations: 0, canvas: 0, ms: 0, truncated: false }
  let tmp: string | null = null
  try {
    if (!root) { out.status = 'skip'; out.note = 'no-root'; out.ms = Date.now() - t0; return out }
    const picked = pickHtmlEntryDetailed(root)
    out.truncated = picked.truncated
    const entry = picked.entry
    if (!entry) { out.status = 'skip'; out.note = 'no-html'; out.ms = Date.now() - t0; return out }
    out.entry = entry
    const html = readFileSync(resolve(root, entry), 'utf8')
    if (!/<script\b/i.test(html)) { out.status = 'skip'; out.note = 'no-script'; out.ms = Date.now() - t0; return out }
    const chrome = findBrowser()
    if (!chrome) { out.status = 'skip'; out.note = 'no-browser'; out.ms = Date.now() - t0; return out }
    tmp = copyToTemp(root, String(Date.now()))
    if (!tmp) { out.status = 'skip'; out.note = 'copy-failed'; out.ms = Date.now() - t0; return out }

    const copyPath = join(tmp, entry)
    writeFileSync(copyPath, injectSmokeProbe(readFileSync(copyPath, 'utf8')))

    const r = spawnSync(chrome, [
      '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      `--user-data-dir=${join(tmp, 'ud')}`,
      // ⚠️ 必需：`type="module"` 的外链脚本在 `file://` 下会被 CORS 拒（origin 为 null）
      // ⇒ 页面脚本一行都不执行，实测把三个正常交付全测成「全 0」。内联脚本的页面不受影响，
      // 所以这个坑只在「模块化交付」上暴露 —— 而模块化正是本插件鼓励的形态。
      '--allow-file-access-from-files',
      '--window-size=520,900', '--virtual-time-budget=4000', '--dump-dom',
      pathToFileURL(copyPath).href,
    ], { timeout: timeoutMs, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    if (r.error || r.status === null) {
      out.status = 'skip'
      const ecode = (r.error as { code?: string } | undefined)?.code
      out.note = `spawn-failed:${String(ecode || 'unknown')}`
      out.ms = Date.now() - t0
      return out
    }
    const dom = String(r.stdout || '')
    const m = /<pre id="__tfsmoke">TFSMOKE=([\s\S]*?)<\/pre>/.exec(dom)
    if (!m) { out.status = 'error'; out.note = 'no-report'; out.ms = Date.now() - t0; return out }
    const c = JSON.parse(m[1].replace(/&quot;/g, '"'))
    out.draw = Number(c.draw) || 0
    out.raf = Number(c.raf) || 0
    out.mutations = Number(c.mut) || 0
    out.canvas = Number(c.cv) || 0
    // 判据（**有 canvas 时只认绘制**，这是关键）：
    // ① 页面有 canvas 且**一次都没画** → 不动。贪吃蛇 A 组正是这一档：循环在跑、rAF 在排、
    //    DOM 还在变（mut=35），但 draw() 永不执行、画面全黑、控制台干净 ——
    //    只看「有没有动」的粗判据会被 mut/raf 骗过去。
    // ② 有 canvas 且画了 → 动。
    // ③ 无 canvas（纯 DOM 应用，如换算器/清单）→ 看绘制或 DOM 变更。
    // ④ 其余全 0 → 不动。
    out.status = out.canvas > 0
      ? (out.draw > 0 ? 'ok' : 'no-motion')
      : (out.draw > 0 || out.mutations > 0 ? 'ok' : 'no-motion')
  } catch (e) {
    out.status = 'error'
    out.note = String((e && e.message) || e).slice(0, 120)
  } finally {
    if (tmp) { try { rmSync(tmp, { recursive: true, force: true }) } catch (e) { /* 清理失败无所谓 */ } }
  }
  out.ms = Date.now() - t0
  return out
}
