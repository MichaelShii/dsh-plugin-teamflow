/**
 * dsh-plugin-teamflow — browser half（阶段 3：完整团队工作台）。
 *
 * 注册 conversation.view tab「🏭 团队工作台」（与 chat / 轨迹并列）：
 * - 流水线图形工作流：阶段泳道 + 节点卡片（状态/耗时/token/子代理会话）+ 实时轮询
 * - Backlog 拖拽看板：需求/任务/缺陷三组状态泳道，卡片拖拽流转（原生 HTML5 DnD，零依赖）
 * - 成本中心：每阶段 token + 总计 + 运行时长
 * - 人工介入中心：needs-human 项聚合 + 一键终态
 * - 历史 run 切换
 *
 * 数据通道：ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION) 后经
 * ctx.remote.teamflow.* 调用宿主 service（strict descriptors 见 descriptors.js）。
 */
import React from 'react'
import { TEAMFLOW_REMOTE_CONTRIBUTION } from '../descriptors.js'

export const inject = ['remote', 'slots', 'sessions', 'locale']

const STATUS_TEXT = {
  created: '立项', 'in-progress': '进行中', 'pending-acceptance': '待验收', accepted: '已验收', closed: '已关闭',
  pending: '待办', running: '开发中', testable: '待测试', testing: '测试中', rework: '打回',
  'needs-human': '需人工', cancelled: '已取消', open: '待认领', claimed: '处理中', fixed: '已修复待验',
  verified: '已关闭', reopened: '重开', done: '已完成', completed: '已完成', failed: '失败',
}
const STATUS_COLOR = {
  created: '#6e7781', pending: '#6e7781', open: '#6e7781',
  'in-progress': '#0969da', running: '#0969da', claimed: '#0969da', testing: '#0969da', fixed: '#0969da', reopened: '#8250df',
  'pending-acceptance': '#9a6700', testable: '#9a6700',
  accepted: '#1a7f37', verified: '#1a7f37', completed: '#1a7f37', done: '#1a7f37',
  rework: '#cf222e', failed: '#cf222e', 'needs-human': '#cf222e', cancelled: '#6e7781', closed: '#6e7781',
}
const PHASE_ICON = {
  'PRD 产品需求': '📋', 'UI/UX 设计': '🎨', '架构规划': '🏗️', '技术方案': '📐',
  开发: '💻', 'QA 测试': '🧪', '产品验收': '✅',
}
const RUN_STATUS_TEXT = { pending: '等待中', running: '进行中', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '⚠ 已中断', superseded: '已取代' }
const COLUMNS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'needs-human'],
}
const KIND_TITLE = { req: '需求', task: '任务', bug: '缺陷' }

const h = React.createElement
const px = (n) => `${n}px`
const flexRow = { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }
const cardBase = {
  background: '#fff', border: '1px solid rgba(31,35,40,.15)', borderRadius: 6, padding: '6px 8px', fontSize: 12, cursor: 'grab',
}
const chip = (text, color) => h('span', {
  style: { padding: '1px 7px', borderRadius: 999, fontSize: 11, background: `${color}1a`, color, whiteSpace: 'nowrap' },
}, text)

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
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
const stText = (s) => STATUS_TEXT[s] || s
const stColor = (s) => STATUS_COLOR[s] || '#6e7781'

