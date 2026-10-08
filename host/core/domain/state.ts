/**
 * dsh-plugin-teamflow core — state.json 预编译上下文索引。
 *
 * 目标：解决「每个新 run 都要从小代理全量读历史文档（PRD/TECH/QA）来重建认知」的 token 爆炸。
 * state.json 是跨 run 累积的结构化索引：每次 run 结束后由各阶段把「精简结论」沉淀进来，
 * 下一个 run 的子代理只读注入的 state slice，不再重复读全套历史文档。
 *
 * 设计原则：
 * - memory.md 保持权威记忆（人读）；state.json 是预编译索引（机器喂给子代理）。
 * - 子代理不直接读 state.json 文件，由 host 在开工时按角色注入相关 slice 到 prompt。
 * - state.json 只存「结论/指针」，不存全文；具体内容仍指向 docs/teamflow/ 下的活文档。
 */
import { join } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { teamflowRoot } from '../../../store.ts'
import type { RoleKey } from '../../constants.ts'
import { t } from '../../locales.ts'
import { runCtxLocale } from '../locale.ts'

/** 各阶段会额外输出一段 `<!-- state -->...<!-- /state -->` 的结构化 JSON，host 提取后合并进 state.json。 */
export interface StageStateBlock {
  /** phase key：prd/design/scaffold/tech/dev/qa/acceptance */
  phase?: string
  /** 本阶段结论摘要（≤500 字，给下一 run 复用的精炼信息） */
  summary?: string
  /** 本次迭代新增/变更的模块（文件路径） */
  touched?: string[]
  /** 本次验收结论（acceptance 阶段） */
  verdict?: string
  /** 需同步的记忆要点 */
  memory?: string[]
  /** free-form 结构：可放模块契约、AC 索引等供后续 slice */
  extra?: Record<string, unknown>
}

/**
 * 待澄清项的**类别**（2026-10-08，ADR-0011 ① 第 2 步）。
 *
 * - `fact` —— **信息缺口**：需求没交代、但模型研究过后有明显默认值。用户不回答也不会「不是我要的」，
 *   `default` 兜住即可 ⇒ **不打断**。
 * - `taste` —— **主观品味项**：多种走法**同样成立**，取舍取决于「用户想要什么」（视觉风格 / 形象角色 /
 *   交互形态 / 信息架构 / 文案语气与命名 / 无约束时的技术选型）。没有客观对错 ⇒ **必须用户自己定**
 *   ⇒ 若存在 `taste` 项，PRD 后**暂停**等用户拍板。
 *
 * 为什么两类要分开（而不是「有任何待澄清项就停」）：纯信息缺口打断用户 = 白白牺牲 §1 的无人值守卖点；
 * 而品味项不打断 = 成品由模型独裁（用户实锤：「我想实现一个桌宠」被模型定了形象与风格 ⇒ 感官很差）。
 */
export type OpenQuestionKind = 'fact' | 'taste'

