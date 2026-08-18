import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { evalSetChecksum } from "../src/evaluation-evidence.mjs";
import { ontologyCatalogChecksum } from "../src/ontology-candidate-service.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";

test("generation scope API uses server budgets, relation components, and sensitive-endpoint filtering",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-generation-scope-api-"));
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"generation-scope-api-secret",
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:3,maxFields:5,timeoutMs:90_000,auditDir:join(root,"audit")},
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:[1]},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],
    connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);
    const empty={sourceId:source.id,tableNames:[]};
    assert.equal((await api(app,"/api/ontology/generation-scope","viewer-token",empty)).status,403);
    const limits=await api(app,"/api/ontology/generation-scope","editor-token",empty);
    assert.equal(limits.status,200);assert.deepEqual(limits.body.limits,{maxTables:3,maxFields:5});assert.equal(limits.body.batchCount,0);
    app.store.upsertRelation({sourceId:source.id,fromTable:"crm_customer",fromCol:"mobile",toTable:"sales_refund",toCol:"refund_id",cardinality:"N:1",confidence:1,status:"confirmed"});
    const planned=await api(app,"/api/ontology/generation-scope","editor-token",{sourceId:source.id,tableNames:["crm_customer","sales_refund"]});
    assert.equal(planned.status,200);assert.equal(planned.body.batchCount,2);assert.equal(planned.body.truncatedFieldCount,2);
    assert.equal(planned.body.confirmedRelationCount,0);assert.equal(planned.body.excludedSensitiveRelationCount,1);
    assert.ok(planned.body.batches.every((batch)=>batch.fieldCount<=5));
  } finally { await app.close(); }
});

test("generation API enforces editor writes and completes an Object background task",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-generation-api-"));
  const generated=[];
  const ontologyCandidateGenerator={generateObjects:async({run,onCandidate,onProgress})=>{
    onProgress({progress:30,total:100,currentStep:"模型识别对象"});
    const stored=await onCandidate({candidateType:"object",mainTable:"crm_customer",payload:{apiName:"generated_customer",displayName:"客户",description:"客户主体",primaryKey:"customer_id",properties:[{apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}}]},evidence:[{kind:"physical_table",refId:"table:crm_customer",verified:true}],modelConfidence:.91,contractErrors:[]});
    generated.push(stored);
    return {candidates:[stored],calls:[{batchId:run.scope.batches[0].id,promptHash:"prompt-hash",outputHash:"output-hash",durationMs:5,usage:{promptTokens:12,completionTokens:6,totalTokens:18},traceStored:true}],tokenUsage:{promptTokens:12,completionTokens:6,totalTokens:18},normalizationIssues:[]};
  }};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"generation-api-secret",
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},ontologyCandidateGenerator,
    apiIdentities:[
      {name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:[1]},
      {name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"},
    ],connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);
    const body={sourceId:source.id,mode:"selected_tables",tableNames:["crm_customer"],domainName:"客户域",domainDescription:"客户主档"};
    assert.equal((await api(app,"/api/ontology/generation-runs","viewer-token",body)).status,403);
    const created=await api(app,"/api/ontology/generation-runs","editor-token",body);
    assert.equal(created.status,202);
    assert.equal(created.body.status,"queued");
    assert.ok(created.body.taskId);
    const task=await waitForTask(app,created.body.taskId);
    assert.equal(task.status,"succeeded",task.error);
    const detail=await api(app,`/api/ontology/generation-runs/${created.body.id}`,"viewer-token",null,"GET");
    assert.equal(detail.status,200);assert.equal(detail.body.status,"succeeded");assert.equal(detail.body.catalogCurrent,true);assert.equal(detail.body.summary.candidateCount,1);assert.equal(detail.body.tokenUsage.totalTokens,18);
    const candidates=await api(app,`/api/ontology/candidates?sourceId=${source.id}&runId=${created.body.id}`,"viewer-token",null,"GET");
    assert.equal(candidates.status,200);assert.equal(candidates.body.length,1);assert.equal(candidates.body[0].status,"review_required");assert.equal(generated.length,1);
    const candidate=await api(app,`/api/ontology/candidates/${candidates.body[0].id}`,"viewer-token",null,"GET");assert.equal(candidate.status,200);assert.equal(candidate.body.sourceId,source.id);
    const bulkInput={sourceId:source.id,candidateIds:[candidate.body.id],decision:"confirm"};assert.equal((await api(app,"/api/ontology/candidates/bulk-decision","viewer-token",bulkInput)).status,403);
    const bulk=await api(app,"/api/ontology/candidates/bulk-decision","editor-token",bulkInput);assert.equal(bulk.status,200);assert.equal(bulk.body.succeeded,1);assert.equal(bulk.body.results[0].candidate.status,"confirmed");
    const events=await api(app,`/api/ontology/candidates/${candidate.body.id}/events`,"viewer-token",null,"GET");assert.equal(events.status,200);assert.deepEqual(events.body.map((item)=>item.eventType),["auto_route","confirmed"]);assert.equal(events.body[1].actor,"editor-a");
    app.store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"catalog_drift",dataType:"varchar",nullable:1,isSensitive:0,comment:"目录变化"});
    const stale=await api(app,`/api/ontology/generation-runs/${created.body.id}`,"viewer-token",null,"GET");assert.equal(stale.status,200);assert.equal(stale.body.catalogCurrent,false);
  } finally { await app.close(); }
});

