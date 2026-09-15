/**
 * dsh-plugin-teamflow — host 语言层单元与门禁（r9 / T1）。
 *
 * 覆盖（PRD AC-1/AC-2/AC-3/AC-9/AC-10/AC-11 的零 LLM 部分）：
 * 1) 语言解析链矩阵（纯函数、零异常、非法值逐级降级）
 * 2) t() 回落链（locale → en → key）与 `{name}` 参数替换
 * 3) 词典不变量（zh/en 键同形、en 值无 CJK、值非空、两份区词典合并后键唯一）
 * 4) 冻结键表（只增不改：存量 key 消失即红）
 * 5) 运行期语言源语义（客户端推送槽 last-write-wins / 非法即清 / settings 端口异常降级）
 * 6) journal.locale 往返（快照随 journal 落盘、resume 读回不重解析）
 * 7) 字面量归属门禁（旧中文文案必须已从消费文件消失、只在词典里存在）
 *
 * 为什么需要门禁：文案搬迁靠人工评审守不住——半搬的词典很容易漏（同一句话残留两份，
 * 切语言时一半中文一半英文），而「en 词典混入中文」更是只能靠机器查。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  FALLBACK_LOCALE, LOCALE_DICTS, dictKeys, dictProblems, langDirective, modeDesc, modeLabel,
  parseLocale, phaseLabel, resolveLocale, t,
} from '../host/locales.ts'
import { PHASE_KEY_OF } from '../host/constants.ts'
import {
  ambientLocale, clientLocale, hostPreference, localeForMissingSnapshot, newRunLocale, noteClientLocale, runCtxLocale, runLocaleOf, setSettingsPort,
} from '../host/core/locale.ts'
import { zh as clientZh, en as clientEn } from '../client/locales.ts'
import { serializeJournal } from '../store.ts'
import { stateSliceFor } from '../host/core/state.ts'
import { teamNameOf, teamDescOf } from '../host/core/teams.ts'
import * as P from '../host/prompts/index.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eq = (actual, expected, msg) => ok(actual === expected, `${msg}（实测 ${JSON.stringify(actual)}）`)
const here = dirname(fileURLToPath(import.meta.url))

console.log('── 1) 解析链矩阵（AC-1：①客户端 ②宿主显式 ③en；纯函数零异常）──')
eq(parseLocale('zh'), 'zh', 'parseLocale: zh')
eq(parseLocale('en'), 'en', 'parseLocale: en')
eq(parseLocale(' EN '), 'en', 'parseLocale: 大小写/空白容忍')
eq(parseLocale('fr'), null, 'parseLocale: 非法值 → null')
eq(parseLocale('zh-Hans'), null, 'parseLocale: 不做前缀猜测（zh-Hans 不是 zh）')
eq(parseLocale(''), null, 'parseLocale: 空串 → null')
eq(parseLocale(undefined), null, 'parseLocale: undefined → null')
eq(parseLocale(null), null, 'parseLocale: null → null')
eq(parseLocale(42), null, 'parseLocale: 非字符串 → null')
eq(FALLBACK_LOCALE, 'en', '兜底语言 = en')
eq(resolveLocale({ client: 'zh', host: 'ja' }), 'zh', '①客户端 zh 优先于非法宿主值')
eq(resolveLocale({ client: 'en', host: 'zh' }), 'en', '①客户端 en 优先于宿主 zh')
eq(resolveLocale({ client: '', host: 'zh' }), 'zh', '②客户端空 → 落宿主 zh')
eq(resolveLocale({ client: 'fr', host: 'en' }), 'en', '②客户端非法 → 落宿主 en')
eq(resolveLocale({ client: undefined, host: undefined }), 'en', '③全空 → en')
eq(resolveLocale({}), 'en', '③空对象 → en')
eq(resolveLocale(null), 'en', '③null → en（不抛异常）')
eq(resolveLocale(undefined), 'en', '③undefined → en（不抛异常）')

console.log('── 2) 翻译回落链与参数替换 ──')
eq(t('zh', 'stageLabel.prd'), 'PRD 产品需求', 't: zh 取 zh 值')
eq(t('en', 'stageLabel.prd'), 'PRD (product requirements)', 't: en 取 en 值')
eq(t('en', 'no.such.key'), 'no.such.key', 't: 缺 key 回落 key 本身（不抛错）')
eq(t('zh', 'no.such.key'), 'no.such.key', 't: zh 缺 key 同样回落 key')
eq(t('zh', 'report.statusLine', { status: 'X', error: '' }), '状态：X', 't: {name} 参数替换')
eq(t('en', 'report.statusLine', { status: 'OK', error: ' (boom)' }), 'Status: OK (boom)', 't: en 参数替换')
eq(t('zh', 'report.statusLine', { status: 'X' }), '状态：X{error}', 't: 漏参保留占位符（可见即修）')
eq(langDirective('zh'), 'Chinese Markdown', '语言指令 zh 逐字不变（既有 prompt 契约）')
eq(langDirective('en'), 'English Markdown', '语言指令 en')
eq(phaseLabel('zh', 'prd'), PHASE_KEY_OF.prd, 'phaseLabel zh 直取 PHASE_KEY_OF（结构性零回归）')
eq(phaseLabel('en', 'prd'), 'PRD (product requirements)', 'phaseLabel en 走词典')
eq(phaseLabel('zh', '开发'), PHASE_KEY_OF.dev, 'phaseLabel 兼容存量中文阶段名')
eq(phaseLabel('zh', '不存在'), '不存在', 'phaseLabel 未知阶段原样返回（不拼假 key）')
eq(modeLabel('zh', 'lite', 'lite（轻量）'), 'lite（轻量）', 'modeLabel zh 由调用方传 MODE_REGISTRY 原值')
eq(modeLabel('en', 'lite', 'lite（轻量）'), 'lite (lightweight)', 'modeLabel en 走词典')
eq(modeDesc('en', 'bogus', 'X'), 'X', 'modeDesc 缺 key 回落调用方 zh 值')

console.log('── 3) 词典不变量（键同形 / en 无 CJK / 值非空 / 合并后键唯一）──')
const problems = dictProblems()
ok(problems.length === 0, `dictProblems 为空（实测 ${problems.length} 条${problems.length ? '：' + problems[0] : ''}）`)
const zhKeys = dictKeys('zh')
const enKeys = dictKeys('en')
ok(zhKeys.length > 0, `词典非空（zh ${zhKeys.length} 条 / en ${enKeys.length} 条）`)
ok(zhKeys.join('\u0000') === enKeys.join('\u0000'), 'zh/en key 集合完全同形')

console.log('── 4) 冻结键表（只增不改：存量 key 消失即红）──')
const FROZEN_KEYS = [
  'stageLabel.prd', 'stageLabel.qa', 'mode.lite.label', 'mode.lite.desc',
  'log.enterStage', 'log.triage', 'log.qaPass', 'log.allDone', 'log.accNoVerdict',
  'run.resume', 'run.resumeDev', 'log.branchDirty', 'err.stageFail', 'err.devFail',
  'diag.effort', 'diag.breaker', 'diag.retry', 'guard.fire', 'guard.reasonRepeat', 'guard.noticeSummary',
  'report.header', 'report.status.completed', 'report.mergeHint', 'report.stashHint', 'report.notice', 'report.listSep',
  'sanity.head', 'sanity.clean', 'state.header', 'state.runDocs', 'state.listSep',
  'tool.start.decision', 'branch.q.mainClean', 'branch.opt.keepFeature', 'err.tool.missingKindId',
  'triage.arch', 'triage.ui', 'triage.noSignal',
  'doc.engConstraints', 'doc.finalCommit', 'doc.noRevisionTable', 'log.gitignoreHeader',
]
for (const k of FROZEN_KEYS) ok(LOCALE_DICTS.zh[k] !== undefined && LOCALE_DICTS.en[k] !== undefined, `冻结 key 存在：${k}`)

console.log('── 5) 运行期语言源（推送槽 + settings 只读端口；AC-10/AC-11）──')
noteClientLocale(null)
eq(clientLocale(), null, '推送槽初始为空')
eq(ambientLocale(), 'en', '无任何来源 → en（headless 兜底）')
noteClientLocale('en')
eq(ambientLocale(), 'en', '客户端推送 en 生效')
noteClientLocale('zh')
eq(ambientLocale(), 'zh', '客户端推送 zh 生效（last-write-wins）')
noteClientLocale('fr')
eq(clientLocale(), null, '非法推送清空推送槽（不保留旧值）')
eq(ambientLocale(), 'en', '清空后回落 en')
setSettingsPort(() => 'zh')
eq(hostPreference(), 'zh', '宿主显式语言端口读到 zh')
eq(ambientLocale(), 'zh', '客户端缺位 → 宿主显式语言')
noteClientLocale('en')
eq(ambientLocale(), 'en', '客户端推送优先于宿主显式语言')
setSettingsPort(() => { throw new Error('boom') })
eq(hostPreference(), null, 'settings 端口抛异常 → null（不向上抛）')
noteClientLocale(null)
eq(ambientLocale(), 'en', '端口异常 + 无推送 → en')
setSettingsPort(null)
eq(hostPreference(), null, '端口未注入 → null')
eq(newRunLocale(), ambientLocale(), 'newRunLocale = ambientLocale（起跑快照取值一致）')
// QA-1：缺 locale 字段的补写口径——resume 一律 zh（存量文案本就是中文），新 run 用环境语言。
noteClientLocale('en')
eq(localeForMissingSnapshot(true), 'zh', 'QA-1：resume 补写 = zh（不按界面语言，不产生同 run 中英混排）')
eq(localeForMissingSnapshot(false), 'en', 'QA-1：新 run 补写 = 环境语言 en')
noteClientLocale(null)
eq(localeForMissingSnapshot(true), 'zh', 'QA-1：headless（无推送）resume 仍 = zh')
eq(runLocaleOf({}), localeForMissingSnapshot(true), 'QA-1：补写口径与 runLocaleOf 缺省一致（同一实现内不自相矛盾）')

console.log('── 6) journal.locale 往返（AC-2：快照落盘 + resume 不重解析）──')
const snap = serializeJournal({ id: 'tf-x', name: 'teamflow-pipeline', status: 'running', locale: 'en', stages: [], logs: [] })
eq(snap.locale, 'en', 'serializeJournal 透传 locale（快照随 journal 落盘）')
eq(serializeJournal({ id: 'tf-y', name: 'n', status: 'running', stages: [], logs: [] }).locale, null, '无 locale → null（不凭空造值）')
eq(runLocaleOf({ locale: 'en' }), 'en', 'runLocaleOf 读快照')
eq(runLocaleOf({ locale: 'zh' }), 'zh', 'runLocaleOf 读快照（zh）')
eq(runLocaleOf({}), 'zh', '历史 journal 缺字段 → zh（存量 run 文案本就是中文）')
eq(runLocaleOf(null), 'zh', 'null → zh（不抛异常）')
eq(runLocaleOf({ locale: 'fr' }), 'zh', '非法快照值 → zh')
eq(runCtxLocale({ __runCtx: { locale: 'en' } }), 'en', 'runCtxLocale 读 state.__runCtx.locale')
eq(runCtxLocale({ __runCtx: {} }), 'zh', 'runCtxLocale 缺字段 → zh（既有测试夹具零改动）')
// AC-2 核心场景：起跑快照 zh 后客户端切 en —— 该 run 语言不变，只有新 run 用 en
const running = { locale: 'zh' }
noteClientLocale('en')
eq(runLocaleOf(running), 'zh', '跑动中切语言：在跑 run 语言不变（AC-2）')
eq(newRunLocale(), 'en', '新 run 用新语言（AC-11）')
noteClientLocale(null)

console.log('── 7) 字面量归属门禁（旧中文文案只在词典里存在）──')
const read = (rel) => readFileSync(join(here, rel), 'utf8')
const dictText = read('../host/locales/pipeline.ts') + read('../host/locales/tools.ts')
const OWNERSHIP = [
  ['../host/core/pipeline.ts', '进入阶段：'],
  ['../host/core/pipeline.ts', '跳过已完成阶段：'],
  ['../host/core/pipeline.ts', '流水线全部完成 ✅'],
  ['../host/core/pipeline.ts', '任务夹就绪：'],
  ['../host/core/report.ts', '【团队研发流水线汇报】'],
  ['../host/core/report.ts', '合回决策：'],
  ['../host/core/report.ts', '尚未进入任何阶段'],
  ['../host/core/state.ts', '【预编译产品状态'],
  ['../host/core/state.ts', '本次任务产物夹'],
  ['../host/core/sanity.ts', '【状态核对】'],
  ['../host/core/sanity.ts', '状态核对不可用'],
  ['../host/core/runner.ts', '（机械阶段降档）'],
  ['../host/core/runner.ts', '累计新增 token'],
  ['../host/core/runner.ts', '进行中护栏中止（'],
  ['../host/core/guard.ts', '触发进行中护栏并中止本次尝试'],
  ['../host/core/guard.ts', '[token 观测]'],
  ['../host/core/guard.ts', '护栏轻提醒'],
  ['../host/core/triage.ts', '架构护栏：需求含'],
  ['../host/index.ts', '【分支决策】'],
  ['../host/index.ts', '【需求确认】'],
  ['../host/index.ts', '已请求取消流水线'],
  ['../host/index.ts', '请先通过输入框旁的'],
  ['../host/index.ts', '(未提供需求)'],
  ['../host/core/backlog.ts', '未知角色 '],
  ['../host/core/backlog.ts', '非法状态 '],
]
for (const [file, literal] of OWNERSHIP) {
  const src = read(file)
  ok(src.indexOf(literal) === -1, `归属：${literal} 已不在 ${file.split('/').pop()}`)
  ok(dictText.indexOf(literal) !== -1, `归属：${literal} 存在于 host/locales/*`)
}

console.log('── 8) 注入块按快照语言渲染（AC-3⑤：en 无 CJK；zh 逐字保留）──')
const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const mkState = (locale) => ({
  version: 1,
  projectName: null,
  updatedAt: null,
  product: { summary: 'demo product', techStack: 'TypeScript' },
  lastRunFolder: null,
  modules: { 'host/locales.ts': 'language layer' },
  verifyScripts: ['pnpm test'],
  acIndex: { 'AC-1': 'parse chain' },
  stages: { prd: 'prd done', tech: 'tech done', qa: 'qa done' },
  lastRun: { requirement: 'demo', verdict: 'completed', folder: 'docs/teamflow/x' },
  __runCtx: { locale, runDocs: 'docs/teamflow/x', sanity: '[State check] ok' },
})
const enBlock = stateSliceFor(mkState('en'), 'dev')
ok(!cjk.test(enBlock), 'en 注入块不含 CJK（含分隔符，实测首行：' + enBlock.split('\n')[0].slice(0, 40) + '）')
ok(/- Tech stack: TypeScript/.test(enBlock) && /- Modules \(1\): host\/locales\.ts/.test(enBlock), 'en 注入块条目为英文')
const zhBlock = stateSliceFor(mkState('zh'), 'dev')
ok(/- 技术栈：TypeScript/.test(zhBlock) && /- 模块（1）：/.test(zhBlock), 'zh 注入块逐字保留现状文案')
const noLocale = stateSliceFor({ ...mkState('en'), __runCtx: { runDocs: 'docs/teamflow/x' } }, 'dev')
ok(cjk.test(noLocale) && /- 技术栈：TypeScript/.test(noLocale), '缺省 __runCtx.locale → zh 分支（存量夹具零改动）')

console.log('── 9) 跨词典显示名一致性门禁（QA-5：client × host 同一文案两处维护）──')
/**
 * client/locales.ts 与 host/locales*.ts 是**两套独立机制**的词典（面不同、不合并、不互相导入），
 * 但同一批用户可见显示名（阶段名/状态词）在两侧各写一份 → 「改一处即 host 与工作台语言漂移」。
 * 这里用机器门禁把它钉住：跨词典同 zh 值的组，en 值必须一致；**有意分叉必须显式登记**（附原因）。
 * 新增重复显示名而两侧不一致 → 直接红（要么统一，要么登记进白名单并说明原因）。
 */
