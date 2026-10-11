/**
 * dsh-plugin-teamflow — 版本探测（`host/core/update-check.ts`）的确定性回归测试。
 *
 * 这个功能的价值全在「**什么时候不提示**」上——提示错了比不提示糟得多
 * （用户被推去做一次没必要的重装）。所以本文件的重心不是「能查出新版」，
 * 而是四条**负向判据**：
 *   ① 解析不了的版本 → 一律不提示（网络脏数据不得变成一条假提醒）；
 *   ② 已跳过的那一版 → 不提示；但**更新的版本出现时必须重新提示**（跳过是「跳过这一版」）；
 *   ③ 缓存新鲜 → **一次网络都不发**（探测功能不得变成后台轮询）；
 *   ④ 网络失败 → 降级成「不知道」并**显式**带出原因，且不得清掉已有的旧 `latest`。
 *
 * ⚠️ 所有用例都**显式传 `file`**，绝不落到 `updateCacheFile()`——那是用户的真实
 * `$DSH_HOME/teamflow/update-check.json`，测试不许碰。
 */
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseVersion, compareVersions, pickLatest, shouldNotify, readOwnVersion,
  readCache, writeCache, skipVersion, checkForUpdate, updateCheckEnabled, upgradeGate, classifyInstallSource,
} from '../host/core/update-check.ts'
import { installCommand, installRecipe } from '../host/util.ts'

let failed = 0
const expect = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const tmp = mkdtempSync(join(tmpdir(), 'tf-upcheck-'))
const cache = join(tmp, 'update-check.json')

/** 造一个 fetch 桩：`payload` 为对象即成功，`'throw'` 抛网络错，`'http'` 返回非 2xx。 */
const stub = (payload) => {
  const calls = { n: 0 }
  const fetchImpl = async () => {
    calls.n++
    if (payload === 'throw') throw new Error('offline')
    if (payload === 'http') return { ok: false, json: async () => ({}) }
    return { ok: true, json: async () => payload }
  }
  return { fetchImpl, calls }
}
const packument = (latest) => ({ 'dist-tags': { latest }, versions: { '0.1.0': {}, [latest]: {} } })

console.log('── 1) parseVersion / compareVersions ──')
{
  expect(parseVersion('0.2.7')?.nums.join('.'), '0.2.7', 'x.y.z 可解析')
  expect(parseVersion('v0.2.7')?.nums.join('.'), '0.2.7', '容忍 v 前缀（git tag 形态）')
  expect(parseVersion('0.2.0-rc.1')?.pre.join('.'), 'rc.1', '预发布段解析出来')
  expect(parseVersion('0.2.7+build.9')?.nums.join('.'), '0.2.7', 'build 元数据不参与（数字段仍为 0.2.7）')
  expect(parseVersion('0.2') === null, true, 'x.y 不合法 → null')
  expect(parseVersion('') === null, true, '空串 → null')
  expect(parseVersion(undefined) === null, true, 'undefined → null')

  expect(compareVersions('0.2.7', '0.2.6') > 0, true, '0.2.7 > 0.2.6')
  expect(compareVersions('0.2.10', '0.2.9') > 0, true, '数值比较（0.2.10 > 0.2.9，不是字典序）')
  expect(compareVersions('0.3.0', '0.2.99') > 0, true, '次版本优先于补丁')
  expect(compareVersions('1.0.0', '1.0.0-rc.1') > 0, true, '正式版 > 同号预发布')
  expect(compareVersions('0.2.0-rc.2', '0.2.0-rc.1') > 0, true, '预发布内数值递增')
  expect(compareVersions('0.2.0-alpha', '0.2.0-beta') < 0, true, '同段字母序')
  expect(compareVersions('0.2.7', '0.2.7'), 0, '相等')
  expect(compareVersions('garbage', '0.2.7'), 0, '⚠️ 解析不了 → 视为相等（宁可漏提示也不误提示）')
}

