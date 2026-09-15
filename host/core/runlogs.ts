/**
 * dsh-plugin-teamflow core — 运行日志生命周期（B 方案 2026-09-15）：**日志根离开用户项目**。
 *
 * 【为什么需要】（用户提问：logs/teamflow 什么时候清理？直接放用户项目工作空间会不会有干扰？）
 * 实测规模：`_scratch/slugkit-en` 49 文件/498 KB、本插件仓 136 文件/3.0 MB、`products/tetris`
 * 1042 文件/17.3 MB——**无任何清理逻辑**（grep 全仓 `rmSync|unlinkSync|retention|TTL|cleanup` 零命中），
 * 且文件树遍历类工具（eslint/prettier/IDE 索引/agent 全局 grep/无 .npmignore 的 npm publish）都会看到它。
 *
 * 【为什么不能一步到位写进 $DSH_HOME】子代理受 DSH 文件沙箱约束：`workspace-write` 只允许写
 * **会话工作区 + 平台临时区**，写 `$DSH_HOME` 直接 `FS_SANDBOX_DENIED`。实测（本机 workspace-write，
 * 无升权重试）：子代理写 `C:\Users\<u>\.dsh\teamflow\_probe\a.txt` → New-Item/Set-Content/Get-Content
 * 三步全拒（`Access to the path is denied` + `[sandbox: file access denied under workspace-write mode]`）；
 * 同构命令写会话工作区内 → exit 0。宿主进程不受该沙箱约束（journal/backlog 一直写 `$DSH_HOME`）。
 *
 * 【所以的机制】两段式：子代理在工作区**暂存**（`<workspacePath>/logs/teamflow/<runId>/`，沙箱允许）
 * → run 结束由 host **归档**到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删掉项目内副本。
 * 项目内**只在 run 进行期间**存在，终态不留存；`$DSH_HOME` 侧按 `LOG_ARCHIVE_KEEP` 保留最近 K 次 run。
 *
 * 【归档只留「有用的」（2026-09-15 二审）】实测这批文件 93% 是可重跑的命令输出或 git 里就有的源码快照，
 * 归档前按白名单过滤：**只留检查脚本/笔记（code 扩展名）+ captures.json**，命令输出与快照一律丢弃
 * （依据见 `KEEP_EXT` 注释）。命令输出在运行期仍有价值——它把几百行输出挡在上下文之外（TOKEN_HYGIENE）。
 *
 * 【自愈】崩溃/被 kill 的 run 走不到 finally → 下次在同工作区起跑时 `sweepWorkspaceLogs` 先把残留
 * 暂存目录与散落文件（历史版本的 `<runId>.log` 直接落在暂存根下）逐个归档走（按名字当 runId 归档，
 * 不丢内容），再淘汰超额归档。**正在运行的 run 一律跳过**。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { JournalRecord } from '../../store.ts'
import { logsArchiveRoot, runLogArchiveDir, runLogStagingDir } from '../../store.ts'
import { LOG_ARCHIVE_KEEP, TF_LOG_DIR } from '../constants.ts'
import { t, type HostLocale } from '../locales.ts'
import { runs } from './context.ts'

/** 工作区内暂存根：`<workspacePath>/logs/teamflow`（无 workspacePath → null）。 */
export function stagingRoot(workspacePath: string | null | undefined): string | null {
  return workspacePath ? join(workspacePath, TF_LOG_DIR) : null
}

/** 目录名白名单（防异常目录名被当作路径段使用）。 */
const SAFE_NAME = /^[A-Za-z0-9._-]+$/

function errText(e: unknown): string {
  return String((e && (e as Error).message) || e)
}

function note(journal: JournalRecord, level: 'info' | 'warn', message: string): void {
  try {
    if (!Array.isArray(journal.logs)) journal.logs = []
    journal.logs.push({ t: Date.now(), level, message })
  } catch (e) { /* 日志记录失败不影响归档本身 */ }
}

/** 目录下的子目录名（不存在/不可读/非白名单名 → 跳过；永不抛）。 */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_NAME.test(d.name) && d.name !== '.' && d.name !== '..')
      .map((d) => d.name)
  } catch (e) { return [] }
}

/** 暂存根下的散落文件（历史版本 host 直接写 `<runId>.log`、人工笔记等；同样是插件命名空间内的噪音）。 */
function looseFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && SAFE_NAME.test(d.name))
      .map((d) => d.name)
  } catch (e) { return [] }
}

