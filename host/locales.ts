/**
 * dsh-plugin-teamflow — host 侧语言层机制（纯函数 + 词典装配，叶子层）。
 *
 * 为什么需要（PRD r9）：DSH 的 zh/en 只在浏览器侧（`@deepseek-ai/dsh-client-locale`），
 * host 侧原本**无 i18n**——完成汇报、工具返回、流水线日志、产物文档一律中文。
 * 本文件是 host 侧语言能力的**机制层**（与 constants/util 同级的叶子）：
 * 解析链（AC-1）、词典装配、翻译回落、阶段/档位标签、产物语言指令。
 *
 * 分层约定（单向依赖，勿破坏）：
 * - **机制在这里**（纯数据/纯函数，零 IO、零异常、零宿主依赖）；
 * - **词典数据**按消费区拆两个文件：`locales/pipeline.ts`（流水线面）+ `locales/tools.ts`
 *   （工具/分诊面）——拆文件是为了「每个文件单一写者」，与代码的既有区域切分一致；
 * - **运行期语言源**（客户端推送槽 + 宿主 settings 只读端口）在 `core/locale.ts`。
 *
 * zh 零回归是**结构性**保证：`phaseLabel('zh', ·)` 直接返回 `PHASE_KEY_OF` 原值、
 * `t(locale, key)` 找不到 key 时回落到 en 再回落 key 本身，绝不拼接/改写中文存量文案。
 */
import { PHASE_KEY_OF, phaseKeyOf } from './constants.ts'
import { PIPELINE_DICT } from './locales/pipeline.ts'
import { TOOLS_DICT } from './locales/tools.ts'

/** host 支持的语言（en 是兜底语言，AC-1③）。 */
export type HostLocale = 'zh' | 'en'

/** 兜底语言：解析链全空、词典缺 key 时的最终落点（PRD AC-1/AC-10）。 */
export const FALLBACK_LOCALE: HostLocale = 'en'

/** 支持的语言枚举（顺序即展示优先级）。 */
export const HOST_LOCALES: readonly HostLocale[] = Object.freeze(['zh', 'en'] as const)

/**
 * 解析单个语言值（纯函数、零异常）：合法返回，其余一律 null。
 * 只认精确的 'zh' / 'en'（大小写与空白容忍：'EN ' → 'en'）——「非法值逐级降级」由
 * resolveLocale 负责，本函数不做任何猜测（不做 ISO 前缀匹配：'zh-Hans' 不等于 'zh'，
 * 免得把用户没选过的语言猜进来）。
 */
export function parseLocale(v: unknown): HostLocale | null {
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  return s === 'zh' || s === 'en' ? (s as HostLocale) : null
}

/**
 * 语言解析链（AC-1）：①客户端推送值 ②宿主用户显式选择值 ③`en`。
 * 任一级非法/缺失即降级下一级；永不抛异常、不做 IO（纯函数）。
 */
export function resolveLocale(v: { client?: unknown; host?: unknown } | null | undefined): HostLocale {
  const src = v || {}
  return parseLocale(src.client) || parseLocale(src.host) || FALLBACK_LOCALE
}

/** 两份区词典合并（模块加载期一次）。 */
export const LOCALE_DICTS: Readonly<Record<HostLocale, Record<string, string>>> = Object.freeze({
  zh: Object.freeze({ ...PIPELINE_DICT.zh, ...TOOLS_DICT.zh }),
  en: Object.freeze({ ...PIPELINE_DICT.en, ...TOOLS_DICT.en }),
})

/** 某语言的全部 key（升序，测试/门禁用）。 */
export function dictKeys(locale: HostLocale): string[] {
  return Object.keys(LOCALE_DICTS[locale] || {}).sort()
}

/**
 * 翻译（回落链：locale → en → key 本身；`{name}` 参数替换）。
 * 缺 key 回退 en 且不抛错（AC-3 验证口径）；参数缺失时保留原占位符（便于发现漏参）。
 */
