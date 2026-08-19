# 本体公理轻量扩展方案（Axiom-Lite V1）

> 状态：A–C 已实施并完成评审收口（D 保持可选、尚未实施）
> 评审修订（2026-08-18）：子类型主键只允许继承、不得覆盖；物理枚举与术语锚点统一由数据源 catalog 注入校验器，校验器不直接访问存储。
> 实施复核（2026-08-18）：补齐语义路径全集上的父子混用与兄弟互斥拦截、空 discriminator 防崩溃、子类型 rootObject 发布门禁证据、Agent 术语别名扩展、判别画像告警降级、锚点 embedding Top-N 与敏感值导入扫描；新增错误码、评分、影响传播和图谱回归矩阵。
> 前置阅读：`docs/ONTOLOGY_OPTIMIZATION_PLAN.md`（Ontology Schema V1 规范）、`docs/AI_ONTOLOGY_MODELING_PLAN.md`
> 关联代码：`server/src/semantic-schema.mjs`、`server/src/semantic-query-plan.mjs`、`server/src/store.mjs`、`server/src/semantic-schema-diff.mjs`、`server/src/ontology-candidate-score.mjs`

## 0. 背景与设计原则

当前 Ontology Schema V1 的表达能力边界：无类层级、无互斥/逆关系公理、apiName 为自造命名无法与外部术语对齐。本方案**不引入 OWL/RDF 全量公理体系**（开放世界假设与 SQL 封闭世界语义冲突、reasoner 无法参与 SQL 编译、公理无物理证据可绑），而是选取 OWL 表达力中对"受控问数"链路有直接收益的约 20%，以平台既有哲学落地：

1. **每个语义扩展必须可被物理证据验证**——子类判别值来自枚举探查、术语绑定来自权威词表，与 Property 必须映射物理字段的现有原则一致。
2. **公理当门禁用，不当推理用**——disjointness 进校验和候选评分，不进 reasoner。
3. **编译器可消费**——扩展要么改变 SQL 生成（层级），要么改善 LLM 规划视图（逆命名、术语），要么拦截错误（互斥）；不产生"躺在库里无消费方"的元数据。
4. **Schema 版本兼容**——所有新字段可选，旧版本 Schema 继续通过校验；变更进 diff/impact 与评测门禁。

四个扩展，按实施顺序：

| 编号 | 扩展 | OWL 对应 | 实施重心 | 预估规模 |
|---|---|---|---|---|
| E1 | 逆关系命名 | `owl:inverseOf` | 元数据 + 规划视图 | 小 |
| E2 | 互斥公理门禁 | `owl:disjointWith` | 校验 + 评分 + 计划拦截 | 小 |
| E3 | 判别式类层级 | `rdfs:subClassOf` | Schema + 编译器 | 中（核心） |
| E4 | 术语锚点 | `skos:exactMatch/broader` | 新表 + 绑定 + 检索/评分消费 | 中 |

---

## 1. E1 逆关系命名（inverse naming）

### 1.1 现状澄清

语义路径解析已经是双向的：`resolveSemanticPath` 构建邻接表时对每条 Link 同时加正反两条边（`semantic-query-plan.mjs:232-235`），基数反转也已实现（`reverseCardinality`，`semantic-schema.mjs:277`）。**因此本项不改变任何可达性或编译行为**，只补语义命名，收益在 LLM 规划视图与图谱展示：目前 `semanticPlanningView` 只输出单向的 `apiName/displayName`（`semantic-query-plan.mjs:206`），LLM 看到 `order_belongs_to_customer` 时需要自行推断反向语义"customer 拥有 orders"。

### 1.2 Schema 变更

Link Type 新增两个可选字段：

```json
{
  "apiName": "order_belongs_to_customer",
  "source": "order", "target": "customer",
  "cardinality": "many_to_one",
  "inverseApiName": "customer_has_orders",
  "inverseDisplayName": "客户拥有的订单"
}
```

### 1.3 校验规则（semantic-schema.mjs）

