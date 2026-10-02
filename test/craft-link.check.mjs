/**
 * craft 链路端到端自检（零成本，不跑 run）
 *
 * 验的不是「条款有没有写进 prompt 文件」，而是 Mechanical flow 是否真的把意图送到了执行者手里：
 *   designPrompt(2b) → DESIGN.md → devPrompt(4b) → qaPrompt(0d)
 *
 * 特别关注一个还没验过的失效点：**2b 让 DESIGN.md 变长之后，dev 端的 clip 会不会正好把视觉规格剪掉**
 * （devPrompt 只注入 clip(design, 4000)，而 2b 要求的那一节写在文档中部）。
 * 若真如此，Phase 0 打的通道等于白打 —— 这比「条款有没有用」更根本。
 */
import { designPrompt, devPrompt, qaPrompt } from '../host/prompts/index.ts'
import { envFlagOn } from '../host/util.ts'

const RUN_ID = 'tf-check-run'
const ROOT = 'products/pomodoro'

const baseState = {
  version: 1, projectName: 'pomodoro', updatedAt: null,
  product: { summary: '番茄钟', techStack: 'vanilla-js' },
  modules: { '/timer.js': '倒计时核心' }, verifyScripts: ['node test/verify.js'],
  acIndex: { 'AC-1': '四种状态切换' }, stages: { prd: '摘要' }, lastRun: null,
  __runCtx: { runDocs: 'docs/teamflow/20260930-r10-pomodoro', blueprint: '' },
}
const offState = { ...baseState, __runCtx: { ...baseState.__runCtx, craft: false } }

const PRD = `# PRD · 番茄钟
AC-1：专注/短休/长休三种时长可配，开始/暂停/重置可用
AC-2：圆环进度条随剩余时间连续变化
AC-3：剩余时间、当前轮次、累计专注数全程可见（含空闲态）
AC-4：结束时播放完成动画
`

// 模拟 design 子代理在 2b 要求下的真实产出形态：先结构/布局，视觉规格在中部，最后是反模式清单
const DESIGN_HEAD = `# DESIGN · 番茄钟

## 1. 信息架构
单页，三区：顶部模式切换（专注 / 短休 / 长休），中部圆环计时器，底部当日统计。

## 2. 页面线框
- 顶部：三个模式按钮，横向排列，居中，间距 12px。
- 中部：直径 320px 的圆环容器，圆心为 MM:SS 数字，下方一行「第 N 轮 · 今日专注 M 次」。
- 底部：统计卡片，展示今日专注次数与总时长。

## 3. 交互与动效
- 模式切换：点击后圆环重新开始，切换过程 200ms。
- 开始/暂停：圆环中心一个主按钮，图标随之切换。
`
const DESIGN_VISUAL = `## 4. Visual quality spec
### Surface treatment
- 圆环轨道：宽 14px，圆角端点 round cap；未完成段 rgba(255,255,255,0.08)，进度段使用渐变 #ff7a59 → #ff3d71，外发光 blur 12px / alpha 0.45。
- 按钮：圆角 radius 999px，1px 描边 rgba(255,255,255,0.14)，默认态无填充，hover 态填充 rgba(255,255,255,0.06) + 描边提亮到 0.28，pressed 态 scale(0.97)，disabled 态 opacity 0.4 + 禁用 hover。
- 统计卡片：radius 16px，底色 rgba(255,255,255,0.04)，1px 描边 0.08，无阴影（避免夜间糊成一团）。
### State feedback
- hover / focus / pressed / disabled 四态都必须可见；focus 用 2px 外描边而非系统默认蓝框。
- 计时进行中：圆心主按钮呼吸高于 0）；暂停态：圆环停止但保持可见，不做任何隐藏。
### Motion
- 进度环推进：跟随系统帧率，不做 CSS transition（避免跳秒抖动）。
- 完成动画：圆环整体放大 1.06 → 1.0，320ms ease-out，同时圆环颜色转绿 #34d399。
### Typography
- MM:SS 使用等宽数字（font-variant-numeric: tabular-nums）避免跳秒抖动；字号 clamp(48px, 12vw, 96px)，字重 600。
### Anti-patterns for this product
- 禁止纯色无描边矩形块；禁止无 hover 反馈的按钮；**禁止空闲态隐藏统计信息**。
`
const DESIGN_TAIL = `## 5. 无障碍
- 圆环提供 aria-label 播报剩余时间；时间步进使用 aria-live="off" 避免刷屏。
- 所有交互元素可达键盘 Tab，焦点顺序自上而下。

## 6. 反模式清单
- 不用纯黑背景（对比过强导致疲劳），用 #0f1116。
- 不引入第三方 UI 框架。
`
const DESIGN = DESIGN_HEAD + DESIGN_VISUAL + DESIGN_TAIL

const TASK = { title: 'T1 计时器界面', files: ['/timer-view.js'], spec: '圆环 + 模式切换 + 统计区' }

