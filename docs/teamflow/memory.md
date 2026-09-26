# TeamFlow 产品记忆（约定层）

> 只承载跨需求的团队约定与技术栈决策；需求细节在各任务夹（`docs/teamflow/<yyyyMMdd-rN-slug>/`），迭代流水见 `docs/devlog.md`。

## 约定

- **host 侧 i18n（自 2026-09-15 / r9 起）**：语言源链 = 客户端推送（浏览器当前语言 / 系统语言探测）> 宿主用户显式选择 > `en` 默认；run 起跑时解析一次并写 run 级快照（`journal.locale`），同 run 语言一致、断点续跑沿用、切换语言只影响之后新起的 run。host 用户可见文案（工具返回 / 完成汇报 / 日志 / 诊断 / state 注入块 / triage 理由）与 prompt 模板、产物正文均走该快照；headless（无客户端）走兜底链，不报错不阻塞。客户端界面语言走宿主 `ctx.locale`（见 `client/locales.ts`）。
- **仓库 docs 与代码注释不做双语**：`docs/` 面向 agent，翻译收益近零——保持中文；代码注释统一中文（不做集中翻译，新注释也不写英文，禁止中英混注）。唯一例外：`docs/benchmarks/corpus/` 的 L2 冻结语料可**新增**（含 `manifest.json` 追加条目），既有内容零改动。
- **判据层只增不改**：验收结论行、缺陷表头/严重度、拒绝措辞词表（`REFUSAL_PATTERN`）、triage 关键词表（`ARCH_SIGNALS`/`UI_SIGNALS`）、L2 冻结语料属于「匹配用户输入 / 解析模型产出」的词表——中文项必须保留，英文支持一律以**新增**方式加入，禁止用英文替换中文词表。