/** state.json 的顶层形状。 */
export interface TeamflowState {
  version: number
  /** workspace 项目名（不做唯一键，仅展示） */
  projectName?: string | null
  updatedAt: number | null
  /** 产品级结论索引 */
  product: {
    summary?: string | null
    techStack?: string | null
  }
  /** ADR-0008：最近一次任务夹（docs/teamflow/<folder>），替代旧「当前版本」概念。 */
  lastRunFolder?: string | null
  /** 模块 → 契约/一句话（tech/dev 阶段沉淀） */
  modules: Record<string, string>
  /** 验证脚本清单（tech/qa 沉淀） */
  verifyScripts: string[]
  /** AC 索引：AC 编号 → 一句话（prd 阶段沉淀） */
  acIndex: Record<string, string>
  /**
   * **结构化待澄清项**（ADR-0011 ①，2026-10-07）：PRD state 块的 `extra.openQuestions`。
   *
   * `prdPrompt` 一直要求它（`prompts/index.ts:454`，且有 `prompt-contract.test.js` 的 L1 门禁），
   * 但 `mergeStateBlock` **从未消费** ⇒ 确认单只能退回**文本抽取**（`journal.assumptions` 的行）。
   * 结构化版本每条带「为什么问 / 影响什么 / 缺省怎么办」，确认单据此能让用户**直接挑默认值**。
   *
   * ⚠️ 语义与 `journal.assumptions` **不同、不互斥**：assumptions 是 agent 已替用户定下的假设，
   * openQuestions 是**要用户拍板**的项 —— 所以确认单两者都呈现，不做二选一。
   */
  openQuestions: Array<{
    q: string
    why: string
    changes: string
    default: string
    /**
     * **这一项属于哪一类**（2026-10-08，ADR-0011 ① 第 2 步）：`fact` = 信息缺口（模型研究过、
     * 有明显默认值，交给 `default` 即可）；`taste` = **主观品味项**（多种走法同样成立、没有客观对错，
     * 必须由用户自己定）。
     *
     * 消费点：**只有 `taste` 会让 PRD 后暂停**（`pipeline.ts`）。为什么不是「任何待澄清项都停」——
     * 信息缺口的代价可以由 `default` 兜住，而品味项猜错的代价是「成品不是我要的」（表现为流失/差评，
     * **不表现为 QA 打回**，用返工率量不出来）；同时也保住 §1 的无人值守卖点不被纯信息缺口打断。
     */
    kind: OpenQuestionKind
    /**
     * **模型没给 `kind` 时的标记**（不落给下游消费，只作**诊断**）。
     *
     * 为什么要留痕：`kind` 是「模型自律 + host 条件消费」的链，而本仓纪律要求**空值必须可见**
     * （否则功能静默空转、长期没人发现——2026-10-07 `extra` 兑现率 ~20% 就是这么埋了很久的）。
     * 缺 `kind` ⇒ 归一成 `fact`（不暂停，见 `normalizeOpenQuestions`），本标记让「契约没兑现」这件事
     * 在 `state.json` 里**可数**（`pipeline.ts` 据此发 warn 日志）。
     */
    kindMissing?: boolean
  }>
  /** 各阶段的最新结论（key: phase） */
  stages: Record<string, string>
  /** 最近流水线结论 */
  lastRun: {
    runId?: string | null
    requirement?: string | null
    folder?: string | null
    verdict?: string | null
    endedAt?: number | null
  } | null
  /** 本次 run 的运行时注入上下文（不持久化；M0 状态核对 + M1 架构蓝图 + 任务夹路径）。 */
  __runCtx?: {
    sanity?: string
    blueprint?: string
    runDocs?: string
    /** run 快照语言（'zh' | 'en'）：pipeline 按 journal.locale 写入，prompts/注入块据此渲染。 */
    locale?: string
    /** 本轮 QA 是否复验轮（C 方案 2026-09-15）：pipeline 的 QA 循环写入，qaPrompt 据此追加复验纪律
     *  （复用上一轮探针 + 重跑缺陷行的检测命令）。缺省/夹具无此字段 = 首轮。 */
    qaReverify?: boolean
    /** 当前 QA 轮次（1 = 首轮；含复验）。 */
    qaRound?: number
    /** 验收是否「已知问题」只读模式（E 方案 2026-09-15）：QA 打回超限时 pipeline 写入，
     *  acceptancePrompt 据此产出交付级视图 + 未闭环清单（结论由 host 强制为需人工裁定）。 */
    knownIssues?: boolean
    /** **交付形态契约**（2026-09-17）：分诊判定形态 → host 数据表展开的必填 AC 清单，
     *  prdPrompt 据此要求 PM 把形态契约写成可测 AC（防"看着完整却装不上"）。 */
    artifact?: string
    installable?: boolean
    artifactContracts?: Array<{ requirement: string; criteria: string }>
    /** 目标宿主（2026-09-18）与「需产出宿主契约调研」标记（非 dsh 宿主 + 插件形态时置位，PRD 硬门禁依据）。 */
    host?: string
    hostResearch?: boolean
    /** **本机安装环境**（2026-09-21）：`$DSH_HOME` + 插件自身路径反推的 profile 名/目录 + `dsh` 是否在 PATH。
     *  路径全为运行时探测（用户环境各异，不得写死）；探测失败时 PRD 必须改为"问用户"。 */
    installEnv?: { dshHome?: string; profile?: string; profileDir?: string; cliOnPath?: boolean; ok?: boolean } | null
    /** **craft 引导通道**（2026-09-30）：options.craft 经 __runCtx 下发；**缺省/undefined＝开**，
     *  只有显式 `false` 才关闭 design 视觉规格（2b）/ dev craft bar（4b）/ QA craft 评级（0d）三处引导。
     *  真值在 pipeline 每次执行开头写入，故 resume/复验轮都 inherits 同一次 run 的设置。 */
    craft?: boolean
  } | null
  /** **版本控制模式**（2026-09-17 方案 A：入口定、出口遵）：'repo'=是仓库/已初始化（出口正常收口提交）；
   *  'none'=用户明确选择不用版本控制（出口**不尝试提交**，汇报明写"未存档"）。缺省=未知（按旧逻辑探测）。 */
  gitMode?: 'repo' | 'none'
}

