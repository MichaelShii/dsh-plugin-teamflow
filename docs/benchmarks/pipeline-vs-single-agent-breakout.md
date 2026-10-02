# 流水线 vs 裸跑：同模型同需求的 A/B 对照（打砖块 Canvas 游戏）

> 日期：2026-09-30
> 模型：inceptionlabs/mercury-2.5（两侧同一模型、同需求原文、同起点空目录）
> 唯一变量：需求走不走 TeamFlow 流水线（r5 = medium 档流水线 / r6 = 单 agent 裸跑）
> 目的：搞清楚「严格提示词」在**同模型同需求**下为何反而产出更差——根因是什么，边界在哪。

---

## ⚠ 时效声明（2026-10-02 复核，先读这段）

本文**诊断方法没过时，结论过时了**。§1 那四条「美学意图在哪一步蒸发」的机制，**七成已在 09-30~10-01 的修复中消失**。
逐条现状见每节末尾的 `【现状 2026-10-02】`。读本文时请注意：

| 节 | 是否还成立 | 一句话 |
|---|---|---|
| §0 纠正错误结论 | ✅ 成立 | 方法论（截图误判 → 用代码 + QA 报告证伪）仍应照做 |
| §1 四条机制 A/B/C/D | ❌ **已修**（D 部分修） | 勿再当成现存问题；见各节 `【现状】` |
| §2 成本数字 | ⚠ **单例，不可当通则** | 后续两组实测方向互不相同（见 §2 表） |
| §3 `clip` 截断 | ⚠ **本文低估了范围** | 只修了 devPrompt 一处，**另外 12 处仍在**（§3 已重写） |
| §4 跨模型定位 / §5 决策表 | ✅ 成立 | 与当前产品定位一致 |

想看 craft 条款自身的 A/B（不是「流水线 vs 裸跑」），见 `docs/benchmarks/craft-ab-pomodoro.md`——**两个不同命题，不重复**。

---

## 0. 先纠正一个错误结论（重要）

首轮对比我断言「r5 漏做 HUD / 违反 AC-27（画布上始终可见分数/生命/关卡）」。这是**看截图误判**，已证伪：

- `tf-obs-r5/js/render.js:98-116` 的 `renderHud()` 无条件绘制关卡/分数/生命；`renderOverlay()`（`:122-140`）按状态绘制遮罩文案。
- `tf-obs-r5/docs/teamflow/.../QA-REPORT.md` 明写 **AC-27 / AC-28 / AC-29 全部 ✅**（HUD 三项在 y∈[0,64] 带内、覆盖层随状态切换）。

**r5 功能上完全达标（33 条 AC 全过）。** 两张截图的真实差距是**视觉质感（craft）**，不是功能：

| 维度 | r5（流水线） | r6（裸跑） |
|---|---|---|
| HUD | 平铺 `fillText` + 半透明带 | 等宽字体 + 强调色 + COMBO + 分隔线 + 圆角卡片 |
| 砖块 | 纯色 `fillRect` | 圆角 + 描边 + 高光条 + 受击白闪 |
| 球/挡板 | 纯色圆/胶囊 | 径向发光 + 拖尾 + `shadowBlur` 辉光 + 渐变 |
| 背景 | 纯色 | 线性渐变 + 网格 + 随球移动的径向氛围光 |
| 覆盖层 | 单行提示 | 标题 + 副行说明（"空格 / 点击发射"） |
| 工具链 | 无 | 自发建 `fallback.js` + `tools/`（playtest/selftest/verify/browsertest/shot） |

所以问题不是「流水线做错了」，而是——

## 1. 根因：流水线提示词优化的是「契约合规 + 可验证」，结构上没有承载「质量/美感」意图的通道

单 agent 在一个连续上下文里抱着「做一个好游戏」的整体意图（含未言明的「做得好看」），自然越过 AC 下限去打磨；流水线的每个子代理只拿到被切碎的切片，且 dev 提示词是**合规执行者框架**——目标函数是「通过契约 + 产出证据块」，不是「做好看」。

> **【现状 2026-10-02】四条机制均已落地修复**（09-30 加条款 → 10-01 craft A/B 后收窄并落盘）。以下原文保留作为**设计动机的历史记录**；引用行号已按当前代码更新。

### 机制 A — 上下文切碎，整体愿景在序列化中蒸发

dev 阶段拿到的不是需求，而是一堆切片（`host/prompts/index.ts:555` 的 `devPrompt(...)`）：

