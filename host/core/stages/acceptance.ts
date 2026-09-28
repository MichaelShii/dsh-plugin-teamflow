/**
 * dsh-plugin-teamflow core — 产品验收阶段（交付判定 + 统一收口提交；QA 打回未超限才执行）。
 *
 * v0.2.5 从 executePipeline 整体外移（2026-09-26 第 ② 步「包成命名单元」之后的第 ③ 步搬家）。
 * **函数体是逐 slice 搬来的原文，一字未改**——共享状态经 `ctx` 传入（原来靠闭包捕获），
 * 因此除一处机械替换（`return` → 返回 `{ cancelled: true }` 的语义等价改写，上一轮已完成）外
 * 不存在任何语义差异；缩进也保持原样，便于与原 commit 逐行比对。
 */
import { advanceTask, storeFor, verifyReqBugs, noteTaskStageUsage, noteTaskAssign } from '../domain/backlog.ts'
import { withRetry, resolveChildRoute } from '../agent/runner.ts'
import { acceptancePrompt } from '../../prompts/index.ts'
import { snippet, parseAcceptanceVerdict, artifactText } from '../../util.ts'
import { phaseKeyOf } from '../../constants.ts'
import { persistJournal } from '../../../store.ts'
import { currentModelSupportsVision } from '../agent/context.ts'
import { phaseLabel, t } from '../../locales.ts'
import type { PipelineCtx } from '../pipeline.ts'
/**
 * 产品验收阶段（交付判定 + 统一收口提交；QA 打回未超限才执行）。
 */
