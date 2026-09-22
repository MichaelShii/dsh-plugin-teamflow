# PRD · OpenClaw 天气插件（r1）

> 阶段：prd。形态判定 `plugin-full`，目标宿主 **非本仓宿主**（openclaw）→ 必须产出「宿主契约调研」段。

## 1. 背景与目标

用户在 openclaw 上需要一个天气插件。

## 7. 宿主契约调研

- **目标宿主**：openclaw（`@openclaw/cli` v0.9 系列）。
- **契约出处**：`https://docs2.openclaw.ai/plugins/building-plugins`（本次实际读过）。
- **它要求什么**：
  - 入口：插件根目录需有 `plugin.json`，其中 `name` 用包根名。
  - 注册工具：在 `registering-tools` 章节描述的注册函数里声明工具，而非 dsh 的 `ctx.tools.register`。
  - 打包：随插件目录分发，无 `files` 白名单概念（与 dsh 不同）。
- **未能核实**：openclaw 的插件版本兼容策略（本环境无法安装 openclaw 实测），列入人工补测。

## 8. 假设与待澄清

- 假设：仅支持当前 openclaw 主版本。
