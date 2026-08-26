import { parseQueryIntent, queryIntentSqlErrors } from "./query-intent.mjs";
import { buildQueryResultContract, validateQueryResultContract } from "./query-result-contract.mjs";

export function missingExhaustiveAccountTables(question,context={},usedTables=[]) {
  const roots=exhaustiveAccountTables(question,context);
  if(roots.length<2)return [];
  const used=new Set(usedTables.map((table)=>String(table).toLowerCase()));
  return roots.filter((table)=>!used.has(String(table).toLowerCase()));
}

export function missingExhaustiveAccountProductColumns(question,context={},queries=[]) {
  if(!isExhaustiveAccountQuestion(question))return [];
  const missing=[];
  const roots=new Set(exhaustiveAccountTables(question,context));
  for(const table of context.tables||[]) {
    if(!roots.has(table.tableName))continue;
    const columns=context.columns?.[table.tableName]||[];
    const productColumns=columns.filter((column)=>/product/.test(String(column.columnName).toLowerCase())||/产品(?:标识|类型|线|名称|版本|编码|key)/i.test(String(column.comment||""))).map((column)=>column.columnName);
    if(!productColumns.length)continue;
    const tableQueries=queries.filter((query)=>(query.tables||[]).some((used)=>String(used).toLowerCase()===String(table.tableName).toLowerCase()));
    if(tableQueries.length&&!tableQueries.some((query)=>productColumns.some((column)=>identifierPattern(column).test(String(query.sql||"")))))missing.push(...productColumns.map((column)=>`${table.tableName}.${column}`));
  }
  return missing;
}

export function exhaustiveAccountTables(question,context={}) {
  if(!isExhaustiveAccountQuestion(question))return [];
  const roots=(context.tables||[]).filter((table)=>{
    const columns=context.columns?.[table.tableName]||[];
    const tableName=String(table.tableName||"").toLowerCase();
    const comment=String(table.comment||"").toLowerCase();
    const tableText=`${tableName} ${comment}`;
    const auxiliary=/(?:^|_)(?:detail|details|day|daily|history|log|record|feedback|activate|activation|director|allocation|quota|business|relation|mapping|map|stat|summary|consume|event|track)(?:_|$)|明细|反馈|分配|额度|流水|日志|历史|记录|日维度|天维度|开通产品|激活记录|关联表|映射表|统计表/.test(tableText);
    if(auxiliary)return false;
    const explicitAccount=/(?:^|_)account(?:_|$)|账号|账户/.test(tableText);
    const userMaster=/(?:^|_)(?:user|users)$/.test(tableName)||/用户(?:信息|账号|账户|主表)|(?:用户|会员)主数据/.test(comment);
    if(!explicitAccount&&!userMaster)return false;
    return columns.some((column)=>{
      const name=String(column.columnName||"").toLowerCase();
      const columnComment=String(column.comment||"");
      return /(?:^|_)(?:office_?name|law_?firm(?:_?name)?|firm_?name)(?:_|$)/.test(name)||/(?:律所|律师事务所|机构)(?:名称|名)(?:$|[（(])/.test(columnComment);
    });
  }).map((table)=>table.tableName);
  const authoritative=new Set(intentSubjectTables(context.retrieval,"account").map(normalizeTable));
  const boundRoots=roots.filter((table)=>authoritative.has(normalizeTable(table)));
  return boundRoots.length?boundRoots:roots;
}

export function isExhaustiveAccountQuestion(question) { return /(?:所有|全部|完整|全量|各个).{0,12}(?:账号|账户)|(?:账号|账户).{0,12}(?:所有|全部|完整|全量)/.test(String(question||"")); }

export function organizationNamePhrase(question) {
  return parseQueryIntent(question).entities.find((item)=>item.type==="organization")?.text||"";
}

export function organizationPhraseFilterError(question,sql,intent=parseQueryIntent(question)) {
  return queryIntentSqlErrors(intent,sql).find((item)=>item.code==="INTENT_ENTITY_DROPPED")?.message||null;
}

export function queryIntentFilterError(question,sql,intent=parseQueryIntent(question),execution={}) {
  const filterError=queryIntentSqlErrors(intent,sql)[0];
  if(filterError)return filterError;
  if(!Array.isArray(execution.usedTables)||!execution.retrieval)return null;
  const contractValidation=queryResultContractValidation(intent,sql,execution);
  if(!contractValidation.ok)return contractValidation.errors[0];
  const facets=subjectFacetDiagnostics(execution.retrieval);
  if(!facets.length)return null;
  const used=new Set(execution.usedTables.map(normalizeTable));
  const matched=facets.some((facet)=>facetTableNames(facet).some((table)=>used.has(normalizeTable(table))));
  if(matched)return null;
  return {
    code:"INTENT_SUBJECT_DROPPED",
    stage:"intent",
    retryable:true,
    message:`SQL 使用的表没有覆盖用户要求的业务对象（${(intent?.subjects||[]).join("、")}）；请从检索分面候选表中选择并先确认结构`,
    details:{subjects:intent?.subjects||[],usedTables:execution.usedTables,expectedTables:[...new Set(facets.flatMap(facetTableNames))]},
  };
}

export function queryResultContractValidation(intent,sql,execution={}) {
  const contract=buildQueryResultContract(intent,execution.retrieval,execution.semanticContract);
  const verdict=execution.verdict||{ast:execution.ast||null,tables:execution.usedTables||[]};
  return validateQueryResultContract(contract,{sql,verdict,columnsByTable:execution.columnsByTable||{}});
}

export function missingIntentSubjectFacets(intent,retrieval,usedTables=[]) {
  const used=new Set(usedTables.map(normalizeTable));
  return subjectFacetDiagnostics(retrieval).filter((facet)=>!facetTableNames(facet).some((table)=>used.has(normalizeTable(table)))).map((facet)=>facet.key);
}

export function missingRequiredRetrievalFacets(retrieval) { return [...(retrieval?.coverageContract?.missing||[])]; }

export function intentSubjectTables(retrieval,subject=null) {
  const facets=subjectFacetDiagnostics(retrieval).filter((facet)=>!subject||facet.key===`subject:${subject}`);
  return [...new Set(facets.flatMap(facetTableNames))];
}

function subjectFacetDiagnostics(retrieval) {
  const sources=Array.isArray(retrieval)?retrieval:[retrieval];
  const byKey=new Map();
  for(const source of sources)for(const facet of source?.diagnostics?.facets||[]) {
    if(facet.kind!=="subject"||!facet.required)continue;
    const previous=byKey.get(facet.key);
    byKey.set(facet.key,previous?{
      ...previous,
      covered:previous.covered||facet.covered,
      selectedTables:[...new Set([...(previous.selectedTables||[]),...(facet.selectedTables||[])])],
      authoritativeTables:[...new Set([...(previous.authoritativeTables||[]),...(facet.authoritativeTables||[])])],
      executionTables:[...new Set([...(previous.executionTables||[]),...(facet.executionTables||[])])],
    }:facet);
  }
  return [...byKey.values()];
}
function facetTableNames(facet) {
  const authoritative=Array.isArray(facet?.authoritativeTables)?facet.authoritativeTables:[];
  if(authoritative.length)return authoritative;
  const execution=Array.isArray(facet?.executionTables)?facet.executionTables:[];
  return execution.length?execution:Array.isArray(facet?.selectedTables)?facet.selectedTables:[];
}
function normalizeTable(value) { return String(value||"").toLowerCase(); }

function identifierPattern(value) { return new RegExp(`(?:^|[^a-z0-9_])${String(value).replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}(?:$|[^a-z0-9_])`,"i"); }
