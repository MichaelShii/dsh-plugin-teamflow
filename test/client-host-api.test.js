/**
 * client-host-api test（无外部依赖，node test/client-host-api.test.js 直接运行）
 *
 * 守的是「插件客户端引用的宿主服务 API」这一面。由来（2026-09-23）：
 * 宿主 0.1.7-alpha.1 的 2026-09-17 refactor 批次（6830e1460d / b9b14dc05e / 6d3b5d4526）删除了
 * `sessions.openSubagent` 与 `sessions.open`，而我们的守卫写成 `typeof sessions.openSubagent === 'function'`
 * → 恒为 false：「🎬 跳转子代理会话」按钮长期灰着、产物跳转静默降级成"当前会话右栏内联打开"。
 * 宿主删 API 不是我们的 bug，但**我们全套测试没有一个变红**——这才是缺口：契约面没有门禁。
 *
 * 冻结依据（已核验 dsh 0.1.7-alpha.1，checkout c36a83ff6b）：
 *  - `packages/api/session-controller/src/client/contract/sessions.ts` —— 契约成员 = 下面的 SESSIONS_MEMBERS
 *  - `packages/client/ui-workspace/src/client/navigation.ts:36` —— `openSession(target: SessionTarget): void`
 *  - `packages/subagent/subagent/src/control-types.ts:77` —— `SubagentAddress = { parentSessionId, childSessionId, mode }`
 * 宿主自家同功能面板的用法参照：`packages/client/ui-workflow-run/src/client/index.ts:34` +
 * `ui-workflow-run/tests/workflow-run.client.spec.tsx:864`（`{ parentSessionId, childSessionId, mode: 'one-shot' }`）。
 *
 * 断言：
 *  1) 客户端源码不得引用**已移除**的宿主成员（openSubagent / sessions.open / SessionListState.current）。
 *  2) 客户端出现的每个 `sessions.<成员>` / `uiWorkspace.<成员>` 必须在冻结白名单内
 *     （宿主新增成员时我们要显式更新这份清单，而不是静默用上）。
 *  3) 用到 `uiWorkspace.*` 就必须有人 inject `'uiWorkspace'`；反之没有任何 `sessions.*` 引用时
 *     不得继续把 `'sessions'` 挂在 inject 上（死依赖 = 白等一个服务）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const clientDir = join(rootDir, 'client')

/** 已核验的宿主 `sessions` 契约成员（0.1.7-alpha.1）。新增成员才可改这里。 */
const SESSIONS_MEMBERS = [
  'retain', 'using', 'retainInfo', 'searchResultLimit', 'create', 'subagentAddress',
  'refreshProjections', 'refresh', 'search', 'fork', 'binding', 'list',
]
/** 已核验的宿主 `uiWorkspace` 面成员（0.1.7-alpha.1）。 */
const UI_WORKSPACE_MEMBERS = ['openSession', 'openWorkspace', 'forkSession', 'open']
/** 宿主已移除的成员：引用即红（历史 `sessions.openSubagent` / `sessions.open` / `SessionListState.current`）。 */
const REMOVED = [
  { re: /sessions\.openSubagent/, why: 'sessions.openSubagent 已于 2026-09-17 被宿主移除 → 改 uiWorkspace.openSession' },
  { re: /sessions\.open\s*\(/, why: 'sessions.open 已于 2026-09-17 被宿主移除 → 改 uiWorkspace.openSession' },
  { re: /sessions\.list[^\n]*\.current\b/, why: 'SessionListState 已无 current 字段（只剩 ids/byId/phase/projectionsBySession）' },
]

let failed = 0
const ok = (label, detail = '') => console.log(`✅ ${label}${detail ? ` —— ${detail}` : ''}`)
const bad = (label, detail = '') => {
  failed++
  console.log(`❌ ${label}${detail ? ` —— ${detail}` : ''}`)
}

const files = readdirSync(clientDir).filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
if (files.length === 0) {
  bad('client/ 有源码文件')
  process.exit(1)
}
/** 剥掉注释但**保留行号**（把注释内容替换成等长空白）：迁移说明里必然要写被移除的 API 名，
 *  扫代码时不带注释，既不误报也能继续盯住真实调用。 */
const stripComments = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
const sources = files.map((f) => {
  const raw = readFileSync(join(clientDir, f), 'utf8')
  return [f, stripComments(raw)]
})

// ── 1) 已移除成员 ────────────────────────────────────────────────────────────
let removedHits = 0
for (const [f, src] of sources) {
  src.split('\n').forEach((line, i) => {
    for (const { re, why } of REMOVED) {
      if (re.test(line)) {
        removedHits++
        bad('引用了宿主已移除的 API', `${f}:${i + 1} ${why}`)
      }
    }
  })
}
if (removedHits === 0) ok('未引用宿主已移除的会话 API', 'openSubagent / sessions.open / list.current')

// ── 2) 成员白名单 ────────────────────────────────────────────────────────────
const seen = { sessions: new Set(), uiWorkspace: new Set() }
const unknown = []
for (const [f, src] of sources) {
  for (const m of src.matchAll(/\b(sessions|uiWorkspace)\.(\w+)/g)) {
    const [, svc, member] = m
    const allow = svc === 'sessions' ? SESSIONS_MEMBERS : UI_WORKSPACE_MEMBERS
    if (allow.includes(member)) seen[svc].add(member)
    else unknown.push(`${f}: ${svc}.${member}`)
  }
}
if (unknown.length === 0) {
  ok('宿主服务成员都在冻结白名单内', `sessions{${[...seen.sessions].join(',') || '-'}} uiWorkspace{${[...seen.uiWorkspace].join(',') || '-'}}`)
} else {
  bad('出现未在白名单内的宿主成员', `${unknown.join(' / ')} —— 先在 dsh 契约里核验，再更新本文件清单`)
}

// ── 3) inject 与用法一致 ─────────────────────────────────────────────────────
const injects = sources.map(([f, src]) => {
  const m = /export const inject\s*=\s*\[([^\]]*)\]/.exec(src)
  return [f, m ? m[1] : null]
})
const hasUiWorkspaceUse = [...seen.uiWorkspace].length > 0
if (hasUiWorkspaceUse) {
  const declared = injects.filter(([, list]) => list && list.includes("'uiWorkspace'")).map(([f]) => f)
  if (declared.length > 0) ok("用到 uiWorkspace 且已 inject 'uiWorkspace'", declared.join(', '))
  else bad("用了 uiWorkspace 但没人 inject 'uiWorkspace'", 'inject 声明缺失 → 宿主不会注入，运行期拿不到服务')
  const provided = sources.filter(([, src]) => /ctx\.get\('uiWorkspace'\)/.test(src)).map(([f]) => f)
  if (provided.length > 0) ok("slot/props 桥接了 ctx.get('uiWorkspace')", provided.join(', '))
  else bad('没有把 uiWorkspace 桥接给组件', '组件靠 props 拿不到服务 → 按钮仍会灰')
} else {
  ok('未使用 uiWorkspace（无需 inject）')
}
if (seen.sessions.size === 0) {
  const dead = injects.filter(([, list]) => list && list.includes("'sessions'")).map(([f]) => f)
  if (dead.length === 0) ok("未使用 sessions.* 且已摘掉 'sessions' 死依赖")
  else bad("没有任何 sessions.* 引用却仍 inject 'sessions'", dead.join(', '))
}