/**
 * `extra.openQuestions` 的容错归一：只保留有 `q` 的条目，四个字段一律转成字符串并截断。
 * 模型可能给 `{question: ...}` / 纯字符串 / 缺字段等变体 ⇒ 一律不抛、不污染 state。
 */
/**
 * `extra.openQuestions` 的容错归一：只保留有 `q` 的条目，各字段一律转成字符串并截断。
 * 模型可能给 `{question: ...}` / 纯字符串 / 缺字段等变体 ⇒ 一律不抛、不污染 state。
 *
 * ⚠️ **`kind` 缺省归 `fact`（不暂停），并打 `kindMissing` 标记** —— 这是刻意的，不是漏了：
 * 本仓纪律「依赖模型自律的判据，在量出真阳性率之前**不得有阻断权**」（见 MEMORY §16）。暂停**就是**阻断权，
 * 而 `kind` 的兑现率到 2026-10-08 仍**未实测** ⇒ 缺 `kind` 时**不能**默认成 `taste` 去暂停，
 * 否则等于把用户明确否掉的「任何待澄清项都停」偷偷放回来（那种形态会毁掉 §1 的无人值守卖点）。
 * 同时「不阻断」也不等于「静默」：`kindMissing` 让契约未兑现这件事在 `state.json` 里**可数**，
 * `pipeline.ts` 据此发 warn（空值必须可见，见 MEMORY §7③）。
 */
export function normalizeOpenQuestions(raw: unknown): TeamflowState['openQuestions'] {
  if (!Array.isArray(raw)) return []
  const out: TeamflowState['openQuestions'] = []
  for (const item of raw) {
    const o = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : null
    if (!o) continue
    const pick = (...keys: string[]): string => {
      for (const k of keys) {
        const v = o[k]
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 300)
      }
      return ''
    }
    const q = pick('q', 'question')
    if (!q) continue
    // ⚠️ **只认 `kind`，不做别名**（`q` 那种容错这里刻意不给）：我们要**测**的就是「模型按不按契约标
    // `kind`」这件事（§7：结构性契约必须用一次真实调用实测兑现率）。加别名会把契约违反洗成契约满足，
    // 把要测的数测没了。方向也是安全的：非法值一律归 `fact`（不暂停），不会误停。
    const rawKind = String(o.kind ?? '').trim().toLowerCase()
    const tagged = rawKind === 'taste' || rawKind === 'fact'
    out.push({
      q,
      why: pick('why', 'reason'),
      changes: pick('changes'),
      default: pick('default', 'defaultAnswer'),
      kind: rawKind === 'taste' ? 'taste' : 'fact',
      ...(tagged ? {} : { kindMissing: true }),
    })
    if (out.length >= 12) break
  }
  return out
}

/** 空态 state。 */
function emptyState(): TeamflowState {
  return {
    version: 1,
    projectName: null,
    updatedAt: null,
    product: { summary: null, techStack: null },
    lastRunFolder: null,
    modules: {},
    verifyScripts: [],
    acIndex: {},
    openQuestions: [],
    stages: {},
    lastRun: null,
  }
}

/** state.json 路径：$DSH_HOME/teamflow/<projectKey>/state.json */
export function stateFile(projectKey: string): string {
  return join(teamflowRoot(), projectKey, 'state.json')
}

