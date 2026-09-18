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
  /** host 侧填：档位被**架构护栏**从哪个档位升上来（ADR-0006）；仅审计/日志用，不参与路由。 */
  upgradedFrom?: PipelineMode | null
  /** **交付物形态**（2026-09-17 新增维度）：决定「该满足哪些客观交付契约」——见 ARTIFACT_CONTRACTS。
   *  用**一个维度**覆盖所有交付物类型，避免"每来一类插件加一条正则"（无界增长 + 词表交叉）。 */
  artifact: ArtifactKind
  /** 是否要求「可安装/可被宿主加载」（形态语义的一部分：源码目录里的插件 ≠ 能装进 profile 的插件）。 */
  installable: boolean
}

/** 交付物形态（单选，与 ARTIFACT_CONTRACTS 一一对应）。 */
export type ArtifactKind = 'app' | 'plugin-host' | 'plugin-client' | 'plugin-full' | 'cli' | 'lib' | 'docs' | 'data' | 'other'

export const ARTIFACT_KINDS: ArtifactKind[] = ['app', 'plugin-host', 'plugin-client', 'plugin-full', 'cli', 'lib', 'docs', 'data', 'other']

/** 形态归一：非法/缺失一律 `other`（绝不因模型没给字段就套用某类契约）。 */
export const normalizeArtifact = (raw: unknown): ArtifactKind =>
  (ARTIFACT_KINDS.indexOf(raw as ArtifactKind) !== -1 ? (raw as ArtifactKind) : 'other')

/** 本仓已有正确样本（写进 prompt 让 PM 去读，而不是把字段名硬编码——防宿主版本漂移）。 */
export const ARTIFACT_REFERENCE_SAMPLES: Record<ArtifactKind, string[]> = {
  app: [], 'plugin-host': ['plugins/dsh-plugin-teamflow'], 'plugin-client': ['plugins/dsh-plugin-teamflow'],
  'plugin-full': ['plugins/dsh-plugin-teamflow'], cli: ['plugins/assetd'], lib: ['plugins/assetd'],
  docs: [], data: [], other: [],
}

/**
 * **交付形态契约表**（数据驱动；新增一类交付物 = 加一行数据，**不加判定逻辑、不加正则**）。
 *
 * 由来（2026-09-17 实测）：`dddd` 那条 run 交付了一个"看着完整"的 dsh 插件（host/src/client/lib 都有），
 * 但**装不进 dsh web profile**——缺 `cordis.patch.yml`（profile 层入口）+ `package.json` 的
 * `dsh.bundle.patch` 声明 + `files` 白名单 + 依赖用了 `workspace:` 协议。它却验收通过了：因为**AC 里
 * 从来没有"宿主可加载/可安装"这一条**——PRD 把"我想开发一个 dsh 插件"展开成了功能 AC（时钟/提醒/持久化/UI），
 * 漏掉了形态本身隐含的客观契约。形态不是"要不要做"的问题，而是"做成什么才算数"。
 *
 * 语义：`required` 是**契约项**（每项给"要求 + 判据形态"），**不是**字段名清单——具体字段名必须由 PM
 * 读同仓既有样本/宿主文档核实（宿主版本会演进，硬编码字段名会过期）。
 */
export interface ArtifactContractItem {
  /** 契约要求（写给 PM 的一句话）。 */
  requirement: string
  /** 判据形态（怎么写进 AC 才算可测）。 */
  criteria: string
  /** 是否仅在 `installable=true` 时要求（形态内部再分档：源码目录 vs 可安装）。 */
  onlyWhenInstallable?: boolean
}

