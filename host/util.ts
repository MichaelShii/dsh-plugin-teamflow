/**
 * dsh-plugin-teamflow — 通用纯工具（底座；依赖 constants.ts，无其他依赖）。
 */
import { REFUSAL_PATTERN, STAGE_MIN_LENGTH, DELIVERY_EVIDENCE_PATTERN } from './constants.ts'
import { t } from './locales.ts'
import type { HostLocale } from './locales.ts'

export function toText(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}
export function clip(text, n) {
  const s = toText(text)
  return s.length > n ? s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]` : s
}
/** 干净截断（无「已截断」后缀、压平空白）：用于持久化展示字段——截断后缀会烙进数据，实体越存越脏。 */
export function snippet(text, n) {
  return String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim().slice(0, n)
}
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}

/** 从 dev/qaFix 回复中提取「验证证据」块（`[Verification evidence]` 行起，到 state 块/结尾止）。
 * dev 阶段无独立对抗校验（QA 有 QA-REPORT.md 结构化证据，dev 只有自述）——证据块是「可审计的
 * 具体自述」：命令+退出码+断言计数+失败行引用，可对照 logs/teamflow/<runId>/ 命令输出日志核实；
 * 模型仍可伪造，但具体细节难编造一致（具体性压力）且伪造可发现（审计轨迹）。
 * 找不到块（契约未兑现）→ null，host 记 warn 不中断（policy 级）。 */
export function extractVerificationEvidence(text) {
  const s = toText(text)
  const m = s.match(/\[Verification evidence\]([\s\S]*?)(?=<!--\s*state|$)/)
  if (!m || !m[1]) return null
  const ev = m[1].trim()
  return ev.length > 0 ? ev : null
}

/**
 * ADR-0008 任务夹命名：<yyyyMMdd>-r<N>[-<slug>]。
 * - date 用本地时区（用户在东八区晚上建的需求不能落到"明天"）
 * - reqId 形如 req-8 → 段 r8（防撞兜底：slug 缺失/非法时夹名退化为 <date>-r<N>）
 * - slug 由 triage 模型给出并经 host 校验（[a-z0-9-]{3,24}），此处再做一次防御性清洗
 */
export function runFolderName(date: Date, reqId: string, slug?: string | null): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const n = String(reqId || '').replace(/^req[-_]/i, 'r')
  const clean = String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const valid = /^[a-z0-9][a-z0-9-]{2,23}$/.test(clean) ? clean : ''
  return valid ? `${ymd}-${n}-${valid}` : `${ymd}-${n}`
}
/**
 * 产品名白名单归一化：只允许 [a-zA-Z0-9_-] 组成的路径段（可含 / 分隔）。
 * 拒绝：绝对路径、盘符、. / .. 段、空段、空白字符 —— 防止穿越 $DSH_HOME 写任意目录。
 * @returns {string|null} 归一化后的安全产品名，非法输入返回 null。
 */
export function normalizeRoot(v: unknown): string | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim().replace(/\\/g, '/')
  if (s.startsWith('/') || s.startsWith('.')) return null // 绝对路径、./、../、..
  if (/^[a-zA-Z]:/.test(s)) return null // 盘符（C:\x）
  if (s.includes('//') || s.includes('..')) return null // 空段、穿越段
  const segments = s.split('/')
  for (const seg of segments) {
    if (!/^[a-zA-Z0-9_-]+$/.test(seg)) return null // 每段仅字母数字下划线连字符
  }
  return segments.join('/')
}
export function normalizeTasks(tasks: unknown): Array<{ title: string; spec: string }> {
  if (!Array.isArray(tasks)) return []
  const out = []
  for (const t of tasks) {
    if (t === null || t === undefined) continue
    if (typeof t === 'string') {
      const s = t.trim()
      if (s) out.push({ title: s, spec: '' })
    } else if (typeof t === 'object') {
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null
      if (title) out.push({ title, spec: typeof t.spec === 'string' ? t.spec : '' })
    }
    if (out.length >= 8) break
  }
  return out
}
export function sanitizeSnapOptions(o) {
  const opts = (o && typeof o === 'object') ? o : {}
  return {
    needDesign: opts.needDesign === true,
    needScaffold: opts.needScaffold === true,
    lite: opts.lite === true,
    mode: (typeof opts.mode === 'string' && opts.mode) ? opts.mode : undefined,
    productRoot: typeof opts.productRoot === 'string' ? opts.productRoot : null,
    maxConcurrency: (Number.isFinite(opts.maxConcurrency) && opts.maxConcurrency > 0) ? Math.min(opts.maxConcurrency, 8) : null,
    tasks: Array.isArray(opts.tasks) ? opts.tasks.map((t) => ({ title: String((t && t.title) || ''), spec: String((t && t.spec) || '') })) : [],
  }
}
// 安全信号兜底：宿主（09-04+）在 subagents.start 内部调用 signal.throwIfAborted()——
// 缺该方法会「启动/执行失败：options?.signal?.throwIfAborted is not a function」（实锤 r1-json-tree-view
// 3 任务 3 轮 resume 全失败）。SAFE_SIGNAL 永不 abort（aborted 恒 false），空实现语义正确。
export const SAFE_SIGNAL = { aborted: false, addEventListener: () => {}, removeEventListener: () => {}, throwIfAborted: () => {} }
export function normalizeSignal(s) {
  // 真 AbortSignal 判定：须具备 throwIfAborted（宿主硬依赖）；伪 signal 一律降级 SAFE_SIGNAL
  return (s && typeof s === 'object' && typeof s.addEventListener === 'function' && typeof s.aborted === 'boolean' && typeof s.throwIfAborted === 'function') ? s : SAFE_SIGNAL
}

/**
 * 幂等合并 .gitignore 条目（纯函数，便于回归测试）。
 *
 * 场景（实锤 assetd `tf-mtwvwpxa-p3vw08`）：插件强制把命令日志/临时脚本写进 `logs/teamflow/`，
 * 目标仓库没忽略它时，收口提交的 227 个文件里 208 个是这批噪音（92%）——本函数负责「补规则」这一半，
 * 另一半（提交面强制排除）在 `sanity.tfAddArgs()`。
 * 2026-09-15（B 方案）后该目录只是 **run 期间的工作区暂存**（终态由 `core/runlogs` 归档到 `$DSH_HOME`
 * 并从项目删除）——两道防线保留，用于覆盖「run 进行中用户自己提交」的窗口。
 *
 * 覆盖判定不只看字面相等：已有 `logs/`、`logs/**` 这类**更宽的目录规则**同样算已忽略
 * （否则会往一个已经生效的仓库里塞冗余规则）。返回 `changed=false` 时调用方**不要写文件**。
 */
