/**
 * dsh-plugin-teamflow — 常量与阶段映射（稳定底座，无依赖；被 util/core 引用）。
 */

/** 单阶段连续失败重试上限。 */
export const RETRY_LIMIT = 2
/** QA→开发→复验 打回闭环的最大轮数（QA 发现缺陷 → 打回开发修复 → 复验；超过则需人工介入，防无限循环）。 */
export const QA_REWORK_LIMIT = 2
/**
 * 单次 withRetry 调用的**新增** token 熔断预算（2026-09-11 口径修正）。
 *
 * 口径 = `freshTokensOf`（input + cacheWrite + output），**排除 cacheRead**：
 * 缓存命中是上下文复用的廉价重放，把它计入「烧钱」会得出荒谬结论——实锤 assetd
 * tf-mtwvwpxa-p3vw08 的 T5：熔断日志报「累计 token 1886k 超出阶段预算 60k」，
 * 而其中 1830k 是 cacheRead，真实新增只有 55k。旧口径的后果不是数字难看，而是
 * **任何 dev 任务只要失败一次就必然熔断**（正常 dev 单次新增实测 45–80k，而缓存命中
 * 恒在 1M 量级）→ RETRY_LIMIT=2 形同虚设，一次失败直接转人工停线。
 *
 * 量级依据（实测单次尝试新增 token）：T5 55.4k / T8 49.3k / T9 79.6k / T11 45.9k
 * → 200k ≈ 允许 RETRY_LIMIT 的两轮尝试各留余量，只在该量级的 3 倍以上（真跑飞）才熔断。
 */
export const FRESH_TOKEN_BUDGET = 200000
/** 任务夹产物展示顺序（ADR-0008）：工作台只列其中**真实存在**的文件，按此顺序出「一键右侧栏预览」按钮。 */
export const TEAMFLOW_ARTIFACT_ORDER = ['PRD.md', 'DESIGN.md', 'TECHNICAL.md', 'QA-REPORT.md', 'ACCEPTANCE.md', 'meta.json']

/**
 * TeamFlow 自有日志：**工作区内暂存目录**（B 方案 2026-09-15）。
 *
 * 为什么还留在工作区：子代理受 DSH 文件沙箱约束——`workspace-write` 只允许写会话工作区
 * 与平台临时区，写 `$DSH_HOME` 直接 `FS_SANDBOX_DENIED`（实测：子代理写 `C:\Users\<u>\.dsh\...`
 * 三步全拒，写工作区内同构命令 exit 0）。所以命令日志只能在项目内暂存。
 * **终态不在这里**：run 结束 host 把本目录归档到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/`
 * 并删除项目内副本（见 `host/core/runlogs.ts`）——项目里不留存，超额归档按最近 K 次淘汰。
 * 与 store.runLogStagingDir 的路径段必须一致（test/runlogs.test.js 守门）。
 */
export const TF_LOG_DIR = 'logs/teamflow'
/** 归档保留的最近 run 数（每个 run 一个目录；超出按 mtime 淘汰，防 $DSH_HOME 无界增长）。 */
export const LOG_ARCHIVE_KEEP = 20

/**
 * 修复轮的「类别门禁」证据标记（A 方案，2026-09-15）：qaFixPrompt 要求 P0–P2 修复在证据块里给出
 * `gate:`（新增/更新的门禁命令 → exit 0（修复前 exit <code> / <n> hits））与 `class sweep:`（命中数 before→after）。
 *
 * 为什么只 warn 不硬失败：host **无法证明**门禁真的存在（门禁长什么样、跑没跑过都在子代理侧），
 * 硬失败会退化成「必须写这几个字」的形式主义；warn 留痕让「这一轮没落门禁」在 journal/工作台可见即可。
 * 实锤动机：r9 的 round-1 只修了看得见的实例，同类 4 处留在 prompts/index.ts → QA round-2 原样打回，白烧一整轮。
 */
export const FIX_GATE_PATTERN = /(^|\n)\s*[-*]?\s*(gate|门禁)\s*[:：]/i

/**
 * 机械型阶段的推理强度降档值（2026-09-11）：只用在**明确的机械阶段**（patch 档的单点确认、
 * scaffold 脚手架落地），其余阶段不传 = 宿主默认 `high`。
 *
 * 为什么值得降：DeepSeek 路由把推理 token **计入 output**，且推理内容**每个带推理回合原样回传**
 * ——高推理同时抬高 output 与后续每一步 input（见 `llm-deepseek/README`）。
 * 安全前提：只有宿主 `llm.resolveModelInfo()` 声明该路由支持该档位才下发——传不支持的值会被
 * 宿主以 `UNSUPPORTED_REASONING_EFFORT` **硬失败且不降级**（runner 会先探测再传）。
 * 重试自动回升 `high`（质量优先，ADR-0006）。
 */
export const MECHANICAL_STAGE_EFFORT = 'low'
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
/**
 * **环境不可用**判定（2026-09-23 probe-v4 实锤）：同一工具**以完全相同错误**持续失败的次数。
 * 实锤：`pwsh` 因 Windows 沙箱 ACL provision 失败（`SetNamedSecurityInfoW failed (Win32 5)`）每次同样报错，
 * 架构师重试 7 次 + 90k 字符推理后撞 max-tokens 被截断 —— 白烧 52.6k 输出，且汇报把真因写成 `max-tokens`。
 * 命令工具不可用是**环境故障**：重试、换命令、用推理代替执行都修不好它，必须在烧钱之前停下并说清原因。
 */
