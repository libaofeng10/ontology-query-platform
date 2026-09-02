# 语义契约完整性 · 修复方案

配套根因报告：[RCA_CONVERSION_RATE_REFUSAL_20260828.md](./RCA_CONVERSION_RATE_REFUSAL_20260828.md)（本次故障的证据链在那里，本文只讲通用修复）。

本文不是"修好成交率这个问题"，而是修**知识页声明与意图契约之间的传递链路**。该链路是平台的通用基础设施：任何数据源、任何指标、任何维度过滤都走它。故障只是它第一次被看见。

## 一、问题抽象：五类缺陷，不是一个 bug

本次故障暴露的不是单点错误。把它抽象成类别后，每一类在代码里都能找到第二个实例——这是必须按类别修而不是按现象修的依据。

### A 类 · 静默降级：推导失败被当作"无约束"

推导函数用 `null` 同时表达两件语义相反的事：**"确实不涉及"** 和 **"没能算出来"**。下游把 `null` 一律当作前者，于是约束消失、更低优先级的信号（问句字面量）胜出。

已核实的两个实例：

| 位置 | 失败方式 | 下游后果 |
|---|---|---|
| `query-intent.mjs:155-156` | 定义文本命中 2 个时间角色 → `roles.length===1` 不成立 → `timeRole=null` | 指标自身时间角色为空，问句"成交"字面量成为唯一信号 |
| `query-intent.mjs:1333` `inferKnowledgeGrain` | 正则不匹配 → 返回 `null` | `MEASURE_GRAIN_AMBIGUOUS` 只在 `grain==="unknown"` 时触发（:113），`null` 不触发，COUNT(*) 护栏被绕过 |

生产实测：3 个已验证 metric 页（跨 2 个数据源），**3 个都带推导缺陷**，且审计 #90 的 `ambiguities` 为 `[]`——残缺契约直接进入执行阶段，澄清机制完全没有机会介入。

**这一类最危险的地方不是拒答，而是错答。** 本次之所以拒答，是因为页面公式结构与问句字面量正好冲突、被护栏抓住。若问法换成"本月成交率"（不含与页面口径冲突的措辞），错误的时间绑定就可能通过护栏，产出一个在错误 cohort 上计算的数字，且没有任何告警。

### B 类 · 权威优先级倒置：已验证声明输给字面量匹配

指标页明确写了"统计周期固定绑定 `alpha_crm_clue.clue_create_time`"，这是 `verified=true`、有 owner 的权威声明。系统最终执行的却是页面 `antiExamples` 里明令禁止的那条绑定。

两个成因叠加：一是 A 类导致声明被丢弃；二是**证据等级在合并意图时没有被强制执行**——`intent.timeRole` 来自问句字面量，却能决定一个由 `verified_knowledge` 支撑的 measure 的时间口径。

更深一层：**知识页用散文表达约束**。散文对人友好，对解析器不可靠，而且越严谨越容易出错——这份定义为把口径讲清楚同时用了"进线"和"成交"，命中两个角色因而被判"说不清"。靠加正则去救是错的方向：它把偶然生效当成机制。

### C 类 · 校验不对称：机器写入被严格校验，人工写入完全不校验

| 写入路径 | 校验 |
|---|---|
| S8 机器提议 `validateDraftPage` | 概念可推导、必须 ratio、公式可解析、谓词绑定不为 unsupported、时间角色非空、**原问题回环重解析** |
| 人工保存 `knowledge-service.validatePage` | 仅 pageType / title / slug / sqlContent 非空 / verified 页必须有 owner。**零语义校验** |

方向是反的：人工写的才是权威页。当前"保存成功 + verified ✓"完全不代表这一页在消费期可用，缺陷要等到用户提问被拒才暴露。

### D 类 · 目录语义搁置 + 系统从未提问

`source_data_channel` 的列注释完整写着 `2:抖音`，语义信息齐备但从未被解析。而值绑定要求 `meaning_source ∈ verified/human/...`——生产实测 6935 行枚举**带含义 0 行**、枚举消歧问题 **0 条**。

**系统要求一个从未向任何人索取过的确认。** 这是死锁，不是数据缺失。