const DIVERGENT_OK = ['失败', '已完成', '已取消', 'PRD 产品需求', '架构规划', '产品验收', '开发']
const dGroups = new Map()
for (const [k, v] of Object.entries(clientZh)) {
  if (!dGroups.has(v)) dGroups.set(v, [])
  dGroups.get(v).push({ side: 'client', key: k, en: clientEn[k] })
}
for (const k of Object.keys(LOCALE_DICTS.zh)) {
  const v = LOCALE_DICTS.zh[k]
  if (!dGroups.has(v)) dGroups.set(v, [])
  dGroups.get(v).push({ side: 'host', key: k, en: LOCALE_DICTS.en[k] })
}
let crossGroups = 0
const unlisted = []
for (const [zhv, list] of dGroups) {
  if (new Set(list.map((x) => x.side)).size < 2) continue // 只查跨词典（同侧变体如 Retry/Retries 属正常）
  crossGroups++
  if (new Set(list.map((x) => x.en)).size > 1 && !DIVERGENT_OK.includes(zhv)) {
    unlisted.push(`「${zhv}」${list.map((x) => `${x.side}:${x.key}="${x.en}"`).join(' | ')}`)
  }
}
ok(unlisted.length === 0, `跨词典重复显示名未登记分叉 ${unlisted.length} 组${unlisted.length ? '：' + unlisted.join('；') : ''}`)
ok(crossGroups >= 12, `门禁有对象（跨词典同 zh 值显示名 ${crossGroups} 组 ≥ 12）`)
ok(clientEn['phase.prd'] === 'PRD' && LOCALE_DICTS.en['stageLabel.prd'] === 'PRD (product requirements)', '登记在案的分叉未被顺手改掉（工作台短标签 vs host 阶段全称）')

