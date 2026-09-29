/**
 * dsh-plugin-teamflow — 流水线画布的**视图数学**与**视图模式选择**（纯函数，无 React / 无宿主依赖）。
 *
 * 为什么单独成文件（2026-09-29）：
 * 客户端**没有 DOM 测试基建**（无 jsdom/happy-dom；`test/client-host-api.test.js` 只守宿主 API 契约面），
 * 触摸手势与缩放边界在 CI 里根本验不了。把可判定的部分（缩放数学、下限、视图模式）抽成纯函数后，
 * 至少这部分能被 node 单测锁住；剩下的 DOM 接线只能真机手测 —— 本文件的存在就是为了**让未知尽可能小**。
 *
 * 三个来源问题（issue #10）：
 * ① 触摸设备彻底不能拖/缩 —— 容器 `touch-action:none` 关掉了原生手势，而应用层只接了鼠标事件；
 * ② 缩放下限**写死 0.5**（原 index.tsx 四处 `Math.max(0.5, …)`）⇒ 大流程图在**任何设备**上都看不全；
 * ③ 窄屏根本不该用图形 —— 图节点 300×54px，手机 fit 后仅约 57×10px（字号≈2px），只能算缩略图。
 */

/** 画布缩放区间。上限沿用既有 1.65；下限从**写死的 0.5** 降到 0.08 —— 这是"看不到全貌"的根因。 */
export const MAX_SCALE = 1.65
export const MIN_SCALE = 0.08

/** 视图模式自动切换的容器宽度阈值（窄于此优先列表；容器宽 ≠ 视口宽，右栏/会话 tab 差异很大）。 */
export const LIST_BREAKPOINT = 560

export interface Viewport {
  x: number
  y: number
  s: number
}

export type ViewMode = 'graph' | 'list'

export const clampScale = (s: number): number =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number.isFinite(s) ? s : 1))

/**
 * 「装得下全部内容」的缩放。**不再抬到 0.5** —— 抬了就等于无论怎么操作都看不全大流程图。
 * 边距沿用原 `doFit` 的 40/46，保证正常尺寸下的初始观感零回归。
 */
export function fitScale(
  worldW: number,
  worldH: number,
  viewW: number,
  viewH: number,
  marginX = 40,
  marginY = 46,
): number {
  if (!(worldW > 0) || !(worldH > 0) || !(viewW > 0) || !(viewH > 0)) return 1
  const raw = Math.min((viewH - marginY) / worldH, (viewW - marginX) / worldW, 1)
  return clampScale(raw)
}

/** 绕容器内某点 (px, py) 缩放到**绝对值**目标开方。滚轮 / 按钮 / 捏合三处共用同一套数学。 */
export function zoomTo(view: Viewport, targetScale: number, px: number, py: number): Viewport {
  const s = clampScale(targetScale)
  const k = s / view.s
  return { s, x: px - (px - view.x) * k, y: py - (py - view.y) * k }
}

/** 绕某点乘一个系数（滚轮/按钮用）。 */
export const zoomBy = (view: Viewport, factor: number, px: number, py: number): Viewport =>
  zoomTo(view, view.s * factor, px, py)

/**
 * 双指捏合：由「起始快照 + 起始距离 + 当前距离 + 两指中点（容器内坐标）」算出新视图。
 * 距离非法（0/NaN）时原样返回 —— 手势起止瞬间必然出现退化值，不能让它污染视图。
 */
export function pinchView(
  start: Viewport,
  startDist: number,
  curDist: number,
  cx: number,
  cy: number,
): Viewport {
  if (!(startDist > 0) || !(curDist > 0)) return start
  const factor = curDist / startDist
  // 间距没变就别动：捏合过程中必然出现大量等距帧，原样返回可省掉无谓的 setState/重渲染，
  // 也让「未变化」在调用侧成为可断言的事实（===）。
  if (Math.abs(factor - 1) < 1e-9) return start
  return zoomTo(start, start.s * factor, cx, cy)
}

/** 两指间距（client 坐标，勾股）。 */
export const pointerDist = (
  a: { x: number; y: number },
  b: { x: number; y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y)

/**
 * 视图模式：**用户显式选择优先**，否则按容器宽度自动（窄 → 列表）。
 * 宽度未知（0）时不武断切列表，保持图形。
 */
export function pickViewMode(
  containerWidth: number,
  userChoice: ViewMode | null | undefined,
  breakpoint = LIST_BREAKPOINT,
): ViewMode {
  if (userChoice === 'list' || userChoice === 'graph') return userChoice
  return containerWidth > 0 && containerWidth < breakpoint ? 'list' : 'graph'
}
