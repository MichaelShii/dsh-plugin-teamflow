#!/usr/bin/env node
/**
 * deploy.mjs — 一条龙：构建 + 测试 + 同步到 profile 副本（DSH_PROFILE 决定，默认 web）。
 *
 * 用法：
 *   node deploy.mjs          — 构建(client+host) → 测试 → 同步   （推荐）
 *   node deploy.mjs --sync   — 仅同步（跳过构建与测试，复用现有 lib/）
 *   node deploy.mjs --no-test— 构建 → 同步（跳过测试）
 *
 * 构建直接用 tsdown 的 CLI 入口（client + host 两个 config），不走 pnpm 脚本，
 * 从而避开 pnpm 11 的 verifyDepsBeforeRun 把 @deepseek-ai/dsh-* 私有
 * peerDeps 拉到 registry 404 的问题。
 *
 * ⚠️ 2026-10-26：进程调用一律 `execFileSync`（不经 shell），理由两条——
 *   ① 字符串进 shell 是注入面（虽然当前调用点全是源码里的字面量，但没必要留着这个形状）；
 *   ② 经 shell 会重新引入引号/空格路径的坑，而这里唯一需要的就是「跑一个已知的程序」。
 *   实现细节：**不能** `execFileSync('npx', …)` —— CVE-2024-27980 之后，Node 在 Windows 上
 *   拒绝不经 shell 执行 `.cmd`/`.bat`（npx/pnpm 都是 shim）⇒ 必须绕开 shim，直接用
 *   `process.execPath` 跑目标脚本（tsdown 的 CLI 就是 `tsdown/run` 这个 ESM 入口）。
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { homedir } from 'node:os'

const requireHere = createRequire(import.meta.url)
/** tsdown 的 CLI 入口（`exports["./run"] = ./dist/run.mjs`）。用它而不是 node_modules/.bin/tsdown。 */
const TSDOWN_CLI = requireHere.resolve('tsdown/run')

const ROOT = import.meta.dirname ?? process.cwd()
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
// 目标 profile 可选：dsh 0.2.0 起桌面版用**独立的 `desktop` profile**（`~/.dsh/profiles/desktop`），
// 与跑 Web 的 `web` profile 各自一份 node_modules ⇒ 插件要分别装、分别同步，否则桌面版里那份会静默陈旧。
// 用法：`DSH_PROFILE=desktop node deploy.mjs --sync`；不给则仍同步 web（保持既有调用不变）。
const PROFILE_NAME = process.env.DSH_PROFILE || 'web'
const PROFILE = join(DSH_HOME, 'profiles', PROFILE_NAME, 'node_modules', 'dsh-plugin-teamflow')

const FILES = [
  'package.json',
  'cordis.patch.yml',
  'AGENTS.md',
  'descriptors.ts',
  'store.ts',
  'host/index.ts',
  'host/types.ts',
  'host/constants.ts',
  'host/util.ts',
  'host/locales.ts',
  'host/locales/pipeline.ts',
  'host/locales/tools.ts',
  'host/prompts/index.ts',
  'host/core/agent/context.ts',
  'host/core/locale.ts',
  'host/core/domain/backlog.ts',
  'host/core/agent/metering.ts',
  'host/core/agent/runner.ts',
  'host/core/agent/guard.ts',
  'host/core/report.ts',
  'host/core/pipeline.ts',
  'host/core/stages/dev.ts',
  'host/core/stages/qa.ts',
  'host/core/stages/acceptance.ts',
  'host/core/clarify-log.ts',
  'host/core/confirm.ts', // PRD 确认单（ADR-0011 ①）：纯函数模块，也要同步到 profile 副本
  'host/core/prd-revise.ts', // PRD 续跑改写（continuable）：同上，纯逻辑 + 投递循环，漏同步则续跑静默失效
  'host/core/update-check.ts', // 版本探测（ADR-0012）：同上，纯逻辑模块
  'host/core/triage.ts',
  'host/core/skill.ts', // /teamflow-brainstorm 注册（只许用户调用）
  'host/core/workspace/sanity.ts',
  'host/core/workspace/runlogs.ts',
  'host/core/workspace/acl-preflight.ts',
  'host/core/workspace/products.ts',
  'host/core/workspace/browser-probe.ts',
  'host/core/workspace/interface-check.ts',
  'host/core/workspace/smoke-check.ts',
  'host/core/domain/state.ts',
  'host/core/domain/teams.ts',
  'client/index.tsx',
  'client/panel.tsx',
  'client/shared.tsx',
  'client/update-ui.tsx', // 「有新版本 / 升级」UI 的唯一实现（工作台 / 全局面板 / 宿主插件页三处共用）
  'client/locales.ts',
  'client/viewport.ts',
  'client/locale-push.ts', // 语言上报重试策略（纯模块：中文环境整轮英文的修复，2026-10-16）
  'client/bug-open-reason.ts', // 缺陷卡「为什么还停在待认领」可见原因（纯模块，2026-10-16）
  'lib/host.mjs',
  'lib/store.mjs',
  'lib/descriptors.mjs',
  'lib/client.js',
]

