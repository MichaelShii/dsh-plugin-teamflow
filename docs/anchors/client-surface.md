# 锚点详情：客户端面（产物可见 + 全局面板）

> 本文件是 `AGENTS.md` §5 中「客户端面（产物可见 + 全局面板）」锚点的**论证、实锤与门禁细节**——从 AGENTS.md 原文迁出，
> 内容逐字保留（仅把表格分隔还原为正常 Markdown 段落）。**行为不变量以 `AGENTS.md` §5 为准**；
> 本文件属可检索层，**不注入会话**（同 `docs/devlog.md` 的定位）。

双入口：**会话内工作台**（`conversation.view` tab，按 sessionId 寻址）+ **全局面板**（`sidebar.panellist` 图标 + `main` key=`teamflow`，按产品线 key 寻址，root scope 无会话钩子；主区为**标签页** run｜backlog，详情为**覆盖式浮层**，不并排多栏）。**两处 id 必须同值**（宿主 `layout.selectPanel` 对未注册 main key 抛错；`selectPanel(null)` 回对话）。右栏 run 详情 tab：类型进 `sidebarRightTabs` + 正文进 `sidebar.right.pane.tab`（key=definition.id），地址由 host 生成 `dsh-resource://teamflow/run/<产品线>/<runId>`；**正文读地址必须用宿主绑定的 `useTabInfo`**（slot 声明 `hooks: { tabInfo }` 会被渲染器改名为 `use<Name>`）取 `tab.navigation.address || tab.contentId`。**右侧栏是会话级的**（`RightbarRoot` 门控 `activePanelId === null`，实测 tf-mtvrsakj-l2vj5u）→ 全局面板里开右栏必须走 `goOwnerSessionAndOpen`：先 `sessions.open(ownerSession)`（host 载荷已带）、等 `sessions.list.current` 真的切过去 + seat 挂载 bind 后再 `openResource`；会话已清理时只提示不跳转；产物地址的会话段也由 host 用 `ownerSession` 生成。展示层 `client/shared.tsx` 共用，渲染组件两处仍分叉（见 docs/TODO.md）。**界面文案中英双语**：走宿主 `ctx.locale`（词典 `client/locales.ts` + slot 注册项声明 `locale: NS` + 面板/tab 名称用 thunk），切语言由宿主重渲染 outlet 生效、无需重启；**en 是兜底语言 → zh/en key 集合必须同形**，且客户端除 console 诊断与 `phaseKeyOf` 存量中文映射外不得有裸中文字面量（smoke 有闸）。**host 侧文案与产物语言见下一条「语言层」锚点**。**快照投影必须带 `taskKey`**（2026-09-16 回归修正，勿删）：`shared.stageLabelOf` 靠 `s.taskKey` 区分「任务级阶段（dev 子卡，保留任务名）」与「其余阶段（走 `phase` 词表本地化）」——`host/index.ts` 的 `stages: j.stages.map(...)` 漏了它 → 所有 dev 卡片退化成只显示阶段名「开发」（实锤 `tf-mtr9mi37-m9zx1u`：journal 里标题完好、UI 只剩「开发」；P1 i18n 之前节点直接渲染 `s.label`，故属 0.1.9 起的回归）；`stageLabelOf` 另有 dev 阶段兜底（缺 `taskKey` 也不丢 label，QA 缺陷修复轮的「第 N 轮」同理）；smoke 两条断言守门

---

## 补记（2026-09-23）：跳会话入口的宿主迁移

**症状**：工作台流水线详情浮层的「🎬 跳转子代理会话」按钮长期灰着；全局面板的产物跳转不再切到发起会话，
而是静默降级成「当前会话右栏内联打开」。

**根因（宿主侧，非本插件改动）**：dsh 0.1.7-alpha.1 的 2026-09-17 refactor 批次
（`6830e1460d` / `b9b14dc05e` / `6d3b5d4526`）删除了客户端会话服务的 `openSubagent` 与 `open`。
我们的守卫写的是 `typeof sessions.openSubagent === 'function'`（`client/index.tsx:179`），契约变更后恒为 false。
实测旁证：宿主契约 `packages/api/session-controller/src/client/contract/sessions.ts` 现有成员仅
`retain/using/retainInfo/searchResultLimit/create/subagentAddress/refreshProjections/refresh/search/fork/binding/list`；
跑中 run 的 journal 里 18/18 阶段 `childId` 全部落盘（数据面完好，问题纯在客户端 API 面）。

**迁移**：跳会话唯一入口 = `uiWorkspace.openSession(target)`，target 为会话 id 或持久子代理地址
`{ parentSessionId, childSessionId, mode: 'one-shot' | 'continuable' | 'unknown' }`
（`packages/subagent/subagent/src/control-types.ts:77`）。宿主自家同功能面板即此法：
`packages/client/ui-workflow-run/src/client/index.ts:34`，其测试断言 `openSession({ parentSessionId, childSessionId, mode: 'one-shot' })`。

**顺带修掉的两处同源死代码**：
- `sessions.open(ownerSession)`（`client/panel.tsx`）同批被移除 → 守卫恒真走降级分支。
- `sessions.list.getSnapshot().current`：`SessionListState` 已无 `current`（只剩 `ids/byId/phase/projectionsBySession`），
  「等当前会话切过去」的判据恒为 undefined → 删除该判据，只留时间维度重试。

**收益**：新 API 是**真跳转**（`ui-workspace/README.zh.md:68`：同步替换 owned `mainView` reference 并让主区域返回 Conversation），
而旧 `openSubagent` 只完成跳转、不切视图 —— 修完比旧行为好。

**门禁**：`test/client-host-api.test.js` —— 客户端引用的宿主成员必须落在冻结白名单内、
禁止引用已移除成员、用到就必须 inject 且桥接到 props；宿主下次再删成员会**测试变红**而不是按钮变灰。