/** 读取（不存在返回空态）。 */
export function loadState(projectKey: string): TeamflowState {
  const file = stateFile(projectKey)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<TeamflowState>
      const base = emptyState()
      if (raw && typeof raw === 'object') {
        base.projectName = raw.projectName ?? null
        base.updatedAt = raw.updatedAt ?? null
        base.product = { ...base.product, ...raw.product }
        base.lastRunFolder = raw.lastRunFolder ?? null
        base.modules = raw.modules || {}
        base.verifyScripts = Array.isArray(raw.verifyScripts) ? raw.verifyScripts : []
        base.acIndex = raw.acIndex || {}
        base.openQuestions = normalizeOpenQuestions(raw.openQuestions)
        base.stages = raw.stages || {}
        base.lastRun = raw.lastRun ?? null
        // **gitMode 必须显式搬运**（2026-09-18 实锤修复）：本函数是**逐字段白名单重建**（不是整体读取），
        // 漏一个字段 = 该字段永远存不住。实测 `tf-mu6tb281`：pipeline 明写 `st.gitMode='repo'; saveState(...)`
        // （日志也有「改动存档已开启」），但**任何一次阶段 state 块合并**（`mergeStateBlock` 走 load→save）
        // 都会把它丢掉 → 下次 run 又从头问一遍「要不要开启改动存档」——用户当初要的「答案记住、后续不再问」
        // 整条失效。这类"白名单漏字段"已第四次（B1 同型：execOptions/journal.options/loadState）。
        // **门禁**：`test/state.test.js` 静态解析本接口的顶层键，逐个断言在本函数里被搬运（新增字段漏了就红）。
        if (raw.gitMode === 'repo' || raw.gitMode === 'none') base.gitMode = raw.gitMode
        return base
      }
    }
  } catch (e) { /* 损坏回空态 */ }
  return emptyState()
}

/** 保存。 */
export function saveState(projectKey: string, state: TeamflowState): boolean {
  const file = stateFile(projectKey)
  try {
    mkdirSync(join(teamflowRoot(), projectKey), { recursive: true })
    state.updatedAt = Date.now()
    writeFileSync(file, JSON.stringify(state, null, 2), 'utf8')
    return true
  } catch (e) {
    console.error('[teamflow] saveState failed', e?.message)
    return false
  }
}

/** 从阶段产出文本中提取 `<!-- state -->{...}<!-- /state -->` 块（找不到返回 null）。 */
export function extractStateBlock(text: unknown): StageStateBlock | null {
  const s = text === null || text === undefined ? '' : String(text)
  const m = s.match(/<!--\s*state\s*-->([\s\S]*?)(?:<!--\s*\/state\s*-->|$)/)
  if (!m || !m[1]) return null
  try {
    const raw = JSON.parse(m[1].trim())
    if (raw && typeof raw === 'object') return raw as StageStateBlock
  } catch (e) { /* 非 JSON 忽略 */ }
  return null
}

/**
 * 从**展示用**文本里剥掉机器可读的 `<!-- state -->…<!-- /state -->` 块。
 *
 * **为什么要剥**（2026-10-08 真机 `tf-muzc59h9-pnbhyk` 用户截图实锤）：state 块是**给 host 的机器契约**，
 * 而它按契约写在子代理的**最终回复**里 ⇒ 会随子代理原文一路进**用户可见面**：
 * 子任务卡 `summary`、事件时间线、失败详情浮层 —— 把一大段 JSON 摊在用户眼前（`{"phase":"qa",…}`）。
 *
 * ⚠️ **只剥展示面，不动机器面**：`extractStateBlock` 仍读**原始**文本；块的内容已按契约落进
 * `state.json`，所以剥掉它不丢信息（不违反「不许静默丢东西」）。
 *
 * ⚠️ **要求成对的关闭标签才剥**（比 `extractStateBlock` 更保守）：那里缺关闭标签时按「到结尾」处理
 * （为了尽量取到状态），但剥展示文本若也这么做，会**吃掉**关闭标签之后可能存在的正常正文。
 * 缺关闭标签 ⇒ 不剥 ⇒ 那个块**留在可见面上**，正好把「契约被违反」暴露出来（与「空值必须可见」同源）。
 */
