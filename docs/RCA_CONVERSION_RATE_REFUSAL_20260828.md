# 根因排查报告 · “本月抖音渠道的线索成交率”被拒答

- **日期**：2026-08-28
- **数据源**：sourceId=2
- **审计**：`ds_audit` id=90，verdict=`refused`，failureClass=`intent_error`，9 步工具轨迹，命中 2 个知识页
- **排查方式**：生产库只读查询 + 本地代码复现，未修改任何线上数据

## 结论

不是本体数据填写错误，也不是 Agent 整体设计有问题，而是**意图契约层的两处具体缺陷**。

`线索成交率` 指标页的内容是正确的——它明确声明了统计周期绑定进线时间 `alpha_crm_clue.clue_create_time`，也在反例里明确禁止把周期绑到 `alpha_clue_order_rel.order_time`。**是解析器读不懂这份声明**，把它静默丢弃后，让问句里“成交”两个字反过来决定了时间口径。护栏随后连续四次驳回 SQL 并拒答，是正确行为——它在拒绝生成一个口径不一致的数字。

| 问题 | 答案 | 依据 |
|---|---|---|
| 是本体数据填错了吗 | 不是 | 指标页定义完整自洽，连反例都写明；渠道列注释完整写着 `2:抖音` |
| 是 Agent 设计的问题吗 | 是，但不是 Loop 本身 | Loop 与护栏行为正确；缺陷在其上游的意图解析 |
| 是昨天 S2 迁移的回归吗 | 不是 | 已用迁移前备份逐项比对；但发现 S2 有一处独立的过度删除，见附带发现 |

## 证据 A：工具轨迹（审计 #90 落库原文）

顺序本身是证据——模型每次修正 SQL，护栏就换一条理由驳回，直到无路可走。

| 步 | 阶段 | 工具 | 结果 |
|---|---|---|---|
| 1 | understand | protocol_retry | 协议格式违规：每轮必须返回一个工具动作，实际返回 2 个 |
| 2 | retrieve | search_context | ok，命中 2 个知识页、8 张相关表 |
| 3 | retrieve | get_schema | ok |
| 4 | execute | run_sql | **驳回**：SQL 没有覆盖必需的时间角色“本月” |
| 5 | retrieve | get_schema | ok |
| 6 | execute | run_sql | **驳回**：时间范围必须绑定 completion 业务时间，不能套用其他创建或更新时间 |
| 7 | execute | run_sql | **驳回**：SQL 包含问题、已确认关系或有效性口径之外的额外筛选 |
| 8 | execute | run_sql | **驳回**：同上 |
| 9 | submit | refuse | 已安全拒答 |

第 4、6 步是同一病灶的两面：护栏要求周期绑 `completion`，指标页要求绑进线时间，两者不可能同时满足。第 7、8 步是渠道过滤被判为“额外筛选”。

## 证据 B：意图落库快照

| 意图字段 | 落库值 | 应有值 |
|---|---|---|
| `intent.timeRole` | `completion`（来自问句“成交”二字） | `entry`——指标页声明的进线口径 |
| `measures[0].timeRole` | `null` | `entry` |
| `metricDefinition.periodColumn` | 字段不存在 | `alpha_crm_clue.clue_create_time` |
| `intent.filters` | `[]` | 渠道 = 抖音 |
| `intent.ambiguities` | `[]` | — |

最后一行最刺眼：**歧义列表是空的**。周期冲突没有被登记为歧义，渠道绑定失败也没有，于是一份残缺的意图契约直接进入了执行阶段。澄清机制完全没有机会介入——它本该在这里问一句“按进线月还是成交月”。

## 缺陷一：指标页声明的周期列被静默丢弃

**位置**：`server/src/query-intent.mjs:155-156`（`knowledgeIntentConcepts`）

时间角色的推导方式是拿整份定义文本正则匹配 `TIME_ROLE_CONCEPTS`，且只在恰好命中一个角色时才采纳：

