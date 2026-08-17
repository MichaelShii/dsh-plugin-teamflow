/**
 * dsh-plugin-teamflow — 通用纯工具（底座；依赖 constants.ts，无其他依赖）。
 */
import { REFUSAL_PATTERN, STAGE_MIN_LENGTH } from './constants.ts'

export function toText(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}
export function clip(text, n) {
  const s = toText(text)
  return s.length > n ? s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]` : s
}
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}
/**
 * 产品名白名单归一化：只允许 [a-zA-Z0-9_-] 组成的路径段（可含 / 分隔）。
 * 拒绝：绝对路径、盘符、. / .. 段、空段、空白字符 —— 防止穿越 $DSH_HOME 写任意目录。
 * @returns {string|null} 归一化后的安全产品名，非法输入返回 null。
 */
export function normalizeRoot(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim().replace(/\\/g, '/')
  if (s.startsWith('/') || s.startsWith('.')) return null // 绝对路径、./、../、..
  if (/^[a-zA-Z]:/.test(s)) return null // 盘符（C:\x）
  if (s.includes('//') || s.includes('..')) return null // 空段、穿越段
  const segments = s.split('/')
  for (const seg of segments) {
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) return null // 每段仅字母数字下划线连字符
  }
  return segments.join('/')
}
export function normalizeTasks(tasks: unknown): Array<{ title: string; spec: string }> {
  if (!Array.isArray(tasks)) return []
  const out = []
  for (const t of tasks) {
    if (t === null || t === undefined) continue
    if (typeof t === 'string') {
      const s = t.trim()
      if (s) out.push({ title: s, spec: '' })
    } else if (typeof t === 'object') {
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null
      if (title) out.push({ title, spec: typeof t.spec === 'string' ? t.spec : '' })
    }
    if (out.length >= 8) break
  }
  return out
}
export function sanitizeSnapOptions(o) {
  const opts = (o && typeof o === 'object') ? o : {}
  return {
    needDesign: opts.needDesign === true,
    needScaffold: opts.needScaffold === true,
    lite: opts.lite === true,
    mode: (typeof opts.mode === 'string' && opts.mode) ? opts.mode : undefined,
    productRoot: typeof opts.productRoot === 'string' ? opts.productRoot : null,
    maxConcurrency: (Number.isFinite(opts.maxConcurrency) && opts.maxConcurrency > 0) ? Math.min(opts.maxConcurrency, 8) : null,
    tasks: Array.isArray(opts.tasks) ? opts.tasks.map((t) => ({ title: String((t && t.title) || ''), spec: String((t && t.spec) || '') })) : [],
  }
}
export const SAFE_SIGNAL = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }
export function normalizeSignal(s) {
  return (s && typeof s === 'object' && typeof s.addEventListener === 'function' && typeof s.aborted === 'boolean') ? s : SAFE_SIGNAL
}

/** 产出物实质校验：非空 + 无拒绝词 + 达到阶段长度下限。 */
export function hasSubstance(phase: string, text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false
  if (REFUSAL_PATTERN.test(text)) return false
  const min = STAGE_MIN_LENGTH[phase] ?? 100
  return text.trim().length >= min
}

/** 不可重试的失败原因（上下文耗尽/超长等——重试同一 prompt 大概率复现）。 */
export function isUnretryable(reason: unknown, outcome: unknown): boolean {
  const r = String(reason || outcome || '')
  return /context|limit|max-token|token|tool-error/i.test(r)
}

/** 阶段产出 → 精简交接摘要（供审计/展示；产出含显式 <!-- handoff --> 块则优先取块内内容）。 */
export function handoffBrief(text: string | null | undefined): string {
  if (!text || !String(text).trim()) return ''
  const m = String(text).match(/<!--\s*handoff\s*-->([\s\S]*?)(?:<!--\s*\/handoff\s*-->|$)/)
  const brief = (m && m[1] ? m[1] : String(text)).trim()
  return clip(brief, 2000)
}
