# 本体构建证据增强计划（值画像 · 文档知识 · 评分闭环）

> 版本：v0.2
> 日期：2026-08-14
> 状态：工程实施完成，待真实业务验收
> 最近实施更新：2026-08-17
> 前置：`AI_ONTOLOGY_MODELING_PLAN.md`（候选流水线 M0–M4）、`ONTOLOGY_OPTIMIZATION_PLAN.md`（P0–P4 闭环）
> 目标：在不改变"候选而非事实、确定性评分、人工发布边界"三条底线的前提下，为关系判断和本体生成引入三类新证据——**列值画像（表示例数据）**、**上传文档中的表关系知识**、**人工校准标注**——并修复评分区分度与知识检索的已知短板。

## 1. 背景与现状

当前本体构建链路已经闭环：结构发现生成关系候选 → LLM 批量判断 → 人工确认 → Object/Link 候选生成 → 确定性评分路由 → 草稿组装 → 发布。但证据来源存在三处明显缺口：

1. **模型只看元数据，不看数据**。关系判断（`relation-model-service.mjs`）和本体生成（`ontology-candidate-generator.mjs`）的输入全部是表名、字段名、类型、注释和索引。注释缺失的库上，语义判断依据不足；`semanticConsistencyScore` 在注释缺失时只能按 15 分保底计分。值域重叠率（`sampleOverlap`）只在模型判断**之后**对建议项计算，最强的物理信号没有进入模型判断本身。
2. **文档知识进不了关系层**。知识页（join/term/metric/rule）目前只在 Link 候选生成时作为佐证注入 prompt；Link 只能从 `ds_relation` 的允许列表中选择 relationId。文档中描述的、结构发现未召回的关系，无法通过任何路径进入本体。关系判断环节完全不读知识页。
3. **校准标注不反哺**。`ontology-calibration-service` 聚合了人工标注的 precision 和 issueType 分布，但评分权重是冻结常量，`autoConfirmScore` 全局固定 80，标注结果仅用于展示。

此外两项工程短板：评分维度过于二值化（physical 只有 30/35 两档、knowledge/template 为 0 或满分），总分区分度不足；知识页选取是"表名过滤 + 截断 30 条"而非语义检索。

## 2. 范围

### 2.1 纳入本期

1. 列级**值画像**采集：对 A/B 级表非敏感列采样，生成脱敏示例值、格式模式、distinct 数、空值率画像，持久化并纳入目录校验和；
2. **重叠率前置**：关系候选在进入模型判断前计算采样重叠率，作为候选元数据进入 prompt；
3. 值画像进入**关系判断** prompt 与**Object 候选生成** prompt（列描述、枚举取值）；
4. 值画像文本补充**语义一致性评分**的证据文本，减少保底计分场景；
5. **文档桥接**：上传表关系文档 → 结构化抽取关系断言 → 校验 → 以 `inferenceSource:"document"`、`status:"review"` 写入 `ds_relation` → 走既有人工确认流程；
6. 关系判断 prompt 附带命中候选两端表的已核验知识页摘要；
7. **标注反哺（规则化）**：按 issueType 聚合校准标注，转化为 forcedReview 规则与减分项；按数据源输出 `autoConfirmScore` 建议值（人工采纳，不自动生效）；
8. **评分连续化**：physicalMapping 按 A/B 表比例、knowledgeEvidence 按证据数量与页面类型、structuralEvidence 保持现档但细化多段 JOIN 计分；
9. **生成后自检（critic）**：候选连同物理证据回喂模型做一致性质询，不一致项追加 forcedReview 原因；
10. 知识页选取从"过滤 + 截断"改为 **embedding top-K 语义检索**（复用 embedding-index）。

### 2.2 后续阶段（不在本期）

- 按标注数据自动拟合评分权重（本期只做规则化反哺与阈值建议）；
- 非结构化长文档（PDF/Word）解析，本期只支持 Markdown/纯文本；
- 值画像用于数据质量监控与漂移检测；
- 跨数据源文档知识复用。

### 2.3 明确不做