| dev 实际拿到的 | 形态（2026-09-30） | 后果 |
|---|---|---|
| `task.spec` | 一句话任务简报（如「T3 渲染层，无规则代码」） | 没有「做好看」的意图 |
| `tech` | `clip(tech, 12000)` —— 而 TECHNICAL.md 有 **48365 字符** | 只看到顶部 ~25% |
| `prd` | **只给路径**："grep the AC number as needed; no full read"（且该路径原本还指错，见 §3） | 主动把模型推离完整 PRD |
| `design` | **完全没传给 dev**（签名无该参数） | 唯一能承载美学的阶段，到不了执行者手里 |

**【现状 2026-10-02】已修。** `devPrompt:561-570` 现在是「小 teaser + 指向磁盘完整文件」：

```ts
// host/prompts/index.ts · devPrompt（当前）
[DESIGN NOTES (the visual quality spec is written FIRST in DESIGN.md — read that section
before writing anything visible; if the clip below is cut off mid-section, open the file
and read it. Avoid relying on this truncated head)
Path: ${RUN(state)}/DESIGN.md — the COMPLETE design is there; this inline clip is only a
starting taste, not the whole spec]
${clip(design, 4000)}
```

tech 同样降为 `clip(tech, 4000)` + `Path: ${RUN(state)}/TECHNICAL.md`。
**残余风险（诚实标注）**：这条路径依赖模型**主动去 disk 读/grep 完整文件**——对弱/本地模型这一招可能不掉用。
（同 §0 口径：那类模型本就依赖四层兜底，且「美学优化」对它无意义，不构成回归，但也**不该据此认为弱模型也拿到了完整 spec**。）

### 机制 B — dev 提示词是「合规执行者」框架，零字提质量

原 REQUREMENTS 逐条是：蓝图优先 / 接口契约 / 只改自己的文件 / spec 冲突处理 / 跑构建 / git 动作 / 写路径策略 / git 纪律 / 日志纪律 / 验证证据块 / 端到端覆盖 / state 块。**通篇没有一句关于视觉质量、打磨、体验、用户愉悦。**

**【现状 2026-10-02】已修。** `devPrompt:578` 新增 `4b. [Craft bar]`，受 `CRAFT(state)` 控制（`TEAMFLOW_CRAFT` 关时整段退场）：

> `4b. [Craft bar · guidance — the AC is the floor, not the ceiling] ... Give visible feedback for interactive states (hover / pressed / focus / disabled / hit) and keep persistent info (score / lives / status / level) visible in EVERY state, including idle and pre-launch ...`

**但作用面已按实测收窄**：craft 只负责「交互反馈下限 + 状态可见性」，**不做审美裁决**——因为 A/B 实测（`craft-ab-pomodoro.md`）显示条款对「好看」没有可测增益，只在「反馈规则计数」这一维度有单调增量。

### 机制 C — 设计阶段（唯一美学通道）与 dev 结构性断开

`designPrompt` 存在（UI/UX 角色，写 DESIGN.md），但 dev 提示词签名无 `design` 参数 → 设计产物到不了执行者；即使经 `techPrompt` 转述也被 `clip(design, 10000)` 二次稀释；且 r5 的 DESIGN.md 整个缺失。

**【现状 2026-10-02】已修（最彻底的一条）。** 当前签名：

```ts
export const devPrompt = (task, tech, prd, design, root, runId, state) => ...
```

`design` 已是一等入参，`569` 行注入 `clip(design, 4000)` + 完整文件路径，并在提示词里明写「**视觉规格写在 DESIGN.md 开头那段，先读它再动手做任何可见的东西**」。
由此形成了「需求 → 设计 → 技术 → 开发」的美学通道（`designPrompt:461` → `techPrompt:509` → `devPrompt:569`）。

### 机制 D — QA 框定为「正确性」，明确把视觉甩给人工

原 `qaPrompt` 的要件是架构核验 / 接口一致性 / 验证证据——全是「对不对」。`QA-REPORT.md` §5 更把**视觉项**（覆盖层遮挡、砖块配色区分度、动画观感）列为**人工补测**（「目视」）。所以「丑」在这套框架里**永远不会被判为缺陷**。

**【现状 2026-10-02】部分修（刻意只修一半）。** `qaPrompt:647` 新增 `0d. [Craft grade · observation, never a blocking gate]`：