```js
const roles = TIME_ROLE_CONCEPTS.filter((item) => item.pattern.test(definition));
const role  = roles.length === 1 ? roles[0] : null;   // 命中 2 个 → 直接放弃
```

而这份指标定义为了把口径讲清楚，同时用到了“进线”和“成交/成单”——前者命中 `entry`，后者命中 `completion`。**定义写得越严谨，命中的角色越多，越容易被判为“说不清”。**

证据链：

1. **本地复现**：用线上真实定义文本调用 `knowledgeIntentConcepts`，得 `timeRole: null`，并确认同时命中 `entry` 与 `completion`。
2. **连带后果**：`metricDefinition` 实测只有 `aggregation, columns, tables, source, formula` 五个字段，**没有任何承载周期列的位置**。页面里那句“统计周期固定绑定 `alpha_crm_clue.clue_create_time`”从此无处可去。
3. **失控点**：指标自身时间角色为空后，问句里“成交”成为唯一信号，`intent.timeRole` 被设为 `completion` 且 `attachesTo: measure:rate`，护栏于是忠实地要求 SQL 绑定成交时间。
4. **结论**：系统最终强制执行的，正是这份指标页明令禁止的那条反例。权威声明输给了字面量匹配。

## 缺陷二：渠道过滤永远绑不上，而系统从未就此提问

**位置**：`server/src/knowledge-retrieval.mjs:874`（`verifiedEnumMeaning`）

护栏拒绝“额外筛选”本身没错——`intent.filters` 是空的，它无法证明渠道谓词属于用户意图。问题是这个绑定**在当前数据状态下不可能成功**，而且失败得毫无声响。

1. **数据事实**：`alpha_crm_clue.source_data_channel` 列注释完整写着 `数据来源 -1:未知 0:百度 1:腾讯 2:抖音 3:自有 4:巨量`，语义信息齐备。
2. **绑定门槛**：枚举值要参与绑定，必须 `meaning` 非空且 `meaning_source` ∈ verified/manual/human/ontology/…。实测数据源 2 共 6935 行枚举，**带含义 0 行**，`meaning_source` 全为 NULL。
3. **也没有人被问过**：枚举类消歧问题 0 条。列注释里的映射从未被解析利用，也从未生成过任何待确认问题。**用户被要求确认一件系统从没问过的事。**
4. **另一条路也是断的**：该列已登记枚举值只有 `-1, 0, 1, 3, 4`——**“抖音”对应的 `2` 根本不在字典里**（采样未覆盖）。即便补上含义，这条路仍走不通。
5. **结论**：指标页其实指明了正确路径——“渠道名称必须通过 `alpha_crm_channel.channel_name` 精确过滤”，且 `alpha_crm_clue.channel_id → alpha_crm_channel.channel_id` 已是 confirmed 关系。缺的是把“抖音”绑到渠道维表取值的已验证映射。

## 已排除的可能性

**S9 的 `METRIC_PROPOSAL_ENABLED` 没打开是原因** —— 开关确实是关的，但打开也不改变结果。口径提议的触发条件是“缺少已验证的 ratio 指标定义且这是唯一阻断原因”，而 `线索成交率` 已存在、已验证、已被检索到（`retrievedPages` 含该页），这道门不会开；它的介入点也在 Agent Loop 启动之前。

**S2 枚举清理删掉了渠道字典** —— 用迁移前备份比对：`source_data_channel` 不命中命名黑名单（实测 `regex.test = false`），5 个枚举值迁移前后完全一致。`alpha_crm_channel` 在 S2 之前就只有 `email` 与 `is_deleted` 两列枚举，**从来没有过 `channel_name` 字典**。

**S1–S9 引入了意图解析回归** —— `git diff 8c19bf7..HEAD` 对 `query-intent.mjs` 仅 2 行改动（给两个 ambiguity 补 `sourceText`），`knowledge-retrieval.mjs` 与 `query-scope-coverage.mjs` 未改。时间角色推导逻辑是既有行为。

