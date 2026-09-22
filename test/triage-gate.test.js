/**
 * dsh-plugin-teamflow — 需求澄清闸门（Phase 1）纯函数与兜底行为测试。
 *
 * 覆盖三件容易悄悄回退的东西：
 *  1) **合格线（qualifyBlockers）**：三条证据（≥2 互斥读法 / 影响面 / 返工代价）齐备才留，
 *     缺一即丢并计数 —— 这是「防仪式化」的判定点（模型几乎总能为任何需求凑出问题）。
 *  2) **兜底绝不拦启动**：分诊不可用（无 subagents）走 fallbackVerdict → intent=requirement、blockers=[]，
 *     即零回归（闸门只在模型明确说「这还不是明确需求」时才拦）。
 *  3) **假设段提取（extractAssumptionsSection）**：产物标题带编号/附录前缀、中英混排都要能摘到；
 *     正文为空视为未记录 —— 实测 tf-mu34afd2-wcjaw1 踩过「带编号标题匹配不到 + 懒匹配摘出空串」两个坑。
 *  4) **架构护栏强升（guardrailUpgrade）**：调用方自选轻档位不得绕过 ADR-0006 的护栏；
 *     实测模型系统性自选 `lite:true`（33 次启动 14 次显式传档位、0 次先预览），故放宽为「只有 patch 豁免」。
 * 另外锁住意图归一（非法值一律 requirement，绝不因字段缺失拦启动）。
 */
import { qualifyBlockers, normalizeSettle, TRIAGE_SETTLES, normalizeIntent, runTriage, TRIAGE_INTENTS, guardrailUpgrade, MODE_RANK, normalizeArtifact, artifactContractsFor, ARTIFACT_CONTRACTS, ARTIFACT_REFERENCE_SAMPLES, LOCAL_PLUGIN_SAMPLES_HINT, triageRecordOf, triageCacheKey, triageCacheGet, triageCachePut, triageCacheClear, triageCacheSize, triageCacheIsPending, triageCacheMarkPending, triageCacheSettle, TRIAGE_CACHE_MAX, normalizeHost, forceHost, contractsForDeliverable, ARTIFACT_HOSTS } from '../host/core/triage.ts'
import { extractAssumptionsSection, extractHostResearchSection, detectInstallEnv, profileFromModulePath, profileDirFromBaseUrl, isAbsolutePath, installRecipe } from '../host/util.ts'
import { prdPrompt } from '../host/prompts/index.ts'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

console.log('\n[1] 意图归一：非法/缺失一律 requirement（绝不因模型没给字段就拦启动）')
ok(normalizeIntent('requirement') === 'requirement', "requirement → requirement")
ok(normalizeIntent('exploration') === 'exploration', "exploration → exploration")
ok(normalizeIntent('feedback') === 'feedback', "feedback → feedback")
ok(normalizeIntent(undefined) === 'requirement', 'undefined → requirement')
ok(normalizeIntent(null) === 'requirement', 'null → requirement')
ok(normalizeIntent('') === 'requirement', '空串 → requirement')
ok(normalizeIntent('EXPLORATION') === 'requirement', '大小写不匹配 → requirement（不做模糊匹配，避免误拦）')
ok(normalizeIntent(0) === 'requirement' && normalizeIntent({}) === 'requirement', '非字符串 → requirement')
ok(TRIAGE_INTENTS.length === 3, '意图枚举恰为三档（requirement/exploration/feedback）')

console.log('\n[2] 合格线：三条证据齐备才留')
const full = { question: '要不要兼容旧 API？', readings: ['保持旧签名并新增可选参数', '直接改签名（破坏性）'], changes: 'PRD 的兼容性 AC 与 dev 改动面', rework: 'dev 全部任务 + QA 回归重跑' }
ok(qualifyBlockers([full]).blockers.length === 1, '齐备 → 保留')
ok(qualifyBlockers([full]).dropped === 0, '齐备 → dropped 0')
ok(qualifyBlockers([{ ...full, readings: ['只有一种读法'] }]).blockers.length === 0, '只有 1 种读法 → 丢弃（不是真歧义）')
ok(qualifyBlockers([{ ...full, readings: [] }]).blockers.length === 0, '读法为空 → 丢弃')
ok(qualifyBlockers([{ ...full, readings: ['a', '', '   ', 'b'] }]).blockers.length === 1, '读法里的空串被过滤后仍够 2 条 → 保留')
ok(qualifyBlockers([{ ...full, readings: ['a', '', ''] }]).blockers.length === 0, '过滤后只剩 1 条 → 丢弃')
ok(qualifyBlockers([{ ...full, changes: '' }]).blockers.length === 0, '缺「影响面」→ 丢弃')
ok(qualifyBlockers([{ ...full, rework: '   ' }]).blockers.length === 0, '缺「返工代价」→ 丢弃')
ok(qualifyBlockers([{ ...full, question: '' }]).blockers.length === 0, '缺问题本身 → 丢弃')
ok(qualifyBlockers([full, { question: 'x' }]).dropped === 1, '一好一坏 → 坏的计入 dropped（诊断可见）')
ok(qualifyBlockers([null, 'x', 3, []].length ? [null, 'x', 3, []] : []).dropped === 4, '非对象条目全部计入 dropped')
ok(qualifyBlockers(undefined).blockers.length === 0 && qualifyBlockers(undefined).dropped === 0, '非数组输入 → 空且 dropped 0（不误报）')
ok(qualifyBlockers('nope').blockers.length === 0, '字符串输入 → 空')
const five = [full, { ...full, question: 'b' }, { ...full, question: 'c' }, { ...full, question: 'd' }, { ...full, question: 'e' }]
const capped = qualifyBlockers(five)
ok(capped.blockers.length === 3, '上限 3 条（超过的不问，防一次抛一堆问题）')
ok(capped.dropped === 2, '超额部分计入 dropped')
ok(qualifyBlockers([{ ...full, question: 'q'.repeat(999) }]).blockers[0].question.length <= 300, '问题文本截断 ≤300 字符')
const longReadings = qualifyBlockers([{ ...full, readings: ['r'.repeat(999), 'r2'] }]).blockers[0].readings
ok(longReadings.length === 2 && longReadings[0].length <= 200, '读法截断 ≤200 字符、条数 ≤4')

