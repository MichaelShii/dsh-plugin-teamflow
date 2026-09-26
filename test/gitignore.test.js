/**
 * dsh-plugin-teamflow — 收口提交面（.gitignore 幂等合并 + 自有日志 pathspec 排除）回归测试。
 *
 * 背景（实锤 assetd run tf-mtwvwpxa-p3vw08）：prompts 强制子代理把命令日志与临时验证脚本写进
 * `logs/teamflow/`（Log discipline / TOKEN_HYGIENE），prompts 资源表同时把它定性为「日常不读」的
 * 非交付物；而收口提交用裸 `git add -A` → 227 个提交文件里 **208 个（92%）** 是这批日志噪音
 * （100 log / 52 json / 44 临时 .mjs / 5 .cjs，623.8 KB），真交付仅 19 个文件。
 * 契约是在 host 这一侧破的（子代理报告「logs/ remain untracked」当时完全属实）。
 *
 * 修复 = 三道防线：① `mergeGitignore` 幂等补规则（卫生，也是整树 add 的唯一依赖）；
 * ② `tfUnstageArgs` 索引兜底（保证）；③ 提交结果分派日志（失败必须可见）。
 *
 * 2026-09-15 二次修正：曾经的 `tfAddArgs` 用负 pathspec `:(exclude)logs/teamflow` 点名自有日志——
 * 而 ① 刚把这行写进 `.gitignore`，git 对「显式点名且被忽略」的路径**报错退出 1**（索引其实已写好），
 * 旧代码又用 add 的结果短路提交 → **4 天里没有任何 run 提交过，且三条日志一条都不触发**。
 * 真 git 行为矩阵在 `test/commit-path.test.js`（这里只锁参数形状）。
 */
import { mergeGitignore } from '../host/util.ts'
import { tfAddArgs, tfUnstageArgs, tfDocAddArgs, TF_DOCS_DIR, TF_LOG_DIR, BASELINE_NOISE_EXCLUDES } from '../host/core/sanity.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitRun as gitRunForTest } from '../host/core/sanity.ts'

let failed = 0
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

console.log('── 收口提交面：自有日志环境（TF_LOG_DIR）──')
expect(TF_LOG_DIR, 'logs/teamflow', '日志命名空间与 prompts 的 Log discipline 同址')

console.log('── 提交参数（tfAddArgs：整树 add + 索引兜底）──')
const args = tfAddArgs()
expect(args[0], 'add', '子命令 = add')
expect(args[1], '-A', '整树 add（文档不漏提交的收益保留）')
expect(args[2], '--', 'pathspec 与选项分隔（防路径被当选项）')
expect(args[3], '.', '提交面收敛到工作区（workspace = 项目根）')
expect(args.length, 4, '无第五个参数（负 pathspec 已移除）')
ok(!args.some((a) => a.includes(':(')), '零回退：不再有魔数负 pathspec 点名 logs/teamflow（2026-09-15 实锤：点名被 .gitignore 忽略的路径 → git add 退出 1 → 收口提交被静默短路 4 天）')
ok(!args.includes(TF_LOG_DIR), '不存在把 logs/teamflow 当普通路径加进来的写法')