test("generation API isolates candidates by source and audits failed model output",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-generation-api-failed-"));
  const failedGenerator={generateObjects:async()=>{const error=new Error("LLM 未返回合法 JSON");error.generationCalls=[{batchId:"object-batch-1",promptHash:"p",outputHash:"o",durationMs:2,error:error.message,traceStored:true}];error.generationTokenUsage={promptTokens:2,completionTokens:1,totalTokens:3};throw error;}};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"generation-api-failed-secret",
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},ontologyCandidateGenerator:failedGenerator,
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:[1]},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],
    connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const demo=app.store.listSources().find((item)=>item.isDemo);
    const created=await api(app,"/api/ontology/generation-runs","editor-token",{sourceId:demo.id,tableNames:["crm_customer"]});
    const task=await waitForTask(app,created.body.taskId);assert.equal(task.status,"failed");assert.match(task.error,/合法 JSON/);
    const run=app.store.getOntologyGenerationRun(created.body.id);assert.equal(run.status,"failed");assert.equal(run.tokenUsage.totalTokens,3);assert.equal(run.summary.modelCalls[0].traceStored,true);

    const other=app.store.createSource({name:"other",kind:"mysql",host:"db",port:3306,dbName:"other",userName:"ro",credential:"encrypted",isDemo:false});
    app.store.createOntologyGenerationRun({id:"other-run",sourceId:other.id,mode:"selected_tables",scope:{tableNames:["x"]},catalogChecksum:"x",promptVersion:"v1",scoringVersion:"s1",status:"failed",createdBy:"editor-a"});
    app.store.createOntologyCandidate({id:"other-candidate",runId:"other-run",sourceId:other.id,candidateType:"object",stableKey:"object:default:x",payload:{},status:"blocked"});
    assert.equal((await api(app,"/api/ontology/candidates/other-candidate","viewer-token",null,"GET")).status,403);
    assert.equal((await api(app,"/api/ontology/candidates/other-candidate/events","viewer-token",null,"GET")).status,403);
    const filtered=await api(app,`/api/ontology/candidates?sourceId=${demo.id}&runId=other-run`,"viewer-token",null,"GET");assert.equal(filtered.status,200);assert.deepEqual(filtered.body,[]);
  } finally { await app.close(); }
});

