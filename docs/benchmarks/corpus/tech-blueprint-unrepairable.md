# TECHNICAL — 蓝图 JSON 被截断（**不可抢救** → null）

> 冻结语料（2026-10-02 追加，只增不改）：蓝图**标记齐全**（`<!-- blueprint -->` 与 `<!-- /blueprint -->` 都在），
> 但**里面的 JSON 被拦腰截断**（模型输出被收尾/超长截断）时的形状 ⇒ 解析器**返回 null**。
>
> 为什么钉住它：`repairBlueprintJson` 只修「提前闭合 + 后面还有键」这**一种**错位
> （要求断点后是 `^\s*,?\s*"` 且断点是 `}` 结尾）；**末尾截断**修不了 ⇒ null。
> **null 的语义是「本 run 没有可用蓝图」**，dev 会按无蓝图继续，而不是崩掉或编一个。
> 若哪天改成「修不出来就返回部分内容」，本条会红 —— **部分蓝图比没有蓝图更危险**
> （dev 会照着半个模块清单装配，缺的那半不会报错）。
>
> 与另外两条构成三态：合法（本目录 `tech-blueprint-valid.md`）/ 可抢救（`tech-blueprint-malformed.md`）/ 不可抢救（本条）。

技术方案：抽独立 storage 封装，避免 game / audio 各自实现适配器。

<!-- blueprint -->{"summary":"抽独立 storage 封装","modules":{"/storage.ts":{"responsibility":"存储封装","dependsOn":[],"assemblyOrder":1,"why":"统一键名与默认值"}},"duplications":[],"tasks":[{"title":"T1 实现 storage.ts","files":["/storage.ts"],"spec":"按蓝图实现存储封装"}<!-- /blueprint -->

## 风险

（输出被截断，本节未写完）