还有第二层：该列已登记枚举值只有 `-1,0,1,3,4`，"抖音"对应的 `2` 不在字典里。`alpha_crm_clue` 有 737,296 行而采样上限 10,000，S1 之后这张表的枚举字典本就不该存在。**所以值绑定必须有一条不依赖枚举字典的路径**，否则大表上的维度过滤永久不可用。

### E 类 · 知识健康度不可见

3/3 已验证指标页带缺陷而无人知晓。UI 上它们都是"已验证"。S6/S7 建的缺口看板是**反应式**的——从拒答审计倒推；缺一个**主动式**的页面健康检查。

### F 类 · 内部标识泄漏

审计 #89 的拒答文案是 `filter:channel:0`，把内部分面 ID 暴露给用户。S5 已建 `missingAssets` 脱敏机制，这条路径没复用。

## 二、设计原则

方案要满足的不变量，按优先级：

1. **推导结果三态，永不用 `null` 表达失败。** `确定` / `不适用` / `未确定`。任何必需分面处于"未确定"必须产生 blocking 歧义，绝不静默通过。
2. **声明优于推导，推导优于字面量。** 证据等级 `declared_knowledge > ontology > catalog > question_literal` 在合并意图时强制执行。低等级信号可以在高等级声明的候选项中**选择**，永不**覆盖**。
3. **契约用结构化字段表达，散文只面向人。** 权威约束必须机器可读，不靠自然语言推断。
4. **写入期校验与消费期推导用同一套断言。** 所有写入路径（人工、机器提议、Markdown 同步）共用一个校验器。
5. **系统必须主动索取它所要求的确认。** 任何"需要人工确认才能生效"的机制，必须自带生成待确认项的能力。
6. **值绑定不得唯一依赖枚举字典。** 大表字典必然不完整，维表 + 已确认 JOIN 是必备的第二条路径。
7. **通用而非领域特化。** 不硬编码任何业务词（成交率/抖音/渠道）。所有机制对任意数据源、任意指标、任意维度成立。

**明确拒绝的方向：** 给 `TIME_ROLE_CONCEPTS` 加正则、给多角色命中定优先级、为"进线 cohort"加特例分支。这些能让本次问题消失，但把偶然生效当机制，且会让 A 类缺陷继续在别处产生新实例。

## 三、分层方案

### L0 · 推导结果三态化（基础层，其余各层依赖）

把推导返回值从裸值改为带状态的结果对象：

```js
{value:"entry", status:"declared",     source:"metric:clue_conversion_rate"}
{value:"entry", status:"inferred",     confidence:"single_match"}
{value:null,    status:"not_applicable"}
{value:null,    status:"undetermined", reason:"multiple_roles_matched",
                candidates:["entry","completion"]}
```

消费侧统一规则：`undetermined` 出现在必需分面 → 产生 blocking 歧义，`candidates` 直接作为澄清选项。

一处改动同时消灭 timeRole 与 grain 两个实例，并让后续新增推导无法再犯同类错误——这是 L0 排在最前的理由。

**兼容性**：对外形状保持 `intent.timeRole.value` 可读，避免大面积改调用点；`grain` 的 `null`/`"unknown"` 二义性一并收敛。

### L1 · 知识页结构化声明 + 权威优先级

**L1a 结构化声明位。** 知识页增加可解析的声明块，承载 `periodColumn`、`timeRole`、`grain`、`allowedDimensions`。散文 `content` 保留给人阅读，声明块才是契约。有声明 → `status:"declared"`；无声明 → 退回散文推导 `status:"inferred"`。存量页零改动即可继续工作。

**L1b `metricDefinition` 承载周期列。** 当前实测只有 `aggregation/columns/tables/source/formula` 五个字段，没有任何位置放周期列——这是"声明无处可去"的直接原因。补 `periodColumn` 与 `timeRole`。

**L1c 证据等级强制。** 合并意图时，`declared` 级别的分面不可被 `question_literal` 覆盖。问句与声明冲突时（如页面声明 entry、问句暗示 completion）产生 `TIME_ROLE_CONFLICT` 澄清，让用户在"按进线月/按成交月"间选择，而不是让某一方静默胜出。

### L2 · 写入期校验对齐消费期

