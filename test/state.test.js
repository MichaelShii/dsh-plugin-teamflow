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
import { loadState, saveState, stateSliceFor } from '../host/core/domain/state.ts'

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
const src = readFileSync(join(here, '../host/core/domain/state.ts'), 'utf8')
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
  // 结构化待澄清项（ADR-0011 ①，2026-10-07）：key 顺序必须与 `normalizeOpenQuestions`
  // 的产出顺序一致（q→why→changes→default）—— 往返断言用的是 `JSON.stringify` 全等。
  openQuestions: [{ q: '要装到哪个 profile？', why: '决定形态契约', changes: 'AC 集', default: 'web' }],
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
const { mergeStateBlock } = await import('../host/core/domain/state.ts')
mergeStateBlock(KEY, { phase: 'prd', summary: '阶段结论', extra: { acIndex: { 'AC-9': '新增' } } })
const afterMerge = loadState(KEY)
ok(afterMerge.gitMode === 'repo', '**合并 state 块后 gitMode 仍在**（修复前正是这一步把它抹掉）')
ok(afterMerge.stages.prd === '阶段结论' && afterMerge.acIndex['AC-9'] === '新增', '合并本身照常生效（不是靠跳过合并来保住 gitMode）')

/* ── 架构蓝图的角色可见性路由（2026-09-29 修）──
 * 事故：白名单只有 arch/tech/dev，而 qaPrompt 的 0a「接口一致性核对」与 acceptancePrompt 的
 * 模块抽取核对都写成 "if the injected blueprint JSON is present" ⇒ 条件**永远为假**，
 * QA 只能退回 ARCHITECTURE.md 猜契约（观察期 run 的 QA 报告自己点出了这一点）。
 * 这两条断言在修复前必红 —— 它们锁的是「声明与投递必须一致」这件事本身。 */
console.log('\n── stateSliceFor：架构蓝图可见性（qa/acceptance 曾收不到）──')
const BP = '<!-- blueprint -->{"summary":"s"}<!-- /blueprint -->'
const bpState = (blueprint = BP) => ({
  __runCtx: { runDocs: 'docs/teamflow/x', blueprint },
  product: {}, modules: {}, verifyScripts: [], acIndex: {}, stages: {}, lastRun: null,
})
const sees = (role) => stateSliceFor(bpState(), role).includes(BP)
ok(sees('dev'), 'dev 能看到蓝图（依它实现：模块划分 / 装配顺序 / api 逐字调用）')
ok(sees('qa'), '**qa 必须能看到蓝图** —— 否则 0a「接口一致性核对」永远无从核对（修复前为假）')
ok(sees('acceptance'), '**acceptance 必须能看到蓝图** —— 模块抽取核对同理（修复前为假）')
ok(sees('arch') && sees('tech'), 'arch / tech 仍能看到（原有行为不回退）')
ok(!stateSliceFor(bpState(''), 'qa').includes('blueprint'), '无蓝图时不得凭空注入（条件式契约的「条件」仍要真判）')
ok(!sees('pm') && !sees('design'), 'pm / design 不注入（它们跑在 tech 之前，此时蓝图尚不存在）')


/* ── 结构化待澄清项（ADR-0011 ①，2026-10-07）──
 * `prdPrompt` 一直要求 state 块带 `extra.openQuestions`（且有 prompts 侧 L1 门禁），
 * 但 `mergeStateBlock` 从未消费 ⇒ 确认单只能退回**文本抽取**。这里锁住「结构化优先」这条链。
 * 重点在**容错**：模型给的形状不稳定（别名 question / 缺字段 / 纯字符串 / 超长），一律不抛、不污染 state。 */
console.log('\n── normalizeOpenQuestions：模型形状容错 ──')
const { normalizeOpenQuestions } = await import('../host/core/domain/state.ts')
ok(normalizeOpenQuestions([{ q: 'Q1', why: 'W', changes: 'C', default: 'D' }]).length === 1, '四字段齐全 → 保留')
ok(JSON.stringify(Object.keys(normalizeOpenQuestions([{ q: 'Q1', why: 'W', changes: 'C', default: 'D' }])[0])) === JSON.stringify(['q', 'why', 'changes', 'default']), '字段顺序稳定（往返断言用 JSON.stringify 全等，顺序是契约）')
ok(normalizeOpenQuestions([{ question: '别名', why: 'W' }])[0].q === '别名', '`question` 别名 → 采纳（模型常见变体）')
ok(normalizeOpenQuestions([{ why: 'W', changes: 'C' }]).length === 0, '缺 q/question → 丢弃（没有问题的条目无意义）')
ok(normalizeOpenQuestions([{ q: '   ' }]).length === 0, 'q 只有空白 → 丢弃')
ok(normalizeOpenQuestions([{ q: 'Q1' }])[0].why === '' && normalizeOpenQuestions([{ q: 'Q1' }])[0].default === '', '缺可选字段 → 补空串（不是 undefined，避免 JSON 里丢键）')
ok(normalizeOpenQuestions(['纯字符串', 3, null, {}]).length === 0, '非对象条目全部丢弃（不炸）')
ok(normalizeOpenQuestions(null).length === 0 && normalizeOpenQuestions(undefined).length === 0 && normalizeOpenQuestions('x').length === 0, '非数组输入 → 空数组（不炸）')
const many = Array.from({ length: 30 }, (_, i) => ({ q: 'Q' + i }))
ok(normalizeOpenQuestions(many).length === 12, `上限 12 条（实测 ${normalizeOpenQuestions(many).length}）`)
ok(normalizeOpenQuestions([{ q: 'x'.repeat(999) }])[0].q.length <= 300, '单字段截断 ≤300')

console.log('\n── mergeStateBlock：openQuestions 整组替换（不累加）──')
saveState(KEY, { ...full, openQuestions: [{ q: '旧问题', why: '', changes: '', default: '' }] })
mergeStateBlock(KEY, { phase: 'prd', summary: 's', extra: { openQuestions: [{ q: '新问题', why: '', changes: '', default: '' }] } })
const qAfter = loadState(KEY).openQuestions
ok(qAfter.length === 1 && qAfter[0].q === '新问题', `PRD 是本次 run 的权威 ⇒ 整组替换（实测 ${JSON.stringify(qAfter)}）`)
mergeStateBlock(KEY, { phase: 'tech', summary: 's', extra: {} })
ok(loadState(KEY).openQuestions.length === 1, 'state 块不含该键 → 保持原值（不清空）')

cleanup()
console.log(failed ? `\n✗ state：${failed} 条失败\n` : '\n✓ state：全部通过\n')
process.exit(failed ? 1 : 0)
