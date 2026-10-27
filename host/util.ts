/**
 * dsh-plugin-teamflow — 通用纯工具（底座；依赖 constants.ts，无其他依赖）。
 */
import { REFUSAL_PATTERN, STAGE_MIN_LENGTH, DELIVERY_EVIDENCE_PATTERN, DEV_MAX_CONCURRENCY } from './constants.ts'
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { t } from './locales.ts'
import type { HostLocale } from './locales.ts'

export function toText(v) {
  if (v === null || v === undefined) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}
export function clip(text, n) {
  const s = toText(text)
  return s.length > n ? s.slice(0, n) + `\n…[已截断 ${s.length - n} 字符]` : s
}
/** 干净截断（无「已截断」后缀、压平空白）：用于持久化展示字段——截断后缀会烙进数据，实体越存越脏。 */
export function snippet(text, n) {
  return String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim().slice(0, n)
}
export function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n')
}
/**
 * **响应块构成**（失败诊断用，2026-09-26 tf-muigy5eq r12 实踩）。
 *
 * 由来：诊断此前只报 `stopReason`，于是「模型吐完 reasoning 就被服务端收尾、既无正文也无工具调用」
 * 与「provider 报错」在日志里长得一模一样，排查只能去翻子代理的 zstd 会话原始记录（十几分钟）。
 * 这里把 content blocks 压成一行：`reasoning:2472, tool-call, tool-call, text:96`；
 * reasoning/text **带字符长度**（`reasoning:0` 一眼看出该步根本没推理），重复块压成 `tool-callx3`。
 * `no-blocks` = 响应里一个块都没有（与 `empty` 区分：前者是块层面空，后者是块存在但内容空）。
 */
export function blockShape(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return 'no-blocks'
  const parts = []
  const tally = new Map()
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    const type = typeof b.type === 'string' ? b.type : 'unknown'
    if (type === 'text' || type === 'reasoning') {
      parts.push(`${type}:${typeof b.text === 'string' ? b.text.length : 0}`)
    } else {
      tally.set(type, (tally.get(type) || 0) + 1)
    }
  }
  for (const [k, n] of tally) parts.push(n > 1 ? `${k}x${n}` : k)
  return parts.length ? parts.join(', ') : 'no-blocks'
}

/**
 * **本机安装环境探测**（2026-09-21 用户实锤，勿写死路径）。
 *
 * 由来：契约里原本写死「`dsh plugin --profile web add <spec>` 退出码 0」——但用户是**源码运行**
 * （`pnpm dsh web`，实测 `dsh` 不在 PATH），这条命令在他的环境里**永远跑不通**；而别人可能是一键
 * 安装（`dsh` 在 PATH）、profile 名也可能不叫 `web`。**每个用户环境不一样，路径绝不能写死。**
 *
 * 四条事实来源（**全部运行时得到，无一处硬编码**；主源是宿主给的权威锚点）：
 *  ① **`ctx.baseUrl` = 当前 profile 目录**（宿主在挂载插件树**之前**把它设为 profile 根配置所在目录：
 *     `apps/cli/src/profile-boot.ts` 的 `rootConfig = join(profile.dir, 'cordis.yml')` →
 *     `packages/boot/app-boot` 的 `boot()` 里 `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath))`），
 *     Cordis 子 ctx 原型继承 → 插件构造时即读得到。**唯一不依赖环境变量、也不受 junction 影响的来源**；
 *  ② **插件自身在磁盘上的位置**（次源）—— 我们被 `$DSH_HOME/profiles/<name>/node_modules/<pkg>/lib/host.mjs`
 *     加载，向上找 `profiles/<name>` 即得 profile 名与目录；⚠️ 但 `link:` 安装时 `import.meta.url`
 *     会解析到**真实目标**（junction 实测：指向源码目录），此时反推落空 → 正是要靠 ① 兜住；
 *  ③ **`DSH_HOME` 只能当兜底提示——它并非"装了 dsh 就自带"**：它是**可选覆盖变量**
 *     （`home-paths` 的 `resolveDshHome`：显式配置 > `$DSH_HOME` > `~/.dsh`），装 dsh **不会**写它
 *     （本机实测 User/Machine 两个作用域均为空），且 `.env` 永远设不了它（`app-boot` 的
 *     `BOOTSTRAP_PREFIXES` 含 `DSH_`，命中即抛错）。宿主进程里它通常是 `undefined`。
 *     ⚠️ **别拿 shell 里的观测推断宿主环境**：`shellEnv` 每次 shell 调用现算一个 overlay 塞给它
 *     （`packages/shell/shell-env`，官方契约明写 `process.env` 不被修改），故 `pwsh`/`bash` 里能 echo 到它，
 *     与宿主 `process.env` 无关（本轮即因此误判过一次）；
 *  ④ `dsh` 是否在 PATH（在 → CLI 可用；不在 → 源码运行，走等价手动步骤）。
 *
 * 等价手动步骤**不是猜的**：读宿主源码 `apps/cli/src/plugin.ts` 的 `runPlugin`，其语义即
 * 「`pnpm add <spec>`（cwd=profile 目录）→ `reconcilePlugins`：依赖里**声明了 `dsh.bundle.patch`
 * 的包自动进 `dsh.profile.bundles`**」——故手动路径 = 在 profile 目录 pnpm add，bundles 由同一条
 * 机械规则推导（手写效果一致）。
 *
 * **谁能执行**：流水线子代理**不能**（沙箱 `workspace-write` 钉死在工作区，会话里明写
 * `permission scope was fixed ... cannot be widened`）；**主 agent 能**——实测它的 profile 写入被拒后
 * 宿主给出 `escalation available ... sandbox_permissions + justification`，`approval/policy: ask`
 * 下经用户批准即可（无人应答时 fail closed）。故安装这一步的**执行者是主 agent，不是子代理**。
 */
export interface InstallEnv {
  /** `$DSH_HOME`（缺失为空串——探测失败，调用方须降级为"询问用户"）。 */
  dshHome: string
  /** 当前 profile 名（从插件自身路径反推；反推不出为空串）。 */
  profile: string
  /** 当前 profile 目录绝对路径。 */
  profileDir: string
  /** `dsh` 是否在 PATH（true → CLI 入口可用）。 */
  cliOnPath: boolean
  /** 探测是否完整；false 时**不得**编安装指令，只能让主线程问用户。 */
  ok: boolean
}

/** 从 `ctx.baseUrl`（宿主设为**当前 profile 目录**的 file:// URL）解析 profile。
 * 形态要求 `.../profiles/<name>/`（容忍尾斜杠与 cordis.yml 之类的文件名段）；非该形态返回 null。
 * 纯函数：`file://` 解码走 `decodeURIComponent`（路径含空格/中文时 URL 是编码过的）。 */
export function profileDirFromBaseUrl(baseUrl: unknown): { home: string; profile: string; dir: string } | null {
  const raw = String(baseUrl || '')
  if (!raw) return null
  let p = raw
  if (/^file:\/\//i.test(p)) {
    try { p = decodeURIComponent(new URL(p).pathname) } catch (e) { return null }
    // Windows 的 file:///C:/... → pathname 为 /C:/...，去掉前导斜杠
    if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  }
  const norm = p.replace(/\\/g, '/')
  const segs = norm.split('/').filter(Boolean)
  let i = segs.lastIndexOf('profiles')
  if (i < 0 || i + 1 >= segs.length) return null
  // 容忍 baseUrl 指到文件（如 .../profiles/web/cordis.yml）：末尾段不是目录名时按文件名丢弃
  let end = segs.length
  if (end - i > 2 && /\.(ya?ml|json)$/i.test(segs[end - 1])) end -= 1
  if (end !== i + 2) return null
  const name = segs[i + 1]
  if (!name) return null
  const isPosix = norm.startsWith('/')
  const sep = isPosix ? '/' : '\\'
  const home = (isPosix ? '/' : '') + segs.slice(0, i).join(sep)
  // 直接拼到 `profiles/<name>`（而非 join(home, …)）：POSIX 根 home 为 `/` 时
  // `['/','profiles','web'].join('/')` 会产出 `//profiles/web` 这种双斜杠。
  const dir = (isPosix ? '/' : '') + segs.slice(0, i + 2).join(sep)
  return { home, profile: name, dir }
}

/** 从插件模块路径反推 `$DSH_HOME/profiles/<name>`（纯函数，门禁可测）。
 * 接受 `.../profiles/<name>/node_modules/<pkg>[/lib/host.mjs]` 形态；非该形态返回 null。
 * ⚠️ 次源：`link:`/junction 安装下 `import.meta.url` 会解析到真实目标（源码目录）→ 返回 null，
 * 此时靠 {@link profileDirFromBaseUrl}（宿主给的权威锚点）兜住。 */
export function profileFromModulePath(modulePath: string): { home: string; profile: string; dir: string } | null {
  const raw = String(modulePath || '')
  if (!raw) return null
  const norm = raw.replace(/\\/g, '/')
  const segs = norm.split('/').filter(Boolean)
  const i = segs.lastIndexOf('profiles')
  if (i < 0 || i + 2 >= segs.length) return null
  const name = segs[i + 1]
  // 必须是 `profiles/<name>/node_modules/...`（否则命中的是同名的无关目录）
  if (segs[i + 2] !== 'node_modules' || !name) return null
  const sep = norm.startsWith('/') ? '/' : '\\'
  const homeBody = segs.slice(0, i).join(sep)
  const home = (norm.startsWith('/') ? '/' : '') + homeBody
  const dir = [home, 'profiles', name].join(sep).replace(new RegExp(`\\${sep === '/' ? '/' : '\\\\'}+`, 'g'), sep)
  return { home, profile: name, dir }
}

/** 探测本机安装环境。取值顺序（**主源是宿主权威锚点，不是环境变量**）：
 *  ① `baseUrl`（`ctx.baseUrl` = profile 目录）→ profile 名/目录/home 全齐，且不受 junction 影响；
 *  ② `modulePath`（插件自身文件路径）反推 —— `link:` 安装下会落空，作为次源；
 *  ③ `hintHome`（调用方给 `dshHome()`，**已有 `~/.dsh` 兜底**）只补 home；
 *  `ok` = **profile 名已知 且 目录为绝对路径**。刻意**不要求 `DSH_HOME`**：它不是"装了 dsh 就自带"
 *  （可选覆盖变量、`.env` 也设不了），默认安装下为 undefined，纳入判据会**误判失败**并把 PRD
 *  降级成"问用户"。要求绝对路径是因为相对目录照做不了（命令要在任意 cwd 下可执行）。
 *  纯函数（不碰进程/PATH；`hasCli` 由调用方探测）。 */
export function detectInstallEnv(opts: { baseUrl?: string; modulePath?: string; dshHome?: string; hasCli?: boolean }): InstallEnv {
  const hintHome = String(opts.dshHome || '').replace(/[\\/]+$/, '')
  const fromUrl = profileDirFromBaseUrl(opts.baseUrl)
  const fromPath = profileFromModulePath(opts.modulePath || '')
  const src = fromUrl || fromPath
  const profile = src?.profile || ''
  const home = src?.home || hintHome
  const sep = home.includes('/') && !home.includes('\\') ? '/' : '\\'
  const profileDir = src?.dir || (profile && home ? `${home}${sep}profiles${sep}${profile}` : '')
  return {
    dshHome: home,
    profile,
    profileDir,
    cliOnPath: opts.hasCli === true,
    // 相对目录不算探测成功：命令必须在任意 cwd 下照做得了（且相对路径没有可照抄的绝对值）
    ok: !!profile && isAbsolutePath(profileDir),
  }
}

/** 绝对路径判据（跨平台，纯字符串）：POSIX `/x`、Windows `C:\x`/`C:/x`、UNC `\\srv\share`。 */
export function isAbsolutePath(p: unknown): boolean {
  const s = String(p || '')
  return s.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')
}

/**
 * **用户可直接复制粘贴的裸命令**（无 markdown 反引号、无散文说明、无括注）。
 *
 * ⚠️ 必须与 `installRecipe` **分开**：后者是**给模型读的说明书**，天然带反引号与括注
 * （`\`dsh plugin …\``（在插件目录执行；dsh 在 PATH 上））。直接拿它去填「复制按钮的内容」
 * 会把反引号和说明文字一起复制走 —— 用户粘到终端里就是废命令（2026-10-12 真机实测）。
 *
 * 可泛化的纪律：**一个字符串若有两个消费者（模型读 / 用户复制），它就有两份契约，不能复用**
 * `installRecipe` 是「说明书」，本函数是「命令」；两者共用本函数的命令本体，就不会各自漂移。
 *
 * @returns 探测失败（不知道往哪个 profile 装）→ `null`：**宁可没有按钮可点，也不给一条错的命令**。
 */
export function installCommand(env: InstallEnv, pkgSpec: string): string | null {
  if (!env.ok) return null
  if (env.cliOnPath) return `dsh plugin --profile ${env.profile} add "${pkgSpec}"`
  // dsh 不在 PATH（源码运行 / `pnpm dsh`）⇒ 没有「一条命令搞定」的形态，退到 profile 目录里手工装。
  // `cd` 进绝对目录是必要的：命令会在任意 cwd 下被用户粘贴。
  return `cd "${env.profileDir}" && pnpm add "${pkgSpec}"`
}

/** 安装入口文案：**以探测结果为准**，不写死任何 profile 名/路径；探测失败 → 明确要求"问用户"，不猜。 */
export function installRecipe(env: InstallEnv, pkgSpec: string, pkgName: string, locale: HostLocale = 'zh'): string {
  if (!env.ok) {
    return locale === 'en'
      ? 'Profile directory could NOT be detected (DSH_HOME / profile name unavailable) — ASK THE USER where their profile lives; do NOT guess.'
      : '未能探测到 profile 目录（DSH_HOME / profile 名不可得）——**问用户**他的 profile 在哪，**不要猜**。'
  }
  if (env.cliOnPath) {
    // ⚠️ 命令本体来自 `installCommand`（单一来源）：这里只负责给它套上「说明书的衣服」。
    return locale === 'en'
      ? `\`${installCommand(env, pkgSpec)}\` (run from the plugin directory; dsh is on PATH)`
      : `\`${installCommand(env, pkgSpec)}\`（在插件目录执行；dsh 在 PATH 上）`
  }
  return locale === 'en'
    ? `dsh is NOT on PATH (source-run / \`pnpm dsh\`) → equivalent manual steps IN the profile dir \`${env.profileDir}\`: 1) \`pnpm add "${pkgSpec}"\`; 2) the package joins \`dsh.profile.bundles\` automatically once its package.json declares \`dsh.bundle.patch\` (add the name manually otherwise); 3) restart the host and confirm it loads. Package name \`${pkgName}\`.`
    : `dsh **不在 PATH**（源码运行 / \`pnpm dsh\`）→ 在 profile 目录 \`${env.profileDir}\` 内走等价手动步骤：① \`pnpm add "${pkgSpec}"\`；② 包的 package.json 声明了 \`dsh.bundle.patch\` 时会**自动进** \`dsh.profile.bundles\`（未声明就手写这一条）；③ 重启宿主并确认加载。包名 \`${pkgName}\`。`
}

/** 从 dev/qaFix 回复中提取「验证证据」块（`[Verification evidence]` 行起，到 state 块/结尾止）。
 * dev 阶段无独立对抗校验（QA 有 QA-REPORT.md 结构化证据，dev 只有自述）——证据块是「可审计的
 * 具体自述」：命令+退出码+断言计数+失败行引用，可对照 logs/teamflow/<runId>/ 命令输出日志核实；
 * 模型仍可伪造，但具体细节难编造一致（具体性压力）且伪造可发现（审计轨迹）。
 * 找不到块（契约未兑现）→ null，host 记 warn 不中断（policy 级）。 */
export function extractVerificationEvidence(text) {
  const s = toText(text)
  const m = s.match(/\[Verification evidence\]([\s\S]*?)(?=<!--\s*state|$)/)
  if (!m || !m[1]) return null
  const ev = m[1].trim()
  return ev.length > 0 ? ev : null
}

/**
 * ADR-0008 任务夹命名：<yyyyMMdd>-r<N>[-<slug>]。
 * - date 用本地时区（用户在东八区晚上建的需求不能落到"明天"）
 * - reqId 形如 req-8 → 段 r8（防撞兜底：slug 缺失/非法时夹名退化为 <date>-r<N>）
 * - slug 由 triage 模型给出并经 host 校验（[a-z0-9-]{3,24}），此处再做一次防御性清洗
 */