- `inverseApiName` 走 `validateApiName`，且与所有 Link 的 `apiName`、其他 `inverseApiName` 全局不重复（新错误码 `ONTOLOGY_LINK_INVERSE_DUPLICATE`）。
- `inverseDisplayName` 缺省时回退为 `inverseApiName`；`inverseApiName` 缺省时整体不输出（保持向后兼容）。
- 自引用 Link（source === target）必须显式提供 `inverseApiName`，否则告警 `ONTOLOGY_LINK_SELF_INVERSE_MISSING`（自引用时两个方向无法靠 source/target 区分）。

### 1.4 消费点

- `semanticPlanningView`：linkTypes 输出增加 `inverseApiName/inverseDisplayName`，并在 description 缺省时合成一句双向描述，降低 LLM 选错根对象方向的概率。
- `ontology-graph-service.mjs`：边标签双向展示（正向/反向 label）。
- AI 候选生成（`ontology-candidate-generator.mjs`）Link 阶段 prompt 要求同时产出 inverse 命名，作为普通字段进入候选评审，不新增状态机分支。

---

## 2. E2 互斥公理门禁（disjointness as gates）

### 2.1 表示

两种来源，均不进推理器：

1. **自动推导**（无需声明）：E3 的兄弟子类型若判别值集合交集为空，则自动视为互斥。
2. **手动声明**：Schema 顶层新增可选字段：

```json
{
  "disjointGroups": [
    ["enterprise_customer", "individual_customer"],
    ["active_supplier", "blacklisted_supplier"]
  ]
}
```

### 2.2 校验规则（semantic-schema.mjs）

- 组内每个成员必须是已定义的 Object Type（`ONTOLOGY_DISJOINT_MEMBER_NOT_FOUND`），组大小 ≥2，组数上限 50。
- 同组两个对象若映射同一物理表且无判别条件区分（都无 discriminator，或判别值集合有交集）→ 错误 `ONTOLOGY_DISJOINT_UNSATISFIABLE`：声明了互斥但物理上是同一行集，公理必然为假。这是"公理必须有物理证据"原则的直接体现。
- 同组对象映射不同物理表 → 天然满足，仅记录，不阻塞。

### 2.3 消费点

1. **查询计划拦截**（`semantic-query-plan.mjs` validate 阶段）：rootObject 为某子类时，若 filters 对判别属性给出与该子类判别值矛盾的取值（如 rootObject=`enterprise_customer` 且 filter `customer_type = 'individual'`），报 `QUERY_PLAN_DISJOINT_CONFLICT` 并在错误信息中说明矛盾——**把"必然空集的合法查询"从静默返回 0 行升级为带解释的拒绝**，LLM agent loop 可据此自我修正。
2. **候选评分强制人工**（`ontology-candidate-score.mjs` forcedReview 条件新增）：两个候选对象映射同一表、无判别区分、且分属手动声明的互斥组 → `evidence_conflict` 强制人工复核。
3. **知识页一致性**：已验证知识页若把互斥组两个对象描述为同义（Wikilink 互指且无区分说明），进 `validateKnowledgeCoverage` 告警（弱信号，仅提示）。

---

## 3. E3 判别式类层级（discriminated subtypes）——核心项

### 3.1 设计决策：为什么是"判别式"而不是"独立表子类"

子类建模有两条路：(a) 子类映射独立物理表，父类查询编译为 UNION；(b) 子类 = 父类同一张表 + 判别列过滤条件。V1 只做 (b)：

- 判别值可被物理证据验证——`ds_enum` 探查字典与 `ds_column_profile` 已有该列的真实取值分布，子类声明"customer_type='enterprise'"时校验器能确认该值真实存在且能给出行数占比。
- 编译器改动可控——不引入 UNION，只在现有 JOIN 树上附加 WHERE 条件；`sql-guard.mjs` 白名单策略不变。
- (a) 的 UNION 编译、跨表主键对齐、聚合语义（去重口径）复杂度高、且首期 Object 候选限单表的现状下没有真实需求，明确列入"不做"。

### 3.2 Schema 变更

