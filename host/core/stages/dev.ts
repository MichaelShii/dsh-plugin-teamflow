/**
 * dsh-plugin-teamflow core — 开发阶段（并发池 + 依赖分波 + resume 补跑 + 收口提测门禁）。
 *
 * v0.2.5 从 executePipeline 整体外移（2026-09-26 第 ② 步「包成命名单元」之后的第 ③ 步搬家）。
 * **函数体是逐 slice 搬来的原文，一字未改**——共享状态经 `ctx` 传入（原来靠闭包捕获），
 * 因此除一处机械替换（`return` → 返回 `{ cancelled: true }` 的语义等价改写，上一轮已完成）外
 * 不存在任何语义差异；缩进也保持原样，便于与原 commit 逐行比对。
 */
import { advanceTask, storeFor, noteTaskStageUsage, noteTaskAssign, createSubtask, completeSubtask, noteSubtaskUsage } from '../domain/backlog.ts'
import { withRetry } from '../agent/runner.ts'
import { devPrompt } from '../../prompts/index.ts'
import {
  clip, snippet, buildRetryDiagnostic, runPool, devTaskStatuses, devTaskIdAt, backfillDevTaskIds,
  mergeFileOverlaps, concurrentWriteConflicts, planDevWaves,
} from '../../util.ts'
import { phaseKeyOf } from '../../constants.ts'
import { persistJournal } from '../../../store.ts'
import { extractStateBlock } from '../domain/state.ts'
import { phaseLabel, t, type HostLocale } from '../../locales.ts'
import type { PipelineCtx } from '../pipeline.ts'

/**
 * 读 journal 后**先补算存量 stage 的 id** 再判定（2026-09-18 二次修正，勿回退）。
 *
 * 为什么：升级前的 stage 只写了 `taskKey`（title）。若直接判定（只认 id），历史成果会被
 * 当成"没做过"——实测 probe-cache `tf-mu6tb281`：纯 title 判定补跑 2 个，而"只认 id +
 * 存量回退 title"两头不靠 → **补跑 8 个**。补算后**只有一个键空间**（id），存量自愈并写回 journal。
 * 补算用**蓝图 title 匹配**（结构化 → 文本），不切分 title；合并执行的 stage 会补出多个 id。
 *
 * @returns 含 id 的任务定义（供后续 filter/completed 判定用）
 */
function devTaskDefsWithBackfill(journal, tasks, locale: HostLocale): DevTaskDef[] {
  const defs = buildDevTaskDefs(journal, tasks, locale)
  const patched = backfillDevTaskIds(journal.stages || [], defs)
  if (patched > 0) {
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devIdsBackfilled', { n: patched }) })
  }
  return defs
}

/** 开发任务定义（单一来源）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
 *  resume 补跑与正常执行共用。
 *
 *  **`id` 是任务的身份（2026-09-18 新增，勿回退）**：由 **host 按定义顺序生成**（`dt-1`…`dt-N`），
 *  与 `title` 彻底解耦。为什么必须这样——probe-cache 实锤 `tf-mu6tb281-4n43oc`：
 *  ① 冲突检测（下方 mergedDefs）会把 files 有交集的任务**合并**，合并时 `title` 被拼成
 *     `"T0 … + T6 … + T7 …"`（**host 自己拼的**，不是模型发挥），而 `taskKey` 当时只存 title；
 *  ② resume 时 `buildDevTaskDefs` 重新从蓝图取回**未合并**的 `T0 …`/`T6 …`/`T7 …`；
 *  ③ 判定按 title 全文精确匹配 → 三个都查不到 → 判定「未完成」→ **重复执行已成功的工作**
 *     （backlog 里 `dev-1` 与 `dev-7` 同是 T0、`dev-8` 同是 T6，肉眼可见的重复卡）。
 *  `id` 在**合并前**分配、合并时以数组累加，故"一个子代理干了三个任务"能被准确记账为
 *  `taskIds=['dt-1','dt-7','dt-8']`，resume 时三个 id 各自命中「已做」。
 *  **禁止回退为「按 title 匹配」或「按分隔符切分 title」**——那是拿文本长相当身份，同型的错已犯过两次
 *  （per-plugin 正则、固定 .gitignore 词表）。 */
/** dev 任务定义。`files` = 可写（owns，并发互斥判据）；`reads` = 只读依赖（不互斥）。 */
export interface DevTaskDef { id: string; title: string; spec: string; files: string[]; reads: string[] }