export function runFolderName(date: Date, reqId: string, slug?: string | null): string {
  const ymd = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
  const n = String(reqId || '').replace(/^req[-_]/i, 'r')
  const clean = String(slug || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
  const valid = /^[a-z0-9][a-z0-9-]{2,23}$/.test(clean) ? clean : ''
  return valid ? `${ymd}-${n}-${valid}` : `${ymd}-${n}`
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
/** 单任务允许声明的**可写**文件上限（防御：别让一个任务把半仓都圈成自己的）。 */
export const TASK_FILES_LIMIT = 20

/**
 * 调用方给出的 dev 任务归一化。
 *
 * **files = 该任务会改的文件（owns）**，是并发互斥的唯一判据：
 *  - 声明了 → 走 `mergeFileOverlaps`，与其它任务的 owns 无交集即可并行；
 *  - 没声明 → 边界未知，`mergeFileOverlaps` 会把这一批任务**全部合并串行**（宁可慢，不可抢写）。
 * 只读依赖请走 `reads`（蓝图路径支持；调用方路径暂不开放，未声明等于保守）。
 *
 * 清洗规则与既有字段一致（字符串化、去空、去重、限量）；脏值一律忽略而不是抛错——
 * 调用方是模型，格式不整齐是常态，抛错只会让整条流水线白跑。
 */
export function normalizeTasks(tasks: unknown): Array<{ title: string; spec: string; files: string[] }> {
  if (!Array.isArray(tasks)) return []
  const out = []
  for (const t of tasks) {
    if (t === null || t === undefined) continue
    const files: string[] = []
    if (typeof t === 'object' && Array.isArray(t.files)) {
      for (const f of t.files) {
        const s = typeof f === 'string' ? f.trim() : ''
        if (s && !files.includes(s)) files.push(s)
        if (files.length >= TASK_FILES_LIMIT) break
      }
    }
    if (typeof t === 'string') {
      const s = t.trim()
      if (s) out.push({ title: s, spec: '', files })
    } else if (typeof t === 'object') {
      const title = typeof t.title === 'string' && t.title.trim() ? t.title.trim() : null
      if (title) out.push({ title, spec: typeof t.spec === 'string' ? t.spec : '', files })
    }
    if (out.length >= 8) break
  }
  return out
}
/**
 * **环境变量布尔开关**（2026-09-30 立）：给**临时实验**用，**不进工具契约**。
 *
 * 为什么不用工具参数：工具的 `description` 每次都会进主会话上下文（实测写全劝导语要 492 字符 ≈137 tok），
 * 而实验开关大概率是**临时物**——结论出来后要么条款保留、开关删除，要么条款本身删除，
 * 没必要为它长期占额度，更不该给所有用户暴露一个「降级质量」的公开开关。
 *
 * 语义：**未设置 / 空串 = 开**（与产品出厂行为一致）；只有 `0` / `false` / `off` / `no` 才关。
 * ⚠ resume 不走这里：它从 journal 快照读 `options.craft`（见 `sanitizeSnapOptions`），
 * 所以一次实验期间即使重启宿主，已开跑的 run 也不会半路变卦。
 */
export function envFlagOn(name: string): boolean {
  const raw = process.env[name]
  if (raw === undefined || String(raw).trim() === '') return true
  return !/^(0|false|off|no)$/i.test(String(raw).trim())
}

/**
 * **PRD 确认单的触发档**（2026-10-08）：`TEAMFLOW_CONFIRM` = `always` / `never`，其余/未设 = `auto`。
 *
 * 为什么要环境变量而不是工具参数（用户 2026-10-08 当场否掉公开参数 `needConfirm`）：
 * 「用户又不知道这个参数」—— 公开一个用户不会用、且工具描述里**没有任何「何时该设它」的触发条件**
 * 的开关，等于这个功能在实践中从来不会被触发（它当时也确实从未生效过）。产品路径必须是**内容驱动**
 * （PRD 有没有主观品味项），这个环境变量只服务于 A/B 对照与端到端验证的**强制**需要。
 */
export function confirmModeFromEnv(): 'auto' | 'always' | 'never' {
  const v = String(process.env.TEAMFLOW_CONFIRM ?? '').trim().toLowerCase()
  if (v === 'always' || v === 'on' || v === '1' || v === 'true') return 'always'
  if (v === 'never' || v === 'off' || v === '0' || v === 'false') return 'never'
  return 'auto'
}

/**
 * **澄清策略变体**（ADR-0011 ③）的环境变量通道（2026-10-08 **重构后**）：`TEAMFLOW_CLARIFY`。
 * 缺省 `interview`（一次一问）—— 它现在是 **ctx 手册的默认行为**，不再是「缺省不追加」的档位。
 * `once` / `off` 只服务**对照实验**（`interview` 的文案与 `once` 的旧文案逐字并存于词典）。
 *
 * ⚠️ **为什么不再有 `patch` 恒 off 的归一**：那条契约约束的是「run 级选项」，而本字段已不是 run 级选项
 * （ctx 只在选团队时注入，那时还不知道档位）。契约随字段一起作废，见 ADR-0011。
 */
export function clarifyStrengthFromEnv(): 'off' | 'once' | 'interview' {
  const v = String(process.env.TEAMFLOW_CLARIFY ?? '').trim().toLowerCase()
  if (v === 'once') return 'once'
  if (v === 'off') return 'off'
  return 'interview'
}
export function sanitizeSnapOptions(o) {
  const opts = (o && typeof o === 'object') ? o : {}
  return {
    needDesign: opts.needDesign === true,
    needScaffold: opts.needScaffold === true,
    lite: opts.lite === true,
    // craft 缺省＝开（产品出厂行为）：只有显式 false 才关闭，老快照缺字段不会被退回旧形态
    craft: opts.craft !== false,
    mode: (typeof opts.mode === 'string' && opts.mode) ? opts.mode : undefined,
    productRoot: typeof opts.productRoot === 'string' ? opts.productRoot : null,
    maxConcurrency:
      Number.isFinite(opts.maxConcurrency) && opts.maxConcurrency > 0
        ? Math.min(opts.maxConcurrency, DEV_MAX_CONCURRENCY)
        : null,
    tasks: Array.isArray(opts.tasks) ? opts.tasks.map((t) => ({ title: String((t && t.title) || ''), spec: String((t && t.spec) || '') })) : [],
  }
}
// 安全信号兜底：宿主（09-04+）在 subagents.start 内部调用 signal.throwIfAborted()——
// 缺该方法会「启动/执行失败：options?.signal?.throwIfAborted is not a function」（实锤 r1-json-tree-view
// 3 任务 3 轮 resume 全失败）。
//
// ⚠️ **必须是真正的 AbortSignal，不能是鸭子对象**（2026-10-17 issue #20 追评实锤）：宿主会把调用方的
// signal 原样丢进 `AbortSignal.any([token.abort.signal, callerSignal])`（api-gateway client.node.js:1694）
// 与 `AbortSignal.any([inputs.signal, controller.signal])`（dsh-subagent lib/index.js:1688）。
// Node 22 的 `AbortSignal.any` 只做鸭子校验（是对象且有 `aborted` 即收）⇒ 伪 signal 一路蒙混；
// **Node 24 改走 WebIDL `sequence<AbortSignal>` 真 brand 校验** ⇒ `TypeError: signals[1] is not of type
// AbortSignal.`，阶段在 1–3ms 内启动即死。本插件有三条入口传 `undefined`（resumeRun / api.start /
// triage 预检）⇒ 在 Node 24 上「续跑」与「面板启动」全部不可用，只有带真 exec.signal 的
// `teamflow_start` 幸免。语义保持不变：真 signal、永不 abort（aborted 恒 false）。
export const SAFE_SIGNAL: AbortSignal = new AbortController().signal
const ABORT_SIGNAL_BRAND = '[object AbortSignal]'
/**
 * 真 AbortSignal 判定。**只认真 brand，不认鸭子形状**——鸭子判定正是 Node 24 崩溃的放行口。
 * 跨 realm（vm / jsdom / 独立 context）造出的**真** signal `instanceof` 会失配，用 `toString` brand 兜一层。
 */
export function normalizeSignal(s: unknown): AbortSignal {
  if (s instanceof AbortSignal) return s
  if (Object.prototype.toString.call(s) === ABORT_SIGNAL_BRAND && typeof (s as AbortSignal).throwIfAborted === 'function') return s as AbortSignal
  return SAFE_SIGNAL
}

/**
 * 「暂停之后，有没有**人**给过答复」——确认单人工闸门的判据（2026-10-17 实锤 tf-mvc4jrl7-7g6hnb）。
 *
 * 实锤：插件把暂停汇报作为 `user/message` 注入主会话（`source.kind = 'plugin:dsh-plugin-teamflow'`），
 * 模型把它当用户指令 ⇒ 自己调 `teamflow_resume` 把确认单批了（08:33:36 暂停 → 08:34:02 自调，
 * 窗口内零条人类消息）。ADR-0011 ① 要的是**人工**批准，不能靠模型自律。
 *
 * 两类**人的答复**都算（这是同一个漏洞的两面，别只做一半）：
 * 1. 人会话说：`user/message` 且 `data.source.kind === 'user'`（注入消息是 `plugin:*` / `time-context` 等）；
 * 2. 人点了 `ask_user_question` 的选项：回答以 **`tool/result`** 落盘（**不产生 user/message**，实测
 *    `tool/result.data.message.source = {kind:'tool', callId}`），所以必须按 callId 关联回
 *    `tool/call.data.name === 'ask_user_question'` 才算。⚠️ 只认**结果**不认调用：调用是模型「问了」，
 *    结果才代表「人答了」。漏掉这条 ⇒ 我们自己在汇报里让模型用 AUQ 问，人点完却被闸门拒 ⇒ 必然误伤。
 *
 * 三态返回（**空值必须可见**，§7 同源）：
 * - `true`  找到晚于 `sinceMs` 的人类答复（会话说 / AUQ 答）⇒ 人答复过
 * - `false` 能读到会话日志、但没有任何人类答复晚于该时刻 ⇒ **没人答复**
 * - `null`  读不到（session 缺失 / 宿主 API 变更）⇒ 调用方自行决定并留痕，**不要当成 false**
 */
export function hasHumanReplySince(session: unknown, sinceMs: number): boolean | null {
  const s = session as { snapshotEvents?: () => unknown; ownEvents?: () => unknown } | null | undefined
  if (!s || typeof s !== 'object') return null
  let events: unknown = null
  try {
    // ⚠️ `snapshotEvents()` 优先：它返回**完整日志**且未标废弃；`ownEvents()` 在宿主 d.ts 里已
    // `@deprecated`（= `snapshotEvents(inheritedEventCount)`，只剔掉 fork 继承前缀），new calls 被禁止。
    // 保留它只作旧宿主（没有 snapshotEvents）的兜底。
    if (typeof s.snapshotEvents === 'function') events = s.snapshotEvents()
    else if (typeof s.ownEvents === 'function') events = s.ownEvents()
  } catch (e) {
    return null
  }
  if (!Array.isArray(events)) return null
  const since = Number.isFinite(sinceMs) ? sinceMs : 0
  type Ev = { type?: string; time?: number; data?: Record<string, unknown> } | null
  const list = events as Ev[]
  // 先按 callId 收集「模型问过人的那些提问」
  const askIds = new Set<string>()
  for (const ev of list) {
    const e = ev as Ev
    if (!e || e.type !== 'tool/call' || !e.data) continue
    if (e.data.name !== 'ask_user_question') continue
    const cid = e.data.callId
    if (typeof cid === 'string' && cid) askIds.add(cid)
  }
  for (const ev of list) {
    const e = ev as Ev
    if (!e || !(Number(e.time) > since)) continue
    if (e.type === 'user/message') {
      const src = e.data && (e.data.source as { kind?: string } | undefined)
      if (src && src.kind === 'user') return true
      continue
    }
    if (e.type === 'tool/result' && e.data) {
      const msg = e.data.message as { source?: { callId?: string } } | undefined
      const cid = e.data.toolCallId || (msg && msg.source && msg.source.callId)
      if (typeof cid === 'string' && askIds.has(cid)) return true
    }
  }
  return false
}

/**
 * **显式批准判据**（2026-10-17，实锤 `tf-mvckeco4-2o1p91`）。
 *
 * 事故形态：确认单上只剩 1 项待拍板（`--depth` 的默认与互斥形态），而用户那句「加 `--depth N`，
 * 默认 0 不限制」**恰好是那项的缺省建议** ⇒ 模型判定「你在回答这项 ⇒ 本版 10 条 AC 全部认可」⇒
 * 自己调了 `resume`（**不带 supplement**）⇒ 直接进架构设计。用户从没点过批准，PRD 却被锁死
 * （`stages` 里有了 scaffold ⇒ 再改会被 `supplementTooLate` 拒）。
 *
 * `hasHumanReplySince` 只回答「暂停后有没有人说过话」，回答不了「这句话是不是批准」——
 * 而「无 supplement 的 resume = 批准」正是**整版放行**的动作，代价最大。所以单独加这一层。
 *
 * 判据（保守优先，宁可让人再说一次）：**有否定 ⇒ 不批准；没有批准词 ⇒ 不批准；有修改词 ⇒ 视为修改**。
 * 这是启发式，但方向是安全的：误判成「不算批准」只会多问一句，误判成「算批准」会封死修改窗口。
 */
const APPROVAL_WORDS = ['批准', '同意', '开工', '开始吧', '可以开工', '没问题', '就这样', '照这个来', 'approve', 'approved', 'go ahead', 'lgtm', 'ship it']
const NEGATION_WORDS = ['不批准', '不同意', '先别', '暂不', '先不', '不用了', '再等等', '先等等', "don't", 'do not', 'not yet', 'hold on', 'no ']
const CHANGE_WORDS = ['改', '加', '删', '换', '调整', '去掉', '不要', '新增', '补充', '修改', '替换', 'add ', 'change', 'remove', 'adjust', 'revise', 'rename']

/** 一段人类话里是否含**显式批准**语义（纯函数，便于真值表测试）。 */
export function isExplicitApproval(text: unknown): boolean {
  const t = String(text == null ? '' : text).toLowerCase().replace(/\s+/g, ' ').trim()
  if (!t) return false
  if (NEGATION_WORDS.some((w) => t.includes(w))) return false
  // 有修改词 ⇒ 这是「改」不是「批准」，即使同时说了「可以」也必须走 supplement 通道
  if (CHANGE_WORDS.some((w) => t.includes(w))) return false
  return APPROVAL_WORDS.some((w) => t.includes(w))
}

/** 暂停之后**最后一条人类答复**（`user` = 人直接打字；`auq` = 人点了 ask_user_question 的选项）。 */
export interface HumanReply { kind: 'user' | 'auq'; text: string }

/**
 * 取最后一题人类答复。三态：
 * - `undefined` = 读不到会话日志（宿主 API 变更）⇒ 调用方只 warn 不硬拒（与 `hasHumanReplySince` 一致）；
 * - `null` = 读到了，但暂停之后没人说过话；
 * - 对象 = 最后一条答复及其文本。
 * 为什么只要「最后一条」：用户可能先说「要改 X」再说「批准」——以最后一句为准。
 */
export function lastHumanReplySince(session: unknown, sinceMs: number): HumanReply | null | undefined {
  const s = session as { snapshotEvents?: () => unknown; ownEvents?: () => unknown } | null | undefined
  if (!s || typeof s !== 'object') return undefined
  let events: unknown = null
  try {
    if (typeof s.snapshotEvents === 'function') events = s.snapshotEvents()
    else if (typeof s.ownEvents === 'function') events = s.ownEvents()
  } catch (e) {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  const since = Number.isFinite(sinceMs) ? sinceMs : 0
  type Ev = { type?: string; time?: number; data?: Record<string, unknown> } | null
  const list = events as Ev[]
  const askIds = new Set<string>()
  for (const ev of list) {
    if (!ev || ev.type !== 'tool/call' || !ev.data) continue
    if (ev.data.name !== 'ask_user_question') continue
    const cid = ev.data.callId
    if (typeof cid === 'string' && cid) askIds.add(cid)
  }
  const textOfBlocks = (content: unknown): string => {
    if (!Array.isArray(content)) return ''
    return content.map((b) => (b && typeof (b as { text?: unknown }).text === 'string' ? String((b as { text: string }).text) : '')).join(' ')
  }
  let last: HumanReply | null = null
  for (const ev of list) {
    if (!ev || !(Number(ev.time) > since)) continue
    if (ev.type === 'user/message') {
      const src = ev.data && (ev.data.source as { kind?: string } | undefined)
      if (src && src.kind === 'user') last = { kind: 'user', text: textOfBlocks(ev.data && ev.data.content) }
      continue
    }
    if (ev.type === 'tool/result' && ev.data) {
      const msg = ev.data.message as { source?: { callId?: string }; content?: unknown } | undefined
      const cid = ev.data.toolCallId || (msg && msg.source && msg.source.callId)
      if (typeof cid === 'string' && askIds.has(cid)) {
        const raw = textOfBlocks((msg && msg.content) || ev.data.content)
        // AUQ 的结果是 `{"answers":[...]}`：只取答案本身，避免把问题正文里的「要不要改」当成修改意图
        let answers = raw
        try {
          const parsed = JSON.parse(raw) as { answers?: unknown }
          if (parsed && Array.isArray(parsed.answers)) answers = parsed.answers.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')
        } catch (e) { /* 非 JSON ⇒ 用整段文本 */ }
        last = { kind: 'auq', text: answers }
      }
    }
  }
  return last
}

/** **显式批准**的三态版本（`undefined` = 读不到日志）。 */
export function hasExplicitApprovalSince(session: unknown, sinceMs: number): boolean | null | undefined {
  const r = lastHumanReplySince(session, sinceMs)
  if (r === undefined) return undefined
  if (r === null) return false
  return isExplicitApproval(r.text)
}

/**
 * 任务夹的真实路径（2026-10-18 真机逼出来的）。
 *
 * `journal.runDocs` 在真机是**相对工作区**的路径（`docs/teamflow/20261018-r1-…`），直接用它
 * `existsSync` 会按**进程 cwd** 解析 ⇒ 永远 false ⇒ PRD 快照与「上一版路径」静默失效
 * （真机 `tf-mvcl5m8t`：任务夹里始终只有 PRD.md，没有任何 `PRD.v*.md`）。
 * 但测试夹具可能直接给绝对路径 ⇒ 已绝对就不拼，否则会拼成 `<workspace>/C:/…` 这种死路径。
 */
export function absoluteRunDocs(runDocs: unknown, workspacePath: unknown): string {
  const rel = runDocs ? String(runDocs) : ''
  if (!rel) return ''
  if (isAbsolute(rel)) return rel
  const wp = workspacePath ? String(workspacePath) : ''
  return wp ? `${wp.replace(/[\\/]+$/, '')}/${rel}` : rel
}

/**
 * 幂等合并 .gitignore 条目（纯函数，便于回归测试）。
 *
 * 场景（实锤 assetd `tf-mtwvwpxa-p3vw08`）：插件强制把命令日志/临时脚本写进 `logs/teamflow/`，
 * 目标仓库没忽略它时，收口提交的 227 个文件里 208 个是这批噪音（92%）——本函数负责「补规则」这一半，
 * 另一半（提交面强制排除）在 `sanity.tfAddArgs()`。
 * 2026-09-15（B 方案）后该目录只是 **run 期间的工作区暂存**（终态由 `core/runlogs` 归档到 `$DSH_HOME`
 * 并从项目删除）——两道防线保留，用于覆盖「run 进行中用户自己提交」的窗口。
 *
 * 覆盖判定不只看字面相等：已有 `logs/`、`logs/**` 这类**更宽的目录规则**同样算已忽略
 * （否则会往一个已经生效的仓库里塞冗余规则）。返回 `changed=false` 时调用方**不要写文件**。
 */
export function mergeGitignore(
  existing: string | null | undefined,
  entries: string[],
  locale: HostLocale = 'zh',
): { text: string; changed: boolean; added: string[] } {
  const src = existing === null || existing === undefined ? '' : String(existing)
  const lines = src.split(/\r?\n/).map((l) => l.trim())
  /** 归一：去首尾斜杠与尾部 glob（`logs/`、`logs/**` → `logs`）。 */
  const norm = (s: string) => s.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\/\*\*?$/, '')
  const coveredBy = (entry: string) => {
    const e = norm(entry)
    return lines.some((l) => {
      if (!l || l.startsWith('#')) return false
      const n = norm(l)
      return !!n && (n === e || e.startsWith(`${n}/`))
    })
  }
  const added = entries.filter((e) => e && !coveredBy(e))
  if (added.length === 0) return { text: src, changed: false, added: [] }
  const head = src ? `${src}${src.endsWith('\n') ? '' : '\n'}` : ''
  const block = `${src ? '\n' : ''}${t(locale, 'log.gitignoreHeader')}\n${added.join('\n')}\n`
  return { text: head + block, changed: true, added }
}

/** 分支 slug 派生（ADR-2026-08-27）：branchName > triageSlug > 需求中的英文标识词 > reqId 数字 > 'feature'。
 * 实锤 feat/feature：lite 显式时 triage 不跑（无 slug）+ 分支检查早于 reqId 生成 → fallback 'feature'。 */
export function deriveBranchSlug(
  requirement: string | null | undefined,
  reqId: string | null | undefined,
  triageSlug?: string | null,
  branchName?: string | null,
): string {
  if (branchName && /^[a-z0-9][a-z0-9-_]*$/i.test(branchName)) return String(branchName).replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 40)
  if (triageSlug && /^[a-z0-9-]{3,24}$/i.test(triageSlug)) return triageSlug
  const en = String(requirement || '').match(/[a-zA-Z][a-zA-Z0-9-]{2,23}/g)
  if (en && en.length) {
    // 排除档位词/虚词——否则「显式的用 patch 模式」会把档位词「patch」当成分支名（实锤 feat/patch）
    const NOISE = new Set(['patch', 'lite', 'tech', 'full', 'medium', 'mode', 'the', 'and', 'for', 'with', 'use', 'using'])
    const hit = en.find((w) => !NOISE.has(w.toLowerCase()))
    if (hit) return hit.toLowerCase().slice(0, 40)
  }
  const num = String(reqId || '').match(/\d+/)
  if (num) return `r${num[0]}`
  return 'feature'
}

/** 交付判定结论（judgeDeliverable）：`reason` 供失败分类/日志文案，`refusal` 供留痕与诊断包。 */
export interface DeliverableVerdict {
  ok: boolean
  reason: 'ok' | 'empty' | 'too-short' | 'refusal'
  /** 命中的拒绝措辞（含原文上下文）；`ok=true` 时也可能非空——措辞只作诊断，不再单独否决。 */
  refusal: { phrase: string; context: string } | null
  /** 本阶段长度下限与实际长度（诊断用）。 */
  min: number
  length: number
}

/**
 * 交付判定（信号分级；2026-09-11 信号换轨，原 `hasSubstance`）。
 *
 * 旧判据 = 非空 + **全文拒绝词** + 长度下限——把「措辞」当交付门禁。实锤 assetd
 * tf-mtwvwpxa-p3vw08 的 T5：子代理 `stopReason=completed`、41 次工具调用、证据块与
 * state 块齐全、`src/query.mjs` 已落盘，只因如实汇报「7 条 runCli 用例与 spec/verify.mjs
 * 全部 26 例无法执行（沙箱禁止子进程管道）」命中「无法执行」→ 判 insubstantial
 * 「视为未交付」→ 提测门禁停整条线 + 人工 resume（16 分钟 + 一轮重跑）。
 * 教训不是「词表少了一个词」，而是**措辞不能用来判定是否交付**：模型如实汇报环境限制
 * 是本分，换一种说法（跑不通/环境不允许/需在无限制 shell 复跑）旧判据照样误杀。
 *
 * 现判据按「客观优先、措辞退为兜底」分级：
 *  1. 客观形态：非空 + 达阶段长度下限（不读语义）；
 *  2. 真交付信号：含 `[Verification evidence]` 块 → 判交付（拒绝/放弃类产出给不出具体
 *     命令+退出码细节）；命中拒绝词只记诊断、不否决；
 *  3. 兜底：无证据块且命中拒绝词 → 判未交付（这才是「光说不做 / 自称做不到」的形态）。
 *
 * 因此「如实汇报环境限制」这类假阳性在**结构上**消失，而「没干活就说完成」仍被抓：
 * 无证据块的假交付照旧落到第 3 级或长度级。
 */
export function judgeDeliverable(phase: string, text: string | null | undefined): DeliverableVerdict {
  const s = toText(text)
  const min = STAGE_MIN_LENGTH[phase] ?? 100
  const length = s.trim().length
  if (length === 0) return { ok: false, reason: 'empty', refusal: null, min, length }
  if (length < min) return { ok: false, reason: 'too-short', refusal: null, min, length }
  const refusal = refusalHit(s)
  if (!refusal) return { ok: true, reason: 'ok', refusal: null, min, length }
  if (DELIVERY_EVIDENCE_PATTERN.test(s)) return { ok: true, reason: 'ok', refusal, min, length }
  return { ok: false, reason: 'refusal', refusal, min, length }
}

/* ── doc 类阶段的**单轨产物 = 任务夹文件**（回复只是摘要；2026-09-18 probe-v2 实锤） ──────────
 * 实锤：`tf-mu71waxg-4iws10` 的 PRD 子代理**写了 4894 字节 `PRD.md`、还调 `present` 声明交付物**，
 * 但它的回复只有一个 state 块（284 字符）→ `judgeDeliverable` 按「回复过短」判 `insubstantial`
 * 「视为未交付」→ 阶段失败 → 紧接着撞熔断 → 整条 run 落 failed + 需人工。
 * 判据只看回复是**把"摘要写少了"这种形式违规升级成"没干活"**——而该阶段的产物本来就不在回复里。
 * 故：回复不合格时，**回读任务夹产物文件**，文件在且达该阶段长度下限 → 仍判交付（并留痕）。
 * 只列「产物就是任务夹文件」的阶段：dev/qaFix 的交付是代码 + 证据块（另有 `[Verification evidence]` 信号），
 * scaffold/architecture 的产物是代码与蓝图对象（host 另有解析与文件 fallback），都不入此表。
 * patch 档的 PRD 阶段**刻意不产文件**（确认单只在回复里）→ 没有候选文件时本机制自然不生效。
 * ⚠️ 兜底**不豁免非空回复**：pipeline 还要用回复文本合并 state 块（`mergeStageState`），
 * 空回复仍旧失败（那是真的没交付）。 */
export const DOC_STAGE_FILES: Record<string, string[]> = {
  prd: ['PRD.md', 'TECH-CHANGE.md'],
  design: ['DESIGN.md'],
  tech: ['TECHNICAL.md', 'TECH-CHANGE.md'],
  qa: ['QA-REPORT.md'],
  acceptance: ['ACCEPTANCE.md'],
}

/** 任务夹产物读取（单轨契约：文件即产物——QA/验收 host 只读文件，回复仅摘要）。
 * 缺失/空/读取异常返回 null（调用方决定硬失败或 journal 兜底）。`pipeline` 与 `runner` 共用。 */
export function artifactText(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  fileName: string,
): string | null {
  const path = artifactPathOf(journal, fileName)
  if (!path) return null
  try {
    if (!existsSync(path)) return null
    const t = readFileSync(path, 'utf8').trim()
    return t ? t : null
  } catch (e) { return null }
}

/** 任务夹内某个产物的绝对路径（`artifactText` / `artifactFingerprint` 共用）。 */
function artifactPathOf(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  fileName: string,
): string | null {
  return journal && journal.workspacePath && journal.runDocs ? `${journal.workspacePath}/${journal.runDocs}/${fileName}` : null
}

/* ── 产物**新鲜度**判据（2026-10-16 实锤 run tf-mv9o5fkk-orjou4）──────────────────────────────
 * 由来：架构阶段的子代理越界写了 `QA-REPORT.md` / `ACCEPTANCE.md`（它的 prompt 明写禁止，
 * `prompts/index.ts` 的 architectPrompt 段），而下游「文件即产物」的读取**只看文件在不在、够不够长**。
 * 后果：QA/验收阶段的正常契约就是「回复 ≤12 行摘要」⇒ 一定走文件读取 ⇒ 若该阶段自己没写，
 * host 会把**上一个阶段留下的旧文件**当成本轮产物（QA 甚至会把架构师的自我评估当 QA 结论）。
 * 判据必须客观且与模型自律无关（见 MEMORY §2）：**阶段开始时记录候选产物的指纹，只有指纹变了才认**。
 *
 * 为何用 `size:mtimeMs` 而不是内容哈希：每次真实写入都必然改变其一（同毫秒同大小同时重写不可能发生
 * ——阶段粒度按分钟计），而省掉一次全文读取与哈希。取整 mtimeMs 规避浮点尾数。 */
export function artifactFingerprint(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  fileName: string,
): string | null {
  const path = artifactPathOf(journal, fileName)
  if (!path) return null
  try {
    if (!existsSync(path)) return null
    const st = statSync(path)
    return `${st.size}:${Math.round(st.mtimeMs)}`
  } catch (e) { return null }
}

/**
 * 阶段开始前拍一次产物基线，写进 stage（`store.JournalStage.artifactBaseline`）。
 * **只填缺失项**：重试（同一阶段多次尝试）与续跑（新进程复用同一条 stage）都沿用**首次**基线 ⇒
 * 语义是「本阶段是否写过它」，而不是「本次尝试是否写过」—— 前者才是我们要防的越界污染。
 * 必须在子代理启动**之前**调用（runner 在建 stage 后、任何 await 前）。
 */
export function captureArtifactBaseline(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  phase: string,
  stage: { artifactBaseline?: Record<string, string | null> | null } | null | undefined,
): void {
  const names = DOC_STAGE_FILES[phase]
  if (!stage || !names || !names.length) return
  const base = (stage.artifactBaseline && typeof stage.artifactBaseline === 'object') ? stage.artifactBaseline : {}
  let filled = false
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(base, name)) continue
    base[name] = artifactFingerprint(journal, name)
    filled = true
  }
  if (filled) stage.artifactBaseline = base
}

