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
import { copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const ROOT = import.meta.dirname ?? process.cwd()
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'web', 'node_modules', 'dsh-plugin-teamflow')

const FILES = [
  'package.json',
  'cordis.patch.yml',
  'descriptors.ts',
  'store.ts',
  'host/index.ts',
  'client/index.tsx',
  'lib/host.mjs', 'lib/host.mjs.map',
  'lib/store.mjs', 'lib/store.mjs.map',
  'lib/descriptors.mjs', 'lib/descriptors.mjs.map',
  'lib/client.js', 'lib/client.js.map',
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
  sh(`npx tsdown`)
  sh(`npx tsdown -c tsdown.host.config.ts`)
  console.log('')
}

/* ── 2) 测试 ─────────────────────────────────────────────────── */
if (skipTest) {
  console.log('⏭ 跳过测试。\n')
} else {
  console.log('2/3 🧪 运行测试 ...\n')
  sh(`node test/smoke.js`)
  sh(`node test/journal.test.js`)
  console.log('')
}

/* ── 3) 同步 ─────────────────────────────────────────────────── */
console.log('3/3 📂 同步到 profile ...')
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
console.log('重启 dsh --profile web 生效。')