/**
 * 归档保留白名单（2026-09-15 二审：维护者指出「logs 里的文件基本没用」——实测**确实如此**）。
 *
 * 实测一次真实 run（`tf-mu2ioilr-95l4th`，130 文件 / 3.03 MB）的构成：
 * - 41% 命令输出（`regression-*.log` 5 个 859 KB + `*.out` 23 个 309 KB）——**可重跑**；
 * - 35% 源码快照（`probe/head/**`、`scripts/_head-*.ts` 等 48 个 `.ts`/`.tsx` 共 ~1.0 MB）——**仓库/git 里就有**；
 * - 17% prompt before/after JSON dump（508 KB，由已被保留的 .cjs 重新生成）；
 * - 7% 一次性校验脚本与合并提交信息（`*.mjs` 184 KB + `.md`/`.txt`）——**唯一不可重跑、且真被用过的部分**
 *   （本轮 r9 的人工验收探针、缺陷回填/关单脚本、幻影缺陷回放脚本都在其中）。
 *
 * 结论：命令输出与快照是**运行期的上下文卫生手段**（把几百行输出挡在上下文之外），不是审计资产——
 * 审计资产是「你查了什么、怎么查的」（脚本本身 + 回复里的 `[Verification evidence]` 块，后者已随
 * journal 落盘并在工作台可见）。故归档 = **只留可重跑/人可读的代码与笔记**：
 * 代码/脚本扩展名 + `captures.json`（命令载荷汇总）；`*.log`/`*.out`/`*.txt`/快照一律丢弃。
 */
const KEEP_EXT = /\.(mjs|cjs|js|md|sh|ps1|py)$/i
/** 命令载荷汇总（小、结构化、prompt 明确要求合并写这一个文件）。 */
const KEEP_NAME = 'captures.json'

/** 相对路径是否属于归档保留面（按文件名判定：code/notes 保留，输出/快照丢弃）。 */
export function keepInArchive(rel: string): boolean {
  const base = String(rel || '').split(/[\\/]/).pop() || ''
  return base.toLowerCase() === KEEP_NAME || KEEP_EXT.test(base)
}

/** 递归收集目录内的相对文件路径（不可读 → 空数组）。 */
function relFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []
  try {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name
      if (d.isDirectory()) out.push(...relFiles(join(dir, d.name), rel))
      else if (d.isFile()) out.push(rel)
    }
  } catch (e) { /* 读不到的子树跳过 */ }
  return out
}

/** 单文件大小（不可读 → 0）。 */
function sizeOf(file: string): number {
  try { return statSync(file).size } catch (e) { return 0 }
}

/** 空目录回收：暂存 run 目录删除后，空掉的 `logs/teamflow`、`logs/` 一并删除（项目内不留空壳）。 */
function pruneEmptyStaging(workspacePath: string | null | undefined): void {
  const root = stagingRoot(workspacePath)
  if (!root || !workspacePath) return
  try {
    if (existsSync(root) && readdirSync(root).length === 0) rmSync(root, { recursive: true, force: true })
    const parent = join(workspacePath, 'logs')
    if (existsSync(parent) && readdirSync(parent).length === 0) rmSync(parent, { recursive: true, force: true })
  } catch (e) { /* 空目录回收失败无副作用 */ }
}

/** 正在运行的 run 一律不动（归档/淘汰都要跳过——并发 run 或本 run 自身）。 */
function isActiveRun(id: string): boolean {
  const j = runs.get(id) as { status?: string } | undefined
  return !!j && j.status === 'running'
}

/**
 * 把某个 runId 的工作区暂存日志归档到 `$DSH_HOME`：**只留白名单内的文件**（检查脚本/笔记/captures.json），
 * 命令输出与快照丢弃，最后删除源目录（合并语义：同名覆盖、目标多余文件保留，续跑不丢上一轮）。
 * @returns { kept, dropped, bytes }（源目录不存在 → 全 0）。
 */
function archiveOne(journal: JournalRecord, locale: HostLocale): { kept: number; dropped: number; bytes: number } {
  const src = runLogStagingDir(journal)
  const dest = runLogArchiveDir(journal)
  if (!src || !dest || !existsSync(src)) return { kept: 0, dropped: 0, bytes: 0 }
  try {
    let kept = 0
    let dropped = 0
    let bytes = 0
    for (const rel of relFiles(src)) {
      const abs = join(src, rel)
      if (!keepInArchive(rel)) {
        dropped++
        bytes += sizeOf(abs)
        continue
      }
      const target = join(dest, rel)
      mkdirSync(dirname(target), { recursive: true })
      cpSync(abs, target, { force: true })
      kept++
    }
    rmSync(src, { recursive: true, force: true })
    const kb = Math.round(bytes / 1024)
    if (kept > 0) note(journal, 'info', t(locale, 'log.logsArchived', { n: kept, dir: dest, keep: LOG_ARCHIVE_KEEP, dropped, kb }))
    else if (dropped > 0) note(journal, 'info', t(locale, 'log.logsTrimmed', { dropped, kb }))
    return { kept, dropped, bytes }
  } catch (e) {
    // 归档失败不阻断 run 收尾：暂存目录留在项目里，下次 run 起跑的自愈清扫会再试一次。
    note(journal, 'warn', t(locale, 'log.logsArchiveFail', { msg: errText(e) }))
    return { kept: 0, dropped: 0, bytes: 0 }
  }
}

/**
 * run 终态调用：归档本次 run 的工作区暂存日志（`logs/teamflow/<runId>/` → `$DSH_HOME/.../logs/<runId>/`）。
 * 幂等：源目录已不存在（已归档/本就没有日志）→ 0，不写日志行。
 * @returns 归档保留的文件数（丢弃的命令输出/快照不计入）。
 */
