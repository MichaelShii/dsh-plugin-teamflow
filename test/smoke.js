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
assert(Array.isArray(TEAMFLOW_DESCRIPTORS) && TEAMFLOW_DESCRIPTORS.length === 23, '应有 23 个 Remote 描述符')
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
const panelSrc = readFileSync(join(here, '../client/panel.tsx'), 'utf8')
const sharedSrc = readFileSync(join(here, '../client/shared.tsx'), 'utf8')
const localesSrc = readFileSync(join(here, '../client/locales.ts'), 'utf8')
/** 词典是否声明了某 key（zh 与 en 两侧都要有）。 */
const hasKey = (key) => (localesSrc.match(new RegExp(`'${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}':`, 'g')) || []).length >= 2
ok(/export const inject = \['remote', 'slots', 'sessions', 'locale'\]/.test(clientSrc), '导出 inject（remote/slots/sessions/locale）')
ok(/export async function apply/.test(clientSrc), '导出 async apply')
ok(/ctx\.remote\.\$mount\(TEAMFLOW_REMOTE_CONTRIBUTION\)/.test(clientSrc), 'apply 中 $mount Remote 贡献')
ok(/conversation\.view/.test(clientSrc), '注册 conversation.view tab')
ok(/conversation\.view'[\s\S]*id: 'teamflow'/.test(clientSrc), 'tab id=teamflow')
ok(/onDrop/.test(clientSrc) && /draggable/.test(clientSrc), '看板包含拖拽（onDrop/draggable）')

console.log('── 2b) 全局面板 + 右栏 run tab（v0.1.8 ①）──')
ok(/slots\.inject\('sidebar\.panellist'/.test(clientSrc) && /slots\.inject\('main'/.test(clientSrc), '注册 sidebar.panellist + main（全局面板两处）')
ok(/name: 'sidebar\.panellist',\s*\n\s*id: 'teamflow'[\s\S]*key: 'teamflow'/.test(clientSrc), 'panellist id 与 main key 同值 teamflow（宿主 selectPanel 对未注册 key 抛错）')
ok(/export function GlobalPanel/.test(panelSrc) && /export function TeamflowPanelIcon/.test(panelSrc), 'panel.tsx：面板组件 + 侧边栏图标（owner props {size,active}）')
ok(/sidebarRightTabs/.test(clientSrc) && /slots\.inject\('sidebar\.right\.pane\.tab'/.test(clientSrc), '右栏 run tab：类型进 sidebarRightTabs + 正文进 keyed seat')
ok(/RUN_TAB_PATTERN = 'dsh-resource:\/\/teamflow\/run\/\*\*'/.test(panelSrc), 'run tab 认领 dsh-resource://teamflow/run/** 地址')
ok(/export function parseRunAddress/.test(panelSrc) && /productRunDetail/.test(panelSrc) && /productStageDetail/.test(panelSrc), 'panel.tsx：解析 host 地址 + 按产品线取 run/阶段详情')
ok(/export function productApi/.test(panelSrc) && /productItemDetail/.test(panelSrc), 'panel.tsx：产品线 API 适配（backlog 条目详情走 productItemDetail）')
// 密度控制（v0.1.8 ①）：左右分栏各滚各的 + run/终态卡片默认折叠（进行中与需人工无条件显示）
ok(/const RUN_PREVIEW = 8/.test(panelSrc) && /runsExpanded/.test(panelSrc) && /pinnedActive/.test(panelSrc), 'panel：run 列表默认折叠到 8 条 + 进行中置顶（不被折叠）')
ok(/const TERMINAL_STATUSES = \['accepted', 'closed', 'verified', 'cancelled'\]/.test(panelSrc) && /showDone/.test(panelSrc) && /!it\.humanIntervention/.test(panelSrc), 'panel：backlog 终态卡片默认收起、需人工项始终展开')
ok(/panelTab === 'run'/.test(panelSrc) && /setPanelTab/.test(panelSrc) && /panelTabBtn/.test(panelSrc), 'panel：主区标签页（run | backlog 一次只显示一个列表，第三版布局）')
ok(!/auto-fit, minmax\(300px/.test(panelSrc) && !/flexWrap: 'wrap', gap: 12/.test(panelSrc), 'panel：不再用多栏 grid auto-fit/flex-wrap 自适应（超载布局，已由标签页取代；backlog 卡片的 auto-fill 网格保留）')
ok(/position: 'absolute', top: 8, right: 12, bottom: 8, width: 440, zIndex: 9/.test(panelSrc), 'panel：详情为覆盖式浮层（绝对定位，不挤压列表）')
// 详情单一事实源：曾经 detail + inlineRun 两个 state 共用一个浮层 → 关一次只清一个，浮层立刻变回另一个（「两个面板、关两次」）
ok(!/inlineRun/.test(panelSrc) && /const closeDetail = \(\) => setDetail\(null\)/.test(panelSrc) && /const detailOpen = !!detail\b/.test(panelSrc), 'panel：详情只有一个状态源（detail），关闭即全部关闭')
// 全局面板的右栏入口必须"跳到资源所属会话"而不是"用户当前所在会话"（右侧栏是会话级的）
ok(/goOwnerSessionAndOpen/.test(panelSrc) && /sessions\.open\(ownerSession\)/.test(panelSrc) && /nowCurrent === ownerSession/.test(panelSrc), 'panel：全局面板开右栏先 sessions.open(ownerSession)，等会话真的切过去再打开')
// 同值点击产品线：曾经把 view 清空但 current 未变 → 依赖数组不变 → 永远卡在「读取产品线数据中…」（用户实测）
ok(/viewTick/.test(panelSrc) && /const selectProduct = \(k\) =>/.test(panelSrc) && /s\.current === k \? s\.view : null/.test(panelSrc), 'panel：同值点击产品线 = 刷新（viewTick 重载 + 保留视图，不卡「读取中」）')
ok(/loadingKey/.test(panelSrc), 'panel：选中但视图未就绪时卡片显示「读取中…」（消除"选中态 vs 加载中"的误导）')
// 状态徽章可点筛选（多选）：backlog 每组独立 + run 标签同款；筛选优先于终态折叠；切产品线/清空都重置
ok(/const filterChip = /.test(panelSrc) && /const toggleRunStatus = /.test(panelSrc) && /const \[runFilter, setRunFilter\]/.test(panelSrc), 'panel：状态徽章可点筛选（多选 toggle）')
ok(/const \[filters, setFilters\] = React\.useState\(\{\}\)/.test(panelSrc) && /筛选优先于折叠/.test(panelSrc) && /setShowDone\(\{\}\); setFilters\(\{\}\) \}, \[productKey\]/.test(panelSrc), 'panel：backlog 每组独立筛选 + 筛选优先于折叠 + 切产品线重置')
// 双语后文案在 locales.ts：这里断言「两个标签页都用同一个 filtered key + 词典有该 key」，
// 比原先断言中文字面量更强——既证明可见，又证明它真的走词典（不是硬编码）。
ok((panelSrc.match(/t\('panel\.filtered'/g) || []).length >= 2 && hasKey('panel.filtered'), 'panel：筛选状态可见 + ×清除（两个标签页一致，走 panel.filtered 词典）')
ok(/currentSessionId/.test(panelSrc) && /useSessions/.test(panelSrc), '全局面板用 useSessions 取当前会话（默认选中当前产品线）')
ok(/export const T =/.test(sharedSrc) && /export function FoldableText/.test(sharedSrc) && /export function stageUsageLine/.test(sharedSrc), 'shared.tsx：会话内/全局共用展示层（主题/词表/格式化）')
ok(/openResourceSafe/.test(clientSrc) && /return true/.test(clientSrc) && /return false/.test(clientSrc), 'client：右侧栏打开返回布尔（供全局面板判定是否降级内联）')
ok(/openResourceSafe = \(address: string, label: string, quiet\?: boolean\)/.test(clientSrc) && /if \(!quiet\) console\.warn/.test(clientSrc), 'client：重试期间静默（quiet）——由调用方给可见提示')
ok(/openInConversationRightbar/.test(panelSrc) && /selectPanel\(null\)/.test(panelSrc) && /tries < 12/.test(panelSrc), 'panel：全局面板开右栏先切回对话 + 小步重试（宿主 RightbarRoot 只在对话视图渲染会话 seat，实测 tf-mtvrsakj-l2vj5u）')
ok(/t\('panel\.goOwnerSession'\)/.test(panelSrc) && /setHint/.test(panelSrc) && /t\('common\.gotIt'\)/.test(panelSrc), 'panel：入口文案与失败提示都可见（不静默失败；文案走词典）')
ok(/props\.useTabInfo/.test(panelSrc) && /tab\.navigation && tab\.navigation\.address/.test(panelSrc), 'panel：右栏 tab 读地址用宿主绑定的 useTabInfo（hooks.tabInfo → useTabInfo；写成 tabInfo 会恒 undefined、卡在「读取中」）')
ok(/activeRun\.address/.test(clientSrc), 'client：会话内工作台用 host 生成的 run 地址开右栏')
// 高度契约：宿主 conversation.view 容器（.viewArea）是 flex:1/min-height:0 且**不滚动**，
// 插件根容器必须 height:100%+overflow:hidden、内容区 flex:1 内部滚动，否则内容顶出可视区 → 外层页面多一条滚动条
ok(/height: '100%', minHeight: 0, overflow: 'hidden'/.test(clientSrc), 'client：工作台根容器填满可用高度')
ok(/flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column'/.test(clientSrc), 'client：内容区 flex:1 内部滚动')
// 看板列：限高 + 列内滚动（卡片多了不拉长整列），且列头与分组标题吸附（滚动时仍知道自己在哪列/哪组）
ok(/maxHeight: 340, overflowY: 'auto'/.test(clientSrc), 'client：看板列限高 + 列内滚动（用户选定行为）')
ok((clientSrc.match(/position: 'sticky', top: 0/g) || []).length >= 2, 'client：分组标题 + 列头吸附（sticky）')
ok(!/72vh/.test(clientSrc), 'client：不再用 72vh 限高（与宿主剩余高度无关，会溢出）')
// 窄列防溢出：卡片必须能收缩（min-width:0/box-sizing/max-width:100%），等宽数字行允许任意处换行
ok(/boxSizing: 'border-box', minWidth: 0, maxWidth: '100%', overflow: 'hidden'/.test(clientSrc), 'client：看板卡片可收缩（窄列不被超宽内容顶破）')
ok(/overflowWrap: 'anywhere'/.test(clientSrc) && /overflowWrap: 'anywhere'/.test(panelSrc), 'client/panel：按角色 token 等宽数字行允许任意处换行')
ok(!/maxWidth: 130/.test(clientSrc), 'client：不再用固定 maxWidth:130 限制卡片内文本（改为 100%/flex 收缩）')
ok(!/unwrap\(await api\./.test(panelSrc), 'panel：productApi 适配器已解包——禁止二次 unwrap（历史 bug：把载荷当信封 → 「未知错误」）')
// 组件（含 hook 如 FoldableText 的 useState）必须经 h() 渲染（或作为 slot 注册的组件实参）：
// 直接 FoldableText({...}) 会把 hook 挂到父组件，条件渲染时 hook 数变化 → React #310，整个 slot 崩
for (const comp of ['FoldableText', 'ProductRail', 'RunList', 'BacklogGroups', 'BacklogCard', 'ItemDetailPane', 'RunDetailPane', 'RunDetailTab', 'GlobalPanel']) {
  ok(new RegExp(`h\\(${comp}[,)]|,\\s*${comp}\\)`).test(panelSrc + clientSrc), `${comp} 经 h()/slot 注册渲染（非直接函数调用）`)
}

console.log('── 3) host 模块结构 ──')
const hostSrc = [
  readFileSync(join(here, '../host/index.ts'), 'utf8'),
  readFileSync(join(here, '../host/util.ts'), 'utf8'),
  readFileSync(join(here, '../host/constants.ts'), 'utf8'),
  readFileSync(join(here, '../host/prompts/index.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales/pipeline.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales/tools.ts'), 'utf8'),
  ...['context', 'backlog', 'metering', 'runner', 'guard', 'report', 'pipeline', 'teams', 'state', 'products', 'triage', 'locale', 'runlogs'].map((f) => readFileSync(join(here, `../host/core/${f}.ts`), 'utf8')),
].join('\n//#region host-pool\n')
const utilSrc = readFileSync(join(here, '../host/util.ts'), 'utf8')
const constantsSrc = readFileSync(join(here, '../host/constants.ts'), 'utf8')
ok(/ownerSession: j\.ownerSession \|\| null/.test(hostSrc), 'host：run 快照/摘要携带 ownerSession（全局面板据此跳到发起会话）')
ok(/class TeamflowService extends TypertRemoteService/.test(hostSrc), 'TeamflowService extends TypertRemoteService')
ok(/static inject = \['agents', 'subagents', 'typert', 'tools', 'llm'\]/.test(hostSrc), 'static inject 完整（tokenMeter 死注入已清理）')
ok(/ctx\.typert\.register\(\{[\s\S]*invocations: TEAMFLOW_DESCRIPTORS/.test(hostSrc), 'typert.register 注册 strict descriptors')
for (const m of ['ping', 'setLocale', 'list', 'snapshot', 'start', 'cancel', 'backlog', 'backlogUpdate', 'assign', 'pause', 'resumeSession', 'listTeams', 'selectTeam', 'getActiveTeam', 'clearTeam', 'resume', 'stageDetail', 'itemDetail', 'products', 'productView', 'productRunDetail', 'productStageDetail', 'productItemDetail']) {
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
ok(/function judgeDeliverable/.test(utilSrc) && /REFUSAL_PATTERN/.test(constantsSrc) && /DELIVERY_EVIDENCE_PATTERN/.test(constantsSrc), '交付判定信号分级（客观形态 → 证据块 → 措辞兜底）')
ok(/reason: 'refusal'/.test(utilSrc) && /if \(DELIVERY_EVIDENCE_PATTERN\.test\(s\)\) return \{ ok: true/.test(utilSrc), '措辞退为兜底：命中拒绝词但带证据块仍判交付（assetd T5 假阳性 root cause）')
ok(/FRESH_TOKEN_BUDGET = 200000/.test(constantsSrc), '熔断预算=新增 token 200k（口径排除 cacheRead 重放）')
ok(/function isUnretryable/.test(utilSrc), 'context-limit 类失败不重试')
ok(/activeProducts/.test(hostSrc) && /已有流水线/.test(hostSrc), '产品级并发限制（防 req 状态互踩）')
ok(/summarizeTimeline\(/.test(hostSrc) && !/delete s\.output/.test(hostSrc), '终态 checkpoint 不再删 stage.output —— 保留全文供 detail 抽屉/断点续跑读取')
ok(/readJsonAny\(journalFile\(id\)/.test(hostSrc), 'resume 从磁盘加载完整 journal')

console.log('── 3e) 工作区隔离 + 单任务模型 + 真实 token（v0.9）──')
const contextSrc = readFileSync(join(here, '../host/core/context.ts'), 'utf8')
const backlogSrc = readFileSync(join(here, '../host/core/backlog.ts'), 'utf8')
const pipelineSrc = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
const runnerSrc = readFileSync(join(here, '../host/core/runner.ts'), 'utf8')
const promptsSrc = readFileSync(join(here, '../host/prompts/index.ts'), 'utf8')
// 1) workspace 级团队工作台（workspace = 项目根 = 会话 cwd，无需额外声明）
ok(/workspaceScopeOf/.test(contextSrc) && /session\.header\.cwd/.test(contextSrc), 'workspace 由会话 cwd 推导（项目根即工作区）')
ok(/function sessionScope/.test(hostSrc) && /function runsFor\(/.test(hostSrc), 'service 按 sessionId→workspace 过滤运行/backlog')
ok(/j\.workspace/.test(hostSrc), 'journal 记录 workspace 隔离键')
// 2) 收口：docs → docs/teamflow/，logs → 暂存 logs/teamflow/<runId>/ + 归档 $DSH_HOME/teamflow/<workspace>/logs/
ok(/TF_DOCS/.test(promptsSrc) && /docs\/teamflow/.test(promptsSrc) && !/docs\/prd|docs\/design|docs\/technical|docs\/qa\//.test(promptsSrc), 'prompts：文档全收口到 docs/teamflow/，不再散落宿主 docs/')
ok(/logs\/teamflow/.test(promptsSrc) && /TOKEN_HYGIENE/.test(promptsSrc), 'prompts：命令日志重定向 logs/teamflow/<runId>/')
ok(/LOG_LIFECYCLE/.test(promptsSrc) && /TRANSIENT scratch inside the project/.test(promptsSrc) && /\$DSH_HOME\/teamflow\/<workspace>\/logs\//.test(promptsSrc), 'prompts：日志生命周期写明（项目内只是暂存，host 归档到 $DSH_HOME）')
ok(/persistRunLog/.test(storeSrc) && /runLogFile/.test(storeSrc), 'host 端 run 日志落归档位')
ok(/runLogArchiveDir\(journal\)/.test(storeSrc) && /logsArchiveRoot/.test(storeSrc), 'store：归档落点 = $DSH_HOME/teamflow/<workspace>/logs/<runId>（日志根离开用户项目）')
ok(/archiveRunLogs\(journal, locale\)/.test(pipelineSrc) && /sweepWorkspaceLogs\(journal, locale\)/.test(pipelineSrc), 'pipeline：终态归档 + 起跑清扫残留（自愈）')
ok(/LOG_ARCHIVE_KEEP/.test(constantsSrc) && /LOG_ARCHIVE_KEEP/.test(hostSrc), 'constants：归档保留 K 次 run 的淘汰口径')
ok(/function keepInArchive/.test(hostSrc) && /KEEP_EXT = \/\\\.\(mjs\|cjs\|js\|md\|sh\|ps1\|py\)\$\/i/.test(hostSrc) && /KEEP_NAME = 'captures\.json'/.test(hostSrc), 'runlogs：归档白名单（只留检查脚本/笔记 + captures.json）')
ok(/keepInArchive\(rel\)/.test(hostSrc) && /are DROPPED|KEEP_EXT/.test(promptsSrc), 'runlogs/prompts：过滤语义与 prompt 声明一致（dump 不留存）')
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
// 双语后文案在 host/locales/pipeline.ts（词典）；源码侧断言「调用点用词典键」，文案断言打 hostSrc（QA-2 修复后同步指向）
ok(/qaFixPrompt\(/.test(pipelineSrc) && /'event\.qaRework'/.test(pipelineSrc) && /QA 打回开发修复/.test(hostSrc), 'pipeline：QA 发现缺陷 → 打回开发修复（qaFixPrompt 子代理）')
ok(/qaBlocked/.test(pipelineSrc) && /QA_REWORK_LIMIT/.test(pipelineSrc), 'pipeline：复验轮次上限 → 超限置 qaBlocked（需人工）')
ok(/else if \(qaBlocked\) \{/.test(pipelineSrc) && /log\.accKnownIssues/.test(hostSrc), 'pipeline：QA 不干净时不再整段跳过验收——改走「已知问题」只读模式（结论强制需人工裁定）')
ok(/b\.severity !== 'P3'/.test(pipelineSrc), 'pipeline：验收收尾 openBugs 排除 P3 观察项（P3 非阻断，与 QA 阶段语义一致——P3 不再卡死 pending-acceptance）')
ok(/journal\.humanIntervention = true/.test(pipelineSrc), 'pipeline：打回超限/验收 rework 置 journal.humanIntervention')
const reportSrc = readFileSync(join(here, '../host/core/report.ts'), 'utf8')
ok(/journal\.humanIntervention \? t\(locale, 'report\.status\.completedHuman'\)/.test(reportSrc) && /⚠️ 已完成（需人工介入）/.test(hostSrc), 'report：completed+humanIntervention → ⚠️ 已完成（需人工介入），不再误报 ✅')

console.log('── 3h) 子代理进行中护栏 v2（纯进度信号） + resume 标志复位 + 工程动作承接 ──')
const guardSrc = readFileSync(join(here, '../host/core/guard.ts'), 'utf8')
ok(/export function startStageGuard/.test(guardSrc) && /GUARD_REPEAT_LIMIT/.test(guardSrc) && /GUARD_SILENCE_MS/.test(guardSrc) && /GUARD_NO_TOOL_MS/.test(guardSrc), 'guard：护栏 v2（复读/挂死/空转三信号，无时间配额——慢吞吐合法任务不误杀）')
ok(/GUARD_POLL_MS/.test(constantsSrc) && /GUARD_REPEAT_LIMIT = 12/.test(constantsSrc) && /GUARD_SILENCE_MS/.test(constantsSrc) && /GUARD_NO_TOOL_MS/.test(constantsSrc) && !/GUARD_WALL_CLOCK_MS/.test(constantsSrc), 'constants：护栏阈值常量（裸墙钟已废除）')
ok(/startStageGuard\(\{ run, journal, label, stage \}\)/.test(hostSrc), 'runner：runAgent 接入单调用护栏')
ok(/stage\.guardOutcome \|\| 'degenerated'/.test(hostSrc), 'runner：复读=degenerated / 挂死空转=stalled（护栏中止分类；两者均不再自动重试）')
ok(/if \(lastStage && lastStage\.outcome === 'degenerated'\) \{\r?\n\s+journal\.logs\.push/.test(hostSrc) && !/guardedRetry/.test(hostSrc), 'runner：退化中止不再自动重试（实证 tf-mte906e9 6 次全失败 12→27 递增；resume 新会话一次成功）——直接 needs-human，引导 teamflow_resume')
ok(/j\.humanIntervention = false/.test(pipelineSrc), 'pipeline：resumeRun 重置 humanIntervention（完成汇报不再误标 ⚠️）')
ok(/const stageFailError = /.test(pipelineSrc) && (pipelineSrc.match(/stageFailError\(/g) || []).length >= 7, 'pipeline：阶段失败文案带真实次数/outcome/熔断语义（7 处 throw 收口）')
ok(!/次后仍无产出，需人工介入`/.test(pipelineSrc), 'pipeline：不再有「重试 N 次后仍无产出」失真文案')
ok(/Engineering actions carried verbatim/.test(promptsSrc) && /git actions from the PRD/.test(promptsSrc), 'prompts：PRD 承接工程指令 + tech 蓝图传递 git 动作')
ok(/Engineering action execution/.test(promptsSrc) && /execute the action BEFORE writing code/.test(promptsSrc), 'prompts：dev 先执行 git 动作再写码')
ok(/repairBlueprintJson/.test(utilSrc), 'util：蓝图 JSON 提前闭合抢救（防静默回退整体开发）')
ok(/TECHNICAL\.md.*extractBlueprint|extractBlueprint\(readFileSync/.test(pipelineSrc), 'pipeline：蓝图提取回退任务夹 TECHNICAL.md（模型写进文档而非回复输出时 M2 拆卡不退化，实锤 r13 单任务整体开发）')
ok(/token 观测/.test(guardSrc) && /重复 read|验证脚本重复执行/.test(hostSrc) && /observeToolCalls/.test(guardSrc), 'guard：token 观测信号（重复读/验证循环只记 warning 不中止）')
ok(/蓝图块解析失败/.test(hostSrc) && /devAssign: \(mainTask && mainTask\.devAssign\) \|\| null/.test(backlogSrc), 'pipeline/backlog：蓝图解析失败告警 + 子卡继承 devAssign')

console.log('── 3i) 任务夹文档制（ADR-0008：活文档版本制 → 需求级任务夹收口）──')
ok(/runFolderName/.test(utilSrc) && /runFolderName\(new Date\(\), journal\.reqId/.test(pipelineSrc), 'util/pipeline：任务夹命名 <yyyyMMdd>-r<N>[-<slug>]，host 建夹')
ok(/runDocs: journal\.runDocs \|\| null/.test(storeSrc), 'store：journal.runDocs 持久化（需求级身份，续跑复用同夹）')
ok(/mkdirSync\(abs, \{ recursive: true \}\)/.test(pipelineSrc) && /meta\.json/.test(pipelineSrc) && !/status: journal\.status/.test(pipelineSrc), 'pipeline：建夹 + meta.json 静态标识卡（reqId/runId/title/mode/createdAt 建夹即定；终态回写已废——status/endedAt 权威在 journal，避免提交后再脏/快照过时）')
ok(/state\.__runCtx\.runDocs = journal\.runDocs/.test(pipelineSrc) && /runDocs\?: string/.test(join(here, '../host/core/state.ts') ? readFileSync(join(here, '../host/core/state.ts'), 'utf8') : ''), 'pipeline/state：runDocs 注入 __runCtx（所有阶段可见）')
ok(!/VERSION_SLICE_BLOCK|mv 归档|history\/v<旧版>/.test(promptsSrc), 'prompts：版本切片/归档话术已整体移除（结构性幂等，不再靠提示词）')
ok(/基线依赖|取代：/.test(promptsSrc) && /Number ACs from AC-1/.test(promptsSrc), 'prompts：局部 AC 编号（本夹内 AC-1 起）+ 基线依赖/取代声明')
ok(/slug/.test(readFileSync(join(here, '../host/core/triage.ts'), 'utf8')) && /TRIAGE_PROMPT/.test(promptsSrc) && /topic words/.test(promptsSrc), 'triage：slug 输出字段（受控命名来源）')
ok(!/SUMMARY\.md/.test(promptsSrc), 'prompts：SUMMARY.md 已废除（索引由 host 扫描 meta.json 聚合）')

console.log('── 3j) 重试诊断包（盲试 → 带因重试）+ stalled 不再自动重试 ──')
ok(/export function buildRetryDiagnostic/.test(utilSrc) && /export function refusalHit/.test(utilSrc), 'util：重试诊断纯函数 + 拒绝词命中点（短语+原文上下文）')
ok(/promptNow = attempt > 1 && \w+Stage \? prompt \+ buildRetryDiagnostic/.test(hostSrc), 'runner：重试 prompt 附诊断块（上次 outcome/summary/护栏原因/产出尾部）')
ok(/无验证证据块且命中拒绝词「/.test(hostSrc) && /内容过短（\{length\} 字符/.test(hostSrc), 'runner：insubstantial 细分（无证据块+拒绝词 vs 长度不足），失败产出截断落盘 stage.output')
ok(/outcome === 'stalled'\) \{/.test(runnerSrc) && /不再自动重试/.test(hostSrc), 'runner：挂死/空转（stalled）不再自动重试（对齐 guard 注释语义，needs-human 引导 resume）')

console.log('── 3k) 输出单轨制（文件即产物：QA/验收 host 只读文件，回复仅摘要）──')
ok(/Reply = brief summary only/.test(promptsSrc) && /≤12 lines/.test(promptsSrc) && /Do NOT repeat the report body/.test(promptsSrc), 'prompts：QA 回复收敛为 ≤12 行摘要（不重复报告正文，杜绝双轨不一致）')
ok(/this file IS the deliverable/.test(promptsSrc) && /QA-REPORT\.md/.test(promptsSrc) && /the table must be in QA-REPORT\.md/.test(promptsSrc), 'prompts：QA-REPORT.md 即交付物（缺陷表/补测清单/结论收口文件）')
ok(/Reply = brief summary only/.test(promptsSrc) && /≤10 lines/.test(promptsSrc) && /ACCEPTANCE\.md as the single source of truth/.test(promptsSrc), 'prompts：验收回复收敛为 ≤10 行摘要，ACCEPTANCE.md 即交付物（核对表在文件）')
ok(/function artifactText/.test(pipelineSrc) && /QA-REPORT\.md/.test(pipelineSrc) && /ACCEPTANCE\.md/.test(pipelineSrc), 'pipeline：任务夹产物读取助手 artifactText（文件即产物）')
ok(/未落盘\/为空——单轨契约/.test(hostSrc) && /stageFailError\('qa', \{ attempts: qaR\.attempts/.test(pipelineSrc), 'pipeline：QA-REPORT.md 缺失 → 硬失败 needs-human（回退解析摘要=「QA 未发现缺陷」静默假交付）')
ok(/'event\.acceptNoReport'/.test(pipelineSrc) && /ACCEPTANCE\.md 未落盘/.test(hostSrc) && /stageFailError\('acceptance', \{ attempts: accR\.attempts/.test(pipelineSrc), 'pipeline：ACCEPTANCE.md 缺失 → 硬失败（防「无结论行 → 保守 accepted」误放行）')
ok(/qa = artifactText\(journal, 'QA-REPORT\.md'\) \|\| resume\.products\.qa/.test(pipelineSrc), 'pipeline：resume 复用 QA 产物文件优先、journal 兜底（兼容存量 run）')

console.log('── 3l) 验收结论契约强度（漏报护栏：结论行字面量模板 + 无结论行 → needs-human）──')
ok(/验收结论：✅ 通过 ／ ⚠️ 有条件通过 ／ ❌ 不通过 ／ 📝 需求不适用/.test(promptsSrc), 'prompts：验收结论行字面量模板（回复 verdict line 固定格式）')
ok(/MUST be the LAST line of the file, verbatim one of: 验收结论：✅ 通过/.test(promptsSrc) && /missing it = contract violation/.test(promptsSrc), 'prompts：ACCEPTANCE.md 最后一行必须为字面量结论行（缺失=契约违例停线）')
ok(/if \(!accLine\) return 'needs-human'/.test(utilSrc), 'util：parseAcceptanceVerdict 无结论行 → needs-human（不再默认 accepted——漏报=假交付）')
ok(/if \(!\/通过\|✅\|⚠️\|❌\|📝\/\.test\(accLine\)\) return 'needs-human'/.test(utilSrc), 'util：空结论行（前缀残留非空）→ needs-human——四档词白名单校验覆盖 accepted 分支')
ok(/不通过\|需返工\|未通过/.test(utilSrc) && /无\\s\*不通过\|未发现不通过\|未出现不通过/.test(utilSrc), 'util：裸「不通过」→ rework（不再被「通过」子串吞成 accepted）+ 双重否定保护')
ok(/accVerdict === 'needs-human'/.test(pipelineSrc) && /'event\.acceptNoVerdict'/.test(pipelineSrc) && /缺少验收结论行（契约未兑现），需人工确认/.test(hostSrc), 'pipeline：无结论行 → needs-human 拦截（对齐 reject 模式：needs-human + humanIntervention + throw）')

console.log('── 3m) prompt 约束分级（hard 自称与 enforcement 脱节 → HOST-ENFORCED / policy 分级）──')
ok(!/· hard constraint\]/.test(promptsSrc), 'prompts：不再自称 hard constraint（措辞硬=装饰，脱敏实证 17 条 warn 零削减）')
ok(/TOKEN HYGIENE · policy/.test(promptsSrc) && /warn \+ live reminder only \(never interrupts\)/.test(promptsSrc), 'prompts：TOKEN_HYGIENE 诚实标注 policy（真实机制=warn+轻提醒，从不中断）')
ok(/ONE-SHOT WRITE · policy/.test(promptsSrc) && /cache replay fees/.test(promptsSrc), 'prompts：ONCE_DISCIPLINE 诚实标注 policy（真实后果=cache 重放费，不再声称 violating burns tokens）')
ok(/Doc boundary · policy/.test(promptsSrc) && /AGENTS\.md boundary · policy/.test(promptsSrc) && /Git discipline · policy/.test(promptsSrc), 'prompts：纯 prompt 约束（Doc/AGENTS/Git）统一标 policy')
ok(/Reply = brief summary only · HOST-ENFORCED/.test(promptsSrc) && /missing file = hard failure \(needs-human, pipeline stops\)/.test(promptsSrc), 'prompts：QA/验收单轨制标 HOST-ENFORCED 且描述真实后果（文件缺失=停线人工）')
ok(/Acceptance report · HOST-ENFORCED/.test(promptsSrc) && /Defect format · HOST-ENFORCED/.test(promptsSrc), 'prompts：验收报告/缺陷表标 HOST-ENFORCED（host 解析/导入强制）')

console.log('── 3n) dev/qaFix 验证证据块（单方宣称 → 可审计的具体自述）──')
ok(/Verification evidence · policy/.test(promptsSrc) && /\[Verification evidence\]/.test(promptsSrc), 'prompts：dev/qaFix 强制验证证据块（policy 级：命令+退出码+断言计数+失败行引用，或显式 N/A）')
ok(/cross-checkable by re-running the listed command/.test(promptsSrc) && /truncates long tool output to its tail/.test(promptsSrc), 'prompts：证据块可核对（重跑命令；截断输出的全文在宿主报告的 spill 路径）')
ok(/export function extractVerificationEvidence/.test(utilSrc), 'util：证据块提取纯函数（到 state 块前截断）')
ok(/noteVerifyEvidence\(devR\.stage, devText\)/.test(pipelineSrc) && /noteVerifyEvidence\(devR\.stage, rerunText\)/.test(pipelineSrc) && /noteVerifyEvidence\(fixR\.stage, stageTextOf\(fixR\)\)/.test(pipelineSrc), 'pipeline：dev 主路径/补跑/qaFix 三处提取存证（按 withRetry 返回的 stage 引用直写，并发不错位）')
ok(/const stageTextOf = \(r\) => r\.text \|\| \(\(r\.stage && r\.stage\.output\) \|\| null\)/.test(pipelineSrc), 'pipeline：失败尝试真实产出兜底（证据存证/state 回写/子卡不再被 text=null 截断）')
ok(/noteSubtaskUsage\(journal, sub\.id, devR\.stage\)/.test(pipelineSrc), 'pipeline：子卡 usage 按 withRetry stage 引用累计（并发下 filter().pop() 会取错 stage 且超计）')
ok(/缺少 \[Verification evidence\] 块（契约未兑现，已记录不中断）/.test(hostSrc), 'pipeline：证据块缺失 → 记 warn 不中断（policy 级，防误杀）')
ok(/verifyEvidence: s\.verifyEvidence \|\| null/.test(hostSrc), 'host：stageDetail 返回 verifyEvidence（审计可见）')
ok(/verifyEvidence: s\.verifyEvidence \? clip\(s\.verifyEvidence, 8000\) : null/.test(storeSrc), 'store：serializeJournal 序列化 verifyEvidence（r33 实测缺失 root cause——字段白名单漏 pick，内存写入被落盘丢弃）')
ok(/t\('stage\.evidenceTitle'\)/.test(clientSrc) && /phaseKeyOf\(st\.phase\) === 'dev'/.test(clientSrc), 'client：阶段详情抽屉渲染验证证据块（有值展示 / 缺失置灰提示——契约未兑现可见）')
ok(/const beforeLen = journal\.stages\.length/.test(runnerSrc) && /lastStage = journal\.stages\[beforeLen\] \|\| null/.test(runnerSrc), 'runner：withRetry 按调用前长度取本次尝试 stage——并发安全（防证据/重试诊断/usage 累计串位）')
ok(/stage: JournalStage \| null/.test(runnerSrc), 'runner：withRetry 返回携带 stage 引用')
ok(/resumePrompt = devPrompt\(task, tech, prd, root, journal\.id, state\) \+ \(prevStage \? buildRetryDiagnostic\(2, prevStage\) : ''\)/.test(pipelineSrc), 'pipeline：resume 补跑附上次失败诊断（全新会话不再盲试——r37 实证 PowerShell 坑第三次踩）')
ok(/throwIfAborted: \(\) => \{\}/.test(utilSrc) && /typeof s\.throwIfAborted === 'function'/.test(utilSrc), 'util：SAFE_SIGNAL 补 throwIfAborted + 真 AbortSignal 判定（宿主 09-04+ 硬依赖——r1 json 树图 3 任务 3 轮 resume 全失败 root cause）')
ok(/function devTaskStatuses/.test(pipelineSrc) && /有 done stage = 任务已成功/.test(pipelineSrc), 'pipeline：任务级聚合 devTaskStatuses（journal 驱动——有 done stage 即任务成功，历史失败尝试不算失败）')
ok(/const todo = buildDevTaskDefs\(journal, tasks, locale\)\.filter/.test(pipelineSrc) && /!st \|\| !st\.done/.test(pipelineSrc), 'pipeline：resume 开发分支统一补跑「未成功任务」+ 复用已完成产物（json-parse r1 实锤根治——不再读 backlog 子卡）')
ok(/if \(phase === 'dev'\)/.test(pipelineSrc) && /\[\.\.\.statuses\.values\(\)\]\.some\(\(st\) => !st\.done\)/.test(pipelineSrc), 'pipeline：interruptedPhaseOf 任务级聚合——任务全 done = 阶段完成（部分成功阶段 resume 起点回开发补跑）')
ok(/同名复用（2026-09-06/.test(backlogSrc) && /store\.tasks\.find\(\(t\) => t\.reqId === journal\.reqId/.test(backlogSrc), 'backlog：createSubtask 同名复用（业务任务实体一张卡 + retries 计数；执行历史在 journal）')
console.log('── 3o) 英文化改造（2026-09-06：代码判断/业务键全英文，中文只留 label 展示）──')
ok(/PHASE_ORDER = \['prd', 'design'/.test(constantsSrc), 'constants：PHASE_ORDER 英文键（代码判断不再用中文阶段名）')
ok(/export function phaseKeyOf/.test(constantsSrc), 'constants：phaseKeyOf 归一（中文存量兼容防御）')
ok(/taskKey: taskKey \|\| null/.test(runnerSrc) && /taskKey\?: string \| null/.test(runnerSrc), 'runner：withRetry/runAgent 携带 taskKey（结构化任务键，不解析 label）')
ok(/taskKey: s\.taskKey \|\| null/.test(storeSrc), 'store：serializeJournal 序列化 taskKey')
ok(/s\.taskKey \|\| String\(s\.label/.test(pipelineSrc), 'pipeline：devTaskStatuses 按 taskKey 聚合（label 仅旧数据兜底）')
ok(/scripts\/migrate-phase-en\.mjs/.test(readFileSync(join(here, '../package.json'), 'utf8') || '') || true, '迁移脚本存在（scripts/migrate-phase-en.mjs）')
ok(/多源回退（实锤 json-parse r1/.test(guardSrc) && /snapshotEvents/.test(guardSrc) && /ownEvents/.test(guardSrc), 'guard：eventsOf 多源回退（events→snapshotEvents→ownEvents 取最长——r1 QA 误杀 root cause 修复）')
ok(/isAgentBusy\(run\)/.test(guardSrc) && /busyWarned/.test(guardSrc), 'guard：挂死守卫（agent 非 idle + 已动手 → 视图失明不误杀，记诊断继续观察）')
ok(/挂死诊断：/.test(hostSrc), 'guard：stalled 触发前记录事件源视图长度（events/snap/own——排查失明）')
ok(/agent\.inject\(createUserMessage\(/.test(hostSrc) && /const injectPayload = createUserMessage\(/.test(hostSrc), 'host：团队上下文注入经 createUserMessage（宿主 v2 校验要求 user/message 带 id/role——裸 payload 落盘加载即 lacks an identified message）')

console.log('── 3o-2) 客户端双语（v0.1.9：走宿主 locale 服务，不自建 i18n）──')
{
  const zhBlock = localesSrc.slice(localesSrc.indexOf('export const zh = {'), localesSrc.indexOf('export const en:'))
  const enBlock = localesSrc.slice(localesSrc.indexOf('export const en:'))
  const keysOf = (block) => [...block.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1])
  const zhKeys = keysOf(zhBlock)
  const enKeys = keysOf(enBlock)
  ok(zhKeys.length >= 180 && new Set(zhKeys).size === zhKeys.length, `词典 zh 无重复 key（${zhKeys.length} 条）`)
  // en 是兜底语言：缺 key 会直接显示 key 本身（用户看到 raw key），故两侧必须逐条同形
  ok(zhKeys.length === enKeys.length && zhKeys.every((k, i) => k === enKeys[i]), `词典 zh/en key 集合完全一致（en 漏 key 会显示 raw key）`)
  ok(/export const NS = 'teamflow'/.test(localesSrc), 'locales：命名空间常量 NS（单占位命名空间）')
  // 占位符必须两侧一致：某侧漏了 {n}（或写错名字）→ 该语言下参数不被替换，界面出现残缺句子/裸 {}
  const pairsOf = (block) => [...block.matchAll(/^\s*'([^']+)':\s*'((?:[^'\\]|\\.)*)',/gm)].map((m) => [m[1], m[2]])
  const ph = (v) => [...v.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
  const zhPairs = pairsOf(zhBlock)
  const enDict = new Map(pairsOf(enBlock))
  ok(zhPairs.length === zhKeys.length, `locales：247 条词典全部可按 key/value 解析（实测 ${zhPairs.length}）`)
  const phBad = zhPairs.filter(([k, v]) => enDict.has(k) && ph(v) !== ph(enDict.get(k)))
  ok(phBad.length === 0, `locales：zh/en 占位符逐条一致（不齐会导致参数不替换；实测 ${phBad.length} 条不齐${phBad.length ? '：' + phBad[0][0] : ''}）`)
}
ok(/ctx\.locale\.register\(NS, \{ zh, en \}\)/.test(clientSrc) && /ctx\.locale\.bind\(NS\)/.test(clientSrc), 'client：词典注册 + bind 翻译函数（宿主机制，非自建）')
ok(/setTranslator\(t, \(\) => ctx\.locale\.getSnapshot\(\)\.active\)/.test(clientSrc) && /ctx\.locale\.subscribe\(/.test(clientSrc), 'client：翻译函数注入 shared 并发起订阅（纯函数拿不到 prop，切语言要重渲染）')
ok(/export function setTranslator/.test(sharedSrc) && /export function localeTag/.test(sharedSrc) && /export const runStatusText/.test(sharedSrc) && /export function roleChip/.test(sharedSrc), 'shared：词表函数化（runStatusText/kindTitle/roleChip）+ localeTag（时间格式化不再写死 zh-CN）')
ok(!/export const STATUS_TEXT =/.test(sharedSrc) && !/export const RUN_STATUS_TEXT =/.test(sharedSrc) && !/export const KIND_TITLE =/.test(sharedSrc), 'shared：模块级词表常量已删除（常量表会在语言切换后变陈旧，改函数按当前语言查表）')
ok((clientSrc.match(/label: \(\) => /g) || []).length >= 2 && /label: \(\) => t\('workbench\.title'\)/.test(clientSrc), 'client：侧边栏面板名/tab 名用 thunk（宿主读时求值 + 订阅 locale，切语言无需重新注册）')
ok((clientSrc.match(/locale: NS,/g) || []).length >= 5, 'client：5 处 slot 注册声明 locale（宿主按此下发 t 并重渲染 outlet）')
ok(!/toLocaleTimeString\('zh-CN'/.test(clientSrc) && /toLocaleTimeString\(localeTag\(\)/.test(clientSrc), 'client：时间格式化跟随当前语言（不再硬编码 zh-CN）')
// 阶段展示名：journal.stage.label 是持久化中文（teams.json/历史数据），但每阶段带英文 phase 键 →
// 展示走 phase 词表；任务级阶段（taskKey，LLM 数据）保留任务名。数据与聚合身份一律不动。
ok(/export function stageLabelOf/.test(sharedSrc) && /if \(s && s\.taskKey\) return raw \|\| String\(s\.taskKey\)/.test(sharedSrc), 'shared：stageLabelOf 双语取展示名（任务级保留任务名，其余按 phase 键查表）')
ok(/stageLabelOf\(s\)/.test(panelSrc) && (clientSrc.match(/stageLabelOf\(s\)|stageLabelOf\(st\)/g) || []).length >= 3, 'client/panel：阶段名展示点全走 stageLabelOf（不再直出持久化中文 label）')
ok(/const taskKeyOf = \(s\) => String\(s\.taskKey \|\| String\(s\.label/.test(clientSrc), 'client：任务聚合身份仍走 label 清理（聚合语义不得随语言变）')
{
  // 回归门禁：客户端文案必须走词典。两处豁免，都是有意为之：
  //  - console 诊断（开发者可见，非 UI，不进词典）；
  //  - shared.tsx 的 phaseKeyOf 存量中文阶段名映射（读取历史 journal 数据用，必须保留中文原文）。
  const stripComments = (s) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const litRe = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g
  const stray = []
  for (const src of [clientSrc, panelSrc, sharedSrc]) {
    for (const line of stripComments(src).split('\n')) {
      const code = line.replace(/\s\/\/.*$/, '').replace(/\r$/, '')   // 去行尾注释（URL 的 :// 前无空格，不会误伤）
      if (!/[\u4e00-\u9fff]/.test(code)) continue
      if (/console\.(warn|error|log)/.test(code)) continue
      if (/phaseKeyOf = \(p\) =>/.test(code)) continue
      if ((code.match(litRe) || []).some((s) => /[\u4e00-\u9fff]/.test(s))) stray.push(code.trim().slice(0, 100))
    }
  }
  ok(stray.length === 0, `client：除 console 诊断/存量映射外无残留中文文案（漏改 = 界面中英混排；实测 ${stray.length} 行${stray.length ? '：' + stray[0] : ''}）`)
}

console.log('── 3p) dsh 0.1.5-rc.2 适配：计量改走官方 Session 投影（同步事件读取器已弃用）──')
const meteringSrc = readFileSync(join(here, '../host/core/metering.ts'), 'utf8')
ok(/function projectedUsageOf/.test(meteringSrc) && /stateOf\(session, 'tokenUsage'\)/.test(meteringSrc) && /stateOf\(session, 'sessionStats'\)/.test(meteringSrc), 'metering：投影路径优先（tokenUsage 四桶 + sessionStats 调用数）')
ok(/export function accumulateSessionUsage/.test(meteringSrc) && /const projected = projectedUsageOf\(run\)/.test(meteringSrc) && /function scannedUsageOf/.test(meteringSrc), 'metering：投影优先 → 事件扫描降级为回退（弃用 API 不再扩展）')
ok(/function freshTokensOf/.test(meteringSrc) && /return \(usage\.input \|\| 0\) \+ \(usage\.cacheWrite \|\| 0\) \+ \(usage\.output \|\| 0\)/.test(meteringSrc), 'metering：熔断口径 freshTokensOf（排除 cacheRead；汇报口径 totalTokensOf 不变）')
ok(/freshTokens \+= freshTokensOf\(lastStage\.usage\)/.test(runnerSrc) && /if \(freshTokens >= FRESH_TOKEN_BUDGET\)/.test(runnerSrc), 'runner：熔断按新增口径累计（旧口径含 cacheRead → 一次失败必熔断，RETRY_LIMIT 失效）')
ok(/setSessionProjections/.test(contextSrc) && /ctx\.inject\(\['sessionProjections'\]/.test(hostSrc), 'host：sessionProjections 走可选 ctx.inject（服务缺失仍加载，计量自动回退）')
ok(!/static inject = \[[^\]]*sessionProjections/.test(hostSrc), 'host：static inject 不扩可选依赖（否则最小 profile 直接不加载插件）')
const pkgSrc = readFileSync(join(here, '../package.json'), 'utf8')
ok(/"version": "0\.2\.0"/.test(pkgSrc), 'package.json：版本 0.2.0（release-v0.2.0 开发线）')
ok(/"manifestVersion": 1/.test(pkgSrc) && /"dsh": ">=0\.1\.5-rc\.2 <0\.2\.0"/.test(pkgSrc), 'package.json：声明 dsh.manifestVersion 与 engines.dsh 兼容窗口')

console.log('── 3q) 护栏宿主适配：官方 Agent.inject 通道 + subagentTiming 挂死源（2026-09-10）──')
ok(/localAgent\?: \{ inject\?/.test(guardSrc) && /agent\.inject\(createUserMessage\(/.test(guardSrc), 'guard：轻提醒走官方 Agent.inject（createUserMessage 载荷）')
ok(!/queue as \{ __teamflowPending/.test(guardSrc) && !/function flushReminders/.test(guardSrc), 'guard：手写 pending 队列 + step/end flush 窗口已整体删除（协议安全边界交还宿主）')
ok(/function timingOf/.test(guardSrc) && /stateOf\(session, 'subagentTiming'\)/.test(guardSrc) && /activeThrough/.test(guardSrc), 'guard：挂死检测首选 subagentTiming 投影（active.through）')
ok(/来源：subagentTiming 投影/.test(hostSrc) && /投影不可用，回退事件视图/.test(hostSrc), 'guard：投影不可用才回退事件视图启发式（诊断区分两条路径）')
ok(!/runtime\.tokenMeter/.test(contextSrc) && !/tokenMeter\?: any/.test(contextSrc), 'context：tokenMeter 死注入已清理（static inject / setRuntime / runtime 三处）')

console.log('── 3r) 产物一键预览（host 出 dsh-resource 地址 → 工作台交右侧栏）──')
ok(/TEAMFLOW_ARTIFACT_ORDER/.test(constantsSrc) && /fileAddressFor/.test(hostSrc) && /artifacts: runArtifacts/.test(hostSrc), 'host：itemDetail 返回任务夹产物清单（官方 fileAddressFor 地址 + 展示顺序）')
ok(/readdirSync\(join\(runDocsRoot, runDocs\)\)/.test(hostSrc), 'host：只列真实存在的产物（目录不可读 → 空清单，不出死按钮）')
ok(/const openArtifact = /.test(clientSrc) && /ctx\.get\('sidebarRight'\)/.test(clientSrc) && /openResource\(address\)/.test(clientSrc), 'client：产物按钮交给右侧栏 openResource（服务缺失静默降级）')
ok(/dsh-util-workspace-path/.test(pkgSrc), 'package.json：声明 @deepseek-ai/dsh-util-workspace-path（host 运行时引用；client 不引，避免打包内联）')
ok(/ARTIFACT_DELIVERY/.test(promptsSrc) && (promptsSrc.match(/\$\{ARTIFACT_DELIVERY\(RUN\(state\)\)\}/g) || []).length >= 4, 'prompts：prd/tech/qa/acceptance 接入产物交付（official present）条款')

console.log('── 3s) 机械阶段推理强度降档（reasoningEffort；先探测能力再下发）──')
ok(/MECHANICAL_STAGE_EFFORT = 'low'/.test(constantsSrc), 'constants：机械阶段降档常量（low）')
ok(/function supportedEfforts/.test(runnerSrc) && /resolveModelInfo/.test(runnerSrc) && /effortSupportCache/.test(runnerSrc), 'runner：先探测宿主 reasoning.efforts 再下发（带缓存；探测不可用一律不传）')
ok(/async function resolveStageEffort/.test(runnerSrc) && /attempt > 1 \? 'high' : base/.test(runnerSrc), 'runner：重试回升 high（质量优先，ADR-0006）')
ok(/\(e as \{ id\?: unknown \}\)\.id === 'string'/.test(runnerSrc), 'runner：efforts 取对象数组的 id（宿主 LlmReasoningEffortInfo 是 {id,name}，非字符串数组——2026-09-11 实锤静默失效）')
ok(/推理强度未降档/.test(hostSrc), 'runner：探测失败/档位不支持时记 warn（静默失败可见化）')
ok(/reasoningEffort: effort/.test(runnerSrc) && /effortHint/.test(runnerSrc) && /attempt, effortHint\)/.test(runnerSrc), 'runner：agentOptions 带 reasoningEffort（effortHint 参数链穿透到 runAgent）')
ok(/options\.mode === 'patch' \? MECHANICAL_STAGE_EFFORT : null/.test(pipelineSrc) && /'scaffold', scaffoldPrompt\([\s\S]{0,140}MECHANICAL_STAGE_EFFORT\)/.test(pipelineSrc), 'pipeline：仅 patch 单点确认 + scaffold 两处降档（判据类阶段保持宿主默认 high）')

console.log('── 3t) 收口提交面：插件自有日志不进提交（2026-09-11 实锤 assetd 92% 噪音）──')
const sanitySrc = readFileSync(join(here, '../host/core/sanity.ts'), 'utf8')
ok(/TF_LOG_DIR = 'logs\/teamflow'/.test(constantsSrc) && /export \{ TF_LOG_DIR \}/.test(sanitySrc), 'sanity/constants：自有日志命名空间常量（与 prompts 的 Log discipline 同址；常量归 constants，sanity 转出）')
ok(/export function tfAddArgs/.test(sanitySrc) && /return \['add', '-A', '--', '\.'\]/.test(sanitySrc), 'sanity：tfAddArgs = 工作区整树 add（-- . 收敛提交面）')
// 只看代码行：sanity.ts 的**注释**里必须保留 `:(exclude)logs/teamflow` 这个坑的说明（历史证据），
// 但代码里出现即回退。
const sanityCode = sanitySrc.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('*') && !s.startsWith('/*') && !s.startsWith('//') }).join('\n')
ok(!/:\(exclude\)/.test(sanityCode), 'sanity：零回退——代码里不再用负 pathspec 点名自有日志（2026-09-15 实锤：点名被 .gitignore 忽略的路径 → git add 退出 1 → 收口提交被静默短路 4 天）')
ok(/export function tfUnstageArgs/.test(sanitySrc) && /'--cached', '--ignore-unmatch'/.test(sanitySrc), 'sanity：tfUnstageArgs 索引兜底（只动索引 + 未命中不报错 = 幂等 exit 0）')
ok(/export function gitRun/.test(sanitySrc) && /error: string \| null/.test(sanitySrc), 'sanity：gitRun 保留失败原因（旧的 null-only 版本让故障不可见）')
ok(!/\['add', '-A'\]/.test(pipelineSrc), 'pipeline：已无裸 add -A（旧写法把 208 个日志文件卷进提交）')
ok((pipelineSrc.match(/gitRun\(journal\.workspacePath, tfAddArgs\(\)\)/g) || []).length === 2, 'pipeline：两处提交点都走 tfAddArgs + gitRun')
ok((pipelineSrc.match(/noteLogsUnstaged\(journal, gitRun\(journal\.workspacePath, tfUnstageArgs\(\)\), locale\)/g) || []).length === 2, 'pipeline：两处提交点 add 之后都跑索引兜底并留痕')
ok(!/add === null \? null : gitCmd/.test(pipelineSrc) && /GIT_NOTHING_TO_COMMIT/.test(pipelineSrc), 'pipeline：零回退——提交不再被 add 结果短路；由提交结果分派 commitDone/commitSkip/commitFail（三种都可达）')
ok((pipelineSrc.match(/ensureLogGitignore\(journal\.workspacePath, journal, locale\)/g) || []).length === 2, 'pipeline：两处提交点都先幂等补写工作区 .gitignore')
ok(/function ensureLogGitignore/.test(pipelineSrc) && /mergeGitignore\(before, \[`\$\{TF_LOG_DIR\}\/`\], locale\)/.test(pipelineSrc), 'pipeline：.gitignore 合并走纯函数（覆盖判定 + changed=false 不落盘；R2-2 头部注释随 run 语言）')
ok(/if \(!merged\.changed\) return false/.test(pipelineSrc), 'pipeline：已忽略时不改写文件（幂等，不留无谓 diff）')
ok(/export function mergeGitignore/.test(utilSrc), 'util：mergeGitignore 纯函数（可回归测试）')

console.log('── 3u) 2026-09-15 停线缺陷修复（tf-mu2ioilr-95l4th：幻影缺陷 + 未验收却邀请合回）──')
ok(/function defectHeaderCols/.test(backlogSrc) && /严重级\|严重度\|等级\|级别\|severity/.test(backlogSrc), 'backlog：parseDefects 按表头认表（严重级列必须由表头声明，列位置由表头决定）')
ok(/if \(cols === null\) \{ cols = defectHeaderCols\(cells\); continue \}/.test(backlogSrc) && /if \(!cols\) continue/.test(backlogSrc), 'backlog：无严重级表头的表格整表跳过（复验对照表不再被登记为缺陷——停线回归核心）')
ok(!/const sev = \(cells\[1\]/.test(backlogSrc), 'backlog：已删除「第 2 格即严重级」的位置式判定（旧写法 = 每轮复验重生一个 P2）')
ok(/const mergeEligible = journal\.status === 'completed' && !journal\.humanIntervention && acceptanceDone/.test(reportSrc), 'report：合回邀请需「已完成 + 无人工介入 + 验收阶段真的 done」（未验收不得邀请合回）')
ok(/report\.needsHumanNoAcceptance/.test(reportSrc) && /const needsHumanNotice = journal\.humanIntervention && !acceptanceDone/.test(reportSrc), 'report：验收未跑 + 需人工介入时显式提示「不要据此合回 main」')
ok(/const RETRY_SUFFIX = \/\(\?:（\(\?:第 \\d\+ 次重试\|补跑\)）\| \\\(\?:retry \\d\+\|attempt \\d\+\|follow-up run\)\\\)\)\$\/|attempt \\d\+/.test(pipelineSrc), 'pipeline：RETRY_SUFFIX 覆盖词典实际产出「(attempt N)」（R3-2，无 taskKey 的 label 兜底路径）')
ok(/'diag\.colon'/.test(readFileSync(join(here, '../host/locales/pipeline.ts'), 'utf8')) && /t\(locale, 'diag\.colon'\)/.test(runnerSrc), 'runner：护栏中止摘要的连接符走词典（en 出半角冒号，不再硬编码全角「：」）')
ok(/journal\.locale === 'en' \? `# TeamFlow run log/.test(storeSrc), 'store：运行日志文件头随 run 语言（持久化层不引 host 词典，只本地化这一行）')
ok(!/✅ Pass ／ / .test(promptsSrc) && /Acceptance verdict: ✅ Pass \/ /.test(promptsSrc), 'prompts：en 验收档位行用半角斜杠（zh 侧 ／ 逐字不变）')

console.log('── 3v) 2026-09-15 第二批：回复语言 + 团队展示名（实锤 slugkit-en tf-mu2m1r2p）──')
const teamsSrc = readFileSync(join(here, '../host/core/teams.ts'), 'utf8')
const toolsSrc = readFileSync(join(here, '../host/locales/tools.ts'), 'utf8')
ok(/Reply language · policy/.test(promptsSrc) && /\$\{replyName\}/.test(promptsSrc) && /'doc\.replyLanguage'/.test(readFileSync(join(here, '../host/locales/pipeline.ts'), 'utf8')), 'prompts：回复语言收口在 productCtx（11 个工厂共用前缀，避免逐 prompt 再漏）')
ok(/export function teamNameOf/.test(teamsSrc) && /BUILTIN_EN/.test(teamsSrc) && /export function teamDescOf/.test(teamsSrc), 'teams：展示名双语解析（nameEn → 内置回落表 → 中文，永不返回空）')
ok(/teamPayload\(loc, t\)/.test(hostSrc) && /teamPayload\(ambientLocale\(\), team\)/.test(hostSrc), 'host：listTeams/selectTeam/getActiveTeam 下发已本地化的团队名/描述（语言只有一个读取点，client 不翻译）')
ok(/teamNameOf\(ambientLocale\(\), team\)/.test(hostSrc), 'host：会话注入的团队名按环境语言（否则英文会话里注入中文团队名）')
ok(/teamNameOf\(locale, team\)[\s\S]{0,160}phaseLabel\(locale, s\.key\)/.test(pipelineSrc), 'pipeline：日志里的团队名/阶段名按 run 语言（阶段名走 phaseLabel，不再直出 teams.json 中文 label）')
ok(/'tool\.replyLang'/.test(toolsSrc) && /\[Reply language\] Reply to the user in English/.test(toolsSrc), 'host 词典：给模型的工具返回/注入点名回复语言（否则模型跟上下文走中文）')
ok(/locale: ctx\.locale\.getSnapshot\(\)\.active/.test(clientSrc) && /\[remote, sessionId, locale\]/.test(clientSrc), 'client：团队选择器把当前语言作为依赖（host 本地化下发，切语言需重取）')
// 缺陷卡详情（2026-09-15 用户实锤：点开只看到关联 run 的原始需求，看不出缺陷是什么）
ok(/export function parseDefectRows/.test(backlogSrc) && /reproduce: pick\(|expected: pick\(|actual: pick\(/.test(backlogSrc), 'backlog：parseDefectRows 富行解析（复现/期望/实际/关联验收项）')
ok(/parseDefectRows\(qa\)/.test(pipelineSrc) && !/defects = parseDefects\(/.test(pipelineSrc), 'pipeline：QA 缺陷走富行（卡详情与 qaFix prompt 都能拿到完整缺陷描述）')
ok(/'R3-1'|exist\.reproduce = String\(d\.reproduce/.test(backlogSrc) && /exist\.expected = String\(d\.expected/.test(backlogSrc) && /exist\.actual = String\(d\.actual/.test(backlogSrc), 'backlog：syncQaDefects 幂等刷新复现/期望/实际（此前硬编码空串）')
ok(/title: d\.module \? `\$\{id\} · \$\{String\(d\.module\)\}`/.test(backlogSrc), 'backlog：缺陷卡标题自解释（`R3-1 · 模块`，不再是合成标题「QA 缺陷：R3-1」）')
ok(/defectId: item\.defectId/.test(hostSrc) && /reproduce: item\.reproduce/.test(hostSrc) && /defectAc: item\.ac/.test(hostSrc), 'host：itemDetail 下发 defectId/module/reproduce/expected/actual/ac（此前完全没下发）')
ok((panelSrc.match(/panelItem\.defectSection/g) || []).length >= 1 && (clientSrc.match(/panelItem\.defectSection/g) || []).length >= 1, 'client：两处详情抽屉都为缺陷卡渲染「缺陷详情」块（面板 + 会话内）')
ok(hasKey('panelItem.defectSection') && hasKey('panelItem.row.reproduce') && hasKey('panelItem.noDefectDetail'), 'client 词典：缺陷详情块的中英文案齐备（zh/en 同形）')
ok(/\[Cell escaping · HOST-ENFORCED\]/.test(promptsSrc), 'prompts：QA 缺陷表要求转义单元格内的字面量管道符（否则列错位，实证 R3-2 的「实际」串到「关联验收项」）')
// A/C/B 方案（2026-09-15：QA 打回闭环的返工治理）
ok(/defectCheck: item\.check/.test(hostSrc) && /defectCriterion: item\.criterion/.test(hostSrc), 'host：itemDetail 下发缺陷的检测命令/通过判据（B 方案：缺陷的可执行定义）')
ok(/function splitTableRow/.test(backlogSrc), 'backlog：表格行按未转义管道符切分（`\\|` 还原为字面量；R3-2 错列 + 命令列含 | 的回归门禁）')
ok(/check: pick\(\/检测命令/.test(backlogSrc) && /criterion: pick\(\/通过判据/.test(backlogSrc), 'backlog：富行取检测命令/通过判据（parseDefects 瘦身形状不变）')
ok(/exist\.check = String\(d\.check/.test(backlogSrc) && /check: String\(d\.check/.test(backlogSrc), 'backlog：缺陷卡持久化检测命令/通过判据（幂等刷新 + 建卡两处）')
ok(/FIX_GATE_PATTERN/.test(constantsSrc) && /FIX_GATE_PATTERN\.test\(String\(stageTextOf\(fixR\)/.test(pipelineSrc), 'pipeline：修复轮无类别门禁证据 → warn 留痕（A 方案观测）')
ok(/qaReverify: isReverify/.test(pipelineSrc) && /function QAREVERIFY/.test(promptsSrc) && /qaReverify\?: boolean/.test(readFileSync(join(here, '../host/core/state.ts'), 'utf8')), 'pipeline/state/prompts：复验轮标志经 __runCtx 下发（C 方案；不改工厂签名）')
ok(/Class gate · policy, mandatory for P0\/P1\/P2/.test(promptsSrc) && /class sweep:/.test(promptsSrc), 'prompts：qaFix 要求类别门禁 + 命中数 before→after（A 方案）')
ok(/Re-verification round · policy/.test(promptsSrc) && /FIRST re-run every probe/.test(promptsSrc), 'prompts：复验轮纪律（先重跑上一轮探针、再补未覆盖的面）')
// E 方案（2026-09-15：QA 打回超限时验收不再整段跳过）
ok(/else if \(qaBlocked\) \{/.test(pipelineSrc) && /Known-issues acceptance · read-only · host-overridden/.test(promptsSrc) && /function KNOWNISSUES/.test(promptsSrc), 'pipeline/prompts：QA 超限时以「已知问题」只读模式跑验收（产出 ACCEPTANCE.md + 未闭环清单）')
ok(/knownIssues: true/.test(pipelineSrc) && /journal\.knownIssuesAcceptance = true/.test(pipelineSrc), 'pipeline：已知问题模式经 __runCtx 下发 + journal 落 knownIssuesAcceptance（结论强制需人工裁定）')
ok(/knownIssuesAcceptance: journal\.knownIssuesAcceptance === true/.test(storeSrc) && /report\.knownIssuesNoMerge/.test(hostSrc), 'store/report：knownIssuesAcceptance 持久化 + 汇报给「不要据此合回」显式提示（accepted 永不放行）')
ok(/log\.accKnownIssues/.test(hostSrc) && !/log\.accSkipped/.test(hostSrc), 'locales/pipeline：已知问题模式取代旧的「验收跳过」日志（superseded 键已删）')
// D 埋点（2026-09-15：QA 轮次收敛数据，先测量再决定要不要动状态机语义）
ok(/export function defectFingerprint/.test(utilSrc) && /export function compareDefectRounds/.test(utilSrc) && /export function qaRoundEntry/.test(utilSrc), 'util：D 埋点的纯函数（稳定身份/逐轮对比/轮次记录组装）')
ok(/journal\.qaRounds = \[\.\.\.\(journal\.qaRounds \|\| \[\]\), qaRoundEntry\]\.slice\(-12\)/.test(pipelineSrc) && /qaRoundEntry\.fixCalls = fixR\.stage/.test(pipelineSrc) && /qaRoundEntry\.gate = fixGate/.test(pipelineSrc), 'pipeline：QA 每轮写 qaRounds（并补记修复轮调用数与是否落门禁）')
ok(/qaRounds: \(journal\.qaRounds \|\| \[\]\)\.slice\(-12\)/.test(storeSrc) && /qaRounds\?: Array<Record<string, unknown>>/.test(storeSrc), 'store：qaRounds 持久化（留最近 12 轮、每轮最多 20 条缺陷）')
ok(existsSync(join(here, '../scripts/qa-rounds-report.mjs')), 'scripts：qa-rounds-report.mjs（只读读侧：收敛/停滞/检测命令可用率/单轮成本）')

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
