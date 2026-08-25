/**
 * dsh-plugin-teamflow — browser half（v0.7 视觉重构：「精密工程控制台」）。
 *
 * 注册 conversation.view tab「🏭 团队工作台」（与 chat / 轨迹并列）：
 * - 流水线图形工作流：阶段泳道 + 节点卡片（状态/耗时/token/子代理会话）+ 实时轮询
 * - Backlog 拖拽看板：需求/任务/缺陷三组状态泳道，卡片拖拽流转（原生 HTML5 DnD，零依赖）
 * - 成本中心：每阶段 token + 总计 + 运行时长
 * - 人工介入中心：needs-human 项聚合 + 一键终态
 * - 历史 run 切换
 *
 * 视觉：全部使用 DSH 主题 token（--dsw-alias-*，自动适配深浅色）。
 * Remote 接入：$mount 后 ctx.get('remote.teamflow') 取全局实例传给组件
 * （不能 inject 'remote.teamflow'——自挂载自注入会让 fiber 死锁）。
 */
import React from 'react'
import { TEAMFLOW_REMOTE_CONTRIBUTION } from '../descriptors.js'

export const inject = ['remote', 'slots', 'sessions', 'locale']

/* ── 主题 token（自动适配深浅色） ─────────────────────────────────── */
const T = {
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

const STATUS_TEXT = {
  created: '立项', 'in-progress': '进行中', 'pending-acceptance': '待验收', accepted: '已验收', closed: '已关闭',
  pending: '待办', running: '开发中', testable: '待测试', testing: '测试中', rework: '打回',
  'needs-human': '需人工', cancelled: '已关闭', open: '待认领', claimed: '处理中', fixed: '已修复待验',
  verified: '已关闭', reopened: '重开', done: '已完成', completed: '已完成', failed: '失败',
  interrupted: '已中断', superseded: '已取代',}
const STATUS_COLOR = {
  created: T.text2, pending: T.text2, open: T.text2,
  'in-progress': T.brand, running: T.brand, claimed: T.brand, testing: T.brand, fixed: T.brand, reopened: '#8250df',
  'pending-acceptance': T.warn, testable: T.warn,
  accepted: T.success, verified: T.success, completed: T.success, done: T.success,
  rework: T.error, failed: T.error, 'needs-human': T.error, cancelled: T.text2, closed: T.text2,
  interrupted: T.warn, superseded: T.text2,
}
const PHASE_ICON = {
  'PRD 产品需求': '📋', 'UI/UX 设计': '🎨', '架构规划': '🏗️', '技术方案': '📐',
  开发: '💻', 'QA 测试': '🧪', '产品验收': '✅',
}
const RUN_STATUS_TEXT = { pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', superseded: '已取代' }
const COLUMNS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'closed', 'needs-human'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}
const KIND_TITLE = { req: '需求', task: '任务', bug: '缺陷' }

const h = React.createElement
const MONO = 'ui-monospace, SFMono-Regular, Consolas, "Cascadia Mono", monospace'
const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
const flexRow = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }

/** 状态徽章：半透明底 + 状态色文字 + 圆角 pill。 */
const chip = (text, color, opts: { style?: Record<string, string>; dot?: boolean } = {}) => h('span', {
  style: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '1px 8px', borderRadius: 999, fontSize: 11, fontWeight: 500, lineHeight: '16px',
    background: `color-mix(in srgb, ${color} 14%, transparent)`, color,
    whiteSpace: 'nowrap', ...(opts.style || {}),
  },
}, opts.dot ? h('span', { style: { width: 5, height: 5, borderRadius: 999, background: color, display: 'inline-block' } }) : null, text)

function fmtTime(t) {
  if (!t) return '—'
  const d = new Date(t)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`
}
function fmtDur(a, b) {
  if (!a) return ''
  const ms = (b || Date.now()) - a
  if (ms < 0) return ''
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${s % 60}s`
}
function fmtTokens(n) {
  if (n === null || n === undefined) return ''
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}
/** 官方口径计费合计（billed input + output）。 */
function totalTokens(u) { return (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.output || 0) }
/** 官方口径工具函数（与 DeepSeek usage 账单对齐，零额外概念）：
 *  - u.input       : 输入（缓存未命中）
 *  - u.cacheRead   : 输入（缓存命中）
 *  - u.cacheWrite  : 输入写入缓存
 *  - u.output      : 输出
 *  billed input = input + cacheRead + cacheWrite；命中率 = cacheRead / (input + cacheRead)。
 */
