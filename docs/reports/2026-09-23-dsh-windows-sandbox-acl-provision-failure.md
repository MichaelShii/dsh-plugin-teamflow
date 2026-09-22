# Windows 沙箱无法在用户自建目录上 provision 工作区 ACE → 该目录下所有 shell 命令失败

> **English abstract.** On dsh `0.1.7-alpha.1` (Windows), a workspace in a *user-created* directory
> (a plain `mkdir`, e.g. `D:\proj`) cannot be provisioned: every shell call fails with
> `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<workspace>)`. Directories that already carry the
> sandbox capability ACE (inherited from a tree provisioned earlier) work fine. The failure surfaces
> only as a tool error deep inside a session — no actionable message — and it cost one pipeline stage
> 52.6k output tokens before anything was reported. Root cause (measured): three security edits share one
> `SetNamedSecurityInfoW` call, and the third — labelling the directory Low integrity, a **SACL** write —
> needs `SeSecurityPrivilege`, which a normal user token does not have.

| 项 | 值 |
|---|---|
| dsh 版本 | `0.1.7-alpha.1`（HEAD `c36a83ff6b`，tag `dsh-v0.1.7-alpha.1`） |
| 平台 | Windows，工作区在非系统盘（NTFS，Fixed） |
| 组件 | `packages/sandbox/sandbox-windows-acl` |
| 影响 | 用户自建目录下 **shell 工具（pwsh/bash）100% 失败**；主会话与子代理同样受影响 |
| 观测者 | 一个三方插件驱动多子代理流水线时（子代理的 `pwsh` 调用） |

> 下文用 `D:\proj` 代替本机真实工作区路径，SID 只保留前缀。除路径与标识已脱敏外，其余为原始观测。

---

## 1. 最小复现

1. 在一个**没有继承过沙箱 ACE** 的目录建工作区（例：`D:\proj`；`mkdir` 即可，无需任何特殊操作）。
2. 以该目录为 cwd 开会话。
3. 让 agent 跑任意命令（例：`node --version`）。

**期望**：命令正常执行（沙箱为该工作区物化 capability ACE 后放行）。
**实际**：每次调用都以同一错误失败：

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
```

`Win32 5 = ERROR_ACCESS_DENIED`。重试没有意义——错误逐字相同。

## 2. 实际观测（一次真实 run）

某阶段（子代理）的 13 次工具调用里，`tool/result` 有 **7 条 `isError: true`**，全部是同一句：

```
isError=true   Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
isError=true   Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
isError=false  .gitignore docs/<task-folder>/meta.json docs/<task-folder>/PRD.md
isError=false  <path>D:\proj\docs\<task-folder>\PRD.md</path>
...
isError=true   Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
isError=true   Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
```

模型的行为是可预期的：它反复重试同一条命令（第 1/2/5/6/7/9/10 步都是 `pwsh`），确认无望后开始长篇推理，最终被输出上限截断：

| 步 | 输出 tokens | 内容 |
|---|---|---|
| #1–#9 | 250 / 70 / 106 / 357 / 156 / 167 / 159 / 41 / 110 | 工具调用（其中 6 次 `pwsh`） |
| #10 | 19,172 | 62,668 字符 reasoning + 2 个 tool call |
| #11 | 32,000（= 输出上限，被截断） | 90,266 字符 reasoning + 仅 172 字符正文、无 tool call |
| 阶段合计 | **52,588** | 11 次调用，**零产出** |

即：**一个环境故障在一个阶段里烧掉 52.6k 输出**，而且最终停下来的原因是「撞上模型输出上限」，不是「环境不可用」——排查时极易被误导（我们最初就按 `max-tokens` 排查了很久）。

## 3. 为什么是路径相关的：ACE 对照

同一台机器上，`Get-Acl` 读到的沙箱 capability ACE（`S-1-4-*` 派生 SID）分布如下：

| 位置 | 沙箱 ACE | shell |
|---|---|---|
| 非系统盘盘根 / 其下一个新建目录（**`D:\proj`**） | ❌ 无 | **全部失败** |
| 用户家目录、`Documents`、`Desktop`、`~/.dsh` | ❌ 无 | （同类结构，未逐一带会话验证） |
| `%TEMP%` 及其中子目录 | ✅ 有（`S-1-5-21-*` 组账户） | 可用 |
| 一个历史会话用过的项目树及其子目录 | ✅ 有 1 条**可继承**（`OI CI`） | 可用 |

对照结论：**只有"以前被 provision 过（或从其继承）"的树能用**。用户随手新建的目录没有这条 ACE，而沙箱这次又没能把它加上。

### 补充实验：ACE 本身是**可加的**

在一个一次性目录上以当前用户身份执行等价的授权操作，**成功**：

```powershell
$acl = Get-Acl $dir
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  (New-Object System.Security.Principal.SecurityIdentifier('<sandbox capability SID, S-1-4-…>')),
  'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
