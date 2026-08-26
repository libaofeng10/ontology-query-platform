import { extractKnowledgeColumnRefs } from "./knowledge-column-refs.mjs";

export const QUERY_INTENT_VERSION="2.0";
export const DEFAULT_BUSINESS_TIME_ZONE="Asia/Shanghai";

const SUBJECT_CONCEPTS={
  clue:["线索","进线","clue","lead","clue_time","clue_create_time"],
  account:["账号","账户","用户","account","user","member"],
  customer:["客户","客群","customer","client"],
  order:["订单","下单","order","purchase","transaction"],
  case:["案件","案源","case","matter","legal_case"],
  revenue:["收入","营收","销售额","回款","revenue","sales","amount","payment"],
};

// These concepts describe business capabilities, never physical mappings. A
// datasource can still enrich them through verified knowledge and ontology term
// bindings during retrieval. Keeping the fallback vocabulary here makes the
// immutable intent contract deterministic even when no semantic assets exist.
const DIMENSION_CONCEPTS=[
  {value:"seller",pattern:/销售(?!额)|业务员|顾问|负责人|seller|salesperson|owner|assignee/i,terms:["销售","业务员","负责人","归属人","seller","salesperson","owner","assignee","seller_id","seller_name","owner_id","owner_name"],labelTerms:["销售姓名","负责人姓名","seller_name","owner_name"]},
  {value:"product",pattern:/产品|商品|服务包|product|sku/i,terms:["产品","商品","product","sku","product_id","product_name"]},
  {value:"channel",pattern:/渠道|来源|source|channel/i,terms:["渠道","来源","channel","source","channel_id","channel_name"]},
  {value:"region",pattern:/地区|区域|省份|城市|region|province|city|area/i,terms:["地区","区域","省份","城市","region","province","city","area"]},
  {value:"organization",pattern:/机构|律所|部门|团队|organization|office|department|team/i,terms:["机构","律所","部门","团队","organization","office","department","team","org_id","org_name"]},
];

const MEASURE_CONCEPTS=[
  {value:"won",pattern:/成单|成交|赢单|签单|closed(?:[_\s-]?won)?|won(?:[_\s-]?order)?/i,aggregation:"count_distinct",timeRole:"completion",terms:["成单","成交","赢单","签单","订单成单","closed","won","is_win_order","order_time","closed_at","won_at","completed_at","deal_time"]},
  {value:"completed",pattern:/完成数|完成量|结案数|办结数|completed[_\s-]?(?:count|volume)/i,aggregation:"count_distinct",timeRole:"completion",terms:["完成数","完成量","结案数","办结数","完成时间","结案时间","completed_count","completed_at","closed_at"]},
  {value:"revenue",pattern:/销售额|成交额|订单金额|交易金额|合同金额|收入|营收|回款金额|revenue|sales_amount/i,aggregation:"sum",timeRole:null,terms:["销售额","成交额","订单金额","交易金额","合同金额","收入","营收","金额","revenue","amount","order_amount","sales_amount"]},
  {value:"rate",pattern:/成单率|成交率|赢单率|签单率|转化率|成功率|完成率|复购率|退款率|留存率|激活率|退货率|占比|比例|[\p{Script=Han}]{2,8}率|conversion[_\s-]?rate|\brate\b/iu,aggregation:"ratio",timeRole:null,terms:["率","转化率","成功率","完成率","复购率","退款率","留存率","占比","比例","conversion_rate","rate","ratio"]},
  {value:"average",pattern:/平均|均值|人均|客均|average|\bavg\b/i,aggregation:"avg",timeRole:null,terms:["平均","均值","人均","客均","average","avg"]},
  {value:"count",pattern:/数量|个数|总数|多少(?:个|条|笔|人)|\bcount\b|\bvolume\b/i,aggregation:"count_distinct",timeRole:null,terms:["数量","个数","总数","count","volume","id","主键"]},
];

const TIME_ROLE_CONCEPTS=[
  {value:"entry",pattern:/进线|入池|录入|创建|新增|注册|entered|created|registered/i,terms:["进线时间","入池时间","创建时间","新增时间","注册时间","clue_create_time","created_at","create_time","entered_at","registered_at"]},
  {value:"completion",pattern:/成单|成交|赢单|签单|完成|结案|closed|won|completed/i,terms:["成单时间","成交时间","赢单时间","签单时间","完成时间","结案时间","order_time","closed_at","won_at","completed_at","deal_time"]},
  {value:"order",pattern:/下单|订购|购买|ordered|purchased/i,terms:["下单时间","订单时间","购买时间","order_time","ordered_at","purchase_time","purchased_at"]},
  {value:"payment",pattern:/支付|付款|回款|到账|paid|payment/i,terms:["支付时间","付款时间","回款时间","到账时间","paid_at","payment_time","receive_time"]},
  {value:"activation",pattern:/激活|开通|启用|activated/i,terms:["激活时间","开通时间","activation_time","activated_at","enabled_at"]},
];

const QUERY_PREFIX=/^(?:请|帮我|麻烦)*(?:查询一下|查一下|统计一下|看一下|看下|了解一下|分析一下|查询|查|统计|看看|分析)/;
const ORGANIZATION_SUFFIX=/(律师事务所|律所|事务所)/;
const SUBJECT_BOUNDARY=/(?:本月|这个月|当月|上月|上个月|本周|这周|上周|本星期|这个星期|上星期|上个星期|本季度|这个季度|当季|本季|上季度|上个季度|上一季度|今年|本年度?|当年|去年|上一?年|今天|今日|昨天|昨日|明天|明日|前天|后天|上半年|下半年|年初|年末|月初|月末|近|\d{4}年|最近|过去|未来|截至|截止|所有账号|全部账号|完整账号|全量账号|账号|账户|进线|线索|客户|用户|订单|案件|收入|营收|销售)/;
const LOCATION_ONLY=new Set(["北京","北京市","上海","上海市","天津","天津市","重庆","重庆市","全国"]);
const FILTER_FIELD_CONCEPTS=[
  {value:"status",aliases:["线索状态","客户状态","订单状态","支付状态","激活状态","案件状态","账号状态","账户状态","状态"],terms:["状态","status","state"]},
  {value:"type",aliases:["线索类型","客户类型","订单类型","案件类型","账号类型","账户类型","类型"],terms:["类型","type","category"]},
  {value:"channel",aliases:["线索渠道","获客渠道","渠道"],terms:["渠道","channel","source_channel"]},
  {value:"source",aliases:["线索来源","客户来源","来源"],terms:["来源","source","origin"]},
  {value:"level",aliases:["客户等级","线索等级","等级"],terms:["等级","级别","level","grade","tier"]},
  {value:"region",aliases:["所属地区","地区","省份","城市"],terms:["地区","省份","城市","region","province","city","area"]},
  {value:"brand",aliases:["品牌"],terms:["品牌","brand"]},
  {value:"amount",aliases:["订单金额","合同金额","成交金额","回款金额","销售额","金额"],terms:["金额","销售额","amount","revenue","sales_amount","order_amount"],numeric:true},
  {value:"age",aliases:["客户年龄","用户年龄","年龄"],terms:["年龄","age"],numeric:true},
  {value:"count",aliases:["购买次数","下单次数","跟进次数","次数"],terms:["次数","count","times"],numeric:true},
];
const FILTER_OPERATOR_ALIASES=[
  ["大于等于","gte"],["不少于","gte"],["不小于","gte"],["至少","gte"],
  ["小于等于","lte"],["不超过","lte"],["不大于","lte"],["至多","lte"],
  ["不等于","neq"],["不是","neq"],["不为","neq"],
  ["!=","neq"],["<>","neq"],
  [">=","gte"],["<=","lte"],
  ["大于","gt"],["超过","gt"],["高于","gt"],
  ["小于","lt"],["低于","lt"],["少于","lt"],
  [">","gt"],["<","lt"],
  ["包含","contains"],["含有","contains"],
  ["等于","eq"],["为","eq"],["是","eq"],["=","eq"],
];

export function parseQueryIntent(question,{now=new Date(),concepts=[],filterConcepts=[],rowDomainConcepts=[],protectedTermAliases=[],timeZone}={}) {
  const rawQuestion=String(question||"").trim();
  const normalizedQuestion=rawQuestion.replace(/\s+/g,"").replace(/[？?。！!，,；;：:]/g,"");
  const resolvedTimeZone=resolveBusinessTimeZone(timeZone);
  const organization=extractOrganizationEntity(normalizedQuestion);
  const preliminarySubjects=detectSubjects(normalizedQuestion);
  const filterQuestion=rawQuestion.replace(/[？?。！；;：:]/g," ").replace(/!+(?!=)/g," ");
  const deletionResolution=detectDeletionScope(filterQuestion,{subjects:preliminarySubjects});
  let filterInput=organization?.sourceText?filterQuestion.replace(organization.sourceText," ".repeat(organization.sourceText.length)):filterQuestion;
  if(deletionResolution.span)filterInput=maskTextSpans(filterInput,[deletionResolution.span]);
  const filterResolution=detectBusinessFilters(filterInput,{subjects:preliminarySubjects,concepts:filterConcepts,protectedTermAliases:[...(protectedTermAliases||[]),...(rowDomainConcepts||[]).flatMap((item)=>item.aliases||[])]});
  const rowDomainResolution=detectKnowledgeRowDomains(rawQuestion,rowDomainConcepts,{subjects:preliminarySubjects,excludedSpans:filterResolution.spans});
  const semanticRawQuestion=maskTextSpans(rawQuestion,[...filterResolution.spans,...rowDomainResolution.spans,...(deletionResolution.span?[deletionResolution.span]:[])]);
  const semanticQuestion=semanticRawQuestion.replace(/\s+/g,"").replace(/[？?。！!，,；;：:]/g,"");
  const detectedSubjects=detectSubjects(semanticQuestion);
  const attachedSubjects=[...filterResolution.filters,...rowDomainResolution.filters].map((filter)=>filter.attachesTo).filter(Boolean);
  const subjects=[...new Set([...detectedSubjects,...attachedSubjects,...(rowDomainResolution.spans.length?preliminarySubjects:[]),...(deletionResolution.ambiguity?preliminarySubjects:[])])];
  const timeResolution=detectTimeRange(maskEntitySpan(semanticQuestion,organization?.span),now,resolvedTimeZone);
  const timeRange=timeResolution.range;
  const shape=detectQueryShape(semanticQuestion);
  const comparisonRange=detectComparisonRange(shape,timeRange);
  const dimensions=detectDimensions(semanticQuestion,shape,concepts);
  const measures=detectMeasures(semanticQuestion,subjects,shape,concepts);
  const timeRole=detectTimeRole(semanticQuestion,timeRange,measures,shape.kind==="trend");
  const allProductScope=/(?:所有|全部|完整|全量|不限)(?:的)?产品|全产品|取消产品限制/.test(normalizedQuestion);
  const exhaustive=/(?:所有|全部|完整|全量|各个).{0,12}(?:账号|账户)|(?:账号|账户).{0,12}(?:所有|全部|完整|全量)/.test(normalizedQuestion)||allProductScope;
  const products=[];
  if(/alpha/i.test(normalizedQuestion.replace(/alpha\s*gpt/ig,"")))products.push("alpha");
  if(/alpha\s*gpt|alphagpt/i.test(normalizedQuestion))products.push("alphaGpt");
  const filterReset=detectFilterReset(normalizedQuestion,filterConcepts);
  const organizationLiteralUnsafe=Boolean(organization&&/[\\%_]/.test(organization.text));
  const organizationBinding=organizationFilterBinding(filterConcepts);
  const entities=organization?[organization]:[];
  const normalizedFilters=[...filterResolution.filters,...rowDomainResolution.filters].map((filter)=>filter.attachesTo||subjects.length!==1?filter:{...filter,attachesTo:subjects[0]});
  const filters=[...(organization&&!organizationLiteralUnsafe?[{id:`filter:organization_name:0`,kind:"organization_name",field:"organization_name",fieldSurface:"机构名称",fieldTerms:["机构名称","律所名称","所属律所","组织名称","office_name","organization_name","org_name","firm_name",...(organizationBinding.terms||[])],physicalColumns:[...(organizationBinding.physicalColumns||[])],operator:"contains",value:organization.text,valueType:"string",attachesTo:subjects.length===1?subjects[0]:null,immutable:true,sourceText:organization.sourceText,...(organizationBinding.provenance?{provenance:organizationBinding.provenance}:{})}]:[]),...normalizedFilters,...(deletionResolution.filter?[{...deletionResolution.filter,attachesTo:deletionResolution.filter.attachesTo||(subjects.length===1?subjects[0]:null)}]:[])];
  const ambiguities=[];
  if(subjects.length===0)ambiguities.push({code:"SUBJECT_UNKNOWN",message:"未识别出明确的业务对象",blocking:false});
  if(shape.kind==="ranking"&&!dimensions.length)ambiguities.push({code:"RANKING_DIMENSION_UNKNOWN",message:"排行问题未识别出明确的分组维度",blocking:true,options:["按业务对象负责人","按产品或渠道","补充其他排行维度"]});
  if(shape.kind==="ranking"&&!measures.length)ambiguities.push({code:"RANKING_MEASURE_UNKNOWN",message:"排行问题未识别出明确的统计指标",blocking:true,options:["按数量排行","按金额排行","补充其他业务指标"]});
  if(shape.kind==="ranking"&&shape.requestedLimitInvalid)ambiguities.push({code:"RANKING_LIMIT_INVALID",message:`排行数量“${shape.requestedLimitInvalid}”不是有效的正整数`,blocking:true,options:["补充有效的 Top 数量","不指定数量，使用系统安全上限"]});
  if(measures.some((item)=>item.grain==="unknown"))ambiguities.push({code:"MEASURE_GRAIN_AMBIGUOUS",message:"统计指标的去重粒度不明确，COUNT(*) 不能作为默认业务口径",blocking:true,options:["按业务对象去重","按事件或订单去重","使用已登记指标口径"]});
  if(timeResolution.unknown)ambiguities.push({code:"TIME_RANGE_UNKNOWN",message:`时间范围“${timeResolution.unknown.sourceText}”无法安全解析为唯一的左闭右开日期区间`,blocking:true,options:["本周","本月","本季度","今年","补充明确起止日期"],sourceText:timeResolution.unknown.sourceText,reason:timeResolution.unknown.reason});
  if((timeRange||shape.kind==="trend")&&timeRole?.ambiguous)ambiguities.push({code:"TIME_ROLE_AMBIGUOUS",message:"时间要求可确定，但无法唯一判断应绑定哪个业务事件时间",blocking:true,options:timeRole.candidates.map((item)=>item.value)});
  if((timeRange||shape.kind==="trend")&&measures.length&&!timeRole)ambiguities.push({code:"TIME_ROLE_UNKNOWN",message:"指标包含时间要求，但没有识别出对应的业务事件时间",blocking:true,options:["创建或进入时间","完成或成单时间","支付或回款时间"]});
  if(shape.kind==="trend"&&!shape.timeGrain)ambiguities.push({code:"TIME_GRAIN_UNKNOWN",message:"趋势问题没有说明按日、周、月、季度还是年汇总",blocking:true,options:["按日","按周","按月"]});
  if(shape.kind==="comparison"&&!comparisonRange)ambiguities.push({code:"COMPARISON_BASELINE_UNKNOWN",message:"对比问题没有形成明确的当前期和基准期窗口",blocking:true,options:["补充当前统计周期","明确同比或环比"]});
  for(const measure of measures.filter((item)=>item.aggregation==="ratio"&&item.evidence?.level!=="verified_knowledge"&&(item.definitionCandidates||[]).length<=1))ambiguities.push({code:"MEASURE_DEFINITION_REQUIRED",message:`比例指标“${measure.sourceText||measure.value}”缺少已验证的分子、分母和去重口径`,blocking:true,options:["选择已登记指标口径","先补充指标定义"]});
  for(const measure of measures.filter((item)=>(item.definitionCandidates||[]).length>1))ambiguities.push({code:"METRIC_AMBIGUOUS",message:`“${measure.sourceText||measure.value}”匹配到多个已验证指标定义`,blocking:true,options:measure.definitionCandidates.map((item)=>item.title||item.source)});
  if(shape.kind==="ranking"&&dimensions.some((item)=>item.value==="seller")&&measures.some((item)=>item.timeRole==="completion")&&!explicitAttribution(normalizedQuestion))ambiguities.push({code:"DIMENSION_ATTRIBUTION_AMBIGUOUS",message:"销售归属未说明是当前负责人还是事件发生时负责人，两种口径可能产生不同排行",blocking:true,options:["当前负责人","事件发生时负责人"]});
  ambiguities.push(...filterResolution.ambiguities);
  ambiguities.push(...rowDomainResolution.ambiguities);
  if(filterReset.ambiguity)ambiguities.push(filterReset.ambiguity);
  if(allProductScope)ambiguities.push({code:"PRODUCT_SCOPE_REGISTRY_REQUIRED",message:"问题要求覆盖所有产品，但当前意图中没有已发布且可穷举的产品注册表，系统不会把“所有产品”退化为任意单一产品",blocking:true,sourceText:matched(normalizedQuestion,/(?:所有|全部|完整|全量|不限)(?:的)?产品|全产品|取消产品限制/),options:["明确列出需要覆盖的产品","发布该业务对象的完整产品注册表"]});
  if(organizationLiteralUnsafe)ambiguities.push({code:"ENTITY_LITERAL_ESCAPE_UNSUPPORTED",message:`机构专名“${organization.text}”含有 LIKE 通配或转义字符，当前无法证明其字面包含语义`,blocking:true,sourceText:organization.sourceText,options:["去掉通配符并输入完整机构名称","发布带明确 ESCAPE 规则的机构匹配能力"]});
  if(deletionResolution.ambiguity)ambiguities.push({...deletionResolution.ambiguity,candidateSubjects:[...preliminarySubjects]});
  const resolvedTimeRole=timeRole?.ambiguous?null:timeRole;
  const intent={
    version:QUERY_INTENT_VERSION,
    timeZone:resolvedTimeZone,
    rawQuestion,
    normalizedQuestion,
    semanticQuestion,
    subjects,
    entities,
    filters,
    timeRange,
    comparisonRange,
    timeRole:resolvedTimeRole,
    shape,
    dimensions,
    measures,
    scope:{exhaustive,exhaustiveExplicit:exhaustive,products,productExplicit:products.length>0,includeDeleted:deletionResolution.mode==="include_deleted",deletionMode:deletionResolution.mode,deletionExplicit:deletionResolution.mode!=="default_active"&&deletionResolution.mode!=="unknown",deletionTargets:deletionResolution.mode!=="default_active"&&deletionResolution.mode!=="unknown"?[...subjects]:[],filterReset:filterReset.explicit,filterResetAll:filterReset.all,filterResetFields:filterReset.fields,scopeReset:explicitScopeReset(normalizedQuestion),contextReset:/仅当前问题/.test(normalizedQuestion),timeReset:explicitTimeReset(normalizedQuestion),timeExplicit:Boolean(timeRange)||explicitTimeReset(normalizedQuestion)},
    ambiguities,
  };
  const withRequirements={...intent,requirements:buildRequirements(intent)};
  return {...withRequirements,retrievalTerms:buildRetrievalTerms(withRequirements)};
}

