#!/usr/bin/env node
/**
 * deploy.mjs — 构建 + 同步到 web profile 副本。
 *
 * 用法：node deploy.mjs         — 重建并同步
 *       node deploy.mjs --sync  — 仅同步（跳过构建，需先手动 pnpm bundle）
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

if (!skipBuild) {
  console.log('📦 构建...')
  try {
    // pnpm 11 默认 verifyDepsBeforeRun=install（跑脚本前自动 pnpm install），
    // 会把 peerDeps 的 @deepseek-ai/dsh-*（宿主私有包）拉到 404 ——
    // 已通过 pnpm-workspace.yaml（verifyDepsBeforeRun:false + autoInstallPeers:false）解决。
    execSync('pnpm bundle', { stdio: 'inherit', cwd: ROOT })
  } catch (e) {
    console.error('\n⚠ 构建失败（可能是 peerDep 或 tsdown 问题）。')
    if (!existsSync(join(ROOT, 'lib', 'host.mjs'))) {
      console.error('❌ lib/ 产物不存在，无法同步。')
      process.exit(1)
    }
    console.log('   lib/ 已有上次构建产物，继续同步...\n')
  }
} else {
  if (!existsSync(join(ROOT, 'lib', 'host.mjs'))) {
    console.error('❌ lib/ 产物不存在。请先运行：pnpm bundle')
    process.exit(1)
  }
}

console.log('📂 同步到 profile...')
let count = 0
for (const f of FILES) {
  const src = join(ROOT, f)
  const dst = join(PROFILE, f)
  if (!existsSync(src)) { console.error(`  ⚠ 源文件不存在：${f}`); continue }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    count++
  } catch (e) {
    console.error(`  ✗ ${f}: ${e.message}`)
  }
}

console.log(`✅ 完成（${count} 个文件）。重启 dsh --profile web 生效。`)
