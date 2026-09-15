/**
 * dsh-plugin-teamflow core — 需求分诊路由（ADR-0004）。
 * - MODE_REGISTRY：5 档流水线策略表（full/medium/lite/tech/patch），各档声明阶段集/PRD 形态/护栏。
 * - suggestMode：正则预筛（给模型参考信号 + 模型不可用时的兜底）。
 * - runTriage：**模型驱动分诊**——spawn 分诊分析师子代理思考一轮，产出结构化裁决（mode/性质/UI/复杂度/理由）。
 */
import type { PipelineMode, PipelineOptions } from '../types.ts'
import { extractText } from '../util.ts'
import { runtime, providerName } from './context.ts'
import { TRIAGE_PROMPT } from '../prompts/index.ts'
import { t, type HostLocale } from '../locales.ts'

/** 各档流水线规格（策略表条目）。 */
export interface ModeSpec {
  key: PipelineMode
  label: string
  /** PRD 形态：full=完整 PRD；confirm=确认型（不重写文档）；tech-change=技术变更单（无功能 AC）。 */
  prdForm: 'full' | 'confirm' | 'tech-change'
  /** 是否默认开 UI/UX 设计阶段（UI 需求触发）。 */
  needDesignDefault: boolean
  /** 是否保留独立 QA agent（patch 档可折叠为开发自测）。 */
  independentQA: boolean
  /** 走文档化技术方案阶段与否。 */
  techDoc: boolean
  /** 一句话适用场景。 */
  desc: string
}

export const PIPELINE_MODES: PipelineMode[] = ['full', 'medium', 'lite', 'tech', 'patch']

export const MODE_REGISTRY: Record<PipelineMode, ModeSpec> = {
  full: { key: 'full', label: 'full（完整）', prdForm: 'full', needDesignDefault: true, independentQA: true, techDoc: true, desc: '跨模块大需求 / 新功能重：完整 7 段 + PM 前置评估' },
  medium: { key: 'medium', label: 'medium（标准）', prdForm: 'full', needDesignDefault: true, independentQA: true, techDoc: true, desc: '含 UI 的中等功能：PRD+设计+技术方案+开发+QA+验收' },
  lite: { key: 'lite', label: 'lite（轻量）', prdForm: 'confirm', needDesignDefault: false, independentQA: true, techDoc: false, desc: '单模块小功能/微增强：PRD(确认型)+轻量架构蓝图+开发+QA+验收（needDesign 时含 UI/UX 设计）' },
  tech: { key: 'tech', label: 'tech（改造）', prdForm: 'tech-change', needDesignDefault: false, independentQA: true, techDoc: false, desc: '技术驱动改造/优化/重构/热修：技术变更单+轻量架构蓝图+开发+QA+验收（回归加强）' },
  patch: { key: 'patch', label: 'patch（热修）', prdForm: 'confirm', needDesignDefault: false, independentQA: false, techDoc: false, desc: '单行/常量/版本号/hotfix：单 agent 直改+自测即交付（无独立 QA）' },
}

/** 确定性护栏关键词（双语，仅 fallback 兜底用；主路由是模型——TRIAGE_PROMPT 语义判断）。
 * 架构信号：持久化/存储/独立模块/抽象/跨模块——防「轻档位局部实现塌方」（M1 架构护栏）。
 * UI 信号：UI 相关需求不得落 patch/tech（无设计/QA 的档位）——最低 lite。
 * ⚠️ en 词必须**语义强**：泛技术名词（module/api/plugin/cache/queue 等）在中文需求里以英文术语形式
 * 偶发出现（「用 cache 优化加载」「plugin 系统拆分 module」），命中即把 full 拉成 medium —— 属档位漂移
 * （QA-4：AC-7/AC-9「既有中文样本档位逐一不变」）。故只保留多词/强语义项（standalone module /
 * cross-module / abstraction / refactor / migration / schema 等）。
 * 【R2-3 收口】单字泛词（refactor/schema/form/dependency…）即使语义强，夹在中文句里仍是弱信号 ——
 * 故新增英文项分表存放，**只对无 CJK 的英文需求生效**：中文/中英混排需求只走存量词表（= HEAD 原文，
 * 含中文词与 HEAD 英文词），档位与 HEAD 逐字等价（AC-9）；英文需求（无 CJK）才叠加新增表（AC-7）。 */