console.log('── 基线排除（方案 B：索引层排除，绝不写用户 .gitignore）──')
// 2026-09-18：旧实现把 .pnpm-store/node_modules 写进**用户** .gitignore（且因 mergeGitignore 的注释是整批一条，
// 顶着「TeamFlow 运行日志…」的文案落盘 —— 用户截图实锤）。方案 B：只在**自己那一次 git 调用**上收敛范围。
expect(BASELINE_NOISE_EXCLUDES.length, 2, '排除清单只有 2 项（防超时的最小集，不是"该忽略什么"的定义）')
ok(BASELINE_NOISE_EXCLUDES.includes('.pnpm-store') && BASELINE_NOISE_EXCLUDES.includes('node_modules'), '两项 = pnpm 本地 store + node_modules（冷启动 add 超时的实测来源）')
ok(!BASELINE_NOISE_EXCLUDES.includes('.idea'), '**不含** .idea——"该忽略什么"归 L2（PM 按技术栈规划）与 L3（QA 探针），host 不替项目决定')
// 注意：`tfExcludePathspecs` 用 `git check-ignore` **以目标仓库为根**做自检——被忽略的项不下发（点名被忽略
// 路径 → git exit 1，见 2026-09-11→09-15 那个 4 天不提交的坑）。本目录不是 git 仓库（或该项未被忽略）时的
// 行为分两种，两种都安全，故断言「不出现危险组合」而非具体结果。
const baseArgs = tfAddArgs(BASELINE_NOISE_EXCLUDES)
expect(baseArgs.slice(0, 4).join(' '), 'add -A -- .', '前缀与收口提交完全一致（同一函数，行为不分叉）')
ok(baseArgs.length <= 4 + BASELINE_NOISE_EXCLUDES.length, '排除项数量不放大（最多每项一个 pathspec）')
ok(baseArgs.every((a, i) => i < 4 || a.startsWith(':(exclude)')), '第 5 项起只可能是 :(exclude) 形式')
expect(tfAddArgs([]).length, 4, '空清单 → 退回 4 参数（收口提交路径逐字不变）')
expect(tfAddArgs().length, 4, '省略参数 → 同空清单（向后兼容，存量调用点零改动）')
ok(!tfAddArgs().some((a) => a.includes(':(')), '收口提交**不带**任何排除（自有日志靠 .gitignore + 索引兜底，见下）')
// 正向验证（真 git 仓库、噪音未被忽略 → 必须下发；已忽略 → 必须不下发）。两个方向都锁，杜绝"读了别人 cwd"。
// 环境要求 = git 可被**本进程** spawn（DSH 文件沙箱 piped-stdio 限制会 EPERM）——与 commit-path 同款
// SKIP 口径（2026-09-26 补）：git 不可用时只跳过本块，形状/纯函数断言照跑；普通终端跑 pnpm test 才是真实门禁。
{
  const tmp = mkdtempSync(join(tmpdir(), 'tf-gi-'))
  const probe = gitRunForTest(tmp, ['--version'])
  if (!probe.ok) {
    console.log(`  ⏭ SKIP 正向验证：本进程无法 spawn git（${probe.error}）——普通终端下本块才是真实门禁`)
  } else {
    gitRunForTest(tmp, ['init', '-q'])
    mkdirSync(join(tmp, '.pnpm-store'), { recursive: true })
    writeFileSync(join(tmp, '.pnpm-store', 'b.bin'), 'x', 'utf8')
    mkdirSync(join(tmp, '.ignored-dir'), { recursive: true })
    writeFileSync(join(tmp, '.ignored-dir', 'b.bin'), 'x', 'utf8')
    writeFileSync(join(tmp, '.gitignore'), '.ignored-dir/\n', 'utf8')
    const sent = tfAddArgs(['.pnpm-store', '.ignored-dir'], tmp)
    ok(sent.includes(':(exclude).pnpm-store'), '未被忽略的噪音 → 下发 :(exclude)（排除生效）')
    ok(!sent.includes(':(exclude).ignored-dir'), '**已被忽略**的项 → **不**下发（点名被忽略路径会让 add exit 1）')
    ok(tfAddArgs(['node_modules'], tmp).includes(':(exclude)node_modules'), '同一仓内逐项独立判定（不是一刀切）')
  }
  rmSync(tmp, { recursive: true, force: true })
}

console.log('── 索引兜底（tfUnstageArgs：自有日志永不入提交）──')
const un = tfUnstageArgs()
expect(un[0], 'rm', '子命令 = rm')
ok(un.includes('--cached'), '只动索引（不删工作区文件）')
ok(un.includes('-r'), '目录需 -r（logs/teamflow 是目录）')
ok(un.includes('--ignore-unmatch'), '未命中不报错（幂等、可无条件调用，exit 0）')
expect(un[un.length - 1], TF_LOG_DIR, `兜底目标 = 自有日志目录（${TF_LOG_DIR}）`)
ok(!un.includes('--quiet'), '不带 --quiet：真摘出东西时 stdout 非空，调用方据此记 warn 留痕')