if (!existsSync(PROFILE)) {
  console.error(`❌ profile 副本不存在：${PROFILE}`)
  console.error(`   请先运行：dsh plugin --profile ${PROFILE_NAME} add file:./plugins/dsh-plugin-teamflow`)
  process.exit(1)
}

const skipBuild = process.argv.includes('--sync')
const skipTest = skipBuild || process.argv.includes('--no-test')

/**
 * 跑一个 node 脚本（argv 数组，不经 shell）。
 * @param {string} label 控制台显示的一行
 * @param {string[]} args 传给 node 的参数（第一个是要执行的脚本）
 */
function nodeRun(label, args) {
  console.log(`▶ ${label}`)
  try {
    execFileSync(process.execPath, args, { stdio: 'inherit', cwd: ROOT })
  } catch (e) {
    console.error(`\n✗ 命令失败（exit ${e.status}）：${label}`)
  }
}

/* ── 1) 构建 ─────────────────────────────────────────────────── */
if (skipBuild) {
  if (!existsSync(join(ROOT, 'lib', 'host.mjs'))) {
    console.error('❌ lib/ 产物不存在。去掉 --sync 先构建。')
    process.exit(1)
  }
  console.log('⏭ 跳过构建（--sync）。\n')
} else {
  console.log('1/3 📦 构建 client + host ...\n')
  nodeRun('tsdown', [TSDOWN_CLI])
  nodeRun('tsdown -c tsdown.host.config.ts', [TSDOWN_CLI, '-c', 'tsdown.host.config.ts'])
  console.log('')
}

/* ── 2) 测试 ─────────────────────────────────────────────────── */
if (skipTest) {
  console.log('⏭ 跳过测试。\n')
} else {
  console.log('2/3 🧪 运行测试 ...\n')
  nodeRun('node test/smoke.js', ['test/smoke.js'])
  nodeRun('node test/journal.test.js', ['test/journal.test.js'])
  console.log('')
}

/* ── 3) 同步 ─────────────────────────────────────────────────── */
console.log(`3/3 📂 同步到 profile (${PROFILE_NAME}) ...`)

/**
 * 3a) 先删「源里已经没有」的副本文件。
 * 为什么需要：deploy 历来**只复制不删除** ⇒ 源码里被移走/改名的文件会在 profile 副本里永久残留。
 * 这是与「漏登记进 FILES = 副本源码永久陈旧」同一类漂移，只是方向相反（2026-09-28 分目录时
 * 实测残留 11 个 host/core/*.ts）。残留文件虽不会被 import，但会干扰 HMR/目录扫描与人工排查。
 *
 * 安全边界（缺一不可）：
 *   ① 只处理 host/ 与 client/ 下的源码文件（.ts/.tsx），不碰 lib/ 产物与配置文件；
 *   ② 源目录扫描结果为空 ⇒ 中止（多半是路径算错，此时删除会变成清空副本）；
 *   ③ 逐文件 rmSync(force)，不存在也不抛。
 */
const scanTs = (base, prefix) => {
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (/\.(ts|tsx)$/.test(e.name)) {
        out.push(`${prefix}/${relative(base, p).split('\\').join('/')}`)
      }
    }
  }
  if (existsSync(base)) walk(base)
  return out
}
{
  const srcSet = new Set([...scanTs(join(ROOT, 'host'), 'host'), ...scanTs(join(ROOT, 'client'), 'client')])
  if (srcSet.size === 0) {
    console.error('❌ 源 host/ client/ 扫描为空 —— 中止同步，避免误删 profile 副本')
    process.exit(1)
  }
  const stale = [...scanTs(join(PROFILE, 'host'), 'host'), ...scanTs(join(PROFILE, 'client'), 'client')]
    .filter((rel) => !srcSet.has(rel))
  for (const rel of stale) {
    rmSync(join(PROFILE, rel), { force: true })
    console.log(`  🧹 移除源已删除的副本文件：${rel}`)
  }
  if (stale.length) console.log(`  （${stale.length} 个 —— 上一次结构变更留下的残骸）`)
}

let count = 0, failed = []
for (const f of FILES) {
  const src = join(ROOT, f)
  const dst = join(PROFILE, f)
  if (!existsSync(src)) { failed.push(f); continue }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    count++
  } catch (e) {
    failed.push(`${f} (${e.message})`)
  }
}

