#!/usr/bin/env node
/**
 * deploy.mjs — 一条龙：构建 + 测试 + 同步到 web profile 副本。
 *
 * 用法：
 *   node deploy.mjs          — 构建(client+host) → 测试 → 同步   （推荐）
 *   node deploy.mjs --sync   — 仅同步（跳过构建与测试，复用现有 lib/）
 *   node deploy.mjs --no-test— 构建 → 同步（跳过测试）
 *
 * 构建直接用 npx tsdown（client + host 两个 config），不走 pnpm 脚本，
 * 从而避开 pnpm 11 的 verifyDepsBeforeRun 把 @deepseek-ai/dsh-* 私有
 * peerDeps 拉到 registry 404 的问题。
 */
import { execSync } from 'node:child_process'
import { copyFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { homedir } from 'node:os'

const ROOT = import.meta.dirname ?? process.cwd()
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-plugin-teamflow')

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
  'host/core/triage.ts',
  'host/core/workspace/sanity.ts',
  'host/core/workspace/runlogs.ts',
  'host/core/workspace/acl-preflight.ts',
  'host/core/workspace/products.ts',
  'host/core/domain/state.ts',
  'host/core/domain/teams.ts',
  'client/index.tsx',
  'client/panel.tsx',
  'client/shared.tsx',
  'client/locales.ts',
  'lib/host.mjs',
  'lib/store.mjs',
  'lib/descriptors.mjs',
  'lib/client.js',
]

if (!existsSync(PROFILE)) {
  console.error(`❌ profile 副本不存在：${PROFILE}`)
  console.error('   请先运行：dsh plugin --profile web add file:./plugins/dsh-plugin-teamflow')
  process.exit(1)
}

const skipBuild = process.argv.includes('--sync')
const skipTest = skipBuild || process.argv.includes('--no-test')

function sh(cmd) {
  console.log(`▶ ${cmd}`)
  try {
    execSync(cmd, { stdio: 'inherit', cwd: ROOT })
  } catch (e) {
    console.error(`\n✗ 命令失败（exit ${e.status}）：${cmd}`)
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
  sh('npx tsdown')
  sh('npx tsdown -c tsdown.host.config.ts')
  console.log('')
}

/* ── 2) 测试 ─────────────────────────────────────────────────── */
if (skipTest) {
  console.log('⏭ 跳过测试。\n')
} else {
  console.log('2/3 🧪 运行测试 ...\n')
  sh('node test/smoke.js')
  sh('node test/journal.test.js')
  console.log('')
}

/* ── 3) 同步 ─────────────────────────────────────────────────── */
console.log('3/3 📂 同步到 profile ...')

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

/* ── 4) 生效提示：检测运行中的 web（改 host 侧必须重启进程才加载新 lib） ── */
try {
  const out = execSync('netstat -ano | findstr :3080', { encoding: 'utf8', windowsHide: true })
  const listen = out.split('\n').find((l) => l.includes('LISTENING'))
  if (listen) {
    const parts = listen.trim().split(/\s+/)
    const pid = parts[parts.length - 1]
    let msg = `⚠ 检测到 web 正在运行（端口 3080，PID=${pid || '?'}）`
    if (pid && /^\d+$/.test(pid)) {
      try {
        const st = execSync(`powershell -NoProfile -Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).StartTime.ToString('yyyy-MM-dd HH:mm:ss')"`, { encoding: 'utf8', windowsHide: true }).trim()
        if (st) msg += `（进程启动于 ${st}）`
      } catch (e) { /* 拿不到启动时间可忽略 */ }
    }
    msg += '——新 host 由该进程加载；不重启则仍跑旧逻辑。'
    console.log(msg)
  }
} catch (e) { /* 平台无 netstat/findstr 时静默 */ }
console.log('重启 dsh --profile web 生效。')
