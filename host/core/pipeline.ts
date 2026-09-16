/**
 * dsh-plugin-teamflow core — 流水线编排中枢（阶段执行 / 入口 / 取消 / 断点续跑）。
 * 依赖：context/backlog/metering/runner/report + prompts + util/constants/types + store。
 * 【档位阶段集】按 mode（full/medium/lite/tech/patch）经 STAGE_POLICY（constants.ts）
 * 展开实际执行阶段集（resolveStages），再与团队阶段取交集——见 ADR-0004。
 */
import { runtime, runs, inFlight, activeProducts, providerName, workspaceScopeOf } from './context.ts'
import { initPipelineBacklog, advanceTask, storeFor, parseDefectRows, syncQaDefects, verifyReqBugs, noteTaskStageUsage, noteTaskAssign, createSubtask, completeSubtask, noteSubtaskUsage, getSubtasks, hasOpenBlockingBugs } from './backlog.ts'
import { withRetry, resolveChildRoute } from './runner.ts'
import { deliverCompletion } from './report.ts'
import { prdPrompt, designPrompt, scaffoldPrompt, techPrompt, architectPrompt, devPrompt, qaPrompt, acceptancePrompt, techChangePrompt, patchConfirmPrompt, qaFixPrompt } from '../prompts/index.ts'
import { clip, snippet, normalizeRoot, normalizeTasks, sanitizeSnapOptions, parseAcceptanceVerdict, extractBlueprint, extractVerificationEvidence, buildRetryDiagnostic, runFolderName, deriveBranchSlug, mergeGitignore, qaRoundEntry as buildQaRoundEntry, runPool, extractAssumptionsSection } from '../util.ts'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { RETRY_LIMIT, QA_REWORK_LIMIT, PHASE_ORDER, PHASE_KEY_BY_NAME, PHASE_KEY_OF, phaseKeyOf, resolveStages, FRESH_TOKEN_BUDGET, MECHANICAL_STAGE_EFFORT, FIX_GATE_PATTERN } from '../constants.ts'
import { persistJournal, readJsonAny, journalFile } from '../../store.ts'
import type { JournalRecord } from '../../store.ts'
import type { Journal, PipelineOptions, ResumeContext, PipelineMode } from '../types.ts'
import { normalizeMode, runTriage, normalizeIntent, normalizeArtifact, qualifyBlockers, guardrailUpgrade, artifactContractsFor, type TriageVerdict } from './triage.ts'
import { loadTeams, findTeam, getActiveStages, teamNameOf } from './teams.ts'
import { loadState, extractStateBlock, mergeStateBlock, noteRun } from './state.ts'
import { runSanityCheck, gitCmd, gitRun, tfAddArgs, tfUnstageArgs, tfDocAddArgs, GIT_NOTHING_TO_COMMIT, TF_DOCS_DIR, TF_LOG_DIR } from './sanity.ts'
import type { GitResult } from './sanity.ts'
import { archiveRunLogs, sweepWorkspaceLogs } from './runlogs.ts'
import { currentModelSupportsVision } from './context.ts'
import { modeLabel, parseLocale, phaseLabel, t, type HostLocale } from '../locales.ts'
import { ambientLocale, localeForMissingSnapshot, runLocaleOf } from './locale.ts'

/** dev 子卡/阶段 label 的「开发 · 」前缀与重试后缀：zh 存量兼容 + en 新增（QA-2：既有解析契约只增不改）。
 *  en 侧必须覆盖词典 `dev.taskRetry` 的实际产出 `(attempt N)`（R3-2 实锤：只写 retry \d+ 时，
 *  无 taskKey 的存量/异常数据走 label 兜底会漏剥离，任务标题归一失效）——**只增不改 zh 分支**。 */
const DEV_TITLE_PREFIX = /^(?:开发|Dev) · /
const RETRY_SUFFIX = /(?:（(?:第 \d+ 次重试|补跑)）| \((?:retry \d+|attempt \d+|follow-up run)\))$/

/** 从 journal 已完成阶段重建断点续跑产物（prd/design/scaffold/tech/qa/acceptance/dev）。 */
export function buildResumeProducts(journal) {
  const products: Record<string, unknown> = {}
  for (const s of journal.stages) {
    if (s.status !== 'done' || !s.output) continue
    const key = phaseKeyOf(s.phase)
    if (!key) continue
    if (key === 'dev') {
      products.dev = journal.stages
        .filter((x) => phaseKeyOf(x.phase) === 'dev' && x.status === 'done' && x.output)
        .map((x) => ({ title: x.taskKey || x.label.replace(DEV_TITLE_PREFIX, ''), failed: false, output: x.output }))
    } else {
      products[key] = s.output
    }
  }
  return products
}

/** add / commit 的失败原因合并成一条可查字符串（add 成功时不占篇幅）。 */
function gitFailDetail(addR: GitResult, cmR: GitResult): string {
  return [addR.ok ? '' : `add: ${addR.error || 'failed'}`, cmR.error || 'commit failed'].filter(Boolean).join(' | ')
}

/**
 * 索引兜底的真摘出留痕：`tfUnstageArgs()` 正常时 stdout 为空（本就没被跟踪）。
 * 一旦非空 = 自有日志**确实进过索引** → 说明 `.gitignore` 那条防线失效了（规则被用户删掉 / 写不进去），
 * 这是必须可见的信号（2026-09-15：提交链路曾经「静默失效」，不能再来一次）。
 */
function noteLogsUnstaged(journal: Journal, r: GitResult, locale: HostLocale = 'zh'): void {
  if (!r.ok) {
    journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.logsUnstageFail', { msg: r.error || '' }) })
    return
  }
  const list = r.out.split('\n').map((l) => l.trim()).filter(Boolean)
  if (!list.length) return
  journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.logsUnstaged', { n: list.length, list: list.slice(0, 3).join(locale === 'en' ? ', ' : '、') }) })
}

/**
 * 让工作区的 .gitignore 忽略插件自有日志目录（幂等；返回是否真的写了）。
 *
 * 为什么需要（实锤 assetd `tf-mtwvwpxa-p3vw08`）：插件强制子代理把命令日志与临时验证脚本写进
 * `logs/teamflow/`（Log discipline / TOKEN_HYGIENE），而收口提交用裸 `add -A`——目标仓库没配
 * .gitignore 时，一次提交 227 个文件里 208 个（92%）是这批日志（100 log / 52 json / 44 临时 .mjs），
 * 真交付只有 19 个。注意当时子代理的交付报告写的是「docs/ and logs/ remain untracked as required」
 * ——交付前完全属实，是 host 在最后一刻扫进去的：**契约在 host 这一侧破的**。
 *
 * 两道防线缺一不可：
 *  ① 本函数写 .gitignore → IDE / `git status` / 用户自己的 CI 也不再看到这批文件（卫生），
 *     而且它是 `tfAddArgs()` 整树 add 的唯一依赖（见 `sanity.tfAddArgs()` 的 2026-09-15 实锤）；
 *  ② `tfUnstageArgs()` 在 add 之后把自有日志从索引里摘掉 → 规则被用户删掉、或本函数写不进去时仍然兜得住（保证）。
 * 只在**即将提交**时写入：跑失败/取消的 run 不留下一份未提交的 .gitignore 改动。
 * 2026-09-15（B 方案）后该目录只是**run 期间的暂存**（终态由 runlogs.archiveRunLogs 归档到 `$DSH_HOME`
 * 并从项目删除）——两道防线保留，覆盖「用户/子代理在 run 进行中自己提交」这个窗口。
 */
function ensureLogGitignore(cwd: string | null | undefined, journal: Journal, locale: HostLocale = 'zh'): boolean {
  if (!cwd) return false
  try {
    const file = `${cwd}/.gitignore`
    const before = existsSync(file) ? readFileSync(file, 'utf8') : null
    const merged = mergeGitignore(before, [`${TF_LOG_DIR}/`], locale)
    if (!merged.changed) return false
    writeFileSync(file, merged.text, 'utf8')
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.gitignore', { dir: TF_LOG_DIR }) })
    return true
  } catch (e) {
    // 写不进去不阻塞提交：tfUnstageArgs() 的索引兜底仍然生效（只影响 git status 的清爽度）
    journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.gitignoreFail', { msg: String((e && e.message) || e) }) })
    return false
  }
}

