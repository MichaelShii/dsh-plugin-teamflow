/**
 * dsh-plugin-teamflow — 「有新版本 / 升级」这套 UI 的**唯一实现**（ADR-0012）。
 *
 * 为什么不放进 `shared.tsx`：那边的约定是「**只放无状态纯展示件**，不放任何 Remote 调用」，
 * 而这里既要探测（读）也要升级（写）。
 *
 * 三处落点共用这一份 —— 会话内工作台提示条、全局面板头部、宿主插件页槽位贡献。
 * ⇒ **不许在调用方各写一套**：「两步确认」的知情语义、以及「按 host 分型结论渲染失败」的规则只在这里。
 */
import React from 'react'
import { T, MONO, h, t } from './shared.js'

/** teamflow Remote 的**最小结构面**：只声明这里用到的三个方法，避免依赖 index.tsx 的完整接口。 */
export interface UpdateApi {
  updateStatus?: (force?: boolean) => Promise<unknown>
  skipUpdateVersion?: (version?: string) => Promise<unknown>
  upgradeSelf?: (version?: string) => Promise<unknown>
}

/** 解 Typert RPC 信封（`{ok, value}` / `{ok,error}`）。失败抛错，与 index.tsx 的 `unwrap` 同语义。 */
function unwrapRpc(res: unknown, what: string): any {
  const r = res as { ok?: boolean; value?: unknown; error?: { code?: string; message?: string } } | null | undefined
  if (!r || !r.ok) {
    throw new Error(t('common.remoteCallFailed', { what, detail: (r && r.error && (r.error.message || r.error.code)) || t('common.unknownError') }))
  }
  return r.value
}

/**
 * 版本状态。挂载时**自动探一次**（`force=false`：吃 24h 缓存，通常不联网）；
 * 返回的第三个元素是**强制重查**（`force=true` 绕过缓存）——「检查更新」按钮必须用它，
 * 否则点两次都只是重读同一份缓存、用户会觉得按钮坏了。
 */
export function useUpdateStatus(api: unknown): [any, (v: any) => void, () => Promise<any>] {
  const [st, setSt] = React.useState<any>(null)
  const probe = React.useCallback((force: boolean) => {
    const a = api as UpdateApi | null
    if (!a || typeof a.updateStatus !== 'function') return Promise.resolve(null)
    return Promise.resolve()
      .then(() => a.updateStatus(force))
      .then((r) => { const out = unwrapRpc(r, 'updateStatus'); setSt(out); return out })
      .catch(() => null) // 探测失败不打扰用户：没有提示条＝「不知道」
  }, [api])
  React.useEffect(() => { probe(false) }, [probe])
  return [st, setSt, () => probe(true)]
}

/**
 * 能不能给「一键升级」：**只对 registry 装法**（ADR-0012，10-12 真机踩到）。
 *
 * `upgradeSelf` 用的是 registry spec ⇒ 对 `file:` 本地链接 / git / tarball 的安装，一键会把依赖
 * **静默换成 registry 版本**；那种情况只给可复制的命令。
 *
 * ⚠️ host 侧 `upgradeGate` 里有**同一维**判据——这里是「早一步不显示按钮」，
 * 两层都要：UI 层是为了不给用户一个坏选项，host 层是为了不依赖 UI 自律。
 */
export function canOneClick(st: any): boolean {
  return !!st && st.outdated === true && st.sourceKind === 'registry'
}

/**
 * 「按钮内文字不得竖排」的两条 CSS（用户 2026-10-12 实测：「已复制」被挤成一列三个字）。
 *
 * 这些按钮常和**可伸缩的 `<code>`**（`flex: 1 1 auto; minWidth: 0`）同行：默认 `flex-shrink: 1`
 * ＋ 按钮继承 `white-space: normal` ⇒ 一旦被挤窄就逐字换行。`nowrap` 保证不换行，
 * `flexShrink: 0` 保证不参与收缩（否则 nowrap 只是把字顶出盒子）。
 *
 * 单独导出是因为**按钮样式源不止一处**（浮层/面板用 `updBtnStyle`，工作台提示条用 `chipBtn`），
 * 但「不竖排」这条教训**只能留一份**，否则改一处忘一处。
 */
