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
function stageTokenNum(s) {
  return typeof s.costTokens === 'number' ? s.costTokens : (typeof s.tokens === 'number' ? s.tokens : null)
}
function usageDetail(s) {
  const k = (n) => (n === null || n === undefined ? '—' : fmtTokens(n))
  if (s.usage) {
    const u = s.usage
    return `累计 in ${k(u.input)} / cacheRead ${k(u.cacheRead)} / out ${k(u.output)} · ${u.calls} 次调用 · 上下文压力 ${k(s.tokens ?? null)}`
  }
  return s.tokens != null ? `上下文压力 ${fmtTokens(s.tokens)}（无 usage 明细）` : ''
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
  const total = (active.stages || []).reduce((a, s) => a + (stageTokenNum(s) || 0), 0)
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
              (stageTokenNum(s) !== null) ? h('span', { title: usageDetail(s), style: { fontFamily: MONO, fontVariantNumeric: 'tabular-nums', marginLeft: 'auto' } }, `${fmtTokens(stageTokenNum(s))} tok`) : null,
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
function BoardPanel({ backlog, api, onRefresh }) {
  const [drag, setDrag] = React.useState(null)
  const [over, setOver] = React.useState(null)
  if (!backlog) return h('div', { style: { color: T.text2, fontSize: 13, padding: '28px 20px', textAlign: 'center' } },
    h('div', { style: { fontSize: 28, marginBottom: 8 } }, '📋'),
    'backlog 为空（还没有流水线运行过）')

  const move = async (kind, id, to) => {
    try { await api.backlogUpdate(kind, id, to, backlog.product, '看板拖拽流转') } catch (e) { /* 面板吞错，轮询自愈 */ }
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
  )

  const groups = [
    { kind: 'req', list: backlog.requirements || [] },
    { kind: 'task', list: backlog.tasks || [] },
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

/** teamflow 服务实例的调用面（$mount 后由 ctx.get 取得，方法返回 RPC 信封）。 */
interface TeamflowRemote {
  list(): Promise<RpcEnvelope>
  snapshot(runId?: string | null): Promise<RpcEnvelope>
  backlog(product?: string | null): Promise<RpcEnvelope>
  backlogUpdate(kind: string, id: string, to: string, product?: string | null, reason?: string): Promise<RpcEnvelope>
  resume(runId: string, sessionId: string): Promise<RpcEnvelope>
}

interface TeamFlowViewProps {
  sessionId: string
  remote: unknown
}

function TeamFlowView(props: TeamFlowViewProps) {
  const api = props.remote as TeamflowRemote // $mount 后的 teamflow 服务实例（ctx.get 取得，普通对象）
  const [state, setState] = React.useState({ runs: [], active: null, backlog: null, err: null })
  const [runId, setRunId] = React.useState(null)
  const [tab, setTab] = React.useState('pipeline')
  const [product, setProduct] = React.useState('')
  const [busy, setBusy] = React.useState(false)

  const refresh = React.useCallback(async () => {
    if (!api) { setState((s) => ({ ...s, err: 'remote 未就绪' })); return }
    try {
      const lr = unwrap(await api.list(), 'list') as { runs?: Array<Record<string, unknown>> }
      const runsList = (lr && lr.runs) || []
      const id = runId || (runsList[0] && (runsList[0].id as string | undefined))
      const snapWrap = id ? await api.snapshot(id) : null
      const snap = snapWrap ? (unwrap(snapWrap, 'snapshot') as { options?: { productRoot?: string | null } } | null) : null
      const p = product || (snap && snap.options && snap.options.productRoot) || null
      const bo = unwrap(await api.backlog(p), 'backlog') as Record<string, unknown>
      setState({ runs: (runsList || []).slice(0, 12), active: snap, backlog: bo, err: null })
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
  const total = (active && active.stages) ? active.stages.reduce((a, s) => a + (stageTokenNum(s) || 0), 0) : 0
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
  const input = { font: 'inherit', fontSize: 12, padding: '4px 9px', borderRadius: 8, border: `1px solid ${T.border2}`, background: T.layer1, color: T.text, outline: 'none' }

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
          onClick: async () => { await api.backlogUpdate(kind, item.id, fin, backlog.product, '人工处理'); refresh() },
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
        total > 0 ? h('span', { style: { fontSize: 11.5, fontFamily: MONO, color: T.text2, cursor: 'help' }, title: '累计计费当量（cacheRead ×0.1 折算，优先统计；悬浮阶段卡片看明细）' }, `∑ ${fmtTokens(total)} tok`) : null,
      ),
    ),

    /* 筛选条 */
    h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' } },
      h('label', { style: { color: T.text2, display: 'flex', alignItems: 'center', gap: 6 } },
        '产品',
        h('input', {
          value: product,
          onChange: (e) => setProduct(e.target.value.trim()),
          placeholder: 'products/tetris',
          style: { ...input, width: 160 },
          onKeyDown: (e) => { if (e.key === 'Enter') refresh() },
        }),
      ),
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 5 } },
        h('span', { style: { color: T.text2 } }, '历史'),
        runs.length ? runs.map((r) => {
          const sel = r.id === (runId || (runs[0] && runs[0].id))
          return h('button', { key: r.id, onClick: () => setRunId(r.id), style: chipBtn(sel), title: r.requirement },
            `#${String(r.id).slice(-6)}`)
        }) : h('span', { style: { color: T.text2, fontSize: 11.5 } }, '（暂无）'),
      ),
    ),

    tab === 'pipeline' ? h(PipelinePanel, { active }) : h(BoardPanel, { backlog, api, onRefresh: refresh }),
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

/** 注册 conversation.view tab「团队工作台」。 */
export async function apply(ctx) {
  await ctx.remote.$mount(TEAMFLOW_REMOTE_CONTRIBUTION)
  // $mount 完成后命名空间服务已在全局注册：ctx.get 直接取实例（不经 ctx 代理的
  // 注入检查），组件通过 slot inject 拿到的是普通对象，方法访问不触发 guard。
  const teamflow = ctx.get('remote.teamflow')
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'teamflow',
    order: 20,
    label: '🏭 团队工作台',
    inject: (sessionId) => ({ sessionId, remote: teamflow }),
  }, TeamFlowView))
}
