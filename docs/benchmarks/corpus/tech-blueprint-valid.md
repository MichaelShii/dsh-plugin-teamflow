# TECHNICAL — 技术方案（**合法**蓝图 JSON，正常路径）

> 冻结语料（2026-10-02 追加，只增不改）：**合法**蓝图 JSON 的解析形状 —— 走的是「一次 `JSON.parse` 成功」
> 这条**正常路径**，根本不经过 `repairBlueprintJson`。
>
> 为什么需要它：既有语料 `tech-blueprint-malformed.md` 覆盖的是「畸形但**可抢救**」，测的是抢救逻辑。
> 两条互补 —— **若抢救逻辑被误用到合法 JSON 上、或正常解析路径本身回归，只有本条会红，那条不会。**
> 语料只增不改：要覆盖新形状请新增文件 + 新条目，不要改本文件。

技术方案：设置面板拆为「几何纯函数 / 滑块组件 / 面板外壳」三层，几何计算独立成模块以便单测。

<!-- blueprint -->{"summary":"设置面板三层拆分 + sliderMath 几何纯函数模块","modules":{"/src/lib/sliderMath.ts":{"responsibility":"滑块几何与取值换算的纯函数","api":["export function valueToPercent(v, min, max)","export function percentToValue(p, min, max)"],"dependsOn":[],"assemblyOrder":1,"why":"纯函数便于单测，且与 DOM 无关"},"/src/components/VolumeSlider.tsx":{"responsibility":"滑块组件（受控）","api":["export function VolumeSlider(props)"],"dependsOn":["/src/lib/sliderMath.ts"],"assemblyOrder":2,"why":"厚度依赖几何计算，故排在 sliderMath 之后"},"/src/components/SettingsPanel.tsx":{"responsibility":"面板外壳与状态持有","api":["export function SettingsPanel(props)"],"dependsOn":["/src/components/VolumeSlider.tsx","/src/lib/sliderMath.ts"],"assemblyOrder":3,"why":"外壳最后装配"}},"duplications":[],"tasks":[{"title":"T1 契约层几何纯函数","files":["/src/lib/sliderMath.ts"],"reads":["/src/types.ts"],"spec":"实现 valueToPercent / percentToValue 并按边界值单测"},{"title":"T2 滑块组件","files":["/src/components/VolumeSlider.tsx"],"reads":["/src/lib/sliderMath.ts"],"spec":"受控滑块，含 hover/active/focus/disabled 四态反馈"},{"title":"T3 面板外壳与演示入口","files":["/src/components/SettingsPanel.tsx","/src/App.tsx"],"reads":["/src/components/VolumeSlider.tsx"],"spec":"持有受控状态并挂演示页"}]}<!-- /blueprint -->

## 风险

无（三层职责不重叠，几何纯函数可独立单测）。
