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
  // 结构化待澄清项（ADR-0011 ①，2026-10-07；`kind` 于 2026-10-08 第 2 步加入）：key 顺序必须与
  // `normalizeOpenQuestions` 的产出顺序一致（q→why→changes→default→kind）—— 往返断言用 `JSON.stringify` 全等。
  openQuestions: [{ q: '要装到哪个 profile？', why: '决定形态契约', changes: 'AC 集', default: 'web', kind: 'taste' }],
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
ok(JSON.stringify(Object.keys(normalizeOpenQuestions([{ q: 'Q1', kind: 'fact' }])[0])) === JSON.stringify(['q', 'why', 'changes', 'default', 'kind']), '字段顺序稳定（往返断言用 JSON.stringify 全等，顺序是契约）')
ok(normalizeOpenQuestions([{ question: '别名', why: 'W' }])[0].q === '别名', '`question` 别名 → 采纳（模型常见变体）')
ok(normalizeOpenQuestions([{ why: 'W', changes: 'C' }]).length === 0, '缺 q/question → 丢弃（没有问题的条目无意义）')
ok(normalizeOpenQuestions([{ q: '   ' }]).length === 0, 'q 只有空白 → 丢弃')
ok(normalizeOpenQuestions([{ q: 'Q1' }])[0].why === '' && normalizeOpenQuestions([{ q: 'Q1' }])[0].default === '', '缺可选字段 → 补空串（不是 undefined，避免 JSON 里丢键）')
ok(normalizeOpenQuestions(['纯字符串', 3, null, {}]).length === 0, '非对象条目全部丢弃（不炸）')
ok(normalizeOpenQuestions(null).length === 0 && normalizeOpenQuestions(undefined).length === 0 && normalizeOpenQuestions('x').length === 0, '非数组输入 → 空数组（不炸）')
const many = Array.from({ length: 30 }, (_, i) => ({ q: 'Q' + i }))
ok(normalizeOpenQuestions(many).length === 12, `上限 12 条（实测 ${normalizeOpenQuestions(many).length}）`)
ok(normalizeOpenQuestions([{ q: 'x'.repeat(999) }])[0].q.length <= 300, '单字段截断 ≤300')

/* `kind`（2026-10-08，ADR-0011 ① 第 2 步）：确认单的**触发判据**就是它 —— 只有 `taste` 会让 PRD 后暂停。
 * 两条纪律决定了缺省值：
 *   ① 「依赖模型自律的判据，在量出真阳性率前**不得有阻断权**」⇒ 缺/非法一律归 `fact`（不暂停），
 *      **不能**默认成 `taste` —— 那等于把用户否掉的「任何待澄清项都停」偷偷放回来。
 *   ② 「空值必须可见」⇒ 缺 `kind` 要打 `kindMissing` 留痕（否则又是一次静默空转）。
 * 三条锁「只认 kind、不给别名」：别名会把契约违反洗成兑现，把要测的兑现率测没。 */
ok(normalizeOpenQuestions([{ q: 'Q', kind: 'taste' }])[0].kind === 'taste', 'kind=taste → 主观项保留（会触发确认单）')
ok(normalizeOpenQuestions([{ q: 'Q', kind: 'fact' }])[0].kind === 'fact', 'kind=fact → 信息缺口保留')
ok(normalizeOpenQuestions([{ q: 'Q', kind: 'TASTE' }])[0].kind === 'taste', 'kind 大小写不敏感（模型常见变体）')
ok(normalizeOpenQuestions([{ q: 'Q', type: 'taste' }])[0].kind === 'fact', '**不做别名**：`type: taste` 不予采纳（否则测不出契约兑现率）')
const untagged0 = normalizeOpenQuestions([{ q: 'Q' }])[0]
ok(untagged0.kind === 'fact' && untagged0.kindMissing === true, '缺 kind → 归 fact（不暂停）＋ kindMissing 留痕')
ok(normalizeOpenQuestions([{ q: 'Q', kind: 'taste' }])[0].kindMissing === undefined && normalizeOpenQuestions([{ q: 'Q', kind: 'fact' }])[0].kindMissing === undefined, '标了合法 kind 就不留 kindMissing（标记不得常驻）')

