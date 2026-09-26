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
import { t, type HostLocale } from '../locales.ts'
import { TF_LOG_DIR } from '../constants.ts'

/** 单条 git 命令的结构化结果：`ok=false` 时 `error` 带真实原因（截断到 300 字符）。 */
export interface GitResult {
  ok: boolean
  /** 成功时的 stdout（已 trim）。 */
  out: string
  /** 失败原因（stderr + stdout + message 拼接；成功为 null）。 */
  error: string | null
}

/** git 失败原因的截断长度（进日志/journal，避免把整段 stderr 灌进去）。 */
const GIT_ERR_MAX = 300

/**
 * 跑一条 git 命令并**保留失败原因**。
 *
 * 为什么必须有这个版本（2026-09-15 实锤）：旧 `gitCmd` 把异常一律吞成 `null`，而收口提交处
 * `add === null ? null : git commit(...)` 用它做短路条件 —— `tfAddArgs()` 的负 pathspec
 * 点名了被 `.gitignore` 忽略的路径（`logs/teamflow`），git 退出 1（**索引其实已经写好**），
 * 于是提交被静默跳过，且 `commitDone`/`commitSkip`/`commitFail` **三条日志一条都不触发**：
 * 2026-09-11 → 09-15 四个 run 全部「跑完了但没提交」，日志上看不出任何异常。
 * 结论：失败可以处置，但不能不可见。
 */
export function gitRun(cwd: string, args: string[], timeoutMs = 8000): GitResult {
  try {
    const out = execFileSync('git', args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true }).trim()
    return { ok: true, out, error: null }
  } catch (e) {
    const err = (e || {}) as { stdout?: unknown; stderr?: unknown; message?: unknown }
    const pick = (v: unknown): string => (typeof v === 'string' ? v.trim() : v && typeof v === 'object' ? String(v).trim() : '')
    const detail = [pick(err.stderr), pick(err.stdout), pick(err.message)].filter(Boolean).join(' | ')
    return { ok: false, out: '', error: (detail || 'git failed').slice(0, GIT_ERR_MAX) }
  }
}

/**
 * 兼容既有调用点的薄封装：失败返回 `null`（调用方降级）。
 * **新代码请用 `gitRun`**——只有它能拿到失败原因，用于把故障写进日志而不是静默跳过。
 */
export function gitCmd(cwd: string, args: string[], timeoutMs = 8000): string | null {
  const r = gitRun(cwd, args, timeoutMs)
  return r.ok ? r.out : null
}

/**
 * TeamFlow 自有日志命名空间（工作区相对路径，定义在 `constants.ts`，此处转出供既有调用点/测试引用）。
 *
 * 为什么单独拎出来：prompts 强制子代理把命令输出与临时验证脚本写进这里（Log discipline / TOKEN_HYGIENE），
 * 而 prompts 的资源表同时把它定性为**非交付物**（「运行日志 … 日常不读」）。也就是说这批文件是插件
 * 自己必然生产、且自己声明不该交付的东西——绝不能靠目标仓库的 .gitignore 兜底。
 * 实锤 assetd `tf-mtwvwpxa-p3vw08`：收口提交 227 个文件里 **208 个（92%）** 是这里的内容
 * （100 log / 52 json / 44 临时 .mjs / 5 .cjs，623.8 KB），真交付只有 19 个文件。
 *
 * 2026-09-15（B 方案）后该目录只是**工作区内暂存**：run 结束 host 会归档到 `$DSH_HOME` 并从项目删除；
 * `.gitignore` 幂等补写 + `tfUnstageArgs()` 索引兜底保留，用于「run 进行中用户/子代理提交」这一窗口。
 */
export { TF_LOG_DIR }

