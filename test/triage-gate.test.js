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
import { qualifyBlockers, normalizeSettle, TRIAGE_SETTLES, normalizeIntent, runTriage, TRIAGE_INTENTS, guardrailUpgrade, MODE_RANK, normalizeArtifact, artifactContractsFor, ARTIFACT_CONTRACTS, ARTIFACT_REFERENCE_SAMPLES, triageCacheKey, triageCacheGet, triageCachePut, triageCacheClear, triageCacheSize, triageCacheIsPending, triageCacheMarkPending, triageCacheSettle, TRIAGE_CACHE_MAX } from '../host/core/triage.ts'
import { extractAssumptionsSection } from '../host/util.ts'

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
ok(TRIAGE_SETTLES.length === 6 && TRIAGE_SETTLES.indexOf('installable') !== -1, 'settles 枚举固定六档')

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
ok(ARTIFACT_REFERENCE_SAMPLES['plugin-full'].includes('plugins/dsh-plugin-teamflow'), 'plugin-full 指向同仓正确样本供 PM 核对')
ok(artifactContractsFor('cli', false).some((it) => /bin|可执行/.test(it.requirement + it.criteria)), 'cli：契约含可执行入口')
ok(artifactContractsFor('lib', false).some((it) => /入口|main|exports/.test(it.requirement + it.criteria)), 'lib：契约含模块入口')
ok(artifactContractsFor('plugin-host', false).some((it) => /workspace:/.test(it.criteria)), 'plugin-host：含"依赖不得用 workspace: 协议"（本次实锤缺口之一）')
ok(artifactContractsFor('plugin-full', false).some((it) => /files|白名单/.test(it.requirement)), 'plugin-full：含分发白名单（本次实锤缺口之一）')

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

console.log(failed ? `\n✗ triage-gate：${failed} 条失败\n` : '\n✓ triage-gate：全部通过\n')
process.exit(failed ? 1 : 0)
