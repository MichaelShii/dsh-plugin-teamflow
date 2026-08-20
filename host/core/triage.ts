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

/** 关键词信号集（命中 → 加重某档倾向）。 */
const SIGNALS: Array<{ mode: 'patch' | 'tech' | 'lite' | 'medium' | 'full'; words: string[] }> = [
  { mode: 'patch', words: ['hotfix', '热修', '修复 bug', '修 bug', '改个 bug', '版本号', '常量', '一行', 'bump', '回滚', '卫生', '笔误', '拼写'] },
  { mode: 'tech', words: ['重构', '优化', '升级', '架构', '性能', '依赖', '脚手架', '缓存', '清理', '遗留债', '工程', '内部改造', '技术债'] },
  { mode: 'lite', words: ['微功能', '小功能', '小增强', '加个', '补一个', '轻微', '顺手'] },
  { mode: 'medium', words: ['界面', 'UI', '视觉', '页面', '按钮', '样式', '交互', '布局', '组件', '持久化', 'localStorage', '本地存储', '存储', '保存', '恢复', '存档', '独立模块', '抽象', '存储层', 'sessionStorage', 'IndexedDB', '跨模块', '数据层'] },
  { mode: 'full', words: ['跨模块', '完整', '大型', '对接', '集成', '模块化', '重构为', '二期', '平台'] },
]

/** 对原始需求做启发式分诊。返回建议 mode + 判定理由 + 置信。 */
export function suggestMode(requirement: string, opts?: { needDesign?: boolean; tasks?: unknown }): { mode: PipelineMode; kind: string; rationale: string[]; confidence: 'high' | 'medium' | 'low' } {
  const text = String(requirement || '')
  const hits: Array<{ mode: PipelineMode; word: string }> = []
  for (const sig of SIGNALS) {
    for (const w of sig.words) {
      if (text.includes(w)) hits.push({ mode: sig.mode, word: w })
    }
  }
  const rationale = hits.map((h) => `命中「${h.word}」→ ${h.mode}`)
  const countOf = (m: PipelineMode) => hits.filter((h) => h.mode === m).length

  let mode: PipelineMode = 'full' // 默认完整（护栏优先，宁重勿漏）
  if (countOf('patch') > 0) mode = 'patch'
  else if (countOf('tech') > 0 && countOf('medium') === 0 && countOf('full') === 0) mode = 'tech'
  else if (countOf('lite') > 0 && countOf('medium') === 0) mode = 'lite'
  else if (countOf('medium') > 0 || opts && opts.needDesign) mode = 'medium'
  else if (hits.length === 0) mode = 'full'

  // 护栏兜底：patch 不适用于"需求含测试/验收/跨文件"场景；UI 需求不得落 patch/tech
  if ((mode === 'patch' || mode === 'tech') && (opts && opts.needDesign)) mode = 'medium'
  if ((mode === 'patch') && (countOf('tech') > 0 || text.includes('新增') || text.includes('功能'))) mode = 'lite'

  // M1 架构护栏：命中"架构性"信号（持久化/存储/独立模块/抽象/跨模块等）→ 不得落 lite/tech/patch，
  // 强制 medium+（必须有架构阶段产蓝图）。架构性改动靠局部视角会塌，不能当微功能/改造处理。
  const architectureSignals = ['持久化', 'localStorage', '本地存储', '存储', '保存', '恢复', '存档', '独立模块', '抽象', '存储层', 'sessionStorage', 'IndexedDB', '跨模块', '数据层']
  if ((mode === 'lite' || mode === 'tech' || mode === 'patch') && architectureSignals.some((w) => text.includes(w))) {
    mode = 'medium'
    rationale.push(`架构护栏：需求含「${architectureSignals.find((w) => text.includes(w))}」→ 强升 medium（需架构阶段）`)
  }

  const kind = mode === 'patch' ? '热修/单点' : mode === 'tech' ? '技术驱动改造' : mode === 'lite' ? '微功能' : mode === 'medium' ? '标准功能(含UI)' : '完整需求'
  const confidence: 'high' | 'medium' | 'low' = mode === 'patch' ? 'high' : hits.length >= 2 ? 'medium' : 'low'
  if (rationale.length === 0) rationale.push('无强信号，默认 full（护栏优先）')
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
  source: 'model' | 'fallback'
}

/** 解析模型 JSON 输出（容错：定位首个 {...} 块；字段缺失/非法回退 null）。 */
function parseVerdictText(text: string): TriageVerdict | null {
  const m = String(text || '').match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const raw = JSON.parse(m[0])
    const mode = normalizeMode(raw.mode)
    if (!mode) return null
    return {
      mode,
      kind: typeof raw.kind === 'string' ? raw.kind : '',
      needDesign: raw.needDesign === true,
      complexity: ['small', 'medium', 'large'].indexOf(raw.complexity) !== -1 ? raw.complexity : 'medium',
      rationale: Array.isArray(raw.rationale) ? raw.rationale.map(String).slice(0, 6) : [],
      confidence: ['high', 'medium', 'low'].indexOf(raw.confidence) !== -1 ? raw.confidence : 'medium',
      source: 'model',
    }
  } catch (e) { return null }
}

/** 兜底：正则预筛 → fallback verdict（模型分诊不可用/超时/解析失败时）。 */
function fallbackVerdict(requirement: string, opts?: { needDesign?: boolean }): TriageVerdict {
  const pre = suggestMode(requirement, opts)
  return {
    mode: pre.mode, kind: pre.kind, needDesign: !!(opts && opts.needDesign), complexity: 'medium',
    rationale: [...pre.rationale, '（模型分诊不可用，已用正则兜底）'], confidence: pre.confidence, source: 'fallback',
  }
}

/** 模型驱动分诊：spawn「分诊分析师」子代理思考一轮；子代理不可用/超时/解析失败 → 正则兜底。 */
export async function runTriage(
  requirement: string,
  opts?: { needDesign?: boolean },
  parent?: unknown,
  signal?: unknown,
): Promise<TriageVerdict> {
  const subagents = runtime.subagents as { start?: (provider: string, init: unknown) => Promise<{ result: Promise<{ output?: unknown; stopReason?: string }>; dispose?: () => Promise<void> | void }> } | undefined
  if (!subagents || typeof subagents.start !== 'function') return fallbackVerdict(requirement, opts)
  const pre = suggestMode(requirement, opts)
  let run: { result: Promise<{ output?: unknown; stopReason?: string }>; dispose?: () => Promise<void> | void } | null = null
  try {
    run = await subagents.start(providerName() as string, {
      label: '需求分诊',
      prompt: [{ type: 'text', text: TRIAGE_PROMPT(requirement, opts, pre) }],
      parent,
      signal,
    })
    const result = await Promise.race([
      run.result,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('triage 超时（90s）')), 90000)),
    ]) as { output?: unknown; stopReason?: string }
    const parsed = parseVerdictText(extractText(result && result.output))
    if (parsed) return parsed
  } catch (e) { /* 超时/失败 → 走兜底 */ } finally {
    if (run && run.dispose) { try { await run.dispose() } catch (e) { /* ignore */ } }
  }
  return fallbackVerdict(requirement, opts)
}
