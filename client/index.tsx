/**
 * dsh-plugin-teamflow — browser half.
 *
 * 团队研发流水线 Web 面板：注册 conversation Chat Node（仿 ui-workflow-run / ui-trajectory），
 * 展示流水线阶段看板 + backlog 摘要 + token 用量。
 *
 * 宿主数据交互走标准 client RPC：host 侧 harness.handle('teamflow/*')。
 * 浏览器侧通过 client runtime 的远程桥调用（注入 '@deepseek-ai/dsh-client-runtime' 后
 * 使用 ctx.api / remote 通道；具体桥接方式见 README「client 接入」一节）。
 *
 * 构建：本文件为 TSX 源码形态，发布前需用 tsdown 打包为 lib/client.js
 * （与 @deepseek-ai/dsh-client-ui-* 相同的构建管线）。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'

export const inject = ['slots', 'locale']

/** 调用宿主 teamflow RPC。TODO: 接入当前 client runtime 的远程桥（见 README）。 */
export function callHost(method: string, args?: unknown): Promise<any> {
  // 标准接入点：通过注入的 runtime 远程桥调用 host harness.handle(`teamflow/${method}`)。
  // 示例（按实际 runtime API 调整）：
  //   return ctx.api.invoke({ service: 'typertGateway', method: 'invoke', args: [...] })
  // 或使用 connection 提供的 bridge.call(method, args)。
  throw new Error(`callHost('${method}') 尚未接入 client 远程桥 — 见 plugins/dsh-plugin-teamflow/README.md`)
}

/** 面板组件：阶段看板 + backlog 摘要（结构复用动态版面板，样式内联）。 */
export function TeamFlowPanel(props: { sessionId: string }) {
  const { React } = window as any
  if (!React) return null
  const h = React.createElement
  const [snap, setSnap] = React.useState<{ runs: any[]; active: any; backlog: any } | null>(null)
  const [err, setErr] = React.useState<string | null>(null)
  const refresh = async () => {
    try {
      const runs = await callHost('list')
      const active = await callHost('snapshot', { runId: runs?.runs?.[0]?.id })
      const backlog = await callHost('backlog', { product: active?.options?.productRoot ?? undefined })
      setSnap({ runs: runs?.runs ?? [], active, backlog })
      setErr(null)
    } catch (e: any) {
      setErr(String(e?.message || e))
    }
  }
  React.useEffect(() => {
    refresh()
    const t = setInterval(refresh, 2000)
    return () => clearInterval(t)
  }, [])

  const st = (s: string) => ({ created: '立项', 'in-progress': '进行中', 'pending-acceptance': '待验收', accepted: '已验收', pending: '待办', running: '开发中', testable: '待测试', testing: '测试中', rework: '打回', 'needs-human': '需人工', open: '待认领', claimed: '处理中', fixed: '已修复待验', verified: '已关闭', reopened: '重开', done: '已完成', completed: '已完成', failed: '失败', cancelled: '已取消' }[s] ?? s)
  const rows: React.ReactNode[] = []
  if (snap?.active) {
    for (const stg of snap.active.stages ?? []) {
      rows.push(h('div', { key: stg.seq, style: { padding: '4px 0', borderBottom: '1px solid rgba(127,127,127,.15)' } },
        h('div', { style: { fontWeight: 600 } }, `${stg.phase} · ${stg.label}`),
        h('div', { style: { fontSize: 12, color: '#666' } },
          `状态 ${st(stg.status)}${typeof stg.tokens === 'number' ? ` · token ${stg.tokens}` : ''}${stg.childId ? ` · 会话 ${stg.childId}` : ''}`),
      ))
    }
  }
  const boRows: React.ReactNode[] = []
  const bo = snap?.backlog
  if (bo) {
    for (const r of (bo.requirements ?? []).slice(0, 5)) boRows.push(h('div', { key: r.id, style: { fontSize: 12, padding: '2px 0' } }, `${r.id} ${r.title} [${st(r.status)}]`))
    for (const b of (bo.bugs ?? []).filter((x: any) => x.status !== 'verified').slice(0, 5)) boRows.push(h('div', { key: b.id, style: { fontSize: 12, padding: '2px 0', color: '#c0392b' } }, `${b.id} ${b.severity} ${b.title} [${st(b.status)}]`))
  }
  return h('div', { style: { fontFamily: '-apple-system, "Segoe UI", "PingFang SC", sans-serif', fontSize: 13, padding: 8 } },
    h('div', { style: { fontWeight: 700, marginBottom: 6 } }, '🏭 团队研发流水线'),
    err ? h('div', { style: { color: '#cf222e', fontSize: 12 } }, `连接失败：${err}（client 远程桥未接入，见 README）`) : null,
    snap?.active ? h('div', { style: { marginBottom: 8 } }, rows) : h('div', { style: { color: '#666', fontSize: 12, marginBottom: 8 } }, '暂无运行中的流水线'),
    bo ? h('div', {},
      h('div', { style: { fontWeight: 600, margin: '6px 0 2px' } }, `📋 backlog · ${bo.product ?? 'default'}${bo.persistence?.mode === 'fs' ? '（已落盘 ' + bo.persistence.root + '）' : ''}`),
      boRows,
    ) : null,
    h('button', { onClick: refresh, style: { marginTop: 8, fontSize: 12 } }, '刷新'),
  )
}

/** 注册 conversation Chat Node（key: teamflow），在每条流水线相关消息下渲染面板。 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({
    name: 'conversation.chat.node',
    key: 'teamflow',
  }, TeamFlowPanel))
}
