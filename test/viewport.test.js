/**
 * dsh-plugin-teamflow — 画布视图数学与视图模式（client/viewport.ts）单测。
 *
 * 为什么必须有（issue #10）：客户端**没有 DOM 测试基建**（无 jsdom/happy-dom），触摸手势在 CI 里
 * 根本验不了。所以把可判定的部分抽成纯函数，在这里锁死；剩下的 DOM 接线只能真机手测 ——
 * 本文件的作用就是把"未知"限制在那部分。
 *
 * 最要紧的一条断言：**fit 不再把缩放抬到 0.5**。旧实现四处 `Math.max(0.5, raw)`，
 * 大流程图在任何设备上都看不全 —— 这是用户报告里"zoom limit"那一半的真正根因。
 */
import {
  MAX_SCALE, MIN_SCALE, LIST_BREAKPOINT,
  clampScale, fitScale, zoomTo, zoomBy, pinchView, pointerDist, pickViewMode,
} from '../client/viewport.ts'

let failed = 0
const ok = (cond, msg) => {
  if (cond) { console.log(`  ✓ ${msg}`) }
  else { failed++; console.log(`  ✗ ${msg}`) }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps

console.log('\n── clampScale：区间 [MIN, MAX] ──')
ok(clampScale(0.001) === MIN_SCALE, `低于下限 → 抬到 ${MIN_SCALE}（结构可辨门槛，理由见 viewport.ts）`)
ok(clampScale(5) === MAX_SCALE, `高于上限 → 压到 ${MAX_SCALE}（沿用既有上限，零回归）`)
ok(clampScale(1) === 1, '区间内原样')
ok(clampScale(NaN) === 1, 'NaN → 1（不得让退化值污染视图）')

console.log('\n── fitScale：装得下内容，但不低于「结构可辨」下限 ──')
// 关键回归（2026-09-29 复核后**翻转**）：我曾把下限降到 0.08 想让大图"一次看全"，算过账后推翻 ——
// 0.12 时卡片只剩 37×7px、字号 1.5px、间距 0.9px，**糊成一团连几张都数不清**，图形就此失去唯一
// 的独有价值（结构）。所以「大图被夹到 0.5、需要拖动或改用列表」是**有意的**，不是遗留缺陷。
const phone = fitScale(2000, 400, 380, 600)
ok(phone === MIN_SCALE, `手机大图被夹到下限 ${MIN_SCALE}（实测 ${phone.toFixed(3)}）—— 保住结构可辨`)
ok(phone * 54 >= 27, `下限处卡片高仍 ≥27px（实测 ${(phone * 54).toFixed(1)}px）：数得清几张卡`)
ok(phone * 7 >= 3.5, `下限处卡间距仍 ≥3.5px（实测 ${(phone * 7).toFixed(2)}px）：卡片不粘连`)
// 正常尺寸零回归：旧算法 min((H-46)/worldH, (W-40)/worldW, 1) 后 max(0.5, ·) = 1
ok(fitScale(200, 100, 900, 600) === 1, '正常尺寸 → 1（与旧行为一致，零回归）')
ok(fitScale(900, 600, 900, 600) === (600 - 46) / 600, '高度成为约束时取高度项')
ok(fitScale(100000, 400, 380, 600) === MIN_SCALE, `超大步图落到下限 ${MIN_SCALE}（不无限缩小）`)
ok(fitScale(0, 100, 900, 600) === 1 && fitScale(100, 100, 0, 600) === 1, '退化输入（0）→ 1，不产生 NaN/Infinity')

console.log('\n── zoomTo / zoomBy：锚点不变量 ──')
// 不变量：容器内锚点 px 处的「世界坐标」在缩放前后必须不动（否则缩放会漂）
const anchorStable = (v0, v1, px) => {
  const wx0 = (px - v0.x) / v0.s, wx1 = (px - v1.x) / v1.s
  return Math.abs(wx0 - wx1) < 1e-9
}
// ⚠️ 目标值必须落在 [MIN_SCALE, MAX_SCALE] 内：给 2 会被夹到 1.65（首版本测试就是这么写错的）
const z1 = zoomTo({ x: 0, y: 0, s: 1 }, 1.5, 100, 100)
ok(z1.s === 1.5, '目标缩放生效')
ok(anchorStable({ x: 0, y: 0, s: 1 }, z1, 100), '锚点世界坐标不动')
ok(near(z1.x, -50) && near(z1.y, -50), `绕 (100,100) 放大 1.5× → 平移 -50（实测 x=${z1.x}）`)
ok(zoomTo({ x: 0, y: 0, s: 1 }, 2, 100, 100).s === MAX_SCALE, '目标超出上限 → 夹到上限（不是原样放行）')
const z2 = zoomBy({ x: 10, y: 20, s: 1 }, 1.12, 50, 60)
ok(z2.s > 1 && z2.s <= MAX_SCALE, '滚轮系数生效且不越上限')
ok(zoomBy({ x: 0, y: 0, s: MAX_SCALE }, 2, 10, 10).s === MAX_SCALE, '已在上限时继续放大 → 停在上限')
ok(zoomBy({ x: 0, y: 0, s: MIN_SCALE }, 0.5, 10, 10).s === MIN_SCALE, '已在下限时继续缩小 → 停在下限')

console.log('\n── pinchView：双指捏合 ──')
const start = { x: 0, y: 0, s: 1 }
const p2 = pinchView(start, 100, 200, 150, 150)
ok(p2.s === clampScale(2), '距离翻倍 → 缩放翻倍')
ok(anchorStable(start, p2, 150), '绕两指中点缩放（中点世界坐标不动）')
ok(pinchView(start, 100, 100, 0, 0) === start, '距离不变 → 原样返回（避免无谓 setState）')
ok(pinchView(start, 0, 100, 0, 0) === start, '起始距离 0（退化）→ 原样返回')
ok(pinchView(start, 100, 0, 0, 0) === start, '当前距离 0（并拢瞬间）→ 原样返回')
ok(pinchView(start, NaN, 100, 0, 0) === start, 'NaN → 原样返回')
ok(pinchView({ x: 0, y: 0, s: MAX_SCALE }, 100, 999, 0, 0).s === MAX_SCALE, '捏合放大受上限约束')

console.log('\n── pointerDist ──')
ok(pointerDist({ x: 0, y: 0 }, { x: 3, y: 4 }) === 5, '勾股距离（3-4-5）')
ok(pointerDist({ x: 7, y: 7 }, { x: 7, y: 7 }) === 0, '同点 → 0（调用方须容忍）')

console.log('\n── pickViewMode：显式选择优先，否则按容器宽度 ──')
ok(pickViewMode(360, null) === 'list', `窄容器（360 < ${LIST_BREAKPOINT}）→ 列表`)
ok(pickViewMode(900, null) === 'graph', '宽容器 → 图形')
ok(pickViewMode(360, 'graph') === 'graph', '**用户显式选图形 → 不被自动判定改回**（记住选择的意义）')
ok(pickViewMode(1200, 'list') === 'list', '用户显式选列表 → 保持')
ok(pickViewMode(LIST_BREAKPOINT, null) === 'graph', '恰好等于阈值 → 图形（仅「小于」算窄）')
ok(pickViewMode(0, null) === 'graph', '宽度未知（0）→ 不武断切列表')

console.log(failed === 0 ? '\n✅ viewport 全部通过' : `\n❌ viewport ${failed} 项失败`)
process.exit(failed === 0 ? 0 : 1)
