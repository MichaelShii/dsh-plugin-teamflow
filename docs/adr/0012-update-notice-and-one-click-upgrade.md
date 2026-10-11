# ADR-0012：升级提示与一键升级（把「不知道新版」与「升级要动手」拆成两件事）

- 状态：**已接受（Accepted，2026-10-12）**——发现落点＝**宿主插件页槽位 ＋ TeamFlow 工作台**；动作＝**真一键（调宿主服务）**；上游通用化**单独立议题，本轮不做**
- 日期：2026-10-12
- 关联：`docs/TODO.md`（真待办 §升级与分发）；`host/util.ts`（`detectInstallEnv` / `installRecipe`——**已存在**的安装环境探测与命令生成）；`host/index.ts`（Remote 方法面）、`descriptors.ts`（client↔host 契约）、`client/index.tsx`（工作台）；ADR-0010/0011（同族纪律：可客观判定的下沉宿主、不依赖模型自律）

## 背景

v0.2.7 已发布，但存量用户大量停留在旧版本。用户（2026-10-12）把问题**明确拆成两件**：

1. **不知道新版本发布了**（发现）；
2. **知道了也要费劲才能更**（动作）。

⚠️ **不是「装不上」**。这一句纠正是本 ADR 的出发点：镜像滞后已被实测排除——`registry.npmjs.org` 与 `registry.npmmirror.com` **同为 0.2.7 / 18 个版本**。**问题在发现与操作成本，不在可达性。**

