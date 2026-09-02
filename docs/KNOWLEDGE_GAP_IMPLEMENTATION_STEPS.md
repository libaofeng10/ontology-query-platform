# 知识缺口治理 · 实施清单

配套方案：[KNOWLEDGE_GAP_AND_PROPOSAL_PLAN.md](./KNOWLEDGE_GAP_AND_PROPOSAL_PLAN.md)（设计依据与取舍在那里，本文只讲怎么落地）。

本文是给实施会话的交接文档。每一步都可独立提交、独立回归，按 S1→S9 顺序执行。

## 交接上下文（开工前必读）

**基线**：`npm test`（= `node --test server/test/*.test.mjs`）当前 **386 passed / 0 failed**，HEAD 为 `8c19bf7`，工作区干净（仅本目录两份未跟踪的 md）。任何一步提交前这个数字只允许上升。

**数据库**：真实库在 `/Users/libaofeng/ontology/platform.sqlite`（`.env.local` 的 `PLATFORM_DB_PATH`）。仓库内 `.data/platform.sqlite` 是 8/12 陈旧副本、没有 knowledge 表，**不要用它核查任何结论**。改 `ds_enum` 前先备份真实库。

**排期**：S1–S9 无外部阻塞，按顺序做即可。（早前工作区存在一批正在改 `knowledgeIntentConcepts` 的未提交改动，会与 S8 争抢同一个函数；这批改动已被撤销，约束解除。）

**S8 依赖的函数当前形态**（已在 `8c19bf7` 上核实，写提议校验前对照确认）：`knowledgeIntentConcepts`（query-intent.mjs:152-174）只处理 `verified && pageType==="metric"` 的页，产出 `kind/value/aliases/aggregation/grain/timeRole/terms/evidence/metricDefinition`。注意两点：**它不产出 `subjects` 字段**；时间角色是内联的 `TIME_ROLE_CONCEPTS.filter(...)` + `roles.length===1` 判断（:155-156），没有独立的 `inferKnowledgeTimeRole` 可调用。S8 的断言只能建立在上面这几个实际字段上。

## S1 · 枚举字典判定收紧

**改** `server/src/db-probe.mjs` 的 `probeTable`（:14-35）。现判据只有 `rows.length <= maxEnumValues`（默认 20），样本 `LIMIT 10000`，无基数比校验、不与表总行数对照——手机号列 `alp_cell` 因此被登记为"只有 1 个合法值的枚举"，查真实手机号被 `sql-guard.mjs:413` 的 `EnumValidationError` 判为字典外取值。

三个条件全满足才写 `item.enums`（否则只保留 `cardinality`）：

1. `estimatedRows > 0 && estimatedRows <= sampleLimit`（样本未覆盖全表不得声明完整字典，沿用 :20 `lastWrite` 的同类判断）
2. `rows.length / Math.min(estimatedRows, sampleLimit) < config.enumMaxDistinctRatio`
3. 列名不命中 `/(_id|_no|_code|cell|phone|mobile|email|name|time|date|_at)$/i`

`config.mjs` 加 `enumMaxDistinctRatio`（env `ENUM_MAX_DISTINCT_RATIO`，默认 0.05）；`settings-service.mjs` GROUPS.discovery 注册。

**验收**：扩充 `server/test/db-probe.test.mjs`——样本未覆盖全表时不写 `enums`；`alp_cell` 即使去重值为 1 也不登记；基数比超阈值不登记；正常业务字典（低基数 + 覆盖全表）仍登记。

## S2 · 存量枚举清理迁移

**新增**一次性迁移，删除 `ds_enum` 中命中 S1 命名黑名单的行。先确认 `sensitive-catalog-migration.mjs` 的调用点，照抄其注册方式。

**约束**：幂等（跑两次结果一致）；只删枚举字典行，不动 `ds_column` 元数据；保守起见首版**只按命名黑名单清理，不按基数比清理存量**；执行前备份 `platform.sqlite`。

**验收**：迁移单测幂等；真实库跑完后 `SELECT COUNT(*) FROM ds_enum WHERE column_name LIKE '%cell%'` 归零（基线：2683 个列被登记为枚举，其中 592 个列名含 `_id`/`name`/`time`/`cell`）。

