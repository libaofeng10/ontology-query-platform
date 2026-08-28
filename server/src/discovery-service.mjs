import { introspectSchema } from "./db-introspect.mjs";
import { probeTable } from "./db-probe.mjs";
import { generateRelationCandidates } from "./relation-candidates.mjs";
import { createRelationModelService } from "./relation-model-service.mjs";
import { detectSensitiveField } from "./sensitive-fields.mjs";
import { generateEnumMeaningQuestions } from "./enum-meaning-candidates.mjs";
import { gradeTable } from "./table-grading.mjs";
import { writeJoinPage, writeRulePage, writeTablePage } from "./ontology-writer.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export function createDiscoveryService({store,connector,wikiDir,config={},relationModel:relationModelOverride}) {
  const relationConfig={maxCandidates:600,batchSize:20,timeoutMs:60_000,minConfidence:0.55,sampleLimit:500,overlapConcurrency:4,overlapTimeoutMs:10_000,...config.relationModel};
  const profilingConfig={enabled:false,sampleLimit:1000,maxTablesPerRefresh:20,timeoutMs:10_000,...config.profiling};
  const discoveryConfig={enumMaxDistinctRatio:0.05,...config.discovery};
  const relationModel=relationModelOverride||createRelationModelService({llm:config.llm||{},batchSize:relationConfig.batchSize,timeoutMs:relationConfig.timeoutMs});

  async function discover(source,{onProgress=()=>{}}={}) {
    emit(onProgress,2,"准备数据源探查");
    if (source.isDemo) {
      const schema=demoSchema(source.id);
      const schemaDiff=saveSnapshot(source.id,schema);
      const relationKeys=schema.foreignKeys.map(relationKey);
      store.finishSchemaRefresh(source.id,schema,relationKeys);
      emit(onProgress,75,"生成演示本体页面");
      await writeOntology(source.id);
      store.markSourceDiscovered(source.id);
      emit(onProgress,100,"探查完成");
      return {...summary(source.id),schemaDiff};
    }

    emit(onProgress,5,"读取 INFORMATION_SCHEMA");
    const schema=await introspectSchema(connector,source);
    const normalized=normalizeSchema(schema);
    const schemaDiff=compareSchema(store.getLatestSchemaSnapshot(source.id)?.schema,normalized);
    const inbound=new Map();
    for(const relation of schema.foreignKeys) inbound.set(relation.toTable,(inbound.get(relation.toTable)||0)+1);
    const columnsByTable=Object.groupBy(schema.columns,(column)=>column.tableName);
    const probeResults=new Map();
    let profiledTableCount=0;

    for(const [index,rawTable] of schema.tables.entries()) {
      emit(onProgress,10+Math.round((index/Math.max(1,schema.tables.length))*60),`探针 ${rawTable.tableName}（${index+1}/${schema.tables.length}）`);
      const table={...rawTable,sourceId:source.id,inboundRelations:inbound.get(rawTable.tableName)||0,daysSinceWrite:null};
      const initialGrade=gradeTable(table);
      if(initialGrade.grade!=="C") {
        const profileThisTable=Boolean(profilingConfig.enabled)&&profiledTableCount<profilingConfig.maxTablesPerRefresh;
        const probed=await probeTable(connector,source,table,columnsByTable[table.tableName]||[],{enumMaxDistinctRatio:discoveryConfig.enumMaxDistinctRatio,profiling:{...profilingConfig,enabled:profileThisTable}});
        if(profileThisTable)profiledTableCount++;
        probeResults.set(table.tableName,probed);
        if(probed.lastWrite) table.daysSinceWrite=Math.max(0,Math.floor((Date.now()-new Date(probed.lastWrite).getTime())/86_400_000));
      }
      const graded=gradeTable(table);
      store.upsertTable({...table,grade:graded.grade,active:graded.grade==="C"?0:1});
      const probedColumns=probeResults.get(table.tableName)?.columns || columnsByTable[table.tableName] || [];
      for(const column of probedColumns) {
        const sensitive=column.isSensitive != null ? Boolean(column.isSensitive) : detectSensitiveField(column.columnName,[],column.comment).sensitive;
        store.upsertColumn({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,dataType:column.dataType,nullable:column.nullable==="YES"?1:Number(column.nullable??1),nullRate:column.nullRate??null,cardinality:column.cardinality??null,isSensitive:sensitive?1:0,comment:column.comment||null,isPrimary:Number(column.isPrimary||0),isUnique:Number(column.isUnique||0),isIndexed:Number(column.isIndexed||0)});
        if(column.profile&&!sensitive)store.upsertColumnProfile({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,...column.profile,sampledAt:new Date().toISOString()});
        for(const value of column.enums||[]) store.upsertEnum({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,...value});
      }
    }

    const relationKeys=[];
    const explicitKeys=new Set();
    for(const fk of schema.foreignKeys) {
      const relation=store.upsertRelation({sourceId:source.id,...fk,cardinality:"N:1",confidence:1,overlapRatio:1,status:"confirmed",inferenceSource:"foreign_key"});
      relationKeys.push(relationKey(relation));
      explicitKeys.add(relationKey(relation));
      explicitKeys.add(reverseRelationKey(relation));
    }
    const currentColumns=new Set(schema.columns.map((column)=>`${column.tableName}.${column.columnName}`));
    for(const relation of store.listRelations(source.id).filter((item)=>item.status==="confirmed")) {
      if(currentColumns.has(`${relation.fromTable}.${relation.fromCol}`)&&currentColumns.has(`${relation.toTable}.${relation.toCol}`)) relationKeys.push(relationKey(relation));
    }

    emit(onProgress,72,"生成结构关系候选");
    const eligibleTableNames=store.listTables(source.id).filter((table)=>table.grade!=="C").map((table)=>table.tableName);
    const profilesByColumn=new Map(store.listTables(source.id).flatMap((table)=>store.listColumns(source.id,table.tableName).map((column)=>[`${table.tableName}.${column.columnName}`,column.profile])));
    let candidates=generateRelationCandidates({schema,eligibleTableNames,maxCandidates:relationConfig.maxCandidates}).filter((candidate)=>!explicitKeys.has(candidate.key)).map((candidate)=>({...candidate,from:{...candidate.from,profile:profilingConfig.enabled?profilesByColumn.get(`${candidate.from.tableName}.${candidate.from.columnName}`)||null:null},to:{...candidate.to,profile:profilingConfig.enabled?profilesByColumn.get(`${candidate.to.tableName}.${candidate.to.columnName}`)||null:null}}));
    emit(onProgress,74,"前置验证关系候选值域");
    candidates=await mapLimit(candidates,relationConfig.overlapConcurrency,async(candidate)=>({...candidate,overlapRatio:candidate.structuralScore<0.3?null:await sampleRelationOverlap(connector,source,candidate.from,candidate.to,relationConfig.sampleLimit,{timeoutMs:relationConfig.overlapTimeoutMs})}));
    const knowledgePages=store.listKnowledge(source.id).filter((page)=>page.verified);
    const modelResult=await relationModel.judge(candidates,{knowledgePages,onProgress:({completed,total,current})=>emit(onProgress,76+Math.round((completed/Math.max(1,total))*8),current)});
    const candidatesById=new Map(candidates.map((candidate)=>[candidate.id,candidate]));
    let suggestedCount=0;
    let rejectedCount=0;

    for(const decision of modelResult.decisions) {
      const candidate=candidatesById.get(decision.candidateId);
      if(!candidate) continue;
      const isSuggested=(decision.decision==="relation"&&decision.confidence>=relationConfig.minConfidence)||(decision.decision==="uncertain"&&decision.confidence>=Math.max(0.7,relationConfig.minConfidence));
      const overlapRatio=candidate.overlapRatio??null;
      const confidence=clamp(decision.confidence*0.60+candidate.structuralScore*0.25+(overlapRatio??0)*0.15);
      const status=isSuggested?"review":"rejected";
      const relation=store.upsertRelation({
        sourceId:source.id,
        fromTable:candidate.from.tableName,fromCol:candidate.from.columnName,
        toTable:candidate.to.tableName,toCol:candidate.to.columnName,
        cardinality:normalizeCardinality(decision.cardinality,candidate),confidence,overlapRatio,status,
        inferenceSource:"model",modelDecision:decision.decision,modelConfidence:decision.confidence,
        modelReason:decision.reason,modelName:modelResult.modelName,
        structuralScore:candidate.structuralScore,structuralReason:candidate.structuralReasons.join("；"),
      });
      relationKeys.push(relationKey(relation));
      if(relation.status==="confirmed") continue;
      if(status==="review") {
        suggestedCount++;
        store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"table",tableName:relation.fromTable,columnName:relation.fromCol,relationId:relation.id,question:`${relation.fromTable}.${relation.fromCol} 是否关联 ${relation.toTable}.${relation.toCol}？`,evidence:modelEvidence(relation),options:["确认该关联","保留候选","不允许关联"]});
      } else rejectedCount++;
    }

    store.saveRelationAnalysis({sourceId:source.id,modelStatus:modelResult.status,modelName:modelResult.modelName,candidateCount:candidates.length,judgedCount:modelResult.decisions.length,suggestedCount,rejectedCount,error:modelResult.error||null});
    if(modelResult.status!=="completed") {
      for(const relation of store.listRelations(source.id).filter((item)=>item.status==="review")) {
        if(currentColumns.has(`${relation.fromTable}.${relation.fromCol}`)&&currentColumns.has(`${relation.toTable}.${relation.toCol}`)) relationKeys.push(relationKey(relation));
      }
    }
    for(const relation of store.listRelations(source.id,false,true).filter((item)=>item.inferenceSource==="document"&&["review","confirmed","denied"].includes(item.status))) {
      if(currentColumns.has(`${relation.fromTable}.${relation.fromCol}`)&&currentColumns.has(`${relation.toTable}.${relation.toCol}`))relationKeys.push(relationKey(relation));
    }
    store.finishSchemaRefresh(source.id,normalized,[...new Set(relationKeys)]);
    store.closeStaleRelationQuestions(source.id);
    emit(onProgress,88,"从列注释生成枚举含义待确认项");
    generateEnumMeaningQuestions(store,source.id);
    const snapshot=saveSnapshot(source.id,normalized,schemaDiff);
    emit(onProgress,90,"写入可审阅本体页面");
    await writeOntology(source.id);
    store.markSourceDiscovered(source.id);
    emit(onProgress,100,"探查完成");
    return {...summary(source.id),schemaDiff:{...schemaDiff,currentVersion:snapshot.currentVersion}};
  }

  async function writeOntology(sourceId) {
    const sourceWikiDir=join(wikiDir,`source-${Number(sourceId)}`);
    const relations=store.listRelations(sourceId);
    for(const table of store.listTables(sourceId)) {
      if(table.grade==="C") continue;
      await writeTablePage(sourceWikiDir,table,store.listColumns(sourceId,table.tableName),store.listEnums(sourceId,table.tableName),relations.filter((r)=>r.fromTable===table.tableName||r.toTable===table.tableName));
    }
    for(const relation of relations.filter((r)=>["accepted","confirmed"].includes(r.status))) await writeJoinPage(sourceWikiDir,relation);
    for(const rule of store.listRules(sourceId)) await writeRulePage(sourceWikiDir,rule);
  }

  function summary(sourceId) {
    const tables=store.listTables(sourceId);
    const relations=store.listRelations(sourceId);
    return {sourceId,tables,totalTables:tables.length,grades:Object.fromEntries(["A","B","C"].map((grade)=>[grade,tables.filter((table)=>table.grade===grade).length])),sensitiveFields:tables.reduce((sum,table)=>sum+store.listColumns(sourceId,table.tableName).filter((column)=>column.isSensitive).length,0),relations:relations.length,pendingQuestions:store.listQuestions(sourceId).length,relationDiscovery:store.relationStats(sourceId)};
  }

  function demoSchema(sourceId) { const tables=store.listTables(sourceId); return normalizeSchema({tables,columns:tables.flatMap((table)=>store.listColumns(sourceId,table.tableName)),foreignKeys:store.listRelations(sourceId).map((item)=>({...item}))}); }
  function saveSnapshot(sourceId,schema,knownDiff=null) { const previous=store.getLatestSchemaSnapshot(sourceId); const checksum=checksumSchema(schema); const diff=knownDiff||compareSchema(previous?.schema,schema); if(!previous||previous.checksum!==checksum) { const saved=store.addSchemaSnapshot(sourceId,checksum,schema); return {...diff,previousVersion:previous?.version??null,currentVersion:saved.version}; } return {...diff,previousVersion:previous?.version??null,currentVersion:previous.version}; }
  return {discover,summary,writeOntology};
}

