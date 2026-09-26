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
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRun, tfAddArgs, tfUnstageArgs, tfDocAddPlan, GIT_NOTHING_TO_COMMIT, TF_DOCS_DIR, TF_LOG_DIR, BASELINE_NOISE_EXCLUDES } from '../host/core/sanity.ts'
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
// 该 fixture 的 .gitignore 只忽略 logs/teamflow/ → 任务夹未被忽略 → 应正常入库（不靠 -f）
const docPlan = tfDocAddPlan([`${TF_DOCS_DIR}/20260915-r1-fixture`, `${TF_DOCS_DIR}/memory.md`], repo)
ok(!docPlan.args.includes('-f'), '未被忽略 → 普通 add（不需要 -f）')
expect(docPlan.ignored.length, 0, '该仓库没忽略 docs/teamflow → 无被忽略项')
const docAdd = gitRun(repo, docPlan.args)
ok(docAdd.ok, '交付文档入库成功')
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

console.log('── ④ 基线排除（2026-09-18 方案 B）：索引层排除噪音 + 绝不写用户 .gitignore ──')
// 这一组锁死两件事：
//  ① 「未被忽略的路径 + :(exclude)」= exit 0 且目标不进索引（**方案 B 的立论基础**，temp 仓库实测）；
//  ② 排除项若**已被 .gitignore 忽略**，`tfExcludePathspecs` 的自检必须不下发它——否则点名被忽略路径
//     立刻复现 2026-09-11→09-15 那个 exit 1（4 天没有任何 run 提交过）。
const baseRepo = newRepo('baseline-exclude')
seedProject(baseRepo, false)
mkdirSync(join(baseRepo, '.pnpm-store', 'v3'), { recursive: true })
writeFileSync(join(baseRepo, '.pnpm-store', 'v3', 'blob.bin'), 'x'.repeat(2048), 'utf8')
mkdirSync(join(baseRepo, 'node_modules', 'dep'), { recursive: true })
writeFileSync(join(baseRepo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n', 'utf8')
// 基线提交那一刻 .gitignore 只有自有日志规则（= ensureLogGitignore 刚写过的状态），
// **没有** .pnpm-store/node_modules —— 正是冷启动的真实起点。
writeFileSync(join(baseRepo, '.gitignore'), mergeGitignore(null, [`${TF_LOG_DIR}/`]).text, 'utf8')
const gitignoreBefore = readFileSync(join(baseRepo, '.gitignore'), 'utf8')
const baseAdd = gitRun(baseRepo, tfAddArgs(BASELINE_NOISE_EXCLUDES, baseRepo), 120000)
ok(baseAdd.ok, `基线 add 带索引层排除时 exit 0（未忽略路径 + :(exclude) 是安全的）${baseAdd.ok ? '' : `：${baseAdd.error}`}`)
const basePaths = stagedPaths(baseRepo)
ok(!basePaths.some((p) => p.startsWith('.pnpm-store')), `.pnpm-store 未进索引（实测暂存 ${basePaths.length} 个文件）`)
ok(!basePaths.some((p) => p.startsWith('node_modules')), 'node_modules 未进索引')
ok(basePaths.includes('src/a.mjs'), '真交付仍在提交面内（排除是精确的，不是一刀切）')
expect(readFileSync(join(baseRepo, '.gitignore'), 'utf8'), gitignoreBefore, '**用户 .gitignore 一个字节都没被改**（方案 B 的核心承诺：不替项目决定该忽略什么）')
const baseCommit = gitRun(baseRepo, ['commit', '-m', 'chore: baseline before teamflow run'], 120000)
ok(baseCommit.ok, '基线提交成功（这就是 probe-clock 那次被超时杀掉、现在能跑通的那一步）')
const baseTree = gitRun(baseRepo, ['ls-tree', '-r', '--name-only', 'HEAD'])
ok(baseTree.ok && !baseTree.out.includes('.pnpm-store') && !baseTree.out.includes('node_modules'), '基线的提交树里没有噪音目录')

// ② 自检：排除项已被 .gitignore 忽略时，必须**不下发**该排除项（否则 exit 1）
const dupRepo = newRepo('baseline-exclude-dup')
seedProject(dupRepo, false)
mkdirSync(join(dupRepo, '.pnpm-store'), { recursive: true })
writeFileSync(join(dupRepo, '.pnpm-store', 'blob.bin'), 'x', 'utf8')
writeFileSync(join(dupRepo, '.gitignore'), mergeGitignore(mergeGitignore(null, [`${TF_LOG_DIR}/`]).text, ['.pnpm-store/']).text, 'utf8')
const dupAdd = gitRun(dupRepo, tfAddArgs(BASELINE_NOISE_EXCLUDES, dupRepo), 120000)
ok(dupAdd.ok, `排除项已被 .gitignore 忽略时仍 exit 0（自检拦下了点名：${dupAdd.ok ? '安全降级' : `FAILED：${dupAdd.error}`}）`)
ok(!stagedPaths(dupRepo).some((p) => p.startsWith('.pnpm-store')), '该噪音仍被 .gitignore 挡在索引外（自检没削弱保护）')

cleanup()
if (failed) { console.error(`\n❌ commit-path 失败 ${failed} 项`); process.exit(1) }
console.log('\n✅ commit-path 全部通过')
