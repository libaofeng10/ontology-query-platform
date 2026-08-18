import { createHash, randomUUID } from "node:crypto";
import {
  createOntologyCandidateScorer,
  cosineSimilarity,
  normalizeOntologyNamespace,
  ONTOLOGY_CANDIDATE_SCORING_VERSION,
} from "./ontology-candidate-score.mjs";
import { buildObjectGenerationScope, ONTOLOGY_OBJECT_PROMPT_VERSION } from "./ontology-candidate-generator.mjs";
import { assembleOntologyDraft } from "./ontology-draft-assembler.mjs";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";
import { callLlmEmbedding } from "./embedding-client.mjs";

const ACCEPTED_STATUSES=new Set(["auto_confirmed","confirmed","applied"]);

export function createOntologyCandidateService({store,config,scorer,generator,critic,embeddingIndex,semanticSchemas,embeddingFetchImpl=globalThis.fetch}={}) {
  if(!store)throw new Error("ontology candidate service 需要 store");
  const aiConfig=config?.ontologyAi||{mode:"off",autoConfirmScore:80,maxTables:20,maxFields:600};
  const candidateScorer=scorer||createOntologyCandidateScorer({embedding:config?.embedding,fetchImpl:embeddingFetchImpl});
  const criticStats=new Map();

  function catalog(sourceId,tableNames=null) {
    const selected=tableNames?new Set(tableNames):null;
    const tables=store.listTables(sourceId).filter((table)=>!selected||selected.has(table.tableName));
    const profilingEnabled=Boolean(config?.profiling?.enabled);
    const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName).map((column)=>profilingEnabled?column:{...column,profile:null})]));
    const enumsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listEnums(sourceId,table.tableName)]));
    const relations=store.listRelations(sourceId,false,true).filter((relation)=>!selected||(selected.has(relation.fromTable)&&selected.has(relation.toTable)));
    const termAnchors=store.listTermAnchors?.()||[];
    return {sourceId,tables,columnsByTable,enumsByTable,relations,termAnchors};
  }

  function prepareGenerationScope(input,{allowEmpty=false}={}) {
    const source=store.getSource(Number(input?.sourceId));
    if(!source)throw httpError(404,"数据源不存在");
    const mode=String(input?.mode||"selected_tables");
    if(mode!=="selected_tables")throw httpError(400,"首期只支持 selected_tables 生成方式");
    const tableNames=[...new Set((input?.tableNames||[]).map((item)=>String(item).trim()).filter(Boolean))].sort();
    const maxTables=boundedInteger(aiConfig.maxTables,1,20,20);
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

  function createRun(input,createdBy,{id=randomUUID(),taskId=null}={}) {
    ensureEnabled(aiConfig);
    const {source,mode,tableNames,maxTables,maxFields,selectedCatalog,generationScope}=prepareGenerationScope(input);
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
    const effectiveAutoConfirmScore=boundedInteger(sourceAutoConfirmScore,0,100,boundedInteger(aiConfig.autoConfirmScore,0,100,80));
    const run=store.createOntologyGenerationRun({
      id,sourceId:source.id,taskId,mode,
      scope:{tableNames,domainName:String(input?.domainName||"").trim(),domainDescription:String(input?.domainDescription||"").trim(),namespace,nonSensitiveFieldCount,batches:generationScope.batches,limits:{maxTables,maxFields},modelingMode:aiConfig.mode,autoConfirmScore:effectiveAutoConfirmScore,embeddingModel,publishedSchemaVersionIdAtStart:publishedAtStart?.id||null,...domainOrchestrationScope(input)},
      catalogChecksum:ontologyCatalogChecksum(selectedCatalog),baseSchemaVersionId,
      modelName:String(config?.llm?.model||"").trim()||null,promptVersion:ONTOLOGY_OBJECT_PROMPT_VERSION,
      scoringVersion:`${ONTOLOGY_CANDIDATE_SCORING_VERSION}:embedding=${embeddingModel}`,createdBy:String(createdBy||"system"),summary:{tableCount:tableNames.length,nonSensitiveFieldCount,includedFieldCount:generationScope.includedFieldCount,truncatedFieldCount:generationScope.truncatedFieldCount,batchCount:generationScope.batchCount,confirmedRelationCount:generationScope.confirmedRelationCount,includedRelationCount:generationScope.includedRelationCount,crossBatchRelationCount:generationScope.crossBatchRelationCount,excludedSensitiveRelationCount:generationScope.excludedSensitiveRelationCount,excludedInvalidRelationCount:generationScope.excludedInvalidRelationCount,candidateCount:0,autoConfirmedCount:0,reviewRequiredCount:0,blockedCount:0},
    });
    return {...run,catalogCurrent:true};
  }

  async function evaluateAndStore(runId,input,actor="system") {
    ensureEnabled(aiConfig);
    const run=requiredRun(runId);
    if(!["queued","running"].includes(run.status)&&!(run.status==="succeeded"&&input?.candidateType==="link"))throw httpError(409,"当前批次状态不允许写入该候选");
    const currentCatalog=validatedRunCatalog(run);
    const acceptedObjects=store.listOntologyCandidates({runId:run.id,candidateType:"object"}).filter((item)=>ACCEPTED_STATUSES.has(item.status));
    const baseSchema=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
    const candidate={...input,payload:normalizeCandidatePayload(input?.payload,{candidateType:input?.candidateType,namespace:run.scope.namespace,catalog:currentCatalog}),sourceId:run.sourceId,namespace:run.scope.namespace};
    const result=await candidateScorer.score(candidate,{sourceId:run.sourceId,catalog:currentCatalog,acceptedObjects,baseSchema,mode:run.scope.modelingMode||aiConfig.mode,autoConfirmScore:run.scope.autoConfirmScore??aiConfig.autoConfirmScore,embeddingModel:run.scope.embeddingModel,scoringVersion:run.scoringVersion});
    if(!result.stableKey)throw httpError(422,"候选无法依据物理映射生成 stableKey，已阻止写入候选表");
    const existing=store.listOntologyCandidates({runId:run.id,candidateType:candidate.candidateType}).find((item)=>item.stableKey===result.stableKey);
    if(existing)return existing;
    return store.createOntologyCandidate({
      id:input?.id||randomUUID(),runId:run.id,sourceId:run.sourceId,candidateType:candidate.candidateType,stableKey:result.stableKey,
      payload:candidate.payload,evidence:Array.isArray(candidate.evidence)?candidate.evidence:[],modelConfidence:Number.isFinite(candidate.modelConfidence)?candidate.modelConfidence:null,
      score:result.score,scoreBreakdown:result.scoreBreakdown,validation:result.validation,status:result.status,forcedReviewReasons:result.forcedReviewReasons,
      actor,eventType:"auto_route",eventNote:result.routeReason,
    });
  }

  async function evaluateBatchAndStore(runId,inputs,actor="system") {
    if(!inputs.length)return [];
    const run=requiredRun(runId);const currentCatalog=validatedRunCatalog(run);const acceptedObjects=store.listOntologyCandidates({runId:run.id,candidateType:"object"}).filter((item)=>ACCEPTED_STATUSES.has(item.status));
    const prepared=inputs.map((input,index)=>({...input,criticId:`${run.id}:${input.candidateType}:${index}:${createHash("sha256").update(JSON.stringify(input.payload||{})).digest("hex").slice(0,12)}`}));
    const inspected=critic?.inspect?await critic.inspect(prepared,{catalog:currentCatalog,acceptedObjects}):{results:new Map(),skipped:true,error:null};
    const stats=criticStats.get(run.id)||{batches:0,flagged:0,skipped:0,errors:[]};stats.batches++;if(inspected.skipped)stats.skipped++;if(inspected.error)stats.errors.push(inspected.error);
    const enriched=prepared.map((input)=>{const result=inspected.results.get(input.criticId);if(result?.consistent===false){stats.flagged++;return {...input,semanticCriticFlagged:true,evidence:[...(input.evidence||[]),{kind:"semantic_critic",refId:`critic:${input.criticId}`,verified:false,consistent:false,issue:result.issue}]};}return input;});
    criticStats.set(run.id,stats);
    const stored=[];for(const input of enriched)stored.push(await evaluateAndStore(runId,input,actor));return stored;
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
      const generated=await generator.generateObjects({run,catalog:generationCatalog,knowledgePages,baseSchema,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress:reportProgress});
      const autoEndpoints=store.listOntologyCandidates({runId:run.id,candidateType:"object"}).filter((candidate)=>candidate.status==="auto_confirmed");
      const existingLinkKeys=store.listOntologyCandidates({runId:run.id,candidateType:"link"}).map((candidate)=>candidate.stableKey);
      const links=generator.generateLinks?await generator.generateLinks({run,catalog:currentCatalog,endpoints:autoEndpoints,knowledgePages,phase:"auto",existingStableKeys:existingLinkKeys,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress:reportProgress}):emptyGenerationResult();
      const candidates=store.listOntologyCandidates({runId:run.id});
      const normalizationIssues=[...generated.normalizationIssues,...links.normalizationIssues];
      const summary={...run.summary,...summarizeCandidates(candidates,run.scope.tableNames),linkEligibleRelationCount:links.eligibleRelationCount,knowledgeRetrievalMode:knowledgeSelection.mode,termAnchorRetrievalMode:termAnchorSelection.mode,termAnchorCount:termAnchorSelection.anchors.length,normalizationIssueCount:normalizationIssues.length,normalizationIssues:normalizationIssues.slice(0,100),critic:criticStats.get(run.id)||{batches:0,flagged:0,skipped:0,errors:[]},modelCalls:[...generated.calls,...links.calls]};
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
      const endpoints=store.listOntologyCandidates({runId:run.id,candidateType:"object"}).filter((candidate)=>ACCEPTED_STATUSES.has(candidate.status));
      const knowledgeSelection=await selectKnowledgePages(run.sourceId,currentCatalog);const knowledgePages=knowledgeSelection.pages;
      const existingLinkKeys=store.listOntologyCandidates({runId:run.id,candidateType:"link"}).map((candidate)=>candidate.stableKey);
      const generated=await generator.generateLinks({run,catalog:currentCatalog,endpoints,knowledgePages,phase:"supplemental",existingStableKeys:existingLinkKeys,onCandidate:(candidate)=>evaluateAndStore(run.id,candidate,"model"),onCandidates:(candidates)=>evaluateBatchAndStore(run.id,candidates,"model"),onProgress});
      const candidates=store.listOntologyCandidates({runId:run.id});const normalizationIssues=[...(run.summary.normalizationIssues||[]),...generated.normalizationIssues].slice(0,100);
      const summary={...run.summary,...summarizeCandidates(candidates,run.scope.tableNames),supplementalLinkEligibleRelationCount:generated.eligibleRelationCount,knowledgeRetrievalMode:knowledgeSelection.mode,normalizationIssueCount:Number(run.summary.normalizationIssueCount||0)+generated.normalizationIssues.length,normalizationIssues,critic:criticStats.get(run.id)||run.summary.critic||{batches:0,flagged:0,skipped:0,errors:[]},modelCalls:[...(run.summary.modelCalls||[]),...generated.calls],lastSupplementalLinkError:null};
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

  async function decide(candidateId,input,actor) {
    const current=store.getOntologyCandidate(candidateId);
    if(!current)throw httpError(404,"候选不存在");
    const decision=String(input?.decision||"");
    if(decision==="reject")return requireTransition(store.transitionOntologyCandidate({id:current.id,expectedStatus:"review_required",status:"rejected",reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:"rejected",note:input?.note||null}));
    if(decision==="withdraw")return requireTransition(store.transitionOntologyCandidate({id:current.id,expectedStatus:"auto_confirmed",status:"review_required",reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:"withdrawn",note:input?.note||null}));
    if(decision!=="confirm")throw httpError(400,"decision 必须是 confirm、reject 或 withdraw");
    if(current.status!=="review_required")throw httpError(409,"只有待人工确认候选可以执行确认");
    const run=requiredRun(current.runId);const currentCatalog=validatedRunCatalog(run);
    const edited=input?.candidate!=null;
    const payload=normalizeCandidatePayload(edited?input.candidate:current.payload,{candidateType:current.candidateType,namespace:run.scope.namespace,catalog:currentCatalog});
    const acceptedObjects=store.listOntologyCandidates({runId:run.id,candidateType:"object"}).filter((item)=>ACCEPTED_STATUSES.has(item.status));
    const baseSchema=run.baseSchemaVersionId?store.getOntologySchemaVersion(run.baseSchemaVersionId)?.schema:null;
    const rescored=await candidateScorer.score({...current,payload,namespace:run.scope.namespace},{sourceId:run.sourceId,catalog:currentCatalog,acceptedObjects,baseSchema,mode:"review",autoConfirmScore:run.scope.autoConfirmScore??aiConfig.autoConfirmScore,embeddingModel:run.scope.embeddingModel,scoringVersion:run.scoringVersion});
    if(!rescored.validation.ok)throw httpError(422,"人工修订后的候选未通过确定性校验");
    if(rescored.stableKey!==current.stableKey)throw httpError(409,"人工修订改变了 stableKey 所依赖的物理映射，请重新生成候选");
    return requireTransition(store.transitionOntologyCandidate({
      id:current.id,expectedStatus:"review_required",status:"confirmed",payload,score:rescored.score,scoreBreakdown:rescored.scoreBreakdown,
      validation:rescored.validation,forcedReviewReasons:rescored.forcedReviewReasons,reviewedBy:actor,decisionNote:input?.note||null,actor,eventType:edited?"edited_and_confirmed":"confirmed",note:input?.note||null,
    }));
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

  return {
    catalog,planScope,createRun,evaluateAndStore,runGeneration,runSupplementalLinks,assertSupplementalReady,decide,bulkDecide,merge,preview,apply,
    getRun:(id)=>runView(requiredRun(id),new Map()),listRuns:(sourceId)=>{const cache=new Map();return store.listOntologyGenerationRuns(sourceId).map((run)=>runView(run,cache));},
    getCandidate,listCandidates,
    listEvents:(candidateId)=>store.listOntologyCandidateEvents(candidateId),
  };
}

export function ontologyCatalogChecksum(catalog) {
  const normalized={
    sourceId:Number(catalog?.sourceId)||null,
    tables:[...(catalog?.tables||[])].map((item)=>({tableName:item.tableName,grade:item.grade,active:item.active,comment:item.comment??null})).sort(byJson),
    columns:Object.entries(catalog?.columnsByTable||{}).sort(([left],[right])=>left.localeCompare(right)).flatMap(([tableName,columns])=>[...columns].map((item)=>({tableName,columnName:item.columnName,dataType:item.dataType,nullable:item.nullable,isSensitive:item.isSensitive,isPrimary:item.isPrimary,isUnique:item.isUnique,isIndexed:item.isIndexed,comment:item.comment??null,...profileIdentity(item.profile)})).sort(byJson)),
    enums:Object.entries(catalog?.enumsByTable||{}).sort(([left],[right])=>left.localeCompare(right)).flatMap(([tableName,items])=>[...items].map((item)=>({tableName,columnName:item.columnName,value:item.value,meaning:item.meaning??null})).sort(byJson)),
    relations:[...(catalog?.relations||[])].map((item)=>({id:item.id,fromTable:item.fromTable,fromCol:item.fromCol,toTable:item.toTable,toCol:item.toCol,cardinality:item.cardinality,status:item.status,inferenceSource:item.inferenceSource})).sort(byJson),
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
