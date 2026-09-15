/**
 * dsh-plugin-teamflow — browser half 共享展示层（主题 token / 状态词表 / 格式化）。
 *
 * 会话内工作台（index.tsx）与全局面板（panel.tsx）共用：**只放无状态纯展示件**，
 * 不放任何 Remote 调用或会话上下文逻辑——两边数据来源不同（sessionId / productKey），
 * 展示语言必须一致。
 *
 * 双语（v0.1.9）：文案统一走宿主 locale 服务（机制说明见 client/locales.ts）。
 * 组件里能拿到注入的 `t`，但**词表/格式化/折叠件是纯函数**，拿不到 prop，
 * 故由 `apply()` 调 `setTranslator()` 注入模块级翻译函数：`bind()` 每次调用都读当前语言，
 * 且宿主在切语言时会重渲染每个 slot outlet（ui-renderer `useLocaleRevision`），
 * 因此模块级函数不会持有过期语言。
 */
import React from 'react'

/** 翻译函数（默认恒等：未注入时显示 key 本身，便于发现漏注册）。 */
let translate: (key: string, params?: Record<string, unknown>) => string = (key) => key
/** 当前语言 id 的读取器（默认 en）。 */
let localeIdOf: () => string = () => 'en'

/**
 * 注入翻译函数与语言读取器（apply 时调用一次）。
 * @param fn - `ctx.locale.bind(NS)` 的返回值（调用时读当前语言）。
 * @param idOf - 返回当前语言 id 的函数（如 `() => ctx.locale.getSnapshot().active`）。
 */
export function setTranslator(fn, idOf?) {
  if (typeof fn === 'function') translate = fn
  if (typeof idOf === 'function') localeIdOf = idOf
}

/** 翻译（`{name}` 占位符由宿主替换）。 */
export const t = (key, params?: Record<string, unknown>) => translate(key, params)

/** 当前语言的 BCP 47 标签（时间格式化用；未知语言回退 en）。 */
export function localeTag() {
  let id = 'en'
  try { id = String(localeIdOf() || 'en') } catch (e) { /* 服务未就绪 */ }
  return id === 'zh' ? 'zh-CN' : id
}

/** 词表查表：命中返回译文，未命中回退原始值（未知状态/角色等）。 */
function vocab(prefix, raw) {
  const key = `${prefix}.${raw}`
  const hit = t(key)
  return hit === key ? String(raw === null || raw === undefined ? '' : raw) : hit
}
export const stText = (s) => vocab('status', s)
export const runStatusText = (s) => vocab('runStatus', s)
export const kindTitle = (k) => vocab('kind', k)
export const roleName = (r) => vocab('role', r)
/** 角色 chip（带图标；未知角色回退「⚙️ <raw>」）。 */
export function roleChip(r) {
  const key = `roleChip.${r}`
  const hit = t(key)
  return hit === key ? `⚙️ ${String(r)}` : hit
}

/* ── 主题 token（自动适配深浅色） ─────────────────────────────────── */
export const T = {
  bg: 'var(--dsw-alias-bg-base)',
  layer1: 'var(--dsw-alias-bg-layer-1)',
  layer2: 'var(--dsw-alias-bg-layer-2)',
  border: 'var(--dsw-alias-border-l1)',
  border2: 'var(--dsw-alias-border-l2)',
  brand: 'var(--dsw-alias-brand-primary)',
  text: 'var(--dsw-alias-label-primary)',
  text2: 'var(--dsw-alias-label-secondary)',
  error: 'var(--dsw-alias-state-error-primary)',
  success: 'var(--dsw-alias-state-success-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
}

/** 状态色表（与语言无关的纯视觉映射）。 */
export const STATUS_COLOR = {
  created: T.text2, pending: T.text2, open: T.text2,
  'in-progress': T.brand, running: T.brand, claimed: T.brand, testing: T.brand, fixed: T.brand, reopened: '#8250df',
  'pending-acceptance': T.warn, testable: T.warn,
  accepted: T.success, verified: T.success, completed: T.success, done: T.success,
  rework: T.error, failed: T.error, 'needs-human': T.error, cancelled: T.text2, closed: T.text2,
  interrupted: T.warn, superseded: T.text2,
}
/** 阶段英文键 → 图标（2026-09-06 英文化：journal.phase 为英文键，展示名统一走词表——换语言即换表）。 */
export const PHASE_ICON = {
  prd: '📋', design: '🎨', scaffold: '🏗️', tech: '📐', dev: '💻', qa: '🧪', acceptance: '✅',
}
/** phase 归一：英文键直通；存量中文映射（防御性——新数据全英文）。 */
export const phaseKeyOf = (p) => ({ 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' })[p] || String(p || '')
export const phaseNameOf = (p) => vocab('phase', phaseKeyOf(p))
export const phaseIconOf = (p) => PHASE_ICON[phaseKeyOf(p)] || '⚙️'
/**
 * 阶段的展示名（双语安全的取法）。
 *
 * journal 里 `stage.label` 是**持久化中文**（teams.json 配置 + 历史数据），而每个阶段都带
 * 英文 `phase` 键——所以展示时：任务级阶段（dev 子卡，`taskKey` 有值）保留任务名（LLM 数据，
 * 不该翻译），其余阶段用 `phase` 键查当前语言词表。**只影响展示，不动数据**：
 * `__taskKey`/`taskKeyOf` 的任务聚合身份仍走 label 清理（聚合语义不能随语言变）。
 */
export function stageLabelOf(s) {
  const raw = String((s && s.label) || '')
  if (s && s.taskKey) return raw || String(s.taskKey)
  return (s && s.phase ? phaseNameOf(s.phase) : '') || raw
}
export const COLUMNS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'closed', 'needs-human'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}

export const h = React.createElement
export const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace'
export const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
export const flexRow = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

/** 状态徽章：半透明底 + 状态色文字 + 圆角 pill（超宽可省略：窄列/窄卡里不顶破外层）。 */
export const chip = (text, color, opts: { style?: Record<string, string>; dot?: boolean } = {}) => h('span', {
  style: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, lineHeight: '16px',
    background: `color-mix(in srgb, ${color} 14%, transparent)`, color,
    whiteSpace: 'nowrap', maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis',
    ...(opts.style || {}),
  },
}, opts.dot ? h('span', { style: { width: 5, height: 5, borderRadius: 999, background: color, display: 'inline-block', flex: '0 0 auto' } }) : null, text)

