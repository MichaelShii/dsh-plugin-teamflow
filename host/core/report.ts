/**
 * dsh-plugin-teamflow core — 完成汇总投递（流水线结束 → 通知发起会话的 Agent）。
 * 依赖：@deepseek-ai/dsh-llm（createUserMessage）、util/types。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { clip } from '../util.ts'
import { MODE_REGISTRY, normalizeArtifact, PLUGIN_ARTIFACTS } from './triage.ts'
import { gitCmd } from './sanity.ts'
import { loadState } from './state.ts'
import { modeLabel, t } from '../locales.ts'
import { phaseKeyOf } from '../constants.ts'
import { runLocaleOf } from './locale.ts'
import type { Journal, ParentAgentLike } from '../types.ts'

/**
 * 流水线结束汇总投递：把结果通知给发起会话的 Agent（主线程）。
 * - idle Agent → followup（唤醒新 turn，模型可见汇报）
 * - running Agent → inject（注入下一个 step 的上下文，不打断）
 * 投递失败静默（Agent 已销毁/会话关闭等场景）。
 */
export function deliverCompletion(journal: Journal, parent: ParentAgentLike): void {
  try {
    if (!parent || typeof parent.inject !== 'function' || typeof parent.followup !== 'function') return
    // 汇报语言 = run 语言快照（AC-3②）：resume/进程重启后仍正确（journal 落盘了 locale）
    const locale = runLocaleOf(journal)
    const stages = journal.stages || []
    const done = stages.filter((s) => s.status === 'done').length
    const failed = stages.filter((s) => s.status === 'failed' || s.status === 'needs-human').length
    const cancelledStages = stages.filter((s) => s.status === 'cancelled').length
    const usageAgg = stages.reduce((a, s) => {
      const u = s.usage
      if (!u) return a
      a.input += u.input || 0
      a.cacheRead += u.cacheRead || 0
      a.cacheWrite += u.cacheWrite || 0
      a.output += u.output || 0
      a.calls += u.calls || 0
      return a
    }, { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 })
    const tok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n))
    const hasUsage = (usageAgg.input + usageAgg.cacheRead + usageAgg.cacheWrite + usageAgg.output) > 0
    const hitRate = (i, c) => { const t = i + c; return t > 0 ? `${Math.round((c / t) * 100)}%` : null }
    const hitTotal = hitRate(usageAgg.input, usageAgg.cacheRead)
    // 每个角色的真实 token（label 前缀即角色，如「产品经理」「QA 测试工程师」；官方口径）
    const roleLine = stages
      .filter((s) => s.usage && (s.usage.input + s.usage.output + s.usage.cacheRead + s.usage.cacheWrite) > 0)
      .slice(-8)
      .map((s) => {
        const u = s.usage
        const hit = hitRate(u.input, u.cacheRead)
        return `${String(s.label || '').split('·')[0].trim()} ⇅${tok(u.input)}/⇅${tok(u.cacheRead)}·⬆${tok(u.output)}${hit ? `·${hit}` : ''}`
      })
      .join(t(locale, 'report.listSep'))
    const tokenLine = hasUsage
      ? t(locale, 'report.token', {
        input: tok(usageAgg.input), cacheRead: tok(usageAgg.cacheRead), cacheWrite: tok(usageAgg.cacheWrite),
        output: tok(usageAgg.output), calls: usageAgg.calls, hit: hitTotal ? t(locale, 'report.tokenHit', { rate: hitTotal }) : '',
      })
      : t(locale, 'report.tokenNone')
    const statusLine = {
      completed: journal.humanIntervention ? t(locale, 'report.status.completedHuman') : t(locale, 'report.status.completed'),
      failed: t(locale, 'report.status.failed'),
      cancelled: t(locale, 'report.status.cancelled'),
      interrupted: t(locale, 'report.status.interrupted'),
    }[journal.status] || journal.status
    const stagesLine = stages.length === 0
      ? t(locale, 'report.noStages')
      : t(locale, 'report.stages', {
        total: stages.length, done,
        failed: failed > 0 ? t(locale, 'report.stagesFailed', { n: failed }) : '',
        cancelled: cancelledStages > 0 ? t(locale, 'report.stagesCancelled', { n: cancelledStages }) : '',
      })
    // 分支策略 A 收尾（ADR-2026-08-27）：验收通过 + 当前在特性分支 + 领先 main → 合回指引。
    // 合回由用户确认验收后人工执行（host 不自动合回）；非仓库/异常静默降级。
    // 收尾决策（ADR-2026-08-27 交互模式）：验收通过 + 特性分支领先 main → 决策邀请。
    // 与前置 needs-decision 对称：汇报带明确「请询问用户」的选项，用户确认后由 teamflow_merge 执行。
    //
    // ⚠ 2026-09-15 修正（实锤 tf-mu2ioilr-95l4th）：**必须确认验收真的跑过且无人为介入**再邀请合回。
    // 旧条件只有 `status === 'completed' && !error`：QA 复验超限时流程 break、验收被跳过、status 仍是
    // completed 且无 error → 汇报照样写「验收已通过，请询问用户是否合回」，诱导用户在未验收时合回 main。
    const acceptanceDone = stages.some((s) => phaseKeyOf(s.phase) === 'acceptance' && s.status === 'done')
    const mergeEligible = journal.status === 'completed' && !journal.humanIntervention && acceptanceDone && !journal.error
    let mergeHint = ''
    if (mergeEligible && journal.workspacePath) {
      try {
        const branch = gitCmd(journal.workspacePath, ['rev-parse', '--abbrev-ref', 'HEAD'])
        if (branch && branch !== 'main') {
          const ahead = gitCmd(journal.workspacePath, ['rev-list', '--count', 'main..HEAD'])
          if (ahead && Number(ahead) > 0) {
            journal.mergeStatus = journal.mergeStatus || 'pending'
            mergeHint = t(locale, 'report.mergeHint', { branch, ahead })
          }
        }
        // preAction=stash：提醒用户恢复启动前暂存的改动
        const pa = (journal.options || {}).preAction
        if (pa === 'stash') {
          const stashHint = t(locale, 'report.stashHint')
          mergeHint = mergeHint ? `${mergeHint}\n${stashHint}` : stashHint
        }
      } catch (e) { /* 非仓库/查询失败：跳过合回指引 */ }
    }
    // 反向守卫：流程提前结束（需人工介入）且验收未跑 → 显式提示「不要合回」，不给决策邀请。
    // E 方案（2026-09-15）：QA 打回超限时验收不再整段跳过，而是只读跑一次（结论强制需人工裁定）——
    // 此时 acceptanceDone 会为真，必须换成「已知问题验收」的提示，否则「不要合回」的警告会消失。
    const needsHumanNotice = journal.humanIntervention && !acceptanceDone
      ? t(locale, 'report.needsHumanNoAcceptance')
      : journal.knownIssuesAcceptance === true ? t(locale, 'report.knownIssuesNoMerge') : ''
    // 通知摘要里的状态词（未知状态回落 status 字面量）
    const noticeKey = `report.noticeStatus.${journal.status}`
    const noticeStatus = t(locale, noticeKey) === noticeKey ? journal.status : t(locale, noticeKey)
    // 取消来源（2026-09-16 实测补充）：主线程看到「已取消」但不知道谁停的，曾据错误前提怀疑
    // 「另一会话在自动续跑」（实际是人工点界面按钮）。来源随汇报显式给出，并说明**不会自动续跑**。
    const cancelSrcKey = `cancelSource.${journal.cancelSource || 'unknown'}`
    const cancelSourceLine = (journal.status === 'cancelled' || journal.cancelled === true)
      ? t(locale, 'report.cancelSource', { source: t(locale, cancelSrcKey) })
      : ''
    // 假设可见化（2026-09-16 需求澄清闸门 Phase 1）：把 PRD 的「假设 / 待澄清」段显式回给主线程——
    // 原缺口是 agent 的替代决定完全不可见（实测 39/39 份 PRD 从未记录过假设），验收人无从判断
    // 「这份 PRD 是不是我想要的」。
    const assumptionsLine = (journal.assumptions && String(journal.assumptions).trim())
      ? t(locale, 'report.assumptions', { list: clip(String(journal.assumptions), 900) })
      : ''
    // 外部供应商故障可见化（2026-09-17）：把"限流/无额度/上游故障"与"交付有缺陷"分开讲清楚——
    // dddd 实测那批失败 16 分钟后同请求即成功，属外部窗口问题；旧文案只给「失败 + 需人工」，
    // 会让人误判成交付质量。此处显式说明「非交付缺陷 + 可续跑只补这一段」。
    const externalLine = journal.externalFailure === true ? t(locale, 'report.externalFailure') : ''
    // **安装待办（2026-09-21 用户实锤）**：交付物是要装进 profile 的插件时，完成汇报必须给主 agent
    // 一段**可直接执行**的安装指令（含本机探测到的 profile 目录/命令/回滚）——而不是"请用户手动测试"。
    // 理由（实测）：流水线子代理权限启动即固定、**写不了 profile**；而主 agent 能（被拒后宿主给
    // `escalation available`，`approval/policy: ask` 下经用户批准）→ 这一步的执行者就是主 agent。
    const installLine = (() => {
      try {
        const env = journal.installEnv as { ok?: boolean; profile?: string; profileDir?: string; cliOnPath?: boolean } | null | undefined
        if (!env) return ''
        const art = normalizeArtifact((journal.triage as { artifact?: string } | null | undefined)?.artifact)
        if (PLUGIN_ARTIFACTS.indexOf(art) === -1) return ''
        if (env.ok !== true) return t(locale, 'report.installAskUser')
        return t(locale, 'report.installPending', {
          dir: env.profileDir || '?',
          how: env.cliOnPath === true
            ? t(locale, 'report.installHowCli', { profile: env.profile || '?' })
            : t(locale, 'report.installHowManual'),
        })
      } catch (e) { return '' }
    })()
    // 改动存档可见化（2026-09-17 方案 A）：非程序员的安全网必须有"看得见"的回执——
    // repo → 「已存档，可整体撤销」；none → 「未存档（用户选择），无法一键撤销」。
    const vcsLine = (() => {
      try {
        if (!journal.workspacePath) return ''
        const st = loadState(journal.workspacePath)
        if (st.gitMode === 'none') return t(locale, 'log.noVcsByChoice')
        if (journal.status === 'completed') return t(locale, 'report.vcsArchived')
        return ''
      } catch (e) { return '' }
    })()
    const text = [
      t(locale, 'report.header', { id: journal.id }),
      t(locale, 'report.statusLine', { status: statusLine, error: journal.error ? t(locale, 'report.error', { error: clip(journal.error, 300) }) : '' }),
      externalLine,
      vcsLine,
      cancelSourceLine,
      assumptionsLine,
      t(locale, 'report.stagesLine', { stages: stagesLine }),
      t(locale, 'report.agents', { n: journal.agentsStarted || 0 }),
      tokenLine,
      hasUsage && roleLine ? t(locale, 'report.byRole', { list: roleLine }) : '',
      journal.product ? t(locale, 'report.product', { product: journal.product }) : '',
      (() => {
        const m = journal.options && journal.options.mode
        return (typeof m === 'string' && m !== 'full' && m !== 'medium')
          ? t(locale, 'report.mode', { mode: modeLabel(locale, m, MODE_REGISTRY[m as keyof typeof MODE_REGISTRY] ? MODE_REGISTRY[m as keyof typeof MODE_REGISTRY].label : m) })
          : ''
      })(),
      // 引擎留痕（2026-09-18）：汇报里直接给出模型路由——排查「是不是模型的锅」不必再翻会话文件
      journal.engine && (journal.engine.provider || journal.engine.model)
        ? t(locale, 'report.engine', { engine: `${journal.engine.provider || '?'}/${journal.engine.model || '?'}` })
        : '',
      t(locale, 'report.backlog', { reqId: journal.reqId || '—' }),
      installLine,
      needsHumanNotice,
      mergeHint,
      t(locale, 'report.tabHint'),
      // 取消态的「下一步」换措辞：不给模型续跑引导（续跑是人的决定，且本 run 不会自动续跑）
      (journal.status === 'cancelled' || journal.cancelled === true) ? t(locale, 'report.nextCancelled') : t(locale, 'report.next'),
      t(locale, 'report.relay'),
    ].filter(Boolean).join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-plugin-teamflow',
        form: 'notice',
        // 状态词走词典（未知状态回落原始 status 字面量）
        summary: t(locale, 'report.notice', { status: noticeStatus, id: journal.id }),
      },
    })
    if (parent.status === 'idle') parent.followup(message)
    else parent.inject(message)
  } catch (e) {
    console.warn('[teamflow] 完成汇报投递失败（忽略）', e?.message)
  }
}