/** 存量词表（= HEAD 原文；改一项即中文档位漂移，AC-9 禁止）。 */
const ARCH_SIGNALS = ['持久化', '存储', '保存', '恢复', '存档', '独立模块', '抽象', '存储层', 'localStorage', 'sessionStorage', 'IndexedDB', '跨模块', '数据层', 'persistence', 'storage', 'database', '数据库', 'standalone module', 'abstraction']
/** 本需求新增英文项（AC-7）：仅对无 CJK 的英文需求生效（见上）。 */
const ARCH_SIGNALS_EN = ['refactor', 'optimize', 'optimisation', 'optimization', 'dependency', 'dependencies', 'schema', 'migrate', 'migration', 'cross-module', 'module']
/** 存量词表（= HEAD 原文；同上）。 */
const UI_SIGNALS = ['界面', 'UI', '视觉', '页面', '按钮', '样式', '交互', '布局', '组件', 'page', 'button', 'style', 'layout', 'component', 'visual', 'interaction']
/** 本需求新增英文项（AC-7）：仅对无 CJK 的英文需求生效（见上）。 */
const UI_SIGNALS_EN = ['pages', 'screen', 'form', 'styles', 'components', 'responsive']
/** 需求文本含 CJK → 不叠加新增英文词表（AC-9：中文样本档位与 HEAD 逐一一致）。 */
const CJK_IN_REQ = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/** 对原始需求做启发式分诊（兜底路径专用）。返回建议 mode + 判定理由 + 置信。
 * 只做确定性护栏（架构强升/UI 禁轻档/needDesign 升档）——不再逐词匹配五档信号：
 * 主路由是模型（TRIAGE_PROMPT 语义判断，天然双语），正则兜底在模型不可用时宁重勿漏（默认 full）。 */
export function suggestMode(requirement: string, opts?: { needDesign?: boolean; tasks?: unknown }, locale: HostLocale = 'zh'): { mode: PipelineMode; kind: string; rationale: string[]; confidence: 'high' | 'medium' | 'low' } {
  const text = String(requirement || '')
  const rationale: string[] = []
  let mode: PipelineMode = 'full' // 默认完整（护栏优先，宁重勿漏）

  const archHit = (CJK_IN_REQ.test(text) ? ARCH_SIGNALS : ARCH_SIGNALS.concat(ARCH_SIGNALS_EN)).find((w) => text.includes(w))
  if (archHit) {
    mode = 'medium'
    rationale.push(t(locale, 'triage.arch', { word: archHit }))
  }
  const uiHit = !archHit ? (CJK_IN_REQ.test(text) ? UI_SIGNALS : UI_SIGNALS.concat(UI_SIGNALS_EN)).find((w) => text.includes(w)) : undefined
  if (uiHit) {
    mode = mode === 'full' ? 'lite' : mode // UI 信号最低 lite（不得落 patch/tech）
    rationale.push(t(locale, 'triage.ui', { word: uiHit }))
  }
  if (opts && opts.needDesign && mode !== 'medium') {
    mode = 'medium'
    rationale.push(t(locale, 'triage.needDesign'))
  }
  if (rationale.length === 0) rationale.push(t(locale, 'triage.noSignal'))
  const kind = mode === 'medium' ? t(locale, 'triage.kind.medium') : mode === 'lite' ? t(locale, 'triage.kind.lite') : t(locale, 'triage.kind.full')
  const confidence: 'high' | 'medium' | 'low' = mode === 'medium' && !opts?.needDesign ? 'medium' : 'low'
  return { mode, kind, rationale, confidence }
}

/** 规范化 mode 入参：合法则返回，非法返回 null。 */
export function normalizeMode(v: unknown): PipelineMode | null {
  if (typeof v !== 'string') return null
  if (PIPELINE_MODES.indexOf(v as PipelineMode) !== -1) return v as PipelineMode
  return null
}

