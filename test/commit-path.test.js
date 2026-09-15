/**
 * dsh-plugin-teamflow — 收口提交链路的**真 git 集成测试**。
 *
 * 为什么必须有它（2026-09-15 实锤：4 天里没有任何 run 提交过，日志上完全看不出来）：
 * 单元测试只断言参数**形状**，而这次的坑恰恰是「参数形状变了、git 行为也变了」——
 * `git add -A -- . ':(exclude)logs/teamflow'` 在 `.gitignore` 含 `logs/teamflow/` 时**退出 1**
 * （而 `ensureLogGitignore()` 正是刚把这行写进 .gitignore 的那一步；索引其实已经写好），
 * 旧代码用 add 的结果短路提交 → 提交被跳过、`commitDone/commitSkip/commitFail` 三条一条都不触发。
 *
 * 本文件用真仓库跑三件事（缺一不可）：
 *  ① **防回退**：负 pathspec 在规则存在时确实 exit 1 —— 谁再写回这个写法，这里立刻红；
 *  ② 修复路径跑通：写 .gitignore → 整树 add → 索引兜底 → commit，断言 commit 真的存在且不含 `logs/teamflow`；
 *  ③ 兜底有效性 + 判据可用：强制把自有日志塞进索引后 `tfUnstageArgs()` 能摘干净；第二次 commit 的失败
 *     能被 `GIT_NOTHING_TO_COMMIT` 认成「无事可做」（而不是被记成故障）。
 *
 * 环境要求：git 可执行且**能被本进程 spawn**。DSH 文件沙箱下 piped-stdio spawn 会 `EPERM`
 * （`spawnSync git EPERM`），此时打印 SKIP 并**不算失败**——在普通终端里跑 `pnpm test` 才是真实门禁。
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRun, tfAddArgs, tfUnstageArgs, tfDocAddArgs, GIT_NOTHING_TO_COMMIT, TF_DOCS_DIR, TF_LOG_DIR } from '../host/core/sanity.ts'
import { mergeGitignore } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

const RUN_ID = 'tf-commitpath-test'
const tmpRoot = mkdtempSync(join(tmpdir(), 'tf-commit-'))
const cleanup = () => { try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 清理尽力而为 */ } }

/** 建一个「刚 git init、身份已就地配置」的空仓库（不依赖宿主全局 git 配置）。 */
function newRepo(name) {
  const dir = join(tmpRoot, name)
  mkdirSync(dir, { recursive: true })
  gitRun(dir, ['init', '-q'])
  gitRun(dir, ['config', 'user.email', 'teamflow@test.local'])
  gitRun(dir, ['config', 'user.name', 'TeamFlow Test'])
  gitRun(dir, ['config', 'commit.gpgsign', 'false'])
  return dir
}

/** 铺一份最小工程：源码 + 任务夹产物 + 自有日志暂存目录（含白名单外的 dump）。 */
function seedProject(dir, withGitignore) {
  writeFileSync(join(dir, 'package.json'), '{\n  "name": "fixture",\n  "private": true\n}\n', 'utf8')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.mjs'), 'export const a = 1\n', 'utf8')
  mkdirSync(join(dir, TF_DOCS_DIR, '20260915-r1-fixture'), { recursive: true })
  writeFileSync(join(dir, TF_DOCS_DIR, '20260915-r1-fixture', 'ACCEPTANCE.md'), 'Acceptance verdict: ✅ Pass\n', 'utf8')
  writeFileSync(join(dir, TF_DOCS_DIR, 'memory.md'), '# memory\n', 'utf8')
  mkdirSync(join(dir, TF_LOG_DIR, RUN_ID, 'scripts'), { recursive: true })
  writeFileSync(join(dir, TF_LOG_DIR, RUN_ID, 'scripts', 'check.mjs'), 'console.log("50/50")\n', 'utf8')
  writeFileSync(join(dir, TF_LOG_DIR, RUN_ID, 'dropped.log'), 'command output that must never be committed\n', 'utf8')
  if (withGitignore) writeFileSync(join(dir, '.gitignore'), mergeGitignore(null, [`${TF_LOG_DIR}/`]).text, 'utf8')
}

/** 索引里实际有哪些路径（用 ls-files：unborn HEAD 也能读，不依赖 HEAD 解析）。 */
function stagedPaths(dir) {
  const r = gitRun(dir, ['ls-files', '--cached'])
  return r.ok ? r.out.split('\n').map((l) => l.trim()).filter(Boolean) : []
}

console.log('── 0) 环境探测（git 可 spawn 才继续，否则 SKIP）──')
const probeRepo = newRepo('probe')
const probe = gitRun(probeRepo, ['--version'])
if (!probe.ok) {
  console.log(`  ⏭ SKIP：本进程无法 spawn git（${probe.error}）——DSH 文件沙箱的 piped-stdio 限制；普通终端下本文件才是真实门禁`)
  cleanup()
  process.exit(0)
}
console.log(`  ✓ git 可用：${probe.out}`)