export function mergeGitignore(
  existing: string | null | undefined,
  entries: string[],
  locale: HostLocale = 'zh',
): { text: string; changed: boolean; added: string[] } {
  const src = existing === null || existing === undefined ? '' : String(existing)
  const lines = src.split(/\r?\n/).map((l) => l.trim())
  /** 归一：去首尾斜杠与尾部 glob（`logs/`、`logs/**` → `logs`）。 */
  const norm = (s: string) => s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/\*\*?$/, '')
  const coveredBy = (entry: string) => {
    const e = norm(entry)
    return lines.some((l) => {
      if (!l || l.startsWith('#')) return false
      const n = norm(l)
      return !!n && (n === e || e.startsWith(`${n}/`))
    })
  }
  const added = entries.filter((e) => e && !coveredBy(e))
  if (added.length === 0) return { text: src, changed: false, added: [] }
  const head = src ? `${src}${src.endsWith('\n') ? '' : '\n'}` : ''
  const block = `${src ? '\n' : ''}${t(locale, 'log.gitignoreHeader')}\n${added.join('\n')}\n`
  return { text: head + block, changed: true, added }
}

/** 分支 slug 派生（ADR-2026-08-27）：branchName > triageSlug > 需求中的英文标识词 > reqId 数字 > 'feature'。
 * 实锤 feat/feature：lite 显式时 triage 不跑（无 slug）+ 分支检查早于 reqId 生成 → fallback 'feature'。 */
export function deriveBranchSlug(requirement: string | null | undefined, reqId: string | null | undefined, triageSlug?: string | null, branchName?: string | null): string {
  if (branchName && /^[a-z0-9][a-z0-9-_]*$/i.test(branchName)) return String(branchName).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40)
  if (triageSlug && /^[a-z0-9-]{3,24}$/i.test(triageSlug)) return triageSlug
  const en = String(requirement || '').match(/[a-zA-Z][a-zA-Z0-9-]{2,23}/g)
  if (en && en.length) {
    // 排除档位词/虚词——否则「显式的用 patch 模式」会把档位词「patch」当成分支名（实锤 feat/patch）
    const NOISE = new Set(['patch', 'lite', 'tech', 'full', 'medium', 'mode', 'the', 'and', 'for', 'with', 'use', 'using'])
    const hit = en.find((w) => !NOISE.has(w.toLowerCase()))
    if (hit) return hit.toLowerCase().slice(0, 40)
  }
  const num = String(reqId || '').match(/\d+/)
  if (num) return `r${num[0]}`
  return 'feature'
}

/** 交付判定结论（judgeDeliverable）：`reason` 供失败分类/日志文案，`refusal` 供留痕与诊断包。 */
export interface DeliverableVerdict {
  ok: boolean
  reason: 'ok' | 'empty' | 'too-short' | 'refusal'
  /** 命中的拒绝措辞（含原文上下文）；`ok=true` 时也可能非空——措辞只作诊断，不再单独否决。 */
  refusal: { phrase: string; context: string } | null
  /** 本阶段长度下限与实际长度（诊断用）。 */
  min: number
  length: number
}

