# 指标口径提议流程 + 知识缺口看板

## Context

当前当问题包含比例指标（如"成交率"）而数据源没有已验证的 metric 知识页时，`parseQueryIntent` 产生 blocking 歧义 `MEASURE_DEFINITION_REQUIRED`（server/src/query-intent.mjs:127）。该 code 不在可澄清白名单 `RESOLVABLE_INTENT_AMBIGUITIES`（query-agent-loop.mjs:923-928）中，系统在第一次 LLM 调用前直接安全拒答，且拒答给出的两个选项（"选择已登记指标口径/先补充指标定义"）在对话内都是死路。更深层的问题：知识缺口只有在用户撞上拒答时才暴露——rock_readonly 有 625 条"已验证知识"（623 条 JOIN + 2 条术语），但指标覆盖为 0，此前无人知晓。

### 审计数据校准（决定了三期的排序）

对真实库 `/Users/libaofeng/ontology/platform.sqlite`（注意：仓库内 `.data/platform.sqlite` 是 8/12 的陈旧副本，无 knowledge 表，不可用于核查）实测 59 条 `ds_audit`：

| 真实拒答/失败原因 | 条数 |
| --- | --- |
| 白名单表/字段不覆盖（找不到线索主表、无可按律所名过滤的字段） | 3 |
| 枚举字典问题（`alp_cell` 手机号、`city` 字典值缺失） | 3 |
| 没有已发布 Ontology Schema（语义强制模式） | 2 |
| Agent 工具协议格式错误（空工具名、缺 thought） | 2 |
| demo 覆盖域外 | 1 |

关键校准结论：

- `intent_json LIKE '%MEASURE_DEFINITION_REQUIRED%'` 命中 **0 条**——Phase 1 修的是一条真实存在的设计死路（拒答给出的两个选项在对话内都走不通），但它不是用户当前撞得最多的墙，不应排在第一位。
- 当前第一大类是检索覆盖不足与枚举误判，二者都可以用确定性手段修复，无需 LLM。
- `intent_json` 仅 4/59 条非空（见下方"核心机制事实"修订），Phase 2 若直接按原 spec 实现，上线当天看板只有 2 个缺口。

### 三期结构

- **Phase 0 确定性修复（前置）**：修枚举字典判定、Agent 工具格式一次性重试、审计 intent 字段回填、首页覆盖计数器、拒答卡片具体化。全部不碰 LLM、有历史数据背书，合计覆盖当前约 40% 的失败案例，且其中的 intent 回填是 Phase 2 的硬前置。
- **Phase 1 口径提议流程**（被动闭环）：editor+ 用户遇到该拒答时，系统改为**确定性圈定候选列 → LLM 组合 1-3 个口径提议 → 服务端校验 → 澄清卡片让用户选择 → 确认即落成 verified 知识页（owner=确认人）→ 用原问题自动重查**。非 editor、开关关闭、提议失败时行为与现状完全一致（fail-closed 不放松）。**接口按 `kind` 泛化**（metric 先落地，term/字段映射沿用同一骨架），因为历史第一大缺口不是指标。
- **Phase 2 知识缺口看板**（主动闭环，借鉴 Semantica 的 Competency Questions 概念）：把历史拒答聚合成"当前本体答不了的能力问题"清单，按频次排序、标注缺什么资产、一键跳转补齐。Phase 1 确认口径 = 自动关闭 Phase 2 的一个缺口（缺口状态由当前知识库实时推导，无联动代码）。

执行顺序：Phase 0 → Phase 2 → Phase 1。Phase 2 提前到 Phase 1 之前，因为它依赖的只有 Phase 0 的 intent 回填，且能先把真实缺口排序暴露出来，用于校准 Phase 1 该优先支持哪个 `kind`。

已拍板的产品决策：**确认即验证**（无草稿态）；**仅 editor 及以上**可确认。

## 核心机制事实（已核验）

