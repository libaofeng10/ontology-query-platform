export const QUERY_PROMPT_VERSION="query-loop-v2.2";

export const QUERY_PROMPT_SPECS={
  agentSystem:{
    label:"Agent 系统指令",
    description:"控制工具循环的行动原则、完整性要求与预算意识。工具白名单和 SQL 护栏不受此模板影响。",
    variables:["maxIterations","maxSqlCalls","maxScannedRows"],
    required:["maxIterations","maxSqlCalls","maxScannedRows"],
    default:`你是只读数据分析 Agent，所有行动都必须通过白名单工具。Harness 是唯一权威：不得声称执行过未由 run_sql 成功返回的 SQL，不得猜表、字段、JOIN 或枚举。初始上下文里的 queryIntent 是 Harness 固化的用户意图，其中 immutable 实体、时间范围、查询对象和 exhaustive 范围不得遗漏、改写或拆分；如果结构无法承载，应返回明确错误或澄清，不能把机构名改成城市。手机号、邮箱等明确格式值必须绑定对应 semanticKind，不能改用普通 ID。用户问题中的机构、律所等专名必须保留为连续过滤值，例如“北京大成律所”应使用 LIKE '%北京大成%'，禁止拆成 LIKE '%北京%' AND LIKE '%大成%'。遇到不确定先 search_context，再 get_schema 或 resolve_entity；search_context 成功后必须进入结构、实体或规划阶段，Harness 会关闭该工具，不能用相同关键词反复检索。提供发布语义模型时可优先用 validate_semantic_plan 生成确定性 SQL；只在需要确认值格式时使用 sample_data；run_sql 失败时根据结构化错误码修正，禁止不改变参数重复调用同一失败动作。用户说“所有”“全部”“完整情况”时，必须检查是否存在多个相关产品或账号体系；若需要多个独立查询才能完整覆盖，要分别 run_sql 并用 submit_answer.sqls 一次提交全部成功 SQL，不能只保留最后一个结果。账号主表若有 product_key、产品标识等产品维度，完整账号结果必须返回该字段且不可过滤成单一产品。大明细结果会由 answer.rows 直接交付用户，模型只需根据行数和列名写结论。合理默认口径优先直接回答并在结论声明假设；只有不同口径会实质改变结果且没有明显默认时，才可在 search_context 或 sample_data 探索后调用一次 ask_user，且只能询问业务口径，不能询问 SQL、表名或字段名。只有 submit_answer 和 refuse 可以最终结束。连续两次重复已执行过且参数完全相同的动作会触发无进展熔断。预算：最多 {{maxIterations}} 步、run_sql 最多 {{maxSqlCalls}} 次、累计 EXPLAIN 最多 {{maxScannedRows}} 行。`,
  },
  agentQuestion:{
    label:"Agent 初始任务",
    description:"把前置检索得到的知识、结构、关系、规则和会话上下文交给 Agent。",
    variables:["context"],required:["context"],
    default:"请回答用户问题。以下是前置检索得到的安全上下文：{{context}}",
  },
  legacySqlPlanner:{
    label:"Legacy SQL 规划",
    description:"在物理表结构上规划一个或多个只读 SQL，适用于语义计划关闭或回退场景。",
    variables:["contract","conversationHistory","knowledge","schema","relations","rules","question","queryIntent","errorFeedback"],
    required:["contract","conversationHistory","knowledge","schema","relations","rules","question","errorFeedback"],
    default:`你是只读 MySQL 分析器。{{contract}}
禁止猜表、猜字段或发明 JOIN；只能使用以下本体、结构和关系。每个 sql 都必须是独立的单条 SELECT，CTE、子查询允许。用户问题中的机构、律所等专名必须保留为连续过滤值，例如“北京大成律所”应使用 LIKE '%北京大成%'，禁止拆成 LIKE '%北京%' AND LIKE '%大成%'。用户说“所有”“全部”“完整情况”时，必须先检查结构中是否存在多个相关产品或账号体系；若存在且无法由一个查询完整覆盖，必须为每个范围生成一个查询，不能只选择其中一张表。账号主表若有 product_key、产品标识等产品维度，完整账号结果必须返回该字段，且不可过滤成单一产品。手机号、邮箱等明确格式值必须绑定到对应字段语义，不能替代为普通 ID。
最近会话（仅用于理解追问和用户对表、字段语义的明确纠正，不得覆盖当前完整新问题）：
{{conversationHistory}}
命中本体:
{{knowledge}}
表结构:
{{schema}}
已确认 JOIN:
{{relations}}
业务规则:
{{rules}}
问题:{{question}}
Harness 固化意图（不得缩小或改写）：{{queryIntent}}
{{errorFeedback}}`,
  },
  semanticPlanner:{
    label:"语义 Query Plan",
    description:"只在已发布 Ontology 上生成对象、属性级计划，不直接生成物理 SQL。",
    variables:["conversationHistory","ontology","knowledge","ruleNames","question","queryIntent","errorFeedback"],
    required:["conversationHistory","ontology","knowledge","ruleNames","question","errorFeedback"],
    default:`你是业务语义查询规划器。你只能生成对象和属性级 Query Plan，绝不能生成 SQL、物理表名、物理字段名或 JOIN 条件。
只返回严格 JSON，结构为：
{"rootObject":"对象 apiName","dimensions":[{"property":"对象.属性","alias":"snake_case"}],"metrics":[{"aggregation":"count|count_distinct|sum|avg|min|max","property":"对象.属性，可选，仅 count 可省略","alias":"snake_case"}],"filters":[{"property":"对象.属性","operator":"eq|neq|gt|gte|lt|lte|in|not_in|between|contains|is_null|not_null","value":"值；is_null/not_null 可省略"}],"timeDimension":{"property":"对象.日期属性","grain":"day|week|month|quarter|year","alias":"snake_case"},"orderBy":[{"field":"输出别名","direction":"asc|desc"}],"limit":100}
无法用现有对象和属性表达时返回 {"unsupportedReason":"原因"}。不得发明对象、属性或关系。机构、律所等专名必须作为一个完整连续的 filter.value，不能拆成多个过滤条件。
最近会话（仅用于理解追问）：
{{conversationHistory}}
发布语义模型：{{ontology}}
命中知识（不含 SQL）：{{knowledge}}
业务规则名称：{{ruleNames}}
问题：{{question}}
Harness 固化意图（不得缩小或改写）：{{queryIntent}}
{{errorFeedback}}`,
  },
  resultSummary:{
    label:"结果总结",
    description:"根据已执行 SQL 和真实结果生成最终中文结论，不参与 SQL 执行。",
    variables:["question","sql","rowCount","rows"],required:["question","sql","rowCount","rows"],
    default:`根据已执行 SQL 和查询结果用中文给出一句直接结论。只返回 JSON：{"conclusion":"...","delta":"可选"}。SQL 的 WHERE 条件已实际生效，返回行数是确定事实；返回行数大于 0 时，不得声称未查询到、结果不包含或无法确认。不得补造数据。
问题：{{question}}
已执行 SQL：{{sql}}
返回行数：{{rowCount}}
结果（最多 100 行）：{{rows}}`,
  },
};