export const ARTIFACT_CONTRACTS: Record<ArtifactKind, ArtifactContractItem[]> = {
  app: [],
  'plugin-host': [
    { requirement: '宿主半必须有 profile 层加载入口声明（参照同仓既有插件，不凭记忆写字段名）', criteria: '存在该声明文件/字段，且其 `name` 用**包根名**（子路径会被 loader 判为"无 client 声明"而跳过）' },
    { requirement: '该入口声明文件必须进包分发白名单（`files` 等）', criteria: '读 package.json 的 files 数组，确认包含该声明文件' },
    { requirement: '依赖协议必须是 profile 可解析的形态（不得用 `workspace:` 等本地协议）', criteria: '`node -e "const s=require(\'fs\').readFileSync(\'package.json\',\'utf8\');process.exit(/workspace:/.test(s)?1:0)"` 退出码 0' },
    { requirement: '宿主运行期依赖要按宿主模块表声明（peer/可选 peer，而非真实下载依赖）', criteria: 'package.json 的 peerDependencies/peerDependenciesMeta 覆盖宿主提供的 @deepseek-ai/* 包' },
    { requirement: '**构建产物与源码同步**（实锤 dddd：`lib` 是旧产物 → 装上后宿主启动即炸）', criteria: '提交/安装前重新构建；产物里能找到只存在于当前源码的特征字符串（或产物 mtime 晚于全部 src 文件）' },
    { requirement: '**装载安全**：模块顶层不得抛错（实锤 dddd：顶层访问未注入的 `ctx.settings` → 宿主起不来）', criteria: '`node -e "require(\'<构建产物入口>\')"` 退出码 0（能 require = 顶层无未捕获异常）' },
    { requirement: '能被 profile 真实装入', criteria: 'profile 内执行安装命令退出码 0，且 profile 的依赖与插件清单出现该包', onlyWhenInstallable: true },
    { requirement: '装载后宿主真实加载该插件（端到端判据）', criteria: '重启宿主后启动日志/插件列表出现该插件；仅有源码文件不算', onlyWhenInstallable: true },
    { requirement: '**安装必须带回滚**（实锤 dddd：装上后宿主起不来，只能另开 agent 手术卸载）', criteria: '安装前先写明卸载命令（如 `dsh plugin remove <name>` / 从 profile 依赖与 bundles 同时摘除），装后验证失败 → 立即执行卸载恢复', onlyWhenInstallable: true },
  ],
  'plugin-client': [
    { requirement: 'client 半必须有 bundle 声明与被扫描的 id/name（参照同仓既有插件）', criteria: 'package.json 的 client 声明块字段名与同仓样本一致，且构建会产出非空 client 产物' },
    { requirement: '构建产物必须进包分发白名单', criteria: '读 files 数组确认包含构建产物目录/文件' },
    { requirement: '**构建产物与源码同步**（实锤 dddd：旧 `lib/client.js` 让浏览器端行为与源码不符）', criteria: '提交/安装前重新构建；产物含当前源码特征字符串或 mtime 晚于全部 src' },
  ],
  'plugin-full': [
    { requirement: '宿主半必须有 profile 层加载入口声明（参照同仓既有插件，不凭记忆写字段名）', criteria: '存在该声明文件/字段，`name` 用包根名' },
    { requirement: 'client 半必须有 bundle 声明与被扫描的 id/name', criteria: 'client 声明块字段名与同仓样本一致，构建产出非空 client 产物' },
    { requirement: '入口声明与构建产物都必须进包分发白名单', criteria: '读 package.json 的 files 数组确认包含二者' },
    { requirement: '依赖协议必须是 profile 可解析的形态（不得用 `workspace:` 等本地协议）', criteria: '读 package.json 全文不得命中 `workspace:`' },
    { requirement: '宿主运行期依赖按宿主模块表声明（peer/可选 peer）', criteria: 'peerDependencies/peerDependenciesMeta 覆盖宿主提供的 @deepseek-ai/* 包' },
    { requirement: '**构建产物与源码同步**（实锤 dddd：旧 `lib/index.js` → 装上后宿主启动即炸）', criteria: '提交/安装前重新构建；宿主与 client 产物均含当前源码特征字符串（或 mtime 晚于全部 src）' },
    { requirement: '**装载安全**：两个产物的模块顶层都不得抛错（实锤 dddd：顶层访问未注入服务 → 宿主起不来，P0）', criteria: '`node -e "require(\'<宿主产物入口>\')"` 与 client 产物同样检查，退出码 0' },
    { requirement: '能被 profile 真实装入且被宿主加载（端到端）', criteria: 'profile 安装命令退出码 0 + 重启宿主后启动日志出现该插件', onlyWhenInstallable: true },
    { requirement: '**安装必须带回滚**（实锤 dddd：装上后宿主起不来，只能另开 agent 手术卸载才能救回宿主）', criteria: '安装前先写明卸载命令（如 `dsh plugin remove <name>` / 从 profile 依赖与 bundles 同时摘除），装后验证失败 → 立即执行卸载恢复', onlyWhenInstallable: true },
  ],
  cli: [
    { requirement: '必须有可执行入口声明', criteria: 'package.json 有 bin 字段且指向真实存在的文件' },
    { requirement: '入口文件可被执行', criteria: '直接运行该入口（或 `--help`）退出码 0' },
  ],
  lib: [
    { requirement: '必须声明模块入口且导出可用', criteria: 'package.json 的 main/exports 指向真实文件，且能被 import 成功' },
  ],
  docs: [],
  data: [],
  other: [],
}

