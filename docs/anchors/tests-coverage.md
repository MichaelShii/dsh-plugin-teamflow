# 锚点详情：测试套件覆盖明细（AGENTS.md §2 测试行「说明」格原文）

> 从 AGENTS.md §2 文档索引迁出的完整覆盖明细（每个套件守哪一类不变量）。逐字保留。
> 测试文件清单本身仍留在 AGENTS.md §2。

结构/描述符 smoke + **语言层门禁（词典键唯一 / zh-en 同形 / en 无 CJK）** + 档位阶段集 + 验收结论 + journal 行为 + **日志生命周期（白名单过滤/归档搬运/合并/自愈清扫/活跃 run 豁免/K 次淘汰/永不抛 + store↔constants 路径同址）** + **中断门禁（只有 running 可取消 / 置位+dispose+落盘 / 阶段间隙可取消 / dispose 抛错与拒绝都不吞取消 / **并发多路一次全停** / **取消后并发池不再取新任务** / descriptor-服务-三处 UI 入口同源）** + 重试诊断/交付判定（judgeDeliverable 信号分级）+ 验证证据块 + token 计量宿主适配（官方投影优先 + 多源回退/usage 双路径回退 + 熔断新增口径 freshTokensOf） + **收口提交面（自有日志 .gitignore 幂等合并 + 索引兜底参数形状）** + **收口提交链路的真 git 集成（负 pathspec 会 exit 1 的防回退锁 / 写规则→整树 add→索引兜底→commit 真跑通 / 「无事可做」判据 / 基线索引层排除不写用户 .gitignore）** + 产品线装配（全局面板数据面：地址/白名单/过滤/摘要/空态） + **dev 任务身份 dt-N 与 resume 判定（合并执行不重复补跑 / 存量回退 / 边界）** + **doc 阶段产物兜底（文件即交付：真实形状复刻 + 边界）+ 熔断预算随缓存能力自适应（无缓存 provider 用例）+ 形态契约接线（triageRecordOf 字段完整性）+ 序列化完整性（JournalRecord/JournalStage 字段逐个断言，防"只写不落盘"）+ 引擎留痕（provider/model）**
