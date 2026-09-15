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
import {
  T, STATUS_COLOR, PHASE_ICON, phaseNameOf, phaseIconOf, phaseKeyOf,
  COLUMNS, h, MONO, SANS, flexRow, chip, FoldableText, CancelButton,
  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, usageDetail, stageUsageLine,
  roleUsage, byRoleLine, totalUsage, stText, stColor, runStatusText, kindTitle, roleChip, stageLabelOf, stageStatusText,
  t, setTranslator, localeTag,
} from './shared.js'
import { NS, zh, en } from './locales.js'
import { GlobalPanel, TeamflowPanelIcon, RunDetailTab, runTabDefinition, RUN_TAB_ID } from './panel.js'

export const inject = ['remote', 'slots', 'sessions', 'locale']

/* 主题 token / 状态词表 / 格式化等共享展示层见 client/shared.tsx（与全局面板共用）。 */

/* 状态徽章 chip / FoldableText / 格式化 / 状态词表等内容已在 client/shared.tsx（顶部 import）。 */

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
    // `cancelled` **不算失败**（2026-09-16 实测截图修正）：中断是用户主动动作，不是 run 的失败态。
    // 旧写法把它与 failed/needs-human 并列 → 被中断的相位组头取错误色（红），而同一节点里阶段卡的
    // 竖条与「已中止」chip 是灰的（STATUS_COLOR.cancelled = text2）→ 红头灰身自相矛盾。
    // 删掉后该组落到兜底 T.text2（灰，与 chip 同色）；真失败（failed/needs-human）仍为红。
    // 注意不会误变绿：allDone 要求每个阶段都 done，被中断的阶段不满足。
    const anyFail = g.stages.some((s) => s.status === 'failed' || s.status === 'needs-human')
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
    title: t('stage.cardTip', { label: stageLabelOf(s) }),
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
      h('span', { title: s.label, style: { flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, stageLabelOf(s)),
      (s.attempts && s.attempts.length > 1) ? h('span', { title: t('stage.retryTip', { n: s.attempts.length - 1, m: s.attempts.length }), style: { fontFamily: MONO, fontSize: 10, fontWeight: 800, color: T.warn, background: `color-mix(in srgb, ${T.warn} 14%, transparent)`, borderRadius: 999, padding: '0 6px', lineHeight: '15px', flex: '0 0 auto' } }, `↻${s.attempts.length - 1}`) : null,
      chip(stageStatusText(s.status), color, { dot: true }),
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
      h('span', { style: { fontSize: 13.5 } }, phaseIconOf(g.phase)),
      h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, phaseNameOf(g.phase)),
      g.stages.length > 1 ? h('span', { style: { fontFamily: MONO, fontSize: 10, fontWeight: 800, background: `color-mix(in srgb, ${g.headColor} 16%, transparent)`, borderRadius: 999, padding: '0 7px', lineHeight: '16px' } }, `×${g.stages.length}`) : null,
      running ? h('span', { style: { width: 8, height: 8, borderRadius: 999, background: g.headColor, animation: 'tf-pulse 1.4s ease-in-out infinite' } }) : null,
    ),
    /* 卡片列 */
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 7, paddingTop: 10 } },
      g.stages.map((s) => FlowStageCard(s, s.seq, onOpen)),
    ),
  )
}

/** 阶段详情抽屉（卡片点击打开；浮于画布右侧，不参与拖动/缩放）。
 * 2026-09-06 状态机化：同任务多次尝试 → 顶部尝试时间线 + 选中展开（默认最新）；
 * 单次尝试保持现状（不渲染时间线）。 */