export function knowledgeIntentConcepts(pages=[],columnsByTable={}) {
  return (pages||[]).filter((page)=>page?.verified&&page.pageType==="metric").map((page)=>{
    const aliases=[page.title,...(page.aliases||[])].map((item)=>String(item||"").trim()).filter(Boolean);
    const definition=`${page.content||""} ${page.sqlContent||""}`;
    const roles=TIME_ROLE_CONCEPTS.filter((item)=>item.pattern.test(definition));
    const role=roles.length===1?roles[0]:null;
    let aggregation=inferKnowledgeAggregation(page.sqlContent);
    const formula=aggregation==="ratio"?inferKnowledgeRatioFormula(page,columnsByTable):null;
    const referencedColumns=extractKnowledgeColumnRefs(page,columnsByTable).map((item)=>`${item.table}.${item.column}`);
    if(aggregation==="unknown"&&referencedColumns.length&&/汇总|总额|总数|预计算|结果指标|summary|precomputed/i.test(definition))aggregation="precomputed";
    const definitionColumns=formula?[...new Set([...formula.numerator.columns,...formula.denominator.columns])]:referencedColumns;
    const rowCount=aggregation==="count"&&/\bCOUNT\s*\(\s*(?:\*|1)\s*\)/i.test(String(page.sqlContent||""));
    return {
      kind:"measure",
      value:`knowledge_${safeConceptId(page.slug||page.title)}`,
      aliases,
      aggregation,
      grain:aggregation==="precomputed"?"precomputed":inferKnowledgeGrain(definition),
      timeRole:role?.value||null,
      terms:[...aliases,...(page.tables||[]),...(String(page.sqlContent||"").match(/[a-z][a-z0-9_]{1,63}/ig)||[])],
      evidence:{level:"verified_knowledge",page:`${page.pageType}:${page.slug}`},
      metricDefinition:{aggregation,columns:definitionColumns,tables:[...(page.tables||[])],source:`${page.pageType}:${page.slug}`,...(rowCount?{rowCount:true}:{}),...(formula?{formula}: {})},
    };
  });
}

// Catalog-backed filter concepts turn datasource/ontology properties into
// field candidates before the intent is frozen.  The parser still records a
// business field surface, while physicalColumns remains proof supplied by the
// published catalog rather than a name guessed later by the model.
export function catalogFilterConcepts(tables=[],columnsByTable={},ontologySchema=null,termAnchors=[]) {
  const groups=new Map();
  const tableByName=new Map((tables||[]).map((table)=>[table.tableName,table]));
  const subjectLabels={clue:"线索",account:"账号",customer:"客户",order:"订单",case:"案件",revenue:"收入"};
  const add=(alias,column,{numeric=false,provenance="catalog",semanticKind=null}={})=>{
    const surface=String(alias||"").trim();const physical=String(column||"").toLowerCase();
    if(!surface||surface.length>64||!physical.includes(".")||/^[\p{P}\p{S}\s]+$/u.test(surface))return;
    const key=normalizeText(surface);const group=groups.get(key)||{alias:surface,columns:new Set(),terms:new Set(),numericStates:new Set(),semanticKinds:new Set(),provenance:new Set()};
    group.columns.add(physical);group.terms.add(surface);group.terms.add(physical);group.terms.add(physical.split(".").at(-1));group.numericStates.add(Boolean(numeric));if(semanticKind)group.semanticKinds.add(semanticKind);group.provenance.add(provenance);groups.set(key,group);
  };
  for(const [tableName,columns] of Object.entries(columnsByTable||{})) {
    const table=tableByName.get(tableName)||{tableName,comment:""};
    const tableSubjects=detectSubjects(`${tableName} ${table.comment||""}`);
    for(const column of columns||[]) {
      const semanticKind=typedColumnKind(column);
      // Sensitive columns remain queryable when the user supplies an exact,
      // self-identifying value (phone/e-mail/identity/card). Other sensitive
      // fields are intentionally not promoted into generic filter concepts.
      if(column?.isSensitive&&!semanticKind)continue;
      const physical=`${tableName}.${column.columnName}`;const numeric=numericDataType(column.dataType);
      add(column.columnName,physical,{numeric,semanticKind});
      for(const alias of typedKindAliases(semanticKind))add(alias,physical,{numeric:false,semanticKind});
      const comment=String(column.comment||"").trim();
      if(comment) {
        add(comment,physical,{numeric,semanticKind});
        for(const subject of tableSubjects)if(subjectLabels[subject]&&!normalizeText(comment).startsWith(subjectLabels[subject]))add(`${subjectLabels[subject]}${comment}`,physical,{numeric,semanticKind});
      }
    }
  }
  const anchors=new Map((termAnchors||[]).map((anchor)=>[`${anchor.vocabulary}\u0000${anchor.canonicalId}`,anchor]));
  for(const object of ontologySchema?.objectTypes||[])for(const property of object?.properties||[]) {
    const table=property?.mapping?.table;const column=property?.mapping?.column;
    if(!table||!column||(columnsByTable?.[table]||[]).every((item)=>String(item.columnName)!==String(column)))continue;
    const metadata=(columnsByTable[table]||[]).find((item)=>String(item.columnName)===String(column));
    const aliases=[property.displayName,property.apiName];
    const binding=property.termBinding;const anchor=binding?anchors.get(`${binding.vocabulary}\u0000${binding.canonicalId}`):null;
    aliases.push(anchor?.prefLabelZh,anchor?.prefLabelEn,...(anchor?.altLabels||[]));
    for(const alias of aliases.filter(Boolean))add(alias,`${table}.${column}`,{numeric:numericDataType(metadata?.dataType),semanticKind:typedColumnKind(metadata),provenance:"published_ontology_property"});
  }
  return [...groups.values()].map((group)=>{
    const fallback=`catalog_${safeConceptId(group.alias)}`;
    const categorical=/(?:状态|类型|渠道|来源|等级|级别|status|state|type|category|channel|source|origin|level|grade|tier)/i.test(group.alias);
    return {
      value:fallback,
      fieldId:filterFieldIdentity(group.alias,fallback),
      aliases:[group.alias],
      terms:[...group.terms],
      physicalColumns:[...group.columns].sort(),
      numeric:categorical?false:group.numericStates.size===1?[...group.numericStates][0]:null,
      semanticKind:group.semanticKinds.size===1?[...group.semanticKinds][0]:null,
      provenance:[...group.provenance].sort(),
    };
  });
}

function typedColumnKind(column={}) {
  const text=`${column.columnName||""} ${column.comment||""}`;
  if(/(?:mobile|phone|telephone|tel(?:ephone)?|cell|手机号|联系电话|手机号码|电话)/i.test(text))return "phone";
  if(/(?:e_?mail|mail_?address|邮箱|电子邮件)/i.test(text))return "email";
  if(/(?:id_?card|identity|身份证|证件号)/i.test(text))return "china_id";
  if(/(?:bank_?card|card_?no|银行卡|银行账号)/i.test(text))return "bank_card";
  return null;
}

function typedKindAliases(kind) {
  return ({phone:["手机号","手机号码","联系电话","phone","mobile"],email:["邮箱","电子邮件","email"],china_id:["身份证号","身份证号码","证件号","id_card"],bank_card:["银行卡号","银行账号","bank_card"]})[kind]||[];
}

function organizationFilterBinding(concepts=[]) {
  const candidates=(concepts||[]).filter((concept)=>[...(concept.aliases||[]),...(concept.terms||[])].some((term)=>/(?:机构名称|组织名称|律所名称|所属律所(?:名称)?|律师事务所(?:名称)?|(?:office|organization|law_?firm|firm|org)_?name|name_of_(?:office|organization|firm|org))/i.test(String(term||""))));
  const published=candidates.filter((concept)=>(concept.provenance||[]).includes("published_ontology_property"));
  const selected=published.length?published:candidates;
  const physicalColumns=[...new Set(selected.flatMap((item)=>item.physicalColumns||[]).map((item)=>String(item).toLowerCase()))].sort();
  // Without a published mapping, leave sibling columns to retrieval's exact
  // ambiguity check. A single structural candidate remains usable for legacy
  // datasources; multiple same-table siblings fail closed.
  if(!published.length&&physicalColumns.length!==1)return {physicalColumns:[],terms:[],provenance:null};
  return {physicalColumns,terms:[...new Set(selected.flatMap((item)=>item.terms||[]))],provenance:published.length?{kind:"published_ontology_property",sources:["published_ontology_property"]}:null};
}

// A verified term/rule that defines a conjunction of direct physical
// predicates is executable row-domain knowledge.  It must become immutable
// filter slots; merely showing its SQL fragment to the LLM is not sufficient.
export function knowledgeIntentRowDomains(pages=[],columnsByTable={}) {
  const result=[];
  for(const page of pages||[]) {
    if(!page?.verified||!new Set(["term","rule"]).has(page.pageType))continue;
    const aliases=[page.title,...(page.aliases||[])].map((item)=>String(item||"").trim()).filter(Boolean);
    if(!aliases.length)continue;
    const parsed=predicateSignatures(page.sqlContent,page,columnsByTable,{strictFragment:true});
    const activationPolicy=page.activationPolicy==="global_table"?"global_table":"explicit_alias";
    const assetId=knowledgeAssetId(page);
    const evidence={level:"verified_knowledge",page:`${page.pageType}:${page.slug||safeConceptId(page.title)}`,assetId,assetKind:activationPolicy==="global_table"?"datasource_rule":"knowledge_asset",activationPolicy,ruleId:page.ruleId??null,checksum:page.checksum||null,owner:page.owner||null};
    if(parsed.status==="physical"&&parsed.predicates.length) {
      result.push({aliases,evidence,activationPolicy,status:"physical",tables:[...(page.tables||[])],subjectHints:detectSubjects(aliases.join(" ")),filters:parsed.predicates.map((predicate,index)=>({
        id:`filter:knowledge:${assetId}:${index}`,
        requirementId:`filter:knowledge:${assetId}:${index}`,
        kind:"knowledge_row_domain",
        field:predicate.column.split(".").at(-1),
        fieldSurface:aliases[0],
        fieldTerms:[predicate.column,predicate.column.split(".").at(-1)],
        physicalColumns:[predicate.column],
        operator:knowledgeFilterOperator(predicate.operator,predicate.valueType),
        value:predicate.valueType==="null"?null:predicate.value,
        valueType:predicate.valueType,
        valueBinding:"verified_knowledge",
        immutable:true,
        provenance:evidence,
      }))});
    } else if(rowDomainSqlSignal(page.sqlContent))result.push({aliases,evidence,activationPolicy,status:"unsupported",tables:[...(page.tables||[])],reason:parsed.reason||"predicate_not_physically_bound",filters:[],subjectHints:detectSubjects(aliases.join(" "))});
  }
  return result;
}

function knowledgeAssetId(page) {
  const kind=String(page?.pageType||"asset").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"")||"asset";
  const identity=page?.ruleId!==null&&page?.ruleId!==undefined?`rule:${String(page.ruleId)}`:`${kind}:${String(page?.slug??page?.title??"unknown")}`;
  const readableRule=page?.ruleId!==null&&page?.ruleId!==undefined?`_rule_${String(page.ruleId).replace(/[^a-z0-9]+/gi,"_").replace(/^_+|_+$/g,"")||"id"}`:"";
  return `${kind}${readableRule}_${stableTextHash(`${identity}\u0000${String(page?.checksum||"")}`)}`;
}

function stableTextHash(value) {
  let hash=2166136261;
  for(const char of String(value||"")){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}
  return (hash>>>0).toString(36);
}

export function applyGlobalRowDomainRules(intent,concepts=[],executionTables=[],{subjectExecutionTables=executionTables}={}) {
  const tables=new Set((executionTables||[]).map((item)=>String(item).toLowerCase()));const next=structuredClone(intent);
  const subjectTables=new Set((subjectExecutionTables||[]).map((item)=>String(item).toLowerCase()));
  const applicable=(concepts||[]).filter((concept)=>concept.activationPolicy==="global_table"&&(concept.tables||[]).some((table)=>tables.has(String(table).toLowerCase())));
  for(const concept of applicable) {
    if(concept.status!=="physical") {
      next.ambiguities.push({code:"GLOBAL_RULE_BINDING_UNSUPPORTED",message:`适用于当前业务对象的已验证规则“${concept.aliases?.[0]||concept.evidence.page}”不能完整绑定为直接物理谓词`,blocking:true,sourceText:concept.aliases?.[0]||"全局规则",reason:concept.reason,options:["修复并重新验证该全局规则"]});
      continue;
    }
    for(const filter of concept.filters||[]) {
      const filterTables=new Set((filter.physicalColumns||[]).map((column)=>String(column).toLowerCase().split(".")[0]));
      // Explicit deletion scope overrides the ordinary soft-delete convention
      // only on the requested subject root. Bridge, event and dimension rows
      // remain active, so their validity predicates/rules are retained.
      if(next.scope?.deletionExplicit&&softDeleteFilter(filter)&&[...filterTables].some((table)=>subjectTables.has(table)))continue;
      const duplicate=(next.filters||[]).some((item)=>knowledgePredicateKey(item)===knowledgePredicateKey(filter)&&item.provenance?.assetId===filter.provenance?.assetId);
      if(!duplicate)next.filters.push({...filter,attachesTo:null,scopeTables:[...(concept.tables||[])],sourceText:concept.aliases?.[0]||filter.sourceText,provenance:{...(filter.provenance||{}),activation:"global_table_rule"}});
    }
  }
  next.ambiguities=[...new Map((next.ambiguities||[]).map((item)=>[`${item.code}|${item.sourceText||""}|${item.reason||""}`,item])).values()];
  next.requirements=buildRequirements(next);next.retrievalTerms=buildRetrievalTerms(next);
  return next;
}

function knowledgePredicateKey(filter) {return `${(filter.physicalColumns||[]).map((item)=>String(item).toLowerCase()).sort().join(",")}|${filter.operator}|${filter.valueType}|${String(filter.value)}`;}
function softDeleteFilter(filter) {const names=(filter.physicalColumns||[]).map((item)=>String(item).toLowerCase().split(".").at(-1));return names.length>0&&names.every((name)=>name==="is_deleted"||name==="deleted_at");}

function detectKnowledgeRowDomains(question,concepts,{subjects=[],excludedSpans=[]}={}) {
  const text=String(question||"");const compact=compactTextMap(text);const matches=[];
  for(const concept of concepts||[])for(const alias of concept.aliases||[]) {
    if(concept.activationPolicy==="global_table")continue;
    const needle=normalizeText(alias);if(!needle)continue;
    let offset=0;
    while((offset=compact.text.indexOf(needle,offset))>=0) {
      const start=compact.map[offset]??0;const last=compact.map[offset+needle.length-1]??start;const end=last+1;
      if(!(excludedSpans||[]).some((span)=>start<span.end&&span.start<end))matches.push({concept,alias:String(alias),start,end,negated:knowledgeMentionNegated(text,start,end)});offset+=Math.max(1,needle.length);
    }
  }
  if(!matches.length)return {filters:[],ambiguities:[],spans:[]};
  const clusters=[];
  for(const item of [...matches].sort((left,right)=>left.start-right.start||right.end-left.end)) {
    const cluster=clusters.at(-1);
    if(!cluster||item.start>=cluster.end)clusters.push({start:item.start,end:item.end,items:[item]});
    else {cluster.items.push(item);cluster.end=Math.max(cluster.end,item.end);}
  }
  const selected=[];
  for(const cluster of clusters) {
    const maximum=Math.max(...cluster.items.map((item)=>normalizeText(item.alias).length));
    const strongest=cluster.items.filter((item)=>normalizeText(item.alias).length===maximum);
    const signatures=new Map();
    for(const item of strongest) {
      const signature=JSON.stringify((item.concept.filters||[]).map((filter)=>[filter.physicalColumns,filter.operator,filter.valueType,filter.value]));
      if(!signatures.has(signature))signatures.set(signature,item);
    }
    if(signatures.size!==1) {
      const item=strongest[0];const spans=clusters.map((entry)=>({start:entry.start,end:entry.end}));
      return {filters:[],ambiguities:[{code:"KNOWLEDGE_FILTER_AMBIGUOUS",message:`业务术语“${item.alias}”对应多个不同的已验证行域定义，执行前必须统一口径`,blocking:true,sourceText:item.alias,options:["保留一个已验证术语定义","使用更具体的术语别名"]}],spans};
    }
    selected.push([...signatures.values()][0]);
  }
  const spans=selected.map((item)=>({start:item.start,end:item.end}));
  const negated=selected.find((item)=>item.negated);
  if(negated)return {filters:[],ambiguities:[{code:"KNOWLEDGE_FILTER_NEGATED",message:`“${text.slice(negated.start,negated.end)}”处于否定、排除或补集表达中，当前不能反向套用正向术语口径`,blocking:true,sourceText:text.slice(negated.start,negated.end),options:["改用已登记的反义术语","明确写出字段和值"]}],spans};
  for(let index=1;index<selected.length;index++) {
    const gap=text.slice(selected[index-1].end,selected[index].start).replace(/\s+/g,"");
    if(/(?:或者|或|、|\/)/.test(gap))return {filters:[],ambiguities:[{code:"KNOWLEDGE_FILTER_BOOLEAN_UNSUPPORTED",message:"多个已验证术语之间包含 OR、枚举或集合语义，当前无法证明完整行域",blocking:true,sourceText:text.slice(selected[index-1].start,selected[index].end),options:["改为明确的 AND 组合","拆分为多个独立问题"]}],spans};
    if(!/^(?:中的?|且|并且|同时|以及|和|与|并|,|，)*$/.test(gap))return {filters:[],ambiguities:[{code:"KNOWLEDGE_FILTER_COMBINATION_AMBIGUOUS",message:"多个已验证术语之间缺少可证明的合取关系，系统不会只保留其中一部分",blocking:true,sourceText:text.slice(selected[index-1].start,selected[index].end),options:["使用“且”明确合取","拆分为多个独立问题"]}],spans};
  }
  const filters=[];
  for(const item of selected) {
    if(item.concept.status!=="physical")return {filters:[],ambiguities:[{code:"KNOWLEDGE_FILTER_BINDING_UNSUPPORTED",message:`已验证术语“${item.alias}”的行域定义不能完整绑定为直接物理谓词`,blocking:true,sourceText:item.alias,reason:item.concept.reason,options:["完善该术语的物理谓词定义"]}],spans};
    const owner=item.concept.subjectHints?.length===1?item.concept.subjectHints[0]:subjects.length===1?subjects[0]:null;
    filters.push(...(item.concept.filters||[]).map((filter)=>({...filter,attachesTo:owner,sourceText:item.alias,span:{start:item.start,end:item.end},provenance:{...(filter.provenance||{}),activation:"explicit_alias"}})));
  }
  return {filters:[...new Map(filters.map((item)=>[`${item.provenance?.assetId}|${knowledgePredicateKey(item)}`,item])).values()],ambiguities:[],spans};
}