## 附带发现：S2 迁移有一处过度删除（与本次故障无关，但是我引入的）

494 个被删列里，有 **151 个是“小维表（≤1 万行）+ 名称列”**，其中相当一部分按 S1 自己的基数比规则本应是合法业务字典：

| 被删列 | 去重值 / 表行数 | 基数比 | S1 规则判定 |
|---|---|---|---|
| `alpha_office_director.seller_name` | 20 / 4284 | 0.005 | 本应登记 |
| `alpha_nps_user_feedback.processing_user_name` | 19 / 2634 | 0.007 | 本应登记 |
| `counsel_operation.group_name` | 20 / 437 | 0.046 | 本应登记 |
| `live_course.lecturer_name` | 19 / 373 | 0.051 | 确应拒绝 |
| `…rating_current.department_name` | 19 / 40 | 0.475 | 确应拒绝 |

原因是我当时“首版只按命名黑名单清理存量、不按基数比清理”的取舍——黑名单一刀切，让基数比这个更准确的判据没机会生效。后果是削弱了按名称过滤的能力。修法：存量清理改为黑名单与基数比联合判定，对小维表名称列恢复登记。

## 修复建议（按治本程度排序）

1. **让指标页结构化声明周期列，并让解析器采纳它**（根因）。周期列不该靠正则从散文里猜。给指标页一个可解析的显式声明位，让 `metricDefinition` 携带 `periodColumn` 与 `timeRole`；多角色命中时以显式声明为准而不是放弃推导。显式声明存在时必须压过问句字面量。影响所有比例指标。
2. **多角色命中时登记为歧义，而不是静默清空**（根因，改动小见效快）。即使暂不做第 1 项，`roles.length !== 1` 也应产生一条 `TIME_ROLE_AMBIGUOUS`，让澄清链路问“按进线月还是成交月”。当前把残缺契约直接放进执行阶段，这才是 `ambiguities: []` 的由来。
3. **从列注释引导枚举含义，并生成消歧问题**。把 `2:抖音` 这类注释映射解析为**候选**含义（候选而非直接采信），再为高频枚举列生成消歧问题让 editor 一次确认。确认后 `meaning_source=human`，绑定链路即可打通。同时补上采样未覆盖值的处理。
4. **为渠道维度建立已验证的取值映射**。指标页已指明走 `alpha_crm_channel.channel_name`，JOIN 关系已 confirmed，缺的是把“抖音”绑到维表取值的映射（术语页或维度映射）。这条路比给大表补枚举字典更稳：`alpha_crm_clue` 有 737,296 行，采样永远覆盖不全，S1 之后重跑探查该列字典本就会消失。
5. **拒答文案不得泄漏内部分面 ID**。同一问题在 8-27 的审计 #89 报的是 `filter:channel:0`，把业务缺口暴露成内部标识。S5 已做 `missingAssets` 脱敏透出，这条路径应复用它。
6. **回补 S2 过度删除的小维表名称字典**。存量清理改为黑名单 + 基数比联合判定，并重跑一次数据源探查。

## 复核方法

- 审计轨迹与意图快照：`ds_audit` 的 `id=90` 行（`tool_trace_json` / `intent_json`）
- 时间角色缺陷：本地用该页真实定义文本调用 `knowledgeIntentConcepts`，得 `timeRole: null`
- 枚举含义覆盖率：`SELECT COUNT(*) FROM ds_enum WHERE source_id=2 AND COALESCE(meaning,'')<>''` → 0
- S2 影响面比对：备份 `~/apps/platform.sqlite.bak-v9-20260828101516`（宿主机只读方式）

## 过程瑕疵说明

排查中我曾为对比备份库，向生产数据目录 `runtime/data/` 复制过一份 62 MB 备份副本，且清理命令因 SSH 连接中断未执行到。重连后已删除该文件，并确认容器全程 `Up (healthy)` 未重启、生产库未被触碰。后续比对改用宿主机只读方式完成。