- `ask()` 每次调用都重新 `store.listKnowledge` + `knowledgeIntentConcepts` + `parseQueryIntent`（query-service.mjs:332-394），所以落库后重查即生效。
- 现有 pending/resume 澄清机制：`pendingLoops`/`pendingBySession`（query-service.mjs:20,256-262），答案经 `POST /api/query {pendingId}` → `resumePending`（:292-306）。前端 `ClarificationCard` + `continueQuestion` 已支持选项按钮和自由文本（app/platform-app.tsx:154-157，api.ts:20）。
- 旧 agent loop 的 resume 闭包快照了 catalog（query-agent-loop.mjs:69），中途落库的知识页对它不可见 → 确认后**不能续旧 loop，必须内部重发 ask()**。
- `pauseForIntentClarification` 不跑 `clarificationContentError`（该校验只在模型 ask_user 处 :571），harness 生成的澄清内容不被硬拦，但自我约束同样规则（选项 ≤5、≤100 字符、无 SQL/物理表名）。
- 拒答可能发生在两处，hook 必须放在 ask() 内、两处之前：`missingRequiredRetrievalFacets` 拒答（query-service.mjs:73-78）和 agent loop 的 `intentFailureOutcome`（query-agent-loop.mjs:145-147）。
- server.mjs 目前只传 `userName`（:138,:162），角色需要新增透传 `identity.role`。
- 校验提议不需要导出 query-intent 私有函数：`knowledgeIntentConcepts([draftPage], allColumns)`（已导出）即是生产推导路径。在 `8c19bf7` 上其产出字段为 `kind/value/aliases/aggregation/grain/timeRole/terms/evidence/metricDefinition`（query-intent.mjs:152-174）——**不含 `subjects`**，时间角色为内联的 `roles.length===1` 判断而非独立函数。提议校验的断言只能建立在这几个字段上。
- `rankFacetColumns/rankFacetTables` 未导出，但 `context.retrieval.diagnostics.facets` 已携带排名结果，从那里取候选表列。
- `ds_audit` 表已有 `verdict`、`fail_reason`、`failure_class`、`intent_json` 列，`store.listAudits(sourceId, limit)` 可读（store.mjs:447）。**但 `intent_json` 实际只有 4/59 条非空**：query-service.mjs 中 LLM 未配置（:45）、ranking 限制（:57）、semantic 强制（:64）等提前返回的 `addAudit` 都没有展开 `...auditContext`，agent loop 内部拒答路径同样缺失。→ Phase 2 无需新增表，但**必须先由 Phase 0 回填写路径**，否则看板无数据。
- `verdict='clarified'`（query-service.mjs:259 会写入）在真实库里 `SELECT DISTINCT verdict` **查不到**——只有 passed/refused/failed。说明 pending/resume 澄清链路在该数据源上从未真实跑通。Phase 1 整个架在这条链路上，因此第一个测试应是澄清往返的端到端回归，而非提议逻辑本身。
- `db-probe.mjs:31` 的枚举判据只有 `rows.length <= maxEnumValues`（默认 20），样本为 `LIMIT 10000`，**无基数比校验、不与表总行数对照**。实测真实库有 2683 个列被登记为枚举，其中 592 个列名含 `_id`/`name`/`time`/`cell`，仅 15 列触到 20 值上限。
- `POST /api/eval/cases`（server.mjs:143，editor 门禁）与 `evaluation.create(sourceId, input)`（evaluation-service.mjs:8）已存在，可直接被口径确认动作复用。

## Phase 0 改动：确定性修复（前置，不涉及 LLM）

### 0.1 枚举字典判定收紧 `server/src/db-probe.mjs`

治的是**查询期护栏误拒**：手机号列 `alp_cell` 在多张 `alpha_user_*` 分表里各被登记为"只有 1 个合法值的枚举"，用户查 `13774665233` 时护栏判定"字典外取值"直接失败（audit 34 failed、24 refused）。源头在建模期探查，症状在查询期护栏。

改 `probeTable`（:14-35）的枚举登记判据，三个条件全部满足才写 `item.enums`：