/**
 * 交付判定（信号分级；2026-09-11 信号换轨，原 `hasSubstance`）。
 *
 * 旧判据 = 非空 + **全文拒绝词** + 长度下限——把「措辞」当交付门禁。实锤 assetd
 * tf-mtwvwpxa-p3vw08 的 T5：子代理 `stopReason=completed`、41 次工具调用、证据块与
 * state 块齐全、`src/query.mjs` 已落盘，只因如实汇报「7 条 runCli 用例与 spec/verify.mjs
 * 全部 26 例无法执行（沙箱禁止子进程管道）」命中「无法执行」→ 判 insubstantial
 * 「视为未交付」→ 提测门禁停整条线 + 人工 resume（16 分钟 + 一轮重跑）。
 * 教训不是「词表少了一个词」，而是**措辞不能用来判定是否交付**：模型如实汇报环境限制
 * 是本分，换一种说法（跑不通/环境不允许/需在无限制 shell 复跑）旧判据照样误杀。
 *
 * 现判据按「客观优先、措辞退为兜底」分级：
 *  1. 客观形态：非空 + 达阶段长度下限（不读语义）；
 *  2. 真交付信号：含 `[Verification evidence]` 块 → 判交付（拒绝/放弃类产出给不出具体
 *     命令+退出码细节）；命中拒绝词只记诊断、不否决；
 *  3. 兜底：无证据块且命中拒绝词 → 判未交付（这才是「光说不做 / 自称做不到」的形态）。
 *
 * 因此「如实汇报环境限制」这类假阳性在**结构上**消失，而「没干活就说完成」仍被抓：
 * 无证据块的假交付照旧落到第 3 级或长度级。
 */
export function judgeDeliverable(phase: string, text: string | null | undefined): DeliverableVerdict {
  const s = toText(text)
  const min = STAGE_MIN_LENGTH[phase] ?? 100
  const length = s.trim().length
  if (length === 0) return { ok: false, reason: 'empty', refusal: null, min, length }
  if (length < min) return { ok: false, reason: 'too-short', refusal: null, min, length }
  const refusal = refusalHit(s)
  if (!refusal) return { ok: true, reason: 'ok', refusal: null, min, length }
  if (DELIVERY_EVIDENCE_PATTERN.test(s)) return { ok: true, reason: 'ok', refusal, min, length }
  return { ok: false, reason: 'refusal', refusal, min, length }
}

/* ── QA 轮次收敛的**埋点**（D 方案 2026-09-15：先测量，再决定要不要动状态机语义） ──────────
 * 背景：52 个历史 run 里「真正需要第 3 轮修复」从未发生，而「同一缺陷原样复现就早停」这条判据
 * **按缺陷 id 判不出来**——QA 每轮重新编号（实锤 r9：`QA-*` → `R2-*` → `R3-*`）。
 * 所以先记录**稳定身份**与逐轮集合，等攒到真实复验轮数据再决定是否把 `QA_REWORK_LIMIT` 换成收敛判据。
 * 身份优先级：**缺陷行自带的检测命令**（B 方案起 QA 必填，最稳定、机器写给机器看）> 模块+实际行为文本
 * （自由文本，跨轮容易被改写，只作兜底）> 缺陷 id（最不稳定，最后兜底）。
 */