function knowledgeMentionNegated(text,start,end) {
  const prefix=String(text||"").slice(Math.max(0,start-12),start).replace(/\s+/g,"");
  const suffix=String(text||"").slice(end,Math.min(String(text||"").length,end+4)).replace(/\s+/g,"");
  if(/(?:不属于|不查|不统计|不看|排除掉?|过滤掉|跳过|忽略|拒绝|不要|别查|剔除|去掉|去除|除去|除了|不含|不包括|不包含|并非|不算|无需|不是|非|不|未|无)$/.test(prefix))return true;
  if(/^(?:除外|以外|之外)/.test(suffix))return true;
  return /除$/.test(prefix)&&/^(?:以外|之外|外)/.test(suffix);
}

function compactTextMap(value) {
  let text="";const map=[];
  for(let index=0;index<String(value||"").length;index++) {
    const char=String(value)[index];if(/\s|[？?。！!，,；;：:]/u.test(char))continue;
    text+=char.toLowerCase();map.push(index);
  }
  return {text,map};
}

function maskTextSpans(value,spans=[]) {
  const chars=String(value||"").split("");
  for(const span of spans||[])if(Number.isInteger(span?.start)&&Number.isInteger(span?.end))for(let index=Math.max(0,span.start);index<Math.min(chars.length,span.end);index++)chars[index]=" ";
  return chars.join("");
}

