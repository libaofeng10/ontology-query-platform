import { buildIntentRetrievalFacets } from "./query-intent.mjs";

const TYPE_BOOST={metric:5,term:4,rule:2.5,join:2,table:1};
const NOISE_TABLE=/(?:^|_)(?:copy\d*|bak\d*|backup|archive|history|tmp|temp|test)(?:_|$)|_20\d{6}(?:_|$)/i;
const QUERY_STOP_TOKENS=new Set(["查询","一下","情况","帮我","看下","看看","请问"]);
export const RETRIEVAL_VERSION="retrieval-v2.2";

export function retrieveKnowledge({question,pages,tables,columnsByTable,relations,maxPages=8,maxTables=12,vector=null,conceptAliases=[],termAliases=[],intent=null}) {
  const expandedTerms=expandTermAliases(question,termAliases);
  const rawQuery=`${question||""} ${expandedTerms.join(" ")}`;
  const query=normalize(rawQuery);
  const tokens=tokenize(rawQuery);
  const signals=[...new Set([...semanticSignals(query,conceptAliases),...expandedTerms.map(normalize)])];
  const fusion=vector?.queryVector?{
    queryVector:vector.queryVector,
    pageVectors:vector.pageVectors||new Map(),
    tableVectors:vector.tableVectors||new Map(),
    vectorWeight:clampRatio(vector.vectorWeight,0.4),
    minSimilarity:clampRatio(vector.minSimilarity,0.35),
    semanticThreshold:clampRatio(vector.semanticThreshold,0.55),
  }:null;
  const lexScored=pages.map((page)=>({page,lex:scorePage(page,query,tokens),cos:fusion?cosine(fusion.queryVector,fusion.pageVectors.get(`${page.pageType}:${page.slug}`)):0}));
  const scored=fuseAndFilter(lexScored,fusion).sort((a,b)=>b.score-a.score);
  const direct=scored.slice(0,maxPages).map((entry)=>entry.page);
  const titles=new Map(pages.map((page)=>[normalize(page.title),page]));
  const expanded=[];
  for(const page of direct) for(const link of wikiLinks(`${page.content||""}\n${page.antiExamples||""}`)) { const linked=titles.get(normalize(link)); if(linked&&!direct.includes(linked)&&!expanded.includes(linked)) expanded.push(linked); }
  const selectedPages=[...direct,...expanded].slice(0,maxPages);
  const selectedNames=[];
  const pageBoundNames=new Set(selectedPages.flatMap((page)=>page.tables||[]));

  const lexTables=tables.map((table)=>({table,lex:scoreStructure(table,columnsByTable[table.tableName]||[],query,tokens,signals),cos:fusion?cosine(fusion.queryVector,fusion.tableVectors.get(table.tableName)):0}));
  const structural=fuseAndFilter(lexTables,fusion).sort((a,b)=>b.score-a.score||a.table.tableName.localeCompare(b.table.tableName));

  const facetEntries=orderedFacets(buildIntentRetrievalFacets(intent)).map((facet)=>({facet,candidates:rankFacetTables(facet,tables,columnsByTable,pageBoundNames),selected:[]}));
  const selectFacetCandidate=(facetEntry,candidate)=>{
    if(!candidate)return;
    const name=candidate.table.tableName;
    if(!selectedNames.includes(name)&&selectedNames.length>=maxTables)return;
    addUnique(selectedNames,name);
    addUnique(facetEntry.selected,name);
  };
  // First pass guarantees one candidate opportunity for every required facet;
  // the second pass spends remaining budget on redundancy. This avoids an early
  // multi-candidate facet starving later requested capabilities.
  for(const entry of facetEntries)if(entry.facet.required) {
    const coLocated=entry.facet.kind==="subject"?null:entry.candidates.find((candidate)=>selectedNames.includes(candidate.table.tableName));
    selectFacetCandidate(entry,coLocated||entry.candidates[0]);
  }
  for(const entry of facetEntries)for(const candidate of entry.candidates) {
    if(entry.selected.length>=facetQuota(entry.facet))break;
    selectFacetCandidate(entry,candidate);
  }
  const facetDiagnostics=facetEntries.map(({facet,candidates,selected})=>{
    const authoritativeTables=candidates.filter((entry)=>pageBoundNames.has(entry.table.tableName)).map((entry)=>entry.table.tableName);
    return {
      key:facet.key,
      kind:facet.kind,
      value:facet.value,
      required:Boolean(facet.required),
      covered:selected.length>0,
      selectedTables:selected,
      authoritativeTables,
      executionTables:authoritativeTables.length?authoritativeTables:facet.kind==="subject"&&!facet.allowMultiple?selected.slice(0,1):selected,
      candidates:candidates.slice(0,8).map((entry)=>({name:entry.table.tableName,score:roundScore(entry.score)})),
    };
  });

  // Knowledge-page bindings are an independent channel. They supplement the
  // per-facet candidates but cannot consume the quota reserved for a requested
  // business object, entity, time range, or explicit product.
  for(const page of selectedPages)for(const table of page.tables||[]) {
    if(selectedNames.length>=maxTables)break;
    addUnique(selectedNames,table);
  }

  // The global structural ranking remains a recall/fallback channel after each
  // intent facet has had an independent chance to contribute candidates.
  for(const entry of structural.slice(0,Math.min(8,maxTables))) {
    if(selectedNames.length>=maxTables)break;
    addUnique(selectedNames,entry.table.tableName);
  }

  const directNames=new Set(selectedNames);
  const tableByName=new Map(tables.map((table)=>[table.tableName,table]));
  const neighbors=new Map();
  for(const relation of relations) {
    let neighbor=null;
    if(directNames.has(relation.fromTable)&&!directNames.has(relation.toTable)) neighbor=relation.toTable;
    else if(directNames.has(relation.toTable)&&!directNames.has(relation.fromTable)) neighbor=relation.fromTable;
    if(!neighbor||!tableByName.has(neighbor)) continue;
    const semantic=scoreStructure(tableByName.get(neighbor),columnsByTable[neighbor]||[],query,tokens,signals);
    const score=semantic+Number(relation.confidence||0)*2;
    if(score>(neighbors.get(neighbor)||-Infinity)) neighbors.set(neighbor,score);
  }
  for(const [neighbor] of [...neighbors.entries()].sort((left,right)=>right[1]-left[1]||left[0].localeCompare(right[0]))) { if(selectedNames.length>=maxTables)break;addUnique(selectedNames,neighbor); }
  const allowed=new Set(tables.map((table)=>table.tableName));
  const tableNames=selectedNames.filter((name)=>allowed.has(name)).slice(0,maxTables);
  const requiredFacets=facetDiagnostics.filter((facet)=>facet.required);
  const coverageContract={
    required:requiredFacets.map((facet)=>facet.key),
    covered:requiredFacets.filter((facet)=>facet.covered).map((facet)=>facet.key),
    missing:requiredFacets.filter((facet)=>!facet.covered).map((facet)=>facet.key),
    missingDetails:requiredFacets.filter((facet)=>!facet.covered).map((facet)=>({key:facet.key,reason:facet.candidates.length?"retrieval_budget":"no_candidate"})),
  };
  return {
    version:RETRIEVAL_VERSION,
    pages:selectedPages,
    tableNames,
    coverage:selectedPages.some((page)=>["term","metric"].includes(page.pageType))?"semantic":tableNames.length?"structural":"none",
    retrievalMode:fusion?"hybrid":"lexical",
    diagnostics:{
      pages:scored.slice(0,maxPages).map((entry)=>({key:`${entry.page.pageType}:${entry.page.slug}`,score:roundScore(entry.score),lexical:roundScore(entry.lex),semantic:roundScore(entry.cos)})),
      tables:structural.slice(0,maxTables).map((entry)=>({name:entry.table.tableName,score:roundScore(entry.score),lexical:roundScore(entry.lex),semantic:roundScore(entry.cos)})),
      facets:facetDiagnostics,
    },
    coverageContract,
  };
}

