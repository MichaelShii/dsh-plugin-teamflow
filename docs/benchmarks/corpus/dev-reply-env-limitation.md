实现完成，改动 src/query.mjs（group 过滤维度：FILTER_KEYS / emptyFilters / parseFilters / matches 四处同步）。

**关键实现点**
- `resolveGroupFilter` 把组名 / `-` 解析成索引桶键；全部不可解析时用模块私有 `NO_MATCH_KEY` 兜底，
  杜绝 `list --group ghost` 退化成返回全量。
- `queryItems` 先解析成 scoped 再决定是否走索引，未分组资产恒存在于 `(ungrouped)` 桶。

**环境限制（如实汇报，非拒绝）**
本沙箱禁止子进程管道（`spawnSync` 直接 EPERM），故 `tests/run.mjs` 的 7 个 runCli 用例与
`spec/verify.mjs` 全部 26 例无法执行，属环境性失败；T11 需在无限制 shell 复跑 `node tests/run.mjs`。

[Verification evidence]
- cmd: node logs/teamflow/tf-mtwvwpxa-p3vw08/smoke-lib.mjs → exit 0, 34/34 asserts, 0 failures
- cmd: node logs/teamflow/tf-mtwvwpxa-p3vw08/cli-lib-parity.mjs → exit 0, 8/8 asserts（CLI→lib 逐字段一致）
- cmd: node tests/run.mjs → exit 1, 57/64 passed，7 条失败全为 CLI 子进程用例（EPERM），0 条非 CLI 失败

<!-- state -->{"phase":"dev","summary":"T5 完成：query.mjs 加入 group 过滤维度","touched":["src/query.mjs"]}<!-- /state -->
