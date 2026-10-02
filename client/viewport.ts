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
 * ② 缩放下限 0.5 **保留**（我第一版把它降到 0.08 想让大图"一次看全"，次日复核推翻 —— 见下方那笔账）；
 * ③ 窄屏根本不该用图形 —— 图节点 300×54px，手机 fit 后仅约 37×7px（字号≈1.5px），只剩糊图。
 */

/**
 * 画布缩放区间（0.5 ~ 1.65，沿用 2026-08-19 初版）。
 *
 * ⚠️ 2026-09-29：我曾把下限降到 0.08 以"让大流程图能一次看全"，**次日复核推翻**（维护者质疑得对）。
 * 这个 0.5 在仓库里**从来没有记录过理由** —— 它随 91bdd5d「流水线视图重设计」一起进来，
 * 原文只有一句「滚轮以光标为中心缩放 (0.5~1.65)」，无注释、无 ADR。现在把理由补上（见下）。
 *
 * 一笔实测账（卡片 300×54、字号 12/10.5、卡间距 7）：
 *   100%  → 卡片 300×54.0px  字号 12.0px  间距 7.0px    可读
 *    50%  → 卡片 150×27.0px  字号  6.0px  间距 3.5px    不可读，但**结构可辨**（数得清几张卡）
 *    31%  → 卡片  94×16.9px  字号  3.8px  间距 2.2px    结构开始糊
 *    12%  → 卡片  37× 6.7px  字号  1.5px  间距 0.9px    **卡片糊成一团**（分不清几张）
 *
 * ⇒ 0.5 与 0.12 **都不可读** —— 50% 并没有换来可读性；但它换来了**结构**。
 *   而结构恰恰是图形视图**唯一的独有价值**（列表能给顺序，给不了「哪一波并行、哪里堆了 6 张卡」）。
 *   把图形缩到 0.12，等于把它降级成一张连卡片都数不清的糊图 —— 用图形换了一张废图。
 * ⇒ 想「一眼看全」的正确出口是**列表视图**（窄容器已默认），而不是把图形缩到看不清。
 *   issue #10 后半句「希望能缩到 50% 以下看全貌」的目标由列表满足，不由缩放满足。
 */
export const MAX_SCALE = 1.65
export const MIN_SCALE = 0.5

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
 * 「装得下全部内容」的缩放，但**不低于 MIN_SCALE**（低于 0.5 卡片糊成一团，图形失去唯一价值：
 * 结构）。边距沿用原 `doFit` 的 40/46，正常尺寸下与原实现逐位一致（零回归）。
 * 大流程图在窄容器上会因此看不全 —— 这是**有意的**：看全貌请用列表视图（见本文件顶部那笔账）。
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
