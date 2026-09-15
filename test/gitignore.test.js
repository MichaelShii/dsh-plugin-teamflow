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
import { tfAddArgs, tfUnstageArgs, tfDocAddArgs, TF_DOCS_DIR, TF_LOG_DIR } from '../host/core/sanity.ts'

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