/** 由 mode 推导执行选项（needDesign/lite 映射；供 start 前归一）。 */
export function modeToOptions(mode: PipelineMode, provided?: PipelineOptions): { needDesign: boolean; lite: boolean; techDoc: boolean; independentQA: boolean; mode: PipelineMode } {
  const spec = MODE_REGISTRY[mode]
  const wantDesign = spec.needDesignDefault && !!(provided && provided.productRoot) || !!(provided && provided.needDesign)
  return {
    needDesign: wantDesign,
    lite: mode === 'lite' || mode === 'tech' || mode === 'patch',
    techDoc: spec.techDoc && !provided?.lite,
    independentQA: spec.independentQA,
    mode,
  }
}

/** 分诊裁决（模型驱动或正则兜底后的统一形态）。 */
export interface TriageVerdict {
  mode: PipelineMode
  kind: string
  needDesign: boolean
  complexity: 'small' | 'medium' | 'large'
  rationale: string[]
  confidence: 'high' | 'medium' | 'low'
  /** ADR-0008 任务夹主题词（短横线小写英文，3-24 字符；模型未给/非法为空）。 */
  slug: string
  source: 'model' | 'fallback'
  /** 需求意图（2026-09-16 需求澄清闸门 Phase 1）：明确需求 / 仍在探索 / 对现状的反馈。 */
  intent: TriageIntent
  /** 动工前 must-know 缺口（**已过 host 合格线**；空数组=没有合格缺口）。 */
  blockers: TriageBlocker[]
  /** 被合格线丢弃的条数（诊断：>0 说明 triage 提了不合格问题 → 记 warn）。 */
  blockersDropped: number
}

/** 需求意图。 */
export type TriageIntent = 'requirement' | 'exploration' | 'feedback'

/** 动工前 must-know 缺口（三条证据齐全才成立，见 qualifyBlockers）。 */
export interface TriageBlocker {
  /** 要问用户的那一句。 */
  question: string
  /** ≥2 个具体且互斥的读法（缺它就不值得打断用户）。 */
  readings: string[]
  /** 用户怎么答会改变哪个产物 / AC / 范围。 */
  changes: string
  /** 猜错会返工什么（哪个阶段 / 哪份产物重来）。 */
  rework: string
}

export const TRIAGE_INTENTS: TriageIntent[] = ['requirement', 'exploration', 'feedback']

/** 意图归一：非法/缺失一律 `requirement`（**绝不因为模型没给字段就拦启动**）。 */
export const normalizeIntent = (raw: unknown): TriageIntent =>
  (TRIAGE_INTENTS.indexOf(raw as TriageIntent) !== -1 ? (raw as TriageIntent) : 'requirement')

/**
 * **host 侧合格线**（防仪式化：prompt 只是请求，这里才是判定）。
 * 三条证据必须齐全：① ≥2 个互斥读法 ② 改变哪个产物/AC/范围 ③ 猜错返工什么。
 * 缺一即丢弃并计数——模型几乎总能为任何需求凑出"问题"，不合格线就会退化成每次都打断。
 * 上限 3 条（超过的部分按丢弃计）。
 */
export function qualifyBlockers(raw: unknown): { blockers: TriageBlocker[]; dropped: number } {
  const arr = Array.isArray(raw) ? raw : []
  const good: TriageBlocker[] = []
  let dropped = 0
  for (const b of arr) {
    const o = (b && typeof b === 'object') ? b as Record<string, unknown> : null
    const question = String((o && o.question) || '').trim()
    const readings = Array.isArray(o && o.readings)
      ? (o.readings as unknown[]).map((x) => String(x === null || x === undefined ? '' : x).trim()).filter(Boolean)
      : []
    const changes = String((o && o.changes) || '').trim()
    const rework = String((o && o.rework) || '').trim()
    if (question && readings.length >= 2 && changes && rework) {
      good.push({
        question: question.slice(0, 300),
        readings: readings.slice(0, 4).map((r) => r.slice(0, 200)),
        changes: changes.slice(0, 300),
        rework: rework.slice(0, 300),
      })
    } else dropped++
  }
  const kept = good.slice(0, 3)
  return { blockers: kept, dropped: dropped + Math.max(0, good.length - kept.length) }
}