Object Type 新增可选字段：

```json
{
  "apiName": "enterprise_customer",
  "displayName": "企业客户",
  "parent": "customer",
  "discriminator": { "property": "customer_type", "values": ["enterprise", "group"] },
  "properties": [
    { "apiName": "credit_line", "type": "number", "mapping": { "table": "customer", "column": "credit_line" } }
  ]
}
```

语义约定：

- 子类**继承父类全部 properties 与 primaryKey**，自身 `properties` 只声明新增属性，可为空数组（放宽现有 `ONTOLOGY_PROPERTIES_REQUIRED`：仅在无 parent 时要求非空）。
- `discriminator.property` 引用**父类**的属性（继承链上可见），values 非空。
- 子类实例集 = 父类行集 ∩ 判别条件；父类查询天然包含全部子类行，无需展开。
- 父类的 Link 对子类可用（Link 继承）；子类可定义自己的 Link。

### 3.3 校验规则（semantic-schema.mjs）

新增 `validateHierarchy`，在对象循环后、Link 校验前执行：

| 规则 | 错误码 |
|---|---|
| parent 必须是已定义 Object Type | `ONTOLOGY_PARENT_NOT_FOUND` |
| 继承链无环，深度上限 3 | `ONTOLOGY_HIERARCHY_CYCLE` / `ONTOLOGY_HIERARCHY_TOO_DEEP` |
| 有 parent 必须有 discriminator，反之亦然 | `ONTOLOGY_DISCRIMINATOR_REQUIRED` |
| discriminator.property 在继承链上可解析，类型为 enum/string/integer | `ONTOLOGY_DISCRIMINATOR_PROPERTY_INVALID` |
| discriminator.values ⊆ 该属性 enumValues；或（非 enum 时）⊆ `ds_enum`/`ds_column_profile` 探查到的真实取值 | `ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED`（探查缺失时降为告警） |
| 子类不得重复定义继承链上已有的 property apiName（V1 不支持覆盖） | `ONTOLOGY_PROPERTY_SHADOWED` |
| 子类新增属性的映射表必须与父类表集合连通（复用 `validateObjectTableConnectivity`，表集合取继承合并后的） | 复用现有错误码 |
| 兄弟子类判别值集合两两交集为空时自动登记互斥（进 E2）；有交集时告警 `ONTOLOGY_SIBLING_OVERLAP`（允许，如"重点客户"与"企业客户"可交叉） | — |
| 同一 Schema 中父类与其子类不得同时被同一个 Link 的 source/target 引用产生歧义路径（见 3.4 限制） | `ONTOLOGY_LINK_HIERARCHY_AMBIGUOUS` |

上限：含子类在内仍受 `MAX_OBJECT_TYPES=1000` 约束，不单设新限；全域草稿采用分页和按需渲染，避免大 Schema 阻塞页面。

### 3.4 编译器变更（semantic-query-plan.mjs）

1. **`createModel` 展开继承**：构建 `effective(object)` —— `properties` = 继承链自根到叶合并（Map 保序），`tables` = 合并后映射表集合，`links` 邻接 = 自身 + 继承链上父类的 Link。`model.properties` 注册表同时登记 `child.inherited_prop` 键，使 `enterprise_customer.name` 可解析（复用 `resolveProperty`，`semantic-query-plan.mjs:309` 无需改动）。
2. **判别条件注入**：`compileSemanticQueryPlan` 中，语义路径上每个带 discriminator 的对象，对其判别属性所在表的别名追加 `WHERE alias.col IN (...)` 条件（values 走现有 `literal()` 转义）。rootObject 是子类 → 根表过滤；子类经 Link 作为中间/目标对象 → 同样过滤。生成的条件并入现有 filters 段之前，顺序确定（按对象 apiName 排序）保证 SQL 确定性。
3. **V1 限制（显式报错而非隐式错误结果）**：同一次查询的语义路径中，父类与其某个子类同时出现（如 rootObject=customer 而某 filter 属性经 `enterprise_customer.x` 引用）→ `QUERY_PLAN_HIERARCHY_MIXED`。原因：两者共享物理表，单别名无法同时承载"过滤"与"不过滤"两种语义；拆双别名自 JOIN 属 V2 范围。
4. **`semanticPlanningView` 变更**：对象输出增加 `parent` 与一句判别说明（如 `"specializes": "customer (customer_type ∈ enterprise, group)"`），properties 输出为**展开后的继承视图**并标记 `inherited: true`——LLM 直接看到子类全貌，不需要自行做继承推理。
5. **`policy` 输出**：判别条件同时写进返回的 policy（新增 `mandatoryFilters` 字段），`sql-guard.mjs` 可校验编译产物确实带上了判别条件（防御编译器自身回归）。

