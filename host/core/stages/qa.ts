/**
 * dsh-plugin-teamflow core — QA 测试阶段（打回闭环：QA → 开发修复 → 复验；超 QA_REWORK_LIMIT 转人工）。
 *
 * v0.2.5 从 executePipeline 整体外移（2026-09-26 第 ② 步「包成命名单元」之后的第 ③ 步搬家）。
 * **函数体是逐 slice 搬来的原文，一字未改**——共享状态经 `ctx` 传入（原来靠闭包捕获），
 * 因此除一处机械替换（`return` → 返回 `{ cancelled: true }` 的语义等价改写，上一轮已完成）外
 * 不存在任何语义差异；缩进也保持原样，便于与原 commit 逐行比对。
 */
import { advanceTask, storeFor, parseDefectRows, syncQaDefects, verifyReqBugs, noteTaskStageUsage, noteTaskAssign, hasOpenBlockingBugs } from '../domain/backlog.ts'
import { withRetry, resolveChildRoute } from '../agent/runner.ts'
import { qaPrompt, qaFixPrompt } from '../../prompts/index.ts'
import { snippet, artifactText, qaRoundEntry as buildQaRoundEntry } from '../../util.ts'
import { QA_REWORK_LIMIT, phaseKeyOf, FIX_GATE_PATTERN } from '../../constants.ts'
import { persistJournal } from '../../../store.ts'
import { currentModelSupportsVision } from '../agent/context.ts'
import { phaseLabel, t } from '../../locales.ts'
import type { PipelineCtx } from '../pipeline.ts'
/**
 * QA 测试阶段（打回闭环：QA → 开发修复 → 复验；超 QA_REWORK_LIMIT 转人工）。
 * @returns qa / qaBlocked 交接给验收阶段（原先是 executePipeline 里的外层 let，现由返回值交回）
 */