export async function runAcceptancePhase(ctx: PipelineCtx): Promise<void> {
  const {
    journal, parent, signal, locale, scopeKey, root, timeline, state, prd, qa, qaBlocked, enabled,
    stageFailError, mergeStageState,
  } = ctx
  /* ── 产品验收阶段（QA 打回未超限才执行；超限时需求已置 needs-human，跳过验收） ── */
  if (!enabled('acceptance')) {
    // patch 档：单 agent 直改 + 自测即交付（无独立 QA/验收，STAGE_POLICY 兑现 desc）——
    // dev 成功即收尾（req/task → accepted + run completed），统一收口提交走现有门控
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.patchDone') })
    advanceTask(journal, 'accepted', null, t(locale, 'event.patchDelivered'), { by: 'dev' })
    const store = storeFor(scopeKey)
    const req = store.find('req', journal.reqId)
    if (req && req.status !== 'accepted') {
      store.pushEvent(req, req.status, 'accepted', t(locale, 'event.patchAccepted'))
      req.status = 'accepted'
      store.persist()
    }
    journal.status = 'completed'
  } else if (qaBlocked) {
    /* ── E 方案（2026-09-15）：已知问题模式验收 ────────────────────────────
       * QA 打回超限时不再「验收整段跳过」（旧行为：人工只拿到一个 needs-human 旗标，
       * 任务夹里连 ACCEPTANCE.md 都没有——实锤 tf-mu2ioilr-95l4th，最后靠人工补写验收记录）。
       * 这里只读跑一次验收，产出交付级视图 + 未闭环清单。
       * **硬约束（信息而非判定）**：结论一律强制为「需人工裁定」——绝不产出可据以合回/提交的
       * accepted；验收失败也不改变 run 结局（保持 completed + needs-human，只记 warn）。 */
    journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'acceptance') }) })
    const store = storeFor(scopeKey)
    const openBlocking = store.bugs.filter((b) => b.reqId === journal.reqId && b.status !== 'verified' && b.status !== 'closed' && b.severity !== 'P3')
    journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.accKnownIssues', { n: openBlocking.length, ids: openBlocking.map((b) => b.defectId || b.id).join(t(locale, 'log.idSep')) }) })
    state.__runCtx = { ...(state.__runCtx || {}), knownIssues: true }
    let accR = null
    try {
      accR = await withRetry(journal, parent, t(locale, 'dev.acceptance'), 'acceptance', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root, journal.id, state, await currentModelSupportsVision(resolveChildRoute(parent).provider, resolveChildRoute(parent).model)), signal)
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.accKnownIssuesFail', { msg: String((e && e.message) || e) }) })
    }
    if (accR && accR.text) {
      try {
        mergeStageState('acceptance', accR.text)
        const acceptance = artifactText(journal, 'ACCEPTANCE.md')
        if (acceptance) {
          timeline.acceptance = acceptance
          noteTaskStageUsage(journal) // 验收角色的真实 usage 照常累计（口径不变）
          const accStage = journal.stages.find((s) => phaseKeyOf(s.phase) === 'acceptance' && s.childId)
          noteTaskAssign(journal, 'accept', accStage ? String(accStage.childId).slice(0, 8) : t(locale, 'role.acceptTeam'))
          // 记录模型自己的结论仅供人参考——**host 不采用它**（下面的 knownIssuesAcceptance 才是事实）
          journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.accKnownIssuesVerdict', { verdict: parseAcceptanceVerdict(acceptance), n: openBlocking.length }) })
        } else {
          journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.accKnownIssuesFail', { msg: 'ACCEPTANCE.md missing' }) })
        }
      } catch (e) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.accKnownIssuesFail', { msg: String((e && e.message) || e) }) })
      }
    }
    journal.humanIntervention = true // 不变：需求仍需人工裁定
    journal.knownIssuesAcceptance = true // 报到 report.ts：给「不要据此合回」的显式提示
    journal.status = 'completed'
  } else {
    journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'acceptance') }) })
    // 单任务模型：验收前任务置「待验收」（patch/无独立 QA 时 task 仍在 testable）
    {
      const curTask = storeFor(scopeKey).find('task', journal.taskId)
      if (curTask && curTask.status !== 'pending-acceptance' && curTask.status !== 'needs-human' && curTask.status !== 'rework') {
        advanceTask(journal, 'pending-acceptance', null, t(locale, 'event.acceptEnter'), { by: 'pm' })
      }
    }
    const accR = await withRetry(journal, parent, t(locale, 'dev.acceptance'), 'acceptance', acceptancePrompt(prd, qa, JSON.stringify(timeline.dev), root, journal.id, state, await currentModelSupportsVision(resolveChildRoute(parent).provider, resolveChildRoute(parent).model)), signal)
    if (!accR.text) { advanceTask(journal, 'needs-human', null, t(locale, 'event.acceptFail'), { by: 'pm' }); throw stageFailError('acceptance', accR) }
    // 单轨契约：文件即产物——ACCEPTANCE.md 是结论行/核对表唯一事实来源；state 块仍在回复尾部
    mergeStageState('acceptance', accR.text)
    const acceptance = artifactText(journal, 'ACCEPTANCE.md')
    if (!acceptance) {
      // 硬失败而非回退解析回复：回复仅摘要无结论行，回退=保守 accepted 误放行（无结论行默认过）
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.accNoFile', { file: `${journal.runDocs ? journal.runDocs + '/' : ''}ACCEPTANCE.md` }) })
      advanceTask(journal, 'needs-human', null, t(locale, 'event.acceptNoReport'), { by: 'pm' })
      throw stageFailError('acceptance', { attempts: accR.attempts, freshTokens: accR.freshTokens })
    }
    timeline.acceptance = acceptance
    noteTaskStageUsage(journal) // 验收角色的真实 usage 累计
    const accStage = journal.stages.find((s) => phaseKeyOf(s.phase) === 'acceptance' && s.childId)
    noteTaskAssign(journal, 'accept', accStage ? String(accStage.childId).slice(0, 8) : t(locale, 'role.acceptTeam'))
    // 结论解析：见 parseAcceptanceVerdict（只认结论行，避免正文「无需改动」等否定/引用话术误杀整条流水线；
    // 无结论行 → needs-human，不猜结论——防模型写 ❌ 但漏「验收结论：」前缀被默认 accepted）
    const accVerdict = parseAcceptanceVerdict(acceptance)
    if (accVerdict === 'needs-human') {
      // 契约未兑现：ACCEPTANCE.md 无「验收结论」行（prompt 已强制最后一行字面量模板）。
      // 宁严勿松：误拦截=人工看一眼，误放行=假交付（旧实现无结论行默认 accepted=漏报）
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.accNoVerdict') })
      advanceTask(journal, 'needs-human', snippet(acceptance, 3000), t(locale, 'event.acceptNoVerdict'), { by: 'pm' })
      const store = storeFor(scopeKey)
      const req = store.find('req', journal.reqId)
      if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', t(locale, 'event.acceptVerdictMissing')) }
      journal.humanIntervention = true
      persistJournal(journal)
      throw new Error(t(locale, 'err.accNoVerdict'))
    }
    if (accVerdict === 'reject') {
      // 需求与现状不符（无有效变更）→ 拦截：task needs-human、req needs-human、流水线中断（非 accepted）
      advanceTask(journal, 'needs-human', snippet(acceptance, 3000), t(locale, 'event.reqMismatch'), { by: 'pm' })
      const store = storeFor(scopeKey)
      const req = store.find('req', journal.reqId)
      if (req) { req.humanIntervention = true; store.pushEvent(req, req.status, 'needs-human', t(locale, 'event.reqMismatchHuman')) }
      // run 级也要置位（2026-09-17 实测 `tf-mu4i779p-kze5kl`：这条路径原先只置 backlog 卡片，
      // journal.humanIntervention 仍为 false → 汇报/工作台的「需人工」状态线与 error 文案自相矛盾；
      // rework 分支一直是两边都置的，这里对齐）
      journal.humanIntervention = true
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.accReject') })
      persistJournal(journal)
      throw new Error(t(locale, 'err.accReject'))
    }
    advanceTask(journal, accVerdict, snippet(acceptance, 3000), accVerdict === 'rework' ? t(locale, 'event.acceptRework') : t(locale, 'event.acceptDone'), { by: 'pm' })
    const store = storeFor(scopeKey)
    const req = store.find('req', journal.reqId)
    if (req) {
      const openBugs = store.bugs.filter((b) => b.reqId === req.id && b.status !== 'verified' && b.status !== 'closed' && b.severity !== 'P3')
      if (accVerdict === 'rework') {
        req.humanIntervention = true
        journal.humanIntervention = true // 汇报状态线：completed+humanIntervention → ⚠️ 已完成（需人工介入）
        store.pushEvent(req, req.status, 'needs-human', t(locale, 'event.acceptRework'))
      } else if (openBugs.length > 0) {
        store.pushEvent(req, req.status, 'pending-acceptance', t(locale, 'event.bugsOpen'))
      } else {
        verifyReqBugs(journal) // 验收通过 → 关闭遗留 open 缺陷
        store.pushEvent(req, req.status, 'accepted', t(locale, 'event.acceptPass'))
      }
    }
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.allDone') })
    journal.status = 'completed'
  }
}