console.log('── 交付文档强制入库（QA-7：目标仓库忽略 docs/teamflow/ 时交付物不被静默吞掉）──')
expect(TF_DOCS_DIR, 'docs/teamflow', '任务夹命名空间与 prompts 同址')
expect(tfDocAddArgs([]).length, 0, '无交付文档 → 空参数（不做无意义 git 调用）')
expect(tfDocAddArgs([null, '', undefined]).length, 0, '全空值 → 空参数')
const docs = tfDocAddArgs([`${TF_DOCS_DIR}/20260915-r9-host-i18n-locale`, `${TF_DOCS_DIR}/memory.md`])
expect(docs[0], 'add', '子命令 = add')
expect(docs[1], '-f', '强制入库（目标仓库 .gitignore 忽略 docs/teamflow/ 时仍交付）')
expect(docs[2], '--', 'pathspec 与选项分隔')
expect(docs.length, 5, '只带本次 run 的夹 + memory.md 两个路径')
ok(docs[3].startsWith(`${TF_DOCS_DIR}/`), '限定在 docs/teamflow/ 内（不放开全树）')
ok(!docs.includes('-A') && !docs.includes('.'), '绝不放宽为 add -f -A（否则 ignored 的 node_modules/lib 会被拖进提交）')

console.log('── .gitignore 幂等合并（mergeGitignore）──')
const created = mergeGitignore(null, ['logs/teamflow/'])
ok(created.changed, '无 .gitignore → 创建（changed=true）')
ok(created.text.includes('logs/teamflow/'), '新文件中写入规则')
ok(created.text.includes('# TeamFlow'), '新文件带说明注释（用户知道这行哪来的）')
ok(created.text.endsWith('\n'), '以换行收尾')

const appended = mergeGitignore('node_modules/\n*.log\n', ['logs/teamflow/'])
ok(appended.changed, '已有 .gitignore 但缺规则 → 追加')
ok(appended.text.startsWith('node_modules/\n*.log\n'), '原内容一字不动（只追加）')
ok(appended.text.includes('\n\n# TeamFlow'), '追加块与原文空行分隔')

const noTrailingNewline = mergeGitignore('node_modules/', ['logs/teamflow/'])
ok(noTrailingNewline.text.startsWith('node_modules/\n'), '原文缺结尾换行时先补换行（不粘行）')
ok(noTrailingNewline.text.includes('logs/teamflow/'), '规则仍然写入')

const exact = mergeGitignore('logs/teamflow/\n', ['logs/teamflow/'])
ok(!exact.changed, '规则已存在（字面相等）→ changed=false（调用方不写文件）')
expect(exact.text, 'logs/teamflow/\n', '不变时不改写文本')

const widerDir = mergeGitignore('logs/\n', ['logs/teamflow/'])
ok(!widerDir.changed, '更宽的目录规则 logs/ 已覆盖 → 不塞冗余规则')

const widerGlob = mergeGitignore('logs/**\n', ['logs/teamflow/'])
ok(!widerGlob.changed, 'logs/** 同样算已覆盖')

const commented = mergeGitignore('# logs/teamflow/\n', ['logs/teamflow/'])
ok(commented.changed, '注释掉的规则不算忽略（必须真写一行）')

const crlf = mergeGitignore('node_modules/\r\n', ['logs/teamflow/'])
ok(crlf.changed && crlf.text.includes('logs/teamflow/'), 'CRLF 文件（Windows 仓库）不误判为已覆盖')

const sibling = mergeGitignore('logs/other/\n', ['logs/teamflow/'])
ok(sibling.changed, '兄弟目录规则 logs/other/ 不覆盖 logs/teamflow/')

console.log(failed === 0 ? '\n✅ gitignore 全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
