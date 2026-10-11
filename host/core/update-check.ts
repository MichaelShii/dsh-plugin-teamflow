/**
 * dsh-plugin-teamflow core — 版本探测（ADR-0012 D3）。
 *
 * 回答一个问题：**本机装的 TeamFlow 是不是旧版本**，且不打扰、不阻断、不泄密。
 *
 * 三条纪律（改这个文件前先读这一段）：
 * ① **不阻断**：网络 / 解析 / 写盘任何一步失败都只降级成「不知道」——本模块**不抛异常**，
 *    调用方拿到的永远是一个可渲染的对象。提示功能不得成为故障源。
 * ② **不打扰**：24h 缓存（`UPDATE_CHECK_TTL_MS`）＋「跳过此版本」记的是**具体版本号**
 *    （不是永久静默）⇒ 更新的版本出现时会重新提示。
 * ③ **不泄密**：一次匿名 GET，无 query、无 body、无任何标识 header。
 *
 * 当前版本读**本插件自身** `package.json`（从 `import.meta.url` 逐级向上找、按包名确认，见
 * `readOwnVersion`）——源码树与 bundle 的相对深度不同，写死任一种都会静默失效。
 * 用文件而不是构建期常量：构建期注入会让「磁盘上装的是哪一版」与「进程以为自己是哪一版」
 * 可能不一致，而这里问的恰恰是磁盘。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readJsonAny, writeJson, teamflowRoot } from '../../store.ts'
import { envFlagOn } from '../util.ts'
import { PLUGIN_PACKAGE_NAME, UPDATE_CHECK_TTL_MS, UPDATE_CHECK_TIMEOUT_MS } from '../constants.ts'

/** 官方 npm 源（探测只问它一个；用户配了镜像也不改变——探测不是安装，不需要跟随安装源）。 */
export const NPM_REGISTRY = 'https://registry.npmjs.org/'

/** 探测结果。**所有字段都可缺省**：缺省＝「不知道」，渲染层按「不提示」处理。 */
export interface UpdateStatus {
  /** 功能是否启用（`TEAMFLOW_UPDATE`，未设＝启用）。关闭时其余字段无意义。 */
  enabled: boolean
  /** 本机磁盘上的版本。 */
  current: string
  /** registry 上的最新版；`null` ＝ 本次没问出来（网络/解析失败）。 */
  latest: string | null
  /** 是否该提示（＝有更新 且 未被用户跳过该版本）。 */
  outdated: boolean
  /** 用户跳过的版本号（跳过是「跳过这一版」，不是永久静默）。 */
  skipped: string | null
  /** 缓存写入时间（毫秒）；`null` ＝ 从没成功缓存过。 */
  checkedAt: number | null
  /** `null` ＝ 一切正常。**失败必须显式**（纪律 ①：降级可以，静默不行）。 */
  error: string | null
}

/** 磁盘缓存形态（机器级，不放工作区目录：装的是哪一版与工作区无关）。 */
export interface UpdateCache {
  checkedAt: number
  latest: string | null
  skipped: string | null
}

/** 缓存的落点：`$DSH_HOME/teamflow/update-check.json`。 */
export function updateCacheFile(): string {
  return join(teamflowRoot(), 'update-check.json')
}

/** 探测开关。语义沿用 `envFlagOn`（未设 / 空 = 开；`0`/`false`/`off`/`no` = 关）。
 *  ⚠️ **不进公开工具 schema** —— 同 `craft` / `confirm` / `clarify` 的处置：
 *  用户不会主动设的开关，公开出来只会变成噪音；它只服务于 A/B 对照与端到端验证的强制位。 */
export function updateCheckEnabled(): boolean {
  return envFlagOn('TEAMFLOW_UPDATE')
}

/** 版本号解析：`x.y.z` ＋ 可选 `-prerelease` ＋ 可选 `+build`（build 不参与比较）。 */
export function parseVersion(value: unknown): { nums: number[]; pre: string[] } | null {
  const s = String(value ?? '').trim().replace(/^v/i, '')
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(s)
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

const DIGITS = /^\d+$/

/** semver 优先级比较：`>0` 表示 a 比 b 新。**解析不了的一律视为相等**——
 *  宁可漏提示也不误提示（探测结果来自网络，脏数据不该变成一条假提醒）。 */
export function compareVersions(a: unknown, b: unknown): number {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) {
    if (x.nums[i] !== y.nums[i]) return x.nums[i] > y.nums[i] ? 1 : -1
  }
  if (x.pre.length === 0 && y.pre.length === 0) return 0
  if (x.pre.length === 0) return 1
  if (y.pre.length === 0) return -1
  const len = Math.max(x.pre.length, y.pre.length)
  for (let i = 0; i < len; i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = DIGITS.test(p)
    const qn = DIGITS.test(q)
    if (pn && qn) {
      const d = Number(p) - Number(q)
      if (d !== 0) return d > 0 ? 1 : -1
    } else if (pn !== qn) {
      return pn ? -1 : 1
    } else if (p !== q) {
      return p > q ? 1 : -1
    }
  }
  return 0
}