- **不把原始行数据发送给模型**。进入 prompt 的只有脱敏后的列级画像（示例值经敏感检测与截断）；整行记录、敏感列的任何取值不出库；
- 不允许文档直接创建 `confirmed` 关系；文档抽取的关系一律 `review`，未经人工确认不进 JOIN 白名单、不参与 Link 生成允许列表（`listRelations(acceptedOnly)` 语义不变）；
- 不改变自动确认 → 组装草稿 → 人工发布的三段边界；
- 不放宽 Link 只能绑定服务端 relationId 的契约；
- 校准阈值建议不自动生效，采纳动作必须由人工在设置中完成并留痕。

## 3. 设计原则

1. **数据边界从"元数据"扩展为"脱敏画像"，且仅此一步**：这是对既有"不发送记录值"约束的一次显式放宽，放宽面限定为列级聚合画像；敏感列（列名检测 + 新增值级检测）只输出格式模式，永不输出原值；
2. **文档是不可信输入**：抽取、注入 prompt 一律走 `<untrusted_input>` 包裹与 `metadataText`/`redactSensitive` 清洗，沿用现有防注入惯例；
3. **文档产生候选，不产生事实**：文档 → `ds_relation(review)` 与模型建议同等待遇，复用同一确认队列、同一证据展示；
4. **画像可复现可审计**：画像带采样时间、采样量、生成规则版本，纳入 `ontologyCatalogChecksum`，画像变化即视为目录变化，触发批次过期判定；
5. **评分改动版本化**：所有计分变更升级 `ONTOLOGY_CANDIDATE_SCORING_VERSION`，校准服务按 scoringVersion 隔离比较，旧批次分数不重算；
6. **降级安全**：画像缺失、采样失败、文档抽取失败均降级为"无该项证据"，回到当前行为，不阻塞主流程。

### 3.1 评审定稿补充

1. **画像校验和使用内容摘要，不直接使用采样时间**：`ontologyCatalogChecksum` 纳入 `profileVersion + profile_json 内容摘要`；`sampledAt` 仅用于审计。相同画像的重复采样不会误判目录漂移，画像内容发生变化时仍会使既有批次过期。
2. **文档关系跨结构刷新保留**：结构刷新时，只要断言两端字段仍存在，`inferenceSource:"document"` 且状态为 `review/confirmed/denied` 的关系必须保留 `present=1`；字段消失后才标记失效。
3. **上传 API 契约冻结为 JSON**：`POST /api/sources/:id/relation-docs` 接收 `{filename, content}`，仅允许 `.md/.markdown/.txt`，UTF-8 内容上限 256 KiB；服务端以文档 UUID 生成实际路径，不使用客户端文件名拼接路径，同一 source 下 checksum 幂等。
4. **逐数据源设置单独持久化并审计**：P5 的阈值采纳不能复用全局 `ontologyAi.autoConfirmScore`；新增逐数据源设置记录，生成批次在创建时冻结当时有效阈值，采纳记录包含操作人、旧值、新值和依据批次。

## 4. 方案设计

### 4.1 列值画像（P1）

**采集**。扩展 `db-probe`：对 A/B 级表、非敏感列，采样 `min(profileSampleLimit, 1000)` 行（优先按主键/时间列倒序，保证"最新"），计算：

- `sampleValues`：最多 5 个高频 distinct 值，逐值做敏感检测（新增手机号/身份证/邮箱/银行卡正则），命中则丢弃该值；每值截断 64 字符；
- `formatPattern`：示例值归纳的正则骨架（如 `CUS-\d{6}`、`\d{4}-\d{2}-\d{2}`）；
- `distinctCount`、`nullRatio`、`minMax`（仅数值/时间列）；
- 枚举列直接复用 `ds_enum` 已有取值，不重复采样。

**存储**。新表 `ds_column_profile(source_id, table_name, column_name, profile_json, sampled_at, sample_size, profile_version)`；`listColumns` 联查后挂到列对象的 `profile` 字段。

**校验和**。`ontologyCatalogChecksum` 纳入 `profile_version + profile_json 内容摘要`；`sampled_at` 仅用于审计。保证批次过期判定感知画像内容更新，同时避免内容未变的重复采样误伤既有批次。

