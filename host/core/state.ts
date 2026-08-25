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
  } | null
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

/** 按角色渲染 state slice（注入到子代理 prompt）。角色 → 只拿相关片段。 */
export function stateSliceFor(state: TeamflowState, role: 'pm' | 'design' | 'arch' | 'tech' | 'dev' | 'qa' | 'acceptance'): string {
  const lines: string[] = []
  // 本次 run 注入上下文（任务夹路径 + M0 状态核对 + M1 架构蓝图）：所有角色都先看到
  if (state.__runCtx) {
    if (state.__runCtx.runDocs) lines.push(`【本次任务产物夹】${state.__runCtx.runDocs}/（host 已创建；本需求的 PRD/TECHNICAL/QA-REPORT/ACCEPTANCE 全部写这里，夹建后不可变、不归档不升版）`)
    if (state.__runCtx.sanity) lines.push(state.__runCtx.sanity)
    if (state.__runCtx.blueprint && (role === 'arch' || role === 'tech' || role === 'dev')) lines.push(state.__runCtx.blueprint)
  }
  lines.push('【预编译产品状态（state.json · 权威记忆在 docs/teamflow/memory.md，本块已是够用的索引，勿再全量读历史文档）】')
  if (state.product.summary) lines.push(`- 产品概要：${state.product.summary}`)
  if (state.product.techStack && (role === 'tech' || role === 'dev' || role === 'arch')) lines.push(`- 技术栈：${state.product.techStack}`)
  if (Object.keys(state.acIndex).length && (role === 'pm' || role === 'qa' || role === 'acceptance' || role === 'tech')) {
    const acs = Object.entries(state.acIndex).slice(0, 40)
    lines.push(`- AC 索引（${acs.length} 条）：${acs.map(([k, v]) => `${k} ${v}`).join('；')}`)
  }
  if (Object.keys(state.modules).length && (role === 'tech' || role === 'dev' || role === 'arch' || role === 'qa')) {
    lines.push(`- 模块（${Object.keys(state.modules).length}）：${Object.entries(state.modules).map(([f, c]) => `${f}${c ? '→' + c : ''}`).join('，')}`)
  }
  if (state.verifyScripts.length && (role === 'qa' || role === 'tech' || role === 'dev')) {
    lines.push(`- 验证脚本：${state.verifyScripts.join('，')}`)
  }
  // 各阶段结论：本角色只需要前后几段
  if (role === 'pm' || role === 'acceptance') {
    if (state.stages.prd) lines.push(`- PRD 摘要：${state.stages.prd}`)
    if (state.stages.tech) lines.push(`- 技术方案摘要：${state.stages.tech}`)
    if (state.stages.qa) lines.push(`- QA 摘要：${state.stages.qa}`)
  } else if (role === 'dev' || role === 'tech') {
    if (state.stages.tech) lines.push(`- 技术方案摘要：${state.stages.tech}`)
    if (state.stages.prd) lines.push(`- PRD 摘要：${state.stages.prd}`)
  } else if (role === 'qa') {
    if (state.stages.qa) lines.push(`- 上轮 QA 摘要：${state.stages.qa}`)
  }
  if (state.lastRun) {
    const r = state.lastRun
    lines.push(`- 上轮：${r.requirement ? r.requirement : ''}${r.verdict ? ' → ' + r.verdict : ''}${r.folder ? `（${r.folder}）` : ''}`)
  }
  return lines.join('\n')
}

/** 让每个阶段产出末尾附带 state 块（将并入 stage output，由 host 提取）。 */
export const STATE_BLOCK_INSTRUCTION = `\n\n【State 沉淀 · 结尾必须输出】在回答末尾追加一段（供索引复用，与正文同一份输出即可）：
<!-- state -->{"phase":"<阶段key>","summary":"<≤500字本阶段结论，受益于下一轮>","memory":["<记忆要点>"]}<!-- /state -->`