Set-Acl -Path $dir -AclObject $acl     # → 成功，读回确认 ACE 已在
```

注意：该 SID **无法翻译成账户名**（`Translate()` 抛 "Some or all identity references could not be translated."），
但作为 ACE 合法可用——所以它应当是 DSH 派生的沙箱身份，而不是本机账户。

## 4. 代码线索

- 抛错点：`packages/sandbox/sandbox-windows-acl/src/acl.ts:262`
  ```ts
  if (applyResult !== abi.ERROR_SUCCESS) throwWin32(api, 'SetNamedSecurityInfoW', applyResult, `${label}(${path})`)
  ```
- 授权调用：同包 `src/index.ts:270-277`、`src/grant.ts:107`（`grantWrite(api, path, sidPtr, lowLabelSid, worldSid)`）。
- 设计说明（同包 `README.zh.md:90 / 108 / 177`）：
  - 「工作区 SID 由规范工作区路径**确定性派生**（`workspaceWriteSid`），因此工作区根目录的安全描述符改动**每台机器每个工作区只物化一次**」；
  - 「重启后重新授权常驻工作区 ACE 是幂等的：`grantWrite` 读取当前 DACL，当完全相同的 ACE 已存在时跳过重新传播」；
  - 「授权物化是**急切的全树传播**」。
- 也就是说：**首次**在某个工作区跑沙箱命令时，必须真实改写该目录的 DACL；一旦被拒（ACCESS_DENIED），该工作区就永远起不来，而后续所有重试都会撞同一面墙。

## 5. 根因（已实测定位：第三项编辑是 SACL 写入，普通用户令牌无权）

`grantWrite` 在**同一次** `SetNamedSecurityInfoW` 调用里做三项编辑（见同包 `README.zh.md:90`）：
① 给工作区 capability SID 加写 ACE；② 给 world SID 拒绝 `FILE_DELETE_CHILD`；③ **把该目录标记为 Low 完整性**。
第 ③ 项写的是 **SACL**，而写 SACL 需要 `SeSecurityPrivilege`——**普通（非提升）用户令牌没有这个权限**。

**源码佐证**（`packages/sandbox/sandbox-windows-acl/src/acl.ts`）：

- `:387-388` 跳过条件 = `hasExactGrant && hasExactDeny && hasExactLabel`（三者都"精确已在"才跳过整次应用）；
- `:398-409` 三项编辑 = `buildLowLabelAcl`（Low + `OI|CI` + no-write-up）／
  `buildExplicitAccess(world, DENY_ACCESS, FILE_DELETE_CHILD, CONTAINER_INHERIT_ACE)`（**仅 CI**）／
  `buildExplicitAccess(capability, GRANT_ACCESS, 0x110156)`；
- `:257` 提交时 `labelEdit.kind === 'keep' ? DACL_SECURITY_INFORMATION : DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION`
  —— **标签若已精确在，则完全不传 SACL 位**。这就是"历史 provision 过的树不需要特权、而全新目录必然需要"的确切分界：
  前者走"纯 DACL 写入"（owner 就能做），后者必须写 SACL（需要 `SeSecurityPrivilege`）。

在本机以普通用户令牌逐项实测（一次性目录；用该包的 `workspaceWriteSid()` 算法算出 SID）：

| 编辑 | 结果 |
|---|---|
| ① 加 capability ACE（掩码 `0x110156`，`OI\|CI`） | ✅ 成功（owner 有 WRITE_DAC） |
| ② world 拒绝 `FILE_DELETE_CHILD` | ✅ 成功 |
| ③ **设 Low 完整性标签（写 SACL）** | ❌ **`Access is denied.`（exit 5）** |

且 `whoami /priv` 中**没有** `SeSecurityPrivilege`。三项编辑在同一次调用里 → ③ 失败即整次返回
`ERROR_ACCESS_DENIED` —— 与观测到的 `Win32 5` 完全一致。

这同时解释了"为什么只有历史 provision 过的树能用"：`grantWrite` 在**精确 ACE + 精确拒绝 + 精确标签**都已存在时
会跳过该调用（幂等快路径，见 `tests/acl-failure-paths.spec.ts:575`），所以那些目录不再需要写 SACL。
它们应当是在某个**提升权限**的进程里被物化过一次的。

**仍未验证**：provision 具体在宿主进程还是沙箱 runner 里执行（与结论无关——非提升场景下两者都没有
`SeSecurityPrivilege`）。

## 6. 影响面（为什么值得修）

- **普通用户会中，但"范围"我们只实测了一个位置，不作全域断言**：在**非系统盘下随手 `mkdir` 的目录**上 100% 失败
  （即本报告的复现场景）。是否为**所有**新建目录，取决于该目录（或祖先）**是否已是 Low 完整性**——
  若已是 Low，第 ③ 项编辑无需发生，provision 就不需要特权即可成功（这解释了 `%TEMP%` 下与历史项目树里
  为什么能留下沙箱 ACE）。**标签分布我们没有测**：读取 SACL 本身就需要 `SeSecurityPrivilege`，
  非提升进程读不到（实测四种路径全部返回 "does not possess the 'SeSecurityPrivilege' privilege"），
  所以"哪些常见位置会中"仍待宿主侧确认。
- **失败方式很贵**：报错只在会话深处的工具结果里，且**与环境无关的表层症状**（本次是"模型输出被 max-tokens 截断"）
  会先被看到。agent 的典型反应是重试 → 推理 → 烧钱。
- **不只是三方插件**：主会话里跑命令同样失败。

## 7. 建议（交给宿主侧决策）

1. **把 DACL 编辑与标签编辑解耦降级**：`acl.ts:257` 已经具备"标签已在就不传 SACL 位"的能力，
   只需再进一步——**标签写不了（无 `SeSecurityPrivilege`）时退化为纯 DACL 写入并如实告警**，
   而不是让整次 `SetNamedSecurityInfoW` 回滚成"该工作区永远不可用"。或者在**初始化阶段**用能写 SACL 的令牌
   完成首次物化（之后精确跳过，成本一次）。
2. **失败要早、要可操作**：当工作区 ACE 无法物化时，在**会话/工作区初始化阶段**就明确报出
   「该目录无法用于沙箱执行：<路径>（Access denied）」并给出补救（换目录 / 手工授权 / 关闭沙箱），
   而不是让它以一条工具错误的形式在 run 深处爆炸。
3. **考虑回退**：若目标目录不可授权，可回退到已带 capability 的目录（例如会话私有临时区）执行命令，并显式告知用户。

（本次涉及的插件侧问题——把一个环境故障误报成 `max-tokens`、以及护栏没拦住同一工具连续相同失败——
已由插件侧自行修复：判据用结构化 `isError`、连续 5 次相同错误即中止并点名「环境不可用」。
宿主侧这条 ACE provision 失败本身仍待修。）

---

## 附：原始证据

**工具错误原文（逐字，路径已替换）**

```
Error: SetNamedSecurityInfoW failed (Win32 5): grantWrite(D:\proj)
```

**ACL（SDDL 形状，SID 已截断）**

```
失败目录（新建）
  O:S-1-5-21-… G:S-1-5-21-…
  D:(A;ID;FA;;;BA)(A;OICIIOID;GA;;;BA)(A;ID;FA;;;SY)(A;OICIIOID;GA;;;SY)
    (A;ID;0x1301bf;;;AU)(A;OICIIOID;SDGXGWGR;;;AU)(A;ID;0x1200a9;;;BU)(A;OICIIOID;GXGR;;;BU)
  ← 无任何 S-1-4-* / 沙箱账户 ACE