console.log(`✅ 完成：${count} 个文件已同步。`)
if (failed.length) {
  console.log(`⚠ 以下文件未同步（需更高权限或源缺失）：\n  ${failed.join('\n  ')}`)
}

/* ── 3c) 部署自检：对面装的是不是**我们刚构建的这份** ─────────────────────────
 * 教训（2026-10-19 真机实锤）：sync 报「50 个文件已同步」，但 profile 里落地的是 **0.2.9**
 * （外部操作在之后覆盖过），于是后续所有真机验证都跑在旧代码上——现象是「已修复的 bug 复发」，
 * 排查花了 3 小时。只数「复制成功几个文件」证明不了落地，必须核对**版本号 + 产物指纹**。
 */
try {
  const wantVer = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  const gotPkg = join(PROFILE, 'package.json')
  const gotVer = existsSync(gotPkg) ? JSON.parse(readFileSync(gotPkg, 'utf8')).version : '(缺失)'
  const localLib = join(ROOT, 'lib/host.mjs')
  const gotLib = join(PROFILE, 'lib/host.mjs')
  const sameLib = existsSync(localLib) && existsSync(gotLib) && readFileSync(localLib).equals(readFileSync(gotLib))
  if (gotVer !== wantVer) {
    console.error(`❌ 部署自检失败：profile 版本 ${gotVer} ≠ 本地 ${wantVer}（对面不是这份代码，别在此之上做验证）`)
    process.exitCode = 1
  } else if (!sameLib) {
    console.error('❌ 部署自检失败：profile 的 lib/host.mjs 与本地构建产物不一致')
    process.exitCode = 1
  } else {
    console.log(`✅ 部署自检：profile 版本 ${gotVer}，lib/host.mjs 与本地构建逐字节一致`)
  }
} catch (e) {
  console.error(`❌ 部署自检异常：${e.message}`)
  process.exitCode = 1
}

/* ── 3d) 校正 profile 的依赖声明：必须指向**本地仓库**，不能是版本号 ──────────────
 * 根因（2026-10-19 真机实锤）：profile 的 package.json 里写着 `"dsh-plugin-teamflow": "0.2.9"`
 * ⇒ 任何一次 `pnpm install` / `dsh plugin add` / `dsh plugin update` 都会**按这个版本重装**，
 * 把 deploy 刚同步进去的开发副本打回旧版（实测：01:31 一次 install ⇒ 01:10 起的 run 全跑在 0.2.9 上，
 * 表现为「v0.3.0 就修好的 signal bug 复发」）。
 * AGENTS.md 写的运行环境本来就是「`file:` 安装 + 从 profile 副本加载」⇒ 这里把它纠回来。
 */
try {
  const profilePkgPath = join(PROFILE, '..', '..', 'package.json')
  if (existsSync(profilePkgPath)) {
    const raw = readFileSync(profilePkgPath, 'utf8')
    const pkg = JSON.parse(raw)
    const cur = pkg.dependencies && pkg.dependencies['dsh-plugin-teamflow']
    const want = `file:${ROOT.split('\\').join('/')}`
    if (cur && cur !== want) {
      pkg.dependencies['dsh-plugin-teamflow'] = want
      // 保留原格式缩进（profile 的 package.json 是 2 空格）
      writeFileSync(profilePkgPath, JSON.stringify(pkg, null, 2) + '\n')
      console.log(`🔧 profile 依赖声明已校正：${cur} → ${want}`)
      console.log('   （请在 profile 目录跑一次 pnpm install，让 lockfile 与 node_modules 跟上；否则下次 install 仍会打回旧版）')
    }
  }
} catch (e) {
  console.log(`⚠ 校正 profile 依赖声明失败（不影响本次同步，但下次 install 可能打回旧版）：${e.message}`)
}

/* ── 4) 生效提示：检测运行中的 web（改 host 侧必须重启进程才加载新 lib） ── */
try {
  // 原来走 `netstat -ano | findstr :3080`（shell 管道）。改成直接跑 netstat、在 JS 里筛：
  // 同样的结果，少一个外部依赖（findstr），也不再给 shell 递字符串。
  const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true })
  const listen = out.split('\n').find((l) => l.includes(':3080') && l.includes('LISTENING'))
  if (listen) {
    const parts = listen.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    let msg = `⚠ 检测到 web 正在运行（端口 3080，PID=${pid || '?'}）`
    msg += '——新 host 由该进程加载；不重启则仍跑旧逻辑。'
    console.log(msg)
  }
} catch (e) { /* 平台无 netstat/findstr 时静默 */ }
console.log(`重启后生效：dsh --profile ${PROFILE_NAME}（桌面版请重启桌面应用）。`)
