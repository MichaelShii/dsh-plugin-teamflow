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

/**
 * **声明本插件自己的 message source kind**（2026-09-23 补：v4 source 适配的类型面，此前只改了字面量）。
 *
 * 宿主 `MessageSource` 是**声明合并的可扩展联合**——`packages/llm/llm/src/message.ts:103-115` 原文：
 * "Merge-extensible sum type — each producer declares its own `kind` in its own module; there is no
 * shared catch-all `plugin` kind"。会话格式 v4 同样要求 producer-owned kind
 * （`plugin:<name>`；退役的 `{ kind: 'plugin', plugin }` wrapper 会被 `assertV4MessageSources` 拒绝）。
 *
 * 所以按宿主约定在这里注册我们的 kind（而不是在调用点写裸字面量）：
 * v4 修复当时只改了 `createUserMessage` 的 source 字面量、没登记类型 → tsc 报
 * 「'"plugin:dsh-plugin-teamflow"' is not assignable to ...」而 **bundle 不做类型检查**，
 * 于是这个错误一路留到本轮跑 typecheck 才暴露（AGENTS.md：改 type 后必跑 typecheck）。
 * `form` 按宿主 `ContextFormed` 判别式给足字段：`notice` 必须带一行 `summary`。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-plugin-teamflow':
      | { readonly kind: 'plugin:dsh-plugin-teamflow'; readonly form?: never }
      | { readonly kind: 'plugin:dsh-plugin-teamflow'; readonly form: 'instructions' }
      | { readonly kind: 'plugin:dsh-plugin-teamflow'; readonly form: 'notice'; readonly summary: string }
  }
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
  /** 脏工作区的启动前处理（配合 needs-decision 选择）：'stash'（推荐，改动暂存，完成后 git stash pop）；'commit'（提交现有改动，commitMessage 缺省用默认信息）；'init'（2026-09-17 改动存档：非 git 工作区用户选"开启存档" → git init +（目录不大时）基线提交，执行期二次校验危险路径/大目录）；'keep-nogit'（用户明确选"不用版本控制" → gitMode='none'，出口不尝试提交）；缺省不处理（改动混入开发）。 */
  preAction?: 'stash' | 'commit' | 'init' | 'keep-nogit' | null
  /** preAction=commit 时的提交信息。 */
  commitMessage?: string | null
  /** 需求澄清答复（2026-09-16 需求澄清闸门）：用户在澄清轮补充的说明——与原始 requirement 分开存，
   *  PRD prompt 会作为 `[CLARIFIED]` 权威输入下发（不污染「用户原话」的忠实转写）。 */
  requirementSupplement?: string | null
  /** 内部：tool 侧预检透传的分诊裁决（避免 pipeline 重复跑一次模型分诊；快照已由 sanitizeSnapOptions 过滤）。 */
  __triage?: unknown
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