把 S8 的 `validateDraftPage` 断言提取为共享校验器 `validateKnowledgeSemantics(page, catalog)`，三条写入路径统一调用：人工 `knowledge-service.save`、机器 `knowledge-proposal-service`、Markdown `sync`。

分级处理，避免一刀切打断现有编辑流：

- **硬失败**（拒绝保存为 verified）：公式无法解析、引用不存在的列、谓词绑定 unsupported
- **软告警**（允许保存，标记 `semanticHealth:"degraded"` 并进健康看板）：粒度未确定、时间角色未确定
- **存量页不追溯失效**：3 个既有缺陷页保持可用，标记 degraded 并给出引导修复入口。回环重解析对人工页不做强制（人工页没有"原问题"作为回环输入）。

### L3 · 目录语义提取与值绑定闭环

**L3a 注释映射为候选。** 解析列注释中的 `值:含义` 模式，写入 `meaning` 且 `meaning_source="comment_candidate"`。**候选不参与绑定**——注释可能过期或与实际不符，直接采信会把错误变成权威。

**L3b 主动生成消歧问题。** 为有候选含义、且被查询实际触达的枚举列生成待确认问题。editor 一次确认 → `meaning_source="human"` → 绑定链路打通。这是对原则 5 的落地：系统索取它所要求的确认。

**L3c 维表值绑定路径。** 当 `事实表.dim_id → 维表.dim_id` 为 confirmed 关系、且维表有名称列时，允许通过维表查名绑定业务词。这条路径不依赖枚举字典，是大表维度过滤唯一可持续的方案，也正是本次指标页 `antiExamples` 指明的做法（"渠道名称必须通过维表精确过滤"）。

### L4 · 知识健康度看板（扩展 S6/S7）

对每个 verified 页运行消费期推导并报告缺陷，与 S6 的缺口看板同一个面板（S7 已建 UI，复用其门禁与排序）。同时暴露枚举含义覆盖率、未回答的消歧问题数。

反应式（拒答倒推）+ 主动式（页面体检）两条线合并，才是完整的治理闭环。

### L5 · 拒答可诊断性

拒答文案必须指向**失败的层**和**可执行的动作**：不是"时间范围必须绑定 completion"，而是"指标页『线索成交率』声明的统计周期无法解析，请在页面补充周期列声明"。复用 S5 的 `missingAssets` 脱敏机制，增补 `declarationDefects`；任何内部分面 ID（`filter:channel:0` 形态）不得出现在用户可见文案。

### L6 · 回补 S2 过度删除（我引入的回退）

存量枚举清理改为**命名黑名单与基数比联合判定**：命中黑名单但基数比证明其为合法业务字典（如 `alpha_office_director.seller_name` 20/4284=0.005）的小维表名称列应予保留。当前 494 个被删列中有 151 个是"小维表 + 名称列"，其中相当一部分本应登记。需重跑一次数据源探查恢复。

与本次故障无关，但削弱了按名称过滤的能力。

## 四、实施步骤

每步独立提交、独立回归，提交前跑全量 `npm test`（当前基线 421 passed）。

### T1 · 推导三态化（L0）

**改** `query-intent.mjs`：引入 `derivation(value, status, meta)` 构造器；`knowledgeIntentConcepts` 的 `timeRole`、`inferKnowledgeGrain` 的返回值改为三态；`parseQueryIntent` 对必需分面的 `undetermined` 产生 blocking 歧义（`TIME_ROLE_UNDETERMINED`、`MEASURE_GRAIN_UNDETERMINED`），`candidates` 作为澄清选项。收敛 `grain` 的 `null`/`"unknown"` 二义性。

**验收**：多角色命中的定义产生 `undetermined` 且带两个候选，不再是 `null`；该页参与的问题产生 blocking 歧义而非空歧义列表；`grain` 推导失败时 `MEASURE_GRAIN_*` 正常触发（当前不触发）；既有 421 项全绿。

### T2 · 结构化声明与周期列承载（L1a/L1b）

**改** `knowledge-service.mjs`（声明块解析与渲染）、`query-intent.mjs`（`metricDefinition` 补 `periodColumn`/`timeRole`，声明存在时置 `status:"declared"`）。