/* ── 流水线面板：阶段泳道 + 节点卡片 ─────────────────────────────── */
function PipelinePanel({ active }) {
  if (!active) return h('div', { style: { color: '#6e7781', fontSize: 13, padding: 20 } }, '暂无运行中的流水线')
  const groups = []
  for (const st of active.stages || []) {
    let g = groups.length ? groups[groups.length - 1] : null
    if (!g || g.phase !== st.phase) { g = { phase: st.phase, stages: [] }; groups.push(g) }
    g.stages.push(st)
  }
  const total = (active.stages || []).reduce((a, s) => a + (typeof s.tokens === 'number' ? s.tokens : 0), 0)
  const cols = groups.map((g, i) => {
    const anyRun = g.stages.some((s) => s.status === 'running')
    const anyFail = g.stages.some((s) => s.status === 'failed' || s.status === 'cancelled')
    const allDone = g.stages.length > 0 && g.stages.every((s) => s.status === 'done')
    const headColor = anyRun ? '#0969da' : anyFail ? '#cf222e' : allDone ? '#1a7f37' : '#6e7781'
    return h('div', { key: i, style: { minWidth: 158, maxWidth: 190, flex: '0 0 auto' } },
      h('div', { style: { ...flexRow, border: `1px solid ${headColor}55`, background: `${headColor}0d`, borderRadius: 6, padding: '5px 8px', marginBottom: 6, fontSize: 12, fontWeight: 600, color: headColor } },
        h('span', null, PHASE_ICON[g.phase] || '⚙️'),
        h('span', null, g.phase),
        g.stages.length > 1 ? h('span', { style: { marginLeft: 'auto', opacity: .7 } }, `×${g.stages.length}`) : null,
      ),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
        g.stages.map((s) => h('div', {
          key: s.seq,
          style: { ...cardBase, borderLeft: `3px solid ${stColor(s.status)}`, opacity: s.status === 'pending' ? .7 : 1 },
          title: s.label,
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 4, fontWeight: 500 } },
            h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.label),
          ),
          h('div', { style: { ...flexRow, marginTop: 3, color: '#6e7781', fontSize: 11 } },
            chip(stText(s.status), stColor(s.status)),
            s.startedAt ? h('span', null, fmtDur(s.startedAt, s.endedAt)) : null,
            typeof s.tokens === 'number' ? h('span', { style: { fontFamily: 'ui-monospace, monospace' } }, `${fmtTokens(s.tokens)} tok`) : null,
          ),
          s.status === 'running' ? h('div', { style: { marginTop: 3, fontSize: 11, color: '#0969da' } }, '⏳ 执行中…') : null,
        )),
      ),
    )
  })
  return h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 4, overflowX: 'auto', padding: 4 } },
    cols.reduce((acc, col, i) => {
      if (i > 0) acc.push(h('div', { key: `a${i}`, style: { alignSelf: 'center', color: '#6e7781', fontSize: 16, padding: '0 2px' } }, '→'))
      acc.push(col)
      return acc
    }, []),
  )
}

/* ── Backlog 拖拽看板 ────────────────────────────────────────────── */
function BoardPanel({ backlog, api, onRefresh }) {
  const [drag, setDrag] = React.useState(null)
  const [over, setOver] = React.useState(null)
  if (!backlog) return h('div', { style: { color: '#6e7781', fontSize: 13, padding: 20 } }, 'backlog 为空（还没有流水线运行过）')

  const move = async (kind, id, to) => {
    try { await api.backlogUpdate(kind, id, to, backlog.product, '看板拖拽流转') } catch (e) { /* 面板吞错，轮询自愈 */ }
    onRefresh()
  }
  const kindOf = (item) => (backlog.requirements || []).some((r) => r.id === item.id) ? 'req'
    : (backlog.tasks || []).some((t) => t.id === item.id) ? 'task' : 'bug'

  const card = (item, kind) => h('div', {
    key: item.id,
    draggable: true,
    onDragStart: () => setDrag({ kind, id: item.id, from: item.status }),
    onDragEnd: () => setDrag(null),
    style: {
      ...cardBase,
      opacity: drag && drag.id === item.id ? .4 : 1,
      borderLeft: `3px solid ${stColor(item.status)}`,
      background: item.humanIntervention || item.status === 'needs-human' ? '#fff5f5' : '#fff',
    },
    title: `${item.id} · ${item.status}${item.summary ? '\n' + item.summary : ''}`,
  },
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 4 } },
      h('span', { style: { fontFamily: 'ui-monospace, monospace', color: '#6e7781', fontSize: 11 } }, item.id),
      item.severity ? chip(item.severity, item.severity === 'P0' ? '#cf222e' : item.severity === 'P1' ? '#9a6700' : '#6e7781') : null,
      item.owner ? h('span', { style: { marginLeft: 'auto', fontSize: 11, color: '#57606a' } }, `👤 ${item.owner}`) : null,
    ),
    h('div', { style: { fontWeight: 500, margin: '2px 0' } }, (item.title || '').slice(0, 30)),
    h('div', { style: { ...flexRow, marginTop: 2 } },
      chip(stText(item.status), stColor(item.status)),
      typeof item.retries === 'number' && item.retries > 0 ? h('span', { style: { fontSize: 11, color: '#9a6700' } }, `↻${item.retries}`) : null,
      item.humanIntervention || item.status === 'needs-human' ? h('span', { style: { fontSize: 11, color: '#cf222e', fontWeight: 600 } }, '⚠') : null,
    ),
  )

  const groups = [
    { kind: 'req', list: backlog.requirements || [] },
    { kind: 'task', list: backlog.tasks || [] },
    { kind: 'bug', list: backlog.bugs || [] },
  ]
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
    groups.map(({ kind, list }) => {
      const counts = {}
      for (const s of COLUMNS[kind]) counts[s] = 0
      for (const item of list) counts[item.status] = (counts[item.status] || 0) + 1
      return h('div', { key: kind },
        h('div', { style: { fontWeight: 600, fontSize: 13, marginBottom: 6 } }, `${KIND_TITLE[kind]} · ${list.length}`),
        h('div', { style: { display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 4 } },
          COLUMNS[kind].map((s) => h('div', {
            key: s,
            onDragOver: (e) => { e.preventDefault(); setOver(`${kind}:${s}`) },
            onDragLeave: () => setOver((o) => (o === `${kind}:${s}` ? null : o)),
            onDrop: async () => {
              if (drag && drag.kind === kind && drag.from !== s) await move(kind, drag.id, s)
              setDrag(null); setOver(null)
            },
            style: {
              minWidth: 132, maxWidth: 168, flex: '0 0 auto',
              border: `1px dashed ${over === `${kind}:${s}` ? '#0969da' : 'rgba(31,35,40,.2)'}`,
              borderRadius: 8, padding: 6,
              background: over === `${kind}:${s}` ? '#0969da0d' : 'rgba(127,127,127,.05)',
              minHeight: 80,
            },
          },
            h('div', { style: { ...flexRow, fontSize: 11, fontWeight: 600, color: stColor(s), marginBottom: 4 } },
              h('span', null, stText(s)),
              h('span', { style: { marginLeft: 'auto', opacity: .7 } }, counts[s] || 0),
            ),
            h('div', { style: { display: 'flex', flexDirection: 'column', gap: 5 } },
              list.filter((item) => item.status === s).map((item) => card(item, kind)),
            ),
          )),
        ),
      )
    }),
  )
}