- **字典完整性**：`estimatedRows > 0 && estimatedRows <= sampleLimit`——样本未覆盖全表时不得声明"完整字典"（沿用 :20 已有的 `lastWrite` 同类判断）。超出时可保留 `cardinality` 供排名使用，但 `enums` 留空。
- **基数比**：`rows.length / Math.min(estimatedRows, sampleLimit)` 低于阈值（`enumMaxDistinctRatio`，默认 0.05）才算枚举，避免小表上每行一个值也被当字典。
- **命名黑名单**：列名命中 `/(_id|_no|_code|cell|phone|mobile|email|name|time|date|_at)$/i` 时不登记枚举——这类列即使样本去重值少也不是业务字典。复用 `query-result-probe.mjs:3` 的 `GENERIC_TOKENS` 词表思路，新增常量避免跨模块耦合。

`config.mjs` 新增 `enumMaxDistinctRatio`（env `ENUM_MAX_DISTINCT_RATIO`，默认 0.05）；`settings-service.mjs` GROUPS.discovery 注册。

**存量数据清理**：新增一次性迁移（`sensitive-catalog-migration.mjs` 同模式），删除 `ds_enum` 中命中命名黑名单的行，并在 `ds_column` 上把对应 `cardinality` 保留、枚举标记清除。迁移必须幂等且只删枚举字典、不动列元数据。

`city` 那条拒答（audit 55：判成枚举但白名单未下发字典值）是另一个方向的问题——先加诊断日志确认是检索预算截断还是下发遗漏，再决定修点，本期不盲改。

### 0.2 Agent 工具协议格式的一次性重试 `server/src/query-agent-loop.mjs`

两条 failed 是"LLM 请求了未授权工具：空工具名"和"LLM 工具动作缺少 thought"——纯格式违规，却让整次查询作废。

- 在工具动作解析处（现抛错即终止的分支）区分**协议格式错误**（空工具名、缺 thought、JSON 结构不符）与**语义违规**（请求了不存在/未授权的具体工具、越权参数）。仅前者可重试。
- 每次查询最多一次格式重试，计数独立于 `iterations` 预算（否则一次笔误吃掉一轮推理预算），但仍受总 token/时间预算约束。重发消息只追加确定性的格式纠正说明（"上一次动作缺少 thought 字段，请按契约重发"），**不追加任何新的表、字段、工具授权**——护栏一寸不放松。
- trace 里记 `{tool:"protocol_retry", reason}`，SSE 同步，便于评测统计重试率。
- 语义违规保持现状立即终止。

### 0.3 审计 intent 字段回填 `server/src/query-service.mjs`（Phase 2 硬前置）

`intent_json` 覆盖率 4/59 的直接原因是部分 `addAudit` 没带 intent 字段。改动：

- 把 :45 / :57 / :64 三处提前返回的 `addAudit` 补上 `...auditContext`（:68 / :76 已有，照抄即可）。:45 在 `buildContext` 之前返回，无 intent 可写——保留现状但补 `failureClass:"llm_unconfigured"`，让 Phase 2 能按 failure_class 归类。
- agent loop 内部的拒答/失败路径（:108 的 agent fallback、:286 的 refused）同样补齐 intent 字段。
- 顺带统一 `failureClass`：当前只有 `retrieval_miss` / `schema_gap` / `execution_error` 三个值在用，新增 `llm_unconfigured` / `ontology_missing` / `protocol_error` / `enum_dictionary`，Phase 2 的缺口归类直接依赖它。

不改表结构、不回溯历史行（老行 `intent_json` 为空由 Phase 2 的退化路径处理）。

### 0.4 首页覆盖计数器 `app/platform-app.tsx:88`

`const verified=knowledge.filter((page)=>page.verified).length` 把 623 条 JOIN 与 2 条术语合并成 625，:147 展示为"基于 625 个已验证知识条目"——这正是"覆盖看起来很好、指标覆盖实际为 0"的认知偏差来源，也是本次问题被延迟发现的原因。

改为按 `pageType` 分类展示（如"术语 2 · 指标 0 · JOIN 623"），逻辑与知识资产页 :222 已有的分类统计一致，抽一个共用的 `coverageByType(pages)` helper 避免两处口径漂移。指标为 0 时该项以警示色显示。

### 0.5 拒答卡片具体化 `app/platform-app.tsx` QueryRefusalCard（:159）

