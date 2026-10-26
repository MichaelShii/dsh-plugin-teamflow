/**
 * dsh-plugin-teamflow — 越界发现（`[OUT-OF-SCOPE]`）解析与接线测试。
 *
 * 事故背景（2026-10-27 tf-mvpjqs87-14qdxa）：dev 任务按契约**不许改别人的文件**（并发写会静默
 * 丢失），于是 T1 发现 T2 文件里 3 个失败用例并定位到行后，只能写进自由文本 summary —— 没人接手，
 * 最后由「交付自检」重新跑全量测试才发现（多一次全量构建，且依赖它恰好覆盖到）。
 * 判定：**发现了，就必须有通道把它变成工作项**，否则"遵守边界"反而成了缺陷下游化的原因。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseOutOfScope } from '../host/util.ts'

const here = dirname(fileURLToPath(import.meta.url))
let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { failed++; console.log(`  ✗ ${msg}`) }
}

console.log('── 1) 标准块 ──')
const std = `实现完成，改了 2 个文件。
[OUT-OF-SCOPE]
- src/test/java/A.java:119 — golden 期望身强但依据行写 +14（偏强） — 订正期望值
- src/main/java/B.java — findNeutralChart 固定按时辰 12 复算
[/OUT-OF-SCOPE]
[Verification evidence] mvn ...`
const a = parseOutOfScope(std)
ok(a.length === 2, `解析出 2 条（实际 ${a.length}）`)
ok(a[0].file === 'src/test/java/A.java' && a[0].line === 119, `路径与行号正确（${a[0].file}:${a[0].line}）`)
ok(/golden 期望身强/.test(a[0].note), '说明文本保留')
ok(a[1].line === null && /findNeutralChart/.test(a[1].note), '行号可省 ⇒ null，说明仍在')

console.log('── 2) 没有块 ≠ 有块为空 ──')
ok(parseOutOfScope('普通回复，没有任何块').length === 0, '无块 ⇒ 空数组（不做"从自由文本猜"）')
ok(parseOutOfScope('[OUT-OF-SCOPE]\n[/OUT-OF-SCOPE]').length === 0, '空块 ⇒ 空数组')
ok(parseOutOfScope('').length === 0 && parseOutOfScope(null).length === 0, '空输入/null 不抛')

console.log('── 3) 宽容但不猜 ──')
const loose = parseOutOfScope('[OUT-OF-SCOPE]\n- a/b.ts:7 - 用连字符当分隔\n* c/d.ts – 用 en dash\nplain/e.ts\n[/OUT-OF-SCOPE]')
ok(loose.length === 3, `三种写法都收（实际 ${loose.length}）`)
ok(loose[0].line === 7 && /连字符/.test(loose[0].note), '连字符分隔 + 行号')
ok(/en dash/.test(loose[1].note), 'en dash 分隔')
ok(loose[2].file === 'plain/e.ts' && loose[2].note === '', '纯路径行（无说明）也收')

console.log('── 4) 边界 ──')
ok(parseOutOfScope('[OUT-OF-SCOPE]\n- x.ts\n[/OUT-OF-SCOPE]', 0).length === 0, 'limit=0 ⇒ 0 条（上限生效）')
const many = '[OUT-OF-SCOPE]\n' + Array.from({ length: 30 }, (_, i) => `- f${i}.ts`).join('\n') + '\n[/OUT-OF-SCOPE]'
ok(parseOutOfScope(many).length === 20, '默认上限 20 条（防一条回复塞爆收口任务）')
ok(parseOutOfScope('[OUT-OF-SCOPE]\n- y.ts — 缺闭标记也能解析').length === 1, '缺闭标记（回复被截断）⇒ 解析到末尾')
ok(!parseOutOfScope('[OUT-OF-SCOPE]\n- z.ts\n[/OUT-OF-SCOPE]').some((f) => /OUT-OF-SCOPE/.test(f.file)), '块标记不进结果')

console.log('── 5) 接线（契约三处必须同时在）──')
const devSrc = readFileSync(join(here, '..', 'host', 'core', 'stages', 'dev.ts'), 'utf8')
const promptSrc = readFileSync(join(here, '..', 'host', 'prompts', 'index.ts'), 'utf8')
// ⚠️ 断言的是**指令句**而不是块标记本身：标记在示例块里也会出现，
// 只查标记的话「把要求删掉、留下示例」这种改动照样绿（本轮变真实测踩到过）。
ok(promptSrc.includes('declare it in the [OUT-OF-SCOPE] block'), 'devPrompt 要求模型用该块声明越界发现（否则没人写）')
ok(devSrc.includes('parseOutOfScope'), 'dev 阶段真的解析它（否则写了白写）')
ok(devSrc.includes('dt-out-of-scope'), '解析后生成收口任务（独占文件的那一条）')
ok(devSrc.includes('alreadyRan'), '只加一轮（按 stage label 判重，resume 不重复追加，防无限增长）')

console.log(failed === 0 ? '\n全部通过' : `\n❌ ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