/** 任务夹产物读取（单轨契约：文件即产物——QA/验收 host 只读文件，回复仅摘要）。
 * 缺失/空/读取异常返回 null（调用方决定硬失败或 journal 兜底）。 */
function artifactText(journal: { workspacePath?: string | null; runDocs?: string | null }, fileName: string): string | null {
  const path = journal && journal.workspacePath && journal.runDocs ? `${journal.workspacePath}/${journal.runDocs}/${fileName}` : null
  if (!path) return null
  try {
    if (!existsSync(path)) return null
    const t = readFileSync(path, 'utf8').trim()
    return t ? t : null
  } catch (e) { return null }
}

/**
 * tool 侧预检透传的分诊裁决（2026-09-16 需求澄清闸门）：只接受形状正确的对象；
 * 形状不对 → 返回 null，走回「内部再跑一次分诊」的原路径（绝不因为透传字段坏掉就跳过路由）。
 */
function normalizeTriagePassthrough(raw: unknown): TriageVerdict | null {
  const o = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : null
  if (!o) return null
  const mode = normalizeMode(o.mode)
  if (!mode) return null
  const qb = qualifyBlockers(o.blockers)
  return {
    mode,
    kind: typeof o.kind === 'string' ? o.kind : '',
    needDesign: o.needDesign === true,
    complexity: (['small', 'medium', 'large'].indexOf(String(o.complexity)) !== -1 ? String(o.complexity) : 'medium') as TriageVerdict['complexity'],
    rationale: Array.isArray(o.rationale) ? (o.rationale as unknown[]).map((x) => String(x)).slice(0, 6) : [],
    confidence: (['high', 'medium', 'low'].indexOf(String(o.confidence)) !== -1 ? String(o.confidence) : 'medium') as TriageVerdict['confidence'],
    slug: /^[a-z0-9][a-z0-9-]{2,23}$/.test(String(o.slug || '')) ? String(o.slug) : '',
    source: o.source === 'fallback' ? 'fallback' : 'model',
    intent: normalizeIntent(o.intent),
    artifact: normalizeArtifact(o.artifact),
    installable: o.installable === true,
    blockers: qb.blockers,
    blockersDropped: qb.dropped,
    // host 侧填：档位被架构护栏从 X 升上来（ADR-0006）——仅用于日志与审计，不参与路由
    upgradedFrom: (normalizeMode(o.__upgradedFrom) || null) as PipelineMode | null,
  }
}

/** journal 里的分诊记录（shadow 埋点：Phase 2 据此决定闸门强度，而不是凭感觉）。 */
function triageRecordOf(v: TriageVerdict) {
  return {
    mode: v.mode, kind: v.kind, complexity: v.complexity, confidence: v.confidence, source: v.source,
    intent: v.intent, blockers: v.blockers, blockersDropped: v.blockersDropped,
    upgradedFrom: (v as { upgradedFrom?: string | null }).upgradedFrom || null,
  }
}

/**
 * PRD 收口：把「假设 / 待澄清」段摘出来落 `journal.assumptions`（2026-09-16，需求澄清闸门 Phase 1）。
 *
 * 为什么必须先做这个（哪怕闸门还没上）：实测 **12/12（另一次 39/39）份 PRD 都没记录过假设**——
 * agent 的替代决定完全不可见，验收人无从判断"这份 PRD 是不是我想要的"。
 * 缺失只记 warn（policy 级：闸门落地前先看数据，不硬失败）。
 */
function notePrdAssumptions(journal: Journal, locale: HostLocale): void {
  const doc = artifactText(journal, 'PRD.md') || artifactText(journal, 'TECH-CHANGE.md')
  if (!doc) return
  // 提取走 util.extractAssumptionsSection（行式；容错编号标题/附录前缀/空正文）——
  // 早先内联的 `^#{1,6}\s*(假设|…)` 正则在真实产物（`## 9. 假设与待澄清`）上匹配不到，
  // 会误报「契约未兑现」（实测 tf-mu34afd2-wcjaw1）。
  const body = extractAssumptionsSection(doc)
  if (body) {
    journal.assumptions = clip(body, 2000)
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.prdAssumptions', { n: body.split(/\n+/).filter((l) => l.trim()).length }) })
  } else {
    journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.prdAssumptionsMissing') })
  }
}

/**
 * 需求澄清闸门 · pipeline 侧兜底（2026-09-16 实测补充）：分诊判「还不是明确需求」或存在合格 must-know
 * 缺口 → **不开工**，把 run 落成**可续跑的中断态**（不建任何阶段），由完成汇报把问题交给主线程去问用户，
 * 用户答完带 `requirementSupplement` 重调（或 `teamflow_resume` 续跑）。
 *
 * 为什么兜底放在 pipeline 而不是只靠 tool 侧预检：预检在**工具调用内**跑，模型分诊可能失败并静默退回
 * 正则兜底（实测 `tf-mu35oza7-wmuckz` 漏传 signal → 0.4s fallback）→ 只靠预检会让闸门在那种情况下静默失效。
 * 代价：这一条罕见路径会留下一个零阶段 run（status=interrupted + humanIntervention），比"静默开跑"划算。
 */
function abortForClarification(journal: Journal, locale: HostLocale, verdict: TriageVerdict): void {
  journal.interrupted = true
  journal.interruptedAt = Date.now()
  journal.humanIntervention = true
  journal.error = t(locale, 'run.needsClarification', { intent: verdict.intent, n: verdict.blockers.length })
  journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.clarifyAbort', { intent: verdict.intent, n: verdict.blockers.length }) })
  for (const b of verdict.blockers) {
    journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.clarifyBlocker', { q: clip(b.question, 200), changes: clip(b.changes, 160), rework: clip(b.rework, 160) }) })
  }
}

/**
 * 断点续跑起点：第一个「没有任意 done 尝试」的阶段。
 * ⚠️ 按阶段而非尝试判断（实锤 tf-mtcomxpq）：PRD 第 1 次尝试 failed（护栏退化）但第 2 次重试 done——
 * 旧实现取第一个非 done stage → 断点错误回到 PRD，PRD/技术方案被无谓重跑。
 * 全部完成仍被中断（理论极端）→ 从产品验收继续。
 */
export function interruptedPhaseOf(journal) {
  // QA 打回未闭环（实锤 run tf-mte906e9）：P0-P2 缺陷仍 open → 无论如何回到 QA 修复-复验闭环。
  // 必须在「第一个无 done 阶段」之前判定——否则验收阶段失败过（无 done）时断点又定位到验收，
  // 带缺陷继续验收必再次失败（用户实锤：resume 进验收 2 次失败，再 resume 仍定位验收，缺陷未闭环）。
  if (hasOpenBlockingBugs(journal)) return 'qa'
  for (const phase of PHASE_ORDER) {
    const phaseStages = (journal.stages || []).filter((s) => phaseKeyOf(s.phase) === phase)
    if (phaseStages.length === 0) continue
    if (phase === 'dev') {
      // 任务级聚合（状态机 2026-09-06）：任务有 done stage = 成功；存在未成功任务 → 阶段未完成。
      // 历史失败尝试不算失败（同名任务已有 done stage）——dev 部分完成时 resume 起点 = 开发（补跑未完成）。
      const statuses = devTaskStatuses(phaseStages)
      if ([...statuses.values()].some((st) => !st.done)) return phase
    } else {
      if (!phaseStages.some((s) => s.status === 'done')) return phase
    }
  }
  return 'acceptance'
}

/** 任务级聚合（journal 驱动，2026-09-06 状态机化）：按 stage.taskKey（旧数据 label 兜底）分组——
 * 有 done stage = 任务已成功（历史失败尝试不算失败）。
 * resume 补跑判定/阶段完成判定共用；不读 backlog（两块业务线解耦——残留失败卡污染判定实锤 json-parse r1）。 */
function devTaskStatuses(stages: Array<{ taskKey?: string | null; label?: string; seq?: number; status?: string }>): Map<string, { done: boolean; lastStatus: string | null; lastSeq: number }> {
  const m = new Map<string, { done: boolean; lastStatus: string | null; lastSeq: number }>()
  for (const s of stages || []) {
    const title = String(s.taskKey || String(s.label || '').replace(DEV_TITLE_PREFIX, '').replace(RETRY_SUFFIX, '').trim())
    if (!title) continue
    const cur = m.get(title) || { done: false, lastStatus: null, lastSeq: -1 }
    if ((s.seq || 0) > cur.lastSeq) { cur.lastSeq = s.seq || 0; cur.lastStatus = s.status || null }
    if (s.status === 'done') cur.done = true
    m.set(title, cur)
  }
  return m
}

