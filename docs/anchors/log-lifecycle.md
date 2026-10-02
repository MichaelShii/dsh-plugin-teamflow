# 锚点详情：日志生命周期（B 方案）

> 本文件是 `AGENTS.md` §5 中「日志生命周期（B 方案）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

**日志根离开用户项目**：子代理受 DSH 文件沙箱约束（`workspace-write` 只允许写会话工作区 + 平台临时区，写 `$DSH_HOME` 实测 `FS_SANDBOX_DENIED`），故为两段式——**暂存**（run 期间写 `<workspacePath>/logs/teamflow/<runId>/`）→ **过滤归档**（run 终态 `core/runlogs.archiveRunLogs`：**只留白名单**——code 扩展名 `.mjs/.cjs/.js/.sh/.ps1/.py/.md` + `captures.json`，搬到 `$DSH_HOME/teamflow/<workspace>/logs/<runId>/` 并删项目内副本；host 自身事件日志 `run.log` 直接写归档位）。**归档面 = 可重跑/人可读的检查脚本与结论笔记**——命令输出（`*.log`/`*.out`/`*.txt`）与源码快照**一律丢弃**（实测一次真实 run 130 文件/3.03 MB 里 93% 是这两类：41% 命令输出可重跑、35% 是 git 里已有一模一样的 `probe/head/**` 快照、17% prompt JSON dump；**唯一不可重跑且真被用过的 7% 就是脚本**）。命令输出在运行期仍有价值（把几百行输出挡在上下文之外，TOKEN_HYGIENE），但**不是审计资产**——durable claim 是回复里的 `[Verification evidence]` 块（随 journal 落盘、工作台可见）。**自愈清扫**：run 起跑 `sweepWorkspaceLogs` 按同一白名单处理上次崩溃/被 kill 残留的暂存目录与历史散落 `<runId>.log`／笔记（目录按名当 runId 归档；`<runId>.log` 直接丢弃——内容与 `runs/<runId>.json` 的 journal.logs 同源）；**保留 `LOG_ARCHIVE_KEEP=20` 次/工作区**（按 mtime 淘汰）；**正在运行的 run（暂存目录与归档）一律跳过**；任何失败只 warn、绝不阻断起跑/收尾。prompt 侧 `[Log lifecycle · policy]` 明确定性（暂存目录、只留脚本与笔记、dump 不留存、禁止提交/自行清理/当项目产物）。禁止回退为「日志长期留在用户项目」——实测 `products/tetris` 曾累计 1042 文件/17.3 MB 且无任何清理逻辑；禁止回退为「全量归档」——那是把 3 MB 里 2.7 MB 的噪音搬进 `$DSH_HOME`

## 交付枚举的截断语义（2026-10-02 追加）

宿主三项可观测性检查（加载 / 接口 / 冒烟）＋ QA 验证证据观察**都先枚举交付文件**（`util.scanDeliverableFiles`，上限 **400**）。两条不变量：

1. **点目录一律不遍历**。`.pnpm-store` / `.venv` / `.cache` 这类目录最易吃满配额，且从不是交付物。
   反面实锤（run `tf-mupnk8h0-1otbl2`）：旧实现的跳过名单**漏了 `.pnpm-store`**，而它在 `readdirSync` 顺序里排在 `AGENTS.md` 之前 ⇒ 几千个**无扩展名** blob 瞬间吃满 400 ⇒ 返回的 400 条里源文件 0、HTML 0 ⇒ 四项检查**同时静默跳过**，日志读起来像「交付里什么都没有」，而交付其实完好（28 文件 / 13 源文件 / 1 个 `index.html`）。**用户是在浏览器里点不动才把它暴露出来的。**

2. **命中上限时，那三条「不是事实」的结论必须被撤回**。「本次未执行（no-html）」「源文件 0 个」「未见可执行入口」——它们**原文保留**（检查确实没执行），撤回靠的是**紧随其后**的一条 `log.hostScanTruncated` warn，它点名那三条并声明「不是事实，只是没枚举到」。
   ⇒ **顺序也是契约**：撤回提示必须排在负结论**之后**，否则读者先看到「事实」再看到解释。编排测试第 ⑨ 组钉住这一条。

**门禁**：`test/smoke-check.test.js` ②b 段（扫描器层：点目录洪水 / 截断必须 `truncated=true` / `truncated` 与「真的没有」可区分）、`test/orchestration.test.js` 第 ⑨ 组（接线层：430 个无扩展名文件顶满 400 ⇒ 必须发出撤回提示且顺序正确）。
