import { extractKnowledgeColumnRefs } from "./knowledge-column-refs.mjs";

const TIME_ROLE_CONCEPTS=[
  {value:"entry",pattern:/进线|入池|录入|创建|新增|注册|entered|created|registered/i,terms:["进线时间","入池时间","创建时间","新增时间","注册时间","clue_create_time","created_at","create_time","entered_at","registered_at"]},
  {value:"completion",pattern:/成单|成交|赢单|签单|完成|结案|closed|won|completed/i,terms:["成单时间","成交时间","赢单时间","签单时间","完成时间","结案时间","order_time","closed_at","won_at","completed_at","deal_time"]},
  {value:"order",pattern:/下单|订购|购买|ordered|purchased/i,terms:["下单时间","订单时间","购买时间","order_time","ordered_at","purchase_time","purchased_at"]},
  {value:"payment",pattern:/支付|付款|回款|到账|paid|payment/i,terms:["支付时间","付款时间","回款时间","到账时间","paid_at","payment_time","receive_time"]},
  {value:"activation",pattern:/激活|开通|启用|activated/i,terms:["激活时间","开通时间","activation_time","activated_at","enabled_at"]},
];
export function knowledgeIntentConcepts(pages=[],columnsByTable={}) {
  return (pages||[]).filter((page)=>page?.verified&&page.pageType==="metric").map((page)=>{
    const aliases=[page.title,...(page.aliases||[])].map((item)=>String(item||"").trim()).filter(Boolean);
    const definition=`${page.content||""} ${page.sqlContent||""}`;
    const timeRoleDerivation=inferKnowledgeTimeRole(page,definition,columnsByTable);
    const grainDerivation=inferKnowledgeGrain(definition,page);
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
      grain:aggregation==="precomputed"?"precomputed":grainDerivation.value,
      grainDerivation:aggregation==="precomputed"?derivation("precomputed","inferred"):grainDerivation,
      timeRole:timeRoleDerivation.value,
      timeRoleDerivation,
      terms:[...aliases,...(page.tables||[]),...(String(page.sqlContent||"").match(/[a-z][a-z0-9_]{1,63}/ig)||[])],
      evidence:{level:"verified_knowledge",page:`${page.pageType}:${page.slug}`},
      metricDefinition:{aggregation,columns:definitionColumns,tables:[...(page.tables||[])],source:`${page.pageType}:${page.slug}`,...(timeRoleDerivation.value?{timeRole:timeRoleDerivation.value}:{}),...(timeRoleDerivation.periodColumn?{periodColumn:timeRoleDerivation.periodColumn}:{}),...(rowCount?{rowCount:true}:{}),...(formula?{formula}: {})},
    };
  });
}

// Catalog-backed filter concepts turn datasource/ontology properties into
// field candidates before the intent is frozen.  The parser still records a
// business field surface, while physicalColumns remains proof supplied by the
// published catalog rather than a name guessed later by the model.
export function catalogFilterConcepts(tables=[],columnsByTable={},ontologySchema=null,termAnchors=[],enumItemsByColumn={}) {
  const groups=new Map();
  const tableByName=new Map((tables||[]).map((table)=>[table.tableName,table]));
  const subjectLabels={clue:"线索",account:"账号",customer:"客户",order:"订单",case:"案件",revenue:"收入"};
  const dictionaryByColumn=new Map(Object.entries(enumItemsByColumn||{}).map(([column,items])=>[String(column).toLowerCase(),items||[]]));
  const add=(alias,column,{numeric=false,provenance="catalog",semanticKind=null}={})=>{
    const surface=String(alias||"").trim();const physical=String(column||"").toLowerCase();
    if(!surface||surface.length>64||!physical.includes(".")||/^[\p{P}\p{S}\s]+$/u.test(surface))return;
    const key=normalizeText(surface);const group=groups.get(key)||{alias:surface,columns:new Set(),terms:new Set(),numericStates:new Set(),semanticKinds:new Set(),provenance:new Set(),memberValues:new Map()};
    group.columns.add(physical);group.terms.add(surface);group.terms.add(physical);group.terms.add(physical.split(".").at(-1));group.numericStates.add(Boolean(numeric));if(semanticKind)group.semanticKinds.add(semanticKind);group.provenance.add(provenance);groups.set(key,group);
    for(const member of dictionaryMemberSurfaces(dictionaryByColumn.get(physical))) {
      const memberKey=normalizeText(member);
      if(memberKey&&!group.memberValues.has(memberKey)&&group.memberValues.size<MEMBER_VALUE_LIMIT)group.memberValues.set(memberKey,member);
    }
  };
  for(const [tableName,columns] of Object.entries(columnsByTable||{})) {
    const table=tableByName.get(tableName)||{tableName,comment:""};
    const tableSubjects=detectSubjects(`${tableName} ${table.comment||""}`);
    for(const column of columns||[]) {
      const semanticKind=typedColumnKind(column);
      // 2026-09-04 应用户要求移除敏感列限制：所有列均登记为筛选概念。
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
      memberValues:[...group.memberValues.values()].sort(),
      provenance:[...group.provenance].sort(),
    };
  });
}

