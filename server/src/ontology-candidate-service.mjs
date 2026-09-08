import { relationPairs } from "./physical-relation.mjs";
import { findBridgeRelationPaths, missingBridgePaths } from "./ontology-bridge-paths.mjs";
import { createHash, randomUUID } from "node:crypto";
import {
  createOntologyCandidateScorer,
  createObjectStableKey,
  cosineSimilarity,
  normalizeOntologyNamespace,
  ONTOLOGY_CANDIDATE_SCORING_VERSION,
} from "./ontology-candidate-score.mjs";
import { buildLinkGenerationScope, buildObjectGenerationScope, ONTOLOGY_OBJECT_PROMPT_VERSION } from "./ontology-candidate-generator.mjs";
import { assembleOntologyDraft } from "./ontology-draft-assembler.mjs";
import { assertLosslessOntologyDraft } from "./ontology-draft-integrity.mjs";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";
import { callLlmEmbedding } from "./embedding-client.mjs";
import { candidateReviewChecksum, candidateReviewIssue } from "./ontology-candidate-review.mjs";
import { differentLinkMappings, mechanicalVerification, ONTOLOGY_HANDOFF_VERSION, ONTOLOGY_VERIFICATION_VERSION, validateVerification, verificationInput, verificationRecord, VERIFICATION_KIND } from "./ontology-candidate-verifier.mjs";

const ACCEPTED_STATUSES=new Set(["auto_confirmed","confirmed","applied"]);