console.log('\n── mergeStateBlock：openQuestions 整组替换（不累加）──')
saveState(KEY, { ...full, openQuestions: [{ q: '旧问题', why: '', changes: '', default: '' }] })
mergeStateBlock(KEY, { phase: 'prd', summary: 's', extra: { openQuestions: [{ q: '新问题', why: '', changes: '', default: '' }] } })
const qAfter = loadState(KEY).openQuestions
ok(qAfter.length === 1 && qAfter[0].q === '新问题', `PRD 是本次 run 的权威 ⇒ 整组替换（实测 ${JSON.stringify(qAfter)}）`)
mergeStateBlock(KEY, { phase: 'tech', summary: 's', extra: {} })
ok(loadState(KEY).openQuestions.length === 1, 'state 块不含该键 → 保持原值（不清空）')


/* ── STATE_BLOCK_INSTRUCTION：`extra` 必须在**模板本体**里（ADR-0011 A，2026-10-07）──
 * 事故：模板原来只给 `{phase, summary, memory}`，而各阶段 rules 用**散文**要求 `extra:{acIndex,…}`
 * ⇒ 模型照模板写、忽略散文 ⇒ 实测 `extra.acIndex` 兑现率仅 7/34（20%）。
 * 这三条锁住「契约合并在模板里」这件事本身，而不只是「prompt 里有 openQuestions 这个词」。 */
console.log('\n── stripStateBlock：机器契约块不得进展示面（2026-10-08 用户截图实锤）──')
{
  const { stripStateBlock, extractStateBlock } = await import('../host/core/domain/state.ts')
  const body = '## 结论\n做完了。\n\n[Verification evidence]\n- 命令：node t.js\n- 退出码：0'
  const blk = '<!-- state -->{"phase":"qa","summary":"x"}<!-- /state -->'
  ok(stripStateBlock(body + '\n\n' + blk) === body, '成对的块 → 剥掉，正文逐字保留（不留空尾）')
  ok(stripStateBlock(body + '\n\n' + blk + '\n\n补充一句') === body + '\n\n补充一句', '块在中间 → 剥掉后两段正文合并（不留双空行）')
  ok(stripStateBlock(body) === body, '没有块 → **一字不改**（快路径，绝大多数文本走这条）')
  // ⚠️ 缺关闭标签时**不剥**：`extractStateBlock` 为了尽量取到状态会按「到结尾」处理，但剥展示文本若也
  // 这么做会**吃掉**后面可能存在的正常正文 ⇒ 宁可留在可见面上，把「契约被违反」暴露出来。
  ok(stripStateBlock(body + '\n\n<!-- state -->{"phase":"qa"}') === body + '\n\n<!-- state -->{"phase":"qa"}', '**缺关闭标签 → 不剥**（不吞正文；契约违反要可见）')
  ok(stripStateBlock('a' + blk + 'b' + blk + 'c') === 'abc', '多个块 → 全部剥掉')
  ok(stripStateBlock('') === '' && stripStateBlock(null) === '' && stripStateBlock(undefined) === '', '空 / null / undefined → 空串（不炸）')
  ok(extractStateBlock(body + '\n\n' + blk) !== null, '机器面仍能从**原始**文本取到块（剥的只是展示副本）')
}

console.log('\n── STATE_BLOCK_INSTRUCTION：extra 契约（ADR-0011 A）──')
const { STATE_BLOCK_INSTRUCTION } = await import('../host/core/domain/state.ts')
ok(/"extra":\{/.test(STATE_BLOCK_INSTRUCTION), '**模板本体含 `extra` 键**（只在散文里要求 = 模型照模板忽略它 —— 本日实测的根因）')
ok(/acIndex/.test(STATE_BLOCK_INSTRUCTION), '模板里点名 prd 的 extra 键（否则「required」落不到具体字段上）')
ok(/STATE BLOCK · mandatory at the end/.test(STATE_BLOCK_INSTRUCTION) && /<!-- state -->/.test(STATE_BLOCK_INSTRUCTION), '契约锚点两句保留（prompt-contract 的 L1 门禁锁的就是它们）')

cleanup()
console.log(failed ? `\n✗ state：${failed} 条失败\n` : '\n✓ state：全部通过\n')
process.exit(failed ? 1 : 0)
