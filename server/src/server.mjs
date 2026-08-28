import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { config } from "./config.mjs";
import { authenticate, authorize, canAccessSource, createRateLimiter } from "./auth.mjs";
import { encryptCredential } from "./crypto.mjs";
import { createConnector } from "./db-connector.mjs";
import { seedDemo } from "./demo-seed.mjs";
import { createDiscoveryService } from "./discovery-service.mjs";
import { createQueryService } from "./query-service.mjs";
import { createKnowledgeService } from "./knowledge-service.mjs";
import { createTaskService } from "./task-service.mjs";
import { createEvaluationService } from "./evaluation-service.mjs";
import { createStore } from "./store.mjs";
import { createOntologyGraphService } from "./ontology-graph-service.mjs";
import { createCapabilityGapService } from "./capability-gap-service.mjs";
import { createKnowledgeProposalService } from "./knowledge-proposal-service.mjs";
import { createOntologyCandidateGenerator } from "./ontology-candidate-generator.mjs";
import { createOntologyCandidateService } from "./ontology-candidate-service.mjs";
import { createOntologyCalibrationService } from "./ontology-calibration-service.mjs";
import { createOntologyGenerationAuditService } from "./ontology-generation-audit-service.mjs";
import { createSemanticSchemaService } from "./semantic-schema-service.mjs";
import { analyzeSemanticSchemaImpact } from "./semantic-schema-impact.mjs";
import { hasSemanticHierarchyChanges, semanticSubtypeNames } from "./semantic-schema-diff.mjs";
import { createSettingsService } from "./settings-service.mjs";
import { createEmbeddingIndex } from "./embedding-index.mjs";
import { callLlmJson } from "./llm-client.mjs";
import { callLlmEmbedding } from "./embedding-client.mjs";
import { applySensitiveCatalogMigration } from "./sensitive-catalog-migration.mjs";
import { applyEnumCatalogMigration } from "./enum-catalog-migration.mjs";
import { createRelationDocumentService } from "./relation-document-service.mjs";
import { createOntologyCandidateCritic } from "./ontology-candidate-critic.mjs";
import { createOntologyDomainPlanner } from "./ontology-domain-plan.mjs";
import { createOntologyDomainModelingService } from "./ontology-domain-modeling-service.mjs";
import { createOntologyDomainDraftService } from "./ontology-domain-draft-service.mjs";
import { detectSensitiveValue } from "./column-profile.mjs";