function hitRate(u) {
  const total = (u.input || 0) + (u.cacheRead || 0)
  return total > 0 ? Math.round(((u.cacheRead || 0) / total) * 100) : null
}
function usageDetail(s) {
  const k = (n) => (n === null || n === undefined ? '—' : fmtTokens(n))
  if (s.usage) {
    const u = s.usage
    const hit = hitRate(u)
    return `输入(未命中) ${k(u.input)} / 输入(命中) ${k(u.cacheRead)} / 写缓存 ${k(u.cacheWrite)} / 输出 ${k(u.output)} · ${u.calls} 次调用${hit !== null ? ` · 缓存命中 ${hit}%` : ''}`
  }
  return '无 usage 明细'
}
/** 节点卡主 token 行：官方口径 —— 输入(未命中)/输入(命中)/输出 + 缓存命中率。 */
function stageUsageLine(s) {
  const u = s && s.usage
  if (u && (u.input || u.cacheRead || u.cacheWrite || u.output)) {
    const hit = hitRate(u)
    return `⇅${fmtTokens(u.input)} ⇅${fmtTokens(u.cacheRead)} ⬆${fmtTokens(u.output)}${hit !== null ? ` ·${hit}%` : ''}`
  }
  return null
}
const ROLE_NAME = { pm: '产品', design: '设计', arch: '架构', tech: '方案', dev: '开发', qa: '测试', acceptance: '验收', other: '其他' }
const roleUsage = (u) => {
  if (!u) return ''
  const hit = hitRate(u)
  return `⇅${fmtTokens(u.input || 0)}/${fmtTokens(u.cacheRead || 0)}·⬆${fmtTokens(u.output || 0)}${hit !== null ? `·${hit}%` : ''}`
}
/** 任务卡按角色累计的真实 token 摘要（官方口径：未命中/命中输入 + 输出 + 命中率）。 */
function byRoleLine(task) {
  const roles = (task && task.byRole) || {}
  const parts = Object.keys(roles)
    .filter((k) => roles[k] && (roles[k].input + roles[k].output + roles[k].cacheRead + roles[k].cacheWrite) > 0)
    .map((k) => `${ROLE_NAME[k] || k} ${roleUsage(roles[k])}`)
  return parts.join(' · ')
}
/** 多阶段 usage 汇总（官方口径）。 */
function totalUsage(stages) {
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
const stText = (s) => STATUS_TEXT[s] || s
const stColor = (s) => STATUS_COLOR[s] || T.text2

/* ── 流水线面板：横向蛇形流程画布（从左至右 · 弧线连接 · 流动动画 · 画布拖动/缩放） ── */
const NODE_W = 300        // 节点宽度
const PHASE_GAP = 88      // 相位间水平间距（连接线长度）
const WAVE = 56           // 相邻相位垂直错位幅度（产生上下弧线）
const CARD_H = 54         // 阶段卡固定高度
const CARD_H_RUN = 64     // 运行中卡略高（含进度条）
const HEAD_H = 38         // 相位头高度
const PAD_L = 46
const PAD_R = 72
const PAD_T = 42
const PAD_B = 46
const cardH = (s) => (s.status === 'running' ? CARD_H_RUN : CARD_H)

/** 横向布局：相位从左至右一排，上下轻微波浪错位（弧线自然成形）+ 绝对定位节点 + 连接锚点。
 *  返回 nodes/conns/worldW/worldH。 */
function layoutFlow(groups, viewW) {
  const nodes = []
  const conns = []
  let maxH = 0
  groups.forEach((g, i) => {
    const anyRun = g.stages.some((s) => s.status === 'running')
    const anyFail = g.stages.some((s) => s.status === 'failed' || s.status === 'needs-human' || s.status === 'cancelled')
    const allDone = g.stages.length > 0 && g.stages.every((s) => s.status === 'done')
    const headColor = anyRun ? T.brand : anyFail ? T.error : allDone ? T.success : T.text2
    const h = HEAD_H + 10 + g.stages.reduce((a, s) => a + cardH(s), 0) + Math.max(0, g.stages.length - 1) * 7
    maxH = Math.max(maxH, h)
    nodes.push({ i, phase: g.phase, stages: g.stages, left: PAD_L + i * (NODE_W + PHASE_GAP), h, headColor })
  })
  const axisY = PAD_T + WAVE / 2 + maxH / 2 // 垂直中心轴（两侧各留波浪余量）
  nodes.forEach((n) => {
    n.top = axisY + (n.i % 2 === 0 ? -1 : 1) * (WAVE / 2) - n.h / 2
    n.centerY = n.top + n.h / 2
  })
  for (let i = 1; i < nodes.length; i++) {
    const p = nodes[i - 1], n = nodes[i]
    conns.push({ x1: p.left + NODE_W, y1: p.centerY, x2: n.left, y2: n.centerY, color: n.headColor })
  }
  const worldW = PAD_L + nodes.length * (NODE_W + PHASE_GAP) - PHASE_GAP + PAD_R
  const worldH = PAD_T + WAVE + maxH + PAD_B
  return { nodes, conns, worldW, worldH }
}

/** S 形弧线路径（从左至右，前后锚点沿水平方向缓进出、垂直方向呈现波浪弧）。 */
function connPath(c) {
  const dx = Math.max(48, (c.x2 - c.x1) / 2)
  return `M ${c.x1} ${c.y1} C ${c.x1 + dx} ${c.y1}, ${c.x2 - dx} ${c.y2}, ${c.x2} ${c.y2}`
}

function FlowStageCard(s, key, onOpen) {
  const color = stColor(s.status)
  const running = s.status === 'running'
  const usage = stageUsageLine(s)
  return h('div', {
    key,
    title: `${s.label} —— 点击查看阶段详情`,
    onMouseDown: (e) => e.stopPropagation(), // 不触发画布拖动，允许点击
    onClick: () => onOpen && onOpen(s),
    style: {
      boxSizing: 'border-box', height: cardH(s), borderRadius: 10, position: 'relative', overflow: 'hidden',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3, padding: '6px 11px 6px 13px',
      background: `linear-gradient(135deg, color-mix(in srgb, ${color} 8%, ${T.layer1}), ${T.layer1} 64%)`,
      border: `1px solid ${T.border}`, borderLeft: `3px solid ${color}`,
      opacity: s.status === 'pending' ? 0.56 : 1,
      cursor: 'pointer',
      transition: 'transform .12s ease, box-shadow .12s ease, border-color .12s ease',
      boxShadow: running ? `0 0 0 1px color-mix(in srgb, ${color} 32%, transparent), 0 6px 18px color-mix(in srgb, ${color} 15%, transparent)` : '0 1px 2px rgba(0,0,0,.05)',
    },
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 6 } },
      running ? h('span', { style: { width: 7, height: 7, borderRadius: 999, background: color, animation: 'tf-pulse 1.15s ease-in-out infinite' } })
        : h('span', { style: { width: 6, height: 6, borderRadius: 2, background: color } }),
      h('span', { title: s.label, style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
      chip(stText(s.status), color, { dot: true }),
      h('span', { style: { color: T.text2, fontSize: 11, opacity: 0.5 } }, '↗'),
    ),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, paddingLeft: 13, fontSize: 10.5, color: T.text2, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' } },
      s.startedAt ? h('span', {}, fmtDur(s.startedAt, s.endedAt)) : h('span', {}, '—'),
      usage ? h('span', { title: usageDetail(s), style: { marginLeft: 'auto', color } }, usage) : null,
    ),
    running ? h('div', { style: { position: 'absolute', left: 5, right: 5, bottom: 3, height: 2, borderRadius: 2, overflow: 'hidden', background: `color-mix(in srgb, ${color} 20%, transparent)` } },
      h('div', { style: { height: '100%', width: '42%', borderRadius: 2, background: color, animation: 'tf-shimmer 1.1s linear infinite' } }),
    ) : null,
  )
}

function FlowNode(node, onOpen) {
  const g = node
  const running = g.stages.some((s) => s.status === 'running')
  return h('div', {
    key: 'n' + g.i,
    style: { position: 'absolute', left: g.left, top: g.top, width: NODE_W, height: g.h, boxSizing: 'border-box', display: 'flex', flexDirection: 'column' },
  },
    /* 步骤序号徽标（悬在左上角，突出编号与次序） */
    h('div', {
      style: {
        position: 'absolute', top: -8, left: 12, width: 22, height: 22, borderRadius: 7, zIndex: 2,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        fontFamily: MONO, fontSize: 10.5, fontWeight: 800, color: g.headColor,
        background: `color-mix(in srgb, ${g.headColor} 16%, ${T.layer1})`,
        border: `1px solid color-mix(in srgb, ${g.headColor} 36%, transparent)`,
        boxShadow: '0 2px 8px rgba(0,0,0,.14)',
      },
    }, String(g.i + 1).padStart(2, '0')),
    /* 相位头 */
    h('div', {
      style: {
        height: HEAD_H, boxSizing: 'border-box', borderRadius: 11, padding: '0 11px',
        display: 'flex', alignItems: 'center', gap: 7,
        color: g.headColor, fontSize: 12.5, fontWeight: 700,
        background: `linear-gradient(90deg, color-mix(in srgb, ${g.headColor} 13%, transparent), color-mix(in srgb, ${g.headColor} 5%, transparent))`,
        border: `1px solid color-mix(in srgb, ${g.headColor} 30%, transparent)`,
      },
    },
      h('span', { style: { fontSize: 13.5 } }, PHASE_ICON[g.phase] || '⚙️'),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.phase),
      g.stages.length > 1 ? h('span', { style: { fontFamily: MONO, fontSize: 10, fontWeight: 800, background: `color-mix(in srgb, ${g.headColor} 16%, transparent)`, borderRadius: 999, padding: '0 7px', lineHeight: '16px' } }, `×${g.stages.length}`) : null,
      running ? h('span', { style: { width: 8, height: 8, borderRadius: 999, background: g.headColor, animation: 'tf-pulse 1.4s ease-in-out infinite' } }) : null,
    ),
    /* 卡片列 */
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 10 } },
      g.stages.map((s) => FlowStageCard(s, s.seq, onOpen)),
    ),
  )
}

