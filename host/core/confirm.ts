/**
 * dsh-plugin-teamflow core — PRD 确认单（ADR-0011 ①）。
 *
 * **为什么数据全部走结构化来源、不抽 PRD 正文**：
 * PRD 的小节标题是模型自由写的（prompt 只要求 "background & goals … scope & non-goals"），
 * 拿正则去抽「目标」段必然时灵时不灵 —— 本仓已经因此踩过一次（`## 9. 假设与待澄清` 让内联的
 * `^#{1,6}\s*(假设|…)` 正则失手，误报「契约未兑现」，实锤 tf-mu34afd2-wcjaw1）。
 * ⇒ 确认单只用三处**宿主自己写/自己解析**的数据：
 *   ① 目标一句话 = PRD state 块的 `extra.summary`（prompt 已要求，由 `mergeStateBlock` 落 `state.product.summary`）；
 *   ② 验收条件 = `state.acIndex`（prompt 要求的 `extra.acIndex`，结构化，非文本抽取）；
 *   ③ 假设清单 = `journal.assumptions`（由 `extractAssumptionsSection` 按**段**解析，行式、容错编号标题）。
 * 三者缺任一 ⇒ 只是摘要薄一点，**不因此跳过暂停**（缺假设恰恰是最该让人看一眼的情况）。
 *
 * **暂停语义**：确认单 = 「PRD 已完成、其后的阶段一个都没开始」。落点与 `abortForClarification`
 * 同构（`interrupted` + `humanIntervention`，ADR-0011 P2：复用 interrupted/resume 基座，不新增状态）。
 */
import { clip, extractAcIndexFromText } from '../util.ts'
import { t, type HostLocale } from '../locales.ts'

/** AC 上限（确认单 ≤40 行的硬预算；超出只列前 N 条并点名还有几条）。 */
export const CONFIRM_AC_MAX = 12
/** 假设清单上限（同上）。 */
export const CONFIRM_ASSUMPTIONS_MAX = 8
/** 结构化待澄清项上限（同上）。 */
export const CONFIRM_QUESTIONS_MAX = 8

/** 一条**待用户拍板**的澄清项（来自 PRD state 块的 `extra.openQuestions`，结构化）。 */
export interface ConfirmQuestion {
  q: string
  why: string
  changes: string
  default: string
}

export interface ConfirmSheet {
  /** 目标一句话（PRD state 块的 extra.summary）。 */
  summary: string
  /** AC 编号 → 一句话（`state.acIndex`，权威来源）。 */
  ac: Array<{ id: string; text: string }>
  /**
   * **AC 的来源**（ADR-0011 C 方案，2026-10-07）—— 必须回给用户看。
   *
   * `state` = 来自 PRD state 块的 `extra.acIndex`（权威）；`extracted` = host 从 PRD 正文**兜底抽取**
   * （实测 `extra` 兑现率仅 ~20%，兜底是必要的）；`none` = 两处都没有。
   * ⚠️ **空壳比空更糟**：不标注来源的话，用户会以为「没什么要注意的」，而实际是「没抓到」。
   */
  acSource: 'state' | 'extracted' | 'none'
  /**
   * **待用户拍板**的项（`state.openQuestions`，结构化优先于文本）。
   * 与 `assumptions` **语义不同、同时呈现**：这里是「要你决定」，那里是「我已经替你定了」。
   */
  questions: ConfirmQuestion[]
  /** PRD「假设 / 待澄清」段逐行（`journal.assumptions`，文本抽取的兜底形态）。 */
  assumptions: string[]
  /** PRD 全文路径（确认单只是摘要，全文让用户/主线程自己读）。 */
  docPath: string
  /** AC 总条数（用于「已列 N / 共 M 条」的诚实标注，不静默截断）。 */
  acTotal: number
  /** 待澄清项总条数（同上）。 */
  questionsTotal: number
  /** 假设总行数（同上）。 */
  assumptionsTotal: number
  at: number
}

/**
 * 组装确认单（纯函数：入参是宿主已经解析好的结构化数据，不读文件、不认文本格式）
 * ⇒ 行为级测试可以直接 import 本文件（本模块不链宿主私有 peer，同 `cancelRun` 的处置）。
 */