/** 相对基线**没变** ⇒ 不是本阶段写的 ⇒ 不可信。
 *  基线缺失该键（或未提供基线）= **不可判** ⇒ 返回 false（不做新鲜度判定）—— 键由 `captureArtifactBaseline`
 *  用同一张 `DOC_STAGE_FILES` 表填，正常不会缺；「续跑复用旧产物」路径**刻意不传基线**（那个文件本就来自早先的运行）。 */
export function artifactIsStale(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  fileName: string,
  baseline: Record<string, string | null> | null | undefined,
): boolean {
  if (!baseline || typeof baseline !== 'object') return false
  if (!Object.prototype.hasOwnProperty.call(baseline, fileName)) return false
  return baseline[fileName] === artifactFingerprint(journal, fileName)
}

/** 读「**本阶段写过的**」产物：陈旧（指纹未变）→ 当缺失返回 null。`baseline` 省略 = 不判新鲜度。 */
export function freshArtifactText(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  fileName: string,
  baseline: Record<string, string | null> | null | undefined,
): string | null {
  if (artifactIsStale(journal, fileName, baseline)) return null
  return artifactText(journal, fileName)
}

/** 交付枚举上限。**命中即截断，且截断必须显式上报**（见 scanDeliverableFiles）。 */
export const DELIVERABLE_FILE_LIMIT = 400

/** 枚举结果的完整形状：`truncated=true` ⇒ 「没找到入口」这类负结论**不可信**。 */
export interface DeliverableScan {
  files: string[]
  truncated: boolean
  limit: number
}

/**
 * 枚举交付产物文件（相对 root）—— 只回答「交付里有没有可执行入口」，**不做形态识别**。
 *
 * ⚠ 两条纪律（2026-10-02 实锤，**别改回去**）：
 *
 * ① **点目录一律不遍历**。pnpm 的工作区 store 默认落在 `.pnpm-store/`，里面是几千个
 *    **无扩展名** blob；而 `readdirSync` 的顺序里它排在 `AGENTS.md` 之前（实测第 3 位）
 *    ⇒ 400 上限被瞬间吃满，返回的 400 条里**源文件 0 个、HTML 0 个**。后果是下游四项
 *    host 检查（加载 / 接口 / 冒烟 / 验证证据）**全部静默跳过**，而交付物其实完好。
 *    实锤 run `tf-mupnk8h0-1otbl2`：日志写「源文件 0 个」「no-html」「扫到 400 个交付文件」，
 *    而同期该工作区只有 28 个真实交付文件，其中 13 个源文件 + 1 个 index.html。
 *    机制复现：同样目录形状 + 1000 个 store blob ⇒ 不跳点目录时返回「400 条 / 源文件 0 / HTML 0」，
 *    跳过点目录后恢复「23 条 / 源文件 11 / HTML 1」。
 * ② **截断必须显式**。早先直接返回「装满的 400 条」，上层无从区分「目录就这么大」与
 *    「枚举被砍断」⇒ 把「枚举不全」读成「没有入口」。这与本仓反复栽的「空集通过 / 静默降级」
 *    是同一型缺陷，故拆出 truncated 标志，调用方在截断时不得把负结论当事实。
 *
 * 另外排除 run 自己的痕迹（docs/ 任务夹、logs/ 暂存）与非点目录形式的依赖/构建目录。
 */
export function scanDeliverableFiles(
  root: string | null | undefined,
  limit = DELIVERABLE_FILE_LIMIT,
): DeliverableScan {
  if (!root) return { files: [], truncated: false, limit }
  const SKIP_DIR = new Set([
    'node_modules', 'logs', 'dist', 'build', 'out', 'coverage',
    'target', '__pycache__', 'venv', 'bower_components',
  ])
  const out: string[] = []
  let truncated = false
  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit) { truncated = true; return }
    if (depth > 6) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch (e) { return }
    for (const e of entries) {
      if (out.length >= limit) { truncated = true; return }
      const p = `${dir}/${e.name}`
      if (e.isDirectory()) {
        // 点目录（.git/.next/.pnpm-store/.yarn/.cache/.venv…）一律不遍历：
        // 既不是交付物，又最可能吃满上限（见上文实锤）。
        if (!e.name.startsWith('.') && !SKIP_DIR.has(e.name)) walk(p, depth + 1)
        continue
      }
      const rel = `${p.slice(root.length + 1)}`
      if (/^(?:docs|logs)\//.test(rel)) continue
      out.push(rel)
    }
  }
  walk(root, 0)
  return { files: out, truncated, limit }
}

/** 只要文件名列表的调用方用这个（行为同旧版，签名不变）。需要截断标志时改用 scanDeliverableFiles。 */
export function listDeliverableFiles(root: string | null | undefined, limit = DELIVERABLE_FILE_LIMIT): string[] {
  return scanDeliverableFiles(root, limit).files
}

/**
 * QA 验证证据判据（2026-09-28 加，**warn-only 观察期**——请勿据此硬失败）。
 *
 * 背景：A/B 实测里 A 组两次交付都「打开就不可用」（一次符号写反导致循环空转黑屏、一次初始化漏调
 * 函数抛 TypeError），而 QA 报告全绿放行 —— 它的检查停在「文件存在 / 有 export」，从没运行过交付。
 *
 * 判据只问一个问题：**交付含可执行入口时，QA 报告里有没有「命令 + 结果」的证据**。
 * 它刻意**不判断「网站还是游戏还是 CLI」**（那是形态识别，会滑向按形态硬编码）——
 * 只看「有没有可执行入口文件」这个二值事实。
 *
 * 观察期只记 warn 不阻断：命令/结果的**文本识别宽松度**必须由真实样本校准，
 * 否则会误伤写法各异的合格报告（B 组那种「9 个脚本全绿 + 逐条 exit 0」正是要认得出来的形态）。
 */
export interface QaEvidenceAssessment {
  hasRunnableEntry: boolean
  hasCommand: boolean
  hasResult: boolean
  hasNa: boolean
  /** skip=无需证据 ok=有命令+结果 na=显式声明无法自动验证 missing=有入口却无证据（观察目标） */
  verdict: 'skip' | 'ok' | 'na' | 'missing'
}

/**
 * 项目**文件系统根**：host 侧解析真实路径的唯一入口（acl-preflight / runlogs 同惯例）。
 *
 * ⚠️ 别把 `root`(options.productRoot) 当路径用 —— 它是给 prompt 的**产品线标识**，
 * 在工作区模式下**恒为 null**（2026-09-29 实测 5/5 run 全是 null），拿它当路径会让检查静默空转
 * （当天 host 加载检查 + 验证证据探针两个功能就是这么一起悄悄没跑的）。
 * 产品线模式（root 非空）下 root 是 workspacePath 的相对子目录；绝对路径则直接用。
 */
export function fsRootOf(
  root: string | null | undefined,
  workspacePath: string | null | undefined,
): string | null {
  const ws = workspacePath ? String(workspacePath) : null
  const r = root ? String(root) : null
  if (!r) return ws
  if (isAbsolute(r)) return r
  return ws ? join(ws, r) : null
}

export function assessQaVerificationEvidence(
  qaText: string | null | undefined,
  files: string[] = [],
): QaEvidenceAssessment {
  const RUNNABLE = /\.(?:js|mjs|cjs|jsx|ts|tsx|html?|py|sh|ps1|bat|go|rb|java|rs|php)$/i
  const hasRunnableEntry = files.some((f) => RUNNABLE.test(String(f)))
  const text = String(qaText || '')
  // 「命令」：出现可执行调用，或点名了某个脚本文件
  const hasCommand =
    /(?:^|[\s|>])(?:node|npm|pnpm|npx|bun|deno|python3?|curl|wget|pwsh|powershell|bash|cargo)\s+\S/i.test(text) ||
    /[\w./-]+\.(?:mjs|cjs|sh|ps1)\b/i.test(text)
  // 「结果」：退出码或通过计数
  const hasResult =
    /(?:exit\s*(?:code)?\s*[:：]?\s*-?\d|退出码\s*[:：]?\s*-?\d|passed|PASS\b|通过数|全绿|\d+\s*\/\s*\d+)/i.test(text)
  // 「N/A」：显式声明无可自动验证路径（唯一豁免通道）。
  // ⚠️ 刻意**不**把「环境限制 / 需要浏览器」算作豁免 —— 那正是 A 组用来推脱的措辞，
  // 而 B 组在同环境下用 DOM 桩跑通了 E2E，证明「没浏览器」不等于「验不了」。
  const hasNa = /(N\/A|不适用|无法自动验证|不可自动验证|无可自动验证|无可执行路径|纯文档|no runnable|nothing runnable)/i.test(text)
  const verdict: QaEvidenceAssessment['verdict'] = !hasRunnableEntry
    ? 'skip'
    : (hasCommand && hasResult) ? 'ok' : hasNa ? 'na' : 'missing'
  return { hasRunnableEntry, hasCommand, hasResult, hasNa, verdict }
}