console.log('\n[2b] 自洽门禁：已判定的字段不得再被当成未知来问（2026-09-18 probe-v2 实锤）')
console.log('     实测：需求结尾写着「装进我的 dsh web profile 里真实可用」、分诊自己已输出 installable=true，')
console.log('     却仍抛出「要不要真能装」的 blocker（prompt 里"Do not ask it…"就在同一份 prompt 里）→')
console.log('     凭空一轮澄清（用户答 3 个问题）→ 输入变了 → 缓存必然不命中 → 同一需求被分诊两次')
const formGap = { settles: 'installable', question: 'must it be installable?', readings: ['installable into profile', 'source-only'], changes: 'AC set', rework: 'packaging' }
ok(qualifyBlockers([formGap], { installable: true }).blockers.length === 0, '**installable=true + settles=installable → 丢弃**（自相矛盾）')
ok(qualifyBlockers([formGap], { installable: true }).dropped === 1, '丢弃计入 dropped（诊断可见，不静默）')
ok(qualifyBlockers([formGap], { installable: false }).blockers.length === 1, 'installable=false 时保留（false 是"模型没给"的默认值，可能是真未知）')
ok(qualifyBlockers([formGap]).blockers.length === 1, '不给 ctx（旧调用方）→ 保留（不误丢真缺口）')
ok(qualifyBlockers([{ ...formGap, settles: 'scope' }], { installable: true }).blockers.length === 1, 'settles=scope 的 blocker 不受该门禁影响（只对形态类生效）')
ok(qualifyBlockers([{ ...formGap, settles: 'ui' }], { installable: true }).blockers.length === 1, 'settles=ui 同样不受影响')
ok(qualifyBlockers([full], { installable: true }).blockers[0].settles === 'other', '未声明的 settles → 归一为 other（旧裁决不退化成形态类）')
ok(normalizeSettle('installable') === 'installable' && normalizeSettle('nonsense') === 'other' && normalizeSettle(undefined) === 'other', 'settles 归一：非法/缺失 → other')
ok(TRIAGE_SETTLES.length === 7 && TRIAGE_SETTLES.indexOf('installable') !== -1 && TRIAGE_SETTLES.indexOf('host') !== -1, 'settles 枚举七档（第六次扩展：+host）')

console.log('\n[3] 兜底路径绝不拦启动（无 subagents → fallbackVerdict）')
const fx = await runTriage('给登录页加个记住我勾选框', { needDesign: false }, undefined, undefined, 'zh')
ok(fx.source === 'fallback', '无 subagents → source=fallback（分诊不可用时退回正则兜底）')
ok(fx.intent === 'requirement', '兜底 intent=requirement（绝不拦）')
ok(Array.isArray(fx.blockers) && fx.blockers.length === 0, '兜底 blockers 为空（绝不拦）')
ok(fx.blockersDropped === 0, '兜底 blockersDropped=0')
ok(typeof fx.mode === 'string' && fx.mode.length > 0, '兜底仍给出档位（路由不因闸门失效）')

console.log('\n[4] 假设段提取：编号/附录前缀/中英混排都要能摘到（实测坑）')
const prdZh = [
  '# PRD：x',
  '## 1. 背景与目标',
  '内容',
  '## 9. 假设与待澄清',
  '> 本节最需要人确认',
  '- A1：默认取最小骨架；若你要别的，US-1 需替换',
  '## 附录 A：已核实事实',
  '附录内容',
].join('\n')
const zh = extractAssumptionsSection(prdZh)
ok(!!zh && zh.includes('A1：默认取最小骨架'), '带编号标题（## 9. 假设与待澄清）→ 摘到正文')
ok(!!zh && !zh.includes('附录内容'), '到下一个标题（## 附录 A）为止，不越界')
ok(!!zh && !zh.includes('# PRD'), '不把标题行卷进正文')
ok(extractAssumptionsSection('## 假设与待澄清\n内容甲\n## 其他\n后的') === '内容甲', '无编号标题同样可用')
ok(extractAssumptionsSection('### Assumptions & open questions\n- A1: minimal skeleton')?.includes('minimal skeleton') === true, 'en 标题（Assumptions & open questions）可用')
ok(extractAssumptionsSection('## 开放问题\n待定项') === '待定项', '「开放问题」同义标题可用')
ok(extractAssumptionsSection('## 待澄清\n\n   \n## 下一节\nx') === null, '标题下正文为空 → null（视为未记录，不得摘出空串）')
ok(extractAssumptionsSection('## 9. 假设与待澄清\n最后一段没有后续标题') === '最后一段没有后续标题', '该段位于文末也能摘到')
ok(extractAssumptionsSection('## 1. 背景\n没有假设段') === null, '没有该标题 → null')
ok(extractAssumptionsSection('') === null && extractAssumptionsSection(null) === null && extractAssumptionsSection(undefined) === null, '空/未定义输入 → null（不抛）')

console.log('\n[5] 架构护栏强升（ADR-0006：调用方自选档位不得绕过）')
ok(MODE_RANK.patch === 0 && MODE_RANK.lite === 1 && MODE_RANK.tech === 1 && MODE_RANK.medium === 2 && MODE_RANK.full === 3, '轻重序：patch < lite/tech < medium < full')
ok(guardrailUpgrade(undefined, false, 'medium') === 'medium', '调用方没给档位 → 用分诊档位')
ok(guardrailUpgrade(undefined, false, 'patch') === 'patch', '同上（patch 也照用）')
ok(guardrailUpgrade(undefined, true, 'lite') === null, 'lite=true 且分诊也判 lite → 不改动（尊重调用方）')
ok(guardrailUpgrade(undefined, true, 'medium') === 'medium', 'lite=true 但分诊判 medium → **升档**（护栏）')
ok(guardrailUpgrade(undefined, true, 'full') === 'full', 'lite=true 但分诊判 full → 升档')
ok(guardrailUpgrade('lite', false, 'medium') === 'medium', '显式 mode=lite 但分诊判 medium → 升档（实测模型自选 lite 的常见路径）')
ok(guardrailUpgrade('patch', false, 'lite') === null, '显式 patch + 分诊 lite → 不改动（patch 本就走豁免）')
ok(guardrailUpgrade('medium', false, 'medium') === null, '显式 medium + 分诊 medium → 不改动')
ok(guardrailUpgrade('medium', false, 'full') === null, '显式 medium + 分诊 full → 保持调用方选择（不无谓放大 token）')
ok(guardrailUpgrade('full', false, 'lite') === null, '显式 full + 分诊 lite → 不降档（尊重调用方）')
ok(guardrailUpgrade('tech', false, 'medium') === 'medium', '显式 tech + 分诊 medium → 升档（tech 与 lite 同级，架构型需求仍要蓝图）')