可用目录（历史 provision 过，含可继承的沙箱 ACE）
  D:AI(A;OICIID;0x110156;;;S-1-4-…)(A;ID;FA;;;BA)…

%TEMP%（可用）
  D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;S-1-5-21-…)
```

**环境**

- `node v22.22.3`、`dsh 0.1.7-alpha.1`、Windows、工作区在非系统盘（NTFS Fixed）。
- 交叉参照：该 run 的产品线目录只落下一个 `teams.json`（首个需要 shell 的阶段即失败，无产物）。

**SID 派生交叉验证**（确认 capability SID 确由工作区路径派生：拿已带 ACE 的目录反算，与磁盘上的 ACE 逐字相符）

```
workspaceWriteSid('<repo root>')             → S-1-4-87479291-289938063    = 该目录上观测到的 ACE ★
workspaceWriteSid('<repo root>/plugins/p2')  → S-1-4-874674689-701560736  = 该目录上观测到的 ACE ★
workspaceWriteSid('D:\proj')                 → （新目录，故磁盘上无此 ACE）
```

**三项编辑逐项实测（普通用户令牌，一次性目录）**

```powershell
whoami /priv | Select-String SeSecurityPrivilege     # → 无输出（令牌里没有该权限）

# ① 加 capability ACE（掩码 0x110156，OI|CI）→ 成功
#    Set-Acl + FileSystemAccessRule(capabilitySid, 0x110156, 'ContainerInherit,ObjectInherit', 'None', 'Allow')