### 3.5 周边模块

- **diff/impact**（`semantic-schema-diff.mjs` / `semantic-schema-impact.mjs`）：新增变更类型 `object_parent_changed` / `discriminator_changed`，影响面 = 该子类及其全部后代引用的评测用例；判别值收窄视为**破坏性变更**（行集缩小），进发布门禁强提醒。
- **图谱**（`ontology-graph-service.mjs`）：新增 `subclass` 边类型（虚线样式），前端 `app/ontology-graph.tsx` 图例补充。
- **审计**：`ds_audit` 的 `semantic_path_json` 中记录注入的判别条件，问数审计可见"这条 SQL 为什么带了这个 WHERE"。
- **AI 候选生成（Phase 2，可延后）**：`ontology-candidate-generator.mjs` 新增子类候选建议——对已确认对象，若其某 enum 列基数低（≤8）且知识页/列注释提及分类语义，生成子类候选；证据类型新增 `enum_profile`（判别值行数占比）；评分沿用现有五维，判别值未在探查中出现 → forcedReview。**首期不做，先支持人工在建模工作台声明**（`app/semantic-schema-form.tsx` 加 parent/discriminator 表单）。

---

## 4. E4 术语锚点（SKOS-lite term anchors）

### 4.1 目标

解决 apiName 自造、跨源不可对齐、本体不可移植的问题。参考 nano-ontoprompt 的 SNOMED 锚点实践（锚点表 + 实体链接 + 权威字段保护），但用 SKOS 弱语义（exact/close/broader match）而非 OWL 强公理，避免引入开放世界问题。

### 4.2 存储（store.mjs 新表）

```sql
CREATE TABLE IF NOT EXISTS ds_term_anchor (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  vocabulary TEXT NOT NULL,            -- 词表名，如 'corp_glossary' / 'fibo_lite'
  canonical_id TEXT NOT NULL,          -- 词表内稳定 ID
  pref_label_zh TEXT, pref_label_en TEXT,
  alt_labels TEXT,                     -- JSON 数组：同义词/缩写
  kind TEXT NOT NULL DEFAULT 'object', -- object | property | metric
  broader_canonical_id TEXT,           -- 词表内部层级（skos:broader），仅存储，不参与编译
  note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(vocabulary, canonical_id)
);
```

导入方式：CSV 上传 API（列格式对齐 nano-ontoprompt 的 `snomed_mental_health.csv`：canonical_id, name_en, name_zh, category, kind）+ 建模工作台管理页。词表本身是**可信数据**（管理员导入），不进 prompt 的 `<untrusted_input>` 包裹，但导入时仍过敏感词扫描。

### 4.3 Schema 变更

Object Type 与 Property 新增可选字段：

```json
{ "termBinding": { "vocabulary": "corp_glossary", "canonicalId": "CUST-001", "match": "exact" } }
```

`match ∈ {exact, close, broader}`（对应 skos:exactMatch/closeMatch/broader）。

校验（semantic-schema.mjs，catalog 注入 anchors）：

- 锚点必须存在且 kind 匹配（`ONTOLOGY_TERM_ANCHOR_NOT_FOUND` / `ONTOLOGY_TERM_ANCHOR_KIND_MISMATCH`）。
- 同一 Schema 内，同一锚点的 `exact` 绑定唯一——两个对象不能都精确等于同一术语（`ONTOLOGY_TERM_EXACT_DUPLICATE`）；`close/broader` 不限。
- E2 联动：互斥组内两对象 exact 绑定同一锚点 → 矛盾，报错。

