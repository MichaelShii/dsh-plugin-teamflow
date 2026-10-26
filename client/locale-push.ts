/**
 * 客户端语言上报器（纯逻辑，**可测**：注入 push/schedule/cancel，不碰定时器与 RPC）。
 *
 * 由来（2026-10-16 实锤 run tf-mvajlsll-roujyi / tf-mvakwjza-v2rt4w）：
 * 宿主 12:17 重启后，两个 run 的 `journal.locale` 都是 `en` —— 中文环境下**产物与日志全英文**，
 * 而且屏幕中英混排（客户端词典按 zh 渲染静态词，run 快照按 en 生成模型内容）。
 *
 * 链路事实（已读码确认）：
 * - `@deepseek-ai/dsh-client-locale` 是**纯客户端**插件（`dsh.client` / `platform: web`，**无 host face**）
 *   ⇒ 宿主侧「用户显式语言设置」那条通路在本组合里**恒为空**；
 * - ⇒ 宿主拿到语言的**唯一来源就是客户端推送**（`teamflow/setLocale`）；
 * - 而推送原先「只在挂载时发一次 + 语言变化时发一次」，失败又被 `catch {}` **静默吞掉**
 *   ⇒ 宿主重启后若挂载时 RPC 尚未就绪（或页面根本没重新挂载），宿主就**永久**停在 en 兜底。
 *   （旁证：`deploy.mjs` 同步会让客户端插件重载 ⇒ 顺带重推一次 ⇒ 与「昨晚 zh、今天 en」的时序吻合。）
 *
 * 语义（每条都有测试）：
 * - **成功即停**：`push` 同步返回且 `ok !== false`、或返回的 promise resolve ⇒ 不再重排；
 * - **失败才重排**：抛错 / promise reject / `ok === false` ⇒ 按固定间隔重试；
 * - **有界**：最多 `maxAttempts` 次（无界重试 = 定时器泄漏）；
 * - **语言变化重置**：新的 `send()` 清掉待发定时器并从第 1 次重新计；
 * - **dispose 后彻底安静**：清定时器，回调即使被外部触发也不再发；
 * - **值没就绪也算「失败」**（2026-10-26）：取到空/非法值 ⇒ 排重试（getter 每次**重新取**），
 *   绝不静默放弃 —— 旧实现把「值还没就绪」当「无事可做」直接 return，于是挂载瞬间
 *   `getSnapshot()` 为空时**一次都不推**，宿主永久停在 en 兜底（整轮产物英文 + 中英混排）。
 */
export const LOCALE_PUSH_RETRY_MS = 2000
export const LOCALE_PUSH_MAX_ATTEMPTS = 8

/** 第 `attempt` 次尝试失败后是否还应重试（attempt 从 1 起算；非法值一律不重试）。 */
export function shouldRetryLocalePush(attempt: unknown, maxAttempts: number = LOCALE_PUSH_MAX_ATTEMPTS): boolean {
  const n = typeof attempt === 'number' && Number.isFinite(attempt) ? attempt : 0
  const cap = typeof maxAttempts === 'number' && Number.isFinite(maxAttempts) ? maxAttempts : 0
  return n > 0 && n < cap
}

export interface LocalePushDeps {
  /** 真正发出上报：可抛错、可返回 promise、可返回 `{ ok: false }`。 */
  push: (locale: string) => unknown
  /** 排一次重试（注入以便测试；生产传 setTimeout）。 */
  schedule: (run: () => void, ms: number) => unknown
  /** 取消已排的重试（生产传 clearTimeout）。 */
  cancel?: (handle: unknown) => void
  retryMs?: number
  maxAttempts?: number
}

export interface LocalePusher {
  /**
   * 上报一次语言：重置计数与待发定时器（语言变化走这条）。
   *
   * `locale` 可以是**值**，也可以是 **getter** —— getter 会在每次尝试时**重新取**，
   * 用于「挂载瞬间语言服务还没就绪」的情形；取到空/非法时排重试而不是放弃。
   */
  send: (locale: unknown | (() => unknown)) => void
  /** 卸载：清掉待发定时器并让后续回调失效。 */
  dispose: () => void
}