**⚠️ 关于 `minimumReleaseAge`（10-12 二次修正，我先前写「未启用」是错的）**：它**是启用的**，窗口 24h（`pnpm remove` 报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`，cutoff `2026-10-10T17:20Z` vs 0.2.7 发布 `2026-10-11T15:06Z`），尽管 `pnpm config get minimumReleaseAge` 返回 `undefined`（⇒ 来源不是普通配置项，别用「config 查不到」当「没启用」的判据）。但它的**咬合面**与直觉不同：pnpm 安装时会**自动**把刚装的版本追加进 `minimumReleaseAgeExclude`（实测输出「Added 1 entry to minimumReleaseAgeExclude…，set `minimumReleaseAgeStrict` to true to gate these updates with a prompt」）；而该豁免**不覆盖 lockfile 策略校验**（`pnpm remove` 仍被拒）。我们的 `upgradeSelf` 用的是**精确版本 spec**，实测能装上（用户点击升级成功）——真正会挡人的是**范围/`latest` 解析**。


### 判据（源码级，2026-10-12 查证）

| 事实 | 判据 |
|---|---|
| 宿主插件页的「可更新」**只服务官方目录** | `updateAvailable()` 要求 `pkg.installTarget`（`packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx:483-488`），而该字段只由 `officialBundleInstallTarget(...)` 产出（`packages/boot/plugin-manager/src/index.ts:300-303`）⇒ **社区插件恒为 `undefined`** |
| 宿主文案把第三方导向「卸载再装」 | 同包 `locales.ts`：`installUpgradeNotice`（「…其他插件请先卸载再安装新版」）、`installProblemInstalled`（「该插件已安装。如需升级，请卸载后重新安装」） |
| agent 工具 `plugin_manager` **不能原地升级** | `inspect()` 对已装包返回 `already-installed`（`index.ts:405` path 分支、`:410` registry 分支）⇒ `install_bundle` 只能 remove→install |
| ✅ **服务层可以原地升级** | `pluginManager.installBundle(spec)` **不调 inspect**，直接 `runPnpm(['add', spec, …])`（`index.ts:542`），且自带备份/回滚、profile 写锁、registry 回退、兼容预检、install-script 审批、取消 |
| ✅ `pluginManager` 是可注入的 cordis 服务 | `super(ctx, 'pluginManager')`（`index.ts:208`）；跨包可用（`packages/host/plugin-inventory/src/index.ts:98`） |
| ✅ 宿主插件页**对外开放贡献槽位** | `plugins.detail.actions` / `plugins.detail.badge` / `plugins.detail.section`（**注意是单数 `section`**，见 `client/ui-plugin-manager/src/client/slot-contract.ts` 的 `declare module '@deepseek-ai/dsh-client-ui-slots'`）。注册走**我们已经在用**的 `ctx.slots.register`，只需类型（`import type … /client`），**不运行时依赖、不改宿主**）＋ 跨插件导航 `setView({kind:'package', name})`（`navigation-store.ts`） |
| 「安装命令 = 升级命令」 | `dsh plugin --profile <p> <args>` 是**面向 profile 的 pnpm 包装**，除三个 DSH 自有子命令外参数逐字交给 pnpm（`apps/cli/src/plugin.ts:77-97`、`plugin-manager/src/operations.ts:357`） |

## 决策

### D1　发现：两处落点

| # | 落点 | 覆盖谁 |
|---|---|---|
| ① | **宿主插件页槽位**（`plugins.detail.badge` ＋ `.actions`） | 去设置页管理插件的人——**这是用户找「更新」的默认位置**；宿主自己没给社区插件这个位置，我们补上 |
| ② | **TeamFlow 工作台**（我们已拥有的 `conversation.view` tab / 右栏） | 打开工作台的人 |
| ③ | **全局面板头部「检查更新」按钮**（`main` slot；2026-10-12 追加） | **唯一的手动入口**：①② 都是挂载时自动探一次、且只吃 24h 缓存 ⇒ 用户**没有主动问一次的办法**。按钮走 `force=true` 绕过缓存（否则点两次都只是重读同一份缓存＝按钮看起来坏了）；「已是最新 / 查不到」**只在手动查过后**显示，避免常驻噪音 |

⚠️ **工具条类位置的呈现规则**（用户 2026-10-12 **五轮**反馈，七条都进纪律）：
1. **不要把说明铺成整句**（30+ 字会把工具条挤成一段话，「有点突兀」）⇒ 非 registry 装法只给一个**感叹号 (+ 版本号)**，组件即 `UpdateHint`；旁边若已有「有新版本 x.y.z」就只给**纯图标**，不重复版本号。
2. ⚠️ **不能用原生 `title` 当浮层**：`title` **点不了、鼠标一移开就消失** ⇒ 既放不了「一键复制」按钮，用户也没法把鼠标移进去操作。改为**自绘悬浮层**：触发件与浮层同属一个容器、`onMouseEnter/onMouseLeave` 挂在**容器**上（浮层就在容器盒内）⇒ **鼠标移进浮层不会消失**；再加 `tabIndex` + `onFocus/onBlur` 让键盘也能开。
3. 🔴 **说「用命令升级」就必须把命令给出来**：面板头部与宿主插件页**原本没有命令**，而旧文案写的是「请用**上面**的命令升级」——**指向空气**。⇒ `UpdateHint` 必须接收 `command`：有就摊出来 ＋ 一键复制；没有就说明原因（`update.envUnknown`）。
   **可泛化的纪律：文案里指代一个动作（「点上面那个」「用下面的命令」）时，先确认那个动作在同一个呈现面上看得见、够得着**（同 §9「假承诺」一族）。
4. 🔴 **触发件与浮层之间的间隙必须属于二者之一**（第三轮反馈「鼠标根本没办法移动到这个面板上面，一往下面移动就消失了」的**真因**）：原实现用 `marginTop: 6` 顶开浮层，那道 6px **既不属于触发件也不属于浮层**（`margin` 是盒外空白）⇒ 鼠标往下一动就已在容器盒之外、`mouseleave` 立刻触发、**浮层在鼠标够到它之前就关了**。
   ⇒ 间隙改挂到**浮层自己**（外层绝对定位容器给 `paddingTop: 6`，浮层作为它的子内容）⇒ 悬停链 `容器 → 间隙 → 浮层` 全程在容器盒内、不断裂；**悬停处理只挂在共享容器上**（触发件、浮层各自不挂，避免两套 handler 互相打架）。
   **再加 240ms 关闭延时兜底**：`closeSoon` 起定时器、`openNow` 取消它（`useEffect` 清理）⇒ 在边缘/间隙抖一下不会闪关。
   **可泛化的纪律：任何「悬停展开的可交互浮层」，落盘前先用「鼠标从触发件走到浮层」这条路径自查 —— `margin` 造成的间隙默认不可悬停；要么用 `padding` 把它划进某一方，要么给关闭加延时。**
5. 🔴 **按钮里的文字不许竖排**：按钮常和「可伸缩的 `<code>`」（`flex: 1 1 auto; minWidth: 0`）同行，默认 `flex-shrink: 1` ＋ 按钮继承 `white-space: normal` ⇒ 一旦被挤窄，「已复制」会变成**一列三个字**。⇒ `whiteSpace: nowrap` ＋ `flexShrink: 0` **两条都要**（只给 `nowrap` 只会把字顶出盒子）。两条提炼为常量 `NO_WRAP`（`client/update-ui.tsx`），**浮层/面板的 `updBtnStyle` 与工作台提示条的 `chipBtn` 共用** —— 按钮样式源不止一处，教训只能留一份。
6. 🔴 **按钮标签在工具条里只用最短的那个词**：复制按钮写「复制升级命令」会把横向空间挤成一段话（用户 2026-10-12：「这个就复制两个字就行了」）⇒ `update.copy` = `复制` / `Copy`。**复制什么由紧邻的命令行自明**，不必在按钮上重复。
7. 🔴 **给用户复制的东西，和给模型读的东西，是两份契约**（用户 2026-10-12：「你把引号和括号内容也带上了？你是指望用户手动删？」）：`installRecipe` 是**说明书**（markdown 反引号 ＋ 括注「（在插件目录执行；dsh 在 PATH 上）」），把它当「复制按钮的内容」会让用户粘到终端里就是废命令。⇒ 新增 `installCommand()`（**裸命令**，无反引号/括注；`dsh` 不在 PATH 时退成 `cd "<绝对目录>" && pnpm add "<spec>"`），`updateStatus` 只用它；`installRecipe` 复用 `installCommand` 的命令本体 ⇒ **一个字符串不跨消费者复用**。
   **可泛化的纪律：凡一个字符串有两个消费者（模型读 / 用户复制 / 用户照抄），先问「两者要的东西一样吗」——说明书带解释，命令必须干净。**（与 §9「假承诺」同源：**话所指的东西必须和话本身对得上**。）



**实现已收敛到 `client/update-ui.tsx`**（`useUpdateStatus` / `UpgradeButton` / `upgradeErrorText` / `canOneClick` / `updBtnStyle` + `NO_WRAP`）——三处落点共用**同一份**，不许在调用方各写一套：「两步确认」的知情语义、「按 host 分型结论渲染失败」的规则、以及「按钮不许竖排」都只在那里。放在独立文件而非 `shared.tsx`，是因为 shared 的约定是「只放无状态纯展示件，不放任何 Remote 调用」，而这里既要探测（读）也要升级（写）。


❌ **不做「工具返回尾巴」**：会污染每次调用的返回面，收益与成本不成比例（用户 2026-10-12 排除）。

### D2　动作：真一键（调宿主服务）

按钮 → 我们的 host Remote 方法 → `ctx.pluginManager.installBundle('dsh-plugin-teamflow@x.y.z')`。

**不自己 spawn pnpm**：宿主这条路径已自带备份/回滚、profile 写锁、registry 回退、兼容预检、install-script 审批、取消——自己造等于把这些保障重实现一遍且更容易漏。

⚠️ **必须同时满足的三条**（实现硬要求）：

1. **用户知情**：按钮与确认文案必须明说「将在此 profile 执行 pnpm 安装、改动 profile 依赖」，**不得做成静默升级**；
2. **run 中不动手**：存在活跃 run 时**禁用或推迟**（避免与流水线抢 profile 锁、打断正在跑的阶段）；
3. **升完提示重启**：新代码要宿主重启才加载（与宿主 `restartNotice` 同义）。
4. **只对 registry 装法开放**（2026-10-12 真机踩到后补）：`upgradeSelf` 用的是 registry spec ⇒ 对 `file:` 本地链接 / git / tarball 的安装，一次点击会**把依赖静默换成 registry 版本**（那天把 desktop profile 的本地 `file:` 装成了线上 0.2.7）。⇒ 判据落在 host：读 profile 的 `dependencies[<pkg>]`，用纯函数 `classifyInstallSource()` 归类，**非 `registry`（含认不出的 `unknown`）一律不给一键，只给可复制的命令**。两层都设：UI 用 `canOneClick()` 提前不显示按钮，host 用 `upgradeGate()` 兜底（不依赖 UI 自律）。判序上**永久性原因压过临时性原因**（「非 registry」排在「run 在跑」之前，否则用户会以为等一等就能点）。


⚠️ 另注：该服务路径**绕过了 `plugin_manager` **工具**层的审批门槛**（审批写在 `tools.ts`，不在服务里）⇒ 知情责任落在我们这边，这正是第 1 条的由来。

### D3　探测底座

- **当前版本**：读插件自身 `package.json`（相对 `import.meta.url` 解析），**不依赖环境变量**。
- **最新版本**：host 侧一次**匿名 GET** packument（`registry.npmjs.org/dsh-plugin-teamflow`），**不带任何标识**；带缓存（默认 24h）；**失败静默且不阻断任何流程**——发现功能不得成为故障源。
- **环境相关命令**：复用已有的 `installRecipe(env, spec, name, locale)`（`host/util.ts:185`）。它已按 `detectInstallEnv()` 的结果区分「dsh 在 PATH」与「不在 PATH」两种形态，无需新造。

### D4　上游（不做；且**只能上报，不能提 PR**）

⚠️ **前提更正（2026-10-12 用户指出）**：dsh **不接受外部 PR，只接受上报（issue）**。⇒ 凡依赖宿主改动的方案**都不成立**，只能作为 issue 上报，**且不得当成会落地的依赖写进计划**。

据此复核本 ADR 的三条落点，**没有一条需要宿主改代码**：

| 落点 | 靠什么 | 需要宿主改码？ |
| --- | --- | --- |
| 探测（D3） | 我们 host 侧一次匿名 GET registry | ❌ 不需要 |
| 发现（D1-①） | 宿主**已发布**的槽位契约 ＋ **我们已在用**的 `ctx.slots.register` | ❌ 不需要 |
| 发现（D1-②） | 我们自己的 `conversation.view` 工作台 | ❌ 不需要 |
| 动作（D2） | 宿主**已发布**的 cordis 服务 `pluginManager.installBundle()` | ❌ 不需要 |

上游议题（让宿主对**所有**社区插件通用支持更新）**仅作 issue 上报**：收益更大，但涉及供应链策略（是否自动安装最新版），**何时落地不由我们决定**，故不计入计划。

## ⚠️ 已知局限（必须对外讲清）

**本功能对存量用户的第一次触达无效**：通知机制本身要靠升级才能获得 ⇒ 老版本用户看不到它。**要撬动存量，必须配一次性、与版本无关的触达**（发版通稿 / README / issue 模板里写明升级命令）。**这是本轮唯一的存量杠杆，不能省。**

## 已定档（2026-10-12，用户逐条确认）

| # | 问题 | 定案 |
|---|---|---|
| 1 | 探测触发时机 | **两处各按需触发**（打开工作台 / 打开宿主插件页）＋ **24h 缓存**；**不做后台定时** |
| 2 | 「跳过此版本」 | **给**。跳过的是**具体版本号**而非「永久静默」——更新的版本出现时重新提示 |
| 3 | 升级失败的用户可见性 | **必须显式**：失败原因、宿主诊断（`ChangeResult.logPath`）、当前版本是否已变，全部可见。同「失败显式暴露」纪律 |
| 4 | `TEAMFLOW_UPDATE` 强制位 | **要**。语义沿用 `util.envFlagOn`（未设＝开；`0/false/off/no`＝关）。⚠️ **不进公开 schema** —— 同 `craft` / `confirm` / `clarify` 的处置（用户不会主动设的参数＝功能不存在） |

## 实现切片（按序，每片独立可验）

| # | 切片 | 状态 |
|---|---|---|
| 1 | **探测底座 + 工作台提示条** —— host 侧版本探测（缓存 / 跳过 / 环境开关）＋ `updateStatus` / `skipUpdateVersion` Remote 方法 ＋ 工作台提示条 ＋ 单测 | ✅ 已完成 |
| 2 | **宿主插件页槽位** —— `plugins.detail.badge` / `.actions` 贡献（复用工作台那套 `UpgradeButton`，不另做直装） | ✅ 已完成 |
| 3 | **真一键** —— `upgradeSelf` 接 `pluginManager.installBundle`，落实 D2 三条硬要求 | ✅ 已完成（host 侧门禁为纯函数 `upgradeGate`，有单测；client 侧做**两步确认**，不直装） |

### ⚠️ 更正记录：切片 2 一度被我误判为「宿主不支持」（10-12）

我先是断言**做不了**，依据是「本机已装宿主里没有插件管理页」——**该结论是错的**，用户一张截图即推翻：桌面版左侧「插件」面板里就是那个页面。

> ⚠️ **订正（同日晚些时候，用户第二张截图）**：那个「插件」页**不是桌面版独有** —— **web 端（浏览器）左侧边栏同样有「插件」入口与同一页面**（内置/实验性/已安装插件三段 ＋ 启用开关 ＋ 「更多」菜单）。
> ⇒ 我在 README / CHANGELOG / release note 里写的「桌面版请用应用内的插件管理界面」**隐含了「只有桌面版有」**，是错的表述，已改为「两端同一个页面，差别只在装到哪个 profile / 升级动作归哪个 profile」。
> **教训同本 ADR 的判据修正**：**别把「我在某一个面上看到的东西」默认成「只有那个面有」** —— 宿主是同一份 client 代码的两个壳。

| 我查的 | 结果 | 对错 |
|---|---|---|
| `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-plugin-manager` | 不存在 | ✅ 事实正确 |
| 已装树 `grep -rl 'plugins.detail'` | 零命中 | ✅ 事实正确 |
| **源码仓构建产物** `packages/client/ui-plugin-manager/lib/client.js` | **三个槽位名都在，`renderSlot("plugins.detail.actions"/"badge", …)` 调用都在**（9-26 构建） | ❌ **漏查了这条路径** |

⇒ 桌面版**从源码仓的构建产物**加载该页面（与宿主 stderr 里那些 `E:\...\deepseek-harness\packages\...` 路径同源），**不在 profile 的 node_modules 里**。

**判据修正（已写进 `MEMORY-playbook` §D）**：问「宿主有没有这个能力」时，除 `~/.dsh/profiles/node_modules` 外**还要查正在跑的构建产物**（`packages/*/lib/`）与**用户界面本身**。**profile 里查不到 ≠ 宿主没有。**

**实现要点**：`dsh-client-ui-plugin-manager` 在 profile 里是断链 ⇒ 类型引不到；但 `ctx.slots.inject/register` 对槽位名是**宽松类型**，直接写名字即可（typecheck 0 错）。门禁加在 `test/client-host-api.test.js`，锁「注册名 → 守卫判据 → 渲染点调用 → 两处包名常量一致」**整条链**（变异证明：去掉守卫的包名判据 ⇒ 恰好 1 条红）。

### 修复记录：工具条呈现五轮（10-12，全是用户真机反馈）

| 轮 | 用户原话 | 真因 | 落点 |
|---|---|---|---|
| 1 | 「这应该是个感叹号之类的图标，然后悬浮展示更好点？这样感觉有点突兀」 | 30+ 字整句塞进水平工具条 | 改 `UpdateHint`：图标 / 短判决走文本，长解释进浮层 |
| 2 | 「请用上面命令升级，到底是啥命令也没有」＋「要一件复制和鼠标悬浮固定住」 | ① 指代一个**看不见**的动作；② 原生 `title` 点不了、移开即消失 | 浮层自带 `command` ＋ 复制按钮；弃 `title`、改自绘可停留浮层 ＋ `tabIndex` |
| 3 | 「鼠标根本没办法移动到这个面板上面，我一往下面移动就消失了」 | **6px `margin` 间隙不属于任何一方** ⇒ `mouseleave` 在鼠标够到浮层前触发 | 间隙改 `padding` 归浮层 ＋ 240ms 关闭延时（工具条规则第 4 条） |
| 4 | 「这个就复制两个字就行了」＋「已复制那个按钮一个字一个换行…应该让字体横着不换行」 | ① 长标签挤工具条；② 按钮与可伸缩 `<code>` 同行，被压缩后逐字竖排 | `update.copy` 收成两个字；`NO_WRAP = { nowrap, flexShrink: 0 }`（规则第 5、6 条） |
| 5 | 「复制的内容你把引号和括号内容也带上了？你是指望用户手动删？」 | `command` 复用了**给模型读的说明书** `installRecipe`（带反引号 ＋ 括注） | 拆出 `installCommand()` 裸命令，`updateStatus` 改用它，recipe 反过来复用它（规则第 7 条） |

**五轮同源**：都是「说明文字 / 命令的**呈现方式**」问题，而非逻辑错误——所以**没有一条能被纯逻辑单测抓到**（`test/update-check.test.js` 全绿时用户仍连报五次）。⇒ **凡是「用户要伸手去够、要照着敲」的 UI，纯函数单测不构成验收**（同 §14：评审必须运行时取证）。

**这一轮补的门禁**（`test/update-check.test.js` 第 10 组，**变异证明**：四条单维度变异各自只让对应新断言变红，还原后回全绿）：

| 变异 | 变红 |
|---|---|
| `updateStatus` 接线改回 `installRecipe` | 2 条（接线锁 ＋ 「说明书不得混入复制通道」） |
| `installCommand` 又裹上反引号/括注 | 3 条（命令正文、反引号/括号负向判据、引号成对） |
| `updBtnStyle` 去掉 `NO_WRAP` | 1 条 |
| `update.copy` 退回长文案 | 2 条（字数 ＋ 「旧文案不得复活」） |

⚠️ 首次变异想直接让 `installCommand` 返回 `installRecipe`，结果**栈溢出**——因为重构后 recipe 的命令正文也来自 `installCommand`，两者互调成环。⇒ 这条变异改到**接线层**（改 `host/index.ts` 的调用点）才成立；**变异本身也要能跑**，「脚本崩了」不算证明。