function emit(callback,progress,currentStep) { callback({progress,total:100,currentStep}); }
function relationKey(item) { return `${item.fromTable}.${item.fromCol}>${item.toTable}.${item.toCol}`; }
function reverseRelationKey(item) { return `${item.toTable}.${item.toCol}>${item.fromTable}.${item.fromCol}`; }
function normalizeSchema(schema) {
  return {
    tables:[...(schema.tables||[])].map(({tableName,rowEstimate=0,comment=null})=>({tableName,rowEstimate,comment})).sort((a,b)=>a.tableName.localeCompare(b.tableName)),
    columns:[...(schema.columns||[])].map(({tableName,columnName,dataType,nullable=null,isPrimary=0,isUnique=0,isIndexed=0,comment=null})=>({tableName,columnName,dataType,nullable,isPrimary:Number(isPrimary||0),isUnique:Number(isUnique||0),isIndexed:Number(isIndexed||0),comment})).sort((a,b)=>`${a.tableName}.${a.columnName}`.localeCompare(`${b.tableName}.${b.columnName}`)),
    foreignKeys:[...(schema.foreignKeys||[])].map(({fromTable,fromCol,toTable,toCol})=>({fromTable,fromCol,toTable,toCol})).sort((a,b)=>relationKey(a).localeCompare(relationKey(b))),
  };
}
function checksumSchema(schema) { return createHash("sha256").update(JSON.stringify(schema)).digest("hex"); }
function compareSchema(previous,current) {
  if(!previous) return {changed:true,previousVersion:null,addedTables:current.tables.map((item)=>item.tableName),removedTables:[],changedTables:[],addedColumns:current.columns.map((item)=>`${item.tableName}.${item.columnName}`),removedColumns:[]};
  const oldTables=new Map(previous.tables.map((item)=>[item.tableName,JSON.stringify(item)]));
  const newTables=new Map(current.tables.map((item)=>[item.tableName,JSON.stringify(item)]));
  const oldColumns=new Map(previous.columns.map((item)=>[`${item.tableName}.${item.columnName}`,JSON.stringify(item)]));
  const newColumns=new Map(current.columns.map((item)=>[`${item.tableName}.${item.columnName}`,JSON.stringify(item)]));
  const addedTables=[...newTables.keys()].filter((key)=>!oldTables.has(key));
  const removedTables=[...oldTables.keys()].filter((key)=>!newTables.has(key));
  const addedColumns=[...newColumns.keys()].filter((key)=>!oldColumns.has(key));
  const removedColumns=[...oldColumns.keys()].filter((key)=>!newColumns.has(key));
  const changedTables=[...newTables.keys()].filter((key)=>oldTables.has(key)&&oldTables.get(key)!==newTables.get(key));
  for(const key of newColumns.keys()) if(oldColumns.has(key)&&oldColumns.get(key)!==newColumns.get(key)) { const table=key.split(".")[0]; if(!changedTables.includes(table)) changedTables.push(table); }
  const changed=Boolean(addedTables.length||removedTables.length||changedTables.length||addedColumns.length||removedColumns.length||checksumSchema(previous)!==checksumSchema(current));
  return {changed,previousVersion:null,addedTables,removedTables,changedTables,addedColumns,removedColumns};
}