/** 取某形态的契约项（`installable=false` 时过滤掉安装类项）。 */
export function artifactContractsFor(kind: ArtifactKind, installable: boolean): ArtifactContractItem[] {
  return (ARTIFACT_CONTRACTS[kind] || []).filter((it) => !it.onlyWhenInstallable || installable)
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

/**
 * 档位「轻重」序（**只用于架构护栏强升**）。tech 与 lite 同级——两者都跑轻量蓝图，差异在语义不在轻重；
 * patch 最轻（单 agent 直改）。
 */
export const MODE_RANK: Record<PipelineMode, number> = { patch: 0, lite: 1, tech: 1, medium: 2, full: 3 }

/**
 * **架构护栏强升**（ADR-0006 的护栏不得因「调用方显式指定档位」而失效）。
 *
 * 背景（2026-09-16 实测）：`lite` 参数描述里写了 "(recommended) for small changes"，模型逐字引用它自行传
 * `lite: true`——33 次启动里 14 次显式传档位（其中 0 次先跑 `teamflow_triage` 预览），于是 triage 的
 * 「架构信号 → 至少 medium」护栏与澄清闸门在 **42% 的启动**上被静默绕过。
 *
 * 规则：调用方**没给**档位 → 用分诊的；给了更轻的档位而分诊判 ≥medium → 升到分诊档位（架构型需求不得
 * 走轻档位）；调用方给的是 medium/full（或已 ≥ 分诊档位）→ **保持调用方选择**（避免无谓 token 放大）。
 * 返回 null 表示不改动。
 */
export function guardrailUpgrade(explicit: PipelineMode | undefined, lite: boolean, triaged: PipelineMode): PipelineMode | null {
  const want = MODE_RANK[triaged] || 0
  // 调用方没给档位 → 直接用分诊的
  if (!explicit && !lite) return triaged
  const have = explicit ? (MODE_RANK[explicit] || 0) : MODE_RANK.lite
  // 只在「调用方选了轻档位（patch/lite/tech）」且「分诊判 ≥medium」时强升；
  // 调用方已选 medium/full 时**保持其选择**（那已满足护栏，再升只是无谓 token 放大）。
  if (have <= MODE_RANK.lite && want >= MODE_RANK.medium) return triaged
  return null
}

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
      artifact: normalizeArtifact(raw.artifact),
      installable: raw.installable === true,
      blockers: qb.blockers,
      blockersDropped: qb.dropped,
    }
  } catch (e) { return null }
}

/** 兜底：正则预筛 → fallback verdict（模型分诊不可用/超时/解析失败时）。`reason` = 退化原因（可见化：
 *  2026-09-18 probe-clock 实锤——分诊子代理**推理中被 90s 超时 dispose**（截图「已停止」），journal 只记
 *  一条 fallback info，没人知道为什么；现在把原因带回给调用方落 warn）。 */
function fallbackVerdict(requirement: string, opts?: { needDesign?: boolean }, locale: HostLocale = 'zh', reason?: string): TriageVerdict {
  const pre = suggestMode(requirement, opts, locale)
  return {
    mode: pre.mode, kind: pre.kind, needDesign: !!(opts && opts.needDesign), complexity: 'medium',
    rationale: [...pre.rationale, t(locale, 'triage.fallback')], confidence: pre.confidence, slug: '', source: 'fallback',
    // 兜底路径**永不拦启动**（intent 默认 requirement、无 blocker）——分诊不可用时退回现状行为，零回归。
    intent: 'requirement', blockers: [], blockersDropped: 0,
    // 兜底路径不猜形态（一律 other = 不套用任何形态契约）：宁可不加，也不要给错形态的契约
    artifact: 'other', installable: false,
    ...(reason ? { fallbackReason: String(reason).slice(0, 300) } : {}),
  } as TriageVerdict
}