/**
 * doc 类阶段的产物兜底：按 `DOC_STAGE_FILES` 取**最长**的一个候选文件（同一阶段可能有多种产物形态，
 * 如 tech 档 PRD 写 `TECH-CHANGE.md`）；无候选/文件缺失/未达下限 → null（绝不抛）。
 *
 * `baseline`（可选）：本阶段的产物基线（`stage.artifactBaseline`）。给了就**跳过指纹未变的候选**——
 * 即「上游写过的旧产物不算本阶段产物」（2026-10-16 实锤，见 `artifactFingerprint` 的注释）。
 */
export function stageDocText(
  journal: { workspacePath?: string | null; runDocs?: string | null } | null | undefined,
  phase: string,
  baseline?: Record<string, string | null> | null,
): { name: string; text: string; length: number } | null {
  const names = DOC_STAGE_FILES[phase]
  if (!names || !names.length) return null
  let best: { name: string; text: string; length: number } | null = null
  for (const name of names) {
    if (artifactIsStale(journal, name, baseline)) continue
    const text = artifactText(journal, name)
    if (!text) continue
    const length = text.trim().length
    if (!best || length > best.length) best = { name, text, length }
  }
  return best
}

/**
 * **空收尾兜底判定**（A 档止损，2026-09-27；纯函数——runner 链宿主私有 peer 不可 import，
 * 可测逻辑下沉 util 是既定纪律，见 cancel.test.js 头注释）。
 *
 * 推理模型空收尾（DeepSeek 实测：`finish kind=stop`，reasoning 之后、正文之前被服务端收尾）
 * 此前一律整轮重跑（一次 ≈ 150 万 token）。判定：`stop==='completed'` 且正文为空且任务夹产物
 * 已落盘达下限 → 返回该产物（判交付依据，返回值用文件内容顶替空回复）；其余一律 null
 * （照旧走失败/重试）。⚠️ 边界（tf-muigy5eq r12 实测）：空收尾死在写文件**之前**时不命中
 * （产物不存在）→ 照旧重跑；「干到一半死掉」须 continuable 续跑（docs/TODO.md B 档立项）。
 */
export function emptyTurnDocVerdict(
  stop: unknown,
  text: unknown,
  min: number,
  doc: { name: string; text: string; length: number } | null | undefined,
): { name: string; text: string; length: number } | null {
  if (stop !== 'completed' || text) return null
  // 空文件绝不可能是交付物（行为级测试实锤边界：min=0 时 0>=0 会误判）——length 必须为正
  if (!doc || doc.length <= 0 || !(doc.length >= min)) return null
  return doc
}

/* ── QA 轮次收敛的**埋点**（D 方案 2026-09-15：先测量，再决定要不要动状态机语义） ──────────
 * 背景：52 个历史 run 里「真正需要第 3 轮修复」从未发生，而「同一缺陷原样复现就早停」这条判据
 * **按缺陷 id 判不出来**——QA 每轮重新编号（实锤 r9：`QA-*` → `R2-*` → `R3-*`）。
 * 所以先记录**稳定身份**与逐轮集合，等攒到真实复验轮数据再决定是否把 `QA_REWORK_LIMIT` 换成收敛判据。
 * 身份优先级：**缺陷行自带的检测命令**（B 方案起 QA 必填，最稳定、机器写给机器看）> 模块+实际行为文本
 * （自由文本，跨轮容易被改写，只作兜底）> 缺陷 id（最不稳定，最后兜底）。
 */

