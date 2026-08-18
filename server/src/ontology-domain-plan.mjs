import { createHash } from "node:crypto";
import { callLlmJson, isLlmConfigured } from "./llm-client.mjs";
import { ontologyCandidateGeneratorInternal } from "./ontology-candidate-generator.mjs";

const GENERIC_PREFIX_TOKENS=new Set(["t","tbl","table","sys","biz","data","info","base","tb","db","app"]);

function httpError(status,message,detail){const error=new Error(message);error.status=status;if(detail)error.detail=detail;return error;}

export function prefixTokens(tableName){return String(tableName||"").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);}

export function prefixKeyOf(tableName){
  const tokens=prefixTokens(tableName);
  const meaningful=tokens.filter((token)=>!GENERIC_PREFIX_TOKENS.has(token));
  // 双段前缀（如 alpha_crm）比单段（alpha）区分度更好；单段表退化为一段
  if(meaningful.length>=2)return `${meaningful[0]}_${meaningful[1]}`;
  return meaningful[0]||tokens[0]||"misc";
}

function shortPrefixKeyOf(tableName){
  const tokens=prefixTokens(tableName);
  const meaningful=tokens.filter((token)=>!GENERIC_PREFIX_TOKENS.has(token));
  return meaningful[0]||tokens[0]||"misc";
}

function majorityPrefix(tableNames,keyOf=prefixKeyOf){
  const counts=new Map();
  for(const name of tableNames){const key=keyOf(name);counts.set(key,(counts.get(key)||0)+1);}
  let best=null,bestCount=0;
  for(const [key,count] of [...counts.entries()].sort(([a],[b])=>a.localeCompare(b)))if(count>bestCount){best=key;bestCount=count;}
  return best;
}

export function mergeSingletons(components){
  const multi=components.filter((component)=>component.length>1).map((component)=>({tables:[...component],prefix:majorityPrefix(component),shortPrefix:majorityPrefix(component,shortPrefixKeyOf),signal:"relations"}));
  const singles=components.filter((component)=>component.length===1).map(([name])=>name);
  const leftovers=[];
  for(const name of singles){
    const host=multi.find((cluster)=>cluster.prefix===prefixKeyOf(name))||multi.find((cluster)=>cluster.shortPrefix===shortPrefixKeyOf(name));
    if(host){host.tables.push(name);host.signal="mixed";}
    else leftovers.push(name);
  }
  // 剩余孤表先按双段前缀分组；仍落单的组再按单段前缀合并
  const byPrefix=new Map();
  for(const name of leftovers){const key=prefixKeyOf(name);if(!byPrefix.has(key))byPrefix.set(key,[]);byPrefix.get(key).push(name);}
  const grouped=new Map();
  for(const [key,names] of [...byPrefix.entries()].sort(([a],[b])=>a.localeCompare(b))){
    const finalKey=names.length>1?key:shortPrefixKeyOf(names[0]);
    if(!grouped.has(finalKey))grouped.set(finalKey,[]);
    grouped.get(finalKey).push(...names);
  }
  const prefixClusters=[...grouped.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([prefix,tables])=>({tables:[...tables].sort(),prefix,signal:"prefix"}));
  for(const cluster of multi)cluster.tables.sort();
  return [...multi,...prefixClusters].map((cluster)=>({tables:cluster.tables,prefix:cluster.prefix,signal:cluster.signal}));
}

export function splitOversized(cluster,maxTables){
  if(cluster.tables.length<=maxTables)return [cluster];
  // 超大分量先按前缀拆成独立逻辑子域（各自命名），落单前缀合并进“其他”子域
  const byPrefix=new Map();
  for(const name of cluster.tables){const key=prefixKeyOf(name);if(!byPrefix.has(key))byPrefix.set(key,[]);byPrefix.get(key).push(name);}
  const subdomains=[];const strays=[];
  for(const [key,names] of [...byPrefix.entries()].sort(([a],[b])=>a.localeCompare(b))){
    if(names.length>1)subdomains.push({prefix:key,tables:[...names].sort()});
    else strays.push(names[0]);
  }
  if(strays.length){
    const byShort=new Map();
    for(const name of strays){const key=shortPrefixKeyOf(name);if(!byShort.has(key))byShort.set(key,[]);byShort.get(key).push(name);}
    for(const [key,names] of [...byShort.entries()].sort(([a],[b])=>a.localeCompare(b))){
      const host=subdomains.find((subdomain)=>subdomain.prefix===key||subdomain.prefix.startsWith(`${key}_`));
      if(host){host.tables=[...host.tables,...names].sort();}
      else subdomains.push({prefix:key,tables:[...names].sort()});
    }
  }
  // 若前缀无法区分（整个分量同前缀），退化为按序分批
  const usable=subdomains.length>1?subdomains:[{prefix:cluster.prefix,tables:[...cluster.tables].sort()}];
  return usable.flatMap((subdomain)=>{
    const chunks=[];
    for(let index=0;index<subdomain.tables.length;index+=maxTables)chunks.push(subdomain.tables.slice(index,index+maxTables));
    return chunks.map((tables,index)=>({...cluster,prefix:subdomain.prefix,tables,batchIndex:index+1,batchCount:chunks.length}));
  });
}