const HAS = {
  '2b': (t) => /Visual quality spec/.test(t),
  '2c': (t) => /Geometrically self-consistent/.test(t),
  '4b': (t) => /Craft bar/.test(t),
  '4c': (t) => /Fit the text before you fit the numbers/.test(t),
  '0d': (t) => /Craft grade/.test(t),
}
const CRAFT_CLAUSES = [
  ['2b', 'design 视觉规格（2b）', 'Visual quality spec'],
  ['2c', 'design 几何自洽条款（2b 子项）', 'Geometrically self-consistent'],
  ['4b', 'dev craft bar（4b）', 'Craft bar'],
  ['4c', 'dev 装得下文字条款（4b 子项）', 'Fit the text before you fit the numbers'],
  ['0d', 'QA craft 评级（0d）', 'Craft grade'],
]

const rendered = {
  design: designPrompt(PRD, ROOT, RUN_ID, baseState),
  designOff: designPrompt(PRD, ROOT, RUN_ID, offState),
  dev: devPrompt(TASK, PRD, PRD, DESIGN, ROOT, RUN_ID, baseState),
  devOff: devPrompt(TASK, PRD, PRD, DESIGN, ROOT, RUN_ID, offState),
  qa: qaPrompt(PRD, '实现完成', ROOT, RUN_ID, baseState, true),
  qaOff: qaPrompt(PRD, '实现完成', ROOT, RUN_ID, offState, true),
}

let fail = 0
const ck = (ok, label, detail = '') => {
  if (!ok) fail++
  console.log(`${ok ? '✅' : '❌'} ${label}${detail ? ' —— ' + detail : ''}`)
}

console.log('── 1. craft 开关：条款的出场与退场 ──')
console.log('    （只查标题是不够的：2026-10-01 新加的 2c/4c 两条自洽子项必须单独断言，否则「全绿」是假安全感）')
const ON = [
  ['2b', HAS['2b'](rendered.design)],
  ['2c', HAS['2c'](rendered.design)],
  ['4b', HAS['4b'](rendered.dev)],
  ['4c', HAS['4c'](rendered.dev)],
  ['0d', HAS['0d'](rendered.qa)],
]
for (const [k, ok] of ON) ck(ok, `默认（未传 craft）条款 ${k} 在`, '出厂行为不受影响')
const OFF = [
  ['2b', HAS['2b'](rendered.designOff)],
  ['2c', HAS['2c'](rendered.designOff)],
  ['4b', HAS['4b'](rendered.devOff)],
  ['4c', HAS['4c'](rendered.devOff)],
  ['0d', HAS['0d'](rendered.qaOff)],
]
for (const [k, ok] of OFF) ck(!ok, `craft:false 时条款 ${k} 消失`, 'A/B 的「关」组成立')
ck(CRAFT_CLAUSES.length === 5, '条款清单已登记（改条款时记得同步这张表）', `${CRAFT_CLAUSES.length} 条`)
ck(rendered.design.length - rendered.designOff.length > 0,
  '关掉后 design prompt 确实变短', `${rendered.design.length} → ${rendered.designOff.length} 字符`)

console.log('\n── 2. 链路：design 的产物能不能到 dev 手里 ──')
ck(rendered.dev.includes('DESIGN.md'), 'dev prompt 指向 DESIGN.md 磁盘路径')
const headVisible = rendered.dev.includes(DESIGN_HEAD.slice(0, 60))
ck(headVisible, 'design 头部确实出现在 dev prompt 渲染体里')

// ★ 关键失效点：视觉规格落在 clip 窗口内吗
const clipStart = rendered.dev.indexOf('[DESIGN NOTES')
const clipEnd = rendered.dev.indexOf('[PRD] Relevant acceptance criteria')
const clipBody = clipStart >= 0 && clipEnd > clipStart ? rendered.dev.slice(clipStart, clipEnd) : ''
const visualVisible = clipBody.includes('Visual quality spec')
const gaugeVisible = clipBody.includes('圆环轨道')
console.log(`   [短文档] design ${DESIGN.length} 字符；视觉规格在第 ${DESIGN.indexOf('Visual quality spec')} 字符处`)
console.log(`   [短文档] dev 实际拿到 ${clipBody.length} 字符`)
ck(visualVisible, '★ 短文档下视觉规格没被剪掉', visualVisible ? '基线成立' : '连短文档都过不了')
ck(gaugeVisible, '★ 短文档下规格数值到了 dev 手里')