/** 从 packument 取最新版：优先 `dist-tags.latest`，取不到就扫 `versions` 求最大值。
 *  （npm 的 abbreviated packument 也带 `dist-tags`；扫 `versions` 是兜底。） */
export function pickLatest(packument: unknown): string | null {
  if (!packument || typeof packument !== 'object') return null
  const tags = (packument as Record<string, unknown>)['dist-tags']
  const tagged = tags && typeof tags === 'object' ? (tags as Record<string, unknown>).latest : undefined
  if (typeof tagged === 'string' && parseVersion(tagged)) return tagged
  const versions = (packument as Record<string, unknown>).versions
  if (!versions || typeof versions !== 'object') return null
  let best: string | null = null
  for (const v of Object.keys(versions as Record<string, unknown>)) {
    if (!parseVersion(v)) continue
    if (best === null || compareVersions(v, best) > 0) best = v
  }
  return best
}

/** 该不该提示：有新版 且 用户没跳过**恰好这一版**。 */
export function shouldNotify(s: { current?: unknown; latest?: unknown; skipped?: unknown }): boolean {
  const current = String(s?.current ?? '')
  const latest = String(s?.latest ?? '')
  if (!parseVersion(current) || !parseVersion(latest)) return false
  if (s?.skipped !== undefined && s?.skipped !== null && String(s.skipped) === latest) return false
  return compareVersions(latest, current) > 0
}

/** 本机磁盘上的版本。读不到返回 `null`（不猜、不回退到环境变量）。
 *
 * ⚠️ **为什么是「向上找」而不是固定的 `../package.json`**：本模块在**源码树**里的位置是
 * `host/core/`，而宿主 bundle 后落到 `<pkg>/lib/host.mjs` —— 同一个 `import.meta.url`
 * 相对深度**不一样**（前者要向上两级、后者一级）。写死任一种，另一种就会读到一个不存在的
 * 路径（实测：源码树下恒返回 `null`，且因为「读不到＝不提示」而**静默失效**）。
 * ⇒ 逐级向上找，并用 `name` **匹配包名**确认找到的是自己（否则会误读上层某个无关的 package.json）。
 */
const OWN_PKG_CANDIDATES = ['../package.json', '../../package.json', '../../../package.json']

export function readOwnVersion(moduleUrl?: string): string | null {
  const here = moduleUrl ?? import.meta.url
  for (const rel of OWN_PKG_CANDIDATES) {
    try {
      const pkg = fileURLToPath(new URL(rel, here))
      const json = JSON.parse(readFileSync(pkg, 'utf8')) as Record<string, unknown>
      if (json.name !== PLUGIN_PACKAGE_NAME) continue
      if (typeof json.version === 'string') return json.version
    } catch (e) {
      /* 这一层没有，继续向上 */
    }
  }
  return null
}

/** 读缓存。读不到 / 形状不对一律返回 `null`（缓存坏了等于没有缓存）。 */
export function readCache(file: string): UpdateCache | null {
  try {
    const raw = readJsonAny<Record<string, unknown> | null>(file, null)
    if (!raw || typeof raw !== 'object') return null
    const checkedAt = Number(raw.checkedAt)
    // ⚠️ `checkedAt === 0` 是**合法**的「从没成功探测过，只记过跳过」——不能当损坏丢掉，
    // 否则「只点了跳过、还没探测过」的用户，跳过记录会在下次读盘时凭空消失。
    if (!Number.isFinite(checkedAt) || checkedAt < 0) return null
    return {
      checkedAt,
      latest: typeof raw.latest === 'string' ? raw.latest : null,
      skipped: typeof raw.skipped === 'string' ? raw.skipped : null,
    }
  } catch (e) {
    return null
  }
}