/* ── 宿主插件页槽位贡献（ADR-0012 D1-①）──
   锁的是**「参数 → 实际使用」整条链**，不只锁调用点：光「注册了槽位名」不够——
   宿主会用**任意插件的详情页**来调我们的贡献，所以守卫必须同时判 subject 形态与本包包名；
   而守卫定义了却不被渲染组件调用，就等于「注册了但会渲染到别的插件页上」。 */
const allClient = sources.map(([, src]) => stripComments(src)).join('\n')
for (const slotName of ['plugins.detail.badge', 'plugins.detail.actions']) {
  if (allClient.includes(`ctx.slots.inject('${slotName}'`)) ok(`注册了宿主插件页槽位 ${slotName}`)
  else bad(`未注册 ${slotName}`, 'ADR-0012 D1-① 的落点缺失')
}
const guardDefs = (allClient.match(/function subjectIsOurs\b/g) || []).length
const guardUses = (allClient.match(/subjectIsOurs\(/g) || []).length
if (guardDefs === 1 && guardUses - guardDefs >= 2) ok('槽位守卫存在且被≥2 处渲染点调用', `定义 ${guardDefs} / 调用 ${guardUses - guardDefs}`)
else bad('槽位守卫缺失或没被渲染组件用上', `定义 ${guardDefs} / 调用 ${guardUses - guardDefs} —— 定义而不调用＝注册了却会渲染到别的插件页上`)
const guardBody = (allClient.match(/function subjectIsOurs[\s\S]{0,200}/) || [''])[0]
if (guardBody.includes("kind === 'bundle'") && /name === PLUGIN_PKG/.test(guardBody)) ok('守卫同时判 subject 形态与本包包名')
else bad('守卫判据不完整', "少了 kind === 'bundle' 或 name === PLUGIN_PKG —— 前者防串到 row/item 形态，后者防串到别的插件")
// 包名常量必须与 host 侧同值（两处各写一份，对不上就永远不匹配）
const clientPkg = /const PLUGIN_PKG = '([^']+)'/.exec(allClient)
const hostPkg = /export const PLUGIN_PACKAGE_NAME = '([^']+)'/.exec(readFileSync(join(rootDir, 'host/constants.ts'), 'utf8'))
if (clientPkg && hostPkg && clientPkg[1] === hostPkg[1]) ok('client 与 host 的包名常量一致', clientPkg[1])
else bad('client 与 host 的包名常量不一致', `${clientPkg && clientPkg[1]} vs ${hostPkg && hostPkg[1]}`)

