#!/usr/bin/env node
/**
 * deploy.mjs — 一键构建 + 同步到 web profile 副本。
 *
 * 用法：pnpm deploy
 * 或：   node deploy.mjs
 *
 * 流程：pnpm bundle → 复制 lib/*.mjs + lib/*.js + package.json + ts 源码 → profile 副本
 * profile 路径：$DSH_HOME/profiles/web/node_modules/dsh-plugin-teamflow（默认 ~/.dsh）
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

console.log('📦 构建...')
execSync('pnpm bundle', { stdio: 'inherit', cwd: ROOT })

console.log('\n📂 同步到 profile...')
let count = 0
for (const f of FILES) {
  const src = join(ROOT, f)
  const dst = join(PROFILE, f)
  if (!existsSync(src)) { console.error(`  ⚠ 源文件不存在：${f}`); continue }
  try {
    mkdirSync(dirname(dst), { recursive: true })
    copyFileSync(src, dst)
    console.log(`  ✓ ${f}`)
    count++
  } catch (e) {
    console.error(`  ✗ ${f}: ${e.message}`)
  }
}

console.log(`\n✅ 完成（${count} 个文件）。重启 dsh --profile web 生效。`)