/** 可折叠长文本：默认只显示前几行预览，「展开全文」/「收起」双向切换（数据不动，纯展示层——summary/需求原文等富文本不再铺满抽屉）。 */
export function FoldableText({ text, charLimit = 280, lineLimit = 5, style }: { text: unknown; charLimit?: number; lineLimit?: number; style?: Record<string, unknown> }) {
  const [open, setOpen] = React.useState(false)
  if (!text) return null
  const s = String(text)
  const lines = s.split('\n')
  const compact = lines.length <= lineLimit && s.length <= charLimit
  const body = (txt) => h('div', { style: { fontSize: 11.5, color: T.text, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(style || {}) } }, txt)
  if (compact) return body(s)
  if (open) return h('div', null,
    body(s),
    h('button', {
      onClick: () => setOpen(false),
      title: t('common.collapseFull'),
      style: { marginTop: 3, font: 'inherit', fontSize: 10.5, fontWeight: 600, color: T.text2, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
    }, t('common.collapse')),
  )
  const pre = lines.length > lineLimit ? lines.slice(0, lineLimit).join('\n') : s.slice(0, charLimit)
  const more = lines.length > lineLimit ? t('common.moreLines', { n: lines.length - lineLimit }) : '…'
  return h('div', null,
    body(pre),
    h('button', {
      onClick: () => setOpen(true),
      title: t('common.clickToExpand'),
      style: { marginTop: 3, font: 'inherit', fontSize: 10.5, fontWeight: 600, color: T.brand, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
    }, `${t('common.expandFull')}${more}`),
  )
}

export function fmtTime(tm) {
  if (!tm) return '—'
  const d = new Date(tm)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
export function fmtDur(a, b) {
  if (!a) return ''
  const ms = (b || Date.now()) - a
  if (ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}
export function fmtTokens(n) {
  if (n === null || n === undefined) return ''
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
/** 官方口径计费合计（billed input + output）。 */
export function totalTokens(u) { return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0) }
/** 官方口径工具函数（与 DeepSeek usage 账单对齐，零额外概念）：
 *  - u.input       : 输入（缓存未命中）
 *  - u.cacheRead   : 输入（缓存命中）
 *  - u.cacheWrite  : 输入写入缓存
 *  - u.output      : 输出
 *  billed input = input + cacheRead + cacheWrite；命中率 = cacheRead / (input + cacheRead)。
 */
export function hitRate(u) {
  const total = (u.input || 0) + (u.cacheRead || 0)
  return total > 0 ? Math.round(((u.cacheRead || 0) / total) * 100) : null
}
export function usageDetail(s) {
  const k = (n) => (n === null || n === undefined ? '—' : fmtTokens(n))
  if (s.usage) {
    const u = s.usage
    const hit = hitRate(u)
    return t('token.usageLine', {
      input: k(u.input), cacheRead: k(u.cacheRead), cacheWrite: k(u.cacheWrite), output: k(u.output), calls: u.calls,
    }) + (hit !== null ? t('token.usageHit', { hit }) : '')
  }
  return t('token.usageMissing')
}
/** 节点卡主 token 行：官方口径 —— 输入(未命中)/输入(命中)/输出 + 缓存命中率。 */
export function stageUsageLine(s) {
  const u = s && s.usage
  if (u && (u.input || u.cacheRead || u.cacheWrite || u.output)) {
    const hit = hitRate(u)
    return `⇅${fmtTokens(u.input)} ⇅${fmtTokens(u.cacheRead)} ⬆${fmtTokens(u.output)}${hit !== null ? ` ·${hit}%` : ''}`
  }
  return null
}
export const roleUsage = (u) => {
  if (!u) return ''
  const hit = hitRate(u)
  return `⇅${fmtTokens(u.input || 0)}/${fmtTokens(u.cacheRead || 0)}·⬆${fmtTokens(u.output || 0)}${hit !== null ? `·${hit}%` : ''}`
}
/** 任务卡按角色累计的真实 token 摘要（官方口径：未命中/命中输入 + 输出 + 命中率）。 */
export function byRoleLine(task) {
  const roles = (task && task.byRole) || {}
  const parts = Object.keys(roles)
    .filter((k) => roles[k] && (roles[k].input + roles[k].output + roles[k].cacheRead + roles[k].cacheWrite) > 0)
    .map((k) => `${roleName(k)} ${roleUsage(roles[k])}`)
  return parts.join(' · ')
}
/** 多阶段 usage 汇总（官方口径）。 */
export function totalUsage(stages) {
  const sum = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  for (const s of (stages || [])) {
    const u = s && s.usage
    if (!u) continue
    sum.input += u.input || 0
    sum.cacheRead += u.cacheRead || 0
    sum.cacheWrite += u.cacheWrite || 0
    sum.output += u.output || 0
    sum.calls += u.calls || 0
  }
  return sum
}
export const stColor = (s) => STATUS_COLOR[s] || T.text2
