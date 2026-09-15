# ADR-0009：不做插件级用户记忆层（已否决）

- 状态：**已否决（Rejected）**
- 日期：2026-09（v0.1.9）
- 关联：`docs/adr/0002`（AGENTS 最小侵入 / 插件写域边界）、`docs/adr/0008`（memory 收窄为约定层）、`host/prompts/index.ts`（`AGENTS_TEMPLATE` / `TOKEN_HYGIENE` / 各阶段 prompt）、`docs/TODO.md`「评估过但否决」、宿主 `@deepseek-ai/dsh-agent-instructions`

## 背景

三层记忆里缺一层跨产品线的「用户约定层」：产品约定在 `<repo>/docs/teamflow/memory.md`，机器索引与运行档案在 `$DSH_HOME/teamflow/<key>/`，每条产品线互相隔离。于是同一条约定（例：「Windows+pnpm 项目 lockfile 必提交」）在每条新产品线都要重新表达一次。

原始提案（本 ADR 初稿）据此设计了一套插件自建的用户层：

- 存储 `$DSH_HOME/teamflow/_user/{memory.md,index.json}` 双件，结构镜像产品层 `memory.md ↔ state.json`；
- 准入三判据（跨产品线可复用 / 代码里查不到 / 会改变 agent 行为）+ 硬上限 30 条；
- host 在 `teamflow_start` 上下文装配时注入索引块（不挂每会话，以省 token），全文按需 grep；
- acceptance 阶段 write-back，加三条护栏（注入≠采信、优先级链、90 天淘汰）。

完整初稿见本仓库 git 历史。

## 否决理由

### 1. 场所错位：用户偏好不产生于流水线

用户偏好是**多轮对话的产物**——聊着聊着发现问题、存下来。而流水线是「一个需求、一条链路、干到底」的批处理形态，**不存在这个场所**。在流水线里建「跨产品记忆」，等于在一个没有该需求的场所里建存储。

### 2. 输入不足以判断普适性

要判断「这条约定是否跨产品线可复用」，需要跨产品线的观察面；而流水线在任一时刻只有**当前产品线**的上下文。因此它归纳出的「通用约定」，本质上都是当前需求里出现的约定——普适性是猜的，不是看到的。准入判据写得再严，也救不了缺失的输入。

### 3. 两条替代路径已足够，且都已有实现

| 约定的性质 | 正确去处 | 现状 |
|---|---|---|
| 跨产品的**用户**约定 | 用户自己写 `$DSH_HOME/AGENTS.md` | 宿主**无条件注入**，插件零代码零改动（事实见下节） |
| 插件的**硬规矩** | 直接进 `AGENTS_TEMPLATE` / 各阶段 prompt | 已在做：`TOKEN_HYGIENE`、`LOG-LAYOUT-SCOPED`、`DOC-BOUNDARY-POLICY`、`AGENTS-BOUNDARY-POLICY`… |
| 插件要**替用户做掉**的事 | 插件直接做（有真 Node `fs`） | 无需记忆层中转 |
| 单产品的约定 | `docs/teamflow/memory.md` | ADR-0002 / 0008 不变 |

### 4. 突破 ADR-0002 的写域边界

ADR-0002 已确立：TeamFlow 只在 `docs/teamflow/`、`logs/teamflow/` 下写文件（加实际产品代码改造与 AGENTS.md 托管区）。一个**跨产品线的全局状态层**突破了这条边界，而换来的是「用户自己写一行文件」即可得到的东西。同理，往用户全局 `AGENTS.md` 自动写入，是 ADR-0002「不改托管区外内容」的更大版本错误——那是**用户的文件**。

### 5. 初稿的一个自证问题

初稿的卖点「只在流水线启动注入（省 token）」是伪优势：需要跨所有会话生效的约定，本来就该每次会话都在；不需要的，就不该进用户层。为省 token 自建「流水线内注入」通道，等于用更多代码换一个**更差的一致性模型**——同一份约定在流水线内可见、流水线外不可见，模型看到的世界不一致。

## 否决前核实的事实（保留，供后续引用）

已自行跑代码确认（非采信转述），宿主侧确实存在用户偏好层：

| 事实 | 证据 |
|---|---|
| 用户偏好载体是 `$DSH_HOME/AGENTS.md` | `dsh-agent-instructions/src/render.ts:98`：`USER_GLOBAL_FILE = 'AGENTS.md'` |
| 装载路径 | `files.ts:285`：`join(config.dshHome, USER_GLOBAL_FILE)` |
| 候选链顺序（宽→窄） | 用户全局**最先** push，其后才是项目祖先链 root→cwd（`files.ts:285-312`） |
| 冲突时窄的赢 | `render.ts:13`："More specific instructions take precedence over broader ones" ⇒ 项目 `AGENTS.md` 优先于用户全局 |
| 不覆盖直接指令 | `render.ts:153`："They do not override system, developer, or **direct user instructions**" |
| 注入形态 | 带 `source` 的普通 `user` 消息（可 replay / compact / resume），非 system prompt |
| 本机实测（2026-09-12） | `C:\Users\gyech\.dsh\AGENTS.md` **不存在**，`CLAUDE.md` 亦不存在 ⇒ 用户偏好层当前是空的 |

**推论**：宿主只**读**不**学**——无自动沉淀、无 origin/hits、无淘汰上限。但「不自动学习」不等于「需要插件代劳学习」：那条约定写成一行文件就永久生效，成本远低于维护一个记忆层。

## 决策

**不做插件级用户记忆层。** 具体：

- 不创建 `$DSH_HOME/teamflow/_user/`，不新增任何全局层；`listProducts` 不受影响（本就不含此类目录）。
- 不在 `$DSH_HOME/teamflow/` 之外新增写点，不改写用户 `$DSH_HOME/AGENTS.md`（含「建议后自动写入」——建议归建议，写入由用户做）。
- 跨产品用户约定 → 用户自行写入 `$DSH_HOME/AGENTS.md`；插件既不代写也不注入。
- 插件需要施加的约束 → 一律直接进 prompt / 模板 / 宿主实现，不经记忆层中转。

## 影响

- ADR 索引（README / README.en / CONTRIBUTING / AGENTS）指向 `0009` 不变，但定性为**否决记录**。
- `docs/TODO.md` 的「用户层记忆落地」条目删除，移入「评估过但否决（勿重复调研）」。
- CHANGELOG [0.1.9] 相应条目改写为「否决记录」。
- **零运行时改动**：不新增存储、不新增注入通道、不新增工具。

## 再评估的触发信号

（避免「否决」退化成教条——出现下列任一情况应重新打开本议题，并附真实实例）

1. 宿主取消或改为 opt-in 地提供 `$DSH_HOME/AGENTS.md`（则「用户写一次」的替代路径失效）；
2. 出现**必须**跨产品线共享、且用户无法用一次文件表达的真实需求（须给具体实例，不接受推演）；
3. 流水线形态本身变化——从「一需求一链路」变成「长期驻留的持续交互」，即决策 1（场所错位）的前提不再成立。