/** 阶段详情抽屉（卡片点击打开；浮于画布右侧，不参与拖动/缩放）。 */
function StageDetailDrawer({ det, onClose, sessionId, sessions }) {
  const st = det.stage
  const d = det.data
  const color = (st && st.status) ? stColor(st.status) : T.text2
  // 跨会话判定：该 run 由另一会话发起（ownerSession ≠ 当前会话）→ 禁用跳转（DSH 目录按父会话加载，跨父导航暂不支持）
  const ownerSession = (d && d.ownerSession) ? String(d.ownerSession) : null
  const mySession = sessionId ? String(sessionId) : null
  const crossSession = !!ownerSession && !!mySession && ownerSession !== mySession
  const hasChild = !!(!crossSession && d && d.childId && sessions && typeof sessions.openSubagent === 'function')
  const openChild = () => {
    if (crossSession || !hasChild) return
    try { sessions.openSubagent({ parentSessionId: (ownerSession || sessionId), childSessionId: d.childId, mode: 'one-shot' }) } catch (e) { /* 会话跳转失败忽略 */ }
  }
  const outText = d && d.output ? d.output
    : d && d.summary ? `（该 run 未保存完整正文，展示摘要）\n\n${d.summary}`
    : det.err ? `⚠ 加载失败：${det.err}`
    : det.loading ? '加载中…'
    : '（无产物正文）'
  const closeBtn = { font: 'inherit', width: 26, height: 26, borderRadius: 8, cursor: 'pointer', border: `1px solid ${T.border}`, background: 'transparent', color: T.text2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, lineHeight: 1 }
  // 悬浮于画布右上（不挤占画布宽度）。滚轮在浮层内只滚自身内容：
  // 用原生 wheel stopPropagation 在冒泡到画布前拦下，避免触发画布缩放。
  const pRef = React.useRef(null)
  React.useEffect(() => {
    const el = pRef.current
    if (!el) return
    const stop = (e) => e.stopPropagation()
    el.addEventListener('wheel', stop, { passive: true })
    return () => el.removeEventListener('wheel', stop)
  }, [])
  return h('div', {
    ref: pRef,
    style: {
      position: 'absolute', top: 10, right: 12, bottom: 10, width: 384, zIndex: 8,
      borderRadius: 14, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${T.border}`,
      background: `color-mix(in srgb, ${T.layer1} 90%, transparent)`,
      backdropFilter: 'blur(14px)',
      boxShadow: '0 14px 48px rgba(0,0,0,.30)',
    },
  },
    /* 头 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: `1px solid ${T.border}`, background: `linear-gradient(135deg, color-mix(in srgb, ${color} 14%, transparent), transparent 62%)` } },
      h('span', { style: { fontSize: 17 } }, PHASE_ICON[st && st.phase] || '⚙️'),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { title: st ? st.label : undefined, style: { fontSize: 12.5, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st ? st.label : '阶段详情'),
        h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 1, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' } },
          `${st ? `#${st.seq} · ${st.phase}` : ''}${(st && (st.startedAt || st.endedAt)) ? ` · ${fmtDur(st.startedAt, st.endedAt)}` : ''}`),
      ),
      st ? chip(stText(st.status), color, { dot: true }) : null,
      h('button', { onClick: onClose, style: closeBtn, title: '关闭' }, '✕'),
    ),
    /* 内容 */
    h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 11 } },
      /* usage 明细（官方口径全字段） */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, 'TOKEN · 官方口径'),
        h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text, lineHeight: 1.65 } }, usageDetail(d || st || {})),
      ),
      /* 跳子代理会话（当前 DSH 未暴露"切 conversation.view 视图"接口：openSubagent 仅完成跳转，
         完整轨迹需到「对话」tab 查看；待官方 conversation.setView 支持后再一键直达，见 AGENTS §6 待办） */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('button', {
          onClick: openChild, disabled: !hasChild,
          title: crossSession
            ? `该子代理由会话 ${ownerSession.slice(-6)} 发起，跨会话跳转暂不支持——请打开其发起会话的团队工作台查看`
            : hasChild ? '跳转到该阶段子代理会话（完整推理与工具调用轨迹）；跳转后请切换「对话」tab 查看' : '该阶段无可用子代理会话',
          style: {
            font: 'inherit', fontSize: 12, fontWeight: 600, padding: '8px 12px', borderRadius: 9, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
            border: `1px solid color-mix(in srgb, ${T.brand} 40%, transparent)`,
            background: `color-mix(in srgb, ${T.brand} 12%, transparent)`, color: T.brand,
            opacity: hasChild ? 1 : 0.45,
          },
        }, '🎬 跳转子代理会话'),
        crossSession
          ? h('div', { style: { fontSize: 10.5, color: T.text2, textAlign: 'center', lineHeight: 1.55 } },
            `跨会话暂不支持：该子代理由会话 ${ownerSession ? ownerSession.slice(-6) : ''} 发起。如需查看轨迹，请打开其发起会话的团队工作台。`)
          : hasChild ? h('div', { style: { fontSize: 10.5, color: T.text2, textAlign: 'center', lineHeight: 1.55 } },
            '跳转成功后，请切「对话」tab 查看该子代理的完整会话轨迹') : null,
      ),
      /* 产物全文 */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, '📄 阶段性产物'),
        h('div', {
          style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12, lineHeight: 1.62, color: T.text, background: `color-mix(in srgb, ${T.layer2} 55%, transparent)`, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', maxHeight: 240, overflowY: 'auto' },
        }, outText),
      ),
    ),
  )
}

function PipelinePanel({ active, api, runId, sessionId, sessions }) {
  if (!active) return h('div', { style: { color: T.text2, fontSize: 13, padding: '28px 20px', textAlign: 'center' } },
    h('div', { style: { fontSize: 28, marginBottom: 8 } }, '🏭'),
    '暂无运行中的流水线——让模型调用 teamflow_start，或在上方输入需求')
  const groups = []
  for (const st of active.stages || []) {
    let g = groups.length ? groups[groups.length - 1] : null
    if (!g || g.phase !== st.phase) { g = { phase: st.phase, stages: [] }; groups.push(g) }
    g.stages.push(st)
  }
  const wrapRef = React.useRef(null)
  const [vw, setVw] = React.useState(900)
  const [view, setView] = React.useState({ x: 0, y: 44, s: 1 })
  const [grabbing, setGrabbing] = React.useState(false)
  const dragRef = React.useRef(null)
  const fittedRef = React.useRef(false)
  const [det, setDet] = React.useState(null) // { seq, stage, loading, data, err } —— 阶段详情浮层

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const doFit = () => {
      const W = el.clientWidth, H = el.clientHeight
      if (W <= 0) return
      if (W !== vw) setVw(W)
      if (!fittedRef.current) {
        const lay = layoutFlow(groups, W)
        const raw = Math.min((H - 46) / lay.worldH, (W - 40) / lay.worldW, 1)
        const s = Math.max(0.5, raw)
        setView({ x: (W - lay.worldW * s) / 2, y: (H - lay.worldH * s) / 2, s })
        fittedRef.current = true
      }
    }
    doFit()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(doFit) : null
    if (ro) ro.observe(el)
    return () => { if (ro) ro.disconnect() }
  }, [active])

  React.useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const px = e.clientX - rect.left, py = e.clientY - rect.top
      setView((v) => {
        const ns = Math.min(1.65, Math.max(0.5, v.s * (e.deltaY < 0 ? 1.12 : 0.89)))
        const k = ns / v.s
        return { s: ns, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // 切换 run 时关闭详情抽屉
  React.useEffect(() => { setDet(null) }, [active && active.id, runId])

  const openDetail = async (s) => {
    if (!api || !runId) return
    setDet({ seq: s.seq, stage: s, loading: true, data: null, err: null })
    try {
      const d = await api.stageDetail(runId, s.seq, sessionId)
      setDet({ seq: s.seq, stage: s, loading: false, data: unwrap(d, 'stageDetail') || null, err: null })
    } catch (e) {
      setDet({ seq: s.seq, stage: s, loading: false, data: null, err: String((e && e.message) || e) })
    }
  }
  const closeDet = () => setDet(null)

  const layout = layoutFlow(groups, vw)
  const fitNow = () => {
    const el = wrapRef.current
    if (!el) return
    const W = el.clientWidth, H = el.clientHeight
    const raw = Math.min((H - 46) / layout.worldH, (W - 40) / layout.worldW, 1)
    const s = Math.max(0.5, raw)
    setView({ x: (W - layout.worldW * s) / 2, y: (H - layout.worldH * s) / 2, s })
  }
  const zoomBy = (f) => {
    setView((v) => {
      const ns = Math.min(1.65, Math.max(0.5, v.s * f))
      const k = ns / v.s
      const el = wrapRef.current
      const px = el ? el.clientWidth / 2 : layout.worldW / 2
      const py = el ? el.clientHeight / 2 : 64
      return { s: ns, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }
  const zoomStyle = { font: 'inherit', fontSize: 13, width: 26, height: 24, borderRadius: 7, cursor: 'pointer', border: `1px solid ${T.border}`, background: T.layer1, color: T.text, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1 }
  const onDown = (e) => {
    if (e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
    setGrabbing(true)
    e.preventDefault()
  }
  const onMove = (e) => {
    const d = dragRef.current
    if (!d) return
    setView((v) => ({ ...v, x: d.ox + (e.clientX - d.sx), y: d.oy + (e.clientY - d.sy) }))
  }
  const onUp = () => { dragRef.current = null; setGrabbing(false) }

  return h('div', {
    ref: wrapRef,
    onMouseDown: onDown, onMouseMove: onMove, onMouseUp: onUp, onMouseLeave: onUp,
    style: {
      position: 'relative', height: 560, borderRadius: 12, overflow: 'hidden', touchAction: 'none',
      border: `1px solid ${T.border}`, userSelect: 'none',
      cursor: grabbing ? 'grabbing' : 'grab',
      background: `radial-gradient(circle, ${T.border2} 1px, transparent 1px) 0 0 / 24px 24px, ${T.layer1}`,
      backgroundBlendMode: 'overlay',
    },
  },
    /* 世界层（整体可拖动/缩放的画布） */
    h('div', {
      style: { position: 'absolute', left: 0, top: 0, width: layout.worldW, height: layout.worldH, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, transformOrigin: '0 0' },
    },
      /* 连接弧线 SVG 层（置于节点之下） */
      h('svg', { width: layout.worldW, height: layout.worldH, style: { position: 'absolute', left: 0, top: 0, overflow: 'visible', zIndex: 0 } },
        h('defs', {}, layout.conns.map((c) => h('marker', { key: 'm' + c.x1 + '-' + c.y1, id: 'tfm-' + c.x1 + '-' + c.y1, viewBox: '0 0 10 10', refX: 8, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, h('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: c.color })))),
        layout.conns.map((c) => h('g', { key: 'c' + c.x1 + '-' + c.y1 },
          h('path', { d: connPath(c), fill: 'none', stroke: `color-mix(in srgb, ${c.color} 12%, transparent)`, strokeWidth: 7, strokeLinecap: 'round' }),
          h('path', { d: connPath(c), fill: 'none', stroke: `color-mix(in srgb, ${c.color} 45%, transparent)`, strokeWidth: 2.5, markerEnd: `url(#tfm-${c.x1}-${c.y1})` }),
          h('path', { d: connPath(c), fill: 'none', stroke: c.color, strokeWidth: 2, strokeLinecap: 'round', strokeDasharray: '5 9', animation: 'tf-flow .75s linear infinite' }),
        )),
      ),
      /* 节点层 */
      h('div', { style: { position: 'absolute', left: 0, top: 0, zIndex: 1 } },
        layout.nodes.map((n) => FlowNode(n, openDetail)),
      ),
    ),
    layout.nodes.length === 0 ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text2, fontSize: 13 } }, '流水线还没有开始执行节点') : null,
    /* 浮层控制簇（不参与画布拖拽） */
    h('div', {
      onMouseDown: (e) => e.stopPropagation(),
      style: { position: 'absolute', top: 10, right: 12, zIndex: 6, display: 'flex', alignItems: 'center', gap: 6, padding: 5, borderRadius: 11, border: `1px solid ${T.border}`, background: `color-mix(in srgb, ${T.layer1} 82%, transparent)`, backdropFilter: 'blur(8px)', boxShadow: '0 6px 20px rgba(0,0,0,.16)' },
    },
      h('button', { title: '缩小', onClick: () => zoomBy(0.86), style: zoomStyle }, '−'),
      h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, minWidth: 34, textAlign: 'center' } }, `${Math.round(view.s * 100)}%`),
      h('button', { title: '放大', onClick: () => zoomBy(1.16), style: zoomStyle }, '+'),
      h('span', { style: { width: 1, height: 14, background: T.border } }),
      h('button', { title: '适应画布', onClick: fitNow, style: { ...zoomStyle, fontSize: 13 } }, '⤢'),
      h('span', { style: { width: 1, height: 14, background: T.border } }),
      h('span', { style: { fontSize: 10.5, color: T.text2, paddingRight: 4, opacity: 0.85 } }, '✥ 拖动画布 · 滚轮缩放'),
    ),
    /* 阶段详情浮层：悬浮于画布右上，不挤占画布宽度；浮层内滚轮只滚正文（原生 stopPropagation），不触发画布缩放 */
    det ? h(StageDetailDrawer, { det, onClose: closeDet, sessionId, sessions }) : null,
  )
}

