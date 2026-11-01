/**
 * dsh-plugin-teamflow core — 子代理路由解析 + 续跑 stage 收尾（纯函数，无宿主私有包依赖）。
 *
 * 为什么单独成文件：这两个函数是纯逻辑（只依赖 `context.runtime` 的可选注入 + 入参），原本住在
 * runner.ts 里；但 runner.ts 顶层 import 了 guard.ts（`@deepseek-ai/dsh-llm`）与 util.ts（同款宿主
 * 私有包），导致**任何 import runner.ts 的测试在公共 CI（无宿主私有包）直接 ERR_MODULE_NOT_FOUND**
 * （2026-11-01 v0.3.3 发版实测：本地绿、CI 红 —— 本机 dsh profile 有这些包，公共 CI 没有）。
 * 把纯函数下沉到只依赖 context/types 的这里，测试即可在无宿主包的 CI 跑；runner.ts re-export 保持
 * 既有 import 面（pipeline / qa / acceptance）不变。
 */
import { runtime } from './context.ts'
import type { ParentAgentLike } from '../../types.ts'

/**
 * 解析父 agent 当前生效的模型路由（provider/model），给子代理用。
 *
 * 背景：子代理默认继承 `parent.options`（创建时快照），主线程在 UI 切换模型后
 * `parent.options` 不会更新，导致子代理仍打旧 provider（如已停的代理端口）。
 *
 * 四级回退，取「当前生效」而非「创建快照」：
 * 0. parent.session 的最新一条 `model/selection` 事件 —— 用户 UI 切模型即时 append 的「待生效选择」，
 *    是「本 session 下一次请求真正会用的路由」。这是切换后唯一**即时**反映新模型的来源。
 * 1. parent.session.requestHeader()?.config —— 主线程最近一次**实际请求**生效的路由。
 *    ⚠️ 仅在父 agent 实际发请求后才刷新；切模型后它是陈旧快照（直到父 agent 下次发请求）。
 * 2. runtime.agentDefaultModel?.currentSelection() —— 全局默认模型当前选择（切换即更新，可选注入）。
 * 3. parent.options —— 创建快照（兜底）。
 *
 * 实证（run tf-mvsgetmy-ldop5j，2026-10-29）：原来只有后三级 ⇒ 切模型后 L1(requestHeader) 陈旧，
 * 改道闸门把「期望路由」算成旧模型 ⇒ 与旧 child 记录比对判「无漂移」⇒ 闸门从不打开、子代理永远吃旧模型。
 * 加优先级 0 后，切模型即时反映到子代理路由。
 */
export function resolveChildRoute(parent: ParentAgentLike): { provider?: string; model?: string; maxTokens?: number } {
  const out: { provider?: string; model?: string; maxTokens?: number } = {}

  // 0. 父 session 待生效选择（model/selection 事件）：用户 UI 切模型即时 append，是「本 session
  //    下一次请求真正会用的路由」。requestHeader（下方 L1）仅在父 agent 实际发请求后刷新，切模型后
  //    是陈旧快照——优先取待生效选择，否则子代理永远继承旧模型（实证 run tf-mvsgetmy-ldop5j）。
  try {
    const sess = (parent as {
      session?: { snapshotEvents?: () => Array<{ type?: unknown; data?: { provider?: unknown; model?: unknown } }> | undefined }
    }).session
    const events = sess && typeof sess.snapshotEvents === 'function' ? sess.snapshotEvents() : undefined
    if (Array.isArray(events)) {
      for (let i = events.length - 1; i >= 0; i--) {
        const ev = events[i] as { type?: unknown; data?: { provider?: unknown; model?: unknown } }
        if (ev && ev.type === 'model/selection' && ev.data) {
          const sp = ev.data.provider, sm = ev.data.model
          if (typeof sp === 'string' && sp) {
            out.provider = sp
            if (typeof sm === 'string' && sm) out.model = sm
          }
          break
        }
      }
    }
  } catch (e) { /* 回退下一级 */ }

  if (!out.provider) {
    // 1. 最近生效路由（request header config，父 agent 上次实际请求；切模型后陈旧，故降到此处）
    const session = (parent as {
      session?: { requestHeader?: () => { config?: { provider?: string; model?: string; maxTokens?: number } } | undefined }
    }).session
    const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const cfg = header && header.config
    if (cfg && typeof cfg.provider === 'string' && cfg.provider) {
      out.provider = cfg.provider
      if (typeof cfg.model === 'string' && cfg.model) out.model = cfg.model
      if (typeof cfg.maxTokens === 'number') out.maxTokens = cfg.maxTokens
    }
  } else {
    // maxTokens：model/selection 不携带，从 requestHeader 补回，避免降级丢失上限
    try {
      const sess = (parent as { session?: { requestHeader?: () => { config?: { maxTokens?: number } } | undefined } }).session
      const h = sess && typeof sess.requestHeader === 'function' ? sess.requestHeader() : undefined
      const mt = h && h.config && h.config.maxTokens
      if (typeof mt === 'number') out.maxTokens = mt
    } catch (e) { /* ignore */ }
  }
  if (!out.provider) {
    // 2. 全局默认模型当前选择（切换即更新）
    const defaultModel = runtime.agentDefaultModel as {
      currentSelection?: () => { provider?: string; model?: string; maxTokens?: number }
    } | undefined
    if (defaultModel && typeof defaultModel.currentSelection === 'function') {
      try {
        const sel = defaultModel.currentSelection()
        if (sel && typeof sel.provider === 'string' && sel.provider) {
          out.provider = sel.provider
          if (typeof sel.model === 'string' && sel.model) out.model = sel.model
          if (typeof sel.maxTokens === 'number') out.maxTokens = sel.maxTokens
        }
      } catch (e) { /* 回退下一级 */ }
    }
  }
  if (!out.provider) {
    // 3. 创建快照兜底
    const po = (parent as { options?: { provider?: string; model?: string; maxTokens?: number } }).options
    if (po && typeof po.provider === 'string' && po.provider) {
      out.provider = po.provider
      if (typeof po.model === 'string' && po.model) out.model = po.model
      if (typeof po.maxTokens === 'number') out.maxTokens = po.maxTokens
    }
  }
  return out
}

/**
 * 续跑「投进去了但没拿到正文」（noText）时收尾 stage：明确 failed + 落**真实**结束时刻。
 *
 * 为什么单独抽出来：旧实现在 noText 分支直接 return、完全不动 stage ⇒ 复用 resume 前的旧 stage，
 * `endedAt` 停在**首次运行**（真机 tf-mvsgetmy-ldop5j T9：卡片显示 6m3s，实际 child 已活 6.5 小时、
 * 单 turn 90 分钟还在跑），UI 时间严重失真、看起来像「6 分钟就死的弃子」。
 *
 * 纯函数便于锁行为（test/dev-continue-timeout.test.js）：`null` 安全；有 stage 就改这两项并返回。
 */
export function finalizeNoTextStage<T extends { status?: string | null; endedAt?: number | null } | null | undefined>(
  stage: T,
  now: number,
): T {
  if (!stage) return stage
  stage.status = 'failed'
  stage.endedAt = now
  return stage
}