test("generation task uses the configured JSON LLM client without sending sensitive columns",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-generation-api-llm-"));let requestBody=null;
  const llmFetchImpl=async(_url,init)=>{
    requestBody=JSON.parse(init.body);
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({candidates:[{tableName:"crm_customer",apiName:"customer_profile",displayName:"客户档案",description:"客户主档",primaryKeyColumn:"customer_id",properties:[{column:"customer_id"},{column:"customer_type"}],modelConfidence:.88,evidenceRefs:["term:有效客户"]}]})}}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}),{status:200});
  };
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"generation-api-llm-secret",llm:{baseUrl:"https://llm.test/v1",apiKey:"sk-real-test-key",model:"object-model"},llmFetchImpl,
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);
    const created=await api(app,"/api/ontology/generation-runs","editor-token",{sourceId:source.id,tableNames:["crm_customer"],domainName:"客户"});
    const task=await waitForTask(app,created.body.taskId);assert.equal(task.status,"succeeded",task.error);
    assert.equal(requestBody.model,"object-model");assert.deepEqual(requestBody.response_format,{type:"json_object"});
    const prompt=JSON.stringify(requestBody.messages);assert.match(prompt,/customer_id/);assert.doesNotMatch(prompt,/mobile|手机号/);
    const candidates=app.store.listOntologyCandidates({runId:created.body.id});assert.equal(candidates.length,1);assert.equal(candidates[0].payload.apiName,"customer_profile");assert.equal(candidates[0].payload.properties[0].mapping.table,"crm_customer");
    const run=app.store.getOntologyGenerationRun(created.body.id);assert.equal(run.tokenUsage.totalTokens,30);assert.equal(run.summary.modelCalls[0].traceStored,true);assert.equal(run.summary.objectCoveredTableCount,1);assert.equal(run.summary.objectMissingTableCount,0);
    assert.equal((await api(app,`/api/ontology/generation-runs/${run.id}/traces`,"viewer-token",null,"GET")).status,403);
    const traces=await api(app,`/api/ontology/generation-runs/${run.id}/traces`,"editor-token",null,"GET");assert.equal(traces.status,200);assert.equal(traces.body.length,1);assert.equal(traces.body[0].fileName,"object-001.json");assert.equal("messages" in traces.body[0],false);
    const trace=await api(app,`/api/ontology/generation-runs/${run.id}/traces/object-001.json`,"editor-token",null,"GET");assert.equal(trace.status,200);assert.equal(trace.body.messages.length,2);assert.match(trace.body.rawOutput,/customer_profile/);
  } finally { await app.close(); }
});