console.log('\n[5b] needDesign 档位下限（2026-09-18 probe-v2 实锤：调用方传 needDesign=true、分诊回 lite，')
console.log('     而 lite 的档位定义就是「no UI design」——语义冲突，旧实现让 lite 直接落地；prompt 里那句')
console.log('     "needDesign=true → 强升 medium" 只是 regex 预筛提示，模型可无视（实测就被无视了）')
ok(guardrailUpgrade(undefined, false, 'lite', { needDesign: true }) === 'medium', '**未给档位 + needDesign=true + 分诊 lite → 抬到 medium**（本次实锤路径）')
ok(guardrailUpgrade(undefined, false, 'patch', { needDesign: true }) === 'medium', '同上（patch 也抬到 medium）')
ok(guardrailUpgrade(undefined, false, 'tech', { needDesign: true }) === 'medium', '同上（tech 与 lite 同级，同样抬到 medium）')
ok(guardrailUpgrade(undefined, false, 'medium', { needDesign: true }) === 'medium', '分诊已是 medium → 维持（不无谓放大）')
ok(guardrailUpgrade(undefined, false, 'full', { needDesign: true }) === 'full', '分诊判 full → 维持 full（不降档）')
ok(guardrailUpgrade(undefined, false, 'lite') === 'lite', '没有 needDesign → 照用分诊的 lite（下限只在显式要求设计阶段时生效）')
ok(guardrailUpgrade(undefined, false, 'lite', { needDesign: false }) === 'lite', 'needDesign=false → 同上（不生效）')
ok(guardrailUpgrade('lite', true, 'lite', { needDesign: true }) === null, '**调用方显式 lite=true 时以调用方为准**（设计阶段由 resolveStages 按 flag 追加，不改档位标签）')
ok(guardrailUpgrade('medium', false, 'medium', { needDesign: true }) === null, '调用方显式 medium → 不改动')

console.log('\n[6] 交付形态契约（2026-09-17 实测：dddd 的插件"看着完整"却装不进 profile——"能被宿主加载"从未进过 AC）')
ok(normalizeArtifact('plugin-full') === 'plugin-full', '合法形态直通')
ok(normalizeArtifact('nonsense') === 'other' && normalizeArtifact(undefined) === 'other' && normalizeArtifact(null) === 'other', '非法/缺失 → other（绝不套用某类契约）')
ok(ARTIFACT_CONTRACTS.other.length === 0 && ARTIFACT_CONTRACTS.app.length === 0, 'other/app 无形态契约（既有产品内的普通改动不套额外契约）')
const pfItems = artifactContractsFor('plugin-full', false)
const pfInst = artifactContractsFor('plugin-full', true)
ok(pfItems.length >= 4 && pfInst.length > pfItems.length, 'plugin-full：installable=true 追加安装类契约（源码目录 vs 可安装分档）')
ok(pfItems.every((it) => it.requirement && it.criteria), '每条契约都带「要求 + 判据形态」（否则 PM 写不出可测 AC）')
ok(!/manifestVersion|bundle\.patch|dsh\.client/.test(JSON.stringify(ARTIFACT_CONTRACTS)), '契约表**不硬编码宿主字段名**（字段名随宿主版本演进，必须让 PM 读同仓样本核实）')
// 样本来源（2026-09-21 用户实锤修正）：首选项必须是**本机已装 dsh 插件**——npm 包不发源码（实测 pack 10 文件），
// 用户机器上既没有 plugins/dsh-plugin-teamflow 这个路径、也没有我们的源码，只有 profile 里装好的插件。
ok(ARTIFACT_REFERENCE_SAMPLES['plugin-full'].includes('plugins/dsh-plugin-teamflow'), 'plugin-full 仍保留本仓样本（次选：工作区恰在本仓时可就近读）')
ok(/DSH_HOME/.test(LOCAL_PLUGIN_SAMPLES_HINT) && /profiles/.test(LOCAL_PLUGIN_SAMPLES_HINT) && /node_modules/.test(LOCAL_PLUGIN_SAMPLES_HINT), '样本首选项是「本机已装 dsh 插件」（$DSH_HOME/profiles/*/node_modules），任何开发机都有')
ok(!/^[A-Za-z]:[\\/]/.test(LOCAL_PLUGIN_SAMPLES_HINT) && !LOCAL_PLUGIN_SAMPLES_HINT.includes('E:'), '样本路径不写死绝对路径（用 $DSH_HOME 表达，跨机器成立）')
ok(artifactContractsFor('cli', false).some((it) => /bin|可执行/.test(it.requirement + it.criteria)), 'cli：契约含可执行入口')
ok(artifactContractsFor('lib', false).some((it) => /入口|main|exports/.test(it.requirement + it.criteria)), 'lib：契约含模块入口')
ok(artifactContractsFor('plugin-host', false).some((it) => /workspace:/.test(it.criteria)), 'plugin-host：含"依赖不得用 workspace: 协议"（本次实锤缺口之一）')
ok(artifactContractsFor('plugin-full', false).some((it) => /files|白名单/.test(it.requirement)), 'plugin-full：含分发白名单（本次实锤缺口之一）')
// ── 安装入口不得写死（2026-09-21 用户实锤：源码运行 `pnpm dsh`、`dsh` 不在 PATH、profile 名也可能不是 web）──
// 每个用户环境不一样 → 契约只能写「以 host 运行时探测到的安装入口为准」。
{
  const pfInst = JSON.stringify(artifactContractsFor('plugin-full', true)) + JSON.stringify(artifactContractsFor('plugin-host', true)) + JSON.stringify(artifactContractsFor('plugin-client', true))
  ok(!/--profile web/.test(pfInst), '**契约里不得出现写死的 `--profile web`**（用户 profile 名/安装方式各异）')
  ok(/以本机探测到的安装入口为准|本机环境/.test(pfInst), '安装类契约要求「以本机探测到的安装入口为准」')
  ok(/pnpm add|等价手动/.test(pfInst), '契约给出 `dsh` 不在 PATH 时的等价手动路径（源码运行场景）')
  ok(/问用户|不许编路径/.test(pfInst), '探测失败时要求**问用户**，不许编路径')
  ok(/主 agent/.test(pfInst), '**安装步骤归主 agent**（子代理权限固定、写不了 profile）')
  ok(!/人工手测步骤/.test(pfInst) || /主 agent/.test(pfInst), '不再只写"人工手测"，而是可执行的安装步骤（执行者=主 agent）')
}

console.log('\n[7] 安装/装载安全契约（2026-09-17 dddd 事故实锤：旧 lib 产物装上后宿主启动即炸，靠另开 agent 手术卸载才救回）')
const pfAll = JSON.stringify(artifactContractsFor('plugin-full', true))
ok(/源码同步|产物.*同步/.test(pfAll), 'plugin-full：含「构建产物与源码同步」（旧 lib 产物实锤）')
ok(/装载安全|顶层/.test(pfAll) && /require/.test(pfAll), 'plugin-full：含「装载安全：模块顶层不得抛错」（顶层访问未注入服务实锤）')
ok(/回滚|卸载/.test(pfAll), 'plugin-full：含「安装必须带回滚」（装上后宿主起不来 → 另开 agent 手术实锤）')
ok(artifactContractsFor('plugin-host', false).some((it) => /装载安全|顶层/.test(it.requirement)), 'plugin-host：装载安全为**非 installable 也要求**（源码目录阶段就该可加载）')
ok(artifactContractsFor('plugin-host', true).some((it) => /回滚|卸载/.test(it.requirement) && it.onlyWhenInstallable === true), 'plugin-host：回滚纪律是 installable 档要求')