# ② world 拒绝 FILE_DELETE_CHILD → 成功
icacls $dir /deny "*S-1-1-0:(OI)(CI)(DC)"

# ③ 设 Low 完整性标签（SACL）→ 失败：这就是整次调用 ACCESS_DENIED 的来源
icacls $dir /setintegritylevel "(OI)(CI)L"
#   → $dir: Access is denied.        (exit 5)
```

**关键交叉验证：同一段代码在提权令牌下成功**（证明不是代码缺陷，而是令牌权限）

以**管理员** PowerShell 运行该包自带的 agentless runner（它会自行 grant 工作区，且工作区 ACE 是
standing、`dispose()` 不撤销）：

```
node <pkg>/lib/runner.js --workspace D:\proj --temp %TEMP% --mode workspace-write -- cmd /c echo ok
→ exit 0
```

之后 `icacls <workspace>`（提权才看得到 Mandatory Label 行）恰好是设计中的终态：

```
Everyone:(CI)(DENY)(DC)                            ← world 拒绝 FILE_DELETE_CHILD（仅 CI，对照 acl.ts:408）
S-1-4-x-y:(OI)(CI)(W,D,DC)                         ← 工作区 capability ACE（掩码 0x110156）
Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)   ← Low + no-write-up（对照 buildLowLabelAcl）
```

**普通用户令牌手工只补前两项（ACE + deny）不够**：标签写不进去 → 精确跳过条件（`acl.ts:387-388`）不成立
→ 下次仍要写 SACL → 依然 `ACCESS_DENIED`（实测：手工补 ACE 后 resume 仍以同一错误早停）。

**旁证：修好之后插件侧的行为**（同一工作区、同一故障）

| 尝试 | 阶段结果 | 输出 tokens | 时长 |
|---|---|---|---|
| 旧版插件 | `max-tokens`（误报，真因被掩） | 52,588 | 3 分 45 秒 |
| 旧版插件（模型改走「文件工具绕道」） | 被人工中断 | 83,496 | ~6 分钟 |
| 修好后 | **`env-unavailable` + 点名环境与原文错误** | **1,510** | **15 秒** |