/** 归一化：去 markdown 装饰、压平空白、小写（仅用于身份比较，不改原值）。 */
function fpNorm(s: unknown): string {
  return String(s === null || s === undefined ? '' : s).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 缺陷的**稳定身份**（跨轮次可比）：检测命令优先，其次 模块+实际/期望文本，最后回落 id。 */
export function defectFingerprint(d: { check?: string | null; module?: string | null; actual?: string | null; expected?: string | null; id?: string | null } | null | undefined): string {
  if (!d) return ''
  const cmd = fpNorm(d.check)
  if (cmd) return `cmd:${cmd}`.slice(0, 200)
  const mod = fpNorm(d.module)
  const body = fpNorm(d.actual || d.expected || '')
  if (mod || body) return `txt:${mod}|${body}`.slice(0, 200)
  return `id:${fpNorm(d.id)}`
}

/**
 * 与**历史轮次**对比本轮阻断集合（收敛判据的原始素材）。
 * @param prevFps - 之前每一轮的指纹数组（按时间顺序，不含本轮）
 * @param curFps - 本轮的指纹数组
 * @returns newFps = 历史从未出现过；repeats = 至少出现过一次（**修完还在 → 停滞信号**）；
 *          resolved = 上一轮出现过、本轮消失（消解数）。返回指纹列表（便于人工核对是哪几条）。
 */
export function compareDefectRounds(prevFps: string[][], curFps: string[]): { newFps: string[]; repeats: string[]; resolved: string[] } {
  const seen = new Set<string>()
  for (const round of prevFps || []) for (const fp of round || []) seen.add(fp)
  const last = (prevFps && prevFps.length ? prevFps[prevFps.length - 1] : []) || []
  const cur = new Set(curFps || [])
  return {
    newFps: (curFps || []).filter((fp) => !seen.has(fp)),
    repeats: (curFps || []).filter((fp) => seen.has(fp)),
    resolved: last.filter((fp) => !cur.has(fp)),
  }
}

/**
 * 组装一轮 QA 的埋点记录（D 方案 2026-09-15；纯函数，便于回归测试）。
 * @param round - 轮次（1 = 首轮）
 * @param seq - 该轮 QA stage 的 seq（审计定位；未知传 null）
 * @param defects - 本轮解析出的全部缺陷（含 P3）
 * @param prevRounds - 之前的埋点记录（用于算 新增/重复/消解）
 * @param qaCalls - 该轮 QA 的实际调用数（未知传 null）
 * @param limit - 当前复验上限（`outcome` 用）
 */
export function qaRoundEntry(
  round: number,
  seq: number | null,
  defects: Array<{ id?: string; severity?: string; module?: string; check?: string; criterion?: string; actual?: string; expected?: string }>,
  prevRounds: Array<Record<string, unknown>> | null | undefined,
  qaCalls: number | null,
  limit: number,
): Record<string, unknown> {
  const all = defects || []
  const blocking = all.filter((d) => d.severity !== 'P3')
  const fps = blocking.map((d) => defectFingerprint(d))
  const prevFps = (prevRounds || []).map((r) => (((r && r.defects) as Array<{ fp?: string }>) || []).map((d) => String((d && d.fp) || '')))
  const cmp = compareDefectRounds(prevFps, fps)
  return {
    round,
    seq,
    blocking: blocking.length,
    p3: all.length - blocking.length,
    defects: blocking.map((d, i) => ({ id: d.id, sev: d.severity, module: d.module || '', fp: fps[i] })),
    withCheck: blocking.filter((d) => String(d.check || '').trim()).length,
    withCriterion: blocking.filter((d) => String(d.criterion || '').trim()).length,
    qaCalls,
    fixCalls: null,
    gate: null,
    newFps: cmp.newFps.length,
    repeats: cmp.repeats.length,
    resolved: cmp.resolved.length,
    outcome: blocking.length === 0 ? 'pass' : round > limit ? 'limit' : 'rework',
  }
}

/** 不可重试的失败原因（上下文耗尽/超长/provider 客户端拒绝等——重试同一 prompt 大概率复现）。
 * 实锤 tf-mtcnejqj：opencode-go 400 invalid_request_error（tool 消息序列非法）被当作可重试 → 烧 1.98M 熔断。 */
export function isUnretryable(reason: unknown, outcome: unknown): boolean {
  const r = String(reason || outcome || '')
  return /context|limit|max-token|token|tool-error|400|invalid_request|INVALID_REQUEST/i.test(r)
}

/** 阶段产出 → 精简交接摘要（供审计/展示；产出含显式 <!-- handoff --> 块则优先取块内内容）。 */
export function handoffBrief(text: string | null | undefined): string {
  if (!text || !String(text).trim()) return ''
  const m = String(text).match(/<!--\s*handoff\s*-->([\s\S]*?)(?:<!--\s*\/handoff\s*-->|$)/)
  const brief = (m && m[1] ? m[1] : String(text)).trim()
  return clip(brief, 2000)
}

/** 拒绝词命中点：返回命中的具体短语 + 原文上下文片段（供重试诊断回灌，比事后从截断尾巴重算可靠）。 */
export function refusalHit(text: string | null | undefined): { phrase: string; context: string } | null {
  const s = String(text || '')
  const m = REFUSAL_PATTERN.exec(s)
  if (!m || m.index < 0) return null
  const start = Math.max(0, m.index - 40)
  const end = Math.min(s.length, m.index + String(m[0]).length + 40)
  return { phrase: m[0], context: s.slice(start, end).replace(/\s+/g, ' ').trim() }
}

/**
 * 外部供应商不可用 vs 内容性失败（2026-09-17，实测驱动）。
 *
 * 背景：dddd 那条 run 在第一轮 01:37 连续 6 个 dev 阶段 `stopReason=error` → 快速重试两次 → 转人工；
 * 而**16 分钟后（01:53）同样的请求就成功了**——即那批失败是「供应商在一段时间窗内不可用」（限流/无额度/
 * 上游 5xx/超时），**与阶段内容无关**。旧行为把它当内容失败：快速失败、落 `failed + human`、让人误以为
 * 交付有问题。现在按错误文本分类（⚠️ **启发式**：宿主只给 `stopReason=error` + 错误文本，没有结构化错误码，
 * 故命中原文必须记日志以便日后核对）：
 *  - `external`：限流/额度/余额/上游不可用/超时/过载 → 走**长退避重试**；用尽仍失败 → 落可续跑中断态；
 *  - `content`：上下文耗尽/护栏/产出无效等 → 维持现状（不自动重试或按既有策略）；
 *  - `unknown`：未命中任何词 → 维持现状（按内容类处置，宁严勿松）。
 * `hint` 为可选的 outcome/summary 文本，一并参与匹配（错误细节可能在 stage.summary 里）。
 */
export function classifyExternalFailure(text: string | null | undefined, hint?: string | null): 'external' | 'content' | 'unknown' {
  const s = `${String(text || '')} ${String(hint || '')}`
  if (!s.trim()) return 'unknown'
  const external = /(?:\b429\b|\b402\b|rate[ _-]?limit|too many requests|insufficient[ _-]?(?:balance|quota|funds)|quota|exceeded[ _-]?(?:your[ _-]?)?(?:quota|limit|rate)|no[ _-]?(?:available[ _-]?)?(?:quota|balance|credit)|out of credit|billing|payment required|overload|temporarily unavailable|service unavailable|\b50[234]\b|upstream|gateway timeout|\b52[0-9]\b|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network error|限流|限速|频率限制|请求过于频繁|额度|配额|余额不足|欠费|无额度|暂时不可用|服务不可用|上游不可用|超时|网络错误|连接被重置|过载|供应商)/i.test(s)
  if (external) return 'external'
  const content = /context[ _-]?(?:window|length)|too many tokens|maximum context|prompt is too long|上下文(?:长度|超限|耗尽)|护栏|degenerated|stalled|insufficient output|too short|产出过短/i.test(s)
  if (content) return 'content'
  return 'unknown'
}

/** 外部故障退避序列（毫秒）：30s → 60s → 120s → 240s（总等待上限 ≈ 7.5 分钟）。
 * 取值依据：dddd 实测窗口 ≈16 分钟（01:37 挂 → 01:53 恢复），故退避要能跨过几分钟的短窗口，
 * 又不至于让一条 run 无限期挂着（用尽后落**可续跑中断态**，窗口恢复后 resume 只补这一段）。 */
export const EXTERNAL_BACKOFF_MS = [30000, 60000, 120000, 240000]

/** 取第 n 次外部故障退避时长（n 从 1 起；超出序列 → null 表示退避用尽）。 */
export function externalBackoffMs(n: number): number | null {
  return EXTERNAL_BACKOFF_MS[n - 1] ?? null
}

/** 重试诊断包：上一轮失败详情回灌进重试 prompt（盲试 → 带因重试）。
 * 失败分类/详情/护栏原因取自 stage；产出尾部截断 1000 字符供自查修正。
 * `locale` 为**尾参可选**（缺省/`zh` → 现状中文**逐字不变**；`en` → 新增英文文案，AC-3④）。
 * 文案自带 zh/en 两份而不经 `host/locales/pipeline.ts`：该词典的 `diag.*` 归流水线面（T2），
 * 冻结键表列出的 `retryHeader/outcome/guardReason/detail/tail/end` 尚未落地——若在此强行查词典，
 * 缺 key 会回落成 key 字面量污染喂回子代理的注入文本；故本函数不引入对词典的强依赖。 */
export function buildRetryDiagnostic(
  attempt: number,
  stage: { outcome?: string | null; summary?: string | null; guardReason?: string | null; output?: string | null },
  locale?: HostLocale | null,
): string {
  const en = locale === 'en'
  const lines: string[] = []
  lines.push(en
    ? `[Retry diagnostic · attempt ${attempt}] The previous attempt did not succeed. This is not a new task — read the failure details below first, then perform the original task while fixing the previous attempt's problems.`
    : `[重试诊断 · 第 ${attempt} 次尝试] 上一轮尝试未成功。这不是新任务——请先阅读以下失败详情，再执行原任务并修正上一轮的问题。`)
  lines.push(en ? `- Failure class: ${stage.outcome || 'unknown'}` : `- 失败分类：${stage.outcome || 'unknown'}`)
  if (stage.guardReason) lines.push(en ? `- Guard abort reason: ${stage.guardReason}` : `- 护栏中止原因：${stage.guardReason}`)
  if (stage.summary) lines.push(en ? `- Details: ${stage.summary}` : `- 详情：${stage.summary}`)
  const out = String(stage.output || '')
  if (out) {
    const tail = out.length > 1000 ? `…${out.slice(-1000)}` : out
    lines.push(en
      ? `- End of the previous output (excerpt, for self-correction):\n${tail}`
      : `- 上一轮产出末尾（节选，供自查修正）：\n${tail}`)
  }
  return `\n\n${lines.join('\n')}\n${en ? '[/Retry diagnostic end]' : '[/重试诊断结束]'}`
}

/**
 * 验收结论解析：只以显式「验收结论 / 整体结论」行为准（acceptancePrompt 强制 4 档固定话术），
 * 不做正文散文朴素子串匹配。历史误报实锤（run tf-msytlok5）：验收报告 ✅ 通过，其记忆回写段一句
 * 「SUMMARY.md 结构无需改动」（= 结构无需变更）被旧正则「无需改动」子串命中 → 误判 reject →
 * 整条流水线置 failed。reject 词在正文里常以否定/引用/对照形式出现，故：
 *  - 「📝 需求不适用」是验收负责人专用的强结论词，允许全文命中；
 *  - 其余 reject 词（需求与实际不符/站不住/无效/无需改动等）仅在结论行且该行不含「通过/✅/⚠️」时才算；
 *  - rework 词仅认结论行（且不与「✅ 通过」同现）。
 * 反向护栏（漏报实锤 2026-09-03）：模型写「❌ 不通过」但漏写「验收结论：」前缀 → accLine 为空 →
 * 旧实现落回默认 accepted（最乐观默认值，质量门禁漏报=假交付）。现改为 **找不到结论行 → needs-human**
 * （宁严勿松：误拦截=人工看一眼，误放行=假交付；📝 全文命中与架构红词仍优先于该默认）。
 * ⚠️ 结论行取值（2026-09-17 实测 bug，`tf-mu4bve7t-duux2k`）：旧实现 `find(第一个含「验收结论」的行)` 会被
 * **章节标题**蒙住 —— 真实产物里 `## 1. 验收结论摘要`（含"验收结论"四字）排在真正的结论行
 * `验收结论：✅ 通过` 之前 → 抓到标题行 → 四档词全落空 → **明明通过却判 needs-human**。
 * 现规则：**优先取字面量模板行**（行首 `验收结论：` / `Acceptance verdict:` / `Overall verdict:`，
 * 允许 `## ` 前缀与列表符），且取**最后一个**（报告末尾的"结论"章才是终判）；仍找不到时，回退到
 * **最后一个非标题、含结论词的行**（避免"只写 ❌ 不通过、漏写前缀"的漏报变体）。
 * @param {unknown} text 验收报告全文
 * @returns {'accepted'|'rework'|'reject'|'needs-human'}
 */
export function parseAcceptanceVerdict(text) {
  const acc = String(text || '')
  const lines = acc.split('\n')
  // ① 字面量模板行（**唯一**结论行来源）：`## 验收结论：✅ 通过` / `- 验收结论：通过` /
  //    `Acceptance verdict: ✅ Pass`。只允许 `##`/列表符前缀 + 冒号连写；`**验收结论：**` 这类
  //    加粗破坏连写的**不认**（宁严勿松：不知道结论就 needs-human，不猜）。
  //    有多个时取**最后一个**（报告末尾的“结论”章才是终判，前面可能是“摘要/小结”章节）。
  const literal = /^\s*(?:#{1,6}\s*|[-*+]\s*)?(?:验收结论|整体结论|Acceptance verdict|Overall verdict)\s*[:：]/i
  const literalHits = lines.filter((l) => literal.test(l))
  const accLine = literalHits.length ? literalHits[literalHits.length - 1].replace(/\|.*/, '').trim() : ''
  // M3 架构门禁：明确的架构打回信号 → rework（无论结论行写没写「通过」）。
  // 修正误杀（tf-mt1pulkw）：验收正文「架构一致性核验 — PASS，无返工项」被朴素正则
  // 当成打回信号 → 误判 rework。现在改为「独立断言词 + 否定保护」：
  //   打回信号 = 出现明确的架构缺陷断言词（重复实现/偏离蓝图/该拆未拆… 或 架构…返工/打回/需重构），
  //             且未被否定保护（无返工/非漂移/M3 PASS/架构一致性良好/无该抽象未抽象…）覆盖时。
  const hasArchRedFlag =
    /重复实现|重复适配|偏离蓝图|未按蓝图|该拆未拆|该抽象未抽象|破坏既有结构|结构性.*问题|架构(打回|需重构)|需.*返工|返工.*项.*(存在|仍)|仍.*(返工|重构)/.test(acc)
  const archNegated =
    /无返工|无.*返工|不返工|无架构打回|无.*打回|非漂移|无.*重复|无.*偏离|无.*抽象.*问题|无.*蓝图.*问题|架构一致性.*(PASS|良好|达标|通过|无问题)|M3.*(PASS|通过|达标)|架构.*(达标|无问题|良好)/.test(acc)
  if (hasArchRedFlag && !archNegated) return 'rework'
  // 「📝 需求不适用」= 验收负责人专用强结论词，**但只认"行首为结论"的写法**（2026-09-17 实测修 bug
  // `tf-mu4i779p-kze5kl`）：真实报告会在标题/正文里**引用并论证它不适用**——「### 5.3 为什么不判
  // 「📝 需求不适用」」+「dev 结果并非「无需改动」」——旧的全文匹配据此把一份 `⚠️ 有条件通过` 的报告
  // 判成 reject（run 落 failed + 需人工）。现改为**行首锚定**：剥掉 markdown/列表/表格前缀与结论标签后
  // 该行必须**以 📝 + 需求不适用 开头**才算（`## 📝 需求不适用` / `验收结论：📝 需求不适用` /
  // `| 📝 需求不适用 | … |` 都算；`5.3 为什么不判「📝 …」` 不算）。
  const naLead = acc.split('\n').map((l) => String(l)
    .replace(/^[\s#*\-+>|]+/, '')
    .replace(/^(?:验收结论|整体结论|结论|判定|Acceptance verdict|Overall verdict|Conclusion|Verdict)\s*[:：]\s*/i, ''))
  if (naLead.some((l) => /^📝\s*(?:需求不适用|Not applicable|N\/A)/i.test(l))) return 'reject'
  // 结论行显式否定 → rework；✅ 通过同现时通过词优先；双重否定保护（无不通过/未发现不通过=通过）
  // en 新增（AC-6）：`fail/failed/not pass/not passed` 进否定词表；**明确不把裸 `rework` 当否定词**
  // ——en 模板 `⚠️ Conditional pass (rework items listed)` 含 `rework`，混入即误判打回。
  // `no failed/no failures` 与中文否定保护同效；通过词用负向先行断言排除 `not passed` 里的 `passed`。
  if (
    /不通过|需返工|未通过|\b(?:fail|failed|not pass|not passed)\b/i.test(accLine) &&
    !/无\s*不通过|未发现不通过|未出现不通过|no failed|no failures/i.test(accLine)
  ) {
    if (/✅\s*通过|(?<!not\s)\bpass(?:ed)?\b|⚠️\s*conditional\s+pass/i.test(accLine)) return 'accepted'
    return 'rework'
  }
  if (!/通过|✅|⚠️/.test(accLine) && /需求不适用|需求与实际不符|需求站不住|需求无效|无需改动|无需修改|not applicable|requirement (?:does not|invalid)/i.test(accLine)) return 'reject'
  if (!accLine) return 'needs-human'
  // 结论行存在但未命中任何四档词（空结论行「验收结论：」/待定/无结论）→ 不猜结论（漏报变体：
  // 旧实现只对「无结论行」→ needs-human，前缀残留的空行因 accLine 非空漏回 accepted）
  // en 新增档位词（`Pass`/`Fail`/`Not applicable`，AC-6）：无 emoji 的英文结论行不得漏成 needs-human。
  // 单独成行而**不改写**下面的中文四档白名单——`test/smoke.js` 对该行做源码断言（改之即红）。
  if (!/通过|✅|⚠️|❌|📝/.test(accLine) && /\bpass(?:ed)?\b|\bfail(?:ed)?\b|not applicable/i.test(accLine)) return 'accepted'
  if (!/通过|✅|⚠️|❌|📝/.test(accLine)) return 'needs-human'
  return 'accepted'
}

/** 架构蓝图（M1/M2）：tech/architect 阶段的产物契约，host 解析注入 dev。 */
export interface BlueprintModule {
  responsibility: string
  dependsOn?: string[]
  assemblyOrder?: number
  why?: string
}
export interface BlueprintTask {
  title: string
  files?: string[]
  spec?: string
}
export interface Blueprint {
  summary: string
  modules?: Record<string, BlueprintModule>
  duplications?: string[]
  tasks?: BlueprintTask[]
  /** 人读渲染文本（注入 dev/QA 用的简版） */
  render: string
}

const bdOpen = '<!-- blueprint -->'
const bdClose = '<!-- /blueprint -->'

/**
 * 从 tech/architect 产出中提取架构蓝图 JSON 块。
 * 约定：产出内嵌 `<!-- blueprint -->{...json...}<!-- /blueprint -->`。
 * 解析失败返回 null（不影响主流程）。
 */
/**
 * 抢救「顶层值提前闭合」类畸形蓝图 JSON。
 * 实锤（run tf-mt85o5jj）：模型在 duplications 数组后多写一个 `}`，根对象提前闭合，
 * 后续 `,"tasks":[…]` 被判为 JSON 外内容 → 整块解析失败 → 开发任务回退单任务「整体开发」，并行度丢失。
 * 修复策略：定位 parse 报错位置；若 head 是完整对象（以 } 收尾）且 tail 是 `,"key":` 续写形态，
 * 删掉 head 末尾那个提前闭合的根括号后拼接重试（最多 3 轮）。
 */
function repairBlueprintJson(raw: string): string | null {
  let cur = raw
  for (let round = 0; round < 3; round++) {
    let err: unknown = null
    try { JSON.parse(cur); return cur } catch (e) { err = e }
    const m = String(((err as Error) && (err as Error).message) || '').match(/position (\d+)/)
    if (!m) return null
    const pos = Number(m[1])
    const head = cur.slice(0, pos)
    const tail = cur.slice(pos)
    if (!/^\s*,?\s*"/.test(tail)) return null
    if (!/\}\s*$/.test(head)) return null
    cur = head.replace(/\}\s*$/, '') + tail.replace(/^\s*,\s*/, ',')
  }
  return null
}

export function extractBlueprint(text: string | null | undefined, locale?: HostLocale | null): Blueprint | null {
  const s = String(text || '')
  const i = s.indexOf(bdOpen)
  const j = s.indexOf(bdClose)
  if (i === -1 || j === -1 || j <= i) return null
  const raw = s.slice(i + bdOpen.length, j).trim()
  let parsed: { summary?: string; modules?: Record<string, BlueprintModule>; duplications?: string[]; tasks?: BlueprintTask[] } | null = null
  try { parsed = JSON.parse(raw) } catch (e) {
    const repaired = repairBlueprintJson(raw)
    if (repaired) { try { parsed = JSON.parse(repaired) } catch (e2) { parsed = null } }
  }
  if (!parsed || typeof parsed !== 'object') return null
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const modules = parsed.modules || {}
  const duplications = Array.isArray(parsed.duplications) ? parsed.duplications : []
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  // render 包裹标签按 locale 输出（缺省/zh → 现状中文逐字不变；en → 新增英文）。
  // 与 buildRetryDiagnostic 同理：冻结键表未给 blueprint.* 键名，故文案自带于此，避免缺 key 回落成 key 字面量。
  const en = locale === 'en'
  const parts: string[] = []
  if (summary) parts.push(en ? `Architecture judgment: ${summary}` : `架构判断：${summary}`)
  const modEntries = Object.entries(modules)
  if (modEntries.length) {
    parts.push(en
      ? `Module blueprint: ${modEntries.map(([f, m]) => `${f}→${m.responsibility || ''}${m.why ? ` (${m.why})` : ''}`).join('; ')}`
      : `模块蓝图：${modEntries.map(([f, m]) => `${f}→${m.responsibility || ''}${m.why ? `（${m.why}）` : ''}`).join('；')}`)
  }
  if (duplications.length) parts.push(en ? `Duplication risks: ${duplications.join('; ')}` : `重复风险：${duplications.join('；')}`)
  if (tasks.length) parts.push(en ? `Decomposed tasks: ${tasks.map((t) => t.title).join(', ')}` : `架构拆解任务：${tasks.map((t) => t.title).join('，')}`)
  const head = en
    ? '[Architecture blueprint (produced by the tech stage; implement on the existing architecture, do not rebuild)]'
    : '【架构蓝图（tech 阶段产出，dev 须在既有架构上实现，勿重建）】'
  return { summary, modules, duplications, tasks, render: `${head}\n${parts.join('\n')}` }
}

/**
 * 并发池：按 max 个 worker 消费 items，返回**同序**结果。
 *
 * `shouldStop`（可选）：取下一个任务**之前**判定，返回 true 即停止取新任务（已在飞的照常等它收尾），
 * 未取到的条目结果保持 `undefined`——**调用方必须容忍空位**（现有调用点一律 `r && …` 过滤）。
 *
 * 为什么要有它（2026-09-16 用户实测）：取消后被 dispose 的任务返回 null，worker 拿到结果会立刻
 * `cursor++` 取下一个任务并启动新子代理——用户按了「中断」，界面上却又冒出一个「开发中」
 * （取消变成了队列补位）。放在 util（无宿主私有依赖）而非 runner，是为了让行为级测试能直接喂 items 断言。
 */
export async function runPool(items, max, fn, shouldStop?: (() => boolean) | null) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, max), items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop && shouldStop()) return
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 从产物文本里摘出「假设 / 待澄清」小节（2026-09-16 需求澄清闸门 Phase 1）。
 *
 * **行式解析而不是单条正则**——实测踩过两个坑（本批真 bug，实锤 run tf-mu34afd2-wcjaw1）：
 *  ① 产物标题常带编号/附录前缀（`## 9. 假设与待澄清`；本仓 PRD 惯例就是编号标题），
 *     `^#{1,6}\s*(假设|…)` 这类写法直接匹配不到 → 明明写了段落却误报「契约未兑现」；
 *  ② 正文用 `([\s\S]*?)(?=\n#{1,6}|\s*$)` 懒匹配时，`\s*$` 分支会在标题后立刻命中 → 摘出空串。
 * 规则：命中标题后一直取到下一个标题；`trim()` 后为空视为未记录（返回 null）。
 */
export function extractAssumptionsSection(doc: string | null | undefined): string | null {
  const text = String(doc || '')
  if (!text.trim()) return null
  const lines = text.split(/\r?\n/)
  const head = /^#{1,6}\s*(?:[0-9]+[.、)]\s*)?(?:附录\s*[0-9A-Za-z]*[.、)]?\s*)?(假设|待澄清|开放问题|assumptions|open questions?)/i
  const isHead = (l: string) => /^#{1,6}\s/.test(l)
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue
    const out: string[] = []
    for (let k = i + 1; k < lines.length; k++) {
      if (isHead(lines[k])) break
      out.push(lines[k])
    }
    const body = out.join('\n').trim()
    return body || null
  }
  return null
}