export function clusterTablesIntoDomains({tables,relations,maxTables=20}={}){
  const names=[...new Set((tables||[]).map((table)=>String(table.tableName||"").trim()).filter(Boolean))].sort();
  const nameSet=new Set(names);
  const usable=(relations||[]).filter((relation)=>nameSet.has(relation.fromTable)&&nameSet.has(relation.toTable));
  const components=ontologyCandidateGeneratorInternal.relationComponents(names,usable);
  const merged=mergeSingletons(components);
  const relationCountOf=(clusterTables)=>{const set=new Set(clusterTables);return usable.filter((relation)=>set.has(relation.fromTable)&&set.has(relation.toTable)).length;};
  const split=merged.flatMap((cluster)=>splitOversized(cluster,maxTables));
  const ordered=split.map((cluster)=>({...cluster,relationCount:relationCountOf(cluster.tables)}))
    .sort((left,right)=>right.tables.length-left.tables.length||left.tables[0].localeCompare(right.tables[0]));
  return ordered.map((cluster,index)=>({
    id:`domain-${index+1}`,domainKey:cluster.prefix||"misc",signal:cluster.signal,
    tableNames:cluster.tables,tableCount:cluster.tables.length,relationCount:cluster.relationCount,
    batchIndex:cluster.batchIndex||1,batchCount:cluster.batchCount||1,
  }));
}

export function fallbackDomainName(cluster){
  const prefix=String(cluster.domainKey||"misc").replace(/_/g," ").toUpperCase();
  const name=`${prefix} 业务域`;
  const description=cluster.signal==="prefix"
    ?`包含 ${cluster.tableCount} 张 ${cluster.domainKey}_* 前缀关联表。`
    :`基于 ${cluster.relationCount} 条已确认 JOIN 关系聚合的 ${cluster.tableCount} 张表。`;
  return {name,description};
}

export function domainNamingMessages({clusters}){
  const payload={clusters:clusters.map((cluster)=>({
    id:cluster.id,
    tables:cluster.tables.slice(0,8).map((table)=>({tableName:table.tableName,comment:table.comment?String(table.comment).slice(0,40):null})),
    ...(cluster.tables.length>8?{more:cluster.tables.length-8}:{}),
  }))};
  return [
    {role:"system",content:"你是数据仓库领域建模专家。只输出严格 JSON，不要输出其他内容。"},
    {role:"user",content:`以下是同一数据库中按物理关联与命名自动聚类得到的表分组。请为每个分组起一个简洁的中文业务域名称（2-8 个字，以“域”结尾）和一句话业务说明。\n${JSON.stringify(payload)}\n输出格式：{"domains":[{"id":"domain-1","name":"...","description":"..."}]}`},
  ];
}

