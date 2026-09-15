/**
 * dsh-plugin-teamflow core — 团队注册表（多团队配置管理）。
 * 每个 workspace 一份 teams.json，定义可用团队及其流水线配置。
 * TeamRegistry 负责加载/解析/提供团队配置。
 */
import { join, dirname } from 'node:path'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { teamflowRoot } from '../../store.ts'

/** 团队阶段定义。 */
export interface TeamStage {
  key: string
  label: string
  role: string
  optional?: boolean
  promptKey?: string
}

/** 团队配置。 */
export interface TeamConfig {
  id: string
  /** 中文展示名（同时是存量 teams.json 的兼容字段）。 */
  name: string
  /** 英文展示名（可选；缺省时内置团队按 id 回落，见 `teamNameOf`）。 */
  nameEn?: string
  icon: string
  /** 中文描述。 */
  description: string
  /** 英文描述（可选，规则同 `nameEn`）。 */
  descriptionEn?: string
  stages: TeamStage[]
  mode?: string
  needDesign?: boolean
  needScaffold?: boolean
}

/** 团队配置文件的顶层结构。 */
interface TeamsFile {
  version: number
  teams: TeamConfig[]
}

/** 内置默认团队：软件开发（当前完整流水线）。
 *  ⚠ 双语字段（2026-09-15）：`nameEn`/`descriptionEn` 是**展示名**的英文来源；`name`/`description`
 *  保持中文（zh 展示 + 存量 teams.json 兼容）。**已落盘的 teams.json 不会被改写**（用户数据），
 *  故缺失 `nameEn` 时按团队 id 回落到 `BUILTIN_EN`（见 `teamNameOf`），保证老工作区也能出英文名。 */
const BUILTIN_DEV_TEAM: TeamConfig = {
  id: 'dev',
  name: '软件开发',
  nameEn: 'Software Development',
  icon: '💻',
  description: 'PRD→设计→技术→开发→QA→验收',
  descriptionEn: 'PRD → design → tech → dev → QA → acceptance',
  stages: [
    { key: 'prd', label: 'PRD 产品需求', role: '产品经理', promptKey: 'prd' },
    { key: 'design', label: 'UI/UX 设计', role: 'UI/UX 设计师', optional: true, promptKey: 'design' },
    { key: 'scaffold', label: '架构规划', role: '架构师', optional: true, promptKey: 'scaffold' },
    { key: 'tech', label: '技术方案', role: '高级全栈工程师', promptKey: 'tech' },
    { key: 'dev', label: '开发', role: '高级全栈工程师', promptKey: 'dev' },
    { key: 'qa', label: 'QA 测试', role: 'QA 测试工程师', promptKey: 'qa' },
    { key: 'acceptance', label: '产品验收', role: '产品经理', promptKey: 'acceptance' },
  ],
  mode: 'auto',
}

/** 内置团队 id → 英文展示名（存量 teams.json 没有 nameEn 字段时的回落表）。 */
const BUILTIN_EN: Record<string, { name: string; description: string }> = {
  dev: { name: 'Software Development', description: 'PRD → design → tech → dev → QA → acceptance' },
}

/**
 * 团队展示名（按语言取值）：en 优先 `nameEn` → 内置回落表 → 中文 `name`（**永不返回空**）。
 * @param locale - 展示语言（host 侧用 run 快照或环境语言；client 侧由 host 直接下发已本地化的值）。
 */
export function teamNameOf(locale: string, team: TeamConfig | null | undefined): string {
  if (!team) return ''
  if (locale === 'en') return team.nameEn || BUILTIN_EN[team.id]?.name || team.name || team.id || ''
  return team.name || team.id || ''
}

/** 团队描述（按语言取值，规则同 {@link teamNameOf}）。 */
export function teamDescOf(locale: string, team: TeamConfig | null | undefined): string {
  if (!team) return ''
  if (locale === 'en') return team.descriptionEn || BUILTIN_EN[team.id]?.description || team.description || ''
  return team.description || ''
}

/** 默认团队配置文件内容。 */
const DEFAULT_TEAMS_FILE: TeamsFile = {
  version: 1,
  teams: [BUILTIN_DEV_TEAM],
}

/** 获取团队配置文件路径。 */
function teamsFile(projectKey: string): string {
  return join(teamflowRoot(), projectKey, 'teams.json')
}

/** 加载团队配置。不存在时创建默认。 */
export function loadTeams(projectKey: string): TeamConfig[] {
  const file = teamsFile(projectKey)
  try {
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as TeamsFile
      if (raw && Array.isArray(raw.teams)) return raw.teams
    }
  } catch (e) { /* 解析失败走默认 */ }
  // 创建默认配置
  saveTeams(projectKey, DEFAULT_TEAMS_FILE.teams)
  return DEFAULT_TEAMS_FILE.teams
}

/** 保存团队配置。 */
export function saveTeams(projectKey: string, teams: TeamConfig[]): void {
  const file = teamsFile(projectKey)
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ version: 1, teams }, null, 2), 'utf8')
  } catch (e) { /* 写入失败静默 */ }
}

/** 从团队列表中查找指定 id 的团队。 */
export function findTeam(teams: TeamConfig[], teamId: string): TeamConfig | undefined {
  return teams.find((t) => t.id === teamId)
}

/** 获取团队的可运行阶段（过滤掉 optional 且未启用的）。 */
export function getActiveStages(team: TeamConfig, options?: { needDesign?: boolean; needScaffold?: boolean }): TeamStage[] {
  return team.stages.filter((s) => {
    if (!s.optional) return true
    if (s.key === 'design') return !!options?.needDesign
    if (s.key === 'scaffold') return !!options?.needScaffold
    return false
  })
}

/** 导出内置团队定义（供 UI 和描述符使用）。 */
export { BUILTIN_DEV_TEAM }