export function archiveRunLogs(journal: JournalRecord, locale: HostLocale = 'zh'): number {
  const r = archiveOne(journal, locale)
  if (r.kept > 0 || r.dropped > 0) pruneEmptyStaging(journal.workspacePath)
  return r.kept
}

/** 归档淘汰：每个工作区只保留最近 `LOG_ARCHIVE_KEEP` 个 run 目录（按 mtime，正在运行的跳过）。 */
export function pruneLogArchives(journal: JournalRecord, locale: HostLocale = 'zh'): number {
  const root = logsArchiveRoot(journal)
  if (!root || !existsSync(root)) return 0
  let entries: Array<{ name: string; mtime: number }> = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && SAFE_NAME.test(d.name) && d.name !== '.' && d.name !== '..')
      .map((d) => {
        let mtime = 0
        try { mtime = statSync(join(root, d.name)).mtimeMs } catch (e) { /* 用 0 兜底 → 最旧优先被淘汰 */ }
        return { name: d.name, mtime }
      })
  } catch (e) { return 0 }
  const victims = entries
    .sort((a, b) => b.mtime - a.mtime)
    .slice(LOG_ARCHIVE_KEEP)
    .filter((e) => !isActiveRun(e.name))
  let pruned = 0
  for (const v of victims) {
    try { rmSync(join(root, v.name), { recursive: true, force: true }); pruned++ } catch (e) { /* 淘汰失败无副作用 */ }
  }
  if (pruned > 0) note(journal, 'info', t(locale, 'log.logsPruned', { n: pruned, keep: LOG_ARCHIVE_KEEP }))
  return pruned
}

/**
 * 归档散落文件（历史版本 host 把日志写成 `<runId>.log` 直接落在暂存根下；也可能有人工笔记）。
 * 同样走白名单：`*.md`/脚本 → 搬到 `logs/<stem>/<原名>`；`<runId>.log` 这类命令输出 → **直接丢弃**
 * （内容与 `runs/<runId>.json` 的 journal.logs 同源，归档只是重复）。本次/活跃 run 的文件不动。
 * 不写 journal 日志行（由调用方汇总成一条，避免每文件一行噪音）。
 */
function archiveLooseFile(journal: JournalRecord, root: string, name: string, locale: HostLocale): { kept: number; dropped: number; bytes: number } {
  const archiveRoot = logsArchiveRoot(journal)
  const src = join(root, name)
  const stem = name.replace(/\.[^.]+$/, '') || name
  if (!archiveRoot || !SAFE_NAME.test(stem) || stem === journal.id || isActiveRun(stem)) return { kept: 0, dropped: 0, bytes: 0 }
  const size = sizeOf(src)
  try {
    if (!keepInArchive(name)) {
      rmSync(src, { force: true })
      return { kept: 0, dropped: 1, bytes: size }
    }
    const target = join(archiveRoot, stem, name)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(src, target, { force: true })
    rmSync(src, { force: true })
    return { kept: 1, dropped: 0, bytes: 0 }
  } catch (e) {
    note(journal, 'warn', t(locale, 'log.logsArchiveFail', { msg: errText(e) }))
    return { kept: 0, dropped: 0, bytes: 0 }
  }
}

/**
 * run 起跑调用：清理工作区里**残留的**暂存日志（上次崩溃/被 kill/早退留下的目录与散落文件），
 * 按同一白名单归档/丢弃，然后淘汰超额归档。正在运行的 run 与本次 run 自己的东西一律不动。
 * @returns swept = 处理掉的残留项数（目录 + 文件），pruned = 淘汰的归档数。
 */
export function sweepWorkspaceLogs(journal: JournalRecord, locale: HostLocale = 'zh'): { swept: number; pruned: number } {
  const root = stagingRoot(journal.workspacePath)
  let swept = 0
  let dropped = 0
  let bytes = 0
  if (root && existsSync(root)) {
    for (const id of subdirs(root)) {
      if (id === journal.id || isActiveRun(id)) continue
      // 以目录名当 runId 归档：即使原作 journal 已不在，内容也随目录名落到对应归档位。
      const r = archiveOne({ ...journal, id } as JournalRecord, locale)
      if (r.kept > 0 || r.dropped > 0) swept++
      dropped += r.dropped
      bytes += r.bytes
    }
    for (const name of looseFiles(root)) {
      const r = archiveLooseFile(journal, root, name, locale)
      if (r.kept > 0 || r.dropped > 0) swept++
      dropped += r.dropped
      bytes += r.bytes
    }
    if (swept > 0) pruneEmptyStaging(journal.workspacePath)
  }
  const pruned = pruneLogArchives(journal, locale)
  if (swept > 0) note(journal, 'info', t(locale, 'log.logsSwept', { n: swept, dropped, kb: Math.round(bytes / 1024) }))
  return { swept, pruned }
}