export function createOntologyDomainPlanner({store,config,fetchImpl=globalThis.fetch}={}){
  function eligibleInputs(sourceId){
    const tables=store.listTables(sourceId).filter((table)=>table.active!==0&&["A","B"].includes(table.grade));
    const tableNames=new Set(tables.map((table)=>table.tableName));
    const relations=store.listRelations(sourceId,true).filter((relation)=>tableNames.has(relation.fromTable)&&tableNames.has(relation.toTable));
    return {tables,relations};
  }
  // 分域只依赖表清单（名称/等级/注释）与已确认关系；字段变化不影响划分，不纳入校验和
  function domainChecksum({tables,relations}){
    const normalized={
      tables:tables.map((table)=>({tableName:table.tableName,grade:table.grade,comment:table.comment??null})).sort((a,b)=>a.tableName.localeCompare(b.tableName)),
      relations:relations.map((relation)=>({fromTable:relation.fromTable,fromCol:relation.fromCol,toTable:relation.toTable,toCol:relation.toCol})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))),
    };
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }

  async function plan(sourceId,{refresh=false,actor=null}={}){
    const source=store.getSource(Number(sourceId));
    if(!source)throw httpError(404,"数据源不存在");
    const inputs=eligibleInputs(source.id);
    const checksum=inputs.tables.length?domainChecksum(inputs):null;
    if(!refresh){
      const saved=store.getOntologyDomainPlan?.(source.id);
      if(saved?.plan)return {...saved.plan,stored:true,storedAt:saved.createdAt,stale:saved.catalogChecksum!==checksum};
      return {sourceId:source.id,stored:false,domains:null};
    }
    if(!inputs.tables.length)throw httpError(400,"当前数据源没有有效 A/B 级表，请先完成数据探查与分级");
    const result=await compute(source.id,inputs);
    store.upsertOntologyDomainPlan?.({sourceId:source.id,planJson:JSON.stringify(result),catalogChecksum:checksum,createdBy:actor});
    return {...result,stored:true,storedAt:result.generatedAt,stale:false};
  }

  async function compute(sourceId,{tables,relations}){
    const tableByName=new Map(tables.map((table)=>[table.tableName,table]));
    const maxTables=boundedInteger(config?.ontologyAi?.maxTables,1,20,20);
    const clusters=clusterTablesIntoDomains({tables,relations,maxTables});
    const withTables=clusters.map((cluster)=>({...cluster,tables:cluster.tableNames.map((name)=>{const table=tableByName.get(name);return {tableName:name,comment:table?.comment||null,grade:table?.grade||null};})}));
    const naming=await nameClusters(withTables);
    return {
      sourceId,generatedAt:new Date().toISOString(),
      namingSource:naming.source,llmError:naming.error,
      eligibleTableCount:tables.length,confirmedRelationCount:relations.length,maxTables,
      domains:withTables.map((cluster)=>{
        const named=naming.byId.get(cluster.id)||fallbackDomainName(cluster);
        return {
          id:cluster.id,domainKey:cluster.domainKey,name:named.name,description:named.description,
          namingSource:naming.byId.has(cluster.id)?"llm":"fallback",
          tableCount:cluster.tableCount,batchIndex:cluster.batchIndex,batchCount:cluster.batchCount,
          tables:cluster.tables,relationCount:cluster.relationCount,signal:cluster.signal,
        };
      }),
    };
  }

  async function nameClusters(clusters){
    const llm=config?.llm;
    if(!isLlmConfigured(llm))return {source:"fallback",error:null,byId:new Map()};
    // 只给每个逻辑域的第一批命名，同 domainKey 的后续批复用名称；小域（<3 张表）用前缀名已可读，控制单次调用规模
    const firstBatches=clusters.filter((cluster)=>cluster.batchIndex===1&&cluster.tableCount>=3).slice(0,48);
    try {
      const extraBody=/dashscope|\.maas\.aliyuncs\.com/i.test(String(llm?.baseUrl||""))?{enable_thinking:false}:{};
      const timeoutMs=Math.min(60_000,Number(config?.ontologyAi?.timeoutMs)||60_000);
      const result=await callLlmJson(llm,domainNamingMessages({clusters:firstBatches}),{timeoutMs,fetchImpl,extraBody});
      const byId=new Map();
      const items=Array.isArray(result?.domains)?result.domains:[];
      const namedByFirstId=new Map();
      for(const item of items){
        const id=String(item?.id||"");const name=String(item?.name||"").trim();const description=String(item?.description||"").trim();
        if(id&&name)namedByFirstId.set(id,{name,description:description||"（模型未提供说明）"});
      }
      for(const cluster of clusters){
        const firstOfDomain=firstBatches.find((item)=>item.domainKey===cluster.domainKey&&item.signal===cluster.signal);
        const named=namedByFirstId.get(cluster.id)||(firstOfDomain?namedByFirstId.get(firstOfDomain.id):null);
        if(named)byId.set(cluster.id,named);
      }
      return {source:byId.size?"llm":"fallback",error:null,byId};
    } catch(cause){
      return {source:"fallback",error:cause instanceof Error?cause.message:String(cause),byId:new Map()};
    }
  }

  return {plan};
}

function boundedInteger(value,min,max,fallback){const parsed=Number(value);if(!Number.isInteger(parsed))return fallback;return Math.max(min,Math.min(max,parsed));}

export const ontologyDomainPlanInternal={prefixTokens,prefixKeyOf,mergeSingletons,splitOversized};