console.log('── 团队展示名双语（2026-09-15 实锤 slugkit-en：英文界面下拉里全是中文）──')
{
  // 用户数据（teams.json）不翻译，但**展示名**必须按语言可解析：存量文件没有 nameEn 字段，
  // 故内置团队按 id 回落（否则老工作区永远只有中文名）。
  const legacy = { id: 'dev', name: '软件开发', icon: '💻', description: 'PRD→设计→技术→开发→QA→验收', stages: [] }
  eq(teamNameOf('en', legacy), 'Software Development', 'en + 存量 teams.json（无 nameEn）→ 内置回落英文名')
  eq(teamDescOf('en', legacy), 'PRD → design → tech → dev → QA → acceptance', 'en + 无 descriptionEn → 内置回落英文描述')
  eq(teamNameOf('zh', legacy), '软件开发', 'zh → 中文名（逐字不变）')
  const custom = { id: 'myteam', name: '我的团队', nameEn: 'My Team', icon: '🚀', description: '自定义', descriptionEn: 'Custom pipeline', stages: [] }
  eq(teamNameOf('en', custom), 'My Team', 'en + 自定义团队显式 nameEn → 用显式值')
  eq(teamDescOf('en', custom), 'Custom pipeline', 'en + 显式 descriptionEn → 用显式值')
  eq(teamNameOf('en', { id: 'x', name: '未知团队', icon: '', description: '', stages: [] }), '未知团队', 'en + 无任何英文来源 → 回落中文名（不返回空）')
  eq(teamNameOf('en', null), '', 'null 团队不抛错')
}

