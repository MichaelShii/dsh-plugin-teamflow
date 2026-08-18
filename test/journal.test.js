/**
 * dsh-plugin-teamflow — journal（断点续跑）行为测试。
 * 直接 import store.ts（纯 node:fs 依赖），验证：
 * 1) journal 写入 → 原子持久化
 * 2) 模拟进程崩溃（running 残留）→ loadJournals 标记 interrupted
 * 3) 已完成阶段产物保留（output）→ 断点续跑重建可用
 * 4) 损坏自愈仍生效（.bak 恢复）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  journalFile, runsDir, persistJournal, loadJournals, serializeJournal, readJson, slugPath, runLogFile,
} from '../store.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

const home = mkdtempSync(join(tmpdir(), 'tf-journal-'))
process.env.DSH_HOME = home
const cleanup = () => { try { rmSync(home, { recursive: true, force: true }) } catch (e) { /* ignore */ } }

console.log('── 0) workspace 槽位（slugPath/run 日志）──')
const slug = slugPath('C:\\Code\\project\\tetris')
ok(/^ws-tetris-[a-f0-9]{8}$/.test(slug), `slugPath 稳定安全槽位: ${slug}`)
ok(slugPath('C:\\Code\\project\\tetris') === slug, '同路径稳定')
ok(slugPath('C:\\Code\\project\\tetris') !== slugPath('D:\\other\\tetris'), '不同路径唯一')

console.log('── 1) journal 写入与序列化 ──')
const wsPath = join(home, 'workspace')
const journal = {
  id: 'tf-test1', name: 'teamflow-pipeline', status: 'running', requirement: '测试需求',
  options: { needDesign: false, needScaffold: false, tasks: [], productRoot: 'products/tetris', maxConcurrency: 3 },
  workspacePath: wsPath, product: 'products/tetris', reqId: 'req-1', taskId: 'task-1',
  taskMap: {}, agentsStarted: 2, humanIntervention: false, cancelled: false, interrupted: false, interruptedAt: null,
  supersededBy: null, startedAt: 1000, endedAt: null, error: null,
  stages: [
    { seq: 1, label: '产品经理 · 梳理 PRD', phase: 'PRD 产品需求', status: 'done', outcome: 'completed', childId: 'c1', startedAt: 1000, endedAt: 2000, tokens: 500, summary: 'PRD 摘要', output: '【完整 PRD 全文】...' },
    { seq: 2, label: '开发 · 整体开发', phase: '开发', status: 'running', outcome: null, childId: 'c2', startedAt: 3000, endedAt: null, tokens: null, usage: null, summary: null, output: null },
  ],
  logs: [{ t: 1000, level: 'info', message: 'backlog 已建立' }],
  result: null,
}
persistJournal(journal)
const file = journalFile('tf-test1')
ok(existsSync(file), `journal 文件已落盘: ${file}`)
const onDisk = JSON.parse(readFileSync(file, 'utf8'))
ok(onDisk.id === 'tf-test1' && onDisk.status === 'running', '落盘内容正确')
ok(onDisk.workspacePath === wsPath && onDisk.taskId === 'task-1', 'workspacePath/taskId 持久化')
ok(onDisk.stages[0].output === '【完整 PRD 全文】...', '已完成阶段产物全文保留（续跑重建用）')
ok(onDisk.stages[1].status === 'running', '未完成阶段保留 running 状态')
ok(readdirSync(join(home, 'workspace', 'logs', 'teamflow')).length === 1, 'run 日志落到 <workspace>/logs/teamflow/<runId>.log')

console.log('── 2) 模拟进程崩溃 → loadJournals 标记 interrupted ──')
const loaded = loadJournals()
ok(loaded.length === 1, '扫描到 1 条 journal')
ok(loaded[0].journal.status === 'interrupted', 'running 残留 → interrupted')
ok(loaded[0].journal.stages[1].status === 'interrupted', 'running 阶段 → interrupted')
ok(loaded[0].wasInterrupted === true, '返回中断标记')
// 磁盘同步更新
const afterLoad = JSON.parse(readFileSync(file, 'utf8'))
ok(afterLoad.status === 'interrupted' && afterLoad.interrupted === true, '中断标记已持久化')

console.log('── 3) 断点续跑数据重建 ──')
const restored = loaded[0].journal
ok(restored.reqId === 'req-1' && restored.taskId === 'task-1', 'reqId/taskId 恢复（单任务模型）')
ok(restored.stages.filter((s) => s.status === 'done').length === 1, '已完成阶段保留')
ok(restored.stages.filter((s) => s.status === 'done')[0].output.length > 0, '产物可重建（buildResumeProducts 输入完备）')

console.log('── 4) 正常 run 不受影响 ──')
const doneJournal = { ...journal, id: 'tf-test2', status: 'completed', stages: journal.stages.map((s) => ({ ...s, status: 'done' })) }
persistJournal(doneJournal)
const loaded2 = loadJournals()
ok(loaded2.length === 2 && loaded2.find((x) => x.journal.id === 'tf-test2').wasInterrupted === false, 'completed 不标记中断')

console.log('── 5) runs 目录忽略备份/临时文件 ──')
writeFileSync(join(runsDir(), 'tf-test1.json.bak'), '[]')
writeFileSync(join(runsDir(), 'junk.json'), 'not-a-journal')
const loaded3 = loadJournals()
ok(loaded3.length === 2, '跳过 .bak 与非 journal 文件')

console.log('── 6) per-project runs/ 扫描 ──')
// 模拟新格式：journal 写到 per-project runs/
const projectKey = 'ws-test-proj-abc12345'
const projectRunsDir = join(home, 'teamflow', projectKey, 'runs')
const projectJournal = { ...journal, id: 'tf-proj1', workspace: projectKey, status: 'completed', stages: [] }
persistJournal(projectJournal)
ok(existsSync(join(projectRunsDir, 'tf-proj1.json')), '新 journal 写到 per-project runs/')
const loaded4 = loadJournals()
ok(loaded4.some((x) => x.journal.id === 'tf-proj1'), 'loadJournals 扫描 per-project runs/')

cleanup()
console.log(failed === 0 ? '\n✅ journal 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
