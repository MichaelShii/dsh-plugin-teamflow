/**
 * dsh-plugin-teamflow core — 运行期语言源（客户端推送槽 + 宿主 settings 只读端口）。
 *
 * 为什么单独一层：语言「从哪来」必须是**唯一读取点**，否则每个消费方各自读 settings /
 * 自建浏览器语言缓存，就会出现 PRD 明令禁止的并行机制与「同 run 语言漂移」。
 * 本文件只回答两个问题：
 *   1. 当前界面语言是什么（`ambientLocale()`）——`teamflow_*` 工具返回/Remote 错误用；
 *   2. 新 run 起跑时快照成什么（`newRunLocale()`）——写进 journal.locale，之后一律读快照。
 *
 * 三个来源（优先级同 AC-1）：
 * - **客户端推送**（`noteClientLocale`）：浏览器当前语言（含系统探测结果），经既有 Remote 面
 *   `teamflow/setLocale` 推上来。用户没在宿主显式选过语言时只有这条通道能拿到真实语言
 *   （宿主 `locale.preference` 仅在用户显式选择过时才有值）。
 * - **宿主 settings 只读端口**（`setSettingsPort`）：`ctx.get('settings').get('locale').preference`，
 *   由 `@deepseek-ai/dsh-client-locale` 的 host face 注册。host 只读不写、未注册/服务缺失一律
 *   null（全 try/catch，AC-10：解析链任一级缺失都不报错、不阻塞）。
 * - **`en`**：兜底（AC-1③）。
 *
 * 内存单槽、last-write-wins、不落盘：语言是界面态，重启后由客户端重新推送（持久化属宿主职责）。
 */
import { FALLBACK_LOCALE, parseLocale, resolveLocale, type HostLocale } from '../locales.ts'

/** 客户端推送的语言（最近一次，内存单槽）。 */
let clientPushed: HostLocale | null = null

/** 客户端推送语言：可解析即写入，非法即清空（非法值不保留旧值——避免「推了个 fr，host 还在用上次的 en」）。 */
export function noteClientLocale(v: unknown): boolean {
  const parsed = parseLocale(v)
  clientPushed = parsed
  return parsed !== null
}

/** 当前客户端推送值（未推送/已清空 → null）。 */
export function clientLocale(): HostLocale | null {
  return clientPushed
}

/** 宿主 settings 只读端口（由门面注入；缺省 null = 宿主未提供）。 */
let settingsPort: (() => unknown) | null = null

/** 注入宿主 settings 只读端口（门面构造时调用；宿主缺 settings 服务时传 null）。 */
export function setSettingsPort(fn: (() => unknown) | null): void {
  settingsPort = typeof fn === 'function' ? fn : null
}

/** 宿主用户显式选择的语言（读不到/服务缺失/异常 → null，永不抛出）。 */
export function hostPreference(): HostLocale | null {
  if (!settingsPort) return null
  try {
    return parseLocale(settingsPort())
  } catch (e) {
    return null
  }
}

/** 当前界面语言（AC-1 解析链；工具返回/Remote 错误用）。 */
export function ambientLocale(): HostLocale {
  try {
    return resolveLocale({ client: clientPushed, host: hostPreference() })
  } catch (e) {
    return FALLBACK_LOCALE
  }
}

/** 新 run 起跑时解析一次（写进 journal.locale 的快照值；AC-2）。 */
export function newRunLocale(): HostLocale {
  return ambientLocale()
}

/**
 * 读 run 的语言快照（纯读、绝不重解析；AC-2）。
 * 历史 journal（升级前无 locale 字段）按 zh 处理——那些 run 的存量文案本就是中文，
 * 用 en 去渲染会与已落盘内容割裂（resumeRun 会补写该字段，见 core/pipeline.ts）。
 */
export function runLocaleOf(journal: unknown): HostLocale {
  const j = journal as { locale?: unknown } | null | undefined
  return parseLocale(j && j.locale) || 'zh'
}

/**
 * 缺 locale 字段时的快照取值（QA-1：resume 绝不按当前界面语言重解析）。
 * - 新 run：环境语言（AC-1 解析链）；
 * - resume/续跑：一律 `zh`——历史 journal 的存量文案本就是中文，用界面语言补写会造成同一 run 内中英混排
 *   （PRD §4.1「已落库文本保留生成时语言」）。与 `runLocaleOf` 的缺省口径严格一致。
 */
export function localeForMissingSnapshot(resume: boolean): HostLocale {
  return resume ? 'zh' : newRunLocale()
}

/** 读 state 注入块上下文里的语言（`state.__runCtx.locale`，由 pipeline 按快照写入）。 */
export function runCtxLocale(state: unknown): HostLocale {
  const s = state as { __runCtx?: { locale?: unknown } | null } | null | undefined
  return parseLocale(s && s.__runCtx && s.__runCtx.locale) || 'zh'
}
