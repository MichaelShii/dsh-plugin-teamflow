/**
 * dsh-plugin-teamflow — 通用纯工具（底座；依赖 constants.ts，无其他依赖）。
 */
import { REFUSAL_PATTERN, STAGE_MIN_LENGTH } from './constants.ts'

export function toText(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}
export function clip(text, n) {
  const s = toText(text)
  return s.length > n ? s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]` : s
}
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
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
export const SAFE_SIGNAL = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} }
export function normalizeSignal(s) {
  return (s && typeof s === 'object' && typeof s.addEventListener === 'function' && typeof s.aborted === 'boolean') ? s : SAFE_SIGNAL
}

/** 产出物实质校验：非空 + 无拒绝词 + 达到阶段长度下限。 */
export function hasSubstance(phase: string, text: string | null | undefined): boolean {
  if (!text || !text.trim()) return false
  if (REFUSAL_PATTERN.test(text)) return false
  const min = STAGE_MIN_LENGTH[phase] ?? 100
  return text.trim().length >= min
}

/** 不可重试的失败原因（上下文耗尽/超长等——重试同一 prompt 大概率复现）。 */
export function isUnretryable(reason: unknown, outcome: unknown): boolean {
  const r = String(reason || outcome || '')
  return /context|limit|max-token|token|tool-error/i.test(r)
}

/** 阶段产出 → 精简交接摘要（供审计/展示；产出含显式 <!-- handoff --> 块则优先取块内内容）。 */
export function handoffBrief(text: string | null | undefined): string {
  if (!text || !String(text).trim()) return ''
  const m = String(text).match(/<!--\s*handoff\s*-->([\s\S]*?)(?:<!--\s*\/handoff\s*-->|$)/)
  const brief = (m && m[1] ? m[1] : String(text)).trim()
  return clip(brief, 2000)
}

/**
 * 验收结论解析：只以显式「验收结论 / 整体结论」行为准（acceptancePrompt 强制 4 档固定话术），
 * 不做正文散文朴素子串匹配。历史误报实锤（run tf-msytlok5）：验收报告 ✅ 通过，其记忆回写段一句
 * 「SUMMARY.md 结构无需改动」（= 结构无需变更）被旧正则「无需改动」子串命中 → 误判 reject →
 * 整条流水线置 failed。reject 词在正文里常以否定/引用/对照形式出现，故：
 *  - 「📝 需求不适用」是验收负责人专用的强结论词，允许全文命中；
 *  - 其余 reject 词（需求与实际不符/站不住/无效/无需改动等）仅在结论行且该行不含「通过/✅/⚠️」时才算；
 *  - rework 词仅认结论行（且不与「✅ 通过」同现）。
 * @param {unknown} text 验收报告全文
 * @returns {'accepted'|'rework'|'reject'}
 */
export function parseAcceptanceVerdict(text) {
  const acc = String(text || '')
  const accLine = (acc.split('\n').find((l) => /验收结论|整体结论/.test(l)) || '').replace(/\|.*/, '').trim()
  // M3 架构门禁：明确的架构打回信号 → rework（无论结论行写没写「通过」）
  // 覆盖：架构返工/重复实现/偏离蓝图/该拆未拆/该抽象未抽象/破坏既有结构
  if (/架构.*(返工|不通过|打回|需重构)|重复实现|重复适配|偏离蓝图|未按蓝图|该拆未拆|该抽象未抽象|破坏既有结构|结构性.*问题/.test(acc)) return 'rework'
  if (/❌\s*不通过|需返工|未通过/.test(accLine) && !/✅\s*通过/.test(accLine)) return 'rework'
  if (/📝\s*需求不适用/.test(acc)) return 'reject'
  if (!/通过|✅|⚠️/.test(accLine) && /需求不适用|需求与实际不符|需求站不住|需求无效|无需改动|无需修改/.test(accLine)) return 'reject'
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
export function extractBlueprint(text: string | null | undefined): Blueprint | null {
  const s = String(text || '')
  const i = s.indexOf(bdOpen)
  const j = s.indexOf(bdClose)
  if (i === -1 || j === -1 || j <= i) return null
  const raw = s.slice(i + bdOpen.length, j).trim()
  let parsed: { summary?: string; modules?: Record<string, BlueprintModule>; duplications?: string[]; tasks?: BlueprintTask[] } | null = null
  try { parsed = JSON.parse(raw) } catch (e) { return null }
  if (!parsed || typeof parsed !== 'object') return null
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const modules = parsed.modules || {}
  const duplications = Array.isArray(parsed.duplications) ? parsed.duplications : []
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  const parts: string[] = []
  if (summary) parts.push(`架构判断：${summary}`)
  const modEntries = Object.entries(modules)
  if (modEntries.length) parts.push(`模块蓝图：${modEntries.map(([f, m]) => `${f}→${m.responsibility || ''}${m.why ? `（${m.why}）` : ''}`).join('；')}`)
  if (duplications.length) parts.push(`重复风险：${duplications.join('；')}`)
  if (tasks.length) parts.push(`架构拆解任务：${tasks.map((t) => t.title).join('，')}`)
  return { summary, modules, duplications, tasks, render: `【架构蓝图（tech 阶段产出，dev 须在既有架构上实现，勿重建）】\n${parts.join('\n')}` }
}