function StageDetailDrawer({ det, onClose, sessionId, sessions }) {
  const [sel, setSel] = React.useState(null)
  const st = det.stage
  const d = det.data
  const attempts = (d && d.attempts && d.attempts.length > 1) ? d.attempts : null
  const selIdx = attempts ? (sel === null ? attempts.length - 1 : sel) : null
  const cur = attempts ? (attempts[selIdx] || d) : d
  const color = (st && st.status) ? stColor(st.status) : T.text2
  // 跨会话判定：该 run 由另一会话发起（ownerSession ≠ 当前会话）→ 禁用跳转（DSH 目录按父会话加载，跨父导航暂不支持）
  const ownerSession = (d && d.ownerSession) ? String(d.ownerSession) : null
  const mySession = sessionId ? String(sessionId) : null
  const crossSession = !!ownerSession && !!mySession && ownerSession !== mySession
  const hasChild = !!(!crossSession && cur && cur.childId && sessions && typeof sessions.openSubagent === 'function')
  const openChild = () => {
    if (crossSession || !hasChild) return
    try { sessions.openSubagent({ parentSessionId: (ownerSession || sessionId), childSessionId: cur.childId, mode: 'one-shot' }) } catch (e) { /* 会话跳转失败忽略 */ }
  }
  const outText = cur && cur.output ? cur.output
    : cur && cur.summary ? t('stage.summaryFallback', { summary: cur.summary })
    : det.err ? t('stage.loadFailed', { err: det.err })
    : det.loading ? t('common.loading')
    : t('stage.noOutput')
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
      h('span', { style: { fontSize: 17 } }, phaseIconOf(st && st.phase)),
      h('div', { style: { flex: 1, minWidth: 0 } },
        h('div', { title: st ? st.label : undefined, style: { fontSize: 12.5, fontWeight: 700, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, st ? stageLabelOf(st) : t('stage.detailTitle')),
        h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 1, fontFamily: MONO, fontVariantNumeric: 'tabular-nums' } },
          `${st ? `#${st.seq} · ${st.phase}` : ''}${(st && (st.startedAt || st.endedAt)) ? ` · ${fmtDur(st.startedAt, st.endedAt)}` : ''}`),
      ),
      st ? chip(stageStatusText(st.status), color, { dot: true }) : null,
      h('button', { onClick: onClose, style: closeBtn, title: t('common.close') }, '✕'),
    ),
    /* 内容 */
    h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 11 } },
      /* usage 明细（官方口径全字段） */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, t('token.officialTitle')),
        h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text, lineHeight: 1.65 } }, usageDetail(cur || st || {})),
      ),
      /* 尝试历史时间线（同任务多次尝试；单次不渲染——保持现状简洁） */
      attempts ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, t('stage.attemptHistory', { n: attempts.length })),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          attempts.map((a, idx) => {
            const aColor = a.status === 'done' ? T.success : (a.status === 'failed' ? T.error : T.warn)
            const sel = idx === selIdx
            return h('div', {
              key: a.seq, onClick: () => setSel(idx),
              title: (a.summary || a.outcome || '').slice(0, 200),
              style: {
                cursor: 'pointer', borderRadius: 9, padding: '6px 9px', display: 'flex', gap: 7, alignItems: 'center',
                border: `1px solid ${sel ? color : T.border}`,
                background: sel ? `color-mix(in srgb, ${color} 10%, transparent)` : T.layer1,
              },
            },
              h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, flex: '0 0 52px' } }, `#${a.seq}`),
              h('span', { style: { fontSize: 11, color: aColor, flex: '0 0 64px', fontWeight: 700 } }, a.status === 'done' ? t('stage.attemptDone') : a.status === 'failed' ? t('stage.attemptFailed', { outcome: a.outcome || t('common.failed') }) : a.status === 'cancelled' ? t('stageStatus.cancelled') : t('stage.attemptRunning')),
              h('span', { style: { flex: 1, minWidth: 0, fontSize: 10.5, color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (a.summary || a.outcome || t('common.noSummary')).slice(0, 80)),
              h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2, flex: '0 0 auto' } }, a.startedAt ? fmtDur(a.startedAt, a.endedAt) : '—'),
              h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2, flex: '0 0 auto' } }, a.usage ? fmtTokens(totalTokens(a.usage)) : ''),
            )
          }),
        ),
      ) : null,
      /* 跳子代理会话（当前 DSH 未暴露"切 conversation.view 视图"接口：openSubagent 仅完成跳转，
         完整轨迹需到「对话」tab 查看；待官方 conversation.setView 支持后再一键直达，见 AGENTS §6 待办） */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('button', {
          onClick: openChild, disabled: !hasChild,
          title: crossSession
            ? t('stage.childCrossSessionTip', { sid: ownerSession.slice(-6) })
            : hasChild ? t('stage.childJumpTip') : t('stage.childNoneTip'),
          style: {
            font: 'inherit', fontSize: 12, fontWeight: 600, padding: '8px 12px', borderRadius: 9, cursor: 'pointer',
            display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'center',
            border: `1px solid color-mix(in srgb, ${T.brand} 40%, transparent)`,
            background: `color-mix(in srgb, ${T.brand} 12%, transparent)`, color: T.brand,
            opacity: hasChild ? 1 : 0.45,
          },
        }, t('stage.childJumpBtn')),
        crossSession
          ? h('div', { style: { fontSize: 10.5, color: T.text2, textAlign: 'center', lineHeight: 1.55 } },
            t('stage.childCrossSessionNote', { sid: ownerSession ? ownerSession.slice(-6) : '' }))
          : hasChild ? h('div', { style: { fontSize: 10.5, color: T.text2, textAlign: 'center', lineHeight: 1.55 } },
            t('stage.childJumpNote')) : null,
      ),
      /* 验证证据（dev/qaFix 契约；policy 级——缺失已记 warn，此处置灰提示可见） */
      (st && phaseKeyOf(st.phase) === 'dev') ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, t('stage.evidenceTitle')),
        (cur && cur.verifyEvidence)
          ? h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11.5, lineHeight: 1.62, color: T.text, background: `color-mix(in srgb, ${T.layer2} 55%, transparent)`, border: `1px solid ${T.border}`, borderRadius: 10, padding: '10px 12px', maxHeight: 180, overflowY: 'auto', fontFamily: MONO } }, cur.verifyEvidence)
          : h('div', { style: { fontSize: 11, color: T.warn, background: `color-mix(in srgb, ${T.warn} 8%, transparent)`, border: `1px dashed color-mix(in srgb, ${T.warn} 45%, transparent)`, borderRadius: 10, padding: '8px 12px', lineHeight: 1.55 } }, t('stage.evidenceMissing')),
      ) : null,
      /* 产物全文 */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
        h('span', { style: { fontSize: 10.5, fontWeight: 700, color: T.text2, letterSpacing: 0.3 } }, t('stage.artifactsTitle')),
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
    t('pipeline.empty'))
  const groups = []
  // 任务键（2026-09-06 英文化）：stage.taskKey 优先（结构化）；存量数据 label 兜底（去中文结构标记）
  const taskKeyOf = (s) => String(s.taskKey || String(s.label || '').replace(/^开发 · /, '').replace(/（(?:第 \d+ 次重试|补跑)）$/, '').trim())
  for (const st of active.stages || []) {
    let g = groups.length ? groups[groups.length - 1] : null
    if (!g || g.phase !== st.phase) { g = { phase: st.phase, stages: [] }; groups.push(g) }
    // 任务级聚合（状态机 2026-09-06，全阶段通用——QA 单 agent 阶段同样收敛）：同任务多次尝试
    // 合成一张卡（重试角标），不再逐尝试膨胀；单次尝试 = 原样单卡（零回归）
    const key = taskKeyOf(st)
    const prev = g.stages.find((x) => x.__taskKey === key)
    if (prev) {
      prev.attempts = prev.attempts || [prev]
      prev.attempts.push(st)
      if ((st.seq || 0) > (prev.seq || 0)) {
        for (const f of ['status', 'outcome', 'usage', 'output', 'summary', 'childId', 'startedAt', 'endedAt', 'verifyEvidence']) prev[f] = st[f]
        prev.seq = st.seq
        prev.label = st.label
      }
    } else {
      g.stages.push({ ...st, __taskKey: key, attempts: [st] })
    }
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
      position: 'relative', flex: 1, minHeight: 320, borderRadius: 12, overflow: 'hidden', touchAction: 'none',
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
    layout.nodes.length === 0 ? h('div', { style: { position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text2, fontSize: 13 } }, t('pipeline.noNodes')) : null,
    /* 浮层控制簇（不参与画布拖拽） */
    h('div', {
      onMouseDown: (e) => e.stopPropagation(),
      style: { position: 'absolute', top: 10, right: 12, zIndex: 6, display: 'flex', alignItems: 'center', gap: 6, padding: 5, borderRadius: 11, border: `1px solid ${T.border}`, background: `color-mix(in srgb, ${T.layer1} 82%, transparent)`, backdropFilter: 'blur(8px)', boxShadow: '0 6px 20px rgba(0,0,0,.16)' },
    },
      h('button', { title: t('pipeline.zoomOut'), onClick: () => zoomBy(0.86), style: zoomStyle }, '−'),
      h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, minWidth: 34, textAlign: 'center' } }, `${Math.round(view.s * 100)}%`),
      h('button', { title: t('pipeline.zoomIn'), onClick: () => zoomBy(1.16), style: zoomStyle }, '+'),
      h('span', { style: { width: 1, height: 14, background: T.border } }),
      h('button', { title: t('pipeline.fitCanvas'), onClick: fitNow, style: { ...zoomStyle, fontSize: 13 } }, '⤢'),
      h('span', { style: { width: 1, height: 14, background: T.border } }),
      h('span', { style: { fontSize: 10.5, color: T.text2, paddingRight: 4, opacity: 0.85 } }, t('pipeline.canvasHint')),
    ),
    /* 阶段详情浮层：悬浮于画布右上，不挤占画布宽度；浮层内滚轮只滚正文（原生 stopPropagation），不触发画布缩放 */
    det ? h(StageDetailDrawer, { det, onClose: closeDet, sessionId, sessions }) : null,
  )
}

