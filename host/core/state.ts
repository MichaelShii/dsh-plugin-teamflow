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
import { teamflowRoot } from '../../store.ts'
import type { RoleKey } from '../constants.ts'
import { t } from '../locales.ts'
import { runCtxLocale } from './locale.ts'

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
  } | null
  /** **版本控制模式**（2026-09-17 方案 A：入口定、出口遵）：'repo'=是仓库/已初始化（出口正常收口提交）；
   *  'none'=用户明确选择不用版本控制（出口**不尝试提交**，汇报明写"未存档"）。缺省=未知（按旧逻辑探测）。 */
  gitMode?: 'repo' | 'none'
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
        base.product = { ...base.product, ...(raw.product || {}) }
        base.lastRunFolder = raw.lastRunFolder ?? null
        base.modules = raw.modules || {}
        base.verifyScripts = Array.isArray(raw.verifyScripts) ? raw.verifyScripts : []
        base.acIndex = raw.acIndex || {}
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
      if (typeof block.extra.techStack === 'string' && block.extra.techStack) state.product.techStack = block.extra.techStack
      if (typeof block.extra.moduleContracts === 'object' && block.extra.moduleContracts) state.modules = { ...state.modules, ...block.extra.moduleContracts }
    }
  }
  saveState(projectKey, state)
  return state
}

/** 按 run 更新 lastRun / lastRunFolder（finally 时调用）。 */
export function noteRun(projectKey: string, run: { id?: string; requirement?: string; verdict?: string; endedAt?: number; runDocs?: string | null }): void {
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
export function stateSliceFor(state: TeamflowState, role: RoleKey): string {
  const locale = runCtxLocale(state)
  const lines: string[] = []
  // 本次 run 注入上下文（任务夹路径 + M0 状态核对 + M1 架构蓝图）：所有角色都先看到
  if (state.__runCtx) {
    if (state.__runCtx.runDocs) lines.push(t(locale, 'state.runDocs', { docs: state.__runCtx.runDocs }))
    if (state.__runCtx.sanity) lines.push(state.__runCtx.sanity)
    if (state.__runCtx.blueprint && (role === 'arch' || role === 'tech' || role === 'dev')) lines.push(state.__runCtx.blueprint)
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

/** 让每个阶段产出末尾附带 state 块（将并入 stage output，由 host 提取）。 */
export const STATE_BLOCK_INSTRUCTION = `\n\n[STATE BLOCK · mandatory at the end] Append one section at the END of your answer (same output as the body; the host indexes it):
<!-- state -->{"phase":"<stage-key>","summary":"<≤500 chars: this stage's conclusion, useful for the next run>","memory":["<memory points>"]}<!-- /state -->`