export async function sampleRelationOverlap(connector,source,left,right,limit,{timeoutMs=10_000}={}) {
  const safeLimit=Math.max(1,Math.min(2000,Number(limit)||500));
  const controller=new AbortController();let timer;const work=(async()=>{
    const leftColumn=quoteIdentifier(left.columnName);const rightColumn=quoteIdentifier(right.columnName);
    const [leftRows]=await connector.query(source,`SELECT DISTINCT ${leftColumn} AS value FROM ${quoteIdentifier(left.tableName)} WHERE ${leftColumn} IS NOT NULL ORDER BY ${leftColumn} LIMIT ${safeLimit}`,[],controller.signal);
    const [rightRows]=await connector.query(source,`SELECT DISTINCT ${rightColumn} AS value FROM ${quoteIdentifier(right.tableName)} WHERE ${rightColumn} IS NOT NULL ORDER BY ${rightColumn} LIMIT ${safeLimit}`,[],controller.signal);
    if(!leftRows.length||!rightRows.length) return 0;
    const rightValues=new Set(rightRows.map((row)=>String(row.value)));
    return leftRows.filter((row)=>rightValues.has(String(row.value))).length/leftRows.length;
  })().catch(()=>null);
  const deadline=new Promise((resolve)=>{timer=setTimeout(()=>{controller.abort();resolve(null);},Math.max(100,Number(timeoutMs)||10_000));});
  try{return await Promise.race([work,deadline]);}finally{clearTimeout(timer);}
}

