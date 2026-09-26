/**
 * dsh-plugin-teamflow — journal（断点续跑）行为测试。
 * 直接 import store.ts（纯 node:fs 依赖），验证：
 * 1) journal 写入 → 原子持久化
 * 2) 模拟进程崩溃（running 残留）→ loadJournals 标记 interrupted
 * 3) 已完成阶段产物保留（output）→ 断点续跑重建可用
 * 4) 损坏自愈仍生效（.bak 恢复）
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { journalFile, runsDir, persistJournal, loadJournals, serializeJournal, slugPath, runLogFile, runLogArchiveDir } from '../store.ts'

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
    { seq: 1, label: '产品经理 · 梳理 PRD', phase: 'prd', status: 'done', outcome: 'completed', childId: 'c1', startedAt: 1000, endedAt: 2000, tokens: 500, summary: 'PRD 摘要', output: '【完整 PRD 全文】...' },
    { seq: 2, label: '开发 · 整体开发', phase: 'dev', status: 'running', outcome: null, childId: 'c2', startedAt: 3000, endedAt: null, tokens: null, usage: null, summary: null, output: null },
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
// 2026-09-15（B 方案）：host run 日志不再落用户项目，改为 $DSH_HOME/teamflow/<workspace>/logs/<runId>/run.log
const archiveDir = runLogArchiveDir(journal)
ok(!!archiveDir && archiveDir.startsWith(join(home, 'teamflow')) && archiveDir.endsWith(join('logs', 'tf-test1')), `run 日志归档到 $DSH_HOME/teamflow/<workspace>/logs/<runId>/（${archiveDir}）`)
ok(existsSync(runLogFile(journal)), '归档内有 host 事件日志 run.log')
ok(!archiveDir.startsWith(wsPath), '归档落点不在工作区（项目内不再落 host 日志）')

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

console.log('── 7) 序列化完整性门禁（白名单漏字段的通用防线）──')
// 历史实锤：`verifyEvidence` 曾存在于 JournalStage 却漏在 stage 序列化里 → 内存写对了、落盘丢了
// （0.1.9 那次「证据块全空」的根因）。这类"手工枚举清单漏一项"已五次，故对**持久化形态**立结构化门禁：
// `JournalRecord` / `JournalStage` 的每个字段都必须被 serializeJournal 写出来（不靠有人记得加断言）。
{
  const storeSrc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../store.ts'), 'utf8')
  const keysOf = (ifaceName) => {
    const block = (storeSrc.match(new RegExp(`export interface ${ifaceName} \\{[\\s\\S]*?\\n\\}`)) || [''])[0]
    const out = []
    for (const line of block.split('\n')) {
      const m = line.match(/^  ([A-Za-z_$][\w$]*)\??\s*:/)
      if (m) out.push(m[1])
    }
    return out
  }
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const ser = (storeSrc.match(/export function serializeJournal[\s\S]*?\n\}/) || [''])[0]
  const serBody = stripComments(ser)
  const stageBody = stripComments((ser.match(/stages: \(journal\.stages \|\| \[\]\)\.map\(\(s\) => \(\{[\s\S]*?\}\)\)/) || [''])[0])

  const recKeys = keysOf('JournalRecord')
  ok(recKeys.length >= 25, `静态解析出 JournalRecord 顶层键 ${recKeys.length} 个（解析失败会让门禁空转）`)
  /** 不落盘的字段（必须**有理由**，不是"忘了"）：目前只有进程内运行期字段。 */
  const REC_EXEMPT = new Map([
    ['result', '进程内运行期字段（requirement/options/timeline 的内存副本，不进磁盘）'],
  ])
  const recMissing = recKeys.filter((k) => !REC_EXEMPT.has(k) && !new RegExp(`^\\s*${k}:`, 'm').test(serBody))
  ok(recMissing.length === 0, `JournalRecord 每个字段都被 serializeJournal 写出${recMissing.length ? `（漏了：${recMissing.join(', ')}）` : ''}`)
  ok(REC_EXEMPT.size === 1 && REC_EXEMPT.has('result'), '豁免表只有一项（新加持久化字段默认必须搬运，不许悄悄塞进豁免表）')

  const stKeys = keysOf('JournalStage')
  ok(stKeys.length >= 15, `静态解析出 JournalStage 顶层键 ${stKeys.length} 个`)
  const ST_EXEMPT = new Map([
    ['tokens', '历史遗留字段（usage 取代）；仅为读取存量数据兼容保留，不再写出'],
  ])
  const stMissing = stKeys.filter((k) => !ST_EXEMPT.has(k) && !new RegExp(`^\\s*${k}:`, 'm').test(stageBody))
  ok(stMissing.length === 0, `JournalStage 每个字段都被阶段序列化写出${stMissing.length ? `（漏了：${stMissing.join(', ')}）` : ''}`)
  ok(ST_EXEMPT.size === 1, '阶段豁免表只有一项（tokens 历史遗留）')
  ok(stageBody.length > 100, '阶段序列化体抽取成功（否则上面两条会假绿）')
  ok(/verifyEvidence/.test(stageBody), '反向锁：verifyEvidence 必须在 stage 序列化里（历史丢字段实锤）')
}

console.log('── 8) 引擎留痕（provider/model）：run 与阶段两级都要落盘 ──')
{
  const j = {
    ...journal, id: 'tf-engine1', status: 'failed', stages: [{
      seq: 1, label: '产品经理 · 梳理 PRD', phase: 'prd', status: 'failed', outcome: 'insubstantial',
      provider: 'inception', model: 'mercury-2.5', startedAt: 1, endedAt: 2,
    }],
    engine: { provider: 'inception', model: 'mercury-2.5' },
  }
  const out = serializeJournal(j)
  ok(out.engine && out.engine.provider === 'inception' && out.engine.model === 'mercury-2.5', 'run 级 engine（provider/model）落盘')
  ok(out.stages[0].provider === 'inception' && out.stages[0].model === 'mercury-2.5', '阶段级 provider/model 落盘（子代理可改道，故逐阶段记）')
  ok(serializeJournal({ ...j, engine: undefined }).engine === null, '缺 engine → null（不编造）')
  ok(serializeJournal({ ...j, stages: [{ seq: 1, label: 'x', phase: 'prd', status: 'done' }] }).stages[0].provider === null, '阶段缺 provider → null')
}

cleanup()
console.log(failed === 0 ? '\n✅ journal 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