**验收**：带声明块的页产出 `declared` 状态与正确 `periodColumn`；无声明块的存量页行为与现状完全一致（回归锁定）；声明块可往返（保存→Markdown→sync 回读一致）。

### T3 · 证据等级强制（L1c）

**改** `query-intent.mjs` 意图合并逻辑：`declared` 分面不可被 `question_literal` 覆盖；冲突产生 `TIME_ROLE_CONFLICT` 澄清。

**验收**：页面声明 entry + 问句含"成交"→ 产生澄清而非静默绑定 completion；澄清答复可确定性绑定到两个候选之一；用真实故障问句端到端复现，结果从拒答变为可澄清。

### T4 · 共享语义校验器（L2）

**新增** `knowledge-semantics.mjs`，提取 S8 断言；接入三条写入路径，分硬失败/软告警；页面记录 `semanticHealth`。

**验收**：公式不可解析的 verified 页保存被拒并给出具体原因；粒度未确定的页可保存但标记 degraded；S8 提议路径行为不变（复用同一校验器后测试全绿）；存量 3 个缺陷页不被追溯失效。

### T5 · 枚举语义闭环（L3a/L3b）

**改** `db-probe.mjs`（注释映射解析为 `comment_candidate`）、消歧问题生成逻辑。候选不参与绑定。

**验收**：`2:抖音` 形态注释产出候选含义；候选状态下绑定仍失败（不得自动采信）；生成对应消歧问题；确认后 `meaning_source="human"` 且绑定成功。

### T6 · 维表值绑定路径（L3c）

**改** `knowledge-retrieval.mjs`：confirmed JOIN + 维表名称列 → 允许业务词绑定，不依赖枚举字典。

**验收**：`alpha_crm_clue.channel_id → alpha_crm_channel` 场景下"抖音"可绑定；无 confirmed 关系时不绑定（fail closed）；维表名称列缺失时不绑定；大表无枚举字典也能过滤。

### T7 · 健康看板与拒答诊断（L4/L5）

**扩展** `capability-gap-service.mjs` 增加页面体检维度；`server.mjs` 接口与 S7 面板复用；拒答文案脱敏与动作指向。

**验收**：3 个既有缺陷页出现在看板并给出修复动作；拒答文案不含内部分面 ID（`filter:*:*` 形态）；文案指向具体页面与具体缺失声明。

### T8 · S2 回补（L6）

**改** `enum-catalog-migration.mjs` 为联合判定；需重跑数据源探查。

**验收**：小维表名称列按基数比恢复登记；大表标识列仍被拒绝；迁移幂等。

## 五、风险与取舍

**短期拒答率会上升。** T1 让"未确定"从静默通过变为 blocking 歧义，原先被静默放过的问题会转为需要澄清。这是**有意的方向**：从"可能错答"换成"明确澄清"。必须与 S1/S2 同样的方式观测——同时盯拒答率与错答率，确认上升的是澄清而非死路。若 T2/T3 的声明补齐及时，这个上升是暂态的。

**T3 是行为变更而非纯修复。** 问句与页面声明冲突时，现在会打断并询问。对已习惯"问了就有数"的用户是体验变化，需要在文案上把"为什么问"说清楚。

**T2 声明块是新的页面契约。** 需要迁移引导，否则会出现"老页面没声明、新页面有声明"的长期双轨。建议在健康看板里把"缺声明"作为 degraded 项持续提示，而非强制一次性改造。

**T5/T6 扩大了绑定面。** 值绑定路径变多，护栏的"额外筛选"判定要同步收紧，避免新路径成为绕过意图契约的后门。每条新路径都必须能追溯到 confirmed 证据。

**顺序不可随意调整。** T1 是其余各步的地基；T3 依赖 T2 的声明位；T6 的护栏放宽依赖 T4 的校验器已经就位。T5/T6 与 T2/T3 之间无依赖，可并行。

## 六、不在本方案范围

- 不改 Agent Loop 的推理策略与护栏判据。本次排查确认 Loop 与护栏行为正确，问题在其上游的意图契约。
- 不改语义层/本体建模。本次故障未涉及已发布 Ontology Schema 的正确性。
- 不为特定业务概念加特例。任何只对"成交率""渠道"生效的改动都不接受。
- 不追溯重算历史审计。历史行由 S6 的退化路径兜底。