/* ── Backlog 拖拽看板 ────────────────────────────────────────────── */
function BoardPanel({ backlog, api, onRefresh, sessionId }) {
  const [drag, setDrag] = React.useState(null)
  const [over, setOver] = React.useState(null)
  const [det, setDet] = React.useState(null)
  const openItem = async (kind, id) => {
    setDet({ kind, id, loading: true, data: null, err: null })
    try {
      const d = unwrap(await api.itemDetail(kind, id, sessionId), 'itemDetail')
      setDet({ kind, id, loading: false, data: d, err: null })
    } catch (e) {
      setDet({ kind, id, loading: false, data: null, err: String((e && e.message) || e) })
    }
  }
  if (!backlog) return h('div', { style: { color: T.text2, fontSize: 13, padding: '28px 20px', textAlign: 'center' } },
    h('div', { style: { fontSize: 28, marginBottom: 8 } }, '📋'),
    'backlog 为空（还没有流水线运行过）')

  // 子卡查找表：subtaskId → subtask
  const subtaskMap = {}
  for (const t of (backlog.tasks || [])) {
    if (t.type === 'subtask' && t.id) subtaskMap[t.id] = t
  }

  const move = async (kind, id, to) => {
    try { await api.backlogUpdate(kind, id, to, sessionId, '看板拖拽流转') } catch (e) { /* 面板吞错，轮询自愈 */ }
    onRefresh()
  }
  const card = (item, kind) => h('div', {
    key: item.id,
    draggable: true,
    onClick: () => openItem(kind, item.id),
    onDragStart: () => setDrag({ kind, id: item.id, from: item.status }),
    onDragEnd: () => setDrag(null),
    style: {
      background: item.humanIntervention || item.status === 'needs-human' ? `color-mix(in srgb, ${T.error} 7%, ${T.layer1})` : T.layer1,
      border: `1px solid ${T.border}`, borderLeft: `3px solid ${stColor(item.status)}`,
      borderRadius: 8, padding: '7px 9px', cursor: 'grab', fontSize: 12,
      opacity: drag && drag.id === item.id ? .35 : 1,
      transition: 'opacity .1s ease, transform .12s ease',
      boxShadow: '0 1px 2px rgba(0,0,0,.05)',
    },
    title: `${item.id} · ${item.status}${item.summary ? '\n' + item.summary : ''}（点击查看详情）`,
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { fontFamily: MONO, color: T.text2, fontSize: 10.5 } }, item.id),
      item.severity ? chip(item.severity, item.severity === 'P0' ? T.error : item.severity === 'P1' ? T.warn : T.text2) : null,
      item.owner ? h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: T.text2 } }, `👤 ${item.owner}`) : null,
    ),
    h('div', { title: item.title || undefined, style: { fontWeight: 500, margin: '3px 0 4px', lineHeight: 1.4 } }, (item.title || '').slice(0, 30)),
    h('div', { style: { ...flexRow, marginTop: 2 } },
      chip(stText(item.status), stColor(item.status)),
      typeof item.retries === 'number' && item.retries > 0 ? h('span', { style: { fontSize: 10.5, color: T.warn, fontFamily: MONO } }, `↻${item.retries}`) : null,
      item.humanIntervention || item.status === 'needs-human' ? h('span', { style: { fontSize: 10.5, color: T.error, fontWeight: 700 } }, '⚠') : null,
    ),
    (kind === 'task' && (item.devAssign || item.qaAssign || item.acceptBy)) ? h('div', { style: { ...flexRow, marginTop: 3, fontSize: 10.5, color: T.text2, fontFamily: MONO } },
      item.devAssign ? h('span', { title: `dev 分配\n${item.devAssign}`, style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `👨‍💻${item.devAssign}`) : null,
      item.qaAssign ? h('span', { title: `qa 分配\n${item.qaAssign}`, style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `🧪${item.qaAssign}`) : null,
      item.acceptBy ? h('span', { title: `验收/汇报人\n${item.acceptBy}`, style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `✅${item.acceptBy}`) : null,
    ) : null,
    (kind === 'task' && byRoleLine(item)) ? h('div', { style: { ...flexRow, marginTop: 3, fontSize: 10.5, color: T.warn, fontFamily: MONO } },
      h('span', { style: { color: T.text2 } }, '⛽'),
      byRoleLine(item),
    ) : null,
    // 子卡摘要 + 子卡列表（主卡展开）
    (kind === 'task' && (item.subtaskIds || []).length > 0) ? (() => {
      const subs = item.subtaskIds.map((id) => subtaskMap[id]).filter(Boolean)
      if (subs.length === 0) return null
      const done = subs.filter((s) => s.status === 'done').length
      const failed = subs.filter((s) => s.status === 'failed').length
      const running = subs.filter((s) => s.status === 'running').length
      return h('div', { style: { marginTop: 5 } },
        h('div', { style: { ...flexRow, fontSize: 10.5, color: T.text2, fontFamily: MONO, marginBottom: 3 } },
          h('span', null, `📦 ${subs.length} 子卡`),
          done > 0 ? h('span', { style: { color: T.success } }, `${done}✓`) : null,
          running > 0 ? h('span', { style: { color: T.brand } }, `${running}⟳`) : null,
          failed > 0 ? h('span', { style: { color: T.error } }, `${failed}✗`) : null,
        ),
        subs.map((sub) => h('div', {
          key: sub.id,
          style: {
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontFamily: MONO,
            padding: '2px 6px', borderRadius: 4, marginBottom: 2,
            background: sub.status === 'failed' ? `color-mix(in srgb, ${T.error} 7%, transparent)` : T.layer2,
            border: `1px solid ${stColor(sub.status)}30`,
          },
        },
          h('span', { style: { color: stColor(sub.status), fontWeight: 600, minWidth: 12 } }, sub.status === 'done' ? '✓' : sub.status === 'failed' ? '✗' : sub.status === 'running' ? '⟳' : '…'),
          h('span', { title: sub.title || undefined, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 } }, (sub.title || '').replace(/^开发 · /, '')),
          sub.devAssign ? h('span', { title: `dev 分配\n${sub.devAssign}`, style: { marginLeft: 'auto', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 70, whiteSpace: 'nowrap' } }, sub.devAssign) : null,
        ))
      )
    })() : null,
  )

  const groups = [
    { kind: 'req', list: backlog.requirements || [] },
    { kind: 'task', list: (backlog.tasks || []).filter((t) => t.type !== 'subtask') }, // 只展示主卡（子卡嵌套在主卡下）
    { kind: 'bug', list: backlog.bugs || [] },
  ]
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '72vh', overflowY: 'auto', paddingRight: 4 } },
    groups.map(({ kind, list }) => {
      const counts = {}
      for (const s of COLUMNS[kind]) counts[s] = 0
      for (const item of list) counts[item.status] = (counts[item.status] || 0) + 1
      return h('div', { key: kind },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13, marginBottom: 8 } },
          h('span', { style: { fontSize: 14 } }, kind === 'req' ? '📌' : kind === 'task' ? '🔧' : '🐞'),
          KIND_TITLE[kind],
          h('span', {
            style: { fontSize: 11, fontWeight: 600, color: T.text2, background: T.layer2, borderRadius: 999, padding: '0 8px', lineHeight: '18px' },
          }, String(list.length)),
        ),
        h('div', { style: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 } },
          COLUMNS[kind].map((s) => {
            const isOver = over === `${kind}:${s}`
            const color = stColor(s)
            return h('div', {
              key: s,
              onDragOver: (e) => { e.preventDefault(); setOver(`${kind}:${s}`) },
              onDragLeave: () => setOver((o) => (o === `${kind}:${s}` ? null : o)),
              onDrop: async () => {
                if (drag && drag.kind === kind && drag.from !== s) await move(kind, drag.id, s)
                setDrag(null); setOver(null)
              },
              style: {
                minWidth: 140, maxWidth: 172, flex: '0 0 auto',
                borderRadius: 10, padding: 7, minHeight: 84,
                maxHeight: 340, overflowY: 'auto', // 任务增多时列内滚动，不撑高页面
                background: isOver ? `color-mix(in srgb, ${color} 8%, ${T.layer1})` : T.layer2,
                border: `1px dashed ${isOver ? color : T.border}`,
                transition: 'background .12s ease, border-color .12s ease',
              },
            },
              h('div', { style: { ...flexRow, fontSize: 11, fontWeight: 600, color, marginBottom: 6, padding: '0 2px' } },
                h('span', null, stText(s)),
                h('span', { style: { marginLeft: 'auto', fontFamily: MONO, fontSize: 10, opacity: .75 } }, counts[s] || 0),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                list.filter((item) => item.status === s).map((item) => card(item, kind)),
              ),
            )
          }),
        ),
      )
    }),
    det ? h(ItemDetailDrawer, { det, onClose: () => setDet(null) }) : null,
  )
}