/**
 * 插件发起的提交统一走这里。
 *
 * 提交面 = 工作区整树（`-- .` 把范围收敛到项目根，不再波及工作区之外）；自有日志靠
 * **`.gitignore` 幂等补写（保证存在）+ `tfUnstageArgs()` 索引兜底**排除，见下方注释。
 *
 * **为什么不再带 `:(exclude)logs/teamflow`（2026-09-15 实锤，勿回退）**：负 pathspec 会**点名**
 * 那个路径，而 `ensureLogGitignore()` 刚刚把 `logs/teamflow/` 写进 `.gitignore` —— git 对「显式点名
 * 且被忽略」的路径直接**报错退出 1**：
 *   `git add -A -- . ':(exclude)logs/teamflow'`
 *   → exit 1  The following paths are ignored by one of your .gitignore files: logs/teamflow
 * （同一命令在 `.gitignore` 没有该规则时 exit 0 —— 这正是它曾经能用、后来又必然失败的原因；
 * 索引其实已经写好，所以现场表现为「文件已 staged 但没有 commit」。）
 * 换 `:(exclude)logs/teamflow/**` / `:(exclude,glob)` / `:(exclude,literal)` 同样 exit 1（实测四种拼法全失败），
 * `-c advice.addIgnoredFile=false` 也不行（那是 error 不是 advice）。
 * 复现与候选方案矩阵见 `test/commit-path.test.js`（真 git 集成测试，锁死这个坑）。
 */
export function tfAddArgs(excludes: readonly string[] = [], cwd?: string): string[] {
  return ['add', '-A', '--', '.', ...tfExcludePathspecs(excludes, cwd)]
}

/**
 * 冷启动基线提交的**索引层噪音排除**（2026-09-18 方案 B 根治，勿回退为「写用户 .gitignore」）。
 *
 * 为什么存在：`git init` 后第一次 `add -A` 是**整树冷扫描**，pnpm 本地 store / node_modules
 * 在实测里是 549 文件 / 51 MB（probe-clock），默认 8s 超时被直接杀掉 → 基线提交失败。
 *
 * **为什么不再写进 `.gitignore`（用户实锤截图）**：旧实现 `pipeline.ensureCommonNoiseIgnores()`
 * 调 `mergeGitignore(before, ['.pnpm-store/','node_modules/'], 'zh')` —— 而 `mergeGitignore` 的注释
 * 参数是**整批一条**，于是 `.pnpm-store/` 顶着「TeamFlow 运行日志（插件自有产物…）」的文案写进了
 * **用户的 `.gitignore`**。两处错：① 注释张冠李戴；② **越界**——`.gitignore` 是用户的项目资产，
 * 「该忽略什么」属于 L2（PRD 阶段 PM 按技术栈规划）与用户本人，host 只该在**自己那一次 git 调用**上
 * 收敛范围，不该在用户文件里留下任何痕迹。
 *
 * 稳定性依据（temp 仓库实测，见 `test/commit-path.test.js`）：`:(exclude)` 报错退出 1 的**唯一前提**
 * 是该路径**已被 `.gitignore` 忽略**（「显式点名 + 被忽略」）。本清单里的路径**从不写进 .gitignore**，
 * 故恒定 exit 0。运行时另有 `tfExcludePathspecs` 的自检双保险。
 */
export const BASELINE_NOISE_EXCLUDES: readonly string[] = ['.pnpm-store', 'node_modules']

/**
 * 把排除项转成 magic pathspec，并**用 git 自己判断**哪些项不该下发。
 *
 * **为什么必须用 `git check-ignore` 而不是自己读 `.gitignore`（2026-09-18 实测修正，勿回退）**：
 * 初版自检用 `existsSync('.gitignore')` + 正则近似——**相对路径读的是宿主进程的 cwd，不是目标仓库**，
 * 于是两个方向同时错：目标仓库没忽略的项被误拦（排除失效、噪音进索引），目标仓库忽略了的项被误放
 * （点名 + 被忽略 → **exit 1，正是 2026-09-11→09-15「4 天没有任何 run 提交过」那个坑原样复活**）。
 * `git check-ignore` 以**目标仓库为根**、且用 git 自己的规则引擎（通配/取反/嵌套 `.gitignore`/全局
 * excludesfile 全覆盖），是本判据唯一正确的实现。`-q` 只取退出码：0=被忽略，1=未忽略。
 *
 * 兜底方向（宁可不排、不可 exit 1）：git 不可用/异常 → 一律**不下发**该排除项。
 * 代价只是"这次少排一点、add 慢一点"，而失败的代价是**整条提交链路静默失效**——不对称，故从严。
 */
function tfExcludePathspecs(excludes: readonly string[], cwd?: string): string[] {
  const list = excludes.filter((p): p is string => typeof p === 'string' && !!p.trim())
  if (!list.length) return []
  const out: string[] = []
  for (const p of list) {
    const clean = p.replace(/\\/g, '/').replace(/\/+$/, '')
    if (!clean) continue
    if (isIgnoredByGit(clean, cwd)) continue // 已被忽略 → 交给 .gitignore 生效，绝不点名（点名即 exit 1）
    out.push(`:(exclude)${clean}`)
  }
  return out
}