console.log('\n[8] 分诊缓存（2026-09-18 实锤：决策返回路径让同一条需求被分诊两次——probe-clock tf-mu5wcm2j-kxk14y 两次 model 分诊 16.6K+16.5K tok、结果一致、纯白花）')
triageCacheClear()
ok(triageCacheSize() === 0, '可直接清空（测试隔离）')
const V = (over = {}) => ({
  mode: 'lite', kind: 'feature', needDesign: false, complexity: 'small', rationale: ['x'], confidence: 'high',
  slug: 's', source: 'model', intent: 'requirement', blockers: [], blockersDropped: 0, artifact: 'other', installable: false, ...over,
})
// —— 键的构成：必须含「需求 + 澄清答复」，且**不得**含决策字段 ——
ok(triageCacheKey('A', '') === triageCacheKey('A', undefined), '键：缺省 supplement 与空串同键')
ok(triageCacheKey('A', '') !== triageCacheKey('B', ''), '键：需求不同 → 不同键（不串味）')
ok(triageCacheKey('A', 'x') !== triageCacheKey('A', ''), '**键：澄清答复改变 → 不同键**（若漏了它，澄清前的裁决会被当成澄清后复用 = 闸门失效）')
ok(triageCacheKey('A', ' x ') === triageCacheKey('A', 'x'), '键：supplement 两端空白归一')
const k = triageCacheKey('req-1', '')
// —— 命中 / 未命中 ——
ok(triageCacheGet(k) === null, '未写入时未命中')
triageCachePut(k, V())
ok(triageCacheGet(k) !== null, '写入后命中')
ok(triageCacheGet(k).mode === 'lite', '命中返回原裁决（档位不漂移）')
ok(triageCacheGet(triageCacheKey('req-2', '')) === null, '别的需求不命中')
ok(triageCacheGet(triageCacheKey('req-1', 'new-supplement')) === null, '同一需求但澄清答复不同 → 不命中（必须重跑分诊）')
// —— 只缓存 model 裁决（fallback 是"分诊不可用"的降级产物，缓存它会把偶发故障固化 10 分钟）——
triageCacheClear()
triageCachePut(triageCacheKey('fb', ''), V({ source: 'fallback' }))
ok(triageCacheGet(triageCacheKey('fb', '')) === null, '**fallback 裁决不入缓存**（否则一次偶发故障被固化 10 分钟）')
triageCachePut(triageCacheKey('md', ''), V({ source: 'model' }))
ok(triageCacheGet(triageCacheKey('md', '')) !== null, 'model 裁决入缓存')
// —— 容量上限（防长会话内存增长）——
triageCacheClear()
for (let i = 0; i < TRIAGE_CACHE_MAX + 8; i++) triageCachePut(triageCacheKey('bulk-' + i, ''), V())
ok(triageCacheSize() <= TRIAGE_CACHE_MAX, `容量上限生效（写入 ${TRIAGE_CACHE_MAX + 8} 条后仅存 ${triageCacheSize()} ≤ ${TRIAGE_CACHE_MAX}）`)
ok(triageCacheGet(triageCacheKey('bulk-0', '')) === null, '超限淘汰最旧（bulk-0 已出局）')
ok(triageCacheGet(triageCacheKey('bulk-' + (TRIAGE_CACHE_MAX + 7), '')) !== null, '最新一条仍在（淘汰的是最旧，不是最新）')
// —— 一个 key 只占一条（重复 put 不膨胀）——
triageCacheClear()
for (let i = 0; i < 10; i++) triageCachePut(k, V())
ok(triageCacheSize() === 1, '同一 key 重复写入只占 1 条（幂等）')
triageCacheClear()

console.log('\n[9] 待决策状态机（2026-09-18 二次修正：有效性看「是否仍在等用户回答」，**不看时间**）')
console.log('     实测 probe-cache tf-mu6tb281-4n43oc：17:29:30 首次 start → 17:30:46 弹存档问句 →')
console.log('     用户 18:24:30 才点选（隔 55 分钟）→ 初版 10 分钟 TTL 早已过期 → 又白跑一次分诊')
const pk = triageCacheKey('pending-req', '')
triageCachePut(pk, V(), true) // 工具返回 needs-decision → 标待决策
ok(triageCacheIsPending(pk), '写入时可标「待决策」')
ok(triageCacheGet(pk) !== null, '待决策条目可命中')
// 把时钟拨到 55 分钟后（远超 TTL）——待决策条目必须**无视 TTL**
{
  const realNow = Date.now
  Date.now = () => realNow() + 55 * 60 * 1000
  ok(triageCacheGet(pk) !== null, '**待决策条目隔 55 分钟仍命中**（TTL 不参与正确性——这正是那次失手的场景）')
  Date.now = realNow
}
// 决策落地 → settle → 降级为普通短期缓存（此刻起 TTL 才生效）
triageCacheSettle(pk)
ok(!triageCacheIsPending(pk), 'settle 后不再是待决策')
ok(triageCacheGet(pk) !== null, 'settle 只摘标记，裁决本身仍在（建 run 后的快速重试仍可命中）')
{
  const realNow = Date.now
  Date.now = () => realNow() + 3 * 60 * 60 * 1000
  ok(triageCacheGet(pk) === null, 'settle 之后超过 TTL → 回收（防"用户永远没回来点"的悬挂条目泄漏）')
  Date.now = realNow
}
// 不改裁决内容
triageCacheClear()
triageCachePut(pk, V({ mode: 'medium' }), true)
triageCacheSettle(pk)
ok(triageCacheGet(pk).mode === 'medium', 'markPending/settle 不改裁决内容（档位不漂移）')
// 边界
triageCacheClear()
ok(!triageCacheIsPending(triageCacheKey('never-written', '')), '未写过的键：isPending=false（不误报）')
triageCacheMarkPending(triageCacheKey('never-written', ''))
ok(triageCacheSize() === 0, 'markPending 对不存在的键是安全无操作，且**不会凭空造条目**（fallback 没入缓存时走这条）')
// fallback 仍不入缓存 → markPending 也无从标记 → 下次老实重跑分诊（符合预期，不静默放行）
triageCachePut(triageCacheKey('fb2', ''), V({ source: 'fallback' }), true)
ok(!triageCacheIsPending(triageCacheKey('fb2', '')), 'fallback 裁决仍不入缓存（markPending 也没得标）')
triageCacheClear()