test("supplemental Link generation and draft apply complete the editor API workflow",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-link-apply-api-"));let relationId=null;let supplementalCalls=0;
  const ontologyCandidateGenerator={
    generateObjects:async({onCandidate})=>{
      const customer=await onCandidate({candidateType:"object",payload:{apiName:"customer",displayName:"客户",primaryKey:"customer_id",properties:[{apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}}]},evidence:[],contractErrors:[]});
      const order=await onCandidate({candidateType:"object",payload:{apiName:"order",displayName:"订单",primaryKey:"order_id",properties:[{apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},{apiName:"customer_id",displayName:"客户编号",type:"integer",required:false,mapping:{table:"sales_order",column:"customer_id"}}]},evidence:[],contractErrors:[]});
      return generationResult([customer,order]);
    },
    generateLinks:async({endpoints,phase,onCandidate})=>{
      if(phase==="auto"){assert.equal(endpoints.length,0);return {...generationResult([]),eligibleRelationCount:0};}
      supplementalCalls+=1;assert.equal(endpoints.length,2);
      const customer=endpoints.find((item)=>item.payload.apiName==="customer");const order=endpoints.find((item)=>item.payload.apiName==="order");
      const link=await onCandidate({candidateType:"link",sourceStableKey:customer.stableKey,targetStableKey:order.stableKey,payload:{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationKind:"references",relationMappings:[{relationId}]},evidence:[{kind:"physical_relation",refId:`relation:${relationId}`,verified:true}],contractErrors:[]});
      return {...generationResult([link]),eligibleRelationCount:1};
    },
  };
  const ontologyCandidateScorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"link-apply-secret",ontologyCandidateGenerator,ontologyCandidateScorer,
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],
    connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.createSource({name:"link-source",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"encrypted",isDemo:false});
    app.store.upsertTable({sourceId:source.id,tableName:"crm_customer",grade:"A",active:1,comment:"客户"});app.store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,comment:"客户编号"});
    app.store.upsertTable({sourceId:source.id,tableName:"sales_order",grade:"A",active:1,comment:"订单"});app.store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"order_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,comment:"订单编号"});app.store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"customer_id",dataType:"bigint",nullable:1,isIndexed:1,comment:"客户编号"});
    relationId=app.store.upsertRelation({sourceId:source.id,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"}).id;
    const created=await api(app,"/api/ontology/generation-runs","editor-token",{sourceId:source.id,tableNames:["crm_customer","sales_order"],domainName:"sales"});
    assert.equal((await waitForTask(app,created.body.taskId)).status,"succeeded");
    const objects=app.store.listOntologyCandidates({runId:created.body.id,candidateType:"object"});assert.equal(objects.length,2);assert.ok(objects.every((item)=>item.status==="review_required"));
    for(const object of objects)assert.equal((await api(app,`/api/ontology/candidates/${object.id}/decision`,"editor-token",{decision:"confirm"})).status,200);
    assert.equal((await api(app,`/api/ontology/generation-runs/${created.body.id}/links`,"viewer-token",{})).status,403);
    const linkTaskResponse=await api(app,`/api/ontology/generation-runs/${created.body.id}/links`,"editor-token",{});assert.equal(linkTaskResponse.status,202);
    assert.equal((await waitForTask(app,linkTaskResponse.body.id)).status,"succeeded");assert.equal(supplementalCalls,1);
    const [link]=app.store.listOntologyCandidates({runId:created.body.id,candidateType:"link"});assert.equal(link.status,"review_required");
    assert.equal((await api(app,`/api/ontology/candidates/${link.id}/decision`,"editor-token",{decision:"confirm"})).status,200);
    const preview=await api(app,`/api/ontology/generation-runs/${created.body.id}/preview`,"editor-token",{});assert.equal(preview.status,200);assert.equal(preview.body.validation.ok,true);assert.equal(preview.body.summary.candidateCount,3);
    assert.equal((await api(app,`/api/ontology/generation-runs/${created.body.id}/apply`,"viewer-token",{})).status,403);
    const applied=await api(app,`/api/ontology/generation-runs/${created.body.id}/apply`,"editor-token",{});assert.equal(applied.status,201);assert.equal(applied.body.validation.ok,true);assert.equal(applied.body.draft.status,"draft");
    assert.equal(applied.body.draft.schema.objectTypes.length,2);assert.equal(applied.body.draft.schema.linkTypes.length,1);assert.equal(app.store.getPublishedOntologySchema(source.id),null);
    assert.ok(app.store.listOntologyCandidates({runId:created.body.id}).every((item)=>item.status==="applied"));
  } finally { await app.close(); }
});

test("candidate merge API is editor-only and keeps both sides auditable",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-candidate-merge-api-"));
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"merge-api-secret",ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test"});
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);app.store.createOntologyGenerationRun({id:"merge-run",sourceId:source.id,mode:"selected_tables",scope:{tableNames:["crm_customer"],namespace:"merge"},catalogChecksum:"snapshot",promptVersion:"v1",scoringVersion:"v1",status:"succeeded",createdBy:"editor-a"});
    app.store.createOntologyCandidate({id:"merge-retained",runId:"merge-run",sourceId:source.id,candidateType:"object",stableKey:"object:merge:crm_customer",payload:{apiName:"customer"},evidence:[{kind:"physical_table",refId:"table:crm_customer",verified:true}],status:"confirmed"});
    app.store.createOntologyCandidate({id:"merge-duplicate",runId:"merge-run",sourceId:source.id,candidateType:"object",stableKey:"object:merge:crm_customer_copy",payload:{apiName:"customer_copy"},evidence:[{kind:"knowledge_page",refId:"term:customer",verified:true}],status:"review_required"});
    assert.equal((await api(app,"/api/ontology/candidates/merge-duplicate/merge","viewer-token",{intoCandidateId:"merge-retained"})).status,403);
    const merged=await api(app,"/api/ontology/candidates/merge-duplicate/merge","editor-token",{intoCandidateId:"merge-retained"});assert.equal(merged.status,200);assert.equal(merged.body.candidate.status,"superseded");assert.equal(merged.body.retainedCandidate.evidence.length,2);
  } finally { await app.close(); }
});