/* ── Backlog 拖拽看板 ────────────────────────────────────────────── */
function BoardPanel({ backlog, api, onRefresh, sessionId, onShowRun, openArtifact }) {
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
    t('board.empty'))

  // 子卡查找表：subtaskId → subtask
  const subtaskMap = {}
  for (const t of (backlog.tasks || [])) {
    if (t.type === 'subtask' && t.id) subtaskMap[t.id] = t
  }

  const move = async (kind, id, to) => {
    try { await api.backlogUpdate(kind, id, to, sessionId, t('board.dragReason')) } catch (e) { /* 面板吞错，轮询自愈 */ }
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
      // 窄列（140–172px）内必须能收缩：否则等宽数字行（如 ⇅19.7k/127.0k·⬆4.7k·87%）会顶破卡片外框
      boxSizing: 'border-box', minWidth: 0, maxWidth: '100%', overflow: 'hidden',
      opacity: drag && drag.id === item.id ? .35 : 1,
      transition: 'opacity .1s ease, transform .12s ease',
      boxShadow: '0 1px 2px rgba(0,0,0,.05)',
    },
    title: t('board.cardTip', { id: item.id, status: item.status, summary: item.summary ? '\n' + item.summary : '' }),
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, minWidth: 0 } },
      h('span', { style: { fontFamily: MONO, color: T.text2, fontSize: 10.5, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.id),
      item.severity ? chip(item.severity, item.severity === 'P0' ? T.error : item.severity === 'P1' ? T.warn : T.text2) : null,
      item.owner ? h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: T.text2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, `👤 ${item.owner}`) : null,
    ),
    h('div', { title: item.title || undefined, style: { fontWeight: 500, margin: '3px 0 4px', lineHeight: 1.4, overflowWrap: 'anywhere' } }, (item.title || '').slice(0, 30)),
    h('div', { style: { ...flexRow, marginTop: 2, minWidth: 0 } },
      chip(stText(item.status), stColor(item.status)),
      typeof item.retries === 'number' && item.retries > 0 ? h('span', { style: { fontSize: 10.5, color: T.warn, fontFamily: MONO } }, `↻${item.retries}`) : null,
      item.humanIntervention || item.status === 'needs-human' ? h('span', { style: { fontSize: 10.5, color: T.error, fontWeight: 700 } }, '⚠') : null,
    ),
    (kind === 'task' && (item.devAssign || item.qaAssign || item.acceptBy)) ? h('div', { style: { ...flexRow, marginTop: 3, fontSize: 10.5, color: T.text2, fontFamily: MONO, minWidth: 0 } },
      item.devAssign ? h('span', { title: t('board.assignDevTip', { who: item.devAssign }), style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap' } }, `👨‍💻${item.devAssign}`) : null,
      item.qaAssign ? h('span', { title: t('board.assignQaTip', { who: item.qaAssign }), style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap' } }, `🧪${item.qaAssign}`) : null,
      item.acceptBy ? h('span', { title: t('board.acceptTip', { who: item.acceptBy }), style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '100%', minWidth: 0, whiteSpace: 'nowrap' } }, `✅${item.acceptBy}`) : null,
    ) : null,
    /* 按角色 token 行：等宽数字是不可断的长串 → 允许在任意处换行（否则撑破窄列） */
    (kind === 'task' && byRoleLine(item)) ? h('div', { style: { ...flexRow, marginTop: 3, fontSize: 10.5, color: T.warn, fontFamily: MONO, minWidth: 0, maxWidth: '100%' } },
      h('span', { style: { color: T.text2, flex: '0 0 auto' } }, '⛽'),
      h('span', { title: byRoleLine(item), style: { minWidth: 0, flex: '1 1 auto', overflowWrap: 'anywhere', wordBreak: 'break-word' } }, byRoleLine(item)),
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
          h('span', null, t('board.subtaskCount', { n: subs.length })),
          done > 0 ? h('span', { style: { color: T.success } }, `${done}✓`) : null,
          running > 0 ? h('span', { style: { color: T.brand } }, `${running}⟳`) : null,
          failed > 0 ? h('span', { style: { color: T.error } }, `${failed}✗`) : null,
        ),
        subs.map((sub) => h('div', {
          key: sub.id,
          style: {
            display: 'flex', alignItems: 'center', gap: 4, fontSize: 10.5, fontFamily: MONO,
            padding: '2px 6px', borderRadius: 4, marginBottom: 2, minWidth: 0,
            background: sub.status === 'failed' ? `color-mix(in srgb, ${T.error} 7%, transparent)` : T.layer2,
            border: `1px solid ${stColor(sub.status)}30`,
          },
        },
          h('span', { style: { color: stColor(sub.status), fontWeight: 600, minWidth: 12, flex: '0 0 auto' } }, sub.status === 'done' ? '✓' : sub.status === 'failed' ? '✗' : sub.status === 'running' ? '⟳' : '…'),
          h('span', { title: sub.title || undefined, style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, (sub.title || '').replace(/^开发 · /, '')),
          sub.devAssign ? h('span', { title: t('board.assignDevTip', { who: sub.devAssign }), style: { flex: '0 1 auto', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 70, minWidth: 0, whiteSpace: 'nowrap' } }, sub.devAssign) : null,
        ))
      )
    })() : null,
  )

  const groups = [
    { kind: 'req', list: backlog.requirements || [] },
    { kind: 'task', list: (backlog.tasks || []).filter((t) => t.type !== 'subtask') }, // 只展示主卡（子卡嵌套在主卡下）
    { kind: 'bug', list: backlog.bugs || [] },
  ]
  return h('div', { style: { position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, paddingRight: 4 } },
    groups.map(({ kind, list }) => {
      const counts = {}
      for (const s of COLUMNS[kind]) counts[s] = 0
      for (const item of list) counts[item.status] = (counts[item.status] || 0) + 1
      return h('div', { key: kind },
        /* 分组标题：看板区滚动时吸附在顶部（否则滚下去就不知道在看哪组） */
        h('div', {
          style: {
            position: 'sticky', top: 0, zIndex: 3, background: T.bg,
            display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, fontSize: 13,
            padding: '6px 0 8px',
          },
        },
          h('span', { style: { fontSize: 14 } }, kind === 'req' ? '📌' : kind === 'task' ? '🔧' : '🐞'),
          kindTitle(kind),
          h('span', {
            style: { fontSize: 11, fontWeight: 600, color: T.text2, background: T.layer2, borderRadius: 999, padding: '0 8px', lineHeight: '18px' },
          }, String(list.length)),
        ),
        h('div', { style: { display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 6 } },
          COLUMNS[kind].map((s) => {
            const isOver = over === `${kind}:${s}`
            const color = stColor(s)
            const colBg = isOver ? `color-mix(in srgb, ${color} 8%, ${T.layer1})` : T.layer2
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
                borderRadius: 10, padding: 0, minHeight: 84,
                // 卡片多了在列内滚（不再拉长整列），配合下方表头吸附；overflowX 兜底：任何超宽内容都不许顶出列外
                maxHeight: 340, overflowY: 'auto', overflowX: 'hidden',
                background: colBg,
                border: `1px dashed ${isOver ? color : T.border}`,
                transition: 'background .12s ease, border-color .12s ease',
              },
            },
              /* 列头：列内滚动时吸附在顶部（sticky 需要不透明底，用列自身底色） */
              h('div', {
                style: {
                  ...flexRow, fontSize: 11, fontWeight: 600, color,
                  position: 'sticky', top: 0, zIndex: 2, background: colBg,
                  padding: '7px 9px 5px', borderTopLeftRadius: 10, borderTopRightRadius: 10,
                },
              },
                h('span', null, stText(s)),
                h('span', { style: { marginLeft: 'auto', fontFamily: MONO, fontSize: 10, opacity: .75 } }, counts[s] || 0),
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '0 7px 7px', minWidth: 0 } },
                list.filter((item) => item.status === s).map((item) => card(item, kind)),
              ),
            )
          }),
        ),
      )
    })),
    det ? h(ItemDetailDrawer, { det, onClose: () => setDet(null), onShowRun, openArtifact }) : null,
  )
}

