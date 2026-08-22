/**
 * dsh-plugin-teamflow core — 完成汇总投递（流水线结束 → 通知发起会话的 Agent）。
 * 依赖：@deepseek-ai/dsh-llm（createUserMessage）、util/types。
 */
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { clip } from '../util.ts'
import { MODE_REGISTRY } from './triage.ts'
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
      .join('，')
    const tokenLine = hasUsage
      ? `Token：输入(未命中) ${tok(usageAgg.input)} / 输入(命中) ${tok(usageAgg.cacheRead)} / 写缓存 ${tok(usageAgg.cacheWrite)} / 输出 ${tok(usageAgg.output)} · ${usageAgg.calls} 次调用${hitTotal ? ` · 缓存命中 ${hitTotal}` : ''}`
      : 'Token：—'
    const statusLine = {
      completed: journal.humanIntervention ? '⚠️ 已完成（需人工介入）' : '✅ 已完成',
      failed: '❌ 失败',
      cancelled: '⏹ 已取消',
      interrupted: '⚠ 中断（可用 teamflow_resume 从断点重跑）',
    }[journal.status] || journal.status
    const stagesLine = stages.length === 0
      ? '尚未进入任何阶段'
      : `${stages.length} 个阶段 · ${done} 完成${failed > 0 ? ` · ${failed} 失败` : ''}${cancelledStages > 0 ? ` · ${cancelledStages} 取消` : ''}`
    const text = [
      `【团队研发流水线汇报】runId=${journal.id}`,
      `状态：${statusLine}${journal.error ? `（${clip(journal.error, 300)}）` : ''}`,
      `阶段：${stagesLine}`,
      `Agent：共启动 ${journal.agentsStarted || 0} 个子代理`,
      tokenLine,
      hasUsage && roleLine ? `Token（按角色）：${roleLine}` : '',
      journal.product ? `产品：${journal.product}` : '',
      (() => {
        const m = journal.options && journal.options.mode
        return (typeof m === 'string' && m !== 'full' && m !== 'medium')
          ? `模式：${MODE_REGISTRY[m as keyof typeof MODE_REGISTRY] ? MODE_REGISTRY[m as keyof typeof MODE_REGISTRY].label : m}`
          : ''
      })(),
      `backlog：需求 ${journal.reqId || '—'}（$DSH_HOME/teamflow/ 持久化）`,
      '用户可打开「🏭 团队工作台」tab 查看阶段泳道、拖拽看板与 token 明细。',
      '如需继续处理：可认领缺陷（teamflow_claim）、人工流转（teamflow_update）、断点重跑（teamflow_resume）。',
      '若用户在场请简明转述以上要点；若无人值守仅记录即可，不必长篇回复。',
    ].filter(Boolean).join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'plugin',
        plugin: 'dsh-plugin-teamflow',
        form: 'notice',
        summary: `团队研发流水线 ${journal.status === 'completed' ? '已完成' : journal.status}（runId=${journal.id}）`,
      },
    })
    if (parent.status === 'idle') parent.followup(message)
    else parent.inject(message)
  } catch (e) {
    console.warn('[teamflow] 完成汇报投递失败（忽略）', e?.message)
  }
}