## S3 · Agent 工具协议格式一次性重试

**改** `server/src/query-agent-loop.mjs` 的工具动作解析分支（现在抛错即终止）。区分两类：

- **格式违规**（空工具名、缺 `thought`、JSON 结构不符）→ 允许重试一次
- **语义违规**（请求不存在/未授权的具体工具、越权参数）→ 保持现状立即终止

重试计数独立于 `iterations` 预算（一次笔误不该吃掉一轮推理预算），但仍受总 token/时间预算约束。重发消息**只追加确定性的格式纠正说明**，不追加任何新的表、字段或工具授权。trace 记 `{tool:"protocol_retry", reason}` 并同步 SSE。

**验收**：扩充 `server/test/query-agent-loop.test.mjs`——缺 thought / 空工具名触发一次重试且第二次合法则成功；连续两次格式错误按现状失败；请求未授权工具**不重试**立即终止；重试不消耗 `iterations`。

## S4 · 审计 intent 字段回填（S6 的硬前置）

**改** `server/src/query-service.mjs`。`intent_json` 真实覆盖率只有 4/59，原因是多处 `addAudit` 没展开 `...auditContext`：

- :57（ranking 限制）、:64（semantic 强制）补 `...auditContext`（:70/:76 已有，照抄）
- :45（LLM 未配置）在 `buildContext` 之前返回、无 intent 可写 → 保留现状但补 `failureClass:"llm_unconfigured"`
- agent loop 内部路径 :108（fallback）、:286（refused）同样补齐

**顺带**统一 `failureClass`：现只有 `retrieval_miss`/`schema_gap`/`execution_error`，新增 `llm_unconfigured`/`ontology_missing`/`protocol_error`/`enum_dictionary`。S6 的缺口归类直接依赖这套取值。

不改表结构、不回溯历史行（老行由 S6 的退化路径兜底）。

**验收**：扩充 `server/test/query-service.test.mjs`——ranking / semantic / coverage-none / missingFacets 四类拒答的审计行 `intent_json` 均非空且 `failureClass` 符合预期；LLM 未配置的拒答 `failureClass==="llm_unconfigured"`。

## S5 · 前端覆盖计数器与拒答卡片

**改** `app/platform-app.tsx:88`：`knowledge.filter((page)=>page.verified).length` 把 623 条 JOIN 与 2 条术语合并成 625，:147 展示为"基于 625 个已验证知识条目"——这是"覆盖看着很好、指标覆盖实际为 0"的认知偏差来源。改为按 `pageType` 分类展示，抽共用 `coverageByType(pages)` helper（与 :222 已有的分类统计共用，避免口径漂移），指标为 0 时警示色。

**改**拒答卡片 QueryRefusalCard（:159）：`publicQueryResult`（server.mjs:192）在拒答响应中透出**已脱敏**的 `{missingAssets:[{kind,label}], failureClass}`——只暴露业务词，不含物理表名/列名。卡片按 kind 渲染具体文案（"缺少『成交率』的指标定义"）：editor+ 给预填跳转（`openNew` + `pageType` + 标题，与 S7 的 remedy prefill 同一套参数）；analyst/viewer 给复制缺口描述（v1 不新增通知链路）。`app/types.ts` 的 `QueryRefusal`（:37）加可选 `missingAssets`，前端对缺字段兜底以兼容旧响应。

**验收**：`coverageByType` 对混合 pageType 返回分类计数；拒答响应缺 `missingAssets` 时卡片不崩。

## S6 · 缺口聚合服务

**新增** `server/src/capability-gap-service.mjs`：

```js
export function createCapabilityGapService({store}) { return {listGaps}; }
export const _internal = {aggregateGaps, gapKey, gapRemedy, gapStatus};
```

`listGaps(sourceId,{limit=500})` 读 `store.listAudits`（store.mjs:447），取 `verdict in ("refused","failed")` 聚合。纯读、实时计算、不落新表。