/* ── TeamFlow Backlog 条目详情抽屉 ──────────────────────────────── */
function fmtAt(ts) { return ts ? new Date(ts).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }) : '—' }

function ItemDetailDrawer({ det, onClose, onShowRun, openArtifact }) {
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
      extra && extra.assignee ? h('span', { title: t('board.assignDevTip', { who: extra.assignee }), style: { display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 10, fontFamily: MONO, color: T.text2, flex: '0 0 auto', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 90, whiteSpace: 'nowrap' } }, `👨‍💻${String(extra.assignee).slice(0, 14)}`) : null,
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
      h('button', { onClick: onClose, style: closeBtn, title: t('common.close') }, '✕'),
    ),
    /* 内容 */
    h('div', { style: { flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 13 } },
      loading ? h('div', { style: { color: T.text2, fontSize: 12, padding: 12 } }, t('common.loading')) :
        err ? h('div', { style: { color: T.error, fontSize: 12, padding: 12 } }, '⚠ ' + err) :
          !d ? null :
          [
            /* 概览 */
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('item.overview')),
              d.spec ? h(FoldableText, { text: d.spec, charLimit: 300, lineLimit: 4, style: { background: T.layer2, borderRadius: 8, padding: '8px 10px' } }) : null,
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                d.summary ? h(FoldableText, { text: d.summary }) : null,
              ),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                d.devAssign ? kv('👨‍💻 dev', d.devAssign.slice(0, 26), true) : null,
                d.qaAssign ? kv('🧪 qa', d.qaAssign.slice(0, 26), true) : null,
                d.assignBy ? kv(t('item.acceptRow'), d.assignBy.slice(0, 26), true) : null,
                d.owner ? kv('👤 owner', d.owner.slice(0, 26), true) : null,
                (typeof d.retries === 'number' && d.retries > 0) ? kv(t('item.retryRow'), String(d.retries)) : null,
                d.humanIntervention ? kv(t('item.humanRow'), t('common.needsHuman')) : null,
                kv(t('item.updatedAt'), fmtAt(d.updatedAt) || '—'),
              ),
            ),
            /* 缺陷卡自身的内容（复现/期望/实际）：先于「关联 run 的原始需求」给出，否则点开只看到需求原文 */
            kind === 'bug' ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', borderRadius: 8, background: T.layer2, border: `1px solid ${T.border}` } },
              secTitle(t('panelItem.defectSection')),
              d.spec ? h(FoldableText, { text: d.spec, charLimit: 300, lineLimit: 4 }) : null,
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                d.defectId ? kv(t('panelItem.row.defectId'), String(d.defectId)) : null,
                d.severity ? kv(t('panelItem.row.severity'), String(d.severity)) : null,
                d.module ? kv(t('panelItem.row.module'), String(d.module)) : null,
                d.reproduce ? kv(t('panelItem.row.reproduce'), String(d.reproduce)) : null,
                d.expected ? kv(t('panelItem.row.expected'), String(d.expected)) : null,
                d.actual ? kv(t('panelItem.row.actual'), String(d.actual)) : null,
                d.defectCheck ? kv(t('panelItem.row.defectCheck'), String(d.defectCheck)) : null,
                d.defectCriterion ? kv(t('panelItem.row.defectCriterion'), String(d.defectCriterion)) : null,
                d.defectAc ? kv(t('panelItem.row.defectAc'), String(d.defectAc)) : null),
              (d.reproduce || d.expected || d.actual) ? null : h('div', { style: { fontSize: 10.5, color: T.warn, lineHeight: 1.5 } }, t('panelItem.noDefectDetail'))) : null,
            /* 需求原文 + 运行信息（req / 关联 journal） */
            d.runInfo ? (() => {
              const ri = d.runInfo
              return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
                h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
                  h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
                    secTitle(t('item.runSection')),
                    h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2, whiteSpace: 'nowrap' } }, ri.runId),
                    chip(stText(ri.status), stColor(ri.status)),
                    onShowRun ? h('button', {
                      onClick: () => onShowRun(ri.runId),
                      title: t('item.jumpRunTip', { id: String(ri.runId).slice(-6) }),
                      style: { marginLeft: 'auto', flex: '0 0 auto', whiteSpace: 'nowrap', fontSize: 10.5, fontWeight: 600, padding: '2px 9px', borderRadius: 6, cursor: 'pointer', border: `1px solid color-mix(in srgb, ${T.brand} 38%, transparent)`, background: `color-mix(in srgb, ${T.brand} 10%, transparent)`, color: T.brand, lineHeight: '16px' },
                    }, t('item.runBtn')) : null,
                  ),
                  (ri.startedAt || ri.endedAt) ? h('span', { style: { fontSize: 10.5, color: T.text2, fontFamily: MONO } }, `${fmtAt(ri.startedAt)} → ${fmtAt(ri.endedAt)} · ${fmtDur(ri.startedAt, ri.endedAt)}`) : null,
                ),
                  h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                    secTitle(t('item.requirement')),
                    h(FoldableText, { text: ri.requirement || t('item.noRequirement'), charLimit: 300, lineLimit: 4, style: { background: T.layer2, borderRadius: 8, padding: '8px 10px' } }),
                  ),
              )
            })() : null,
            /* 任务夹（ADR-0008）：路径 + 产物一键右侧栏预览（host 只回存在且带好地址的文件） */
            d.runDocs ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('item.runDocs')),
              h('div', { style: { fontSize: 11.5, fontFamily: MONO, color: T.brand, background: T.layer2, borderRadius: 8, padding: '7px 10px', wordBreak: 'break-all' } }, d.runDocs + '/'),
              (Array.isArray(d.artifacts) && d.artifacts.length > 0) ? h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 1 } },
                d.artifacts.map((a) => h('button', {
                  key: a.name,
                  onClick: () => { if (openArtifact) openArtifact(a.address, a.name) },
                  title: t('item.previewTip', { path: `${d.runDocs}/${a.name}` }),
                  style: { fontSize: 10.5, fontWeight: 600, padding: '3px 9px', borderRadius: 6, cursor: 'pointer', lineHeight: '16px', border: `1px solid color-mix(in srgb, ${T.brand} 38%, transparent)`, background: `color-mix(in srgb, ${T.brand} 10%, transparent)`, color: T.brand, whiteSpace: 'nowrap' },
                }, `📄 ${String(a.name).replace(/\.md$/, '')}`)),
              ) : null,
            ) : null,
            /* TOKEN（task） */
            (kind === 'task' && d.usage) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('token.officialTitle')),
              h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text, lineHeight: 1.65 } }, usageDetail(d)),
              (d.byRole && Object.keys(d.byRole).length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, marginTop: 2 } },
                Object.entries(d.byRole).sort((a, b) => (totalTokens(b[1]) - totalTokens(a[1]))).map(([role, uRaw]) => {
                  const u = uRaw as { input?: number; cacheRead?: number; cacheWrite?: number; output?: number; calls?: number }
                  const label = roleChip(role)
                  return h('div', { key: role, style: { display: 'flex', gap: 7, alignItems: 'center', fontSize: 10.5, fontFamily: MONO, color: T.text2 } },
                    h('span', { style: { flex: '0 0 64px' } }, label),
                    h('span', { style: { color: T.text } }, `⛽${fmtTokens(totalTokens(u))}`),
                    h('span', null, `${fmtTokens(u.input || 0)}i / ${fmtTokens(u.cacheRead || 0)}c / ${fmtTokens(u.output || 0)}o · ${t('common.calls', { n: u.calls || 0 })}`),
                  )
                }),
              ) : null,
            ) : null,
            /* 关联子卡 */
            (d.subtasks && d.subtasks.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('item.subtasks', { n: d.subtasks.length })),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, d.subtasks.map((s) => linkRow(s, { usage: s.usage, assignee: s.devAssign }))),
            ) : null,
            /* 关联缺陷 */
            (d.bugs && d.bugs.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('item.bugs', { n: d.bugs.length })),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } }, d.bugs.map((b) => linkRow(b, {}))),
            ) : null,
            /* 流转时间线 */
            (d.events && d.events.length > 0) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
              secTitle(t('item.timeline', { n: d.events.length })),
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
function TeamSelector({ sessionId, remote, locale }) {
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
    // locale 是依赖：团队名/描述由 host 按界面语言本地化后下发，切语言必须重取
    // （团队配置是用户数据，client 侧不翻译，见 host/index.ts teamPayload）
  }, [remote, sessionId, locale])

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
      title: active ? t('team.currentTip', { name: active.name }) : t('team.pick'),
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
      h('span', { title: active && active.name ? String(active.name) : t('team.label'), style: { maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, active ? active.name : t('team.label')),
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
      h('div', { style: { padding: '7px 12px', fontSize: 10, color: T.text2, borderBottom: `1px solid ${T.border}` } }, t('team.pick')),
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
          h('div', { style: { fontWeight: 600, lineHeight: 1.35 } }, t('team.none')),
          h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 3, lineHeight: 1.45, whiteSpace: 'normal', wordBreak: 'break-word' } }, t('team.noneNote')),
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
    throw new Error(t('common.remoteCallFailed', { what: what || 'remote', detail: (res && res.error && (res.error.message || res.error.code)) || t('common.unknownError') }))
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
  /** 中断运行（只对正在跑的 run 有效；host 返回 `{ ok }`，false = 已不在运行中）。 */
  cancel(runId: string): Promise<RpcEnvelope>
  stageDetail(runId: string, seq: number, sessionId?: string | null): Promise<RpcEnvelope>
  itemDetail(kind: string, id: string, sessionId?: string | null): Promise<RpcEnvelope>
}

