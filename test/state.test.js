/**
 * dsh-plugin-teamflow — state.json 读写的**字段完整性**门禁。
 *
 * **被修的 bug**（2026-09-18 实锤 probe-cache `tf-mu6tb281`）：
 * `loadState` 是**逐字段白名单重建**（`const base = emptyState()` 后逐个赋值，不是整体读取），
 * 而它漏了 `gitMode` → pipeline 明明写了 `st.gitMode='repo'; saveState(...)`（日志也有「改动存档已开启」），
 * 但**任何一次阶段 state 块合并**（`mergeStateBlock` 走 load→save 往返）都会把它丢掉 →
 * 下次 run 又从头问「要不要开启改动存档」——用户当初要的「答案记住、后续不再问」整条失效。
 *
 * **这类"白名单漏字段"已第四次**（B1 同型：`execOptions` / `journal.options` / `loadState`），
 * 所以本文件不只补 `gitMode` 一个字段，而是立**结构化门禁**：
 *   ① 静态解析 `TeamflowState` 接口的**顶层键**，逐个断言 `loadState` 真的搬运了它
 *      （新加持久化字段忘了搬运 → 立刻红，不依赖有人记得来加断言）；
 *   ② 行为级往返：save → load 后每个字段仍在（`gitMode` 含非法值过滤）。
 *
 * 运行时字段（`__runCtx`，注释明写"不持久化"）与常量（`version`，由 `emptyState` 供给）**豁免**。
 */
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadState, saveState } from '../host/core/state.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

const here = dirname(fileURLToPath(import.meta.url))
const home = mkdtempSync(join(tmpdir(), 'tf-state-'))
process.env.DSH_HOME = home
const cleanup = () => { try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* ignore */ } }

/** 顶层键中**不参与 loadState 搬运**的：运行时注入（不持久化）+ 常量（emptyState 供给）。 */
const EXEMPT = new Set(['__runCtx', 'version'])

console.log('── 1) 结构化门禁：TeamflowState 的每个持久化字段都必须被 loadState 搬运 ──')
const src = readFileSync(join(here, '../host/core/state.ts'), 'utf8')
// 抽出 interface TeamflowState { ... } 的顶层键（只取 2 空格缩进的 `key?:` / `key:` 行）
const iface = (src.match(/export interface TeamflowState \{[\s\S]*?\n\}/) || [''])[0]
const topKeys = []
for (const line of iface.split('\n')) {
  const m = line.match(/^  ([A-Za-z_$][\w$]*)\??\s*:/)
  if (m) topKeys.push(m[1])
}
ok(topKeys.length >= 10, `解析到 TeamflowState 顶层键 ${topKeys.length} 个（${topKeys.join(', ')}）`)
// loadState 函数体（从声明到下一个 export）
const loadBody = (src.match(/export function loadState[\s\S]*?(?=\n\/\*\*|\nexport )/) || [''])[0]
ok(loadBody.length > 200, '提取到 loadState 函数体')
const missing = topKeys.filter((k) => !EXEMPT.has(k) && !new RegExp(`raw\\.${k}\\b`).test(loadBody))
ok(missing.length === 0, `每个持久化字段都被搬运${missing.length ? `——**漏了：${missing.join(', ')}**（新增持久化字段必须同步 loadState，否则永远存不住）` : ''}`)
ok(/raw\.gitMode/.test(loadBody), 'gitMode 被显式搬运（本次实锤漏的就是它——「答案记住」整条失效）')
ok(/raw\.gitMode === 'repo' \|\| raw\.gitMode === 'none'/.test(loadBody), 'gitMode 只接受合法值（脏值不写回，避免把垃圾固化）')

console.log('\n── 2) 行为级往返：save → load 后字段仍在 ──')
const KEY = 'ws-state-test'
const full = {
  version: 1,
  projectName: 'demo',
  updatedAt: null,
  product: { summary: '产品摘要', techStack: 'TS' },
  lastRunFolder: 'docs/teamflow/20260918-r1',
  modules: { 'src/a.ts': '模块 A' },
  verifyScripts: ['pnpm test'],
  acIndex: { 'AC-1': '第一条' },
  stages: { prd: 'PRD 结论' },
  lastRun: { runId: 'tf-x', requirement: '需求', folder: 'docs/teamflow/20260918-r1', verdict: 'accepted', endedAt: 1 },
  gitMode: 'repo',
}
saveState(KEY, full)
const back = loadState(KEY)
for (const k of topKeys.filter((x) => !EXEMPT.has(x))) {
  ok(JSON.stringify(back[k]) === JSON.stringify(full[k]) || (k === 'updatedAt' && typeof back.updatedAt === 'number'),
    `往返后 ${k} 保持${k === 'updatedAt' ? '（updatedAt 允许被 saveState 刷新为时间戳）' : ''}`)
}
ok(back.gitMode === 'repo', '**gitMode 往返保持 repo**（修复前此处为 undefined → 每次 run 重复问存档）')

console.log('\n── 3) gitMode 语义 ──')
saveState(KEY, { ...full, gitMode: 'none' })
ok(loadState(KEY).gitMode === 'none', 'gitMode=none 往返保持（用户选"不用版本控制"要被记住）')
saveState(KEY, { ...full, gitMode: undefined })
ok(loadState(KEY).gitMode === undefined, '缺省 = 未知（不编造 repo/none，交回决策流程）')
saveState(KEY, { ...full, gitMode: 'garbage' })
ok(loadState(KEY).gitMode === undefined, '非法值被过滤（脏数据不写回、不固化）')

console.log('\n── 4) 「合并阶段 state 块」不得弄丢 gitMode（实锤的丢失路径）──')
// 实锤路径：pipeline 写 gitMode → 之后任一阶段产出 state 块 → mergeStateBlock(load→save) 往返
saveState(KEY, { ...full, gitMode: 'repo' })
const { mergeStateBlock } = await import('../host/core/state.ts')
mergeStateBlock(KEY, { phase: 'prd', summary: '阶段结论', extra: { acIndex: { 'AC-9': '新增' } } })
const afterMerge = loadState(KEY)
ok(afterMerge.gitMode === 'repo', '**合并 state 块后 gitMode 仍在**（修复前正是这一步把它抹掉）')
ok(afterMerge.stages.prd === '阶段结论' && afterMerge.acIndex['AC-9'] === '新增', '合并本身照常生效（不是靠跳过合并来保住 gitMode）')

cleanup()
console.log(failed ? `\n✗ state：${failed} 条失败\n` : '\n✓ state：全部通过\n')
process.exit(failed ? 1 : 0)
