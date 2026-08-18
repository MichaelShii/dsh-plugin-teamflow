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
  'needs-human': '需人工', cancelled: '已取消', open: '待认领', claimed: '处理中', fixed: '已修复待验',
  verified: '已关闭', reopened: '重开', done: '已完成', completed: '已完成', failed: '失败',
  interrupted: '已中断', superseded: '已取代',
}
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
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'needs-human'],
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

/* ── 流水线面板：阶段泳道 + 节点卡片 ─────────────────────────────── */
function PipelinePanel({ active }) {
  if (!active) return h('div', { style: { color: T.text2, fontSize: 13, padding: '28px 20px', textAlign: 'center' } },
    h('div', { style: { fontSize: 28, marginBottom: 8 } }, '🏭'),
    '暂无运行中的流水线——让模型调用 teamflow_start，或在上方输入需求')
  const groups = []
  for (const st of active.stages || []) {
    let g = groups.length ? groups[groups.length - 1] : null
    if (!g || g.phase !== st.phase) { g = { phase: st.phase, stages: [] }; groups.push(g) }
    g.stages.push(st)
  }
  const total = totalUsage(active.stages)
  const cols = groups.map((g, i) => {
    const anyRun = g.stages.some((s) => s.status === 'running')
    const anyFail = g.stages.some((s) => s.status === 'failed' || s.status === 'needs-human' || s.status === 'cancelled')
    const allDone = g.stages.length > 0 && g.stages.every((s) => s.status === 'done')
    const headColor = anyRun ? T.brand : anyFail ? T.error : allDone ? T.success : T.text2
    return h('div', { key: i, style: { minWidth: 158, maxWidth: 190, flex: '0 0 auto' } },
      /* 泳道头 */
      h('div', {
        style: {
          display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', marginBottom: 8,
          borderRadius: 8, fontSize: 12, fontWeight: 600,
          background: `color-mix(in srgb, ${headColor} 9%, transparent)`,
          border: `1px solid color-mix(in srgb, ${headColor} 30%, transparent)`,
          color: headColor,
        },
      },
        h('span', { style: { fontSize: 13 } }, PHASE_ICON[g.phase] || '⚙️'),
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, g.phase),
        g.stages.length > 1 ? h('span', {
          style: { marginLeft: 'auto', fontSize: 10, fontWeight: 700, background: 'rgba(0,0,0,.08)', borderRadius: 999, padding: '0 6px', lineHeight: '16px' },
        }, `×${g.stages.length}`) : null,
      ),
      /* 节点卡片 */
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 7 } },
        g.stages.map((s) => {
          const color = stColor(s.status)
          const running = s.status === 'running'
          return h('div', {
            key: s.seq,
            style: {
              position: 'relative', background: T.layer1, border: `1px solid ${T.border}`,
              borderLeft: `3px solid ${color}`, borderRadius: 8, padding: '7px 9px 7px 10px',
              opacity: s.status === 'pending' ? .62 : 1,
              transition: 'transform .12s ease, box-shadow .12s ease',
              boxShadow: running ? `0 0 0 1px color-mix(in srgb, ${color} 35%, transparent), 0 2px 8px color-mix(in srgb, ${color} 12%, transparent)` : '0 1px 2px rgba(0,0,0,.04)',
            },
            title: s.label,
          },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600, fontSize: 12 } },
              h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
            ),
            h('div', { style: { ...flexRow, marginTop: 5, color: T.text2, fontSize: 11 } },
              chip(stText(s.status), color, { dot: true }),
              s.startedAt ? h('span', { style: { fontVariantNumeric: 'tabular-nums', fontFamily: MONO } }, fmtDur(s.startedAt, s.endedAt)) : null,
              (stageUsageLine(s) !== null) ? h('span', { title: usageDetail(s), style: { fontFamily: MONO, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' } }, stageUsageLine(s)) : null,
            ),
            running ? h('div', { style: { marginTop: 6, height: 2, borderRadius: 2, overflow: 'hidden', background: `color-mix(in srgb, ${color} 18%, transparent)` } },
              h('div', { style: { height: '100%', width: '40%', borderRadius: 2, background: color, animation: 'tf-shimmer 1.1s linear infinite' } }),
            ) : null,
          )
        }),
      ),
    )
  })
  return h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 0, overflowX: 'auto', padding: '4px 2px 8px' } },
    cols.reduce((acc, col, i) => {
      if (i > 0) {
        acc.push(h('div', {
          key: `a${i}`, style: {
            alignSelf: 'center', flex: '0 0 auto', width: 22, height: 2, margin: '0 2px',
            borderRadius: 2, opacity: .5,
            background: `linear-gradient(90deg, ${stColor(groups[i - 1].stages[0].status)}, ${stColor(groups[i].stages[0].status)})`,
          },
        }))
      }
      acc.push(col)
      return acc
    }, []),
  )
}