// ★★ 真实体量扫描：2b 会 DESIGN.md 推到万字符级（同项目 TECHNICAL.md 实测 48365 字符）。
//    视觉规格在文档里的位置由**章节顺序**决定 —— 下面按不同体量扫描，看它在哪种体量下掉出窗口。
function makeDesign(n) {
  return DESIGN_HEAD
    + '## 4. 组件清单与尺寸令牌\n'
    + Array.from({ length: n }, (_, i) =>
      `- C${i + 1} 组件：容器宽 ${280 + i * 12}px，内边距 ${12 + i}px，栅格列 ${i % 4 + 1}，垂直间距 ${8 + i * 2}px，`
      + '说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位。\n').join('')
    + DESIGN_VISUAL
    + Array.from({ length: Math.round(n * 0.7) }, (_, i) =>
      `- D${i + 1} 响应式断点：宽度 ${360 + i * 60}px 时，标题字号 ${14 + i}px，容器最大宽度 ${320 + i * 40}px，`
      + '说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位。\n').join('')
    + DESIGN_TAIL
}
// 契约修复后的写法：VISUAL SPEC 写在文档**最前**（2b placement rule 要求的形态）
function makeDesignHeadFirst(n) {
  return DESIGN_VISUAL
    + Array.from({ length: n }, (_, i) =>
      `- C${i + 1} 组件：容器宽 ${280 + i * 12}px，内边距 ${12 + i}px，栅格列 ${i % 4 + 1}，垂直间距 ${8 + i * 2}px，`
      + '说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位说明文字占位。\n').join('')
    + DESIGN_HEAD
    + DESIGN_TAIL
}
console.log('\n   ── 体量扫描（视觉规格写在文档中部，即设计文档的常见写法）──')
console.log('   design 长度 | 规格位置 | dev 可见 | 数值可见')
const rows = []
for (const n of [4, 16, 32, 56, 80, 110]) {
  const xp = makeDesign(n)
  const pos = xp.indexOf('Visual quality spec')
  const dv = devPrompt(TASK, PRD, PRD, xp, ROOT, RUN_ID, baseState)
  const a = dv.indexOf('[DESIGN NOTES')
  const b = dv.indexOf('[PRD] Relevant acceptance criteria')
  const clip = a >= 0 && b > a ? dv.slice(a, b) : ''
  const specIn = clip.includes('Visual quality spec')
  const valIn = clip.includes('圆环轨道')
  rows.push({ len: xp.length, pos, specIn, valIn })
  console.log(`   ${String(xp.length).padStart(11)} | ${String(pos).padStart(8)} | ${specIn ? '是' : ' **否** '}     | ${valIn ? '是' : '**否**'}`)
}
const broken = rows.filter((r) => !r.specIn)
console.log(`   ⇒ 中部写法：${broken.length}/${rows.length} 档丢失${broken.length ? `，首档丢失出现在 design ≈ ${broken[0].len} 字符` : ''}`)

// 契约要求的写法（规格在最前）必须全量级稳健 —— 这才是被门禁锁住的不变量
console.log('\n   ── 体量扫描（视觉规格写在最前 —— 2b placement rule 要求）──')
console.log('   design 长度 | dev 可见 | 数值可见')
const fixedRows = []
for (const n of [4, 32, 80, 160, 260]) {
  const xp = makeDesignHeadFirst(n)
  const dv = devPrompt(TASK, PRD, PRD, xp, ROOT, RUN_ID, baseState)
  const a = dv.indexOf('[DESIGN NOTES')
  const b = dv.indexOf('[PRD] Relevant acceptance criteria')
  const clip = a >= 0 && b > a ? dv.slice(a, b) : ''
  const specIn = clip.includes('Visual quality spec')
  const valIn = clip.includes('圆环轨道')
  fixedRows.push({ len: xp.length, specIn, valIn })
  console.log(`   ${String(xp.length).padStart(11)} | ${specIn ? '是' : ' **否** '}     | ${valIn ? '是' : '**否**'}`)
}
const fixedBroken = fixedRows.filter((r) => !r.specIn || !r.valIn)
ck(fixedBroken.length === 0, '★★ 规格写在最前时，全量级都到得了 dev',
  fixedBroken.length ? `**仍有 ${fixedBroken.length} 档丢失**` : `最大体量 ${fixedRows[fixedRows.length - 1].len} 字符仍可见`)

console.log('\n── 3. token 差（开 vs 关）──')
const t = (n) => Math.round(n / 3.6)
for (const k of ['design', 'dev', 'qa']) {
  const on = rendered[k].length
  const off = rendered[k + 'Off'].length
  console.log(`   ${k.padEnd(7)} 开 ${String(t(on)).padStart(5)} tok / 关 ${String(t(off)).padStart(5)} tok  差 ${((on - off) / on * 100).toFixed(1)}%`)
}

console.log('\n── 4. 环境变量开关（本次 A/B 的唯一变量入口）──')
const envCases = [
  [undefined, true, '未设置 = 开（出厂行为）'],
  ['', true, '空串 = 开'],
  ['1', true, '显式开'],
  ['true', true, '显式开'],
  ['0', false, '0 = 关'],
  ['false', false, 'false = 关'],
  ['OFF', false, '大小写不敏感'],
  [' no ', false, '容忍前后空格'],
]
let envFail = 0
for (const [raw, want, label] of envCases) {
  if (raw === undefined) delete process.env.TEAMFLOW_CRAFT
  else process.env.TEAMFLOW_CRAFT = raw
  const got = envFlagOn('TEAMFLOW_CRAFT')
  if (got !== want) envFail++
  console.log(`   ${got === want ? '✅' : '❌'} ${label}  (TEAMFLOW_CRAFT=${raw === undefined ? '<unset>' : JSON.stringify(raw)} → ${got})`)
}
delete process.env.TEAMFLOW_CRAFT
fail += envFail

console.log(fail === 0 ? '\ncraft-link-check: 全部通过' : `\ncraft-link-check: ${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