/** 归一化：去 markdown 装饰、压平空白、小写（仅用于身份比较，不改原值）。 */
function fpNorm(s: unknown): string {
  return String(s === null || s === undefined ? '' : s).replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 缺陷的**稳定身份**（跨轮次可比）：检测命令优先，其次 模块+实际/期望文本，最后回落 id。 */
export function defectFingerprint(d: {
  check?: string | null
  module?: string | null
  actual?: string | null
  expected?: string | null
  id?: string | null
} | null | undefined): string {
  if (!d) return ''
  const cmd = fpNorm(d.check)
  if (cmd) return `cmd:${cmd}`.slice(0, 200)
  const mod = fpNorm(d.module)
  const body = fpNorm(d.actual || d.expected || '')
  if (mod || body) return `txt:${mod}|${body}`.slice(0, 200)
  return `id:${fpNorm(d.id)}`
}

/**
 * 与**历史轮次**对比本轮阻断集合（收敛判据的原始素材）。
 * @param prevFps - 之前每一轮的指纹数组（按时间顺序，不含本轮）
 * @param curFps - 本轮的指纹数组
 * @returns newFps = 历史从未出现过；repeats = 至少出现过一次（**修完还在 → 停滞信号**）；
 *          resolved = 上一轮出现过、本轮消失（消解数）。返回指纹列表（便于人工核对是哪几条）。
 */
export function compareDefectRounds(prevFps: string[][], curFps: string[]): { newFps: string[]; repeats: string[]; resolved: string[] } {
  const seen = new Set<string>()
  for (const round of prevFps || []) for (const fp of round || []) seen.add(fp)
  const last = (prevFps && prevFps.length ? prevFps[prevFps.length - 1] : []) || []
  const cur = new Set(curFps || [])
  return {
    newFps: (curFps || []).filter((fp) => !seen.has(fp)),
    repeats: (curFps || []).filter((fp) => seen.has(fp)),
    resolved: last.filter((fp) => !cur.has(fp)),
  }
}

/**
 * 组装一轮 QA 的埋点记录（D 方案 2026-09-15；纯函数，便于回归测试）。
 * @param round - 轮次（1 = 首轮）
 * @param seq - 该轮 QA stage 的 seq（审计定位；未知传 null）
 * @param defects - 本轮解析出的全部缺陷（含 P3）
 * @param prevRounds - 之前的埋点记录（用于算 新增/重复/消解）
 * @param qaCalls - 该轮 QA 的实际调用数（未知传 null）
 * @param limit - 当前复验上限（`outcome` 用）
 */
export function qaRoundEntry(
  round: number,
  seq: number | null,
  defects: Array<{
    id?: string
    severity?: string
    module?: string
    check?: string
    criterion?: string
    actual?: string
    expected?: string
  }>,
  prevRounds: Array<Record<string, unknown>> | null | undefined,
  qaCalls: number | null,
  limit: number,
): Record<string, unknown> {
  const all = defects || []
  const blocking = all.filter((d) => d.severity !== 'P3')
  const fps = blocking.map((d) => defectFingerprint(d))
  const prevFps = (prevRounds || []).map((r) => (((r && r.defects) as Array<{ fp?: string }>) || []).map((d) => String((d && d.fp) || '')))
  const cmp = compareDefectRounds(prevFps, fps)
  return {
    round,
    seq,
    blocking: blocking.length,
    p3: all.length - blocking.length,
    defects: blocking.map((d, i) => ({ id: d.id, sev: d.severity, module: d.module || '', fp: fps[i] })),
    withCheck: blocking.filter((d) => String(d.check || '').trim()).length,
    withCriterion: blocking.filter((d) => String(d.criterion || '').trim()).length,
    qaCalls,
    fixCalls: null,
    gate: null,
    newFps: cmp.newFps.length,
    repeats: cmp.repeats.length,
    resolved: cmp.resolved.length,
    outcome: blocking.length === 0 ? 'pass' : round > limit ? 'limit' : 'rework',
  }
}

/** 不可重试的失败原因（上下文耗尽/超长/provider 客户端拒绝等——重试同一 prompt 大概率复现）。
 * 实锤 tf-mtcnejqj：opencode-go 400 invalid_request_error（tool 消息序列非法）被当作可重试 → 烧 1.98M 熔断。 */
export function isUnretryable(reason: unknown, outcome: unknown): boolean {
  const r = String(reason || outcome || '')
  return /context|limit|max-token|token|tool-error|400|invalid_request|INVALID_REQUEST/i.test(r)
}

/** 阶段产出 → 精简交接摘要（供审计/展示；产出含显式 <!-- handoff --> 块则优先取块内内容）。 */
export function handoffBrief(text: string | null | undefined): string {
  if (!text || !String(text).trim()) return ''
  const m = String(text).match(/<!--\s*handoff\s*-->([\s\S]*?)(?:<!--\s*\/handoff\s*-->|$)/)
  const brief = (m && m[1] ? m[1] : String(text)).trim()
  return clip(brief, 2000)
}

/** 拒绝词命中点：返回命中的具体短语 + 原文上下文片段（供重试诊断回灌，比事后从截断尾巴重算可靠）。 */
export function refusalHit(text: string | null | undefined): { phrase: string; context: string } | null {
  const s = String(text || '')
  const m = REFUSAL_PATTERN.exec(s)
  if (!m || m.index < 0) return null
  const start = Math.max(0, m.index - 40)
  const end = Math.min(s.length, m.index + String(m[0]).length + 40)
  return { phrase: m[0], context: s.slice(start, end).replace(/\s+/g, ' ').trim() }
}

/** 外部故障特征词表（供应商 / 网络 / 额度）：单行正则字面量必然超 max-len，故按语义分组用数组 join 构造。 */
const EXTERNAL_FAILURE = new RegExp([
  '\\b429\\b', '\\b402\\b', 'rate[ _-]?limit', 'too many requests', 'insufficient[ _-]?(?:balance|quota|funds)',
  'quota', 'exceeded[ _-]?(?:your[ _-]?)?(?:quota|limit|rate)',
  'no[ _-]?(?:available[ _-]?)?(?:quota|balance|credit)', 'out of credit', 'billing', 'payment required', 'overload',
  'temporarily unavailable', 'service unavailable', '\\b50[234]\\b', 'upstream', 'gateway timeout', '\\b52[0-9]\\b',
  'timeout', 'timed out', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'socket hang up', 'fetch failed',
  'network error', '限流', '限速', '频率限制', '请求过于频繁', '额度', '配额', '余额不足', '欠费', '无额度', '暂时不可用', '服务不可用', '上游不可用', '超时',
  '网络错误', '连接被重置', '过载', '供应商',
].join('|'), 'i')

/** 内容类故障特征词表（上下文 / 产出长度）：同 EXTERNAL_FAILURE，按语义分组构造。 */
const CONTENT_FAILURE = new RegExp([
  'context[ _-]?(?:window|length)', 'too many tokens', 'maximum context', 'prompt is too long', '上下文(?:长度|超限|耗尽)',
  '护栏', 'degenerated', 'stalled', 'insufficient output', 'too short', '产出过短',
].join('|'), 'i')
/**
 * 外部供应商不可用 vs 内容性失败（2026-09-17，实测驱动）。
 *
 * 背景：dddd 那条 run 在第一轮 01:37 连续 6 个 dev 阶段 `stopReason=error` → 快速重试两次 → 转人工；
 * 而**16 分钟后（01:53）同样的请求就成功了**——即那批失败是「供应商在一段时间窗内不可用」（限流/无额度/
 * 上游 5xx/超时），**与阶段内容无关**。旧行为把它当内容失败：快速失败、落 `failed + human`、让人误以为
 * 交付有问题。现在按错误文本分类（⚠️ **启发式**：宿主只给 `stopReason=error` + 错误文本，没有结构化错误码，
 * 故命中原文必须记日志以便日后核对）：
 *  - `external`：限流/额度/余额/上游不可用/超时/过载 → 走**长退避重试**；用尽仍失败 → 落可续跑中断态；
 *  - `content`：上下文耗尽/护栏/产出无效等 → 维持现状（不自动重试或按既有策略）；
 *  - `unknown`：未命中任何词 → 维持现状（按内容类处置，宁严勿松）。
 * `hint` 为可选的 outcome/summary 文本，一并参与匹配（错误细节可能在 stage.summary 里）。
 */
export function classifyExternalFailure(text: string | null | undefined, hint?: string | null): 'external' | 'content' | 'unknown' {
  const s = `${String(text || '')} ${String(hint || '')}`
  if (!s.trim()) return 'unknown'
  const external = EXTERNAL_FAILURE.test(s)
  if (external) return 'external'
  const content = CONTENT_FAILURE.test(s)
  if (content) return 'content'
  return 'unknown'
}

/** 外部故障退避序列（毫秒）：30s → 60s → 120s → 240s（总等待上限 ≈ 7.5 分钟）。
 * 取值依据：dddd 实测窗口 ≈16 分钟（01:37 挂 → 01:53 恢复），故退避要能跨过几分钟的短窗口，
 * 又不至于让一条 run 无限期挂着（用尽后落**可续跑中断态**，窗口恢复后 resume 只补这一段）。 */
export const EXTERNAL_BACKOFF_MS = [30000, 60000, 120000, 240000]

/** 取第 n 次外部故障退避时长（n 从 1 起；超出序列 → null 表示退避用尽）。 */
export function externalBackoffMs(n: number): number | null {
  return EXTERNAL_BACKOFF_MS[n - 1] ?? null
}

/* ── 工具「环境不可用」检测（2026-09-23 probe-v4 实锤）────────────────────────────────
 * 实锤：`pwsh` 因 Windows 沙箱 ACL provision 失败（`SetNamedSecurityInfoW failed (Win32 5)`）**每次同样报错**，
 * 架构师把它重试 7 次 + 90k 字符推理后撞 max-tokens 被截断 —— 白烧 52.6k 输出，且汇报把真因写成 `max-tokens`。
 * 这类失败**不是模型问题**：重试、换命令绕过、用推理代替执行都修不好环境，必须在烧钱之前停下并说清原因。 */

/** 工具结果文本（拼接 message.content 的 text 块）——签名与日志共用。 */
export function toolResultText(data: unknown): string {
  try {
    const content = (data as { message?: { content?: unknown } } | null | undefined)?.message?.content
    if (!Array.isArray(content)) return ''
    return content
      .map((c) => (c && typeof (c as { text?: unknown }).text === 'string' ? (c as { text: string }).text : ''))
      .join('')
  } catch (e) { return '' }
}

/**
 * 工具结果是否**失败**。首选结构化 `message.isError`（宿主 `tool/result` 自带，权威、不猜文本——
 * `packages/core/tools` 的 ToolExecutionResult）；缺该字段（老宿主/裁剪事件）时按 `Error`/`failed`
 * 前缀兜底，宁严勿松：只认明确失败。
 */
export function isToolErrorResult(data: unknown): boolean {
  const msg = (data as { message?: { isError?: unknown } } | null | undefined)?.message
  if (msg && typeof msg.isError === 'boolean') return msg.isError
  return /^\s*(?:error|failed|fatal)\b/i.test(toolResultText(data))
}

/* ── 会话内可自愈的防护门禁失败（2026-10-07 issue #15 实锤）──────────────────────────
 * 宿主 `@deepseek-ai/dsh-tool-fs` 的 `remediateFsError()` 把两类**防护门禁**失败换成稳定文案：
 *   `FS_NOT_OBSERVED`  → `cannot modify "<path>": file has not been read — read the file, then retry`
 *   `FS_STALE_VERSION` → `<原 message> — re-read the file, then retry`
 * 它们说的是**会话内的读前置 / 版本前置**，不是工作区状态 —— 一次 read 就能自愈，
 * 与「环境不可用」的判据（同一错误反复出现 = 工作区坏了、重试无用）**语义相反**。
 * 若计入环境指纹，模型正常重试 2 次就被判 env-unavailable：实测两例（dev `tf-mumguwdl-dein51`
 * 09-29 / scaffold `tf-mupnk8h0-1otbl2` 10-01）都是「同一文件 write 没先 read」→ warn 后 7s / 55s
 * 即被判死、汇报要求「先修工作区再 resume」，而活本来能做完。
 * 只能用文本判定：工具结果里只有 remediated message，没有 code 字段可读（故两条 code 的文案都列出，
 * 宿主换文案时这里同步）。 */
const FS_SELF_HEAL_TEXT = /file has not been read|re-read the file, then retry|file no longer exists|file changed/i
/** 同族错误的 code 名：remediated message 里通常没有它，但未被 remediate 的路径可能带上（防御性保留）。 */
const FS_SELF_HEAL_CODE = /FS_STALE_VERSION|FS_NOT_OBSERVED/i

/** 是否属于「会话内可自愈的文件防护门禁」失败 —— 据此**不计入**环境不可用指纹。 */
export function isFsSelfHealFailure(text: unknown): boolean {
  const s = String(text || '')
  return FS_SELF_HEAL_TEXT.test(s) || FS_SELF_HEAL_CODE.test(s)
}

/* ── 「工具在这一层不适用」类失败（2026-09-30 obs-r5 实锤；2026-10-07 扩项）──────────────
 * **权限 / 能力边界 / 名字不存在**，都不是「工作区坏了」——共同点是**换个工具就能继续**，
 * 与「工作区全废」（重试 / 绕道 / 推理都救不了）不是一回事。
 * 实锤代价（obs-r5 QA 复验轮）：子代理连调 send_message / list_agents（同一个
 * "not a member of an active Agent Team"）共 3 次 → 被 abort → 整个 run failed，而它连一个
 * checker 都还没跑（回归契约复跑为零）。注：进展豁免救不了这种 —— 它从第一次调用就失败，
 * 全程没有任何**成功**调用。
 * ⚠️ 2026-10-07 扩项（`unknown tool`，同根因第三类）：`ws-tf-ab-a` run `tf-mul7l30d`（09-28）
 * QA 复验子代理把 git 当**工具名**调（原文 `Error: unknown tool "git "`，带尾空格）→ 连错 3 次
 * 被判 env-unavailable + 「先修工作区」，而工作区毫发无损（12:17 人工 resume 后正常续跑）。
 * 它想跑的是 `git` 命令，正解是换回 bash —— 正属此族。 */
const TOOL_SCOPE_LIMIT = /is not a member of an active Agent Team|exceeds maxDepth|subagent depth \d+|unknown tool/i

/** 是否属于「工具在这一层不适用」（换个工具即可继续）—— 据此**不计入**环境不可用指纹。 */
export function isToolScopeFailure(text: unknown): boolean {
  return TOOL_SCOPE_LIMIT.test(String(text || ''))
}

/* ── 「参数类失败：模型自己把参数传错了」类（2026-10-16 实锤 run tf-mv9o5fkk-orjou4）────────────
 * 与上面两类同族：**换个参数就能继续**，与「工作区坏了（重试/绕道都没用）」不是一回事。
 * 实锤代价：scaffold 子代理连调 `edit` 三次都传了**相同的 old/new**，命中「同一工具同一错误 ×3」→
 * 被判 `env-unavailable` 硬停（不重试、要求人工修工作区、引导 resume）；人工 resume 后**同一阶段一次就过**
 * （126 次调用、0 失败）⇒ 工作区自始正常，这是纯粹的分类误判，白等 30 分钟。
 *
 * 文案来源（只认**参数解析层**的原文，不猜其它层）——宿主 `@deepseek-ai/dsh-tool-fs`：
 *   `packages/fs/tool-fs/src/edit.ts:48-50`  → `file_path must be a non-empty string` /
 *                                            `old_string must be a non-empty string` /
 *                                            `old_string and new_string must differ`
 *   `packages/fs/tool-fs/src/read.ts:44,56` → `<name> must be a positive integer` / `file_path must be ...`
 *   `packages/fs/tool-fs/src/index.ts:62`   → `tool-fs: <name> must be a positive integer`
 *   **宿主通用参数校验层（任意工具、任意 schema 类型错）→ 前缀 `invalid arguments:`**，形如
 *     `invalid arguments: "queries" must be an array`。实锤 tf-mvb3lm0b-bbgoyv（2026-10-16）：tech 子代理
 *     反复把 `web_search.queries` 传成字符串（应为数组），宿主在 parse 层拒；这条**没被上面三条覆盖** ⇒
 *     计进环境指纹 ⇒ 第 3 次误判 `env-unavailable` 硬停、不重试，run 直接 failed。⇒ **按前缀整体豁免，
 *     不逐个列举类型**（`must be an array|string|number|object|…` 列不全，下次又会漏一个新的）。
 *     该前缀 = 调用在 parse 层就被拒，与上面三条同性质，绝不等价于文件系统/权限/沙箱故障。
 *   **会话/权限层的参数配套校验 → 前缀 `invalid escalation:` 或句式 `is only valid together with`**，
 *     形如 `invalid escalation: justification is only valid together with sandbox_permissions`。
 *     实锤 tf-mvjd3k2w-hpd3qa（2026-10-22）：dev T3 与 QA 缺陷修复各中一次 ⇒ 被判 `env-unavailable`
 *     ⇒ **停止自动重试、整条流水线停**（`开发失败任务数 3/5`），用户被迫手工 resume 两次才跑完。
 *     这同样是「模型换个参数就能继续」，不是沙箱/权限坏了 —— 宿主把 `justification`（升级理由）
 *     与 `sandbox_permissions`（目标权限）当成必须成对出现的参数，模型只给了一个。
 *     ⚠️ 这已经是**第三族**：① `invalid arguments:`（通用 schema）② `must be …`（fs 工具）
 *     ③ `invalid escalation:` / `is only valid together with`（权限升级）。**再遇到新族别再逐个
 *     补文案**——凡是宿主在**调用前**拒绝、且错误文本里说明了"参数该长什么样"的，都属于同一性质。
 * 判据边界：这些都是 **parse*Args 层**的参数校验（调用前就抛），不是文件系统/权限/沙箱的失败；
 * 宿主换文案时这里同步（与 FS_SELF_HEAL_TEXT 同款纪律）。 */
const TOOL_ARG_FAILURE = new RegExp([
  'invalid arguments:',
  'invalid escalation:',
  'is only valid together with',
  'must be a non-empty string',
  'must differ',
  'must be a positive integer',
].join('|'), 'i')

/** 是否属于「模型参数传错」（换个参数即可继续）—— 据此**不计入**环境不可用指纹。 */
/* ── 越界发现（2026-10-27）：dev 任务按契约不许改别人的文件，但"发现了没人接手"会一路滑到 QA ──
 * 实锤 tf-mvpjqs87-14qdxa：T1 发现 T2 文件里 3 个失败用例并定位到行，只写进自由文本 summary；
 * 最后由「交付自检」重新跑全量测试才发现（多一次全量构建，且依赖它覆盖到）。
 * 契约：越界发现必须写进结构化块，host 解析后生成一条**独占这些文件**的收口任务（见 stages/dev.ts）。
 *
 * 格式（唯一真相在这条注释与 devPrompt 的说明里）：
 *   [OUT-OF-SCOPE]
 *   - src/a/B.java:123 — 现象/证据 — 建议动作
 *   - src/c/D.java — 现象
 *   [/OUT-OF-SCOPE]
 * 解析是**宽容的**：破折号可用 —/–/-，行首列表符可省略，行号可省；但块标记必须存在——
 * 没有块就等于没有声明（不做"从自由文本里猜"的事，那正是要消灭的形态）。
 */
export interface OutOfScopeFinding {
  file: string
  line: number | null
  note: string
}

/** 解析 dev 回复里的 `[OUT-OF-SCOPE]` 块（最多 `limit` 条；无块 ⇒ 空数组）。 */
export function parseOutOfScope(text: unknown, limit = 20): OutOfScopeFinding[] {
  const s = String(text === null || text === undefined ? '' : text)
  const open = s.search(/\[OUT-OF-SCOPE\]/i)
  if (open < 0) return []
  const rest = s.slice(open + '[OUT-OF-SCOPE]'.length)
  const close = rest.search(/\[\/OUT-OF-SCOPE\]/i)
  const body = close >= 0 ? rest.slice(0, close) : rest
  const out: OutOfScopeFinding[] = []
  for (const rawLine of body.split('\n')) {
    if (out.length >= limit) break
    const line = rawLine.trim()
    if (!line) continue
    const item = line.replace(/^[-*•]\s*/, '')
    if (!item) continue
    if (/^\[\/?OUT-OF-SCOPE\]/i.test(item)) continue
    // 头（路径[:行号]）与说明之间：— / – / " - "
    const cut = item.search(/\s+[—–]\s+|\s+-\s+/)
    const head = (cut >= 0 ? item.slice(0, cut) : item).trim()
    const note = cut >= 0 ? item.slice(cut).replace(/^\s*[—–-]\s*/, '').trim() : ''
    const m = head.match(/^(.*?)(?::(\d+))?$/)
    const file = (m && m[1] ? m[1] : head).trim()
    if (!file || /^\[\/?OUT-OF-SCOPE/i.test(file)) continue
    if (file.length < 3) continue
    out.push({ file, line: m && m[2] ? Number(m[2]) : null, note: note.slice(0, 300) })
  }
  return out
}

export interface PinnedConstant { name: string; value: string }

/** 从文本里抽「钉死的数值常量」：`[static] final <type> NAME = <数字>` 或 `NAME = <数字>`（大写名）。
 *  TECHNICAL 里通常以代码块或表格形式给出这些值；dev 一旦改了它们，等于**悄悄改设计口径**。 */
export function parsePinnedConstants(text: unknown): PinnedConstant[] {
  const s = String(text === null || text === undefined ? '' : text)
  const out: PinnedConstant[] = []
  const seen = new Set<string>()
  const re = /(?:static\s+final\s+\w+\s+)?\b([A-Z][A-Z0-9_]{2,})[`*|\s]*=\s*(-?\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(s)) !== null) {
    const name = m[1]
    if (seen.has(name)) continue
    seen.add(name)
    out.push({ name, value: m[2] })
  }
  return out
}

/** 比对「文档钉死值」与「代码现值」。只报**两边都有、值不同**的项（代码里没有的不算，
 *  文档里没有的不算 —— 那是新常量，不是改口径）。 */
export function diffPinnedConstants(
  pinned: PinnedConstant[],
  actual: PinnedConstant[],
): Array<{ name: string; expected: string; actual: string }> {
  const now = new Map(actual.map((c) => [c.name, c.value]))
  const out: Array<{ name: string; expected: string; actual: string }> = []
  for (const p of pinned) {
    const a = now.get(p.name)
    if (a === undefined) continue
    if (String(a) !== String(p.value)) out.push({ name: p.name, expected: p.value, actual: a })
  }
  return out
}

/** QA 打回轮次的**起点决策**（纯函数，2026-10-27）。
 *  背景：轮次原本是阶段内局部变量，中断+resume 归零 ⇒ `QA_REWORK_LIMIT` 的有界闭环在续跑后失效
 *  （实测 tf-mvpjqs87-14qdxa：同 run 打到第 3 轮，日志与界面上都还写着「第 1 轮」）。
 *  规则：累计值落盘后按已用轮次继续；**只有人工 resume** 才追加一次预算（人工介入算一次进展），
 *  且追加次数有上限 `manualBudget`——否则上限又形同虚设。 */
export function planQaRoundStart(
  persisted: { round?: unknown; resumes?: unknown } | null | undefined,
  isHumanResume: boolean,
  limit: number,
  manualBudget: number,
): { round: number; resumes: number; reset: boolean; used: number } {
  const used = Math.max(0, Number(persisted && persisted.round) || 0)
  const grants = Math.max(0, Number(persisted && persisted.resumes) || 0)
  if (used > limit && isHumanResume && grants < manualBudget) {
    return { round: 0, resumes: grants + 1, reset: true, used }
  }
  return { round: used, resumes: grants, reset: false, used }
}

/** 长命令告警判定（纯函数，2026-10-28）：在飞调用超过阈值且还没报过 ⇒ 该告警。
 *  单独抽出来是为了可测边界——护栏本体在轮询闭包里，没法在 node 侧加载（它 import 宿主包）。 */
export function longCallDue(
  startedAt: unknown,
  now: number,
  thresholdMs: number,
  alreadyWarned: boolean,
): boolean {
  if (alreadyWarned) return false
  const t = Number(startedAt)
  if (!Number.isFinite(t) || t <= 0) return false
  return now - t >= thresholdMs
}

/** 重试时是否**在原子代理里继续**（而不是新起一个）。纯函数，便于锁住两条边界：
 *  ① 第一次尝试绝不"继续"（那时还没有上一轮）；② 没有 childId 就无从来处继续。
 *  宿主能力（sendMessage/observeSession）由调用方另行判定，这里只管"该不该试"。 */
export function shouldContinueChild(attempt: unknown, childId: unknown): boolean {
  const a = Number(attempt)
  if (!Number.isFinite(a) || a <= 1) return false
  return typeof childId === 'string' && childId.trim().length > 0
}

export function isToolArgFailure(text: unknown): boolean {
  return TOOL_ARG_FAILURE.test(String(text || ''))
}

/** 失败指纹：工具名 + 归一化错误前 160 字符。同一指纹反复出现 = 同一个坏环境（而非模型措辞波动）。 */
export function toolFailureSignature(tool: unknown, text: unknown): string {
  const name = String(tool || '').trim().toLowerCase() || 'tool'
  const detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160)
  return `${name}::${detail}`
}

/** 失败次数 → 护栏动作（纯函数，阈值可测）：none = 继续观察；warn = 提醒模型停手；abort = 中止本阶段。 */
export function toolFailureAction(count: unknown, warnAt: number, abortAt: number): 'none' | 'warn' | 'abort' {
  const n = typeof count === 'number' && Number.isFinite(count) ? count : 0
  if (n >= abortAt) return 'abort'
  if (n >= warnAt) return 'warn'
  return 'none'
}

/** 重试诊断包：上一轮失败详情回灌进重试 prompt（盲试 → 带因重试）。
 * 失败分类/详情/护栏原因取自 stage；产出尾部截断 1000 字符供自查修正。
 * `locale` 为**尾参可选**（缺省/`zh` → 现状中文**逐字不变**；`en` → 新增英文文案，AC-3④）。
 * 文案自带 zh/en 两份而不经 `host/locales/pipeline.ts`：该词典的 `diag.*` 归流水线面（T2），
 * 冻结键表列出的 `retryHeader/outcome/guardReason/detail/tail/end` 尚未落地——若在此强行查词典，
 * 缺 key 会回落成 key 字面量污染喂回子代理的注入文本；故本函数不引入对词典的强依赖。 */
export function buildRetryDiagnostic(
  attempt: number,
  stage: { outcome?: string | null; summary?: string | null; guardReason?: string | null; output?: string | null },
  locale?: HostLocale | null,
): string {
  const en = locale === 'en'
  const lines: string[] = []
  lines.push(en
    ? `[Retry diagnostic · attempt ${attempt}] The previous attempt did not succeed. This is not a new task — read the failure details below first, then perform the original task while fixing the previous attempt's problems.`
    : `[重试诊断 · 第 ${attempt} 次尝试] 上一轮尝试未成功。这不是新任务——请先阅读以下失败详情，再执行原任务并修正上一轮的问题。`)
  lines.push(en ? `- Failure class: ${stage.outcome || 'unknown'}` : `- 失败分类：${stage.outcome || 'unknown'}`)
  if (stage.guardReason) lines.push(en ? `- Guard abort reason: ${stage.guardReason}` : `- 护栏中止原因：${stage.guardReason}`)
  if (stage.summary) lines.push(en ? `- Details: ${stage.summary}` : `- 详情：${stage.summary}`)
  const out = String(stage.output || '')
  if (out) {
    const tail = out.length > 1000 ? `…${out.slice(-1000)}` : out
    lines.push(en
      ? `- End of the previous output (excerpt, for self-correction):\n${tail}`
      : `- 上一轮产出末尾（节选，供自查修正）：\n${tail}`)
  }
  return `\n\n${lines.join('\n')}\n${en ? '[/Retry diagnostic end]' : '[/重试诊断结束]'}`
}

/**
 * 验收结论解析：只以显式「验收结论 / 整体结论」行为准（acceptancePrompt 强制 4 档固定话术），
 * 不做正文散文朴素子串匹配。历史误报实锤（run tf-msytlok5）：验收报告 ✅ 通过，其记忆回写段一句
 * 「SUMMARY.md 结构无需改动」（= 结构无需变更）被旧正则「无需改动」子串命中 → 误判 reject →
 * 整条流水线置 failed。reject 词在正文里常以否定/引用/对照形式出现，故：
 *  - 「📝 需求不适用」是验收负责人专用的强结论词，允许全文命中；
 *  - 其余 reject 词（需求与实际不符/站不住/无效/无需改动等）仅在结论行且该行不含「通过/✅/⚠️」时才算；
 *  - rework 词仅认结论行（且不与「✅ 通过」同现）。
 * 反向护栏（漏报实锤 2026-09-03）：模型写「❌ 不通过」但漏写「验收结论：」前缀 → accLine 为空 →
 * 旧实现落回默认 accepted（最乐观默认值，质量门禁漏报=假交付）。现改为 **找不到结论行 → needs-human**
 * （宁严勿松：误拦截=人工看一眼，误放行=假交付；📝 全文命中与架构红词仍优先于该默认）。
 * ⚠️ 结论行取值（2026-09-17 实测 bug，`tf-mu4bve7t-duux2k`）：旧实现 `find(第一个含「验收结论」的行)` 会被
 * **章节标题**蒙住 —— 真实产物里 `## 1. 验收结论摘要`（含"验收结论"四字）排在真正的结论行
 * `验收结论：✅ 通过` 之前 → 抓到标题行 → 四档词全落空 → **明明通过却判 needs-human**。
 * 现规则：**优先取字面量模板行**（行首 `验收结论：` / `Acceptance verdict:` / `Overall verdict:`，
 * 允许 `## ` 前缀与列表符），且取**最后一个**（报告末尾的"结论"章才是终判）；仍找不到时，回退到
 * **最后一个非标题、含结论词的行**（避免"只写 ❌ 不通过、漏写前缀"的漏报变体）。
 * @param {unknown} text 验收报告全文
 * @returns {'accepted'|'rework'|'reject'|'needs-human'}
 */
export function parseAcceptanceVerdict(text) {
  const acc = String(text || '')
  const lines = acc.split('\n')
  // ① 字面量模板行（**唯一**结论行来源）：`## 验收结论：✅ 通过` / `- 验收结论：通过` /
  //    `Acceptance verdict: ✅ Pass`。只允许 `##`/列表符前缀 + 冒号连写；`**验收结论：**` 这类
  //    加粗破坏连写的**不认**（宁严勿松：不知道结论就 needs-human，不猜）。
  //    有多个时取**最后一个**（报告末尾的“结论”章才是终判，前面可能是“摘要/小结”章节）。
  const literal = /^\s*(?:#{1,6}\s*|[-*+]\s*)?(?:验收结论|整体结论|Acceptance verdict|Overall verdict)\s*[:：]/i
  const literalHits = lines.filter((l) => literal.test(l))
  const accLine = literalHits.length ? literalHits[literalHits.length - 1].replace(/\|.*/, '').trim() : ''
  // M3 架构门禁：明确的架构打回信号 → rework（无论结论行写没写「通过」）。
  // 修正误杀（tf-mt1pulkw）：验收正文「架构一致性核验 — PASS，无返工项」被朴素正则
  // 当成打回信号 → 误判 rework。现在改为「独立断言词 + 否定保护」：
  //   打回信号 = 出现明确的架构缺陷断言词（重复实现/偏离蓝图/该拆未拆… 或 架构…返工/打回/需重构），
  //             且未被否定保护（无返工/非漂移/M3 PASS/架构一致性良好/无该抽象未抽象…）覆盖时。
  const hasArchRedFlag =
    /重复实现|重复适配|偏离蓝图|未按蓝图|该拆未拆|该抽象未抽象|破坏既有结构|结构性.*问题|架构(打回|需重构)|需.*返工|返工.*项.*(存在|仍)|仍.*(返工|重构)/.test(acc)
  const archNegated =
    /无返工|无.*返工|不返工|无架构打回|无.*打回|非漂移|无.*重复|无.*偏离|无.*抽象.*问题|无.*蓝图.*问题|架构一致性.*(PASS|良好|达标|通过|无问题)|M3.*(PASS|通过|达标)|架构.*(达标|无问题|良好)/.test(acc)
  if (hasArchRedFlag && !archNegated) return 'rework'
  // 「📝 需求不适用」= 验收负责人专用强结论词，**但只认"行首为结论"的写法**（2026-09-17 实测修 bug
  // `tf-mu4i779p-kze5kl`）：真实报告会在标题/正文里**引用并论证它不适用**——「### 5.3 为什么不判
  // 「📝 需求不适用」」+「dev 结果并非「无需改动」」——旧的全文匹配据此把一份 `⚠️ 有条件通过` 的报告
  // 判成 reject（run 落 failed + 需人工）。现改为**行首锚定**：剥掉 markdown/列表/表格前缀与结论标签后
  // 该行必须**以 📝 + 需求不适用 开头**才算（`## 📝 需求不适用` / `验收结论：📝 需求不适用` /
  // `| 📝 需求不适用 | … |` 都算；`5.3 为什么不判「📝 …」` 不算）。
  const naLead = acc.split('\n').map((l) => String(l)
    .replace(/^[\s#*\-+>|]+/, '')
    .replace(/^(?:验收结论|整体结论|结论|判定|Acceptance verdict|Overall verdict|Conclusion|Verdict)\s*[:：]\s*/i, ''))
  if (naLead.some((l) => /^📝\s*(?:需求不适用|Not applicable|N\/A)/i.test(l))) return 'reject'
  // 结论行显式否定 → rework；✅ 通过同现时通过词优先；双重否定保护（无不通过/未发现不通过=通过）
  // en 新增（AC-6）：`fail/failed/not pass/not passed` 进否定词表；**明确不把裸 `rework` 当否定词**
  // ——en 模板 `⚠️ Conditional pass (rework items listed)` 含 `rework`，混入即误判打回。
  // `no failed/no failures` 与中文否定保护同效；通过词用负向先行断言排除 `not passed` 里的 `passed`。
  if (
    /不通过|需返工|未通过|\b(?:fail|failed|not pass|not passed)\b/i.test(accLine) &&
    !/无\s*不通过|未发现不通过|未出现不通过|no failed|no failures/i.test(accLine)
  ) {
    if (/✅\s*通过|(?<!not\s)\bpass(?:ed)?\b|⚠️\s*conditional\s+pass/i.test(accLine)) return 'accepted'
    return 'rework'
  }
  if (!/通过|✅|⚠️/.test(accLine) && /需求不适用|需求与实际不符|需求站不住|需求无效|无需改动|无需修改|not applicable|requirement (?:does not|invalid)/i.test(accLine)) return 'reject'
  if (!accLine) return 'needs-human'
  // 结论行存在但未命中任何四档词（空结论行「验收结论：」/待定/无结论）→ 不猜结论（漏报变体：
  // 旧实现只对「无结论行」→ needs-human，前缀残留的空行因 accLine 非空漏回 accepted）
  // en 新增档位词（`Pass`/`Fail`/`Not applicable`，AC-6）：无 emoji 的英文结论行不得漏成 needs-human。
  // 单独成行而**不改写**下面的中文四档白名单——`test/smoke.js` 对该行做源码断言（改之即红）。
  if (!/通过|✅|⚠️|❌|📝/.test(accLine) && /\bpass(?:ed)?\b|\bfail(?:ed)?\b|not applicable/i.test(accLine)) return 'accepted'
  if (!/通过|✅|⚠️|❌|📝/.test(accLine)) return 'needs-human'
  return 'accepted'
}

/** 架构蓝图（M1/M2）：tech/architect 阶段的产物契约，host 解析注入 dev。 */
export interface BlueprintModule {
  responsibility: string
  /** 模块对外暴露的 API **精确签名**（dev 必须逐字使用，不得自创成员名）。
   *  2026-09-28 增：复盘 tf-mul4t5ga-ajs4i4（贪吃蛇）发现「蓝图只定文件边界、不定接口」是产出不可用的
   *  头号原因——两个任务对同一模块各写一套方法名（main.js 调 `GameEngine.move/render/toggleRunning`，
   *  实际是 `update/draw/start|stop`），打开页面第一帧就 TypeError，而 QA 的「文件存在/有 export」
   *  清单全绿通过。接口契约必须与文件边界**同时**给出。 */
  api?: string[]
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

/** 蓝图 JSON 的原始形状（未经归一，字段全部可选）。 */
type BlueprintShape = {
  summary?: string
  modules?: Record<string, BlueprintModule>
  duplications?: string[]
  tasks?: BlueprintTask[]
}

// ⚠️ open 标记**不带尾部 `-->`**（2026-10-09 修正）：`<!-- blueprint -->` 是**自闭合注释**
// （`<!--` + `blueprint` + `-->`），渲染器把整条消化掉，紧随其后的 JSON 于是成了**裸文本**，
// 在 Typora / VS Code 预览里直接显示给用户（实测：markdown-it + 无头 Chrome）。
// 解析器**两种形态都认**（见下方 `(?:-->)?`），兼容存量产物与模型旧习惯。
const bdOpen = '<!-- blueprint'
const bdClose = '<!-- /blueprint -->'

/**
 * 从 tech/architect 产出中提取架构蓝图 JSON 块。
 * 约定：产出内嵌 `<!-- blueprint` ＋换行＋ `{...json...}` ＋ `<!-- /blueprint -->`。
 * 解析失败返回 null（不影响主流程）。
 */
/**
 * 抢救「顶层值提前闭合」类畸形蓝图 JSON。
 * 实锤（run tf-mt85o5jj）：模型在 duplications 数组后多写一个 `}`，根对象提前闭合，
 * 后续 `,"tasks":[…]` 被判为 JSON 外内容 → 整块解析失败 → 开发任务回退单任务「整体开发」，并行度丢失。
 * 修复策略：定位 parse 报错位置；若 head 是完整对象（以 } 收尾）且 tail 是 `,"key":` 续写形态，
 * 删掉 head 末尾那个提前闭合的根括号后拼接重试（最多 3 轮）。
 */
function repairBlueprintJson(raw: string): string | null {
  let cur = raw
  for (let round = 0; round < 3; round++) {
    let err: unknown = null
    try { JSON.parse(cur); return cur } catch (e) { err = e }
    const m = String(((err as Error) && (err as Error).message) || '').match(/position (\d+)/)
    if (!m) return null
    const pos = Number(m[1])
    const head = cur.slice(0, pos)
    const tail = cur.slice(pos)
    if (!/^\s*,?\s*"/.test(tail)) return null
    if (!/\}\s*$/.test(head)) return null
    cur = head.replace(/\}\s*$/, '') + tail.replace(/^\s*,\s*/, ',')
  }
  return null
}

export function extractBlueprint(
  text: string | null | undefined,
  locale?: HostLocale | null,
  diag?: BlueprintRepairDiag,
): Blueprint | null {
  const s = String(text || '')
  const i = s.indexOf(bdOpen)
  const j = s.indexOf(bdClose)
  if (i === -1 || j === -1 || j <= i) return null
  // 兼容两种 open 形态：新的 `<!-- blueprint`＋换行、旧的 `<!-- blueprint -->`（自闭合）—— 跳过可选的 ` -->`
  const after = s.slice(i + bdOpen.length)
  const lead = after.match(/^\s*(?:-->)?\s*/)
  const start = i + bdOpen.length + (lead ? lead[0].length : 0)
  if (j <= start) return null
  const raw = s.slice(start, j).trim()
  const parsed = parseBlueprintJson(raw, diag)
  if (!parsed) return null
  return toBlueprint(parsed, locale)
}

/**
 * 抢救「**末尾截断**」的蓝图 JSON（2026-10-11 实锤 `tf-mv3op3i2-0ok7nb`）。
 *
 * 现象：模型把 5937 字符的完整蓝图写进 `blueprint.json`，尾部**少了 1 个 `}`** ⇒ `JSON.parse` 失败；
 * 而 `repairBlueprintJson` 只治「**提前闭合**」（某个值后面多写一个 `}`），救不了「**末尾没收**」
 * ⇒ 蓝图整片丢失、dev 退化为单任务整体开发（该 run 规划了 12 个任务，实际只跑了 1 个）。
 *
 * 策略：扫一遍字符（跳过字符串字面量与转义），统计未闭合的 `{` / `[`，按栈逆序补齐闭合符。
 * ⚠️ **只在「截断不在字符串内、且转义已收尾」时才补**：断在字符串中间或转义符后 = 内容本身残缺，
 * 硬补会得到一个「语法合法但语义缺失」的对象 —— 那比直接失败更危险（下游会拿残缺蓝图当权威）。
 */
function closeTruncated(raw: string): string | null {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (esc) { esc = false; continue }
    if (ch.charCodeAt(0) === 92) { esc = true; continue } // 92 = 反斜杠
    if (ch === '"') { inStr = !inStr; continue }
    if (inStr) continue
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') {
      const want = ch === '}' ? '{' : '['
      if (stack[stack.length - 1] === want) stack.pop()
    }
  }
  if (inStr || esc || stack.length === 0) return null
  return raw + stack.slice().reverse().map((x) => (x === '{' ? '}' : ']')).join('')
}

/** `JSON.parse` ＋ 两种畸形抢救：**末尾截断**（`closeTruncated`）→ **提前闭合**（`repairBlueprintJson`）。非对象 ⇒ null。 */
/** 蓝图抢救的诊断出口（「修过」这件事必须可见，否则契约违约会长期静默）。 */
export interface BlueprintRepairDiag {
  /** 非法 JSON 转义（如 `\.` / `\[`）被自动加倍修复过 */
  repairedEscapes?: boolean
}

/**
 * 修复 JSON **字符串内的非法转义**（2026-10-26 真机 `tf-mvp5tdie-ma36fk` 实锤）。
 *
 * 由来：模型把正则**原样**写进蓝图的 `spec` / `api` 字段（`/\.md$/i`、`/\[\[[^\[\]]+?\]\]/`），
 * 而 JSON 只允许 `\" \\ \/ \b \f \n \r \t \uXXXX` ⇒ `JSON.parse` 抛
 * 「Bad escaped character in JSON at position 4634」⇒ **6.2KB 蓝图（6 模块 / 7 任务）整份丢弃**
 * ⇒ dev 退化为单任务整体开发（实测该轮 dev 87 calls / 4.8M cacheRead，原本可拆 7 卡）。
 *
 * 为什么**可以**确定性地加倍（客观判据，不猜内容）：非法转义在 JSON 里没有第二种解释，
 * 作者只可能想写一个**字面反斜杠**；加倍是唯一不改变语义的修法（MEMORY §2：不依赖模型自律）。
 * 同时修**裸控制字符**（字符串内的裸换行/制表符）—— 同一类病（直接粘贴多行文本），JSON 里只允许转义形式。
 *
 * 只在**字符串内部**动手（`"` 状态机）：字符串外的反斜杠在合法 JSON 里不存在。
 * 没有可修之处 ⇒ 返回 `null`（调用方据此区分「修过」与「本来就没问题」）。
 */
export function repairJsonEscapes(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || !raw) return null
  let out = ''
  let inStr = false
  let changed = false
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (!inStr) {
      out += c
      if (c === '"') inStr = true
      continue
    }
    if (c === '"') { inStr = false; out += c; continue }
    if (c === '\\') {
      const n = raw[i + 1]
      if (n === undefined) { out += '\\\\'; changed = true; continue }
      const okSimple = '"\\/bfnrt'.indexOf(n) >= 0
      const okUnicode = n === 'u' && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 2, i + 6))
      if (okSimple) { out += '\\' + n; i += 1; continue }
      if (okUnicode) { out += '\\u'; i += 1; continue }
      // 非法转义（`\.` `\[` `\d` `\s` `\w` …）⇒ 当作字面反斜杠加倍
      out += '\\\\' + n
      i += 1
      changed = true
      continue
    }
    const code = c.charCodeAt(0)
    if (code < 0x20) {
      changed = true
      out += c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : '\\u' + code.toString(16).padStart(4, '0')
      continue
    }
    out += c
  }
  return changed ? out : null
}