/* ── Backlog 拖拽看板 ────────────────────────────────────────────── */
function BoardPanel({ backlog, api, onRefresh, sessionId }) {
  const [drag, setDrag] = React.useState(null)
  const [over, setOver] = React.useState(null)
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
    title: `${item.id} · ${item.status}${item.summary ? '\n' + item.summary : ''}`,
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { fontFamily: MONO, color: T.text2, fontSize: 10.5 } }, item.id),
      item.severity ? chip(item.severity, item.severity === 'P0' ? T.error : item.severity === 'P1' ? T.warn : T.text2) : null,
      item.owner ? h('span', { style: { marginLeft: 'auto', fontSize: 10.5, color: T.text2 } }, `👤 ${item.owner}`) : null,
    ),
    h('div', { style: { fontWeight: 500, margin: '3px 0 4px', lineHeight: 1.4 } }, (item.title || '').slice(0, 30)),
    h('div', { style: { ...flexRow, marginTop: 2 } },
      chip(stText(item.status), stColor(item.status)),
      typeof item.retries === 'number' && item.retries > 0 ? h('span', { style: { fontSize: 10.5, color: T.warn, fontFamily: MONO } }, `↻${item.retries}`) : null,
      item.humanIntervention || item.status === 'needs-human' ? h('span', { style: { fontSize: 10.5, color: T.error, fontWeight: 700 } }, '⚠') : null,
    ),
    (kind === 'task' && (item.devAssign || item.qaAssign || item.acceptBy)) ? h('div', { style: { ...flexRow, marginTop: 3, fontSize: 10.5, color: T.text2, fontFamily: MONO } },
      item.devAssign ? h('span', { title: 'dev 分配', style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `👨‍💻${item.devAssign}`) : null,
      item.qaAssign ? h('span', { title: 'qa 分配', style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `🧪${item.qaAssign}`) : null,
      item.acceptBy ? h('span', { title: '验收/汇报人', style: { display: 'inline-flex', alignItems: 'center', gap: 3, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 130, whiteSpace: 'nowrap' } }, `✅${item.acceptBy}`) : null,
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
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130 } }, (sub.title || '').replace(/^开发 · /, '')),
          sub.devAssign ? h('span', { style: { marginLeft: 'auto', color: T.text2, overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 70, whiteSpace: 'nowrap' } }, sub.devAssign) : null,
        ))
      )
    })() : null,
  )

  const groups = [
    { kind: 'req', list: backlog.requirements || [] },
    { kind: 'task', list: (backlog.tasks || []).filter((t) => t.type !== 'subtask') }, // 只展示主卡（子卡嵌套在主卡下）
    { kind: 'bug', list: backlog.bugs || [] },
  ]
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
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
      h('span', { style: { maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, active ? active.name : '团队'),
      h('span', { style: { fontSize: 8, opacity: .6 } }, open ? '▲' : '▼'),
    ),
    open ? h('div', {
      style: {
        position: 'absolute', bottom: '100%', right: 0, marginBottom: 4,
        minWidth: 160, background: T.layer1, border: `1px solid ${T.border}`,
        borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,.15)',
        zIndex: 100, overflow: 'hidden',
      },
    },
      h('div', { style: { padding: '6px 10px', fontSize: 10, color: T.text2, borderBottom: `1px solid ${T.border}` } }, '选择团队'),
      // "无团队"选项：清除选择，回到原生模式
      h('button', {
        onClick: () => select(null),
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '7px 10px', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: !active ? `color-mix(in srgb, ${T.text2} 10%, transparent)` : 'transparent',
          color: T.text, fontSize: 12, transition: 'background .1s',
          borderBottom: `1px solid ${T.border}`,
        },
      },
        h('span', { style: { fontSize: 14, opacity: .5 } }, '💬'),
        h('div', null,
          h('div', { style: { fontWeight: 600 } }, '无团队（直接对话）'),
          h('div', { style: { fontSize: 10, color: T.text2, marginTop: 1 } }, '不走 teamflow，模型直接工作'),
        ),
        !active ? h('span', { style: { marginLeft: 'auto', color: T.text2, fontSize: 12 } }, '✓') : null,
      ),
      teams.map((team) => h('button', {
        key: team.id,
        onClick: () => select(team.id),
        style: {
          display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          padding: '7px 10px', border: 'none', cursor: 'pointer', textAlign: 'left',
          background: active && active.id === team.id ? `color-mix(in srgb, ${T.brand} 10%, transparent)` : 'transparent',
          color: T.text, fontSize: 12, transition: 'background .1s',
        },
      },
        h('span', { style: { fontSize: 14 } }, team.icon),
        h('div', null,
          h('div', { style: { fontWeight: 600 } }, team.name),
          h('div', { style: { fontSize: 10, color: T.text2, marginTop: 1 } }, team.description),
        ),
        active && active.id === team.id ? h('span', { style: { marginLeft: 'auto', color: T.brand, fontSize: 12 } }, '✓') : null,
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
}

interface TeamFlowViewProps {
  sessionId: string
  remote: unknown
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
  const canResume = activeRun && (activeRun.status === 'interrupted' || activeRun.status === 'failed' || activeRun.status === 'cancelled')
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
        style: { ...btn, background: T.error, color: '#fff', border: 'none', fontWeight: 600 },
      }, busy ? '续跑中…' : '↻ 从断点重跑') : null,
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
          style: {
            fontSize: 11.5, fontFamily: MONO, padding: '2px 10px', borderRadius: 999,
            background: T.layer2, color: activeRun.status === 'interrupted' ? T.warn : T.text2,
            border: `1px solid ${T.border}`,
          },
        }, `#${String(activeRun.id).slice(-8)} · ${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}`) : null,
        total && (total.input + total.cacheRead + total.cacheWrite + total.output) > 0 ? h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text2, cursor: 'help' }, title: '输入(未命中)/输入(命中)/输出 全部阶段合计' }, `∑ ⇅${fmtTokens(total.input)}/⇅${fmtTokens(total.cacheRead)}·⬆${fmtTokens(total.output)}`) : null,
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
        h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 } },
          (workspace && workspace.path) ? String(workspace.path).split(/[\\/]/).filter(Boolean).pop() : 'ungrouped'),
      ),
      /* 历史 run 切换：仅流水线 tab 下有意义（Backlog 看板是工作区级，不随 run 变化，
         展示在这里点击无反应还会误导 —— 故只看板 tab 时隐藏） */
      tab === 'pipeline' ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
        h('span', { style: { color: T.text2 } }, '历史'),
        runs.length ? runs.map((r) => {
          const sel = r.id === (runId || (runs[0] && runs[0].id))
          return h('button', { key: r.id, onClick: () => setRunId(r.id), style: chipBtn(sel), title: r.requirement },
            `#${String(r.id).slice(-6)}`)
        }) : h('span', { style: { color: T.text2, fontSize: 11.5 } }, '（暂无）'),
      ) : null,
    ),

    tab === 'pipeline' ? h(PipelinePanel, { active }) : h(BoardPanel, { backlog, api, onRefresh: refresh, sessionId: props.sessionId }),
  )
}

/* ── 动画 keyframes（注入一次） ───────────────────────────────────── */
if (typeof document !== 'undefined') {
  const styleEl = document.createElement('style')
  styleEl.textContent = `
@keyframes tf-pulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .45; transform: scale(.8); } }
@keyframes tf-shimmer { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }`
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
    inject: (sessionId) => ({ sessionId, remote: teamflow }),
  }, TeamFlowView))
  // 注册输入框旁的团队选择按钮
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'teamflow-team-select',
    order: 5,
    inject: (sessionId) => ({ sessionId, remote: teamflow }),
  }, TeamSelector))
}