function orderedFacets(facets) {
  const priority={subject:0,entity:1,time:2,product:3,scope:4};
  return [...facets].sort((left,right)=>(priority[left.kind]??9)-(priority[right.kind]??9)||left.key.localeCompare(right.key));
}

function facetQuota(facet) { return Number.isInteger(facet.quota)&&facet.quota>0?facet.quota:facet.kind==="subject"||facet.kind==="product"?2:1; }

function rankFacetTables(facet,tables,columnsByTable,pageBoundNames=new Set()) {
  const raw=(facet.terms||[]).join(" ");
  const query=normalize(raw);
  const tokens=tokenize(raw);
  const signals=[...new Set((facet.terms||[]).map(normalize).filter(Boolean))];
  const anchors=[...new Set((facet.anchorTerms||[]).map(normalize).filter(Boolean))];
  return tables.filter((table)=>!anchors.length||structureContains(table,columnsByTable[table.tableName]||[],anchors))
    .map((table)=>({table,score:scoreStructure(table,columnsByTable[table.tableName]||[],query,tokens,signals)+(pageBoundNames.has(table.tableName)?12:0)}))
    .filter((entry)=>entry.score>0)
    .sort((left,right)=>right.score-left.score||left.table.tableName.localeCompare(right.table.tableName));
}

function structureContains(table,columns,terms) {
  const texts=[normalize(`${table.tableName} ${table.comment||""}`),...columns.map((column)=>normalize(`${column.columnName} ${column.comment||""}`))];
  return terms.some((term)=>texts.some((text)=>text.includes(term)));
}

function fuseAndFilter(entries,fusion) {
  if(!fusion) return entries.filter((entry)=>entry.lex>0).map((entry)=>({...entry,score:entry.lex}));
  const maxLex=Math.max(...entries.map((entry)=>entry.lex),0);
  const fused=[];
  for(const entry of entries) {
    const similarity=entry.cos>=fusion.minSimilarity?entry.cos:0;
    if(entry.lex<=0&&similarity<fusion.semanticThreshold) continue;
    const lexNorm=maxLex>0?entry.lex/maxLex:0;
    const score=(1-fusion.vectorWeight)*lexNorm+fusion.vectorWeight*similarity;
    if(score<=0) continue;
    fused.push({...entry,score});
  }
  return fused;
}