**开关**。`config.profiling = {enabled, sampleLimit, maxTablesPerRefresh, timeoutMs}`，默认关闭，按数据源灰度。

### 4.2 关系判断增强（P2）

1. **重叠率前置**：`discovery-service` 在 `generateRelationCandidates` 之后、`relationModel.judge` 之前，对全部候选计算 `sampleOverlap`（并发上限 4，单候选超时降级 null）。候选量上限 600，采样查询可控；对 `structuralScore < 0.3` 的尾部候选可跳过采样直接送判；
2. **prompt 扩展**：`messagesFor` 的候选元数据增加 `from.profile`、`to.profile`（示例值、格式模式、distinct 数）与 `overlapRatio`；system prompt 明确"重叠率与格式一致性是强证据，但低重叠不能单独否决时间上不相交的新旧数据关系"；
3. **知识页注入**：按候选两端表名命中已核验知识页（join/rule 优先），每批最多 5 页、每页摘要 300 字，`<untrusted_input>` 包裹；
4. **置信度公式调整**：`overlapRatio` 已进入模型判断输入，事后加权公式从 `0.65/0.25/0.10` 调整为 `模型 0.60 / 结构 0.25 / 重叠 0.15`，并在 `modelEvidence` 证据文本中标注画像与重叠证据。

### 4.3 文档知识桥接（P3）

**上传与抽取**。新增 API `POST /api/sources/:id/relation-docs`：

1. 接收 Markdown/纯文本文档，落盘到 `wiki/source-<id>/uploads/`，记录 checksum；
2. LLM 抽取关系断言：`{fromTable, fromColumn, toTable, toColumn, cardinality?, evidenceQuote}`，输出严格 JSON，文档内容 `<untrusted_input>` 包裹；join 知识页的 `sqlContent`（ON 条件）走确定性解析，不经模型；
3. 抽取结果逐条校验：表/字段存在于当前目录、类型兼容（复用 `compatibleType`）、两端非敏感、不与既有 `confirmed/review` 关系重复（复用 relationKey 去重）；
4. 可选执行一次 `sampleOverlap` 作为佐证；
5. 通过校验的断言 `upsertRelation({inferenceSource:"document", status:"review", modelReason:抽取理由+原文引用, confidence:0.5+overlap*0.3})`，并生成人工确认问题（复用 `addQuestion`，evidence 附文档名与引用原文）；
6. 未通过校验的断言返回给上传者，附失败原因（表不存在/敏感/重复）。

**闭环**。人工确认后关系进入 `confirmed`，自动出现在 Link 生成允许列表；同一文档可再整理为 join 知识页（verified 后作为 Link 候选的 `knowledge_page` 证据），形成"物理关系 + 知识证据"双通道。

结构刷新保留两端字段仍存在的文档关系及其人工状态；只有任一端字段从目录消失时才将该关系标记为失效。

### 4.4 本体生成增强（P4）

1. **值画像进 Object prompt**：`objectGenerationMessages` 的列描述追加 `profile`（示例值、格式、枚举取值——`ds_enum` 现在并未进 prompt，一并带上），帮助模型为 `status/type` 类无注释字段写出准确业务含义；
2. **语义证据文本扩展**：`semanticTexts` 的 evidenceText 追加画像文本（格式模式 + 枚举取值 + 非敏感示例值），仅在注释证据为空或不足时启用，减少 15 分保底路径；
3. **评分连续化**（升级 scoringVersion 至 `ontology-candidate-v2`）：
   - physicalMapping：按 A 级表占比线性计分（全 A = 35，全 B = 28，线性插值）；
   - knowledgeEvidence：1 条已验证证据 6 分，2 条 8 分，≥3 条或含 gold_sql 10 分；
   - structuralEvidence：多段 JOIN 从固定 20 分改为按"全部段 confirmed 且基数一致"细分 20/22 两档；
   - semanticConsistency 分档不变，但证据文本来源扩展见上；
