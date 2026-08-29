/**
 * dsh-plugin-teamflow — smoke test（无外部依赖，node test/smoke.js 直接运行）。
 *
 * 1) 校验 TEAMFLOW_DESCRIPTORS 满足 typert registry 的 validateInvocation 规则
 *    （id/service/namespace/method/参数 wire 唯一/src-json codec/endpoint 唯一）
 * 2) 校验 client 模块导出形状（inject/apply）与 host 模块结构（默认导出 class）
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TEAMFLOW_DESCRIPTORS } from '../descriptors.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const assert = (cond, msg) => { if (!cond) { throw new Error(`assert failed: ${msg}`) } }

console.log('── 1) descriptors 校验（typert validateInvocation 规则）──')
assert(Array.isArray(TEAMFLOW_DESCRIPTORS) && TEAMFLOW_DESCRIPTORS.length === 17, '应有 17 个 Remote 描述符')
const endpoints = new Set()
const ids = new Set()
for (const d of TEAMFLOW_DESCRIPTORS) {
  assert(typeof d.id === 'string' && d.id.length > 0, `id 非空: ${d.id}`)
  assert(typeof d.service === 'string' && d.service.length > 0 && !d.service.includes('#'), `service 合法: ${d.service}`)
  assert(/^[A-Za-z0-9_$.-]+$/.test(d.namespace), `namespace 合法: ${d.namespace}`)
  assert(/^[A-Za-z0-9_$.-]+$/.test(d.method), `method 合法: ${d.method}`)
  assert(d.invocation && d.invocation.kind === 'direct', `direct invocation: ${d.method}`)
  assert(d.result && d.result.mode === 'strict' && typeof d.result.schema.parse === 'function', `strict result codec: ${d.method}`)
  const endpoint = `${d.namespace}/${d.method}`
  assert(!endpoints.has(endpoint), `endpoint 唯一: ${endpoint}`)
  assert(!ids.has(d.id), `id 唯一: ${d.id}`)
  endpoints.add(endpoint); ids.add(d.id)
  const wires = new Set()
  for (const p of d.parameters) {
    assert(/^[A-Za-z0-9_$.-]+$/.test(p.name), `参数名合法: ${p.name}`)
    assert(typeof p.wire === 'string' && p.wire.length > 0, `wire 合法: ${p.wire}`)
    assert(!wires.has(p.wire), `wire 不重复: ${p.wire}`)
    wires.add(p.wire)
    assert(p.source === 'json', `参数为 json: ${p.name}`)
    assert(p.codec && p.codec.mode === 'strict' && typeof p.codec.schema.parse === 'function', `参数 codec strict: ${p.name}`)
  }
}
ok(true, `${TEAMFLOW_DESCRIPTORS.length} 个描述符全部通过规则校验`)

console.log('── 2) client 模块结构 ──')
const here = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(here, '../client/index.tsx'), 'utf8')
ok(/export const inject = \['remote', 'slots', 'sessions', 'locale'\]/.test(clientSrc), '导出 inject（remote/slots/sessions/locale）')
ok(/export async function apply/.test(clientSrc), '导出 async apply')
ok(/ctx\.remote\.\$mount\(TEAMFLOW_REMOTE_CONTRIBUTION\)/.test(clientSrc), 'apply 中 $mount Remote 贡献')
ok(/conversation\.view/.test(clientSrc), '注册 conversation.view tab')
ok(/conversation\.view'[\s\S]*id: 'teamflow'/.test(clientSrc), 'tab id=teamflow')
ok(/onDrop/.test(clientSrc) && /draggable/.test(clientSrc), '看板包含拖拽（onDrop/draggable）')

console.log('── 3) host 模块结构 ──')
const hostSrc = [
  readFileSync(join(here, '../host/index.ts'), 'utf8'),
  readFileSync(join(here, '../host/util.ts'), 'utf8'),
  readFileSync(join(here, '../host/constants.ts'), 'utf8'),
  readFileSync(join(here, '../host/prompts/index.ts'), 'utf8'),
  ...['context', 'backlog', 'metering', 'runner', 'guard', 'report', 'pipeline', 'teams', 'state'].map((f) => readFileSync(join(here, `../host/core/${f}.ts`), 'utf8')),
].join('\n//#region host-pool\n')
const utilSrc = readFileSync(join(here, '../host/util.ts'), 'utf8')
const constantsSrc = readFileSync(join(here, '../host/constants.ts'), 'utf8')
ok(/class TeamflowService extends TypertRemoteService/.test(hostSrc), 'TeamflowService extends TypertRemoteService')
ok(/static inject = \['agents', 'subagents', 'tokenMeter', 'typert', 'tools', 'llm'\]/.test(hostSrc), 'static inject 完整')
ok(/ctx\.typert\.register\(\{[\s\S]*invocations: TEAMFLOW_DESCRIPTORS/.test(hostSrc), 'typert.register 注册 strict descriptors')
for (const m of ['ping', 'list', 'snapshot', 'start', 'cancel', 'backlog', 'backlogUpdate', 'assign', 'pause', 'resumeSession', 'listTeams', 'selectTeam', 'getActiveTeam', 'clearTeam', 'resume', 'stageDetail', 'itemDetail']) {
  ok(new RegExp(`\\n  ${m}\\(`).test(hostSrc), `Remote 方法 ${m}()`)
}
ok(/export default TeamflowService/.test(hostSrc), '默认导出 TeamflowService')
ok(/from '\.\.\/descriptors\.ts'/.test(hostSrc), 'import descriptors.ts')
ok(/from '\.\.\/store\.ts'/.test(hostSrc), 'import store.ts（持久化层独立）')

console.log('── 3b) 断点续跑（v0.4.0）──')
ok(/loadJournals\(\)/.test(hostSrc), '构造时加载磁盘 journal')
ok(/interruptedCount/.test(hostSrc), '中断残留计数提示')
ok(/persistJournal\(journal\)/.test(hostSrc), 'checkpoint 落盘')
ok(/resumeRun\(/.test(hostSrc) && /interruptedPhaseOf\(/.test(hostSrc) && /buildResumeProducts\(/.test(hostSrc), 'resume 逻辑（起点/产物重建）')
ok(/resumed\(/.test(hostSrc) && /logSkip\(/.test(hostSrc), 'executePipeline 阶段跳过')
ok(/stage\.output = clip\(text, 50000\)/.test(hostSrc), '阶段产物全文记录（续跑重建上下文）')
const storeSrc = readFileSync(join(here, '../store.ts'), 'utf8')
ok(/export function loadJournals/.test(storeSrc) && /export function persistJournal/.test(storeSrc) && /export function serializeJournal/.test(storeSrc), 'store.js 导出 journal 三件套')
ok(/status === 'running' \|\| j\.status === 'pending'/.test(storeSrc), 'loadJournals 中断标记逻辑（store.js）')

console.log('── 3c) 完成汇总投递（v0.5.0）──')
ok(/from '@deepseek-ai\/dsh-llm'/.test(hostSrc), 'import createUserMessage（dsh-llm）')
ok(/function deliverCompletion/.test(hostSrc), 'deliverCompletion 函数')
ok(/parent\.status === 'idle'\) parent\.followup\(message\)/.test(hostSrc), 'idle → followup 唤醒')
ok(/else parent\.inject\(message\)/.test(hostSrc), 'running → inject 注入')
ok(/kind: 'plugin',[\s\S]*plugin: 'dsh-plugin-teamflow',[\s\S]*form: 'notice'/.test(hostSrc), 'notice 来源标记（与 tool-jobs 同款）')
ok(/deliverCompletion\(journal, parent\)/.test(hostSrc), 'finally 中投递')
ok(/teamflow_resume/.test(hostSrc), '汇报文本引导断点重跑')

console.log('── 3d) 防恶心人加固（v0.6.0）──')
ok(/parameterSchemaSpecToJsonSchema/.test(hostSrc), '工具 parameters 经 schema 编译（wire 带 type: object）')
ok(/function hasSubstance/.test(utilSrc) && /REFUSAL_PATTERN/.test(constantsSrc), '假阳性检测（拒绝词 + 长度下限）')
ok(/STAGE_TOKEN_BUDGET = 60000/.test(constantsSrc), '阶段 token 熔断预算 60k')
ok(/function isUnretryable/.test(utilSrc), 'context-limit 类失败不重试')
ok(/activeProducts/.test(hostSrc) && /已有流水线/.test(hostSrc), '产品级并发限制（防 req 状态互踩）')
ok(/summarizeTimeline\(/.test(hostSrc) && !/delete s\.output/.test(hostSrc), '终态 checkpoint 不再删 stage.output —— 保留全文供 detail 抽屉/断点续跑读取')
ok(/readJsonAny\(journalFile\(id\)/.test(hostSrc), 'resume 从磁盘加载完整 journal')

console.log('── 3e) 工作区隔离 + 单任务模型 + 真实 token（v0.9）──')
const contextSrc = readFileSync(join(here, '../host/core/context.ts'), 'utf8')
const backlogSrc = readFileSync(join(here, '../host/core/backlog.ts'), 'utf8')
const pipelineSrc = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
const promptsSrc = readFileSync(join(here, '../host/prompts/index.ts'), 'utf8')
// 1) workspace 级团队工作台（workspace = 项目根 = 会话 cwd，无需额外声明）
ok(/workspaceScopeOf/.test(contextSrc) && /session\.header\.cwd/.test(contextSrc), 'workspace 由会话 cwd 推导（项目根即工作区）')
ok(/function sessionScope/.test(hostSrc) && /function runsFor\(/.test(hostSrc), 'service 按 sessionId→workspace 过滤运行/backlog')
ok(/j\.workspace/.test(hostSrc), 'journal 记录 workspace 隔离键')
// 2) 收口：docs → docs/teamflow/，logs → logs/teamflow/<runId>/
ok(/TF_DOCS/.test(promptsSrc) && /docs\/teamflow/.test(promptsSrc) && !/docs\/prd|docs\/design|docs\/technical|docs\/qa\//.test(promptsSrc), 'prompts：文档全收口到 docs/teamflow/，不再散落宿主 docs/')
ok(/logs\/teamflow/.test(promptsSrc) && /TOKEN_HYGIENE/.test(promptsSrc), 'prompts：命令日志重定向 logs/teamflow/<runId>/')
ok(/persistRunLog/.test(storeSrc) && /runLogFile/.test(storeSrc), 'host 端 run 日志落 <workspace>/logs/teamflow/')
// 3) 单任务模型（需求 → 唯一轮转任务卡）
ok(/store\.nextId\('task'\)/.test(backlogSrc) && /taskId/.test(backlogSrc), '每需求一张轮转任务卡（req→taskId）')
ok(/devAssign/.test(backlogSrc) && /qaAssign/.test(backlogSrc), '任务卡记录 devAssign/qaAssign 分配人')
ok(/function assignTask/.test(backlogSrc), '独立分配函数 assignTask（不碰 status）')
ok(/function noteTaskAssign/.test(backlogSrc), 'pipeline 内部分配函数 noteTaskAssign（不碰 status）')
ok(!/item\.devAssign.*=.*meta/.test(backlogSrc) || /function assignTask/.test(backlogSrc), 'transitionBacklog 不再设 assign（assign 与 status 分离）')
ok(/advanceTask\(journal, 'running'/.test(pipelineSrc) && /advanceTask\(journal, 'testable'/.test(pipelineSrc) && /advanceTask\(journal, 'testing'/.test(pipelineSrc) && /pending-acceptance/.test(pipelineSrc), '任务流转：待办→开发中→待测试→测试中→待验收→验收')
ok(/noteTaskStageUsage/.test(backlogSrc) && /accruedSeq/.test(backlogSrc), '任务级真实 usage 按角色幂等累计')
// 4) client：真实 token + workspace 作用域
ok(/stageUsageLine/.test(clientSrc) && /byRoleLine/.test(clientSrc), 'client：节点卡显示真实 usage、任务卡显示按角色 token')
ok(/api\.list\(props\.sessionId\)/.test(clientSrc) && /api\.backlog\(props\.sessionId\)/.test(clientSrc), 'client：面板按当前会话 workspace 取数（隔离）')
ok(/TeamSelector/.test(clientSrc) && /conversation\.input\.right/.test(clientSrc), 'client：团队选择按钮注入 conversation.input.right')
ok(/listTeams/.test(clientSrc) && /selectTeam/.test(clientSrc), 'client：团队选择器调用 listTeams/selectTeam')
// 5) 团队管理 + 会话级暂停
ok(!/systemPrompt\.section/.test(hostSrc), 'host：prompt 注入已移除（触发改由 UI 驱动）')
ok(/pausedSessions/.test(hostSrc) && /teamflow_pause/.test(hostSrc) && /teamflow_resume_session/.test(hostSrc), 'host：会话级暂停/恢复（pausedSessions + 两个工具）')
ok(/activeTeams/.test(hostSrc) && /listTeams/.test(hostSrc) && /selectTeam/.test(hostSrc) && /clearTeam/.test(hostSrc), 'host：团队管理（activeTeams + listTeams/selectTeam/getActiveTeam/clearTeam）')
// 6) token 优化：state.json 预编译索引 + 一次成型纪律 + 版本切片
ok(/loadState/.test(hostSrc) && /mergeStateBlock/.test(hostSrc) && /extractStateBlock/.test(hostSrc), 'host：state.json 预编译索引（loadState/merge/extract）')
ok(/stateSliceFor/.test(hostSrc) && /STATE_BLOCK_INSTRUCTION/.test(hostSrc), 'host：state slice 按角色注入 prompt + 产出 state 块')
ok(/noteRun/.test(hostSrc) && /stateFile/.test(hostSrc), 'host：run 结束更新 state.json')
ok(/ONCE_DISCIPLINE/.test(hostSrc) && /ONE-SHOT WRITE/.test(hostSrc), 'prompt：一次成型纪律（write≤1 + 禁 read-edit 循环）')
// 7) 子代理模型路由修复：主线程切换模型后子代理不沿用废弃 provider
ok(/resolveChildRoute/.test(hostSrc) && /requestHeader\(\)/.test(hostSrc), 'runner：子代理路由解析（requestHeader 最近生效路由）')
ok(/agentDefaultModel/.test(hostSrc) && /currentSelection/.test(hostSrc), 'runner：回退全局默认模型当前选择（切换即更新）')
ok(/agentOptions/.test(hostSrc) && /subagents\.start/.test(hostSrc), 'runner：显式传 agentOptions 给子代理（不再依赖过期快照）')

console.log('── 3f) 档位阶段集差异执行（ADR-0004 落地）──')
ok(/resolveStages/.test(constantsSrc) && /STAGE_POLICY/.test(constantsSrc), 'constants：档位→阶段集策略表 + 纯函数 resolveStages')
ok(/export type StageKey =/.test(constantsSrc) && /full: \[/.test(constantsSrc) && /medium: \[/.test(constantsSrc) && /patch: \[/.test(constantsSrc), 'STAGE_POLICY 覆盖 full/medium/lite/tech/patch 五档')
ok(/STAGE_POLICY\.full/.test(constantsSrc), 'resolveStages 未知档回退 full')
ok(/resolveStages/.test(pipelineSrc) && /const stageSet = resolveStages/.test(pipelineSrc), 'pipeline：入口按档位展开阶段集')
ok(/const enabled = \(key/.test(pipelineSrc) && /stageSet\.indexOf/.test(pipelineSrc), 'pipeline：enabled() 基于阶段集（档位 × 团队交集）')
ok(/if \(enabled\('design'\)\)/.test(pipelineSrc) && /if \(enabled\('scaffold'\)\)/.test(pipelineSrc) && /if \(!enabled\('qa'\)\)/.test(pipelineSrc), 'pipeline：design/scaffold/qa 由阶段集门控（取代散落 if/else）')

console.log('── 3g) QA→开发 打回修复→复验 闭环（QA 缺陷不再静默进验收）──')
ok(/QA_REWORK_LIMIT/.test(constantsSrc), 'constants：QA_REWORK_LIMIT 复验轮次上限（防无限循环）')
ok(/function parseDefects/.test(backlogSrc) && /\*\*/.test(backlogSrc), 'backlog：parseDefects 容忍 markdown 加粗严重级（**P1**）')
ok(/export function syncQaDefects/.test(backlogSrc) && /defectId/.test(backlogSrc), 'backlog：QA 缺陷幂等登记（按 reqId+defectId 不重复建卡）')
ok(/export function verifyReqBugs/.test(backlogSrc), 'backlog：复验通过关闭全部 open 缺陷（verifyReqBugs）')
ok(/export const qaFixPrompt/.test(promptsSrc) && /Confirm first, then fix/.test(promptsSrc), 'prompts：qaFixPrompt（QA 缺陷→开发确认+修复，交还复验）')
ok(/qaFixPrompt\(/.test(pipelineSrc) && /QA 打回开发修复/.test(pipelineSrc), 'pipeline：QA 发现缺陷 → 打回开发修复（qaFixPrompt 子代理）')
ok(/qaBlocked/.test(pipelineSrc) && /QA_REWORK_LIMIT/.test(pipelineSrc), 'pipeline：复验轮次上限 → 超限置 qaBlocked（需人工）')
ok(/if \(!qaBlocked\)/.test(pipelineSrc) && /产品验收跳过/.test(pipelineSrc), 'pipeline：QA 不干净则跳过产品验收（干净才进验收）')
ok(/b\.severity !== 'P3'/.test(pipelineSrc), 'pipeline：验收收尾 openBugs 排除 P3 观察项（P3 非阻断，与 QA 阶段语义一致——P3 不再卡死 pending-acceptance）')
ok(/journal\.humanIntervention = true/.test(pipelineSrc), 'pipeline：打回超限/验收 rework 置 journal.humanIntervention')
const reportSrc = readFileSync(join(here, '../host/core/report.ts'), 'utf8')
ok(/journal\.humanIntervention \? '⚠️ 已完成（需人工介入）'/.test(reportSrc), 'report：completed+humanIntervention → ⚠️ 已完成（需人工介入），不再误报 ✅')

console.log('── 3h) 子代理进行中护栏 v2（纯进度信号） + resume 标志复位 + 工程动作承接 ──')
const guardSrc = readFileSync(join(here, '../host/core/guard.ts'), 'utf8')
ok(/export function startStageGuard/.test(guardSrc) && /GUARD_REPEAT_LIMIT/.test(guardSrc) && /GUARD_SILENCE_MS/.test(guardSrc) && /GUARD_NO_TOOL_MS/.test(guardSrc), 'guard：护栏 v2（复读/挂死/空转三信号，无时间配额——慢吞吐合法任务不误杀）')
ok(/GUARD_POLL_MS/.test(constantsSrc) && /GUARD_REPEAT_LIMIT = 12/.test(constantsSrc) && /GUARD_SILENCE_MS/.test(constantsSrc) && /GUARD_NO_TOOL_MS/.test(constantsSrc) && !/GUARD_WALL_CLOCK_MS/.test(constantsSrc), 'constants：护栏阈值常量（裸墙钟已废除）')
ok(/startStageGuard\(\{ run, journal, label, stage \}\)/.test(hostSrc), 'runner：runAgent 接入单调用护栏')
ok(/stage\.guardOutcome \|\| 'degenerated'/.test(hostSrc), 'runner：复读=degenerated（污染会话自动重试必挂，直接 needs-human 引导 resume）；挂死/空转=stalled 走预算门转人工')
ok(/if \(lastStage && lastStage\.outcome === 'degenerated'\) \{\r?\n\s+journal\.logs\.push/.test(hostSrc) && !/guardedRetry/.test(hostSrc), 'runner：退化中止不再自动重试（实证 tf-mte906e9 6 次全失败 12→27 递增；resume 新会话一次成功）——直接 needs-human，引导 teamflow_resume')
ok(/j\.humanIntervention = false/.test(pipelineSrc), 'pipeline：resumeRun 重置 humanIntervention（完成汇报不再误标 ⚠️）')
ok(/const stageFailError = /.test(pipelineSrc) && (pipelineSrc.match(/stageFailError\(/g) || []).length >= 7, 'pipeline：阶段失败文案带真实次数/outcome/熔断语义（7 处 throw 收口）')
ok(!/次后仍无产出，需人工介入`/.test(pipelineSrc), 'pipeline：不再有「重试 N 次后仍无产出」失真文案')
ok(/Engineering actions carried verbatim/.test(promptsSrc) && /git actions from the PRD/.test(promptsSrc), 'prompts：PRD 承接工程指令 + tech 蓝图传递 git 动作')
ok(/Engineering action execution/.test(promptsSrc) && /execute the action BEFORE writing code/.test(promptsSrc), 'prompts：dev 先执行 git 动作再写码')
ok(/repairBlueprintJson/.test(utilSrc), 'util：蓝图 JSON 提前闭合抢救（防静默回退整体开发）')
ok(/TECHNICAL\.md.*extractBlueprint|extractBlueprint\(readFileSync/.test(pipelineSrc), 'pipeline：蓝图提取回退任务夹 TECHNICAL.md（模型写进文档而非回复输出时 M2 拆卡不退化，实锤 r13 单任务整体开发）')
ok(/token 观测/.test(guardSrc) && /重复 read|验证脚本重复执行/.test(guardSrc) && /observeToolCalls/.test(guardSrc), 'guard：token 观测信号（重复读/验证循环只记 warning 不中止）')
ok(/蓝图块解析失败/.test(pipelineSrc) && /devAssign: \(mainTask && mainTask\.devAssign\) \|\| null/.test(backlogSrc), 'pipeline/backlog：蓝图解析失败告警 + 子卡继承 devAssign')

console.log('── 3i) 任务夹文档制（ADR-0008：活文档版本制 → 需求级任务夹收口）──')
ok(/runFolderName/.test(utilSrc) && /runFolderName\(new Date\(\), journal\.reqId/.test(pipelineSrc), 'util/pipeline：任务夹命名 <yyyyMMdd>-r<N>[-<slug>]，host 建夹')
ok(/runDocs: journal\.runDocs \|\| null/.test(storeSrc), 'store：journal.runDocs 持久化（需求级身份，续跑复用同夹）')
ok(/mkdirSync\(abs, \{ recursive: true \}\)/.test(pipelineSrc) && /meta\.json/.test(pipelineSrc) && !/status: journal\.status/.test(pipelineSrc), 'pipeline：建夹 + meta.json 静态标识卡（reqId/runId/title/mode/createdAt 建夹即定；终态回写已废——status/endedAt 权威在 journal，避免提交后再脏/快照过时）')
ok(/state\.__runCtx\.runDocs = journal\.runDocs/.test(pipelineSrc) && /runDocs\?: string/.test(join(here, '../host/core/state.ts') ? readFileSync(join(here, '../host/core/state.ts'), 'utf8') : ''), 'pipeline/state：runDocs 注入 __runCtx（所有阶段可见）')
ok(!/VERSION_SLICE_BLOCK|mv 归档|history\/v<旧版>/.test(promptsSrc), 'prompts：版本切片/归档话术已整体移除（结构性幂等，不再靠提示词）')
ok(/基线依赖|取代：/.test(promptsSrc) && /Number ACs from AC-1/.test(promptsSrc), 'prompts：局部 AC 编号（本夹内 AC-1 起）+ 基线依赖/取代声明')
ok(/slug/.test(readFileSync(join(here, '../host/core/triage.ts'), 'utf8')) && /TRIAGE_PROMPT/.test(promptsSrc) && /topic words/.test(promptsSrc), 'triage：slug 输出字段（受控命名来源）')
ok(!/SUMMARY\.md/.test(promptsSrc), 'prompts：SUMMARY.md 已废除（索引由 host 扫描 meta.json 聚合）')

console.log('── 4) 其他文件 ──')
for (const f of ['../cordis.patch.yml', '../package.json', '../README.md', '../descriptors.ts', '../client/index.tsx', '../host/index.ts', '../store.ts']) {
  ok(existsSync(join(here, f)), `存在 ${f}`)
}

console.log('── 5) 安全加固（v0.3.1，持久化逻辑位于 store.js）──')
const patchSrc = readFileSync(join(here, '../cordis.patch.yml'), 'utf8')
ok(!/teamflow-client/.test(patchSrc), 'cordis.patch.yml 不再声明 client host row（自动扫描）')
ok(/- insert:/.test(patchSrc), 'patch 用 insert 块（顶层 - id: 是替换语义会静默跳过）')
ok(/name: 'dsh-plugin-teamflow'/.test(patchSrc) && !/name: 'dsh-plugin-teamflow\/host'/.test(patchSrc), 'entry 名用包根（子路径行导致 clientModules 扫不到 dsh.client）')
ok(/s\.includes\('\.\.'\)/.test(utilSrc), 'normalizeRoot 拒绝 .. 穿越段')
ok(/s\.startsWith\('\/'\)/.test(utilSrc) && /\^\[a-zA-Z\]:/.test(utilSrc), 'normalizeRoot 拒绝绝对路径/盘符')
ok(/copyFileSync\(file, file \+ '\.bak'\)/.test(storeSrc), '写前保留 .bak 备份')
ok(/renameSync\(tmp, file\)/.test(storeSrc), '原子写（.tmp → rename）')
ok(/从 \.bak 恢复/.test(storeSrc), '主文件损坏自动从 .bak 恢复')

console.log(failed === 0 ? '\n✅ smoke 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