/** 解析模型 JSON 输出（容错：定位首个 {...} 块；字段缺失/非法回退 null）。 */
function parseVerdictText(text: string): TriageVerdict | null {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const raw = JSON.parse(m[0])
    const mode = normalizeMode(raw.mode)
    if (!mode) return null
    const qb = qualifyBlockers(raw.blockers)
    return {
      mode,
      kind: typeof raw.kind === 'string' ? raw.kind : '',
      needDesign: raw.needDesign === true,
      complexity: ['small', 'medium', 'large'].indexOf(raw.complexity) !== -1 ? raw.complexity : 'medium',
      rationale: Array.isArray(raw.rationale) ? raw.rationale.map(String).slice(0, 6) : [],
      confidence: ['high', 'medium', 'low'].indexOf(raw.confidence) !== -1 ? raw.confidence : 'medium',
      slug: /^[a-z0-9][a-z0-9-]{2,23}$/.test(String(raw.slug || '')) ? String(raw.slug) : '',
      source: 'model',
      intent: normalizeIntent(raw.intent),
      blockers: qb.blockers,
      blockersDropped: qb.dropped,
    }
  } catch (e) { return null }
}

/** 兜底：正则预筛 → fallback verdict（模型分诊不可用/超时/解析失败时）。 */
function fallbackVerdict(requirement: string, opts?: { needDesign?: boolean }, locale: HostLocale = 'zh'): TriageVerdict {
  const pre = suggestMode(requirement, opts, locale)
  return {
    mode: pre.mode, kind: pre.kind, needDesign: !!(opts && opts.needDesign), complexity: 'medium',
    rationale: [...pre.rationale, t(locale, 'triage.fallback')], confidence: pre.confidence, slug: '', source: 'fallback',
    // 兜底路径**永不拦启动**（intent 默认 requirement、无 blocker）——分诊不可用时退回现状行为，零回归。
    intent: 'requirement', blockers: [], blockersDropped: 0,
  }
}

/** 模型驱动分诊：spawn「分诊分析师」子代理思考一轮；子代理不可用/超时/解析失败 → 正则兜底。
 * 解析失败先带纠错提示重试一次（实锤 run tf-mtfo8exi：模型输出「Let me output the JSON.」开场白
 * 后无 JSON——首轮输出预算被思考耗尽/模型停早；重试提示直接输出 JSON 对象本身）。 */
export async function runTriage(
  requirement: string,
  opts?: { needDesign?: boolean },
  parent?: unknown,
  signal?: unknown,
  locale: HostLocale = 'zh',
): Promise<TriageVerdict> {
  const subagents = runtime.subagents as { start?: (provider: string, init: unknown) => Promise<{ result: Promise<{ output?: unknown; stopReason?: string }>; dispose?: () => Promise<void> | void }> } | undefined
  if (!subagents || typeof subagents.start !== 'function') return fallbackVerdict(requirement, opts, locale)
  const pre = suggestMode(requirement, opts, locale)
  for (let attempt = 1; attempt <= 2; attempt++) {
    let run: { result: Promise<{ output?: unknown; stopReason?: string }>; dispose?: () => Promise<void> | void } | null = null
    try {
      const hint = attempt > 1
        ? 'Your previous reply contained only a preface (e.g. "Let me output the JSON.") with NO JSON object — that is a failed reply. Reply now with the JSON object ITSELF as the first and only content, starting with {.'
        : ''
      run = await subagents.start(providerName() as string, {
        label: t(locale, 'triage.label'),
        prompt: [{ type: 'text', text: TRIAGE_PROMPT(requirement, opts, pre, hint, locale) }],
        parent,
        signal,
      })
      const result = await Promise.race([
        run.result,
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(t(locale, 'err.triageTimeout'))), 90000)),
      ]) as { output?: unknown; stopReason?: string }
      const parsed = parseVerdictText(extractText(result && result.output))
      if (parsed) return parsed
    } catch (e) {
      if (attempt === 2) { /* 超时/失败 → 走兜底 */ }
    } finally {
      if (run && run.dispose) { try { await run.dispose() } catch (e) { /* ignore */ } }
    }
  }
  return fallbackVerdict(requirement, opts, locale)
}