interface TeamFlowViewProps {
  sessionId: string
  remote: unknown
  /** 产物一键预览：host 已算好 dsh-resource 地址，这里交给右侧栏（服务缺失时静默降级）。 */
  openArtifact?: (address: string, name: string) => void
  /** 通用右侧栏打开（run 详情 tab 等）；返回 false 表示右侧栏不可用，调用方自行降级。 */
  openResource?: (address: string, label: string) => boolean
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
    if (!api) { setState((s) => ({ ...s, err: t('common.remoteNotReady') })); return }
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
  // 只有 running 是 host 侧的真实活动态（其余历史态 cancel 会被 host 拒绝，故不显示按钮）
  const runningRun = !!(activeRun && activeRun.status === 'running')
  /** 中断请求已发出：按钮先隐藏，等 2s 轮询把状态刷成 cancelled（避免重复点出「未生效」提示）。 */
  const [cancelSentFor, setCancelSentFor] = React.useState<string | null>(null)
  React.useEffect(() => { setCancelSentFor(null) }, [activeRun && activeRun.id, activeRun && activeRun.status])
  const onCancel = async (id) => {
    if (!api) return
    try {
      const r = unwrap(await api.cancel(id), 'cancel') as { ok?: boolean } | null
      if (!r || r.ok !== true) throw new Error(t('cancel.failed'))
      setCancelSentFor(id)
      refresh()
    } catch (e) {
      setState((s) => ({ ...s, err: String((e && e.message) || e) }))
    }
  }

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