export function createOntologyCandidateService({store,config,scorer,generator,critic,verifier,embeddingIndex,semanticSchemas,embeddingFetchImpl=globalThis.fetch}={}) {
  if(!store)throw new Error("ontology candidate service 需要 store");
  const aiConfig=config?.ontologyAi||{mode:"off",autoConfirmScore:85,maxTables:20,maxFields:600};
  const candidateScorer=scorer||createOntologyCandidateScorer({embedding:config?.embedding,fetchImpl:embeddingFetchImpl});
  const criticStats=new Map();

  const usesVerification=run=>Boolean(verifier)&&run.scope.modelingMode==="auto_draft";
  function verificationContext(run){return {run,base:run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId):null,catalog:catalog(run.sourceId,run.scope.tableNames),acceptedObjects:acceptedRunObjects(run),knowledgePages:store.listKnowledge(run.sourceId)};}
  function currentVerification(candidate,run=requiredRun(candidate.runId)) {
    if(!usesVerification(run))return null;
    const record=verificationRecord(candidate);
    if(record?.decision==="business_question"&&record.handoffVersion!==ONTOLOGY_HANDOFF_VERSION)return null;
    try{return record?.policy===ONTOLOGY_VERIFICATION_VERSION&&record.inputChecksum===verificationInput(candidate,verificationContext(run)).inputChecksum?record:null;}catch{return null;}
  }
  function reviewIssue(candidate,run,base) {
    const issue=candidateReviewIssue(candidate,run,base);
    if(!usesVerification(run))return issue;
    const record=currentVerification(candidate,run);
    if(record?.decision==="business_question")return {...issue,reviewKind:"business",title:`请核实「${candidate.payload.displayName||candidate.payload.apiName}」的业务口径`,
      detail:record.explanation,clarificationPrompt:record.question,definitions:issue.definitions.map(item=>({...item,reasons:[record.question]})),evidenceSummary:[...(issue.evidenceSummary||[]),...record.supports.map(item=>item.reason)]};
    return {id:`verification:${candidate.id}`,kind:"verification",title:"系统正在核验和修正业务定义",detail:record?.explanation||"此定义需要系统结合已有证据核验，尚未发现需要你回答的具体业务问题。",tables:issue.tables,candidateIds:[candidate.id],retryable:true};
  }

  async function verifyRun(runId,{retryPasses=0,onProgress=()=>{}}={}) {
    let run=requiredRun(runId);
    if(!usesVerification(run)||run.status!=="succeeded")return {skipped:true};
    validatedRunCatalog(run);
    const context=verificationContext(run),pending=store.listOntologyCandidates({runId,limit:2000}).filter(item=>["review_required","blocked"].includes(item.status)),requests=[];
    const assertSnapshot=(original,input)=>{
      const latest=store.getOntologyCandidate(original.id),owner=requiredRun(runId);
      validatedRunCatalog(owner);
      if((store.getPublishedOntologySchema(owner.sourceId)?.id||null)!==(owner.scope.publishedSchemaVersionIdAtStart||null))throw httpError(409,"核验期间当前版本已变化，请重新构建");
      if(!latest||latest.status!==original.status||verificationInput(latest,verificationContext(owner)).inputChecksum!==input.inputChecksum)throw httpError(409,"核验期间候选或证据已变化，旧结论未应用");
      return latest;
    };
    const persist=(candidate,input,result,attempt)=>store.db.transaction(()=>{
      const latest=assertSnapshot(candidate,input),record={kind:VERIFICATION_KIND,policy:ONTOLOGY_VERIFICATION_VERSION,handoffVersion:ONTOLOGY_HANDOFF_VERSION,inputChecksum:input.inputChecksum,attempt,model:config?.llm?.model||null,at:new Date().toISOString(),...result,verified:result.decision==="supported"};
      return requireTransition(store.transitionOntologyCandidate({id:latest.id,expectedStatus:latest.status,status:record.verified?"auto_confirmed":latest.status,
        evidence:[record,...latest.evidence.filter(item=>item.kind!==VERIFICATION_KIND)],validation:latest.validation,actor:"system",eventType:"evidence_verification",note:record.explanation}));
    }).immediate();
    for(const candidate of pending){
      const input=verificationInput(candidate,context),prior=currentVerification(candidate,run);
      if(prior&&!(["system_error","checking"].includes(prior.decision)&&Number(prior.attempt)<1+Math.min(2,retryPasses)))continue;
      const attempt=Number(prior?.attempt||0)+1,mechanical=mechanicalVerification(candidate,input,context);
      if(mechanical){persist(candidate,input,mechanical,attempt);continue;}
      // Reserve before calling the model. Restart/read requests cannot reset the budget.
      persist(candidate,input,{decision:"checking",explanation:"等待模型完成证据核验",supports:[],question:null},attempt);
      requests.push({candidate,input:{...input,...(prior?.decision==="system_error"?{retryFeedback:`上次核验未通过协议校验：${prior.explanation}。claim 必须来自 requirements，证据 ID 必须完整、原样引用本次 evidence、requiredRelationIds 和 requiredEndpointIds。`}: {})},attempt});
    }
    // Commit each bounded batch before the next call, so a crash keeps completed work.
    for(let start=0;start<requests.length;start+=4){
      const batch=requests.slice(start,start+4);onProgress({currentStep:`正在核验证据 ${start+1}–${Math.min(start+4,requests.length)} / ${requests.length}`});
      let inspected;
      try{inspected=await verifier.inspect(batch.map(item=>item.input));}catch{inspected={results:new Map(),calls:1};}
      for(const {candidate,input,attempt} of batch){const raw=inspected.results?.get(candidate.id),result=raw?.decision==="system_error"?{decision:"system_error",explanation:String(raw.explanation||"证据核验失败").slice(0,500),supports:[],question:null}:validateVerification(raw,input);persist(candidate,input,result,attempt);}
      run=requiredRun(runId);
      store.transitionOntologyGenerationRun({id:runId,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:{...run.summary,verificationCalls:Number(run.summary.verificationCalls||0)+Number(inspected.calls||0),...summarizeCandidates(store.listOntologyCandidates({runId,limit:2000}),run.scope.scopeKind==="global_links"?[]:run.scope.tableNames)},tokenUsage:mergeUsage(run.tokenUsage,inspected.tokenUsage)});
    }
    return {runId};
  }

  async function verifyAndRepairRun(runId,options={}) {
    await verifyRun(runId,options);
    if(!usesVerification(requiredRun(runId)))return;
    for(let round=0;round<3;round++){
      const run=requiredRun(runId),spent=Number(run.summary.verificationRepairAttempts||0);
      const pending=store.listOntologyCandidates({runId,limit:2000}).filter(item=>["review_required","blocked"].includes(item.status)),previousHandoffIds=run.summary.handoffRepairCandidateIds||[];
      const repairLimit=2+Math.min(2,Math.max(0,Number(options.retryPasses)||0));
      const systemIds=spent<repairLimit?pending.filter(item=>currentVerification(item,run)?.decision==="system_repair").map(item=>item.id):[];
      const handoffIds=options.repairBusinessQuestions?pending.filter(item=>!previousHandoffIds.includes(item.id)&&["business_question","system_repair"].includes(currentVerification(item,run)?.decision)&&!systemIds.includes(item.id)).map(item=>item.id):[];
      const ids=[...new Set([...systemIds,...handoffIds])];
      if(!ids.length||!generator)break;
      store.transitionOntologyGenerationRun({id:runId,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:{...run.summary,verificationRepairAttempts:spent+(systemIds.length?1:0),handoffRepairCandidateIds:[...new Set([...previousHandoffIds,...handoffIds])]},tokenUsage:run.tokenUsage});
      try{await refineRun(runId,{remainingRounds:1,verificationRepairIds:ids,onProgress:options.onProgress});}catch(error){if(error.status===409)throw error;break;}
      await verifyRun(runId,options);
    }
  }

  function catalog(sourceId,tableNames=null) {
    const selected=tableNames?new Set(tableNames):null;
    // Respect the data source's table selection: modeling must stay within the
    // tables the user opted into. Excluded tables (included=0) are not part of
    // the ontology and must not generate objects, or drafts later fail their
    // mapping validation with ONTOLOGY_MAPPING_TABLE_NOT_FOUND.
    const excludedTables=store.excludedTableNames(sourceId);
    const tables=store.listTables(sourceId).filter((table)=>!excludedTables.has(table.tableName)&&(!selected||selected.has(table.tableName)));
    const profilingEnabled=Boolean(config?.profiling?.enabled);
    const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName).map((column)=>profilingEnabled?column:{...column,profile:null})]));
    const enumsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listEnums(sourceId,table.tableName)]));
    const relations=store.listRelations(sourceId,false,true).filter((relation)=>!selected||(selected.has(relation.fromTable)&&selected.has(relation.toTable)));
    const termAnchors=store.listTermAnchors?.()||[];
    return {sourceId,tables,columnsByTable,enumsByTable,relations,termAnchors};
  }

  function prepareGenerationScope(input,{allowEmpty=false,linkOnly=false}={}) {
    const source=store.getSource(Number(input?.sourceId));
    if(!source)throw httpError(404,"数据源不存在");
    const mode=String(input?.mode||"selected_tables");
    if(mode!=="selected_tables")throw httpError(400,"首期只支持 selected_tables 生成方式");
    const tableNames=[...new Set((input?.tableNames||[]).map((item)=>String(item).trim()).filter(Boolean))].sort();
    const maxTables=linkOnly?20:boundedInteger(aiConfig.maxTables,1,20,20);
    if((!allowEmpty&&!tableNames.length)||tableNames.length>maxTables)throw httpError(400,`tableNames 必须选择 1 到 ${maxTables} 张表`);
    const selectedCatalog=catalog(source.id,tableNames);
    const found=new Set(selectedCatalog.tables.map((table)=>table.tableName));
    const missing=tableNames.filter((table)=>!found.has(table));
    if(missing.length)throw httpError(400,`表不存在或已失效：${missing.join("、")}`);
    const unavailable=selectedCatalog.tables.filter((table)=>table.active===0||!["A","B"].includes(table.grade));
    if(unavailable.length)throw httpError(400,`只允许选择有效 A/B 级表：${unavailable.map((item)=>item.tableName).join("、")}`);
    const maxFields=boundedInteger(aiConfig.maxFields,1,600,600);
    const generationScope=buildObjectGenerationScope({catalog:selectedCatalog,tableNames,maxFields});
    return {source,mode,tableNames,maxTables,maxFields,selectedCatalog,generationScope};
  }

  function planScope(input) {
    ensureEnabled(aiConfig);
    const {source,mode,tableNames,maxTables,maxFields,generationScope}=prepareGenerationScope(input,{allowEmpty:true});
    return {
      sourceId:source.id,mode,tableNames,limits:{maxTables,maxFields},
      totalNonSensitiveFields:generationScope.totalNonSensitiveFields,includedFieldCount:generationScope.includedFieldCount,truncatedFieldCount:generationScope.truncatedFieldCount,
      batchCount:generationScope.batchCount,hasTruncation:generationScope.hasTruncation,confirmedRelationCount:generationScope.confirmedRelationCount,
      includedRelationCount:generationScope.includedRelationCount,crossBatchRelationCount:generationScope.crossBatchRelationCount,
      excludedSensitiveRelationCount:generationScope.excludedSensitiveRelationCount,excludedInvalidRelationCount:generationScope.excludedInvalidRelationCount,
      batches:generationScope.batches.map((batch)=>({id:batch.id,tableNames:batch.tableNames,fieldCount:batch.fieldCount,relationCount:batch.relationIds.length,tables:batch.tables.map((table)=>({tableName:table.tableName,totalNonSensitiveFields:table.totalNonSensitiveFields,includedFieldCount:table.includedFieldCount,truncatedFieldCount:table.truncatedFieldCount,fieldsComplete:table.fieldsComplete}))})),
    };
  }

  function createRun(input,createdBy,{id=randomUUID(),taskId=null,linkContext=null}={}) {
    ensureEnabled(aiConfig);
    const {source,mode,tableNames,maxTables,maxFields,selectedCatalog,generationScope}=prepareGenerationScope(input,{linkOnly:Boolean(linkContext)});
    const nonSensitiveFieldCount=generationScope.totalNonSensitiveFields;
    if(store.listOntologyGenerationRuns(source.id,20).some((run)=>["queued","running"].includes(run.status)))throw httpError(409,"同一数据源已有正在执行的本体生成批次");
    const publishedAtStart=store.getPublishedOntologySchema(source.id);
    const baseSchemaVersionId=input?.baseSchemaVersionId==null?(publishedAtStart?.id||null):Number(input.baseSchemaVersionId);
    if(baseSchemaVersionId!=null) {
      const base=store.getOntologySchemaVersion(baseSchemaVersionId);
      if(!base||base.sourceId!==source.id)throw httpError(400,"基础 Schema 版本不存在或不属于当前数据源");
    }
    const namespace=normalizeOntologyNamespace(input?.domainName);
    const embeddingModel=String(config?.embedding?.model||"unconfigured").trim()||"unconfigured";
    const sourceAutoConfirmScore=store.getSourceOntologySetting?.(source.id)?.autoConfirmScore;
    const effectiveAutoConfirmScore=boundedInteger(sourceAutoConfirmScore,0,100,boundedInteger(aiConfig.autoConfirmScore,0,100,85));
    const run=store.createOntologyGenerationRun({
      id,sourceId:source.id,taskId,mode,
      scope:{tableNames,domainName:String(input?.domainName||"").trim(),domainDescription:String(input?.domainDescription||"").trim(),namespace,nonSensitiveFieldCount,batches:generationScope.batches,limits:{maxTables,maxFields},modelingMode:aiConfig.mode,autoConfirmScore:effectiveAutoConfirmScore,llmTimeoutMs:boundedInteger(aiConfig.timeoutMs,1_000,600_000,300_000),embeddingModel,publishedSchemaVersionIdAtStart:publishedAtStart?.id||null,...domainOrchestrationScope(input),...(linkContext?{...linkContext,scopeKind:"global_links",batches:[]}: {})},
      catalogChecksum:ontologyCatalogChecksum(selectedCatalog),baseSchemaVersionId,
      modelName:String(config?.llm?.model||"").trim()||null,promptVersion:ONTOLOGY_OBJECT_PROMPT_VERSION,
      scoringVersion:`${ONTOLOGY_CANDIDATE_SCORING_VERSION}:embedding=${embeddingModel}`,createdBy:String(createdBy||"system"),summary:{tableCount:tableNames.length,nonSensitiveFieldCount,includedFieldCount:generationScope.includedFieldCount,truncatedFieldCount:generationScope.truncatedFieldCount,batchCount:generationScope.batchCount,confirmedRelationCount:generationScope.confirmedRelationCount,includedRelationCount:generationScope.includedRelationCount,crossBatchRelationCount:generationScope.crossBatchRelationCount,excludedSensitiveRelationCount:generationScope.excludedSensitiveRelationCount,excludedInvalidRelationCount:generationScope.excludedInvalidRelationCount,candidateCount:0,autoConfirmedCount:0,reviewRequiredCount:0,blockedCount:0},
    });
    return {...run,catalogCurrent:true};
  }

  async function evaluateAndStore(runId,input,actor="system",{repair=false,allowedRepairIds=null,existingOnly=false}={}) {
    ensureEnabled(aiConfig);
    const run=requiredRun(runId);
    if(!["queued","running"].includes(run.status)&&!(run.status==="succeeded"&&(input?.candidateType==="link"||repair)))throw httpError(409,"当前批次状态不允许写入该候选");
    const currentCatalog=validatedRunCatalog(run);
    const acceptedObjects=acceptedRunObjects(run);
    const baseSchema=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
    const candidate={...input,evidence:(input?.evidence||[]).filter(item=>item.kind!==VERIFICATION_KIND),payload:normalizeCandidatePayload(input?.payload,{candidateType:input?.candidateType,namespace:run.scope.namespace,catalog:currentCatalog}),sourceId:run.sourceId,namespace:run.scope.namespace};
    // Global completion adds uncovered physical paths; an accidental API-name
    // collision must not replace an existing, differently mapped relationship.
    if(candidate.candidateType==="link"&&run.scope.scopeKind==="global_links"){
      const previous=baseSchema?.linkTypes?.find(item=>item.apiName===candidate.payload.apiName);
      if(previous&&differentLinkMappings(candidate.payload,previous)){
        const suffix=createHash("sha256").update(JSON.stringify(candidate.payload.relationMappings)).digest("hex").slice(0,10);
        candidate.payload.apiName=`${candidate.payload.apiName.slice(0,75)}_path_${suffix}`;
        if(candidate.payload.inverseApiName)candidate.payload.inverseApiName=`${candidate.payload.inverseApiName.slice(0,75)}_path_${suffix}`;
      }
    }
    const result=await candidateScorer.score(candidate,{sourceId:run.sourceId,catalog:currentCatalog,acceptedObjects,baseSchema,mode:run.scope.modelingMode||aiConfig.mode,autoConfirmScore:run.scope.autoConfirmScore??aiConfig.autoConfirmScore,embeddingModel:run.scope.embeddingModel,scoringVersion:run.scoringVersion});
    if(!result.stableKey)throw httpError(422,"候选无法依据物理映射生成 stableKey，已阻止写入候选表");
    const existing=store.listOntologyCandidates({runId:run.id,candidateType:candidate.candidateType}).find((item)=>item.stableKey===result.stableKey);
    if(existingOnly&&!existing)throw httpError(422,"本轮修正不能引入不同物理映射的新候选");
    if(existing){
      if(!repair||!["review_required","blocked"].includes(existing.status)||(allowedRepairIds&&!allowedRepairIds.includes(existing.id)))return existing;
      if(usesVerification(run)&&result.validation.ok){result.status="review_required";result.routeReason="awaiting_evidence_verification_after_repair";}
      return requireTransition(store.transitionOntologyCandidate({id:existing.id,expectedStatus:existing.status,status:result.status,payload:candidate.payload,evidence:candidate.evidence||[],modelConfidence:candidate.modelConfidence,score:result.score,scoreBreakdown:result.scoreBreakdown,validation:result.validation,forcedReviewReasons:result.forcedReviewReasons,actor,eventType:"model_repair",note:result.routeReason}));
    }
    return store.createOntologyCandidate({
      id:input?.id||randomUUID(),runId:run.id,sourceId:run.sourceId,candidateType:candidate.candidateType,stableKey:result.stableKey,
      payload:candidate.payload,evidence:Array.isArray(candidate.evidence)?candidate.evidence:[],modelConfidence:Number.isFinite(candidate.modelConfidence)?candidate.modelConfidence:null,
      score:result.score,scoreBreakdown:result.scoreBreakdown,validation:result.validation,status:result.status,forcedReviewReasons:result.forcedReviewReasons,
      actor,eventType:"auto_route",eventNote:result.routeReason,
    });
  }

  async function evaluateBatchAndStore(runId,inputs,actor="system",options={}) {
    if(!inputs.length)return [];
    const run=requiredRun(runId);const currentCatalog=validatedRunCatalog(run);const acceptedObjects=acceptedRunObjects(run);
    const prepared=inputs.map((input,index)=>({...input,criticId:`${run.id}:${input.candidateType}:${index}:${createHash("sha256").update(JSON.stringify(input.payload||{})).digest("hex").slice(0,12)}`}));
    const inspected=critic?.inspect?await critic.inspect(prepared,{catalog:currentCatalog,acceptedObjects}):{results:new Map(),skipped:true,error:null};
    const stats=criticStats.get(run.id)||{batches:0,flagged:0,skipped:0,errors:[]};stats.batches++;if(inspected.skipped)stats.skipped++;if(inspected.error)stats.errors.push(inspected.error);
    const enriched=prepared.map((input)=>{const result=inspected.results.get(input.criticId);if(result?.consistent===false){stats.flagged++;return {...input,semanticCriticFlagged:true,evidence:[...(input.evidence||[]),{kind:"semantic_critic",refId:`critic:${input.criticId}`,verified:false,consistent:false,issue:result.issue}]};}return input;});
    criticStats.set(run.id,stats);
    const stored=[];for(const input of enriched)stored.push(await evaluateAndStore(runId,input,actor,options));return stored;
  }

  async function selectKnowledgePages(sourceId,currentCatalog) {
    const pages=store.listKnowledge(sourceId).filter((page)=>page.verified);if(!pages.length)return {pages:[],mode:"empty"};
    if(!embeddingIndex?.enabled?.()||!embeddingIndex?.loadVectors||!embeddingIndex?.embedQuestion)return {pages,mode:"fallback"};
    try{
      const vectors=embeddingIndex.loadVectors(sourceId);if(!vectors?.pageVectors?.size)return {pages,mode:"fallback"};
      const query=(currentCatalog.tables||[]).flatMap((table)=>[table.tableName,table.comment]).filter(Boolean).join("\n");const queryVector=await embeddingIndex.embedQuestion(query);if(!queryVector)return {pages,mode:"fallback"};
      const tableNames=new Set((currentCatalog.tables||[]).map((table)=>table.tableName));const hard=pages.filter((page)=>(page.tables||[]).some((table)=>tableNames.has(table)));
      const hardKeys=new Set(hard.map((page)=>`${page.pageType}:${page.slug}`));const ranked=pages.filter((page)=>!hardKeys.has(`${page.pageType}:${page.slug}`)).map((page)=>({page,similarity:cosineSimilarity(queryVector,vectors.pageVectors.get(`${page.pageType}:${page.slug}`))})).sort((left,right)=>right.similarity-left.similarity||String(left.page.title).localeCompare(String(right.page.title)));
      return {pages:[...hard,...ranked.map((item)=>item.page)].slice(0,30),mode:"embedding_top_k"};
    }catch{return {pages,mode:"fallback"};}
  }

  async function selectTermAnchors(run,currentCatalog) {
    const anchors=currentCatalog.termAnchors||[];if(anchors.length<=100)return {anchors,mode:"bounded_all"};
    const embedding=config?.embedding||{};
    const query=[run.scope.domainName,run.scope.domainDescription,...(currentCatalog.tables||[]).flatMap((table)=>[table.tableName,table.comment]),...Object.values(currentCatalog.columnsByTable||{}).flatMap((columns)=>columns.flatMap((column)=>[column.columnName,column.comment]))].filter(Boolean).join("\n");
    const anchorText=(anchor)=>[anchor.vocabulary,anchor.canonicalId,anchor.prefLabelZh,anchor.prefLabelEn,...(anchor.altLabels||[])].filter(Boolean).join(" ");
    if(embedding.baseUrl&&embedding.apiKey&&embedding.model)try{
      const vectors=await callLlmEmbedding(embedding,[query,...anchors.map(anchorText)],{timeoutMs:30_000,fetchImpl:embeddingFetchImpl});const queryVector=vectors[0];
      const ranked=anchors.map((anchor,index)=>({anchor,similarity:cosineSimilarity(queryVector,vectors[index+1])})).sort((left,right)=>right.similarity-left.similarity||String(left.anchor.vocabulary).localeCompare(String(right.anchor.vocabulary))||String(left.anchor.canonicalId).localeCompare(String(right.anchor.canonicalId)));
      return {anchors:ranked.slice(0,100).map((item)=>item.anchor),mode:"embedding_top_n"};
    }catch{/* Fall through to deterministic lexical recall. */}
    const normalizedQuery=normalizeSearchText(query);const ranked=anchors.map((anchor)=>({anchor,score:anchorSearchScore(normalizedQuery,anchorText(anchor))})).sort((left,right)=>right.score-left.score||String(left.anchor.vocabulary).localeCompare(String(right.anchor.vocabulary))||String(left.anchor.canonicalId).localeCompare(String(right.anchor.canonicalId)));
    return {anchors:ranked.slice(0,100).map((item)=>item.anchor),mode:"lexical_fallback"};
  }

  async function runGeneration({payload,onProgress=()=>{}}={}) {
    if(!generator)throw new Error("Object 候选生成器未配置");
    let run=requiredRun(payload?.runId);
    if(run.status==="succeeded")return {runId:run.id,...run.summary,tokenUsage:run.tokenUsage};
    if(!["queued","running"].includes(run.status))throw new Error(`生成批次当前状态为 ${run.status}，不能执行`);
    if(run.status==="queued") {
      const started=store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"queued",status:"running",progress:1,summary:run.summary});
      if(!started.ok)throw new Error("生成批次状态已变化，无法启动");
      run=started.run;
    }
    const reportProgress=(step)=>{
      onProgress(step);
      const latest=store.getOntologyGenerationRun(run.id);
      if(latest?.status==="running")store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"running",status:"running",progress:step.progress,summary:latest.summary,tokenUsage:latest.tokenUsage});
    };
    try {
      const currentCatalog=validatedRunCatalog(run);
      const knowledgeSelection=await selectKnowledgePages(run.sourceId,currentCatalog);const knowledgePages=knowledgeSelection.pages;
      const termAnchorSelection=await selectTermAnchors(run,currentCatalog);const generationCatalog={...currentCatalog,termAnchors:termAnchorSelection.anchors};
      const baseSchema=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
      reportProgress({progress:5,total:100,currentStep:"准备目录快照与业务语料"});
      const generated=run.scope.scopeKind==="global_links"?emptyGenerationResult():await generator.generateObjects({run,catalog:generationCatalog,knowledgePages,baseSchema,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress:reportProgress});
      const autoEndpoints=acceptedRunObjects(run);
      const existingLinkKeys=store.listOntologyCandidates({runId:run.id,candidateType:"link"}).map((candidate)=>candidate.stableKey);
      const links=generator.generateLinks?await generator.generateLinks({run,catalog:linkCatalog(run,currentCatalog),endpoints:autoEndpoints,knowledgePages,phase:"auto",existingStableKeys:existingLinkKeys,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress:reportProgress}):emptyGenerationResult();
      const candidates=store.listOntologyCandidates({runId:run.id});
      const normalizationIssues=[...generated.normalizationIssues,...links.normalizationIssues];
      const summary={...run.summary,...summarizeCandidates(candidates,run.scope.scopeKind==="global_links"?[]:run.scope.tableNames),linkEligibleRelationCount:links.eligibleRelationCount,knowledgeRetrievalMode:knowledgeSelection.mode,termAnchorRetrievalMode:termAnchorSelection.mode,termAnchorCount:termAnchorSelection.anchors.length,normalizationIssueCount:normalizationIssues.length,normalizationIssues:normalizationIssues.slice(0,100),critic:criticStats.get(run.id)||{batches:0,flagged:0,skipped:0,errors:[]},modelCalls:[...generated.calls,...links.calls]};
      const tokenUsage=mergeUsage(generated.tokenUsage,links.tokenUsage);
      const completed=store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"running",status:"succeeded",progress:100,summary,tokenUsage});
      if(!completed.ok)throw new Error("生成批次完成时状态已变化");
      onProgress({progress:100,total:100,currentStep:"Object 与 Link 候选生成完成"});
      return {runId:run.id,...summary,tokenUsage};
    } catch(error) {
      const latest=store.getOntologyGenerationRun(run.id);
      if(latest?.status==="running")store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"running",status:"failed",progress:latest.progress,summary:{...latest.summary,modelCalls:error?.generationCalls||latest.summary.modelCalls||[]},tokenUsage:error?.generationTokenUsage||latest.tokenUsage,error:String(error?.message||error)});
      throw error;
    }
  }

  async function runSupplementalLinks({payload,onProgress=()=>{}}={}) {
    ensureEnabled(aiConfig);
    if(!generator?.generateLinks)throw new Error("Link 候选生成器未配置");
    const run=requiredRun(payload?.runId);
    if(run.status!=="succeeded")throw new Error("只有已完成 Object 阶段的批次可以补充生成 Link");
    try {
      const currentCatalog=validatedRunCatalog(run);
      const endpoints=acceptedRunObjects(run);
      const knowledgeSelection=await selectKnowledgePages(run.sourceId,currentCatalog);const knowledgePages=knowledgeSelection.pages;
      const existingLinkKeys=store.listOntologyCandidates({runId:run.id,candidateType:"link"}).map((candidate)=>candidate.stableKey);
      const generated=await generator.generateLinks({run,catalog:linkCatalog(run,currentCatalog),endpoints,knowledgePages,phase:"supplemental",existingStableKeys:existingLinkKeys,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress});
      const candidates=store.listOntologyCandidates({runId:run.id});const normalizationIssues=[...(run.summary.normalizationIssues||[]),...generated.normalizationIssues].slice(0,100);
      const summary={...run.summary,...summarizeCandidates(candidates,run.scope.scopeKind==="global_links"?[]:run.scope.tableNames),supplementalLinkEligibleRelationCount:generated.eligibleRelationCount,knowledgeRetrievalMode:knowledgeSelection.mode,normalizationIssueCount:Number(run.summary.normalizationIssueCount||0)+generated.normalizationIssues.length,normalizationIssues,critic:criticStats.get(run.id)||run.summary.critic||{batches:0,flagged:0,skipped:0,errors:[]},modelCalls:[...(run.summary.modelCalls||[]),...generated.calls],lastSupplementalLinkError:null};
      const tokenUsage=mergeUsage(run.tokenUsage,generated.tokenUsage);
      const updated=store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"succeeded",status:"succeeded",progress:100,summary,tokenUsage});
      if(!updated.ok)throw new Error("补充 Link 完成时批次状态已变化");
      onProgress({progress:100,total:100,currentStep:"补充 Link 候选生成完成"});
      return {runId:run.id,...summary,tokenUsage};
    } catch(error) {
      const latest=store.getOntologyGenerationRun(run.id);
      if(latest?.status==="succeeded")store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:{...latest.summary,lastSupplementalLinkError:String(error?.message||error),modelCalls:[...(latest.summary.modelCalls||[]),...(error?.generationCalls||[])]},tokenUsage:mergeUsage(latest.tokenUsage,error?.generationTokenUsage)});
      throw error;
    }
  }

  async function decide(candidateId,input,actor,{onDecision=()=>{}}={}) {
    const current=store.getOntologyCandidate(candidateId);
    if(!current)throw httpError(404,"候选不存在");
    const decision=String(input?.decision||"");
    if(decision==="reject")return requireTransition(store.transitionOntologyCandidate({id:current.id,expectedStatus:"review_required",status:"rejected",reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:"rejected",note:input?.note||null}));
    if(decision==="withdraw")return requireTransition(store.transitionOntologyCandidate({id:current.id,expectedStatus:"auto_confirmed",status:"review_required",reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:"withdrawn",note:input?.note||null}));
    if(decision!=="confirm")throw httpError(400,"decision 必须是 confirm、reject 或 withdraw");
    if(current.status!=="review_required")throw httpError(409,"只有待人工确认候选可以执行确认");
    const run=requiredRun(current.runId);const currentCatalog=validatedRunCatalog(run);
    const assertReviewCurrent=()=>{
      if(input?.reviewChecksum==null)return;
      const latest=store.getOntologyCandidate(candidateId),latestRun=requiredRun(current.runId);
      const base=latestRun.baseSchemaVersionId?store.getOntologySchemaVersion(latestRun.baseSchemaVersionId):null;
      if(!latest||latest.status!=="review_required"||(store.getPublishedOntologySchema(current.sourceId)?.id??null)!==(latestRun.baseSchemaVersionId??null)||
        input.reviewChecksum!==candidateReviewChecksum(latest,latestRun,base))throw httpError(409,"待审核定义或依据已变化，请刷新后重新确认");
      validatedRunCatalog(latestRun);
    };
    assertReviewCurrent();
    const edited=input?.candidate!=null;
    let payload=current.payload;let score=current.score;let scoreBreakdown=current.scoreBreakdown;let validation=current.validation;let forcedReviewReasons=current.forcedReviewReasons;
    if(edited){
      payload=normalizeCandidatePayload(input.candidate,{candidateType:current.candidateType,namespace:run.scope.namespace,catalog:currentCatalog});
      const acceptedObjects=acceptedRunObjects(run);
      const baseSchema=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
      const rescored=await candidateScorer.score({...current,payload,namespace:run.scope.namespace},{sourceId:run.sourceId,catalog:currentCatalog,acceptedObjects,baseSchema,mode:"review",autoConfirmScore:run.scope.autoConfirmScore??aiConfig.autoConfirmScore,embeddingModel:run.scope.embeddingModel,scoringVersion:run.scoringVersion});
      if(!rescored.validation.ok)throw httpError(422,"人工修订后的候选未通过确定性校验");
      if(rescored.stableKey!==current.stableKey)throw httpError(409,"人工修订改变了 stableKey 所依赖的物理映射，请重新生成候选");
      score=rescored.score;scoreBreakdown=rescored.scoreBreakdown;validation=rescored.validation;forcedReviewReasons=rescored.forcedReviewReasons;
    }else if(!validation?.ok)throw httpError(422,"候选生成时未通过确定性校验，请编辑后再确认");
    return store.db.transaction(()=>{
      // Edited review can await a scorer; reject a changed definition before commit.
      assertReviewCurrent();
      const updated=requireTransition(store.transitionOntologyCandidate({
        id:current.id,expectedStatus:"review_required",status:"confirmed",payload,score,scoreBreakdown,
        validation,forcedReviewReasons,reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:edited?"edited_and_confirmed":"confirmed",note:input?.note||null,
      }));
      onDecision(updated);
      return updated;
    }).immediate();
  }

  async function bulkDecide(input,actor) {
    const ids=normalizeCandidateIdList(input?.candidateIds);
    if(!ids.length||ids.length>200)throw httpError(400,"candidateIds 必须包含 1 到 200 个候选");
    const sourceId=Number(input?.sourceId);if(!Number.isInteger(sourceId)||sourceId<=0)throw httpError(400,"sourceId 必填");
    const decision=String(input?.decision||"");if(!["confirm","reject","withdraw"].includes(decision))throw httpError(400,"decision 必须是 confirm、reject 或 withdraw");
    const candidates=ids.map((id)=>store.getOntologyCandidate(id));const invalid=ids.filter((id,index)=>!candidates[index]||Number(candidates[index].sourceId)!==sourceId);
    if(invalid.length)throw httpError(400,`候选不存在或不属于当前数据源：${invalid.join("、")}`);
    const results=[];
    for(const candidate of candidates){try{const updated=await decide(candidate.id,{decision,note:input?.note},actor);results.push({id:candidate.id,ok:true,candidate:updated});}catch(error){results.push({id:candidate.id,ok:false,error:String(error?.message||error),status:Number(error?.status||409)});}}
    return {sourceId,decision,total:results.length,succeeded:results.filter((item)=>item.ok).length,failed:results.filter((item)=>!item.ok).length,results};
  }

  function merge(candidateId,input,actor) {
    ensureEnabled(aiConfig);
    const intoCandidateId=String(input?.intoCandidateId||"").trim();
    if(!intoCandidateId)throw httpError(400,"intoCandidateId 必填");
    return store.mergeOntologyCandidates({id:candidateId,intoCandidateId,actor:String(actor||"system"),note:String(input?.note||"").trim()||null});
  }

  function preview(runId,input) {
    const prepared=prepareDraft(runId,input);
    return {schema:prepared.validation.schema,validation:withoutSchema(prepared.validation),diff:prepared.diff,conflicts:prepared.assembled.conflicts,excludedCandidateIds:prepared.assembled.excludedCandidateIds,summary:prepared.assembled.summary};
  }

  function apply(runId,input,actor) {
    const {run,expectedPublishedId,assembled,validation,diff}=prepareDraft(runId,input);
    if(assembled.summary.unresolvedConflictCount)throw httpError(409,"仍有未处理的 Schema 冲突，请明确选择保留现有定义或采用候选并重新预览");
    if(!assembled.includedCandidates.length)throw httpError(409,"没有可应用的已确认候选；请完成审核或调整排除列表");
    assertLosslessOntologyDraft(assembled.schema,validation);
    const compactValidation=withoutSchema(validation);
    const schema=validation.schema;
    const draft=store.createOntologyDraftWithCandidates({
      sourceId:run.sourceId,runId:run.id,baseSchemaVersionId:run.baseSchemaVersionId,
      expectedPublishedSchemaVersionId:expectedPublishedId,
      schemaName:schema.name||`source_${run.sourceId}`,schema,
      checksum:createHash("sha256").update(JSON.stringify(schema)).digest("hex"),validation:compactValidation,
      createdBy:String(actor||"system"),candidateIds:assembled.includedCandidates.map((candidate)=>candidate.id),
    });
    return {draft:{...draft,validation:compactValidation},validation:compactValidation,diff,conflicts:assembled.conflicts,excludedCandidateIds:assembled.excludedCandidateIds,summary:assembled.summary};
  }

  function prepareDraft(runId,input) {
    ensureEnabled(aiConfig);
    if(!semanticSchemas?.validate)throw new Error("业务本体 Schema 校验服务未配置");
    const run=requiredRun(runId);
    if(run.status!=="succeeded")throw httpError(409,"只有已完成的生成批次可以预览或创建 Schema 草稿");
    validatedRunCatalog(run);
    const published=store.getPublishedOntologySchema(run.sourceId);const expectedPublishedId=run.scope.publishedSchemaVersionIdAtStart||null;
    if((published?.id||null)!==expectedPublishedId)throw httpError(409,"当前发布 Schema 已变化，请基于最新版本重新生成批次");
    const base=run.baseSchemaVersionId==null?null:store.getOntologySchemaVersion(run.baseSchemaVersionId);
    if(run.baseSchemaVersionId!=null&&(!base||base.sourceId!==run.sourceId))throw httpError(409,"基础 Schema 版本不存在或不属于当前数据源");
    const candidates=store.listOntologyCandidates({runId:run.id,limit:2000});const candidateIds=new Set(candidates.map((candidate)=>candidate.id));
    const excludeCandidateIds=normalizeCandidateIdList(input?.excludeCandidateIds);const unknownExcluded=excludeCandidateIds.filter((candidateId)=>!candidateIds.has(candidateId));
    if(unknownExcluded.length)throw httpError(400,`排除列表包含不属于当前批次的候选：${unknownExcluded.join("、")}`);
    const conflictResolutions=normalizeConflictResolutions(input?.conflictResolutions);const unknownResolved=Object.keys(conflictResolutions).filter((candidateId)=>!candidateIds.has(candidateId));
    if(unknownResolved.length)throw httpError(400,`冲突处理包含不属于当前批次的候选：${unknownResolved.join("、")}`);
    const assembled=assembleOntologyDraft({run,candidates,baseSchema:base?.schema||null,excludeCandidateIds,conflictResolutions});
    const validation=semanticSchemas.validate(run.sourceId,assembled.schema);
    const diffBase=base?.schema||{name:validation.schema.name,displayName:validation.schema.displayName,description:validation.schema.description,objectTypes:[],linkTypes:[]};
    const diff=diffSemanticSchemas(validation.schema,diffBase);
    return {run,expectedPublishedId,assembled,validation,diff};
  }

  function validatedRunCatalog(run) {
    const current=catalog(run.sourceId,run.scope.tableNames);
    if(ontologyCatalogChecksum(current)!==run.catalogChecksum)throw httpError(409,"物理目录自生成批次创建后已变化，请重新生成批次");
    return current;
  }
  function runCatalogCurrent(run,cache=new Map()) {
    const tableNames=[...new Set(run?.scope?.tableNames||[])].sort();const key=`${run.sourceId}:${tableNames.join("\u0000")}`;
    let checksum=cache.get(key);if(!checksum){checksum=ontologyCatalogChecksum(catalog(run.sourceId,tableNames));cache.set(key,checksum);}
    return checksum===run.catalogChecksum;
  }
  function runView(run,cache) { return {...run,catalogCurrent:runCatalogCurrent(run,cache)}; }
  function requiredRun(id) { const run=store.getOntologyGenerationRun(id);if(!run)throw httpError(404,"生成批次不存在");return run; }
  function assertSupplementalReady(id) { ensureEnabled(aiConfig);const run=requiredRun(id);if(run.status!=="succeeded")throw httpError(409,"只有已完成 Object 阶段的批次可以补充生成 Link");validatedRunCatalog(run);return run; }
  function getCandidate(id) { const candidate=store.getOntologyCandidate(id);if(!candidate)return null;const calibration=store.listOntologyCandidateCalibrationLabels(candidate.sourceId).find((item)=>item.candidateId===candidate.id)||null;return {...candidate,calibration}; }
  function listCandidates(filters) { const candidates=store.listOntologyCandidates(filters);if(!candidates.length)return candidates;const labels=new Map(store.listOntologyCandidateCalibrationLabels(candidates[0].sourceId).map((item)=>[item.candidateId,item]));return candidates.map((candidate)=>({...candidate,calibration:labels.get(candidate.id)||null})); }


  function acceptedRunObjects(run) {
    const ids=run.scope.scopeKind==="global_links"?run.scope.endpointRunIds||[]:[run.id];
    const tables=new Set(run.scope.tableNames);
    const objects=ids.flatMap(id=>{
      const owner=requiredRun(id);
      validatedRunCatalog(owner);
      if(owner.sourceId!==run.sourceId||id!==run.id&&owner.scope.orchestrationId!==run.scope.orchestrationId)throw httpError(409,"关系端点不属于本次构建");
      return store.listOntologyCandidates({runId:id,candidateType:"object",limit:2000}).filter(item=>ACCEPTED_STATUSES.has(item.status)&&objectTables(item.payload).some(table=>tables.has(table)));
    });
    if(run.scope.scopeKind==="global_links"&&run.baseSchemaVersionId){
      const base=store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema;
      const covered=new Set(objects.flatMap(item=>objectTables(item.payload)));
      for(const payload of base?.objectTypes||[])if(objectTables(payload).every(table=>tables.has(table))&&!objectTables(payload).some(table=>covered.has(table)))objects.push({id:`base:${run.baseSchemaVersionId}:${payload.apiName}`,sourceId:run.sourceId,candidateType:"object",status:"applied",payload,stableKey:createObjectStableKey({namespace:payload.namespace||"default",payload})});
    }
    return objects;
  }

  function buildCandidates(run,endpointRunIds=run.scope.endpointRunIds) {
    const allowed=endpointRunIds?new Set(endpointRunIds):null;
    const cache=new Map();
    const belongs=(item)=>!allowed||(item.scope.scopeKind==="global_links"?(item.scope.endpointRunIds||[]).length===allowed.size&&(item.scope.endpointRunIds||[]).every(id=>allowed.has(id)):allowed.has(item.id));
    return store.listOntologyGenerationRuns(run.sourceId,500).filter(item=>item.scope.orchestrationId===run.scope.orchestrationId&&item.status==="succeeded"&&belongs(item)&&runCatalogCurrent(item,cache)).flatMap(item=>store.listOntologyCandidates({runId:item.id,limit:2000}));
  }
  function coveredRelationIds(items,baseSchema) {
    return new Set([...items.filter(item=>item.candidateType==="link"&&ACCEPTED_STATUSES.has(item.status)).flatMap(item=>item.payload.relationMappings||[]),...(baseSchema?.linkTypes||[]).flatMap(item=>item.relationMappings||[])].map(item=>Number(item.relationId??item)));
  }
  function linkCatalog(run,currentCatalog) {
    if(run.scope.scopeKind!=="global_links")return currentCatalog;
    const allowed=new Set(run.scope.relationIds),base=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
    const covered=coveredRelationIds(buildCandidates(run).filter(item=>item.runId!==run.id),base);
    const links=buildCandidates(run).filter(item=>item.runId!==run.id&&item.candidateType==="link"&&ACCEPTED_STATUSES.has(item.status)).map(item=>item.payload);
    const missing=missingBridgePaths(findBridgeRelationPaths(currentCatalog),[...links,...(base?.linkTypes||[])]);
    return {...currentCatalog,relations:currentCatalog.relations.filter(item=>allowed.has(item.id)),excludedDirectRelationIds:run.scope.pathIds?.length?[...allowed]:[...covered],pathIds:(run.scope.pathIds||[]).filter(id=>missing.some(path=>path.pathId===id))};
  }
  async function completeBuildLinks({sourceId,orchestrationId,runIds,tableNames,actor="system",extraRounds=0,retryPasses=0,verificationRetryPasses=0,clarifiedCandidateIds=[],onProgress=()=>{}}) {
    const objectRuns=runIds.map(requiredRun).filter(run=>run.scope.scopeKind!=="global_links");
    if(!objectRuns.length)return {runIds:[],coverage:{confirmedRelationCount:0,coveredRelationCount:0,missingRelationIds:[]}};
    for(const run of objectRuns)if(run.sourceId!==sourceId||run.scope.orchestrationId!==orchestrationId)throw httpError(409,"关系补充范围与本次构建不一致");
    const selected=catalog(sourceId,tableNames),relations=selected.relations.filter(item=>["confirmed","accepted"].includes(item.status)).sort((a,b)=>a.id-b.id);
    const baseId=objectRuns[0].baseSchemaVersionId,base=baseId?store.getOntologySchemaVersion(baseId)?.schema:null;
    const globalRuns=[],newRuns=new Set(),paths=findBridgeRelationPaths(selected),work=[];
    // Ten relationships need at most twenty endpoint tables per model batch.
    for(let offset=0;offset<relations.length;offset+=10){
      const chunk=relations.slice(offset,offset+10);
      work.push({relationIds:chunk.map(item=>item.id),pathIds:[],domainPlanId:`global-links:${chunk.map(item=>item.id).join(",")}`,endpointTables:[...new Set(chunk.flatMap(item=>[item.fromTable,item.toTable]))]});
    }
    // Six bridge paths need at most eighteen tables, including the bridges.
    for(let offset=0;offset<paths.length;offset+=6){
      const chunk=paths.slice(offset,offset+6);
      work.push({relationIds:[...new Set(chunk.flatMap(item=>item.relationIds))],pathIds:chunk.map(item=>item.pathId),domainPlanId:`global-paths:${chunk.map(item=>item.pathId).join(",")}`,endpointTables:[...new Set(chunk.flatMap(item=>[item.fromTable,item.bridgeTable,item.toTable]))]});
    }
    for(const {relationIds,pathIds,domainPlanId,endpointTables} of work){
      const prior=store.listOntologyGenerationRuns(sourceId,500).filter(item=>item.scope.orchestrationId===orchestrationId&&item.scope.domainPlanId===domainPlanId);
      const reusable=prior.filter(item=>runCatalogCurrent(item)&&JSON.stringify([...(item.scope.endpointRunIds||[])].sort())===JSON.stringify(objectRuns.map(run=>run.id).sort()));
      let run=reusable.find(item=>item.status==="succeeded")||reusable.find(item=>["queued","running"].includes(item.status));
      const covered=coveredRelationIds(buildCandidates(objectRuns[0],objectRuns.map(item=>item.id)),base);
      const links=buildCandidates(objectRuns[0],objectRuns.map(item=>item.id)).filter(item=>item.candidateType==="link"&&ACCEPTED_STATUSES.has(item.status)).map(item=>item.payload);
      const pendingPaths=missingBridgePaths(paths,[...links,...(base?.linkTypes||[])]);
      if(!run&&(pathIds.length?!pathIds.some(id=>pendingPaths.some(path=>path.pathId===id)):relationIds.every(id=>covered.has(id))))continue;
      if(!run){
        run=createRun({sourceId,tableNames:endpointTables,domainName:pathIds.length?"中间表业务关系":"跨域关系补充",orchestrationId,domainPlanId,baseSchemaVersionId:baseId},actor,{taskId:orchestrationId,linkContext:{endpointRunIds:objectRuns.map(item=>item.id),relationIds,pathIds}});
      }
      if(run.status!=="succeeded"){await runGeneration({payload:{runId:run.id},onProgress});newRuns.add(run.id);}
      globalRuns.push(run.id);
    }
    // Give link completion its own bounded budget, and fill omissions before
    // spending it on semantic review. Existing review choices stay stable.
    const remaining=()=>Math.max(0,20*(1+Math.min(2,retryPasses))-store.listOntologyGenerationRuns(sourceId,500).filter(item=>item.scope.orchestrationId===orchestrationId&&item.scope.scopeKind==="global_links").reduce((sum,item)=>sum+Number(item.summary.repairAttempts||0),0));
    for(const id of globalRuns)await refineRun(id,{extraRounds,retryPasses,remainingRounds:remaining(),missingLinksOnly:true,onProgress});
    for(const id of globalRuns)if(newRuns.has(id)||store.listOntologyCandidates({runId:id,limit:2000}).some(item=>clarifiedCandidateIds.includes(item.id)))await refineRun(id,{extraRounds,retryPasses,clarifiedCandidateIds,remainingRounds:remaining(),onProgress});
    for(const id of [...objectRuns.map(run=>run.id),...globalRuns])await verifyAndRepairRun(id,{retryPasses:verificationRetryPasses,repairBusinessQuestions:true,onProgress});
    const covered=coveredRelationIds(buildCandidates(objectRuns[0],objectRuns.map(item=>item.id)),base),missing=relations.filter(item=>!covered.has(item.id));
    const links=buildCandidates(objectRuns[0],objectRuns.map(item=>item.id)).filter(item=>item.candidateType==="link"&&ACCEPTED_STATUSES.has(item.status)).map(item=>item.payload),missingPaths=missingBridgePaths(paths,[...links,...(base?.linkTypes||[])]);
    return {runIds:globalRuns,coverage:{confirmedRelationCount:relations.length,coveredRelationCount:relations.length-missing.length,missingRelationIds:missing.map(item=>item.id),bridgePathCount:paths.length,bridgePathLimitReached:Boolean(paths.truncated),coveredBridgePathCount:paths.length-missingPaths.length,missingBridgePaths:missingPaths.map(({pathId,fromTable,toTable,bridgeTable,relationIds})=>({pathId,fromTable,toTable,bridgeTable,relationIds}))}};
  }

  async function refineRun(runId,{onProgress=()=>{},extraRounds=0,remainingRounds=20,clarifiedCandidateIds=[],missingLinksOnly=false,retryPasses=0,verificationRepairIds=null}={}) {
    ensureEnabled(aiConfig);
    let run=requiredRun(runId);
    if(run.status!=="succeeded")throw httpError(409,"生成完成后才能修正业务定义");
    // Old review-mode runs keep their policy; deployment never confirms them.
    if(run.scope.modelingMode!=="auto_draft")return {skipped:true};
    if(!missingLinksOnly)await verifyRun(runId,{onProgress});
    run=requiredRun(runId);
    let attempts=Number(run.summary.repairAttempts||0);
    const limit=verificationRepairIds?attempts+Math.min(1,remainingRounds):Math.min(2+Math.min(2,Math.max(0,extraRounds))+2*Math.min(2,Math.max(0,retryPasses)),attempts+Math.max(0,remainingRounds));
    while(attempts<limit) {
      const all=store.listOntologyCandidates({runId,limit:2000});
      const clarified=new Set(clarifiedCandidateIds);
      const pending=missingLinksOnly?[]:all.filter((item)=>["review_required","blocked"].includes(item.status)).filter(item=>{
        if(verificationRepairIds)return verificationRepairIds.includes(item.id);
        const verified=currentVerification(item,run);
        if(verified&&["business_question","system_error","checking"].includes(verified.decision)&&!clarified.has(item.id))return false;
        const reasons=item.forcedReviewReasons||[];
        return clarified.has(item.id)||!item.validation?.ok||!reasons.length||reasons.some(reason=>reason!=="MODIFIES_BASE_SCHEMA");
      });
      const summary=summarizeCandidates(all,run.scope.scopeKind==="global_links"?[]:run.scope.tableNames);
      const retained=item=>missingLinksOnly||ACCEPTED_STATUSES.has(item.status)||(usesVerification(run)&&!pending.some(target=>target.id===item.id));
      const uncovered=buildLinkGenerationScope({catalog:linkCatalog(run,validatedRunCatalog(run)),endpoints:acceptedRunObjects(run),namespace:run.scope.namespace,existingStableKeys:all.filter(item=>item.candidateType==="link"&&retained(item)).map(item=>item.stableKey)});
      if(!pending.length&&!summary.objectMissingTableCount&&!uncovered.relations.length)break;
      const currentCatalog=validatedRunCatalog(run);
      const knowledgeSelection=await selectKnowledgePages(run.sourceId,currentCatalog);
      const referencedKnowledge=new Set(pending.flatMap(item=>(currentVerification(item,run)?.supports||[]).flatMap(support=>support.evidenceIds||[])));
      const repairKnowledgePages=[...new Map([...store.listKnowledge(run.sourceId).filter(page=>page.verified&&referencedKnowledge.has(`knowledge:${page.id}`)),...knowledgeSelection.pages].map(page=>[page.id,page])).values()].slice(0,30);
      const targetTables=new Set([...summary.objectMissingTables,...pending.filter((item)=>item.candidateType==="object").flatMap((item)=>(item.payload.properties||[]).map((p)=>p.mapping.table))]);
      const batches=(run.scope.batches||[]).filter((batch)=>batch.tableNames.some((table)=>targetTables.has(table))).map((batch)=>({...batch,tableNames:batch.tableNames.filter((table)=>targetTables.has(table)),tables:batch.tables.filter((table)=>targetTables.has(table.tableName))}));
      const feedback=pending.map((item)=>({definition:item.payload,issues:item.validation?.errors||[],reasons:item.forcedReviewReasons||[],scoreBreakdown:item.scoreBreakdown,evidenceVerification:currentVerification(item,run)}));
      feedback.push({normalizationIssues:run.summary.normalizationIssues||[],missingRelationIds:uncovered.relations.map(item=>item.relationId).filter(Boolean),missingPathIds:uncovered.relations.map(item=>item.pathId).filter(Boolean),missingTables:summary.objectMissingTables,instruction:"补齐有依据的关系。优先按照 evidenceVerification 修复模型自行添加的过度描述、方向标签和名称冲突；不能删除必要业务含义或隐藏冲突。不同已确认路径应分别命名并保留原路径，不要求业务人员二选一。cardinality 以服务端物理关系为准，不得在描述中声称与之相反的基数；contains 仅允许 one_to_one 或 one_to_many，不能将 many_to_one 或 many_to_many 包装为包含多个子对象。普通关联采用 references，只有两端有时间字段且有实际时间语义依据才采用 temporal。修正后仍缺少业务口径时明确说明，不得虚构。"});
      attempts++;
      // Reserve the attempt before the network call; a crash cannot reset it.
      run=store.transitionOntologyGenerationRun({id:runId,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:{...run.summary,repairAttempts:attempts},tokenUsage:run.tokenUsage}).run;
      const phase=`repair-${attempts}`,repairOptions={repair:!missingLinksOnly,allowedRepairIds:usesVerification(run)?pending.map(item=>item.id):null,existingOnly:Boolean(verificationRepairIds)};const onCandidate=async(item)=>(await evaluateBatchAndStore(runId,[item],"model",repairOptions))[0];const onCandidates=(items)=>evaluateBatchAndStore(runId,items,"model",repairOptions);
      try {
        const generated=batches.length?await generator.generateObjects({run:{...run,scope:{...run.scope,batches}},catalog:currentCatalog,knowledgePages:repairKnowledgePages,baseSchema:run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null,feedback,phase,onCandidate,onCandidates,onProgress}):emptyGenerationResult();
        const updated=store.listOntologyCandidates({runId,limit:2000});
        const links=generator.generateLinks?await generator.generateLinks({run,catalog:linkCatalog(run,currentCatalog),endpoints:acceptedRunObjects(run),knowledgePages:repairKnowledgePages,existingStableKeys:updated.filter((item)=>item.candidateType==="link"&&retained(item)).map((item)=>item.stableKey),feedback,phase,onCandidate,onCandidates,onProgress}):emptyGenerationResult();
        const normalizationIssues=[...(run.summary.normalizationIssues||[]),...(generated.normalizationIssues||[]),...(links.normalizationIssues||[])].slice(-100);
        const nextSummary={...run.summary,normalizationIssues,normalizationIssueCount:Number(run.summary.normalizationIssueCount||0)+(generated.normalizationIssues?.length||0)+(links.normalizationIssues?.length||0),...summarizeCandidates(store.listOntologyCandidates({runId,limit:2000}),run.scope.scopeKind==="global_links"?[]:run.scope.tableNames),modelCalls:[...(run.summary.modelCalls||[]),...(generated.calls||[]),...(links.calls||[])],repairAttempts:attempts};
        run=store.transitionOntologyGenerationRun({id:runId,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:nextSummary,tokenUsage:mergeUsage(run.tokenUsage,generated.tokenUsage,links.tokenUsage)}).run;
        if(!missingLinksOnly){await verifyRun(runId,{onProgress});run=requiredRun(runId);}
      } catch(error) {
        store.transitionOntologyGenerationRun({id:runId,expectedStatus:"succeeded",status:"succeeded",progress:100,summary:{...run.summary,lastRepairError:String(error?.message||error),modelCalls:[...(run.summary.modelCalls||[]),...(error.generationCalls||[])]},tokenUsage:mergeUsage(run.tokenUsage,error.generationTokenUsage)});
        throw error;
      }
    }
    return {runId,...run.summary};
  }

  return {
    refineRun,completeBuildLinks,verifyRun,verifyAndRepairRun,reviewIssue,currentVerification,
    catalog,planScope,createRun,evaluateAndStore,runGeneration,runSupplementalLinks,assertSupplementalReady,decide,bulkDecide,merge,preview,apply,
    getRun:(id)=>runView(requiredRun(id),new Map()),
    listRuns:(sourceId,limit=50,offset=0)=>{const cache=new Map();return store.listOntologyGenerationRuns(sourceId,limit,offset).map((run)=>runView(run,cache));},
    listRunsPage:(sourceId,{page=1,pageSize=20}={})=>{const normalizedPage=boundedInteger(page,1,100000,1);const normalizedSize=boundedInteger(pageSize,1,50,20);const total=store.countOntologyGenerationRuns(sourceId);const cache=new Map();const items=store.listOntologyGenerationRuns(sourceId,normalizedSize,(normalizedPage-1)*normalizedSize).map((run)=>runView(run,cache));return {items,total,page:normalizedPage,pageSize:normalizedSize,totalPages:Math.max(1,Math.ceil(total/normalizedSize))};},
    getCandidate,listCandidates,
    listEvents:(candidateId)=>store.listOntologyCandidateEvents(candidateId),
  };
}