export const NO_WRAP = { whiteSpace: 'nowrap' as const, flexShrink: 0 }

/** 「升级 / 复制」类小按钮的样式（模块级，供本文件与调用方共用）。 */
export const updBtnStyle = () => ({
  font: 'inherit', fontSize: 11, padding: '2px 10px', borderRadius: 999, cursor: 'pointer',
  border: `1px solid ${T.border}`, background: 'transparent', color: T.text2, fontFamily: MONO,
  ...NO_WRAP,
})


/**
 * 「不能一键」的**紧凑提示 + 可停留悬浮层**。
 *
 * 为什么不是原生 `title`（用户 2026-10-12 反馈）：`title` **不能被点、鼠标一移开就消失**，
 * 于是既放不了「一键复制」按钮，用户也没法把鼠标移进去操作。这里自己做浮层：
 * 触发件与浮层**同属一个容器**，`onMouseEnter/onMouseLeave` 挂在容器上 ⇒ 鼠标从 ⚠ 移到浮层里
 * **不会消失**（浮层本身就在容器盒子内），并带 `tabIndex` + `onFocus/onBlur` 让键盘也能开。
 *
 * ⚠️ 浮层内容**必须自带命令**：文案里说「改用命令升级」，而面板头部 / 宿主插件页原本**根本没有命令**
 * ——话指向空气（用户同日第二条反馈）。所以 `command` 有值就摊出来 + 带复制按钮；没有就说明原因。
 *
 * `label` 由调用方给：面板头部没有别的版本文案 ⇒ 传 `⚠ 0.2.7`；提示条 / 插件页旁边已经有
 * 「有新版本 x.y.z」⇒ 只传默认的 `⚠`，避免同一句版本号出现两遍。
 */
export function UpdateHint({ label = '⚠', command = null }: { label?: string; command?: string | null }) {
  const [open, setOpen] = React.useState(false)
  const [copied, setCopied] = React.useState<'ok' | 'fail' | null>(null)
  const timer = React.useRef<any>(null)
  const cmd = command ? String(command) : ''

  /** 打开：清掉待关闭的定时器（从浮层挪回触发件时不该被关掉）。 */
  const openNow = () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    setOpen(true)
  }
  /** 关闭**留 240ms 余量**：鼠标在浮层边缘/间隙抖一下就立刻关，等于浮层不可用。
   *  余量期间重新进入（`openNow`）会取消它。 */
  const closeSoon = () => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { setOpen(false); setCopied(null); timer.current = null }, 240)
  }
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const copy = () => {
    if (!cmd) { setCopied('fail'); return }
    const nav = typeof navigator === 'undefined' ? null : navigator
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(cmd).then(() => setCopied('ok')).catch(() => setCopied('fail'))
      return
    }
    setCopied('fail')
  }

  return h('span', {
    'data-teamflow-update-hint': '',
    style: { position: 'relative', display: 'inline-flex', alignItems: 'center' },
    onMouseEnter: openNow,
    onMouseLeave: closeSoon,
  },
  h('span', {
    tabIndex: 0,
    onFocus: openNow,
    onBlur: closeSoon,
    style: { fontSize: 11, color: T.warn, cursor: 'help', fontFamily: MONO, whiteSpace: 'nowrap' },
  }, label),
  open ? h('span', {
    /* ⚠️ 外层只负责定位于「把 6px 间隙变成浮层自己的区域」——用 **padding 而不是 margin**。
         用 margin 的话，那道 6px 既不属于触发件也不属于浮层 ⇒ 鼠标往下走时已经离开容器，
         `mouseleave` 立刻触发，**浮层在鼠标够到它之前就关了**（用户 2026-10-12 实测：
         「一往下面移动就消失了」）。padding 让间隙归浮层所有，悬停链不断。 */
    style: { position: 'absolute', top: '100%', right: 0, paddingTop: 6, zIndex: 40 },
  },
  h('span', {
    'data-teamflow-update-pop': '',
    style: {
      display: 'block', width: 360, maxWidth: '90vw', padding: '8px 10px', borderRadius: 8, textAlign: 'left',
      background: T.layer2, border: `1px solid ${T.border2 || T.border}`, color: T.text,
      fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'normal',
    },
  },
  h('div', null, t('update.notRegistry')),
  cmd
    ? h('div', { style: { marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 } },
      h('code', {
        /* 换行而不是省略号：这是**给用户抄的命令**，被 `…` 截掉等于「看不见自己会复制到什么」。
                 浮层不怕多占一行（工具条才怕）。`break-all` 让长包名也能断。 */
        style: { flex: '1 1 auto', minWidth: 0, fontFamily: MONO, color: T.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-all' },
      }, cmd),
      h('button', { style: updBtnStyle(), onClick: copy }, copied === 'ok' ? t('update.copied') : t('update.copy')))
    : h('div', { style: { marginTop: 6, color: T.warn } }, t('update.envUnknown')),
  copied === 'fail' ? h('div', { style: { marginTop: 4, color: T.warn } }, t('update.copyFailed')) : null,
  )) : null,
  )
}