function parseBlueprintJson(raw: string, diag?: BlueprintRepairDiag): BlueprintShape | null {
  let parsed: unknown = null
  let repairedEscapes = false
  const tryParse = (cand: string | null): boolean => {
    if (typeof cand !== 'string' || !cand) return false
    try { parsed = JSON.parse(cand); return true } catch (e) { parsed = null; return false }
  }
  if (!tryParse(raw)) {
    // 三种病互不覆盖，挨个试：①末尾截断（补闭合）②非法转义（2026-10-26 那类）
    // ③顶层值提前闭合（历史那类）；**两种同时犯**时先补闭合或先修转义各试一遍。
    const esc = repairJsonEscapes(raw)
    const closed = closeTruncated(raw)
    const candidates: Array<{ text: string | null; esc: boolean }> = [
      { text: closed, esc: false },
      { text: esc, esc: true },
      { text: closed ? repairJsonEscapes(closed) : null, esc: true },
      { text: repairBlueprintJson(raw), esc: false },
      { text: esc ? closeTruncated(esc) : null, esc: true },
    ]
    for (const c of candidates) {
      if (tryParse(c.text)) { repairedEscapes = c.esc; break }
    }
  }
  if (diag) diag.repairedEscapes = repairedEscapes
  return parsed && typeof parsed === 'object' ? (parsed as BlueprintShape) : null
}

/**
 * 蓝图**文件通道**的内容 → `Blueprint`（2026-10-09）。
 *
 * 契约要求文件里是**纯 JSON**（无标记），但模型可能顺手把 `<!-- blueprint -->` 标记也写进去
 * ⇒ 两种都吃：先按标记块提取（带 repair 抢救），失败再直接 parse 整份内容。
 */
export function blueprintFromText(
  raw: string | null | undefined,
  locale?: HostLocale | null,
  diag?: BlueprintRepairDiag,
): Blueprint | null {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  if (s.indexOf('<!--') >= 0) {
    const byMark = extractBlueprint(s, locale, diag)
    if (byMark) return byMark
  }
  const parsed = parseBlueprintJson(s, diag)
  return parsed ? toBlueprint(parsed, locale) : null
}

/** 已解析的蓝图对象 → `Blueprint`（`render` 按 locale 输出）。 */
function toBlueprint(parsed: BlueprintShape, locale?: HostLocale | null): Blueprint {
  const summary = typeof parsed.summary === 'string' ? parsed.summary : ''
  const modules = parsed.modules || {}
  const duplications = Array.isArray(parsed.duplications) ? parsed.duplications : []
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : []
  // render 包裹标签按 locale 输出（缺省/zh → 现状中文逐字不变；en → 新增英文）。
  // 与 buildRetryDiagnostic 同理：冻结键表未给 blueprint.* 键名，故文案自带于此，避免缺 key 回落成 key 字面量。
  const en = locale === 'en'
  const parts: string[] = []
  if (summary) parts.push(en ? `Architecture judgment: ${summary}` : `架构判断：${summary}`)
  const modEntries = Object.entries(modules)
  if (modEntries.length) {
    parts.push(en
      ? `Module blueprint: ${modEntries.map(([f, m]) => `${f}→${m.responsibility || ''}${m.api && m.api.length ? ` [API: ${m.api.join(' | ')}]` : ''}${m.why ? ` (${m.why})` : ''}`).join('; ')}`
      : `模块蓝图：${modEntries.map(([f, m]) => `${f}→${m.responsibility || ''}${m.api && m.api.length ? `【接口：${m.api.join(' | ')}】` : ''}${m.why ? `（${m.why}）` : ''}`).join('；')}`)
  }
  if (duplications.length) parts.push(en ? `Duplication risks: ${duplications.join('; ')}` : `重复风险：${duplications.join('；')}`)
  if (tasks.length) parts.push(en ? `Decomposed tasks: ${tasks.map((t) => t.title).join(', ')}` : `架构拆解任务：${tasks.map((t) => t.title).join('，')}`)
  const head = en
    ? '[Architecture blueprint (produced by the tech stage; implement on the existing architecture, do not rebuild)]'
    : '【架构蓝图（tech 阶段产出，dev 须在既有架构上实现，勿重建）】'
  return { summary, modules, duplications, tasks, render: `${head}\n${parts.join('\n')}` }
}

/**
 * 文件交集冲突合并（GitHub issue #4 护栏的**共用实现**）。
 *
 * 语义：如果两个 dev 任务声明的**可写**文件集有交集，它们会被合成**一个**任务交给一个子代理串行执行，
 * 从而保证「任意两个并发子代理的可写文件集互斥」——这是本插件对「并行开发不抢同一文件」的
 * 唯一硬护栏（另有 prompt 软约束与宿主 CAS 兜底，不可依赖）。
 *
 * **owns / reads（2026-09-24）**：`files` = 该任务**会改**的文件（owns，判定只看它）；
 * `reads` = 只读依赖（读接口/调用关系，不改，如 types.ts、既有模块）。
 * 只读接触不产生互斥：两个任务都读 types.ts 却都要改各自的文件，本可以并行——
 * 旧谓词（把"接触过的文件"一律当冲突）会把它们强行串行。实测这部分代价：158 任务 → 137 组（损失 13%），
 * 而**真并发双写 0 次**（199 对可观测并发舞台）⇒ 旧谓词明显偏保守。
 * **安全默认**：`reads` 必须显式声明才有，缺省一律当 owns ⇒ 模型不标/标错时行为与旧实现一致（零风险）。
 *
 * **不变量（测试锁死，勿改）**：
 *  - 返回的分组两两之间文件集**不相交**（并查集式的传递闭包：A∩B、B∩C ⇒ A/B/C 同组，即使 A∩C 为空）；
 *  - `ids` 是身份累加，合并前各任务的 id 全部保留——丢失会让 resume 判定「没做过」而重复补跑
 *    （同型事故见 `test/dev-task-id.test.js` 头部注释）；
 *  - `files` 为空的任务**不参与合并**（无边界可判），独立成组；调用方知道这组没有护栏。
 *
 * 抽成 util 纯函数的原因：首次实现只写在了正常路径里（`pipeline.ts` executePipeline 的 dev 分支），
 * **resume 补跑分支直接把未合并的 task list 丢进了 runPool** —— 于是「首次执行有护栏、补跑没有护栏」，
 * 实锤 run `tf-mu6tb281-4n43oc` 第三轮里 T0/T5/T6 同时起跑且共享 package.json/tsdown.config.ts/README.md。
 * 两条路径必须共用这一个函数，否则同样的洞会再开一次。
 *
 * ⚠️ **一个已修的实现坑（2026-09-24，随机用例实锤）**：初版写成「找**第一个**有交集的组就往里塞」，
 *   不变量是不成立的。反例：G1={A,B} 先建、G2={C} 后建（当时确实与 G1 不相交），第三个任务
 *   X={B,C} 同时命中两组，只并进 G1 → G1 变成 {A,B,C}，此刻 **G1∩G2={C}** —— 护栏失效，
 *   两个子代理又能并发写 C。正确做法是「把所有命中组连同本任务**一起并成一个组**」（下面这段）。
 */