现在拒答只显示笼统的"请先补充业务术语"，而后端此刻已经知道缺什么（`intent.ambiguities[].sourceText`、`missingFacets`、`failureClass`）。

- `publicQueryResult`（server.mjs:192）在拒答响应中透出**已脱敏的缺口摘要**：`{missingAssets:[{kind:"metric", label:"成交率"}], failureClass}`。只暴露业务词，不含物理表名/列名（与现有拒答文案的脱敏口径一致）。
- 卡片按 kind 渲染具体文案（"缺少『成交率』的指标定义"），并按角色分叉：editor+ 给预填跳转（`openNew` + `pageType` + 标题，与 Phase 2 的 remedy prefill 同一套参数）；analyst/viewer 给"通知知识负责人"（v1 仅复制缺口描述到剪贴板，不新增通知链路）。
- `app/types.ts` 的 `QueryRefusal`（:37）加可选 `missingAssets`，前端对缺字段做兜底，保证与旧响应兼容。

## Phase 1 改动：口径提议流程

### 1. 新模块 `server/src/metric-proposal-service.mjs`

```js
export function createKnowledgeProposalService({store, config, knowledge, evaluation}) {
  return {propose, confirmProposal};   // propose(kind, {context, question, ...})
}
export const _internal = {shortlistCandidates, proposalMessages, composeDraftPage,
                          validateDraftPage, buildClarification, matchProposalAnswer};
```

**按 kind 泛化**（审计校准的直接结论）：历史第一大缺口是检索覆盖不足，`MEASURE_DEFINITION_REQUIRED` 出现 0 次。因此 `propose(kind, ...)` 以 kind 为第一参数，v1 只实现 `kind:"metric"`，未实现的 kind 返回 null 走原拒答。骨架（确定性圈定候选 → LLM 只出结构化结果 → 服务端回环校验 → 澄清确认 → 落库重查）对 `kind:"term"` / `kind:"property_mapping"` 完全复用，差异只在 shortlist 词表、draft 渲染模板和校验断言三处，各自拆成 `KIND_HANDLERS[kind]` 的成员。pending 记录用 `kind:"knowledge_proposal"` + `proposalKind:"metric"`，避免 metric 焊死在 pending 类型里。文件名与服务名都不带 metric 字样，省掉后续改名。

- **shortlistCandidates（确定性，无 LLM）**：从 `context.retrieval.diagnostics.facets` 取主体/指标分面的候选表（≤6，限 `context.tables` 白名单）；分子事件列用小词表（成单/成交/赢单/won/is_win_order/completed…）扫列名+注释，附 `context.enumItemsByColumn` 的枚举含义；分母/去重列取主键/unique/`*_id`；时间列取 datetime 且命中 TIME_ROLE 词表的列并标注角色；JOIN 路径取 `context.relations`（已 confirmed）。排除 `isSensitive` 列。
- **LLM 提议**：`callLlmJson(config.llm, messages, {timeoutMs, signal})`，prompt 模式照抄 `objectGenerationMessages`（ontology-candidate-generator.mjs:116-147）：untrusted_input 包裹、敏感注释脱敏、内联 JSON 契约。**LLM 只输出结构化公式**（numerator/denominator 的 aggregation/distinct/column/predicates、timeColumn、timeRole、业务描述、optionLabel），**SQL 和 content 由 harness 模板渲染**（`composeDraftPage`）——从构造上保证 `inferKnowledgeRatioFormula` 可解析：顶层 `/`、聚合体内 `CASE WHEN pred THEN col END`、仅 AND 谓词、FROM/JOIN 别名可解析、不写时间字面量（时间口径写进 content 的"统计周期：…"声明，且恰好一个时间角色）。aliases 必须包含问题里的指标原文（measure.sourceText）。
- **白名单规范化**：引用列必须在 shortlist 中、JOIN 必须是 confirmed 关系，违反即丢弃；optionLabel ≤100 字符、不含表名/SQL 关键词（复用 clarificationContentError 的正则思路），不合格则从 description 确定性生成，重名加"口径1/2"后缀。
- **validateDraftPage**：① `knowledgeIntentConcepts([draft], allColumns)` 断言 aggregation==="ratio"、formula 非空、分子分母 predicateBinding!=="unsupported"、timeRole 非空；② 端到端回环：`parseQueryIntent(原问题, {concepts: knowledgeIntentConcepts([...现有页, draft], allColumns), ...parseOptions})` 断言 `MEASURE_DEFINITION_REQUIRED` 和 `METRIC_AMBIGUOUS` 消失。失败即丢弃，最多保留 3 个。
- **confirmProposal**：`knowledge.save(sourceId, {pageType:"metric", title, aliases, tables, content, sqlContent, antiExamples, verified:true, owner:userName})`（knowledge-service.mjs:31-44，verified 强制 owner）。保存前查 `store.getKnowledge` 防 slug 撞已验证页（撞未验证页则加后缀）。保存成功后**顺手 `evaluation.create(sourceId, {question: pending.question, category:"口径确认", heldOut:0})`**——goldSql 留空，跑语义门禁时自然按"无金标"处理。这是唯一一次拿到"业务认可的问题 + 口径"配对的时机，后续口径被改动时评测门禁能发现回归；失败不阻断主流程（try/catch，失败仅告警）。