/**
 * 「升级到 vX.Y.Z」（ADR-0012 D2）。**刻意做成两步**：点一次只展开确认行，把将要发生的事
 * 摊开（在**当前 profile** 执行 pnpm 安装、改动依赖、装完要重启），再点「确认升级」才真调 host。
 *
 * 为什么不做成一键直装：这条服务路径**绕过了宿主 `plugin_manager` 工具层的审批门槛**
 * （审批写在宿主的 `tools.ts` 里，不在服务里）⇒ 知情责任落在我方，一键直装等于把宿主替用户
 * 把的那道关也一并拿掉。ADR-0012 D2 第 1 条硬要求。
 *
 * 结果一律按 host 的**分型结论**渲染，**不把不同失败糊成一句「升级失败」**：
 * 有 run 在跑 / 没有插件管理服务 / 安装脚本待批准 是完全不同的三件事，可行动性也不同。
 */
export function UpgradeButton({ api, latest }: { api: UpdateApi | null; latest: unknown }) {
  const [phase, setPhase] = React.useState('idle')
  const [res, setRes] = React.useState<Record<string, unknown> | null>(null)
  const run = () => {
    setPhase('busy')
    Promise.resolve()
      .then(() => (api && typeof api.upgradeSelf === 'function' ? api.upgradeSelf(String(latest)) : null))
      .then((r) => {
        const out = r ? (unwrapRpc(r, 'upgradeSelf') as Record<string, unknown> | null) : null
        setRes(out)
        setPhase(out && out.ok === true ? 'done' : 'error')
      })
      .catch((e) => { setRes({ error: String((e && e.message) || e) }); setPhase('error') })
  }
  if (phase === 'busy') return h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('update.upgrading'))
  if (phase === 'done') return h('span', { style: { fontSize: 11.5, color: T.success } }, t('update.done', { version: String((res && res.installedVersion) || latest) }))
  if (phase === 'error') return h('span', { style: { fontSize: 11.5, color: T.warn } }, upgradeErrorText(res, latest))
  if (phase === 'confirm') {
    return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
      h('span', { style: { fontSize: 11.5, color: T.text2 } }, t('update.confirmHint', { version: String(latest) })),
      h('button', { style: updBtnStyle(), onClick: run }, t('update.confirmYes')),
      h('button', { style: updBtnStyle(), onClick: () => setPhase('idle') }, t('update.confirmNo')),
    )
  }
  return h('button', { style: updBtnStyle(), onClick: () => setPhase('confirm') }, t('update.upgrade', { version: String(latest) }))
}

/** 把 host 的分型结果翻成人话；**不认识的原因原样带出**（不吞、不美化）。 */
export function upgradeErrorText(res: Record<string, unknown> | null, latest: unknown) {
  const err = String((res && res.error) || 'unknown')
  if (err === 'run-in-progress') return t('update.busy', { n: String((res && res.activeRuns) || 1) })
  if (err === 'plugin-manager-unavailable') return t('update.noManager')
  if (err === 'not-registry-install') return t('update.notRegistry')
  const pending = res && res.pendingBuilds
  if (Array.isArray(pending) && pending.length > 0) return t('update.pendingBuilds', { names: pending.join(', ') })
  const installed = res && res.installedVersion
  if (typeof installed === 'string' && installed !== String(latest)) return t('update.doneOther', { installed, version: String(latest) })
  return t('update.failed', { reason: err })
}
