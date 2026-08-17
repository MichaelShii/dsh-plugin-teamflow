/**
 * dsh-plugin-teamflow — 常量与阶段映射（稳定底座，无依赖；被 util/core 引用）。
 */

/** 单阶段连续失败重试上限。 */
export const RETRY_LIMIT = 2
/** 单阶段 token 熔断预算（子代理会话上下文压力估算累计）。 */
export const STAGE_TOKEN_BUDGET = 60000
/** 假阳性完成检测：明确拒绝/放弃模式的输出视为未产出。 */
export const REFUSAL_PATTERN = /(无法完成|不能完成|无法继续|抱歉|对不起|我(无法|不能)|无法执行|cannot complete|unable to)/i
/** 各阶段最小产出长度（防"假完成"：空话/一句话冒充交付）。 */
export const STAGE_MIN_LENGTH = { prd: 400, design: 250, arch: 250, tech: 350, dev: 60, qa: 250, acceptance: 150 }
/** backlog 状态机（需求/任务/缺陷）。 */
export const STATUS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human', 'closed'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}
/** 成本观测阈值（计费当量）：超阈值仅记录 warn，不打断（观测线——覆盖 lite 规模，暴露后按实测调优）。 */
export const COST_BUDGET_TOKENS = 250000
/** 流水线阶段顺序与 key 映射（resume/pipeline 用）。 */
export const PHASE_ORDER = ['PRD 产品需求', 'UI/UX 设计', '架构规划', '技术方案', '开发', 'QA 测试', '产品验收']
export const PHASE_KEY_OF = { prd: 'PRD 产品需求', design: 'UI/UX 设计', scaffold: '架构规划', tech: '技术方案', dev: '开发', qa: 'QA 测试', acceptance: '产品验收' }
export const PHASE_KEY_BY_NAME = { 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' }
