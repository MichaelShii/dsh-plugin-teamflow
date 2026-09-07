# QA 测试报告 — Tetris v2.6

## 范围与环境
- 范围：本地持久化（最高分 + 四设置）
- 环境：node test/verify*.cjs（jsdom 无浏览器依赖）

## 测试用例与结果
| 用例 | 结果 | 说明 |
|---|---|---|
| verify-game | PASS | 52/52 |
| verify-audio | PASS | 23/23 |
| verify-persist | PASS | 10/10 |

## 人工补测清单
- 真实 file:// 浏览器 reload 持久化生效（AC-16/AC-10.5）

## 缺陷
| 编号 | 严重级(P0/P1/P2/P3) | 功能模块 | 复现步骤 | 期望行为 | 实际行为 | 关联验收项 |
|---|---|---|---|---|---|---|
| BUG-1 | **P1** | persist.js | 真实浏览器 reload | 分数/设置保留 | 全部丢失（TypeError 被静默吞） | AC-16, AC-10.5 |
| BUG-2 | P2 | audio.js | 切静音后 reload | 静音保持 | 恢复默认 | AC-10.5 |
| OBS-3 | P3 | game.js | 快速连击 | 不应抖动 | 偶发抖动 | — |

## 结论
存在 P0/P1/P2 缺陷，打回开发修复后复验。