function explicitScopeReset(value) {return /不限产品|所有产品|全部产品|取消产品限制|仅当前问题/.test(String(value||""));}
function explicitTimeReset(value) {return /不限时间|全部时间|所有时间|取消(?:时间|日期)(?:范围|限制)?|不(?:再)?限制(?:时间|日期)|时间不限|日期不限/.test(String(value||""));}
function explicitContextAddition(value) {return /^(?:那|然后|另外)?(?:再加上|并且|同时(?:满足)?|还要|也要)/.test(normalizeText(value).replace(/^[，,。；;]+/,""));}
function detectFilterReset(value,concepts=[]) {
  const text=String(value||"");
  if(/(?:取消|清除|去掉)(?:全部|所有)(?:筛选|过滤)(?:条件)?|不(?:再)?使用任何(?:筛选|过滤)|仅当前问题/.test(text))return {explicit:true,all:true,fields:[],ambiguity:null};
  const aliases=[...new Set([...(concepts||[]).flatMap((item)=>item.aliases||[]),...FILTER_FIELD_CONCEPTS.flatMap((item)=>item.aliases||[])])].map(String).filter(Boolean).sort((left,right)=>right.length-left.length);
  const aliasPattern=aliases.map(escapeRegExp).join("|");
  const match=aliasPattern?text.match(new RegExp(`(?:不限|不(?:再)?限制|取消|去掉|清除)(?:对)?(${aliasPattern})(?:的)?(?:筛选|过滤|限制)?|(?:全部|所有)(${aliasPattern})`,"iu")):null;
  if(match) {
    const alias=match[1]||match[2];const concept=(concepts||[]).find((item)=>(item.aliases||[]).some((candidate)=>normalizeText(candidate)===normalizeText(alias)))||FILTER_FIELD_CONCEPTS.find((item)=>(item.aliases||[]).some((candidate)=>normalizeText(candidate)===normalizeText(alias)));
    return {explicit:true,all:false,fields:[concept?.fieldId||filterFieldIdentity(alias,concept?.value||"attribute")],ambiguity:null};
  }
  if(/(?:取消|去掉|清除).{0,12}(?:筛选|过滤)|不(?:再)?限制|不限|不筛选/.test(text)&&!explicitTimeReset(text)&&!explicitScopeReset(text))return {explicit:true,all:false,fields:[],ambiguity:{code:"FILTER_RESET_TARGET_UNKNOWN",message:"筛选取消请求没有绑定到唯一字段，系统不会清空其他仍有效的筛选条件",blocking:true,sourceText:text,options:["说明要取消的字段","明确说取消全部筛选"]}};
  return {explicit:false,all:false,fields:[],ambiguity:null};
}
function numericDataType(value) {return /(?:tinyint|smallint|mediumint|bigint|decimal|numeric|number|float|double|real|integer|\bint\b)/i.test(String(value||""));}
function rowDomainSqlSignal(value) {return /(?:=|!=|<>|>=|<=|>|<|\bIS\s+(?:NOT\s+)?NULL\b|\bLIKE\b|\bIN\s*\(|\bBETWEEN\b)/i.test(String(value||""));}
function knowledgeFilterOperator(operator,valueType) {
  if(valueType==="null")return String(operator).toLowerCase().includes("not")?"not_null":"is_null";
  return ({"=":"eq","!=":"neq","<>":"neq",">":"gt",">=":"gte","<":"lt","<=":"lte","like":"contains"})[String(operator||"").toLowerCase()]||String(operator||"").toLowerCase();
}

export function applyIntentClarification(intent,answer,{now=new Date()}={}) {
  const text=String(answer||"").trim();
  if(!text||!intent?.ambiguities?.some((item)=>item.blocking))return intent;
  const next=structuredClone(intent);
  const resolved=new Set();
  if((next.ambiguities||[]).some((item)=>item.code==="TIME_RANGE_UNKNOWN"&&item.blocking)) {
    const normalizedTimeAnswer=text.replace(/\s+/g,"").replace(/[？?。！!，,；;：:]/g,"");
    const timeResolution=detectTimeRange(normalizedTimeAnswer,now,resolveBusinessTimeZone(next.timeZone));
    if(timeResolution.range) {
      next.timeRange=timeResolution.range;
      next.comparisonRange=detectComparisonRange(next.shape,next.timeRange);
      const clarifiedRole=detectTimeRole(`${next.normalizedQuestion}${normalizedTimeAnswer}`,next.timeRange,next.measures,next.shape?.kind==="trend");
      if(clarifiedRole?.ambiguous) {
        next.timeRole=null;
        if(!next.ambiguities.some((item)=>item.code==="TIME_ROLE_AMBIGUOUS"))next.ambiguities.push({code:"TIME_ROLE_AMBIGUOUS",message:"时间要求可确定，但无法唯一判断应绑定哪个业务事件时间",blocking:true,options:clarifiedRole.candidates.map((item)=>item.value)});
      } else if(clarifiedRole)next.timeRole=clarifiedRole;
      else if(next.measures?.length&&!next.ambiguities.some((item)=>item.code==="TIME_ROLE_UNKNOWN"))next.ambiguities.push({code:"TIME_ROLE_UNKNOWN",message:"指标包含时间要求，但没有识别出对应的业务事件时间",blocking:true,options:["创建或进入时间","完成或成单时间","支付或回款时间"]});
      resolved.add("TIME_RANGE_UNKNOWN");
      if(next.timeRole){resolved.add("TIME_ROLE_UNKNOWN");resolved.add("TIME_ROLE_AMBIGUOUS");}
      if(next.comparisonRange)resolved.add("COMPARISON_BASELINE_UNKNOWN");
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="RANKING_DIMENSION_UNKNOWN"&&item.blocking)) {
    const clarified=detectDimensions(text,next.shape||{kind:"ranking"},[]);
    if(clarified.length) {
      next.dimensions=[...new Map([...(next.dimensions||[]),...clarified].map((item)=>[item.id,item])).values()];
      resolved.add("RANKING_DIMENSION_UNKNOWN");
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="RANKING_MEASURE_UNKNOWN"&&item.blocking)) {
    const clarified=detectMeasures(text,next.subjects||[],next.shape||{kind:"ranking"},[]);
    if(clarified.length) {
      next.measures=[...new Map([...(next.measures||[]),...clarified].map((item)=>[item.id,item])).values()];
      const clarifiedRole=detectTimeRole(`${next.normalizedQuestion}${text}`,next.timeRange,next.measures,next.shape?.kind==="trend");
      if(clarifiedRole&&!clarifiedRole.ambiguous)next.timeRole=clarifiedRole;
      resolved.add("RANKING_MEASURE_UNKNOWN");
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="RANKING_LIMIT_INVALID"&&item.blocking)) {
    const top=String(text).match(/(?:top|前)\s*(\d+)/i);
    const value=top?Number(top[1]):null;
    if(Number.isSafeInteger(value)&&value>0) {
      next.shape.requestedLimit=value;delete next.shape.requestedLimitInvalid;resolved.add("RANKING_LIMIT_INVALID");
    } else if(/不指定|系统安全上限|默认上限/.test(text)) {
      next.shape.requestedLimit=null;delete next.shape.requestedLimitInvalid;resolved.add("RANKING_LIMIT_INVALID");
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="COMPARISON_BASELINE_UNKNOWN"&&item.blocking)) {
    if(/同比|去年同期|上年同期/.test(text))next.shape.comparisonMode="year_over_year";
    else if(/环比|上期|上一周期|与上月|和上月|与上周|和上周|与上季度|和上季度/.test(text))next.shape.comparisonMode="period_over_period";
    let comparison=detectComparisonRange(next.shape,next.timeRange);
    if(!comparison) {
      const explicit=detectTimeRange(text,now,resolveBusinessTimeZone(next.timeZone));
      if(explicit.range)comparison={...explicit.range,kind:"comparison_custom",sourceText:text};
    }
    if(comparison){next.comparisonRange=comparison;resolved.add("COMPARISON_BASELINE_UNKNOWN");}
  }
  const filterAmbiguityCodes=new Set(["FILTER_BOOLEAN_UNSUPPORTED","FILTER_EXPRESSION_UNSUPPORTED","FILTER_VALUE_TYPE_UNSUPPORTED","FILTER_OPERATOR_UNSUPPORTED"]);
  if((next.ambiguities||[]).some((item)=>item.blocking&&filterAmbiguityCodes.has(item.code))) {
    const clarificationConcepts=(next.ambiguities||[]).filter((item)=>item.blocking&&filterAmbiguityCodes.has(item.code)&&item.filterCandidate).map((item)=>item.filterCandidate);
    const clarified=detectBusinessFilters(text,{subjects:next.subjects||[],concepts:clarificationConcepts});
    if(clarified.filters.length&&!clarified.ambiguities.length) {
      const fields=new Set(clarified.filters.map((item)=>item.field));
      next.filters=[...(next.filters||[]).filter((item)=>item.kind==="organization_name"||!fields.has(item.field)),...clarified.filters];
      next.ambiguities=(next.ambiguities||[]).filter((item)=>!filterAmbiguityCodes.has(item.code)||!fields.has(item.field));
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="FILTER_RESET_TARGET_UNKNOWN"&&item.blocking)) {
    const candidates=(next.ambiguities||[]).map((item)=>item.filterCandidate).filter(Boolean);
    const reset=detectFilterReset(normalizeText(text),candidates);
    if(reset.explicit&&!reset.ambiguity) {
      const resetFields=new Set(reset.fields);const resetAssets=new Set((next.filters||[]).filter((item)=>explicitKnowledgeFilter(item)&&[...resetFields].some((field)=>filterResetMatches(field,item.field))).map((item)=>item.provenance?.assetId).filter(Boolean));
      next.filters=(next.filters||[]).filter((item)=>item.provenance?.activation==="global_table_rule"||!reset.all&&![...resetFields].some((field)=>filterResetMatches(field,item.field))&&!resetAssets.has(item.provenance?.assetId));
      next.scope={...(next.scope||{}),filterReset:true,filterResetAll:reset.all,filterResetFields:[...resetFields],removedKnowledgeGroups:[...resetAssets]};resolved.add("FILTER_RESET_TARGET_UNKNOWN");
    }
  }
  if((next.ambiguities||[]).some((item)=>item.code==="DELETION_SCOPE_UNKNOWN"&&item.blocking)) {
    const ambiguity=(next.ambiguities||[]).find((item)=>item.code==="DELETION_SCOPE_UNKNOWN"&&item.blocking);
    const answerSubjects=detectSubjects(text);const candidateSubjects=ambiguity?.candidateSubjects||next.subjects||[];
    const clarificationSubjects=answerSubjects.length===1?answerSubjects:candidateSubjects.length===1?candidateSubjects:[];
    const clarified=detectDeletionScope(text.replace(/\s+/g,""),{subjects:clarificationSubjects});
    if(!clarified.ambiguity&&clarified.mode!=="default_active") {
      const target=clarificationSubjects.length===1?clarificationSubjects[0]:null;
      if(target) {
        next.filters=[...(next.filters||[]).filter((item)=>item.field!=="is_deleted"||item.attachesTo!==target),...(clarified.filter?[{...clarified.filter,attachesTo:target}]:[])];
        next.scope={...(next.scope||{}),includeDeleted:clarified.mode==="include_deleted",deletionMode:clarified.mode,deletionExplicit:true,deletionTargets:[target]};
        resolved.add("DELETION_SCOPE_UNKNOWN");
      }
    }
  }
  const attributionChoice=explicitAttribution(text);
  if(attributionChoice==="current") {
    for(const dimension of next.dimensions||[])if(dimension.value==="seller")dimension.attribution="current";
    resolved.add("DIMENSION_ATTRIBUTION_AMBIGUOUS");
  } else if(attributionChoice==="event_time") {
    for(const dimension of next.dimensions||[])if(dimension.value==="seller")dimension.attribution="event_time";
    resolved.add("DIMENSION_ATTRIBUTION_AMBIGUOUS");
  }
  const role=TIME_ROLE_CONCEPTS.find((item)=>item.pattern.test(text));
  if(role&&(next.timeRange||next.shape?.kind==="trend")) {
    next.timeRole={value:role.value,sourceText:text,terms:[...role.terms],attachesTo:next.measures?.[0]?.id||null};
    resolved.add("TIME_ROLE_AMBIGUOUS");resolved.add("TIME_ROLE_UNKNOWN");
  }
  const timeGrain=clarifiedTimeGrain(text);
  if(timeGrain&&next.shape?.kind==="trend") {next.shape.timeGrain=timeGrain;resolved.add("TIME_GRAIN_UNKNOWN");}
  const grain=clarifiedGrain(text);
  if(grain&&(next.ambiguities||[]).some((item)=>item.code==="MEASURE_GRAIN_AMBIGUOUS"&&item.blocking)&&/(?:按|以).{0,8}(?:去重|统计|粒度|为准)|(?:唯一|不同).{0,4}(?:线索|订单|客户|案件|账号|账户)/.test(text)) {
    for(const measure of next.measures||[])if(measure.grain==="unknown")measure.grain=grain;
    resolved.add("MEASURE_GRAIN_AMBIGUOUS");
  }
  if(next.shape?.kind==="ranking"&&(next.dimensions||[]).some((item)=>item.value==="seller"&&!item.attribution)&&(next.measures||[]).some((item)=>item.timeRole==="completion")&&!next.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"))next.ambiguities.push({code:"DIMENSION_ATTRIBUTION_AMBIGUOUS",message:"销售归属未说明是当前负责人还是事件发生时负责人，两种口径可能产生不同排行",blocking:true,options:["当前负责人","事件发生时负责人"]});
  next.ambiguities=(next.ambiguities||[]).filter((item)=>!resolved.has(item.code));
  next.requirements=buildRequirements(next);
  next.retrievalTerms=buildRetrievalTerms(next);
  return next;
}

export function mergeContextualQueryIntent(current,prior) {
  if(!prior)return current;
  if(current?.scope?.contextReset) {
    const isolated=structuredClone(current);
    if(!isolated.subjects?.length)isolated.ambiguities=(isolated.ambiguities||[]).map((item)=>item.code==="SUBJECT_UNKNOWN"?{...item,blocking:true,message:"已断开历史上下文，但当前问题没有明确业务对象"}:item);
    isolated.requirements=buildRequirements(isolated);isolated.retrievalTerms=buildRetrievalTerms(isolated);return isolated;
  }
  const next=structuredClone(current);
  if(!next.subjects?.length)next.subjects=structuredClone(prior.subjects||[]);
  if(!next.measures?.length)next.measures=structuredClone(prior.measures||[]);
  if(!next.dimensions?.length)next.dimensions=structuredClone(prior.dimensions||[]);
  if(next.shape?.kind==="detail"||!current.measures?.length&&next.shape?.kind==="aggregate")next.shape=structuredClone(prior.shape||next.shape);
  const currentTimeRangeUnknown=(current.ambiguities||[]).some((item)=>item.code==="TIME_RANGE_UNKNOWN"&&item.blocking);
  if(next.scope?.timeReset){next.timeRange=null;next.comparisonRange=null;next.timeRole=null;}
  else if(!next.timeRange&&prior.timeRange&&!currentTimeRangeUnknown){next.timeRange=structuredClone(prior.timeRange);next.timeRole=structuredClone(prior.timeRole);next.timeZone=prior.timeZone||next.timeZone;}
  else if(next.timeRange&&!next.timeRole&&next.measures.length) {
    const resolved=detectTimeRole(`${next.normalizedQuestion}${next.measures.map((item)=>item.sourceText).join("")}`,next.timeRange,next.measures);
    next.timeRole=resolved?.ambiguous?null:resolved;
  }
  if(!next.scope?.scopeReset&&!next.entities?.length&&prior.entities?.length)next.entities=structuredClone(prior.entities);
  const subjectChanged=Boolean(current.subjects?.length&&prior.subjects?.length&&!current.subjects.some((subject)=>prior.subjects.includes(subject)));
  const additiveContext=explicitContextAddition(current.rawQuestion||current.normalizedQuestion);
  const currentFilters=structuredClone(next.filters||[]).map((item)=>!item.attachesTo&&next.subjects?.length===1?{...item,attachesTo:next.subjects[0]}:item);
  if(next.scope?.filterResetAll)next.filters=currentFilters;
  else {
    const replacementKeys=new Set(currentFilters.map(filterContextKey));
    const resetFields=new Set(next.scope?.filterResetFields||[]);
    const resetKnowledgeAssets=new Set((prior.filters||[]).filter((item)=>explicitKnowledgeFilter(item)&&[...resetFields].some((field)=>filterResetMatches(field,item.field))).map((item)=>item.provenance?.assetId).filter(Boolean));
    if(resetKnowledgeAssets.size)next.scope.removedKnowledgeGroups=[...resetKnowledgeAssets];
    const currentExplicitKnowledge=currentFilters.filter(explicitKnowledgeFilter);
    const currentKnowledgeSubjects=new Set(currentExplicitKnowledge.map((item)=>item.attachesTo).filter(Boolean));
    const inheritedFilters=structuredClone(prior.filters||[]).filter((item)=>{
      if(item.provenance?.activation==="global_table_rule")return false;
      if(explicitKnowledgeFilter(item)&&resetKnowledgeAssets.has(item.provenance?.assetId))return false;
      if([...resetFields].some((field)=>filterResetMatches(field,item.field)))return false;
      if(!additiveContext&&replacementKeys.has(filterContextKey(item)))return false;
      if(next.scope?.deletionExplicit&&item.field==="is_deleted")return false;
      if(subjectChanged&&item.kind!=="organization_name")return false;
      // Explicitly mentioning a new verified term/rule replaces the previous
      // explicit knowledge activation as one semantic group for that subject.
      // Global table rules are provenance-separated and remain in force.
      if(!additiveContext&&currentExplicitKnowledge.length&&explicitKnowledgeFilter(item)&&(!currentKnowledgeSubjects.size||!item.attachesTo||currentKnowledgeSubjects.has(item.attachesTo)))return false;
      return true;
    }).map((item)=>subjectChanged&&item.kind==="organization_name"&&next.subjects?.length===1?{...item,attachesTo:next.subjects[0]}:item);
    next.filters=[...inheritedFilters,...currentFilters];
  }
  addFilterConstraintConflicts(next);
  next.scope={...(next.scope||{})};
  const currentDeletionUnknown=(current.ambiguities||[]).some((item)=>item.code==="DELETION_SCOPE_UNKNOWN"&&item.blocking);
  if(!next.scope.deletionExplicit&&!currentDeletionUnknown&&prior.scope?.deletionExplicit) {
    next.scope.includeDeleted=Boolean(prior.scope.includeDeleted);
    next.scope.deletionMode=prior.scope.deletionMode;
    next.scope.deletionExplicit=true;
    next.scope.deletionTargets=structuredClone(prior.scope.deletionTargets||prior.subjects||[]);
  }
  if(!next.scope.scopeReset&&!next.scope.productExplicit&&prior.scope?.products?.length) {
    next.scope.products=structuredClone(prior.scope.products);next.scope.productExplicit=Boolean(prior.scope.productExplicit);
  }
  if(!next.scope.scopeReset&&!next.scope.exhaustiveExplicit&&prior.scope?.exhaustive) {
    next.scope.exhaustive=true;next.scope.exhaustiveExplicit=Boolean(prior.scope.exhaustiveExplicit);
  }
  if(next.shape?.kind==="comparison")next.comparisonRange=detectComparisonRange(next.shape,next.timeRange);
  const resolvedFilterFields=new Set((current.filters||[]).map((item)=>item.field).filter(Boolean));
  const resetFilterFields=new Set(next.scope?.filterResetFields||[]);
  const inheritedBlocking=(prior.ambiguities||[]).filter((item)=>item.blocking
    &&!String(item.code||"").startsWith("GLOBAL_RULE_")
    &&!(next.scope?.timeReset&&new Set(["TIME_RANGE_UNKNOWN","TIME_ROLE_UNKNOWN","TIME_ROLE_AMBIGUOUS","COMPARISON_BASELINE_UNKNOWN"]).has(item.code))
    &&!(item.code==="TIME_RANGE_UNKNOWN"&&current.timeRange)
    &&!(item.code==="COMPARISON_BASELINE_UNKNOWN"&&next.comparisonRange)
    &&!(item.code==="DELETION_SCOPE_UNKNOWN"&&next.scope.deletionExplicit)
    &&!(item.field&&[...resetFilterFields].some((field)=>filterResetMatches(field,item.field)))
    &&!(/^FILTER_/.test(item.code)&&item.field&&resolvedFilterFields.has(item.field)));
  const currentAmbiguities=(next.ambiguities||[]).filter((item)=>!new Set(["SUBJECT_UNKNOWN","MEASURE_GRAIN_AMBIGUOUS","RANKING_MEASURE_UNKNOWN","RANKING_DIMENSION_UNKNOWN"]).has(item.code));
  next.ambiguities=[...new Map([...inheritedBlocking,...currentAmbiguities].map((item)=>[`${item.code}|${item.field||""}|${item.sourceText||""}`,item])).values()];
  if(next.comparisonRange)next.ambiguities=next.ambiguities.filter((item)=>item.code!=="COMPARISON_BASELINE_UNKNOWN");
  enforceFinalTimeRoleInvariant(next);
  next.requirements=buildRequirements(next);
  next.retrievalTerms=buildRetrievalTerms(next);
  return next;
}

function filterContextKey(item) {return `${item?.attachesTo||"unbound"}|${item?.field||item?.kind||"unknown"}`;}
function filterResetMatches(resetField,candidateField) {
  const reset=String(resetField||"").toLowerCase();const candidate=String(candidateField||"").toLowerCase();
  if(!reset||!candidate)return false;if(reset===candidate)return true;
  const families=["status","type","channel","source","level","region","amount","age","count"];
  return families.some((family)=>(reset===family||reset.endsWith(`_${family}`))&&(candidate===family||candidate.endsWith(`_${family}`)));
}
function explicitKnowledgeFilter(item) {return item?.kind==="knowledge_row_domain"&&item?.provenance?.activation==="explicit_alias";}

function addFilterConstraintConflicts(intent) {
  const groups=new Map();
  for(const filter of intent?.filters||[]) {
    const physical=(filter.physicalColumns||[]).map((item)=>String(item).toLowerCase());
    const key=physical.length===1?`column:${physical[0]}`:`field:${filter.attachesTo||"unbound"}:${filter.field||filter.kind||"unknown"}`;
    const items=groups.get(key)||[];items.push(filter);groups.set(key,items);
  }
  for(const [key,items] of groups) {
    if(items.length<2||filterConstraintsSatisfiable(items))continue;
    const field=items[0].field||key;
    intent.ambiguities.push({
      code:"FILTER_CONTRACT_CONFLICT",field,sourceText:items.map((item)=>item.sourceText||`${item.field}${item.operator}${item.value}`).join("、"),
      message:`多个已声明筛选在 ${field} 上互相冲突，继续执行只会得到恒假或口径不明的结果`,blocking:true,
      options:["保留一个筛选口径","修正上下界或等值条件"],
      details:{constraints:items.map((item)=>({operator:item.operator,valueType:item.valueType,value:item.value,physicalColumns:item.physicalColumns||[],provenance:item.provenance||null}))},
    });
  }
  intent.ambiguities=[...new Map((intent.ambiguities||[]).map((item)=>[`${item.code}|${item.field||""}|${item.sourceText||""}`,item])).values()];
}

function filterConstraintsSatisfiable(items=[]) {
  const constraints=items.map((item)=>({...item,operator:normalizeFilterConstraintOperator(item.operator),valueType:String(item.valueType||"").toLowerCase(),normalizedValue:normalizeFilterConstraintValue(item)}));
  const nulls=constraints.filter((item)=>item.operator==="is_null");
  const nonNulls=constraints.filter((item)=>item.operator!=="is_null");
  if(nulls.length&&nonNulls.length)return false;
  const equals=constraints.filter((item)=>item.operator==="eq");
  if(new Set(equals.map((item)=>`${item.valueType}|${item.normalizedValue}`)).size>1)return false;
  const equal=equals[0];
  if(equal)for(const item of constraints) {
    if(item.operator==="neq"&&sameFilterConstraintValue(equal,item))return false;
    if(equal.valueType==="number"&&new Set(["gt","gte","lt","lte"]).has(item.operator)) {
      const comparison=compareCanonicalDecimals(equal.normalizedValue,item.normalizedValue);if(comparison==null)return false;
      if(item.operator==="gt"&&comparison<=0||item.operator==="gte"&&comparison<0||item.operator==="lt"&&comparison>=0||item.operator==="lte"&&comparison>0)return false;
    }
    if(item.operator==="contains"&&(equal.valueType!=="string"||!String(equal.normalizedValue).includes(String(item.normalizedValue))))return false;
  }
  const numeric=constraints.filter((item)=>item.valueType==="number"&&new Set(["gt","gte","lt","lte"]).has(item.operator));
  let lower=null;let upper=null;
  for(const item of numeric) {
    if(new Set(["gt","gte"]).has(item.operator)) {
      const comparison=lower?compareCanonicalDecimals(item.normalizedValue,lower.normalizedValue):1;
      if(!lower||comparison>0||comparison===0&&item.operator==="gt")lower=item;
    } else {
      const comparison=upper?compareCanonicalDecimals(item.normalizedValue,upper.normalizedValue):-1;
      if(!upper||comparison<0||comparison===0&&item.operator==="lt")upper=item;
    }
  }
  if(lower&&upper) {const comparison=compareCanonicalDecimals(lower.normalizedValue,upper.normalizedValue);if(comparison>0||comparison===0&&(lower.operator==="gt"||upper.operator==="lt"))return false;}
  return true;
}

function normalizeFilterConstraintOperator(value) {return ({"=":"eq","==":"eq","!=":"neq","<>":"neq",">":"gt",">=":"gte","<":"lt","<=":"lte","is":"is_null","is not":"not_null"})[String(value||"").toLowerCase()]||String(value||"").toLowerCase();}
function normalizeFilterConstraintValue(item) {return String(item?.valueType||"").toLowerCase()==="number"?canonicalDecimalLexeme(item?.value):String(item?.value??"");}
function sameFilterConstraintValue(left,right) {return left.valueType===right.valueType&&left.normalizedValue===right.normalizedValue;}
function compareCanonicalDecimals(left,right) {
  const a=canonicalDecimalLexeme(left);const b=canonicalDecimalLexeme(right);if(a===b)return 0;
  const negativeA=a.startsWith("-");const negativeB=b.startsWith("-");if(negativeA!==negativeB)return negativeA?-1:1;
  const parts=(value)=>value.replace(/^-/,"").split(".");const [ai,af=""]=parts(a);const [bi,bf=""]=parts(b);
  let comparison=ai.length-bi.length||ai.localeCompare(bi);if(!comparison){const width=Math.max(af.length,bf.length);comparison=af.padEnd(width,"0").localeCompare(bf.padEnd(width,"0"));}
  return negativeA?-Math.sign(comparison):Math.sign(comparison);
}

function enforceFinalTimeRoleInvariant(intent) {
  if(!(intent?.timeRange||intent?.shape?.kind==="trend")||!(intent?.measures||[]).length)return;
  if(!intent.timeRole) {
    const resolved=detectTimeRole(`${intent.semanticQuestion||intent.normalizedQuestion||""}${intent.measures.map((item)=>item.sourceText||"").join("")}`,intent.timeRange,intent.measures,intent.shape?.kind==="trend");
    if(resolved?.ambiguous) {
      intent.ambiguities=intent.ambiguities.filter((item)=>item.code!=="TIME_ROLE_UNKNOWN");
      if(!intent.ambiguities.some((item)=>item.code==="TIME_ROLE_AMBIGUOUS"))intent.ambiguities.push({code:"TIME_ROLE_AMBIGUOUS",message:"时间要求可确定，但无法唯一判断应绑定哪个业务事件时间",blocking:true,options:resolved.candidates.map((item)=>item.value)});
    } else if(resolved) {
      intent.timeRole=resolved;intent.ambiguities=intent.ambiguities.filter((item)=>!new Set(["TIME_ROLE_UNKNOWN","TIME_ROLE_AMBIGUOUS"]).has(item.code));
    } else if(!intent.ambiguities.some((item)=>item.code==="TIME_ROLE_UNKNOWN"))intent.ambiguities.push({code:"TIME_ROLE_UNKNOWN",message:"指标包含时间要求，但没有识别出对应的业务事件时间",blocking:true,options:["创建或进入时间","完成或成单时间","支付或回款时间"]});
  } else intent.ambiguities=intent.ambiguities.filter((item)=>!new Set(["TIME_ROLE_UNKNOWN","TIME_ROLE_AMBIGUOUS"]).has(item.code));
}

export function buildIntentRetrievalQuestion(intent,fallbackQuestion=intent?.rawQuestion||"") {
  const semantic=String(intent?.semanticQuestion||"").trim();
  const values=[semantic||fallbackQuestion,...(intent?.retrievalTerms||[])].map((value)=>String(value||"").trim()).filter(Boolean);
  return [...new Set(values)].join(" ");
}

// Retrieval facets are business capabilities, not physical table mappings. The
// retrieval layer gives every required facet its own candidate quota so a strong
// organization or time match cannot crowd the requested business object out of
// one global ranking.
export function buildIntentRetrievalFacets(intent) {
  const facets=[];
  const requirements=Array.isArray(intent?.requirements)&&intent.requirements.length?intent.requirements:buildRequirements(intent);
  for(const requirement of requirements) {
    const quota=requirement.kind==="subject"?(intent?.scope?.exhaustive&&!intent?.scope?.products?.length?4:Math.max(2,intent?.scope?.products?.length||0)):requirement.kind==="filter"&&requirement.allowMultiple?Math.max(2,intent?.scope?.exhaustive?4:intent?.scope?.products?.length||0):requirement.kind==="dimension"||requirement.kind==="measure"?2:1;
    facets.push({key:requirement.id,kind:requirement.kind,value:requirement.value,sourceValue:requirement.sourceValue??requirement.value,field:requirement.field||null,fieldSurface:requirement.fieldSurface||null,role:requirement.role,attribution:requirement.attribution||null,attachesTo:requirement.attachesTo||null,required:requirement.required!==false,quota,allowMultiple:Boolean(requirement.allowMultiple),anchorTerms:[...(requirement.anchorTerms||[])],terms:[...(requirement.terms||[])],bindingTerms:[...(requirement.bindingTerms||[])],labelTerms:[...(requirement.labelTerms||[])],fieldTerms:[...(requirement.fieldTerms||[])],physicalColumns:[...(requirement.physicalColumns||[])],operator:requirement.operator||null,valueType:requirement.valueType||null,valueBinding:requirement.valueBinding||null,provenance:requirement.provenance||null,aggregation:requirement.aggregation||null,grain:requirement.grain||null,evidence:requirement.evidence||null,metricDefinition:requirement.metricDefinition||null});
  }
  for(const entityItem of intent?.entities||[]) {
    if(entityItem.type!=="organization")continue;
    facets.push({key:`entity:organization:${entityItem.text}`,kind:"entity",value:entityItem.text,required:true,quota:intent?.scope?.exhaustive?4:2,allowMultiple:Boolean(intent?.scope?.exhaustive||(intent?.scope?.products||[]).length>1),terms:[entityItem.text,"律所","律师事务所","机构","组织","office","law_firm","firm","organization","org"]});
  }
  for(const product of intent?.scope?.products||[])facets.push({key:`product:${product}`,kind:"product",value:product,required:true,quota:2,anchorTerms:[product,product.toLowerCase()],terms:[product,product.toLowerCase(),"产品","product"]});
  if(intent?.scope?.exhaustive&&!intent?.scope?.products?.length)facets.push({key:"scope:exhaustive",kind:"scope",value:"exhaustive",required:false,terms:["所有","全部","完整","全量","多产品","多体系","all","complete","product"]});
  return facets;
}

export function queryIntentSqlErrors(intent,sql) {
  const errors=[];
  const text=String(sql||"");
  for(const entity of intent?.entities||[]) {
    if(entity.type!=="organization"||!entity.text)continue;
    if(!text.includes(entity.text))errors.push({
      code:"INTENT_ENTITY_DROPPED",
      stage:"intent",
      retryable:true,
      message:`机构专名“${entity.text}”必须作为连续字符串过滤（例如 LIKE '%${entity.text}%'），不能遗漏、改写或拆成多个条件`,
      details:{entityType:entity.type,expected:entity.text},
    });
  }
  if(intent?.timeRange&&!hasIntentTimeRangePredicate(text,intent.timeRange))errors.push({
    code:"INTENT_TIME_DROPPED",
    stage:"intent",
    retryable:true,
    message:`问题中的时间约束“${intent.timeRange.sourceText}”没有体现在 SQL 过滤条件中`,
    details:{timeRange:intent.timeRange},
  });
  if(intent?.shape?.kind==="ranking"&&!/\bORDER\s+BY\b/i.test(text))errors.push({code:"INTENT_RANKING_DROPPED",stage:"intent",retryable:true,message:"排行问题必须包含明确的排序指标与 ORDER BY",details:{shape:intent.shape}});
  if((intent?.measures||[]).some((item)=>item.aggregation!=="precomputed")&&!/\b(?:COUNT|SUM|AVG|MIN|MAX)\s*\(/i.test(text))errors.push({code:"INTENT_MEASURE_DROPPED",stage:"intent",retryable:true,message:"问题要求统计指标，但 SQL 没有对应聚合表达式",details:{measures:intent.measures}});
  if((intent?.dimensions||[]).length&&(intent?.measures||[]).length&&!/\bGROUP\s+BY\b/i.test(text))errors.push({code:"INTENT_DIMENSION_DROPPED",stage:"intent",retryable:true,message:"问题要求按维度统计，但 SQL 没有 GROUP BY",details:{dimensions:intent.dimensions}});
  return errors;
}

function extractOrganizationEntity(text) {
  const suffix=text.match(ORGANIZATION_SUFFIX);
  if(suffix?.index!=null) {
    const prefix=cleanEntityPrefix(text.slice(0,suffix.index));
    if(validOrganizationCandidate(prefix))return entity(prefix,`${prefix}${suffix[0]}`,text.indexOf(prefix));
    return null;
  }
  const withoutPrefix=text.replace(QUERY_PREFIX,"").replace(/^(?:请|帮我|麻烦|一下)+/,"");
  const boundary=withoutPrefix.search(SUBJECT_BOUNDARY);
  if(boundary<=0)return null;
  const candidate=cleanEntityPrefix(withoutPrefix.slice(0,boundary));
  return validOrganizationCandidate(candidate,{implicit:true})?entity(candidate,candidate,text.indexOf(candidate)):null;
}

function cleanEntityPrefix(value) {
  return String(value||"").replace(QUERY_PREFIX,"").replace(/^(?:请|帮我|麻烦|一下)+/,"").replace(/的$/," ").trim();
}

function validOrganizationCandidate(value,{implicit=false}={}) {
  const length=[...String(value||"")].length;
  if(length<(implicit?4:2)||length>32)return false;
  if(implicit&&!/^(?:北京|上海|广州|深圳|天津|重庆|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|青岛|厦门|济南|合肥|福州|昆明|沈阳|大连|宁波|东莞|佛山|无锡)/.test(value))return false;
  if(/[a-z0-9@]/i.test(value))return false;
  if(LOCATION_ONLY.has(value)||/^(?:所有|全部|各个|每个|某个|该|这个|当前|任意|当地|本地)$/.test(value))return false;
  if(/(?:地区|区域|范围内?|当地|本地|省|市|区|县)$/.test(value))return false;
  return !/^(?:本月|上月|本周|上周|今天|昨天)/.test(value);
}

function entity(text,sourceText,start) {
  return {type:"organization",text,sourceText,immutable:true,span:{start:Math.max(0,start),end:Math.max(0,start)+text.length}};
}

function maskEntitySpan(value,span) {
  if(!span||!Number.isInteger(span.start)||!Number.isInteger(span.end)||span.start<0||span.end<=span.start)return value;
  return `${value.slice(0,span.start)}${" ".repeat(span.end-span.start)}${value.slice(span.end)}`;
}

function detectBusinessFilters(value,{subjects=[],concepts=[],protectedTermAliases=[]}={}) {
  const text=String(value||"");
  const aliasMap=new Map();
  for(const concept of [...(concepts||[]),...FILTER_FIELD_CONCEPTS])for(const alias of concept.aliases||[]) {
    const key=normalizeText(alias);if(key&&!aliasMap.has(key))aliasMap.set(key,{alias:String(alias),concept});
  }
  const aliases=[...aliasMap.values()].sort((left,right)=>right.alias.length-left.alias.length||left.alias.localeCompare(right.alias));
  const aliasPattern=aliases.map((item)=>escapeRegExp(item.alias)).join("|");
  const operatorPattern=FILTER_OPERATOR_ALIASES.map(([alias])=>escapeRegExp(alias)).join("|");
  const terminalPattern="(?:的(?:线索|进线|客户|用户|订单|案件|案源|账号|账户|数据|记录|数量|个数|总数|排行|排名|榜单|趋势|走势|情况|明细|列表)|数量|个数|总数|排行|排名|榜单|趋势|走势|情况|明细|列表|本月|上月|本周|上周|本季度|今年)";
  const delimiterPattern=`(?=\\s*(?:${terminalPattern}|并且|同时|以及|且|和|或者|或|,|，|、|$))`;
  const filters=[];const ambiguities=[];const consumed=[];
  const overlaps=(start,end)=>consumed.some((item)=>start<item.end&&item.start<end);
  const protectedTermOverlap=(start,end)=>protectedTermAliases.some((alias)=>{const needle=normalizeText(alias);if(!needle)return false;const source=normalizeText(text.slice(start,end));return source.startsWith(needle)||source.includes(needle);});
  const conceptFor=(alias)=>aliasMap.get(normalizeText(alias))?.concept;
  const consume=(start,end)=>{if(Number.isInteger(start)&&Number.isInteger(end)&&end>start&&!overlaps(start,end))consumed.push({start,end});};
  const reject=(code,sourceText,message,{field=null,start=null,end=null,concept=null,alias=null}={})=>{
    ambiguities.push(filterAmbiguity(code,sourceText,message,{field,filterCandidate:concept?frozenFilterCandidate(concept,alias||sourceText,field):null}));
    consume(start,end);
  };
  const add=(match,operator,valueType,literal)=>{
    let start=match.index;const end=match.index+match[0].length;
    if(overlaps(start,end))return;
    const concept=conceptFor(match[1]);if(!concept)return;
    const field=concept.fieldId||filterFieldIdentity(match[1],concept.value);
    const prefix=text.slice(Math.max(0,start-3),start);const aggregatePrefix=prefix.match(/(?:平均|均值)$/)?.[0];
    if(aggregatePrefix) {start-=aggregatePrefix.length;reject("FILTER_AGGREGATE_SCOPE_UNSUPPORTED",text.slice(start,end),`筛选“${text.slice(start,end)}”包含聚合口径，无法当作单行属性条件执行`,{field,start,end,concept,alias:match[1]});return;}
    if(concept.numeric===true&&new Set(["gt","gte","lt","lte"]).has(operator)&&valueType!=="number") {reject("FILTER_VALUE_TYPE_UNSUPPORTED",match[0],`筛选“${match[0]}”要求数值，但未提供可验证的数字`,{field,start,end,concept,alias:match[1]});return;}
    if(concept.numeric!==true&&new Set(["gt","gte","lt","lte"]).has(operator)) {reject("FILTER_OPERATOR_UNSUPPORTED",match[0],`筛选“${match[0]}”没有已证明的数值字段类型，不能使用范围操作符`,{field,start,end,concept,alias:match[1]});return;}
    if(concept.numeric===true&&operator==="contains") {reject("FILTER_OPERATOR_UNSUPPORTED",match[0],`数值筛选“${match[0]}”不能使用包含关系`,{field,start,end,concept,alias:match[1]});return;}
    if(operator==="contains"&&/[\\%_]/.test(String(literal))) {reject("FILTER_VALUE_ESCAPE_UNSUPPORTED",match[0],`筛选值“${literal}”含有 LIKE 通配或转义字符，当前无法证明包含语义与原文字面值一致`,{field,start,end,concept,alias:match[1]});return;}
    filters.push({kind:"attribute",field,fieldSurface:match[1],fieldTerms:[...new Set([match[1],field,...(concept.terms||[])])],physicalColumns:[...(concept.physicalColumns||[])],operator,value:literal,valueType,attachesTo:filterSubjectForAlias(match[1],subjects),immutable:true,sourceText:match[0],span:{start,end},...(concept.provenance?{provenance:{kind:"catalog_property",sources:concept.provenance}}:{})});
    consume(start,end);
  };

  // Typed identifiers have a self-validating lexical shape. They are the only
  // operator-less filters accepted by the parser, and they still bind through
  // an exact catalog column before execution. This covers natural follow-ups
  // such as “手机号138...” and “138...是手机号” without opening a generic
  // value-to-column guessing channel.
  for(const {alias,concept} of aliases.filter((item)=>item.concept?.semanticKind)) {
    const valuePattern=typedLiteralPattern(concept.semanticKind);if(!valuePattern)continue;
    const escapedAlias=escapeRegExp(alias);
    const fieldFirst=new RegExp(`(${escapedAlias})\\s*(?:为|是|等于|=|：|:)?\\s*(${valuePattern})(?![A-Za-z0-9@._+\\-])`,"giu");
    for(const match of text.matchAll(fieldFirst)) {
      if(!typedLiteralMatches(concept.semanticKind,match[2]))continue;
      const synthetic=[match[0],alias];synthetic.index=match.index;add(synthetic,"eq","string",String(match[2]).trim());
    }
    const valueFirst=new RegExp(`(${valuePattern})\\s*(?:是|为|等于)?\\s*(${escapedAlias})(?:呀|啊|呢|哦|嘛)?`,"giu");
    for(const match of text.matchAll(valueFirst)) {
      if(overlaps(match.index,match.index+match[0].length)||!typedLiteralMatches(concept.semanticKind,match[1]))continue;
      const synthetic=[match[0],alias];synthetic.index=match.index;add(synthetic,"eq","string",String(match[1]).trim());
    }
  }

  const nullExpression=new RegExp(`(${aliasPattern})\\s*(不为空|非空|为空|为\\s*null|是\\s*null|等于\\s*null)`,"giu");
  for(const match of text.matchAll(nullExpression))add(match,/不为空|非空/.test(match[2])?"not_null":"is_null","null",null);

  const sourceAliases=aliases.filter((item)=>item.concept?.value==="source"||/来源|source|origin/i.test(item.alias)).map((item)=>escapeRegExp(item.alias)).join("|");
  if(sourceAliases) {
    const sourceExpression=new RegExp(`(${sourceAliases})\\s*(?:于|来自|源自)\\s*([\\p{L}\\p{N}_.+\\-/\\s]{1,48}?)${delimiterPattern}`,"giu");
    for(const match of text.matchAll(sourceExpression)) {
      const rawValue=String(match[2]||"").trim();if(rawValue)add(match,"eq","string",rawValue);
    }
  }

  const expression=new RegExp(`(${aliasPattern})\\s*(${operatorPattern})\\s*([\\p{L}\\p{N}_.+\\-/\\s]{1,48}?)${delimiterPattern}`,"giu");
  for(const match of text.matchAll(expression)) {
    if(overlaps(match.index,match.index+match[0].length))continue;
    const operator=FILTER_OPERATOR_ALIASES.find(([alias])=>alias===match[2])?.[1];
    const rawValue=String(match[3]||"").trim();
    if(!operator||!rawValue)continue;
    if(copulaQuestion(match[2],rawValue))continue;
    if(/(?:或者|或|任一|之一|、|,|，)/.test(rawValue)) {const concept=conceptFor(match[1]);const field=concept?.fieldId||filterFieldIdentity(match[1],concept?.value);reject("FILTER_BOOLEAN_UNSUPPORTED",match[0],`筛选“${match[0]}”包含未登记的多值或 OR 语义`,{field,start:match.index,end:match.index+match[0].length,concept,alias:match[1]});continue;}
    const concept=conceptFor(match[1]);const numeric=/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(rawValue);
    const numericValue=Boolean(concept?.numeric&&numeric);
    add(match,operator,numericValue?"number":"string",rawValue);
  }

  const implicitValues="有效|无效|成功|失败|启用|禁用|开启|关闭|正常|异常|已激活|未激活|已支付|未支付";
  const fieldFirst=new RegExp(`(${aliasPattern})\\s*(${implicitValues})${delimiterPattern}`,"giu");
  for(const match of text.matchAll(fieldFirst))if(!overlaps(match.index,match.index+match[0].length)) {
    if(protectedTermOverlap(match.index,match.index+match[0].length))continue;
    const concept=conceptFor(match[1]);reject("FILTER_EXPRESSION_UNSUPPORTED",match[0],`筛选“${match[0]}”省略了明确操作符，无法证明是等值、排除还是业务术语口径`,{field:concept?.fieldId||filterFieldIdentity(match[1],concept?.value),start:match.index,end:match.index+match[0].length,concept,alias:match[1]});
  }
  const valueFirst=new RegExp(`(${implicitValues})\\s*(${aliasPattern})${delimiterPattern}`,"giu");
  for(const match of text.matchAll(valueFirst))if(!overlaps(match.index,match.index+match[0].length)) {
    if(protectedTermOverlap(match.index,match.index+match[0].length))continue;
    const concept=conceptFor(match[2]);reject("FILTER_EXPRESSION_UNSUPPORTED",match[0],`倒装筛选“${match[0]}”无法安全规范化为唯一字段、操作符和值`,{field:concept?.fieldId||filterFieldIdentity(match[2],concept?.value),start:match.index,end:match.index+match[0].length,concept,alias:match[2]});
  }

  const unsupported=new RegExp(`(${aliasPattern})\\s*(?:介于|位于|属于|任一|之一|从.{0,20}到|在.{0,20}(?:中|内|之间)|(?:不)?为空|非空|${operatorPattern})`,"giu");
  for(const match of text.matchAll(unsupported)) {
    const end=Math.min(text.length,match.index+Math.max(match[0].length,36));
    if(containsCopulaQuestion(text.slice(match.index,end)))continue;
    if(overlaps(match.index,end)) {
      const tail=text.slice(match.index,end);
      const andFollowedByAnotherField=new RegExp(`(?:和|,|，|、)\\s*(?:${aliasPattern})\\s*(?:${operatorPattern})`,"iu").test(tail);
      if(!andFollowedByAnotherField&&/(?:或者|或|任一|之一|、|,|，)/.test(tail)){const concept=conceptFor(match[1]);const field=concept?.fieldId||filterFieldIdentity(match[1],concept?.value);ambiguities.push(filterAmbiguity("FILTER_BOOLEAN_UNSUPPORTED",tail,`筛选“${tail}”包含多值、OR、IN 或集合语义，当前无法证明其完整行域`,{field,filterCandidate:concept?frozenFilterCandidate(concept,match[1],field):null}));}
      continue;
    }
    const concept=conceptFor(match[1]);reject("FILTER_EXPRESSION_UNSUPPORTED",match[0],`筛选表达式“${match[0]}”无法安全规范化为唯一字段、操作符和值`,{field:concept?.fieldId||filterFieldIdentity(match[1],concept?.value),start:match.index,end,concept,alias:match[1]});
  }

  // Residual filter-shaped language is never allowed to disappear.  Catalog
  // concepts can make custom fields executable; otherwise the immutable
  // intent records a schema gap instead of letting an unrestricted query pass.
  const genericOperator=`(?:${operatorPattern}|来源于|来自|源自)`;
  const generic=new RegExp(`([\\p{Script=Han}A-Za-z_][\\p{Script=Han}A-Za-z0-9_]{0,23})\\s*(${genericOperator})\\s*([\\p{L}\\p{N}_.+\\-/\\s]{1,48}?)${delimiterPattern}`,"giu");
  for(const match of text.matchAll(generic)) {
    const start=match.index;const end=start+match[0].length;if(overlaps(start,end))continue;
    if(copulaQuestion(match[2],match[3]))continue;
    // “并且是 VIP 客户” introduces a verified term in an additive
    // follow-up; it is not an unknown field named “并且”. Leave the span for
    // the row-domain term matcher below.
    if(additiveProtectedTermExpression(match[0],protectedTermAliases))continue;
    reject("FILTER_FIELD_UNKNOWN",match[0],`筛选字段“${match[1]}”未绑定到当前数据源已发布的唯一属性，系统不会猜测物理列`,{field:`unknown_${safeConceptId(match[1])}`,start,end});
  }

  const uniqueFilters=[...new Map(filters.map((item)=>[`${item.field}|${item.operator}|${item.valueType}|${String(item.value)}`,item])).values()].map((item,index)=>({...item,id:`filter:${item.field}:${index}`}));
  const uniqueAmbiguities=[...new Map(ambiguities.map((item)=>[`${item.code}|${item.sourceText}`,item])).values()];
  return {filters:uniqueFilters,ambiguities:uniqueAmbiguities,spans:[...consumed].sort((left,right)=>left.start-right.start)};
}

function additiveProtectedTermExpression(value,aliases=[]) {
  const text=normalizeText(value);
  for(const alias of aliases||[]) {
    const term=normalizeText(alias);if(!term||!text.endsWith(term))continue;
    const prefix=text.slice(0,-term.length);
    if(/^(?:再加上|并且|同时(?:满足)?|还要|也要)(?:是|为|满足)?$/.test(prefix))return true;
  }
  return false;
}

function copulaQuestion(operator,value) {
  if(!/^(?:是|为|等于|不是|不为|不等于)$/.test(normalizeText(operator)))return false;
  return interrogativeFilterValue(value);
}

function containsCopulaQuestion(value) {
  const text=normalizeText(value);
  const match=text.match(/(?:不等于|不是|不为|等于|是|为)(.+)$/);
  return Boolean(match&&interrogativeFilterValue(match[1]));
}

function interrogativeFilterValue(value) {
  const text=normalizeText(value).replace(/(?:呢|呀|啊|吗)+$/g,"");
  return /^(?:多少|什么|啥|谁|哪(?:个|些|一个|一些|一位|一家|一条|一笔|一单|种)|几(?:个|条|位|家|笔|单|种|类|项)|多(?:少|大|高|长|久))(?:[\p{Script=Han}A-Za-z_]{0,12})?$/u.test(text);
}

function filterAmbiguity(code,sourceText,message,{field=null,filterCandidate=null}={}) {
  return {code,message,blocking:true,sourceText,field,...(filterCandidate?{filterCandidate}:{}),options:["改为单个明确的字段等值筛选","改为明确的数值上限或下限","拆分为多个独立问题"]};
}

function frozenFilterCandidate(concept,alias,field) {return {value:concept.value||field,fieldId:concept.fieldId||field,aliases:[String(alias||"")],terms:[...(concept.terms||[])],physicalColumns:[...(concept.physicalColumns||[])],numeric:concept.numeric??null,semanticKind:concept.semanticKind||null,provenance:[...(concept.provenance||[])]};}

function filterFieldIdentity(alias,fallback="attribute") {
  const mappings=[
    [/手机号|手机号码|联系电话|mobile|phone/i,"phone"],[/邮箱|电子邮件|e_?mail/i,"email"],[/身份证|证件号|id_?card|identity/i,"china_id"],[/银行卡|银行账号|bank_?card/i,"bank_card"],
    [/线索状态/,"clue_status"],[/客户状态/,"customer_status"],[/订单状态/,"order_status"],[/支付状态/,"payment_status"],[/激活状态/,"activation_status"],[/案件状态/,"case_status"],[/账号状态|账户状态/,"account_status"],
    [/线索类型/,"clue_type"],[/客户类型/,"customer_type"],[/订单类型/,"order_type"],[/案件类型/,"case_type"],[/账号类型|账户类型/,"account_type"],
    [/线索渠道|获客渠道/,"clue_channel"],[/线索来源/,"clue_source"],[/客户来源/,"customer_source"],[/客户等级/,"customer_level"],[/线索等级/,"clue_level"],
    [/所属地区/,"region"],[/省份/,"province"],[/城市/,"city"],[/订单金额/,"order_amount"],[/合同金额/,"contract_amount"],[/成交金额/,"deal_amount"],[/回款金额/,"payment_amount"],[/销售额/,"sales_amount"],
    [/客户年龄/,"customer_age"],[/用户年龄/,"user_age"],[/购买次数/,"purchase_count"],[/下单次数/,"order_count"],[/跟进次数/,"follow_up_count"],
  ];
  return mappings.find(([pattern])=>pattern.test(String(alias||"")))?.[1]||fallback;
}

function typedLiteralPattern(kind) {
  return ({
    phone:"(?:\\+?86[-\\s]?)?1[3-9]\\d{9}",
    email:"[\\w.+-]{1,64}@[\\w.-]{1,255}\\.[A-Za-z]{2,}",
    china_id:"\\d{17}[\\dXx]",
    bank_card:"(?:\\d[ -]?){12,19}",
  })[kind]||null;
}

function typedLiteralMatches(kind,value) {
  const pattern=typedLiteralPattern(kind);return Boolean(pattern&&new RegExp(`^(?:${pattern})$`,"iu").test(String(value||"").trim()));
}

function filterSubjectForAlias(alias,subjects) {
  const text=String(alias||"");
  const mappings=[["clue",/线索|进线/],["account",/账号|账户|用户/],["customer",/客户/],["order",/订单|支付|回款|下单/],["case",/案件|案源/]];
  const explicit=mappings.find(([,pattern])=>pattern.test(text))?.[0];
  if(explicit)return explicit;
  return subjects.length===1?subjects[0]:null;
}

function detectDeletionScope(value,{subjects=[]}={}) {
  const text=String(value||"").replace(/\s+/g,"");
  const mentions=[...text.matchAll(/(?:不(?:包含|包括|含|查询)|排除|不是|非|未)(?:已|被)?删除(?:的)?(?:线索|进线|客户|用户|订单|案件|账号|账户|数据|记录)?|(?:包含|包括|含有|含|连同|不排除)(?:所有)?(?:已|被)?删除(?:的)?(?:线索|进线|客户|用户|订单|案件|账号|账户|数据|记录)?|(?:已删除|被删除|删除的(?:线索|进线|客户|用户|订单|案件|账号|账户|数据|记录))/g)];
  if(mentions.length&&subjects.length>1)return {mode:"unknown",filter:null,span:{start:mentions[0].index,end:mentions.at(-1).index+mentions.at(-1)[0].length},ambiguity:filterAmbiguity("DELETION_SCOPE_UNKNOWN",mentions.map((item)=>item[0]).join("、"),"删除范围同时涉及多个业务对象，当前无法证明应放宽哪一个主体的有效性约束",{field:"is_deleted"})};
  if(mentions.length>1) {
    const modes=new Set(mentions.map((item)=>/^(?:不|排除|不是|非|未)/.test(item[0])?"active":/(?:包含|包括|含有|连同|不排除)/.test(item[0])?"include":"deleted"));
    if(modes.size>1||subjects.length>1)return {mode:"unknown",filter:null,span:{start:mentions[0].index,end:mentions.at(-1).index+mentions.at(-1)[0].length},ambiguity:filterAmbiguity("DELETION_SCOPE_UNKNOWN",mentions.map((item)=>item[0]).join("、"),"同一问题包含多个删除范围，当前无法证明每个范围对应的唯一业务对象",{field:"is_deleted"})};
  }
  const active=/(?:不(?:包含|包括|含|查询)|排除|不是|非|未)(?:已|被)?删除|未删除|没有删除|非删除/.exec(text);
  const included=/(?:包含|包括|含有|含|连同|不排除)(?:所有)?(?:已|被)?删除/.exec(text);
  const deleted=/(?:已删除|被删除|删除的(?:线索|进线|客户|用户|订单|案件|账号|账户|数据|记录))/.exec(text);
  const ambiguous=/删除(?:线索|进线|客户|用户|订单|案件|账号|账户|数据|记录)(?:数量|个数|总数|明细|列表|情况)?/.exec(text);
  if(active)return {...deletionFilterResolution("active_only","0",active[0],subjects),span:{start:active.index,end:active.index+active[0].length}};
  if(included)return {mode:"include_deleted",filter:null,ambiguity:null,span:{start:included.index,end:included.index+included[0].length}};
  if(deleted)return {...deletionFilterResolution("deleted_only","1",deleted[0],subjects),span:{start:deleted.index,end:deleted.index+deleted[0].length}};
  if(ambiguous)return {mode:"unknown",filter:null,span:{start:ambiguous.index,end:ambiguous.index+ambiguous[0].length},ambiguity:filterAmbiguity("DELETION_SCOPE_UNKNOWN",ambiguous[0],`“${ambiguous[0]}”无法区分仅查询已删除数据、排除已删除数据还是包含全部数据`,{field:"is_deleted"})};
  return {mode:"default_active",filter:null,ambiguity:null,span:null};
}

function deletionFilterResolution(mode,value,sourceText,subjects) {
  return {mode,ambiguity:null,filter:{id:"filter:is_deleted:0",kind:"attribute",field:"is_deleted",fieldSurface:"删除标记",fieldTerms:["is_deleted","逻辑删除","删除标记","是否删除"],operator:"eq",value,valueType:"number",attachesTo:subjects.length===1?subjects[0]:null,immutable:true,sourceText}};
}

function filterValueType(value) {
  if(value===null)return "null";
  if(typeof value==="number"||typeof value==="string"&&/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(value))return "number";
  if(typeof value==="boolean")return "boolean";
  return "string";
}

function escapeRegExp(value) {return String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");}

function detectSubjects(text) {
  const subjects=[];
  if(/线索|进线|lead|clue/i.test(text))subjects.push("clue");
  if(/账号|账户|account/i.test(text))subjects.push("account");
  if(/客户|customer/i.test(text))subjects.push("customer");
  if(/订单|order/i.test(text))subjects.push("order");
  if(/案件|案源|\bcase\b|matter/i.test(text))subjects.push("case");
  if(/收入|营收|销售额|回款|revenue|sales/i.test(text))subjects.push("revenue");
  return subjects;
}

function detectQueryShape(text) {
  const top=text.match(/(?:top|前)\s*([+-]?\d+)/i);
  const parsedTop=top?Number(top[1]):null;
  const validTop=top&&Number.isSafeInteger(parsedTop)&&parsedTop>0;
  if(/排行|排名|榜单|top\s*[+-]?\d*|前\s*[+-]?\d+\s*名?|最高|最多|最低|最少/i.test(text))return {kind:"ranking",direction:/最低|最少|升序|asc/i.test(text)?"asc":"desc",requestedLimit:validTop?parsedTop:null,...(top&&!validTop?{requestedLimitInvalid:top[1]}:{})};
  if(/趋势|走势|变化|按(?:天|日|周|月|季度|季|年)|trend/i.test(text))return {kind:"trend",direction:"asc",requestedLimit:null,timeGrain:detectTimeGrain(text)};
  if(/对比|比较|同比|环比|versus|\bvs\b/i.test(text))return {kind:"comparison",comparisonMode:/同比/.test(text)?"year_over_year":/环比/.test(text)?"period_over_period":"custom",direction:null,requestedLimit:null};
  if(/统计|数量|个数|总数|多少|平均|均值|合计|总额|占比|比例|率|\bcount\b|\bsum\b|\bavg\b/i.test(text)||MEASURE_CONCEPTS.some((item)=>item.pattern.test(text)))return {kind:"aggregate",direction:null,requestedLimit:null};
  return {kind:"detail",direction:null,requestedLimit:null};
}

function detectDimensions(text,shape,concepts=[]) {
  const grouped=/按|各|每|分别|分组|排行|排名|榜单|top|前\s*\d+\s*名?/i.test(text)||shape.kind==="ranking";
  if(!grouped)return [];
  const result=DIMENSION_CONCEPTS.filter((item)=>item.pattern.test(text)).map((item)=>({id:`dimension:${item.value}`,value:item.value,sourceText:matched(text,item.pattern),role:item.value==="seller"?"attribution":"category",attribution:explicitAttribution(text),presentation:"label_and_id",terms:[...item.terms],labelTerms:[...item.labelTerms||[]]}));
  for(const concept of concepts.filter((item)=>item?.kind==="dimension")) {
    const alias=(concept.aliases||[]).find((item)=>normalizeText(text).includes(normalizeText(item)));
    if(!alias||result.some((item)=>item.value===concept.value))continue;
    result.push({id:`dimension:${safeConceptId(concept.value||alias)}`,value:concept.value||alias,sourceText:alias,role:concept.role||"category",attribution:concept.attribution||null,presentation:concept.presentation||"label_and_id",terms:[...new Set([alias,...(concept.terms||[])])],labelTerms:[...(concept.labelTerms||[`${alias}名称`,`${alias}姓名`])]});
  }
  // A trend's time bucket is represented by the dedicated time requirement.
  // Treating “按日/周/月趋势” as an arbitrary business dimension would make
  // retrieval look for a fictitious table/column and can crowd out the event
  // time that the query actually needs.
  if(!result.length&&shape.kind!=="trend") {
    const phrase=customDimensionPhrase(text);
    if(phrase){const terms=customDimensionTerms(phrase);result.push({id:`dimension:custom_${safeConceptId(phrase)}`,value:phrase,sourceText:phrase,role:"category",attribution:null,presentation:"label_and_id",terms:[...terms,...terms.flatMap((item)=>[`${item}ID`,`${item}编号`,`${item}名称`,`${item}姓名`])],labelTerms:terms.flatMap((item)=>[`${item}名称`,`${item}姓名`])});}
  }
  return result;
}

function detectMeasures(text,subjects,shape,concepts=[]) {
  const found=[];
  for(const item of MEASURE_CONCEPTS)if(item.pattern.test(text))found.push({id:`measure:${item.value}`,value:item.value,sourceText:matched(text,item.pattern),role:"business_measure",aggregation:item.aggregation,grain:measureGrain(item.value,subjects),timeRole:item.timeRole,terms:[...item.terms]});
  // A complete rate phrase such as “成单率” is one metric. The embedded word
  // “成单” must not create a second count metric alongside it.
  const rate=found.find((item)=>item.value==="rate");
  if(rate)for(let index=found.length-1;index>=0;index--) {
    const item=found[index];
    if(item!==rate&&new Set(["won","completed"]).has(item.value)&&item.sourceText&&rate.sourceText.includes(item.sourceText))found.splice(index,1);
  }
  if(!found.length&&shape.kind==="ranking"&&/排行|排名|榜单/.test(text)&&/数量|个数|最多|最少/.test(text)) {
    const item=MEASURE_CONCEPTS.find((entry)=>entry.value==="count");found.push({id:"measure:count",value:"count",sourceText:matched(text,/数量|个数|最多|最少/),role:"business_measure",aggregation:item.aggregation,grain:measureGrain("count",subjects),timeRole:null,terms:[...item.terms]});
  }
  const matches=[];
  for(const concept of concepts.filter((item)=>item?.kind==="measure")) {
    const aliases=(concept.aliases||[]).filter((item)=>normalizeText(text).includes(normalizeText(item))).sort((left,right)=>normalizeText(right).length-normalizeText(left).length);
    if(aliases[0])matches.push({concept,alias:aliases[0]});
  }
  const grouped=new Map();
  for(const match of matches){const key=normalizeText(match.alias);const values=grouped.get(key)||[];values.push(match);grouped.set(key,values);}
  for(const group of grouped.values()) {
    const alias=group[0].alias;const concept=group[0].concept;
    let target=found.find((item)=>surfaceOverlaps(item.sourceText,alias))||(concept.aggregation&&concept.aggregation!=="unknown"?found.find((item)=>item.aggregation===concept.aggregation):null);
    if(!target) {
      const value=concept.value||safeConceptId(alias);
      target={id:`measure:${safeConceptId(value)}`,value,sourceText:alias,role:"business_measure",aggregation:concept.aggregation||"unknown",grain:concept.grain||measureGrain(value,subjects),timeRole:concept.timeRole||null,terms:[alias]};found.push(target);
    }
    target.definitionCandidates=[...new Map([...(target.definitionCandidates||[]),...group.map((item)=>({source:item.concept.metricDefinition?.source||item.concept.evidence?.page,title:item.alias}))].map((item)=>[item.source,item])).values()];
    target.terms=[...new Set([...target.terms,alias,...group.flatMap((item)=>item.concept.terms||[])])];
    if(target.definitionCandidates.length===1) {
      target.evidence=concept.evidence||target.evidence||null;target.metricDefinition=concept.metricDefinition||target.metricDefinition||null;
      if(concept.aggregation&&concept.aggregation!=="unknown")target.aggregation=concept.aggregation;
      if(concept.grain)target.grain=concept.grain;if(concept.timeRole)target.timeRole=concept.timeRole;
    } else {target.evidence=null;target.metricDefinition=null;}
  }
  return found;
}

function detectTimeRole(text,timeRange,measures,required=false) {
  if(!timeRange&&!required)return null;
  const matches=TIME_ROLE_CONCEPTS.filter((item)=>item.pattern.test(text));
  const measureRoles=[...new Set((measures||[]).map((item)=>item.timeRole).filter(Boolean))];
  for(const value of measureRoles)if(!matches.some((item)=>item.value===value)) {const concept=TIME_ROLE_CONCEPTS.find((item)=>item.value===value);if(concept)matches.push(concept);}
  const unique=[...new Map(matches.map((item)=>[item.value,item])).values()];
  if(unique.length>1)return {ambiguous:true,candidates:unique};
  const selected=unique[0];
  return selected?{value:selected.value,sourceText:matched(text,selected.pattern)||timeRange.sourceText,terms:[...selected.terms],attachesTo:measures?.[0]?.id||null}:null;
}

function buildRequirements(intent) {
  const requirements=[];
  for(const subject of intent?.subjects||[]) {
    const terms=SUBJECT_CONCEPTS[subject]||[subject];
    requirements.push({id:`subject:${subject}`,kind:"subject",value:subject,role:"business_object",surfaceText:subject,required:true,allowMultiple:Boolean(intent?.scope?.exhaustive||(intent?.scope?.products?.length||0)>1),anchorTerms:[...terms],terms:[...terms]});
  }
  for(const dimension of intent?.dimensions||[])requirements.push({id:dimension.id,kind:"dimension",value:dimension.value,role:dimension.attribution?`${dimension.role}:${dimension.attribution}`:dimension.role,attribution:dimension.attribution||null,surfaceText:dimension.sourceText,required:true,terms:[...dimension.terms],anchorTerms:[...dimension.terms],bindingTerms:attributionBindingTerms(dimension),labelTerms:[...dimension.labelTerms],presentation:dimension.presentation});
  for(const measure of intent?.measures||[])requirements.push({id:measure.id,kind:"measure",value:measure.value,role:measure.role,surfaceText:measure.sourceText,required:true,terms:[...measure.terms],aggregation:measure.aggregation,grain:measure.grain,evidence:measure.evidence||null,metricDefinition:measure.metricDefinition||null});
  for(const filter of intent?.filters||[])requirements.push({
    id:filter.requirementId||filter.id,
    filterId:filter.id,
    kind:"filter",
    value:filter.value,
    sourceValue:filter.value,
    field:filter.field||null,
    fieldSurface:filter.fieldSurface||null,
    role:filter.kind||"business_filter",
    surfaceText:filter.sourceText||String(filter.value??""),
    required:true,
    allowMultiple:Boolean(intent?.scope?.exhaustive||(intent?.scope?.products?.length||0)>1),
    operator:filter.operator||"eq",
    valueType:filter.valueType||filterValueType(filter.value),
    attachesTo:filter.attachesTo||null,
    fieldTerms:[...(filter.fieldTerms||[])],
    physicalColumns:[...(filter.physicalColumns||[])],
    valueBinding:filter.valueBinding||null,
    provenance:filter.provenance||null,
    anchorTerms:[...(filter.fieldTerms||[])],
    terms:[...(filter.fieldTerms||[])],
  });
  if(intent?.timeRange||intent?.shape?.kind==="trend") {
    const role=intent.timeRole;
    const sourceText=intent.timeRange?.sourceText||intent.shape?.timeGrain||"时间";
    const terms=role?.terms?.length?[sourceText,...role.terms]:[sourceText,"时间","日期","发生时间","time","date"];
    requirements.push({id:intent.timeRange?`time:${intent.timeRange.kind}`:`time_dimension:${intent.shape?.timeGrain||"unknown"}`,kind:"time",value:intent.timeRange?.kind||intent.shape?.timeGrain||"unknown",role:role?.value||"unknown",surfaceText:sourceText,required:true,terms,...(intent.timeRange?{range:{start:intent.timeRange.start,endExclusive:intent.timeRange.endExclusive}}:{}),grain:intent.shape?.timeGrain||null,attachesTo:role?.attachesTo||null});
    if(intent.comparisonRange)requirements.push({id:`time:comparison_${intent.shape?.comparisonMode||"custom"}`,kind:"time",value:intent.comparisonRange.kind,role:role?.value||"unknown",surfaceText:intent.comparisonRange.sourceText,required:true,terms:[intent.comparisonRange.sourceText,...(role?.terms||[]),"基准期","对比期","comparison","baseline"],range:{start:intent.comparisonRange.start,endExclusive:intent.comparisonRange.endExclusive},attachesTo:role?.attachesTo||null});
  }
  return requirements;
}

function measureGrain(value,subjects) {
  if(subjects.length===1)return subjects[0];
  if(value==="revenue"||value==="average")return "amount";
  return "unknown";
}

function explicitAttribution(text) {
  const value=String(text||"").replace(/\s+/g,"");
  const withoutNegated=value
    .replace(/(?:不是|不要|不按|不用|别按|非|排除|取消)(?:选择|使用|采用|按|用)?(?:当前|现在|现任|目前)(?:的)?(?:负责人|销售|归属人)?/g,"")
    .replace(/(?:不是|不要|不按|不用|别按|非|排除|取消)(?:选择|使用|采用|按|用)?(?:成单时|成交时|事件发生时|当时|历史|快照)(?:的)?(?:负责人|销售|归属人)?/g,"")
    .replace(/\bnot(?:use|choose)?(?:the)?(?:current[_-]?(?:owner|assignee)|event[_-]?(?:owner|assignee)|closing[_-]?owner|won[_-]?owner)\b/gi,"");
  const current=/(?:当前|现在|现任|目前)(?:的)?(?:负责人|销售|归属人)?|current[_-]?(?:owner|assignee)/i.test(withoutNegated);
  const eventTime=/(?:成单时|成交时|事件发生时|当时|历史|快照)(?:的)?(?:负责人|销售|归属人)?|event[_-]?(?:owner|assignee)|closing[_-]?owner|won[_-]?owner/i.test(withoutNegated);
  if(current===eventTime)return null;
  if(current)return "current";
  if(eventTime)return "event_time";
  return null;
}

function attributionBindingTerms(dimension) {
  if(dimension?.value!=="seller"||!dimension.attribution)return [];
  if(dimension.attribution==="current")return ["当前负责人","当前负责","现任负责人","当前归属","current_owner","active_owner","current_assignee","is_deleted"];
  if(dimension.attribution==="event_time")return ["成单时负责人","成交时负责人","事件负责人","历史负责人","负责人快照","closing_owner","won_owner","event_owner","owner_snapshot","assignee_snapshot","effective_at"];
  return [];
}

function clarifiedGrain(text) {
  if(/线索/.test(text))return "clue";
  if(/订单/.test(text))return "order";
  if(/商机/.test(text))return "opportunity";
  if(/客户/.test(text))return "customer";
  if(/案件/.test(text))return "case";
  if(/账号|账户/.test(text))return "account";
  return null;
}

function detectTimeGrain(text) {
  if(/按(?:天|日)|每日|daily|\bday\b/i.test(text))return "day";
  if(/按周|每周|weekly|\bweek\b/i.test(text))return "week";
  if(/按月|每月|monthly|\bmonth\b/i.test(text))return "month";
  if(/按(?:季度|季)|每季度|quarter/i.test(text))return "quarter";
  if(/按年|每年|yearly|\byear\b/i.test(text))return "year";
  return null;
}

function clarifiedTimeGrain(text){return detectTimeGrain(String(text||""));}

function customDimensionPhrase(text) {
  const match=String(text||"").match(/按(.{1,16}?)(?:排行|排名|榜单|统计|分组|汇总|对比|比较|$)/);
  const phrase=String(match?.[1]||"").replace(/(?:本月|上月|本周|上周|今天|昨天|每日|每周|每月)$/g,"").trim();
  return phrase&&[...phrase].length<=16?phrase:"";
}

function customDimensionTerms(phrase) {
  const reduced=String(phrase||"").replace(/^(?:线索|账号|账户|用户|客户|订单|案件|案源|产品|商品|渠道|机构|组织)/,"");
  return [...new Set([phrase,reduced].filter(Boolean))];
}

function inferKnowledgeAggregation(sql) {
  const text=String(sql||"");
  if(/\b(?:COUNT|SUM|AVG)\s*\(/i.test(text)&&/\//.test(text))return "ratio";
  if(/COUNT\s*\(\s*DISTINCT/i.test(text))return "count_distinct";
  if(/\bSUM\s*\(/i.test(text))return "sum";
  if(/\bAVG\s*\(/i.test(text))return "avg";
  if(/\bCOUNT\s*\(/i.test(text))return "count";
  return "unknown";
}

function inferKnowledgeRatioFormula(page,columnsByTable) {
  const sql=String(page?.sqlContent||"");
  const slash=topLevelOperator(sql,"/");
  if(slash<0)return null;
  const numerator=aggregateBeside(sql,slash,"left",page,columnsByTable);
  const denominator=aggregateBeside(sql,slash,"right",page,columnsByTable);
  return numerator&&denominator?{numerator,denominator}:null;
}

function topLevelOperator(value,operator) {
  let depth=0;let quote=null;
  for(let index=0;index<value.length;index++) {
    const char=value[index];
    if(quote){if(char===quote&&value[index-1]!=="\\")quote=null;continue;}
    if(char==="'"||char==='"'||char==="`"){quote=char;continue;}
    if(char==="(")depth++;else if(char===")")depth=Math.max(0,depth-1);else if(char===operator&&depth===0)return index;
  }
  return -1;
}

function aggregateBeside(sql,slash,direction,page,columnsByTable) {
  const matches=[...sql.matchAll(/\b(COUNT|SUM|AVG)\s*\(/ig)];
  const match=direction==="left"?[...matches].reverse().find((item)=>item.index<slash):matches.find((item)=>item.index>slash);
  if(!match)return null;
  const open=sql.indexOf("(",match.index);const close=matchingParen(sql,open);
  if(close<0||(direction==="left"&&close>slash)||(direction==="right"&&match.index<slash))return null;
  let body=sql.slice(open+1,close).trim();const distinct=/^DISTINCT\b/i.test(body);if(distinct)body=body.replace(/^DISTINCT\b/i,"").trim();
  const scopedPage={...page,content:"",antiExamples:"",sqlContent:body};
  const columns=extractKnowledgeColumnRefs(scopedPage,columnsByTable).map((item)=>`${item.table}.${item.column}`);
  const predicateBinding=predicateSignatures(body,page,columnsByTable);
  return {aggregation:String(match[1]).toLowerCase(),distinct,columns,predicates:predicateBinding.predicates,predicateBinding:predicateBinding.status};
}

function matchingParen(value,open) {
  let depth=0;let quote=null;
  for(let index=open;index<value.length;index++) {
    const char=value[index];
    if(quote){if(char===quote&&value[index-1]!=="\\")quote=null;continue;}
    if(char==="'"||char==='"'||char==="`"){quote=char;continue;}
    if(char==="(")depth++;else if(char===")"&&--depth===0)return index;
  }
  return -1;
}

function predicateSignatures(value,page,columnsByTable,{strictFragment=false}={}) {
  const text=String(value||"");
  if(/\bOR\b|\bNOT\b(?!\s+NULL\b)/i.test(text))return {status:"unsupported",predicates:[],reason:"boolean_expression_unsupported"};
  const identifier="(?:`?[a-z_][a-z0-9_$]*`?\\.)?`?[a-z_][a-z0-9_$]*`?";
  const literal="(?:'(?:''|[^'])*'|\"(?:\"\"|[^\"])*\"|[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)|TRUE|FALSE|NULL)";
  const direct=new RegExp(`(${identifier})\\s*(>=|<=|<>|!=|=|>|<)\\s*(${literal})`,"gi");
  const reverse=new RegExp(`(${literal})\\s*(>=|<=|<>|!=|=|>|<)\\s*(${identifier})`,"gi");
  const nullCheck=new RegExp(`(${identifier})\\s+IS\\s+(NOT\\s+)?NULL`,"gi");
  const predicates=[];const spans=[];let unresolved=false;let comparisons=0;
  const add=(rawColumn,operator,rawLiteral,match)=>{
    comparisons++;
    const column=resolveKnowledgePredicateColumn(rawColumn,page,columnsByTable);
    const value=canonicalLiteral(rawLiteral);
    if(!column||!value){unresolved=true;return;}
    predicates.push({column,operator,valueType:value.type,value:value.value});
    if(match)spans.push({start:match.index,end:match.index+match[0].length});
  };
  for(const item of text.matchAll(direct))add(item[1],item[2],item[3],item);
  for(const item of text.matchAll(reverse))if(!spans.some((span)=>item.index<span.end&&span.start<item.index+item[0].length))add(item[3],reverseComparisonOperator(item[2]),item[1],item);
  for(const item of text.matchAll(nullCheck))if(!spans.some((span)=>item.index<span.end&&span.start<item.index+item[0].length))add(item[1],item[2]?"IS NOT":"IS","NULL",item);
  const uniquePredicates=[...new Map(predicates.map((item)=>[`${item.column}|${item.operator}|${item.valueType}|${item.value}`,item])).values()].sort((left,right)=>JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if(strictFragment) {
    const chars=text.split("");for(const span of spans)for(let index=span.start;index<span.end;index++)chars[index]=" ";
    const remainder=chars.join("").replace(/^\s*WHERE\b/i,"").replace(/\bAND\b/gi,"").replace(/[()\s;]+/g,"");
    if(remainder)return {status:"unsupported",predicates:[],reason:"predicate_fragment_not_fully_consumed",remainder};
  }
  return {status:unresolved||comparisons!==uniquePredicates.length?"unsupported":"physical",predicates:uniquePredicates,...(unresolved?{reason:"predicate_column_or_literal_unresolved"}:{})};
}

function resolveKnowledgePredicateColumn(rawValue,page,columnsByTable) {
  const raw=String(rawValue||"").replaceAll("`","").toLowerCase();
  const parts=raw.split(".");const column=parts.at(-1);const qualifier=parts.length>1?parts.at(-2):null;
  const aliasMap=new Map();
  for(const match of String(page?.sqlContent||"").matchAll(/\b(?:FROM|JOIN)\s+`?([a-z_][a-z0-9_$]*)`?(?:\s+(?:AS\s+)?`?([a-z_][a-z0-9_$]*)`?)?/gi)) {
    const table=String(match[1]).toLowerCase();const alias=String(match[2]||table).toLowerCase();
    if(!new Set(["on","where","join","left","right","inner","outer","group","order","limit"]).has(alias))aliasMap.set(alias,table);
    aliasMap.set(table,table);
  }
  const declaredTables=(page?.tables||[]).map((item)=>String(item||"").toLowerCase()).filter(Boolean);
  const scopedTables=[...new Set((declaredTables.length?declaredTables:Object.keys(columnsByTable||{})).map((item)=>String(item||"").toLowerCase()).filter(Boolean))];
  if(qualifier) {
    const table=aliasMap.get(qualifier)||qualifier;
    return (columnsByTable?.[table]||[]).some((item)=>String(item.columnName??item).toLowerCase()===column)?`${table}.${column}`:null;
  }
  const matches=scopedTables.filter((table)=>(columnsByTable?.[table]||[]).some((item)=>String(item.columnName??item).toLowerCase()===column));
  return matches.length===1?`${matches[0]}.${column}`:null;
}

function canonicalLiteral(rawValue) {
  const raw=String(rawValue||"").trim();
  if(/^'(?:''|[^'])*'$/.test(raw))return {type:"string",value:raw.slice(1,-1).replaceAll("''", "'")};
  if(/^"(?:""|[^"])*"$/.test(raw))return {type:"string",value:raw.slice(1,-1).replaceAll('""','"')};
  if(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw))return {type:"number",value:canonicalDecimalLexeme(raw)};
  if(/^(?:TRUE|FALSE)$/i.test(raw))return {type:"boolean",value:raw.toLowerCase()};
  if(/^NULL$/i.test(raw))return {type:"null",value:"null"};
  return null;
}

function canonicalDecimalLexeme(value) {
  const match=String(value||"").match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))$/);if(!match)return String(value||"");
  const integer=String(match[2]||"0").replace(/^0+(?=\d)/,"")||"0";const fraction=String(match[3]??match[4]??"").replace(/0+$/,"");const negative=match[1]==="-"&&!(integer==="0"&&!fraction)?"-":"";
  return `${negative}${integer}${fraction?`.${fraction}`:""}`;
}

function reverseComparisonOperator(operator){return ({">=":"<=",">":"<","<":">","<=":">=","=":"=","!=":"!=","<>":"<>"})[operator]||operator;}

function inferKnowledgeGrain(value) {
  const text=String(value||"");
  const match=text.match(/按(?:唯一)?(线索|订单|商机|客户|案件|账号|账户).{0,8}去重|COUNT\s*\(\s*DISTINCT\s+[^)]*?\b(clue|order|opportunity|customer|case|account)(?:_id|_no|\.id)\b[^)]*\)/i);
  const raw=match?.[1]||match?.[2]||"";
  return {线索:"clue",订单:"order",商机:"opportunity",客户:"customer",案件:"case",账号:"account",账户:"account"}[raw]||String(raw).toLowerCase()||null;
}

function safeConceptId(value){const latin=String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");if(latin)return latin.slice(0,64);let hash=2166136261;for(const char of String(value||"")){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}return `c${(hash>>>0).toString(36)}`;}
function surfaceOverlaps(left,right){const a=normalizeText(left);const b=normalizeText(right);return Boolean(a&&b&&(a.includes(b)||b.includes(a)));}
function normalizeText(value){return String(value||"").toLowerCase().replace(/\s+/g,"");}

function detectTimeRange(text,now,timeZone) {
  const value=String(text||"");
  const rollingSignals=tokenMatches(value,/近([+-]?(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百千万]+)?)(个月|天|日|周|月|年)/g);
  const rollingTokens=tokenMatches(value,/近(\d+)(个月|天|日|周|月|年)/g);
  const dateTokens=tokenMatches(value,/(\d{4})年(\d{1,2})月(\d{1,2})(?:日|号)/g);
  const monthTokens=tokenMatches(value,/(\d{4})年(\d{1,2})月(?:份)?/g).filter((token)=>!dateTokens.some((date)=>spansOverlap(token,date)));
  const yearTokens=tokenMatches(value,/(\d{4})年(?:度)?/g).filter((token)=>![...dateTokens,...monthTokens,...rollingSignals].some((item)=>spansOverlap(token,item)));
  const relativeTokens=relativeTimeTokens(value);
  const explicitTokens=[...dateTokens,...monthTokens,...yearTokens];
  const allRecognized=[...explicitTokens,...rollingTokens,...relativeTokens];

  if(hasUnsupportedTimeModifier(value))return unknownTimeRange(value,"unsupported_expression");
  if(rollingSignals.length!==rollingTokens.length)return unknownTimeRange(rollingSignals[0]?.text||timeSignalSource(value),"invalid_rolling_count");

  if(dateTokens.length) {
    if(monthTokens.length||yearTokens.length||rollingTokens.length||relativeTokens.length||dateTokens.length>2)return unknownTimeRange(timeSignalSource(value,allRecognized),"multiple_time_ranges");
    if(hasUnparsedTimeRangeSignal(value,dateTokens))return unknownTimeRange(value,"unsupported_expression");
    if(dateTokens.length===2) {
      if(!supportedDateRangeConnector(value,dateTokens[0],dateTokens[1]))return unknownTimeRange(value.slice(dateTokens[0].start,dateTokens[1].end),"unsupported_date_range_connector");
      try {
        const start=dateFromToken(dateTokens[0]);const inclusiveEnd=dateFromToken(dateTokens[1]);
        if(compareDateOnly(start,inclusiveEnd)>0)return unknownTimeRange(value.slice(dateTokens[0].start,dateTokens[1].end),"reversed_date_range");
        return resolvedTimeRange({kind:"explicit_date_range",sourceText:value.slice(dateTokens[0].start,dateTokens[1].end),start,endExclusive:addDateOnlyDays(inclusiveEnd,1)});
      } catch {return unknownTimeRange(value.slice(dateTokens[0].start,dateTokens[1].end),"invalid_calendar_date");}
    }
    try {
      const start=dateFromToken(dateTokens[0]);
      return resolvedTimeRange({kind:"explicit_day",sourceText:dateTokens[0].text,start,endExclusive:addDateOnlyDays(start,1)});
    } catch {return unknownTimeRange(dateTokens[0].text,"invalid_calendar_date");}
  }

  if(monthTokens.length) {
    if(monthTokens.length!==1||yearTokens.length||rollingTokens.length||relativeTokens.length)return unknownTimeRange(timeSignalSource(value,allRecognized),"multiple_time_ranges");
    const token=monthTokens[0];
    if(hasUnparsedTimeRangeSignal(value,[token]))return unknownTimeRange(value,"unsupported_expression");
    try {
      const year=Number(token.match[1]);const month=Number(token.match[2]);
      const start=validMonthStart(year,month);
      return resolvedTimeRange({kind:"explicit_month",sourceText:token.text,start,endExclusive:shiftDateOnly(start,{months:1})});
    } catch {return unknownTimeRange(token.text,"invalid_calendar_month");}
  }

  if(yearTokens.length) {
    if(yearTokens.length!==1||rollingTokens.length||relativeTokens.length)return unknownTimeRange(timeSignalSource(value,allRecognized),"multiple_time_ranges");
    const token=yearTokens[0];
    if(hasUnparsedTimeRangeSignal(value,[token]))return unknownTimeRange(value,"unsupported_expression");
    try {
      const year=Number(token.match[1]);const start=validYearStart(year);
      return resolvedTimeRange({kind:"explicit_year",sourceText:token.text,start,endExclusive:validYearStart(year+1)});
    } catch {return unknownTimeRange(token.text,"invalid_calendar_year");}
  }

  if(rollingSignals.length) {
    if(rollingTokens.length!==1||relativeTokens.length)return unknownTimeRange(timeSignalSource(value,[...rollingTokens,...relativeTokens]),"multiple_time_ranges");
    const token=rollingTokens[0];const count=Number(token.match[1]);const unit=token.match[2];
    if(hasUnparsedTimeRangeSignal(value,[token]))return unknownTimeRange(value,"unsupported_expression");
    if(!Number.isSafeInteger(count)||count<=0)return unknownTimeRange(token.text,"invalid_rolling_count");
    try {
      const endExclusive=addDateOnlyDays(calendarDateInTimeZone(now,timeZone),1);
      const rolling=rollingRangeStart(endExclusive,count,unit);
      return resolvedTimeRange({kind:rolling.kind,sourceText:token.text,start:rolling.start,endExclusive});
    } catch {return unknownTimeRange(token.text,"rolling_range_out_of_bounds");}
  }

  if(relativeTokens.length) {
    if(relativeTokens.length!==1)return unknownTimeRange(timeSignalSource(value,relativeTokens),"multiple_time_ranges");
    if(hasUnparsedTimeRangeSignal(value,relativeTokens))return unknownTimeRange(value,"unsupported_expression");
    try {return resolvedTimeRange(relativeRange(relativeTokens[0],now,timeZone));}
    catch {return unknownTimeRange(relativeTokens[0].text,"relative_range_out_of_bounds");}
  }

  if(hasExplicitTimeRangeSignal(value))return unknownTimeRange(timeSignalSource(value),"unsupported_expression");
  return resolvedTimeRange(null);
}

function detectComparisonRange(shape,timeRange) {
  if(shape?.kind!=="comparison"||!timeRange)return null;
  if(shape.comparisonMode==="year_over_year")return shiftCalendarRange(timeRange,{years:-1,kind:"comparison_year_over_year",sourceText:"同比基准期"});
  if(shape.comparisonMode!=="period_over_period")return null;
  const common={kind:"comparison_period_over_period",sourceText:"环比基准期"};
  if(new Set(["today","yesterday","explicit_day"]).has(timeRange.kind))return shiftCalendarRange(timeRange,{days:-1,...common});
  if(new Set(["current_week","previous_week"]).has(timeRange.kind))return shiftCalendarRange(timeRange,{days:-7,...common});
  if(new Set(["current_month","previous_month","explicit_month"]).has(timeRange.kind))return shiftCalendarRange(timeRange,{months:-1,...common});
  if(new Set(["current_quarter","previous_quarter"]).has(timeRange.kind))return shiftCalendarRange(timeRange,{months:-3,...common});
  if(new Set(["current_year","previous_year","explicit_year"]).has(timeRange.kind))return shiftCalendarRange(timeRange,{years:-1,...common});
  const rolling=timeRange.sourceText.match(/^近(\d+)(个月|天|日|周|月|年)$/);
  if(rolling&&new Set(["个月","月"]).has(rolling[2]))return shiftCalendarRange(timeRange,{months:-Number(rolling[1]),...common});
  if(rolling?.[2]==="年")return shiftCalendarRange(timeRange,{years:-Number(rolling[1]),...common});
  if(new Set(["rolling_days","rolling_weeks","explicit_date_range"]).has(timeRange.kind)) {
    const days=dateRangeDays(timeRange);
    return {kind:common.kind,sourceText:common.sourceText,start:addDateOnlyDays(timeRange.start,-days),endExclusive:timeRange.start};
  }
  return null;
}

function shiftCalendarRange(range,{years=0,months=0,days=0,kind,sourceText}) {
  const shift=(value)=>shiftDateOnly(value,{years,months,days});
  return {kind,sourceText,start:shift(range.start),endExclusive:shift(range.endExclusive)};
}

function calendarMonth(kind,sourceText,now,timeZone,offset) {
  const current=calendarDateInTimeZone(now,timeZone);
  const [year,month]=current.split("-").map(Number);
  const first=formatDateOnly(year,month,1);
  return {kind,sourceText,start:shiftDateOnly(first,{months:offset}),endExclusive:shiftDateOnly(first,{months:offset+1})};
}

function calendarWeek(kind,sourceText,now,timeZone,offset) {
  const current=calendarDateInTimeZone(now,timeZone);
  const monday=addDateOnlyDays(current,-mondayBasedWeekday(current));
  return {kind,sourceText,start:addDateOnlyDays(monday,offset*7),endExclusive:addDateOnlyDays(monday,(offset+1)*7)};
}

function calendarQuarter(kind,sourceText,now,timeZone,offset) {
  const [year,month]=dateOnlyParts(calendarDateInTimeZone(now,timeZone));
  const first=formatDateOnly(year,Math.floor((month-1)/3)*3+1,1);
  return {kind,sourceText,start:shiftDateOnly(first,{months:offset*3}),endExclusive:shiftDateOnly(first,{months:(offset+1)*3})};
}

function calendarYear(kind,sourceText,now,timeZone,offset) {
  const [year]=dateOnlyParts(calendarDateInTimeZone(now,timeZone));
  return {kind,sourceText,start:validYearStart(year+offset),endExclusive:validYearStart(year+offset+1)};
}

function relativeTimeTokens(value) {
  const definitions=[
    {key:"current_month",pattern:/本月|这个月|当月/g},
    {key:"previous_month",pattern:/上月|上个月/g},
    {key:"current_week",pattern:/本周|这周|本星期|这个星期/g},
    {key:"previous_week",pattern:/上周|上星期|上个星期/g},
    {key:"current_quarter",pattern:/本季度|这个季度|当季|本季/g},
    {key:"previous_quarter",pattern:/上季度|上个季度|上一季度/g},
    {key:"current_year",pattern:/本年度|今年|本年|当年/g},
    {key:"previous_year",pattern:/去年|上年|上一年/g},
    {key:"today",pattern:/今天|今日/g},
    {key:"yesterday",pattern:/昨天|昨日/g},
  ];
  return definitions.flatMap((definition)=>tokenMatches(value,definition.pattern).map((token)=>({...token,key:definition.key}))).sort((left,right)=>left.start-right.start||right.end-left.end);
}

function relativeRange(token,now,timeZone) {
  if(token.key==="current_month")return calendarMonth("current_month",token.text,now,timeZone,0);
  if(token.key==="previous_month")return calendarMonth("previous_month",token.text,now,timeZone,-1);
  if(token.key==="current_week")return calendarWeek("current_week",token.text,now,timeZone,0);
  if(token.key==="previous_week")return calendarWeek("previous_week",token.text,now,timeZone,-1);
  if(token.key==="current_quarter")return calendarQuarter("current_quarter",token.text,now,timeZone,0);
  if(token.key==="previous_quarter")return calendarQuarter("previous_quarter",token.text,now,timeZone,-1);
  if(token.key==="current_year")return calendarYear("current_year",token.text,now,timeZone,0);
  if(token.key==="previous_year")return calendarYear("previous_year",token.text,now,timeZone,-1);
  if(token.key==="today") {
    const start=calendarDateInTimeZone(now,timeZone);return {kind:"today",sourceText:token.text,start,endExclusive:addDateOnlyDays(start,1)};
  }
  if(token.key==="yesterday") {
    const endExclusive=calendarDateInTimeZone(now,timeZone);return {kind:"yesterday",sourceText:token.text,start:addDateOnlyDays(endExclusive,-1),endExclusive};
  }
  throw new TypeError(`不支持的相对时间：${token.text}`);
}

function rollingRangeStart(endExclusive,count,unit) {
  if(new Set(["天","日"]).has(unit))return {kind:"rolling_days",start:shiftDateOnlyChecked(endExclusive,{days:-count})};
  if(unit==="周") {
    const days=count*7;if(!Number.isSafeInteger(days))throw new RangeError("周数超出可解析范围");
    return {kind:"rolling_weeks",start:shiftDateOnlyChecked(endExclusive,{days:-days})};
  }
  if(new Set(["个月","月"]).has(unit))return {kind:"rolling_months",start:shiftDateOnlyChecked(endExclusive,{months:-count})};
  if(unit==="年")return {kind:"rolling_years",start:shiftDateOnlyChecked(endExclusive,{years:-count})};
  throw new TypeError(`不支持的滚动时间单位：${unit}`);
}

function resolvedTimeRange(range){return {range,unknown:null};}
function unknownTimeRange(sourceText,reason){return {range:null,unknown:{sourceText:String(sourceText||"未知时间表达"),reason}};}

function tokenMatches(value,pattern) {
  return [...String(value||"").matchAll(pattern)].map((match)=>({text:match[0],start:match.index,end:match.index+match[0].length,match}));
}

function spansOverlap(left,right){return left.start<right.end&&right.start<left.end;}

function dateFromToken(token) {
  const value=formatDateOnly(Number(token.match[1]),Number(token.match[2]),Number(token.match[3]));
  dateOnlyParts(value);return value;
}

function validMonthStart(year,month) {
  if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw new TypeError("无效日历月份");
  const value=formatDateOnly(year,month,1);dateOnlyParts(value);return value;
}

function validYearStart(year) {
  if(!Number.isInteger(year)||year<1000||year>9999)throw new TypeError("无效日历年份");
  const value=formatDateOnly(year,1,1);dateOnlyParts(value);return value;
}

function shiftDateOnlyChecked(value,offset) {
  const shifted=shiftDateOnly(value,offset);dateOnlyParts(shifted);return shifted;
}

function compareDateOnly(left,right){return left.localeCompare(right);}

function dateRangeDays(range) {
  const [startYear,startMonth,startDay]=dateOnlyParts(range.start);
  const [endYear,endMonth,endDay]=dateOnlyParts(range.endExclusive);
  const value=(Date.UTC(endYear,endMonth-1,endDay)-Date.UTC(startYear,startMonth-1,startDay))/86_400_000;
  if(!Number.isSafeInteger(value)||value<=0)throw new TypeError("无效日期区间");
  return value;
}

function mondayBasedWeekday(value) {
  const [year,month,day]=dateOnlyParts(value);
  return (new Date(Date.UTC(year,month-1,day)).getUTCDay()+6)%7;
}

function supportedDateRangeConnector(value,left,right) {
  const connector=value.slice(left.end,right.start);
  if(/^(?:起)?(?:至|到|~|～|—|–|-)$/.test(connector))return true;
  return /^(?:和|与)$/.test(connector)&&/^之间/.test(value.slice(right.end));
}

function hasUnsupportedTimeModifier(value) {
  return /(?:截至|截止|以来|之前|之后|以前|以后|最近|过去|未来|明天|明日|前天|后天|年初|年末|月初|月末|季初|季末|上半年|下半年|第?[\d一二三四]+季度|Q[1-4]|某(?:天|日|周|月|季度|季|年))/i.test(value);
}

function hasExplicitTimeRangeSignal(value) {
  return /(?:本|这个|当|上个|上一?|去|近)(?:天|日|周|星期|月|季度|季|年)|(?:今天|今日|昨天|昨日|明天|前天|后天|最近|过去|未来|截至|截止|以来|之前|之后|上半年|下半年)|\d{4}(?:年|[-/]\d{1,2})|(?:^|[^\d])\d{1,2}月(?:\d{1,2}(?:日|号))?|(?:^|[^\d])\d{1,2}(?:日|号)(?:$|[^\d])|周[一二三四五六日天]|星期[一二三四五六日天]/i.test(value);
}

function hasUnparsedTimeRangeSignal(value,tokens) {
  const characters=String(value||"").split("");
  for(const token of tokens)for(let index=token.start;index<token.end;index++)characters[index]=" ";
  return hasExplicitTimeRangeSignal(characters.join(""));
}

function timeSignalSource(value,tokens=[]) {
  if(tokens.length) {
    const ordered=[...tokens].sort((left,right)=>left.start-right.start);
    return value.slice(ordered[0].start,ordered.at(-1).end);
  }
  return matched(value,/(?:最近|过去|未来|截至|截止|上半年|下半年|周[一二三四五六日天]|星期[一二三四五六日天]|\d{4}年[^\s]{0,12}|近[^\s]{0,12})/)||value;
}

function hasCurrentMonthPredicate(sql,timeRange) {
  return /\b(?:CURDATE|CURRENT_DATE|CURRENT_TIMESTAMP|NOW)\s*\(|\bCURRENT_DATE\b|DATE_FORMAT\s*\(|EXTRACT\s*\(|\bYEAR\s*\(|\bMONTH\s*\(/i.test(sql)||hasExplicitRange(sql,timeRange);
}

function hasPreviousMonthPredicate(sql,timeRange) {
  return /DATE_SUB\s*\(|INTERVAL\s+1\s+MONTH|LAST_DAY\s*\(/i.test(sql)||hasExplicitRange(sql,timeRange);
}

function hasIntentTimeRangePredicate(sql,timeRange) {
  if(timeRange.kind==="current_month")return hasCurrentMonthPredicate(sql,timeRange);
  if(timeRange.kind==="previous_month")return hasPreviousMonthPredicate(sql,timeRange);
  return hasExplicitRange(sql,timeRange);
}

function hasExplicitRange(sql,timeRange) { return String(sql).includes(timeRange.start)&&String(sql).includes(timeRange.endExclusive); }

function resolveBusinessTimeZone(explicit) {
  const environment=typeof process!=="undefined"&&process?.env?process.env.BUSINESS_TIME_ZONE:undefined;
  const candidate=String(explicit??environment??DEFAULT_BUSINESS_TIME_ZONE).trim();
  if(!candidate||candidate.length>128||!/^[a-z0-9._+/-]+$/i.test(candidate))return DEFAULT_BUSINESS_TIME_ZONE;
  try {new Intl.DateTimeFormat("en-US",{timeZone:candidate}).format(new Date(0));return candidate;}
  catch {return DEFAULT_BUSINESS_TIME_ZONE;}
}

const calendarFormatters=new Map();
function calendarDateInTimeZone(value,timeZone) {
  const instant=value instanceof Date?value:new Date(value);
  if(Number.isNaN(instant.getTime()))throw new TypeError("now 必须是有效日期");
  let formatter=calendarFormatters.get(timeZone);
  if(!formatter) {
    formatter=new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn",{timeZone,year:"numeric",month:"2-digit",day:"2-digit"});
    calendarFormatters.set(timeZone,formatter);
  }
  const parts=Object.fromEntries(formatter.formatToParts(instant).filter((item)=>new Set(["year","month","day"]).has(item.type)).map((item)=>[item.type,item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function shiftDateOnly(value,{years=0,months=0,days=0}={}) {
  const [year,month,day]=dateOnlyParts(value);
  const targetMonthIndex=(year+years)*12+(month-1)+months;
  const targetYear=Math.floor(targetMonthIndex/12);const targetMonth=targetMonthIndex-targetYear*12+1;
  if(!Number.isSafeInteger(targetYear)||targetYear<1000||targetYear>9999)throw new RangeError("日历位移超出支持范围");
  const lastDay=new Date(Date.UTC(targetYear,targetMonth,0)).getUTCDate();
  const shifted=new Date(Date.UTC(targetYear,targetMonth-1,Math.min(day,lastDay)+days));
  const shiftedYear=shifted.getUTCFullYear();
  if(shiftedYear<1000||shiftedYear>9999)throw new RangeError("日历位移超出支持范围");
  return formatDateOnly(shiftedYear,shifted.getUTCMonth()+1,shifted.getUTCDate());
}

function addDateOnlyDays(value,days){return shiftDateOnly(value,{days});}
function dateOnlyParts(value) {
  const match=String(value||"").match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!match)throw new TypeError(`无效日历日期：${value}`);
  const parts=match.slice(1).map(Number);const probe=new Date(Date.UTC(parts[0],parts[1]-1,parts[2]));
  if(probe.getUTCFullYear()!==parts[0]||probe.getUTCMonth()+1!==parts[1]||probe.getUTCDate()!==parts[2])throw new TypeError(`无效日历日期：${value}`);
  return parts;
}
function formatDateOnly(year,month,day){return `${String(year).padStart(4,"0")}-${String(month).padStart(2,"0")}-${String(day).padStart(2,"0")}`;}
function matched(value,pattern){return String(value).match(pattern)?.[0]||"";}

function buildRetrievalTerms(intent) {
  // Once a clarification has become part of the structured intent, its
  // canonical binding vocabulary must travel with every retrieval refresh.
  // Do not depend on the free-form fallback question: semanticQuestion takes
  // precedence there, and intentionally remains the original business query.
  const result=buildIntentRetrievalFacets(intent).flatMap((facet)=>facet.kind==="entity"?[facet.value,facet.terms.slice(1).join(" ")]:[[...(facet.terms||[]),...(facet.bindingTerms||[])].join(" ")]);
  return [...new Set(result)];
}