/* ── 子代理地址的 mode 必须是 'unknown'（2026-10-15 实机修复 tf-mv9o5fkk-orjou4）──
   实锤：阶段详情「🎬 跳转子代理会话」点了报「历史加载失败：subagent mode does not match the supplied address
   （subagent/unauthorized）」。根因是我们抄宿主 ui-workflow-run 的例子写死 `mode: 'one-shot'`，而
   本插件的阶段子代理**在宿主 alpha.2 起一律记为 `continuable`**（`manager.startLocal` 统一写该值；
   实测 run tf-mv9o5fkk-orjou4 的子会话 descriptor：`{"mode":"continuable","provider":"spawn"}`）。宿主
   `history.validateAddress` 的判据是 `address.mode !== 'unknown' && identity.mode !== address.mode`
   ⇒ 声明与实际不符即拒。宿主自己的类型注释写明 `'unknown'` 是**跳转浏览**的既定输入
   （"unknown mode is resolved when child history is read"，control-types.ts:77），
   读回时由 identity 投影解析真实形态 ⇒ 这才是唯一与宿主版本解耦的写法。
   锁的是**调用里的对象字面量**（不是整份源码）：类型声明行本身含 `'one-shot' | 'continuable'`，
   扫全文会假绿。 */
const openCalls = [...allClient.matchAll(/openSession\(\{([\s\S]{0,400}?)\}\)/g)].map((m) => m[1])
if (openCalls.length === 0) bad('未找到 openSession({…}) 子代理地址调用', '跳子代理会话的入口应传持久地址对象')
else {
  const wrong = openCalls.filter((a) => !/mode: 'unknown'/.test(a) || /mode: '(one-shot|continuable)'/.test(a))
  if (wrong.length === 0) ok(`子代理地址一律 mode:'unknown'（${openCalls.length} 处）`, '宿主读回时按 identity 解析真实形态')
  else bad('子代理地址写死了具体 mode 或缺 mode', `实测宿主会拒：subagent mode does not match the supplied address —— ${JSON.stringify(wrong.map((a) => a.trim()))}`)
}
// 类型面同源：`mode` 必须**显式必填**——校验是 `address.mode !== 'unknown' && …`，不传即 undefined ⇒ 必被拒
{
  const decl = /openSession\?: \(target: string \| \{[^}]*\}\)/.exec(allClient)
  if (decl && /\bmode: 'one-shot'/.test(decl[0])) ok('openSession 入参类型的 mode 为必填', '缺省不安全：undefined 会直接落到宿主校验的否定分支')
  else bad('openSession 入参类型把 mode 写成可选', `不传 mode 会被宿主拒（undefined !== 'unknown'）—— 实得 ${decl ? decl[0] : '未找到声明'}`)
}

console.log(
  failed === 0
    ? `\nclient-host-api: 全部通过（${files.length} 个客户端源文件 / sessions 用到 ${seen.sessions.size} 个成员 / uiWorkspace ${seen.uiWorkspace.size} 个）`
    : `\nclient-host-api: ${failed} 项失败`,
)
process.exit(failed === 0 ? 0 : 1)