/**
 * `git check-ignore` **三态**判定：`0`=被忽略 / `1`=未忽略 / `-1`=无法判定（git 缺失、不在仓库、超时、
 * 或本机的 spawn 限制）。与 `isIgnoredByGit` 同一判据，但**不把「无法判定」冒充成「被忽略」**——
 * 那正是 2026-09-26 踩到的坑：进程 spawn 不到 git 时 `status` 为 `null`（非 1），布尔版会一律返回 true，
 * 于是「尊重 .gitignore」的实现在判据不可用的环境里退化成「所有交付文档都不入库」，且日志还谎称
 * 「被 .gitignore 忽略」。凡是**丢弃用户东西**的方向，都必须先分清「确实如此」与「没查到」。
 */
function ignoredStateByGit(rel: string, cwd?: string): 0 | 1 | -1 {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], {
      cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 4000, windowsHide: true,
    })
    return 0 // exit 0 = 被忽略
  } catch (e) {
    const code = (e as { status?: number }).status
    if (code === 1) return 1 // 明确未被忽略
    return -1 // 无法判定
  }
}

/** `git check-ignore` 判定（0=被忽略／1=未忽略／其它=无法判定）。无法判定时按「被忽略」处理＝不下发 pathspec。 */
function isIgnoredByGit(rel: string, cwd?: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', rel], {
      cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 4000, windowsHide: true,
    })
    return true // exit 0 = 被忽略
  } catch (e) {
    // exit 1 = 明确未被忽略 → 可安全下发 pathspec（这是唯一允许下发的分支）
    const code = (e as { status?: number }).status
    if (code === 1) return false
    return true // git 缺失/不在仓库/超时 → 无法判定 → 不下发（宁可少排，绝不让 add exit 1）
  }
}

/**
 * 索引兜底：把自有日志从索引里摘掉（**只动索引，不删工作区文件**）。
 *
 * 与 `.gitignore` 补写构成新的两道防线：
 *  ① `pipeline.ensureLogGitignore()` 在 add 之前幂等写规则（正常路径下 logs/teamflow 根本进不了索引）；
 *  ② 本函数紧随 add 执行 —— 规则被用户删掉、或目标仓库 `.gitignore` 写不进去时仍然兜得住（保证）。
 * `--ignore-unmatch` 让「本来就没被跟踪」时也是 exit 0（幂等、可无条件调用）；
 * 不加 `--quiet`：真的摘出东西时 stdout 非空，调用方据此记 warn（说明防线①失效了，要看得见）。
 */
export function tfUnstageArgs(): string[] {
  return ['rm', '-r', '--cached', '--ignore-unmatch', '--', TF_LOG_DIR]
}

/**
 * git 说「没有东西可提交」的判定（提交失败时用它区分「无事可做」与真故障）。
 * 覆盖实测到的三种英文措辞 + 中文 git 兜底；判据只增不改（措辞变化时宁可多报失败，不可少报）。
 * 主路径不依赖它：收口提交先用 `git status --porcelain` 空判定（确定性），这里只兜「索引非空但 commit 仍说没东西」。
 */
export const GIT_NOTHING_TO_COMMIT = /nothing to commit|nothing added to commit|no changes added to commit|working tree clean|无文件要提交|没有要提交|工作区干净/i

/** 任务夹命名空间（ADR-0008：docs/teamflow/<yyyyMMdd-rN-slug>/ 与 memory.md）。 */export const TF_DOCS_DIR = 'docs/teamflow'