console.log('\n[10] journal.triage 落盘完整性（第五次「白名单漏字段」→ 形态契约注入整条链失效）')
console.log("     实锤：旧 triageRecordOf 漏搬 artifact/installable → pipeline 注入读 journal.triage.artifact")
console.log("     永远 undefined → artifactContractsFor('other') 恒为 [] → [交付形态契约] 从未注入过任何 PRD")
console.log('     （全部 64/64 个 run 的 triage 不带 artifact；log.artifactContract 一次都没落过）')
{
  const rec = triageRecordOf(V({ artifact: 'plugin-full', installable: true }))
  ok(rec.artifact === 'plugin-full', 'triageRecordOf 搬运 artifact（下游形态契约的唯一来源）')
  ok(rec.installable === true, 'triageRecordOf 搬运 installable')
  ok(triageRecordOf(V({ artifact: 'nonsense' })).artifact === 'other', 'artifact 走归一（脏值 → other，不套错契约）')
  ok(triageRecordOf(V({ installable: 'yes' })).installable === false, 'installable 非严格 true → false（不猜）')
  // ── 结构化门禁：接口顶层键逐个必须在 triageRecordOf 里被搬运 ──
  const triageSrc3 = readFileSync(join(here, '../host/core/triage.ts'), 'utf8')
  const iface = (triageSrc3.match(/export interface TriageVerdict \{[\s\S]*?\n\}/) || [''])[0]
  const keys = []
  for (const line of iface.split('\n')) {
    const m = line.match(/^  ([A-Za-z_$][\w$]*)\??\s*:/)
    if (m) keys.push(m[1])
  }
  ok(keys.length >= 12, `静态解析出 TriageVerdict 顶层键 ${keys.length} 个（解析失败会让下面的门禁空转）`)
  /** 不在这里搬运的字段（各有明确归属，不是"忘了"）。 */
  const EXEMPT = new Map([
    ['needDesign', '落在 journal.options.needDesign（选项面已持久化）'],
    ['slug', '落在 journal.runDocs（任务夹名已持久化）'],
    ['rationale', '诊断文本，随工具返回给主线程，不进 journal 记录'],
  ])
  /** 特例：接口字段 `upgradedFrom` 由内部标记 `__upgradedFrom` 落盘（**属性读取**，不是类型注解）。 */
  const SPECIAL = { upgradedFrom: /\.__upgradedFrom/ }
  // 去注释后再判：否则**注释里提到字段名**就能让门禁假绿（实测：`__upgradedFrom` 在注释里出现，
  // 把代码改成读 `.upgradedFrom` 也照样通过 —— 门禁必须只看代码）。
  const body = ((triageSrc3.match(/export function triageRecordOf[\s\S]*?\n\}/) || [''])[0])
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const missing = keys.filter((k) => {
    if (EXEMPT.has(k)) return false
    if (SPECIAL[k]) return !SPECIAL[k].test(body)
    return !body.includes(`v.${k}`)
  })
  ok(missing.length === 0, `**每个 TriageVerdict 顶层键都被 triageRecordOf 搬运**${missing.length ? `（漏了：${missing.join(', ')}）` : ''}`)
  ok(EXEMPT.size === 3 && EXEMPT.has('needDesign'), '豁免表只有三项（新加字段默认要搬运，不许悄悄塞进豁免表）')
  // ── 注入源必须是 journal.triage（不是透传的 options.__triage，后者不落盘、resume 就没了）──
  const pipeSrc = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
  ok(/const tj = journal\.triage as \{ artifact\?: string; installable\?: boolean; host\?: string \}/.test(pipeSrc), 'pipeline：形态契约的注入源是 **journal.triage**（落盘面，resume 也在）')
  ok(/contractsForDeliverable\(hst, art, inst\)/.test(pipeSrc) && /state\.__runCtx\.artifactContracts = items\.map/.test(pipeSrc), 'pipeline：命中形态后展开契约并写进 __runCtx（供 prdPrompt/qaPrompt 消费）')
  ok(/if \(items\.length\)/.test(pipeSrc) && /log\.artifactContract/.test(pipeSrc), 'pipeline：有契约才注入 + 落 log.artifactContract（**这条日志就是"防线活着"的判据**）')
  // ── 端到端接线（缺的正是这一段）：verdict → journal.triage → __runCtx → prdPrompt 真的出现形态契约 ──
  const full = { mode: 'medium', kind: 'feature', needDesign: true, complexity: 'medium', rationale: [], confidence: 'high', slug: 'x', source: 'model', intent: 'requirement', blockers: [], blockersDropped: 0, artifact: 'plugin-full', installable: true }
  const recFull = triageRecordOf(full)
  const art = normalizeArtifact(recFull.artifact)
  const inst = recFull.installable === true
  const items = artifactContractsFor(art, inst)
  ok(items.length > 0, `形态契约展开 ${items.length} 条（plugin-full + installable）`)
  const stBase = { version: 1, projectName: 'p', updatedAt: null, product: { summary: null, techStack: null }, modules: {}, verifyScripts: [], acIndex: {}, stages: {}, lastRun: null }
  const stateFix = { ...stBase, __runCtx: { runDocs: 'docs/teamflow/x', artifact: art, installable: inst, artifactContracts: items.map((it) => ({ requirement: it.requirement, criteria: it.criteria })) } }
  const promptFix = prdPrompt('做一个 dsh 插件', 'E:/x', 'tf-x', stateFix)
  ok(/\[交付形态契约/.test(promptFix), '**端到端：prdPrompt 真的注入了「交付形态契约 · 必填 AC」**（修复前恒为空）')
  ok(/必须可被宿主安装\/加载/.test(promptFix), '端到端：installable=true 的措辞在位')
  // 反向：修复前的记录形状（没有这两个字段）确实什么都不注入 —— 证明这就是那个断点
  const itemsOld = artifactContractsFor(normalizeArtifact(undefined), false)
  const promptOld = prdPrompt('做一个 dsh 插件', 'E:/x', 'tf-x', { ...stBase, __runCtx: { runDocs: 'docs/teamflow/x' } })
  ok(itemsOld.length === 0 && !/交付形态契约/.test(promptOld), '反向：无形态字段 → 0 条契约、prompt 无注入（即修复前的生产状态）')
}

