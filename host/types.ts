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

/**
 * **澄清策略变体**（ADR-0011 ③；2026-10-08 收窄为**对照实验开关**）。
 *
 * 历史：它曾是 `PipelineOptions` 的独立字段（`off`/`once`/`interview`），并在 ADR-0011 里
 * **刻意不做成 `PipelineMode` 的一档**——`PipelineMode` 决定阶段集 / PRD 形态 / 架构护栏
 * （`resolveStages` / `MODE_RANK` / `guardrailUpgrade` 三处按它分派），把「追问几次」塞进去会让
 * 同一张表承担两件正交的事，并把 `interview` 变成「没有对应阶段集」的伪档位。**该论证仍成立。**
 *
 * ⚠️ **2026-10-08 字段本身被删掉**，理由与论证无关：它**从来没影响过流水线**，只选 `tool.ctx.team`
 * 中间那段文案；而 ctx 只在**选团队时**注入 ⇒ 作为 run 参数结构上「迟一拍」（反查历史 run 还带来
 * 「重启丢失」）。用户指出切口应是**手册本身** ⇒ 默认行为写进 ctx（`once` 的文案保留为对照组），
 * 这个 union 只剩 `TEAMFLOW_CLARIFY` 的取值域，不再是 pipeline 选项。
 */
export type ClarifyStrength = 'off' | 'once' | 'interview'
/**
 * **PRD 确认单的触发档**（ADR-0011 ①；2026-10-08 由显式 `needConfirm` 开关改为内容驱动）。
 *
 * - `auto`（缺省）—— **判据是内容**：PRD 的 `openQuestions` 里存在 `kind: "taste"`（主观品味项）
 *   ⇒ 暂停等用户拍板；只有信息缺口（`fact`）或没有待澄清项 ⇒ 直通不打断。
 *   为什么两类要分开：信息缺口的代价由 `default` 兜住，品味项猜错的代价是「成品不是我要的」
 *   ——后者表现为流失/差评、**不表现为 QA 打回**（用户 2026-10-08 定调）；而纯信息缺口也打断用户
 *   会白毁 §1 的无人值守卖点。
 * - `always` / `never` —— **只是 A/B 对照与端到端验证的内部强制位**。
 *
 * ⚠️ **不是工具参数**：由环境变量 `TEAMFLOW_CONFIRM` 传入（`always` / `never`，其余/未设 = `auto`）。
 * 2026-10-08 之前它是公开参数 `needConfirm`，被用户当场否掉：「用户又不知道这参数」——
 * 而工具描述里也没有任何「何时该设它」的触发条件 ⇒ 实践中没人设 ⇒ 功能是死的。
 * `patch` 档恒不生效（STAGE_POLICY：单 agent 直改，PRD 是机械的单点确认）。
 */
