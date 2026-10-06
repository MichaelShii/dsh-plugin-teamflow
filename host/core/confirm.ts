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
import { clip } from '../util.ts'
import { t, type HostLocale } from '../locales.ts'

/** AC 上限（确认单 ≤40 行的硬预算；超出只列前 N 条并点名还有几条）。 */
export const CONFIRM_AC_MAX = 12
/** 假设清单上限（同上）。 */
export const CONFIRM_ASSUMPTIONS_MAX = 8

export interface ConfirmSheet {
  /** 目标一句话（PRD state 块的 extra.summary）。 */
  summary: string
  /** AC 编号 → 一句话（state.acIndex）。 */
  ac: Array<{ id: string; text: string }>
  /** PRD「假设 / 待澄清」段逐行。 */
  assumptions: string[]
  /** PRD 全文路径（确认单只是摘要，全文让用户/主线程自己读）。 */
  docPath: string
  /** AC 总条数（用于「已列 N / 共 M 条」的诚实标注，不静默截断）。 */
  acTotal: number
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
  assumptions?: string | null
  runDocs?: string | null
}): ConfirmSheet {
  const acEntries = Object.entries(v.acIndex || {}).filter(([, text]) => String(text || '').trim())
  const assumpLines = String(v.assumptions || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^[-*#|]+\s*$/.test(l))
  return {
    summary: clip(v.summary, 200),
    ac: acEntries.slice(0, CONFIRM_AC_MAX).map(([id, text]) => ({ id, text: clip(text, 160) })),
    assumptions: assumpLines.slice(0, CONFIRM_ASSUMPTIONS_MAX).map((l) => clip(l, 160)),
    docPath: v.runDocs ? `${String(v.runDocs).replace(/\/$/, '')}/PRD.md` : 'PRD.md',
    acTotal: acEntries.length,
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
  }
  if (sheet.assumptions.length) {
    const list = sheet.assumptions.map((a) => `- ${a}`).join('\n')
    lines.push(t(locale, 'confirm.assumptions', { n: sheet.assumptions.length, total: sheet.assumptionsTotal, list }))
  }
  lines.push(t(locale, 'confirm.footer', { doc: sheet.docPath }))
  return lines.join('\n')
}