export function buildDevTaskDefs(journal, tasks, locale: HostLocale = 'zh'): DevTaskDef[] {
  // 蓝图任务：`files` = 可写（owns），`reads` = 只读依赖（不参与并发互斥判定）。
  // `reads` 是 2026-09-24 新增的可选字段，存量蓝图没有它 → 缺省空数组 ⇒ 行为与旧实现一致（安全默认）。
  const blueprintTasks = (journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length)
    ? journal.blueprint.tasks.map((t) => ({
      title: t.title || t(locale, 'dev.blueprintTask'),
      files: Array.isArray(t.files) ? t.files : [],
      reads: Array.isArray(t.reads) ? t.reads : [],
      spec: t.spec || '',
    }))
    : []
  const base = blueprintTasks.length
    ? blueprintTasks
    : tasks.length > 0
      ? tasks.map((t) => ({ title: t.title, spec: t.spec, files: t.files || ([] as string[]), reads: [] as string[] }))
      : [{ title: t(locale, 'dev.overall'), spec: t(locale, 'dev.overallSpec'), files: [] as string[], reads: [] as string[] }]
  // id 按定义顺序生成 —— 同一份蓝图（journal.blueprint 落盘后不变）必然产生同一组 id，
  // 故 resume 重新调用本函数时 id 稳定可对齐（这正是 title 做不到的）。
  return base.map((d, i) => ({ id: devTaskIdAt(i), title: d.title, spec: d.spec, files: d.files || [], reads: d.reads || [] }))
}
/**
 * 开发阶段（并发池 + 依赖分波 + resume 补跑 + 收口提测门禁）。
 * @returns cancelled 为真表示 dev 期间被取消，调用方须整体 return
 */
