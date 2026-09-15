/**
 * dsh-plugin-teamflow — 运行日志生命周期（B 方案 + 白名单过滤）回归测试。
 *
 * 契约（2026-09-15 二审）：
 * - 暂存：`<workspacePath>/logs/teamflow/<runId>/`（子代理受 DSH 沙箱约束只能写工作区）；
 * - 归档：`$DSH_HOME/teamflow/<workspace>/logs/<runId>/`（host 进程侧写，run 终态搬运）；
 * - **过滤**：只留检查脚本/笔记（code 扩展名）与 `captures.json`；命令输出（*.log/*.out/*.txt）与源码快照丢弃
 *   ——实测一次真实 run 里 93% 是这两类（可重跑或 git 里已有）；
 * - 自愈：run 起跑把上次残留的暂存目录/散落文件按同一白名单处理；归档按每工作区最近 `LOG_ARCHIVE_KEEP` 次淘汰；
 * - 正在运行的 run 一律不动；任何失败都不抛（run 起跑/收尾绝不被日志管理打断）。
 *
 * 本文件同时守住 store.ts 与 host/constants.ts 的路径段一致性（store 是独立 entry，刻意不引 host 代码）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  runLogFile, runLogArchiveDir, runLogStagingDir, logsArchiveRoot,
} from '../store.ts'
import { archiveRunLogs, sweepWorkspaceLogs, pruneLogArchives, stagingRoot, keepInArchive } from '../host/core/runlogs.ts'
import { runs } from '../host/core/context.ts'
import { TF_LOG_DIR, LOG_ARCHIVE_KEEP } from '../host/constants.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eq = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

const home = mkdtempSync(join(tmpdir(), 'tf-runlogs-'))
process.env.DSH_HOME = home
const ws = mkdtempSync(join(tmpdir(), 'tf-ws-'))
/** 造一个最小 journal（只带日志生命周期用到的字段）。 */
const J = (id, extra = {}) => ({
  id, name: 'teamflow-pipeline', status: 'running', workspace: 'ws-test-abc12345',
  workspacePath: ws, logs: [], ...extra,
})
const write = (file, text) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text, 'utf8') }
const staging = (id, rel, text) => write(join(ws, TF_LOG_DIR, id, rel), text)
const cleanup = () => {
  for (const d of [home, ws]) { try { rmSync(d, { recursive: true, force: true }) } catch (e) { /* ignore */ } }
}

console.log('── 1) 路径契约：暂存留在项目内、归档落在 $DSH_HOME ──')
eq(TF_LOG_DIR, 'logs/teamflow', 'TF_LOG_DIR 常量值')
eq(stagingRoot(ws), join(ws, 'logs', 'teamflow'), 'stagingRoot = <workspacePath>/logs/teamflow')
eq(runLogStagingDir(J('tf-a')), join(ws, 'logs', 'teamflow', 'tf-a'), 'store 暂存路径与 TF_LOG_DIR 同址（跨 entry 一致性门禁）')
const arch = runLogArchiveDir(J('tf-a'))
ok(!!arch && arch.startsWith(home), `归档在 $DSH_HOME 下（${arch}）`)
ok(!!arch && !arch.startsWith(ws), '归档不在用户项目内')
eq(arch, join(home, 'teamflow', 'ws-test-abc12345', 'logs', 'tf-a'), '归档 = $DSH_HOME/teamflow/<workspace>/logs/<runId>')
eq(logsArchiveRoot(J('tf-a')), join(home, 'teamflow', 'ws-test-abc12345', 'logs'), '归档根 = .../<workspace>/logs')
eq(runLogFile(J('tf-a')), join(arch, 'run.log'), 'host 自身事件日志 = <归档 run 目录>/run.log')
const derived = runLogArchiveDir({ id: 'tf-b', workspacePath: 'C:\\Code\\project\\tetris', logs: [] })
ok(!!derived && derived.includes('ws-tetris-'), 'workspace 槽位缺失时按 workspacePath 派生（与 backlog 同键）')
eq(runLogArchiveDir({ id: 'tf-c', logs: [] }), null, '无 workspace/workspacePath → null（不瞎写）')
eq(runLogStagingDir({ id: 'tf-c', logs: [] }), null, '无 workspacePath → 暂存路径 null')

console.log('── 2) 过滤白名单：只留可重跑/人可读的东西 ──')
for (const f of ['check.mjs', 'q.mjs', 'helper.cjs', 'x.js', 'notes.md', 'run.sh', 'probe.ps1', 'p.py', 'captures.json', 'scripts/dbg-repro2.mjs', 'probe/deep/nested.md'])
  ok(keepInArchive(f), `保留：${f}`)
for (const f of ['regression-dev.log', 'tf-mu2ioilr-95l4th.log', 'qa-test.out', 'zh-parity-report.txt', 'probe/head/host/core/pipeline.ts', 'scripts/_head-index.ts', 'probe/prompts-before.json', 'probe/head/client/index.tsx', 'r3-append.done', 'CHECK.MJS'.toLowerCase() + '.log'])
  ok(!keepInArchive(f), `丢弃：${f}`)
