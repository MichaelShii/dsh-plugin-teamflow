/**
 * dsh-plugin-teamflow — 全局面板 + 右栏 run 详情 tab（v0.1.8 ①）。
 *
 * 与 conversation.view tab（会话内工作台）的分工：
 * - 全局面板挂在**应用外壳**的 root slot 上：`sidebar.panellist`（侧边栏图标）+
 *   `main`（中央主区，keyed，**必须与 panellist 同 id**——宿主 `layout.selectPanel`
 *   对未注册的 main key 直接抛错）。它没有会话上下文，因此数据面按**产品线 key**
 *   寻址（`remote.products/productView/...`），跨会话可用。
 * - 右栏 run 详情 tab：tab 类型进 `ctx.sidebarRightTabs`，正文进 keyed seat
 *   `sidebar.right.pane.tab`；地址由 host 生成（`dsh-resource://teamflow/run/<产品线>/<runId>`），
 *   与产物预览同一条原则——client 不拼地址。右侧栏是 AppFrame 级 root slot，
 *   全局面板占着中央区时它依然挂载（唯一失败态是"没有挂载会话"，此时降级为面板内联详情）。
 */
import React from 'react'
import {
  T, h, MONO, SANS, flexRow, chip, FoldableText, stColor, stText,
  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, phaseNameOf, phaseIconOf,
  RUN_STATUS_TEXT, COLUMNS, KIND_TITLE, byRoleLine, stageUsageLine,
} from './shared.js'

/* ── 右栏 run tab 的类型标识（host 生成地址，client 只解析） ────────── */
export const RUN_TAB_ID = 'dsh-plugin-teamflow/run'
export const RUN_TAB_KIND = 'teamflow-run'
export const RUN_TAB_PATTERN = 'dsh-resource://teamflow/run/**'