### 2. Hook：`server/src/query-service.mjs`

- `createQueryService` 新增依赖 `knowledge`、`evaluation`；实例化 `knowledgeProposals`。注意 server.mjs 里 `evaluation` 在 `queries` 之后构造（:56 依赖 queries），存在循环——用惰性 getter（`{get evaluation(){return evaluation;}}`）或在 :56 之后回填注入，避免改动构造顺序。
- `ask()` 新增参数 `userRole="viewer"`、内部参数 `_skipMetricProposal=false`（server.mjs 显式传字段，HTTP 无法注入）。
- `buildContext` 返回值补充暴露 `parseOptions`、`allColumns`、`knowledgePages`（:393）。
- **拦截点：`missingRetrievalFacets` 拒答块（:73-78）之前**（在 coverage==="none" 拒答之后）：
  - 触发条件：`config.metricProposalEnabled` && `!_skipMetricProposal` && role≥editor && 存在 blocking `MEASURE_DEFINITION_REQUIRED` && 缺失分面全部归属未验证 ratio 指标（若还缺主体/时间/过滤分面则走原拒答——metric 页救不了）。
  - `tryMetricProposal()`：propose → 无有效提议返回 null 走原拒答（failReason 追加"；已尝试自动提议指标口径：<原因>"）；有提议则构造澄清 `{question:"「成交率」还没有已验证的指标定义。请确认应采用的业务口径：", options:[...optionLabels, "都不对，暂不定义"], allowFreeText:true}`，照抄 `finalizeAgentOutcome` 的 pending 簿记（invalidatePendingSession、randomUUID、TTL=queryAgentPendingTtlMs、audit verdict:"clarified"、SSE 事件 tool:"propose_metric_definition"），pending 记录 `{kind:"metric_proposal", question原文, sourceId, sessionId, userName, userRole, proposals(含完整SQL), trace, expiresAt}`。响应形状与现有 `QueryClarification` 完全一致 → **前端零改动**。
- **`resumePending`（:292）分支**：`pending.kind==="metric_proposal"` → `resumeMetricProposal`：
  - `matchProposalAnswer`：精确匹配选项→该提议；"都不对/不确认/暂不/放弃/取消"→拒答（与现 intentFailureOutcome 同文案，errorCode:"MEASURE_DEFINITION_REQUIRED"）；其他自由文本→v1 也按拒绝处理并提示可手工建页（re-propose 留 v2）。
  - 确认：`confirmProposal` try/catch（失败→audit "failed"、拒答"保存指标定义失败：…"）；成功追加 trace `{tool:"save_metric_definition"}` 并发 SSE。
  - **重查**：`ask({sourceId, question: pending.question, userName, userRole, sessionId, _skipMetricProposal:true, signal, onEvent})`，返回前 `result._sessionQuestion ??= pending.question`（保证会话记录原问题而非"口径1"）。重查产生的新澄清会注册自己的 pending，链式澄清天然成立。
  - **循环护栏**：`_skipMetricProposal` 保证二次 `MEASURE_DEFINITION_REQUIRED` 走普通拒答；resume 包装层检测该情况并包裹诊断文案（"已保存指标页但重新解析仍未命中……请人工检查"）。