console.log('── 2) pickLatest ──')
{
  expect(pickLatest(packument('0.2.7')), '0.2.7', '优先 dist-tags.latest')
  expect(pickLatest({ versions: { '0.2.6': {}, '0.2.10': {}, '0.2.9': {} } }), '0.2.10', '没有 dist-tags 时扫 versions 取最大值（数值比较）')
  expect(pickLatest({ 'dist-tags': { latest: 'not-a-version' }, versions: { '0.2.6': {} } }), '0.2.6', 'latest 脏 → 回退扫 versions')
  expect(pickLatest({ 'dist-tags': { latest: 'not-a-version' } }), null, '全脏 → null')
  expect(pickLatest(null), null, 'null → null（绝不抛）')
}

console.log('── 3) shouldNotify：负向判据 ──')
{
  expect(shouldNotify({ current: '0.2.6', latest: '0.2.7' }), true, '有新版 → 提示')
  expect(shouldNotify({ current: '0.2.7', latest: '0.2.7' }), false, '同版 → 不提示')
  expect(shouldNotify({ current: '0.2.7', latest: '0.2.6' }), false, '本地更新（灰度/回滚）→ 不提示')
  expect(shouldNotify({ current: '0.2.6', latest: '0.2.7', skipped: '0.2.7' }), false, '已跳过该版 → 不提示')
  expect(shouldNotify({ current: '0.2.6', latest: '0.2.8', skipped: '0.2.7' }), true, '⚠️ 跳过的是**具体版本号**：更新的 0.2.8 出现 → 重新提示')
  expect(shouldNotify({ current: '0.2.6', latest: null }), false, '不知道最新版 → 不提示')
  expect(shouldNotify({ current: '', latest: '0.2.7' }), false, '当前版本未知 → 不提示')
  expect(shouldNotify({ current: '0.2.6', latest: 'garbage' }), false, '最新版脏 → 不提示')
}

console.log('── 4) readOwnVersion：读的是磁盘，不是构建期常量 ──')
{
  const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8'))
  expect(readOwnVersion(), pkg.version, '与仓库 package.json 的 version 逐字相同')
  // 出货形态：bundle 后本模块位于 `<pkg>/lib/host.mjs`，与源码树 `host/core/` 的**相对深度不同**。
  // 这一条钉住「两种形态都要能解析」——只覆盖源码树时，出货后会静默返回 null（＝永不提示）。
  expect(readOwnVersion(new URL('../lib/host.mjs', import.meta.url).href), pkg.version, '出货形态（lib/host.mjs）也能读到版本')
  expect(readOwnVersion('file:///definitely/not/here/lib/host.mjs'), null, '只读失败 → null（不猜、不回退环境变量）')
}

console.log('── 5) 缓存 / 跳过 ──')
{
  expect(readCache(cache), null, '文件不存在 → null')
  writeFileSync(cache, '{ not json')
  expect(readCache(cache), null, '缓存损坏 → null（坏缓存等于没缓存）')

  expect(writeCache(cache, { checkedAt: 1000, latest: '0.2.7' }), true, '写入成功')
  expect(readCache(cache)?.latest, '0.2.7', '回读 latest')
  expect(skipVersion(cache, '0.2.7'), true, '记下跳过')
  expect(readCache(cache)?.skipped, '0.2.7', '跳过记录落盘')
  expect(readCache(cache)?.latest, '0.2.7', '⚠️ 只改跳过，不得动已缓存的 latest')

  writeCache(cache, { checkedAt: 2000, latest: '0.2.8' })
  expect(readCache(cache)?.skipped, '0.2.7', '⚠️ 后续探测覆写缓存时**保留**跳过记录（否则跳过会被静默抹掉）')

  // 只跳过、从没成功探测过：checkedAt=0 必须仍能读回，否则跳过记录凭空消失。
  rmSync(cache, { force: true })
  expect(skipVersion(cache, '0.2.7'), true, '在没有缓存文件时直接记跳过')
  expect(readCache(cache)?.skipped, '0.2.7', '⚠️ checkedAt=0 的「只记过跳过」记录必须能读回')
  expect(skipVersion(cache, 'garbage'), false, '跳过非版本号 → 拒绝（不写脏数据）')
}

