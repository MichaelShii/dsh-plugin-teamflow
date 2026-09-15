/**
 * dsh-plugin-teamflow — 一次性 codemod：把 client/index.tsx 与 client/panel.tsx 的
 * 中文字面量替换为 locales.ts 的 `t('key')` 调用（v0.1.9 客户端双语 P1）。
 *
 * 用法：node scripts/i18n-client-codemod.mjs
 * 特性：
 * - 按 old 串长度降序替换，避免长串被短串先切断；
 * - 每条映射报告命中次数，**命中 0 次即报错退出**（防静默漏改）；
 * - 结束后扫描文件里残留的中文字面量（注释外），列出待人工判断项（console.* 诊断保留中文）。
 *
 * 已执行完毕，保留作为「中文原文 → key」的映射留痕（与 client/locales.ts 的 key 对照）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/** [old, new] 映射（old 为源码里的精确串，含引号/反引号）。 */
const MAP = {
  'client/index.tsx': [
    // import 列表
    ["import {\n  T, STATUS_TEXT, STATUS_COLOR, PHASE_ICON, PHASE_NAME, phaseNameOf, phaseIconOf, phaseKeyOf,\n  RUN_STATUS_TEXT, COLUMNS, KIND_TITLE, h, MONO, SANS, flexRow, chip, FoldableText,\n  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, usageDetail, stageUsageLine,\n  ROLE_NAME, roleUsage, byRoleLine, totalUsage, stText, stColor,\n} from './shared.js'",
      "import {\n  T, STATUS_COLOR, PHASE_ICON, phaseNameOf, phaseIconOf, phaseKeyOf,\n  COLUMNS, h, MONO, SANS, flexRow, chip, FoldableText,\n  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, usageDetail, stageUsageLine,\n  roleUsage, byRoleLine, totalUsage, stText, stColor, runStatusText, kindTitle, roleChip,\n  t, setTranslator, localeTag,\n} from './shared.js'\nimport { NS, zh, en } from './locales.js'"],
    // 阶段卡 / 详情
    ["title: `${s.label} —— 点击查看阶段详情`,", "title: t('stage.cardTip', { label: s.label }),"],
    ["title: `重试 ${s.attempts.length - 1} 次（共 ${s.attempts.length} 次尝试）`,", "title: t('stage.retryTip', { n: s.attempts.length - 1, m: s.attempts.length }),"],
    [": cur && cur.summary ? `（该 run 未保存完整正文，展示摘要）\\n\\n${cur.summary}`", ": cur && cur.summary ? t('stage.summaryFallback', { summary: cur.summary })"],
    [": det.err ? `⚠ 加载失败：${det.err}`", ": det.err ? t('stage.loadFailed', { err: det.err })"],
    [": det.loading ? '加载中…'", ": det.loading ? t('common.loading')"],
    [": '（无产物正文）'", ": t('stage.noOutput')"],
    ["title: '关闭' }, '✕')", "title: t('common.close') }, '✕')"],
    ["'TOKEN · 官方口径'", "t('token.officialTitle')"],
    ["`↻ 尝试历史（${attempts.length} 次 · 点击查看该次详情）`", "t('stage.attemptHistory', { n: attempts.length })"],
    ["a.status === 'done' ? '✅ 成功' : a.status === 'failed' ? `❌ ${a.outcome || '失败'}` : '⏳ 进行中'",
      "a.status === 'done' ? t('stage.attemptDone') : a.status === 'failed' ? t('stage.attemptFailed', { outcome: a.outcome || t('common.failed') }) : t('stage.attemptRunning')"],
    ["(a.summary || a.outcome || '（无摘要）')", "(a.summary || a.outcome || t('common.noSummary'))"],
    ["st ? st.label : '阶段详情'", "st ? st.label : t('stage.detailTitle')"],
    ["`该子代理由会话 ${ownerSession.slice(-6)} 发起，跨会话跳转暂不支持——请打开其发起会话的团队工作台查看`", "t('stage.childCrossSessionTip', { sid: ownerSession.slice(-6) })"],
    ["'跳转到该阶段子代理会话（完整推理与工具调用轨迹）；跳转后请切换「对话」tab 查看'", "t('stage.childJumpTip')"],
    ["'该阶段无可用子代理会话'", "t('stage.childNoneTip')"],
    ["}, '🎬 跳转子代理会话'),", "}, t('stage.childJumpBtn')),"],
    ["`跨会话暂不支持：该子代理由会话 ${ownerSession ? ownerSession.slice(-6) : ''} 发起。如需查看轨迹，请打开其发起会话的团队工作台。`",
      "t('stage.childCrossSessionNote', { sid: ownerSession ? ownerSession.slice(-6) : '' })"],
    ["'跳转成功后，请切「对话」tab 查看该子代理的完整会话轨迹')", "t('stage.childJumpNote'))"],
    ["'🔬 验证证据'", "t('stage.evidenceTitle')"],
    ["}, '（缺失——契约未兑现，host 已记警告；可与 logs/teamflow/<runId>/ 命令输出日志对照）'),", "}, t('stage.evidenceMissing')),"],
    ["}, '📄 阶段性产物'),", "}, t('stage.artifactsTitle')),"],
    // 流水线画布
    ["'暂无运行中的流水线——让模型调用 teamflow_start，或在上方输入需求')", "t('pipeline.empty'))"],
    ["}, '流水线还没有开始执行节点') : null,", "}, t('pipeline.noNodes')) : null,"],
    ["title: '缩小'", "title: t('pipeline.zoomOut')"],
    ["title: '放大'", "title: t('pipeline.zoomIn')"],
    ["title: '适应画布'", "title: t('pipeline.fitCanvas')"],
    ["}, '✥ 拖动画布 · 滚轮缩放'),", "}, t('pipeline.canvasHint')),"],
    // 看板
    ["'backlog 为空（还没有流水线运行过）')", "t('board.empty'))"],
    ["sessionId, '看板拖拽流转')", "sessionId, t('board.dragReason'))"],
    ["title: `${item.id} · ${item.status}${item.summary ? '\\n' + item.summary : ''}（点击查看详情）`,",
      "title: t('board.cardTip', { id: item.id, status: item.status, summary: item.summary ? '\\n' + item.summary : '' }),"],
    ["title: `dev 分配\\n${item.devAssign}`", "title: t('board.assignDevTip', { who: item.devAssign })"],
    ["title: `qa 分配\\n${item.qaAssign}`", "title: t('board.assignQaTip', { who: item.qaAssign })"],
    ["title: `验收/汇报人\\n${item.acceptBy}`", "title: t('board.acceptTip', { who: item.acceptBy })"],
    ["`📦 ${subs.length} 子卡`", "t('board.subtaskCount', { n: subs.length })"],
    ["title: `dev 分配\\n${sub.devAssign}`", "title: t('board.assignDevTip', { who: sub.devAssign })"],
    ["title: `dev 分配\\n${extra.assignee}`", "title: t('board.assignDevTip', { who: extra.assignee })"],
    ["toLocaleTimeString('zh-CN', ", "toLocaleTimeString(localeTag(), "],
    // 条目详情
    ["secTitle('概览'),", "secTitle(t('item.overview')),"],
    ["}, '加载中…') :", "}, t('common.loading')) :"],
    ["kv('✅ 验收'", "kv(t('item.acceptRow')"],
    ["kv('↻ 重试', String(d.retries))", "kv(t('item.retryRow'), String(d.retries))"],
    ["kv('⚠ 人工介入', '需人工介入')", "kv(t('item.humanRow'), t('common.needsHuman'))"],
    ["kv('更新于', fmtAt(d.updatedAt) || '—')", "kv(t('item.updatedAt'), fmtAt(d.updatedAt) || '—')"],
    ["secTitle('运行'),", "secTitle(t('item.runSection')),"],
    ["title: `跳转到该需求的流水线视图 #${String(ri.runId).slice(-6)}`,", "title: t('item.jumpRunTip', { id: String(ri.runId).slice(-6) }),"],
    ["}, '▶ 流水线') : null,", "}, t('item.runBtn')) : null,"],
    ["secTitle('需求原文'),", "secTitle(t('item.requirement')),"],
    ["text: ri.requirement || '（无原文）'", "text: ri.requirement || t('item.noRequirement')"],
    ["secTitle('任务夹'),", "secTitle(t('item.runDocs')),"],
    ["title: `在右侧栏预览 ${d.runDocs}/${a.name}`,", "title: t('item.previewTip', { path: `${d.runDocs}/${a.name}` }),"],
    ["const label = role === 'dev' ? '👨‍💻 开发' : role === 'qa' ? '🧪 QA' : role === 'acceptance' ? '✅ 验收' : role === 'pm' ? '📌 产品' : role === 'design' ? '🎨 设计' : role === 'arch' ? '🏗 架构' : '⚙️ ' + role",
      "const label = roleChip(role)"],
    [" · ${u.calls || 0} 次`", " · ${t('common.calls', { n: u.calls || 0 })}`"],
    ["secTitle(`关联子卡（${d.subtasks.length}）`),", "secTitle(t('item.subtasks', { n: d.subtasks.length })),"],
    ["secTitle(`关联缺陷（${d.bugs.length}）`),", "secTitle(t('item.bugs', { n: d.bugs.length })),"],
    ["secTitle(`流转时间线（${d.events.length}）`),", "secTitle(t('item.timeline', { n: d.events.length })),"],
    // 团队选择器
    ["title: active ? `当前团队：${active.name}（点击切换）` : '选择团队',", "title: active ? t('team.currentTip', { name: active.name }) : t('team.pick'),"],
    ["title: active && active.name ? String(active.name) : '团队'", "title: active && active.name ? String(active.name) : t('team.label')"],
    ["}, active ? active.name : '团队'),", "}, active ? active.name : t('team.label')),"],
    ["}, '选择团队'),", "}, t('team.pick')),"],
    ["}, '无团队（直接对话）'),", "}, t('team.none')),"],
    ["}, '不走 teamflow，模型直接工作'),", "}, t('team.noneNote')),"],
    // 主视图
    ["throw new Error(`${what || 'remote'} 调用失败：${(res && res.error && (res.error.message || res.error.code)) || '未知错误'}`)",
      "throw new Error(t('common.remoteCallFailed', { what: what || 'remote', detail: (res && res.error && (res.error.message || res.error.code)) || t('common.unknownError') }))"],
    ["{ ...s, err: 'remote 未就绪' }", "{ ...s, err: t('common.remoteNotReady') }"],
    ["}, '团队工作台'),", "}, t('workbench.title')),"],
    ["anyRunning ? '流水线运行中' : '空闲',", "anyRunning ? t('workbench.running') : t('workbench.idle'),"],
    ["}, '🔄 刷新'),", "}, t('workbench.refresh')),"],
    ["title: `断点续跑 ${activeRun.id}\\n当前状态：${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}；跳过已完成阶段，从第一个未完成阶段重跑`,",
      "title: t('workbench.resumeTip', { id: activeRun.id, status: runStatusText(activeRun.status) }),"],
    ["}, busy ? '续跑中…' : `↻ 从断点重跑 #${String(activeRun.id).slice(-6)}`) : null,",
      "}, busy ? t('workbench.resuming') : t('workbench.resumeBtn', { id: String(activeRun.id).slice(-6) })) : null,"],
    ["}, `⚠ ${err}（确认已安装 dsh-plugin-teamflow 且 web 已重启）`) : null,", "}, t('workbench.loadFailed', { err })) : null,"],
    ["}, `⚠ ${needHuman.length} 项需人工介入`),", "}, t('workbench.needsHumanBanner', { n: needHuman.length })),"],
    ["props.sessionId, '人工处理'); refresh() },", "props.sessionId, t('workbench.manualReason')); refresh() },"],
    ["}, `处理 ${item.id}`)", "}, t('workbench.handle', { id: item.id }))"],
    ["}, '🔄 流水线'),", "}, t('workbench.tabPipeline')),"],
    ["}, '📋 Backlog 看板'),", "}, t('workbench.tabBoard')),"],
    ["title: '输入(未命中)/输入(命中)/输出 全部阶段合计'", "title: t('token.allStagesTip')"],
    ["`#${String(activeRun.id).slice(-8)} · ${RUN_STATUS_TEXT[activeRun.status] || activeRun.status}`",
      "`#${String(activeRun.id).slice(-8)} · ${runStatusText(activeRun.status)}`"],
    ["title: `当前工作区（workspace 级隔离）：${(workspace && workspace.path) || '未连接工作区'}`,",
      "title: t('workbench.workspaceTip', { path: (workspace && workspace.path) || t('workbench.noWorkspace') }),"],
    ["}, '历史'),", "}, t('workbench.history')),"],
    ["}, '（暂无）'),", "}, t('common.noneDash')),"],
    ["title: '在右侧栏打开该 run 详情（与任务夹产物并排看）',", "title: t('workbench.openRightBarTip'),"],
    ["}, '⇥ 右栏打开')", "}, t('workbench.openRightBarBtn'))"],
  ],
  'client/panel.tsx': [
    ["import {\n  T, h, MONO, SANS, flexRow, chip, FoldableText, stColor, stText,\n  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, phaseNameOf, phaseIconOf,\n  RUN_STATUS_TEXT, COLUMNS, KIND_TITLE, byRoleLine, stageUsageLine,\n} from './shared.js'",
      "import {\n  T, h, MONO, SANS, flexRow, chip, FoldableText, stColor, stText,\n  fmtTime, fmtDur, fmtTokens, totalTokens, hitRate, phaseNameOf, phaseIconOf,\n  COLUMNS, byRoleLine, stageUsageLine, runStatusText, kindTitle, t,\n} from './shared.js'"],
    ["let detail = '未知错误'", "let detail = t('common.unknownError')"],
    ["throw new Error(`${what || 'remote'} 调用失败：${detail}`)", "throw new Error(t('common.remoteCallFailed', { what: what || 'remote', detail }))"],
    ["throw new Error(`${what || 'remote'} 返回空结果（ok=true 但无 value；原始信封=${raw}）`)", "throw new Error(t('common.remoteEmptyResult', { what: what || 'remote', raw }))"],
    ["return '无 token 数据'", "return t('common.noUsage')"],
    ["} · ${u.calls} 次`", "} · ${t('common.calls', { n: u.calls })}`"],
    // 产品线栏
    ["`产品线 · ${products.length}`", "t('panel.railTitle', { n: products.length })"],
    ["title: '重新扫描 $DSH_HOME/teamflow' }, busy ? '刷新中' : '刷新')", "title: t('panel.rescanTip') }, busy ? t('panel.refreshing') : t('panel.refresh'))"],
    ["muted('还没有产品线。在某个工作区跑过一次流水线后，这里会出现对应产品线（$DSH_HOME/teamflow/<key>）。', { padding: '10px 4px' })",
      "muted(t('panel.noProducts'), { padding: '10px 4px' })"],
    ["chip(`运行 ${p.activeRuns}`, T.brand, { dot: true })", "chip(t('panel.activeRuns', { n: p.activeRuns }), T.brand, { dot: true })"],
    ["h('span', null, `更新 ${fmtTime(p.updatedAt)}`)", "h('span', null, t('panel.updated', { time: fmtTime(p.updatedAt) }))"],
    ["}, '读取中…') : null),", "}, t('panel.reading')) : null),"],
    ["chip(`验收 ${p.lastVerdict}`, stColor(p.lastVerdict === 'accepted' ? 'accepted' : p.lastVerdict))",
      "chip(t('panel.verdict', { v: p.lastVerdict }), stColor(p.lastVerdict === 'accepted' ? 'accepted' : p.lastVerdict))"],
    // run 列表
    ["muted('该产品线还没有 run 记录。', { padding: '2px 2px 8px' })", "muted(t('runList.empty'), { padding: '2px 2px 8px' })"],
    ["chip(RUN_STATUS_TEXT[r.status] || r.status, stColor(r.status), { dot: true }),", "chip(runStatusText(r.status), stColor(r.status), { dot: true }),"],
    ["}, '进行中') : null),", "}, t('runList.running')) : null),"],
    ["|| '(无需求描述)'", "|| t('runList.noRequirement')"],
    ["h('span', null, `阶段 ${r.doneStages}/${r.stageCount}`),", "h('span', null, t('runList.stageProgress', { done: r.doneStages, total: r.stageCount })),"],
    ["title: '跳到该 run 的发起会话，并在那个会话的右侧栏打开详情（右侧栏是会话级的：挂到无关会话上没有意义）',",
      "title: t('runList.openRightBarTip'),"],
    ["}, '去会话右栏'),", "}, t('runList.openRightBar')),"],
    // backlog 卡
    ["`验收 ${item.acceptBy}`", "t('panel.verdict', { v: item.acceptBy })"],
    ["`重试 ${item.retries}`", "t('board.retries', { n: item.retries })"],
    ["}, '需人工') : null),", "}, t('status.needs-human')) : null),"],
    ["title: on ? '点击取消该状态筛选' : '点击只看该状态（可多选）',", "title: on ? t('panelBoard.filterChipOn') : t('panelBoard.filterChipOff'),"],
    ["muted('backlog 为空（该产品线还没有立项卡片）。', { padding: '2px 2px 8px' })", "muted(t('panelBoard.empty'), { padding: '2px 2px 8px' })"],
    ["`${KIND_TITLE[kind]} · ${list.length}`", "t('panelBoard.groupCount', { kind: kindTitle(kind), n: list.length })"],
    ["`活动 ${active.length}`", "t('panelBoard.activeCount', { n: active.length })"],
    ["title: '清除本组筛选',", "title: t('panelBoard.clearFilterTip'),"],
    ["}, `筛选中 ${sel.length} 项 · 显示 ${matched.length}/${list.length} × 清除`)",
      "}, t('panel.filtered', { sel: sel.length, shown: matched.length, total: list.length }))"],
    ["title: open ? '收起已完成/已关闭卡片' : '展开已完成/已关闭卡片',", "title: open ? t('panelBoard.collapseDoneTip') : t('panelBoard.expandDoneTip'),"],
    ["}, open ? `收起已完成 ${done.length}` : `已完成 ${done.length} ▸`)",
      "}, open ? t('panelBoard.collapseDone', { n: done.length }) : t('panelBoard.expandDone', { n: done.length }))"],
    ["muted('该筛选下没有卡片。', { fontSize: 10.5 })", "muted(t('panelBoard.emptyFiltered'), { fontSize: 10.5 })"],
    // 条目详情
    ["row('需求', det.reqId), row('负责人', det.owner), row('开发', det.devAssign), row('测试', det.qaAssign),\n      row('验收', det.assignBy), row('重试', det.retries), row('任务夹', det.runDocs)),",
      "row(t('panelItem.row.req'), det.reqId), row(t('panelItem.row.owner'), det.owner), row(t('panelItem.row.dev'), det.devAssign), row(t('panelItem.row.qa'), det.qaAssign),\n      row(t('panelItem.row.accept'), det.assignBy), row(t('panelItem.row.retries'), det.retries), row(t('panelItem.row.runDocs'), det.runDocs)),"],
    ["}, '关闭')),", "}, t('common.close'))),"],
    ["}, '规格'), h(FoldableText", "}, t('panelItem.spec')), h(FoldableText"],
    ["}, '结论摘要'), h(FoldableText", "}, t('panelItem.summary')), h(FoldableText"],
    ["`任务夹产物 · ${det.artifacts.length}`", "t('panelItem.artifacts', { n: det.artifacts.length })"],
    ["title: `${a.address}\\n（跳到产物所属会话后在该会话右侧栏打开）`,", "title: t('panelItem.artifactTip', { address: a.address }),"],
    ["muted('该条目没有可预览的任务夹产物（或缺少会话上下文，无法生成文件地址）。')", "muted(t('panelItem.noArtifacts'))"],
    ["`子卡 · ${det.subtasks.length}`", "t('panelItem.subtasks', { n: det.subtasks.length })"],
    ["chip('失败', T.error)", "chip(t('common.failed'), T.error)"],
    ["`关联缺陷 · ${det.bugs.length}`", "t('panelItem.bugs', { n: det.bugs.length })"],
    ["`流转时间线 · 最近 ${Math.min(det.events.length, 30)} 条`", "t('panelItem.events', { n: Math.min(det.events.length, 30) })"],
    // run 详情
    ["muted('未找到该 run（可能已被清理，或地址已过期）。', { padding: 12 })", "muted(t('detail.runMissing'), { padding: 12 })"],
    ["chip(RUN_STATUS_TEXT[snap.status] || snap.status, stColor(snap.status), { dot: true }),", "chip(runStatusText(snap.status), stColor(snap.status), { dot: true }),"],
    ["h('span', null, `阶段 ${stages.filter((s) => s.status === 'done').length}/${stages.length}`),",
      "h('span', null, t('runList.stageProgress', { done: stages.filter((s) => s.status === 'done').length, total: stages.length })),"],
    ["h('span', null, `子代理 ${snap.agentsStarted || 0}`)),", "h('span', null, t('detail.subagents', { n: snap.agentsStarted || 0 }))),"],
    ["h('span', null, `输入(未命中) ${fmtTokens(totals.input) || '0'}`),", "h('span', null, t('token.inputMiss', { v: fmtTokens(totals.input) || '0' })),"],
    ["h('span', null, `输入(命中) ${fmtTokens(totals.cacheRead) || '0'}`),", "h('span', null, t('token.inputHit', { v: fmtTokens(totals.cacheRead) || '0' })),"],
    ["h('span', null, `写缓存 ${fmtTokens(totals.cacheWrite) || '0'}`),", "h('span', null, t('token.cacheWrite', { v: fmtTokens(totals.cacheWrite) || '0' })),"],
    ["h('span', null, `输出 ${fmtTokens(totals.output) || '0'}`),", "h('span', null, t('token.output', { v: fmtTokens(totals.output) || '0' })),"],
    ["h('span', null, `${totals.calls} 次调用`),", "h('span', null, t('common.callsCount', { n: totals.calls })),"],
    ["h('span', null, `合计 ${fmtTokens(totalTokens(totals)) || '0'}`)),", "h('span', null, t('token.total', { v: fmtTokens(totalTokens(totals)) || '0' }))),"],
    ["sectionTitle(`阶段 · ${stages.length}`),", "sectionTitle(t('detail.stages', { n: stages.length })),"],
    ["stageUsageLine(s) || '无 token 数据'", "stageUsageLine(s) || t('common.noUsage')"],
    ["`子代理 ${String(s.childId).slice(0, 14)}`", "t('detail.subagentChip', { id: String(s.childId).slice(0, 14) })"],
    ["muted(`阶段详情读取失败：${err}`, { color: T.error })", "muted(t('detail.stageFailed', { err }), { color: T.error })"],
    ["}, `阶段 #${sel.seq} 详情`),", "}, t('detail.stageTitle', { seq: sel.seq })),"],
    ["onClick: () => setSel(null) }, '收起')),", "onClick: () => setSel(null) }, t('common.collapse'))),"],
    ["`阶段 token：${stageUsageLine(sel) || '无'}`", "t('token.stageLine', { v: stageUsageLine(sel) || t('common.none') })"],
    ["}, '🔬 验证证据'),", "}, t('stage.evidenceTitle')),"],
    ["muted('（缺失——契约未兑现，host 已记警告）', { color: T.warn })", "muted(t('stage.evidenceMissingShort'), { color: T.warn })"],
    ["}, '阶段产出'),", "}, t('detail.output')),"],
    ["}, `同任务尝试 · ${sel.attempts.length}`),", "}, t('detail.attempts', { n: sel.attempts.length })),"],
    ["sectionTitle(`日志 · 最近 ${logs.length} 条`),", "sectionTitle(t('detail.logs', { n: logs.length })),"],
    ["' → 进行中'", "' → ' + t('detail.endedRunning')"],
    // 右栏 tab
    ["setErr(address ? `无法解析 run 地址：${address}` : (readTab ? '读取 tab 地址中…' : '宿主 tab 信息钩子不可用（useTabInfo 缺失）'))",
      "setErr(address ? t('tab.resolveFailed', { address }) : (readTab ? t('tab.readingAddress') : t('tab.noHook')))"],
    ["setErr('remote 不可用（插件未挂载或版本过旧）')", "setErr(t('tab.remoteUnavailable'))"],
    ["}, '重试'))", "}, t('common.retry')))"],
    ["muted('读取 run 详情中…', { padding: 12 })", "muted(t('tab.readingRun'), { padding: 12 })"],
    // 全局面板
    ["setHint(`${label}：host 未生成可打开的地址（可能缺少会话上下文）`)", "setHint(t('panel.hintNoAddress', { label }))"],
    ["setHint(`右侧栏打开失败（宿主只在对话视图挂载它）：${label}${fallback ? '——已在本面板内联显示' : ''}`)",
      "setHint(t('panel.hintRightbarFailed', { label }) + (fallback ? t('panel.hintInlineSuffix') : ''))"],
    ["setHint(`发起会话 ${String(ownerSession).slice(0, 8)}… 不在会话列表里（可能已被清理）——已在本面板展示详情`)",
      "setHint(t('panel.hintSessionGone', { sid: String(ownerSession).slice(0, 8) }))"],
    ["setHint(`已切到发起会话，但右栏没打开（${label}）——可在该会话里用「⇥ 右栏打开」重试`)",
      "setHint(t('panel.hintSwitchedNoRightbar', { label }))"],
    ["{ ...s, err: 'remote.products 不可用（插件未挂载或版本过旧）' }", "{ ...s, err: t('panel.remoteProductsUnavailable') }"],
    ["}, '🏭 团队工作台'),", "}, t('panel.title')),"],
    ["}, '全局面板 · 按产品线'),", "}, t('panel.subtitle')),"],
    ["`当前会话 ${String(currentSessionId).slice(0, 8)}`) : h('span', { style: { fontSize: 10, color: T.text2 } }, '无当前会话')",
      "t('panel.currentSession', { sid: String(currentSessionId).slice(0, 8) })) : h('span', { style: { fontSize: 10, color: T.text2 } }, t('panel.noSession'))"],
    ["|| '未知错误' } catch (e) { /* 循环引用等 */ }", "|| t('common.unknownError') } catch (e) { /* 循环引用等 */ }"],
    ["muted(pending ? '读取 tab 地址中…' : err, { color: pending ? T.text2 : T.error })", "muted(pending ? t('tab.readingAddress') : err, { color: pending ? T.text2 : T.error })"],
    ["}, '刷新数据') : null,", "}, t('panel.reload')) : null,"],
    ["title: '回到对话（再点侧边栏图标即可切回本面板）',", "title: t('panel.backToChatTip'),"],
    ["}, '回到对话'))),", "}, t('panel.backToChat')))),"],
    ["}, '知道了')) : null,", "}, t('common.gotIt'))) : null,"],
    ["muted('选择左侧产品线查看 backlog 与 run（首次进入默认选最近更新的产品线）。')", "muted(t('panel.pickProduct'))"],
    ["muted('读取产品线数据中…')", "muted(t('panel.loadingView'))"],
    ["chip(`run ${product.totalRuns}`, T.text2)", "chip(t('panel.runChip', { n: product.totalRuns }), T.text2)"],
    ["chip(`活跃 ${product.activeRuns}`, T.brand, { dot: true })", "chip(t('panel.activeChip', { n: product.activeRuns }), T.brand, { dot: true })"],
    ["chip(`验收 ${product.lastVerdict}`, stColor('accepted'))", "chip(t('panel.verdictChip', { v: product.lastVerdict }), stColor('accepted'))"],
    ["panelTabBtn('run', `🚀 流水线 run · ${runs.length}`),", "panelTabBtn('run', t('panel.tabRuns', { n: runs.length })),"],
    ["panelTabBtn('backlog', `📋 Backlog · ${backlogCount}`),", "panelTabBtn('backlog', t('panel.tabBacklog', { n: backlogCount })),"],
    ["chip(`已置顶进行中 ${pinnedActive.length}`, T.brand, { dot: true })", "chip(t('panel.pinnedActive', { n: pinnedActive.length }), T.brand, { dot: true })"],
    ["runsExpanded ? `只看最近 ${RUN_PREVIEW} 条` : `展开全部 ${runsMatched.length} 条`)",
      "runsExpanded ? t('panel.showRecent', { n: RUN_PREVIEW }) : t('panel.showAll', { n: runsMatched.length }))"],
    ["`${RUN_STATUS_TEXT[st] || st} ${runStatusCounts[st]}`", "`${runStatusText(st)} ${runStatusCounts[st]}`"],
    ["title: '清除 run 状态筛选',", "title: t('panel.clearRunFilterTip'),"],
    ["}, `筛选中 ${runSel.length} 项 · 显示 ${runsMatched.length}/${runs.length} × 清除`)",
      "}, t('panel.filtered', { sel: runSel.length, shown: runsMatched.length, total: runs.length }))"],
    ["muted('该筛选下没有 run。', { fontSize: 10.5 }),", "muted(t('panel.emptyRunFilter'), { fontSize: 10.5 }),"],
    ["muted('点一行看详情浮层；「去会话右栏」= 跳到该 run 的发起会话并在其右侧栏打开（与任务夹产物并排）', { fontSize: 10, marginTop: 8 }))",
      "muted(t('panel.runHint'), { fontSize: 10, marginTop: 8 }))"],
    ["muted('点状态徽章可筛选（多选）；终态卡片默认收起，筛选时自动显示', { fontSize: 10, marginBottom: 8 }),",
      "muted(t('panel.boardHint'), { fontSize: 10, marginBottom: 8 }),"],
    ["}, 'run 详情'),", "}, t('panel.runDetail')),"],
    ["title: '跳到该 run 的发起会话，并在那个会话的右侧栏打开（与任务夹产物并排看）',", "title: t('panel.goOwnerSessionTip'),"],
    ["}, '去发起会话')", "}, t('panel.goOwnerSession'))"],
    ["onClick: closeDetail }, '关闭'))),", "onClick: closeDetail }, t('common.close')))),"],
    ["KIND_TITLE[det.kind] || det.kind)),", "kindTitle(det.kind))),"],
  ],
}