test("real-source calibration API enforces review evidence before admin activates auto_draft",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-calibration-api-"));
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"calibration-api-secret",apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"},{name:"admin-a",role:"admin",token:"admin-token",sourceIds:"*"}],connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test"});
  try {
    const source=app.store.createSource({name:"pilot-source",kind:"mysql",host:"db",port:3306,dbName:"pilot",userName:"ro",credential:"encrypted",isDemo:false});app.store.markSourceTest(source.id,true);
    app.store.upsertTable({sourceId:source.id,tableName:"pilot_customer",grade:"A",active:1,comment:"客户"});app.store.upsertColumn({sourceId:source.id,tableName:"pilot_customer",columnName:"id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0,comment:"编号"});
    const tables=app.store.listTables(source.id);const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,app.store.listColumns(source.id,table.tableName)]));
    const catalogChecksum=ontologyCatalogChecksum({sourceId:source.id,tables,columnsByTable,relations:app.store.listRelations(source.id,false,true)});
    const run=app.store.createOntologyGenerationRun({id:"pilot-run",sourceId:source.id,mode:"selected_tables",scope:{tableNames:["pilot_customer"],namespace:"pilot",modelingMode:"review",autoConfirmScore:80},catalogChecksum,modelName:"model",promptVersion:"v1",scoringVersion:"score-v1",status:"succeeded",summary:{modelCalls:[{durationMs:20}]},tokenUsage:{totalTokens:100},createdBy:"editor-a"});
    const candidates=[];for(let index=0;index<40;index++)candidates.push(app.store.createOntologyCandidate({id:`pilot-${index}`,runId:run.id,sourceId:source.id,candidateType:"object",stableKey:`object:pilot:pilot_customer_${index}`,payload:{apiName:`pilot_${index}`,displayName:`试点 ${index}`,primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table:"pilot_customer",column:"id"}}]},score:90,validation:{ok:true,errors:[],warnings:[]},status:"review_required",forcedReviewReasons:[],actor:"model",eventType:"auto_route"}));
    for(const candidate of candidates)assert.equal(app.store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"confirmed",reviewedBy:"reviewer-primary",actor:"reviewer-primary",eventType:"confirmed"}).ok,true);
    for(const candidate of candidates.slice(1))app.ontologyCalibration.label(candidate.id,{verdict:"correct"},"reviewer-a");
    assert.equal((await api(app,`/api/ontology/candidates/${candidates[0].id}/calibration`,"viewer-token",{verdict:"correct"})).status,403);
    assert.equal((await api(app,`/api/ontology/candidates/${candidates[0].id}/calibration`,"editor-token",{verdict:"correct"})).status,200);
    const labeled=await api(app,`/api/ontology/candidates/${candidates[0].id}`,"viewer-token",null,"GET");assert.equal(labeled.body.calibration.verdict,"correct");
    const draft=app.store.createOntologySchemaVersion({sourceId:source.id,schemaName:"pilot",schema:{name:"pilot",displayName:"试点",objectTypes:[],linkTypes:[]},checksum:"draft",validation:{ok:true,errors:[],warnings:[],summary:{objectTypes:40,properties:40,linkTypes:0,errorCount:0,warningCount:0}},createdBy:"editor-a"});
    app.store.publishOntologySchemaVersion(draft.id,"editor-a");
    const evalCases=[];for(let index=0;index<10;index++)evalCases.push(app.store.addEvalCase({sourceId:source.id,setName:"pilot-gold",question:`试点 Gold 问题 ${index+1}`,goldSql:"SELECT id FROM pilot_customer",category:"客户",heldOut:1}));
    const publishedDraft=app.store.getOntologySchemaVersion(draft.id);const evalGate=app.store.saveEvalGate({id:"pilot-gold",sourceId:source.id,setName:"pilot-gold",total:10,ontologySchemaVersion:draft.version,ontologySchemaPublishedAt:publishedDraft.publishedAt,evaluationChecksum:evalSetChecksum(evalCases),baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0},passed:1,decision:"enable_prefer",reason:"equivalent"});
    assert.equal((await api(app,"/api/settings","admin-token",{ontologyAi:{mode:"auto_draft"}},"PUT")).status,400);
    const report=await api(app,`/api/ontology/calibration?sourceId=${source.id}`,"viewer-token",null,"GET");assert.equal(report.status,200);assert.equal(report.body.counts.labeledAuto,40);assert.deepEqual(report.body.evalSets,[{setName:"pilot-gold",total:10,goldCount:10,heldOutCount:10,ready:true}]);
    const created=await api(app,"/api/ontology/calibration/gates","editor-token",{sourceId:source.id,draftSchemaVersionId:draft.id,evalGateId:evalGate.id,manualObjectCount:0});assert.equal(created.status,201);assert.equal(created.body.passed,true);
    assert.equal((await api(app,`/api/ontology/calibration/gates/${created.body.id}/activate`,"editor-token",{})).status,403);
    const activated=await api(app,`/api/ontology/calibration/gates/${created.body.id}/activate`,"admin-token",{});assert.equal(activated.status,200);assert.equal(activated.body.settings.ontologyAi.mode,"auto_draft");assert.equal(activated.body.gate.activatedBy,"admin-a");
  } finally { await app.close(); }
});