/** 开发任务定义（单一来源）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
 * resume 补跑与正常执行共用（defByTitle 按 title 匹配失败子卡）。 */
function buildDevTaskDefs(journal, tasks, locale: HostLocale = 'zh'): Array<{ title: string; spec: string; files: string[] }> {
  const blueprintTasks = (journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length)
    ? journal.blueprint.tasks.map((t) => ({ title: t.title || t(locale, 'dev.blueprintTask'), files: Array.isArray(t.files) ? t.files : [], spec: t.spec || '' }))
    : []
  return blueprintTasks.length
    ? blueprintTasks
    : tasks.length > 0
      ? tasks.map((t) => ({ title: t.title, spec: t.spec, files: [] }))
      : [{ title: t(locale, 'dev.overall'), spec: t(locale, 'dev.overallSpec'), files: [] }]
}
/**
 * 执行流水线。resume = null 全新运行；resume = { phase, products } 从断点续跑：
 * phase 之前的阶段直接复用 products 产物（跳过执行），从 phase 阶段开始重跑。
 */
export async function executePipeline(
  journal: Journal, parent: unknown, requirement: string, options: PipelineOptions,
  signal: unknown, resume: ResumeContext | null = null,
): Promise<void> {
  journal.status = 'running'
  // run 级语言快照（AC-2）：起跑解析一次；历史 journal（升级前无字段）补写一次。
  // 注意只在「缺失」时解析——resume 走 localeForMissingSnapshot(true)=zh（存量文案本就是中文，
  // 不得按当前界面语言补写，QA-1）；新 run 用环境语言。
  if (!parseLocale(journal.locale)) journal.locale = localeForMissingSnapshot(!!resume)
  const locale = runLocaleOf(journal)
  if (!resume) journal.startedAt = Date.now()
  const root = options.productRoot || null
  journal.product = root
  // 澄清答复随 run 落盘（可审计：这份需求在对齐阶段补过什么）；PRD 阶段会作为权威输入下发。
  journal.requirementSupplement = options.requirementSupplement ? String(options.requirementSupplement) : null
  // 工作区（项目）作用域：workspace slug 同时是并发锁与 backlog 的隔离键
  const scopeKey = journal.workspace || root || 'default'
  // 产品级并发限制（防御：正常入口 startPipeline/resumeRun 已预检；按工作区隔离，互不阻塞）
  if (activeProducts.has(scopeKey) && activeProducts.get(scopeKey) !== journal.id) {
    journal.status = 'failed'
    journal.error = t(locale, 'run.workspaceBusy', { ws: journal.workspacePath || scopeKey, id: activeProducts.get(scopeKey) })
    journal.endedAt = Date.now()
    persistJournal(journal)
    return
  }
  activeProducts.set(scopeKey, journal.id)
  // 日志生命周期（B 方案 2026-09-15）：先把上次崩溃/中断残留在工作区的暂存日志归档走（自愈），
  // 再淘汰超额归档。清扫尽力而为，绝不阻断起跑。
  try { sweepWorkspaceLogs(journal, locale) } catch (e) { /* 清扫失败不影响起跑 */ }
  // 自动分诊（对调用方透明）：除 `patch` 与**断点续跑**外一律跑一次——含显式 `lite`/`mode`。判据来自实测：
  // ① 模型系统性自选档位（33 次启动 14 次显式传入、0 次先预览 `teamflow_triage`），若跳过 triage，
  //    澄清闸门与 ADR-0006 架构护栏会在 42% 的启动上静默失效；
  // ② tool 侧预检只是**快路径**，它在工具调用内跑、会失败（实测 `tf-mu35oza7-wmuckz`：漏传 signal →
  //    0.4s 退 fallback）→ **权威判定放这里**，预检透传只用于省一次模型调用。
  // ⚠️ **续跑必须跳过分诊**（2026-09-17 `dddd` 续跑实测：日志多出一行 `自动分诊 … source=fallback`）：
  //    档位在首次启动就已定稿并落 `journal.options.mode`，续跑再跑一次既白花一次模型调用、又可能让
  //    档位在续跑时漂移（护栏强升本就不该在续跑路径上二次触发）。改为用已有档位补一条 shadow 记录。
  // 使用者无需了解/选择 mode；mode 是内部路由 + 可选显式覆盖（审计可见）。
  let triageSlug = ''
  const preTriage = normalizeTriagePassthrough((options as { __triage?: unknown }).__triage)
  const preTriageError = String((options as { __triageError?: unknown }).__triageError || '')
  if (preTriage) {
    triageSlug = preTriage.slug || ''
    journal.triage = triageRecordOf(preTriage)
    journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.triage', { kind: preTriage.kind, mode: preTriage.mode, source: preTriage.source }) })
    // 架构护栏强升可见化（ADR-0006）：调用方自选轻档位、分诊判 ≥medium → 已升档（模型自选档位不得绕过护栏）
    const upFrom = (preTriage as { upgradedFrom?: string | null }).upgradedFrom
    if (upFrom) journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.modeUpgraded', { from: upFrom, to: preTriage.mode }) })
    if (preTriage.blockersDropped > 0) journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.triageBlockersDropped', { n: preTriage.blockersDropped }) })
  } else if (resume) {
    // 断点续跑：档位已定稿（首次启动时定的），**不再跑分诊**；只补一条 shadow 记录保住样本连续性
    // （`journal.triage` 在续跑前若已存在则原样保留——首轮的真实裁决比这里补的更有价值）。
    if (!journal.triage) {
      journal.triage = { mode: options.mode || 'full', kind: 'resume', complexity: 'medium', confidence: 'medium', source: 'resume', intent: 'requirement', blockers: [], blockersDropped: 0, upgradedFrom: null }
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.triageResumed', { mode: options.mode || 'full' }) })
    }
  } else if (options.mode !== 'patch') {
    // 预检失败不静默（实测过：漏传 signal → 工具内分诊 0.4s 退 fallback，没人知道）
    if (preTriageError) journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.triagePreflightFail', { msg: clip(preTriageError, 200) }) })
    try {
      const callerMode = options.mode
      // 分诊输入带上澄清答复（与 tool 侧预检同一口径）：否则已答复的问题会被反复问、闸门不收敛（dddd 实测）
      const triageInput = journal.requirementSupplement
        ? `${requirement}\n\n[CLARIFIED — the user answered the open questions below during a clarification round; treat them as authoritative and do NOT re-ask]\n${String(journal.requirementSupplement)}`
        : requirement
      const verdict = await runTriage(triageInput, { needDesign: options.needDesign }, parent, signal, locale)
      // 档位：调用方给了更轻的而分诊判 ≥medium → 护栏强升；否则保持调用方选择（或走分诊结果）
      const up = guardrailUpgrade(callerMode, !!options.lite, verdict.mode)
      if (up) {
        if (callerMode !== undefined || options.lite) (verdict as unknown as Record<string, unknown>).__upgradedFrom = callerMode || 'lite'
        options.mode = up
        options.lite = up === 'lite' || up === 'tech' || up === 'patch' ? !!options.lite : false
      }
      if (verdict.needDesign && !options.needDesign) options.needDesign = true
      triageSlug = verdict.slug || ''
      journal.options = Object.assign({}, options) as Record<string, unknown>
      journal.triage = triageRecordOf(verdict)
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.triage', { kind: verdict.kind, mode: verdict.mode, source: verdict.source }) })
      const upFrom2 = (verdict as { upgradedFrom?: string | null }).upgradedFrom
      if (upFrom2) journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.modeUpgraded', { from: upFrom2, to: verdict.mode }) })
      if (verdict.blockersDropped > 0) journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.triageBlockersDropped', { n: verdict.blockersDropped }) })
      // 收敛规则（与 tool 侧一致）：**没给过澄清答复**才拦；已给过 → 残余 blocker 当作假设开工（PRD 的
      // 「假设与待澄清」段 + 完成汇报高亮），不再无限追问（dddd 实测 6 轮零 run）。
      const clarified = !!String(journal.requirementSupplement || '').trim()
      if (verdict.intent !== 'requirement' || verdict.blockers.length > 0) {
        if (!clarified) return abortForClarification(journal, locale, verdict)
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.clarifyProceedWithAssumptions', { n: verdict.blockers.length }) })
      }
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.triageFail', { msg: String((e && e.message) || e) }) })
    }
  }
  const tasks = normalizeTasks(options.tasks)
  const maxConcurrency = Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0 ? Math.min(options.maxConcurrency, 8) : 3
  const timeline: Record<string, unknown> = {}
  // 档位→阶段集（ADR-0004 差异执行的单一事实来源）：先按 mode + needDesign/needScaffold 展开，
  // 再与团队阶段列表取交集（团队可进一步裁剪）。取代散落的 if/else 阶段门控。
  const stageSet = resolveStages(options.mode, { needDesign: options.needDesign, needScaffold: options.needScaffold })
  // 团队配置：加载团队的阶段列表，确定哪些阶段跳过（optional + 未启用）
  let activeStageKeys: Set<string> | null = null
  if (options.teamId) {
    const teams = loadTeams(journal.workspace || 'default')
    const team = findTeam(teams, options.teamId)
    if (team) {
      const active = getActiveStages(team, { needDesign: options.needDesign, needScaffold: options.needScaffold })
      activeStageKeys = new Set(active.map((s) => s.key))
      // 团队名与阶段名都按 run 语言取：阶段名走 phaseLabel（teams.json 的 label 是中文数据，只作 zh 源）
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.team', { name: teamNameOf(locale, team), list: active.map((s) => phaseLabel(locale, s.key)).join(' → ') }) })
    }
  }
  journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.stageSet', { mode: options.mode || 'full', list: stageSet.join(' → ') || t(locale, 'log.stageSetEmpty') }) })
  const enabled = (key: string) => stageSet.indexOf(key as any) !== -1 && (!activeStageKeys || activeStageKeys.has(key))
  // 断点续跑：跳过 resume.phase 之前的阶段
  const resumed = (phase) => !!resume && PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf(resume.phase)
  const logSkip = (phase) => journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.skipStage', { phase: phaseLabel(locale, phase) }) })
  /** 阶段失败错误：带真实尝试次数/末次结果/累计消耗与熔断语义（取代千篇一律的「重试 N 次后仍无产出」）。 */
  const stageFailError = (label: string, r: { attempts?: number; freshTokens?: number }): Error => {
    const last = [...(journal.stages || [])].reverse().find((s) => phaseKeyOf(s.phase) === label)
    const attempts = r && r.attempts ? r.attempts : RETRY_LIMIT
    const burnt = Math.round(((r && r.freshTokens) || 0) / 1000)
    const breaker = ((r && r.freshTokens) || 0) >= FRESH_TOKEN_BUDGET ? t(locale, 'err.breaker') : ''
    const detail = last
      ? t(locale, 'err.stageLast', { outcome: last.outcome || 'unknown', summary: last.summary ? t(locale, 'err.stageLastSummary', { summary: last.summary }) : '' })
      : t(locale, 'err.stageNone')
    return new Error(t(locale, 'err.stageFail', { phase: phaseLabel(locale, label), attempts, detail, burnt, breaker }))
  }
  try {
    if (resume) {
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'run.resumeBacklog', { reqId: journal.reqId, phase: phaseLabel(locale, resume.phase) }) })
    } else {
      const init = initPipelineBacklog(journal, requirement, options)
      journal.reqId = init.reqId
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.backlogInit', { reqId: init.reqId, product: root || 'unknown', n: maxConcurrency }) })
      // 分支策略 A 落地（ADR-2026-08-27，基调=启动前用户决策，见 index.ts needs-decision 检查）：
      // auto → 建特性分支 feat/<slug>（从当前 HEAD 派生，main 或 feature 上都建）；keep → 沿用当前分支。
      // 位置：initBacklog 之后（reqId 已生成——slug fallback 链依赖它；实锤 feat/feature：分支检查早于 reqId → fallback 'feature'）。
      if (options.branchPolicy !== 'keep' && journal.workspacePath) {
        try {
          const s = runSanityCheck(journal.workspacePath, locale)
          if (s.ok && s.inRepo && !s.hasDirty) {
            const slug = deriveBranchSlug(requirement, journal.reqId, triageSlug, options.branchName)
            const branch = `feat/${slug}`
            const exists = gitCmd(journal.workspacePath, ['branch', '--list', branch])
            if (exists && exists.trim()) {
              journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.branchExists', { branch }) })
              gitCmd(journal.workspacePath, ['checkout', branch])
              journal.branch = branch
            } else {
              const ok = gitCmd(journal.workspacePath, ['checkout', '-b', branch])
              journal.logs.push({ t: Date.now(), level: 'info', message: ok !== null ? t(locale, 'log.branchCreated', { branch, from: s.branch }) : t(locale, 'log.branchCreateFail', { branch }) })
              if (ok !== null) journal.branch = branch
            }
          } else if (s.ok && s.inRepo && s.branch) {
            journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.branchDirty', { n: s.dirty.split(/\r?\n/).filter((l) => l.trim()).length, branch: s.branch }) })
          }
        } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.branchCheckFail', { msg: String((e && e.message) || e) }) }) }
      }
    }
    persistJournal(journal)

    // ADR-0008 任务夹：需求级档案单元 docs/teamflow/<yyyyMMdd>-r<N>[-<slug>]/。
    // 夹名在建夹时刻固定并持久化 journal.runDocs——阶段重试/断点续跑一律复用同夹（幂等由结构保证）。
    if (!journal.runDocs && journal.reqId) {
      journal.runDocs = `${'docs/teamflow'}/${runFolderName(new Date(), journal.reqId, triageSlug)}`
      try {
        if (journal.workspacePath) {
          const abs = `${journal.workspacePath}/${journal.runDocs}`
          mkdirSync(abs, { recursive: true })
          writeFileSync(`${abs}/meta.json`, JSON.stringify({
            reqId: journal.reqId, runId: journal.id, title: String(requirement).replace(/\s+/g, ' ').trim().slice(0, 80),
            mode: options.mode || null, createdAt: Date.now(),
          }, null, 2), 'utf8')
        }
        journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.runDocs', { docs: journal.runDocs }) })
      } catch (e) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.runDocsFail', { msg: String((e && e.message) || e) }) })
      }
    }

    // 分支策略 preAction（ADR-2026-08-27）：脏工作区的启动前处理，在 sanity 之前执行，
    // 使状态核对看到「处理后的干净基线」。stash 的改动由用户在流水线完成后自行 pop（完成汇报有提醒）。
    if (!resume && journal.workspacePath && options.preAction === 'stash') {
      try {
        const out = gitCmd(journal.workspacePath, ['stash', 'push', '-m', `teamflow:${journal.id} pre-pipeline`])
        if (out !== null) {
          journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.stash', { id: journal.id }) })
        } else {
          journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.stashFail') })
        }
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.stashErr', { msg: String((e && e.message) || e) }) }) }
    } else if (!resume && journal.workspacePath && options.preAction === 'commit') {
      try {
        const msg = (typeof options.commitMessage === 'string' && options.commitMessage.trim()) ? options.commitMessage.trim() : t(locale, 'commit.preAction', { id: journal.id })
        ensureLogGitignore(journal.workspacePath, journal, locale) // 自有日志先写进 .gitignore（幂等）
        const addR = gitRun(journal.workspacePath, tfAddArgs())
        noteLogsUnstaged(journal, gitRun(journal.workspacePath, tfUnstageArgs()), locale) // 索引兜底
        const cmR = gitRun(journal.workspacePath, ['commit', '-m', msg])
        // 失败要给原因（2026-09-15：旧写法只在 add/commit 任一为 null 时记一句「commit 执行失败」，
        // 真实原因无处可查——而那正是收口提交静默失效 4 天没被发现的根因）
        if (cmR.ok) {
          journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.preCommit', { msg: msg.slice(0, 60) }) })
        } else {
          journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.preCommitFail', { msg: gitFailDetail(addR, cmR) }) })
        }
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.preCommitErr', { msg: String((e && e.message) || e) }) }) }
    }

    // 预编译 state（跨 run 累积索引）：各阶段 prompt 注入 slice；结束后提取/合并 state 块
    const state = loadState(journal.workspace || 'default')
    state.__runCtx = { ...(state.__runCtx || {}) }
    if (journal.runDocs) state.__runCtx.runDocs = journal.runDocs
    // 注入块语言（AC-3⑤）：快照经既有 __runCtx 通道下发（不改任何 prompt 工厂签名）
    state.__runCtx.locale = locale
    // 交付形态契约（2026-09-17 实测）：形态由分诊给（triage.artifact + installable），契约清单由 host 数据表
    // 展开（ARTIFACT_CONTRACTS）→ PRD 必须把它们写成可测 AC。缺这一环的实锤：dddd 的插件"看着完整"却装不进
    // profile（缺 profile 层入口声明 + bundle 声明 + files 白名单 + workspace: 协议），而功能 AC 全绿 → 验收通过。
    // `other` 形态不注入（避免给既有产品内的普通改动套错契约）。
    try {
      const tj = journal.triage as { artifact?: string; installable?: boolean } | null | undefined
      const art = normalizeArtifact(tj?.artifact)
      const inst = tj?.installable === true
      const items = artifactContractsFor(art, inst)
      if (items.length) {
        state.__runCtx.artifact = art
        state.__runCtx.installable = inst
        state.__runCtx.artifactContracts = items.map((it) => ({ requirement: it.requirement, criteria: it.criteria }))
        journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.artifactContract', { kind: art, n: items.length }) })
      }
    } catch (e) { /* 形态契约注入失败不阻断（policy 级） */ }
    // M0 状态核对：核对代码库真实状态（多人/场外提交/非流水线改动），注入后续所有阶段。
    // 核心原则：认知可复用"减量"，但不替代"对现状的核对"。
    try {
      const wsCwd = workspaceScopeOf(parent).path
      const sanity = runSanityCheck(wsCwd, locale)
      state.__runCtx = { ...(state.__runCtx || {}), sanity: sanity.summary }
      journal.sanity = { ok: sanity.ok, branch: sanity.branch, hasDirty: sanity.hasDirty, dirty: sanity.dirty.slice(0, 1000), recentCommits: sanity.recentCommits.slice(0, 1000), summary: sanity.summary }
      if (sanity.hasDirty || !sanity.ok) {
        journal.logs.push({ t: Date.now(), level: 'warn', message: sanity.summary })
      } else {
        journal.logs.push({ t: Date.now(), level: 'info', message: sanity.summary })
      }
    } catch (e) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.sanityFail', { msg: String((e && e.message) || e) }) })
    }
    const mergeStageState = (phaseKey, output) => {
      const block = extractStateBlock(output)
      if (block) mergeStateBlock(journal.workspace || 'default', block, phaseKey)
    }
    // 验证证据块存证（dev/qaFix 契约；policy 级——缺失记 warn 不中断）。
    // 按 withRetry 返回的 stage 引用直写——并发 dev 下绝不错位（reverse().find
    // 取「最后一个无证据同 phase stage」会把 A 的证据挂到 B 的 stage，审计特性自毁）。
    const noteVerifyEvidence = (stage, output) => {
      try {
        const ev = extractVerificationEvidence(output)
        if (!ev) { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.noEvidence', { stage: stage ? phaseLabel(locale, phaseKeyOf(stage.phase)) : phaseLabel(locale, 'dev') }) }); return }
        if (stage) stage.verifyEvidence = ev
      } catch (e) { /* 存证失败不影响流水线 */ }
    }
    /**
     * 失败尝试的真实产出取用（2026-09-11 修「文本凭空丢失」）：
     * runAgent 失败路径已把产出截断落盘到 `stage.output`（供重试诊断/详情浮层），
     * 但 withRetry 的 `text` 为 null → 证据存证 / state 回写 / 子卡产物全部拿不到文本，
     * 还会派生一条**误导性 warn**「回复缺少 [Verification evidence] 块」（实锤 assetd
     * tf-mtwvwpxa-p3vw08 的 T5：块明明在，只因该轮被判失败就报「契约未兑现」）。
     * 展示/存证/诊断一律用真实文本，成功与否仍只由 `text` 决定。
     */
    const stageTextOf = (r) => r.text || ((r.stage && r.stage.output) || null)

    /* ── PRD 阶段 ── */
    let prd = null
    if (resumed('prd')) {
      prd = resume.products.prd
      timeline.prd = prd
      logSkip('prd')
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'prd') }) })
      const pForm = options.mode === 'tech'
        ? { label: t(locale, 'dev.prdTechChange'), fn: techChangePrompt }
        : options.mode === 'patch'
          ? { label: t(locale, 'dev.prdPatch'), fn: patchConfirmPrompt }
          : { label: t(locale, 'dev.prdFull'), fn: prdPrompt }
      // 澄清答复（2026-09-16 需求澄清闸门）：用户在澄清轮补充的说明是**权威输入**——拼在需求之后并显式声明
      // 「不得再自行假设」，否则 PM 会把自己的旧猜测再填一遍。原始 requirement 保持逐字不变（可审计）。
      const supplement = journal.requirementSupplement
      const prdInput = supplement
        ? `${requirement}\n\n[CLARIFIED — the user answered the open questions below during a clarification round; treat them as authoritative and do NOT re-assume]\n${supplement}`
        : requirement
      // patch 档的「单点确认」是机械阶段（核对现状 + 给直改指令，不做架构判断）→ 降档省 token
      const prdR = await withRetry(journal, parent, pForm.label, 'prd', pForm.fn(prdInput, root, journal.id, state), signal, undefined, options.mode === 'patch' ? MECHANICAL_STAGE_EFFORT : null)
      if (!prdR.text) { throw stageFailError('prd', prdR) }
      prd = prdR.text
      timeline.prd = prd
      mergeStageState('prd', prd)
      noteTaskStageUsage(journal) // PRD 角色的真实 token 累计到任务卡
      if (journal.cancelled) return
    }
    // PRD 收口（2026-09-16 需求澄清闸门 Phase 1）：把「假设 / 待澄清」段读出来落 journal，
    // 让完成汇报能显式提示「本次基于以下假设启动」——今天的缺口是**假设完全不可见**
    // （实测 12/12、39/39 份 PRD 都没这一段），验收人无从知道 agent 替他决定了什么。
    notePrdAssumptions(journal, locale)

    /* ── UI/UX 设计阶段（档位阶段集启用；lite+needDesign 也保留，显式要求的 UI 需求不被吞） ── */
    let design = null
    if (enabled('design')) {
      if (resumed('design')) {
        design = resume.products.design
        timeline.design = design
        logSkip('design')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'design') }) })
        const designR = await withRetry(journal, parent, t(locale, 'dev.design'), 'design', designPrompt(prd, root, journal.id, state), signal)
        if (!designR.text) { throw stageFailError('design', designR) }
        design = designR.text
        timeline.design = design
        mergeStageState('design', design)
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 架构规划阶段（档位阶段集启用：显式 needScaffold 才含，见 STAGE_POLICY） ── */
    let scaffold = null
    if (enabled('scaffold')) {
      if (resumed('scaffold')) {
        scaffold = resume.products.scaffold
        timeline.scaffold = scaffold
        logSkip('scaffold')
      } else {
        journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'scaffold') }) })
        // 脚手架落地是机械阶段（按蓝图建骨架/搬文件，不做判据）→ 降档省 token
        const scR = await withRetry(journal, parent, t(locale, 'dev.scaffold'), 'scaffold', scaffoldPrompt(requirement, design, root, journal.id, state), signal, undefined, MECHANICAL_STAGE_EFFORT)
        if (!scR.text) { throw stageFailError('scaffold', scR) }
        scaffold = scR.text
        timeline.scaffold = scaffold
        mergeStageState('scaffold', scaffold)
        noteTaskStageUsage(journal)
        if (journal.cancelled) return
      }
    }

    /* ── 技术方案/架构阶段（按档位阶段集；lite/tech 轻量产架构蓝图；patch 无 tech——单 agent 直改，见 STAGE_POLICY） ── */
    let tech = null
    if (enabled('tech')) {
      if (resumed('tech')) {
        tech = resume.products.tech
        timeline.tech = tech
        logSkip('tech')
      } else {
      const isHeavy = !options.lite && options.mode !== 'tech' && options.mode !== 'patch'
      journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: isHeavy ? phaseLabel(locale, 'tech') : t(locale, 'stageLabel.blueprint') }) })
      const label = isHeavy ? t(locale, 'dev.techHeavy') : t(locale, 'dev.techLite')
      const prompt = isHeavy
        ? techPrompt(prd, design, scaffold, tasks, root, journal.id, state)
        : architectPrompt(prd, root, journal.id, state)
      const techR = await withRetry(journal, parent, label, 'tech', prompt, signal)
      if (!techR.text) { throw stageFailError(label, techR) }
      tech = techR.text
      timeline.tech = tech
      mergeStageState('tech', tech)
      // 提取架构蓝图 JSON → 注入后续阶段（dev 继承蓝图）并用于自动拆任务。
      // 优先取 stage 回复输出；模型可能把蓝图写进任务夹 TECHNICAL.md（ADR-0008 收口约定）——回退读文件提取，绝不静默丢蓝图（实锤 r13：蓝图只在文档里，dev 退化为单任务整体开发、M2 拆卡失效）。
      let bd = extractBlueprint(tech)
      if (!bd || bd.summary === undefined) {
        try {
          const techFile = journal.runDocs && journal.workspacePath
            ? `${journal.workspacePath}/${journal.runDocs}/TECHNICAL.md`
            : null
          if (techFile && existsSync(techFile)) bd = extractBlueprint(readFileSync(techFile, 'utf8'))
          if (bd) journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.blueprintFromFile') })
        } catch (e) { /* 回退失败走既有告警 */ }
      }
      if (bd && bd.summary !== undefined) {
        try {
          state.__runCtx = state.__runCtx || {}
          state.__runCtx.blueprint = bd.render
          journal.blueprint = { modules: bd.modules, tasks: bd.tasks }
        } catch (e) { /* 蓝图注入失败不影响 */ }
      } else if (/<!-- blueprint -->/.test(String(tech))) {
        // 蓝图块存在但解析失败：显式告警（否则静默回退整体开发，并行度丢失难排查）
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.blueprintParseFail') })
      }
      noteTaskStageUsage(journal)
      if (journal.cancelled) return
      }
    }

    /* ── 开发阶段（并发池；resume 到 QA/验收时复用旧结果） ── */
    let devResults = null
    if (resume) {
      // resume 场景（状态机 2026-09-06）：无论起点在开发之前还是开发本身——
      // 开发 = 复用已完成产物 + 仅补跑「任务级聚合后未成功」的任务；全完成 → 跳过。
      // 判定完全基于 journal stages（devTaskStatuses），不读 backlog 子卡。
      devResults = resume.products.dev || []
      const taskStatuses = devTaskStatuses(journal.stages || [])
      const todo = buildDevTaskDefs(journal, tasks, locale).filter((d) => {
        const st = taskStatuses.get(String(d.title || '').trim())
        return !st || !st.done
      })
      if (todo.length === 0) {
        timeline.dev = devResults
        logSkip('dev')
      } else {
        const reused = devResults.filter((r) => r && !todo.some((d) => d.title === r.title))
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'run.resumeDev', { reused: reused.length, todo: todo.length }) })
        const rerun = await runPool(todo, maxConcurrency, async (task) => {          // resume 补跑诊断（缺口修复 2026-09-04）：resume 是全新子代理会话，不拼诊断=盲试
          // （与 withRetry 自动重试同构的问题——模型不知道上次为何失败，会重复踩同一坑）。
          // 找该任务上次失败 stage（同 title 的最近失败），附 buildRetryDiagnostic（outcome/summary/产出尾部）。
          const prevStage = [...journal.stages].reverse().find((s) => phaseKeyOf(s.phase) === 'dev' && s.status !== 'done' && ((s.taskKey && s.taskKey === String(task.title || '')) || (!s.taskKey && (s.label || '').includes(String(task.title || '')))))
          const resumePrompt = devPrompt(task, tech, prd, root, journal.id, state) + (prevStage ? buildRetryDiagnostic(2, prevStage) : '')
          const devR = await withRetry(journal, parent, t(locale, 'dev.taskRerun', { title: task.title }), 'dev', resumePrompt, signal, task.title)
          const rerunText = stageTextOf(devR)
          noteVerifyEvidence(devR.stage, rerunText)
          const ok = !!devR.text
          return { title: task.title, failed: !ok, output: rerunText || t(locale, 'dev.failedPlaceholder') }
        }, () => journal.cancelled)
        for (const t of rerun) {
          if (!t) continue // 取消后并发池不再取新任务 → 未启动的条目是 undefined（时间线里留空位）
          // 子卡同步：createSubtask 同名复用（业务任务实体一张卡）+ completeSubtask 更新状态
          const sub = createSubtask(journal, t.title, t.spec || '')
          if (sub) completeSubtask(journal, sub.id, t.failed, t.output ? snippet(t.output, 1000) : null, null)
        }
        devResults = [...reused, ...rerun]
        timeline.dev = devResults
      }
    } else {
      journal.logs.push({ t: Date.now(), level: 'phase', message: t(locale, 'log.enterStage', { phase: phaseLabel(locale, 'dev') }) })
      // 开发任务来源（按优先级）：架构蓝图自动拆 > 调用方显式 tasks > 整体开发兜底。
      // M2「认知前置 + 架构落地」：架构师（tech/architect 阶段）已按文件边界拆好蓝图 tasks，
      // dev 继承蓝图在既有架构上实现；无蓝图时退化为整体开发或调用方 tasks。
      const devTaskDefs = buildDevTaskDefs(journal, tasks, locale)
      // 冲突检测：蓝图任务文件有交集 → 合并（保证并发不写同一文件）；无交集才可并行
      const mergedDefs: Array<{ title: string; files: string[]; spec: string }> = []
      for (const t of devTaskDefs) {
        const hit = t.files && t.files.length
          ? mergedDefs.find((m) => m.files.some((f) => t.files.includes(f)))
          : undefined
        if (hit) {
          hit.title = `${hit.title} + ${t.title}`
          hit.spec = `${hit.spec}${t.spec ? `；${t.spec}` : ''}`
          for (const f of (t.files || [])) if (!hit.files.includes(f)) hit.files.push(f)
        } else {
          mergedDefs.push({ title: t.title, files: t.files || [], spec: t.spec || '' })
        }
      }
      journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.devStart', { n: mergedDefs.length, concurrency: maxConcurrency, fromBlueprint: journal.blueprint && Array.isArray(journal.blueprint.tasks) && journal.blueprint.tasks.length ? t(locale, 'log.devFromBlueprint') : '' }) })
      advanceTask(journal, 'running', null, t(locale, 'event.devStart'), { by: 'dev' })
      // 为每个 dev 子任务建一张子卡（并行 agent 各自独立跟踪）
      const subCards = mergedDefs.map((dt) => createSubtask(journal, dt.title, dt.spec))
      devResults = await runPool(mergedDefs, maxConcurrency, async (task, idx) => {
        const sub = subCards[idx]
        if (sub) {
          completeSubtask(journal, sub.id, false, null, null) // 先标记 running（end 由 complete 设）
          const store = storeFor(scopeKey)
          const subLive = store.find('task', sub.id)
          if (subLive) { subLive.status = 'running'; subLive.startedAt = Date.now(); store.persist(); persistJournal(journal) }
        }
        const devR = await withRetry(journal, parent, t(locale, 'dev.task', { title: task.title }), 'dev', devPrompt(task, tech, prd, root, journal.id, state), signal, task.title)
        const devText = stageTextOf(devR)
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
    if (journal.cancelled) return
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
        const qaRoundEntry = buildQaRoundEntry(round, qaR.stage ? qaR.stage.seq : null, defects, journal.qaRounds, qaR.stage && qaR.stage.usage ? qaR.stage.usage.calls : null, QA_REWORK_LIMIT)
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
        if (journal.cancelled) return
      } while (true)
      if (!qaBlocked && qaClean) {
        verifyReqBugs(journal) // 复验通过 → 关闭全部 open 缺陷
        advanceTask(journal, 'pending-acceptance', snippet(qa, 3000), t(locale, 'event.qaPass'), { by: 'qa' })
        journal.logs.push({ t: Date.now(), level: 'info', message: round > 1 ? t(locale, 'log.qaPassReverify', { n: round - 1 }) : t(locale, 'log.qaPass') })
      } else {
        journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.qaBlocked') })
      }
      if (journal.cancelled) return
    }
    persistJournal(journal)

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
  } catch (e) {
    if (journal.cancelled) {
      journal.status = 'cancelled'
      journal.error = t(locale, 'err.cancelled')
    } else {
      journal.status = 'failed'
      journal.error = String((e && e.message) || e)
    }
  } finally {
    /* 终态归一（2026-09-16 实测修正，勿删）：取消若走 `if (journal.cancelled) return` 这条**正常返回**路径，
     * 唯一把 status 落成 cancelled 的 catch 块不会执行 → run 卡在 `status='running'` 且 `cancelled=true`：
     * ① 工作台永远显示「运行中」+ 中断按钮（再按取消也无效——门禁只认 running、恰好放行，但已无在飞子代理可停），
     *    界面同时给出「↻ 从断点重跑」→ 点一次就重跑一轮 dev → 再取消 → 循环（实测 01:59 / 02:03 两轮）；
     * ② 完成汇报按 running 渲染，出现「状态：running」却 cancelled=true 的自相矛盾（主线程据此怀疑 host 在自动续跑）；
     * ③ 紧随其后的归档与孤儿收口（`journal.status === 'cancelled'` 分支）也全被跳过。
     * 故在此统一归一：仍是 running 且已置 cancelled → 落 cancelled（throw 路径已置 cancelled 时无副作用；completed 不受影响）。 */
    if (journal.cancelled && journal.status === 'running') {
      journal.status = 'cancelled'
      journal.error = journal.error || t(locale, 'err.cancelled')
    }
    journal.endedAt = Date.now()
    inFlight.delete(journal.id)
    activeProducts.delete(scopeKey) // 释放工作区级并发锁
    // 统一收口提交兜底（ADR-2026-08-27 升级：一个 run 一个 commit，取代子代理零碎提交）：
    // try 内验收通过后已提交过（幂等：无改动时 commit 跳过）；此处兜底异常路径。
    // 只有「验收通过」才提交；failed/cancelled/打回超限 needs-human 不提交——工作区保留，人工处理或 resume 修复后再收口。
    // 结构上消灭文档漏提交（实测 r16 漏 QA-REPORT/ACCEPTANCE；整树 add 必然全带），
    // 提交面 = 工作区整树**减去插件自有日志** `logs/teamflow/`：`.gitignore` 幂等补写（卫生 + 整树 add 的
    // 唯一依赖）+ `tfUnstageArgs()` 索引兜底（保证）——**不再用负 pathspec 点名自有日志**
    // （2026-09-15 实锤：点名被忽略路径 → `git add` 退出 1 → 收口提交被静默短路 4 天，见 sanity.tfAddArgs）。
    if (journal.workspacePath && journal.status === 'completed' && !journal.humanIntervention) {
      try {
        const reqHead = String(journal.requirement || '').replace(/\s+/g, ' ').trim().slice(0, 80)
        ensureLogGitignore(journal.workspacePath, journal, locale) // 自有日志先写进 .gitignore（幂等）
        // 交付文档强制入库（QA-7）：任务夹/memory.md 是交付物，目标仓库 .gitignore 可能忽略 docs/teamflow/
        const docAdd = tfDocAddArgs([journal.runDocs, `${TF_DOCS_DIR}/memory.md`].filter((p) => existsSync(`${journal.workspacePath}/${p}`)))
        if (docAdd.length) gitRun(journal.workspacePath, docAdd)
        const addR = gitRun(journal.workspacePath, tfAddArgs())
        noteLogsUnstaged(journal, gitRun(journal.workspacePath, tfUnstageArgs()), locale) // 索引兜底（幂等）
        // ③（2026-09-15 修复）：add 的结果**不再决定要不要提交**——旧写法 `add === null ? null : git commit(...)`
        // 让一次 add 失败（索引其实已写好）把整个提交短路掉，且三条日志一条都不写。现在**永远尝试提交**，
        // 由提交结果决定日志级别；add 的错误与提交错误一并写进 commitFail，故障不再不可见。
        // 「无事可做」优先用状态判定（确定性，不依赖 git 措辞）：索引为空 = 这次没有内容要提交。
        const pend = gitRun(journal.workspacePath, ['status', '--porcelain'])
        if (pend.ok && pend.out === '') {
          journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.commitSkip') })
        } else {
          const cmR = gitRun(journal.workspacePath, ['commit', '-m', t(locale, 'commit.final', { req: reqHead, id: journal.id, docs: journal.runDocs ? t(locale, 'commit.finalDocs', { docs: journal.runDocs }) : '' })])
          if (cmR.ok) {
            journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.commitDone') })
          } else if (GIT_NOTHING_TO_COMMIT.test(cmR.error || '')) {
            // 兜底分类：索引非空、但 git 仍说没东西可提交（例如只剩「未跟踪且未纳入」的文件）
            journal.logs.push({ t: Date.now(), level: 'info', message: t(locale, 'log.commitSkip') })
          } else {
            journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.commitFail', { msg: gitFailDetail(addR, cmR) }) })
          }
        }
      } catch (e) { journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'log.commitFail', { msg: String((e && e.message) || e) }) }) }
    } else if (journal.workspacePath && journal.runDocs && (journal.status === 'failed' || journal.status === 'cancelled' || journal.status === 'interrupted')) {
      journal.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'run.notCommitted', { docs: journal.runDocs }) })
    }
    // 日志生命周期（B 方案 2026-09-15）：暂存日志归档离开项目 → $DSH_HOME/teamflow/<workspace>/logs/<runId>/，
    // 项目内 **只在 run 进行期间** 存在（子代理沙箱只允许写工作区，见 core/runlogs.ts 的实测依据）。
    // 放在收口提交之后：run 期间的 pathspec 排除 + .gitignore 补写仍覆盖「用户自己在 run 中提交」的窗口。
    try { archiveRunLogs(journal, locale) } catch (e) { /* 归档尽力而为，不影响收尾 */ }
    journal.result = { requirement, options: sanitizeSnapOptions(options), timeline: summarizeTimeline(timeline) }
    persistJournal(journal) // 终态 checkpoint（含日志刷新；阶段全文保留在磁盘+内存，供详情抽屉/断点续跑读取）
    // 孤儿收尾：run 异常/取消时把未到终态的 req/task 落成可见状态（中断不再永远 in-progress；cancelled 保留 resume 入口）
    try {
      const store = storeFor(scopeKey)
      if (journal.status === 'failed') {
        const req = store.find('req', journal.reqId)
        if (req && (req.status === 'in-progress' || req.status === 'created')) {
          req.humanIntervention = true
          store.pushEvent(req, req.status, 'needs-human', t(locale, 'event.abnormalExit', { err: String(journal.error || '').slice(0, 120) }))
          req.status = 'needs-human'
        }
        const task = journal.taskId ? store.find('task', journal.taskId) : null
        if (task && (task.status === 'running' || task.status === 'pending')) {
          store.pushEvent(task, task.status, 'needs-human', t(locale, 'event.abnormalInterrupt'))
          task.status = 'needs-human'
        }
        store.persist()
      } else if (journal.status === 'cancelled') {
        const req = store.find('req', journal.reqId)
        if (req && req.status === 'in-progress') store.pushEvent(req, req.status, 'in-progress', t(locale, 'event.cancelled'))
        if (req) store.persist()
      }
    } catch (e) { /* 孤儿收尾尽力而为，不影响主收尾 */ }
    // ADR-0008：meta.json 是任务夹「静态标识卡」——reqId/runId/title/mode/createdAt 建夹即定，
    // 不再终态回写（历史：host 回写 status 导致 ①终态永远晚于 agent 提交 → 提交后再脏、②
    // run 误判时 meta 快照过时）。status/endedAt 权威在 runs/<runId>.json（journal），目录
    // 扫描聚合时以 journal 为准，勿从 meta 读动态字段。
    noteRun(journal.workspace || 'default', { id: journal.id, requirement: journal.requirement, verdict: journal.status, runDocs: journal.runDocs })
    deliverCompletion(journal, parent) // 汇总投递回发起会话（主线程）
    console.log(`[teamflow] 运行结束 ${journal.id} → ${journal.status}（工作区 ${scopeKey}）`)
  }
}