/* ── TeamFlow Backlog 条目详情抽屉 ──────────────────────────────── */
function fmtAt(ts) { return ts ? new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—' }

function ItemDetailDrawer({ det, onClose }) {
  const d = det && det.data
  const loading = det && det.loading
  const err = det && det.err
  const kind = det && det.kind
  const icon = kind === 'req' ? '📌' : kind === 'task' ? '🔧' : '🐞'
  const color = d ? stColor(d.status) : T.text2
  const closeBtn = { font: 'inherit', width: 26, height: 26, borderRadius: 8, cursor: 'pointer', border: `1px solid ${T.border}`, background: 'transparent', color: T.text2, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, lineHeight: 1 }
  const secTitle = (label) => h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, label)
  const kv = (k, v, mono?: boolean) => h('div', { style: { display: 'flex', gap: 8, fontSize: 11.5, lineHeight: 1.6 } },
    h('span', { style: { flex: '0 0 72px', color: T.text2 } }, k),
    h('span', { title: v === null || v === undefined ? undefined : String(v), style: { flex: 1, minWidth: 0, fontFamily: mono ? MONO : undefined, color: T.text, wordBreak: 'break-all', textOverflow: 'ellipsis' } }, v === null || v === undefined ? '—' : String(v)),
  )
  const linkRow = (it, extra) => h('div', { key: it.id, style: { display: 'flex', flexDirection: 'column', gap: 2, padding: '5px 8px', borderRadius: 7, background: T.layer2, fontSize: 11.5 } },
    h('div', { style: { display: 'flex', gap: 7, alignItems: 'center' } },
      h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, flex: '0 0 auto' } }, it.id),
      it.severity ? chip(it.severity, it.severity === 'P0' ? T.error : it.severity === 'P1' ? T.warn : T.text2) : null,
      chip(stText(it.status), stColor(it.status)),
      extra && extra.usage ? h('span', { style: { fontSize: 10, fontFamily: MONO, color: T.warn, flex: '0 0 auto' } }, `⛽${fmtTokens((extra.usage.input || 0) + (extra.usage.cacheRead || 0) + (extra.usage.cacheWrite || 0) + (extra.usage.output || 0))}`) : null,
      extra && extra.assignee ? h('span', { title: `dev 分配\n${extra.assignee}`, style: { display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, fontFamily: MONO, color: T.text2, flex: '0 0 auto', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90, whiteSpace: 'nowrap' } }, `👨‍💻${String(extra.assignee).slice(0, 14)}`) : null,
      h('span', { title: it.title || undefined, style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: T.text } }, (it.title || '').slice(0, 44)),
    ),
    it.summary ? h('div', { title: it.summary, style: { fontSize: 10.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' } }, it.summary) : null,
  )
  return h('div', {
    style: {
      position: 'absolute', top: 10, right: 12, bottom: 10, width: 400, zIndex: 9,
      borderRadius: 14, overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      border: `1px solid ${T.border}`,
      background: `color-mix(in srgb, ${T.layer1} 92%, transparent)`,
      backdropFilter: 'blur(14px)',
      boxShadow: '0 14px 48px rgba(0,0,0,.30)',
    },
  },
    /* 头 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 9, padding: '12px 14px', borderBottom: `1px solid ${T.border}`, background: `linear-gradient(135deg, color-mix(in srgb, ${color} 14%, transparent), transparent 62%)` } },
      h('span', { style: { fontSize: 17 } }, icon),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { style: { fontSize: 12.5, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: d ? (d.title || d.id) : undefined },
          d ? (d.title || d.id) : `${det.kind} · ${det.id}`),
        d ? h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 1, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' } },
          `${d.id} · ${d.kind}${d.severity ? ' · ' + d.severity : ''}`) : null,
      ),
      d ? chip(stText(d.status), color, { dot: true }) : null,
      h('button', { onClick: onClose, style: closeBtn, title: '关闭' }, '✕'),
    ),
    /* 内容 */
    h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 13 } },
      loading ? h('div', { style: { color: T.text2, fontSize: 12, padding: 12 } }, '加载中…') :
        err ? h('div', { style: { color: T.error, fontSize: 12, padding: 12 } }, '⚠ ' + err) :
          !d ? null :
          [
            /* 概览 */
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle('概览'),
              d.spec ? h('div', { style: { fontSize: 12, color: T.text, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: T.layer2, borderRadius: 8, padding: '8px 10px' } }, d.spec) : null,
              d.summary ? h('div', { style: { fontSize: 11.5, color: T.text2, lineHeight: 1.6, wordBreak: 'break-word' } }, d.summary) : null,
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                d.devAssign ? kv('👨‍💻 dev', d.devAssign.slice(0, 26), true) : null,
                d.qaAssign ? kv('🧪 qa', d.qaAssign.slice(0, 26), true) : null,
                d.assignBy ? kv('✅ 验收', d.assignBy.slice(0, 26), true) : null,
                d.owner ? kv('👤 owner', d.owner.slice(0, 26), true) : null,
                (typeof d.retries === 'number' && d.retries > 0) ? kv('↻ 重试', String(d.retries)) : null,
                d.humanIntervention ? kv('⚠ 人工介入', '需人工介入') : null,
                kv('更新于', fmtAt(d.updatedAt) || '—'),
              ),
            ),
            /* 需求原文 + 运行信息（req / 关联 journal） */
            d.runInfo ? (() => {
              const ri = d.runInfo
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                  secTitle('运行'),
                  h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2 } }, ri.runId),
                  chip(stText(ri.status), stColor(ri.status)),
                  (ri.startedAt || ri.endedAt) ? h('span', { style: { fontSize: 10.5, color: T.text2, fontFamily: MONO } }, `${fmtAt(ri.startedAt)} → ${fmtAt(ri.endedAt)} · ${fmtDur(ri.startedAt, ri.endedAt)}`) : null,
                ),
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  secTitle('需求原文'),
                  h('div', { style: { fontSize: 11.5, color: T.text, lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: T.layer2, borderRadius: 8, padding: '8px 10px' } }, ri.requirement || '（无原文）'),
                ),
              )
            })() : null,
            /* 任务夹（ADR-0008） */
            d.runDocs ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle('任务夹'),
              h('div', { style: { fontSize: 11.5, fontFamily: MONO, color: T.brand, background: T.layer2, borderRadius: 8, padding: '7px 10px', wordBreak: 'break-all' } }, d.runDocs + '/'),
            ) : null,
            /* TOKEN（task） */
            (kind === 'task' && d.usage) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle('TOKEN · 官方口径'),
              h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text, lineHeight: 1.65 } }, usageDetail(d)),
              (d.byRole && Object.keys(d.byRole).length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                Object.entries(d.byRole).sort((a, b) => (totalTokens(b[1]) - totalTokens(a[1]))).map(([role, uRaw]) => {
                  const u = uRaw as { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; calls?: number }
                  const label = role === 'dev' ? '👨‍💻 开发' : role === 'qa' ? '🧪 QA' : role === 'acceptance' ? '✅ 验收' : role === 'pm' ? '📌 产品' : role === 'design' ? '🎨 设计' : role === 'arch' ? '🏗 架构' : '⚙️ ' + role
                  return h('div', { key: role, style: { display: 'flex', gap: 7, alignItems: 'center', fontSize: 10.5, fontFamily: MONO, color: T.text2 } },
                    h('span', { style: { flex: '0 0 64px' } }, label),
                    h('span', { style: { color: T.text } }, `⛽${fmtTokens(totalTokens(u))}`),
                    h('span', null, `${fmtTokens(u.input || 0)}i / ${fmtTokens(u.cacheRead || 0)}c / ${fmtTokens(u.output || 0)}o · ${u.calls || 0} 次`),
                  )
                }),
              ) : null,
            ) : null,
            /* 关联子卡 */
            (d.subtasks && d.subtasks.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(`关联子卡（${d.subtasks.length}）`),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, d.subtasks.map((s) => linkRow(s, { usage: s.usage, assignee: s.devAssign }))),
            ) : null,
            /* 关联缺陷 */
            (d.bugs && d.bugs.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(`关联缺陷（${d.bugs.length}）`),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, d.bugs.map((b) => linkRow(b, {}))),
            ) : null,
            /* 流转时间线 */
            (d.events && d.events.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(`流转时间线（${d.events.length}）`),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 0 } },
                d.events.slice().reverse().map((ev) => h('div', { key: `${ev.at}-${ev.to}`, style: { display: 'flex', gap: 8, alignItems: 'baseline', padding: '5px 0', borderBottom: `1px dashed ${T.border}`, fontSize: 11.5 } },
                  h('span', { style: { fontFamily: MONO, color: T.text2, fontSize: 10.5, flex: '0 0 42px' } }, fmtAt(ev.at)),
                  h('span', { style: { color: T.text } }, ev.from || '—'),
                  h('span', { style: { color: T.text2 } }, '→'),
                  h('span', { style: { fontFamily: MONO, color: T.brand } }, ev.to),
                  h('span', { style: { flex: 1, minWidth: 0, color: T.text2, fontSize: 10.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: ev.reason || undefined }, ev.reason || ''),
                )),
              ),
            ) : null,
          ],
    ),
  )
}