test("domain-plan API clusters eligible tables for viewers with prefix fallback naming",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-domain-plan-api-"));
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"domain-plan-api-secret",llm:{baseUrl:"",apiKey:"",model:""},
    ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:[1]},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:[1]}],
    connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);
    const empty=await api(app,`/api/ontology/domain-plan?sourceId=${source.id}`,"viewer-token",null,"GET");
    assert.equal(empty.status,200);
    assert.equal(empty.body.stored,false);
    assert.equal(empty.body.domains,null);
    assert.equal((await api(app,`/api/ontology/domain-plan?sourceId=${source.id}&refresh=1`,"viewer-token",null,"GET")).status,403);
    const planned=await api(app,`/api/ontology/domain-plan?sourceId=${source.id}&refresh=1`,"editor-token",null,"GET");
    assert.equal(planned.status,200);
    assert.equal(planned.body.namingSource,"fallback");
    assert.equal(planned.body.stored,true);
    assert.equal(planned.body.stale,false);
    assert.ok(planned.body.domains.length>=1);
    const eligible=app.store.listTables(source.id).filter((table)=>table.active!==0&&["A","B"].includes(table.grade)).map((table)=>table.tableName).sort();
    const covered=planned.body.domains.flatMap((domain)=>domain.tables.map((table)=>table.tableName)).sort();
    assert.deepEqual(covered,eligible);
    for(const domain of planned.body.domains){assert.ok(domain.tableCount<=planned.body.maxTables);assert.match(domain.name,/域/);}
    const cached=await api(app,`/api/ontology/domain-plan?sourceId=${source.id}`,"viewer-token",null,"GET");
    assert.equal(cached.status,200);
    assert.equal(cached.body.stored,true);
    assert.equal(cached.body.domains.length,planned.body.domains.length);
    assert.equal((await api(app,"/api/ontology/domain-plan?sourceId=999","viewer-token",null,"GET")).status,404);
  } finally { await app.close(); }
});

