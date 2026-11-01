/**
 * dsh-plugin-teamflow — resolveChildRoute 路由解析（2026-10-29 修复 run tf-mvsgetmy-ldop5j）。
 *
 * 动机：UI 切模型只更新父 session 的 `model/selection`（待生效）与全局默认（agentDefaultModel），
 * 不 append `request/header`；requestHeader 仅在父 agent 实际发请求后才刷新 ⇒ 切模型后陈旧。
 * 若 resolveChildRoute 优先取 requestHeader（旧逻辑 L1 优先），子代理永远拿不到新模型，
 * 改道闸门也因「期望路由=旧模型」判无漂移而从不打开。
 *
 * 锁两件事：
 *  ① 优先级 0：父 session 有 model/selection（新模型）时，必须压过陈旧的 requestHeader（旧模型）。
 *  ② 回退：无 model/selection 时，退化到 requestHeader（旧行为不破坏）。
 * 变异：去掉优先级 0 的 mutant 必须误判（返回陈旧旧模型）⇒ 证明真有牙；去掉 maxTokens 回填的
 *      mutant 必须丢失上限 ⇒ 证明回填真有牙。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { resolveChildRoute } from '../host/core/agent/runner.ts'
import { runtime } from '../host/core/agent/context.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

// L2（全局默认）由本测试控制
let l2 = null
runtime.agentDefaultModel = { currentSelection: () => l2 }

const parent = (over) => ({
  session: {
    snapshotEvents: () => (over && over.events) || [],
    requestHeader: () => (over && over.header) || undefined,
  },
  options: over && over.options,
})

// 路由常量
const OLD = { provider: 'p-old', model: 'm-old', maxTokens: 4096 }
const NEW = { provider: 'p-new', model: 'm-new' }
const DEF = { provider: 'p-def', model: 'm-def' }
const OPT = { provider: 'p-opt', model: 'm-opt' }

console.log('── 1) 优先级 0：model/selection 压过陈旧 requestHeader ──')
// 隔离 L2/L3：L2 设 null、options 不设，唯一新模型来源是 model/selection
ok(resolveChildRoute(parent({ events: [{ type: 'model/selection', data: { provider: NEW.provider, model: NEW.model } }], header: { config: OLD } })).provider === NEW.provider,
  '父 session 有 model/selection(新) + requestHeader(旧) ⇒ 取新（切模型即时生效）')
ok(resolveChildRoute(parent({ events: [{ type: 'model/selection', data: { provider: NEW.provider, model: NEW.model } }], header: { config: OLD } })).model === NEW.model,
  'model 同样取自 model/selection（新）')

console.log('── 2) maxTokens 回填：model/selection 不携带，须从 requestHeader 补回 ──')
ok(resolveChildRoute(parent({ events: [{ type: 'model/selection', data: { provider: NEW.provider, model: NEW.model } }], header: { config: OLD } })).maxTokens === OLD.maxTokens,
  'model/selection 命中时，maxTokens 从 requestHeader 补回（不降级丢失上限）')

console.log('── 3) 回退链（无 model/selection 时旧行为不破坏）──')
// 无 model/selection ⇒ 取 requestHeader（L1）
ok(resolveChildRoute(parent({ events: [], header: { config: OLD } })).provider === OLD.provider,
  '无 model/selection ⇒ 退化到 requestHeader(L1)（旧行为）')
// 无 model/selection 且无 requestHeader ⇒ 取 L2 全局默认
l2 = DEF
ok(resolveChildRoute(parent({ events: [], header: null })).provider === DEF.provider,
  '无 model/selection + 无 requestHeader ⇒ 取全局默认(L2)')
// 无 model/selection / 无 header / 无 L2 ⇒ 取创建快照 options(L3)
l2 = null
ok(resolveChildRoute(parent({ events: [], header: null, options: OPT })).provider === OPT.provider,
  '三项皆无 ⇒ 取创建快照(L3)')
// L2 在 model/selection 之下：即便 L2 仍是旧，也必须取 model/selection
l2 = OLD
ok(resolveChildRoute(parent({ events: [{ type: 'model/selection', data: { provider: NEW.provider, model: NEW.model } }], header: { config: OLD } })).provider === NEW.provider,
  '优先级 0 压过 L2（即使 L2 仍是旧模型）')

console.log('── 4) 变异：每个判据必须有牙 ──')
// 变异①：删除优先级 0（退回旧逻辑 L1>L2>L3，忽略 model/selection）
const mutantDropPending = (p) => {
  const out = {}
  const header = p.session && p.session.requestHeader ? p.session.requestHeader() : undefined
  const cfg = header && header.config
  if (cfg && typeof cfg.provider === 'string' && cfg.provider) {
    out.provider = cfg.provider
    if (typeof cfg.model === 'string' && cfg.model) out.model = cfg.model
  }
  if (!out.provider) {
    const sel = l2
    if (sel && typeof sel.provider === 'string' && sel.provider) { out.provider = sel.provider; if (typeof sel.model === 'string' && sel.model) out.model = sel.model }
  }
  if (!out.provider) {
    const po = p.options
    if (po && typeof po.provider === 'string' && po.provider) { out.provider = po.provider; if (typeof po.model === 'string' && po.model) out.model = po.model }
  }
  return out
}
l2 = null
const scen = parent({ events: [{ type: 'model/selection', data: { provider: NEW.provider, model: NEW.model } }], header: { config: OLD } })
ok(mutantDropPending(scen).provider === OLD.provider && resolveChildRoute(scen).provider === NEW.provider,
  '变异①（删优先级 0）：切模型后误取旧模型 ⇒ 该变异被杀死')

// 变异②：有优先级 0 但删除 maxTokens 回填
const mutantDropMaxTokens = (p) => {
  const out = {}
  const events = p.session && p.session.snapshotEvents ? p.session.snapshotEvents() : []
  if (Array.isArray(events)) {
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev && ev.type === 'model/selection' && ev.data) {
        const sp = ev.data.provider, sm = ev.data.model
        if (typeof sp === 'string' && sp) { out.provider = sp; if (typeof sm === 'string' && sm) out.model = sm }
        break
      }
    }
  }
  if (!out.provider) {
    const header = p.session && p.session.requestHeader ? p.session.requestHeader() : undefined
    const cfg = header && header.config
    if (cfg && typeof cfg.provider === 'string' && cfg.provider) { out.provider = cfg.provider; if (typeof cfg.model === 'string' && cfg.model) out.model = cfg.model }
  }
  return out // 故意不回填 maxTokens
}
ok(mutantDropMaxTokens(scen).maxTokens === undefined && resolveChildRoute(scen).maxTokens === OLD.maxTokens,
  '变异②（删 maxTokens 回填）：丢失上限 ⇒ 该变异被杀死')

console.log('── 5) 接线 ──')
const runnerSrc = readFileSync(join(here, '..', 'host', 'core', 'agent', 'runner.ts'), 'utf8')
ok(/model\/selection/.test(runnerSrc) && /snapshotEvents/.test(runnerSrc), 'resolveChildRoute 读父 session 的 model/selection 事件（优先级 0 落点）')
ok(/0\. 父 session 待生效选择/.test(runnerSrc), 'doc 标注优先级 0 为待生效选择')
ok(/maxTokens：model\/selection 不携带/.test(runnerSrc), '命中优先级 0 时回填 maxTokens')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
