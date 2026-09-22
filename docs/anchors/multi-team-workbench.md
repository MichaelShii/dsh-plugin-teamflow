# 锚点详情：多团队/工作台

> 本文件是 `AGENTS.md` §5 中「多团队/工作台」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

teams.json + workspace 级隔离 + 单任务轮转 + dev 子卡 + 会话暂停/resume + state.json 预编译索引 + 子代理路由跟随主线程 + 分支策略启动前 needs-decision（ADR-2026-08-27）。**dev 任务身份 = host 生成的 `dt-N`（2026-09-18 实锤修复，勿回退）**：冲突检测会把 `files` 有交集的 blueprint 任务**合并**执行（正确，保证并发不写同一文件），但合并时 `title` 被**拼接**——若拿 title 当身份，resume 用未合并的 title 去查必然落空 → **重复执行已成功的工作**（probe-cache `tf-mu6tb281`：T0/T6/T7 被重跑，backlog 里 `dev-1` 与 `dev-7` 同为 T0）。现规则：`buildDevTaskDefs` 按定义顺序发 **`dt-N`**（`util.devTaskIdAt`），合并时 **`taskIds` 数组累加**（`['dt-1','dt-7','dt-8']`），`stage.taskIds` 落盘，`devTaskStatuses`（住 **util.ts**，纯函数可测——pipeline 链宿主私有 peer）**只认 id 归并**、resume 判定 `get(d.id)`，子卡匹配键用 **`dtId`**；**存量 stage 由 `backfillDevTaskIds` 补算 id**（用**蓝图 title 匹配**，结构化→文本；合并 title 会补出多个 id；结果写回 journal、幂等）——判定因此**始终只有一个键空间**。**禁止**在判定里做 title 双键/回退（会形成 id/title 两套命名空间 → 存量全 Miss，实测补跑 8 个而非 1 个），也**禁止**按分隔符切分 title（拿文本长相当身份，同型教训已两次）。门禁：`test/dev-task-id.test.js`（含真实 journal 形状复刻）+ smoke 反向断言。**隔离 key = 路径派生 `slugPath(cwd)`**（UUID 分支当前不可达：宿主 `resolveByPath` 异步、插件同步调用，见 docs/TODO.md）。**改动存档两态（2026-09-17 方案 A，勿回退）**：`gitMode: "repo"
