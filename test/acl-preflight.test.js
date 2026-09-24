/**
 * dsh-plugin-teamflow — Windows ACL 预检（2026-09-25）。
 *
 * **被修的问题**（用户原话「每次新建目录然后跑流水线，每次都碰到 ACL，agent 每次需要
 * 排查几分钟」）：宿主 sandbox 的 grantWrite 写 mandatory label 需要 WRITE_OWNER，而
 * 数据盘新建目录的继承 DACL（Authenticated Users:(M) + Users:(RX)）不含用户显式 ACE →
 * owner 隐式权利只有 READ_CONTROL+WRITE_DAC → 首跑必败 Win32 5 → 子代理 env-unavailable、
 * 主会话逐轮排查提权。
 *
 * **修法**：`host/core/acl-preflight.ts` 在 executePipeline 任何阶段之前用宿主自己的
 * `@deepseek-ai/dsh-sandbox-windows-acl`（workspace SID = sha256(realpathSync.native(root))
 * 确定性派生）把 standing grant 提前物化；失败时用 icacls 补一条 user:(WO) DACL ACE
 * （该写只需 WRITE_DAC，无需提权）后重试；仍失败 → run 立即失败并给可复制命令。
 *
 * 本文件锁四件事：
 * ① 预检挂在 executePipeline 里、且在首次 runTriage 之前（fail-fast 省 model 调用的前提）；
 * ② 失败分支必须 persistJournal + activeProducts.delete（不留幽灵锁）；
 * ③ SID 派生走宿主的 `workspaceWriteSid` + `realpathSync.native`（与宿主 materializeAclGrant
 *    同 SID 同路径 → 宿主命中 exact-ACE skip，零重复零残留）；
 * ④ 修复 ACE 是 `(WO)`（WRITE_OWNER），不是 F/提权。
 */
import { readFileSync } from 'node:fs'
import { preflightWorkspaceAcl } from '../host/core/acl-preflight.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}

const pipeSrc = readFileSync(new URL('../host/core/pipeline.ts', import.meta.url), 'utf8')
const pfSrc = readFileSync(new URL('../host/core/acl-preflight.ts', import.meta.url), 'utf8')
const localeSrc = readFileSync(new URL('../host/locales/pipeline.ts', import.meta.url), 'utf8')

console.log('[1] 挂载点：预检在任何阶段/模型调用之前')
const pfPos = pipeSrc.indexOf('preflightWorkspaceAcl(journal.workspacePath)')
ok(pfPos > 0, 'executePipeline 调用了 preflightWorkspaceAcl(journal.workspacePath)')
const triagePos = pipeSrc.indexOf('await runTriage(')
ok(pfPos > 0 && triagePos > 0 && pfPos < triagePos, '预检调用位于首次 runTriage 之前（fail-fast 省 model 调用）')
ok(/status === 'failed'[\s\S]*?journal\.status = 'failed'[\s\S]*?persistJournal\(journal\)[\s\S]*?activeProducts\.delete\(scopeKey\)/.test(pipeSrc.slice(pfPos, pfPos + 2000)), 'failed 分支：判失败 + persistJournal + 释放并发锁（不留幽灵锁）')

console.log('[2] SID 同源：与宿主 materializeAclGrant 同 SID 同路径')
ok(pfSrc.includes('aclMod.workspaceWriteSid(root)'), 'SID 来自宿主包的 workspaceWriteSid（确定性派生，宿主 exact-ACE skip 生效的前提）')
ok(pfSrc.includes('realpathSync.native'), 'root 经 realpathSync.native 规范化（与宿主 sandbox-policy 同口径）')
ok(pfSrc.includes("add(root, true)"), 'grant 以 standing 形态物化（dispose 不回收，等价宿主 workspace grant 语义）')
ok(pfSrc.includes('(OI)(CI)(WO)'), '修复 ACE 是 (OI)(CI)(WO)（仅 WRITE_OWNER，无需提权）')
ok(!pfSrc.includes('(OI)(CI)F'), '修复 ACE 不是 F（最小权限：只补缺的 WRITE_OWNER 位）')

console.log('[3] 失败语义：给用户的命令可复制、错误原文透传')
ok(pfSrc.includes("icacls"), 'fix 命令基于 icacls')
ok(pfSrc.includes("'%USERNAME%'"), '账号解析失败时退 %USERNAME% 占位（命令仍可直接执行）')

console.log('[4] locale 三键 zh/en 对称')
for (const key of ["'log.aclPreflightFixed'", "'log.aclPreflightFail'", "'run.aclPreflightFailed'"]) {
  const n = localeSrc.split(key).length - 1
  ok(n === 2, `${key} 在 zh 与 en 各出现一次（实际 ${n}）`)
}

console.log('[5] 运行时：skip 路径（不抛错）')
{
  const a = await preflightWorkspaceAcl(null)
  ok(a.status === 'skip', 'workspacePath 为空 → skip')
  const b = await preflightWorkspaceAcl('Z:/__teamflow_not_exist__/__probe__')
  ok(b.status === 'skip', '目录不存在 → skip')
}

if (failed) {
  console.error(`\n${failed} 项断言失败`)
  process.exit(1)
}
console.log('\nall acl-preflight assertions passed')
