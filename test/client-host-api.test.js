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
  else bad("没有把 uiWorkspace 桥接给组件", "组件靠 props 拿不到服务 → 按钮仍会灰")
} else {
  ok('未使用 uiWorkspace（无需 inject）')
}
if (seen.sessions.size === 0) {
  const dead = injects.filter(([, list]) => list && list.includes("'sessions'")).map(([f]) => f)
  if (dead.length === 0) ok("未使用 sessions.* 且已摘掉 'sessions' 死依赖")
  else bad("没有任何 sessions.* 引用却仍 inject 'sessions'", dead.join(', '))
}

console.log(
  failed === 0
    ? `\nclient-host-api: 全部通过（${files.length} 个客户端源文件 / sessions 用到 ${seen.sessions.size} 个成员 / uiWorkspace ${seen.uiWorkspace.size} 个）`
    : `\nclient-host-api: ${failed} 项失败`,
)
process.exit(failed === 0 ? 0 : 1)
