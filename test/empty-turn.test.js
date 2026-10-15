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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { emptyTurnDocVerdict, stageDocText, DOC_STAGE_FILES, artifactFingerprint, artifactIsStale, freshArtifactText, captureArtifactBaseline, isToolArgFailure } from '../host/util.ts'

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

/* ── 4) 产物新鲜度：只认「本阶段写过的」产物（2026-10-16 实锤 run tf-mv9o5fkk-orjou4） ──
   场景：架构阶段（prompt 明写禁止）越界写了 QA-REPORT.md / ACCEPTANCE.md。下游「文件即产物」
   只查「在不在、够不够长」⇒ QA 自己没写时会拿上游那份当结论（假交付）。判据 = 阶段开始时的指纹基线。 */
console.log('── 4) 产物新鲜度：指纹基线（上游越界写的旧产物不算本阶段产物）──')
{
  const j = { workspacePath: ws, runDocs }
  const qaPath = join(docDir, 'QA-REPORT.md') // 第 2) 节已落盘 = 模拟「上游先写了」
  const stage = {}
  captureArtifactBaseline(j, 'qa', stage)
  ok(!!stage.artifactBaseline && typeof stage.artifactBaseline['QA-REPORT.md'] === 'string',
    '基线记下候选产物指纹（absent 时也能记字符串）')
  ok(artifactFingerprint(j, 'NO-SUCH.md') === null, '文件不存在 → 指纹 null（不抛）')
  eq(freshArtifactText(j, 'QA-REPORT.md', stage.artifactBaseline), null, '指纹未变 ⇒ 当缺失（上游写的不算本阶段产物）')
  eq(stageDocText(j, 'qa', stage.artifactBaseline), null, 'stageDocText 同样跳过陈旧候选（A 档兜底不再拿旧文件）')

  // 本阶段真的写了（同内容同大小、仅 mtime 前进 —— 显式推 mtime 既证语义也规避同毫秒写入的测试抖动）
  const now = Date.now() / 1000
  utimesSync(qaPath, now + 5, now + 5)
  eq(artifactIsStale(j, 'QA-REPORT.md', stage.artifactBaseline), false, '指纹变了（同大小、仅 mtime）⇒ 认作本阶段产物')
  ok(!!freshArtifactText(j, 'QA-REPORT.md', stage.artifactBaseline), 'freshArtifactText 读到本阶段版本')
  ok(!!stageDocText(j, 'qa', stage.artifactBaseline), 'stageDocText 重新认得它')

  // 只填缺失项：重试/续跑沿用**首次**基线（语义 = 「本阶段写过」而非「本次尝试写过」）
  const t2 = {}
  captureArtifactBaseline(j, 'qa', t2)
  const first = t2.artifactBaseline['QA-REPORT.md']
  utimesSync(qaPath, now + 9, now + 9)
  captureArtifactBaseline(j, 'qa', t2)
  eq(t2.artifactBaseline['QA-REPORT.md'], first, '第二次 capture 不覆盖（重试沿用首次基线）')

  // 不可判的两种输入一律 fail-open（不判新鲜度）：存量调用与「续跑复用旧产物」路径刻意不传基线
  eq(artifactIsStale(j, 'QA-REPORT.md', undefined), false, '无基线 ⇒ 不判（续跑复用旧产物路径）')
  ok(!!freshArtifactText(j, 'QA-REPORT.md', { 'PRD.md': 'x' }), '基线缺该键 ⇒ 不判（返回文件，不误杀）')

  // 阶段开始时不存在（基线 null）→ 本阶段从无到有 = 新鲜；一直不存在 = 指纹相同（都 null）= 不可信
  const acc = {}
  captureArtifactBaseline(j, 'acceptance', acc)
  eq(acc.artifactBaseline['ACCEPTANCE.md'], null, '阶段开始时 ACCEPTANCE.md 不存在 ⇒ 基线 null')
  eq(artifactIsStale(j, 'ACCEPTANCE.md', acc.artifactBaseline), true, '仍不存在 ⇒ 指纹相同（都 null）⇒ 判不可信')
  writeFileSync(join(docDir, 'ACCEPTANCE.md'), '验收结论：accepted\n' + '正文'.repeat(300))
  ok(!!freshArtifactText(j, 'ACCEPTANCE.md', acc.artifactBaseline), '从无到有 ⇒ 认作本阶段产物')
}

/* ── 5) 环境不可用指纹的第三类豁免：参数类失败（模型自己传错参数）──
   实锤 tf-mv9o5fkk-orjou4：`edit` 连传 3 次相同 old/new → 被判 env-unavailable 硬停；人工 resume 后
   同一阶段一次就过 ⇒ 工作区自始正常。判据必须能区分「参数错」与「环境坏」。 */
console.log('── 5) isToolArgFailure：参数类失败不计入环境指纹 ──')
for (const t of [
  'old_string and new_string must differ', // 宿主 packages/fs/tool-fs/src/edit.ts:50（本次实锤原文）
  'old_string must be a non-empty string',
  'file_path must be a non-empty string',
  'tool-fs: limit must be a positive integer',
  'offset must be a positive integer',
]) ok(isToolArgFailure(t), `识别参数类：${t}`)
for (const t of [
  'ENOENT: no such file or directory, open ...',
  'EACCES: permission denied',
  'spawn pnpm ENOENT',
  'command not found: mvn',
  'fs: cannot write outside the workspace root',
  'The operation timed out after 60000ms',
]) ok(!isToolArgFailure(t), `不吞环境类：${t}`)

rmSync(home, { recursive: true, force: true })
ok(!existsSync(home), '临时目录已清理')

console.log(failed === 0 ? '✅ empty-turn 全部通过' : `❌ empty-turn 失败 ${failed} 项`)
if (failed > 0) process.exit(1)