export function ontologyCatalogChecksum(catalog) {
  const normalized={
    sourceId:Number(catalog?.sourceId)||null,
    tables:[...(catalog?.tables||[])].map((item)=>({tableName:item.tableName,grade:item.grade,active:item.active,comment:item.comment??null})).sort(byJson),
    columns:Object.entries(catalog?.columnsByTable||{}).sort(([left],[right])=>left.localeCompare(right)).flatMap(([tableName,columns])=>[...columns].map((item)=>({tableName,columnName:item.columnName,dataType:item.dataType,nullable:item.nullable,isSensitive:item.isSensitive,isPrimary:item.isPrimary,isUnique:item.isUnique,isIndexed:item.isIndexed,keyConstraints:item.keyConstraints||[],comment:item.comment??null,...profileIdentity(item.profile)})).sort(byJson)),
    enums:Object.entries(catalog?.enumsByTable||{}).sort(([left],[right])=>left.localeCompare(right)).flatMap(([tableName,items])=>[...items].map((item)=>({tableName,columnName:item.columnName,value:item.value,meaning:item.meaning??null})).sort(byJson)),
    relations:[...(catalog?.relations||[])].map((item)=>({id:item.id,fromTable:item.fromTable,fromCol:item.fromCol,toTable:item.toTable,toCol:item.toCol,columnPairs:relationPairs(item),cardinality:item.cardinality,status:item.status,inferenceSource:item.inferenceSource})).sort(byJson),
    termAnchors:[...(catalog?.termAnchors||[])].map((item)=>({vocabulary:item.vocabulary,canonicalId:item.canonicalId,prefLabelZh:item.prefLabelZh??null,prefLabelEn:item.prefLabelEn??null,altLabels:item.altLabels||[],kind:item.kind,broaderCanonicalId:item.broaderCanonicalId??null})).sort(byJson),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function normalizeCandidatePayload(payload,{candidateType,namespace,catalog}={}) {
  const normalized=structuredClone(payload&&typeof payload==="object"&&!Array.isArray(payload)?payload:{});
  if(candidateType!=="object")return normalized;
  normalized.namespace=normalizeOntologyNamespace(namespace);
  delete normalized.freshness;
  const tableNames=[...new Set((normalized.properties||[]).map((property)=>String(property?.mapping?.table||"").trim()).filter(Boolean))];
  const table=tableNames.length===1?(catalog?.tables||[]).find((item)=>item.tableName===tableNames[0]):null;
  if(isFreshness(table?.freshness))normalized.freshness=table.freshness;
  for(const property of normalized.properties||[]) {
    delete property.freshness;
    const column=(catalog?.columnsByTable?.[property?.mapping?.table]||[]).find((item)=>item.columnName===property?.mapping?.column);
    if(isFreshness(column?.freshness))property.freshness=column.freshness;
  }
  return normalized;
}

function byJson(left,right) { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }
function profileIdentity(profile) {
  if(!profile)return {};
  const content={...profile};delete content.sampledAt;
  return {profileVersion:profile.profileVersion||null,profileDigest:createHash("sha256").update(JSON.stringify(content)).digest("hex")};
}
function emptyGenerationResult() { return {candidates:[],calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[],eligibleRelationCount:0}; }
function mergeUsage(...items) { const total={promptTokens:0,completionTokens:0,totalTokens:0};for(const item of items)for(const key of Object.keys(total))total[key]+=Number(item?.[key]||0);return total; }
function summarizeCandidates(candidates,scopeTableNames=[]) { const objects=candidates.filter((item)=>item.candidateType==="object");const covered=new Set(objects.flatMap((item)=>(item.payload?.properties||[]).map((property)=>String(property?.mapping?.table||"").trim()).filter(Boolean)));const scope=[...new Set((scopeTableNames||[]).map((item)=>String(item).trim()).filter(Boolean))].sort();const missing=scope.filter((tableName)=>!covered.has(tableName));return {candidateCount:candidates.length,objectCount:objects.length,linkCount:candidates.filter((item)=>item.candidateType==="link").length,autoConfirmedCount:candidates.filter((item)=>item.status==="auto_confirmed").length,reviewRequiredCount:candidates.filter((item)=>item.status==="review_required").length,blockedCount:candidates.filter((item)=>item.status==="blocked").length,objectCoveredTableCount:scope.length-missing.length,objectMissingTableCount:missing.length,objectMissingTables:missing}; }
function domainOrchestrationScope(input) { const text=(key)=>String(input?.[key]||"").trim()||null;const positiveInteger=(key)=>{const value=Number(input?.[key]);return Number.isInteger(value)&&value>0?value:null;};return {orchestrationId:text("orchestrationId"),domainPlanId:text("domainPlanId"),domainKey:text("domainKey"),domainBatchIndex:positiveInteger("domainBatchIndex"),domainBatchCount:positiveInteger("domainBatchCount")}; }
function normalizeCandidateIdList(value) { if(value==null)return [];if(!Array.isArray(value))throw httpError(400,"excludeCandidateIds 必须是数组");return [...new Set(value.map((item)=>String(item).trim()).filter(Boolean))]; }
function normalizeConflictResolutions(value) { if(value==null)return {};if(!value||typeof value!=="object"||Array.isArray(value))throw httpError(400,"conflictResolutions 必须是对象");const result={};for(const [candidateId,resolution] of Object.entries(value)){const id=String(candidateId).trim();if(!id)continue;if(!["keep_existing","use_candidate"].includes(resolution))throw httpError(400,`候选 ${id} 的冲突处理值无效`);result[id]=resolution;}return result; }
function withoutSchema(validation) { return {ok:validation.ok,errors:validation.errors,warnings:validation.warnings,summary:validation.summary}; }
function isFreshness(value) { return ["realtime","hourly","daily","batch"].includes(value); }
function normalizeSearchText(value) { return String(value||"").toLowerCase().replace(/\s+/g,""); }
function anchorSearchScore(query,value) { let score=0;for(const token of String(value||"").split(/[\s|,，;；/]+/)){const normalized=normalizeSearchText(token);if(!normalized)continue;if(query.includes(normalized))score+=Math.min(20,normalized.length);else if(normalized.includes(query)&&query.length>1)score+=2;}return score; }
function ensureEnabled(config) { if(config.mode==="off")throw httpError(409,"AI 本体建模功能当前已关闭"); }
function boundedInteger(value,min,max,fallback) { const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback; }
function requireTransition(result) { if(!result.ok)throw httpError(result.reason==="not_found"?404:409,result.reason==="not_found"?"候选不存在":"候选状态已变化，请刷新后重试");return result.candidate; }
function httpError(status,message) { const error=new Error(message);error.status=status;return error; }

function objectTables(payload){return [...new Set((payload?.properties||[]).map(item=>item.mapping?.table).filter(Boolean))];}