export function createLocalePusher(deps: LocalePushDeps): LocalePusher {
  const retryMs = typeof deps.retryMs === 'number' ? deps.retryMs : LOCALE_PUSH_RETRY_MS
  const maxAttempts = typeof deps.maxAttempts === 'number' ? deps.maxAttempts : LOCALE_PUSH_MAX_ATTEMPTS
  let timer: unknown = null
  let attempts = 0
  let alive = true
  /** 世代号（只增）：每次 `send` 开新的一轮。⚠️ 只用 `attempts` 判「这个回调还属于当前轮」是不够的——
   *  重置后计数会与旧轮**重合**，旧回调于是被误认成本轮的（测试 ⑦ 实测：切语言后多烧 1 次）。 */
  let generation = 0

  const clear = (): void => {
    if (timer !== null && typeof deps.cancel === 'function') deps.cancel(timer)
    timer = null
  }

  /** 当前轮的语言来源：**值或 getter**（getter 在每次尝试时重新取 —— 挂载瞬间可能还没就绪）。 */
  let source: unknown = null
  const readSource = (): unknown => {
    try { return typeof source === 'function' ? (source as () => unknown)() : source } catch (e) { return null }
  }
  const send = (input: unknown): void => {
    if (!alive) return
    generation += 1
    attempts = 0
    clear()
    source = input
    attempt(generation)
  }

  function attempt(gen: number): void {
    attempts += 1
    const retry = (): void => {
      if (!alive || gen !== generation) return // 期间又被 send 过 ⇒ 那一轮负责，本轮回调作废
      if (!shouldRetryLocalePush(attempts, maxAttempts)) return
      clear()
      timer = deps.schedule(() => {
        timer = null
        // ⚠️ 触发时**再判一次**：`cancel` 未必生效（宿主/浏览器时序、双重排期），
        // 而 dispose 或切语言之后任何一次补发都是错的（测试 ⑧ 实测：只在排期时判 ⇒ dispose 后仍会发）。
        if (!alive || gen !== generation) return
        if (!shouldRetryLocalePush(attempts, maxAttempts)) return
        attempt(gen)
      }, retryMs)
    }
    const locale = readSource()
    // **空/非法 ≠ 「无事可做」**（2026-10-26 真机 `tf-mvp015bq-vy7vgk`）：挂载那一刻
    // `ctx.locale.getSnapshot()` 可能还没就绪（`shared.tsx` 的 `localeTag` 自己就写着
    // `catch { /* 服务未就绪 */ }`）。旧实现这里直接 `return` ⇒ **一次都不推、也不重试**
    // ⇒ 宿主永久停在 en 兜底（整轮产物与日志英文 + 团队名/子代理 label 英文，而宿主 UI 是中文）。
    // 现在：值没就绪就排重试，重试时**重新取**（getter），就绪后自然推上去。
    if (typeof locale !== 'string' || !locale) { retry(); return }
    try {
      const r = deps.push(locale) as { ok?: unknown; then?: unknown } | undefined
      if (r && typeof r.then === 'function') { (r as Promise<unknown>).then(() => { }, retry); return }
      if (r && (r as { ok?: unknown }).ok === false) retry()
    } catch (e) { retry() }
  }

  return {
    send,
    // ⚠️ 刻意**不重置 attempts**：重置会让「触发时再判有界」顺手挡住 dispose 后的补发，
    // 从而把「触发时复判存活」这条判据**掩盖成假绿**（2026-10-16 实测：M16 变异下测试仍绿）。
    // dispose 的语义只有两条：不再回调、不再接受 send —— 由 alive 单独承担。
    dispose: () => { alive = false; clear() },
  }
}