/**
 * 交付文档的**入库计划**（2026-09-26 改造：**尊重目标仓库的 `.gitignore`，不再无条件 `-f` 强加**）。
 *
 * 历史：原 `tfDocAddArgs` 对任务夹与 `memory.md` 一律 `add -f`（QA-7：`add -A` 会被目标仓库的
 * `.gitignore` 静默吞掉交付物）。范围控制本身是对的——`-f` 只点名这两个路径，从不会波及别的文件
 * （实测：被忽略的 `.env` 不会被带进提交）。但 `-f` 的语义是「无视用户用 `.gitignore` 表达的意图」，
 * 而本插件自己的仓库忽略 `docs/teamflow/` 的理由恰恰是「含潜在项目信息，勿提交」——
 * 于是**用户在仓库里唯一能表达「别提交」的手段被插件绕过了**，且全程静默（无任何日志）。
 * 这与 `sanity.ts` 已有的纪律同源（「该忽略什么属于用户，host 不该越界」，见 BASELINE_NOISE_EXCLUDES 注释）。
 *
 * 现在：逐路径用 `git check-ignore`（与 `tfExcludePathspecs` 同一判据、同一「以目标仓库为根」的正确性）判断：
 *   - 未被忽略 → 普通 `add --`（不需要 `-f`，本就能进）；
 *   - 已被忽略 → **不入库**，路径进 `ignored`，由调用方记日志（文件仍在工作区，交付物不丢，
 *     QA 的「文件即产物」契约读的是磁盘文件，不依赖 git）。
 * **绝不**放宽为 `add -A` / `add -f -A`（那会把 ignored 的 node_modules/lib/*.tgz 一并拖进提交）。
 *
 * @param cwd 目标仓库根。**不传 = 无法判定**（判据必须以仓库为根，用宿主进程 cwd 会误判，
 *            这正是 2026-09-18 修掉的那个坑）。
 * @returns ignored 只在**确实被 .gitignore 忽略**时非空（可据此如实记日志）；判据不可用时进 `unknown`，
 *          并**仍按入库处理**——「没查到」不等于「用户不想提交」，丢弃交付物的方向必须从严。
 */
export function tfDocAddPlan(
  docPaths: Array<string | null | undefined>,
  cwd?: string,
): { args: string[]; ignored: string[]; unknown: string[] } {
  const paths = docPaths
    .filter((p): p is string => typeof p === 'string' && !!p.trim())
    .map((p) => p.replace(/\\/g, '/').replace(/\/+$/, ''))
  if (!paths.length) return { args: [], ignored: [], unknown: [] }
  const add: string[] = []
  const ignored: string[] = []
  const unknown: string[] = []
  for (const p of paths) {
    const st = cwd ? ignoredStateByGit(p, cwd) : -1
    if (st === 0) { ignored.push(p); continue }
    if (st === -1) unknown.push(p)
    add.push(p)
  }
  return { args: add.length ? ['add', '--', ...add] : [], ignored, unknown }
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
 * @param locale - 输出语言（缺省 zh：存量调用点零改动、zh 文案逐字不变）。
 */
export function runSanityCheck(path: string | null | undefined, locale: HostLocale = 'zh'): SanityCheck {
  const defaultOut: SanityCheck = {
    ok: false, inRepo: false, branch: null, dirty: '', hasDirty: false, recentCommits: '', summary: '',
  }
  if (!path) {
    return { ...defaultOut, summary: t(locale, 'sanity.noPath') }
  }
  const branch = gitCmd(path, ['branch', '--show-current'])
  const status = gitCmd(path, ['status', '--short'])
  if (branch === null && status === null) {
    // git 命令完全不可用（不在仓库 / git 未安装 / 沙箱拦截）
    return { ...defaultOut, summary: t(locale, 'sanity.unavailable') }
  }
  const recent = gitCmd(path, ['log', '--oneline', '-5'])
  const dirty = status || ''
  const dirtyLines = dirty.split('\n').filter(Boolean)
  const summaryParts: string[] = []
  summaryParts.push(t(locale, 'sanity.branch', { branch: branch && branch !== 'HEAD' ? branch : t(locale, 'sanity.detached') }))
  if (dirtyLines.length) {
    summaryParts.push(t(locale, 'sanity.dirty', { n: dirtyLines.length, list: dirtyLines.slice(0, 8).join(t(locale, 'sanity.listSep')), more: dirtyLines.length > 8 ? t(locale, 'sanity.more') : '' }))
  } else {
    summaryParts.push(t(locale, 'sanity.clean'))
  }
  if (recent) {
    summaryParts.push(t(locale, 'sanity.recent', { list: recent.split('\n').slice(0, 3).join(t(locale, 'sanity.listSep')) }))
  }
  return {
    ok: true, inRepo: true, branch: branch && branch !== 'HEAD' ? branch : null,
    dirty, hasDirty: dirtyLines.length > 0, recentCommits: recent || '',
    summary: t(locale, 'sanity.head', { body: summaryParts.join(t(locale, 'sanity.join')) }),
  }
}