### 3. 角色透传与开关

- `server.mjs:138` 和 `:162`：`queries.ask({..., userRole: identity.role})`；`:55` 传入 `knowledge`；`lockedSettingKeys`（:182）加 `metricProposalEnabled`。
- `config.mjs`：`metricProposalEnabled`（env `METRIC_PROPOSAL_ENABLED`，**默认 false**，与 queryAgentMode 保守默认一致）。
- `settings-service.mjs` GROUPS.query 注册该键。

### 4. 边界情况

- LLM 超时/坏 JSON/零有效提议 → 不建 pending，退回原拒答（加注原因）。
- 一个问题多个未验证 ratio 指标 → v1 只提议第一个；确认后重查若还缺第二个 → 普通拒答列出剩余指标。
- TTL 过期 410、新问题 invalidatePendingSession、resume 身份 403 —— 全部复用现有机制不动。
- demo 数据源在 :36-41 提前返回，不可达。

## Phase 2 改动：知识缺口看板（Competency Questions 借鉴）

### 5. 新模块 `server/src/capability-gap-service.mjs`

```js
export function createCapabilityGapService({store}) { return {listGaps}; }
export const _internal = {aggregateGaps, gapKey, gapRemedy, gapStatus};
```

- **listGaps(sourceId, {limit=500})**：读 `store.listAudits(sourceId, limit)`，取 `verdict in ("refused","failed")` 且 `intent_json` 含 blocking 歧义的行，解析 `intentJson.ambiguities`，聚合成缺口列表。纯读、实时计算，不落新表（v1 数据量在数百条审计内可接受；后续量大再物化）。
- **gapKey（分组键）**：优先 `ambiguity.code + "|" + 归一化资产标识`。资产标识按 code 取语义：`MEASURE_DEFINITION_REQUIRED`/`METRIC_AMBIGUOUS` → measure 的 sourceText（如"成交率"）；`FILTER_FIELD_UNKNOWN`/`FILTER_VALUE_BINDING_UNKNOWN` → field/sourceText；`PRODUCT_SCOPE_REGISTRY_REQUIRED` 等 → code 本身。同一口径的多次提问合并为一个缺口。
- **退化路径（必须有，否则看板空）**：`intent_json` 为空的行（历史 55/59 条，以及 Phase 0 之前写入的所有行）不能直接跳过，否则当前第一大类"找不到线索主表"（3 次重复提问）永远进不了看板。退化时用 `failure_class + 归一化 fail_reason` 作为键：`fail_reason` 去掉数字、引号内字面量、表名 token 后取前 60 字符做指纹，`assetLabel` 取 `failureClass` 的中文标签 + 问题里的关键业务词。归一化后的指纹只用于分组，展示仍用 `sampleQuestions` 里的原始问题，避免指纹可读性差。
- Phase 0 落地后新写入的行都带 intent，退化路径的占比会自然衰减，但需长期保留——`llm_unconfigured` 这类在 `buildContext` 之前返回的拒答永远不会有 intent。
- **每个缺口输出**：`{key, code, assetLabel, count, lastAskedAt, sampleQuestions(≤3), remedy, status}`。
- **gapRemedy（缺什么资产）**：code → 建议动作的确定性映射：`MEASURE_DEFINITION_REQUIRED → {action:"create_metric_page", prefill:{pageType:"metric", title:assetLabel}}`；`FILTER_FIELD_UNKNOWN → {action:"publish_ontology_property"}`；`KNOWLEDGE_FILTER_* → {action:"create_term_page"}` 等。前端用 prefill 一键打开对应编辑器。
- **gapStatus（实时闭环判定）**：用当前知识库推导缺口是否已解决——对 `MEASURE_DEFINITION_REQUIRED` 缺口：`knowledgeIntentConcepts(store.listKnowledge(sourceId), columns)` 中存在 verified ratio 概念且其 aliases 归一化后命中 assetLabel → `resolved`；对 filter 类缺口：`catalogFilterConcepts` 中该 field 已有唯一 published 物理映射 → `resolved`；否则 `open`。Phase 1 的 confirmProposal 落库后，对应缺口在下次读取时自动变为 resolved，无需任何联动代码。
- 不重放历史问题、不调 LLM——状态判定只用与 `parseQueryIntent` 相同的确定性推导，成本为零且口径一致。