  return h('div', { style: { fontFamily: SANS, fontSize: 13, color: T.text, display: 'flex', flexDirection: 'column', gap: 10, padding: '4px 16px 10px', height: '100%', minHeight: 0, overflow: 'hidden' } },
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
        h('span', { style: { fontWeight: 700, fontSize: 14, lineHeight: '18px' } }, t('workbench.title')),
        h('span', { style: { fontSize: 11, color: T.text2, display: 'flex', alignItems: 'center', gap: 5 } },
          h('span', {
            style: {
              width: 7, height: 7, borderRadius: 999, display: 'inline-block',
              background: anyRunning ? T.success : T.text2,
              animation: anyRunning ? 'tf-pulse 1.6s ease-in-out infinite' : 'none',
            },
          }),
          anyRunning ? t('workbench.running') : t('workbench.idle'),
        ),
      ),
      h('button', { onClick: refresh, style: { ...btn, marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 5 } }, t('workbench.refresh')),
      runningRun && cancelSentFor !== activeRun.id ? h(CancelButton, {
        runId: activeRun.id,
        label: t('cancel.btnWithId', { id: String(activeRun.id).slice(-6) }),
        title: t('cancel.tip', { id: activeRun.id }),
        onConfirm: onCancel,
      }) : null,
      canResume ? h('button', {
        onClick: onResume, disabled: busy,
        title: t('workbench.resumeTip', { id: activeRun.id, status: runStatusText(activeRun.status) }),
        style: { ...btn, background: T.error, color: '#fff', border: 'none', fontWeight: 600 },
      }, busy ? t('workbench.resuming') : t('workbench.resumeBtn', { id: String(activeRun.id).slice(-6) })) : null,
    ),

    err ? h('div', {
      style: {
        color: T.error, fontSize: 12, background: `color-mix(in srgb, ${T.error} 8%, transparent)`,
        border: `1px solid color-mix(in srgb, ${T.error} 30%, transparent)`, borderRadius: 8, padding: '7px 11px',
      },
    }, t('workbench.loadFailed', { err })) : null,

    /* 人工介入横幅 */
    needHuman.length > 0 ? h('div', {
      style: {
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        background: `color-mix(in srgb, ${T.warn} 9%, ${T.layer1})`,
        border: `1px solid color-mix(in srgb, ${T.warn} 35%, transparent)`,
        borderRadius: 10, padding: '9px 12px',
      },
    },
      h('span', { style: { fontWeight: 700, color: T.warn, fontSize: 12.5 } }, t('workbench.needsHumanBanner', { n: needHuman.length })),
      needHuman.slice(0, 5).map((item) => {
        const kind = (backlog.requirements || []).some((r) => r.id === item.id) ? 'req'
          : (backlog.tasks || []).some((t) => t.id === item.id) ? 'task' : 'bug'
        const fin = kind === 'bug' ? 'verified' : 'accepted'
        return h('button', {
          key: item.id,
          onClick: async () => { await api.backlogUpdate(kind, item.id, fin, props.sessionId, t('workbench.manualReason')); refresh() },
          style: { ...btn, background: T.success, color: '#fff', border: 'none', fontWeight: 600 },
        }, t('workbench.handle', { id: item.id }))
      }),
    ) : null,

    /* tab 栏 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 2, borderBottom: `1px solid ${T.border}` } },
      h('button', { onClick: () => setTab('pipeline'), style: tabBtn(tab === 'pipeline') }, t('workbench.tabPipeline')),
      h('button', { onClick: () => setTab('board'), style: tabBtn(tab === 'board') }, t('workbench.tabBoard')),
      h('div', { style: { marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 } },
        activeRun ? h('span', {
          title: `${activeRun.id}\n${activeRun.requirement || ''}`,
          style: {
            fontSize: 11.5, fontFamily: MONO, padding: '2px 10px', borderRadius: 999,
            background: T.layer2, color: activeRun.status === 'interrupted' ? T.warn : T.text2,
            border: `1px solid ${T.border}`,
          },
        }, `#${String(activeRun.id).slice(-8)} · ${runStatusText(activeRun.status)}`) : null,        total && (total.input + total.cacheRead + total.cacheWrite + total.output) > 0 ? h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text2, cursor: 'help' }, title: t('token.allStagesTip') }, `∑ ⇅${fmtTokens(total.input)}/⇅${fmtTokens(total.cacheRead)}·⬆${fmtTokens(total.output)}`) : null,
      ),
    ),

    /* 作用域条：当前工作区（项目）+ 本工作区历史流水线 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' } },
      h('span', {
        title: t('workbench.workspaceTip', { path: (workspace && workspace.path) || t('workbench.noWorkspace') }),
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
        h('span', { style: { color: T.text2 } }, t('workbench.history')),
        runs.length ? runs.map((r) => {
          const sel = r.id === (runId || (runs[0] && runs[0].id))
          return h('button', { key: r.id, onClick: () => setRunId(r.id), style: chipBtn(sel), title: `${r.id}\n${r.requirement || ''}` },
            `#${String(r.id).slice(-6)}`)
        }) : h('span', { style: { color: T.text2, fontSize: 11.5 } }, t('common.noneDash')),
      ) : null,
      /* 右栏 run 详情（v0.1.8）：与任务夹产物并排看；右侧栏不可用时点按无效（只 console 提示） */
      tab === 'pipeline' && activeRun && activeRun.address
        ? h('button', {
          style: chipBtn(false),
          title: t('workbench.openRightBarTip'),
          onClick: () => {
            const opened = props.openResource && props.openResource(activeRun.address, activeRun.id)
            if (!opened) console.warn('[teamflow] 右侧栏不可用，run 详情请在画布节点里查看')
          },
        }, t('workbench.openRightBarBtn'))
        : null,
    ),

    /* 内容区：占满剩余高度并自行滚动——宿主 `.viewArea` 是 flex:1/min-height:0 且不滚动，
       根容器不约束高度就会顶出可视区（外层多出一条页面滚动条，2026-09-11 用户实测） */
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' } },
      tab === 'pipeline' ? h(PipelinePanel, { active, api, runId: activeRun ? activeRun.id : null, sessionId: props.sessionId, sessions: props.sessions }) : h(BoardPanel, { backlog, api, onRefresh: refresh, sessionId: props.sessionId, openArtifact: props.openArtifact, onShowRun: (rid) => { setTab('pipeline'); setRunId(rid) } })),
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

