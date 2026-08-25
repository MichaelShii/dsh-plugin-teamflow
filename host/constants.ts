/**
 * dsh-plugin-teamflow — 常量与阶段映射（稳定底座，无依赖；被 util/core 引用）。
 */

/** 单阶段连续失败重试上限。 */
export const RETRY_LIMIT = 2
/** QA→开发→复验 打回闭环的最大轮数（QA 发现缺陷 → 打回开发修复 → 复验；超过则需人工介入，防无限循环）。 */
export const QA_REWORK_LIMIT = 2
/** 单阶段 token 熔断预算（官方口径总消耗：input+cacheRead+cacheWrite+output 累计）。 */
export const STAGE_TOKEN_BUDGET = 60000
/* ── 子代理单调用护栏（进行中退化检测；纯进度信号，无时间配额——慢吞吐的合法任务不受影响）── */
/** 护栏轮询间隔 ms。 */
export const GUARD_POLL_MS = 15000
/** 复读判定：滑动窗口内同一规范化流式片段出现次数上限（正常 agent 措辞有变化，几乎不可能逐字重复）。 */
export const GUARD_REPEAT_LIMIT = 12
/** 复读检测滑动窗口大小（条）。 */
export const GUARD_WINDOW_SIZE = 400
/** 挂死判定：连续这么久没有任何新会话事件（provider 挂起/静默死亡）→ stalled（走预算门转人工）。 */
export const GUARD_SILENCE_MS = 10 * 60_000
/** 空转判定：会话仍在产出事件但连续这么久没有任何工具调用（纯推理打转/改写式循环）→ stalled。要求已见过至少一次工具调用。 */
export const GUARD_NO_TOOL_MS = 15 * 60_000
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
/** 流水线阶段顺序与 key 映射（resume/pipeline 用）。 */
export const PHASE_ORDER = ['PRD 产品需求', 'UI/UX 设计', '架构规划', '技术方案', '开发', 'QA 测试', '产品验收']
export const PHASE_KEY_OF = { prd: 'PRD 产品需求', design: 'UI/UX 设计', scaffold: '架构规划', tech: '技术方案', dev: '开发', qa: 'QA 测试', acceptance: '产品验收' }
export const PHASE_KEY_BY_NAME = { 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' }

/**
 * 档位→阶段集策略表（ADR-0004「阶段集差异执行」的单一事实来源）。
 * 每个档位声明执行顺序的阶段规则；`when` 为条件阶段（满足才含入）。
 * ⚠ 设计要点：design/scaffold 在所有档位都按**显式 flag**（needDesign/needScaffold）条件化，
 * 显式请求永不被档位吞掉（v0.8.1「lite 不再吞显式设计」原则的泛化）。
 * 档位之间的真正差异由 pipeline 的 prompt 形态承担：PRD 形态（prd/techChange/patchConfirm）、
 * tech 文档形态（isHeavy/architect 蓝图）、patch 无独立 QA。
 * - patch：无独立 QA（单点修复，开发自测兜底）；显式 needDesign/needScaffold 仍有效。
 * - full 的 PM 前置评估、medium 强制设计为后续待办（见 AGENTS §6），非本表范围。
 */
export type StageKey = 'prd' | 'design' | 'scaffold' | 'tech' | 'dev' | 'qa' | 'acceptance'
export type StageMode = 'full' | 'medium' | 'lite' | 'tech' | 'patch'
export interface StagePolicyOpts {
  needDesign?: boolean
  needScaffold?: boolean
}
export interface StageRule {
  key: StageKey
  /** 条件阶段：满足才含入执行集；缺省为恒含。 */
  when?: (o: StagePolicyOpts) => boolean
}
export const STAGE_POLICY: Record<StageMode, StageRule[]> = {
  full: [
    { key: 'prd' },
    { key: 'design', when: (o) => !!o.needDesign },
    { key: 'scaffold', when: (o) => !!o.needScaffold },
    { key: 'tech' },
    { key: 'dev' },
    { key: 'qa' },
    { key: 'acceptance' },
  ],
  medium: [
    { key: 'prd' },
    { key: 'design', when: (o) => !!o.needDesign },
    { key: 'scaffold', when: (o) => !!o.needScaffold },
    { key: 'tech' },
    { key: 'dev' },
    { key: 'qa' },
    { key: 'acceptance' },
  ],
  lite: [
    { key: 'prd' },
    { key: 'design', when: (o) => !!o.needDesign },
    { key: 'scaffold', when: (o) => !!o.needScaffold },
    { key: 'tech' },
    { key: 'dev' },
    { key: 'qa' },
    { key: 'acceptance' },
  ],
  tech: [
    { key: 'prd' },
    { key: 'design', when: (o) => !!o.needDesign },
    { key: 'scaffold', when: (o) => !!o.needScaffold },
    { key: 'tech' },
    { key: 'dev' },
    { key: 'qa' },
    { key: 'acceptance' },
  ],
  patch: [
    { key: 'prd' },
    { key: 'design', when: (o) => !!o.needDesign },
    { key: 'scaffold', when: (o) => !!o.needScaffold },
    { key: 'tech' },
    { key: 'dev' },
    { key: 'acceptance' },
  ],
}

/** 按档位 + 条件展开实际执行阶段集（纯函数；未知档回退 full）。 */
export function resolveStages(mode: StageMode | string | null | undefined, opts: StagePolicyOpts = {}): StageKey[] {
  const rules = STAGE_POLICY[(mode || 'full') as StageMode] || STAGE_POLICY.full
  return rules.filter((r) => !r.when || r.when(opts)).map((r) => r.key)
}