ok(keepInArchive('CAPTURES.JSON'), '白名单大小写不敏感（captures.json）')

console.log('── 3) 归档：白名单文件搬到 $DSH_HOME，输出/快照丢弃，源目录删除 ──')
staging('tf-r1', 'regression-dev.log', 'suite output (rerunnable)')
staging('tf-r1', 'qa-test.out', 'command output (rerunnable)')
staging('tf-r1', join('probe', 'head', 'host', 'core', 'pipeline.ts'), 'a copy of a git-tracked file')
staging('tf-r1', join('scripts', 'check.mjs'), 'console.log(1)')
staging('tf-r1', 'captures.json', '{"cmds":[]}')
staging('tf-r1', 'notes.md', '# evidence notes')
const j1 = J('tf-r1')
eq(archiveRunLogs(j1), 3, '归档保留 3 个文件（check.mjs + captures.json + notes.md）')
const a1 = runLogArchiveDir(j1)
ok(existsSync(join(a1, 'scripts', 'check.mjs')) && existsSync(join(a1, 'captures.json')) && existsSync(join(a1, 'notes.md')), '白名单文件都在归档里（含子目录）')
ok(!existsSync(join(a1, 'regression-dev.log')) && !existsSync(join(a1, 'qa-test.out')), '命令输出未进归档（可重跑）')
ok(!existsSync(join(a1, 'probe')), '源码快照未进归档（git 里已有）')
ok(!existsSync(join(ws, TF_LOG_DIR, 'tf-r1')), '项目内暂存目录已删除')
ok(!existsSync(join(ws, TF_LOG_DIR)) && !existsSync(join(ws, 'logs')), '空掉的 logs/teamflow 与 logs/ 一并回收（项目内不留空壳）')
ok(j1.logs.some((l) => l.level === 'info' && l.message.includes(a1) && l.message.includes('丢弃')), 'journal 记录归档落点与丢弃计数（可审计）')
eq(archiveRunLogs(j1), 0, '重复归档幂等（源目录已不存在 → 0，不记噪音日志）')

console.log('── 4) 全是输出的 run：不留归档目录，只记一行「已清理」 ──')
staging('tf-noise', 'regression-qa.log', 'x'.repeat(2048))
staging('tf-noise', 'probe', 'ignore-me-dir-placeholder')
rmSync(join(ws, TF_LOG_DIR, 'tf-noise', 'probe'), { force: true })
staging('tf-noise', join('probe', 'head', 'index.ts'), 'snapshot')
const jn = J('tf-noise')
eq(archiveRunLogs(jn), 0, '无可归档内容 → 保留 0')
ok(!existsSync(runLogArchiveDir(jn)), '不创建空归档目录')
ok(!existsSync(join(ws, TF_LOG_DIR, 'tf-noise')), '暂存目录已删除（输出不留在项目里）')
ok(jn.logs.some((l) => l.message.includes('已清理')), 'journal 记录「已清理」（丢弃计数可见）')

console.log('── 5) 归档合并语义：续跑/重试不丢上一轮 ──')
staging('tf-r1', join('scripts', 'check.mjs'), 'console.log(2)')
staging('tf-r1', join('scripts', 'new-check.mjs'), 'console.log(3)')
eq(archiveRunLogs(J('tf-r1')), 2, '第二轮再归档 2 个文件')
eq(readFileSync(join(a1, 'scripts', 'check.mjs'), 'utf8'), 'console.log(2)', '同名文件被新一轮覆盖')
ok(existsSync(join(a1, 'scripts', 'new-check.mjs')), '新文件进归档')
ok(existsSync(join(a1, 'captures.json')) && existsSync(join(a1, 'notes.md')), '上一轮的独有文件保留（合并而非镜像替换）')

