/**
 * Windows ACL 预检（2026-09-25）——产品级根治「新目录首跑流水线必碰 ACL env-unavailable」。
 *
 * **根因**（控制变量实验实锤，见 `.workbuddy/memory/2026-09-24.md`）：宿主 sandbox 的
 * `grantWrite`（`@deepseek-ai/dsh-sandbox-windows-acl/lib/types/acl.js`）用一次
 * `SetNamedSecurityInfoW` 同时写 DACL（capability ACE + Everyone deny DC）与 SACL
 * （Low mandatory label）。**写 label 进 SACL 需要 WRITE_OWNER**；owner 身份只隐式授予
 * READ_CONTROL + WRITE_DAC ⇒ 首跑成败取决于目录 DACL 里有没有给当前用户的**显式** ACE：
 *   - `%TEMP%`（C:\Users\<user> profile 继承链自带 user:(F)）→ 必成；
 *   - E: 等数据盘（继承 DACL 通常只有 `Authenticated Users:(M)` + `Users:(RX)`）→ 必败 Win32 5。
 *
 * **自救原理**：给目录补一条 `user:(WO)`（WRITE_OWNER）DACL ACE 的写操作只需要
 * WRITE_DAC（owner 隐式就有）——**不需要管理员、不需要提权**。更优：workspace SID 是
 * `sha256(realpathSync.native(root))` 确定性派生的宿主 capability SID（`workspaceWriteSid`），
 * 本模块直接用宿主自己的 `@deepseek-ai/dsh-sandbox-windows-acl` 按**同一 SID**把 standing
 * grant 提前物化——宿主随后 `materializeAclGrant` 命中 exact-ACE skip（O(1)），零重复、
 * 零残留、零额外写放大（sid 相同 ⇒ 落的就是宿主要落的 ACE）。
 *
 * **失败语义**：预检失败（连 DACL-only 的 icacls 修复都不成功等罕见情形）→ 返回 `failed`，
 * 由 `executePipeline` 在**任何阶段/任何模型调用之前**把 run 判失败并给出一条可复制的
 * icacls 命令——不再让子代理跑到 dev 才 env-unavailable、主会话再花几分钟排查。
 * 预检自身不可用（非 Windows / 宿主未装该包）→ `skip`，行为与旧版完全一致。
 *
 * 幂等性：宿主 `grantWrite` 自带 exact-ACE skip（capability ACE + deny + label 三者齐才跳），
 * 同目录重复预检是 O(1) 读检查，不触发全树继承传播。
 */

import { existsSync, realpathSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'

/** System32 绝对路径：不依赖服务进程的 PATH（whoami/icacls 都在 System32）。 */
const SYSTEM32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32')

export interface AclPreflightResult {
  /** skip=非 Windows/包不可用/目录不存在；ok=授权已就绪（含本次物化成功）；fixed=补写修复 ACE 后就绪；failed=救不回来 */
  status: 'skip' | 'ok' | 'fixed' | 'failed'
  /** failed 时的底层错误（grantWrite / icacls 的原文） */
  err?: string
  /** failed 时给用户的可复制修复命令（普通终端即可，无需管理员） */
  fix?: string
}

/** 当前用户账号（`whoami` 带 DOMAIN\user 形态最稳；失败退 `os.userInfo`）。 */
function currentUserAccount(): string {
  try {
    const r = spawnSync(join(SYSTEM32, 'whoami.exe'), [], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout && String(r.stdout).trim()) return String(r.stdout).trim()
  } catch { /* fallthrough */ }
  try { return userInfo().username } catch { return '' }
}

/** 给用户看/手动执行的修复命令（与自动修复同一形态）。 */
function fixCommandOf(path: string, user: string): string {
  return `icacls "${path}" /grant "${user || '%USERNAME%'}:(OI)(CI)(WO)"`
}

interface AclModule {
  workspaceWriteSid: (root: string) => string
  AclWriteGrant: { create: (sid: string) => { add: (path: string, standing?: boolean) => void; dispose: () => void } }
}

/** 用宿主的包 + 宿主的派生算法，把 standing workspace grant 物化到 root（即宿主本来要做的那次写）。 */
async function materializeStandingGrant(aclMod: AclModule, root: string): Promise<void> {
  const sid = aclMod.workspaceWriteSid(root)
  const grant = aclMod.AclWriteGrant.create(sid)
  try {
    grant.add(root, true) // standing：宿主 dispose 语义本就不回收 standing 编辑
  } catch (error) {
    try { grant.dispose() } catch { /* 清理尽力而为，原始错误优先上抛 */ }
    throw error
  }
  grant.dispose()
}

/**
 * 预检 + 自愈一个流水线工作区。详见模块头注释。永不抛错——所有失败折叠为 `failed` 结果。
 */
export async function preflightWorkspaceAcl(workspacePath: string | null | undefined): Promise<AclPreflightResult> {
  if (process.platform !== 'win32' || !workspacePath || !existsSync(workspacePath)) return { status: 'skip' }
  let aclMod: AclModule
  try {
    // 宿主私有包（peerDependencies 声明为 optional）：不在默认组合里 → 预检整体跳过，行为同旧版。
    aclMod = (await import('@deepseek-ai/dsh-sandbox-windows-acl')) as unknown as AclModule
  } catch {
    return { status: 'skip' }
  }
  // 与宿主 sandbox-policy 同一口径的规范化（workspace-sid.js 明写：realpathSync.native），
  // 保证我们派生的 SID 与宿主 materializeAclGrant 派生的 SID 一致 → 宿主命中 exact-ACE skip。
  let root = workspacePath
  try { root = realpathSync.native(workspacePath) } catch { /* 用原路径兜底 */ }
  try {
    await materializeStandingGrant(aclMod, root)
    return { status: 'ok' }
  } catch (firstError) {
    const first = String((firstError as Error)?.message || firstError)
    const user = currentUserAccount()
    const fix = fixCommandOf(workspacePath, user)
    // 修复写的是 DACL-only 的 user:(WO) ACE —— 只需要 WRITE_DAC（owner 隐式足够），无需提权。
    let fixErr = ''
    try {
      const r = spawnSync(join(SYSTEM32, 'icacls.exe'), [root, '/grant', `${user || '%USERNAME%'}:(OI)(CI)(WO)`], { encoding: 'utf8' })
      if (r.status !== 0) fixErr = String(r.error?.message || r.stderr || r.stdout || `icacls exit ${r.status}`).trim()
    } catch (e) {
      fixErr = String((e as Error)?.message || e)
    }
    if (fixErr) return { status: 'failed', err: `${first}; icacls: ${fixErr}`, fix }
    try {
      await materializeStandingGrant(aclMod, root)
    } catch (retryError) {
      const retry = String((retryError as Error)?.message || retryError)
      return { status: 'failed', err: `${first}; 修复后仍失败: ${retry}`, fix }
    }
    return { status: 'fixed' }
  }
}