export function createApp(overrides={}) {
  const runtime={...config,...overrides,rateLimits:{...config.rateLimits,...overrides.rateLimits},ontologyAi:{...config.ontologyAi,...overrides.ontologyAi}};
  const store=overrides.store||createStore(runtime.dbPath);seedDemo(store,runtime.appSecret);
  const sensitiveCatalogMigration=applySensitiveCatalogMigration(store);
  const enumCatalogMigration=applyEnumCatalogMigration(store);
  const settings=createSettingsService({store,baseConfig:runtime,appSecret:runtime.appSecret,lockedKeys:lockedSettingKeys(overrides)});
  const settingsConfig=settings.config;
  const connector=overrides.connector||createConnector({appSecret:runtime.appSecret,timeoutMs:()=>settingsConfig.queryTimeoutMs});
  const embeddingIndex=overrides.embeddingIndex||createEmbeddingIndex({store,settings,fetchImpl:overrides.embeddingFetchImpl});
  const discovery=createDiscoveryService({store,connector,wikiDir:runtime.wikiDir,config:settingsConfig,relationModel:overrides.relationModelService});
  const relationDocuments=overrides.relationDocumentService||createRelationDocumentService({store,connector,wikiDir:runtime.wikiDir,llm:settingsConfig.llm,fetchImpl:overrides.llmFetchImpl,timeoutMs:settingsConfig.relationModel?.timeoutMs||90_000,sampleLimit:settingsConfig.relationModel?.sampleLimit||500,overlapTimeoutMs:settingsConfig.relationModel?.overlapTimeoutMs||10_000});
  const knowledge=createKnowledgeService({store,wikiDir:runtime.wikiDir,embeddingIndex});
  const semanticSchemas=createSemanticSchemaService({store});
  const ontologyGenerator=overrides.ontologyCandidateGenerator||createOntologyCandidateGenerator({llm:settingsConfig.llm,fetchImpl:overrides.llmFetchImpl,timeoutMs:()=>settingsConfig.ontologyAi.timeoutMs,auditDir:runtime.ontologyAi?.auditDir});
  const ontologyCritic=overrides.ontologyCandidateCritic||createOntologyCandidateCritic({llm:settingsConfig.llm,fetchImpl:overrides.llmFetchImpl,timeoutMs:()=>settingsConfig.ontologyAi.timeoutMs,enabled:()=>settingsConfig.ontologyAi.criticEnabled});
  const ontologyCandidates=createOntologyCandidateService({store,config:settingsConfig,scorer:overrides.ontologyCandidateScorer,generator:ontologyGenerator,critic:ontologyCritic,embeddingIndex,semanticSchemas,embeddingFetchImpl:overrides.embeddingFetchImpl});
  const ontologyCalibration=createOntologyCalibrationService({store,config:settingsConfig,settings});
  const ontologyDomainPlanner=overrides.ontologyDomainPlanner||createOntologyDomainPlanner({store,config:settingsConfig,fetchImpl:overrides.llmFetchImpl});
  const ontologyDomainModeling=createOntologyDomainModelingService({domainPlanner:ontologyDomainPlanner,candidates:ontologyCandidates});
  const ontologyDomainDrafts=createOntologyDomainDraftService({store,candidates:ontologyCandidates,semanticSchemas});
  const ontologyGenerationAudits=createOntologyGenerationAuditService({auditDir:runtime.ontologyAi.auditDir});
  const graph=createOntologyGraphService({store,knowledge});
  const capabilityGaps=createCapabilityGapService({store});
  const queries=createQueryService({store,connector,config:settingsConfig,embeddingIndex});
  const evaluation=createEvaluationService({store,connector,queries,config:settingsConfig});
  // evaluation depends on queries, so the proposal wiring is backfilled after both exist.
  const knowledgeProposals=overrides.knowledgeProposalService||createKnowledgeProposalService({store,config:settingsConfig,knowledge,fetchImpl:overrides.llmFetchImpl});
  queries.setDependencies({knowledge,evaluation,proposalService:knowledgeProposals});
  const tasks=createTaskService({store,discovery,handlers:{evaluation:evaluation.run,evaluation_gate:evaluation.runGate,evaluation_agent_gate:evaluation.runAgentGate,ontology_generation:ontologyCandidates.runGeneration,ontology_link_generation:ontologyCandidates.runSupplementalLinks,ontology_domain_modeling:ontologyDomainModeling.run,embedding_reindex:({source,onProgress})=>embeddingIndex.reindex(source.id,{onProgress:({done,total,currentStep})=>onProgress({progress:done,total:Math.max(total,1),currentStep})})}});tasks.recover();
  const limiter=createRateLimiter();

  async function handler(req,res) {
    const requestId=String(req.headers["x-request-id"]||randomUUID());setSecurityHeaders(req,res,runtime,requestId);
    if(req.method==="OPTIONS")return send(res,204,null);
    const url=new URL(req.url,"http://localhost");
    try {
      if(req.method==="GET"&&url.pathname==="/api/health")return send(res,200,{ok:true,service:"ontology-query-api",time:new Date().toISOString(),requestId});
      if(req.method==="GET"&&url.pathname==="/api/ready"){store.db.prepare("SELECT 1").get();return send(res,200,{ok:true,store:"ready",sensitiveFieldRules:{version:sensitiveCatalogMigration.version,promotedColumns:sensitiveCatalogMigration.promotedColumns,skipped:sensitiveCatalogMigration.skipped},enumDictionaryRules:{version:enumCatalogMigration.version,removedColumns:enumCatalogMigration.removedColumns,removedHumanMeanings:enumCatalogMigration.removedHumanMeanings,skipped:enumCatalogMigration.skipped},requestId});}
      const identity=authenticate(req,runtime);applyRateLimit(req,res,url,identity,runtime,limiter);

      if(req.method==="GET"&&url.pathname==="/api/bootstrap"){
        authorize(identity,"viewer");const sources=visibleSources(store,identity);const requested=Number(url.searchParams.get("sourceId")||sources[0]?.id||0);if(requested)authorize(identity,"viewer",requested);
        return send(res,200,{sources,sourceId:requested,discovery:requested?discovery.summary(requested):null,questions:requested?store.listQuestions(requested):[],knowledge:requested?knowledge.list(requested):[],graph:requested?graph.build(requested):null,audits:requested&&roleAtLeast(identity,"editor")?store.listAudits(requested,100):[],auditStats:requested&&roleAtLeast(identity,"editor")?store.auditStats(requested):null,evalCases:requested?store.listEvalCases(requested):[],evalRuns:requested?evaluation.listRuns(requested):[],evalGates:requested?evaluation.listGates(requested):[],tasks:requested?tasks.list(requested):[],schemaSnapshots:requested?store.listSchemaSnapshots(requested):[],identity:{name:identity.name,role:identity.role}});
      }
      if(req.method==="GET"&&url.pathname==="/api/sources"){authorize(identity,"viewer");return send(res,200,visibleSources(store,identity));}
      if(req.method==="POST"&&url.pathname==="/api/sources"){authorize(identity,"admin");const body=await readJson(req);validateSource(body);const source=store.createSource({name:body.name,kind:"mysql",host:body.host,port:Number(body.port||3306),dbName:body.dbName,userName:body.userName,credential:encryptCredential(body.password,runtime.appSecret),isDemo:false});return send(res,201,withoutCredential(source));}
      const relationDocsMatch=url.pathname.match(/^\/api\/sources\/(\d+)\/relation-docs$/);if(relationDocsMatch){const source=requiredSource(store,identity,Number(relationDocsMatch[1]),req.method==="POST"?"editor":"viewer");if(req.method==="GET")return send(res,200,relationDocuments.list(source.id));if(req.method==="POST")return send(res,201,await relationDocuments.upload(source,await readJson(req),identity.name));}

      const sourceTest=url.pathname.match(/^\/api\/sources\/(\d+)\/test$/);if(req.method==="POST"&&sourceTest){const source=requiredSource(store,identity,sourceTest[1],"editor");try{const result=await connector.test(source);store.markSourceTest(source.id,true);return send(res,200,result);}catch(error){store.markSourceTest(source.id,false,safeError(error));throw error;}}
      const credentialMatch=url.pathname.match(/^\/api\/sources\/(\d+)\/credential$/);if(req.method==="POST"&&credentialMatch){const source=requiredSource(store,identity,credentialMatch[1],"admin");if(source.isDemo)throw badRequest("演示数据源不支持凭据轮换");const body=await readJson(req);if(!body.password||typeof body.password!=="string")throw badRequest("password 必填");store.updateSourceCredential(source.id,encryptCredential(body.password,runtime.appSecret));await connector.invalidate?.(source.id);return send(res,200,{ok:true,sourceId:source.id,requiresRetest:true});}
      const sourceDiscover=url.pathname.match(/^\/api\/sources\/(\d+)\/discover$/);if(req.method==="POST"&&sourceDiscover){const source=requiredSource(store,identity,sourceDiscover[1],"editor");if(!source.isDemo&&source.lastTestOk!==1)throw badRequest("真实数据源必须先通过只读连接测试");return send(res,202,tasks.createDiscoveryTask(source));}
      const sourceDiscovery=url.pathname.match(/^\/api\/sources\/(\d+)\/discovery$/);if(req.method==="GET"&&sourceDiscovery){requiredSource(store,identity,sourceDiscovery[1]);return send(res,200,discovery.summary(Number(sourceDiscovery[1])));}
      const gradeMatch=url.pathname.match(/^\/api\/sources\/(\d+)\/tables\/([^/]+)\/grade$/);if(req.method==="POST"&&gradeMatch){const source=requiredSource(store,identity,gradeMatch[1],"editor");const body=await readJson(req);if(!["A","B","C"].includes(body.grade))throw badRequest("grade 只允许 A、B、C");const changes=store.setTableGrade(source.id,decodeURIComponent(gradeMatch[2]),body.grade);if(!changes)throw notFound("表不存在");store.closeQuestionsOnExcludedTables(source.id);await discovery.writeOntology(source.id);return send(res,200,discovery.summary(source.id));}

      if(req.method==="GET"&&url.pathname==="/api/tasks"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,tasks.list(sourceId));}
      const taskMatch=url.pathname.match(/^\/api\/tasks\/([^/]+)$/);if(req.method==="GET"&&taskMatch){const task=tasks.get(decodeURIComponent(taskMatch[1]));if(!task)throw notFound("任务不存在");authorize(identity,"viewer",task.sourceId);return send(res,200,task);}
      if(req.method==="GET"&&url.pathname==="/api/questions"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,store.listQuestions(sourceId));}
      const answerMatch=url.pathname.match(/^\/api\/questions\/(\d+)\/answer$/);if(req.method==="POST"&&answerMatch){const body=await readJson(req);const answer=typeof body.answer==="string"?body.answer.trim():"";if(!answer)throw badRequest("answer 必须是非空字符串");const question=store.getQuestion(Number(answerMatch[1]));if(!question)throw notFound("问题不存在");authorize(identity,"editor",question.sourceId);if(question.kind==="枚举含义"){const result=store.answerEnumQuestion(question.id,answer,identity.name);if(!result.ok){if(result.reason==="not_found")throw notFound("问题不存在");if(["invalid_options","answer_not_allowed"].includes(result.reason))throw badRequest("枚举答案必须是问题 options 中明确列出的选项");if(result.reason==="invalid_binding")throw conflict("枚举问题缺少结构化值绑定，无法安全写回");if(result.reason==="meaning_conflict")throw conflict("该枚举值已有不同的人工含义，当前问题已过期");throw conflict("问题已被回答或已失效");}}else{const changes=store.answerQuestion(question.id,answer,identity.name);if(changes!==1)throw conflict("问题已被回答或已失效");if(question.kind==="JOIN 路径"&&question.relationId){if(/^确认/.test(answer))store.setRelationStatus(question.relationId,"confirmed");else if(/^不允许/.test(answer))store.setRelationStatus(question.relationId,"denied");}else if(question.kind==="JOIN 路径"&&/^确认/.test(answer))store.confirmRelationByColumn(question.sourceId,question.tableName,question.columnName);if(question.scope==="global"&&/^全部/.test(answer))store.addRule({sourceId:question.sourceId,name:question.question.replace(/[？?]/g,""),content:`字段族 ${question.columnName||"amount"} 统一按分存储，查询展示时除以 100.0`,appliesTo:question.tableName,verified:1});}await discovery.writeOntology(question.sourceId);return send(res,200,{ok:true,remaining:store.listQuestions(question.sourceId).length});}

      if(req.method==="GET"&&url.pathname==="/api/knowledge"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,knowledge.list(sourceId));}
      if(req.method==="GET"&&url.pathname==="/api/graph"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,graph.build(sourceId));}
      if(req.method==="POST"&&url.pathname==="/api/knowledge"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,201,await knowledge.save(sourceId,body));}
      if(req.method==="POST"&&url.pathname==="/api/knowledge/sync"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,200,await knowledge.sync(sourceId));}
      const knowledgeMatch=url.pathname.match(/^\/api\/knowledge\/(\d+)\/([^/]+)\/([^/]+)$/);if(req.method==="GET"&&knowledgeMatch){requiredSource(store,identity,knowledgeMatch[1]);const page=knowledge.get(Number(knowledgeMatch[1]),decodeURIComponent(knowledgeMatch[2]),decodeURIComponent(knowledgeMatch[3]));if(!page)throw notFound("知识页面不存在");return send(res,200,page);}

      if(req.method==="GET"&&url.pathname==="/api/ontology/schemas"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,semanticSchemas.list(sourceId));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/catalog"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,semanticSchemas.catalog(sourceId));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/term-anchors"){authorize(identity,"viewer");return send(res,200,store.listTermAnchors(url.searchParams.get("vocabulary")||null));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/term-anchors"){authorize(identity,"admin");const body=await readJson(req);const items=Array.isArray(body.items)?body.items:[body];if(!items.length||items.length>2_000)throw badRequest("术语锚点单次最多导入 2000 条");assertTermAnchorsSafe(items);return send(res,201,{count:items.length,items:items.map((item)=>store.upsertTermAnchor(item))});}
      if(req.method==="POST"&&url.pathname==="/api/ontology/term-anchors/import"){authorize(identity,"admin");const body=await readJson(req);const items=parseTermAnchorCsv(body.csv,body.vocabulary);if(!items.length||items.length>2_000)throw badRequest("CSV 必须包含 1 到 2000 条术语锚点");assertTermAnchorsSafe(items);return send(res,201,{count:items.length,items:items.map((item)=>store.upsertTermAnchor(item))});}
      if(req.method==="GET"&&url.pathname==="/api/ontology/domain-plan"){const refresh=url.searchParams.get("refresh")==="1";const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"),refresh?"editor":"viewer");return send(res,200,await ontologyDomainPlanner.plan(sourceId,{refresh,actor:identity.name}));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/domain-modeling"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");const active=store.findActiveTask(sourceId,"ontology_domain_modeling");if(active)return send(res,202,active);ontologyDomainModeling.assertReady(sourceId);const orchestrationId=String(body.orchestrationId||"").trim()||null;if(orchestrationId){const original=store.getTask(orchestrationId);if(!original||original.taskType!=="ontology_domain_modeling"||Number(original.sourceId)!==Number(sourceId))throw badRequest("待恢复的全域建模任务不存在或不属于当前数据源");}return send(res,202,tasks.create({sourceId,taskType:"ontology_domain_modeling",payload:{refreshDomainPlan:body.refreshDomainPlan!==false,domainIds:Array.isArray(body.domainIds)?body.domainIds:[],orchestrationId,actor:identity.name}}));}
      const ontologyDomainWorkflowMatch=url.pathname.match(/^\/api\/ontology\/domain-modeling\/([^/]+)\/(summary|preview|apply|repair|retry-failed)$/);
      if(ontologyDomainWorkflowMatch){const orchestrationId=decodeURIComponent(ontologyDomainWorkflowMatch[1]);const action=ontologyDomainWorkflowMatch[2];const workflow=ontologyDomainDrafts.summary(orchestrationId);authorize(identity,action==="summary"?"viewer":"editor",workflow.sourceId);if(req.method==="GET"&&action==="summary")return send(res,200,workflow);if(req.method==="POST"&&action==="preview")return send(res,200,ontologyDomainDrafts.preview(orchestrationId,await readJson(req)));if(req.method==="POST"&&action==="apply")return send(res,201,ontologyDomainDrafts.apply(orchestrationId,await readJson(req),identity.name));if(req.method==="POST"&&action==="repair")return send(res,201,ontologyDomainDrafts.repair(orchestrationId,identity.name));if(req.method==="POST"&&action==="retry-failed"){const domainIds=ontologyDomainDrafts.failedDomainIds(orchestrationId);if(!domainIds.length)throw badRequest("当前没有失败域需要重试");const active=store.findActiveTask(workflow.sourceId,"ontology_domain_modeling");if(active)return send(res,202,active);ontologyDomainModeling.assertReady(workflow.sourceId);return send(res,202,tasks.create({sourceId:workflow.sourceId,taskType:"ontology_domain_modeling",payload:{refreshDomainPlan:false,domainIds,orchestrationId,actor:identity.name}}));}}
      if(req.method==="POST"&&url.pathname==="/api/ontology/generation-scope"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,200,ontologyCandidates.planScope({...body,sourceId}));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/generation-runs"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");const taskId=randomUUID();const run=ontologyCandidates.createRun({...body,sourceId},identity.name,{taskId});tasks.create({id:taskId,sourceId,taskType:"ontology_generation",payload:{runId:run.id}});return send(res,202,run);}
      if(req.method==="GET"&&url.pathname==="/api/ontology/generation-runs"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));if(url.searchParams.has("page")||url.searchParams.has("pageSize"))return send(res,200,ontologyCandidates.listRunsPage(sourceId,{page:url.searchParams.get("page"),pageSize:url.searchParams.get("pageSize")}));return send(res,200,ontologyCandidates.listRuns(sourceId));}
      const ontologyRunMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)$/);if(req.method==="GET"&&ontologyRunMatch){const run=ontologyCandidates.getRun(decodeURIComponent(ontologyRunMatch[1]));authorize(identity,"viewer",run.sourceId);return send(res,200,run);}
      const ontologyRunTracesMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)\/traces$/);if(req.method==="GET"&&ontologyRunTracesMatch){const run=ontologyCandidates.getRun(decodeURIComponent(ontologyRunTracesMatch[1]));authorize(identity,"editor",run.sourceId);return send(res,200,await ontologyGenerationAudits.list(run.id));}
      const ontologyRunTraceMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)\/traces\/([^/]+)$/);if(req.method==="GET"&&ontologyRunTraceMatch){const run=ontologyCandidates.getRun(decodeURIComponent(ontologyRunTraceMatch[1]));authorize(identity,"editor",run.sourceId);return send(res,200,await ontologyGenerationAudits.get(run.id,decodeURIComponent(ontologyRunTraceMatch[2])));}
      const ontologyRunLinksMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)\/links$/);if(req.method==="POST"&&ontologyRunLinksMatch){const runId=decodeURIComponent(ontologyRunLinksMatch[1]);const existing=ontologyCandidates.getRun(runId);authorize(identity,"editor",existing.sourceId);const run=ontologyCandidates.assertSupplementalReady(runId);return send(res,202,tasks.create({sourceId:run.sourceId,taskType:"ontology_link_generation",payload:{runId:run.id}}));}
      const ontologyRunPreviewMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)\/preview$/);if(req.method==="POST"&&ontologyRunPreviewMatch){const run=ontologyCandidates.getRun(decodeURIComponent(ontologyRunPreviewMatch[1]));authorize(identity,"editor",run.sourceId);return send(res,200,ontologyCandidates.preview(run.id,await readJson(req)));}
      const ontologyRunApplyMatch=url.pathname.match(/^\/api\/ontology\/generation-runs\/([^/]+)\/apply$/);if(req.method==="POST"&&ontologyRunApplyMatch){const runId=decodeURIComponent(ontologyRunApplyMatch[1]);const run=ontologyCandidates.getRun(runId);authorize(identity,"editor",run.sourceId);return send(res,201,ontologyCandidates.apply(run.id,await readJson(req),identity.name));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/candidates"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,ontologyCandidates.listCandidates({sourceId,runId:url.searchParams.get("runId")||null,status:url.searchParams.get("status")||null,candidateType:url.searchParams.get("candidateType")||null}));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/candidates/bulk-decision"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,200,await ontologyCandidates.bulkDecide({...body,sourceId},identity.name));}
      const ontologyCandidateMatch=url.pathname.match(/^\/api\/ontology\/candidates\/([^/]+)$/);if(req.method==="GET"&&ontologyCandidateMatch){const candidate=ontologyCandidates.getCandidate(decodeURIComponent(ontologyCandidateMatch[1]));if(!candidate)throw notFound("本体候选不存在");authorize(identity,"viewer",candidate.sourceId);return send(res,200,candidate);}
      const ontologyCandidateEventsMatch=url.pathname.match(/^\/api\/ontology\/candidates\/([^/]+)\/events$/);if(req.method==="GET"&&ontologyCandidateEventsMatch){const candidate=ontologyCandidates.getCandidate(decodeURIComponent(ontologyCandidateEventsMatch[1]));if(!candidate)throw notFound("本体候选不存在");authorize(identity,"viewer",candidate.sourceId);return send(res,200,ontologyCandidates.listEvents(candidate.id));}
      const ontologyCandidateDecisionMatch=url.pathname.match(/^\/api\/ontology\/candidates\/([^/]+)\/decision$/);if(req.method==="POST"&&ontologyCandidateDecisionMatch){const candidate=ontologyCandidates.getCandidate(decodeURIComponent(ontologyCandidateDecisionMatch[1]));if(!candidate)throw notFound("本体候选不存在");authorize(identity,"editor",candidate.sourceId);return send(res,200,await ontologyCandidates.decide(candidate.id,await readJson(req),identity.name));}
      const ontologyCandidateMergeMatch=url.pathname.match(/^\/api\/ontology\/candidates\/([^/]+)\/merge$/);if(req.method==="POST"&&ontologyCandidateMergeMatch){const candidate=ontologyCandidates.getCandidate(decodeURIComponent(ontologyCandidateMergeMatch[1]));if(!candidate)throw notFound("本体候选不存在");authorize(identity,"editor",candidate.sourceId);return send(res,200,ontologyCandidates.merge(candidate.id,await readJson(req),identity.name));}
      const ontologyCandidateCalibrationMatch=url.pathname.match(/^\/api\/ontology\/candidates\/([^/]+)\/calibration$/);if(req.method==="POST"&&ontologyCandidateCalibrationMatch){const candidate=ontologyCandidates.getCandidate(decodeURIComponent(ontologyCandidateCalibrationMatch[1]));if(!candidate)throw notFound("本体候选不存在");authorize(identity,"editor",candidate.sourceId);return send(res,200,ontologyCalibration.label(candidate.id,await readJson(req),identity.name));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/calibration"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));const runIds=url.searchParams.getAll("runId");return send(res,200,ontologyCalibration.report(sourceId,{...(runIds.length?{runIds}:{}),manualObjectCount:url.searchParams.get("manualObjectCount")||0}));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/calibration/gates"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,ontologyCalibration.listGates(sourceId));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/calibration/gates"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,201,ontologyCalibration.createGate(sourceId,body,identity.name));}
      const ontologyCalibrationActivateMatch=url.pathname.match(/^\/api\/ontology\/calibration\/gates\/([^/]+)\/activate$/);if(req.method==="POST"&&ontologyCalibrationActivateMatch){authorize(identity,"admin");const gate=store.getOntologyCalibrationGate(decodeURIComponent(ontologyCalibrationActivateMatch[1]));if(!gate)throw notFound("校准门禁不存在");authorize(identity,"admin",gate.sourceId);return send(res,200,ontologyCalibration.activate(gate.id,identity.name));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/calibration/threshold/adopt"){authorize(identity,"admin");const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"admin");return send(res,200,ontologyCalibration.adoptThreshold(sourceId,body,identity.name));}
      if(req.method==="GET"&&url.pathname==="/api/ontology/published"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));const record=semanticSchemas.getPublished(sourceId);if(!record)throw notFound("当前数据源还没有已发布的业务本体 Schema");return send(res,200,record);}
      if(req.method==="POST"&&url.pathname==="/api/ontology/validate"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,200,semanticSchemas.validate(sourceId,body.schema));}
      if(req.method==="POST"&&url.pathname==="/api/ontology/schemas"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,201,semanticSchemas.saveDraft(sourceId,body.schema,identity.name));}
      const ontologySchemaMatch=url.pathname.match(/^\/api\/ontology\/schemas\/(\d+)$/);if(req.method==="GET"&&ontologySchemaMatch){const record=semanticSchemas.get(Number(ontologySchemaMatch[1]));if(!record)throw notFound("业务本体 Schema 版本不存在");authorize(identity,"viewer",record.sourceId);return send(res,200,record);}
      const ontologyDiffMatch=url.pathname.match(/^\/api\/ontology\/schemas\/(\d+)\/diff$/);if(req.method==="GET"&&ontologyDiffMatch){const record=semanticSchemas.get(Number(ontologyDiffMatch[1]));const base=semanticSchemas.get(Number(url.searchParams.get("against")));if(!record||!base)throw notFound("用于比较的业务本体 Schema 版本不存在");authorize(identity,"viewer",record.sourceId);authorize(identity,"viewer",base.sourceId);if(record.sourceId!==base.sourceId)throw badRequest("只能比较同一数据源的 Schema 版本");const cases=store.listEvalCasesForImpact(record.sourceId);const impact=analyzeSemanticSchemaImpact(record.schema,base.schema,{cases,relations:store.listRelations(record.sourceId,false,true)});const subtypeNames=new Set(semanticSubtypeNames(record.schema));const gateEvidence=impact.affectedSets.map((setName)=>{const setCases=cases.filter((item)=>item.setName===setName);const gate=store.findPassedEvalGate(record.sourceId,setName,record.version,evalSetChecksum(setCases));const subtypeRootObjects=(gate?.candidate?.subtypeRootObjects||[]).filter((name)=>subtypeNames.has(name));return {setName,passed:Boolean(gate),gateId:gate?.id||null,createdAt:gate?.createdAt||null,subtypeRootObjects};});const hierarchyChanged=hasSemanticHierarchyChanges(record.schema,base.schema);const subtypeRootCoverage=[...new Set(gateEvidence.flatMap((item)=>item.subtypeRootObjects))];const subtypeRootCoverageMissing=hierarchyChanged&&!subtypeRootCoverage.length;const readyToPublish=impact.summary.requiresEvaluation&&!impact.uncoveredChanges.length&&gateEvidence.every((item)=>item.passed)&&!subtypeRootCoverageMissing;return send(res,200,{sourceId:record.sourceId,currentVersion:record.version,baseVersion:base.version,...impact.diff,evaluationImpact:{summary:{...impact.summary,hierarchyChanged,subtypeRootCoverageMissing,readyToPublish},affectedCases:impact.affectedCases,affectedSets:impact.affectedSets,uncoveredChanges:impact.uncoveredChanges,gateEvidence,subtypeRootCoverage}});}
      const ontologyPublishMatch=url.pathname.match(/^\/api\/ontology\/schemas\/(\d+)\/publish$/);if(req.method==="POST"&&ontologyPublishMatch){const record=semanticSchemas.get(Number(ontologyPublishMatch[1]));if(!record)throw notFound("业务本体 Schema 版本不存在");authorize(identity,"editor",record.sourceId);const result=semanticSchemas.publish(record.id,identity.name);const status=result.ok?200:result.gateRequired?409:422;return send(res,status,result.ok?result:{error:result.gateRequired?"发布前评测门禁尚未满足":"业务本体 Schema 校验失败",...result});}
      const ontologyRollbackMatch=url.pathname.match(/^\/api\/ontology\/schemas\/(\d+)\/rollback$/);if(req.method==="POST"&&ontologyRollbackMatch){const record=semanticSchemas.get(Number(ontologyRollbackMatch[1]));if(!record)throw notFound("业务本体 Schema 版本不存在");authorize(identity,"editor",record.sourceId);const result=semanticSchemas.rollback(record.id,identity.name);return send(res,result.ok?200:422,result.ok?result:{error:"历史版本已不兼容当前物理结构，无法回滚",...result});}

      if(req.method==="GET"&&url.pathname==="/api/settings"){authorize(identity,"admin");return send(res,200,settings.publicView());}
      if(req.method==="PUT"&&url.pathname==="/api/settings"){authorize(identity,"admin");const body=await readJson(req);const ai=body?.ontologyAi;if(ai?.mode==="auto_draft"&&settingsConfig.ontologyAi.mode!=="auto_draft")throw badRequest("auto_draft 必须通过已达标的 AI 本体校准门禁启用");const calibrationKeys=["autoConfirmScore","calibrationMinSamples","calibrationMinPrecision","maxManualObjectRate","maxFailureRate","maxP95LatencyMs","maxAverageTokens"];if(settingsConfig.ontologyAi.mode==="auto_draft"&&ai&&calibrationKeys.some((key)=>key in ai)&&!["off","review"].includes(ai.mode))throw badRequest("修改校准规则前必须先将 AI 本体建模切回 review 或 off");return send(res,200,settings.update(body,identity.name));}
      if(req.method==="POST"&&url.pathname==="/api/settings/test-llm"){authorize(identity,"admin");const body=await readJson(req);const candidate=mergeConnection(settingsConfig.llm,body);const started=Date.now();try{await callLlmJson(candidate,[{role:"system",content:"只输出严格 JSON。"},{role:"user",content:'返回 {"ok":true}'}],{timeoutMs:20_000,extraBody:{max_tokens:16},fetchImpl:overrides.llmFetchImpl});return send(res,200,{ok:true,latencyMs:Date.now()-started,model:candidate.model});}catch(error){return send(res,400,{ok:false,error:safeError(error)});}}
      if(req.method==="POST"&&url.pathname==="/api/settings/test-embedding"){authorize(identity,"admin");const body=await readJson(req);const candidate=mergeConnection(settingsConfig.embedding,body);const started=Date.now();try{const [vector]=await callLlmEmbedding(candidate,["ping"],{timeoutMs:20_000,fetchImpl:overrides.embeddingFetchImpl});return send(res,200,{ok:true,latencyMs:Date.now()-started,dimensions:vector.length});}catch(error){return send(res,400,{ok:false,error:safeError(error)});}}
      if(req.method==="POST"&&url.pathname==="/api/settings/reindex-embeddings"){const body=await readJson(req);const source=requiredSource(store,identity,body.sourceId||1,"admin");return send(res,202,tasks.create({sourceId:source.id,taskType:"embedding_reindex"}));}

      if(req.method==="POST"&&url.pathname==="/api/query"){authorize(identity,"analyst");const body=await readJson(req);const source=requiredSource(store,identity,body.sourceId||1,"analyst");if(acceptsSse(req))return streamQuery(req,res,{body,source,identity});const rawResult=await queries.ask({sourceId:source.id,question:body.question,sessionId:body.sessionId,pendingId:body.pendingId,userName:identity.name,userRole:identity.role});const {response,auditId,sessionQuestion}=publicQueryResult(rawResult);if(!response.clarification)store.appendSessionTurn(response.sessionId,sessionQuestion||body.question,response,auditId);return send(res,200,response);}
      if(req.method==="GET"&&url.pathname==="/api/sessions"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"),"analyst");return send(res,200,store.listSessions(sourceId,identity.name));}
      if(req.method==="POST"&&url.pathname==="/api/sessions"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"analyst");return send(res,201,store.createSession({id:randomUUID(),sourceId,userName:identity.name,title:"新问数会话"}));}
      const sessionMatch=url.pathname.match(/^\/api\/sessions\/([^/]+)$/);if(sessionMatch){const session=store.getSession(decodeURIComponent(sessionMatch[1]));if(!session)throw notFound("问数会话不存在");authorize(identity,"analyst",session.sourceId);if(session.userName!==identity.name)throw forbidden("不能访问其他用户的问数会话");if(req.method==="GET"){const detail=store.getSessionDetail(session.id);const pending=queries.getPendingClarification?.({sessionId:session.id,userName:identity.name});return send(res,200,pending?{...detail,pendingClarification:pending}:detail);}if(req.method==="DELETE"){store.deleteSession(session.id);return send(res,200,{ok:true,id:session.id});}}

      if(req.method==="POST"&&url.pathname==="/api/eval/cases"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,201,evaluation.create(sourceId,body));}
      const evalCaseMatch=url.pathname.match(/^\/api\/eval\/cases\/(\d+)$/);if(req.method==="POST"&&evalCaseMatch){const item=store.getEvalCase(Number(evalCaseMatch[1]));if(!item)throw notFound("评测用例不存在");authorize(identity,"editor",item.sourceId);return send(res,200,evaluation.update(item.id,await readJson(req)));}
      const evalArchiveMatch=url.pathname.match(/^\/api\/eval\/cases\/(\d+)\/archive$/);if(req.method==="POST"&&evalArchiveMatch){const item=store.getEvalCase(Number(evalArchiveMatch[1]));if(!item)throw notFound("评测用例不存在");authorize(identity,"editor",item.sourceId);return send(res,200,evaluation.archive(item.id));}
      if(req.method==="POST"&&url.pathname==="/api/eval/import"){const body=await readJson(req);const sourceId=requiredSourceId(store,identity,body.sourceId,"editor");return send(res,201,evaluation.importCases(sourceId,body.items,{manifestStatus:body.manifestStatus,minimumCases:body.minimumCases}));}
      if(req.method==="POST"&&url.pathname==="/api/eval/run"){const body=await readJson(req);const source=requiredSource(store,identity,body.sourceId||1,"editor");if(!source.isDemo&&source.lastTestOk!==1)throw badRequest("真实数据源必须先通过只读连接测试");const queryAgentMode=normalizeQueryAgentMode(body.queryAgentMode);return send(res,202,tasks.create({sourceId:source.id,taskType:"evaluation",payload:{setName:body.setName,tolerance:body.tolerance,queryAgentMode}}));}
      if(req.method==="POST"&&url.pathname==="/api/eval/gate"){const body=await readJson(req);const source=requiredSource(store,identity,body.sourceId||1,"editor");if(source.isDemo||source.lastTestOk!==1)throw badRequest("对照门禁需要已通过只读连接测试的真实数据源");if(body.gateKind==="agent")return send(res,202,tasks.create({sourceId:source.id,taskType:"evaluation_agent_gate",payload:{setName:body.setName,tolerance:body.tolerance,maxP95LatencyRatio:body.maxP95LatencyRatio,maxAverageTokenRatio:body.maxAverageTokenRatio,maxClarificationRate:body.maxClarificationRate,maxBudgetFallbackRate:body.maxBudgetFallbackRate,maxRepeatedActionRate:body.maxRepeatedActionRate,minToolSuccessRate:body.minToolSuccessRate}}));if(body.gateKind&&body.gateKind!=="semantic")throw badRequest("gateKind 必须是 semantic 或 agent");if(body.ontologySchemaVersionId){const version=semanticSchemas.get(Number(body.ontologySchemaVersionId));if(!version||version.sourceId!==source.id)throw badRequest("候选 Schema 版本不存在或不属于当前数据源");}return send(res,202,tasks.create({sourceId:source.id,taskType:"evaluation_gate",payload:{setName:body.setName,tolerance:body.tolerance,ontologySchemaVersionId:body.ontologySchemaVersionId}}));}
      if(req.method==="POST"&&url.pathname==="/api/eval/agent-gate"){const body=await readJson(req);const source=requiredSource(store,identity,body.sourceId||1,"editor");if(source.isDemo||source.lastTestOk!==1)throw badRequest("Agent 对照门禁需要已通过只读连接测试的真实数据源");return send(res,202,tasks.create({sourceId:source.id,taskType:"evaluation_agent_gate",payload:{setName:body.setName,tolerance:body.tolerance,maxP95LatencyRatio:body.maxP95LatencyRatio,maxAverageTokenRatio:body.maxAverageTokenRatio,maxClarificationRate:body.maxClarificationRate,maxBudgetFallbackRate:body.maxBudgetFallbackRate,maxRepeatedActionRate:body.maxRepeatedActionRate,minToolSuccessRate:body.minToolSuccessRate}}));}
      if(req.method==="GET"&&url.pathname==="/api/eval/runs"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId"));return send(res,200,evaluation.listRuns(sourceId));}
      if(req.method==="GET"&&url.pathname==="/api/audits"){const sourceId=url.searchParams.get("sourceId")?requiredSourceId(store,identity,url.searchParams.get("sourceId"),"editor"):null;authorize(identity,"editor");return send(res,200,store.listAudits(sourceId,Math.min(500,Number(url.searchParams.get("limit")||100))));}
      if(req.method==="GET"&&url.pathname==="/api/capability-gaps"){const sourceId=requiredSourceId(store,identity,url.searchParams.get("sourceId")||1,"editor");authorize(identity,"editor");return send(res,200,capabilityGaps.listGaps(sourceId,{limit:Math.min(500,Number(url.searchParams.get("limit")||500))}));}
      return send(res,404,{error:"接口不存在",requestId});
    }catch(error){const status=Number(error.status||500);if(error.retryAfter)res.setHeader("retry-after",String(error.retryAfter));if(status>=500)console.error(`[${requestId}]`,safeError(error));return send(res,status,{error:status>=500?"服务处理失败":error.message,detail:runtime.nodeEnv==="development"?safeError(error):undefined,requestId});}
  }

  async function streamQuery(req,res,{body,source,identity}) {
    const controller=new AbortController();
    const abort=()=>controller.abort();
    req.once?.("aborted",abort);res.once?.("close",()=>{if(!res.writableEnded)abort();});
    res.statusCode=200;res.setHeader("content-type","text/event-stream; charset=utf-8");res.setHeader("connection","keep-alive");res.setHeader("x-accel-buffering","no");res.flushHeaders?.();
    try {
      const rawResult=await queries.ask({sourceId:source.id,question:body.question,sessionId:body.sessionId,pendingId:body.pendingId,userName:identity.name,userRole:identity.role,signal:controller.signal,onEvent:(event)=>writeSse(res,event.type,event)});
      if(controller.signal.aborted)return;
      const {response,auditId,sessionQuestion}=publicQueryResult(rawResult);
      if(!response.clarification)store.appendSessionTurn(response.sessionId,sessionQuestion||body.question,response,auditId);
      const event=response.clarification?"clarification":response.refused?"refused":"final";
      writeSse(res,event,{type:event,result:response});
      res.end();
    } catch(error) {
      if(controller.signal.aborted)return;
      writeSse(res,"refused",{type:"refused",result:{refused:true,reason:runtime.nodeEnv==="development"?safeError(error):"服务处理失败"}});res.end();
    } finally { req.off?.("aborted",abort); }
  }

  async function close(){await tasks.close();await connector.close();store.close();}
  return {handler,close,store,ontologyCandidates,ontologyCalibration,relationDocuments,sensitiveCatalogMigration,enumCatalogMigration};
}