console.log('── ① 防回退：负 pathspec 点名被忽略路径 = git add 退出 1（旧写法的坑）──')
const oldRepo = newRepo('old-way')
seedProject(oldRepo, true) // .gitignore 已含规则（ensureLogGitignore 刚写过的状态）
const oldAdd = gitRun(oldRepo, ['add', '-A', '--', '.', `:(exclude)${TF_LOG_DIR}`])
ok(oldAdd.ok === false, '负 pathspec 版 tfAddArgs 在规则存在时失败（这就是曾经的收口提交被静默短路的原因）')
ok(/ignored/i.test(oldAdd.error || ''), `失败原因就是「paths are ignored」（实测：${String(oldAdd.error || '').split('\n')[0].slice(0, 90)}）`)
ok(stagedPaths(oldRepo).length > 0, '而它其实已经把文件写进索引（现场表现 = 文件已 staged 但没有 commit）')

console.log('── ② 修复路径：写 .gitignore → 整树 add → 索引兜底 → commit ──')
const repo = newRepo('fixed-way')
seedProject(repo, false)
writeFileSync(join(repo, '.gitignore'), mergeGitignore(null, [`${TF_LOG_DIR}/`]).text, 'utf8') // = ensureLogGitignore
const docAdd = gitRun(repo, tfDocAddArgs([`${TF_DOCS_DIR}/20260915-r1-fixture`, `${TF_DOCS_DIR}/memory.md`]))
ok(docAdd.ok, '交付文档强制入库（add -f）成功')
const addR = gitRun(repo, tfAddArgs())
ok(addR.ok, `整树 add 成功（旧写法在这里返回 null）${addR.ok ? '' : `：${addR.error}`}`)
const unR = gitRun(repo, tfUnstageArgs())
ok(unR.ok, '索引兜底 exit 0（幂等：本就没被跟踪）')
expect(unR.out, '', '兜底无输出 = 自有日志根本没进索引（.gitignore 防线生效）')
const paths = stagedPaths(repo)
ok(!paths.some((p) => p.startsWith(TF_LOG_DIR)), `暂存区不含 ${TF_LOG_DIR}（实测 ${paths.length} 个文件）`)
ok(paths.includes('src/a.mjs') && paths.some((p) => p.startsWith(`${TF_DOCS_DIR}/`)), '代码与任务夹产物都在提交面内')
const commit = gitRun(repo, ['commit', '-m', 'chore: teamflow closing commit'])
ok(commit.ok, 'commit 成功（收口提交不再被短路）')
const log = gitRun(repo, ['log', '--oneline'])
ok(log.ok && log.out.split('\n').filter(Boolean).length === 1, '仓库里真的有了 1 个 commit')
const tree = gitRun(repo, ['ls-tree', '-r', '--name-only', 'HEAD'])
ok(tree.ok && !tree.out.includes(TF_LOG_DIR), '提交树里没有自有日志（承诺：logs/teamflow 永不入提交）')
ok(tree.ok && tree.out.includes('src/a.mjs'), '提交树里有交付代码')

console.log('── ③ 判据：兜底真摘出东西 + 「无事可做」分类 ──')
const secRepo = newRepo('unstaged')
seedProject(secRepo, false) // 故意不写 .gitignore = 规则失效
ok(gitRun(secRepo, ['add', '-f', '--', '.']).ok, '规则失效时自有日志被（强制）塞进索引')
const un2 = gitRun(secRepo, tfUnstageArgs())
ok(un2.ok, '兜底执行成功（只动索引，未命中也不报错）')
ok(un2.out.includes(TF_LOG_DIR), '兜底输出非空 → 调用方据此记 warn 留痕（防线①失效可见）')
ok(!stagedPaths(secRepo).some((p) => p.startsWith(TF_LOG_DIR)), `摘出后暂存区不再含 ${TF_LOG_DIR}`)
ok(existsSync(join(secRepo, TF_LOG_DIR, RUN_ID, 'dropped.log')), '工作区文件没被删（--cached 只动索引）')

const secCommit = gitRun(secRepo, ['commit', '-m', 'chore: closing commit'])
ok(secCommit.ok, '规则失效时也能正常提交（兜底把日志摘出后剩下的都是交付物）')
const clean = gitRun(secRepo, ['status', '--porcelain', '--untracked-files=no'])
ok(clean.ok && clean.out === '', '提交后已无待提交内容（--untracked-files=no；本仓库故意没写 .gitignore，未跟踪的 logs/ 仍在——正是下面措辞分类要覆盖的场景）')
const again = gitRun(secRepo, ['commit', '-m', 'chore: nothing left'])
ok(again.ok === false, '再来一次 commit 确实失败（无事可做）')
ok(GIT_NOTHING_TO_COMMIT.test(again.error || ''), `失败文本被 GIT_NOTHING_TO_COMMIT 兜底认成「无事可做」（实测措辞：${String(again.error || '').split('\n').filter(Boolean).slice(-1)[0].slice(0, 70)}）`)

cleanup()
if (failed) { console.error(`\n❌ commit-path 失败 ${failed} 项`); process.exit(1) }
console.log('\n✅ commit-path 全部通过')