### 6. 接口与前端

- `server.mjs` 新增 `GET /api/capability-gaps?sourceId=`（editor，`roleAtLeast` 门禁与 audits 一致），返回 `{gaps, generatedAt, auditWindow}`。
- `app/platform-app.tsx` 知识资产页（KnowledgeWorkspace）顶部新增"知识缺口"面板：按 `status==="open"` 优先、count 降序展示（`assetLabel · 被问 N 次 · 最近 <date> · 缺口类型`），行尾按钮按 remedy 跳转——`create_metric_page` 直接 `openNew` 并预填 `pageType:"metric"` 和标题；resolved 的缺口折叠显示（近期已闭环的正反馈）。`app/api.ts` 加 `listCapabilityGaps(sourceId)`；`app/types.ts` 加 `CapabilityGap` 类型。
- 拒答卡片（QueryRefusalCard）不改——它的"补充知识"按钮跳到的知识页现在自带缺口面板，落点更准。

## 验证

- Phase 0 测试：
  1. `server/test/db-probe.test.mjs` 扩充：样本未覆盖全表时不写 `enums`（只留 cardinality）；`alp_cell` 这类命名黑名单列即使去重值为 1 也不登记枚举；基数比超阈值不登记；正常低基数业务字典（如 `clue_status` 3 个值、覆盖全表）仍正常登记。
  2. 存量清理迁移：跑两次结果一致（幂等），只删枚举行不动 `ds_column` 元数据。
  3. `server/test/query-agent-loop.test.mjs` 扩充：缺 thought / 空工具名 → 触发一次 `protocol_retry`，第二次合法则查询成功；连续两次格式错误 → 按现状失败；请求未授权的具体工具 → **不重试**立即终止（护栏不放松）；重试不消耗 `iterations` 预算。
  4. `server/test/query-service.test.mjs` 扩充：ranking 限制、semantic 强制、coverage none、missingFacets 四类拒答写入的审计行 `intent_json` 均非空且 `failureClass` 符合预期；LLM 未配置的拒答 `failureClass==="llm_unconfigured"`。
  5. 前端计数：`coverageByType` 对混合 pageType 返回分类计数，指标为 0 时标记警示；拒答响应缺 `missingAssets` 字段时卡片不崩（旧响应兼容）。
- 新测试 `server/test/knowledge-proposal.test.mjs`（node --test，照 `query-clarification.test.mjs` 的 fixture + `globalThis.fetch` stub 模式）：
  0. **前置回归**：现有 pending/resume 澄清链路端到端跑通一次（`verdict='clarified'` 落库、pendingId 可 resume）——真实库里从未出现过该 verdict，此链路必须先自证可用。
  1. 单元：composeDraftPage 渲染的 SQL 经 `knowledgeIntentConcepts` 推导出 ratio+可解析公式+唯一 timeRole；OR 谓词/未知列被拒。
  2. 单元：shortlist 含赢单标记/去重 id/时间列，敏感列被排除。
  3. 服务级 happy path：editor 提问 → 澄清（N+1 选项，audit clarified）→ 选口径 1 → 重查返回答案，verified metric 页存在且 owner=editor，会话记录原问题。
  4. 角色门禁：analyst 得到现状拒答，fetch stub 无提议调用。
  5. 拒绝路径：选"都不对" → 拒答 errorCode MEASURE_DEFINITION_REQUIRED，无页面落库。
  6. 开关关闭：拒答字段与现状逐字一致。
  7. 循环护栏：确认与重查之间删除页面 → 诊断拒答，不再二次提议。
  8. eval 联动：确认口径后 `store.listEvalCases` 多出一条 question 等于原问题的用例；`evaluation.create` 抛错时确认流程仍成功（仅告警）。
  9. kind 泛化：`propose("term", ...)` 在 v1 返回 null 且走原拒答，不抛错。