- **gapKey**：优先 `ambiguity.code + "|" + 归一化资产标识`（metric 类取 measure 的 `sourceText`，filter 类取 field）
- **退化路径（必须有）**：`intent_json` 为空的行不能跳过——历史 55/59 条为空，当前第一大类"找不到线索主表"（3 次重复提问）否则永远进不了看板。用 `failure_class` + 归一化 `fail_reason`（去掉数字、引号内字面量、表名 token 后取前 60 字符）做指纹分组；指纹只用于分组，展示仍用原始问题。该路径需长期保留（`llm_unconfigured` 永远没有 intent）。
- **gapRemedy**：code → 动作的确定性映射，`MEASURE_DEFINITION_REQUIRED → {action:"create_metric_page", prefill:{pageType:"metric", title:assetLabel}}` 等
- **gapStatus**：用当前知识库实时推导 `resolved`/`open`（metric 类走 `knowledgeIntentConcepts`，filter 类走 `catalogFilterConcepts`）。不重放历史问题、不调 LLM——与 `parseQueryIntent` 同一套确定性推导，成本为零且口径一致。S8 落库后缺口下次读取自动 resolved，无联动代码。

**验收**：新增 `server/test/capability-gaps.test.mjs`——聚合正确（count、`sampleQuestions` ≤3）；退化路径把 3 条 fail_reason 仅字面量不同的审计并成 1 个缺口 count=3；落一个 alias 含"成交率"的 verified metric 页后该缺口转 resolved；remedy 映射正确。

## S7 · 缺口看板接口与前端

`server.mjs` 新增 `GET /api/capability-gaps?sourceId=`，`roleAtLeast(identity,"editor")` 门禁与 audits 一致（参考 :71 的 audits 分支），返回 `{gaps, generatedAt, auditWindow}`。

`app/platform-app.tsx` 的 KnowledgeWorkspace 顶部加"知识缺口"面板：`status==="open"` 优先、count 降序，行尾按钮按 remedy 跳转，resolved 折叠显示。`app/api.ts` 加 `listCapabilityGaps`；`app/types.ts` 加 `CapabilityGap`。

**验收**：analyst 请求该接口得 403；面板按 open 优先排序；`create_metric_page` 按钮打开预填了 pageType 和标题的编辑器。

## S8 · 口径提议服务（等 query-intent.mjs 落定后开工）

**新增** `server/src/knowledge-proposal-service.mjs`：

```js
export function createKnowledgeProposalService({store, config, knowledge, evaluation}) {
  return {propose, confirmProposal};   // propose(kind, {context, question, ...})
}
```

**按 kind 泛化**：v1 只实现 `kind:"metric"`，未实现的 kind 返回 null 走原拒答。差异收进 `KIND_HANDLERS[kind]`（shortlist 词表、draft 模板、校验断言三处），文件名与服务名都不带 metric 字样。

- `shortlistCandidates`（确定性、无 LLM）：从 `context.retrieval.diagnostics.facets` 取候选表（≤6，限 `context.tables` 白名单），分子事件列扫小词表 + 注释，分母取主键/unique/`*_id`，时间列标注角色，JOIN 只用 confirmed 关系，**排除 `isSensitive` 列**。
- LLM 只输出**结构化公式**，SQL 与 content 由 harness 模板渲染（`composeDraftPage`）——从构造上保证 `inferKnowledgeRatioFormula` 可解析（顶层 `/`、`CASE WHEN pred THEN col END`、仅 AND 谓词、别名可解析、不写时间字面量）。prompt 模式照抄 `ontology-candidate-generator.mjs:116-147`（untrusted_input 包裹、敏感注释脱敏）。
- `validateDraftPage`：① `knowledgeIntentConcepts([draft], allColumns)` 断言 ratio + 公式非空 + `predicateBinding!=="unsupported"` + timeRole 非空；② 端到端回环：把 draft 塞进 concepts 重跑 `parseQueryIntent(原问题)`，断言 `MEASURE_DEFINITION_REQUIRED` 与 `METRIC_AMBIGUOUS` 消失。失败即丢弃，最多留 3 个。
- `confirmProposal`：`knowledge.save`（knowledge-service.mjs:31-44，verified 强制 owner），保存前查 `store.getKnowledge` 防 slug 撞已验证页。**成功后顺手 `evaluation.create(sourceId,{question:pending.question, category:"口径确认"})`**（goldSql 留空），try/catch 不阻断主流程。