/**
 * 注册三处：
 * 1. `sidebar.panellist` + `main`（key = 'teamflow'）：**全局面板**——侧边栏图标 + 中央主区。
 *    两者 id 必须一致：宿主 `layout.selectPanel(id)` 对未注册的 main key 直接抛错。
 * 2. `conversation.view` tab（会话内工作台）+ `conversation.input.right`（团队选择按钮）。
 * 3. 右栏 run 详情 tab 类型 + body（`sidebarRightTabs` + `sidebar.right.pane.tab`）。
 */
export async function apply(ctx) {
  await ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)
  const teamflow = ctx.get('remote.teamflow')
  /* ── 双语（v0.1.9）：词典注册 + 翻译函数注入（机制见 client/locales.ts） ──
   * - register：两个词典进宿主 locale 服务（切语言时宿主重渲染每个 slot outlet）；
   * - bind：返回的函数每次调用读当前语言，故可常驻 shared 的模块变量
   *   （词表/格式化/折叠件是纯函数，拿不到组件 prop，只能走这条注入路径）；
   * - labels 用 thunk：侧边栏面板名与 tab 名由宿主在读取时求值（ui-sidebar /
   *   ui-conversation 都订阅了 locale），切语言不需要重新注册。 */
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'teamflow: dictionaries')
  ctx.effect(() => ctx.locale.subscribe(() => setTranslator(t, () => ctx.locale.getSnapshot().active)), 'teamflow: translator sync')
  setTranslator(t, () => ctx.locale.getSnapshot().active)
  /* host 侧语言上报（host 无浏览器语言通道）：初始上报一次 + 宿主语言变化时推送。
   * 只走既有 Remote 面（teamflow/setLocale），不自建浏览器存储/语言探测；
   * 失败静默（老宿主无该方法 / RPC 未就绪 / 连接断开都不影响客户端渲染与流水线）。 */
  const pushLocaleToHost = (active?: string): void => {
    try {
      if (typeof active !== 'string' || !active) return
      const p = teamflow.setLocale(active)
      if (p && typeof p.catch === 'function') p.catch(() => {})
    } catch (e) { /* 推送失败静默：host 走兜底链 */ }
  }
  ctx.effect(() => {
    pushLocaleToHost(ctx.locale.getSnapshot().active)
    return ctx.locale.subscribe(() => pushLocaleToHost(ctx.locale.getSnapshot().active))
  }, 'teamflow: host locale push')
  // 右侧栏打开（产物预览 / run 详情共用）：地址（dsh-resource://…）由 host 生成，这里只交给右侧栏。
  // 服务名 sidebarRight（@deepseek-ai/dsh-client-ui-sidebar-right 提供）；未挂载/未认领地址时返回 false
  // ——右侧栏只是增强路径，缺它时调用方降级（故不进 inject，避免激活期硬依赖）。
  // quiet=true：调用方自会做小步重试/给用户可见提示（全局面板需先切回对话才有右侧栏会话 seat），不刷 console。
  const openResourceSafe = (address: string, label: string, quiet?: boolean): boolean => {
    try {
      const sidebarRight = ctx.get('sidebarRight')
      if (!sidebarRight || typeof sidebarRight.openResource !== 'function') {
        if (!quiet) console.warn('[teamflow] 右侧栏服务不可用', label)
        return false
      }
      sidebarRight.openResource(address)
      return true
    } catch (e) {
      if (!quiet) console.warn('[teamflow] 打开右侧栏失败', label, e && e.message)
      return false
    }
  }
  const openArtifact = (address: string, name: string) => { openResourceSafe(address, name) }
  // 注册全局面板：侧边栏图标 + 中央主区（同 id 'teamflow'）
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: 'teamflow',
    order: 60,
    locale: NS,
    label: () => t('workbench.title'),
  }, TeamflowPanelIcon))
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: 'teamflow',
    locale: NS,
    inject: () => ({
      remote: teamflow,
      sessions: ctx.get('sessions'),
      layout: ctx.get('layout'),
      openResource: openResourceSafe,
      openArtifact,
    }),
  }, GlobalPanel))
  // 注册右栏 run 详情 tab 类型（类型进 sidebarRightTabs；正文进 keyed seat sidebar.right.pane.tab）
  try {
    const tabs = ctx.get('sidebarRightTabs')
    if (tabs && typeof tabs.register === 'function') {
      ctx.effect(() => tabs.register(runTabDefinition()), 'teamflow: run tab type')
    } else {
      console.warn('[teamflow] sidebarRightTabs 不可用，run 详情右栏 tab 未注册（面板内联详情仍可用）')
    }
  } catch (e) { console.warn('[teamflow] 注册 run tab 类型失败', e && e.message) }
  ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: RUN_TAB_ID,
    locale: NS,
    inject: () => ({ remote: teamflow, openArtifact }),
  }, RunDetailTab))
  // 注册团队工作台 tab
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'teamflow',
    order: 20,
    locale: NS,
    label: () => `🏭 ${t('workbench.title')}`,
    inject: (sessionId) => ({ sessionId, remote: teamflow, sessions: ctx.get('sessions'), openArtifact, openResource: openResourceSafe }),
  }, TeamFlowView))
  // 注册输入框旁的团队选择按钮
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'teamflow-team-select',
    order: 5,
    locale: NS,
    // locale 一并注入：团队名/描述由 host 按界面语言本地化下发，切语言时组件需重取列表
    inject: (sessionId) => ({ sessionId, remote: teamflow, locale: ctx.locale.getSnapshot().active }),
  }, TeamSelector))
}