4. **critic 自检**：候选评分完成后、路由之前，批量（每批 10 个）回喂 `候选 displayName/description + 物理列画像 + 表注释`，质询"业务定义与物理证据是否矛盾、是否将日志/中间表包装为业务对象"，输出 `{candidateId, consistent, issue}`；`consistent=false` 追加 forcedReview 原因 `SEMANTIC_CRITIC_FLAGGED`（只降级为人审，不直接拒绝）；critic 调用失败整体降级跳过。

### 4.5 校准反哺与知识检索（P5）

1. **标注规则化**：校准报告按 issueType 聚合，`unconfirmed_join`、`sensitive_mapping` 高发（占比 ≥20% 且样本 ≥10）时在报告中输出结构化建议（收紧对应 forcedReview 规则/减分项），并提供一键生成设置变更草案，人工采纳生效；
2. **阈值建议**：按数据源用标注 correct/incorrect 分布计算能使 precision ≥ 目标值（默认 0.9）的最低 `autoConfirmScore`，展示于校准报告；采纳后写入 per-source 设置并留痕；
3. **知识页语义检索**：`ontology-candidate-service` 选取知识页时改为 embedding top-K（K=30 不变）：候选批次的表名 + 表注释拼为查询文本，从 embedding-index 检索，表名硬命中的页保底纳入；embedding 不可用时回退现有过滤逻辑。

## 5. 实施阶段

### P0｜计划与契约

状态：**本文档**

- 固化数据边界放宽范围（列级脱敏画像）、文档桥接的 review-only 契约、评分版本化策略；
- 评审通过后冻结 `profile_json` 结构与 `relation-docs` API 契约。

出口条件：计划评审通过；`ds_column_profile` 表结构与抽取 JSON 契约定稿。

### P1｜值画像采集与存储

- db-probe 扩展采样与画像生成；值级敏感检测正则库与单测；
- `ds_column_profile` 建表、store 读写、`listColumns` 联查；
- 画像纳入 `ontologyCatalogChecksum`；配置开关与灰度。

出口条件：

1. 敏感列（列名或值级命中）画像中不出现任何原值，有单测覆盖手机号/身份证/邮箱样本；
2. 画像缺失时全链路行为与现状一致（降级测试）；
3. 画像更新后既有生成批次被判定为目录过期。

### P2｜关系判断增强

- overlap 前置计算与并发/超时控制；
- `messagesFor` 注入画像、重叠率与知识页摘要；置信度权重调整；
- `modelEvidence` 证据文本更新。

出口条件：

1. 对照集（挑选 ≥50 条已人工确认/否决的历史候选）上，判断准确率不低于现版本；
2. 单批 token 增量 ≤ 40%；采样失败候选正常降级送判；
3. 知识页内容中的指令性文本不影响判断输出（注入测试）。

### P3｜文档知识桥接

- `relation-docs` 上传 API、抽取 prompt 与确定性 join 页解析；
- 断言校验、去重、`inferenceSource:"document"` 入库与确认问题生成;
- 前端上传入口与抽取结果反馈。

出口条件：

1. 文档抽取的关系全部为 `review`，不出现在 `listRelations(acceptedOnly)`；
2. 含表外字段/敏感字段/重复关系的断言被拒并返回原因；
3. 人工确认文档关系后，Link 生成允许列表可选到该 relationId（端到端测试）；
4. 文档内嵌指令不改变抽取行为（注入测试）。

### P4｜本体生成增强

- Object prompt 注入画像与枚举；semanticTexts 证据扩展；
- 评分连续化，scoringVersion 升级为 `ontology-candidate-v2`；
- critic 自检批次与 `SEMANTIC_CRITIC_FLAGGED` 路由。

出口条件：

1. 无注释测试库上，Object 候选描述质量人工评审优于现版本（抽样 ≥20 个候选双人盲评）；
2. v1/v2 批次在校准服务中不混算（scoringVersion 隔离测试）；
3. critic 失败时批次正常完成，仅缺自检证据。

### P5｜校准反哺与知识检索

- issueType 聚合建议与设置变更草案；per-source 阈值建议与采纳留痕；
- 知识页 embedding top-K 检索与回退。

出口条件：

1. 阈值建议只影响展示，采纳前 `autoConfirmScore` 不变；
2. embedding 不可用时知识页选取回退现有逻辑；
3. 采纳动作有审计记录（操作人、旧值、新值、依据批次）。

