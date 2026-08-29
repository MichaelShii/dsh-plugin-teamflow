/**
 * dsh-plugin-teamflow core — M0 状态核对（sanity check）。
 *
 * 目的（三情况协议）：
 * - 情况一（全新会话）：0 认知 → 核对确认"从零开始"。
 * - 情况二（续会话）：认知大概率过期（多人协作/场外提交/非流水线改动）→ 核对发现预期外变化。
 * - 情况三（新会话处理新需求）：即使共用 state/记忆，仓库也可能被外部改动 → 核对现状。
 *
 * 核心原则：认知资产（索引/记忆/摘要）可复用"减量"，但永不能替代"对代码库当前真实状态的核对"。
 * 本模块在 host 侧直接跑 git（零模型 token、轻量、失败优雅降级为"无法核对"），
 * 产出 externalDiffs 摘要注入到后续所有阶段 prompt。
 */
import { execFileSync } from 'node:child_process'

/** 单条 git 检查结果（失败返回 null，调用方降级）。 */
export function gitCmd(cwd: string, args: string[], timeoutMs = 8000): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }).trim()
  } catch (e) {
    return null
  }
}

/** 状态核对结果。 */
export interface SanityCheck {
  ok: boolean
  /** 是否在 git 仓库内（非仓库/无 git → 无法核对） */
  inRepo: boolean
  /** 当前分支名（或 detached HEAD / 非仓库） */
  branch: string | null
  /** 工作区未提交改动（git status --short 输出，可能为空串） */
  dirty: string
  /** 是否有未提交改动 */
  hasDirty: boolean
  /** 近期场外提交（git log --oneline -5，可能为空） */
  recentCommits: string
  /** 简短人类可读摘要（注入 prompt 用） */
  summary: string
}

/**
 * 跑一次状态核对。
 * @param path - 工作区绝对路径（workspaceScopeOf(agent).path）。
 */
export function runSanityCheck(path: string | null | undefined): SanityCheck {
  const defaultOut: SanityCheck = {
    ok: false, inRepo: false, branch: null, dirty: '', hasDirty: false, recentCommits: '', summary: '',
  }
  if (!path) {
    return { ...defaultOut, summary: '⚠ 无法确定工作区路径，未做状态核对。' }
  }
  const branch = gitCmd(path, ['branch', '--show-current'])
  const status = gitCmd(path, ['status', '--short'])
  if (branch === null && status === null) {
    // git 命令完全不可用（不在仓库 / git 未安装 / 沙箱拦截）
    return { ...defaultOut, summary: '⚠ 状态核对不可用（非 git 仓库或 git 命令被拒），无法确认代码库真实状态。' }
  }
  const recent = gitCmd(path, ['log', '--oneline', '-5'])
  const dirty = status || ''
  const dirtyLines = dirty.split('\n').filter(Boolean)
  const summaryParts: string[] = []
  summaryParts.push(`分支：${branch && branch !== 'HEAD' ? branch : '(detached HEAD / 非分支)'}`)
  if (dirtyLines.length) {
    summaryParts.push(`未提交改动 ${dirtyLines.length} 处：${dirtyLines.slice(0, 8).join('；')}${dirtyLines.length > 8 ? '…' : ''}`)
  } else {
    summaryParts.push('工作区干净（无未提交改动）')
  }
  if (recent) {
    summaryParts.push(`近期提交（可能含场外改动）：${recent.split('\n').slice(0, 3).join('；')}`)
  }
  return {
    ok: true, inRepo: true, branch: branch && branch !== 'HEAD' ? branch : null,
    dirty, hasDirty: dirtyLines.length > 0, recentCommits: recent || '',
    summary: `【状态核对】${summaryParts.join('。')}`,
  }
}
