/**
 * 存量迁移（2026-09-06 英文化改造）：journal stage.phase 中文 → 英文键 + stage.taskKey 补写
 * （dev 任务 stage 从 label 提取任务 title）+ backlog 子卡 taskKey 补写。
 * 运行：node scripts/migrate-phase-en.mjs [--dry-run]
 * 目标：DSH_HOME/teamflow 下 runs 与 backlog 的 JSON 文件
 */
import { readdirSync, existsSync, writeFileSync, renameSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const DRY = process.argv.includes('--dry-run')
const ROOT = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'teamflow')
const PHASE_MAP = { 'PRD 产品需求': 'prd', 'UI/UX 设计': 'design', '架构规划': 'scaffold', '技术方案': 'tech', '开发': 'dev', 'QA 测试': 'qa', '产品验收': 'acceptance' }

let journalFiles = 0, journalStageFixed = 0, taskKeyAdded = 0, backlogFixed = 0, skipped = 0

function walk(dir) {
  if (!existsSync(dir)) return
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name)
    if (f.isDirectory()) { walk(p); continue }
    if (f.name.endsWith('.json') && !f.name.includes('.bak') && !f.name.includes('.tmp') && !f.name.includes('.corrupt')) migrateFile(p)
  }
}

function migrateFile(file) {
  let raw
  try { raw = readFileSync(file, 'utf8') } catch { return }
  let obj
  try { obj = JSON.parse(raw) } catch { skipped++; return }
  let changed = false

  if (file.includes(`${sep()}runs${sep()}`) || /[\\/]runs[\\/]/.test(file)) {
    // journal：stage.phase 中文 → 英文 + taskKey 补写
    if (Array.isArray(obj.stages)) {
      for (const s of obj.stages) {
        if (s && typeof s.phase === 'string' && PHASE_MAP[s.phase]) {
          s.phase = PHASE_MAP[s.phase]
          journalStageFixed++
          changed = true
        }
if (s && s.phase === 'dev' && (!s.taskKey || /（第/.test(String(s.taskKey)) || String(s.taskKey).endsWith('）') || String(s.taskKey).endsWith('（')) && typeof s.label === 'string') {
          // 清洗：taskKey 缺失或含历史正则残留（「（第 2 次重试）替换不干净的多出 ）」）→ 从 label 重新提取
          const title = String(s.label).replace(/^开发 · /, '').replace(/（(?:第 \d+ 次重试|补跑)）$/, '').trim()
          if (title) { s.taskKey = title; taskKeyAdded++; changed = true }
        }
      }
    }
    if (changed) journalFiles++
  } else if (/[\\/]backlog[\\/]/.test(file) && Array.isArray(obj)) {
    // backlog tasks：子卡补 taskKey（title 前缀 `开发 · ` 提取）
    let any = false
    for (const t of obj) {
      if (t && t.type === 'subtask' && (!t.taskKey || /（第/.test(String(t.taskKey)) || String(t.taskKey).endsWith('）') || String(t.taskKey).endsWith('（')) && typeof t.title === 'string' && t.title.startsWith('开发 · ')) {
        t.taskKey = t.title.replace(/^开发 · /, '').replace(/（(?:第 \d+ 次重试|补跑)）$/, '').trim()
        any = true
      }
    }
    if (any) { backlogFixed++; changed = true }
  } else return

  if (changed && !DRY) {
    const tmp = file + '.migrate-tmp'
    writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    renameSync(tmp, file)
  }
}

function sep() { return /^win/.test(process.platform) ? '\\' : '/' }

console.log(`迁移目录: ${ROOT}（dry-run=${DRY}）`)
walk(ROOT)
console.log(`\n完成：journal 迁移 ${journalFiles} 个文件（stage.phase 修正 ${journalStageFixed} 处，taskKey 补写 ${taskKeyAdded} 处）；backlog 迁移 ${backlogFixed} 个文件；跳过 ${skipped} 个（非 JSON）`)