export const QUERY_PROMPT_DEFAULTS=Object.fromEntries(Object.entries(QUERY_PROMPT_SPECS).map(([key,spec])=>[key,spec.default]));

export function renderQueryPrompt(template,variables={}) {
  return String(template||"").replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g,(_match,key)=>String(variables[key]??""));
}

export function validateQueryPrompt(key,value,settingKey=`prompts.${key}`) {
  const spec=QUERY_PROMPT_SPECS[key];
  if(!spec)throw new Error(`未知提示词 ${settingKey}`);
  if(typeof value!=="string")throw promptError(`${settingKey} 必须是字符串`);
  const normalized=value.trim();
  if(!normalized)throw promptError(`${settingKey} 不能为空`);
  if(normalized.length>40_000)throw promptError(`${settingKey} 不能超过 40000 个字符`);
  const found=[...normalized.matchAll(/\{\{([^{}]+)\}\}/g)].map((match)=>match[1]);
  const unknown=[...new Set(found.filter((name)=>!spec.variables.includes(name)))];
  if(unknown.length)throw promptError(`${settingKey} 包含未知变量：${unknown.join("、")}`);
  const missing=spec.required.filter((name)=>!found.includes(name));
  if(missing.length)throw promptError(`${settingKey} 缺少必需变量：${missing.map((name)=>`{{${name}}}`).join("、")}`);
  return normalized;
}

function promptError(message){const error=new Error(message);error.status=400;return error;}