test("domain-modeling API automatically builds every domain and its Links with threshold routing",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-domain-modeling-api-"));
  const ontologyCandidateScorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
  const ontologyCandidateGenerator={
    generateObjects:async({run,onCandidate})=>{const items=[];for(const tableName of run.scope.tableNames)items.push(await onCandidate({candidateType:"object",mainTable:tableName,payload:{apiName:tableName,displayName:tableName,primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table:tableName,column:"id"}}]},evidence:[],contractErrors:[]}));return generationResult(items);},
    generateLinks:async({catalog,endpoints,onCandidate})=>{const byTable=new Map(endpoints.map((item)=>[item.payload.properties[0].mapping.table,item]));const items=[];for(const relation of catalog.relations){const source=byTable.get(relation.fromTable);const target=byTable.get(relation.toTable);if(!source||!target)continue;items.push(await onCandidate({candidateType:"link",sourceStableKey:source.stableKey,targetStableKey:target.stableKey,payload:{apiName:`${source.payload.apiName}_to_${target.payload.apiName}`,displayName:"域内关系",source:source.payload.apiName,target:target.payload.apiName,cardinality:"many_to_one",relationKind:"references",relationMappings:[{relationId:relation.id}]},evidence:[{kind:"physical_relation",refId:`relation:${relation.id}`,verified:true}],contractErrors:[]}));}return {...generationResult(items),eligibleRelationCount:items.length};},
  };
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"domain-modeling-api-secret",llm:{baseUrl:"",apiKey:"",model:""},ontologyCandidateGenerator,ontologyCandidateScorer,
    ontologyAi:{mode:"auto_draft",autoConfirmScore:80,maxTables:20,maxFields:600,timeoutMs:90_000,auditDir:join(root,"audit")},
    apiIdentities:[{name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},{name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"}],
    connector:{close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const source=app.store.createSource({name:"domain-source",kind:"mysql",host:"db",port:3306,dbName:"domain",userName:"ro",credential:"encrypted",isDemo:false});
    for(const tableName of ["crm_customer","crm_contact","sales_order","sales_item"]){app.store.upsertTable({sourceId:source.id,tableName,grade:"A",active:1,comment:tableName});app.store.upsertColumn({sourceId:source.id,tableName,columnName:"id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0,comment:"编号"});}
    app.store.upsertRelation({sourceId:source.id,fromTable:"crm_contact",fromCol:"id",toTable:"crm_customer",toCol:"id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
    app.store.upsertRelation({sourceId:source.id,fromTable:"sales_item",fromCol:"id",toTable:"sales_order",toCol:"id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
    assert.equal((await api(app,"/api/ontology/domain-modeling","viewer-token",{sourceId:source.id})).status,403);
    const started=await api(app,"/api/ontology/domain-modeling","editor-token",{sourceId:source.id});assert.equal(started.status,202);
    const task=await waitForTask(app,started.body.id);assert.equal(task.status,"succeeded",task.error);assert.equal(task.result.domainCount,2);assert.equal(task.result.succeededDomainCount,2);assert.equal(task.result.objectCount,4);assert.equal(task.result.linkCount,2);assert.equal(task.result.reviewRequiredCount,0);
    const runs=app.store.listOntologyGenerationRuns(source.id);assert.equal(runs.length,2);assert.ok(runs.every((run)=>run.taskId===task.id&&run.scope.orchestrationId===task.id&&run.status==="succeeded"));
    const candidates=app.store.listOntologyCandidates({sourceId:source.id});assert.equal(candidates.length,6);assert.ok(candidates.every((item)=>item.status==="auto_confirmed"));
  } finally { await app.close(); }
});

async function waitForTask(app,id) {
  for(let index=0;index<200;index++){const task=app.store.getTask(id);if(["succeeded","failed"].includes(task?.status))return task;await new Promise((resolve)=>setTimeout(resolve,5));}
  throw new Error("ontology generation task did not finish");
}

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}

function generationResult(candidates) { return {candidates,calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[]}; }
