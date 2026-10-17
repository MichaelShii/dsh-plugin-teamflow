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
import { normalizeOpenQuestions } from './domain/state.ts'

/** AC 上限（确认单 ≤40 行的硬预算；超出只列前 N 条并点名还有几条）。 */
export const CONFIRM_AC_MAX = 12
/** 假设清单上限（同上）。 */
export const CONFIRM_ASSUMPTIONS_MAX = 8
/** 结构化待澄清项上限（同上）。 */
export const CONFIRM_QUESTIONS_MAX = 8

/**
 * **PRD 版本上限**（2026-10-17，issue #11）：一份 run 最多被改写这么多版。
 *
 * 为什么需要上限：确认单的批准**绑在 PRD 版本上**（见 `confirmDecision`）—— 用户改主意 ⇒ PRD 重跑 ⇒
 * 上一版批准失效 ⇒ 必须再让用户看一次。这件事没有上界就成了「反复修正需求」，即 `/plan` 模式的活，
 * 与本产品「批量可靠交付」的定位互斥（MEMORY §1/§31）。⇒ 第二版之后不再接受改写，让用户重开 run。
 *
 * 2 = 首版 + 一次改写。第 3 版请求被拒（`redoAllowed`）。
 */
export const PRD_REV_MAX = 2

/**
 * **确认单的触发判据（纯函数）**（2026-10-17，取代 `!resume`）。
 *
 * 旧判据是「只做一轮」＝ `!resume`（`pipeline.ts` 里那句注释：轮次上限归 interview 档）。
 * 它的漏洞：**redo 重跑 PRD 走的正是 resume 路径** ⇒ PRD 已经变了，确认单却不再出现 ⇒
 * 用户在**没看过新 PRD** 的情况下被推进开发（issue #11 实锤 `tf-mv5xkem-imgt7v`：模型自己都说
 * "a fresh confirm sheet will arrive"，没来）。「只做一轮」把**轮次**当成了不变量，而真正可变的
 * 是**被批准的对象**。
 *
 * 现在的判据：**被批准的对象变了，批准必须自动失效**。
 *   - `approvedRev === prdRev`（且 `prdRev>0`）⇒ 这一版已经批过 ⇒ 不再打断（`reason:'approved'`）。
 *   - `prdRev > 1` ⇒ 这是**改写后的** PRD ⇒ 无条件再看一次（`reason:'revised'`），
 *     **不看 taste**：用户刚主动改了需求，他要确认改对了，而不是再由模型判断「这项要不要紧」。
 *   - 其余沿用内容驱动：有 `taste` 项才停（`reason:'taste'`／`'none'`）。
 *
 * 天然有界：`PRD_REV_MAX` 封住改写次数，`approvedRev` 封住重复打断 ⇒ 一份 run 最多两张单。
 */
export function confirmDecision(v: {
  mode?: string | null
  confirmMode?: string | null
  tasteCount?: number | null
  prdRev?: number | null
  approvedRev?: number | null
}): { ask: boolean; reason: 'patch' | 'off' | 'approved' | 'revised' | 'taste' | 'none' } {
  // `patch` = 单 agent 直改，它的 PRD 是「单点确认」机械阶段 ⇒ 不为它加人工闸门（ADR-0011 档位矩阵）。
  if (v.mode === 'patch') return { ask: false, reason: 'patch' }
  // `never` 是显式关闸（环境变量 `TEAMFLOW_CONFIRM`，调试/A-B 用）⇒ 连「改写后必须再看」也一并关掉。
  if (v.confirmMode === 'never') return { ask: false, reason: 'off' }
  const rev = Number(v.prdRev || 0) || 0
  const approved = Number(v.approvedRev || 0) || 0
  if (rev > 0 && approved >= rev) return { ask: false, reason: 'approved' }
  if (rev > 1) return { ask: true, reason: 'revised' }
  const taste = Number(v.tasteCount || 0) || 0
  if (v.confirmMode === 'always' || taste > 0) return { ask: true, reason: 'taste' }
  return { ask: false, reason: 'none' }
}

/** **还允许改写 PRD 吗**（`prdRev` 已达上限 ⇒ 拒绝 redo，让用户重开 run）。 */
export function redoAllowed(prdRev?: number | null): boolean {
  const rev = Number(prdRev || 0) || 0
  return rev < PRD_REV_MAX
}

/** 一条**待用户拍板**的澄清项（来自 PRD state 块的 `extra.openQuestions`，结构化）。 */
export interface ConfirmQuestion {
  q: string
  why: string
  changes: string
  default: string
  /**
   * **这一项属于哪一类**（2026-10-08）：`fact` = 信息缺口（`default` 兜住即可）；
   * `taste` = **主观品味项** —— 只有它会触发暂停，所以要标出来让用户一眼看到「这几条是要你定」。
   * 这里用内联联合而不 `import type` 自 `domain/state.ts`：本模块刻意不链宿主私有 peer
   * （见文件头注释），多一条类型依赖就多一份运行时耦合风险。
   */
  kind?: 'fact' | 'taste'
}