> `Correctness and craft are separate dimensions ... Grade craft as **P3 observation** rows only (never P0-P2) ... File each gap as a P3 observation naming the concrete element; do NOT fail or block the run on it.`

**为什么只到 P3、不做门禁**：本插件面向任意 dsh 用户、任意模型。把 craft 升成硬门禁，会让「不会写状态反馈的弱模型」每个 run 都失败 = 插件不可用。真正该硬起来的是**机器能客观判的**那部分（见 §3 与 `docs/anchors/`）。
**仍然保留人工通道**：`:615` / `:622` 依旧把遮挡、动画观感、版式美学列为目视项——这类只有人眼能判，不该伪装成可自动断言。

## 2. 成本（⚠ 单例样本，勿当通则）

2026-09-30 这一组（打砖块，mercury-2.5）：

| 项 | r5 流水线 | r6 裸跑 | 倍数 |
|---|---|---|---|
| token | **4510 万** | 1190 万 | 3.8× |
| 时长 | 95 min | — | — |
| 调用 | 635 | — | — |
| 阶段 | 10 | 1 | — |
| 代码行 | 884 | 2274（含 fallback + 工具链） | 0.39× |

**【现状 2026-10-02】这条 3.8× 不能外推。** 后续两组实测**方向互不相同**：

| 样本 | 对比 | 倍数 | 备注 |
|---|---|---|---|
| 09-30 打砖块 | 流水线 vs 裸跑 | **3.8×** token | 本文这组 |
| 10-01 番茄钟 | C 原生单会话 vs B 流水线(craft 关) | **便宜 45× input / 27× 墙钟** | `craft-ab-pomodoro.md` §0.3 |
| 10-01 番茄钟 | A(craft 开) vs B(craft 关) | **+30.8% input / +46.7% 调用 / +29.0% 墙钟** | 同文档 §7 |
| 10-02 设置面板 | R2(craft 开) vs R1(craft 关) | **−54% input / −56% 调用 / −42% 墙钟** | ⚠ 被「dev 任务拆分 7 vs 3」主导，**不可归因 craft** |

⇒ 结论：**「流水线比裸跑贵多少」是量级 10× 以上的量级差（3.8× 是这个样本里偏小的一次），但「craft 开关本身的边际成本」到目前为止三组都算不清**——每一组都被 QA 返工轮或 dev 任务拆分粒度这个更大的变量盖住。
用这组数字论证「craft 贵」或「craft 便宜」都是错的。

## 3. `clip` 截断：只修了 dev 一处，另外 12 处仍在（本文原版低估了范围）

原判断：`clip(tech, 12000)` 把 48KB 技术文档截掉 3/4 ⇒ dev 基于被截断的 spec 工作，**这不只是美学问题，是真的信息丢失**。
该判断成立，但**修复只覆盖了 devPrompt**。

**【现状 2026-10-02】全量盘点**（`host/prompts/index.ts`，共 14 处 `clip`，仅 2 处带磁盘路径）：

| 行 | 归属 | 调用 | 是否带「完整文件在磁盘」指引 |
|---|---|---|---|
| 461 | `designPrompt` | `clip(prd, 15000)` | ❌ |
| 481 | `scaffoldPrompt` | `clip(req, 10000)` | ❌ |
| 483 | `scaffoldPrompt` | `clip(design, 10000)` | ❌ |
| 507 | `techPrompt` | `clip(prd, 12000)` | ❌ |
| 509 | `techPrompt` | `clip(design, 10000)` | ❌ |
| 511 | `techPrompt` | `clip(scaffold, 10000)` | ❌ |
| 538 | `architectPrompt` | `clip(prd, 12000)` | ❌ |
| **564** | **`devPrompt`** | **`clip(tech, 4000)`** | ✅ 已改 |
| **569** | **`devPrompt`** | **`clip(design, 4000)`** | ✅ 已改 |
| 628 | `qaPrompt` | `clip(devSummary, 15000)` | ❌ |
| 677 | `qaFixPrompt` | `clip(qa, 12000)` | ❌ |
| **681** | **`qaFixPrompt`** | **`clip(tech, 12000)`** | ❌ **同一个 tech 截断，最要紧** |
| 736 | `acceptancePrompt` | `clip(qa, 10000)` | ❌ |
| 738 | `acceptancePrompt` | `clip(devSummary, 8000)` | ❌ |

