/**
 * dsh-plugin-teamflow — 「技术方案钉死的常量」守卫测试。
 *
 * 事故（2026-10-27 tf-mvpjqs87-14qdxa）：PRD §3.1 表格写「日主 +10、总权 22」，TECHNICAL §47 写
 * `DAY_MASTER_SELF = 10`；QA 缺陷修复轮把它改成 **4 / 16**，并把「断言该常量」的测试一起改成断言 4，
 * 然后自辩「仍在 PRD §3.1 日主固定值档内」。五档因此"全可达"了 —— 但那是**换了刻度**，不是修好。
 * 判据：**文档里钉死的数值常量，代码改了就必须停**。这条完全可机器判定，不需要模型自觉。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parsePinnedConstants, diffPinnedConstants } from '../host/util.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

console.log('── 1) 从技术方案文本里抽常量 ──')
const tech = [
  '    public static final int WEIGHT_MONTH = 3;',
  '    public static final int WEIGHT_STEM = 1;',
  '    public static final int DAY_MASTER_SELF = 10;',
  '    public static final int TOTAL_WEIGHT = 22;  // 3+2+2+2+1+1+1+10',
  '| `LEVEL_STRONG` = 20 | 身强阈值 |',
].join('\n')
const pinned = parsePinnedConstants(tech)
const byName = Object.fromEntries(pinned.map((c) => [c.name, c.value]))
ok(pinned.length === 5, `抽出 5 个常量（实际 ${pinned.length}）`)
ok(byName.DAY_MASTER_SELF === '10' && byName.TOTAL_WEIGHT === '22', 'Java 声明形式：取到数值')
ok(byName.LEVEL_STRONG === '20', '表格/裸赋值形式也认（`NAME = 20`）')
ok(!('3' in byName), '小写/纯数字不会被当成常量名')
ok(new Set(pinned.map((c) => c.name)).size === pinned.length, '同名只记第一次出现（文档里重复说明不算新常量）')

console.log('── 2) 比对：只报「两边都有且值不同」 ──')
const actualSame = [{ name: 'DAY_MASTER_SELF', value: '10' }, { name: 'TOTAL_WEIGHT', value: '22' }]
ok(diffPinnedConstants(pinned, actualSame).length === 0, '值一致 ⇒ 零漂移')

// 真实事故形状：10/22 → 4/16
const actualDrift = [
  { name: 'DAY_MASTER_SELF', value: '4' },
  { name: 'TOTAL_WEIGHT', value: '16' },
  { name: 'NEW_CONST_NOT_IN_DOC', value: '1' },
]
const drift = diffPinnedConstants(pinned, actualDrift)
ok(drift.length === 2, `检出 2 处漂移（实际 ${drift.length}）：日主与总权`)
ok(drift.some((d) => d.name === 'DAY_MASTER_SELF' && d.expected === '10' && d.actual === '4'), '带上「应为 / 实为」，人一眼能判')
ok(!drift.some((d) => d.name === 'NEW_CONST_NOT_IN_DOC'), '文档里没有的新常量不算改口径')
ok(diffPinnedConstants(pinned, []).length === 0, '代码里没出现这些名字 ⇒ 不算（可能是别的语言/别的模块）')

console.log('── 3) 接线（守卫必须真的在 dev 收口被调用）──')
const devSrc = readFileSync(join(here, '..', 'host', 'core', 'stages', 'dev.ts'), 'utf8')
ok(devSrc.includes('parsePinnedConstants(tech)'), '用**本轮技术方案**当基准（不是全仓猜）')
ok(devSrc.includes('diffPinnedConstants'), '调用了比对函数')
ok(devSrc.includes("t(locale, 'err.pinnedConst'"), '漂移时真的停（抛错走 needs-human，不是只 warn）')
ok(devSrc.includes('devTouchEntries'), '只扫本轮 touched 的文件（不扫全仓）')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
