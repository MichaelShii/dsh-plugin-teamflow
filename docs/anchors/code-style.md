# Code Style —— 代码格式规范

> 本文件是**格式的唯一定义源**。规范先于成本：先定"应该怎么写"，再谈"要改多少处"。
> 落地位置：`.oxlintrc.json`（规则） + `lefthook.yml`（提交时自动修） + `CONTRIBUTING.md`（贡献流程）。

## 一、立场：单一仲裁者

**本仓库不使用自动格式化器（无 Prettier / Biome）。格式由 `@stylistic` 的 lint 规则定义。**

这不是"省事"，是**避免两个格式源互相否定**。实测：同一份 `client/*.tsx`，`@stylistic/indent --fix` 修到 0 错之后
Prettier 仍判不合规，反之亦然——JSX 缩进上两者不可能同时满足。格式标准只能有一个定义源，
而 lint 规则是那个**可声明、可自动修、可进 CI 门禁**的形态；printer 是"我另有一套看法"的形态。

由此推出的两条硬结论：

1. **可自动修的规则一律启用并进门禁**（不因为"存量多"就不开）。
2. **不可自动修的规则只有 `max-len`**；它超标时必须人工断行，这是规范的执行内容，不是"例外"。

## 二、规则（ts/tsx）

| 项 | 值 | 自动修 | 说明 |
|---|---|---|---|
| 缩进 | 2 空格 | ✅ | `indent` 规则。JSX 也归它管 |
| 分号 | 不写 | ✅ | `semi: never`——与宿主 dsh 同侧 |
| 引号 | 单引号（`avoidEscape`） | ✅ | JSX 属性同 |
| 尾逗号 | 多行一律带 | ✅ | `comma-dangle: always-multiline` |
| 花括号空格 | `{ a: 1 }` | ✅ | `object-curly-spacing: always` |
| 箭头参数括号 | `(a) =>` | ✅ | `arrow-parens: always`，见下"与宿主的有意差异" |
| 成员分隔符 | 多行无分隔符 / 单行分号 | ✅ | `member-delimiter-style` |
| 末行换行 | 必须有 | ✅ | `eol-last` |
| 行尾空格 | 禁止 | ✅ | `no-trailing-spaces` |
| **行宽** | **每行 ≤ 140 字符** | ❌ | `max-len`，见下 |

`js/mjs` 段：单引号、无分号、无行尾空格（三条，均为可自动修）。

### 行宽为什么是 140

140 是**宿主 dsh 的值**。我们是 dsh 插件，源码与宿主同生态（2 空格、no-semi、单引号），
行宽也应对齐——生态一致性是格式标准的第一依据，不是"改起来贵不贵"。

口径（读这条规则时必须知道）：

- 数的是**整行字符数，含缩进空格**；
- `ignoreStrings` / `ignoreTemplateLiterals` / `ignoreUrls` → **含字符串字面量、模板字符串、URL 的行不计数**。
  这是为了让长 prompt 模板、长文案、长 URL 不被卷进"行宽纪律"——它们的长度由内容决定，不由排版决定。
- 因此"整仓超 140 字符的行"远多于"被判违规的行"，两者不是一回事，别拿前者质疑后者。

### 不可拆的行怎么办

**先拆，再谈豁免。** 超长正则字面量的正规写法是「按语义分组 + 数组 join」：

```ts
const EXTERNAL_FAILURE = new RegExp([
  '\\b429\\b', '\\b402\\b', 'rate[ _-]?limit', 'too many requests',
  '限流', '限速', '配额', '余额不足',
].join('|'), 'i')
```

拆分是机械的，但**必须做等价校验**（`new RegExp(parts.join('|')).source` 与原正则 `source` 逐字相同），
改完跑 `verdict.test.js` 复核分类结果。`host/util.ts` 的两条故障词表就是这么落地的：43 条 / 11 条候选词。

只有在"拆完反而读不了"时才允许 `// oxlint-disable-next-line @stylistic/max-len`，
且**必须说明为什么拆不开**、一文件至多一处。禁止用它绕过"懒得改"。

## 三、与宿主 dsh 的有意差异

| 项 | 宿主 | 我们 | 理由 |
|---|---|---|---|
| `arrow-parens` | `as-needed` | **`always`** | 存量与 12 条源码正则断言都按 `(a) =>` 写；`as-needed` 会改 270 处写法并炸断言。`always` 同时也是更主流的写法 |
| `indent` | 开（2） | 开（2） | 同 |
| `max-len` | 140 | 140 | 同 |
| js / mjs | `ignorePatterns` 直接排除 | 上基础三条 | 我们的测试与脚本也是源码，不该有豁免区 |

其余（no-semi、单引号、尾逗号、花括号空格、成员分隔符）与宿主一致。

## 四、执行机制（以后照做，不需要重新讨论）

1. **提交前**：`pnpm format`（= `oxlint --fix .` 跑两遍——JS 插件的重叠修复一遍不收敛）。
2. **提交时**：`lefthook` 的 `pre-commit` 对 staged 文件跑同一个 fixer 并 `stage_fixed` 重新暂存；
   另跑 `git diff --cached --check` 查空白错误。
3. **CI**：`pnpm lint`（`oxlint --deny-warnings`）必须 0 warning / 0 error。
4. **判据不是"有没有红"，是规则数**：日志里必须是 `64 files with 103 rules`。
   数字掉下来 = 配置没被吃到（jsPlugins 加载失败时 oxlint 会退化成默认规则集且仍可能退出 0）。

## 五、规则准入与升级纪律

- **新规则准入**：一条规则要么①可自动修，要么②存量清零，两者都不满足就不开。不允许"先加上、违规以后再说"。
- **disable 纪律**：`CONTRIBUTING.md` 已写明"Fix it, don't silence it"。disable 只允许出现在"技术上拆不开"的场景，且必须带理由。
  启用 `reportUnusedDisableDirectives`，失效的 disable 会让 CI 变红。
- **源码断言锁只锁内容，不锁排版**：`test/smoke.js` 用正则锁定 host 源码写法（防行为被悄悄改掉）。
  这类锁断言的是**调用了什么、传了哪些参数**；换行与缩进归 formatter 与 `max-len` 管。
  所以跨行时分隔符一律写 `\s*`（并容忍 `comma-dangle` 的尾逗号 `,?`），否则"行宽合规"和"门禁不红"会互相打架。
- **升级纪律**：`jsPlugins` 在 oxlint schema 里明写 **alpha、不受 semver**，所以 `oxlint` devDep **锁精确版本**（`1.85.0`）。
  升版前必须在临时目录验证规则仍生效（已知 `@stylistic/comma-dangle` 对 interface 成员静默失效）。

## 六、编辑器

`.editorconfig`（2 空格 / LF / 末行换行 / 去尾空格）只影响人类编辑器。**AI 直接写文件时不读它**——
那种情况下兜底的是 lint 规则与提交钩子，这正是本规范必须有"自动修 + 门禁"两层的原因。