/** 结果 timeline 摘要化（内存只留 2k 级摘要，全文在磁盘 journal/backlog）。 */
export function summarizeTimeline(timeline) {
  const out = {}
  for (const key of Object.keys(timeline || {})) {
    const val = timeline[key]
    if (Array.isArray(val)) {
      out[key] = val.map((x) => (x && typeof x === 'object'
        ? { title: x.title, failed: !!x.failed, output: clip(x.output || '', 2000) }
        : clip(x, 2000)))
    } else {
      out[key] = clip(val, 2000)
    }
  }
  return out
}

/** 启动流水线：预检 + 建 journal + 异步 executePipeline（按发起会话的工作区绑 scope）。 */
export function startPipeline(agent: unknown, requirement: string, options: PipelineOptions, signal: unknown): string {
  const provider = providerName()
  const locale = ambientLocale()
  if (!provider) throw new Error(t(locale, 'run.noProvider'))
  const ws = workspaceScopeOf(agent)
  const productKey = ws.projectKey
  const active = activeProducts.get(productKey)
  if (active) throw new Error(t(locale, 'run.workspaceBusyHint', { ws: ws.path || ws.projectKey, id: active }))
  // 分支策略决策（ADR-2026-08-27 基调）：已在 teamflow_start 层完成（needs-decision → 用户选择 → 带参重发），此处不再阻断。
  // mode：显式指定 / lite 兼容 / 否则留空 → 由 executePipeline 自动分诊（对调用方透明）
  const mode = normalizeMode(options.mode) ?? (options.lite ? 'lite' : undefined)
  // 发起会话 id：阶段子代理的直接 parent（跨会话跳转子代理时据此判定/兜底）
  const ownerSession = ((agent as { session?: { id?: string } } | null | undefined)?.session?.id) || null
  const journal = {
    id: `tf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: 'teamflow-pipeline', status: 'pending',
    requirement: clip(requirement, 8000),
    workspace: ws.projectKey,
    workspacePath: ws.path,
    ownerSession,
    // run 级语言快照（AC-2）：起跑解析一次并随 journal 落盘（resume/重启读回，不重解析）
    locale,
    product: normalizeRoot(options.productRoot),
    options: {
      needDesign: !!options.needDesign,
      needScaffold: !!options.needScaffold,
      lite: !!options.lite,
      mode,
      teamId: options.teamId || undefined,
      tasks: normalizeTasks(options.tasks),
      productRoot: normalizeRoot(options.productRoot),
      maxConcurrency: (Number.isFinite(options.maxConcurrency) && options.maxConcurrency > 0) ? Math.min(options.maxConcurrency, 8) : null,
      branchPolicy: options.branchPolicy || undefined,
      branchName: options.branchName || undefined,
      preAction: options.preAction || undefined,
      commitMessage: options.commitMessage || undefined,
    },
    startedAt: null, endedAt: null, agentsStarted: 0,
    stages: [], logs: [], result: null, error: null, cancelled: false, humanIntervention: false,
    interrupted: false, interruptedAt: null, supersededBy: null,
  }
  runs.set(journal.id, journal)
  if (runs.size > 30) {
    const firstKey = runs.keys().next().value
    if (firstKey !== undefined) runs.delete(firstKey)
  }
  persistJournal(journal) // 首次 checkpoint（断点续跑基座）
  // ⚠️ 必须把**调用方的 options 里那两个内部字段**显式带到 executePipeline：`journal.options` 是**白名单字面量**
  // （审计面只留档位/团队/并发等），当初直接传它导致 `requirementSupplement` 与 `__triage` 被静默丢弃——
  // 澄清结论进不了 PRD（`[CLARIFIED]` 空转）、`journal.triage` 永远为空（shadow 埋点失效）。
  // 实锤：2026-09-16 run tf-mu34afd2-wcjaw1（模型传了 1144 字符澄清结论，落盘 options 里却完全没有该键）。
  const execOptions = Object.assign({}, journal.options, {
    requirementSupplement: options.requirementSupplement || null,
    __triage: (options as { __triage?: unknown }).__triage,
  })
  executePipeline(journal, agent, journal.requirement, execOptions, signal)
  return journal.id
}

/* 取消运行 `cancelRun` 在 core/context.ts（只操作 runs/inFlight，且无宿主私有依赖 → 可被 tests 直接加载）。 */

/** 从断点续跑：跳过已完成阶段，从第一个未完成阶段重跑（service 与工具共用）。 */
export function resumeRun(runId: string | null | undefined, sessionId: string | null | undefined): { ok: boolean; runId?: string; resumedFrom?: string; error?: string } {
  const id = typeof runId === 'string' ? runId : null
  if (!id) return { ok: false, error: t(ambientLocale(), 'run.missingId') }
  // 从磁盘加载完整 journal（内存版已裁剪 output，磁盘保留阶段产物全文）
  let j = null
  try {
    const disk = readJsonAny(journalFile(id), null) as JournalRecord | null
    if (disk && typeof disk === 'object' && disk.id === id) j = disk
  } catch (e) { /* 落到内存版 */ }
  if (!j) j = runs.get(id)
  if (!j) return { ok: false, error: t(ambientLocale(), 'run.notFound', { id }) }
  // 历史 journal 兼容（升级前无 locale 字段）：补写一次快照（AC-2：resume 不重解析已有值）。
  // QA-1：历史 run 一律 zh（与 core/locale.ts:runLocaleOf 缺省口径一致）——绝不按当前界面语言补写。
  if (!parseLocale(j.locale)) j.locale = localeForMissingSnapshot(true)
  const locale = runLocaleOf(j)
  if (j.status !== 'interrupted' && j.status !== 'failed' && j.status !== 'cancelled') {
    return { ok: false, error: t(locale, 'run.badStatus', { status: j.status }) }
  }
  // 全阶段已 done 的 failed/cancelled：没有断点可续（阶段全绿≠run 成功，如「需求与现状不符」拦截单），
  // 续跑只会兜底重跑验收、循环失败——硬拒绝，引导起新流水线（实锤 tf-mt8kxyef-29ruxt）
  if ((j.stages || []).length > 0 && (j.stages || []).every((s) => s.status === 'done')) {
    return { ok: false, error: t(locale, 'run.noBreakpoint', { status: j.status }) }
  }
  const productKey = j.workspace || j.product || 'default'
  if (activeProducts.has(productKey) && activeProducts.get(productKey) !== id) {
    return { ok: false, error: t(locale, 'run.workspaceBusy', { ws: j.workspacePath || productKey, id: activeProducts.get(productKey) }) }
  }
  const sid = typeof sessionId === 'string' ? sessionId : null
  const agent = sid && runtime.agents ? runtime.agents.get(sid) : undefined
  if (agent === undefined) return { ok: false, error: t(locale, 'run.agentNotFound', { sid }) }
  try {
    const resumePhase = interruptedPhaseOf(j)
    const products = buildResumeProducts(j)
    j.status = 'running'
    j.cancelled = false
    j.interrupted = false
    j.interruptedAt = null
    j.error = null
    // 重置历史失败留下的需人工标记（否则完成汇报头会误标「⚠️ 已完成（需人工介入）」，实锤 tf-mt5afdch 续跑）
    j.humanIntervention = false
    // 孤儿收尾回写恢复：上次失败/取消把 req/task 落到 needs-human，续跑时恢复进行中语义
    try {
      const store = storeFor(productKey)
      const req = store.find('req', j.reqId)
      if (req && req.status === 'needs-human' && req.humanIntervention) {
        store.pushEvent(req, req.status, 'in-progress', t(locale, 'event.resumeFrom', { phase: resumePhase }))
        req.status = 'in-progress'
        req.humanIntervention = false
      }
      const task = j.taskId ? store.find('task', j.taskId) : null
      if (task && task.status === 'needs-human') {
        store.pushEvent(task, task.status, 'running', t(locale, 'event.resumeTask'))
        task.status = 'running'
      }
      store.persist()
    } catch (e) { /* 恢复尽力而为 */ }
    j.endedAt = null
    j.logs = (j.logs || []).slice(-200)
    j.logs.push({ t: Date.now(), level: 'warn', message: t(locale, 'run.resume', { phase: phaseLabel(locale, resumePhase) }) })
    j.stages = (j.stages || []).filter((s) => s.status !== 'running' && s.status !== 'pending') // 清理未完成 stage；保留 done/failed 历史（失败痕迹不消失）
    runs.set(id, j) // 内存换用磁盘完整版（含 output 全文）
    persistJournal(j)
    executePipeline(j, agent, j.requirement, j.options, undefined, { phase: resumePhase, products })
    return { ok: true, runId: id, resumedFrom: resumePhase }
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
}
