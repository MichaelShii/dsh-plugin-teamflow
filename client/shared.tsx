/**
 * dsh-plugin-teamflow — browser half 共享展示层（主题 token / 状态词表 / 格式化）。
 *
 * 会话内工作台（index.tsx）与全局面板（panel.tsx）共用：**只放无状态纯展示件**，
 * 不放任何 Remote 调用或会话上下文逻辑——两边数据来源不同（sessionId / productKey），
 * 展示语言必须一致。
 */
import React from 'react'

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

export const STATUS_TEXT = {
  created: '立项', 'in-progress': '进行中', 'pending-acceptance': '待验收', accepted: '已验收', closed: '已关闭',
  pending: '待办', running: '开发中', testable: '待测试', testing: '测试中', rework: '打回',
  'needs-human': '需人工', cancelled: '已关闭', open: '待认领', claimed: '处理中', fixed: '已修复待验',
  verified: '已关闭', reopened: '重开', done: '已完成', completed: '已完成', failed: '失败',
  interrupted: '已中断', superseded: '已取代',}
export const STATUS_COLOR = {
  created: T.text2, pending: T.text2, open: T.text2,
  'in-progress': T.brand, running: T.brand, claimed: T.brand, testing: T.brand, fixed: T.brand, reopened: '#8250df',
  'pending-acceptance': T.warn, testable: T.warn,
  accepted: T.success, verified: T.success, completed: T.success, done: T.success,
  rework: T.error, failed: T.error, 'needs-human': T.error, cancelled: T.text2, closed: T.text2,
  interrupted: T.warn, superseded: T.text2,
}
/** 阶段英文键 → 图标/中文展示名（2026-09-06 英文化：journal.phase 为英文键，展示名统一走映射——未来 i18n 换表即换语言）。 */
export const PHASE_ICON = {
  prd: '📋', design: '🎨', scaffold: '🏗️', tech: '📐', dev: '💻', qa: '🧪', acceptance: '✅',
}
export const PHASE_NAME = { prd: 'PRD 产品需求', design: 'UI/UX 设计', scaffold: '架构规划', tech: '技术方案', dev: '开发', qa: 'QA 测试', acceptance: '产品验收' }
export const phaseNameOf = (p) => PHASE_NAME[p] || p || '—'
export const phaseIconOf = (p) => PHASE_ICON[p] || '⚙️'
/** phase 归一：英文键直通；存量中文映射（防御性——新数据全英文）。 */
export const phaseKeyOf = (p) => ({ 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' })[p] || String(p || '')
export const RUN_STATUS_TEXT = { pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', superseded: '已取代' }
export const COLUMNS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'closed', 'needs-human'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}
export const KIND_TITLE = { req: '需求', task: '任务', bug: '缺陷' }

export const h = React.createElement
export const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace'
export const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
export const flexRow = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

/** 状态徽章：半透明底 + 状态色文字 + 圆角 pill。 */
export const chip = (text, color, opts: { style?: Record<string, string>; dot?: boolean } = {}) => h('span', {
  style: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, lineHeight: '16px',
    background: `color-mix(in srgb, ${color} 14%, transparent)`, color,
    whiteSpace: 'nowrap', ...(opts.style || {}),
  },
}, opts.dot ? h('span', { style: { width: 5, height: 5, borderRadius: 999, background: color, display: 'inline-block' } }) : null, text)

/** 可折叠长文本：默认只显示前几行预览，「展开全文」/「收起」双向切换（数据不动，纯展示层——summary/需求原文等富文本不再铺满抽屉）。 */
export function FoldableText({ text, charLimit = 280, lineLimit = 5, style }: { text: unknown; charLimit?: number; lineLimit?: number; style?: Record<string, unknown> }) {
  const [open, setOpen] = React.useState(false)
  if (!text) return null
  const t = String(text)
  const lines = t.split('\n')
  const compact = lines.length <= lineLimit && t.length <= charLimit
  const body = (txt) => h('div', { style: { fontSize: 11.5, color: T.text, lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word', ...(style || {}) } }, txt)
  if (compact) return body(t)
  if (open) return h('div', null,
    body(t),
    h('button', {
      onClick: () => setOpen(false),
      title: '收起全文',
      style: { marginTop: 3, font: 'inherit', fontSize: 10.5, fontWeight: 600, color: T.text2, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
    }, '收起'),
  )
  const pre = lines.length > lineLimit ? lines.slice(0, lineLimit).join('\n') : t.slice(0, charLimit)
  const more = lines.length > lineLimit ? `… +${lines.length - lineLimit} 行` : '…'
  return h('div', null,
    body(pre),
    h('button', {
      onClick: () => setOpen(true),
      title: '点击查看全文',
      style: { marginTop: 3, font: 'inherit', fontSize: 10.5, fontWeight: 600, color: T.brand, background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' },
    }, `展开全文${more}`),
  )
}

export function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
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
    return `输入(未命中) ${k(u.input)} / 输入(命中) ${k(u.cacheRead)} / 写缓存 ${k(u.cacheWrite)} / 输出 ${k(u.output)} · ${u.calls} 次调用${hit !== null ? ` · 缓存命中 ${hit}%` : ''}`
  }
  return '无 usage 明细'
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
export const ROLE_NAME = { pm: '产品', design: '设计', arch: '架构', tech: '方案', dev: '开发', qa: '测试', acceptance: '验收', other: '其他' }
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
    .map((k) => `${ROLE_NAME[k] || k} ${roleUsage(roles[k])}`)
  return parts.join(' · ')
}
/** 多阶段 usage 汇总（官方口径）。 */
export function totalUsage(stages) {
  const t = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
  for (const s of (stages || [])) {
    const u = s && s.usage
    if (!u) continue
    t.input += u.input || 0
    t.cacheRead += u.cacheRead || 0
    t.cacheWrite += u.cacheWrite || 0
    t.output += u.output || 0
    t.calls += u.calls || 0
  }
  return t
}
export const stText = (s) => STATUS_TEXT[s] || s
export const stColor = (s) => STATUS_COLOR[s] || T.text2