/* ── 团队选择器（input.right 注入） ─────────────────────────────── */
function TeamSelector({ sessionId, remote }) {
  const [teams, setTeams] = React.useState([])
  const [active, setActive] = React.useState(null)
  const [open, setOpen] = React.useState(false)
  const ref = React.useRef(null)

  const load = React.useCallback(async () => {
    if (!remote || !sessionId) return
    try {
      const tw = unwrap(await remote.listTeams(sessionId), 'listTeams')
      setTeams((tw && tw.teams) || [])
      const at = unwrap(await remote.getActiveTeam(sessionId), 'getActiveTeam')
      setActive(at && at.team ? at.team : null)
    } catch (e) { /* 静默 */ }
  }, [remote, sessionId])

  React.useEffect(() => { load() }, [load])

  // 点击外部关闭下拉
  React.useEffect(() => {
    if (!open) return
    const handler = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const select = async (teamId) => {
    if (!remote || !sessionId) return
    try {
      if (!teamId) {
        await remote.clearTeam(sessionId)
        setActive(null)
      } else {
        const r = unwrap(await remote.selectTeam(sessionId, teamId), 'selectTeam')
        setActive(r && r.team ? r.team : null)
      }
    } catch (e) { /* 静默 */ }
    setOpen(false)
  }

  if (teams.length === 0) return null

  return h('div', { ref, style: { position: 'relative' } },
    h('button', {
      onClick: () => setOpen(!open),
      title: active ? `当前团队：${active.name}（点击切换）` : '选择团队',
      style: {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
        fontSize: 11, fontFamily: MONO, fontWeight: 500,
        border: `1px solid ${active ? T.brand : T.border}`,
        background: active ? `color-mix(in srgb, ${T.brand} 10%, transparent)` : 'transparent',
        color: active ? T.brand : T.text2,
        transition: 'all .12s ease',
      },
    },
      h('span', { style: { fontSize: 12 } }, active ? active.icon : '🏭'),
      h('span', { title: active && active.name ? String(active.name) : '团队', style: { maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, active ? active.name : '团队'),
      h('span', { style: { fontSize: 8, opacity: .6 } }, open ? '▲' : '▼'),
    ),
    open ? h('div', {
      style: {
        position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
        minWidth: 228, background: T.layer1, border: `1px solid ${T.border}`,
        borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.15)',
        zIndex: 100, overflow: 'hidden',
      },
    },
      h('div', { style: { padding: '7px 12px', fontSize: 10, color: T.text2, borderBottom: `1px solid ${T.border}` } }, '选择团队'),
      // "无团队"选项：清除选择，回到原生模式
      h('button', {
        onClick: () => select(null),
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
          padding: '9px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: !active ? `color-mix(in srgb, ${T.text2} 10%, transparent)` : 'transparent',
          color: T.text, fontSize: 12, transition: 'background .1s',
          borderBottom: `1px solid ${T.border}`,
        },
      },
        h('span', { style: { fontSize: 14, opacity: .5, width: 18, flexShrink: 0, lineHeight: 1.4 } }, '💬'),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { fontWeight: 600, lineHeight: 1.35 } }, '无团队（直接对话）'),
          h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 3, lineHeight: 1.45, whiteSpace: 'normal', wordBreak: 'break-word' } }, '不走 teamflow，模型直接工作'),
        ),
        !active ? h('span', { style: { marginLeft: 'auto', color: T.text2, fontSize: 12, flexShrink: 0 } }, '✓') : null,
      ),
      teams.map((team) => h('button', {
        key: team.id,
        onClick: () => select(team.id),
        style: {
          display: 'flex', alignItems: 'flex-start', gap: 10, width: '100%',
          padding: '9px 12px', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: active && active.id === team.id ? `color-mix(in srgb, ${T.brand} 10%, transparent)` : 'transparent',
          color: T.text, fontSize: 12, transition: 'background .1s',
        },
      },
        h('span', { style: { fontSize: 14, width: 18, flexShrink: 0, lineHeight: 1.4 } }, team.icon),
        h('div', { style: { minWidth: 0, flex: 1 } },
          h('div', { style: { fontWeight: 600, lineHeight: 1.35 } }, team.name),
          h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 3, lineHeight: 1.45, whiteSpace: 'normal', wordBreak: 'break-word' } }, team.description),
        ),
        active && active.id === team.id ? h('span', { style: { marginLeft: 'auto', color: T.brand, fontSize: 12, flexShrink: 0 } }, '✓') : null,
      )),
    ) : null,
  )
}

