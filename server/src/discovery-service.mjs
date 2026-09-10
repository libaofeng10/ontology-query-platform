import { describeRelationEvidence } from "./relation-data-evidence.mjs";
import { introspectSchema } from "./db-introspect.mjs";
import { probeTable } from "./db-probe.mjs";
import { assertRelationCheckpoint } from "./relation-checkpoint.mjs";
import { analyzeRelationCandidates } from "./relation-discovery-analysis.mjs";
import { createRelationModelService } from "./relation-model-service.mjs";
import { generateEnumMeaningQuestions } from "./enum-meaning-candidates.mjs";
import { gradeTable } from "./table-grading.mjs";
import { removeTablePage, writeJoinPage, writeRulePage, writeTablePage } from "./ontology-writer.mjs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { COLUMN_PROFILE_VERSION } from "./column-profile.mjs";
import { sampleRelationOverlap } from "./relation-data-evidence.mjs";
import { relationKey as physicalRelationKey, relationPairs, reverseRelation, relationColumnsPresent, formatRelation } from "./physical-relation.mjs";
export { sampleRelationOverlap } from "./relation-data-evidence.mjs";

export function createDiscoveryService({store,connector,wikiDir,config={},relationModel:relationModelOverride}) {
  const relationConfig={maxCandidates:600,batchSize:20,timeoutMs:60_000,minConfidence:0.55,sampleLimit:500,overlapConcurrency:4,overlapTimeoutMs:10_000,...config.relationModel};
  const discoveryConfig={enumMaxDistinctRatio:0.05,labelDictionaryMaxRows:undefined,...config.discovery};
  const relationModel=relationModelOverride||createRelationModelService({llm:config.llm||{},batchSize:relationConfig.batchSize,timeoutMs:relationConfig.timeoutMs});

  async function discover(source,{onProgress=()=>{},tableNames=null,resumeRelations=false,runId=null}={}) {
    const previousCheckpoint=store.getRelationCheckpoint?.(source.id);
    const checkpoint=resumeRelations||(runId&&previousCheckpoint?.runId===runId)?previousCheckpoint:null;
    if(resumeRelations&&!checkpoint)throw new Error("没有可继续的关系检查点，请重新探查");
    const profilingConfig={enabled:false,sampleLimit:1000,maxTablesPerRefresh:20,timeoutMs:10_000,...config.profiling};
    const selected=tableNames?new Set(tableNames):null;
    const excluded=store.excludedTableNames(source.id);
    const included=(name)=>!excluded.has(name)&&(!selected||selected.has(name));
    const restrict=(schema)=>{
      schema.tables=schema.tables.filter((table)=>included(table.tableName));
      // COLUMNS also contains views; only admitted base tables define this scope.
      const admittedTables=new Set(schema.tables.map(table=>table.tableName));
      schema.columns=schema.columns.filter((column)=>admittedTables.has(column.tableName));
      schema.foreignKeys=schema.foreignKeys.filter((relation)=>admittedTables.has(relation.fromTable)&&admittedTables.has(relation.toTable));
      return schema;
    };
    emit(onProgress,2,"准备数据源探查");
    emit(onProgress,5,"读取 INFORMATION_SCHEMA");
    const schema=restrict(await introspectSchema(connector,source));
    const analysisInput=()=>{
      const catalog=store.listTables(source.id).filter(table=>included(table.tableName));
      const profiles=new Map(catalog.flatMap(table=>store.listColumns(source.id,table.tableName).map(column=>[`${table.tableName}.${column.columnName}`,column.profile])));
      const explicitKeys=new Set();
      for(const relation of schema.foreignKeys){
        explicitKeys.add(relationKey(relation));explicitKeys.add(reverseRelationKey(relation));
        for(const pair of relationPairs(relation)){const part={fromTable:relation.fromTable,toTable:relation.toTable,...pair};explicitKeys.add(relationKey(part));explicitKeys.add(reverseRelationKey(part));}
      }
      return {schema:{...schema,columns:schema.columns.map(column=>({...column,profile:profilingConfig.enabled?profiles.get(`${column.tableName}.${column.columnName}`)||null:null}))},
        eligibleTableNames:catalog.filter(table=>table.grade!=="C").map(table=>table.tableName),
        model:relationModel,connector,source,config:relationConfig,knowledgePages:store.listKnowledge(source.id).filter(page=>page.verified),explicitKeys,
        context:{profiling:profilingConfig,discovery:discoveryConfig,grades:catalog.map(table=>[table.tableName,table.gradeOverride]).sort()}};
    };
    if(checkpoint)assertRelationCheckpoint(checkpoint,analysisInput());
    // Scope decision happens before anything else sees the schema: excluded tables are cut
    // from tables, columns AND foreign keys here, so the probe, the relation candidates, the
    // snapshot and the question generators all operate on a world where they don't exist.
    if(excluded.size)store.purgeExcludedTables(source.id);
    const normalized=normalizeSchema(schema);
    const schemaDiff=compareSchema(store.getLatestSchemaSnapshot(source.id)?.schema,normalized);
    const inbound=new Map();
    for(const relation of schema.foreignKeys) inbound.set(relation.toTable,(inbound.get(relation.toTable)||0)+1);
    const columnsByTable=Object.groupBy(schema.columns,(column)=>column.tableName);
    const probeResults=new Map();
    let profiledTableCount=0;
    // information_schema knows nothing about human grading decisions. Without carrying
    // grade_override back in, gradeTable() re-derives every grade from naming rules and
    // the manual C never reaches the "skip the probe" gate below — the table keeps getting
    // probed, keeps registering enum values, and keeps seeding disambiguation questions.
    const gradeOverrideByTable=new Map(store.listTables(source.id).map((table)=>[table.tableName,table.gradeOverride]));

    for(const [index,rawTable] of (checkpoint?[]:schema.tables).entries()) {
      emit(onProgress,10+Math.round((index/Math.max(1,schema.tables.length))*60),`探针 ${rawTable.tableName}（${index+1}/${schema.tables.length}）`);
      const table={...rawTable,sourceId:source.id,gradeOverride:gradeOverrideByTable.get(rawTable.tableName)??null,inboundRelations:inbound.get(rawTable.tableName)||0,daysSinceWrite:null};
      const initialGrade=gradeTable(table);
      if(initialGrade.grade!=="C") {
        const profileThisTable=Boolean(profilingConfig.enabled)&&profiledTableCount<profilingConfig.maxTablesPerRefresh;
        const probed=await probeTable(connector,source,table,columnsByTable[table.tableName]||[],{enumMaxDistinctRatio:discoveryConfig.enumMaxDistinctRatio,labelDictionaryMaxRows:discoveryConfig.labelDictionaryMaxRows,profiling:{...profilingConfig,enabled:profileThisTable}});
        if(profileThisTable)profiledTableCount++;
        probeResults.set(table.tableName,probed);
        if(probed.lastWrite) table.daysSinceWrite=Math.max(0,Math.floor((Date.now()-new Date(probed.lastWrite).getTime())/86_400_000));
      }
      const graded=gradeTable(table);
      store.upsertTable({...table,grade:graded.grade,active:graded.grade==="C"?0:1});
      const probedColumns=probeResults.get(table.tableName)?.columns || columnsByTable[table.tableName] || [];
      for(const column of probedColumns) {
        // 2026-09-04 应用户要求移除敏感列逻辑：发现阶段不再自动推断 isSensitive。
        store.upsertColumn({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,dataType:column.dataType,nullable:column.nullable==="YES"?1:Number(column.nullable??1),nullRate:column.nullRate??null,cardinality:column.cardinality??null,isSensitive:0,comment:column.comment||null,isPrimary:Number(column.isPrimary||0),isUnique:Number(column.isUnique||0),isIndexed:Number(column.isIndexed||0),keyConstraints:column.keyConstraints||[]});
        if(column.profile)store.upsertColumnProfile({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,...column.profile,sampledAt:new Date().toISOString()});
        else if(profilingConfig.enabled)store.upsertColumnProfile({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,profile:{status:"unavailable",reason:column.profileUnavailableReason||"not_sampled",sampleValues:[]},sampleSize:0,profileVersion:COLUMN_PROFILE_VERSION,sampledAt:new Date().toISOString()});
        for(const value of column.enums||[]) store.upsertEnum({sourceId:source.id,tableName:table.tableName,columnName:column.columnName,...value});
      }
    }

    const relationKeys=[];
    for(const fk of schema.foreignKeys) {
      const relation=store.upsertRelation({sourceId:source.id,...fk,cardinality:fk.cardinality||"N:1",confidence:1,overlapRatio:null,status:"confirmed",inferenceSource:"foreign_key"});
      relationKeys.push(relationKey(relation));
    }
    const currentColumns=new Set(schema.columns.map((column)=>`${column.tableName}.${column.columnName}`));
    for(const relation of store.listRelations(source.id,false,true).filter((item)=>["accepted","confirmed","denied"].includes(item.status))) {
      if(relation.inferenceSource!=="foreign_key"&&relationColumnsPresent(relation,currentColumns)) relationKeys.push(relationKey(relation));
    }

    emit(onProgress,72,"生成结构关系候选");
    const {candidates,modelResult,diagnostics}=await analyzeRelationCandidates({...analysisInput(),checkpoint,runId,
      onCheckpoint:state=>store.saveRelationCheckpoint(source.id,state),
      onProgress:({completed,total,current})=>emit(onProgress,76+Math.round((completed/Math.max(1,total))*8),current)});
    const candidatesById=new Map(candidates.map((candidate)=>[candidate.id,candidate]));
    let suggestedCount=0;
    let rejectedCount=0;

    for(const decision of modelResult.decisions) {
      const candidate=candidatesById.get(decision.candidateId);
      if(!candidate) continue;
      // Uncertainty is a review item, never evidence that a relationship does not exist.
      const isSuggested=decision.decision!=="none"||decision.confidence<relationConfig.minConfidence;
      const overlapRatio=candidate.overlapRatio??null;
      const confidence=clamp(decision.confidence*0.60+candidate.structuralScore*0.25+(overlapRatio??0)*0.15);
      const status=isSuggested?"review":"rejected";
      const relation=store.upsertRelation({
        sourceId:source.id,
        fromTable:candidate.from.tableName,fromCol:candidate.from.columnName,
        toTable:candidate.to.tableName,toCol:candidate.to.columnName,
        columnPairs:candidate.columnPairs,
        cardinality:normalizeCardinality(decision.cardinality,candidate),confidence,overlapRatio,dataEvidence:candidate.dataEvidence,status,
        inferenceSource:"model",modelDecision:decision.decision,modelConfidence:decision.confidence,
        modelReason:decision.reason,modelName:modelResult.modelName,
        structuralScore:candidate.structuralScore,structuralReason:candidate.structuralReasons.join("；"),
      });
      relationKeys.push(relationKey(relation));
      if(["accepted","confirmed","denied"].includes(relation.status)) continue;
      if(relation.status==="review") {
        suggestedCount++;
        store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"table",tableName:relation.fromTable,columnName:relation.fromCol,relationId:relation.id,question:`是否确认关联 ${formatRelation(relation)}？`,evidence:modelEvidence(relation),options:["确认该关联","保留候选","不允许关联"]});
      } else rejectedCount++;
    }

    const judgedIds=new Set(modelResult.decisions.map(item=>item.candidateId));
    for(const candidate of candidates.filter(item=>!judgedIds.has(item.id))){
      const prior=store.getRelationByKey(source.id,candidate.from.tableName,candidate.from.columnName,candidate.to.tableName,candidate.to.columnName,candidate.columnPairs);
      const item={sourceId:source.id,fromTable:candidate.from.tableName,fromCol:candidate.from.columnName,toTable:candidate.to.tableName,toCol:candidate.to.columnName,columnPairs:candidate.columnPairs,status:"review",inferenceSource:"model",modelDecision:"uncertain",modelReason:"模型尚未完成有效判断，请重试或补充业务依据",structuralScore:candidate.structuralScore,overlapRatio:candidate.overlapRatio,dataEvidence:candidate.dataEvidence};
      const relation=store.getReviewedRelation(source.id,item)||(prior?.inferenceSource==="document"?prior:store.upsertRelation(item));
      relationKeys.push(relationKey(relation));
      if(relation.status==="review")store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"table",tableName:relation.fromTable,columnName:relation.fromCol,relationId:relation.id,question:`是否确认关联 ${formatRelation(relation)}？`,evidence:"模型尚未完成有效判断，不能作为否定关系的依据。",options:["确认该关联","保留候选","不允许关联"]});
    }
    store.saveRelationAnalysis({sourceId:source.id,modelStatus:modelResult.status,modelName:modelResult.modelName,candidateCount:candidates.length,judgedCount:modelResult.decisions.length,suggestedCount,rejectedCount,error:modelResult.error||null,diagnostics});
    if(modelResult.status!=="completed") {
      for(const relation of store.listRelations(source.id).filter((item)=>item.status==="review")) {
        if(store.getReviewedRelation(source.id,relation))continue;
        if(relationColumnsPresent(relation,currentColumns)) relationKeys.push(relationKey(relation));
      }
    }
    for(const relation of store.listRelations(source.id,false,true).filter((item)=>item.inferenceSource==="document"&&["review","confirmed","denied"].includes(item.status))) {
      if(relation.status==="review"&&store.getReviewedRelation(source.id,relation))continue;
      if(relationColumnsPresent(relation,currentColumns))relationKeys.push(relationKey(relation));
    }
    store.finishSchemaRefresh(source.id,normalized,[...new Set(relationKeys)]);
    store.closeStaleRelationQuestions(source.id);
    store.closeQuestionsOnExcludedTables(source.id);
    emit(onProgress,88,"从列注释生成枚举含义待确认项");
    generateEnumMeaningQuestions(store,source.id);
    const snapshot=saveSnapshot(source.id,normalized,schemaDiff);
    emit(onProgress,90,"写入可审阅本体页面");
    await writeOntology(source.id);
    store.markSourceDiscovered(source.id);
    emit(onProgress,100,"探查完成");
    return {...summary(source.id),schemaDiff:{...schemaDiff,currentVersion:snapshot.currentVersion}};
  }

  // Lists every base table in the source database with its current selection state, without
  // probing anything — this is what the user reviews BEFORE discovery runs. Demo sources have

  async function previewTables(source) {
    const selections=new Map(store.listTableSelections(source.id).map((item)=>[item.tableName,item]));
    const known=new Map(store.listTables(source.id).map((table)=>[table.tableName,table]));
    const rows=(await introspectSchema(connector,source)).tables;
    return rows.map((row)=>({
      tableName:row.tableName,
      rowEstimate:Number(row.rowEstimate)||0,
      comment:row.comment||null,
      included:selections.get(row.tableName)?.included??1,
      decidedBy:selections.get(row.tableName)?.decidedBy??null,
      probed:known.has(row.tableName),
      grade:known.get(row.tableName)?.grade??null,
    }));
  }

  async function writeOntology(sourceId) {
    const sourceWikiDir=join(wikiDir,`source-${Number(sourceId)}`);
    const relations=store.listRelations(sourceId);
    for(const tableName of store.excludedTableNames(sourceId)) await removeTablePage(sourceWikiDir,tableName);
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
    return {sourceId,tables,totalTables:tables.length,grades:Object.fromEntries(["A","B","C"].map((grade)=>[grade,tables.filter((table)=>table.grade===grade).length])),sensitiveFields:0,relations:relations.length,pendingQuestions:store.listQuestions(sourceId).length,relationDiscovery:store.relationStats(sourceId)};
  }

  function saveSnapshot(sourceId,schema,knownDiff=null) { const previous=store.getLatestSchemaSnapshot(sourceId); const checksum=checksumSchema(schema); const diff=knownDiff||compareSchema(previous?.schema,schema); if(!previous||previous.checksum!==checksum) { const saved=store.addSchemaSnapshot(sourceId,checksum,schema); return {...diff,previousVersion:previous?.version??null,currentVersion:saved.version}; } return {...diff,previousVersion:previous?.version??null,currentVersion:previous.version}; }
  return {discover,summary,writeOntology,previewTables};
}