export function stripStateBlock(text: unknown): string {
  const s = text === null || text === undefined ? '' : String(text)
  if (!s || s.indexOf('<!--') < 0) return s // 快路径：绝大多数文本不含块
  return s.replace(/<!--\s*state\s*-->[\s\S]*?<!--\s*\/state\s*-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 把阶段产出的 state 块合并进 state.json。 */
export function mergeStateBlock(projectKey: string, block: StageStateBlock, phase?: string): TeamflowState {
  const state = loadState(projectKey)
  const key = (block && block.phase) || phase || 'other'
  if (block) {
    if (typeof block.summary === 'string' && block.summary.trim()) state.stages[key] = block.summary.trim()
    if (Array.isArray(block.touched)) {
      for (const f of block.touched) {
        if (typeof f === 'string' && f) state.modules[f] = state.modules[f] || 'touched'
      }
    }
    if (typeof block.verdict === 'string' && block.verdict) {
      state.lastRun = state.lastRun || {}
      state.lastRun.verdict = block.verdict
    }
    if (block.extra && typeof block.extra === 'object') {
      if (Array.isArray(block.extra.verifyScripts)) {
        for (const s of block.extra.verifyScripts) if (typeof s === 'string' && s && state.verifyScripts.indexOf(s) === -1) state.verifyScripts.push(s)
      }
      if (block.extra.acIndex && typeof block.extra.acIndex === 'object') state.acIndex = { ...state.acIndex, ...block.extra.acIndex }
      // 产品一句话（确认单 ADR-0011 ① 的目标来源）：`prdPrompt` 早已要求 extra.summary，
      // 但此前**从未落盘** ⇒ 确认单只能去抽模型自由写的段落标题（不可靠）。此处补齐落点。
      if (typeof block.extra.summary === 'string' && block.extra.summary.trim()) state.product.summary = block.extra.summary.trim()
      // 结构化待澄清项（ADR-0011 ①）：PRD 是本次 run 的权威 ⇒ **整组替换**（不累加，
      // 否则上一轮的遗留问题会一直挂在确认单上）。缺该键则保持原值。
      if (Array.isArray(block.extra.openQuestions)) state.openQuestions = normalizeOpenQuestions(block.extra.openQuestions)
      if (typeof block.extra.techStack === 'string' && block.extra.techStack) state.product.techStack = block.extra.techStack
      if (typeof block.extra.moduleContracts === 'object' && block.extra.moduleContracts) state.modules = { ...state.modules, ...block.extra.moduleContracts }
    }
  }
  saveState(projectKey, state)
  return state
}

/** 按 run 更新 lastRun / lastRunFolder（finally 时调用）。 */
export function noteRun(
  projectKey: string,
  run: { id?: string; requirement?: string; verdict?: string; endedAt?: number; runDocs?: string | null },
): void {
  const state = loadState(projectKey)
  if (run.runDocs) state.lastRunFolder = run.runDocs
  state.lastRun = {
    runId: run.id || null,
    requirement: run.requirement ? String(run.requirement).slice(0, 200) : null,
    verdict: run.verdict || null,
    folder: run.runDocs || null,
    endedAt: run.endedAt ?? Date.now(),
  }
  saveState(projectKey, state)
}

/** 按角色渲染 state slice（注入到子代理 prompt）。角色 → 只拿相关片段。
 * 语言：读 `state.__runCtx.locale`（由 pipeline 按 run 快照写入；缺省/历史缺字段 → zh，逐字不变）。 */
/**
 * 需要看到 M1 架构蓝图的角色：
 * - `dev` 依它实现（模块划分 / 装配顺序 / api 逐字调用）
 * - `qa` / `acceptance` 依它**核对**（接口一致性、模块是否按计划抽取）
 *
 * ⚠️ 2026-09-29 修：此前白名单只有 arch/tech/dev，而 `qaPrompt` 的 0a「接口一致性核对」与
 * `acceptancePrompt` 的模块抽取核对都写成 "if the injected blueprint JSON is present" ——
 * 条件**永远为假**，QA 只能退回 ARCHITECTURE.md 猜契约（观察期 run tf-muliqvaq 的 QA 报告
 * 自己点出了「本阶段上下文未注入 <!-- blueprint --> JSON」）。
 */
const BLUEPRINT_ROLES: readonly string[] = ['arch', 'tech', 'dev', 'qa', 'acceptance']

export function stateSliceFor(state: TeamflowState, role: RoleKey): string {
  const locale = runCtxLocale(state)
  const lines: string[] = []
  // 本次 run 注入上下文（任务夹路径 + M0 状态核对 + M1 架构蓝图）：所有角色都先看到
  if (state.__runCtx) {
    if (state.__runCtx.runDocs) lines.push(t(locale, 'state.runDocs', { docs: state.__runCtx.runDocs }))
    if (state.__runCtx.sanity) lines.push(state.__runCtx.sanity)
    if (state.__runCtx.blueprint && BLUEPRINT_ROLES.includes(role)) lines.push(state.__runCtx.blueprint)
  }
  lines.push(t(locale, 'state.header'))
  if (state.product.summary) lines.push(t(locale, 'state.productSummary', { summary: state.product.summary }))
  if (state.product.techStack && (role === 'tech' || role === 'dev' || role === 'arch')) lines.push(t(locale, 'state.techStack', { stack: state.product.techStack }))
  if (Object.keys(state.acIndex).length && (role === 'pm' || role === 'qa' || role === 'acceptance' || role === 'tech')) {
    const acs = Object.entries(state.acIndex).slice(0, 40)
    lines.push(t(locale, 'state.acIndex', { n: acs.length, list: acs.map(([k, v]) => `${k} ${v}`).join(t(locale, 'state.listSep')) }))
  }
  if (Object.keys(state.modules).length && (role === 'tech' || role === 'dev' || role === 'arch' || role === 'qa')) {
    lines.push(t(locale, 'state.modules', { n: Object.keys(state.modules).length, list: Object.entries(state.modules).map(([f, c]) => `${f}${c ? '→' + c : ''}`).join(t(locale, 'state.commaSep')) }))
  }
  if (state.verifyScripts.length && (role === 'qa' || role === 'tech' || role === 'dev')) {
    lines.push(t(locale, 'state.verifyScripts', { list: state.verifyScripts.join(t(locale, 'state.commaSep')) }))
  }
  // 交付形态契约 → QA/验收（2026-09-17）：形态契约在 PRD 已落成 AC，但 QA/验收需要**可执行判据**——
  // 每条契约的 criteria 就是探针清单（装得上/被加载/构建产物新鲜/卸载回滚），缺它 QA 只能凭自觉。
  if (state.__runCtx && Array.isArray(state.__runCtx.artifactContracts) && state.__runCtx.artifactContracts.length && (role === 'qa' || role === 'acceptance')) {
    const kind = state.__runCtx.artifact || 'other'
    lines.push(t(locale, 'state.artifactContracts', {
      kind,
      n: state.__runCtx.artifactContracts.length,
      list: state.__runCtx.artifactContracts.map((it, i) => `${i + 1}. ${it.requirement} — ${it.criteria}`).join('\n'),
    }))
  }
  // 各阶段结论：本角色只需要前后几段
  if (role === 'pm' || role === 'acceptance') {
    if (state.stages.prd) lines.push(t(locale, 'state.prdSummary', { summary: state.stages.prd }))
    if (state.stages.tech) lines.push(t(locale, 'state.techSummary', { summary: state.stages.tech }))
    if (state.stages.qa) lines.push(t(locale, 'state.qaSummary', { summary: state.stages.qa }))
  } else if (role === 'dev' || role === 'tech') {
    if (state.stages.tech) lines.push(t(locale, 'state.techSummary', { summary: state.stages.tech }))
    if (state.stages.prd) lines.push(t(locale, 'state.prdSummary', { summary: state.stages.prd }))
  } else if (role === 'qa') {
    if (state.stages.qa) lines.push(t(locale, 'state.lastQaSummary', { summary: state.stages.qa }))
  }
  if (state.lastRun) {
    const r = state.lastRun
    lines.push(t(locale, 'state.lastRun', {
      requirement: r.requirement ? r.requirement : '',
      verdict: r.verdict ? ' → ' + r.verdict : '',
      folder: r.folder ? t(locale, 'state.lastRunFolder', { folder: r.folder }) : '',
    }))
  }
  return lines.join('\n')
}

/**
 * state 块的**文件通道路径**（工作区相对路径；写进 prompt 用相对、读取时拼 workspace root）。
 *
 * **为什么要有文件通道**（2026-10-08 用户两次实锤）：块原本按契约写在**子代理的最终回复**里
 * ⇒ 它一路进用户可见面 —— 任务卡、时间线、详情浮层（这些我们已在展示侧剥掉），
 * 但还有**宿主自己的「子智能体执行记录」卡**，它直接渲染子代理回复原文，**插件改不了**。
 * ⇒ 唯一根治办法：**让机器契约根本不走人类可读的通道**。
 * 顺带解决一个更根本的问题：`extractStateBlock` 原先要在自然语言里**猜**一段 JSON
 * （markdown 转义 / 代码围栏 / 中途截断都会翻车）⇒ 换成读文件后，这条链从「猜」变成「读」。
 *
 * `suffix` 用于**并发同阶段**（dev 多任务同时跑）区分文件 —— 必须是 ASCII 安全串（如子任务 id `dev-1`）。
 */
export function stateBlockRelPath(runId: string, phase: string, suffix?: string | null): string {
  const s = String(suffix || '').trim()
  return `logs/teamflow/${runId}/state/${phase}${s ? '-' + s : ''}.json`
}

/**
 * 读**文件通道**的 state 块。文件不存在 / 读不出 / JSON 坏 ⇒ `null`（调用方**回落**抽回复文本）。
 * ⚠️ 回落不是可选项：`写在回复里` 是实测 100% 兑现的旧契约（`kind` 6/6），
 * 一次切成文件通道若模型忘写，`openQuestions`/`acIndex`/`touched` 会**整片消失**
 * ⇒ 最坏情况必须只能是「退化成今天的行为 + 一条可数的 warn」，绝不能是静默丢状态。
 */
export function readStateBlockFile(absPath: string): StageStateBlock | null {
  try {
    const txt = readFileSync(absPath, 'utf8')
    return extractStateBlock(txt)
  } catch (e) {
    return null // 文件缺失/权限/坏编码一律回落，不抛
  }
}

/**
 * 让每个阶段把 state 块**写进文件**（不再写进回复正文）。
 *
 * ⚠️ 2026-10-08 改通道：旧文案是「Append one section at the END of your answer」，
 * 那正是块泄漏到用户 UI 的**唯一原因** —— 宿主渲染子代理回复，插件管不到。
 * 现在明确要求：**用文件工具写**，且**回复正文里不许出现这个块**。
 */
export function stateBlockInstruction(relPath: string): string {
  return `\n\n[STATE BLOCK · MACHINE CHANNEL · do NOT put it in your reply] Write the state JSON to \`${relPath}\` with a file-write tool call (create the directory if needed). The host reads it **from disk**; it is not part of your answer.
- The file's entire content is exactly this one-line block (the markers included):
<!-- state -->{"phase":"<stage-key>","summary":"<≤500 chars: this stage's conclusion, useful for the next run>","memory":["<memory points>"],"extra":{<the extra keys YOUR OWN stage rules above name>}}<!-- /state -->
- **Never** echo this block in your reply text, and **never** wrap it in Markdown fences in the file.
- Write the file **before** you finish; if your write fails, say so in your reply (a missing state block is a hard contract violation the host will report).
⚠️ **\`extra\` is required whenever your stage rules above name extra keys** (e.g. prd → \`acIndex\`/\`summary\`/\`techStack\`/\`openQuestions\`; tech → \`verifyScripts\`/\`modules\`; qa → \`verifyScripts\`). The host reads those values from **inside \`extra\`** — writing them flat (or omitting \`extra\`) drops them silently, and no later stage will see them. Omit the \`extra\` key entirely **only** when your rules name no extra fields.`
}