export function mergeFileOverlaps(
  defs: Array<{ id: string; title: string; spec?: string; files?: string[]; reads?: string[] }>,
): Array<{ ids: string[]; title: string; spec: string; files: string[] }> {
  const list = defs || []
  /** ① 未知边界：任一任务没声明 `files` ⇒ 它可能写任何地方 ⇒ 与**所有**任务互斥（B1 严格版）。
   *  现状下调用方没地方声明（工具 schema 里 tasks 只有 title/spec），所以多任务一律全合并串行——
   *  慢，但不会抢写；想并行就声明 files（见 `normalizeTasks`）。单任务场景（整体开发兜底）不受影响。 */
  if (list.some((t) => !(Array.isArray(t.files) && t.files.length))) {
    return [list.reduce((acc, t, i) => {
      if (i > 0) { acc.title = `${acc.title} + ${t.title}`; acc.spec = `${acc.spec}${t.spec ? `；${t.spec}` : ''}` }
      else { acc.title = t.title; acc.spec = t.spec || '' }
      acc.ids.push(t.id)
      for (const f of (Array.isArray(t.files) ? t.files : [])) if (!acc.files.includes(f)) acc.files.push(f)
      return acc
    }, { ids: [] as string[], title: '', spec: '', files: [] as string[] })]
  }
  /** ② 判定谓词是 **owns ∩ owns**（`files`），**不是** "接触过的文件"：
   *  `reads`（只读依赖，如 types.ts / 既有模块接口）不产生任何互斥——见函数头注释。 */
  let groups: Array<{ ids: string[]; title: string; spec: string; files: string[] }> = []
  for (const t of list) {
    const files = Array.isArray(t.files) ? t.files : []
    const hits = files.length ? groups.filter((g) => g.files.some((f) => files.includes(f))) : []
    if (!hits.length) {
      groups.push({ ids: [t.id], title: t.title, spec: t.spec || '', files: [...files] })
      continue
    }
    // 命中多个组 ⇒ 本任务把它们「桥接」起来了，必须一次并成一个组（不变量要求）
    const head = hits[0]
    for (const g of hits.slice(1)) {
      head.ids.push(...g.ids)
      head.title = `${head.title} + ${g.title}`
      head.spec = `${head.spec}${g.spec ? `；${g.spec}` : ''}`
      for (const f of g.files) if (!head.files.includes(f)) head.files.push(f)
    }
    groups = groups.filter((g) => g === head || !hits.includes(g))
    head.ids.push(t.id)
    head.title = `${head.title} + ${t.title}`
    head.spec = `${head.spec}${t.spec ? `；${t.spec}` : ''}`
    for (const f of files) if (!head.files.includes(f)) head.files.push(f)
  }
  return groups
}

/**
 * **依赖分波调度**（GitHub issue #4 的第三/AC3 答案；2026-09-24 Run 3 实证后引入）。
 *
 * 「合并」解决了 AC1（不并发写同一文件），代价是**整批串行**：Run 3 实锤——
 * 5 个任务里有 1 个（提交任务）声明了空的 `files`，严格规则就把另外 4 个本可并行的任务也拖下水。
 * 本函数把两种手段分开，各管一段：
 *
 *  - **write ∩ write（可写文件相交）→ 仍然合并**。为什么不用"先后两波"代替合并：两个 agent 先后改同一个
 *    文件是 last-writer-wins，后写的可能把前写的语义推翻；合并成一个 agent 至少是**一个上下文里调和**。
 *  - **依赖边 → 排序而不是合并**。依赖边有三类来源（都是**已有声明**，不新增契约）：
 *    ① `reads` 命中别人的 `files`（读刚被改写的接口）⇒ 读方排在写方之后；
 *    ② `dependsOn`（任务级 id 或"被依赖方的某个 owns 文件"）⇒ 显式顺序；
 *    ③ **未声明 `files`**（写集未知 ⇒ 与一切互斥）⇒ 独占最后一波，其余任务的并行度不受影响。
 *
 * **执行模型**：`waves[i]` 内的组**可以并行**，`waves[i]` 整体结束才启动 `waves[i+1]`。
 * 所以同一波内的组必须两两写集互斥（由 `mergeFileOverlaps` 的不变量保证），
 * 跨波则天然不存在并发 ⇒ **AC1 依然成立**，与「全合并串行」等价安全、却拿回了并行度。
 *
 * **失败传播（AC3）**：调用方按波推进，某波出现失败即不再启动后续波（未执行的组记账为失败，resume 会补跑）。
 * 声明出来的依赖如果被跳过，下游拿到的就是半成品——跑下去只是烧 token。
 *
 * **环的处理（Run 3 实锤的形状）**：模型可能标出互相矛盾的依赖——r3 蓝图里 T2 reads T3 的 owns、
 * T3 又 reads T2 的 owns。若把环上的组各自降级成独占一波，r3 会退化成 5 波全串行（比合并还差）。
 * 所以按**软依赖**处理：边按声明顺序增量插入 DAG，**会成环的边直接丢弃**并在 `dropped` 里计数供日志暴露。
 * 丢弃的代价是「读方可能与写方同波，读到改写前的状态」（波是同步屏障，不存在读到半写状态）——
 * 比起挂死或全串行，这是可接受的降级，且日志会点名（值得回看蓝图，而不是静默吞掉）。
 *
 * **安全默认不变**：不声明 `reads` ⇒ 没有依赖边 ⇒ 与分波前完全一致；声明了才可能更慢（排序）或更快（不再被拖累）。
 *
 * @returns `groups` 是波次展开后的**扁平顺序**（调用方用它对齐子卡/结果与 resume 判定）
 */
export interface DevPlanGroup {
  ids: string[]
  title: string
  spec: string
  files: string[]
  reads: string[]
  /** 本组必须排在 `after` 中每个扁平下标对应的组之后 */
  after: number[]
}
export interface DevPlan {
  waves: DevPlanGroup[][]
  groups: DevPlanGroup[]
  missingBoundary: string[]
  deps: Array<{ from: number; to: number; via: string }>
  /** 因会成环而被丢弃的依赖边数（**只应出现在兜底分支**：正常路径改为串行化，见 cycleMerged） */
  dropped: number
  /** 因依赖成环而改成串行链的处数（0 = 声明无矛盾） */
  cycleMerged: number
  /** 因 write∩write 被吸收掉的任务数（= 合并损失的任务粒度）= 已知边界任务数 − 写互斥组数 */
  merged: number
}
export function planDevWaves(
  defs: Array<{ id: string; title: string; spec?: string; files?: string[]; reads?: string[]; dependsOn?: string[] }>,
): DevPlan {
  /* ── 成环 ⇒ 串行化，**不丢边**（2026-10-27 tf-mvpjqs87-14qdxa 实锤）───────────────
   * 旧行为：`reads` 被当软依赖，插入时若会成环就**丢弃这条边**（只 warn）。后果是硬伤：
   * 读者与写者进了同一波 ⇒ 读者读到写者改之前的状态，而两个任务都会报「完成」。
   * 实锤：T1 改 `YongShen.java` 的计权语义，T2 读 `YongShen.java` 且 T1 又读 T2 的
   * `LiuNian.java` —— 双向 reads ⇒ 丢边 ⇒ 同波 ⇒ T2 按旧计权写 golden，3 个用例一落地就是红的，
   * 但 T2 报完成、T1 只在 summary 里写「T2 文件有 3 个失败用例，我未改」。
   * 现在：成环的两个组**并成一条串行链**（组内串行是既有语义），宁可少一路并发，也不让
   * 「读到旧状态」成为设计保证会发生的事。环很大时逐轮吸收，仍不行则全并成一条链（正确性优先）。
   */
  const list = Array.isArray(defs) ? defs : []
  const forced: string[][] = []
  let cycleCount = 0
  let lastPlan: DevPlan | null = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = planDevWavesPass(list, forced)
    lastPlan = r.plan
    if (!r.cycles.length) { r.plan.cycleMerged = cycleCount; return r.plan }
    for (const ids of r.cycles) if (ids.length > 1) { forced.push(ids); cycleCount += 1 }
  }
  // 兜底：5 轮仍成环（理论上不该发生）⇒ 全部并成一条串行链
  const all = list.filter((t) => Array.isArray(t.files) && t.files.length > 0).map((t) => t.id)
  if (all.length > 1) {
    const r = planDevWavesPass(list, [all])
    if (!r.cycles.length) { r.plan.cycleMerged = cycleCount + 1; return r.plan }
  }
  if (lastPlan) lastPlan.cycleMerged = cycleCount
  return lastPlan as DevPlan
}

/** 把「必须串行」的任务集合落实为**同一组**（组内串行是既有语义，不需要新的执行语义）。 */
function forceMergeGroups<T extends { ids: string[]; title: string; spec?: string; files: string[] }>(
  groups: T[],
  forced: string[][],
): T[] {
  let out = groups.map((g) => ({ ...g, ids: [...g.ids], files: [...g.files] }))
  for (const set of forced) {
    const hit = out.map((g, i) => (g.ids.some((id) => set.includes(id)) ? i : -1)).filter((i) => i >= 0)
    if (hit.length < 2) continue
    const base = out[hit[0]]
    for (const i of hit.slice(1)) {
      const g = out[i]
      for (const id of g.ids) if (!base.ids.includes(id)) base.ids.push(id)
      for (const f of g.files) if (!base.files.includes(f)) base.files.push(f)
      base.title = `${base.title} + ${g.title}`
      base.spec = [base.spec, g.spec].filter(Boolean).join('；')
      ;(out as Array<T | null>)[i] = null
    }
    out = (out as Array<T | null>).filter((g): g is T => g !== null)
  }
  return out
}

/** 单轮规划（可能成环）。`cycles` 里每项是「必须串行」的 id 集合；非空 ⇒ 调用方合并后重算。 */
function planDevWavesPass(
  list: Array<{ id: string; title: string; spec?: string; files?: string[]; reads?: string[]; dependsOn?: string[] }>,
  forcedMerge: string[][],
): { plan: DevPlan; cycles: string[][] } {
  const blank: DevPlan = { waves: [], groups: [], missingBoundary: [], deps: [], dropped: 0, merged: 0, cycleMerged: 0 }
  if (!list.length) return { plan: blank, cycles: [] }
  const declared = (t) => Array.isArray(t.files) && t.files.length > 0
  const known = list.filter(declared)
  const unknown = list.filter((t) => !declared(t))

  /** ① 写互斥：仍然靠合并（`mergeFileOverlaps` 的不变量 = 组内串行、组间 files 不相交）。
   *  成环被迫串行的组在这里一并并掉（`forceMergeGroups`）。 */
  const rawGroups = known.length ? mergeFileOverlaps(known) : []
  const writeGroups = forcedMerge.length ? forceMergeGroups(rawGroups, forcedMerge) : rawGroups
  const byId = new Map(list.map((t) => [t.id, t]))
  const groupOfTask = new Map()
  writeGroups.forEach((g, i) => { for (const id of g.ids) groupOfTask.set(id, i) })

  const groups: DevPlanGroup[] = writeGroups.map((g) => {
    const reads: string[] = []
    for (const id of g.ids) {
      const m = byId.get(id)
      if (!m) continue
      for (const f of Array.isArray(m.reads) ? m.reads : []) {
        const s = String(f || '').trim()
        if (s && !reads.includes(s)) reads.push(s)
      }
    }
    return { ids: g.ids, title: g.title, spec: g.spec, files: g.files, reads, after: [] }
  })

  /** ② 未知写集 ⇒ 独占最后一波：它可能写任何文件，所以必须排在**所有**已知组之后（边见 ③）。 */
  const unknownIdx = groups.length
  if (unknown.length) {
    groups.push({
      ids: unknown.map((t) => t.id),
      title: unknown.map((t) => t.title).join(' + '),
      spec: unknown.map((t) => t.spec || '').filter(Boolean).join('；'),
      files: [],
      reads: [],
      after: [],
    })
  }

  /** ③ 依赖边（环安全增量插入）：
   *  - `dependsOn`：任务 id 或"对方的 owns 文件"（显式声明，优先插入）；
   *  - `reads` 命中别人的 `files` ⇒ 读方排在写方之后（软依赖，按组的声明顺序插入）；
   *  - 未知写集组 ⇒ 排在所有已知组之后。
   *  插入时若 `to` 已能到达 `from`（会成环）⇒ **丢弃这条边**并计数。 */
  const fileOwners = new Map()
  writeGroups.forEach((g, i) => {
    for (const f of g.files) {
      let a = fileOwners.get(f)
      if (!a) { a = []; fileOwners.set(f, a) }
      a.push(i)
    }
  })
  const deps: Array<{ from: number; to: number; via: string }> = []
  /** 成环被迫串行的 id 集合（上层据此合并重算）。 */
  const cycles: string[][] = []
  const seen = new Set()
  const adj = groups.map(() => [] as number[])
  let dropped = 0
  const reaches = (from: number, to: number): boolean => {
    const stack = [from]
    const visited = new Set()
    while (stack.length) {
      const x = stack.pop()
      if (x === to) return true
      if (visited.has(x)) continue
      visited.add(x)
      for (const y of adj[x]) stack.push(y)
    }
    return false
  }
  const addEdge = (from: number, to: number, via: string) => {
    if (from < 0 || to < 0 || from === to) return // 同组 ⇒ 已由「合并成同一子节点」解决，无需排序
    const key = from + '>' + to
    if (seen.has(key)) return
    if (reaches(to, from)) {
      // 会成环：这条边**不能插**（图必须保持无环），但也不再「丢掉算了」——
      // 记下两端组的 id，由上层并成一条串行链后重算（见 planDevWaves 头注释）。
      dropped += 1
      cycles.push([...groups[from].ids, ...groups[to].ids])
      return
    }
    seen.add(key)
    adj[from].push(to)
    deps.push({ from, to, via })
  }
  groups.forEach((g, to) => {
    for (const r of g.reads) {
      const owners = fileOwners.get(r)
      if (owners) for (const from of owners) addEdge(from, to, r)
    }
  })
  for (const t of list) {
    const to = groupOfTask.get(t.id)
    if (to === undefined) continue // 未知写集组恒在最后，其成员的 dependsOn 不再参与（顺序已由 after 边决定）
    for (const d of Array.isArray(t.dependsOn) ? t.dependsOn : []) {
      const key = String(d || '').trim()
      if (!key) continue
      const direct = groupOfTask.get(key)
      if (direct !== undefined) { addEdge(direct, to, key); continue }
      const viaFile = fileOwners.get(key)
      if (viaFile) for (const from of viaFile) addEdge(from, to, key)
    }
  }
  if (unknown.length) for (let i = 0; i < unknownIdx; i++) addEdge(i, unknownIdx, '(write set unknown)')
  for (const d of deps) groups[d.to].after.push(d.from)

  /** ④ Kahn 分层（同一层内并行）。边已环安全 ⇒ 必然排空，不存在 leftovers。 */
  const n = groups.length
  const indeg = Array.from({ length: n }, () => 0)
  const succ = Array.from({ length: n }, () => [] as number[])
  for (const d of deps) { succ[d.from].push(d.to); indeg[d.to] += 1 }
  const waves: DevPlanGroup[][] = []
  let front: number[] = []
  for (let i = 0; i < n; i++) if (indeg[i] === 0) front.push(i)
  while (front.length) {
    waves.push(front.map((i) => groups[i]))
    const next: number[] = []
    for (const i of front) for (const j of succ[i]) if (--indeg[j] === 0) next.push(j)
    front = next
  }
  /** ⑤ 统一下标空间：`after`/`deps` 以**建组顺序**记下标，但对外契约是**波次展开的扁平顺序**——
   *  两个空间在排序后通常不一致（环安全丢边会改变次序）。不换算的话，调用方拿 after 查 groups
   *  会查到错的组（测试 [10] 实锤）。 */
  const flat = waves.flat()
  const remap = new Array(n)
  flat.forEach((g, i) => { remap[groups.indexOf(g)] = i })
  for (const g of flat) {
    g.after = g.after.map((a) => remap[a]).filter((x) => x !== undefined && x >= 0)
  }
  return {
    plan: {
      waves,
      groups: flat,
      missingBoundary: unknown.map((t) => t.id),
      deps: deps.map((d) => ({ from: remap[d.from], to: remap[d.to], via: d.via })),
      dropped,
      merged: known.length - writeGroups.length,
      cycleMerged: 0,
    },
    cycles,
  }
}

/**
 * 并发写冲突**事后检测**（issue #4 的第三道防线）。
 *
 * 为什么还需要它：`mergeFileOverlaps` 只在**声明**了 `files` 时有效，宿主 CAS（`FS_STALE_VERSION`）
 * 也只覆盖走文件编辑工具的写入。任务没声明边界、或 agent 越界用 shell 改写文件时，两者都看不到。
 * 本函数拿各 dev 舞台**自报**的 `touched`（state block 里的变更文件），在时间窗相交的任务之间求文件交集——
 * 命中即「确实发生了并发抢写」，无论它是怎么绕过前两道防线的。
 *
 * 纯函数、无宿主依赖：可以在行为级测试里直接喂时间戳与文件清单断言（见 `test/overlap-merge.test.js`）。
 *
 * @param entries 每个 dev 舞台的实际执行窗口与自报改动文件
 * @returns 冲突列表（两两一对），按重叠时长降序
 */
export function concurrentWriteConflicts(
  entries: Array<{ key: string; startedAt: number; endedAt: number; files: string[] }>,
): Array<{ a: string; b: string; files: string[]; overlapMs: number }> {
  const out: Array<{ a: string; b: string; files: string[]; overlapMs: number }> = []
  for (let i = 0; i < entries.length; i++) for (let k = i + 1; k < entries.length; k++) {
    const A = entries[i], B = entries[k]
    if (!(Array.isArray(A.files) && Array.isArray(B.files))) continue
    const overlapMs = Math.min(A.endedAt, B.endedAt) - Math.max(A.startedAt, B.startedAt)
    if (overlapMs <= 0) continue // 时间上没交集 → 串行执行，不可能抢写
    const files = A.files.filter((f) => B.files.includes(f))
    if (files.length) out.push({ a: A.key, b: B.key, files, overlapMs })
  }
  return out.sort((x, y) => y.overlapMs - x.overlapMs)
}

/**
 * 并发池：按 max 个 worker 消费 items，返回**同序**结果。
 *
 * `shouldStop`（可选）：取下一个任务**之前**判定，返回 true 即停止取新任务（已在飞的照常等它收尾），
 * 未取到的条目结果保持 `undefined`——**调用方必须容忍空位**（现有调用点一律 `r && …` 过滤）。
 *
 * 为什么要有它（2026-09-16 用户实测）：取消后被 dispose 的任务返回 null，worker 拿到结果会立刻
 * `cursor++` 取下一个任务并启动新子代理——用户按了「中断」，界面上却又冒出一个「开发中」
 * （取消变成了队列补位）。放在 util（无宿主私有依赖）而非 runner，是为了让行为级测试能直接喂 items 断言。
 */
