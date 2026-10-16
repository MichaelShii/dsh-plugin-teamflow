/**
 * 缺陷「为什么还停在 open」的**可见原因**（同源 §7「空值必须可见」：
 * 状态由 host 自动推进的实体，UI 必须能回答「为什么还停在这个状态」）。
 *
 * 背景（2026-10-16 诊断）：bug 卡 `status.open` 在界面统一显示「待认领」，
 * 但 open 分两类原因且不可区分：
 *   ① P3 观察项 —— 设计上永不自动关闭（host 显式留作待登记），不是「没修好」；
 *   ② 非 P3 未闭环 —— 真缺陷没修好，来源需求以 needs-human 收尾，按设计不关闭。
 * 两类在卡片上长得一模一样，用户只能翻 bugs.json + run 日志才看得出来。
 *
 * 返回**本地化 key + 语气**，组件负责翻译；纯函数便于单测。
 */

export type BugOpenTone = 'muted' | 'warn'

export interface BugOpenReason {
  key: string
  tone: BugOpenTone
}

export function bugOpenReasonKey(
  item: { status?: string; severity?: string | null; reqId?: string | null } | null | undefined,
  req?: { status?: string; humanIntervention?: boolean } | null,
): BugOpenReason | null {
  if (!item || item.status !== 'open') return null
  // P3 观察项：设计上永不自动关闭（host 显式留作待登记），不是「没修好」。
  // severity 大小写不敏感（QA 报告列可能小写）。
  if (item.severity && String(item.severity).toUpperCase() === 'P3') return { key: 'panel.bugOpenP3', tone: 'muted' }
  // 非 P3 仍 open ⇒ 真缺陷未闭环；若来源需求以需人工裁定收尾，点明根因
  if (req && (req.humanIntervention === true || req.status === 'needs-human')) {
    return { key: 'panel.bugOpenNeedsHuman', tone: 'warn' }
  }
  return { key: 'panel.bugOpenUnclosed', tone: 'warn' }
}