/** 模型驱动分诊：spawn「分诊分析师」子代理思考一轮；子代理不可用/超时/解析失败 → 正则兜底。
 * 解析失败先带纠错提示重试一次（实锤 run tf-mtfo8exi：模型输出「Let me output the JSON.」开场白
 * 后无 JSON——首轮输出预算被思考耗尽/模型停早；重试提示直接输出 JSON 对象本身）。
 * **超时 240s**（2026-09-18 实锤修正，勿回退 90s）：分诊职责今天已含 intent/blockers/artifact/installable
 * 判定（输出字段翻倍），深思考模型 90s 内经常答不完 → 被 dispose（UI 显示「已停止」）→ 两次尝试全废 →
 * fallback。probe-clock 截图实证：模型推理到 artifact 判别处被掐，推理质量很高、不是卡死。 */
export const TRIAGE_TIMEOUT_MS = 240000

/**
 * 分诊结果短期缓存（2026-09-18 实锤新增，勿回退）。
 *
 * **为什么必须有**：`teamflow_start` 的**决策返回路径会让同一条需求被分诊两次**。实测 probe-clock
 * `tf-mu5wcm2j-kxk14y`：主线程 03:01:54 首次调用 → 工具内 preflight 跑一次分诊（子代理 16.6K tok）
 * → 继续走到分支决策 → 返回 `needs-decision kind=git-init`（**不建 run**）→ 用户点选后主线程
 * **03:02:24 重调** → 又跑一次分诊（子代理 16.5K tok）。两次都 `source=model`、都成功，**结果也一致**
 * ——纯粹白花一次子代理调用（~16.5K tok + 2–4s），且第一次的裁决被丢弃。
 * 此前几轮分诊都走 `source=fallback`（90s 超时那个 bug）→ fallback 不建子代理 → 重复执行不可见；
 * 超时修到 240s 后分诊真跑起来，重复才暴露。
 * **不止救 git-init**：任何 `needs-decision`（分支决策四情形 / 危险路径 / 澄清闸门）都会让工具被重调。
 *
 * **缓存键必须包含 requirement + requirementSupplement**：`[CLARIFIED]` 补充说明**改变分诊输入**
 * （收敛规则据此判定"已澄清过"），键里漏了它会把「澄清前」的裁决当成「澄清后」的复用——
 * 那就等于闸门失效。键里**不得**包含 `preAction`/`branchPolicy`/`branchName`/`commitMessage`：
 * 它们是**决策答案**，不改变需求语义（正是它们导致重调，进了键就永远命不中）。
 *
 * **有效性不看时间，看「是否仍在等待用户决策」（2026-09-18 二次修正，勿回退）**：
 * 初版用 TTL 10 分钟，注释里写「决策往返是秒级/分钟级，更久说明用户走神了」——**这个前提是错的**。
 * probe-cache 实测 `tf-mu6tb281-4n43oc`：17:29:30 首次 start（分诊子代理 `a612dc69`）→ 17:30:46 弹存档问句
 * → 用户 **18:24:30 才点选**（隔 55 分钟，期间还重启过宿主）→ 缓存早已过期 → 又跑一次分诊（`7e73839e`）。
 * 而「改动存档」「分支策略」这类**启动前的非紧急决策**，用户去处理别的事、过一小时再回来点，完全正常——
 * 按时间赌必然失手。故改为**显式状态机**：
 *  - 首次预检返回 `needs-decision`（工具没建 run）→ 该条目标记 `pendingDecision`（**待决策**）；
 *  - 只要还标着待决策 → **无论隔多久都复用**（这正是"用户还没回答同一个问题"的精确语义）；
 *  - 建 run 成功 / 需求变了 → 标记清除（不再待决策）。
 * TTL 降级为**纯粹的防泄漏兜底**（默认 2 小时，见 `triageCachePending` 的实现）：只用来回收
 * 「用户永远没回来点」的悬挂条目，不再承担正确性职责。容量上限 32 条、超出按插入序淘汰最旧。
 * **只缓存 model 裁决**：fallback 是"分诊不可用"的降级产物，缓存它会把一次偶发故障固化。
 */
export const TRIAGE_CACHE_TTL_MS = 2 * 60 * 60 * 1000
/** 容量上限（导出供测试断言，避免测试里硬编码重复数字——改了上限只改这一处）。 */
export const TRIAGE_CACHE_MAX = 32
const triageCache = new Map<string, { verdict: TriageVerdict; at: number; pendingDecision: boolean }>()

/** 缓存键 = 需求 + 澄清答复（**不含任何决策字段**；见上方注释）。 */
export function triageCacheKey(requirement: string, supplement?: unknown): string {
  const sup = typeof supplement === 'string' ? supplement.trim() : ''
  return `${String(requirement || '').trim()}\u0000${sup}`
}