function normalizeCardinality(cardinality,candidate) {
  if(cardinality&&cardinality!=="unknown") return cardinality;
  if(candidate.to.isPrimary||candidate.to.isUnique) return candidate.from.isUnique?"1:1":"N:1";
  return "N:N";
}
function modelEvidence(relation) { const overlap=relation.overlapRatio==null?"未取得本地样本":`前置本地样本值域重叠 ${(relation.overlapRatio*100).toFixed(2)}%`;return `模型 ${relation.modelName||"未命名"} 判断：${relation.modelReason||"无理由"}；模型置信度 ${((relation.modelConfidence||0)*100).toFixed(1)}%；结构评分 ${((relation.structuralScore||0)*100).toFixed(1)}%；${overlap}；脱敏列画像与已核验知识摘要（如有）已作为判断证据。该建议未经人工确认，不会进入问数 JOIN 白名单。`; }
function clamp(value) { return Math.max(0,Math.min(1,value)); }

function quoteIdentifier(value) { const identifier=String(value??"");if(!identifier||identifier.length>64||/[\0\r\n]/.test(identifier))throw new Error(`无效的数据库标识符：${identifier}`);return `\`${identifier.replaceAll("`","``")}\``; }
async function mapLimit(items,limit,mapper) { const result=new Array(items.length);let next=0;const workers=Array.from({length:Math.min(Math.max(1,Number(limit)||1),items.length)},async()=>{while(true){const index=next++;if(index>=items.length)return;result[index]=await mapper(items[index],index);}});await Promise.all(workers);return result; }

export const _internal={normalizeSchema,compareSchema,sampleOverlap:sampleRelationOverlap,normalizeCardinality};