console.log('── 6) 自愈清扫：上次残留按同一白名单处理 ──')
staging('tf-old1', 'a.log', 'old dump')
staging('tf-old1', 'check-old.mjs', 'console.log(1)')
staging('tf-old2', join('probe', 'head', 'x.ts'), 'snapshot')
staging('tf-cur', 'c.log', 'current')
// 历史版本 host 的落点（散落文件）：<runId>.log 是命令输出 → 丢弃；笔记 → 保留
write(join(ws, TF_LOG_DIR, 'tf-legacy.log'), 'legacy host log (dup of journal.logs)')
write(join(ws, TF_LOG_DIR, 'note-draft.md'), 'scratch note')
write(join(ws, TF_LOG_DIR, 'tf-cur.log'), 'current run host log (must stay)')
const j2 = J('tf-cur')
const swept = sweepWorkspaceLogs(j2)
eq(swept.swept, 4, '处理 4 项残留（tf-old1/tf-old2/tf-legacy.log/note-draft.md；不碰本次 run 自己的目录/文件）')
ok(existsSync(join(home, 'teamflow', 'ws-test-abc12345', 'logs', 'tf-old1', 'check-old.mjs')), '残留目录里的检查脚本按名归档')
ok(!existsSync(join(home, 'teamflow', 'ws-test-abc12345', 'logs', 'tf-old1', 'a.log')), '残留目录里的命令输出被丢弃')
ok(!existsSync(join(home, 'teamflow', 'ws-test-abc12345', 'logs', 'tf-old2')), '只有快照的残留目录根本不建归档位')
ok(existsSync(join(home, 'teamflow', 'ws-test-abc12345', 'logs', 'note-draft', 'note-draft.md')), '散落笔记归档为 logs/<stem>/<原名>')
ok(!existsSync(join(ws, TF_LOG_DIR, 'tf-legacy.log')) && !existsSync(join(ws, TF_LOG_DIR, 'note-draft.md')), '散落文件已离开项目')
ok(existsSync(join(ws, TF_LOG_DIR, 'tf-cur', 'c.log')) && existsSync(join(ws, TF_LOG_DIR, 'tf-cur.log')), '本次 run 的暂存目录与 host 日志保留（run 进行中还要写）')
ok(j2.logs.some((l) => l.message.includes('已清理本工作区')), 'journal 记录清扫汇总（含丢弃计数）')

console.log('── 7) 正在运行的 run 一律不动 ──')
staging('tf-live', 'live.log', 'live')
runs.set('tf-live', { status: 'running' })
const swept2 = sweepWorkspaceLogs(J('tf-cur'))
eq(swept2.swept, 0, '活跃 run 的暂存目录不被清走')
ok(existsSync(join(ws, TF_LOG_DIR, 'tf-live', 'live.log')), '活跃 run 目录仍在项目内')
runs.delete('tf-live')

console.log('── 8) 归档保留：每工作区最近 K 次 run ──')
const keepKey = 'ws-keeponly-00000000'
const root = logsArchiveRoot(J('x', { workspace: keepKey }))
const base = Date.now() - 10 * 24 * 3600_000
for (let i = 0; i < LOG_ARCHIVE_KEEP + 5; i++) {
  const d = join(root, `tf-keep-${String(i).padStart(2, '0')}`)
  write(join(d, 'run.log'), 'x')
  utimesSync(d, new Date(base + i * 60_000), new Date(base + i * 60_000))
}
const pruned = pruneLogArchives(J('tf-new', { workspace: keepKey }))
eq(pruned, 5, `淘汰 ${LOG_ARCHIVE_KEEP} 次以外的 5 个归档`)
const left = readdirSync(root).filter((n) => n.startsWith('tf-keep-'))
eq(left.length, LOG_ARCHIVE_KEEP, `归档数收敛到 LOG_ARCHIVE_KEEP=${LOG_ARCHIVE_KEEP}`)
ok(!existsSync(join(root, 'tf-keep-00')) && existsSync(join(root, `tf-keep-${String(LOG_ARCHIVE_KEEP + 4).padStart(2, '0')}`)), '淘汰最旧、保留最新（按 mtime）')
runs.set('tf-keep-05', { status: 'running' })
mkdirSync(join(root, 'tf-keep-05'), { recursive: true })
utimesSync(join(root, 'tf-keep-05'), new Date(base - 3600_000), new Date(base - 3600_000)) // 最旧
eq(pruneLogArchives(J('tf-new', { workspace: keepKey })) >= 0, true, '活跃 run 归档在淘汰中被跳过（不抛错）')
ok(existsSync(join(root, 'tf-keep-05')), '活跃 run 的归档目录被保留（即使最旧）')
runs.delete('tf-keep-05')

console.log('── 9) 永不抛：缺失目录 / 空 journal / 异常目录名 ──')
const ws2 = mkdtempSync(join(tmpdir(), 'tf-ws2-'))
const J2 = (id) => ({ id, name: 'x', status: 'running', workspace: 'ws-clean-00000000', workspacePath: ws2, logs: [] })
eq(sweepWorkspaceLogs(J2('tf-fresh')).swept, 0, '干净工作区无残留 → 0（无异常）')
eq(archiveRunLogs(J2('tf-never')), 0, '无暂存目录 → 0（无异常）')
eq(archiveRunLogs({ id: 'tf-x', logs: [] }), 0, '无 workspacePath → 0（无异常）')
mkdirSync(join(ws2, TF_LOG_DIR, 'bad name'), { recursive: true })
writeFileSync(join(ws2, TF_LOG_DIR, 'bad name', 'x.log'), 'x')
const weird = sweepWorkspaceLogs(J2('tf-fresh'))
eq(weird.swept, 0, '白名单外的目录名被跳过（不归档、不删除、不抛错）')
ok(existsSync(join(ws2, TF_LOG_DIR, 'bad name', 'x.log')), '异常目录原样保留（只跳过，不动别人的东西）')
try { rmSync(ws2, { recursive: true, force: true }) } catch (e) { /* ignore */ }

cleanup()
console.log(failed === 0 ? '\n✅ runlogs 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