function cosine(queryVector,candidate) {
  if(!Array.isArray(candidate)||candidate.length!==queryVector.length) return 0;
  let dot=0;
  for(let index=0;index<queryVector.length;index++) dot+=queryVector[index]*candidate[index];
  return Math.max(0,dot);
}
function clampRatio(value,fallback) { const num=Number(value);return Number.isFinite(num)&&num>=0&&num<=1?num:fallback; }

function scorePage(page,query,tokens) {
  const title=normalize(page.title); const aliases=(page.aliases||[]).map(normalize);
  const body=normalize(`${page.content||""} ${page.sqlContent||""} ${page.antiExamples||""} ${(page.tables||[]).join(" ")}`);
  let score=0;
  if(title&&query.includes(title)) score+=12;
  if(aliases.some((alias)=>alias&&query.includes(alias))) score+=9;
  for(const token of tokens){if(title.includes(token))score+=3;if(aliases.some((alias)=>alias.includes(token)))score+=2;if(body.includes(token))score+=.55;}
  return score*(TYPE_BOOST[page.pageType]||1)*(page.verified?1.2:.82);
}

function scoreStructure(table,columns,query,tokens,signals=[]){
  let score=0;
  const tableText=normalize(`${table.tableName} ${table.comment||""}`);
  const columnTexts=columns.map((column)=>normalize(`${column.columnName} ${column.comment||""}`));
  if(query.includes(normalize(table.tableName))) score+=8;
  for(const token of tokens) {
    if(tableText.includes(token)) score+=1.5;
    else if(columnTexts.some((text)=>text.includes(token))) score+=.35;
  }
  for(const signal of signals) {
    if(tableText.includes(signal)) score+=2;
    else if(columnTexts.some((text)=>text.includes(signal))) score+=.55;
    if(rootTableSignal(table.tableName,signal))score+=5;
  }
  if(NOISE_TABLE.test(table.tableName)) score-=4;
  return score;
}
function tokenize(value){const latin=value.match(/[a-z0-9_]{2,}/g)||[];const chinese=(value.match(/[\u4e00-\u9fff]+/g)||[]).flatMap((part)=>part.length<=2?[part]:Array.from({length:part.length-1},(_,index)=>part.slice(index,index+2))).filter((token)=>!QUERY_STOP_TOKENS.has(token));return [...new Set([...latin,...chinese])];}
function semanticSignals(query,conceptAliases=[]){
  const signals=[];
  if(/(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(query))signals.push("手机号","手机号码","mobile","phone","cell");
  if(/[\w.+-]{1,64}@[\w.-]{1,255}\.[a-z]{2,}/i.test(query))signals.push("邮箱","电子邮件","email","mail");
  if(/(?:^|\D)\d{17}[\dx](?:\D|$)/i.test(query))signals.push("身份证","证件号","id_card","identity");
  // Chinese business questions often use domain words while physical schemas use
  // English names. Expand only high-confidence concepts so exhaustive questions
  // such as “所有账号” can recall every product account root instead of whichever
  // single table happens to have the strongest Chinese comment match.
  if(/账号|账户/.test(query))signals.push("账号","账户","account","user");
  if(/产品/.test(query))signals.push("产品","product");
  if(/律所|律师事务所/.test(query))signals.push("律所","律师事务所","office","law_firm","firm");
  if(/线索|进线|clue|lead/.test(query))signals.push("线索","进线","clue","lead");
  if(/本月|上月|今天|昨日|时间|日期|create_time|created_at/.test(query))signals.push("时间","日期","time","date","create_time","created_at");
  for(const alias of conceptAliases){
    const source=String(alias?.match||"");
    if(!source)continue;
    let pattern;
    try{pattern=new RegExp(source);}catch{continue;}
    if(pattern.test(query))signals.push(...(Array.isArray(alias.terms)?alias.terms:[]).map(String));
  }
  return [...new Set(signals.map(normalize).filter(Boolean))];
}
function wikiLinks(value){return [...String(value).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match)=>match[1].trim());}
function normalize(value){return String(value||"").toLowerCase().replace(/\s+/g,"");}
function addUnique(items,value){if(value&&!items.includes(value))items.push(value);}
function rootTableSignal(tableName,signal) { const table=normalize(tableName);const value=normalize(signal);return Boolean(value&&/^[a-z0-9_]+$/.test(value)&&(table===value||table.endsWith(`_${value}`))); }
function roundScore(value){return Math.round(Number(value||0)*10_000)/10_000;}

function expandTermAliases(question,items) {
  const query=normalize(question);
  const result=[];
  for(const item of Array.isArray(items)?items:[]) {
    const aliases=Array.isArray(item?.aliases)?item.aliases:[];
    if(!aliases.some((alias)=>{const value=normalize(alias);return value&&query.includes(value);}))continue;
    for(const term of Array.isArray(item?.terms)?item.terms:[])addUnique(result,String(term));
  }
  return result;
}

export const _internal={tokenize,semanticSignals,scorePage,scoreStructure,wikiLinks,expandTermAliases};