function emit(callback,progress,currentStep) { callback({progress,total:100,currentStep}); }
function relationKey(item) { return physicalRelationKey(item); }
function reverseRelationKey(item) { return physicalRelationKey(reverseRelation(item)); }
function normalizeSchema(schema) {
  return {
    tables:[...(schema.tables||[])].map(({tableName,rowEstimate=0,comment=null})=>({tableName,rowEstimate,comment})).sort((a,b)=>a.tableName.localeCompare(b.tableName)),
    columns:[...(schema.columns||[])].map(({tableName,columnName,dataType,nullable=null,isPrimary=0,isUnique=0,isIndexed=0,comment=null,keyConstraints=[]})=>({tableName,columnName,dataType,nullable,isPrimary:Number(isPrimary||0),isUnique:Number(isUnique||0),isIndexed:Number(isIndexed||0),comment,keyConstraints})).sort((a,b)=>`${a.tableName}.${a.columnName}`.localeCompare(`${b.tableName}.${b.columnName}`)),
    foreignKeys:[...(schema.foreignKeys||[])].map((relation)=>({fromTable:relation.fromTable,fromCol:relation.fromCol,toTable:relation.toTable,toCol:relation.toCol,columnPairs:relationPairs(relation)})).sort((a,b)=>relationKey(a).localeCompare(relationKey(b))),
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


function normalizeCardinality(cardinality,candidate) {
  const fromUnique=candidate.from.isPrimary||candidate.from.isUnique,toUnique=candidate.to.isPrimary||candidate.to.isUnique;
  if(fromUnique&&toUnique)return "1:1";
  if(toUnique)return "N:1";
  if(fromUnique)return "1:N";
  const samples=[candidate.dataEvidence,...(candidate.dataEvidence?.history||[])].filter(evidence=>evidence?.status==="sampled");
  if(samples.some(evidence=>evidence.multipleMatchCount>0)&&["N:1","1:1"].includes(cardinality))return "N:N";
  if(samples.some(evidence=>evidence.sourceMultipleMatchCount>0)){
    if(cardinality==="1:N")return "N:N";
    if(cardinality==="1:1")return "N:1";
  }
  if(cardinality&&cardinality!=="unknown") return cardinality;
  return "N:N";
}
function modelEvidence(relation) { return `模型 ${relation.modelName||"未命名"} 判断：${relation.modelReason||"无理由"}；模型置信度 ${((relation.modelConfidence||0)*100).toFixed(1)}%；结构评分 ${((relation.structuralScore||0)*100).toFixed(1)}%；${describeRelationEvidence(relation)}。列画像与已核验知识摘要（如有）已作为判断证据。确认后可作为本体关系生成的依据。`; }
function clamp(value) { return Math.max(0,Math.min(1,value)); }

export const _internal={normalizeSchema,compareSchema,sampleOverlap:sampleRelationOverlap,normalizeCardinality};