/** 解析 host 生成的 run 地址 → { product, runId }（不合法 → null）。 */
export function parseRunAddress(address) {
  const m = /^dsh-resource:\/\/teamflow\/run\/([^/]+)\/([^/?#]+)$/.exec(String(address || ''))
  if (!m) return null
  try { return { product: decodeURIComponent(m[1]), runId: decodeURIComponent(m[2]) } } catch (e) { return null }
}

/** 右栏 tab 类型定义（类型本身；正文在 sidebar.right.pane.tab 的 keyed seat）。 */
export function runTabDefinition() {
  return {
    id: RUN_TAB_ID,
    kind: RUN_TAB_KIND,
    priority: 'extension',
    patterns: [RUN_TAB_PATTERN],
    title: (address) => {
      const p = parseRunAddress(address)
      return p ? `TeamFlow · ${p.runId.slice(0, 14)}` : 'TeamFlow Run'
    },
  }
}

/** Typert remote 信封解包（与会话内工作台同一约定）。
 * 空信封（`{ok:true}` 但没有 `value`）是**真实故障态**：host 方法返回了 `undefined` / 结果被丢弃——
 * 此时不能静默返回 undefined（调用方会把它再包成「未知错误」，丢掉定位信息），故显式报出原始信封。 */
function unwrap(res, what) {
  if (!res || !res.ok) {
    let detail = '未知错误'
    try { detail = (res && res.error && (res.error.message || res.error.code)) || JSON.stringify(res) || '未知错误' } catch (e) { /* 循环引用等 */ }
    try { console.warn('[teamflow] remote 调用失败', what, res) } catch (e) { /* ignore */ }
    throw new Error(`${what || 'remote'} 调用失败：${detail}`)
  }
  if (res.value === undefined) {
    try { console.warn('[teamflow] remote 返回空信封（ok 但无 value）', what, res) } catch (e) { /* ignore */ }
    let raw = ''
    try { raw = JSON.stringify(res) } catch (e) { raw = String(res) }
    throw new Error(`${what || 'remote'} 返回空结果（ok=true 但无 value；原始信封=${raw}）`)
  }
  return res.value
}

/* ── 侧边栏图标（官方 owner props：{ size, active }） ───────────────── */
/** 全局面板图标：三条泳道 + 节点（与工作台「流水线」语义一致），跟随选中态配色。 */
export function TeamflowPanelIcon({ size = 16, active = false }) {
  const c = active ? 'currentColor' : 'currentColor'
  return h('svg', {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: c, strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false',
  },
    h('rect', { x: 3, y: 4, width: 5.2, height: 4, rx: 1.2, opacity: active ? 1 : 0.85 }),
    h('rect', { x: 9.4, y: 10, width: 5.2, height: 4, rx: 1.2, opacity: active ? 1 : 0.85 }),
    h('rect', { x: 3, y: 16, width: 5.2, height: 4, rx: 1.2, opacity: active ? 1 : 0.85 }),
    h('path', { d: 'M8.4 6h3.3a1 1 0 0 1 1 1v3.4' }),
    h('path', { d: 'M8.4 18h3.3a1 1 0 0 0 1-1v-3.4' }),
    h('path', { d: 'M14.6 12h4.4' }),
  )
}

/* ── 小工具 ─────────────────────────────────────────────────────── */
const panelBtn = {
  font: 'inherit', fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 7, cursor: 'pointer',
  border: `1px solid ${T.border}`, background: T.layer1, color: T.text, whiteSpace: 'nowrap', lineHeight: '16px',
}
const brandBtn = { ...panelBtn, border: `1px solid color-mix(in srgb, ${T.brand} 40%, transparent)`, background: `color-mix(in srgb, ${T.brand} 12%, transparent)`, color: T.brand }
const sectionTitle = (text, extra?) => h('div', { style: { ...flexRow, justifyContent: 'space-between', margin: '14px 0 8px' } },
  h('div', { style: { fontSize: 12, fontWeight: 700, color: T.text, letterSpacing: '.02em' } }, text),
  extra || null)
const muted = (text, style = {}) => h('div', { style: { fontSize: 11, color: T.text2, lineHeight: 1.6, ...style } }, text)
const runUsageText = (u) => {
  if (!u || !(u.input || u.cacheRead || u.cacheWrite || u.output)) return '无 token 数据'
  const hit = hitRate(u)
  return `⇅${fmtTokens(u.input)} ⇅${fmtTokens(u.cacheRead)} ⬆${fmtTokens(u.output)}${hit !== null ? ` ·${hit}%` : ''} · ${u.calls} 次`
}

/* ── 密度控制（v0.1.8 ①：分栏 + 默认折叠） ──────────────────────
 * run 列表默认只渲染最近 RUN_PREVIEW 条（进行中/未完成的**无条件置顶**，不许被折叠掉）；
 * backlog 每组的终态卡片默认收起（计数仍显示），活动项与 needs-human 始终展开。 */
const RUN_PREVIEW = 8
const TERMINAL_STATUSES = ['accepted', 'closed', 'verified', 'cancelled']

/* ── 产品线导航（左栏） ─────────────────────────────────────────── */
function ProductRail({ products, current, onSelect, onRefresh, busy }) {
  return h('div', {
    style: {
      width: 236, flex: '0 0 236px', minHeight: 0, display: 'flex', flexDirection: 'column',
      borderRight: `1px solid ${T.border}`, background: `color-mix(in srgb, ${T.layer1} 40%, transparent)`,
    },
  },
    h('div', { style: { ...flexRow, justifyContent: 'space-between', padding: '10px 12px 8px' } },
      h('span', { style: { fontSize: 11.5, fontWeight: 700, color: T.text2 } }, `产品线 · ${products.length}`),
      h('button', { style: panelBtn, onClick: onRefresh, disabled: busy, title: '重新扫描 $DSH_HOME/teamflow' }, busy ? '刷新中' : '刷新')),
    h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 8px 12px' } },
      products.length === 0
        ? muted('还没有产品线。在某个工作区跑过一次流水线后，这里会出现对应产品线（$DSH_HOME/teamflow/<key>）。', { padding: '10px 4px' })
        : products.map((p) => {
          const on = p.key === current
          return h('div', {
            key: p.key,
            onClick: () => onSelect(p.key),
            title: p.path || p.key,
            style: {
              padding: '8px 10px', marginBottom: 6, borderRadius: 9, cursor: 'pointer',
              border: `1px solid ${on ? `color-mix(in srgb, ${T.brand} 45%, transparent)` : T.border}`,
              background: on ? `color-mix(in srgb, ${T.brand} 10%, ${T.layer1})` : 'transparent',
            },
          },
            h('div', { style: { ...flexRow, justifyContent: 'space-between' } },
              h('span', { style: { fontSize: 12, fontWeight: 600, color: T.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.title || p.key),
              p.activeRuns > 0 ? chip(`运行 ${p.activeRuns}`, T.brand, { dot: true }) : null),
            h('div', { style: { fontSize: 10, color: T.text2, fontFamily: MONO, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, p.key),
            h('div', { style: { ...flexRow, gap: 8, marginTop: 3, fontSize: 10, color: T.text2 } },
              h('span', null, `run ${p.totalRuns}`),
              p.updatedAt ? h('span', null, `更新 ${fmtTime(p.updatedAt)}`) : null),
            p.lastRequirement ? h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 3, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' } }, p.lastRequirement) : null,
            p.lastVerdict ? h('div', { style: { marginTop: 4 } }, chip(`验收 ${p.lastVerdict}`, stColor(p.lastVerdict === 'accepted' ? 'accepted' : p.lastVerdict))) : null,
          )
        })),
  )
}

/* ── run 列表 ───────────────────────────────────────────────────── */
function RunList({ runs, activeRunId, onOpenRun, onInlineRun }) {
  if (!runs.length) return muted('该产品线还没有 run 记录。', { padding: '2px 2px 8px' })
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
    runs.map((r) => {
      const on = r.id === activeRunId
      const active = r.status === 'running' || r.status === 'pending'
      return h('div', {
        key: r.id,
        style: {
          padding: '8px 11px', borderRadius: 9, border: `1px solid ${on ? `color-mix(in srgb, ${T.brand} 45%, transparent)` : T.border}`,
          borderLeft: `3px solid ${stColor(r.status)}`,
          background: on ? `color-mix(in srgb, ${T.brand} 8%, ${T.layer1})` : T.layer1,
          display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
        },
        onClick: () => onInlineRun(r),
      },
        h('div', { style: { flex: 1, minWidth: 0 } },
          h('div', { style: { ...flexRow, gap: 6 } },
            chip(RUN_STATUS_TEXT[r.status] || r.status, stColor(r.status), { dot: true }),
            r.mode ? chip(String(r.mode), T.text2) : null,
            h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2 } }, r.id),
            active ? h('span', { style: { fontSize: 10, color: T.brand } }, '进行中') : null),
          h('div', { style: { fontSize: 11.5, color: T.text, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, r.requirement || '(无需求描述)'),
          h('div', { style: { ...flexRow, gap: 10, marginTop: 3, fontSize: 10, color: T.text2, fontFamily: MONO } },
            h('span', null, `阶段 ${r.doneStages}/${r.stageCount}`),
            h('span', null, runUsageText(r.usage)),
            h('span', null, `${fmtTime(r.startedAt)}${r.endedAt ? ` → ${fmtTime(r.endedAt)}` : ''} ${fmtDur(r.startedAt, r.endedAt)}`))),
        h('button', {
          style: brandBtn,
          title: '跳到该 run 的发起会话，并在那个会话的右侧栏打开详情（右侧栏是会话级的：挂到无关会话上没有意义）',
          onClick: (e) => { e.stopPropagation(); onOpenRun(r) },
        }, '去会话右栏'),
      )
    }))
}

/* ── backlog 分组 ───────────────────────────────────────────────── */
function BacklogCard({ kind, item, onOpen }) {
  const color = stColor(item.status)
  return h('div', {
    onClick: () => onOpen(kind, item.id),
    style: {
      padding: '6px 9px', borderRadius: 8, border: `1px solid ${T.border}`, borderLeft: `3px solid ${color}`,
      background: T.layer1, cursor: 'pointer', minWidth: 0, boxSizing: 'border-box', maxWidth: '100%', overflow: 'hidden',
    },
  },
    h('div', { style: { ...flexRow, gap: 5, minWidth: 0 } },
      h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.id),
      chip(stText(item.status), color, { dot: true }),
      kind === 'bug' && item.severity ? chip(String(item.severity), stColor('rework')) : null),
    h('div', { style: { fontSize: 11.5, color: T.text, marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, item.title || item.id),
    (() => {
      const roles = kind === 'task' ? byRoleLine(item) : ''
      // 等宽数字串（⇅19.7k/127.0k·⬆4.7k·87%）不可断行 → 允许任意处换行，避免顶破卡片
      return roles ? h('div', { title: roles, style: { fontSize: 10, color: T.text2, fontFamily: MONO, marginTop: 3, minWidth: 0, overflowWrap: 'anywhere', wordBreak: 'break-word' } }, roles) : null
    })(),
    h('div', { style: { ...flexRow, gap: 6, marginTop: 3, fontSize: 10, color: T.text2 } },
      item.devAssign ? h('span', null, `dev ${item.devAssign}`) : null,
      item.qaAssign ? h('span', null, `qa ${item.qaAssign}`) : null,
      item.acceptBy ? h('span', null, `验收 ${item.acceptBy}`) : null,
      item.retries ? h('span', { style: { color: T.warn } }, `重试 ${item.retries}`) : null,
      item.humanIntervention ? h('span', { style: { color: T.error } }, '需人工') : null),
  )
}

function BacklogGroups({ backlog, onOpen }) {
  const [showDone, setShowDone] = React.useState({})   // kind → 是否展开终态卡片
  if (!backlog) return null
  const groups = [['req', backlog.requirements || []], ['task', (backlog.tasks || []).filter((t) => t.type !== 'subtask')], ['bug', backlog.bugs || []]]
  const total = groups.reduce((a, [, arr]) => a + arr.length, 0)
  if (!total) return muted('backlog 为空（该产品线还没有立项卡片）。', { padding: '2px 2px 8px' })
  return h('div', null,
    groups.map(([kind, list]) => {
      if (!list.length) return null
      // 终态且非人工介入 → 默认收起（needs-human 是终态之外的独立标记，必须一直可见）
      const done = list.filter((it) => TERMINAL_STATUSES.indexOf(it.status) !== -1 && !it.humanIntervention)
      const active = list.filter((it) => done.indexOf(it) === -1)
      const open = showDone[kind] === true
      const byStatus = {}
      for (const it of list) byStatus[it.status] = (byStatus[it.status] || 0) + 1
      return h('div', { key: kind, style: { marginBottom: 12 } },
        h('div', { style: { ...flexRow, gap: 6, marginBottom: 6, minWidth: 0 } },
          h('span', { style: { fontSize: 11.5, fontWeight: 700, color: T.text, flex: '0 0 auto' } }, `${KIND_TITLE[kind]} · ${list.length}`),
          h('span', { style: { fontSize: 10, color: T.text2, flex: '0 0 auto' } }, `活动 ${active.length}`),
          ...Object.keys(byStatus).map((s) => chip(`${stText(s)} ${byStatus[s]}`, stColor(s))),
          done.length
            ? h('button', {
              style: { ...panelBtn, marginLeft: 'auto', flex: '0 0 auto' },
              title: open ? '收起已完成/已关闭卡片' : '展开已完成/已关闭卡片',
              onClick: () => setShowDone((m) => ({ ...m, [kind]: !open })),
            }, open ? `收起已完成 ${done.length}` : `已完成 ${done.length} ▸`)
            : null),
        h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(228px, 1fr))', gap: 6 } },
          (open ? list : active).map((it) => h(BacklogCard, { key: it.id, kind, item: it, onOpen }))))
    }))
}

/* ── 条目详情（面板内联；右侧栏留给 run 详情与产物） ─────────────── */
function ItemDetailPane({ det, openArtifact, onClose }) {
  if (!det) return null
  const row = (k, v) => (v === null || v === undefined || v === '' ? null
    : h('div', { style: { ...flexRow, gap: 6, fontSize: 11 } },
      h('span', { style: { color: T.text2, flex: '0 0 auto' } }, k), h('span', { style: { color: T.text, minWidth: 0, wordBreak: 'break-word' } }, String(v))))
  return h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8, minHeight: 0 } },
    h('div', { style: { ...flexRow, justifyContent: 'space-between' } },
      h('div', { style: { ...flexRow, gap: 6 } },
        h('span', { style: { fontFamily: MONO, fontSize: 11, color: T.text2 } }, det.id),
        chip(stText(det.status), stColor(det.status), { dot: true }),
        h('span', { style: { fontSize: 10.5, color: T.text2 } }, KIND_TITLE[det.kind] || det.kind)),
      h('button', { style: panelBtn, onClick: onClose }, '关闭')),
    h('div', { style: { fontSize: 13, fontWeight: 600, color: T.text, lineHeight: 1.45 } }, det.title),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } },
      row('需求', det.reqId), row('负责人', det.owner), row('开发', det.devAssign), row('测试', det.qaAssign),
      row('验收', det.assignBy), row('重试', det.retries), row('任务夹', det.runDocs)),
    det.spec ? h('div', null, h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 3 } }, '规格'), h(FoldableText, { text: det.spec })) : null,
    det.summary ? h('div', null, h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 3 } }, '结论摘要'), h(FoldableText, { text: det.summary })) : null,
    det.artifacts && det.artifacts.length
      ? h('div', null,
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `任务夹产物 · ${det.artifacts.length}`),
        h('div', { style: { ...flexRow, gap: 5 } }, det.artifacts.map((a) => h('button', {
          key: a.name,
          style: brandBtn,
          title: `${a.address}\n（跳到产物所属会话后在该会话右侧栏打开）`,
          onClick: () => openArtifact && openArtifact(a.address, a.name, (det.runInfo && det.runInfo.ownerSession) || null),
        }, a.name))))
      : muted('该条目没有可预览的任务夹产物（或缺少会话上下文，无法生成文件地址）。'),
    det.subtasks && det.subtasks.length
      ? h('div', null,
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `子卡 · ${det.subtasks.length}`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, det.subtasks.map((s) => h('div', {
          key: s.id, style: { ...flexRow, gap: 6, fontSize: 11, padding: '4px 7px', borderRadius: 7, background: T.layer1, border: `1px solid ${T.border}` },
        },
          h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2 } }, s.id),
          chip(stText(s.status), stColor(s.status)),
          h('span', { style: { color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, s.title),
          s.failed ? chip('失败', T.error) : null))))
      : null,
    det.bugs && det.bugs.length
      ? h('div', null,
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `关联缺陷 · ${det.bugs.length}`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } }, det.bugs.map((b) => h('div', {
          key: b.id, style: { ...flexRow, gap: 6, fontSize: 11, padding: '4px 7px', borderRadius: 7, background: T.layer1, border: `1px solid ${T.border}` },
        },
          h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2 } }, b.id),
          b.severity ? chip(String(b.severity), T.warn) : null,
          chip(stText(b.status), stColor(b.status)),
          h('span', { style: { color: T.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, b.title)))))
      : null,
    det.events && det.events.length
      ? h('div', null,
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 4 } }, `流转时间线 · 最近 ${Math.min(det.events.length, 30)} 条`),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3, fontFamily: MONO, fontSize: 10, color: T.text2 } },
          det.events.slice(-30).map((e, i) => h('div', { key: i }, `${fmtTime(e.at)} ${e.from || '—'} → ${e.to || '—'}${e.by ? ` · ${e.by}` : ''}${e.reason ? ` · ${e.reason}` : ''}`))))
      : null,
  )
}

