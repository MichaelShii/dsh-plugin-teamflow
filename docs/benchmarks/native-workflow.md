# 原生 DSH 工作流还原（高质量参照基线）

> 实证还原：原生 DSH 单会话面对未知项目（tetris 持久化）时，从「零认知」到交付的**完整工作流**。
> 数据来源：路径 B 会话 `session-5393e094`（JSONL 解压），与流水线路径 A 对照。
> 目的：作为「团队概念」引入流水线的**参照基线**——不凭空设计团队，而是先搞清原生靠什么产出高质量。

## 会话总览

| 指标 | 值 |
|---|---|
| 模型调用（assistant/message） | 115 |
| 工具调用 | read 28 / pwsh 28 / edit+write 58 / ask 1 / grep 1 / todo 3 = **119** |
| billed token（≈） | 19.1M（input 395k + cacheRead 18.7M + output 64k） |
| 总耗时 | 27 分钟 |
| 交付 | v2.6，`storage.js` 独立模块 + `verify-storage.cjs` + 19 文件全绿 |

## 原生工作流的五个阶段（实证时间线）

### Phase 1 — 环境探索（4 个 pwsh，先建上下文再动手）
```
git status; git branch -a                        → 建立 git/分支上下文
git log --oneline -10                            → 了解历史 / 惯例
git checkout -b feat/persistence-localStorage-main main  → 先建隔离分支
git diff main feat/persistence-localStorage --stat      → 对比旧分支（本会话变量污染点）
```
> 特征：**先搞清楚我在哪、项目什么状态、有哪些分支**，再谈别的。

### Phase 2 — 大量 READ 建立全局认知（连续 15+ 个 read）
```
docs/teamflow/ 的 memory/summary/prd/tech 文档    → 项目记忆与契约
game.js → audio.js → ui.js → index.html          → 完整读 4 个核心源文件
scripts/ 的 verify-game/audio/ui/assembly/qa-e2e  → 读全部验证脚本
README.md → style.css                            → 读外围
```
> 特征：**一次性全覆盖**。不挑、不 grep 跳过，把「摸清整个 codebase」作为前置，为后续架构决策铺认知。

### Phase 3 — 宣布理解 + Design Decision（关键转折点）
```
模型: "I now have a thorough understanding of the codebase.
       Let me formulate my implementation plan."
      → 输出 Design / Implementation Plan（架构决策）
```
> 特征：**认知到位才做设计**。先「thorough understanding」，后「formulate plan」。设计决策（如独立 storage.js）在这一步成型。

### Phase 4 — 验证基线（2 个 pwsh）
```
node verify-game.cjs; node qa-e2e-jsdom → 确认现状 Baseline 全绿（188/188）
模型: "Baseline fully green. Now let me set up my todo list and plan."
```
> 特征：**动手前确认基线**，知道改前是绿的，改出问题能归因。

### Phase 5 — 建 todo + 动手实现 + 验证循环（大量 edit + 反复验证）
```
todo_write → 大量 edit（write storage.js 新文件 → 装配 index.html → 实现）
→ 反复 run verify-storage/verify-game/verify-constants/verify-ui/qa-e2e → 全绿
```
> 特征：**设计先行、实现跟随**；每改一块就验证，循环收敛到全绿。

## 高质量的核心：认知 → 设计 → 实现 的次序

原生靠的是**不可跳过的次序**，而不是什么花哨技巧：
1. 先全局 READ 建认知（Phase 2）
2. 认知到位 → 一次性 Design Decision（Phase 3）
3. 基线确认（Phase 4）
4. 才动手实现（Phase 5）

「storage.js 该独立成模块」这个正确架构决策，是 Phase 2 读全了 game/audio/ui/index
之后，在 Phase 3 自然得出的——不是凭空来的。

## 对照流水线：缺的是什么

流水线代码质量翻车的根因不是「没有团队」，而是**跳过了「认知 → 设计」这个前置阶段**：

| 阶段 | 原生（路径 B） | 流水线（路径 A） |
|---|---|---|
| Phase 1 环境探索 | ✅ git 全查 | ❌ 无（直接开干） |
| Phase 2 全局 READ | ✅ 15+ 个全覆盖 | ❌ TOKEN_HYGIENE 禁止整读 → dev 只见局部 |
| Phase 3 Design Decision | ✅ "thorough understanding → plan" | ❌ 无架构决策，dev 直接散落实现 |
| Phase 4 基线验证 | ✅ Baseline green | ⚠ 无（直接改） |
| Phase 5 实现 | ✅ 每块验证循环 | ⚠ 有验证，但无设计引领 |

**结论**：原生高质量 = 「认知 → 设计 → 实现」次序不可跳过。
流水线引入「团队概念」的正确方式，是在 **Phase 3（Design Decision）这个点**映射角色
（架构师/tech 承担「全局读 → 建认知 → 出架构蓝图」），而不是让每个 dev 在没认知、
没设计的情况下各自为战。

## 团队概念的引入原则（基于此基线）

1. **「建认知 + 出设计」必须前置**，且由专门角色（tech/架构）在 dev 之前完成——对应原生 Phase 2~3。
2. **dev 得到的是「架构蓝图」**（该抽什么模块/依赖/装配/为什么），不是让它重新读全文件自己猜。
3. **省 token 的正确方式**是把认知/设计做成**一次性共享**（tech 产出 → state → dev 继承），
   而不是让每个 dev 各读一遍（重复）或都不读（没认知）。
4. **不可为省 token 砍掉 Phase 2~3**：那正是架构质量的生命线（见 pipeline-vs-native.md 教训）。