function setSecurityHeaders(req,res,runtime,requestId){const origin=req.headers.origin;if(origin&&runtime.allowedOrigins.includes(origin)){res.setHeader("access-control-allow-origin",origin);res.setHeader("vary","Origin");}res.setHeader("access-control-allow-methods","GET,POST,PUT,DELETE,OPTIONS");res.setHeader("access-control-allow-headers","authorization,content-type,x-request-id,x-ontoquery-token");res.setHeader("access-control-max-age","86400");res.setHeader("cache-control","no-store");res.setHeader("x-content-type-options","nosniff");res.setHeader("referrer-policy","no-referrer");res.setHeader("x-request-id",requestId);}
function applyRateLimit(req,res,url,identity,runtime,limiter){const kind=["/api/query","/api/eval/run","/api/eval/gate"].includes(url.pathname)?"query":req.method==="GET"?"read":"write";const limit=kind==="query"?runtime.rateLimits.queryPerMinute:kind==="read"?runtime.rateLimits.readPerMinute:runtime.rateLimits.writePerMinute;const ip=String(req.socket?.remoteAddress||"local");const state=limiter.check(`${identity.key}:${ip}:${kind}`,limit);res.setHeader("x-ratelimit-limit",String(limit));res.setHeader("x-ratelimit-remaining",String(state.remaining));}
function evalSetChecksum(cases){return createHash("sha256").update(JSON.stringify(cases.map((item)=>[item.id,item.question,item.goldSql,item.category,item.heldOut]))).digest("hex");}
function lockedSettingKeys(overrides){const keys=[];for(const group of ["llm","embedding","retrieval","discovery","profiling","ontologyAi"])if(overrides[group])for(const key of Object.keys(overrides[group]))keys.push(`${group}.${key}`);for(const key of ["semanticQueryPlanMode","queryAgentMode","queryAgentTrafficPercent","queryAgentMaxIterations","queryAgentMaxSqlCalls","queryAgentMaxScannedRows","queryAgentPendingTtlMs","metricProposalEnabled","queryMaxRows","explainMaxRows","queryTimeoutMs","queryLlmTimeoutMs"])if(key in overrides)keys.push(`query.${key}`);return keys;}
function mergeConnection(current,body){const merged={baseUrl:String(body?.baseUrl??"").trim()||current.baseUrl,apiKey:String(body?.apiKey??"").trim()||current.apiKey,model:String(body?.model??"").trim()||current.model};const dimensions=body?.dimensions??current.dimensions;return {...merged,...(Number(dimensions)>0?{dimensions:Number(dimensions)}:{})};}
function visibleSources(store,identity){return store.listSources().filter((source)=>canAccessSource(identity,source.id));}
function requiredSource(store,identity,id,minimum="viewer"){const source=store.getSource(Number(id));if(!source)throw notFound("数据源不存在");authorize(identity,minimum,source.id);return source;}
function requiredSourceId(store,identity,value,minimum="viewer"){return requiredSource(store,identity,Number(value||1),minimum).id;}
function roleAtLeast(identity,minimum){const rank={viewer:1,analyst:2,editor:3,admin:4};return rank[identity.role]>=rank[minimum];}
function withoutCredential(source){const safe={...source};delete safe.credential;return safe;}
function send(res,status,data){res.statusCode=status;if(data==null)return res.end();res.setHeader("content-type","application/json; charset=utf-8");res.end(JSON.stringify(data));}
function acceptsSse(req){return /(?:^|,)\s*text\/event-stream(?:\s*;|\s*,|$)/i.test(String(req.headers.accept||""));}
function writeSse(res,event,data){if(res.writableEnded||res.destroyed)return;res.write?.(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);}
function publicQueryResult(result){const response={...result};const auditId=Number(response._auditId)||null;const sessionQuestion=typeof response._sessionQuestion==="string"?response._sessionQuestion:null;delete response._auditId;delete response._sessionQuestion;return {response,auditId,sessionQuestion};}
async function readJson(req){let raw="";for await(const chunk of req){raw+=chunk;if(raw.length>1_000_000)throw badRequest("请求体过大");}try{return raw?JSON.parse(raw):{};}catch{throw badRequest("请求体必须是 JSON");}}
function validateSource(body){for(const field of ["name","host","dbName","userName","password"])if(!body[field]||typeof body[field]!=="string")throw badRequest(`${field} 必填`);if(!/^[A-Za-z0-9_$-]+$/.test(body.dbName))throw badRequest("数据库名包含不安全字符");}
function safeError(error){return String(error?.message||error).replace(/(?:password|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,"$1=[REDACTED]").slice(0,1000);}
function badRequest(message){const error=new Error(message);error.status=400;return error;}function forbidden(message){const error=new Error(message);error.status=403;return error;}function notFound(message){const error=new Error(message);error.status=404;return error;}function conflict(message){const error=new Error(message);error.status=409;return error;}
function normalizeQueryAgentMode(value){const mode=String(value||"off").trim().toLowerCase();if(!["off","prefer","required"].includes(mode))throw badRequest("queryAgentMode 必须是 off、prefer、required 之一");return mode;}
function requireWrite(req,runtime){const identity=authenticate(req,runtime);return authorize(identity,"analyst");}

function parseTermAnchorCsv(input,defaultVocabulary) {
  if(typeof input!=="string"||!input.trim())throw badRequest("csv 必填");
  const rows=parseCsvRows(input);if(rows.length<2)return [];
  const headers=rows[0].map((value)=>value.trim().toLowerCase());
  const index=(...names)=>names.map((name)=>headers.indexOf(name)).find((value)=>value>=0)??-1;
  const canonicalIndex=index("canonical_id","canonicalid","id");
  if(canonicalIndex<0)throw badRequest("CSV 缺少 canonical_id 列");
  const vocabularyIndex=index("vocabulary");const zhIndex=index("name_zh","pref_label_zh","label_zh");const enIndex=index("name_en","pref_label_en","label_en");const kindIndex=index("kind");const broaderIndex=index("broader_canonical_id","category");const aliasesIndex=index("alt_labels","aliases");const noteIndex=index("note");
  return rows.slice(1).filter((row)=>row.some((value)=>value.trim())).map((row,line)=>{
    const vocabulary=String(vocabularyIndex>=0?row[vocabularyIndex]:defaultVocabulary||"").trim();
    const canonicalId=String(row[canonicalIndex]||"").trim();
    if(!vocabulary||!canonicalId)throw badRequest(`CSV 第 ${line+2} 行缺少 vocabulary 或 canonical_id`);
    return {vocabulary,canonicalId,prefLabelZh:zhIndex>=0?row[zhIndex]:null,prefLabelEn:enIndex>=0?row[enIndex]:null,kind:kindIndex>=0&&row[kindIndex]?row[kindIndex]:"object",broaderCanonicalId:broaderIndex>=0?row[broaderIndex]:null,altLabels:aliasesIndex>=0?String(row[aliasesIndex]||"").split(/[|；;]/).map((value)=>value.trim()).filter(Boolean):[],note:noteIndex>=0?row[noteIndex]:null};
  });
}

function assertTermAnchorsSafe(items) {
  for(const [index,item] of items.entries())for(const value of termAnchorTextValues(item)) {
    const finding=detectSensitiveValue(value);
    if(finding.sensitive)throw badRequest(`术语锚点第 ${index+1} 条包含敏感值（${finding.kind}），已拒绝导入`);
  }
}

function termAnchorTextValues(item) {
  if(!item||typeof item!=="object")return [];
  return Object.values(item).flatMap((value)=>Array.isArray(value)?value:value==null?[]:[value]).filter((value)=>typeof value==="string");
}

function parseCsvRows(value) {
  const rows=[];let row=[];let cell="";let quoted=false;
  for(let index=0;index<value.length;index++){
    const char=value[index];
    if(quoted&&char==='"'&&value[index+1]==='"'){cell+='"';index++;continue;}
    if(char==='"'){quoted=!quoted;continue;}
    if(!quoted&&char===","){row.push(cell);cell="";continue;}
    if(!quoted&&(char==="\n"||char==="\r")){if(char==="\r"&&value[index+1]==="\n")index++;row.push(cell);rows.push(row);row=[];cell="";continue;}
    cell+=char;
  }
  row.push(cell);if(row.some((item)=>item.length)||rows.length===0)rows.push(row);return rows;
}

export const _internal={requireWrite,authenticate,authorize,createRateLimiter};

if(import.meta.url===`file://${process.argv[1]}`){const app=createApp();const server=http.createServer(app.handler);server.requestTimeout=65_000;server.headersTimeout=10_000;server.keepAliveTimeout=5_000;server.listen(config.port,config.host,()=>console.log(`OntoQuery API: http://${config.host}:${config.port}/api/health`));const shutdown=()=>server.close(()=>app.close().finally(()=>process.exit(0)));process.on("SIGINT",shutdown);process.on("SIGTERM",shutdown);}