/* ── 主视图 ──────────────────────────────────────────────────────── */
/** Typert remote 的标准 RPC 信封：client 拿到的是 { ok, value }（或 { ok, error }），必须解包 .value。 */
interface RpcEnvelope {
  ok: boolean
  value?: unknown
  error?: { code?: string; message?: string }
}

/** 解包 remote 信封：失败抛错；成功返回 value。 */
function unwrap(res: RpcEnvelope | undefined | null, what?: string): any {
  if (!res || !res.ok) {
    throw new Error(`${what || 'remote'} 调用失败：${(res && res.error && (res.error.message || res.error.code)) || '未知错误'}`)
  }
  return res.value
}

/** teamflow 服务实例的调用面（$mount 后由 ctx.get 取得，方法返回 RPC 信封）。
 *  各方法带 sessionId：host 按该会话所属 workspace（项目）过滤，不同 workspace 数据互不可见。 */
interface TeamflowRemote {
  list(sessionId?: string | null): Promise<RpcEnvelope>
  snapshot(runId?: string | null, sessionId?: string | null): Promise<RpcEnvelope>
  backlog(sessionId?: string | null): Promise<RpcEnvelope>
  backlogUpdate(kind: string, id: string, to: string, sessionId?: string | null, reason?: string, meta?: Record<string, unknown>): Promise<RpcEnvelope>
  resume(runId: string, sessionId: string): Promise<RpcEnvelope>
  stageDetail(runId: string, seq: number, sessionId?: string | null): Promise<RpcEnvelope>
  itemDetail(kind: string, id: string, sessionId?: string | null): Promise<RpcEnvelope>
}

interface TeamFlowViewProps {
  sessionId: string
  remote: unknown
  sessions?: {
    openSubagent?: (a: { parentSessionId: string; childSessionId: string; mode?: string }) => void
  } | null
}