// The dictionary surfaces a person can actually type. A human-confirmed meaning
// ("抖音") is the surface for a coded value; a raw value is only its own surface
// when it is textual, because "2渠道" is not language anybody uses and admitting
// it would make the parser guess. Unconfirmed meanings are excluded on purpose:
// column comments go stale, and meaning_source is the level the binding layer
// trusts. Only verified enum meanings become ontology vocabulary.
// to avoid coupling the parser to the retrieval module.
const TRUSTED_MEANING_SOURCE=/^(?:verified|manual|human|user|ontology|knowledge|reviewed|confirmed)$/i;
const MEMBER_VALUE_LIMIT=200;

function dictionaryMemberSurfaces(items=[]) {
  const surfaces=[];
  for(const item of items||[]) {
    const raw=String(item?.value??"").trim();
    if(!raw||raw.toLowerCase()==="null")continue;
    const meaning=String(item?.meaning||"").trim();
    const surface=meaning&&TRUSTED_MEANING_SOURCE.test(String(item?.meaningSource||""))?meaning
      :/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)?null:raw;
    if(!surface||[...surface].length>24||/^[\p{P}\p{S}\s]+$/u.test(surface))continue;
    surfaces.push(surface);
  }
  return surfaces;
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
function numericDataType(value) {return /(?:tinyint|smallint|mediumint|bigint|decimal|numeric|number|float|double|real|integer|\bint\b)/i.test(String(value||""));}

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