/* ── run 详情（右栏 tab 正文 + 面板内联降级共用） ────────────────── */
function RunDetailPane({ snap, product, api }) {
  const [sel, setSel] = React.useState(null)     // 选中的阶段详情
  const [err, setErr] = React.useState(null)
  React.useEffect(() => { setSel(null); setErr(null) }, [snap && snap.id])
  if (!snap) return muted('未找到该 run（可能已被清理，或地址已过期）。', { padding: 12 })
  const stages = snap.stages || []
  const totals = stages.reduce((a, s) => {
    const u = s.usage
    if (u) { a.input += u.input || 0; a.cacheRead += u.cacheRead || 0; a.cacheWrite += u.cacheWrite || 0; a.output += u.output || 0; a.calls += u.calls || 0 }
    return a
  }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 })
  const openStage = async (s) => {
    if (!api) return
    // 注意：api 适配器（productApi）**已解包**，这里直接用值——再 unwrap 一次会把载荷当信封（历史 bug）
    try { setSel(await api.stageDetail(snap.id, s.seq)); setErr(null) }
    catch (e) { setErr(String((e && e.message) || e)) }
  }
  const logs = (snap.logs || []).slice(-60)
  return h('div', { style: { padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflowY: 'auto' } },
    h('div', { style: { ...flexRow, gap: 6 } },
      chip(RUN_STATUS_TEXT[snap.status] || snap.status, stColor(snap.status), { dot: true }),
      snap.options && snap.options.mode ? chip(String(snap.options.mode), T.text2) : null,
      h('span', { style: { fontFamily: MONO, fontSize: 10.5, color: T.text2 } }, snap.id),
      product ? h('span', { style: { fontSize: 10, color: T.text2, fontFamily: MONO } }, product) : null),
    h('div', { style: { fontSize: 12, color: T.text, lineHeight: 1.5 } }, snap.requirement || '(无需求描述)'),
    h('div', { style: { ...flexRow, gap: 12, fontSize: 10.5, color: T.text2, fontFamily: MONO } },
      h('span', null, `${fmtTime(snap.startedAt)}${snap.endedAt ? ` → ${fmtTime(snap.endedAt)}` : ' → 进行中'} · ${fmtDur(snap.startedAt, snap.endedAt)}`),
      h('span', null, `阶段 ${stages.filter((s) => s.status === 'done').length}/${stages.length}`),
      h('span', null, `子代理 ${snap.agentsStarted || 0}`)),
    h('div', { style: { ...flexRow, gap: 10, fontSize: 10.5, color: T.text2, fontFamily: MONO, padding: '6px 8px', borderRadius: 8, background: `color-mix(in srgb, ${T.layer2} 60%, transparent)`, border: `1px solid ${T.border}` } },
      h('span', null, `输入(未命中) ${fmtTokens(totals.input) || '0'}`),
      h('span', null, `输入(命中) ${fmtTokens(totals.cacheRead) || '0'}`),
      h('span', null, `写缓存 ${fmtTokens(totals.cacheWrite) || '0'}`),
      h('span', null, `输出 ${fmtTokens(totals.output) || '0'}`),
      h('span', null, `${totals.calls} 次调用`),
      h('span', null, `合计 ${fmtTokens(totalTokens(totals)) || '0'}`)),
    sectionTitle(`阶段 · ${stages.length}`),
    h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
      stages.map((s) => {
        const on = sel && Number(sel.seq) === Number(s.seq)
        const color = stColor(s.status)
        return h('div', {
          key: s.seq,
          onClick: () => openStage(s),
          style: {
            padding: '6px 9px', borderRadius: 8, cursor: 'pointer', border: `1px solid ${on ? `color-mix(in srgb, ${T.brand} 45%, transparent)` : T.border}`,
            borderLeft: `3px solid ${color}`, background: on ? `color-mix(in srgb, ${T.brand} 7%, ${T.layer1})` : T.layer1,
          },
        },
          h('div', { style: { ...flexRow, gap: 6 } },
            h('span', { style: { fontFamily: MONO, fontSize: 10, color: T.text2 } }, `#${s.seq}`),
            h('span', null, phaseIconOf(s.phase)),
            h('span', { style: { fontSize: 11.5, color: T.text, fontWeight: 500 } }, s.label || phaseNameOf(s.phase)),
            chip(stText(s.status), color, { dot: true }),
            s.outcome && s.outcome !== 'completed' ? chip(String(s.outcome), stColor(s.outcome)) : null,
            h('span', { style: { marginLeft: 'auto', fontFamily: MONO, fontSize: 10, color: T.text2 } }, `${fmtTime(s.startedAt)}${s.endedAt ? ` · ${fmtDur(s.startedAt, s.endedAt)}` : ''}`)),
          h('div', { style: { ...flexRow, gap: 10, marginTop: 3, fontFamily: MONO, fontSize: 10, color: T.text2 } },
            h('span', null, stageUsageLine(s) || '无 token 数据'),
            s.childId ? h('span', { title: s.childId }, `子代理 ${String(s.childId).slice(0, 14)}`) : null),
          s.summary ? h('div', { style: { fontSize: 10.5, color: T.text2, marginTop: 3, lineHeight: 1.45 } }, String(s.summary).slice(0, 200)) : null)
      })),
    err ? muted(`阶段详情读取失败：${err}`, { color: T.error }) : null,
    sel ? h('div', { style: { padding: '9px 10px', borderRadius: 9, border: `1px solid ${T.border}`, background: T.layer2, display: 'flex', flexDirection: 'column', gap: 8 } },
      h('div', { style: { ...flexRow, justifyContent: 'space-between' } },
        h('div', { style: { ...flexRow, gap: 6 } },
          h('span', { style: { fontSize: 11.5, fontWeight: 700, color: T.text } }, `阶段 #${sel.seq} 详情`),
          chip(stText(sel.status), stColor(sel.status))),
        h('button', { style: panelBtn, onClick: () => setSel(null) }, '收起')),
      h('div', { style: { fontSize: 10.5, color: T.text2, fontFamily: MONO } }, `阶段 token：${stageUsageLine(sel) || '无'}`),
      sel.verifyEvidence
        ? h('div', null,
          h('div', { style: { fontSize: 11, color: T.success, marginBottom: 3 } }, '🔬 验证证据'),
          h('div', { style: { whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11, lineHeight: 1.6, color: T.text, background: `color-mix(in srgb, ${T.layer1} 70%, transparent)`, border: `1px solid ${T.border}`, borderRadius: 8, padding: '7px 9px', maxHeight: 200, overflowY: 'auto', fontFamily: MONO } }, sel.verifyEvidence))
        : muted('（缺失——契约未兑现，host 已记警告）', { color: T.warn }),
      sel.output ? h('div', null,
        h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 3 } }, '阶段产出'),
        h(FoldableText, { text: sel.output, charLimit: 400, lineLimit: 8, style: { fontFamily: MONO, fontSize: 11 } })) : null,
      sel.attempts && sel.attempts.length > 1
        ? h('div', null,
          h('div', { style: { fontSize: 11, color: T.text2, marginBottom: 3 } }, `同任务尝试 · ${sel.attempts.length}`),
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 3 } }, sel.attempts.map((a) => h('div', {
            key: a.seq, style: { ...flexRow, gap: 6, fontSize: 10.5, fontFamily: MONO, color: T.text2 },
          },
            h('span', null, `#${a.seq}`), chip(stText(a.status), stColor(a.status)), a.outcome ? h('span', null, a.outcome) : null,
            h('span', { style: { marginLeft: 'auto' } }, `${fmtTime(a.startedAt)} · ${fmtDur(a.startedAt, a.endedAt)}`)))))
        : null)
      : null,
    logs.length ? h('div', null,
      sectionTitle(`日志 · 最近 ${logs.length} 条`),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: 2, fontFamily: MONO, fontSize: 10, color: T.text2, maxHeight: 220, overflowY: 'auto' } },
        logs.map((l, i) => h('div', { key: i, style: { color: l.level === 'error' ? T.error : l.level === 'warn' ? T.warn : T.text2 } }, `${fmtTime(l.t)} [${l.level}] ${l.message}`)))) : null,
  )
}