function TeamFlowView(props: TeamFlowViewProps) {
  const api = props.remote as TeamflowRemote // $mount 后的 teamflow 服务实例（ctx.get 取得，普通对象）
  const [state, setState] = React.useState({ runs: [], active: null, backlog: null, err: null, workspace: null })
  const [runId, setRunId] = React.useState(null)
  const [tab, setTab] = React.useState('pipeline')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (!api) { setState((s) => ({ ...s, err: 'remote 未就绪' })); return }
    try {
      const lr = unwrap(await api.list(props.sessionId), 'list') as { runs?: Array<Record<string, unknown>>; workspace?: { slug?: string; path?: string | null } }
      const runsList = (lr && lr.runs) || []
      const workspace = (lr && lr.workspace) || null
      const id = runId || (runsList[0] && (runsList[0].id as string | undefined))
      const snapWrap = id ? await api.snapshot(id, props.sessionId) : null
      const snap = snapWrap ? (unwrap(snapWrap, 'snapshot') as Record<string, unknown> | null) : null
      const bo = unwrap(await api.backlog(props.sessionId), 'backlog') as Record<string, unknown>
      setState({ runs: (runsList || []).slice(0, 12), active: snap, backlog: bo, err: null, workspace })
    } catch (e) {
      setState((s) => ({ ...s, err: String((e && e.message) || e) }))
    }
  }, [runId, api, props.sessionId])

  React.useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const { runs, active, backlog, err, workspace } = state
  const total = totalUsage(active && active.stages)
  const needHuman = []
  if (backlog) {
    for (const item of [...(backlog.requirements || []), ...(backlog.tasks || []), ...(backlog.bugs || [])]) {
      if (item.humanIntervention || item.status === 'needs-human') needHuman.push(item)
    }
  }
  const activeRun = runs.find((r) => r.id === runId) || runs[0]
  // host 判定字段（list 不返回 stages 全量，只给 incompleteStages 布尔）+ 三态才可续
  const canResume = activeRun && activeRun.incompleteStages && (activeRun.status === 'interrupted' || activeRun.status === 'failed' || activeRun.status === 'cancelled')
  const onResume = async () => {
    if (!api || !activeRun || busy) return
    setBusy(true)
    try { await api.resume(activeRun.id, props.sessionId); refresh() }
    catch (e) { setState((s) => ({ ...s, err: String((e && e.message) || e) })) }
    setBusy(false)
  }
  const anyRunning = runs.some((r) => r.status === 'running' || r.status === 'pending')

  const btn = {
    font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 8, cursor: 'pointer',
    border: `1px solid ${T.border2}`, background: T.layer1, color: T.text,
    transition: 'border-color .12s ease, background .12s ease',
  }
  const tabBtn = (on) => ({
    font: 'inherit', fontSize: 12, fontWeight: on ? 600 : 500, padding: '5px 14px', borderRadius: 8, cursor: 'pointer',
    border: 'none',
    background: on ? `color-mix(in srgb, ${T.brand} 14%, transparent)` : 'transparent',
    color: on ? T.brand : T.text2,
    transition: 'background .12s ease, color .12s ease',
  })
  const chipBtn = (sel) => ({
    font: 'inherit', fontSize: 11, padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
    border: `1px solid ${sel ? T.brand : T.border}`,
    background: sel ? `color-mix(in srgb, ${T.brand} 12%, transparent)` : 'transparent',
    color: sel ? T.brand : T.text2,
    fontFamily: MONO,
  })

  return h('div', { style: { fontFamily: SANS, fontSize: 13, color: T.text, display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px' } },
    /* 顶部品牌条 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 10 } },
      h('div', {
        style: {
          width: 28, height: 28, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 15, background: `color-mix(in srgb, ${T.brand} 12%, transparent)`,
          border: `1px solid color-mix(in srgb, ${T.brand} 28%, transparent)`,
        },
      }, '🏭'),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1 } },
        h('span', { style: { fontWeight: 700, fontSize: 14, lineHeight: '18px' } }, '团队工作台'),
        h('span', { style: { fontSize: 11, color: T.text2, display: 'flex', alignItems: 'center', gap: 5 } },
          h('span', {
            style: {
              width: 7, height: 7, borderRadius: 999, display: 'inline-block',
              background: anyRunning ? T.success : T.text2,
              animation: anyRunning ? 'tf-pulse 1.6s ease-in-out infinite' : 'none',
            },
          }),
          anyRunning ? '流水线运行中' : '空闲',
        ),
      ),
      h('button', { onClick: refresh, style: { ...btn, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 } }, '🔄 刷新'),
      canResume ? h('button', {
        onClick: onResume, disabled: busy,
        title: `断点续跑 ${activeRun.id}\n当前状态：${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}；跳过已完成阶段，从第一个未完成阶段重跑`,
        style: { ...btn, background: T.error, color: '#fff', border: 'none', fontWeight: 600 },
      }, busy ? '续跑中…' : `↻ 从断点重跑 #${String(activeRun.id).slice(-6)}`) : null,
    ),

    err ? h('div', {
      style: {
        color: T.error, fontSize: 12, background: `color-mix(in srgb, ${T.error} 8%, transparent)`,
        border: `1px solid color-mix(in srgb, ${T.error} 30%, transparent)`, borderRadius: 8, padding: '7px 11px',
      },
    }, `⚠ ${err}（确认已安装 dsh-plugin-teamflow 且 web 已重启）`) : null,

    /* 人工介入横幅 */
    needHuman.length > 0 ? h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: `color-mix(in srgb, ${T.warn} 9%, ${T.layer1})`,
        border: `1px solid color-mix(in srgb, ${T.warn} 35%, transparent)`,
        borderRadius: 10, padding: '9px 12px',
      },
    },
      h('span', { style: { fontWeight: 700, color: T.warn, fontSize: 12.5 } }, `⚠ ${needHuman.length} 项需人工介入`),
      needHuman.slice(0, 5).map((item) => {
        const kind = (backlog.requirements || []).some((r) => r.id === item.id) ? 'req'
          : (backlog.tasks || []).some((t) => t.id === item.id) ? 'task' : 'bug'
        const fin = kind === 'bug' ? 'verified' : 'accepted'
        return h('button', {
          key: item.id,
          onClick: async () => { await api.backlogUpdate(kind, item.id, fin, props.sessionId, '人工处理'); refresh() },
          style: { ...btn, background: T.success, color: '#fff', border: 'none', fontWeight: 600 },
        }, `处理 ${item.id}`)
      }),
    ) : null,

    /* tab 栏 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 2, borderBottom: `1px solid ${T.border}` } },
      h('button', { onClick: () => setTab('pipeline'), style: tabBtn(tab === 'pipeline') }, '🔄 流水线'),
      h('button', { onClick: () => setTab('board'), style: tabBtn(tab === 'board') }, '📋 Backlog 看板'),
      h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 } },
        activeRun ? h('span', {
          title: `${activeRun.id}\n${activeRun.requirement || ''}`,
          style: {
            fontSize: 11.5, fontFamily: MONO, padding: '2px 10px', borderRadius: 999,
            background: T.layer2, color: activeRun.status === 'interrupted' ? T.warn : T.text2,
            border: `1px solid ${T.border}`,
          },
        }, `#${String(activeRun.id).slice(-8)} · ${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}`) : null,        total && (total.input + total.cacheRead + total.cacheWrite + total.output) > 0 ? h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text2, cursor: 'help' }, title: '输入(未命中)/输入(命中)/输出 全部阶段合计' }, `∑ ⇅${fmtTokens(total.input)}/⇅${fmtTokens(total.cacheRead)}·⬆${fmtTokens(total.output)}`) : null,
      ),
    ),

    /* 作用域条：当前工作区（项目）+ 本工作区历史流水线 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' } },
      h('span', {
        title: `当前工作区（workspace 级隔离）：${(workspace && workspace.path) || '未连接工作区'}`,
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: MONO,
          fontSize: 11.5, padding: '2px 10px', borderRadius: 999,
          background: `color-mix(in srgb, ${T.brand} 10%, transparent)`,
          border: `1px solid color-mix(in srgb, ${T.brand} 30%, transparent)`, color: T.brand,
        },
      },
        h('span', { style: { fontSize: 13 } }, '🗂'),
        h('span', { title: (workspace && workspace.path) ? String(workspace.path) : undefined, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 } },
          (workspace && workspace.path) ? String(workspace.path).split(/[\\/]/).filter(Boolean).pop() : 'ungrouped'),
      ),
      /* 历史 run 切换：仅流水线 tab 下有意义（Backlog 看板是工作区级，不随 run 变化，
         展示在这里点击无反应还会误导 —— 故只看板 tab 时隐藏） */
      tab === 'pipeline' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
        h('span', { style: { color: T.text2 } }, '历史'),
        runs.length ? runs.map((r) => {
          const sel = r.id === (runId || (runs[0] && runs[0].id))
          return h('button', { key: r.id, onClick: () => setRunId(r.id), style: chipBtn(sel), title: `${r.id}\n${r.requirement || ''}` },
            `#${String(r.id).slice(-6)}`)
        }) : h('span', { style: { color: T.text2, fontSize: 11.5 } }, '（暂无）'),
      ) : null,
    ),

    tab === 'pipeline' ? h(PipelinePanel, { active, api, runId: activeRun ? activeRun.id : null, sessionId: props.sessionId, sessions: props.sessions }) : h(BoardPanel, { backlog, api, onRefresh: refresh, sessionId: props.sessionId }),
  )
}

/* ── 动画 keyframes（注入一次） ───────────────────────────────────── */
if (typeof document !== 'undefined') {
  const styleEl = document.createElement('style')
  styleEl.textContent = `
@keyframes tf-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.8); } }
@keyframes tf-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
@keyframes tf-flow { from { stroke-dashoffset: 0 } to { stroke-dashoffset: -28 } }`
  document.head.appendChild(styleEl)
}

/** 注册 conversation.view tab「团队工作台」+ input.right 团队选择按钮。 */
export async function apply(ctx) {
  await ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)
  const teamflow = ctx.get('remote.teamflow')
  // 注册团队工作台 tab
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'teamflow',
    order: 20,
    label: '🏭 团队工作台',
    inject: (sessionId) => ({ sessionId, remote: teamflow, sessions: ctx.get('sessions') }),
  }, TeamFlowView))
  // 注册输入框旁的团队选择按钮
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'teamflow-team-select',
    order: 5,
    inject: (sessionId) => ({ sessionId, remote: teamflow }),
  }, TeamSelector))
}