- 新测试 `server/test/capability-gaps.test.mjs`：
  1. 聚合：3 条含 `MEASURE_DEFINITION_REQUIRED`（sourceText 成交率）的拒答审计 + 1 条 `FILTER_FIELD_UNKNOWN` → 2 个缺口，count 正确、sampleQuestions ≤3。
  1b. 退化路径：3 条 `intent_json` 为空、`failure_class='schema_gap'`、fail_reason 仅数字/字面量不同的审计 → 归并为 1 个缺口 count=3；展示用原始问题而非指纹。
  2. 闭环：落一个 verified metric 页（alias 含"成交率"）后重新 listGaps → 该缺口 status 变 resolved。
  3. remedy 映射：metric 缺口返回 create_metric_page + prefill 标题。
  4. 权限：analyst 请求 /api/capability-gaps 得 403。
- Phase 0 手工验证：重跑一次数据源探查后，查 `ds_enum` 中 `column_name LIKE '%cell%'` 的行应清零（存量 592 个可疑列同步下降）；以真实手机号 `13774665233` 提问"查询 Alpha 到期时间"应不再因"枚举字段字典外取值"失败；首页应显示分类覆盖且指标项为 0 带警示；随后每条新拒答的 `intent_json` 应非空。
- 手工验证：`METRIC_PROPOSAL_ENABLED=true` 启动，以 editor 身份问"分析一下本月抖音渠道的线索的成交率"，确认口径后应直接返回结果；检查 `.ontology-wiki/wiki/source-2/metrics/` 生成 md 文件；知识页缺口面板中"成交率"缺口应显示为已解决；再以 analyst 身份验证查询提议仍为拒答、缺口接口 403。

## Backlog（治理增强，本期不做）

- 冲突分级与解决策略（Semantica conflicts 借鉴）：KNOWLEDGE_ONTOLOGY_CONFLICT 按严重度分级，低级别进治理队列带建议解法而非阻断，解决动作留痕。
- 资产影响面反查：metric/term 页编辑界面显示"该口径影响过 N 个历史回答"（evidence checksum → audits 反向索引）。
- 本体版本发布 diff 报告 + 受影响知识页/eval 用例清单。
- 双时态属性标注，自动消解"当前负责人 vs 事件发生时负责人"类归属歧义。
- Phase 1 v2：自由文本一轮 re-propose、clarification.detail 多行提议详情、多 ratio 指标批量提议。

## 风险

- shortlist 召回不足（uncovered 指标分面 executionColumns 可能很薄）→ 最坏情况提议全被校验拒掉，干净退回拒答，可接受，后续调优。
- 回环校验用的 parseOptions 不含 buildContext 的 global-rule 不动点迭代，极端情况下与真实重查有偏差 → 循环护栏兜底 + 测试覆盖。
- 缺口聚合实时扫描 audits（v1 上限 500 条），数据量大后需物化或加索引视图；`intent_json` 为空的老审计行走 failure_class 退化路径而非跳过。
- **枚举判定收紧会误伤真实低基数字典**（表行数超过 10000 采样上限时不再声明完整字典，护栏从"字典校验"退化为"不校验"）→ 该场景下值域校验能力下降，但方向是少拒不是错答，且可通过提高 `sampleLimit` 或补 term 页恢复；上线后需对比拒答率与错答率两个指标。
- **存量枚举清理不可逆**（删 `ds_enum` 行）→ 迁移前备份 `platform.sqlite`，且只删命中命名黑名单的行，保守起见首版不按基数比清理存量。
- **协议重试可能掩盖 prompt 缺陷**：如果格式错误率高，重试会把问题从失败率转移到延迟和 token 成本上 → trace 里的 `protocol_retry` 必须进评测统计，重试率超阈值时应修 prompt 而非依赖重试。
- Phase 1 依赖的澄清链路在生产数据源上从未跑通（无 `clarified` 审计），存在未知缺陷风险 → 前置回归测试兜底；若该链路本身有问题，Phase 1 排期需上浮修复成本。