/** 右栏 run 详情 tab 正文（地址来自宿主导航记录；host 只认自己的地址格式）。
 *
 * ⚠️ prop 名：宿主渲染器把 slot 的 `hooks: { tabInfo }` 绑成 **`useTabInfo`**（约定 `hooks.<name>` → `use<Name>`；
 * 官方 `ui-sidebar-documentpreview/TextPreview.tsx` 即用 `useTabInfo`）。2026-09-11 实锤：写成 `tabInfo`
 * 会恒 undefined → 地址取不到、错误也没设 → 永远停在「读取 run 详情中…」。
 */
export function RunDetailTab(props) {
  const readTab = props && (typeof props.useTabInfo === 'function' ? props.useTabInfo
    : typeof props.tabInfo === 'function' ? props.tabInfo : null)
  let info = null
  try { info = readTab ? readTab() : null } catch (e) { info = null }
  const tab = info && info.tab ? info.tab : null
  // 资源型 tab：导航地址是权威（`contentId` 兜底——资源 claim 下二者同为地址）
  const address = (tab && tab.navigation && tab.navigation.address) || (tab && tab.contentId) || null
  const parsed = parseRunAddress(address)
  const remote = props && props.remote
  const [snap, setSnap] = React.useState(null)
  const [err, setErr] = React.useState(null)
  const [nonce, setNonce] = React.useState(0)     // 手动重试
  const product = parsed ? parsed.product : null
  const runId = parsed ? parsed.runId : null
  const api = React.useMemo(() => (remote && product ? productApi(remote, product) : null), [remote, product])
  // 兜底自愈：地址还没就绪时（宿主提交 tab 记录前的空窗，钩子可能抛错且不订阅）主动重渲染若干次
  const [, bump] = React.useReducer((n) => n + 1, 0)
  React.useEffect(() => {
    if (address) return undefined
    let tries = 0
    const timer = setInterval(() => { tries += 1; bump(); if (tries >= 12) clearInterval(timer) }, 150)
    return () => clearInterval(timer)
  }, [address])
  React.useEffect(() => {
    let alive = true
    if (!runId) {
      setSnap(null)
      setErr(address ? `无法解析 run 地址：${address}` : (readTab ? '读取 tab 地址中…' : '宿主 tab 信息钩子不可用（useTabInfo 缺失）'))
      return undefined
    }
    if (!api) { setSnap(null); setErr('remote 不可用（插件未挂载或版本过旧）'); return undefined }
    api.runDetail(runId).then((v) => { if (alive) { setSnap(v); setErr(null) } }, (e) => { if (alive) setErr(String((e && e.message) || e)) })
    const timer = setInterval(() => {
      api.runDetail(runId).then((v) => {
        if (!alive) return
        setSnap(v)
        // 结束后停止轮询（避免对已完成 run 空转）
        if (!v || !(v.status === 'running' || v.status === 'pending')) clearInterval(timer)
      }, () => { /* 轮询失败静默（下一次自愈） */ })
    }, 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [api, runId, address, nonce, readTab])
  if (err && !snap) {
    // 「地址还没就绪」不是错误态：tab 刚挂载的那一帧宿主可能尚未提交记录，等下一次渲染即可
    const pending = !address && !!readTab
    return h('div', { style: { padding: 12, display: 'flex', flexDirection: 'column', gap: 8 } },
      muted(pending ? '读取 tab 地址中…' : err, { color: pending ? T.text2 : T.error }),
      pending ? null : h('button', { style: panelBtn, onClick: () => { setErr(null); setNonce((n) => n + 1) } }, '重试'))
  }
  if (!snap) return muted('读取 run 详情中…', { padding: 12 })
  return h(RunDetailPane, { snap, product, api })
}

/* ── 产品线 API 适配（按产品线 key 寻址的 remote 面） ─────────────── */
export function productApi(remote, product) {
  return {
    view: async () => unwrap(await remote.productView(product), 'productView'),
    runDetail: async (runId) => unwrap(await remote.productRunDetail(product, runId), 'productRunDetail'),
    stageDetail: async (runId, seq) => unwrap(await remote.productStageDetail(product, runId, seq), 'productStageDetail'),
    itemDetail: async (kind, id, sessionId) => unwrap(await remote.productItemDetail(product, kind, id, sessionId), 'productItemDetail'),
  }
}

/* ── 全局面板（中央主区） ───────────────────────────────────────── */
/** 全局面板 props：root scope 标准 props（useSessions 取当前会话）+ 插件注入（remote/打开回调）。 */
export function GlobalPanel(props) {
  const remote = props.remote
  const useSessions = props.useSessions
  const currentSessionId = (() => {
    try { return useSessions ? useSessions((s) => s.current) : undefined } catch (e) { return undefined }
  })()
  const [state, setState] = React.useState({ products: [], current: null, view: null, err: null, busy: false })
  const [detail, setDetail] = React.useState(null)        // 单一事实源：{ kind:'item'|'run', data, run? } —— 同一时刻只可能有一个详情
  const [hint, setHint] = React.useState(null)            // 面板内可见提示（不再只进 console）
  const [runsExpanded, setRunsExpanded] = React.useState(false)  // run 列表：默认折叠到 RUN_PREVIEW
  const [panelTab, setPanelTab] = React.useState('run')          // 主区标签页：run | backlog（一次只显示一个列表）

  /**
   * 右侧栏的**会话内容**宿主只在「对话被选中」时渲染（`RightbarRoot` 门控 `activePanelId === null`），
   * 而全局面板占着 `main` → seat 不存在 → `ctx.sidebarRight` 没有 binding（抛 `no session surface
   * is mounted`，2026-09-11 用户实测 tf-mtvrsakj-l2vj5u）。所以：先切回对话，再小步重试
   * （seat 在切换后的 effect 里才 `bindService`）；彻底失败才降级，并把原因显示在面板里。
   */
  const openInConversationRightbar = (address, label, fallback?) => {
    const attempt = (quiet) => !!(props.openResource && address && props.openResource(address, label, quiet))
    if (attempt(false)) return
    if (!address) {
      setHint(`${label}：host 未生成可打开的地址（可能缺少会话上下文）`)
      if (fallback) fallback()
      return
    }
    try { if (props.layout && typeof props.layout.selectPanel === 'function') props.layout.selectPanel(null) } catch (e) { /* ignore */ }
    let tries = 0
    const tick = () => {
      tries += 1
      if (attempt(true)) return
      if (tries < 12) { setTimeout(tick, 120); return }
      setHint(`右侧栏打开失败（宿主只在对话视图挂载它）：${label}${fallback ? '——已在本面板内联显示' : ''}`)
      if (fallback) fallback()
    }
    setTimeout(tick, 140)
  }

  /**
   * **跳到资源所属的会话，再在那个会话的右栏打开**（全局面板的正确语义）。
   * 右侧栏是会话级的：从全局面板看 tetris 的 run 却把 tab 挂到"用户当前所在会话"上没有意义
   * （用户 2026-09-11 提出）。所以先 `sessions.open(ownerSession)`，等当前会话真的切过去、
   * 且对话 seat 挂载 bind 之后再 openResource（两者都要等，故小步重试 + 就绪判据）。
   * @param target.ownerSession - 资源所属会话（run 的发起会话 / 产物地址里的会话）
   * @param target.address - host 生成的 dsh-resource 地址
   * @param target.label - 提示用的名字
   * @param target.fallback - 没有 ownerSession 或跳转失败时的降级（通常是面板内联详情）
   */
  const goOwnerSessionAndOpen = (target) => {
    const { ownerSession, address, label, fallback } = target || {}
    const sessions = props.sessions
    if (!ownerSession || !sessions || typeof sessions.open !== 'function') {
      // 老数据没有 ownerSession / 会话服务不可用 → 退回"在当前会话右栏打开"
      openInConversationRightbar(address, label, fallback)
      return
    }
    try { sessions.open(ownerSession) } catch (e) {
      setHint(`发起会话 ${String(ownerSession).slice(0, 8)}… 不在会话列表里（可能已被清理）——已在本面板展示详情`)
      if (fallback) fallback()
      return
    }
    try { if (props.layout && typeof props.layout.selectPanel === 'function') props.layout.selectPanel(null) } catch (e) { /* ignore */ }
    let tries = 0
    const tick = () => {
      tries += 1
      let nowCurrent = null
      try { nowCurrent = sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot().current : null } catch (e) { nowCurrent = null }
      // 等目标会话成为当前会话（最多等 6 次），再尝试打开右栏 tab
      const sessionReady = nowCurrent === ownerSession || tries >= 6
      if (sessionReady && props.openResource && address && props.openResource(address, label, tries < 6)) return
      if (tries < 14) { setTimeout(tick, 130); return }
      setHint(`已切到发起会话，但右栏没打开（${label}）——可在该会话里用「⇥ 右栏打开」重试`)
    }
    setTimeout(tick, 140)
  }

  const loadProducts = React.useCallback(async (preferKey?: string | null) => {
    if (!remote || typeof remote.products !== 'function') {
      setState((s) => ({ ...s, err: 'remote.products 不可用（插件未挂载或版本过旧）' }))
      return
    }
    setState((s) => ({ ...s, busy: true }))
    try {
      const v = unwrap(await remote.products(currentSessionId || null), 'products') || {}
      const list = v.products || []
      const key = preferKey || state.current || (v.current && list.some((p) => p.key === v.current) ? v.current : (list[0] && list[0].key) || null)
      setState({ products: list, current: key, view: null, err: null, busy: false })
    } catch (e) {
      setState((s) => ({ ...s, busy: false, err: String((e && e.message) || e) }))
    }
  }, [remote, currentSessionId, state.current])

  const loadView = React.useCallback(async (key, silent?: boolean) => {
    if (!remote || !key) return
    const api = productApi(remote, key)
    try {
      const v = await api.view()
      setState((s) => ({ ...s, view: v, err: null }))
    } catch (e) {
      if (!silent) setState((s) => ({ ...s, err: String((e && e.message) || e) }))
    }
  }, [remote])

  // 首次加载 + 当前会话变化时刷新产品线清单（保持用户已选产品线）
  React.useEffect(() => { loadProducts() }, [currentSessionId])
  // 选中产品线后拉取视图
  React.useEffect(() => { if (state.current) loadView(state.current) }, [state.current])
  // 有活跃 run 时轮询（8s；无活跃 run 不打扰）
  React.useEffect(() => {
    const runs = (state.view && state.view.runs) || []
    const anyActive = runs.some((r) => r.status === 'running' || r.status === 'pending')
    if (!anyActive || !state.current) return undefined
    const timer = setInterval(() => { loadView(state.current, true) }, 8000)
    return () => clearInterval(timer)
  }, [state.current, state.view, loadView])

  const api = state.current && remote ? productApi(remote, state.current) : null
  const openItem = async (kind, id) => {
    if (!api) return
    // api 适配器已解包（同上，勿二次 unwrap）
    try { setDetail({ kind: 'item', data: await api.itemDetail(kind, id, currentSessionId || null) }) }
    catch (e) { setState((s) => ({ ...s, err: String((e && e.message) || e) })) }
  }
  const showInline = async (r) => {
    if (!api) return
    try {
      const snap = await api.runDetail(r.id)
      // 覆盖同一个 detail（连带 run 元信息，供列表高亮/右栏入口用）——详情只有这一个状态源
      setDetail({ kind: 'run', data: snap, run: r })
    } catch (e) { setState((s) => ({ ...s, err: String((e && e.message) || e) })) }
  }
  const closeDetail = () => setDetail(null)
  const openRun = (r) => { goOwnerSessionAndOpen({ ownerSession: r.ownerSession, address: r.address, label: r.id, fallback: () => { void showInline(r) } }) }
  const openArtifactInPanel = (address, name, ownerSession) => {
    goOwnerSessionAndOpen({ ownerSession, address, label: name })
  }

  const view = state.view
  const product = view && view.product
  const runs = (view && view.runs) || []
  const detailOpen = !!detail
  // run 折叠：默认最近 RUN_PREVIEW 条，但**进行中/未完成的一律置顶显示**（别把正在跑的藏起来）
  const headRuns = runs.slice(0, RUN_PREVIEW)
  const headIds = new Set(headRuns.map((r) => r.id))
  const pinnedActive = runsExpanded ? [] : runs.filter((r) => (r.status === 'running' || r.status === 'pending') && !headIds.has(r.id))
  const visibleRuns = (runsExpanded || runs.length <= RUN_PREVIEW) ? runs : pinnedActive.concat(headRuns)
  const bl = view && view.backlog
  const backlogCount = bl ? ((bl.requirements || []).length + (bl.tasks || []).filter((t) => t.type !== 'subtask').length + (bl.bugs || []).length) : 0
  /** 主区标签按钮（选中态用品牌色下划线）。 */
  const panelTabBtn = (key, label) => h('button', {
    key,
    onClick: () => setPanelTab(key),
    style: {
      font: 'inherit', fontSize: 12, fontWeight: panelTab === key ? 700 : 500,
      padding: '6px 12px', marginBottom: -1, cursor: 'pointer', whiteSpace: 'nowrap',
      background: 'transparent', border: 'none',
      borderBottom: `2px solid ${panelTab === key ? T.brand : 'transparent'}`,
      color: panelTab === key ? T.text : T.text2,
    },
  }, label)
  return h('div', {
    style: { height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column', background: T.bg, color: T.text, fontFamily: SANS, fontSize: 12 },
  },
    h('div', { style: { ...flexRow, justifyContent: 'space-between', padding: '10px 14px', borderBottom: `1px solid ${T.border}` } },
      h('div', { style: { ...flexRow, gap: 8 } },
        h('span', { style: { fontSize: 13, fontWeight: 700 } }, '🏭 团队工作台'),
        h('span', { style: { fontSize: 11, color: T.text2 } }, '全局面板 · 按产品线'),
        currentSessionId ? h('span', { style: { fontSize: 10, color: T.text2, fontFamily: MONO } }, `当前会话 ${String(currentSessionId).slice(0, 8)}`) : h('span', { style: { fontSize: 10, color: T.text2 } }, '无当前会话')),
      h('div', { style: { ...flexRow, gap: 6 } },
        product ? h('button', { style: panelBtn, onClick: () => loadView(state.current) }, '刷新数据') : null,
        h('button', {
          style: panelBtn,
          title: '回到对话（再点侧边栏图标即可切回本面板）',
          onClick: () => { try { const layout = props.layout; if (layout && layout.selectPanel) layout.selectPanel(null) } catch (e) { /* ignore */ } },
        }, '回到对话'))),
    state.err ? h('div', { style: { padding: '6px 14px', fontSize: 11, color: T.error, borderBottom: `1px solid ${T.border}` } }, state.err) : null,
    hint ? h('div', { style: { ...flexRow, justifyContent: 'space-between', gap: 8, padding: '6px 14px', fontSize: 11, color: T.warn, borderBottom: `1px solid ${T.border}`, background: `color-mix(in srgb, ${T.warn} 8%, transparent)` } },
      h('span', null, hint),
      h('button', { style: panelBtn, onClick: () => setHint(null) }, '知道了')) : null,
    h('div', { style: { flex: 1, minHeight: 0, display: 'flex', position: 'relative' } },
      h(ProductRail, { products: state.products, current: state.current, busy: state.busy, onRefresh: () => loadProducts(state.current), onSelect: (k) => { closeDetail(); setRunsExpanded(false); setState((s) => ({ ...s, current: k, view: null })) } }),
      h('div', { style: { flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' } },
        !state.current
          ? h('div', { style: { padding: '12px 14px' } }, muted('选择左侧产品线查看 backlog 与 run（首次进入默认选最近更新的产品线）。'))
          : !view
            ? h('div', { style: { padding: '12px 14px' } }, muted('读取产品线数据中…'))
            : h(React.Fragment, null,
              /* 产品头：固定（不参与滚动） */
              h('div', { style: { ...flexRow, justifyContent: 'space-between', gap: 10, padding: '12px 14px 6px' } },
                h('div', { style: { minWidth: 0 } },
                  h('div', { style: { fontSize: 15, fontWeight: 700, color: T.text } }, product.title || product.key),
                  h('div', { style: { fontSize: 10.5, color: T.text2, fontFamily: MONO, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, product.path || product.key)),
                h('div', { style: { ...flexRow, gap: 6, flex: '0 0 auto' } },
                  chip(`run ${product.totalRuns}`, T.text2),
                  product.activeRuns > 0 ? chip(`活跃 ${product.activeRuns}`, T.brand, { dot: true }) : null,
                  product.lastVerdict ? chip(`验收 ${product.lastVerdict}`, stColor('accepted')) : null)),
              /* 标签页：一次只显示一个列表 —— 宽度全给它，不再多栏挤压（第三版布局） */
              h('div', { style: { display: 'flex', alignItems: 'flex-end', gap: 2, padding: '0 14px', borderBottom: `1px solid ${T.border}` } },
                panelTabBtn('run', `🚀 流水线 run · ${runs.length}`),
                panelTabBtn('backlog', `📋 Backlog · ${backlogCount}`),
                h('div', { style: { marginLeft: 'auto', ...flexRow, gap: 6, paddingBottom: 7 } },
                  panelTab === 'run' && !runsExpanded && pinnedActive.length > 0 ? chip(`已置顶进行中 ${pinnedActive.length}`, T.brand, { dot: true }) : null,
                  panelTab === 'run' && runs.length > RUN_PREVIEW
                    ? h('button', { style: panelBtn, onClick: () => setRunsExpanded((v) => !v) },
                      runsExpanded ? `只看最近 ${RUN_PREVIEW} 条` : `展开全部 ${runs.length} 条`)
                    : null)),
              /* 单一滚动区（自己滚；页面级滚动条不会出现） */
              h('div', { style: { flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'hidden', padding: '12px 14px 18px' } },
                panelTab === 'run'
                  ? h(React.Fragment, null,
                    h(RunList, { runs: visibleRuns, activeRunId: detail && detail.kind === 'run' && detail.run ? detail.run.id : null, onOpenRun: openRun, onInlineRun: showInline }),
                    muted('点一行看详情浮层；「对话右栏」= 切回对话并在右侧栏打开（与任务夹产物并排）', { fontSize: 10, marginTop: 8 }))
                  : h(React.Fragment, null,
                    muted('终态卡片默认收起；活动项与需人工项始终展开', { fontSize: 10, marginBottom: 8 }),
                    h(BacklogGroups, { backlog: view.backlog, onOpen: openItem }))),
            ),
      ),
      /* 详情：**覆盖式浮层**（绝对定位、自己滚动，不挤压列表宽度）——与会话内工作台的两个抽屉同款 */
      detailOpen
        ? h('div', {
          style: {
            position: 'absolute', top: 8, right: 12, bottom: 8, width: 440, zIndex: 9,
            overflowY: 'auto', overflowX: 'hidden', borderRadius: 12,
            border: `1px solid ${T.border}`, background: `color-mix(in srgb, ${T.layer1} 96%, transparent)`,
            backdropFilter: 'blur(12px)', boxShadow: '0 14px 44px rgba(0,0,0,.28)',
          },
        },
          detail && detail.kind === 'item'
            ? h(ItemDetailPane, { det: detail.data, openArtifact: openArtifactInPanel, onClose: closeDetail })
            : h('div', null,
              h('div', { style: { ...flexRow, justifyContent: 'space-between', padding: '10px 12px 0' } },
                h('span', { style: { fontSize: 11.5, fontWeight: 700, color: T.text } }, 'run 详情'),
                h('div', { style: { ...flexRow, gap: 6 } },
                  detail && detail.data && detail.data.address
                    ? h('button', {
                      style: brandBtn,
                      title: '跳到该 run 的发起会话，并在那个会话的右侧栏打开（与任务夹产物并排看）',
                      onClick: () => goOwnerSessionAndOpen({
                        ownerSession: detail.data.ownerSession,
                        address: detail.data.address,
                        label: detail.data.id,
                      }),
                    }, '去发起会话')
                    : null,
                  h('button', { style: panelBtn, onClick: closeDetail }, '关闭'))),
              h(RunDetailPane, { snap: detail && detail.data, product: state.current, api })))
        : null,
    ),
  )
}