/* ── 主视图 ──────────────────────────────────────────────────────── */
function TeamFlowView(props) {
  const api = props.remote && props.remote.teamflow
  const [state, setState] = React.useState({ runs: [], active: null, backlog: null, err: null })
  const [runId, setRunId] = React.useState(null)
  const [tab, setTab] = React.useState('pipeline')
  const [product, setProduct] = React.useState('')

  const refresh = React.useCallback(async () => {
    if (!api) { setState((s) => ({ ...s, err: 'remote 未就绪' })); return }
    try {
      const lr = await api.list()
      const id = runId || (lr.runs && lr.runs[0] && lr.runs[0].id)
      const snap = id ? await api.snapshot(id) : null
      const p = product || (snap && snap.options && snap.options.productRoot) || null
      const bo = await api.backlog(p)
      setState({ runs: (lr.runs || []).slice(0, 12), active: snap, backlog: bo, err: null })
      if (!product && p) setProduct(p)
    } catch (e) {
      setState((s) => ({ ...s, err: String((e && e.message) || e) }))
    }
  }, [runId, product, api])

  React.useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [refresh])

  const { runs, active, backlog, err } = state
  const total = (active && active.stages) ? active.stages.reduce((a, s) => a + (typeof s.tokens === 'number' ? s.tokens : 0), 0) : 0
  const needHuman = []
  if (backlog) {
    for (const item of [...(backlog.requirements || []), ...(backlog.tasks || []), ...(backlog.bugs || [])]) {
      if (item.humanIntervention || item.status === 'needs-human') needHuman.push(item)
    }
  }
  const activeRun = runs.find((r) => r.id === runId) || runs[0]
  const canResume = activeRun && (activeRun.status === 'interrupted' || activeRun.status === 'failed' || activeRun.status === 'cancelled')
  const onResume = async () => {
    if (!api || !activeRun) return
    try { await api.resume(activeRun.id, props.sessionId); refresh() }
    catch (e) { setState((s) => ({ ...s, err: String((e && e.message) || e) })) }
  }

  return h('div', { style: { fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif', fontSize: 13, color: '#1f2328', display: 'flex', flexDirection: 'column', gap: 8, padding: '2px 0' } },
    /* 顶部工具条 */
    h('div', { style: { ...flexRow, gap: 8 } },
      h('span', { style: { fontWeight: 700, fontSize: 14 } }, '🏭 团队工作台'),
      h('button', { onClick: refresh, style: btn }, '刷新'),
      h('span', { style: { fontSize: 11, color: '#6e7781', fontFamily: 'ui-monospace, monospace' } },
        backlog && backlog.persistence ? `${backlog.persistence.mode === 'fs' ? '📦 ' + (backlog.persistence.root || '') : '（内存态）'}` : ''),
    ),
    err ? h('div', { style: { color: '#cf222e', fontSize: 12, background: '#ffebe9', borderRadius: 6, padding: '6px 10px' } }, `连接宿主失败：${err}（确认已安装 dsh-plugin-teamflow 且 web 已重启）`) : null,

    /* 人工介入横幅 */
    needHuman.length > 0 ? h('div', { style: { background: '#fff1e5', border: '1px solid #9a670055', borderRadius: 8, padding: '8px 10px' } },
      h('div', { style: { ...flexRow, fontWeight: 600, color: '#9a6700' } },
        h('span', null, `⚠ ${needHuman.length} 项需人工介入`),
        needHuman.slice(0, 5).map((item) => h('span', { key: item.id, style: { fontSize: 11, fontFamily: 'ui-monospace, monospace' } }, item.id)),
      ),
      h('div', { style: { ...flexRow, marginTop: 4 } },
        needHuman.slice(0, 5).map((item) => {
          const kind = (backlog.requirements || []).some((r) => r.id === item.id) ? 'req'
            : (backlog.tasks || []).some((t) => t.id === item.id) ? 'task' : 'bug'
          const fin = kind === 'bug' ? 'verified' : kind === 'req' ? 'accepted' : 'accepted'
          return h('button', { key: item.id, onClick: async () => { await api.backlogUpdate(kind, item.id, fin, backlog.product, '人工处理'); refresh() }, style: { ...btn, background: '#1a7f37', color: '#fff', border: 'none' } },
            `处理 ${item.id}（${fin}）`)
        }),
      ),
    ) : null,

    /* 内部 tab：流水线 / Backlog */
    h('div', { style: { ...flexRow, gap: 4 } },
      h('button', { onClick: () => setTab('pipeline'), style: tabBtn(tab === 'pipeline') }, '🔄 流水线'),
      h('button', { onClick: () => setTab('board'), style: tabBtn(tab === 'board') }, '📋 Backlog 看板'),
      h('span', { style: { marginLeft: 'auto' } },
        activeRun ? h('span', { style: { fontSize: 12, color: activeRun.status === 'interrupted' ? '#cf222e' : '#57606a' } },
          `#${String(activeRun.id).slice(-8)} · ${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}`) : null,
        canResume ? h('button', {
          onClick: onResume,
          style: { ...btn, marginLeft: 8, background: '#cf222e', color: '#fff', border: 'none' },
        }, '↻ 从断点重跑') : null,
      ),
      total > 0 ? h('span', { style: { fontSize: 12, color: '#57606a', fontFamily: 'ui-monospace, monospace' } }, `∑ ${fmtTokens(total)} tok`) : null,
    ),
    h('div', { style: { ...flexRow, gap: 4, fontSize: 12 } },
      h('label', { style: { color: '#6e7781' } }, '产品：'),
      h('input', {
        value: product,
        onChange: (e) => setProduct(e.target.value.trim()),
        placeholder: 'products/tetris',
        style: { ...input, width: 160 },
        onKeyDown: (e) => { if (e.key === 'Enter') refresh() },
      }),
      h('label', { style: { color: '#6e7781' } }, '历史运行：'),
      runs.length ? runs.map((r) => h('button', {
        key: r.id,
        onClick: () => { setRunId(r.id) },
        style: {
          ...chipBtn, background: r.id === (runId || (runs[0] && runs[0].id)) ? '#0969da' : 'transparent',
          color: r.id === (runId || (runs[0] && runs[0].id)) ? '#fff' : '#57606a',
        },
      }, `#${String(r.id).slice(-6)}`)) : h('span', { style: { color: '#6e7781' } }, '（暂无）'),
    ),

    tab === 'pipeline' ? h(PipelinePanel, { active }) : h(BoardPanel, { backlog, api, onRefresh: refresh }),
  )
}

const btn = {
  font: 'inherit', fontSize: 12, padding: '3px 10px', borderRadius: 6, cursor: 'pointer',
  border: '1px solid rgba(31,35,40,.2)', background: '#fff',
}
const tabBtn = (on) => ({
  font: 'inherit', fontSize: 12, padding: '4px 12px', borderRadius: 6, cursor: 'pointer',
  border: on ? '1px solid #0969da' : '1px solid rgba(31,35,40,.2)',
  background: on ? '#0969da' : '#fff', color: on ? '#fff' : '#1f2328',
})
const chipBtn = { font: 'inherit', fontSize: 11, padding: '2px 8px', borderRadius: 999, cursor: 'pointer', border: '1px solid rgba(31,35,40,.2)' }
const input = { font: 'inherit', fontSize: 12, padding: '3px 8px', borderRadius: 6, border: '1px solid rgba(31,35,40,.2)' }

/** 注册 conversation.view tab「团队工作台」。 */
export async function apply(ctx) {
  await ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'teamflow',
    order: 20,
    label: '🏭 团队工作台',
    inject: (sessionId) => ({ sessionId, remote: ctx.remote }),
  }, TeamFlowView))
}