export type ConfirmMode = 'auto' | 'always' | 'never'
/** 流水线启动选项。 */
export interface PipelineOptions {
  needDesign?: boolean
  needScaffold?: boolean
  /** **PRD 确认单**（ADR-0011 ①）：触发档见 `ConfirmMode`（缺省 `auto` = 有主观品味项才停）。
   *  环境变量通道，不进工具 schema。 */
  confirmMode?: ConfirmMode
  tasks?: unknown
  productRoot?: string | null
  maxConcurrency?: number
  /** lite：微功能轻量模式——跳过独立技术方案文档阶段，PRD 即契约，QA/验收保留；needDesign=true 时保留 UI/UX 设计。 */
  lite?: boolean
  /** 需求分诊路由（ADR-0004）；缺省由 triage 自动判定。 */
  mode?: PipelineMode
  /** 团队 id：指定走哪个团队的流水线（从 teams.json 读取阶段配置）。 */
  teamId?: string
  /** craft 引导通道（2026-09-30 立）：**缺省 true**；显式 `false` 关闭三处「引导/观察」条款——
   *  design 视觉规格（2b）/ dev craft bar（4b）/ QA craft 观察评级（0d）。三者都不是硬门禁，
   *  故关闭后丢失的只是质感引导，主机强制的正确性契约一条不少（用于 ±craft 的 A/B 对照实验）。
   *  ⚠ **不是工具参数**：由环境变量 `TEAMFLOW_CRAFT=0` 传入（见 `util.envFlagOn`）——
   *  工具 description 每次都进主会话上下文，而这个开关大概率是临时物，不值得常驻。 */
  craft?: boolean
  /** 分支策略（ADR-2026-08-27 基调：启动前用户决策）：
   *  - 'auto'（默认）——建特性分支 feat/<branchName|slug>（从当前 HEAD 派生）；
   *  - 'keep'——沿用当前分支不建。
   *  需要决策的场景由 teamflow_start 返回 needs-decision，用户选择后带本参数重发。 */
  branchPolicy?: 'auto' | 'keep'
  /** 自定义分支名（branchPolicy=auto 时生效；缺省用 triage slug；仅 [a-z0-9-_]，host 校验）。 */
  branchName?: string | null
  /** 脏工作区的启动前处理（配合 needs-decision 选择）：
   *  - 'stash'（推荐，改动暂存，完成后 git stash pop）；
   *  - 'commit'（提交现有改动，commitMessage 缺省用默认信息）；
   *  - 'init'（2026-09-17 改动存档：非 git 工作区用户选「开启存档」 → git init +（目录不大时）基线提交，
   *    执行期二次校验危险路径/大目录）；
   *  - 'keep-nogit'（用户明确选「不用版本控制」 → gitMode='none'，出口不尝试提交）；
   *  缺省不处理（改动混入开发）。 */
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
  /** **回退重跑 PRD**（2026-10-08）：检查点被主动拨回 `prd`（`resumeRun` 在「PRD 之后没跑过任何阶段」
   *  且带 supplement 时这么做，见 `resume.phase==='prd'`）。用来给 PRD 换一段**语义不同**的补录块：
   *  澄清轮是「用户答了我问的问题」，而这次是「用户要求改这些地方」（见 `pipeline.ts` 的 prdInput 拼装）。 */
  redo?: boolean
}
/** 运行中的本地子代理活 Agent 的鸭子类型（`runtime.agents` 注册表返回）。
 *  `status` 是宿主唯一的生命周期态（`'idle' | 'running'`，见 `packages/core/agent/src/runtime-types.ts`）。
 *  ⚠️ 这里**没有** `phase` —— 宿主从未提供该字段，护栏曾按 `localAgent.phase.kind` 判忙，恒 false 静默失效（2026-10-15 修正）。 */
export interface LocalChildAgentLike {
  session?: unknown
  status?: string
  /** 观测→执行闭环：token 护栏注入轻提醒（不打断，下一轮 step 可见）。 */
  inject?: (m: unknown) => void
}

/** 子代理运行句柄的鸭子类型（避免强依赖内部类型）。 */
export interface SubagentRunLike {
  id: string
  result: Promise<unknown>
  dispose(): Promise<void> | void
  /** 本地子级（进程内）的活 Agent；外部/远程 provider 为 undefined（这个「本地 vs 远程」对照就是它叫
   *  localAgent 而不是 agent 的原因）。**alpha.2 起不再由 `start()` 回执返回** —— 改由 `agents`
   *  注册表按 childId 解析（见 `context.liveChildAgentOf`）。 */
  localAgent?: LocalChildAgentLike
}

/** `subagents.startActivation` 的入参/出参鸭子类型。
 *  ⚠️ **宿主 API 迁移锚点（2026-10-15 / issue #20）**：alpha.1 的 `subagents.start(name, request)`
 *  在 alpha.2 被整体删除（提交 `3d852a1cea`，首个含它的 tag = `dsh-v0.2.1-alpha.2`），取而代之的是
 *  单一入口 `startActivation(spec)`：`provider`/`label`/`signal`/`delivery` 提到 spec 顶层，`label` 变必填，
 *  且**不再回传 `localAgent`**。官方迁移指南：`docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/`。 */
export interface SubagentActivationLike {
  childId: string
  /** Accepted inbox message id（本地子级必有；本插件不用——等待的是 `result`）。 */
  messageId?: string
  result: Promise<{ output?: unknown; stopReason?: string }>
  dispose(): Promise<void> | void
}

export interface SubagentStarters {
  startActivation?: (spec: {
    provider: string
    label: string
    request: { prompt: unknown; parent: unknown; agentOptions?: unknown; signal: unknown }
    signal: unknown
    /** `'caller'`＝只把结果交给调用方，**不向父会话投递完成通知**。本插件自己编排流水线，
     *  必须用 `'caller'`：`'parent'` 会把每个阶段的完成通知塞进主会话（污染主线程且非本插件语义）。 */
    delivery: 'parent' | 'caller'
  }) => Promise<SubagentActivationLike>
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