export function buildConfirmSheet(v: {
  summary?: string | null
  acIndex?: Record<string, string> | null
  /** PRD 全文：`extra.acIndex` 缺失时用它**兜底抽取** AC（ADR-0011 B/C）。 */
  prdText?: string | null
  /** 结构化待澄清项（`state.openQuestions`）；缺/空 ⇒ 该段不渲染。 */
  openQuestions?: ConfirmQuestion[] | null
  assumptions?: string | null
  runDocs?: string | null
}): ConfirmSheet {
  // AC：**结构化优先、文本兜底**（ADR-0011 C）。兜底必要性的实测依据：`extra` 兑现率 ~20%（7/34）。
  let acEntries = Object.entries(v.acIndex || {}).filter(([, text]) => String(text || '').trim())
  let acSource: 'state' | 'extracted' | 'none' = acEntries.length ? 'state' : 'none'
  if (!acEntries.length) {
    const extracted = extractAcIndexFromText(v.prdText)
    if (extracted) {
      acEntries = Object.entries(extracted)
      acSource = 'extracted'
    }
  }
  const assumpLines = String(v.assumptions || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*#|]+\s*$/.test(l))
  const questions = (v.openQuestions || []).filter((q) => q && String(q.q || '').trim())
  return {
    summary: clip(v.summary, 200),
    ac: acEntries.slice(0, CONFIRM_AC_MAX).map(([id, text]) => ({ id, text: clip(text, 160) })),
    acSource,
    questions: questions.slice(0, CONFIRM_QUESTIONS_MAX).map((q) => ({
      q: clip(q.q, 200),
      why: clip(q.why, 160),
      changes: clip(q.changes, 160),
      default: clip(q.default, 160),
    })),
    assumptions: assumpLines.slice(0, CONFIRM_ASSUMPTIONS_MAX).map((l) => clip(l, 160)),
    docPath: v.runDocs ? `${String(v.runDocs).replace(/\/$/, '')}/PRD.md` : 'PRD.md',
    acTotal: acEntries.length,
    questionsTotal: questions.length,
    assumptionsTotal: assumpLines.length,
    at: Date.now(),
  }
}

/** 渲染成 ≤40 行的文本（交给主线程/用户批准用）。 */
export function renderConfirmSheet(sheet: ConfirmSheet, locale: HostLocale): string {
  const lines: string[] = [t(locale, 'confirm.head', { goal: sheet.summary || t(locale, 'confirm.noSummary') })]
  if (sheet.ac.length) {
    const list = sheet.ac.map((a) => `${a.id} ${a.text}`).join('\n')
    lines.push(t(locale, 'confirm.ac', { n: sheet.ac.length, total: sheet.acTotal, list }))
    // 来源可审计：抽取来的必须自曝（否则用户在「结构化」与「抽来的」之间无从分辨）
    if (sheet.acSource === 'extracted') lines.push(t(locale, 'confirm.acExtracted'))
  } else {
    lines.push(t(locale, 'confirm.acMissing'))
  }
  if (sheet.questions.length) {
    const list = sheet.questions
      .map((q) => {
        const def = q.default ? t(locale, 'confirm.defaultAnswer', { value: q.default }) : ''
        const why = q.why ? t(locale, 'confirm.whyAsk', { value: q.why }) : ''
        return `- ${q.q}${def}${why}`
      })
      .join('\n')
    lines.push(t(locale, 'confirm.questions', { n: sheet.questions.length, total: sheet.questionsTotal, list }))
  }
  if (sheet.assumptions.length) {
    const list = sheet.assumptions.map((a) => `- ${a}`).join('\n')
    lines.push(t(locale, 'confirm.assumptions', { n: sheet.assumptions.length, total: sheet.assumptionsTotal, list }))
  }
  lines.push(t(locale, 'confirm.footer', { doc: sheet.docPath }))
  return lines.join('\n')
}

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * **审批面：可选、可插拔的批准能力**（ADR-0011 ②，2026-10-07）。
 *
 * **为什么是「回调单例」而不是直接 `ctx.get('userQuestions')`**：
 * pipeline 是**模块级纯编排**函数，拿不到插件 ctx（且它链到宿主私有 peer
 * `@deepseek-ai/dsh-llm`，Behavior 测试取不到）⇒ 沿用 `runtime` / `installCtx` 的
 * 单例搬运手法，由 service 装配时把「带着 ctx 的提问能力」登记进来。
 *
 * **契约**：`ask(journal, sheet)` 返回用户的选择；返回 `null`/`undefined` 或**抛错**
 * ＝ 本轮审批面不可用 ⇒ 调用方一律**回落**到「停在 interrupted + 汇报交主线程兜底」。
 *
 * **为什么当前默认不登记**（关键取舍）：
 * - **① 已裁决「保留自动 resume」** ⇒ 批准动作 = `resume` ⇒ 原生审批卡**不是功能必需的**，
 *   它是「体验更顺」的可选通道。
 * - **P1 只验到「请求进入转发队列」**，客户端 UI 是否真的弹卡并回传答案**未验**
 *   （实测见 `docs/adr/0011-…md` §P1 实机验证）。
 * - ⚠️ **`ask()` 带 carrier 时会一直等**：若客户端没接该请求，它会**挂住不返回**。
 *   把它放进生产路径＝把「流水线卡死」的风险常态化 ⇒ **端到端验证前不接**。
 */
export type ConfirmAsker = (journal: unknown, sheet: unknown) => Promise<string | null>

/** 审批面回调（未登记 = 一律回落）。 */
export const confirmHook: { ask?: ConfirmAsker } = {}

/** 登记／撤销审批面（可选能力；缺服务或类型不符都不抛）。 */
export function setConfirmHook(fn: unknown): void {
  confirmHook.ask = typeof fn === 'function' ? (fn as ConfirmAsker) : undefined
}

/**
 * 从 agents 服务里选出「发起该 run 的那个 live root」。
 *
 * 依据：`userQuestions.ask(request)` 只在 `request.agent` **是 registry 里的 live root** 时才会进入
 * scoped waterfall（带 scope carrier），客户端桥才会按 agentId 把问题路由到对应连接
 * （`dsh-user-questions/lib/index.js:52-60`、`dsh-api-remotes/lib/index.js:147-157`）。
 *
 * ⚠️ **多 root 且 ownerSession 匹配不上 ⇒ 返回 `null`、由调用方回落**，不猜第一个 root：
 * 问错会话比不弹卡更糟（用户在当前会话看不到卡，流水线却停在「等批准」）。
 */
export function liveRootFor(agents: unknown, ownerSession: unknown): unknown {
  try {
    const a = agents as { get?: (id: unknown) => unknown; roots?: () => unknown } | null | undefined
    if (!a || typeof a.roots !== 'function') return null
    const roots = a.roots()
    if (!Array.isArray(roots) || roots.length === 0) return null
    if (ownerSession && typeof a.get === 'function') {
      const one = a.get(ownerSession)
      if (one && roots.includes(one)) return one
    }
    return roots.length === 1 ? roots[0] : null
  } catch (e) {
    return null
  }
}