export const GUARD_TOOL_FAIL_WARN = 2
/** 同一工具相同失败的**中止**阈值（达到即 dispose；outcome='env-unavailable'，不自动重试）。
 * 取 3 而非更大的值：**实测模型第 2 次就以「按策略停止重试」放弃 shell、改用文件工具绕道**
 * （probe-v4 第二次实机：它手写 13 个文件 / 69.8k 输出，其中一个 18.7KB 自测脚本从没跑过），
 * 所以提醒要早于它放弃（2 次），中止也要在它绕道成规模之前（3 次）。 */
export const GUARD_TOOL_FAIL_ABORT = 3
/**
 * 拒绝/放弃措辞词表（诊断信号 + 兜底判据，**不再是唯一的交付门禁**）。
 *
 * 2026-09-11 信号换轨：旧实现把它当交付门禁全文扫描，实锤 assetd tf-mtwvwpxa-p3vw08 的 T5
 * ——子代理 `stopReason=completed`、41 次工具调用、证据块与 state 块齐全、代码已落盘，
 * 只因**如实汇报环境限制**（「7 条 runCli 用例与 spec/verify.mjs 全部 26 例无法执行」）
 * 命中「无法执行」→ 判 insubstantial「视为未交付」→ 提测门禁停线 + 人工 resume。
 * 模型汇报环境限制是本分，不是拒绝——措辞不能当交付判据。
 * 现用法见 `judgeDeliverable`：仅在**无验证证据块**时才作为否决依据；命中即回传供留痕。
 */
export const REFUSAL_PATTERN = /(无法完成|不能完成|无法继续|抱歉|对不起|我(无法|不能)|无法执行|cannot complete|unable to|I cannot|I can['’]t|not able to)/i
/**
 * 真交付信号（结构件，非措辞）：prompt 强制的 `[Verification evidence]` 块——「命令 + 退出码 +
 * 断言计数」的具体自述。拒绝/放弃类产出给不出具体命令细节，故它出现即判交付，与措辞无关。
 * 这是「防假完成（光说不做）」的客观判据，取代此前对散文措辞的依赖。
 */
export const DELIVERY_EVIDENCE_PATTERN = /\[Verification evidence\]/i
/** 各阶段最小产出长度（防"假完成"：空话/一句话冒充交付）。 */
export const STAGE_MIN_LENGTH = { prd: 400, design: 250, scaffold: 250, arch: 250, tech: 350, dev: 60, qa: 250, acceptance: 150 }
/** backlog 状态机（需求/任务/缺陷）。 */
export const STATUS = {
  req: ['created', 'in-progress', 'pending-acceptance', 'accepted', 'needs-human', 'closed'],
  task: ['pending', 'running', 'testable', 'testing', 'pending-acceptance', 'accepted', 'rework', 'needs-human', 'cancelled'],
  bug: ['open', 'claimed', 'fixed', 'verified', 'reopened', 'needs-human'],
}
/**
 * 流水线阶段（2026-09-06 英文化改造）：内部一律英文键（journal.stage.phase / 代码判断 / 状态机）。
 * 中文阶段名只作为展示 label（client UI 映射，未来 i18n 与 dsh 中英对齐）。
 */
export const PHASE_ORDER = ['prd', 'design', 'scaffold', 'tech', 'dev', 'qa', 'acceptance']
/** 英文键 → 中文展示名（仅 UI/label/日志文案使用，不得用于代码判断）。 */
export const PHASE_KEY_OF: Record<StageKey, string> = { prd: 'PRD 产品需求', design: 'UI/UX 设计', scaffold: '架构规划', tech: '技术方案', dev: '开发', qa: 'QA 测试', acceptance: '产品验收' }
/** 中文阶段名 → 英文键（存量 journal/backlog 兼容映射；迁移脚本执行后仅防御性保留）。 */
export const PHASE_KEY_BY_NAME: Record<string, StageKey> = { 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' }
/** phase 归一：中文（存量）或英文（新数据）输入 → 英文键；未知回退原值小写化。 */
export function phaseKeyOf(phase: unknown): string {
  const p = String(phase || '')
  if (!p) return ''
  if (PHASE_KEY_BY_NAME[p]) return PHASE_KEY_BY_NAME[p]
  return p
}

/**
 * 角色键单一事实来源（byRole token 分段 / stateSliceFor 切片 / noteTaskAssign 写入共用）。
 * 对应 PHASE_ORDER 各阶段；'design'/'arch' 为条件阶段（needDesign/needScaffold），无对应阶段则不累计。
 */
export const ROLE_KEYS = ['pm', 'design', 'arch', 'tech', 'dev', 'qa', 'acceptance'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]
/** 阶段英文键 → 角色键（任务卡 byRole 累计用；未知阶段归 'other'）。 */
export const PHASE_ROLE: Record<string, RoleKey> = {
  prd: 'pm',
  design: 'design',
  scaffold: 'arch',
  tech: 'tech',
  dev: 'dev',
  qa: 'qa',
  acceptance: 'acceptance',
}

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
    { key: 'dev' },
  ],
}

/** 按档位 + 条件展开实际执行阶段集（纯函数；未知档回退 full）。 */
export function resolveStages(mode: StageMode | string | null | undefined, opts: StagePolicyOpts = {}): StageKey[] {
  const rules = STAGE_POLICY[(mode || 'full') as StageMode] || STAGE_POLICY.full
  return rules.filter((r) => !r.when || r.when(opts)).map((r) => r.key)
}