export async function runDevPhase(ctx: PipelineCtx): Promise<{ cancelled: boolean }> {
  const {
    journal, parent, signal, resume, locale, scopeKey, root, tasks, maxConcurrency, timeline, state,
    prd, tech, logSkip, mergeStageState, noteVerifyEvidence, stageTextOf,
  } = ctx
  /* ── 开发阶段（并发池；resume 到 QA/验收时复用旧结果） ── */
  /* 并发写的**事后记账**（issue #4 第三道防线）：前两道护栏都可能被绕过——
       ① 任务没声明 files ⇒ mergeFileOverlaps 无从判定；② agent 越界写别人的文件（prompt 只软约束）；
       ③ agent 用 shell 改写文件 ⇒ 宿主 CAS（FS_STALE_VERSION）完全看不见。
       唯一绕不过去的事实是「这一舞台最终动了哪些文件」（state block 的 touched），
       所以各 dev 舞台结束时连同真实执行窗口记一笔，收尾统一求并发窗口内的文件交集。 */
  const devTouchEntries: Array<{ key: string; startedAt: number; endedAt: number; files: string[] }> = []
  const trackDevTouched = (key: string, startedAt: number, endedAt: number, text: unknown) => {
    const block = extractStateBlock(text)
    const files = Array.isArray(block && block.touched)
      ? (block!.touched || []).map((f) => String(f || '').trim()).filter(Boolean)
      : []
    if (files.length) devTouchEntries.push({ key, startedAt, endedAt, files })
  }
  /** 合并结果 + 波次的留痕（两条 dev 路径共用）。**必须区分「没声明 files」与「共享可写文件」**——
     *  两者补救方式完全不同（前者要声明 files，后者是真的改同一文件）。
     *  2026-09-24 r1b 实锤第一版两条路径各打一半：resume 分支只用了 overlap 文案，三个**无 files** 的任务
     *  被合并后日志却说"共享文件"；r3 又发现 `devNoBoundary` 的 {n} 传的是**总数**，5 个任务里只有 1 个
     *  没声明 files 却写成"5 个任务未声明"。日志一旦与事实不符，排查就会被带偏——这里两个数字都给全。 */
  const logDevPlan = (defs: Array<{ files?: string[] }>, plan: ReturnType<typeof planDevWaves>) => {
    const missing = plan.missingBoundary.length
    if (missing > 0 && defs.length > 1) {
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devNoBoundary', { m: missing, n: defs.length }) })
    } else if (plan.merged > 0) {
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devOverlapMerged', { n: defs.length, m: plan.groups.length - (missing ? 1 : 0) }) })
    }
    if (plan.dropped > 0) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.devPlanCycle', { n: plan.dropped }) })
    }
    if (plan.waves.length > 0 && plan.groups.length > 1) {
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devWaves', { g: plan.groups.length, w: plan.waves.length, lanes: plan.waves.map((w) => w.length).join('+') }) })
    }
  }
  const reportDevWriteConflicts = () => {
    const hits = concurrentWriteConflicts(devTouchEntries)
    for (const c of hits.slice(0, 5)) {
      journal.logs.push({
        t: Date.now(), level: 'warn',
        message: t(locale, 'log.devWriteConflict', {
          a: clip(c.a, 40), b: clip(c.b, 40), files: c.files.slice(0, 6).join(', '),
          min: Math.max(1, Math.round(c.overlapMs / 60000)),
        }),
      })
    }
    return hits.length
  }
  let devResults = null
  if (resume) {
    // resume 场景（状态机 2026-09-06）：无论起点在开发之前还是开发本身——
    // 开发 = 复用已完成产物 + 仅补跑「任务级聚合后未成功」的任务；全完成 → 跳过。
    // 判定完全基于 journal stages（devTaskStatuses），不读 backlog 子卡。
    devResults = resume.products.dev || []
    // **先补算存量 id 再判定**（2026-09-18 二次修正）：升级前的 stage 只有 title，直接按 id 查
    // 会全部 Miss → 补跑 8 个（实测）。补算后判定只在一个键空间（id）内进行。
    const devDefs = devTaskDefsWithBackfill(journal, tasks, locale)
    const taskStatuses = devTaskStatuses(journal.stages || [])
    const todoDefs = devDefs.filter((d) => {
      const st = taskStatuses.get(d.id)
      return !st || !st.done
    })
    if (todoDefs.length === 0) {
      timeline.dev = devResults
      logSkip('dev')
    } else {
      const reused = devResults.filter((r) => r && !todoDefs.some((d) => d.title === r.title))
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'run.resumeDev', { reused: reused.length, todo: todoDefs.length }) })
      // **补跑同样要过冲突护栏**（2026-09-24 issue #4 实锤修复）：补跑任务是从
      // `devDefs` 过滤出来的**原始**任务（未合并），直接喂 runPool 会让共享文件的任务并发执行——
      // 首次开发有护栏、补跑反而没有，是最容易被忽略的一半。复用结果仍按原始 title 判定，
      // 合并/分波只作用于「这次要起几个子代理」。
      const todoPlan = planDevWaves(todoDefs)
      logDevPlan(todoDefs, todoPlan)
      const rerun: Array<{ title: string; spec?: string; dtId: string | null; failed: boolean; output: string } | undefined> = []
      for (let w = 0; w < todoPlan.waves.length; w++) {
        if (journal.cancelled) break
        // resume 补跑诊断（缺口修复 2026-09-04）：resume 是全新子代理会话，不拼诊断=盲试
        const waveRes = await runPool(todoPlan.waves[w], maxConcurrency, async (task) => {
          // （与 withRetry 自动重试同构的问题——模型不知道上次为何失败，会重复踩同一坑）。
          // 找该任务上次失败 stage（**按 taskIds 与本组任务 id 有交集**的最近失败；存量无 taskIds 时回退 title 匹配），
          // 附 buildRetryDiagnostic（outcome/summary/产出尾部）。
          const prevStage = [...journal.stages].reverse().find((s) => phaseKeyOf(s.phase) === 'dev' && s.status !== 'done'
            && (Array.isArray(s.taskIds) && s.taskIds.length
              ? task.ids.some((id) => s.taskIds.includes(id))
              : ((s.taskKey && task.ids.some((id) => s.taskKey === String(id))) || (!s.taskKey && task.title && (s.label || '').includes(String(task.title))))))
          const t0 = Date.now()
          const resumePrompt = devPrompt(task, tech, prd, root, journal.id, state) + (prevStage ? buildRetryDiagnostic(2, prevStage) : '')
          const devR = await withRetry(journal, parent, t(locale, 'dev.taskRerun', { title: task.title }), 'dev', resumePrompt, signal, task.title, null, task.ids)
          const rerunText = stageTextOf(devR)
          trackDevTouched(task.title, t0, Date.now(), rerunText)
          noteVerifyEvidence(devR.stage, rerunText)
          const ok = !!devR.text
          return { title: task.title, spec: task.spec, dtId: task.ids[0], failed: !ok, output: rerunText || t(locale, 'dev.failedPlaceholder') }
        }, () => journal.cancelled)
        rerun.push(...waveRes)
        // 失败传播（AC3）：本波有失败 ⇒ 后续波的组在拿半成品往下做，直接记账跳过（resume 会按未完成补跑）
        const failedHere = waveRes.filter((r) => r && r.failed).length
        if (failedHere > 0 && w + 1 < todoPlan.waves.length) {
          journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.devDepBlocked', { wave: w + 1, failed: failedHere, rest: todoPlan.groups.length - rerun.length }) })
          for (let gi = rerun.length; gi < todoPlan.groups.length; gi++) {
            const g = todoPlan.groups[gi]
            rerun.push({ title: g.title, spec: g.spec, dtId: g.ids[0], failed: true, output: t(locale, 'dev.depBlocked') })
          }
          break
        }
      }
      for (const t of rerun) {
        if (!t) continue // 取消后并发池不再取新任务 → 未启动的条目是 undefined（时间线里留空位）
        // 子卡同步：createSubtask 同任务复用（业务任务实体一张卡）+ completeSubtask 更新状态
        const sub = createSubtask(journal, t.title, t.spec || '', t.dtId)
        if (sub) completeSubtask(journal, sub.id, t.failed, t.output ? snippet(t.output, 1000) : null, null)
      }
      reportDevWriteConflicts()
      devResults = [...reused, ...rerun]
      timeline.dev = devResults
    }
  } else {
    journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'dev') }) })
    // 开发任务来源（按优先级）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
    // M2「认知前置 + 架构落地」：架构师（tech/architect 阶段）已按文件边界拆好蓝图 tasks，
    // dev 继承蓝图在既有架构上实现；无蓝图时退化为整体开发或调用方 tasks。
    const devTaskDefs = buildDevTaskDefs(journal, tasks, locale)
    // 冲突护栏 = 合并（write∩write，保证并发不写同一文件）+ 分波（依赖边靠排序，不再拖累无关任务）。
    // 共用实现在 `util.planDevWaves`（内部用 `mergeFileOverlaps`，不变量与 resume 路径事故的说明见其头注释）。
    // **合并时 ids 一并累加**（2026-09-18）：title 拼接是给人看的，id 数组才是身份——
    // 少了这一步，"一个子代理干了三个任务"就无法被 resume 正确识别（probe-cache 实锤）。
    // 2026-09-25（Run 3 实证后）：从「任一无 files ⇒ 整批合并串行」升级为「未知写集 ⇒ 独占最后一波」——
    // 一个收尾任务不再把 4 个本可并行的任务拖下水；reads/dependsOn 变成真实的执行顺序（AC3）。
    const devPlan = planDevWaves(devTaskDefs)
    logDevPlan(devTaskDefs, devPlan)
    // 只读声明的收益留痕：把 reads 也算冲突的话会被合并成几组？差值 = 这一轮多保住的并发路数。
    // 只对**已知边界**的任务算（未知写集本来就独占一波，混进来只会把差值抹成 0——r3 实测）。
    // 目的不是优化，而是**可观测**：模型到底有没有用 reads，看这条日志即可（不需要跑几十条流水线做统计）。
    const knownGroups = devPlan.groups.filter((g) => g.files.length)
    if (devTaskDefs.some((d) => d.reads && d.reads.length) && knownGroups.length > 1) {
      const legacy = mergeFileOverlaps(
        devTaskDefs
          .filter((d) => d.files && d.files.length)
          .map((d) => ({ ...d, files: [...d.files, ...(d.reads || [])] })),
      )
      if (legacy.length < knownGroups.length) {
        journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devParallelKept', { n: legacy.length, m: knownGroups.length, d: knownGroups.length - legacy.length }) })
      }
    }
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devStart', { n: devPlan.groups.length, concurrency: maxConcurrency, fromBlueprint: journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length ? t(locale, 'log.devFromBlueprint') : '' }) })
    advanceTask(journal, 'running', null, t(locale, 'event.devStart'), { by: 'dev' })
    // 为每个 dev 子任务建一张子卡（并行 agent 各自独立跟踪）
    // 传 ids[0] 作 dtId：合并任务的子卡归属其**首个**任务 id（保底唯一、稳定；合并语义在 stage.taskIds 里完整保留）
    const subCards = devPlan.groups.map((dt) => createSubtask(journal, dt.title, dt.spec, dt.ids[0]))
    devResults = []
    for (let w = 0; w < devPlan.waves.length; w++) {
      if (journal.cancelled) break
      const offset = devResults.length // 波次展开 = 扁平顺序，偏移量正好是已产出的结果数（含取消产生的空位）
      const waveRes = await runPool(devPlan.waves[w], maxConcurrency, async (task, idx) => {
        const sub = subCards[offset + idx]
        if (sub) {
          completeSubtask(journal, sub.id, false, null, null) // 先标记 running（end 由 complete 设）
          const store = storeFor(scopeKey)
          const subLive = store.find('task', sub.id)
          if (subLive) { subLive.status = 'running'; subLive.startedAt = Date.now(); store.persist(); persistJournal(journal) }
        }
        const t0 = Date.now()
        const devR = await withRetry(journal, parent, t(locale, 'dev.task', { title: task.title }), 'dev', devPrompt(task, tech, prd, root, journal.id, state), signal, task.title, null, task.ids)
        const devText = stageTextOf(devR)
        trackDevTouched(task.title, t0, Date.now(), devText)
        noteVerifyEvidence(devR.stage, devText)
        const ok = !!devR.text
        // 完成子卡：记录状态 + childId + 摘要
        if (sub) {
          completeSubtask(journal, sub.id, !ok, devText ? snippet(devText, 1000) : null, null)
          // 把对应 stage 的 usage 累计到子卡（withRetry 返回的 stage 引用——并发下
          // filter().pop() 会取错 stage：后完成的任务吸收先创建任务的 usage，且被多次累计超计）
          if (devR.stage) noteSubtaskUsage(journal, sub.id, devR.stage)
        }
        return { title: task.title, failed: !ok, output: devText || t(locale, 'dev.failedPlaceholder') }
      }, () => journal.cancelled)
      devResults.push(...waveRes)
      // 失败传播（AC3）：本波有失败 ⇒ 后续波的组是在拿半成品往下做，直接记账跳过（提测门禁会拦住；
      // resume 按未完成补跑）。这里只**止损**，不做新的语义——不改变「有失败 → 转人工」的门禁行为。
      const failedHere = waveRes.filter((r) => r && r.failed).length
      if (failedHere > 0 && w + 1 < devPlan.waves.length) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.devDepBlocked', { wave: w + 1, failed: failedHere, rest: devPlan.groups.length - devResults.length }) })
        for (let gi = devResults.length; gi < devPlan.groups.length; gi++) {
          const g = devPlan.groups[gi]
          const sub = subCards[gi]
          if (sub) completeSubtask(journal, sub.id, true, snippet(t(locale, 'dev.depBlocked'), 1000), null)
          devResults.push({ title: g.title, failed: true, output: t(locale, 'dev.depBlocked') })
        }
        break
      }
    }
    reportDevWriteConflicts()
    timeline.dev = devResults
    // dev 阶段 state 沉淀：汇总各 dev 产出中提取的 state 块
    for (const r of devResults) {
      if (r && r.output) mergeStageState('dev', r.output)
    }
    // 累计全部 dev stage usage 到主卡（汇总）
    noteTaskStageUsage(journal)
    const devStages = journal.stages.filter((s) => phaseKeyOf(s.phase) === 'dev')
    noteTaskAssign(journal, 'dev', devStages.map((s) => (s.childId || '').slice(0, 8)).filter(Boolean).join(',') || t(locale, 'role.devTeam'))
  }
  /* ── 开发收口：取消检查 + 提测门禁（**两个分支共用**，不可只写在其中之一） ──
     * 2026-09-16 实测（resume 后中断，dev 全部「已中止」却直接起了 QA 子代理）：这两个判断原先只写在
     * 「新开发」分支里，resume 补跑分支没有 → 取消/resume 失败都会径直进入 QA（QA 检查轮必然重复报告
     * 已知缺口，实锤 r26：T2 failed → QA 450k 白烧）。顺序也重要：**先取消检查后门禁**——取消时 dev 任务
     * 的 failed 只是「没跑完」，不该被记成提测失败转人工。 */
  if (journal.cancelled) return { cancelled: true }
  {
    const failedCount = (devResults || []).filter((r) => r && r.failed).length
    if (failedCount > 0) {
      advanceTask(journal, 'needs-human', null, t(locale, 'event.devFail'), { by: 'dev' })
      const req = storeFor(scopeKey).find('req', journal.reqId)
      if (req) { req.humanIntervention = true; storeFor(scopeKey).persist() }
      // 提测门禁（方案 A，实锤 r26）：任务 failed = 已知缺口——QA 检查轮必然重复报告同一缺项
      // （r26：T2 failed → QA 450k 白烧，D1-D4 全是 T2 缺项；修复子代理补做任务过重复读 27 次挂掉）。
      // 一律停止流水线不进 QA；人工处理后 teamflow_resume 从开发补跑 failed 任务（done 任务复用）。
      journal.logs.push({ t: Date.now(), level: 'error', message: t(locale, 'log.devFailGate', { failed: failedCount, total: (devResults || []).length }) })
      throw new Error(t(locale, 'err.devFail', { failed: failedCount, total: (devResults || []).length }))
    } else {
      advanceTask(journal, 'testable', null, t(locale, 'event.devTestable'), { by: 'dev' })
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devDone') })
    }
  }
  persistJournal(journal)
  return { cancelled: false }
}