## 6. 存储与 API 变更

| 变更 | 类型 | 说明 |
| --- | --- | --- |
| `ds_column_profile` | 新表 | 列画像，`(source_id, table_name, column_name)` 唯一；采样时间只审计，不直接参与目录校验和 |
| `ds_relation.inference_source` | 枚举扩展 | 新增 `document` |
| `ds_relation_doc` | 新表 | 上传文档登记：路径、checksum、抽取批次、断言数、通过数 |
| `ds_source_ontology_setting` | 新表 | 逐数据源建模阈值与采纳审计，不覆盖全局默认值 |
| `POST /api/sources/:id/relation-docs` | 新 API | 上传并抽取关系断言 |
| `GET /api/sources/:id/relation-docs` | 新 API | 列出文档与抽取结果 |
| `config.profiling` | 新配置 | 画像采样开关与限额 |
| `ONTOLOGY_CANDIDATE_SCORING_VERSION` | 升级 | `ontology-candidate-v2`（P4 生效） |

## 7. 测试策略

- **单测**：画像生成与脱敏（含边界正则）、格式模式归纳、overlap 前置降级、文档断言校验矩阵（表缺失/类型不兼容/敏感/重复）、v2 计分函数逐维度、critic 输出规范化；
- **注入测试**：知识页、文档内容、画像示例值中埋入指令文本，断言模型输出契约不被破坏（沿用 `untrusted_input` 测试惯例）；
- **回归对照**：以历史人工标注的关系候选与本体候选为金集，P2/P4 上线前后各跑一轮，准确率与 auto_confirm precision 不回退；
- **端到端**：上传文档 → review 关系 → 人工确认 → Link 生成选中 → 草稿组装 → 发布校验全链路。

## 8. 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 画像泄露敏感值 | 列名 + 值级双重检测；示例值白名单截断；灰度开启 | 关闭 `config.profiling`，画像不再进入 prompt 与评分 |
| 采样拖慢结构刷新 | 并发/超时/表数限额；尾部候选跳过采样 | 同上，overlap 回退为仅建议项计算 |
| 文档抽取幻觉关系 | 全部 review + 目录校验 + 人工确认；不进白名单 | 下线上传入口，已入库 review 关系可批量否决 |
| v2 计分引起自动确认率突变 | scoringVersion 隔离；上线前金集对照 | 配置回退 scoringVersion 至 v1 计分函数 |
| critic 误伤（过度降级人审） | 只追加 forcedReview 不拒绝；按批次统计 flag 率告警 | 关闭 critic 开关 |
| token 成本上涨 | 画像字段截断、每批知识页 ≤5、token 增量出口条件把关 | 逐项开关独立回退 |

## 9. 优先级与依赖

```
P1 值画像 ──┬─→ P2 关系判断增强 ──→（关系召回/精度提升）
            └─→ P4 本体生成增强 ──→（候选质量提升）
P3 文档桥接 ────→（独立，仅依赖现有 ds_relation 契约）
P5 校准反哺 ────→（独立，依赖已有标注积累）
```

建议实施顺序：P1 → P2 与 P3 并行 → P4 → P5。P3 与画像无依赖，可提前独立交付。

## 10. 实施记录（2026-08-17）

- P1–P5 的工程实现已落地：脱敏列画像与配置、overlap 前置、知识摘要注入、关系文档桥接、Object 画像/枚举、v2 评分、critic、校准建议与逐数据源阈值审计、embedding top-K 回退，以及对应前端入口。
- 自动化验证已覆盖敏感值抑制、画像校验和、采样降级、提示词注入边界、文档断言校验矩阵、review-only/白名单边界、结构刷新保留、v2 各评分维度、critic 失败降级、v1/v2 隔离、阈值采纳留痕和 embedding 回退。
- 仍需真实业务证据才能关闭的上线验收项：≥50 条历史关系候选对照、≥20 个无注释 Object 双人盲评、单批 token 增量与真实延迟、以及生产数据源灰度结果。这些不由代码或合成测试代替。