export async function runQaPhase(ctx: PipelineCtx): Promise<{ cancelled: boolean; qa: string | null; qaBlocked: boolean }> {
  const {
    journal, parent, signal, resume, locale, scopeKey, root, timeline, state, prd, tech, enabled,
    resumed, logSkip, stageFailError, mergeStageState, noteVerifyEvidence, stageTextOf,
  } = ctx
  /* ── QA 测试阶段（档位阶段集启用：patch 档不含 qa，见 STAGE_POLICY） ── */
  let qa = null
  let qaBlocked = false
  if (!enabled('qa')) {
    // 档位阶段集无 QA（patch）或团队未启用 QA：跳过独立 QA
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.qaSkipped') })
    qa = t(locale, 'qa.skippedValue')
  } else if (resumed('qa') && !hasOpenBlockingBugs(journal)) {
    // 复用旧 QA 产物（QA 干净/仅 P3 时续跑）；QA 打回缺陷未闭环时不复用——重走修复-复验闭环
    // 单轨契约：文件即产物——QA-REPORT.md 优先，journal 兜底（兼容存量 run/文件缺失）
    qa = artifactText(journal, 'QA-REPORT.md') || resume.products.qa
    timeline.qa = qa
    logSkip('qa')
  } else {
    journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'qa') }) })
    advanceTask(journal, 'testing', null, t(locale, 'event.qaStart'), { by: 'qa' })
    const store = storeFor(scopeKey)
    const qaStageChildren = () => journal.stages.filter((s) => phaseKeyOf(s.phase) === 'qa').map((s) => (s.childId || '').slice(0, 8)).filter(Boolean).join(',') || t(locale, 'role.qaTeam')
    // QA → 开发修复 → 复验 打回闭环：QA 发现 P0-P2 缺陷则打回开发确认/修复，干净才进验收；超 QA_REWORK_LIMIT 轮需人工。
    let round = 0
    let qaClean = false
    const devFixRounds = []
    const qaDevSummary = () => {
      const src = JSON.stringify(timeline.dev)
      return devFixRounds.length ? `${src}\n${t(locale, 'ctx.qaFixSummary')}\n${devFixRounds.join('\n---\n')}` : src
    }
    let defects = []
    do {
      round += 1
      const isReverify = round > 1
      const label = isReverify ? t(locale, 'dev.qaReverify', { n: round - 1 }) : t(locale, 'dev.qaTest')
      // C 方案（2026-09-15）：复验轮必须在 prompt 里显式说明——复用上一轮探针（就在 logs/teamflow/<runId>/scripts/）
      // 并重跑缺陷行自带的检测命令。经既有 __runCtx 注入通道下发（不改 prompt 工厂签名）。
      state.__runCtx = { ...(state.__runCtx || {}), qaReverify: isReverify, qaRound: round }
      const qaR = await withRetry(journal, parent, label, 'qa', qaPrompt(prd, qaDevSummary(), root, journal.id, state, await currentModelSupportsVision(resolveChildRoute(parent).provider, resolveChildRoute(parent).model)), signal)
      if (!qaR.text) { advanceTask(journal, 'needs-human', null, isReverify ? t(locale, 'event.qaReverifyFail', { round: round - 1 }) : t(locale, 'event.qaFail'), { by: 'qa' }); throw stageFailError('qa', qaR) }
      // 单轨契约：文件即产物——QA-REPORT.md 是缺陷表/补测清单/结论的唯一事实来源；
      // state 块仍在回复尾部（host 机器元数据，不进文件）
      mergeStageState('qa', qaR.text)
      qa = artifactText(journal, 'QA-REPORT.md')
      if (!qa) {
        // 硬失败而非回退解析回复：回复仅摘要无缺陷表，回退=「QA 未发现缺陷」静默假交付（本次要治的病）
        journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.qaNoFile', { file: `${journal.runDocs ? journal.runDocs + '/' : ''}QA-REPORT.md` }) })
        advanceTask(journal, 'needs-human', null, t(locale, 'event.qaNoReport'), { by: 'qa' })
        throw stageFailError('qa', { attempts: qaR.attempts, freshTokens: qaR.freshTokens })
      }
      timeline.qa = qa
      noteTaskStageUsage(journal) // QA 角色的真实 usage 累计
      noteTaskAssign(journal, 'qa', qaStageChildren())
      // 用**富行**解析：缺陷卡要存复现/期望/实际（qaFix prompt 也据此给出完整缺陷描述），
      // parseDefects（瘦身契约）只留给冻结语料比对
      defects = parseDefectRows(qa)
      // 登记全部缺陷（含 P3 观察项，幂等）
      syncQaDefects(journal, defects)
      // 阻断判定：只认 P0/P1/P2（P3 观察项非阻断，记卡不循环）
      const blocking = defects.filter((d) => d.severity !== 'P3')
      /* D 埋点（2026-09-15）：逐轮记录阻断集合的**稳定身份**与增/减/停滞计数（纯函数在 util.qaRoundEntry）。
         * 目的：为「把 QA_REWORK_LIMIT 硬上限换成收敛判据」攒真实数据（当前 52 个 run 里从未出现
         * 真正需要第 3 轮的情况，而 id 跨轮不可比——QA 每轮重编号）。只记录、不改变任何行为。 */
      const qaRoundEntry = buildQaRoundEntry(
        round,
        qaR.stage ? qaR.stage.seq : null,
        defects,
        journal.qaRounds,
        qaR.stage && qaR.stage.usage ? qaR.stage.usage.calls : null,
        QA_REWORK_LIMIT,
      )
      journal.qaRounds = [...(journal.qaRounds || []), qaRoundEntry].slice(-12)
      if (blocking.length === 0) {
        qaClean = true
        journal.logs.push({ t: Date.now(), level: 'info', message: defects.length ? t(locale, 'log.qaP3', { ids: defects.map((d) => d.id).join(t(locale, 'log.idSep')) }) : t(locale, 'log.qaClean') })
        break
      }
      if (journal.cancelled) return
      if (round > QA_REWORK_LIMIT) {
        // 超过复验轮次上限 → 需人工介入，跳过产品验收（QA 不干净不验收）
        qaBlocked = true
        journal.humanIntervention = true
        journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.qaReworkLimit', { round, n: blocking.length, ids: blocking.map((d) => d.id).join(t(locale, 'log.idSep')), limit: QA_REWORK_LIMIT }) })
        advanceTask(journal, 'needs-human', snippet(qa, 3000), t(locale, 'event.qaReworkLimit', { round, limit: QA_REWORK_LIMIT }), { by: 'qa' })
        const req = store.find('req', journal.reqId)
        if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', t(locale, 'event.qaReworkLimitHuman', { limit: QA_REWORK_LIMIT, list: blocking.map((d) => d.id).join(locale === 'en' ? ', ' : '、') })) }
        break
      }
      // 打回开发确认/修复 → 下一轮复验
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.qaRework', { n: blocking.length, round }) })
      advanceTask(journal, 'rework', snippet(qa, 3000), t(locale, 'event.qaRework', { round, limit: QA_REWORK_LIMIT + 1 }), { by: 'qa' })
      const fixR = await withRetry(journal, parent, t(locale, 'dev.qaFix', { n: round }), 'dev', qaFixPrompt(blocking, qa, tech, prd, root, journal.id, state), signal, null)
      noteVerifyEvidence(fixR.stage, stageTextOf(fixR))
      if (!fixR.text) { advanceTask(journal, 'needs-human', null, t(locale, 'event.qaFixFail'), { by: 'qa' }); throw stageFailError(t(locale, 'dev.qaFixStage'), fixR) }
      devFixRounds.push(snippet(fixR.text, 3000))
      // A 方案（2026-09-15）观测：P0–P2 修复要求「类别门禁 + 命中数 before→after」进证据块。
      // policy 级（host 无法证明门禁真的存在），但**没写就是可见的**——warn 留痕供人工/复验核对。
      const fixGate = FIX_GATE_PATTERN.test(String(stageTextOf(fixR) || ''))
      if (!fixGate) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'diag.noGateEvidence', { n: blocking.length, round }) })
      }
      // D 埋点：把本轮修复的代价与「有没有落门禁」补进同一轮记录（收敛判据要同时看质量与成本）
      qaRoundEntry.fixCalls = fixR.stage && fixR.stage.usage ? fixR.stage.usage.calls : null
      qaRoundEntry.gate = fixGate
      noteTaskStageUsage(journal) // 修复子代理真实 usage 累计到任务卡
      if (journal.cancelled) return { cancelled: true, qa, qaBlocked }
    } while (true) // 有界循环：round > QA_REWORK_LIMIT → break（勿改 while 形态，见评估「未发现无界循环」）
    if (!qaBlocked && qaClean) {
      verifyReqBugs(journal) // 复验通过 → 关闭全部 open 缺陷
      advanceTask(journal, 'pending-acceptance', snippet(qa, 3000), t(locale, 'event.qaPass'), { by: 'qa' })
      journal.logs.push({ t: Date.now(), level: 'info', message: round > 1 ? t(locale, 'log.qaPassReverify', { n: round - 1 }) : t(locale, 'log.qaPass') })
    } else {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.qaBlocked') })
    }
    if (journal.cancelled) return { cancelled: true, qa, qaBlocked }
  }
  persistJournal(journal)
  return { cancelled: false, qa, qaBlocked }
}