console.log('── 6) checkForUpdate：开关 / 缓存 / 降级 ──')
{
  rmSync(cache, { force: true })
  let r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: false })
  expect(r.enabled, false, 'enabled=false 时不探测')
  expect(r.error, 'disabled', '显式说明是「被关掉」而不是「查不到」')
  expect(r.outdated, false, '关掉 → 不提示')

  r = await checkForUpdate({ file: cache, current: '', enabled: true })
  expect(r.error, 'unknown-current-version', '取不到当前版本 → 显式错误码')
  expect(r.outdated, false, '当前版本未知 → 不提示')

  rmSync(cache, { force: true })
  const cold = stub(packument('0.2.9'))
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: cold.fetchImpl, now: 1_000_000 })
  expect(cold.calls.n, 1, '冷启动查一次网络')
  expect(r.latest, '0.2.9', '拿到最新版')
  expect(r.outdated, true, '有新版 → 该提示')
  expect(r.error, null, '成功路径不带错误')
  expect(readCache(cache)?.latest, '0.2.9', '结果落盘')

  const warm = stub(packument('9.9.9'))
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: warm.fetchImpl, now: 1_000_000 + 60_000 })
  expect(warm.calls.n, 0, '⚠️ 缓存新鲜 → 一次网络都不发（不做后台轮询）')
  expect(r.latest, '0.2.9', '用缓存里的版本')

  const forced = stub(packument('0.3.0'))
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: forced.fetchImpl, now: 1_000_000 + 60_000, force: true })
  expect(forced.calls.n, 1, 'force 忽略缓存有效期（A/B 与端到端验证要用）')
  expect(r.latest, '0.3.0', 'force 拿到新值')

  const stale = stub(packument('0.4.0'))
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: stale.fetchImpl, now: 1_000_000 + 48 * 3600_000 })
  expect(stale.calls.n, 1, '缓存过期 → 重新查')
  expect(r.latest, '0.4.0', '刷新到新值')

  const dead = stub('throw')
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: dead.fetchImpl, now: 1_000_000 + 96 * 3600_000 })
  expect(r.error, 'registry-unreachable', '⚠️ 网络失败 → 显式报「问不到」，不是静默')
  expect(r.latest, '0.4.0', '⚠️ 失败时保留旧 latest（比「突然不提示了」有用）')
  expect(r.outdated, true, '仍按旧 latest 提示')

  const http = stub('http')
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: http.fetchImpl, now: 1_000_000 + 120 * 3600_000 })
  expect(r.error, 'registry-unreachable', '非 2xx 也算问不到')

  rmSync(cache, { force: true })
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: dead.fetchImpl, now: 1_000_000 })
  expect(r.latest, null, '没有任何缓存 + 网络失败 → latest 为 null')
  expect(r.outdated, false, '不知道 → 不提示')
  expect(r.error, 'registry-unreachable', '但错误仍然显式')

  // 跳过语义要穿过完整链路（缓存 → shouldNotify），不只是纯函数
  const ok = stub(packument('0.2.9'))
  await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: ok.fetchImpl, now: 5_000_000 })
  skipVersion(cache, '0.2.9')
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: ok.fetchImpl, now: 5_000_000 + 60_000 })
  expect(r.outdated, false, '跳过 0.2.9 后不再提示')
  expect(ok.calls.n, 1, '（顺带：这次走的是缓存，没多发网络）')

  const newer = stub(packument('0.3.1'))
  r = await checkForUpdate({ file: cache, current: '0.2.6', enabled: true, fetchImpl: newer.fetchImpl, now: 5_000_000 + 48 * 3600_000 })
  expect(r.outdated, true, '⚠️ 更新的 0.3.1 出现 → 重新提示（跳过不是永久静默）')
}

console.log('── 7) 开关默认值 ──')
{
  const prev = process.env.TEAMFLOW_UPDATE
  delete process.env.TEAMFLOW_UPDATE
  expect(updateCheckEnabled(), true, '未设 → 默认开（产品路径不靠用户设开关）')
  process.env.TEAMFLOW_UPDATE = '0'
  expect(updateCheckEnabled(), false, '0 → 关')
  process.env.TEAMFLOW_UPDATE = 'off'
  expect(updateCheckEnabled(), false, 'off → 关')
  process.env.TEAMFLOW_UPDATE = '1'
  expect(updateCheckEnabled(), true, '1 → 开')
  if (prev === undefined) delete process.env.TEAMFLOW_UPDATE
  else process.env.TEAMFLOW_UPDATE = prev
}

