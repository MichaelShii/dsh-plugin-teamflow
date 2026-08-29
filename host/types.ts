/**
 * dsh-plugin-teamflow — host 公共类型（strip-types 可剥离：无 enum/namespace/装饰器）。
 * 依赖方向：本文件可 import '../store.ts' 的类型；严禁被下层（util/constants）反向依赖。
 */
import type { JournalRecord, JournalStage } from '../store.ts'

/** 流水线运行日志（运行时对象，含 result 等非持久化字段）。 */
export interface Journal extends JournalRecord {
  result?: { requirement?: string; options?: unknown; timeline?: Record<string, unknown> } | null
  stages: JournalStage[]
  logs: Array<{ t: number; level: string; message: string }>
}
/** backlog 记录（需求/任务/缺陷通用形状）。 */
export interface BacklogItem {
  id: string
  status: string
  title?: string
  humanIntervention?: boolean
  retries?: number
  severity?: string
  owner?: string | null
  summary?: string | null
  events?: Array<{ at: number; by: string; from: string | null; to: string; reason: string }>
  /** 自由 JSON 记录（req/task/bug 异构字段，如 taskIds/bugIds/createdAt/updatedAt…）：放宽以承载运营字段。 */
  [key: string]: any
}
/** 需求分诊路由模式（ADR-0004：full/medium/lite/tech/patch）。 */
export type PipelineMode = 'full' | 'medium' | 'lite' | 'tech' | 'patch'
/** 流水线启动选项。 */
export interface PipelineOptions {
  needDesign?: boolean
  needScaffold?: boolean
  tasks?: unknown
  productRoot?: string | null
  maxConcurrency?: number
  /** lite：微功能轻量模式——跳过独立技术方案文档阶段，PRD 即契约，QA/验收保留；needDesign=true 时保留 UI/UX 设计。 */
  lite?: boolean
  /** 需求分诊路由（ADR-0004）；缺省由 triage 自动判定。 */
  mode?: PipelineMode
  /** 团队 id：指定走哪个团队的流水线（从 teams.json 读取阶段配置）。 */
  teamId?: string
  /** 分支策略（ADR-2026-08-27 基调：启动前用户决策）：'auto'（默认）——建特性分支 feat/<branchName|slug>（从当前 HEAD 派生）；'keep'——沿用当前分支不建。需要决策的场景由 teamflow_start 返回 needs-decision，用户选择后带本参数重发。 */
  branchPolicy?: 'auto' | 'keep'
  /** 自定义分支名（branchPolicy=auto 时生效；缺省用 triage slug；仅 [a-z0-9-_]，host 校验）。 */
  branchName?: string | null
  /** 脏工作区的启动前处理（配合 needs-decision 选择）：'stash'（推荐，改动暂存，完成后 git stash pop）；'commit'（提交现有改动，commitMessage 缺省用默认信息）；缺省不处理（改动混入开发）。 */
  preAction?: 'stash' | 'commit' | null
  /** preAction=commit 时的提交信息。 */
  commitMessage?: string | null
}
/** 断点续跑上下文。 */
export interface ResumeContext {
  phase: string
  products: Record<string, unknown>
}
/** 子代理运行句柄的鸭子类型（避免强依赖内部类型）。 */
export interface SubagentRunLike {
  id: string
  result: Promise<unknown>
  dispose(): Promise<void> | void
  localAgent?: { session?: unknown }
  /** 观测→执行闭环：token 护栏注入轻提醒（不打断，下一轮 step 可见）。 */
  inject?: (m: unknown) => void
}
/** 父 Agent 句柄的鸭子类型（deliverCompletion / runAgent 共用）。 */
export interface ParentAgentLike {
  inject?: (m: unknown) => void
  followup?: (m: unknown) => void
  status?: string
  session?: { append?: Function }
}
/** 单子代理真实 LLM usage 桶（来自会话 assistant/message 事件的 provider usage）。 */
export interface UsageBuckets {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  calls: number
}