/** 读缓存。**待决策条目无视 TTL**（见上方注释）；非待决策条目按 TTL 兜底回收。 */
export function triageCacheGet(key: string): TriageVerdict | null {
  const hit = triageCache.get(key)
  if (!hit) return null
  if (!hit.pendingDecision && Date.now() - hit.at > TRIAGE_CACHE_TTL_MS) { triageCache.delete(key); return null }
  return hit.verdict
}

/**
 * 写缓存（**仅 model 裁决**；容量超限淘汰最旧）。
 * @param pendingDecision 该裁决是否**仍未被消费**（= 本次调用会返回 needs-decision、不建 run）。
 *   工具侧两次调用共享同一 key，故：首次预检返回 needs-decision 时置 true（下次复用，隔多久都行）；
 *   建 run 成功时置 false（这条需求的决策已落地，缓存降级为普通短期缓存）。
 */
export function triageCachePut(key: string, verdict: TriageVerdict, pendingDecision = false): void {
  if (!verdict || verdict.source !== 'model') return
  triageCache.delete(key) // 重新插入以刷新插入序（LRU-ish：命中过的排到最后）
  triageCache.set(key, { verdict, at: Date.now(), pendingDecision })
  while (triageCache.size > TRIAGE_CACHE_MAX) {
    const oldest = triageCache.keys().next()
    if (oldest.done) break
    triageCache.delete(oldest.value)
  }
}

/** 该键是否仍标着「待用户决策」（诊断/测试用）。 */
export function triageCacheIsPending(key: string): boolean {
  const hit = triageCache.get(key)
  return !!hit && hit.pendingDecision
}

/**
 * 标记「仍在等用户决策」（工具返回 needs-decision / needs-clarification 时调用）。
 *
 * **为什么不重新 put 一次**：`put` 会被 `source !== 'model'` 拦掉，而这里要处理的情况是
 * 「缓存里**已有**裁决、现在要把它标成待决策」——只能就地改状态。若缓存里没有该键（例如裁决来自
 * fallback、根本没入缓存），这里是**无操作**（下次调用老老实实重跑分诊，符合预期）。
 */
export function triageCacheMarkPending(key: string): void {
  const hit = key ? triageCache.get(key) : undefined
  if (hit) hit.pendingDecision = true
}

/**
 * 决策已落地 → 清除「待决策」标记（**保留裁决本身**，降级为普通短期缓存）。
 * 调用点：`teamflow_start` 在建 run 成功之后（此时这条需求的启动决策已用完）。
 */
export function triageCacheSettle(key: string): void {
  const hit = triageCache.get(key)
  if (hit) { hit.pendingDecision = false; hit.at = Date.now() }
}

/** 测试/诊断用：清空缓存（生产路径不调用）。 */
export function triageCacheClear(): void { triageCache.clear() }

/** 测试/诊断用：当前缓存条数。 */
export function triageCacheSize(): number { return triageCache.size }

export async function runTriage(
  requirement: string,
  opts?: { needDesign?: boolean },
  parent?: unknown,
  signal?: unknown,
  locale: HostLocale = 'zh',
): Promise<TriageVerdict> {
  const subagents = runtime.subagents as { start?: (provider: string, init: unknown) => Promise<{ result: Promise<{ output?: unknown; stopReason?: string }>; dispose?: () => Promise<void> | void }> } | undefined
  if (!subagents || typeof subagents.start !== 'function') return fallbackVerdict(requirement, opts, locale, 'subagents service unavailable')
  const pre = suggestMode(requirement, opts, locale)
  let lastReason = ''
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
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error(t(locale, 'err.triageTimeout') + ` (${Math.round(TRIAGE_TIMEOUT_MS / 1000)}s)`)), TRIAGE_TIMEOUT_MS)),
      ]) as { output?: unknown; stopReason?: string }
      const parsed = parseVerdictText(extractText(result && result.output))
      if (parsed) return parsed
      lastReason = `empty/unparseable verdict (stopReason=${result && result.stopReason || 'unknown'})`
    } catch (e) {
      lastReason = String((e && e.message) || e)
      if (attempt === 2) { /* 超时/失败 → 走兜底（原因已在 lastReason） */ }
    } finally {
      if (run && run.dispose) { try { await run.dispose() } catch (e) { /* ignore */ } }
    }
  }
  return fallbackVerdict(requirement, opts, locale, lastReason)
}