const CJK = /[\u4e00-\u9fff]/
const LIT = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g

let failed = 0
for (const [file, pairs] of Object.entries(MAP)) {
  const path = join(root, file)
  let src = readFileSync(path, 'utf8')
  // 映射串用 LF 书写；文件可能是 CRLF（Windows 工作区），按文件实际行尾归一后再匹配。
  const eol = src.includes('\r\n') ? '\r\n' : '\n'
  const norm = (s) => (eol === '\n' ? s : s.replace(/\n/g, eol))
  const sorted = [...pairs].sort((a, b) => b[0].length - a[0].length)
  const miss = []
  let applied = 0
  let already = 0
  for (const [oldRaw, newRaw] of sorted) {
    const oldText = norm(oldRaw)
    const newText = norm(newRaw)
    const parts = src.split(oldText)
    if (parts.length === 1) {
      // 幂等：已替换过（old 消失且 new 在场）不算失败
      if (src.includes(newText)) { already++; continue }
      miss.push(oldRaw); continue
    }
    applied += parts.length - 1
    src = parts.join(newText)
  }
  writeFileSync(path, src)
  const leftover = [...new Set((src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').match(LIT) || []).filter((s) => CJK.test(s)))]
  console.log(`\n=== ${file} (eol=${eol === '\r\n' ? 'CRLF' : 'LF'}) ===`)
  console.log(`替换命中 ${applied} 处；已应用 ${already} 条；未命中映射 ${miss.length} 条`)
  for (const m of miss) { console.log(`  MISS: ${m.replace(/\s+/g, ' ').slice(0, 120)}`); failed++ }
  console.log(`残留中文字面量 ${leftover.length} 处：`)
  for (const s of leftover) console.log(`  LEFT: ${s.replace(/\s+/g, ' ').slice(0, 120)}`)
}
console.log(failed ? `\n❌ ${failed} 条映射未命中` : '\n✅ 全部映射已命中')
process.exit(failed ? 1 : 0)