**实测证据**：10-02 设置面板两档的 `TECHNICAL.md` 分别是 **15699 / 14273 字符**，都 **> 12000** ⇒ `qaFixPrompt:681` 拿到技术方案时**必然被截**。
即「dev 修完了、QA 修复路径没跟着修」——同型缺陷漏改。

**已修的两处**（2026-09-30）：

```ts
// host/prompts/index.ts · devPrompt
${(tech && String(tech).trim())
  ? `[TECH DESIGN (full source lives on disk — read/grep the sections your task needs; do NOT rely on this truncated head)
Path: ${RUN(state)}/TECHNICAL.md  — the COMPLETE technical design is there; this inline clip is only a starting taste, not the whole spec]
${clip(tech, 4000)}`
  : ''}
```

顺带修的另一个 bug：`devPrompt` 原先把 PRD 指到 `${TF_DOCS}/prd/PRD.md`，但真实路径是 `${RUN(state)}/PRD.md`（`qaPrompt` 用的是对的）→ **已改**，当前 `571` 行是正确的 `${RUN(state)}/PRD.md`。

**待办**：其余 12 处是否都要跟改成「teaser + 磁盘路径」，需按文档实际体量逐处判断——加了路径指引会给每个 prompt 增加固定 token（本仓有 `test/instruction-budget.test.js` 硬门禁），**不该无脑全铺**。
优先级最高的是 `qaFixPrompt:681`（`tech` 是已知大文档，且它是**修缺陷**的路径，信息缺失代价最大）。

## 4. 收口到插件的跨模型定位

这套严格提示词**不是 bug，而是模式错配**：它解决的是「**弱/未知模型 + 批量可靠交付**」那个不同的问题（弱模型不会自查，四层门禁才必要）。对「**强模型 + 单需求 + 你能亲自验收**」这个 case，合规脚手架既是纯开销，又把产出封顶在合规下限。

这恰好印证产品定位：**批量可靠交付才是卖点，单需求强模型直跑更划算**。

**【现状 2026-10-02】仍然成立，且已落成机制。** craft 这类「面向质量」的引导做成了**环境变量开关**（`TEAMFLOW_CRAFT`，缺省开；`0/false/off/no` 关），而不是写死：强模型上条款≈纯成本，弱/本地模型上才是净收益 ⇒ 可分层。开关只影响 prompt 形态，**落进 run 快照 `journal.options.craft`**，事后可辨实验组。

## 5. 决策指南：何时用流水线

| 场景 | 流水线 | 单 agent 裸跑 |
|---|---|---|
| 强模型 + 单需求 + 你能亲自验收 | ❌ 不划算（成本高、质感封顶） | ✅ 更优 |
| 弱/本地模型（不会自查） | ✅ 必要兜底 | ❌ 每个 run 都失败 |
| 批量交付（你看不过来、要可信记录） | ✅ 核心价值 | ❌ 失败隔离/审计缺失 |
| 需要跨阶段契约/接口一致性硬保证 | ✅ | ❌ |

**结论**：流水线在「会自查的强模型 + 单需求」场景下的劣势是系统性的（设计、实现、验证、成本四层各漏一处），但它在弱模型与批量场景下不可替代。提示词应继续为「可靠交付」优化；**单需求的强模型场景应默认走 patch/lite 或直接裸跑**，不要为合规框架买单。

## 6. 怎么复核本文的结论（可复跑）

本次复核全部是**静态可核**的，不依赖任何人的记忆：

```bash
# ① 机制 A/C：devPrompt 是否已收 design 入参、是否带磁盘路径
node -e "const L=require('fs').readFileSync('host/prompts/index.ts','utf8').split(/\r?\n/);L.forEach((l,i)=>{if(/export const \w+Prompt =/.test(l)||/clip\(/.test(l))console.log(i+1,l.trim().slice(0,110))})"

# ② 机制 B/D：craft 条款是否在位、是否受 CRAFT(state) 控制
node test/craft-link.check.mjs      # 断言 2b/2c/4b/4c/0d 五键在 / craft:false 时五键退场

# ③ §1 的「意图蒸发」类缺陷：产物侧自洽
node scripts/artifact-selfcheck.mjs <产物目录>   # [geo] 几何自洽 / [bind] 未绑定按钮 / [state] 死快照 / [craft] 反馈态计数
```

第三条是 10-01 新增的**产物自洽探针**——本文 §1 讨论的「下游没人判产物自洽」那类问题，现在有机器判据了（不依赖模型自律）。