/** 写缓存。`skipped` 缺省时保留磁盘上已有的值——避免「一次探测把跳过记录抹掉」。 */
export function writeCache(file: string, patch: { checkedAt: number; latest: string | null; skipped?: string | null }): boolean {
  try {
    const prev = readCache(file)
    const next: UpdateCache = {
      checkedAt: patch.checkedAt,
      latest: patch.latest,
      skipped: patch.skipped === undefined ? prev?.skipped ?? null : patch.skipped,
    }
    return writeJson(file, next)
  } catch (e) {
    return false
  }
}

/** 记下「跳过这一版」。返回写盘是否成功（供调用方显式上报失败，不静默）。 */
export function skipVersion(file: string, version: unknown): boolean {
  const v = String(version ?? '').trim()
  if (!parseVersion(v)) return false
  const prev = readCache(file)
  return writeCache(file, { checkedAt: prev?.checkedAt ?? 0, latest: prev?.latest ?? null, skipped: v })
}

/** 问一次 registry。**任何失败都返回 `null`**（纪律 ①）；超时用 `AbortController` 硬断。 */
export async function fetchLatest(
  name: string = PLUGIN_PACKAGE_NAME,
  opts: { fetchImpl?: typeof fetch; registry?: string; timeoutMs?: number } = {},
): Promise<string | null> {
  const fetchImpl = opts.fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch
  if (typeof fetchImpl !== 'function') return null
  const url = `${opts.registry ?? NPM_REGISTRY}${encodeURIComponent(name)}`
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), opts.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, {
      signal: ctl.signal,
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
    if (!res || res.ok !== true) return null
    return pickLatest(await res.json())
  } catch (e) {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 依赖 spec 的**来源形态**。决定能不能给「一键升级」。
 *
 * ⚠️ 为什么必须有这一维（2026-10-12 真机踩到）：`upgradeSelf` 用的是 **registry spec**
 * （`<pkg>@x.y.z`），而宿主的 `installBundle` 就是 `pnpm add <spec>` ⇒ 对 `file:` 本地链接 /
 * git / tarball 的安装，一次点击会**把这个依赖静默换成 registry 版本**。那天就是这样把
 * desktop profile 的本地 `file:` 装成了线上版。⇒ **只有本来就是 registry 装法的才给一键**。
 *
 * 认不出的一律 `unknown` ——**保守方向**：不给一键，只给可复制的命令。
 */
export function classifyInstallSource(spec: unknown): 'registry' | 'other' | 'unknown' {
  if (spec === undefined || spec === null) return 'unknown'
  let s = String(spec).trim()
  if (!s) return 'unknown'

  // registry 别名 `npm:<name>[@<range>]` / `jsr:<name>[@<range>]`：剥掉前缀，**按末尾的 range 再判**
  // （`npm:foo@1.0.0` 里的 `npm:` 不是"非 registry 协议"，不能跟 `file:` 混为一谈）。
  const alias = /^(npm|jsr):/i.exec(s)
  if (alias) {
    const rest = s.slice(alias[0].length)
    if (!rest) return 'unknown'
    const at = rest.lastIndexOf('@')
    s = at > 0 ? rest.slice(at + 1) : ''
    if (!s) return 'registry' // 别名不带 range ⇒ 就是 registry 的 latest
  }

  // 显式非 registry 协议：本地链接 / workspace / git / 代码托管简写
  if (/^(file|link|workspace|portal|git|git\+[a-z]+|github|gitlab|bitbucket|gist):/i.test(s)) return 'other'
  // 本地路径：相对 / 绝对 / 盘符 / UNC / 家目录
  // ⚠️ `~` 必须**带分隔符**才算家目录——否则会把 `~1.2`（合法的 semver 范围）误判成本地路径。
  if (s.startsWith('.') || s.startsWith('/') || s.startsWith('~/') || s.startsWith('~\\') || s.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(s)) return 'other'
  // tarball 直链
  if (/^https?:\/\//i.test(s)) return 'other'
  // scp 形态的 git 地址 `user@host:path`
  if (/^[^@/:\s]+@[^:/\s]+:/i.test(s)) return 'other'
  // 剩下按 registry 的版本/范围处理：`1.2.3` / `^1` / `~1` / `>=1` / `v1` / `latest`
  if (/^[~^<>=]*\s*v?\d/.test(s)) return 'registry'
  if (/^(\*|latest|next|beta|alpha|rc|canary)$/i.test(s)) return 'registry'
  return 'unknown'
}

/**
 * 真一键的**前置门禁**（纯函数；ADR-0012 D2 的三条硬要求之一「run 中不动手」）。
 *
 * 四种拒绝各有**独立错误码**，由 UI 分别呈现——「宿主没有插件管理服务」「不是 registry 装法」
 * 「有流水线正在跑」是完全不同的三件事，合成一句「升级失败」等于把可行动信息丢掉。
 *
 * 判序：① 服务可用性 → ② 版本号合法性 → ③ 来源形态 → ④ 活跃 run。
 * - ② 在 ④ 之前：非法版本号是**调用方的编程错误**（UI 只会传它刚显示的那个版本），
 *   不该被「正好有 run 在跑」掩盖掉。
 * - ③ 在 ④ 之前：**永久性原因要压过临时性原因**——「这是本地安装，本来就不能一键」比
 *   「等 run 跑完再试」有用得多（后者会让人以为等一等就能点）。
 */
export function upgradeGate(o: { hasManager?: boolean; activeRuns?: number; version?: unknown; sourceKind?: unknown }):
  | { ok: true; spec: string }
  | { ok: false; error: 'plugin-manager-unavailable' | 'missing-version' | 'not-registry-install' | 'run-in-progress'; activeRuns: number } {
  const activeRuns = Math.max(0, Number(o?.activeRuns) || 0)
  if (o?.hasManager !== true) return { ok: false, error: 'plugin-manager-unavailable', activeRuns }
  const v = String(o?.version ?? '').trim()
  if (!parseVersion(v)) return { ok: false, error: 'missing-version', activeRuns }
  if (o?.sourceKind !== 'registry') return { ok: false, error: 'not-registry-install', activeRuns }
  if (activeRuns > 0) return { ok: false, error: 'run-in-progress', activeRuns }
  return { ok: true, spec: `${PLUGIN_PACKAGE_NAME}@${v}` }
}

/**
 * 主入口：拿一份可直接渲染的探测结果。**永不抛**。
 *
 * `force` 忽略缓存有效期（A/B 与端到端验证用：不 force 时第二次调用必然吃缓存，
 * 「探测到底跑没跑」就验不出来）。缓存过期但本次没问出来时，
 * **保留旧的 `latest` 并把 `error` 显式带出**——比「突然不提示了」有用。
 */
export async function checkForUpdate(
  opts: {
    file?: string
    now?: number
    ttlMs?: number
    timeoutMs?: number
    current?: string | null
    enabled?: boolean
    force?: boolean
    fetchImpl?: typeof fetch
  } = {},
): Promise<UpdateStatus> {
  const current = opts.current !== undefined ? opts.current : readOwnVersion()
  const enabled = opts.enabled !== undefined ? opts.enabled : updateCheckEnabled()
  const out: UpdateStatus = {
    enabled,
    current: typeof current === 'string' ? current : '',
    latest: null,
    outdated: false,
    skipped: null,
    checkedAt: null,
    error: null,
  }
  if (!enabled) return { ...out, error: 'disabled' }
  if (!parseVersion(out.current)) return { ...out, error: 'unknown-current-version' }

  let file = ''
  try {
    file = opts.file ?? updateCacheFile()
  } catch (e) {
    return { ...out, error: 'cache-path-unavailable' }
  }

  const cache = readCache(file)
  if (cache) {
    out.latest = cache.latest
    out.skipped = cache.skipped
    // `0` 是「只记过跳过、从没成功探测」——对外表达成「没查过」，不要暴露成时间戳 0。
    out.checkedAt = cache.checkedAt > 0 ? cache.checkedAt : null
  }

  const now = opts.now ?? Date.now()
  const ttl = opts.ttlMs ?? UPDATE_CHECK_TTL_MS
  const fresh = cache !== null && cache.checkedAt > 0 && now - cache.checkedAt < ttl
  if (!fresh || opts.force === true) {
    const latest = await fetchLatest(PLUGIN_PACKAGE_NAME, { fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs })
    if (latest) {
      out.latest = latest
      out.checkedAt = now
      if (!writeCache(file, { checkedAt: now, latest })) out.error = 'cache-write-failed'
    } else if (out.error === null) {
      // 问不出来也要说清楚：有旧缓存就继续用它，没有就只是「不知道」。
      out.error = 'registry-unreachable'
    }
  }

  out.outdated = shouldNotify({ current: out.current, latest: out.latest, skipped: out.skipped })
  return out
}