console.log('── 8) upgradeGate：真一键的四道门禁（纯函数）──')
{
  const reg = { hasManager: true, activeRuns: 0, version: '0.3.0', sourceKind: 'registry' }
  const pass = upgradeGate(reg)
  expect(pass.ok, true, '服务在 + registry 装法 + 无活跃 run → 放行')
  expect(pass.spec, 'dsh-plugin-teamflow@0.3.0', 'spec 由包名 + 版本拼出')

  expect(upgradeGate({ ...reg, hasManager: false }).error, 'plugin-manager-unavailable',
    '⚠️ 精简 profile 没有插件管理服务 → 独立错误码（不能含糊成「升级失败」）')
  expect(upgradeGate({ ...reg, activeRuns: 2 }).error, 'run-in-progress',
    '⚠️ 有活跃 run → 拒绝（避免抢 profile 锁 / 在流水线跑到一半换掉磁盘上的插件）')
  expect(upgradeGate({ ...reg, activeRuns: 2 }).activeRuns, 2, '拒绝时带出活跃 run 数（UI 要说清原因）')
  expect(upgradeGate({ ...reg, version: '' }).error, 'missing-version', '没给版本 → 拒绝')
  expect(upgradeGate({ ...reg, version: 'garbage' }).error, 'missing-version', '版本号非法 → 拒绝（不让 pnpm 去试）')
  expect(upgradeGate({ ...reg, version: '0.3.0-rc.1' }).spec, 'dsh-plugin-teamflow@0.3.0-rc.1', '预发布版本也接受')

  // 新增维度：来源形态（10-12 真机踩到 —— 一键把本地 file: 装成了 registry 版）
  expect(upgradeGate({ ...reg, sourceKind: 'other' }).error, 'not-registry-install',
    '⚠️ `file:`/git/tarball 装法 → 拒绝一键（否则会把依赖静默换源）')
  expect(upgradeGate({ ...reg, sourceKind: 'unknown' }).error, 'not-registry-install',
    '⚠️ 认不出来源 → 同样拒绝（保守方向：只给命令，不给一键）')
  expect(upgradeGate({ hasManager: true, activeRuns: 0, version: '0.3.0' }).error, 'not-registry-install',
    '⚠️ 连 sourceKind 都没传 → 拒绝（绝不默认成「可以装」）')

  // 判序：永久性原因压过临时性原因
  expect(upgradeGate({ ...reg, version: 'bad' }).error, 'missing-version',
    '判序①②：先查版本合法性')
  expect(upgradeGate({ ...reg, sourceKind: 'other', activeRuns: 3 }).error, 'not-registry-install',
    '判序③④：永久性原因（非 registry）压过临时性原因（run 在跑）—— 否则用户会以为等一等就能点')
}

console.log('── 9) classifyInstallSource：来源形态归类 ──')
{
  for (const s of ['0.2.7', '^0.2.7', '~1.2', '>=1.0.0', 'v1.2.3', 'latest', '*', 'npm:dsh-plugin-teamflow@1.0.0']) {
    expect(classifyInstallSource(s), 'registry', `registry 形态：${s}`)
  }
  for (const s of [
    'file:E:/Code/x', 'link:../x', 'workspace:*', 'portal:./x',
    'git+https://github.com/a/b.git', 'github:a/b', 'gitlab:a/b',
    'https://example.com/x.tgz', 'git@github.com:a/b.git',
    'E:\\Code\\x', '/abs/path', './rel', '../up', '~/x',
  ]) {
    expect(classifyInstallSource(s), 'other', `非 registry 形态：${s}`)
  }
  for (const s of [undefined, null, '', '   ', 'not a spec']) {
    expect(classifyInstallSource(s), 'unknown', `认不出 → unknown（保守）：${JSON.stringify(s)}`)
  }
}

rmSync(tmp, { recursive: true, force: true })