**验收**：单测覆盖 composeDraftPage 渲染结果可被 `knowledgeIntentConcepts` 正确推导、OR 谓词/未知列被拒、shortlist 排除敏感列、`propose("term",...)` 返回 null 不抛错。

## S9 · 提议流程接入查询链路

**先做前置回归**：真实库 `SELECT DISTINCT verdict` 只有 passed/refused/failed，**`clarified` 一条都没有**——说明 pending/resume 澄清链路在生产数据源上从未跑通。S9 整个架在这条链路上，所以第一个测试是澄清往返的端到端回归（`verdict='clarified'` 落库、pendingId 可 resume），而不是提议逻辑本身。若该链路本身有缺陷，先修它再继续。

**改** `server/src/query-service.mjs`：

- `createQueryService` 加依赖 `knowledge`、`evaluation`。注意 server.mjs 里 `evaluation`（:56）在 `queries` 之后构造且依赖 queries，**存在循环**——用惰性 getter 或 :56 之后回填注入，别改构造顺序。
- `ask()` 加 `userRole="viewer"` 与内部参数 `_skipMetricProposal=false`；`buildContext` 返回值补 `parseOptions`/`allColumns`/`knowledgePages`（:393）。
- **拦截点在 `missingRetrievalFacets` 拒答块（:73-78）之前、coverage==="none" 拒答之后**。触发条件：开关开 && `!_skipMetricProposal` && role≥editor && 存在 blocking `MEASURE_DEFINITION_REQUIRED` && 缺失分面全部归属未验证 ratio 指标（还缺主体/时间/过滤分面则走原拒答，metric 页救不了）。
- 澄清簿记照抄 `finalizeAgentOutcome`（invalidatePendingSession、randomUUID、TTL、audit `verdict:"clarified"`、SSE）。pending 记 `{kind:"knowledge_proposal", proposalKind:"metric", ...}`。**响应形状与现有 `QueryClarification` 完全一致 → 前端零改动。**
- `resumePending`（:292）加分支：确认 → `confirmProposal` → **内部重发 `ask({..., _skipMetricProposal:true})`**（旧 loop 的 resume 闭包快照了 catalog，query-agent-loop.mjs:69，中途落库的页对它不可见，所以不能续旧 loop）；返回前 `result._sessionQuestion ??= pending.question`。"都不对"→ 拒答。自由文本 v1 按拒绝处理。
- **循环护栏**：`_skipMetricProposal` 保证二次 `MEASURE_DEFINITION_REQUIRED` 走普通拒答，resume 包装层套诊断文案。

**开关与角色**：`config.mjs` 加 `metricProposalEnabled`（env `METRIC_PROPOSAL_ENABLED`，**默认 false**）；`settings-service.mjs` GROUPS.query 注册；`lockedSettingKeys`（server.mjs:182）加该键；server.mjs :138/:162 传 `userRole: identity.role`。

**验收**（新增 `server/test/knowledge-proposal.test.mjs`）：前置澄清回归；happy path（editor 提问 → 澄清 N+1 选项 → 选口径 → 重查出答案，verified 页 owner=editor，会话记录原问题）；analyst 得现状拒答且 fetch stub 无提议调用；选"都不对"拒答且无页落库；**开关关闭时拒答字段与现状逐字一致**；循环护栏；eval 用例联动。

## 提交与回归策略

每个 S 独立提交，提交信息写清 S 编号与治理的失败模式。每次提交前跑全量 `npm test`（基线 389）。

S1/S2 上线后需**同时观测拒答率与错答率**：枚举收紧在超过采样上限的大表上会让值域校验从"字典校验"退化为"不校验"，方向是少拒不错答，但必须确认没有换来错答上升。S3 的 `protocol_retry` 要进评测统计，重试率超阈值说明该修 prompt 而不是靠重试兜底。

## 手工验证（Phase 0 全量落地后）

重跑一次数据源探查，然后：`ds_enum` 中 `%cell%` 行归零；以手机号 `13774665233` 提问"查询 Alpha 到期时间"不再因枚举字典外取值失败；首页显示分类覆盖且指标项为 0 带警示；随后每条新拒答的 `intent_json` 非空。
