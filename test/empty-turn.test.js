/**
 * dsh-plugin-teamflow — 空收尾文件兜底（A 档止损）行为级测试。
 *
 * 契约（2026-09-27，实测依据 tf-muigy5eq-dw5dv0 r12）：
 * - 推理模型空收尾（DeepSeek 实测：`finish kind=stop`，reasoning 之后、正文之前被服务端收尾，
 *   非宿主动手——宿主中断走 `aborted`、预算截断走 `max-tokens`）此前一律整轮重跑，一次 ≈ 150 万 token。
 * - A 档：`stop==='completed'` + 空正文 + 任务夹产物已落盘**达下限** → 判交付（runner 直接收口不重试），
 *   返回值用文件内容顶替空回复（timeline 存产物全文；state 块不在文件里则 mergeStageState 宽容跳过）。
 * - **边界（r12 实锤，勿回退）**：空收尾死在写文件之前（那次全程只写了验证脚本、QA-REPORT.md 未动）
 *   → 产物不存在 → 兜底不命中 → 照旧重跑。「干到一半死掉」须 continuable 续跑（docs/TODO.md B 档）。
 * - 判定核心在 util.emptyTurnDocVerdict 纯函数——runner 链宿主私有 peer（@deepseek-ai/dsh-llm，
 *   仓库内未安装）不可 import，可测逻辑下沉 util 是既定纪律（见 cancel.test.js 头注释）。
 *
 * 本文件自带 $DSH_HOME 风格临时目录（stageDocText 走真实文件系统，绝不碰真实 home）。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyTurnDocVerdict, stageDocText, DOC_STAGE_FILES } from '../host/util.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg}`); failed++ }
}
const eq = (actual, expected, msg) => {
  if (actual === expected) console.log(`  ✓ ${msg}`)
  else { console.error(`  ✗ ${msg} — got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`); failed++ }
}

const home = mkdtempSync(join(tmpdir(), 'tf-emptyturn-'))

console.log('── 1) 真值表：emptyTurnDocVerdict ──')
const DOC = { name: 'QA-REPORT.md', text: 'x'.repeat(600), length: 600 }

eq(emptyTurnDocVerdict('completed', '', 500, DOC), DOC, 'completed + 空正文 + 达下限 → 判交付（返回产物）')
eq(emptyTurnDocVerdict('completed', '', 700, DOC), null, '产物不达下限（600 < 700）→ null（照旧走失败/重试）')
eq(emptyTurnDocVerdict('completed', '有正文', 500, DOC), null, '正文非空 → null（走常规 judgeDeliverable 路径，不越权）')
eq(emptyTurnDocVerdict('max-tokens', '', 500, DOC), null, 'stop=max-tokens（预算截断）→ null（不兜底，该重试重试）')
eq(emptyTurnDocVerdict('aborted', '', 500, DOC), null, 'stop=aborted（宿主/外部中断）→ null')
eq(emptyTurnDocVerdict('error', '', 500, DOC), null, 'stop=error（provider 报错）→ null')
eq(emptyTurnDocVerdict('completed', '', 500, null), null, '产物不存在（r12 实锤形态：死在写文件之前）→ null')
eq(emptyTurnDocVerdict('completed', '', 500, undefined), null, '产物 undefined → null')
eq(emptyTurnDocVerdict(undefined, '', 500, DOC), null, 'stop 缺失 → null')
eq(emptyTurnDocVerdict('completed', '', 0, { name: 'n', text: '', length: 0 }), null, '产物 0 字符（空文件）→ null（0 >= 0 也不算交付）')

console.log('── 2) 端到端：stageDocText（真实文件系统）→ 兜底判定 ──')
const ws = join(home, 'ws-emptyturn')
const runDocs = 'docs/teamflow/20260927-emptyturn'
const docDir = join(ws, runDocs)
mkdirSync(docDir, { recursive: true })
eq(stageDocText({ workspacePath: ws, runDocs }, 'qa'), null, 'QA-REPORT.md 未落盘 → null（r12 边界形态）')
writeFileSync(join(docDir, 'QA-REPORT.md'), '# QA 报告\n' + '内容'.repeat(400))
const doc = stageDocText({ workspacePath: ws, runDocs }, 'qa')
ok(!!doc && doc.name === 'QA-REPORT.md' && doc.length > 500, '产物落盘后 stageDocText 读到（name+length）')
eq(emptyTurnDocVerdict('completed', '', 500, doc), doc, '落盘产物 → 兜底命中（端到端）')
eq((doc && doc.text.indexOf('# QA 报告') === 0), true, '返回值带文件全文（runner 用它顶替空回复喂 timeline）')

console.log('── 3) 覆盖面：DOC_STAGE_FILES 覆盖全部 doc 类阶段 ──')
for (const phase of ['prd', 'design', 'tech', 'qa', 'acceptance']) {
  ok(Array.isArray(DOC_STAGE_FILES[phase]) && DOC_STAGE_FILES[phase].length > 0, `phase=${phase} 有产物候选（A 档覆盖面）`)
}

rmSync(home, { recursive: true, force: true })
ok(!existsSync(home), '临时目录已清理')

console.log(failed === 0 ? '✅ empty-turn 全部通过' : `❌ empty-turn 失败 ${failed} 项`)
if (failed > 0) process.exit(1)