console.log('── 阶段 prompt 的回复语言（2026-09-15 实锤：产物英文、工作台里阶段产物却中文）──')
{
  // 只约束产物语言是不够的：子代理的**回复文本**会作为 stage.output 存下来并显示在工作台，
  // 若 prompt 不点名回复语言，模型就跟着上下文（宿主/用户级 AGENTS.md 都是中文）走中文。
  const mk = (locale) => ({
    product: { summary: 's', techStack: 'TS' }, acIndex: { 'AC-1': 'x' }, modules: { '/a.ts': 'c' },
    verifyScripts: ['pnpm test'], stages: { prd: 'p', tech: 't', qa: 'q' },
    __runCtx: { locale, runDocs: 'docs/teamflow/x' },
  })
  const task = { title: 'T1', files: ['/a.ts'], spec: 's' }
  const en = mk('en')
  const zh = mk('zh')
  const factories = {
    prdPrompt: (s) => P.prdPrompt('r', 'p', 'tf', s),
    designPrompt: (s) => P.designPrompt('#p', 'p', 'tf', s),
    scaffoldPrompt: (s) => P.scaffoldPrompt('r', 'd', 'p', 'tf', s),
    techPrompt: (s) => P.techPrompt('#p', '', '', [], 'p', 'tf', s),
    architectPrompt: (s) => P.architectPrompt('#p', 'p', 'tf', s),
    devPrompt: (s) => P.devPrompt(task, '#t', '#p', 'p', 'tf', s),
    qaPrompt: (s) => P.qaPrompt('#p', 'd', 'p', 'tf', s, false),
    qaFixPrompt: (s) => P.qaFixPrompt([], '#q', '#t', '#p', 'p', 'tf', s),
    acceptancePrompt: (s) => P.acceptancePrompt('#p', '#q', 'd', 'p', 'tf', s, false),
    techChangePrompt: (s) => P.techChangePrompt('r', 'p', 'tf', s),
    patchConfirmPrompt: (s) => P.patchConfirmPrompt('r', 'p', 'tf', s),
  }
  const missingEn = Object.entries(factories).filter(([, f]) => !/Write your \*\*final reply\*\*[\s\S]{0,200}?in English/.test(String(f(en)))).map(([k]) => k)
  ok(missingEn.length === 0, `11 个阶段工厂的 en 回复语言=English（缺：${missingEn.length ? missingEn.join(',') : '无'}）`)
  const missingZh = Object.entries(factories).filter(([, f]) => !/Write your \*\*final reply\*\*[\s\S]{0,200}?in 中文/.test(String(f(zh)))).map(([k]) => k)
  ok(missingZh.length === 0, `11 个阶段工厂的 zh 回复语言=中文（缺：${missingZh.length ? missingZh.join(',') : '无'}）`)
}

console.log(failed === 0 ? '\n✅ locale 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