export function t(locale: HostLocale, key: string, params?: Record<string, string | number> | null): string {
  const dict = LOCALE_DICTS[locale] || LOCALE_DICTS.zh
  const raw = dict[key] !== undefined ? dict[key] : (LOCALE_DICTS[FALLBACK_LOCALE][key] !== undefined ? LOCALE_DICTS[FALLBACK_LOCALE][key] : key)
  if (!params) return raw
  return String(raw).replace(/\{(\w+)\}/g, (m, name) => (params[name] === undefined || params[name] === null ? m : String(params[name])))
}

/** 产物语言指令（prompts 用；zh 保持现状字面量 'Chinese Markdown'）。 */
export function langDirective(locale: HostLocale): string {
  return locale === 'zh' ? 'Chinese Markdown' : 'English Markdown'
}

/**
 * 阶段展示名（journal.logs / 阶段 label / 失败错误 / 注入块共用同一处取值）。
 * zh 直接取 `PHASE_KEY_OF` 原值（逐字不变，AC-9 结构性零回归）；未知阶段原样返回。
 */
export function phaseLabel(locale: HostLocale, phase: unknown): string {
  const key = phaseKeyOf(phase)
  // phaseKeyOf 对未知输入会原样返回，故必须再校验是否真的是阶段键（否则会拼出不存在的 key）
  if (!key || (PHASE_KEY_OF as Record<string, string | undefined>)[key] === undefined) return String(phase === null || phase === undefined ? '' : phase)
  if (locale === 'zh') return PHASE_KEY_OF[key as keyof typeof PHASE_KEY_OF] || String(phase)
  return t(locale, `stageLabel.${key}`)
}

/** 档位展示名（zh 由调用方传 MODE_REGISTRY 原值，保持单一事实来源；en 取词典）。 */
export function modeLabel(locale: HostLocale, mode: string, zhLabel?: string | null): string {
  if (locale === 'zh') return zhLabel || mode
  const key = `mode.${mode}.label`
  const hit = LOCALE_DICTS[locale][key]
  return hit !== undefined ? hit : (zhLabel || mode)
}

/** 档位一句话说明（同 modeLabel：zh 走 MODE_REGISTRY 原值）。 */
export function modeDesc(locale: HostLocale, mode: string, zhDesc?: string | null): string {
  if (locale === 'zh') return zhDesc || ''
  const key = `mode.${mode}.desc`
  const hit = LOCALE_DICTS[locale][key]
  return hit !== undefined ? hit : (zhDesc || '')
}

/** en 词典值里的 CJK 检测（AC-3 验证口径：en 文案不得含 CJK）。 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/

/**
 * 词典自检（键唯一 / zh-en 同形 / en 无 CJK / 值非空）——返回值即问题清单，空数组 = 健康。
 * 刻意不抛异常（AC-10：headless 加载不得因词典问题阻塞），门禁由 test/locale.test.js 断言。
 */
export function dictProblems(): string[] {
  const problems: string[] = []
  const zhKeys = Object.keys(PIPELINE_DICT.zh).concat(Object.keys(TOOLS_DICT.zh))
  const seen = new Set<string>()
  for (const k of zhKeys) {
    if (seen.has(k)) problems.push(`键重复（两份区词典合并后不唯一）：${k}`)
    seen.add(k)
  }
  const zhAll = dictKeys('zh')
  const enAll = dictKeys('en')
  for (const k of zhAll) if (enAll.indexOf(k) === -1) problems.push(`en 缺 key：${k}`)
  for (const k of enAll) if (zhAll.indexOf(k) === -1) problems.push(`zh 缺 key：${k}`)
  for (const loc of HOST_LOCALES) {
    const dict = LOCALE_DICTS[loc]
    for (const k of Object.keys(dict)) {
      const v = dict[k]
      if (typeof v !== 'string' || !v) { problems.push(`${loc} 空值：${k}`); continue }
      if (loc === 'en' && CJK.test(v)) problems.push(`en 值含 CJK：${k}`)
    }
  }
  return problems
}