/** **本轮 PRD 的结构化输出快照**（按 run；修「汇报层串了模版」实锤 tf-mvaubzdz-5w606x，2026-10-16）。 */
export interface PrdSnapshot {
  /** 目标一句话（本轮 PRD 的 `extra.summary`；本轮没给 = null）。 */
  summary: string | null
  /** 验收条件（本轮 PRD 的 `extra.acIndex`；本轮没给 = null，由确认单再走正文兜底抽取）。 */
  acIndex: Record<string, string> | null
  /** 结构化待澄清项（本轮 PRD 的 `extra.openQuestions`；本轮没给 = null）。 */
  openQuestions: ConfirmQuestion[] | null
}

/**
 * 从 PRD 阶段产出的 state 块里**抽取本轮 PRD 的结构化输出**（按 run 快照）。
 *
 * **为什么必须按 run**：`state.json` 是**按项目累积、跨 run** 的（见 `domain/state.ts` 文件头），
 * 且 `mergeStateBlock` 是**条件式覆盖** —— `acIndex` 按键累加、`summary` 仅非空时覆盖、
 * `openQuestions` 写成整组替换但「缺键则保持原值」。⇒ 本轮 PRD 未回写这些 `extra` 键时
 * （`extra` 兑现率实测偏低，且 `tech` 档的「技术变更单」本就不产出 PRD 式 AC），确认单会拿到
 * **上一轮 run 的**目标/AC/待澄清项。实锤 `tf-mvaubzdz-5w606x`：r5（四柱节气精度）的确认单显示了
 * r4（64 卦 Wiki）的目标与 12 条 AC，而**同一份汇报的「假设」段却是对的** —— 因为「假设」读的是
 * **run 级**的 `journal.assumptions`。这份分裂正是定位根因的钥匙。
 *
 * 返回的三个字段各自可为 `null`（= 本轮 PRD 确实没给），**刻意不回落累积 state**：
 * 宁可在确认单上诚实显示「本轮没抓到」（`confirm.noSummary` / `confirm.acMissing`），
 * 也不要拿上一轮的内容冒充「本轮 PRD」（那会让用户在错误范围上批准，见 MEMORY §7「空值必须可见」）。
 *
 * 纯函数：入参是已解析好的 state 块，便于行为测试（不读文件、不认文本格式）。
 */
export function prdSnapshotFromBlock(block: unknown): PrdSnapshot {
  const b = (block && typeof block === 'object' && !Array.isArray(block)) ? (block as Record<string, unknown>) : null
  const rawExtra = b ? b.extra : null
  const extra = (rawExtra && typeof rawExtra === 'object' && !Array.isArray(rawExtra)) ? (rawExtra as Record<string, unknown>) : null

  const summary = extra && typeof extra.summary === 'string' && extra.summary.trim() ? extra.summary.trim() : null

  const rawAc = extra ? extra.acIndex : null
  let acIndex: Record<string, string> | null = null
  if (rawAc && typeof rawAc === 'object' && !Array.isArray(rawAc)) {
    const entries = Object.entries(rawAc as Record<string, unknown>)
      .filter(([, v]) => String(v == null ? '' : v).trim())
      .map(([k, v]) => [k, String(v)] as [string, string])
    acIndex = entries.length ? Object.fromEntries(entries) : null
  }

  const rawQ = extra ? extra.openQuestions : null
  const openQuestions = Array.isArray(rawQ) ? normalizeOpenQuestions(rawQ) : null

  return { summary, acIndex, openQuestions }
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
  /**
   * **这张单描述的是第几版 PRD**（2026-10-17，issue #11）。1 = 首版；2 = 用户改过一次后的版本。
   * 必须在单子上显式标出来：用户要能分清「这是我刚要求的那版」还是「第一版」——
   * 否则第二张单看起来和第一张一模一样，改了哪儿反而更难核对。
   */
  prdRev: number
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
  /** 本版 PRD 的版本号（缺省按 1）。 */
  prdRev?: number | null
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
      ...(q.kind === 'taste' ? { kind: 'taste' as const } : q.kind === 'fact' ? { kind: 'fact' as const } : {}),
    })),
    assumptions: assumpLines.slice(0, CONFIRM_ASSUMPTIONS_MAX).map((l) => clip(l, 160)),
    docPath: v.runDocs ? `${String(v.runDocs).replace(/\/$/, '')}/PRD.md` : 'PRD.md',
    acTotal: acEntries.length,
    questionsTotal: questions.length,
    assumptionsTotal: assumpLines.length,
    prdRev: Math.max(1, Number(v.prdRev || 1) || 1),
    at: Date.now(),
  }
}

/** 渲染成 ≤40 行的文本（交给主线程/用户批准用）。 */
export function renderConfirmSheet(sheet: ConfirmSheet, locale: HostLocale): string {
  const lines: string[] = [t(locale, 'confirm.head', { goal: sheet.summary || t(locale, 'confirm.noSummary') })]
  // 改写后的版本必须自曝（2026-10-17）：第二张单与第一张长得一样时，用户无从核对「我要求改的
  // 到底改没改」；同时把封顶说清（`PRD_REV_MAX`），避免他以为可以无限改下去。
  if (sheet.prdRev > 1) {
    lines.push(t(locale, 'confirm.rev', { n: String(sheet.prdRev), max: String(PRD_REV_MAX) }))
  }
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
        // 主观项打标（2026-10-08）：它会触发暂停，用户要能一眼看出「哪几条是我必须定的」。
        const tag = q.kind === 'taste' ? t(locale, 'confirm.tasteTag') : ''
        return `- ${tag}${q.q}${def}${why}`
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