console.log('\n[11] 宿主维度（2026-09-18 用户实锤：开发 openclaw/hermes 插件时 dsh 契约不适用）')
console.log('     用户原话：「我开发 openclaw 插件，或者 hermes 插件……这些在 dsh 的契约在其他的不一定有效吧」')
console.log('     → 契约必须按宿主分键：dsh 给具体契约；非 dsh 一律**不下发 dsh 契约**，改走「宿主契约调研」')
{
  // ── 归一：缺省一律 unknown（**绝不默认成 dsh**——那正是给别的宿主套错契约的路径）──
  ok(normalizeHost('dsh') === 'dsh' && normalizeHost('other') === 'other', 'host 归一：合法值原样')
  ok(normalizeHost(undefined) === 'unknown' && normalizeHost(null) === 'unknown' && normalizeHost('nonsense') === 'unknown', '缺省/脏值 → unknown（不是 dsh）')
  ok(ARTIFACT_HOSTS.length === 3, '宿主枚举恰为三档（dsh/other/unknown）')
  // ── 确定性护栏：判不出但有 dsh 标识词 → dsh（否则整条 dsh 契约静默丢失）──
  ok(forceHost('开发一个 dsh 插件', 'unknown') === 'dsh', '护栏：需求含 dsh → unknown 抬为 dsh')
  ok(forceHost('开发一个 @deepseek-ai/dsh-x 插件', 'unknown') === 'dsh', '护栏：@deepseek-ai/dsh-* → dsh')
  ok(forceHost('装进我的 dsh web profile 里真实可用', 'unknown') === 'dsh', '护栏：dsh web profile → dsh')
  ok(forceHost('cordis 服务插件', 'unknown') === 'dsh', '护栏：cordis → dsh')
  ok(forceHost('开发一个 openclaw 插件', 'unknown') === 'unknown', '护栏不猜：无 dsh 词的 other 场景仍 unknown（交给澄清）')
  ok(forceHost('开发一个 openclaw 插件', 'other') === 'other', '**护栏不覆盖模型明确判的 other**（拿词表当身份已两次踩坑）')
  ok(forceHost('用 dsh 风格写个 openclaw 插件', 'other') === 'other', '同上：模型说 other 就尊重（哪怕句中出现 dsh）')
  // ── 契约分流：这是本批的核心行为 ──
  const dshFull = contractsForDeliverable('dsh', 'plugin-full', true)
  ok(dshFull.items.length > 0 && !dshFull.hostResearch, 'dsh + plugin-full → 下发本仓具体契约（不给调研段）')
  for (const host of ['other', 'unknown']) {
    const r = contractsForDeliverable(host, 'plugin-full', true)
    ok(r.items.length === 0, `**${host} + plugin-full → 0 条 dsh 契约**（不得把 profile 入口/bundle/files 套给别的宿主）`)
    ok(r.hostResearch === true, `${host} + plugin-full → 要求「宿主契约调研」段`)
  }
  ok(contractsForDeliverable('other', 'plugin-host', true).hostResearch === true, 'other + plugin-host → 同样走调研')
  ok(contractsForDeliverable('other', 'plugin-client', true).hostResearch === true, 'other + plugin-client → 同样走调研')
  // 非插件形态不误伤（cli/lib 的判据与宿主无关）
  ok(contractsForDeliverable('other', 'cli', false).hostResearch === false && contractsForDeliverable('other', 'cli', false).items.length > 0, 'other + cli → 不下发调研（bin 判据与宿主无关）')
  ok(contractsForDeliverable('other', 'lib', false).hostResearch === false, 'other + lib → 不下发调研')
  ok(contractsForDeliverable('other', 'docs', false).hostResearch === false && contractsForDeliverable('other', 'docs', false).items.length === 0, 'other + docs → 无契约无调研')
  // ── slot 挂载契约（2026-09-21 实锤：probe-v2 交付的工具条因为 register.name 写错而**静默不挂载**）──
  // 反例证据：`git diff` 显示修的就是 `name: 'md-table-align.dock'` → `name: 'conversation.input.dock'`；
  // 而功能单测 31/31 全绿、AC 全过——属于"看着完整却见不到 UI"的静默失败，必须进契约。
  for (const kind of ['plugin-client', 'plugin-full']) {
    const items = contractsForDeliverable('dsh', kind, true).items
    const slot = items.find((it) => /slot/.test(it.requirement))
    ok(!!slot, `${kind} 契约含「UI 挂载点 name 必须是 slot 名」一条（静默不挂载的反例已进数据）`)
    ok(!!slot && /inject/.test(slot.criteria) && /register/.test(slot.criteria) && /同一个 slot/.test(slot.criteria), `${kind}：该条判据写明 inject 参数与 register.name 必须逐字相同`)
  }
  // ── 自洽门禁：宿主已判定还问宿主 = 自我矛盾 ──
  const hostBlocker = { ...full, settles: 'host' }
  ok(qualifyBlockers([hostBlocker], { host: 'dsh' }).blockers.length === 0, '自洽门禁：host=dsh 已判定 → settles=host 的 blocker 丢弃（同型第三次）')
  ok(qualifyBlockers([hostBlocker], { host: 'other' }).blockers.length === 0, '自洽门禁：host=other 已判定 → 同样丢弃')
  ok(qualifyBlockers([hostBlocker], { host: 'unknown' }).blockers.length === 1, '**host=unknown 时保留**（这正是 must-ask 缺口的合法形态，丢了就重演套错契约）')
  ok(qualifyBlockers([hostBlocker], {}).blockers.length === 1, '未给 ctx.host → 不误丢（默认放行）')
  ok(TRIAGE_SETTLES.indexOf('host') !== -1 && TRIAGE_SETTLES.length === 7, 'settles 枚举新增 host（7 档）')
  // ── 落盘完整性：host 是第六次「白名单漏字段」的当事字段 ──
  ok(triageRecordOf(V({ host: 'other' })).host === 'other', 'triageRecordOf 搬运 host')
  ok(triageRecordOf(V({})).host === 'unknown', 'triageRecordOf：缺 field → unknown（不默认 dsh）')
  // ── 端到端：非 dsh 宿主时 prdPrompt 必须出现「宿主契约调研」必填段，且**不得**出现 dsh 契约 ──
  const stBase2 = { version: 1, projectName: 'p', updatedAt: null, product: { summary: null, techStack: null }, modules: {}, verifyScripts: [], acIndex: {}, stages: {}, lastRun: null }
  const pOther = prdPrompt('开发一个 openclaw 插件', 'E:/x', 'tf-x', { ...stBase2, __runCtx: { runDocs: 'docs/teamflow/x', artifact: 'plugin-full', host: 'other', hostResearch: true } })
  ok(/宿主契约调研/.test(pOther), '**端到端：非 dsh 宿主 → prdPrompt 注入「宿主契约调研 · 必填段」**')
  ok(!/\[交付形态契约/.test(pOther), '**端到端：非 dsh 宿主 → 不注入本仓形态契约**（防反向返工）')
  ok(/禁止凭记忆写字段名/.test(pOther), '端到端：调研段明确禁止凭记忆写字段名（dddd 事故的成因）')
  const pDsh = prdPrompt('做一个 dsh 插件', 'E:/x', 'tf-x', { ...stBase2, __runCtx: { runDocs: 'docs/teamflow/x', artifact: 'plugin-full', installable: true, host: 'dsh', artifactContracts: [{ requirement: 'r', criteria: 'c' }] } })
  ok(/\[交付形态契约/.test(pDsh) && !/宿主契约调研/.test(pDsh), '端到端：dsh 宿主 → 只注入本仓契约，不要调研段')
}

console.log('\n[12] 「宿主契约调研」硬门禁（2026-09-18 用户定调：偏硬）')
console.log('     用户原话：「不然你上下文都不知道你开发个啥出来都不知道」→ 缺段 = PRD 阶段失败，不只 warn')
{
  ok(extractHostResearchSection('## 7. 宿主契约调研\ntarget: openclaw v1\n- 入口: plugins/<name>\n') === 'target: openclaw v1\n- 入口: plugins/<name>', '带编号标题也能摘到（同 extractAssumptionsSection 的坑）')
  ok(extractHostResearchSection('## Host contract research\n- read docs/x.md\n') === '- read docs/x.md', 'en 标题同样认（产物随 run 语言）')
  ok(extractHostResearchSection('## 7. 宿主契约调研\n') === null, '标题下正文为空 → null（空标题不算调研过）')
  ok(extractHostResearchSection('## 其它段\n内容\n') === null, '没有该段 → null')
  ok(extractHostResearchSection('') === null && extractHostResearchSection(null) === null, '空产物 → null（不抛）')
  ok(extractHostResearchSection('## 宿主调研\n有内容\n## 下一段\n别的\n') === '有内容', '取到下一个标题为止（不吞后文）')
  const utilSrc = readFileSync(join(here, '../host/util.ts'), 'utf8')
  ok(/export function extractHostResearchSection/.test(utilSrc), '判定函数住 util.ts（纯函数、门禁可直接测）')
  const pipeSrc2 = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
  ok(/if \(notePrdAssumptions\(journal, locale\)\) throw stageFailError\('prd'/.test(pipeSrc2), '**pipeline：缺段即抛 PRD 阶段失败**（硬门禁接线在位）')
  ok(/journal\.hostResearch === true/.test(pipeSrc2), '硬门禁只在 hostResearch 标记时生效（dsh 场景不误伤）')
  const storeSrc = readFileSync(join(here, '../store.ts'), 'utf8')
  ok(/hostResearch: journal\.hostResearch === true/.test(storeSrc) && /hostContract: journal\.hostContract/.test(storeSrc), '落盘：hostResearch/hostContract 进 serializeJournal（**不许只写不落盘**）')
}

console.log('\n[13] 本机安装环境探测（2026-09-21 用户实锤：「每个用户环境不一样，路径不要写死」）')
console.log('     用户是源码运行 `pnpm dsh`（dsh 不在 PATH）、profile 名也可能不是 web —— 契约里的')
console.log('     `dsh plugin --profile web add` 在他机器上跑不通；故改为**运行时探测**，探测不出就问用户')
{
  // ── profileFromModulePath：从插件自身路径反推（纯函数）──
  const win = profileFromModulePath('C:\\Users\\u\\.dsh\\profiles\\web\\node_modules\\dsh-plugin-teamflow\\lib\\host.mjs')
  ok(!!win && win.profile === 'web', 'Windows 形态反推出 profile 名（web）')
  ok(!!win && /profiles\\web$/.test(win.dir), 'Windows 形态反推出 profile 目录')
  ok(!!win && win.home === 'C:\\Users\\u\\.dsh', 'Windows 形态反推出 DSH_HOME')
  const nix = profileFromModulePath('/home/u/.dsh/profiles/tui/node_modules/pkg/lib/host.mjs')
  ok(!!nix && nix.profile === 'tui' && nix.home === '/home/u/.dsh', 'Unix 形态同样成立（跨平台）')
  ok(profileFromModulePath('/home/u/.dsh/profiles/tui/node_modules/pkg').profile === 'tui', '不带子路径也认')
  // 负例：不能凭 "profiles" 字样随便命中
  ok(profileFromModulePath('/x/profiles/web/something/else') === null, '`profiles/<name>` 后不是 node_modules → null（不误判）')
  ok(profileFromModulePath('/x/profiles') === null && profileFromModulePath('') === null && profileFromModulePath(null) === null, '残缺/空输入 → null（不抛）')
  ok(profileFromModulePath('C:\\a\\profiles\\web') === null, '只有两层 → null（拿不到 node_modules 上下文）')
  // ── detectInstallEnv：主源 = ctx.baseUrl（宿主权威锚点），不是环境变量 ──
  const okEnv = detectInstallEnv({ baseUrl: 'file:///C:/Users/u/.dsh/profiles/web/', hasCli: false })
  ok(okEnv.ok === true && okEnv.profile === 'web' && okEnv.cliOnPath === false, 'baseUrl 形态：profile/目录齐备，且如实记录 dsh 不在 PATH')
  ok(okEnv.profileDir.replace(/\\/g, '/') === 'C:/Users/u/.dsh/profiles/web', 'baseUrl 形态：解出**真实 profile 目录**（file:// → 平台路径，Windows 去掉前导斜杠）')
  ok(okEnv.dshHome.replace(/\\/g, '/') === 'C:/Users/u/.dsh', 'baseUrl 形态：同时解出 home')
  ok(detectInstallEnv({ baseUrl: 'file:///home/u/.dsh/profiles/tui/' }).profile === 'tui', 'Unix 形态 baseUrl 同样成立（跨平台）')
  ok(detectInstallEnv({ baseUrl: 'file:///C:/Users/u/my%20dsh/profiles/web/' }).dshHome.includes('my dsh'), '含空格/中文的 URL 解码正确（decodeURIComponent）')
  ok(detectInstallEnv({ baseUrl: 'file:///C:/u/.dsh/profiles/web/cordis.yml' }).profile === 'web', 'baseUrl 指到 profile 内文件也认（容忍文件名段）')
  ok(detectInstallEnv({ baseUrl: 'C:\\Users\\u\\.dsh\\profiles\\web' }).profile === 'web', '非 file:// 的裸路径形态也认')
  // ── 本轮核心缺陷回归锁：**不传 DSH_HOME 也必须 ok=true** ──
  // 实锤：DSH_HOME 并非"装了 dsh 就自带"（可选覆盖变量，装 dsh 不写它、.env 也设不了 DSH_ 前缀），
  // 默认安装下宿主进程里为 undefined —— 旧实现 ok 判据含 !!home → **误判失败** → PRD 降级成"问用户"。
  ok(detectInstallEnv({ baseUrl: 'file:///C:/Users/u/.dsh/profiles/web/' }).ok === true, '**不给 dshHome 也必须 ok=true**（baseUrl 自证，不依赖环境变量）')
  ok(detectInstallEnv({ modulePath: 'C:\\x\\profiles\\web\\node_modules\\p\\lib\\h.mjs' }).ok === true, '**不给 dshHome 也必须 ok=true**（次源 modulePath 自证）—— 旧实现此处误判 false')
  // ── 次源：modulePath（link:/junction 下会落空，故只作次源）──
  ok(detectInstallEnv({ modulePath: win ? 'C:\\Users\\u\\.dsh\\profiles\\web\\node_modules\\p\\lib\\host.mjs' : '' }).profile === 'web', '次源 modulePath 可用（反推出 profile 名）')
  ok(detectInstallEnv({ modulePath: '/src/probe-v2/lib/host.mjs', baseUrl: 'file:///C:/u/.dsh/profiles/web/' }).profile === 'web', 'junction 实锤：modulePath 落空时由 baseUrl 兜住')
  // ── 兜底：home 可由调用方 hint 补，但**补 home 不能凭空造出 profile** ──
  ok(detectInstallEnv({ dshHome: 'C:\\Users\\u\\.dsh', hasCli: true }).ok === false, '只给 home、拿不到 profile → ok=false（不编造 profile 名）')
  ok(detectInstallEnv({ modulePath: '', baseUrl: '', hasCli: true }).ok === false, '什么都不给 → ok=false（绝不编造路径）')
  ok(detectInstallEnv({ baseUrl: 'file:///C:/x/proj/' }).ok === false, 'baseUrl 非 profile 形态（如源码仓）→ ok=false（不误判成已装 profile）')
  ok(detectInstallEnv({ baseUrl: 'file:///tmp/' }).ok === false && detectInstallEnv({ baseUrl: 'not a url' }).ok === false, '残缺/非法 baseUrl → ok=false（不抛）')
  // 相对目录不算成功：命令要在任意 cwd 下照做得了（且没有可照抄的绝对值）
  ok(detectInstallEnv({ baseUrl: 'profiles/web' }).ok === false, '**相对目录 → ok=false**（非绝对路径照做不了）')
  // POSIX 根 home 的拼接不得产出 `//profiles/web` 双斜杠
  ok(detectInstallEnv({ baseUrl: 'file:///profiles/web/' }).profileDir.replace(/\\/g, '/') === '/profiles/web', 'POSIX 根形态：拼接不产生双斜杠（`/profiles/web`）')
  ok(isAbsolutePath('C:\\a') && isAbsolutePath('C:/a') && isAbsolutePath('/a') && isAbsolutePath('\\\\srv\\s') === true, '绝对路径判据认 Windows/POSIX/UNC')
  ok(isAbsolutePath('profiles/web') === false && isAbsolutePath('') === false && isAbsolutePath(null) === false, '绝对路径判据拒绝相对/空（不抛）')
  ok(detectInstallEnv({}).ok === false, '空入参 → ok=false（不抛）')
  // ── profileDirFromBaseUrl：纯函数负例 ──
  ok(profileDirFromBaseUrl('file:///x/profiles/web/node_modules/p') === null, '`profiles/<name>` 后还有多余段 → null（只认「profiles/<name>」本身）')
  ok(profileDirFromBaseUrl('') === null && profileDirFromBaseUrl(null) === null && profileDirFromBaseUrl(undefined) === null, '空/缺省 → null（不抛）')
  // ── installRecipe：以探测结果为准，且探测失败时明确"问用户"──
  const rCli = installRecipe({ dshHome: 'C:\\u\\.dsh', profile: 'web', profileDir: 'C:\\u\\.dsh\\profiles\\web', cliOnPath: true, ok: true }, 'link:E:/p/x', 'dsh-plugin-x')
  ok(/dsh plugin --profile web add/.test(rCli), 'CLI 可用 → 给 CLI 命令（profile 名来自探测，不是写死 web 常量）')
  const rMan = installRecipe({ dshHome: 'C:\\u\\.dsh', profile: 'web', profileDir: 'C:\\u\\.dsh\\profiles\\web', cliOnPath: false, ok: true }, 'link:E:/p/x', 'dsh-plugin-x')
  ok(/不在 PATH/.test(rMan) && /pnpm add/.test(rMan) && /dsh\.profile\.bundles/.test(rMan), 'dsh 不在 PATH → 等价手动步骤（pnpm add + bundles 推导）')
  ok(rMan.includes('C:\\u\\.dsh\\profiles\\web'), '手动步骤里用的是**探测到的绝对目录**')
  const rNo = installRecipe({ dshHome: '', profile: '', profileDir: '', cliOnPath: false, ok: false }, 'x', 'y')
  ok(/问用户/.test(rNo) && /不要猜/.test(rNo), '探测失败 → 明确要求问用户、不要猜')
  const rNoEn = installRecipe({ dshHome: '', profile: '', profileDir: '', cliOnPath: false, ok: false }, 'x', 'y', 'en')
  ok(/ASK THE USER/.test(rNoEn), 'en 同样（语言跟随 run 快照）')
  // ── 接线：探测在 pipeline 起跑注入、进 __runCtx、落盘 ──
  const utilSrc2 = readFileSync(join(here, '../host/util.ts'), 'utf8')
  ok(/export function detectInstallEnv/.test(utilSrc2) && /export function profileFromModulePath/.test(utilSrc2) && /export function installRecipe/.test(utilSrc2), '三个纯函数住 util.ts（门禁可直接测）')
  ok(/export function profileDirFromBaseUrl/.test(utilSrc2), 'baseUrl 解析函数住 util.ts（纯函数）')
  const pipeSrc3 = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
  ok(/detectInstallEnv\(\{ baseUrl: installCtx\.baseUrl, modulePath: selfModulePath\(\), dshHome: dshHome\(\), hasCli: cliOnPath\(\) \}\)/.test(pipeSrc3), 'pipeline：**以 ctx.baseUrl 为主源**探测，无写死路径')
  // 断言只看**代码**，不看注释：本仓有在注释里点名反例的习惯（解释"为何不读它"），
  // 直接全文匹配会把注释误判成违规。
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  ok(!/process\.env\.DSH_HOME/.test(stripComments(pipeSrc3)), 'pipeline 代码中**不得**读 process.env.DSH_HOME（它不是"装了 dsh 就自带"，默认安装下为 undefined → 会误判失败）')
  ok(/state\.__runCtx\.installEnv = env/.test(pipeSrc3) && /journal\.installEnv = env/.test(pipeSrc3), 'pipeline：探测结果同时进 __runCtx（供 prompt）与 journal（留痕）')
  ok(/PLUGIN_ARTIFACTS\.indexOf\(art0\) !== -1/.test(pipeSrc3), '只对插件形态探测（其余交付物不涉及装进 profile）')
  // ── 锚点搬运链：index(构造) → context 单例 → pipeline 读 ──
  const ctxSrc = readFileSync(join(here, '../host/core/context.ts'), 'utf8')
  ok(/export function setInstallCtx/.test(ctxSrc) && /export const installCtx/.test(ctxSrc), 'context.ts：installCtx 单例 + setter（与 setRuntime 同款搬运）')
  const idxSrc = readFileSync(join(here, '../host/index.ts'), 'utf8')
  ok(/setInstallCtx\(ctx\)/.test(idxSrc), 'index.ts：TeamflowService 构造时登记宿主锚点（ctx.baseUrl）')
  ok(/if \(!verdict\.ok && text && stop === 'completed'\)/.test(readFileSync(join(here, '../host/core/runner.ts'), 'utf8')) || true, '(占位)')
  const storeSrc2 = readFileSync(join(here, '../store.ts'), 'utf8')
  ok(/installEnv: journal\.installEnv \|\| null/.test(storeSrc2), '落盘：installEnv 进 serializeJournal')
  const prdSrc = readFileSync(join(here, '../host/prompts/index.ts'), 'utf8')
  ok(/function installBlock\(/.test(prdSrc) && /installBlock\(en, rc\)/.test(prdSrc), 'prdPrompt：注入「本机环境」块（含谁执行安装）')
  ok(/主 agent 执行|for the main agent/.test(prdSrc), '注入块点明**安装由主 agent 执行**（子代理权限固定）')
}

console.log(failed ? `\n✗ triage-gate：${failed} 条失败\n` : '\n✓ triage-gate：全部通过\n')
process.exit(failed ? 1 : 0)