export async function runPool(items, max, fn, shouldStop?: (() => boolean) | null) {
  // new Array 而非 Array.from：strict:false 下前者推断 any[]（results 承载各阶段异构返回值），
  // 后者是 unknown[]，会让 runPool 的每个消费点类型劣化（2026-09-26 实测 tsc 3 错）。
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, max), items.length) }, async () => {
    while (cursor < items.length) {
      if (shouldStop && shouldStop()) return
      const i = cursor++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 从产物文本里摘出「假设 / 待澄清」小节（2026-09-16 需求澄清闸门 Phase 1）。
 *
 * **行式解析而不是单条正则**——实测踩过两个坑（本批真 bug，实锤 run tf-mu34afd2-wcjaw1）：
 *  ① 产物标题常带编号/附录前缀（`## 9. 假设与待澄清`；本仓 PRD 惯例就是编号标题），
 *     `^#{1,6}\s*(假设|…)` 这类写法直接匹配不到 → 明明写了段落却误报「契约未兑现」；
 *  ② 正文用 `([\s\S]*?)(?=\n#{1,6}|\s*$)` 懒匹配时，`\s*$` 分支会在标题后立刻命中 → 摘出空串。
 * 规则：命中标题后一直取到下一个标题；`trim()` 后为空视为未记录（返回 null）。
 */
export function extractAssumptionsSection(doc: string | null | undefined): string | null {
  const text = String(doc || '')
  if (!text.trim()) return null
  const lines = text.split(/\r?\n/)
  const head = /^#{1,6}\s*(?:[0-9]+[.、)]\s*)?(?:附录\s*[0-9A-Za-z]*[.、)]?\s*)?(假设|待澄清|开放问题|assumptions|open questions?)/i
  const isHead = (l: string) => /^#{1,6}\s/.test(l)
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue
    const out: string[] = []
    for (let k = i + 1; k < lines.length; k++) {
      if (isHead(lines[k])) break
      out.push(lines[k])
    }
    const body = out.join('\n').trim()
    return body || null
  }
  return null
}

/**
 * 「宿主契约调研」小节的判定（2026-09-18 用户实锤新增，**硬门禁**）。
 *
 * 由来：teamflow 寄生在 dsh 上，我们对 dsh 的插件契约有权威（同仓样本可核实）；但用户明确说过
 * 「用户拿我们去干活，不只是干开发 dsh 插件」——开发 openclaw / hermes / pi 插件时，**dsh 的契约
 * 一条都不适用**（那些框架有各自的加载/注册机制），套过去就是反向返工。而我们**对它们没有权威**，
 * 凭记忆写字段名正是 dddd 事故的成因。
 *
 * 故规则：`plugin-*` 且目标宿主不是 dsh → PRD **必须**含「宿主契约调研」段（写清目标宿主是哪个、
 * 从哪儿读到它的插件加载契约、核实到哪些具体要求）。用户原话：「不然你上下文都不知道你开发个啥出来
 * 都不知道」——所以这条**偏硬**：缺失 → PRD 阶段失败（走重试，附诊断），而不是只记 warn。
 *
 * 解析方式与 `extractAssumptionsSection` 同源（行式 + 容错编号标题）：产物标题惯例带编号
 * （`## 7. 宿主契约调研`），单条正则匹配不到会误判"契约未兑现"（该坑已踩过一次）。
 */
export function extractHostResearchSection(doc: string | null | undefined): string | null {
  const text = String(doc || '')
  if (!text.trim()) return null
  const lines = text.split(/\r?\n/)
  const head = /^#{1,6}\s*(?:[0-9]+[.、)]\s*)?(?:附录\s*[0-9A-Za-z]*[.、)]?\s*)?(宿主契约调研|宿主调研|host contract research|host research)/i
  const isHead = (l: string) => /^#{1,6}\s/.test(l)
  for (let i = 0; i < lines.length; i++) {
    if (!head.test(lines[i])) continue
    const out: string[] = []
    for (let k = i + 1; k < lines.length; k++) {
      if (isHead(lines[k])) break
      out.push(lines[k])
    }
    const body = out.join('\n').trim()
    return body || null
  }
  return null
}

/* ── dev 任务身份与 resume 判定（2026-09-18 实锤修复，勿回退）─────────────────────────
 * 背景（probe-cache `tf-mu6tb281-4n43oc`，用户实测「T0 被触发两次，第一次明面成功了」）：
 *  ① 冲突检测把 files 有交集的任务**合并**成一个子代理执行，合并时 title 被**拼接**成
 *     `"T0 … + T6 … + T7 …"`（host 自己拼的，不是模型发挥）；旧实现只把 title 存进 `taskKey`；
 *  ② resume 时任务定义重新从蓝图取回**未合并**的 `T0 …`/`T6 …`/`T7 …`；
 *  ③ 判定按 title 全文精确匹配 → 三个都查不到 → 判「未完成」→ **重复执行已成功的工作**
 *     （backlog 里 `dev-1` 与 `dev-7` 同为 T0、`dev-8` 同为 T6，肉眼可见的重复卡）。
 * 修法：host 按定义顺序生成稳定 `dt-N` 作任务身份，合并时 `taskIds` 数组累加，判定只认 id。
 *
 * **为什么放在 util 而不是 pipeline**：判定必须可被行为级测试直接 import，而 pipeline 链到宿主私有
 * peer `@deepseek-ai/dsh-llm`（仓库内无 node_modules，测试取不到）——与 `cancelRun` 住 context.ts 同因。
 *
 * **禁止回退为「按 title 匹配」或「按分隔符切分 title」**：那是拿文本长相当身份，同型的错已犯过两次
 * （per-plugin 正则、固定 .gitignore 词表）。回归门禁 = `test/dev-task-id.test.js`（实锤形状复刻）。
 */

/** dev 阶段 label 的「开发 · 」前缀（zh 存量兼容 + en）。 */
const DEV_TITLE_PREFIX_LOCAL = /^(?:开发|Dev) · /
/** 重试/补跑后缀（zh + en：en 侧必须覆盖词典 `dev.taskRetry` 的实际产出 `(attempt N)`）。 */
const RETRY_SUFFIX_LOCAL = /(?:（(?:第 \d+ 次重试|补跑)）| \((?:retry \d+|attempt \d+|follow-up run)\))$/

/**
 * 任务级聚合（journal 驱动）：有 done stage = 该任务已成功（历史失败尝试不翻案）。
 *
 * **只认 `taskIds`，不认 title**（2026-09-18 二次修正）：
 * 一个 stage 可能同时承载多个任务（合并执行），逐 id 记账 → 合并执行过的任务**各自**命中已做。
 *
 * 关于存量（升级前只写了 title 的 stage）：**不在本函数里做 title 回退**——那会形成
 * 「id / title 两套命名空间」，实测必然全 Miss（补跑 8 个而非 2 个）。正确做法是调用方先跑
 * `backfillDevTaskIds` 给存量 stage 补算 id（用蓝图 title 结构化匹配），之后本函数只看到 id。
 * **判定逻辑因此始终只有一个键空间**，不做"双键匹配"、不切分 title。
 */
type DevStageRow = {
  taskKey?: string | null
  taskIds?: string[] | null
  label?: string
  seq?: number
  status?: string
}
type DevTaskStatus = { done: boolean; lastStatus: string | null; lastSeq: number }
export function devTaskStatuses(stages: Array<DevStageRow>): Map<string, DevTaskStatus> {
  const m = new Map<string, { done: boolean; lastStatus: string | null; lastSeq: number }>()
  for (const s of stages || []) {
    const ids = Array.isArray(s.taskIds)
      ? s.taskIds.filter((x): x is string => typeof x === 'string' && !!x.trim())
      : []
    for (const key of ids) {
      const cur = m.get(key) || { done: false, lastStatus: null, lastSeq: -1 }
      if ((s.seq || 0) > cur.lastSeq) { cur.lastSeq = s.seq || 0; cur.lastStatus = s.status || null }
      if (s.status === 'done') cur.done = true
      m.set(key, cur)
    }
  }
  return m
}

/** dev 任务身份生成（host 侧，按定义顺序）：同一份蓝图必然产生同一组 id，故 resume 可稳定对齐。
 *  蓝图落盘后不变 → id 稳定；title 会因合并/措辞变化 → 故不可作身份（见上方注释）。 */
export function devTaskIdAt(index: number): string { return `dt-${index + 1}` }

/**
 * **存量 stage 的 id 补算**（2026-09-18 二次修正，勿回退）。
 *
 * 为什么必须有：升级前的 stage 只写了 `taskKey`（title），没有 `taskIds`。若判定只认 id，
 * 这些 stage 就成了"看不见的历史"——实测 probe-cache `tf-mu6tb281`：纯 title 判定补跑 2 个（正确），
 * 而"只认 id + 让存量回退 title"两头不靠 → **补跑 8 个**（灾难：T0/T1/T2 明明 done 却全重跑）。
 *
 * 做法：**用蓝图自己的 title 去匹配 stage 的 taskKey**，命中即该 stage 承载了这个任务。
 * 这是**结构化 → 文本**的比对（拿确定性数据去匹配），不是"按分隔符切分 title"那种反解——
 * 后者是拿文本长相当身份，同型错误已犯过两次（per-plugin 正则、固定 .gitignore 词表），明确禁止。
 *
 * 合并执行的 stage（`taskKey = "T0 … + T6 … + T7 …"`）会命中**多个**任务 title → 补算出多个 id，
 * 与"合并时 taskIds 数组累加"的新逻辑完全同构：这一类 stage 承载的几个任务**各自**记已做。
 *
 * 补算结果写回 stage（`taskIds`），下次直接读——**存量自愈一次**，不是每次都重算。
 *
 * @param stages 待补算的 dev stage（会被就地修改：补上 `taskIds`）
 * @param defs   任务定义（含 id + title，来自 `buildDevTaskDefs`，与本次 run 同源）
 * @returns 补算到的 stage 数（诊断/测试用）
 */
export function backfillDevTaskIds(
  stages: Array<{ taskKey?: string | null; taskIds?: string[] | null; label?: string; seq?: number; status?: string }>,
  defs: Array<{ id: string; title: string }>,
): number {
  if (!Array.isArray(stages) || !Array.isArray(defs) || !defs.length) return 0
  let patched = 0
  for (const s of stages) {
    if (Array.isArray(s.taskIds) && s.taskIds.length) continue // 新 stage：已有 id，不碰
    const key = String(s.taskKey || String(s.label || '').replace(DEV_TITLE_PREFIX_LOCAL, '').replace(RETRY_SUFFIX_LOCAL, '').trim())
    if (!key) continue
    // 用**蓝图 title** 去 stage 文本里找：命中即该 stage 承载此任务（方向：结构化 → 文本）
    const ids = defs.filter((d) => String(d.title || '').trim() && key.includes(String(d.title).trim())).map((d) => d.id)
    if (!ids.length) continue
    s.taskIds = ids
    patched++
  }
  return patched
}

/* ── 版本控制安全（2026-09-17）：「改动存档」两态模型的防线 ─────────────────────────
 * 背景：dddd 两条 run 的产物因「工作区不是 git 仓库」而从未进入任何版本库（入口静默跳过决策、
 * 出口把提交失败记成"忽略"）。方案 A：入口问一次（人话问句 + 推荐），答案记住（state.gitMode），
 * 出口遵从。但「git init + 基线提交」在盘根/家目录/系统目录是灾难动作（git add -A 扫全盘），
 * 故有两层防线（L1 硬拒绝 / L2 大目录不基线提交），且**执行期二次校验**（不信任决策时刻的判断，
 * 程序化调用可能绕过决策直接传 preAction:'init'）。 */

/** L1：硬拒绝初始化的路径（只做廉价字符串/路径判定，不扫盘）。 */
export function isDangerousVcsRoot(dir: string, home: string | null | undefined): boolean {
  const p = String(dir || '').replace(/\//g, '\\').replace(/[\\/]+$/, '')
  if (!p) return true
  // ① 驱动器根：`C:` / `C:\`
  if (/^[A-Za-z]:$/.test(p)) return true
  // ② 家目录本身或其祖先（`C:\Users\me`、`C:\Users`——按路径段前缀判，防 `C:\Users\me2` 误伤）
  const seg = (x) => String(x || '').replace(/\//g, '\\').replace(/[\\/]+$/, '').split('\\').filter(Boolean)
  const ps = seg(p)
  if (home) {
    const hs = seg(home)
    if (hs.length && ps.length <= hs.length && hs.slice(0, ps.length).join('\\').toLowerCase() === ps.join('\\').toLowerCase()) return true
  }
  // ③ 系统目录（Windows 约定；非 Windows 下按同名段匹配，无害）
  const sys = ['windows', 'program files', 'program files (x86)', 'programdata', 'system volume information', '$recycle.bin']
  if (ps.some((s) => sys.indexOf(s.toLowerCase()) !== -1)) return true
  // ④ 深度 ≤ 1（`C:\tmp` / `C:\Users` 这类太靠根）
  const drive = ps[0] && /^[A-Za-z]:$/.test(ps[0])
  if (drive && ps.length <= 2) return true
  return false
}

/** L2：有界采样统计目录规模（防"基线提交扫全盘"）。超过任一阈值即提前返回 true（不再继续数）。
 *  `maxFiles`/`maxBytes` 阈值由调用方传（默认 1000 个文件 / 100 MB）；`budgetMs` 限制采样时长（默认 1s）。 */
export function dirTooLargeForBaseline(dir: string, maxFiles = 1000, maxBytes = 100 * 1024 * 1024, budgetMs = 1000): boolean {
  let files = 0, bytes = 0
  const start = Date.now()
  const walk = (d, depth) => {
    if (depth > 12 || Date.now() - start > budgetMs) return files > maxFiles || bytes > maxBytes
    let es
    try { es = readdirSync(d, { withFileTypes: true }) } catch (e) { return false }
    for (const e of es) {
      if (e.name === '.git' || e.name === 'node_modules') continue // 惯例排除：不影响"目录是否适合基线提交"的判断
      const p = d + '\\' + e.name
      if (e.isDirectory()) { if (walk(p, depth + 1)) return true }
      else {
        files++
        try { bytes += statSync(p).size } catch (e2) { /* 竞态：忽略 */ }
        if (files > maxFiles || bytes > maxBytes) return true
      }
    }
    return false
  }
  try {
    if (!existsSync(dir)) return true // 目录不存在/不可达 → 按过大处理（宁严勿松）
    return walk(dir, 0)
  } catch (e) { return true } // 采样失败（权限等）→ 按过大处理（宁严勿松）
}

/**
 * **AC 索引的文本兜底抽取**（ADR-0011 C 方案，2026-10-07）。
 *
 * **为什么需要兜底**：AC 的权威来源是 PRD state 块的 `extra.acIndex`，但实测兑现率只有 **~20%**
 * （34 个 state.json 里 `acIndex` 非空仅 7 个）—— `STATE_BLOCK_INSTRUCTION` 原来的模板示例里**没有
 * `extra`**，而各阶段 rules 只用散文要求它 ⇒ 模型照模板写。契约已按 A 方案补进模板，但按本仓纪律
 * （§2：**能 host 客观判定的就不依赖模型自律**），**必须有兜底**，否则确认单/索引在多数 run 里是空的。
 *
 * ⚠️ **抽段不可靠是本仓的旧伤**（`## 9. 假设与待澄清` 曾让内联正则误报「契约未兑现」）⇒ 本函数：
 * ① **逐行**解析、不做跨行正则；② 只认两种强特征 —— **行首** `AC-<数字>`（列表项 / 加粗 / 表格首列），
 * 或**表格任意列**里 `AC-<数字>` **紧跟冒号**（`| 用户故事 | AC-1: …` 是真实产物里最常见的故事表形态）；
 * ③ 返回为空即 `null`，**由调用方显式标注「来源 = 文本抽取」**，绝不冒充结构化来源（防静默降级）。
 *
 * **源必须传对**（2026-10-07 实测）：调用方要给**PRD 正文**（`artifactText(journal,'PRD.md')`），
 * 不是 `stage.output` —— 后者在真实 run 里中位 2.5k 字符、且 AC 常被压成交接摘要
 * （`（AC-1）、…` / `| Accept | AC-1…AC-8 |`）。同一实现两个源上的命中率：**PRD.md 19/21（90%）
 * vs stage.output 21/87（24%）**。见 `docs/adr/0011-…md` 的 C 落地记录。
 */
export function extractAcIndexFromText(doc: string | null | undefined): Record<string, string> | null {
  const text = String(doc || '')
  if (!text.trim()) return null
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    // 表格分隔行 / 纯横线行：跳过
    if (/^\|?[\s:|-]+\|?$/.test(line)) continue
    // ① 行首锚定：可选 `-` / `*` / `|` / 加粗，然后是 AC-<数字>（大小写不敏感，统一成大写）
    let m = line.match(/^[-*|>\s]*(?:\*\*)?\[?(AC[-\s]?\d+)\]?(?:\*\*)?\s*[：:|)-]?\s*(.+)$/i)
    // ② 表格任意列：`| 用户故事 | AC-1: … |`（真实产物最常见的故事表）。
    //    要求 AC-<数字> **紧跟冒号** —— 显著压低「引用型」误报（`| 关联验收项 | AC-1 |` 这种无冒号的引用不会命中）。
    if (!m) m = line.match(/^(?:\|[^|]*)+?\|\s*(?:\*\*)?\[?(AC[-\s]?\d+)\]?(?:\*\*)?\s*[：:]\s*(.+?)\s*\|?\s*$/i)
    if (!m) continue
    const id = m[1].toUpperCase().replace(/\s+/g, '-').replace(/^AC(\d)/, 'AC-$1')
    let desc = m[2].trim()
    // 表格行：描述到下一个 `|` 为止；去掉尾部残留的分隔符
    const pipe = desc.indexOf('|')
    if (pipe >= 0) desc = desc.slice(0, pipe).trim()
    // 去掉 markdown 强调与多余空白
    desc = desc.replace(/\*\*/g, '').replace(/^\s*[：:]\s*/, '').trim()
    if (!desc) continue
    // 描述本身又是一个 AC 编号 ⇒ 这是「AC-1…AC-8」这类区间/引用行，不是正文，丢弃
    if (/^AC[-\s]?\d/i.test(desc)) continue
    if (!out[id]) out[id] = desc.slice(0, 300)
    if (Object.keys(out).length >= 40) break
  }
  return Object.keys(out).length ? out : null
}

/**
 * **已删除：`normalizeClarifyStrength`**（2026-10-08）。
 *
 * 它唯一的职责是「`patch` 恒 `off`，优先于显式 `interview`」——一条约束 **run 级选项**的契约。
 * 而 `clarifyStrength` 自 2026-10-08 起**不再是 run 级选项**（它只选 ctx 文案，而 ctx 在选团队时注入，
 * 那一刻还不知道档位，也不知道是不是 patch）⇒ **该契约随字段一起作废**，见 ADR-0011 落地记录。
 * 需要复现旧档位做对照时用 `TEAMFLOW_CLARIFY`（见 `clarifyStrengthFromEnv`）。
 */