function detectSubjects(text) {
  const subjects=[];
  if(/线索|进线|lead|clue/i.test(text))subjects.push("clue");
  if(/账号|账户|用户|account|\busers?\b/i.test(text))subjects.push("account");
  if(/客户|customer/i.test(text))subjects.push("customer");
  if(/订单|order/i.test(text))subjects.push("order");
  if(/案件|案源|\bcase\b|matter/i.test(text))subjects.push("case");
  if(/收入|营收|销售额|回款|revenue|sales/i.test(text))subjects.push("revenue");
  return subjects;
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
  return {aggregation:String(match[1]).toLowerCase(),distinct,columns,predicates:predicateBinding.predicates,predicateBinding:predicateBinding.status,...(predicateBinding.unresolvedColumns?{unresolvedColumns:predicateBinding.unresolvedColumns}:{})};
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
  const predicates=[];const spans=[];const unresolvedColumns=[];let unresolved=false;let comparisons=0;
  const add=(rawColumn,operator,rawLiteral,match)=>{
    comparisons++;
    const column=resolveKnowledgePredicateColumn(rawColumn,page,columnsByTable);
    const value=canonicalLiteral(rawLiteral);
    if(!column||!value){unresolved=true;if(!column)unresolvedColumns.push(String(rawColumn).replaceAll("`",""));return;}
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
  const unresolvedColumnNames=[...new Set(unresolvedColumns)];
  return {status:unresolved||comparisons!==uniquePredicates.length?"unsupported":"physical",predicates:uniquePredicates,...(unresolvedColumnNames.length?{unresolvedColumns:unresolvedColumnNames}:{}),...(unresolved?{reason:"predicate_column_or_literal_unresolved"}:{})};
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

// A derivation separates "this dimension does not apply" from "we could not work it
// out". Status is declared | inferred | not_applicable | undetermined; only
// undetermined may become a blocking ambiguity, and it never degrades to a bare null
// that downstream reads as "unconstrained".
function derivation(value,status,meta={}) { return {value,status,...meta}; }

const GRAIN_PROSE_TOKENS={线索:"clue",订单:"order",商机:"opportunity",客户:"customer",案件:"case",账号:"account",账户:"account"};
const GRAIN_COLUMN_TOKENS=["clue","order","opportunity","customer","case","account"];

// A page may carry a machine-readable contract. Prose stays for human readers;
// anything the harness must enforce is read from here first.
function declaredMetricContract(page) {
  const contract=page?.contract;
  if(!contract||typeof contract!=="object")return {};
  const timeRole=String(contract.timeRole||"").trim().toLowerCase();
  return {
    timeRole:TIME_ROLE_CONCEPTS.some((item)=>item.value===timeRole)?timeRole:null,
    periodColumn:String(contract.periodColumn||"").trim()||null,
    grain:String(contract.grain||"").trim().toLowerCase()||null,
  };
}

// Resolves a time column to its business event role. Returns null when the name
// is claimed by more than one role, leaving the caller to report undetermined
// rather than silently picking one.
function timeRoleForColumn(columnName) {
  const name=String(columnName||"").toLowerCase();
  if(!name)return null;
  const hits=TIME_ROLE_CONCEPTS.filter((role)=>role.terms.some((term)=>/^[a-z0-9_]+$/i.test(term)&&name.includes(term.toLowerCase())));
  return hits.length===1?hits[0].value:null;
}

// A definition that names its own period column is stronger evidence than keyword
// counting over the whole text: the column is a verifiable catalog reference.
function namedPeriodColumn(definition,columnsByTable) {
  const sentences=String(definition||"").split(/[。；;\n]/).filter((part)=>/统计周期|时间口径|周期绑定|周期固定|时间范围绑定/.test(part));
  for(const sentence of sentences) {
    for(const reference of sentence.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/g)||[]) {
      const [left,right]=reference.includes(".")?reference.split("."):[null,reference];
      for(const [table,columns] of Object.entries(columnsByTable||{})) {
        if(left&&String(table).toLowerCase()!==String(left).toLowerCase())continue;
        const column=(columns||[]).find((item)=>String(item.columnName).toLowerCase()===String(right).toLowerCase());
        if(column&&/date|time|timestamp/i.test(String(column.dataType||"")))return {table,column:column.columnName};
      }
    }
  }
  return null;
}

function inferKnowledgeTimeRole(page,definition,columnsByTable) {
  const source=`${page?.pageType}:${page?.slug}`;
  const declared=declaredMetricContract(page);
  const period=namedPeriodColumn(definition,columnsByTable);
  const declaredPeriod=declared.periodColumn||(period?`${period.table}.${period.column}`:null);
  if(declared.timeRole)return derivation(declared.timeRole,"declared",{source,...(declaredPeriod?{periodColumn:declaredPeriod}:{})});
  if(period) {
    const role=timeRoleForColumn(period.column);
    if(role)return derivation(role,"inferred",{source,periodColumn:`${period.table}.${period.column}`,reason:"period_column_named"});
  }
  const roles=TIME_ROLE_CONCEPTS.filter((item)=>item.pattern.test(definition));
  if(roles.length===1)return derivation(roles[0].value,"inferred",{source,reason:"single_prose_match",...(declaredPeriod?{periodColumn:declaredPeriod}:{})});
  if(roles.length>1)return derivation(null,"undetermined",{source,candidates:roles.map((item)=>item.value),reason:"multiple_prose_roles",...(declaredPeriod?{periodColumn:declaredPeriod}:{})});
  return derivation(null,"not_applicable",{source});
}

// Returns a derivation: a grain that could not be determined is reported as
// undetermined with its candidates, never as null. Callers must be able to tell
// "this metric has no grain" apart from "we failed to work the grain out".
function inferKnowledgeGrain(value,page=null) {
  const declaredGrain=declaredMetricContract(page).grain;
  if(declaredGrain)return derivation(declaredGrain,"declared",{source:`${page?.pageType}:${page?.slug}`});
  const text=String(value||"");
  const candidates=new Set();
  for(const [surface,grain] of Object.entries(GRAIN_PROSE_TOKENS)) {
    if(new RegExp(`(?:按|以|粒度为|粒度是)(?:唯一)?${surface}`).test(text))candidates.add(grain);
  }
  // Underscore is a word character, so \b never fires between a table prefix and
  // the token: `alpha_crm_clue.id` has to match through an explicit class.
  for(const fragment of text.match(/COUNT\s*\(\s*DISTINCT\s+[^)]*\)/ig)||[]) {
    for(const token of GRAIN_COLUMN_TOKENS) {
      if(new RegExp(`(?:^|[^a-z0-9])${token}(?:_id|_no|\\.id)`,"i").test(fragment))candidates.add(token);
    }
  }
  const values=[...candidates];
  if(values.length===1)return derivation(values[0],"inferred");
  if(values.length>1)return derivation(null,"undetermined",{candidates:values,reason:"multiple_grain_candidates"});
  return derivation(null,"not_applicable");
}

function safeConceptId(value){const latin=String(value||"").toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");if(latin)return latin.slice(0,64);let hash=2166136261;for(const char of String(value||"")){hash^=char.codePointAt(0);hash=Math.imul(hash,16777619);}return `c${(hash>>>0).toString(36)}`;}
function normalizeText(value){return String(value||"").toLowerCase().replace(/\s+/g,"");}