console.log('── 10) installCommand：给用户复制的那一条，必须是「裸命令」 ──')
{
  // 契约：`command` 会原样进 `navigator.clipboard` ⇒ 用户粘到终端里就要能跑。
  // `installRecipe` 是给**模型读**的说明书（带反引号 + 括注），拿来当复制内容会连引号括号一起带走
  // （用户 2026-10-12 实测：「你把引号和括号内容也带上了？」）。
  const envCli = { dshHome: 'C:\\u\\.dsh', profile: 'web', profileDir: 'C:\\u\\.dsh\\profiles\\web', cliOnPath: true, ok: true }
  const c1 = installCommand(envCli, 'dsh-plugin-teamflow@0.2.7')
  expect(c1, 'dsh plugin --profile web add "dsh-plugin-teamflow@0.2.7"', 'CLI 可用 → 单条命令，profile 名来自探测')
  expect(/[`（）()]|在插件目录|ASK THE USER/.test(String(c1)), false,
    '🔴 裸命令里不得出现反引号 / 括号 / 说明文字（那正是说明书 `installRecipe` 的东西）')
  expect(c1.includes('"') && c1.split('"').length % 2 === 1, true,
    '仅规格值外的一对引号（shell 引用），成对 ⇒ 不是残缺的说明书片段')

  // dsh 不在 PATH ⇒ 没有「一条命令」形态；退到 profile 目录里手工装，但**必须自带 cd**
  // （命令会在任意 cwd 下被粘贴）。
  const envMan = { ...envCli, cliOnPath: false }
  const c2 = installCommand(envMan, 'dsh-plugin-teamflow@0.2.7')
  expect(c2, 'cd "C:\\u\\.dsh\\profiles\\web" && pnpm add "dsh-plugin-teamflow@0.2.7"', 'dsh 不在 PATH → `cd <绝对目录> && pnpm add`')
  expect(/[`（）()]|不在 PATH/.test(String(c2)), false, '同样不含反引号 / 括号 / 说明')

  // 探测失败 → 没有命令（宁可不给按钮，也不给一条错的命令）
  const envBad = { dshHome: '', profile: '', profileDir: '', cliOnPath: false, ok: false }
  expect(installCommand(envBad, 'x@1.0.0'), null, '探测失败 → null（不给命令）')

  // 命令本体单点定义：`installRecipe`（说明书）必须复用它，否则两边会各自漂移。
  const recipe = installRecipe(envCli, 'dsh-plugin-teamflow@0.2.7', 'dsh-plugin-teamflow')
  expect(recipe.includes(c1), true, '说明书里的命令正文 == 复制用的裸命令（同一来源，不漂移）')

  // 接线：`updateStatus` 返回的 `command` 必须来自 `installCommand`，且不得再引 `installRecipe`
  //（说明书进复制通道就是本条契约被破的那一步）。
  const idx = readFileSync(join(rootDir, 'host', 'index.ts'), 'utf8')
  expect(/command = installCommand\(env, /.test(idx), true, '`updateStatus` 用 `installCommand` 生成 command')
  expect(/from '\.\/util\.ts'/.test(idx) && !/import[^;\n]*\binstallRecipe\b/.test(idx), true,
    '🔴 `host/index.ts` 不再 import `installRecipe`（说明书不得混入复制通道）')

  // 按钮不得竖排：文案与 CSS 各锁一处（用户实测「已复制」被挤成一列三个字）。
  const ui = readFileSync(join(rootDir, 'client', 'update-ui.tsx'), 'utf8')
  expect(/export const NO_WRAP = \{ whiteSpace: 'nowrap' as const, flexShrink: 0 \}/.test(ui), true,
    '「不竖排」两条 CSS 有单一定义 `NO_WRAP`')
  expect(/\.\.\.NO_WRAP,/.test(ui), true, '`updBtnStyle` 应用 `NO_WRAP`（浮层/面板的按钮）')
  const loc = readFileSync(join(rootDir, 'client', 'locales.ts'), 'utf8')
  expect(/'update\.copy': '复制',/.test(loc), true, '复制按钮 zh 文案只有两个字')
  expect(/'update\.copy': 'Copy',/.test(loc), true, '复制按钮 en 文案同步收短')
  expect(/'update\.copy': '复制升级命令'|'update\.copy': 'Copy upgrade command'/.test(loc), false,
    '🔴 旧长文案不得复活（会把工具条挤成一段话）')
}

rmSync(tmp, { recursive: true, force: true })
console.log(failed === 0 ? '\n✅ update-check 测试全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
