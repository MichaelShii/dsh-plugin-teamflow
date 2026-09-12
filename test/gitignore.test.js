/**
 * dsh-plugin-teamflow — 收口提交面（.gitignore 幂等合并 + 自有日志 pathspec 排除）回归测试。
 *
 * 背景（实锤 assetd run tf-mtwvwpxa-p3vw08）：prompts 强制子代理把命令日志与临时验证脚本写进
 * `logs/teamflow/`（Log discipline / TOKEN_HYGIENE），prompts 资源表同时把它定性为「日常不读」的
 * 非交付物；而收口提交用裸 `git add -A` → 227 个提交文件里 **208 个（92%）** 是这批日志噪音
 * （100 log / 52 json / 44 临时 .mjs / 5 .cjs，623.8 KB），真交付仅 19 个文件。
 * 契约是在 host 这一侧破的（子代理报告「logs/ remain untracked」当时完全属实）。
 *
 * 修复 = 两道防线：① `mergeGitignore` 幂等补规则（卫生）；② `tfAddArgs` pathspec 强制排除（保证）。
 */
import { mergeGitignore } from '../host/util.ts'
import { tfAddArgs, TF_LOG_DIR } from '../host/core/sanity.ts'

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

console.log('── 提交参数（tfAddArgs：禁止裸 add -A）──')
const args = tfAddArgs()
expect(args[0], 'add', '子命令 = add')
expect(args[1], '-A', '整树 add（文档不漏提交的收益保留）')
expect(args[2], '--', 'pathspec 与选项分隔（防路径被当选项）')
expect(args[3], '.', '提交面收敛到工作区（workspace = 项目根）')
expect(args[4], ':(exclude)logs/teamflow', 'magic pathspec 排除自有日志（不依赖目标仓库 .gitignore）')
ok(!args.includes('logs'), '不存在把 logs 当普通路径加进来的写法')

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
