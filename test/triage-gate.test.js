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
import { qualifyBlockers, normalizeIntent, runTriage, TRIAGE_INTENTS, guardrailUpgrade, MODE_RANK, normalizeArtifact, artifactContractsFor, ARTIFACT_CONTRACTS, ARTIFACT_REFERENCE_SAMPLES } from '../host/core/triage.ts'
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

console.log(failed ? `\n✗ triage-gate：${failed} 条失败\n` : '\n✓ triage-gate：全部通过\n')
process.exit(failed ? 1 : 0)
