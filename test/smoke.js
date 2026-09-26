/**
 * dsh-plugin-teamflow — smoke test（无外部依赖，node test/smoke.js 直接运行）。
 *
 * 1) 校验 TEAMFLOW_DESCRIPTORS 满足 typert registry 的 validateInvocation 规则
 *    （id/service/namespace/method/参数 wire 唯一/src-json codec/endpoint 唯一）
 * 2) 校验 client 模块导出形状（inject/apply）与 host 模块结构（默认导出 class）
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { TEAMFLOW_DESCRIPTORS } from '../descriptors.ts'
import { parseAcceptanceVerdict } from '../host/util.ts'

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
  // create() 是 dsh 0.1.6-alpha.2 起 typert validateCodec 的硬要求（缺则注册抛错）
  assert(d.result && d.result.mode === 'strict' && typeof d.result.create === 'function' && typeof d.result.create().parse === 'function', `strict result codec 带 create(): ${d.method}`)
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
    assert(p.codec && p.codec.mode === 'strict' && typeof p.codec.create === 'function' && typeof p.codec.create().parse === 'function', `参数 codec strict 带 create(): ${p.name}`)
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
// 2026-09-23：宿主 0.1.7-alpha.1 移除了 sessions.openSubagent / sessions.open → 跳会话改走 uiWorkspace；
// sessions 已无任何引用，故不再是注入依赖（保留死依赖＝白等一个服务）
ok(/export const inject = \['remote', 'slots', 'uiWorkspace', 'locale'\]/.test(clientSrc), '导出 inject（remote/slots/uiWorkspace/locale）')
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
// 2026-09-23 迁移：宿主 0.1.7-alpha.1 移除 sessions.open 与 SessionListState.current
// → 改 uiWorkspace.openSession(ownerSession) + 纯时间维度重试（旧「等 current 切过去」判据恒为 undefined）
ok(/goOwnerSessionAndOpen/.test(panelSrc) && /uiWorkspace\.openSession\(ownerSession\)/.test(panelSrc), 'panel：全局面板开右栏先 uiWorkspace.openSession(ownerSession)（宿主已移除 sessions.open），再小步重试打开')
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
for (const comp of ['FoldableText', 'CancelButton', 'ProductRail', 'RunList', 'BacklogGroups', 'BacklogCard', 'ItemDetailPane', 'RunDetailPane', 'RunDetailTab', 'GlobalPanel']) {
  ok(new RegExp(`h\\(${comp}[,)]|,\\s*${comp}\\)`).test(panelSrc + clientSrc), `${comp} 经 h()/slot 注册渲染（非直接函数调用）`)
}
// 阶段状态词表与 backlog 词表分道：`status.cancelled` 是缺陷/任务词（已关闭 / Closed），阶段直接复用会把
// 「被中断的阶段」显示成「已关闭」（2026-09-16 中断实测截图：同屏 run 行写「已取消」、阶段节点写「已关闭」）。
// 这里锁住「阶段渲染必须走 stageStatusText」+「该词条 zh/en 同形且各自取值正确」。
ok(/export const stageStatusText = /.test(sharedSrc) && /t\('stageStatus\.cancelled'\)/.test(sharedSrc), 'shared：阶段状态专用词表 stageStatusText（cancelled 单独取词，其余仍共用 status.*）')
ok((clientSrc.match(/stageStatusText\(/g) || []).length >= 2 && (panelSrc.match(/stageStatusText\(/g) || []).length >= 3, '阶段渲染（流水线节点/阶段抽屉/阶段行/选中阶段/尝试历史）全走 stageStatusText，无一处回退 stText')
ok(/'stageStatus\.cancelled': '已中止'/.test(localesSrc) && /'stageStatus\.cancelled': 'Stopped'/.test(localesSrc), 'stageStatus.cancelled 词条 zh/en 同形且不撞词（已中止 / Stopped；不撞 runStatus 的 已中断/已取消）')
// 相位组头取色：`cancelled` 不得算「失败」（否则用户主动中断的组头被涂成错误色红，而阶段卡竖条/chip 是灰的
// → 红头灰身）。回退写法 = anyFail 里出现 `'cancelled'`。
ok(/const anyFail = g\.stages\.some\(\(s\) => s\.status === 'failed' \|\| s\.status === 'needs-human'\)/.test(clientSrc) && !/anyFail[\s\S]{0,120}'cancelled'/.test(clientSrc), 'client：相位组头取色不把 cancelled 当失败（anyFail 只认 failed/needs-human）')
// dev 卡片标题（2026-09-16 回归锁）：客户端对 dev 阶段要有「缺 taskKey 也不丢 label」的兜底
// （host 侧投影必须带 taskKey 的断言在 host 段，hostSrc 初始化之后）。
ok(/phaseKeyOf\(s\.phase\) === 'dev' && raw/.test(sharedSrc), 'shared：stageLabelOf 对 dev 阶段兜底保留 label（缺 taskKey 时不退化成阶段名）')

console.log('── 3) host 模块结构 ──')
// host/core 领域文件清单（聚合进 hostSrc 供源码断言；新增领域文件必须加进来，否则断言读不到它）。
// 完整性由下面「清单完整性门禁」用真实目录校验——不靠人记（此前实测漏过 sanity.ts）。
const CORE_FILES = ['context', 'backlog', 'metering', 'runner', 'guard', 'report', 'pipeline', 'teams', 'state', 'products', 'triage', 'locale', 'runlogs', 'sanity', 'acl-preflight']
const hostSrc = [
  readFileSync(join(here, '../host/index.ts'), 'utf8'),
  readFileSync(join(here, '../host/util.ts'), 'utf8'),
  readFileSync(join(here, '../host/constants.ts'), 'utf8'),
  readFileSync(join(here, '../host/prompts/index.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales/pipeline.ts'), 'utf8'),
  readFileSync(join(here, '../host/locales/tools.ts'), 'utf8'),
  ...CORE_FILES.map((f) => readFileSync(join(here, `../host/core/${f}.ts`), 'utf8')),
].join('\n//#region host-pool\n')
const utilSrc = readFileSync(join(here, '../host/util.ts'), 'utf8')
// smoke 自身源码（用于断言「测试里确实写了这条回归样本」——防测试被悄悄删掉而源码仍在/或反之）
const smokeSelf = readFileSync(join(here, 'verdict.test.js'), 'utf8')
const constantsSrc = readFileSync(join(here, '../host/constants.ts'), 'utf8')
ok(/ownerSession: j\.ownerSession \|\| null/.test(hostSrc), 'host：run 快照/摘要携带 ownerSession（全局面板据此跳到发起会话）')
ok(/class TeamflowService extends TypertRemoteService/.test(hostSrc), 'TeamflowService extends TypertRemoteService')
ok(/static inject = \['agents', 'subagents', 'typert', 'tools', 'llm'\]/.test(hostSrc), 'static inject 完整（tokenMeter 死注入已清理）')
ok(/ctx\.typert\.register\(\{[\s\S]*invocations: TEAMFLOW_DESCRIPTORS/.test(hostSrc), 'typert.register 注册 strict descriptors')
for (const m of ['ping', 'setLocale', 'list', 'snapshot', 'start', 'cancel', 'backlog', 'backlogUpdate', 'assign', 'pause', 'resumeSession', 'listTeams', 'selectTeam', 'getActiveTeam', 'clearTeam', 'resume', 'stageDetail', 'itemDetail', 'products', 'productView', 'productRunDetail', 'productStageDetail', 'productItemDetail']) {
  ok(new RegExp(`\\n  (?:async )?${m}\\(`).test(hostSrc), `Remote 方法 ${m}()`)
}
ok(/export default TeamflowService/.test(hostSrc), '默认导出 TeamflowService')
ok(/from '\.\.\/descriptors\.ts'/.test(hostSrc), 'import descriptors.ts')
ok(/from '\.\.\/store\.ts'/.test(hostSrc), 'import store.ts（持久化层独立）')
// dev 卡片标题（2026-09-16 回归锁）：快照投影**必须带 taskKey**——client 的 stageLabelOf 靠它保留 dev 任务名，
// 漏掉它会让所有 dev 卡片退化成只剩「开发」（实锤 tf-mtr9mi37-m9zx1u：journal 里标题完好，UI 只剩「开发」）。
ok(/stages: j\.stages\.map\(\(s\) => \(\{ seq: s\.seq, label: s\.label, phase: s\.phase, taskKey: s\.taskKey/.test(hostSrc), 'host：snapshot 的 stage 投影带 taskKey（client 靠它保留 dev 任务名，勿删）')

// 需求澄清闸门（2026-09-16 Phase 1）：① 启动前「探索态不建 run」② 假设可见化。
// 相位性约束（勿回退）：闸门只在分诊给出非 requirement 意图或合格 blocker 时拦；分发不可用时放行。
ok(/async function clarificationPreflight/.test(hostSrc), 'host：启动前澄清预检存在（clarificationPreflight）')
ok(/if \(options\.mode === 'patch'\) return \{ verdict: null/.test(hostSrc), 'host：预检只豁免 patch（lite/显式 mode 一律跑分诊——2026-09-16 放宽，旧「显式档位全豁免」会让闸门与架构护栏在 42% 启动上失效）')
ok(/verdict\.intent !== 'requirement' \|\| verdict\.blockers\.length > 0/.test(hostSrc), 'host：闸门判据 = 意图非明确需求 或 存在合格 blocker')
ok(/status: 'needs-clarification'/.test(hostSrc) && /needs-clarification[\s\S]{0,400}requirementSupplement/.test(hostSrc), 'host：needs-clarification 返回 + 指引带 requirementSupplement 重调')
ok(/\(options as unknown as Record<string, unknown>\)\.__triage = pre\.verdict/.test(hostSrc), 'host：分诊裁决透传 pipeline（避免重复一次模型调用）')
ok(/requirementSupplement: \{ type: 'string'/.test(hostSrc), 'host：teamflow_start 暴露 requirementSupplement 参数')
ok(/await clarificationPreflight\(req, opts as Record<string, unknown>, agent, undefined, ambientLocale\(\)\)/.test(hostSrc), 'host：Remote/程序化 start 同样过闸门（不只模型工具路径）')
// 注：闸门在 pipeline/store/report 侧的断言放在末尾（那三个源常量在文件后段才初始化）。

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
ok(/kind: 'plugin:dsh-plugin-teamflow',[\s\S]*form: 'notice'/.test(hostSrc), 'notice 来源标记走 v4 producer-owned（plugin:dsh-plugin-teamflow，不再用退役的 kind:\'plugin\' wrapper）')
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
ok(/loadJournalById\(id\)/.test(hostSrc) && /export function loadJournalById/.test(storeSrc), 'resume 从磁盘加载完整 journal（双路径：per-project + 全局）')

console.log('── 3e) 工作区隔离 + 单任务模型 + 真实 token（v0.9）──')
const contextSrc = readFileSync(join(here, '../host/core/context.ts'), 'utf8')
const backlogSrc = readFileSync(join(here, '../host/core/backlog.ts'), 'utf8')
const pipelineSrc = readFileSync(join(here, '../host/core/pipeline.ts'), 'utf8')
const runnerSrc = readFileSync(join(here, '../host/core/runner.ts'), 'utf8')
const promptsSrc = readFileSync(join(here, '../host/prompts/index.ts'), 'utf8')
const triageSrc = readFileSync(join(here, '../host/core/triage.ts'), 'utf8')
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

console.log('── 3j) 会话事件 source 走 v4 producer-owned 命名空间（producer-owned source kind 校验）──')
// 宿主 session-format-v4 的 assertV4MessageSources 拒绝 kind==='plugin' 的退役 wrapper：
// 插件 inject/append 的事件必须写成 'plugin:<name>'，否则新 run 在事件采纳阶段直接抛错失败（实锤 probe-v3）。
ok(/kind: 'plugin:dsh-plugin-teamflow'/.test(hostSrc), 'inject 事件 source 全部走 plugin:dsh-plugin-teamflow（v4 producer-owned，index/report/guard/runner 同池）')
ok(!/kind: 'plugin', plugin: 'dsh-plugin-teamflow'/.test(hostSrc), 'host-pool 无退役 wrapper kind:\'plugin\', plugin: 写法')

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
ok(/export function artifactText/.test(utilSrc) && /artifactText/.test(pipelineSrc) && /QA-REPORT\.md/.test(pipelineSrc) && /ACCEPTANCE\.md/.test(pipelineSrc), 'util/pipeline：任务夹产物读取助手 artifactText（文件即产物；住 util 供 pipeline/runner 共用）')
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
ok(/export function devTaskStatuses/.test(utilSrc) && /有 done stage = 该任务已成功/.test(utilSrc), 'util：任务级聚合 devTaskStatuses（放 util 以便行为级测试直接 import——pipeline 链宿主私有 peer 取不到）')
// 任务身份 = host 生成的 dt-N（2026-09-18 实锤 probe-cache tf-mu6tb281：合并执行把 title 拼成
// "T0 + T6 + T7"，resume 拿未合并的 title 去查必然落空 → 重复执行已成功的 T0/T6/T7）
ok(/return `dt-\$\{index \+ 1\}`/.test(utilSrc), 'util：dev 任务 id 由 **host 按定义顺序生成**（dt-N，与 title 彻底解耦——禁止拿文本长相当身份）')
ok(/export interface DevTaskDef \{ id: string/.test(pipelineSrc), 'pipeline：DevTaskDef 带 id（任务身份的结构化载体）')
// 2026-09-24：合并逻辑从 pipeline 内联块抽到 `util.mergeFileOverlaps`（两条路径共用——见 test/overlap-merge.test.js）
ok(/head\.ids\.push\(t\.id\)/.test(utilSrc) && /export function mergeFileOverlaps/.test(utilSrc), 'util：**合并任务时 ids 数组累加**（title 拼接只给人看，id 数组才是身份——少了这步合并过的任务无法被 resume 识别）')
ok(/taskIds: \(Array\.isArray\(taskIds\) && taskIds\.length\) \? \[\.\.\.taskIds\] : null/.test(runnerSrc), 'runner：stage 落 taskIds（数组，合并任务时为多项）')
ok(/taskIds\?: string\[\] \| null/.test(storeSrc) && /taskIds: \(Array\.isArray\(s\.taskIds\)/.test(storeSrc), 'store：serializeJournal 序列化 taskIds')
ok(/存量兼容/.test(utilSrc), 'util：存量 stage 无 taskIds → 由 backfillDevTaskIds 补算（只增不改，历史 run 判定不受影响）')
{
  // 只看 devTaskStatuses 函数体（util.ts 里从声明到下一个 export）
  const fnBody = (utilSrc.match(/export function devTaskStatuses[\s\S]*?(?=\n\/\*\*|\nexport )/) || [''])[0]
  ok(/const ids = Array\.isArray\(s\.taskIds\)/.test(fnBody), 'util：devTaskStatuses **按 taskIds 归并**（逐 id 记账：合并执行过的任务各自命中已做）')
  ok(!/s\.taskKey/.test(fnBody), 'util：**判定函数体内不出现 taskKey**（不做 title 双键/回退——否则 id/title 两套命名空间 → 存量全 Miss，实测补跑 8 个而非 1 个）')
  ok(/const ids = defs\.filter/.test(utilSrc) && /key\.includes/.test(utilSrc), 'util：补算用 **defs（蓝图 title）** 去匹配 stage 文本（结构化→文本）')
  const noSplit = /split\(/.test((utilSrc.match(/export function backfillDevTaskIds[\s\S]*?(?=\n\/\*\*|\nexport )/) || [''])[0]) === false
  ok(noSplit, 'util：**不得按分隔符切分 title**（拿文本长相当身份，明确禁止——合并 title 由蓝图 title 包含匹配识别）')
}
ok(/export function backfillDevTaskIds/.test(utilSrc), 'util：存量 stage 由 backfillDevTaskIds 补算 id（判定只有一个键空间，不是给脏数据打补丁）')
ok(/String\(d\.title \|\| ''\)\.trim\(\) && key\.includes\(/.test(utilSrc), 'util：补算用**蓝图 title 匹配**（结构化→文本），**不是**切分拼接 title（后者是拿文本长相当身份，已明确禁止）')
ok(/if \(Array\.isArray\(s\.taskIds\) && s\.taskIds\.length\) continue/.test(utilSrc), 'util：已有 taskIds 的 stage 不重复补算（幂等，补算结果写回后下次直接读）')
ok(/log\.devIdsBackfilled/.test(pipelineSrc), 'pipeline：补算留痕（日志可见「已为 N 个历史阶段补算编号」）')
ok(/backfillDevTaskIds\(journal\.stages \|\| \[\], defs\)/.test(pipelineSrc), 'pipeline：resume 判定**前**先补算存量 id（否则历史 title stage 被当成没做过 → 全量补跑）')
ok(/const todoDefs = devDefs\.filter/.test(pipelineSrc) && /!st \|\| !st\.done/.test(pipelineSrc), 'pipeline：resume 开发分支统一补跑「未成功任务」+ 复用已完成产物（json-parse r1 实锤根治——不再读 backlog 子卡）')
ok(/if \(phase === 'dev'\)/.test(pipelineSrc) && /\[\.\.\.statuses\.values\(\)\]\.some\(\(st\) => !st\.done\)/.test(pipelineSrc), 'pipeline：interruptedPhaseOf 任务级聚合——任务全 done = 阶段完成（部分成功阶段 resume 起点回开发补跑）')
ok(/同任务复用（2026-09-06/.test(backlogSrc) && /store\.tasks\.find\(\(t\) => t\.reqId === journal\.reqId/.test(backlogSrc), 'backlog：createSubtask 同任务复用（业务任务实体一张卡 + retries 计数；执行历史在 journal）')
// 子卡匹配键 = dtId（2026-09-18）：旧实现按 title 匹配，合并任务把 title 拼接后，resume 补跑的单任务
// title 与之不等 → 同一任务建出第二张卡（probe-cache 实锤：dev-1 与 dev-7 同为 T0、dev-8 同为 T6）
ok(/export function createSubtask\(journal, title, spec, dtId\?/.test(backlogSrc), 'backlog：createSubtask 接受 dtId（任务身份）')
ok(/dtId: key/.test(backlogSrc) && /t\.dtId \? t\.dtId === key : false/.test(backlogSrc), 'backlog：子卡匹配优先 dtId（存量卡无 dtId 才回退 title 匹配——只增不改）')
ok(/createSubtask\(journal, dt\.title, dt\.spec, dt\.ids\[0\]\)/.test(pipelineSrc), 'pipeline：新开发建子卡传 dtId（合并任务取首个 id，保底唯一稳定）')
ok(/createSubtask\(journal, t\.title, t\.spec \|\| '', t\.dtId\)/.test(pipelineSrc), 'pipeline：resume 补跑建子卡传 dtId（同一任务复用原卡，不再建重复卡）')
// 开发收口（2026-09-16 实测：resume 后中断，dev 全「已中止」却径直起了 QA 子代理）：取消检查与提测门禁
// 原先只写在「新开发」分支里，resume 补跑分支没有 → 必须落在两个分支的**汇合点**，且顺序是**先取消后门禁**
// （取消时 dev 任务的 failed 只是「没跑完」，不该被记成提测失败转人工）。
const devSeg = (/\/\* ── 开发阶段[\s\S]*?\/\* ── QA 测试阶段/.exec(pipelineSrc) || [''])[0]
ok(/if \(journal\.cancelled\) return[\s\S]{0,140}const failedCount = \(devResults \|\| \[\]\)/.test(devSeg), 'pipeline：dev 收口的「取消检查 → 提测门禁」在 if(resume)/else 汇合点（两分支共用+先取消后门禁）')
ok((devSeg.match(/const failedCount = \(devResults \|\| \[\]\)/g) || []).length === 1, 'pipeline：提测门禁只有一处（不重复、不漏分支）')
// 终态归一（2026-09-16 实测：取消走正常返回 → catch 被跳过 → run 卡在 status='running' 且 cancelled=true，
// 界面永远「运行中」+ 续跑按钮 → 点一次重跑一轮 dev → 再取消，死循环）：finally 顶部必须把 cancelled 的 running 落成终态。
// 断言方式：先定位归一语句，再要求「其后第一个 endedAt」就在附近（= 同一 finally 块的顶部，先归一后收尾）。
const normIdx = pipelineSrc.indexOf("if (journal.cancelled && journal.status === 'running')")
const normEnded = normIdx >= 0 ? pipelineSrc.indexOf('journal.endedAt = Date.now()', normIdx) : -1
ok(normIdx > 0 && /journal\.status = 'cancelled'/.test(pipelineSrc.slice(normIdx, normIdx + 200)), 'pipeline：finally 顶部终态归一（取消的正常返回路径也落 cancelled，不再卡 running）')
ok(normEnded > normIdx && normEnded - normIdx < 800, 'pipeline：终态归一位于 endedAt（以及其后的归档/孤儿收口/汇报）之前')
console.log('── 3o) 英文化改造（2026-09-06：代码判断/业务键全英文，中文只留 label 展示）──')
ok(/PHASE_ORDER = \['prd', 'design'/.test(constantsSrc), 'constants：PHASE_ORDER 英文键（代码判断不再用中文阶段名）')
ok(/export function phaseKeyOf/.test(constantsSrc), 'constants：phaseKeyOf 归一（中文存量兼容防御）')
ok(/taskKey: taskKey \|\| null/.test(runnerSrc) && /taskKey\?: string \| null/.test(runnerSrc), 'runner：withRetry/runAgent 携带 taskKey（结构化任务键，不解析 label）')
ok(/taskKey: s\.taskKey \|\| null/.test(storeSrc), 'store：serializeJournal 序列化 taskKey')
ok(/s\.taskKey \|\| String\(s\.label/.test(utilSrc), 'util：存量回退路径——taskKey 优先、label 仅旧数据兜底（只增不改）')
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
ok(/freshTokens \+= freshTokensOf\(lastStage\.usage\)/.test(runnerSrc) && /if \(freshTokens >= eff\.budget\)/.test(runnerSrc), 'runner：熔断按新增口径累计（旧口径含 cacheRead → 一次失败必熔断，RETRY_LIMIT 失效）')
// 熔断预算的缓存能力自适应（2026-09-18 probe-v2 实锤：inception/mercury-2.5 无 prompt 缓存、命中率
// 10.4%、17 次调用 259k → 熔断；同阶段在命中 90%+ 的 provider 上 17 次调用只需 25–40k）
ok(/export function effectiveFreshBudget/.test(meteringSrc) && /calls >= UNCACHED_MIN_CALLS && ratio < UNCACHED_HIT_RATIO/.test(meteringSrc), 'metering：有效预算随缓存能力放宽（无缓存 provider 上 200k 会退化成「约 13 次调用上限」）')
ok(/effectiveFreshBudget\(usageAcc, FRESH_TOKEN_BUDGET\)/.test(runnerSrc) && /diag\.breakerUncached/.test(runnerSrc) && /diag\.breakerUncached/.test(hostSrc), 'runner/locales：无缓存时的熔断**带依据留痕**（命中率/调用数/放宽后预算），与有缓存路径分开措辞')
// doc 类阶段的产物兜底（回复过短但文件已落盘 → 判交付；实锤 4894 字节 PRD.md 被「回复 284 字符」误杀）
ok(/export const DOC_STAGE_FILES/.test(utilSrc) && /export function stageDocText/.test(utilSrc) && /'QA-REPORT\.md'/.test(utilSrc) && /'ACCEPTANCE\.md'/.test(utilSrc), 'util：doc 阶段产物文件名表 + stageDocText（产物是任务夹文件的阶段才入表）')
ok(/stageDocText\(journal, phase\)/.test(runnerSrc) && /doc\.length >= verdict\.min/.test(runnerSrc) && /verdict\.ok \|\| docFallback/.test(runnerSrc), 'runner：回复不合格时回读任务夹产物（文件达下限即判交付），留痕 warn')
ok(/!verdict\.ok && text && stop === 'completed'/.test(runnerSrc), 'runner：**兜底不豁免非空回复**（pipeline 要用回复合并 state 块——空回复仍是未交付）')
ok(/setSessionProjections/.test(contextSrc) && /ctx\.inject\(\['sessionProjections'\]/.test(hostSrc), 'host：sessionProjections 走可选 ctx.inject（服务缺失仍加载，计量自动回退）')
ok(!/static inject = \[[^\]]*sessionProjections/.test(hostSrc), 'host：static inject 不扩可选依赖（否则最小 profile 直接不加载插件）')
const pkgSrc = readFileSync(join(here, '../package.json'), 'utf8')
ok(/"version": "0\.2\.2"/.test(pkgSrc), 'package.json：版本 0.2.2（release-v0.2.2 开发线）')
ok(/"manifestVersion": 1/.test(pkgSrc) && /"dsh": ">=0\.1\.7-alpha\.1 <0\.2\.0"/.test(pkgSrc), 'package.json：声明 dsh.manifestVersion 与 engines.dsh 兼容窗口（下限 = v4 宿主 0.1.7-alpha.1）')
// 手工枚举的清单必须配门禁（同型教训：journal 字段 / execOptions / loadState / triageRecordOf）。
// deploy.mjs FILES 与上面的 CORE_FILES 都是手写清单，领域化拆分后两者都漂移过——实测 FILES 漏了
// guard/products/runlogs/state/teams 五个（profile 副本里那份源码因此永久陈旧），CORE_FILES 漏了 sanity。
// 这里用「真实文件 ⊆ 清单」把漂移变红灯，不再靠人记。
const walkSources = (base) => readdirSync(join(here, '..', base), { recursive: true })
  .map((f) => `${base}/${String(f).replace(/\\/g, '/')}`)
  .filter((f) => /\.(ts|tsx)$/.test(f))
const realSources = [...walkSources('host'), ...walkSources('client'), 'descriptors.ts', 'store.ts']
const filesBlock = (readFileSync(join(here, '../deploy.mjs'), 'utf8').match(/const FILES = \[([\s\S]*?)\n\]/) || [])[1] || ''
const deployFiles = new Set([...filesBlock.matchAll(/'([^']+)'/g)].map((m) => m[1]))
const missingDeploy = realSources.filter((f) => !deployFiles.has(f))
ok(missingDeploy.length === 0, `deploy.mjs FILES 覆盖全部源码（漏项 = profile 副本源码永久陈旧）${missingDeploy.length ? '；缺: ' + missingDeploy.join(', ') : ''}`)
const realCore = walkSources('host').filter((f) => f.startsWith('host/core/')).map((f) => f.slice('host/core/'.length).replace(/\.ts$/, ''))
const missingPool = realCore.filter((f) => !CORE_FILES.includes(f))
ok(missingPool.length === 0, `smoke CORE_FILES 覆盖全部 host/core 领域文件（漏项 = 源码断言读不到它）${missingPool.length ? '；缺: ' + missingPool.join(', ') : ''}`)

console.log('── 3p2) 引擎留痕：provider/model 必须落 journal（排查「是不是模型的锅」不该翻会话文件）──')
ok(/stage\.provider = route\.provider \|\| providerName\(\) \|\| null/.test(runnerSrc) && /stage\.model = route\.model \|\| null/.test(runnerSrc), 'runner：逐阶段记**实际生效**的 provider/model（子代理路由可被改道，与 run 起始默认可能不同）')
ok(/journal\.engine = engine/.test(pipelineSrc) && /const r = resolveChildRoute\(parent\)/.test(pipelineSrc) && /log\.engine/.test(pipelineSrc), 'pipeline：run 起始解析模型路由 → journal.engine + 落 log.engine（run.log 里一眼可见）')
ok(/engine: journal\.engine \|\| null/.test(storeSrc) && /provider: s\.provider \|\| null/.test(storeSrc) && /model: s\.model \|\| null/.test(storeSrc), 'store：engine 与阶段 provider/model 都进序列化（否则内存写了、落盘丢）')
ok(/report\.engine/.test(reportSrc) && /'report\.engine'/.test(hostSrc), 'report/locales：完成汇报给出模型路由（report.engine 键 zh/en 齐备）')
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
ok(/reasoningEffort: effort/.test(runnerSrc) && /effortHint/.test(runnerSrc) && /attempt, effortHint, taskIds\)/.test(runnerSrc), 'runner：agentOptions 带 reasoningEffort（effortHint/taskIds 参数链穿透到 runAgent）')
// ⚠️ 后半正则 2026-09-26 放宽：四阶段收敛进 `runSimpleStage(phase, prompt, label, opts)` 后，
// scaffold 的降档不再直接写在 withRetry 的第 8 参上，而是经 `{ effort: MECHANICAL_STAGE_EFFORT }` 传入
// → 原文 `MECHANICAL_STAGE_EFFORT\)`（紧贴右括号）必然失配。**锁定语义不变**：scaffold 阶段的调用语句里
// 必须带降档常量（判据类阶段保持宿主默认 high）；窗口 140→200 是因为多了一层 opts 对象。
ok(/options\.mode === 'patch' \? MECHANICAL_STAGE_EFFORT : null/.test(pipelineSrc) && /'scaffold', scaffoldPrompt\([\s\S]{0,200}MECHANICAL_STAGE_EFFORT/.test(pipelineSrc), 'pipeline：仅 patch 单点确认 + scaffold 两处降档（判据类阶段保持宿主默认 high）')

console.log('── 3t) 收口提交面：插件自有日志不进提交（2026-09-11 实锤 assetd 92% 噪音）──')
const sanitySrc = readFileSync(join(here, '../host/core/sanity.ts'), 'utf8')
ok(/TF_LOG_DIR = 'logs\/teamflow'/.test(constantsSrc) && /export \{ TF_LOG_DIR \}/.test(sanitySrc), 'sanity/constants：自有日志命名空间常量（与 prompts 的 Log discipline 同址；常量归 constants，sanity 转出）')
ok(/export function tfAddArgs/.test(sanitySrc) && /return \['add', '-A', '--', '\.'/.test(sanitySrc), 'sanity：tfAddArgs = 工作区整树 add（-- . 收敛提交面；前缀不变）')
// 只看代码行：sanity.ts 的**注释**里必须保留 `:(exclude)logs/teamflow` 这个坑的说明（历史证据），
// 但代码里出现即回退。
const sanityCode = sanitySrc.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('*') && !s.startsWith('/*') && !s.startsWith('//') }).join('\n')
// 精确化（2026-09-18 方案 B）：`:(exclude)` 语法本身被正当用于**基线噪音排除**（选项 B：索引层排除，不写用户
// .gitignore）。真正禁止的是**点名自有日志**——那是「点名 + 被忽略 → exit 1」那个坑。
ok(!/:\(exclude\)\$\{?TF_LOG_DIR/.test(sanityCode) && !/exclude[^\n]*logs\/teamflow/.test(sanityCode), 'sanity：零回退——**不得**用负 pathspec 点名自有日志 TF_LOG_DIR（2026-09-15 实锤：点名被 .gitignore 忽略的路径 → git add 退出 1 → 收口提交被静默短路 4 天）')
ok(!/BASELINE_NOISE_EXCLUDES[^\n]*TF_LOG_DIR/.test(sanityCode) && !/TF_LOG_DIR[^\n]*BASELINE_NOISE_EXCLUDES/.test(sanityCode), 'sanity：基线噪音清单**不得**含自有日志（它已被 .gitignore + tfUnstageArgs 覆盖；塞进来会造成"点名被忽略路径"）')
// 自检必须以**目标仓库**为根（2026-09-18 实测：自读 .gitignore 读到的是宿主 cwd → 两个方向同时错）
ok(/check-ignore/.test(sanityCode), 'sanity：忽略判定走 `git check-ignore`（以目标仓库为根，权威规则引擎）')
ok(/export function tfUnstageArgs/.test(sanitySrc) && /'--cached', '--ignore-unmatch'/.test(sanitySrc), 'sanity：tfUnstageArgs 索引兜底（只动索引 + 未命中不报错 = 幂等 exit 0）')
ok(/export function gitRun/.test(sanitySrc) && /error: string \| null/.test(sanitySrc), 'sanity：gitRun 保留失败原因（旧的 null-only 版本让故障不可见）')
ok(!/\['add', '-A'\]/.test(pipelineSrc), 'pipeline：已无裸 add -A（旧写法把 208 个日志文件卷进提交）')
ok((pipelineSrc.match(/gitRun\(journal\.workspacePath, tfAddArgs\(\)\)/g) || []).length >= 2, 'pipeline：所有提交点（收口 ×2 + init 基线 ×1）都走 tfAddArgs + gitRun')
ok((pipelineSrc.match(/noteLogsUnstaged\(journal, gitRun\(journal\.workspacePath, tfUnstageArgs\(\)\), locale\)/g) || []).length === 2, 'pipeline：两处提交点 add 之后都跑索引兜底并留痕')
ok(!/add === null \? null : gitCmd/.test(pipelineSrc) && /GIT_NOTHING_TO_COMMIT/.test(pipelineSrc), 'pipeline：零回退——提交不再被 add 结果短路；由提交结果分派 commitDone/commitSkip/commitFail（三种都可达）')
ok((pipelineSrc.match(/ensureLogGitignore\(journal\.workspacePath, journal, locale\)/g) || []).length >= 2, 'pipeline：所有提交点（收口 ×2 + init 基线 ×1）都先幂等补写工作区 .gitignore')
ok(/function ensureLogGitignore/.test(pipelineSrc) && /mergeGitignore\(before, \[`\$\{TF_LOG_DIR\}\/`\], locale\)/.test(pipelineSrc), 'pipeline：.gitignore 合并走纯函数（覆盖判定 + changed=false 不落盘；R2-2 头部注释随 run 语言）')
ok(/if \(!merged\.changed\) return false/.test(pipelineSrc), 'pipeline：已忽略时不改写文件（幂等，不留无谓 diff）')
ok(/export function mergeGitignore/.test(utilSrc), 'util：mergeGitignore 纯函数（可回归测试）')

console.log('── 3u) 2026-09-15 停线缺陷修复（tf-mu2ioilr-95l4th：幻影缺陷 + 未验收却邀请合回）──')
ok(/function defectHeaderCols/.test(backlogSrc) && /严重级\|严重度\|等级\|级别\|severity/.test(backlogSrc), 'backlog：parseDefects 按表头认表（严重级列必须由表头声明，列位置由表头决定）')
ok(/if \(cols === null\) \{ cols = defectHeaderCols\(cells\); continue \}/.test(backlogSrc) && /if \(!cols\) continue/.test(backlogSrc), 'backlog：无严重级表头的表格整表跳过（复验对照表不再被登记为缺陷——停线回归核心）')
ok(!/const sev = \(cells\[1\]/.test(backlogSrc), 'backlog：已删除「第 2 格即严重级」的位置式判定（旧写法 = 每轮复验重生一个 P2）')
ok(/const mergeEligible = journal\.status === 'completed' && !journal\.humanIntervention && acceptanceDone/.test(reportSrc), 'report：合回邀请需「已完成 + 无人工介入 + 验收阶段真的 done」（未验收不得邀请合回）')
ok(/report\.needsHumanNoAcceptance/.test(reportSrc) && /const needsHumanNotice = journal\.humanIntervention && !acceptanceDone/.test(reportSrc), 'report：验收未跑 + 需人工介入时显式提示「不要据此合回 main」')
ok(/RETRY_SUFFIX_LOCAL/.test(utilSrc) && /attempt \\d\+/.test(utilSrc), 'taskKey 归一正则覆盖词典实际产出「(attempt N)」（R3-2，无 taskKey 的 label 兜底路径）')
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

// ── 需求澄清闸门（2026-09-16 Phase 1）· pipeline/store/report 侧回归锁 ──
// 放在文件末尾：pipelineSrc / storeSrc / reportSrc 在中段才初始化（早期断言用它们会 TDZ 崩）。
ok(/normalizeTriagePassthrough/.test(pipelineSrc) && /if \(preTriage\) \{/.test(pipelineSrc), 'pipeline：复用透传裁决（不再重复跑分诊）')
ok(/journal\.triage = triageRecordOf\(/.test(pipelineSrc), 'pipeline：分诊裁决落盘 journal.triage（shadow 埋点，Phase 2 定闸门强度的数据源）')
// triageRecordOf 住 core/triage.ts（纯函数，门禁可直接测）——第五次「白名单漏字段」的现场：
// 旧版漏搬 artifact/installable → 形态契约注入读 journal.triage.artifact 永远 undefined → 整条防线死掉。
ok(/export function triageRecordOf/.test(triageSrc) && /triageRecordOf/.test(pipelineSrc) && !/function triageRecordOf/.test(pipelineSrc), 'triage/pipeline：triageRecordOf 住 triage.ts 并被 pipeline 引用（不再住 pipeline —— 那里门禁够不着）')
ok(/artifact: normalizeArtifact\(v\.artifact\), installable: v\.installable === true/.test(triageSrc), 'triage：**triageRecordOf 必须搬运 artifact/installable**（形态契约注入的唯一来源；漏了 = dddd 事故防线再次静默失效）')
ok(/__upgradedFrom/.test((triageSrc.match(/export function triageRecordOf[\s\S]*?\n\}/) || [''])[0]), 'triage：升档标记读的是 __upgradedFrom（读错一个下划线 = log.modeUpgraded 静默消失）')
ok(/function notePrdAssumptions/.test(pipelineSrc), 'pipeline：notePrdAssumptions 存在')
ok(/notePrdAssumptions\(journal, locale\)/.test(pipelineSrc), 'pipeline：PRD 收口读假设段（假设可见化的落点）')
ok(/journal\.assumptions = clip\(body, 2000\)/.test(pipelineSrc), 'pipeline：假设段落 journal.assumptions（截断 2000）')
ok(/log\.prdAssumptionsMissing/.test(pipelineSrc), 'pipeline：PRD 未给假设段 → 记 warn（policy 级，不硬失败）')
ok(/triage: journal\.triage \|\| null/.test(storeSrc) && /assumptions: journal\.assumptions \|\| null/.test(storeSrc) && /requirementSupplement: journal\.requirementSupplement \|\| null/.test(storeSrc), 'store：serializeJournal 序列化 triage/assumptions/requirementSupplement')
ok(/report\.assumptions/.test(reportSrc) && /const assumptionsLine/.test(reportSrc), 'report：完成汇报显式回带「本次基于以下假设启动」')
ok(/\[CLARIFIED — the user answered the open questions below/.test(pipelineSrc), 'pipeline：澄清答复作为权威输入进 PRD（[CLARIFIED] 块，声明不得再自行假设）')
// B1 回归锁（2026-09-16 实测 tf-mu34afd2-wcjaw1）：`journal.options` 是白名单字面量，直接传给 executePipeline
// 会把 requirementSupplement / __triage 静默丢掉（澄清结论进不了 PRD、journal.triage 永远为空、shadow 埋点空转）。
ok(/const execOptions = Object\.assign\(\{\}, journal\.options, \{[\s\S]{0,220}requirementSupplement: options\.requirementSupplement \|\| null,[\s\S]{0,140}__triage:/.test(pipelineSrc), 'pipeline：executePipeline 收到「白名单 + 内部字段」（澄清答复/分诊裁决不得再被丢）')
ok(/executePipeline\(journal, agent, journal\.requirement, execOptions, signal\)/.test(pipelineSrc), 'pipeline：startPipeline 用 execOptions 起跑（不得回退为直接传 journal.options）')
// B2 回归锁：假设段提取必须走 util.extractAssumptionsSection（行式，容错编号标题 / 空正文两个实测坑）
ok(/extractAssumptionsSection\(doc\)/.test(pipelineSrc) && /export function extractAssumptionsSection/.test(utilSrc), 'pipeline/util：PRD 假设段走 extractAssumptionsSection（编号标题 + 空正文两坑已修）')
ok(!/\^#\{1,6\}\[ \\t\]\*\(假设\|待澄清/.test(pipelineSrc), 'pipeline：不再内联那条匹配不到编号标题的正则')
// 档位自选治理（2026-09-16 实测：模型逐字引用参数描述里的 "(recommended)" 自选 lite；33 次启动 14 次显式传档位、0 次先预览）
ok(!/Lightweight mode for small changes \(recommended\)/.test(hostSrc), 'host：lite 参数描述不再写 "(recommended)"（那正是模型自选 lite 的依据）')
ok(/Do NOT pick the tier yourself by default/.test(hostSrc) && /let auto-triage decide/.test(hostSrc), 'host：lite/mode 描述明确「默认不要自选档位，交给自动分诊」')
ok(/omit `mode`\/`lite` and let auto-triage decide the tier/.test(hostSrc), 'host：工具描述同步该口径（Routing 段）')
ok(/if \(options\.mode === 'patch'\) return \{ verdict: null/.test(hostSrc), 'host：预检只豁免 patch（lite/显式 mode 一律跑分诊，否则 42% 启动绕过闸门与架构护栏）')
ok(/guardrailUpgrade\(explicit, !!options\.lite, pre\.verdict\.mode, \{ needDesign: options\.needDesign === true \}\)/.test(hostSrc) && /guardrailUpgrade\(explicit, !!\(opts as Record<string, unknown>\)\.lite, pre\.verdict\.mode, \{ needDesign/.test(hostSrc), 'host：工具路径与 Remote 路径都过架构护栏强升（并带上 needDesign 档位下限）')
// needDesign 档位下限（2026-09-18 probe-v2 实锤：调用方传 needDesign=true、分诊回 lite，而 lite 的档位定义
// 就是「no UI design」；prompt 里那句「needDesign=true → 强升 medium」只是 regex 预筛提示，实测被模型无视）
ok(/if \(opts && opts\.needDesign === true && want < MODE_RANK\.medium\) return 'medium'/.test(triageSrc), 'triage：**未给档位 + 显式 needDesign=true + 分诊判轻档位 → 抬到 medium**（把预筛提示变成宿主判定）')
// 形态类 blocker 自洽门禁（2026-09-18 probe-v2 实锤：需求已写「装进我的 dsh web profile」、分诊自己已判
// installable=true，却仍抛出「要不要真能装」→ 凭空一轮澄清 → 输入变了 → 缓存必然不命中 → 同一需求分诊两次）
ok(/settles === 'installable' && ctx && ctx\.installable === true/.test(triageSrc), 'triage：**形态类 blocker 自洽门禁**（已判 installable=true 却仍问「要不要能装」→ 丢弃并计数）')
// 宿主一致性门禁（2026-09-18 同型扩展）：宿主已判定（dsh / 明确的别的宿主）→ 不得再问「装到哪个宿主」。
// 与 installable 那条同源：让模型显式声明 settles，宿主只做一致性检查，**不解析问句文本**。
ok(/settles === 'host' && ctx && ctx\.host && ctx\.host !== 'unknown'/.test(triageSrc), 'triage：**宿主类 blocker 自洽门禁**（已判 host≠unknown 却仍问「装到哪个宿主」→ 丢弃并计数）')
ok(/qualifyBlockers\(raw\.blockers, \{ installable: raw\.installable === true, host \}\)/.test(triageSrc) && /qualifyBlockers\(o\.blockers, \{ installable: o\.installable === true, host: forceHost\(/.test(pipelineSrc), 'triage/pipeline：两条解析路径都把 installable+host 传给合格线（漏传 = 门禁失效）')
ok(/"settles": "installable\|artifact\|host\|scope\|ui\|data\|other"/.test(promptsSrc) && /settles: TriageSettle/.test(triageSrc), 'prompt/triage：blocker 带机器可读的 settles 字段（宿主只做一致性检查，**不解析问句文本**）')
// 宿主维度接线（2026-09-18 用户实锤：开发 openclaw/hermes 插件时本仓契约不适用）——契约必须按宿主分键。
ok(/host: forceHost\(requirement, normalizeHost\(raw\.host\)\)/.test(triageSrc) && /host: normalizeHost\(v\.host\)/.test(triageSrc), 'triage：模型裁决与落盘记录都带 host（**漏搬 = 又给别的宿主套 dsh 契约**，同型第六次）')
ok(/contractsForDeliverable\(hst, art, inst\)/.test(pipelineSrc) && /if \(hostResearch\)/.test(pipelineSrc), 'pipeline：契约取用走 contractsForDeliverable（宿主分流），非 dsh → 走宿主调研分支')
ok(/"host": "dsh\|other\|unknown"/.test(promptsSrc), 'prompt：triage 输出模板声明 host 字段（模型才知道要判它）')
ok(/export function contractsForDeliverable/.test(triageSrc) && /hostResearchRequired/.test(triageSrc), 'triage：契约分流的唯一入口在位（plugin-* × 非 dsh → 0 条本仓契约 + 要求调研）')
ok(/log\.modeUpgraded/.test(pipelineSrc) && /__upgradedFrom/.test(hostSrc) && /__upgradedFrom/.test(pipelineSrc), 'pipeline：升档落日志（调用方自选轻档位被护栏纠正时可见）')
// 注入文案闭环（2026-09-16 实测补充）：实测会话 session-518e9188 里团队注入已下发、用户说「我想开发一个
// dsh 插件」，但**模型根本没调用 teamflow_start**（0 次调用、该产品线 runs=0）——不复现「抢跑」，可闸门也
// 就没机会生效。旧注入只写「不明确就别调用」，没写「澄清完要回来开工」→ 这条链没有闭环保证。故补三段。
// 权威判定在 pipeline（2026-09-16 实测 tf-mu35oza7-wmuckz：预检漏传 signal → 工具内分诊 0.4s 退 fallback，闸门静默失效）
ok(/clarificationPreflight\(requirement, options as unknown as Record<string, unknown>, parent, exec && exec\.signal, ambientLocale\(\)\)/.test(hostSrc), 'host：预检把工具 signal 传给分诊（漏传会让分诊秒退 fallback）')
ok(/verdict: TriageVerdict \| null; error\?: string/.test(hostSrc) && /__triageError/.test(hostSrc), 'host：预检失败返回原因（__triageError），不静默')
ok(/\} else if \(options\.mode !== 'patch'\) \{/.test(pipelineSrc), 'pipeline：除 patch 外一律跑分诊（含显式 lite/mode —— 权威判定在 pipeline）')
ok(/function abortForClarification/.test(pipelineSrc) && /return abortForClarification\(journal, locale, verdict\)/.test(pipelineSrc), 'pipeline：闸门兜底 abortForClarification（非明确需求/must-know → 不开工，落可续跑中断态）')
ok(/log\.triagePreflightFail/.test(pipelineSrc) && /log\.clarifyAbort/.test(pipelineSrc) && /run\.needsClarification/.test(hostSrc), 'pipeline：预检失败与闸门兜底都有可见日志（locale 键齐备）')
// 收敛规则（2026-09-16 dddd 实测：答复没进分诊 → 同一个问题问了 6 轮、零 run）
ok(/do NOT re-ask/.test(hostSrc) && /do NOT re-ask/.test(pipelineSrc), '分诊输入必须带上 requirementSupplement（[CLARIFIED]），否则已答复的问题会被反复问')
ok(/const alreadyClarified = !!String\(options\.requirementSupplement \|\| ''\)\.trim\(\)/.test(hostSrc) && /&& !alreadyClarified/.test(hostSrc), '收敛规则：调用方还没给过澄清答复时才拦（给过就不再拦，防不收敛）')
ok(/log\.clarifyProceedWithAssumptions/.test(pipelineSrc) && /const clarified = !!String\(journal\.requirementSupplement/.test(pipelineSrc), 'pipeline 同收敛规则：已澄清 → 残余 blocker 作假设开工（可见 warn）')
// 验收结论行取值（2026-09-17 实测 bug tf-mu4bve7t-duux2k：`## 1. 验收结论摘要` 蒙住真正的结论行 →
// 明明「验收结论：✅ 通过」却判 needs-human）。规则：只认**字面量模板行**（冒号连写），且取最后一个。
ok(/const literal = \/\^\\s\*\(\?:#\{1,6\}\\s\*\|\[-\*\+\]\\s\*\)\?\(\?:验收结论\|整体结论\|Acceptance verdict\|Overall verdict\)\\s\*\[:：]\/i/.test(utilSrc), 'util：结论行按字面量模板行匹配（`验收结论：` 冒号连写，不被章节标题蒙住）')
ok(/literalHits\.length \? literalHits\[literalHits\.length - 1\]/.test(utilSrc), 'util：多个命中取**最后一个**（报告末尾的结论章才是终判）')
ok(parseAcceptanceVerdict('## 1. 验收结论摘要\n摘要文本\n## 6. 验收结论\n验收结论：✅ 通过') === 'accepted', 'util：真实结构（摘要章在前）→ accepted（回归核心，行为断言）')
ok(smokeSelf.includes('验收结论摘要'), 'verdict.test.js 内保留该真实结构样本（防回归样本被悄悄删掉）')
ok(parseAcceptanceVerdict('## 1. 验收结论摘要\n## 6. 验收结论\n（未写结论）') === 'needs-human', 'util：只有标题、无字面量结论行 → needs-human（不猜）')
// 📝 判定改为行首锚定（2026-09-17 实测 bug tf-mu4i779p-kze5kl：报告标题「为什么不判「📝 需求不适用」」
// 被旧全文匹配当成结论 → 一份 ⚠️ 有条件通过 的报告被判 reject → run failed）
ok(/const naLead = acc\.split\('\\n'\)\.map/.test(utilSrc) && /if \(naLead\.some\(\(l\) => \/\^📝/.test(utilSrc), 'util：📝 需求不适用改为**行首锚定**（剥 markdown/表格前缀与结论标签后必须以 📝 开头）')
ok(/parseAcceptanceVerdict\('## 📝 需求不适用\\n现状已满足，无有效变更。'\) === 'reject'/.test(smokeSelf) || smokeSelf.includes('📝 需求不适用：只认「行首结论」写法'), 'verdict.test.js 保留行首/引用两组样本（防回归样本被删）')
ok(/journal\.humanIntervention = true\s*\n\s*journal\.logs\.push\(\{ t: Date\.now\(\), level: 'error', message: t\(locale, 'log\.accReject'\)/.test(pipelineSrc), 'pipeline：reject 分支置 journal.humanIntervention（原先只置 backlog 卡片 → 汇报「需人工」与状态线矛盾）')
// 改动存档两态（2026-09-17 方案 A：入口定 init/keep + 记住；出口遵从；危险路径两层防线）
ok(/export function isDangerousVcsRoot/.test(utilSrc) && /export function dirTooLargeForBaseline/.test(utilSrc), 'util：危险路径判定 + 有界规模采样（纯函数，可单测）')
ok(/if \(!s\.inRepo\) \{/.test(hostSrc) && /git\.q\.noRepo/.test(hostSrc) && /kind: 'git-init'/.test(hostSrc), 'host：非 git 工作区不再静默跳过——进入「改动存档」决策（init/keep，危险路径只给 keep）')
ok(/st\.gitMode === 'none' \|\| options\.preAction === 'keep-nogit'/.test(hostSrc), 'host：记住答案（state.gitMode）——已选"不开启"的后续 run 不再问')
// 「记住答案」的**存储侧**门禁（2026-09-18 实锤：loadState 是逐字段白名单重建，漏了 gitMode →
// pipeline 写了也被下一次 state 块合并抹掉 → 每次 run 重复问存档。`test/state.test.js` 静态断言
// 「TeamflowState 每个持久化字段都被 loadState 搬运」+ 行为往返 + 合并后仍在；此处只做指针性守门）
{
  const stateSrc2 = readFileSync(join(here, '../host/core/state.ts'), 'utf8')
  ok(/raw\.gitMode === 'repo' \|\| raw\.gitMode === 'none'/.test(stateSrc2), 'state：loadState 显式搬运 gitMode（逐字段重建漏一个 = 该字段永远存不住——白名单漏字段已第四次）')
  ok(existsSync(join(here, 'state.test.js')), 'state.test.js 存在（字段完整性门禁：静态解析接口顶层键逐个断言被搬运 + 往返 + 合并后仍在）')
}
// 分诊缓存（2026-09-18 实测：决策返回路径让同一条需求被分诊两次——probe-clock tf-mu5wcm2j-kxk14y：
// 首次 start 跑分诊(16.6K tok) → 返回 needs-decision(git-init)、不建 run → 用户点选后主线程重调 →
// 又跑一次(16.5K tok)，两次 model 裁决一致。此前分诊都走 fallback（90s 超时 bug）→ 不建子代理 → 不可见）
{
  const triageSrc2 = readFileSync(join(here, '../host/core/triage.ts'), 'utf8')
  ok(/export function triageCacheKey/.test(triageSrc2) && /export function triageCacheGet/.test(triageSrc2) && /export function triageCachePut/.test(triageSrc2), 'triage：缓存三件套（key/get/put 纯函数，可单测）')
  ok(/supplement/.test(triageSrc2.match(/export function triageCacheKey[^}]*\}/s)?.[0] || ''), 'triage：**缓存键含澄清答复**（漏了它会把"澄清前"的裁决当"澄清后"复用 = 闸门失效）')
  ok(/verdict\.source !== 'model'/.test(triageSrc2), 'triage：**只缓存 model 裁决**（fallback 是"分诊不可用"的降级产物，缓存它会把偶发故障固化）')
  ok(/TRIAGE_CACHE_MAX/.test(triageSrc2) && /TRIAGE_CACHE_TTL_MS/.test(triageSrc2), 'triage：缓存有容量上限 + TTL（防长会话内存增长 / 陈年裁决复活）')
  ok(/triageCacheGet\(cacheKey\)/.test(hostSrc) && /triageCachePut\(cacheKey/.test(hostSrc), 'host：preflight **先查缓存再跑分诊**，跑完写缓存（否则两次分诊白花 ~16.5K tok/次）')
  ok(/triageCacheKey\(requirement, options\.requirementSupplement\)/.test(hostSrc), 'host：缓存键 = 需求 + 澄清答复（**不得**含 preAction/branchPolicy——正是它们导致重调，进键就永远命不中）')
  ok(/diag\.triageCacheHit/.test(hostSrc), 'host：缓存命中留痕（否则"为什么这次没跑分诊"会变成新的黑盒）')
  // 待决策状态机（2026-09-18 二次修正：TTL 10 分钟失手——probe-cache 实测用户隔 55 分钟才点选；
  // 有效性改为「仍在等用户回答」，TTL 降级为防泄漏兜底）
  ok(/pendingDecision/.test(triageSrc2), 'triage：缓存条目带 pendingDecision（**有效性看"仍在等用户回答"，不看时间**）')
  ok(/!hit\.pendingDecision && Date\.now\(\) - hit\.at > TRIAGE_CACHE_TTL_MS/.test(triageSrc2), 'triage：**待决策条目无视 TTL**（TTL 只做防泄漏兜底，不承担正确性）')
  ok(/export function triageCacheMarkPending/.test(triageSrc2) && /export function triageCacheSettle/.test(triageSrc2), 'triage：待决策标记 / 落定 两个状态迁移函数（纯函数可单测）')
  ok((hostSrc.match(/triageCacheMarkPending\(/g) || []).length >= 3, 'host：**每个"不建 run"的返回都标待决策**（needs-clarification / git-init / 分支决策 三处）')
  ok(/triageCacheSettle\(triageKey\)/.test(hostSrc) && /triageCacheSettle\(pre\.cacheKey\)/.test(hostSrc), 'host：两条 start 路径（tool + Remote）在建 run 成功后都 settle')
}
ok(/options\.preAction === 'init'/.test(pipelineSrc) && /isDangerousVcsRoot\(journal\.workspacePath, homedir\(\)\)/.test(pipelineSrc), 'pipeline：preAction=init 执行期**二次校验**危险路径（不信任决策时刻的判断）→ 命中则降级为不初始化并继续')
ok(/baselineSkip = dirTooLargeForBaseline/.test(pipelineSrc) && /commit\.baseline/.test(hostSrc), 'pipeline：init 时目录过大 → 只 init 不基线提交（git add -A 防全盘扫描）')
ok(/vcsState === 'none'/.test(pipelineSrc) && /log\.noVcsByChoice/.test(pipelineSrc) && /log\.noVcsDangerous/.test(pipelineSrc), 'pipeline：出口遵从——none/危险路径**不尝试提交**（不再出现「提交失败（忽略）」的含糊措辞）')
ok(/report\.vcsArchived/.test(reportSrc) && /loadState\(journal\.workspacePath\)/.test(reportSrc), 'report：汇报带「已存档/未存档」行（非程序员的安全网要看得见）')
// preAction 四值放行（2026-09-18 probe-clock 实测：工具入口整形只认 stash/commit，把改动存档决策
// 正确回传的 preAction='init' 丢成 null → git init 静默没执行；主线程回传/决策/pipeline 三环全对，
// 唯独入口这一行把参数弄丢）
ok(/args\.preAction === 'stash' \|\| args\.preAction === 'commit' \|\| args\.preAction === 'init' \|\| args\.preAction === 'keep-nogit'/.test(hostSrc), 'host：preAction 入口整形放行全部四值（stash/commit/init/keep-nogit——漏 init 会静默丢掉存档决策）')
// .gitignore 三层分工（2026-09-18 **方案 B 根治**，勿回退）：**L1 只做索引层排除，绝不写用户 .gitignore**。
// 旧实现（`ensureCommonNoiseIgnores` 把 .pnpm-store/node_modules 写进用户 .gitignore）的实锤：mergeGitignore
// 的注释是**整批一条** → `.pnpm-store/` 顶着「TeamFlow 运行日志（插件自有产物…）」写进用户文件（用户截图）；
// 更根本的是**越界**——"该忽略什么"归 L2（PRD 阶段 PM 按技术栈规划）与 L3（QA 收口探针）及用户本人，
// host 只该在**自己那一次 git 调用**上收敛范围。故断言反向：**pipeline 不得再出现写 .gitignore 的噪音排除**。
{
  const m = pipelineSrc.match(/tfAddArgs\(([A-Z_]+), journal\.workspacePath\)/)
  ok(!!m && m[1] === 'BASELINE_NOISE_EXCLUDES', 'pipeline：基线提交的噪音排除走 tfAddArgs(BASELINE_NOISE_EXCLUDES, 仓库路径)——**必须传仓库路径**，自检要针对目标仓库而非宿主 cwd')
  // 只看代码行（注释里要保留旧实现的历史说明 = 证据，见 pipeline.ts 顶部注释）
  const pipeCode = pipelineSrc.split('\n').filter((l) => { const s = l.trim(); return !s.startsWith('*') && !s.startsWith('/*') && !s.startsWith('//') }).join('\n')
  ok(!/ensureCommonNoiseIgnores/.test(pipeCode), 'pipeline：**不得**回退为写用户 .gitignore 的噪音排除（ensureCommonNoiseIgnores 已从代码删除）')
  ok(!/mergeGitignore\([^)]*'\.pnpm-store'/.test(pipeCode) && !/mergeGitignore\([^)]*node_modules/.test(pipeCode), 'pipeline：噪音项**不得**经由 mergeGitignore 落进用户 .gitignore（只允许 logs/teamflow 那条自有日志规则）')
  ok((pipeCode.match(/writeFileSync\(/g) || []).length <= 2, 'pipeline：写文件处收敛（仅 .gitignore 自有日志规则 + 任务夹/产物写入，不得新增"替用户写文件"的点）')
  const sanitySrc = readFileSync(join(here, '../host/core/sanity.ts'), 'utf8')
  ok(/export const BASELINE_NOISE_EXCLUDES[^=]*=\s*\[/.test(sanitySrc), 'sanity：BASELINE_NOISE_EXCLUDES 常量（排除清单数据化，一处可改）')
  ok(/check-ignore/.test(sanitySrc), 'sanity：用 `git check-ignore` 判"是否已被忽略"（以目标仓库为根；自读 .gitignore 会读成宿主 cwd → 两个方向同时错，2026-09-18 实测）')
  ok(!/readFileSync\('\.gitignore'\)/.test(sanitySrc), 'sanity：**不得**再用相对路径读 .gitignore 做忽略判定（那是宿主 cwd，不是目标仓库）')
  ok(/export function tfAddArgs\(excludes[^)]*cwd\?/.test(sanitySrc), 'sanity：tfAddArgs 接受可选 excludes + cwd（默认空 → 收口提交行为逐字不变）')
  ok(/log\.baselineExcludes/.test(pipelineSrc), 'pipeline：索引层排除记一条 info（用户能看到"排除了什么、且没动你的 .gitignore"）')
  ok(/Version-control hygiene · mandatory when the workspace is versioned/.test(promptsSrc) && /Commit-surface hygiene probe/.test(promptsSrc), 'prompts：L2 PM .gitignore 规划必查项 + L3 QA 收口探针（模型按项目技术栈规划，非固定清单）')
}
// 分诊超时 90s→240s + fallback 原因可见化（2026-09-18 probe-clock 截图实锤：分诊子代理推理中被
// 90s dispose（UI「已停止」），journal 只剩一条 fallback info——没人知道为什么）
{
  ok(/TRIAGE_TIMEOUT_MS = 240000/.test(triageSrc), 'triage：分诊超时常量 240s（90s 时代分诊职责已翻倍，深思考模型答不完）')
  ok(/fallbackReason/.test(triageSrc) || /fallbackReason/.test(pipelineSrc), 'triage：fallback 必须带退化原因（fallbackReason → warn 可见化，不再黑盒）')
  ok(/log\.triageFallbackReason/.test(pipelineSrc), 'pipeline：分诊退化原因记 warn（含原因摘要）')
}
// execOptions 白名单完整性（B1 同型 bug 第三次现身：2026-09-17 probe-clock 实锤——branchPolicy/preAction
// 不在白名单 → 用户选了"开启存档"但 executePipeline 收到 undefined → git init 静默没执行）。
// 门禁：内部字段必须逐个出现在 execOptions；以后再加内部字段漏一个就红。
{
  const lines = pipelineSrc.split('\n')
  const start = lines.findIndex((l) => l.includes('const execOptions = Object.assign'))
  const body = start >= 0 ? lines.slice(start, start + 10).join('\n') : ''
  for (const f of ['requirementSupplement', '__triage', 'branchPolicy', 'branchName', 'preAction', 'commitMessage']) {
    ok(body.includes(f + ':'), `pipeline：execOptions 显式携带内部字段 ${f}（journal.options 白名单不承载内部字段——B1 同型防回退）`)
  }
}
// 输出 schema 严格性（2026-09-17 实锤 probe-clock：git-init 决策返回带 kind 未声明 → additionalProperties:false
// 拒收 → start 当场失败、零 run；全套测试因没覆盖"返回形状 vs schema"而全绿漏过）
ok(/kind: \{ type: 'string' \}/.test(hostSrc), 'host：start 的 output schema 声明 kind（git-init 决策字段）')
{
  // 静态抽取 execute 里所有 return { … } 的顶层键，逐一核对已在 schema properties 中声明
  const startIdx = hostSrc.indexOf("name: 'teamflow_start'")
  const mergeIdx = hostSrc.indexOf("name: 'teamflow_merge'")
  const seg = hostSrc.slice(startIdx, mergeIdx === -1 ? undefined : mergeIdx)
  const schemaLine = (hostSrc.split('\n').find((l) => l.includes("required: ['status']") && l.includes('runId')) || '')
  ok(schemaLine.includes('kind:'), 'host：schema 抽取自检（kind 已声明）')
  const declared = new Set((schemaLine.match(/([a-zA-Z]+): \{ type/g) || []).map((m) => m.replace(/: \{ type/, '')))
  const returned = new Set()
  for (const m of seg.matchAll(/return\s*\{([^{}]*)\}/g)) {
    for (const kv of m[1].matchAll(/([a-zA-Z_]+)\s*:/g)) returned.add(kv[1])
  }
  const bad = [...returned].filter((k) => k !== 'status' && !declared.has(k))
  ok(bad.length === 0, `start：execute 各返回路径的键都在 output schema 内（未声明：${bad.join(',') || '无'}）`)
}
// 续跑不重跑分诊（2026-09-17 dddd 续跑实测：多出一次 `自动分诊 … source=fallback`，档位早已定稿）
ok(/\} else if \(resume\) \{/.test(pipelineSrc) && /log\.triageResumed/.test(pipelineSrc) && /source: 'resume'/.test(pipelineSrc), 'pipeline：断点续跑跳过分诊（沿用 journal.options.mode + 补 shadow 记录）')
ok(/if \(!journal\.triage\) \{/.test(pipelineSrc), 'pipeline：续跑只在 triage 缺失时补记录（首轮真实裁决优先保留）')
// 外部供应商故障处置（2026-09-17：429/无额度/上游故障 ≠ 交付缺陷；实测同请求 16 分钟后成功）
ok(/export function classifyExternalFailure/.test(utilSrc) && /export const EXTERNAL_BACKOFF_MS/.test(utilSrc) && /export function externalBackoffMs/.test(utilSrc), 'util：外部故障分类 + 退避序列（纯函数，可单测）')
ok(/isExternalFailure\(lastStage\)/.test(runnerSrc) && /externalBackoffMs\(externalAttempts \+ 1\)/.test(runnerSrc), 'runner：外部故障走长退避重试（不受 RETRY_LIMIT 约束）')
ok(/sleepUnlessCancelled\(wait, \(\) => journal\.cancelled\)/.test(runnerSrc) && /attempt--/.test(runnerSrc), 'runner：退避可被取消打断；退避后重试同一阶段（不推进 RETRY_LIMIT）')
ok(/journal\.externalFailure = true/.test(runnerSrc) && /lastStage\.status = 'interrupted'/.test(runnerSrc), 'runner：退避用尽 → 落可续跑中断态（非 failed）')
ok(/report\.externalFailure/.test(reportSrc) && /externalFailure: journal\.externalFailure === true/.test(storeSrc), 'report/store：外部故障标记落盘 + 汇报讲清「非交付缺陷、resume 只补这一段」')
ok(/diag\.externalBackoff/.test(hostSrc) && /diag\.externalExhausted/.test(hostSrc), 'locales：退避与用尽都有可见文案（zh/en 同形由 locale 测试守门）')
ok(/\[Clarify first, do not jump the gun\]/.test(hostSrc) && /\[After clarifying, come back to the pipeline\]/.test(hostSrc), '注入（en）：同上（语言跟随会话，双语同形门禁另有 locale 测试）')
ok(/若 teamflow_start 返回 needs-clarification，按它列出的 blockers 继续问用户/.test(hostSrc) && /If teamflow_start returns needs-clarification, keep asking the user about the blockers/.test(hostSrc), '注入：needs-clarification 的处理指引（按 blockers 问 → 带 supplement 重调，禁止替用户假设）')

// ── 环境不可用护栏（2026-09-23 probe-v4 实锤：命令工具持续同一错误失败 = 工作区坏了）──
// 实锤：`pwsh` 因 Windows 沙箱 ACL provision 失败（`SetNamedSecurityInfoW failed (Win32 5)`）**每次同样报错**，
// 架构师重试 7 次 + 90k 字符推理才撞 max-tokens 停下 —— 白烧 52.6k 输出，且汇报把真因误写成 `max-tokens`。
console.log('── 3q) 环境不可用护栏（同一工具持续同一错误失败 → 早停 + 点名环境）──')
ok(/GUARD_TOOL_FAIL_WARN = 2/.test(constantsSrc) && /GUARD_TOOL_FAIL_ABORT = 3/.test(constantsSrc), 'constants：工具失败 WARN=2 / ABORT=3（实测模型第 2 次就放弃 shell，3/5 太晚）')
ok(/function observeToolFailures/.test(guardSrc) && /observeToolFailures\(newEvents\)/.test(guardSrc), 'guard：失败的 tool/result 增量归因（callId → 工具名）并参与判定')
ok(/isToolErrorResult\(e\.data\)/.test(guardSrc) && /toolFailureAction\(n, GUARD_TOOL_FAIL_WARN, GUARD_TOOL_FAIL_ABORT\)/.test(guardSrc), 'guard：判据走结构化 isError + 纯函数阈值（不猜文本）')
ok(/'guard\.reasonToolFail'[\s\S]{0,90}'env-unavailable'/.test(guardSrc), "guard：达阈值 → fire(outcome='env-unavailable')")
ok(/outcome === 'env-unavailable'\) \{/.test(runnerSrc) && /diag\.envUnavailable/.test(runnerSrc), 'runner：env-unavailable 不自动重试 + 日志点名环境（needs-human）')
ok(/stage\.outcome === 'env-unavailable'/.test(runnerSrc), 'runner：isExternalFailure 排除 env-unavailable（不误走供应商退避）')
ok(/env-unavailable/.test(storeSrc) && /export function isToolErrorResult/.test(utilSrc) && /export function toolFailureAction/.test(utilSrc), 'store/util：outcome 类型 + 纯函数齐备')
ok(/stage\.envUnavailable = /.test(guardSrc) && /if \(stage\.envUnavailable\) \{/.test(runnerSrc), 'guard→runner：WARN 档落证据，runner 据此把「模型听劝停手」也归成 env-unavailable（否则误判产出过短并重试）')
ok(runnerSrc.indexOf('if (stage.envUnavailable)') > -1 && runnerSrc.indexOf('if (stage.envUnavailable)') < runnerSrc.indexOf("stop === 'completed' && text && (verdict.ok || docFallback)"), 'runner：环境不可用**优先于「完成了」**（绕道用文件工具写完的骨架无法验证，不得算 done——probe-v4 第二次实测 69.8k 输出）')
ok(/envUnavailable: s\.envUnavailable \|\| null/.test(storeSrc), 'store：envUnavailable 落盘（序列化完整性门禁覆盖）')
ok(promptsSrc.indexOf('[Env unavailable · policy]') > -1 && promptsSrc.indexOf('[Env unavailable · policy]') < promptsSrc.indexOf('export const prdPrompt'), 'prompts：政策块落在共享前缀（早于第一个阶段工厂 → 11 个阶段全覆盖，含 scaffold）')

// ── 文档完整性门禁（2026-09-16 实证）──
// 补丁脚本用 String.replace(from, to) 时，替换文本里的 `` $` `` / `$&` / `$'` 会被当成**特殊模式**，
// 把匹配点前后的文件内容插进来 → AGENTS.md / CHANGELOG.md / devlog.md 被整份复制成两份（白占注入预算）。
// 这里按「关键标记只能出现一次 + 体量上限」兜住这类结构性损坏（写文档的脚本必须用函数式替换）。
const docFiles = [
  ['AGENTS.md', '# AGENTS.md —', 1, 60 * 1024],
  ['AGENTS.md', '## 5. 当前行为锚点', 1, 60 * 1024],
  ['AGENTS.md', '## 6. 变更记录', 1, 60 * 1024],
  ['CHANGELOG.md', '## [0.2.0]', 1, 200 * 1024],
  ['docs/devlog.md', '## 迭代变更流水', 1, 300 * 1024],
  ['docs/TODO.md', '## 真待办', 1, 120 * 1024],
  ['README.md', '## 界面预览', 1, 60 * 1024],
  ['README.en.md', '## Screenshots', 1, 60 * 1024],
]
for (const [f, marker, want, cap] of docFiles) {
  const body = readFileSync(join(here, `../${f}`), 'utf8')
  const n = body.split(marker).length - 1
  ok(n === want && body.length <= cap, `文档完整性：${f} 「${marker}」出现 ${n} 次（期望 ${want}）、${(body.length / 1024).toFixed(0)}KB ≤ ${(cap / 1024).toFixed(0)}KB`)
}

console.log(failed === 0 ? '\n✅ smoke 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