### 4.4 消费点

1. **候选生成**：`ontology-candidate-generator.mjs` 的对象/属性命名阶段，prompt 注入相关词表片段（按批次表名/注释 embedding 召回 top-N 锚点），要求 LLM 优先复用锚点术语命名并输出 termBinding 建议；服务端校验 canonicalId 在允许列表内（沿用 relationId 允许列表模式，`generator.mjs:224` 同款约束）。
2. **权威保护**（借 nano-ontoprompt 的"SNOMED 字段不可覆盖"）：termBinding 一经人工确认，候选再生成（同 stableKey）不得修改，重生成结果与已确认绑定冲突 → forcedReview。
3. **评分**：`ontology-candidate-score.mjs` 语义一致性维度（25 分档）加入锚点信号——候选 displayName/description 与绑定锚点 labels 的 embedding 相似度低 → 降档。
4. **检索增强**：`knowledge-retrieval.mjs` 查询扩展——用户问法命中锚点 alt_labels（同义词/缩写）时，等价替换为绑定对象的 displayName 参与词法检索，提升"用户用行话、模型用表名"场景的召回。
5. **导出（Phase 3，可选）**：单向导出 SKOS Turtle（Concept + prefLabel/altLabel + exactMatch + broader），供外部治理工具消费；**不做导入、不做推理**。

---

## 5. 版本兼容与发布门禁

- 四项扩展的全部新字段均可选，`validateSemanticSchema` 对不含新字段的历史版本行为不变；`ds_ontology_schema_version` 不可变版本机制不动，checksum 自然区分。
- `semantic-schema-diff.mjs` 新增变更类型：`link_inverse_changed`（非破坏）、`disjoint_group_changed`（非破坏，但触发查询计划行为变化提示）、`object_parent_changed` / `discriminator_changed`（破坏性）、`term_binding_changed`（非破坏）。
- 发布门禁：含 E3 变更的版本发布前，Gold SQL 评测需覆盖至少一条以子类为 rootObject 的用例，否则 `ds_eval_gate` 提示覆盖缺口。
- 回滚：现有"回滚前按当前物理结构重新校验"逻辑自动覆盖新校验规则，无需额外改动。

## 6. 实施顺序

| 阶段 | 内容 | 主要文件 |
|---|---|---|
| A（已完成并复核） | E1 逆命名 + E2 手动/自动互斥组（校验+计划拦截） | semantic-schema.mjs、semantic-query-plan.mjs、semantic-schema-form.tsx |
| B（已完成并复核） | E3 判别式子类型全链路（不含 AI 候选） | semantic-schema.mjs、semantic-query-plan.mjs、semantic-schema-diff/impact.mjs、ontology-graph-service.mjs、表单 |
| C（已完成并复核） | E4 锚点表 + 绑定 + embedding Top-N + 检索/评分消费 | store.mjs、semantic-schema.mjs、ontology-candidate-generator/score.mjs、knowledge-retrieval.mjs |
| D（可选） | 子类 AI 候选生成、SKOS 导出 | ontology-candidate-generator.mjs、新 export 模块 |

A 不依赖 B/C；B 完成后 E2 的自动互斥推导生效；C 独立于 B。建议 A → B → C 顺序，每阶段独立发版过评测门禁。

## 7. 明确不做（Non-goals）

- OWL reasoner / 开放世界语义 / 一致性自动推理——公理只进门禁。
- 独立表子类与 UNION 编译（`QUERY_PLAN_HIERARCHY_MIXED` 场景的双别名自 JOIN 同属 V2）。
- 传递闭包、多继承、属性覆盖（override）。
- RDF/OWL 导入、跨词表映射推导（broader 链只存储展示）。
- 跨数据源本体对齐——E4 锚点为其铺路，但对齐机制本身是后续独立课题。
