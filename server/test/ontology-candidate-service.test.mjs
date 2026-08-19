import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOntologyCandidateService, ontologyCatalogChecksum } from "../src/ontology-candidate-service.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { createStore } from "../src/store.mjs";

test("feature switch is off by default and prevents generation runs",async()=>{
  const fixture=await createFixture();
  try {
    const service=createOntologyCandidateService({store:fixture.store,config:{ontologyAi:{mode:"off",autoConfirmScore:80,maxTables:20,maxFields:600}}});
    assert.throws(()=>service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"]},"editor"),/当前已关闭/);
    assert.equal(fixture.store.listOntologyGenerationRuns(fixture.source.id).length,0);
  } finally { fixture.store.close(); }
});

test("fixed candidates complete M0 scoring, routing, persistence and audit without an LLM",async()=>{
  const fixture=await createFixture();
  try {
    const config={
      ontologyAi:{mode:"auto_draft",autoConfirmScore:80,maxTables:20,maxFields:600},
      llm:{model:"not-called"},embedding:{model:"embed-v1"},
    };
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"],domainName:"客户域"},"editor-a");
    assert.equal(run.scope.namespace.length>0,true);
    assert.equal(run.catalogChecksum,ontologyCatalogChecksum(service.catalog(fixture.source.id,["crm_customer"])));
    const candidate=await service.evaluateAndStore(run.id,objectCandidate(),"system");
    assert.equal(candidate.status,"auto_confirmed");
    assert.equal(candidate.score,85);
    assert.equal(candidate.stableKey,`object:${run.scope.namespace}:crm_customer`);
    assert.equal(candidate.payload.namespace,run.scope.namespace);
    assert.equal("freshness" in candidate.payload,false);
    assert.equal(candidate.payload.properties.some((property)=>"freshness" in property),false);
    assert.deepEqual(service.listEvents(candidate.id).map((event)=>event.eventType),["auto_route"]);
  } finally { fixture.store.close(); }
});

test("catalog drift prevents stale runs from accepting candidates",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"]},"editor-a");
    assert.equal(run.catalogCurrent,true);assert.equal(service.getRun(run.id).catalogCurrent,true);assert.equal(service.listRuns(fixture.source.id)[0].catalogCurrent,true);
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"new_column",dataType:"varchar",nullable:1,comment:"新增字段"});
    assert.equal(service.getRun(run.id).catalogCurrent,false);assert.equal(service.listRuns(fixture.source.id)[0].catalogCurrent,false);
    await assert.rejects(service.evaluateAndStore(run.id,objectCandidate()),/物理目录自生成批次创建后已变化/);
    assert.equal(service.listCandidates({runId:run.id}).length,0);
  } finally { fixture.store.close(); }
});

test("bulk decisions validate one source and report per-candidate concurrency conflicts",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{model:"embed-v1"}};
    let scoreCalls=0;const scorer={score:async(candidate,options)=>{scoreCalls+=1;return scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9});}};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer","sales_order"],domainName:"sales"},"editor-a");
    const customer=await service.evaluateAndStore(run.id,objectCandidate());const order=await service.evaluateAndStore(run.id,orderCandidate());
    const generationScoreCalls=scoreCalls;
    const result=await service.bulkDecide({sourceId:fixture.source.id,candidateIds:[customer.id,order.id,customer.id],decision:"confirm",note:"批量双检"},"editor-a");
    assert.equal(result.total,2);assert.equal(result.succeeded,2);assert.equal(result.failed,0);assert.ok(result.results.every((item)=>item.candidate.status==="confirmed"));
    assert.equal(scoreCalls,generationScoreCalls,"未编辑候选批量确认不应重复请求 Embedding 评分");
    const repeated=await service.bulkDecide({sourceId:fixture.source.id,candidateIds:[customer.id,order.id],decision:"confirm"},"editor-b");
    assert.equal(repeated.succeeded,0);assert.equal(repeated.failed,2);assert.ok(repeated.results.every((item)=>/只有待人工确认/.test(item.error)));
    await assert.rejects(service.bulkDecide({sourceId:fixture.source.id+1,candidateIds:[customer.id],decision:"confirm"},"editor-b"),/不属于当前数据源/);
  } finally { fixture.store.close(); }
});

test("recovered generation runs reuse already persisted stable keys idempotently",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const generator={generateObjects:async({onCandidate})=>{const stored=await onCandidate(objectCandidate());return {candidates:[stored],calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[]};}};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,generator});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"]},"editor-a");
    fixture.store.transitionOntologyGenerationRun({id:run.id,expectedStatus:"queued",status:"running",progress:30,summary:run.summary});
    await service.evaluateAndStore(run.id,objectCandidate(),"model");
    const result=await service.runGeneration({payload:{runId:run.id}});
    assert.equal(result.candidateCount,1);
    assert.equal(fixture.store.getOntologyGenerationRun(run.id).status,"succeeded");
    assert.equal(fixture.store.listOntologyCandidates({runId:run.id}).length,1);
  } finally { fixture.store.close(); }
});

test("generation summaries retain missing table coverage for a targeted supplemental run",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{model:"embed-v1"}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const generator={
      generateObjects:async({onCandidate})=>generationResult([await onCandidate(objectCandidate())]),
      generateLinks:async()=>({...generationResult([]),eligibleRelationCount:0}),
    };
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,generator});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer","sales_order"],domainName:"sales"},"editor-a");
    const result=await service.runGeneration({payload:{runId:run.id}});
    assert.equal(result.objectCoveredTableCount,1);assert.equal(result.objectMissingTableCount,1);assert.deepEqual(result.objectMissingTables,["sales_order"]);
  } finally { fixture.store.close(); }
});

test("the automatic run stage generates Links only from auto-confirmed Object endpoints",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"auto_draft",autoConfirmScore:78,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{model:"embed-v1"}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    let linkEndpoints=[];
    const generator={
      generateObjects:async({onCandidate})=>generationResult([await onCandidate(objectCandidate()),await onCandidate(orderCandidate())]),
      generateLinks:async({phase,endpoints,onCandidate})=>{assert.equal(phase,"auto");linkEndpoints=endpoints;const customer=endpoints.find((item)=>item.payload.apiName==="customer");const order=endpoints.find((item)=>item.payload.apiName==="order");return {...generationResult([await onCandidate(linkCandidate(fixture.relation.id,customer,order))]),eligibleRelationCount:1};},
    };
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,generator});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer","sales_order"],domainName:"sales"},"editor-a");
    const result=await service.runGeneration({payload:{runId:run.id}});
    assert.equal(linkEndpoints.length,2);assert.ok(linkEndpoints.every((item)=>item.status==="auto_confirmed"));assert.equal(result.objectCount,2);assert.equal(result.linkCount,1);assert.equal(result.linkEligibleRelationCount,1);
    assert.equal(fixture.store.listOntologyCandidates({runId:run.id,candidateType:"link"})[0].status,"auto_confirmed");
  } finally { fixture.store.close(); }
});

test("confirmed Object and Link candidates form a validated immutable draft with exclusions and replacement audit",async()=>{
  const fixture=await createFixture();
  try {
    const config={ontologyAi:{mode:"auto_draft",autoConfirmScore:78,maxTables:20,maxFields:600},llm:{model:"model"},embedding:{model:"embed-v1"}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const semanticSchemas=createSemanticSchemaService({store:fixture.store});
    fixture.store.createOntologyGenerationRun({id:"older-run",sourceId:fixture.source.id,mode:"selected_tables",scope:{tableNames:["crm_customer"],namespace:"sales"},catalogChecksum:"old",promptVersion:"v1",scoringVersion:"v1",status:"succeeded",createdBy:"editor-old"});
    const older=fixture.store.createOntologyCandidate({id:"older-customer",runId:"older-run",sourceId:fixture.source.id,candidateType:"object",stableKey:"object:sales:crm_customer",payload:objectCandidate().payload,status:"confirmed"});
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,semanticSchemas});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer","sales_order","customer_tag"],domainName:"sales"},"editor-a");
    const customer=await service.evaluateAndStore(run.id,objectCandidate());
    const order=await service.evaluateAndStore(run.id,orderCandidate());
    const tag=await service.evaluateAndStore(run.id,tagCandidate());
    const link=await service.evaluateAndStore(run.id,linkCandidate(fixture.relation.id,customer,order));
    for(const candidate of [customer,order,tag,link])assert.equal(candidate.status,"auto_confirmed");
    finishRun(fixture.store,run.id);

    const preview=service.preview(run.id,{excludeCandidateIds:[tag.id]});
    assert.equal(preview.validation.ok,true);assert.equal(preview.summary.objectsAdded,2);assert.equal(preview.summary.linksAdded,1);assert.equal(fixture.store.getOntologyCandidate(customer.id).status,"auto_confirmed");
    const result=service.apply(run.id,{excludeCandidateIds:[tag.id]},"editor-a");
    assert.equal(result.draft.status,"draft");assert.equal(result.validation.ok,true);assert.equal(result.summary.objectsAdded,2);assert.equal(result.summary.linksAdded,1);
    assert.deepEqual(result.draft.schema.objectTypes.map((item)=>item.apiName).sort(),["customer","order"]);assert.equal(result.draft.schema.linkTypes[0].apiName,"customer_orders");
    for(const candidate of [customer,order,link]){const stored=fixture.store.getOntologyCandidate(candidate.id);assert.equal(stored.status,"applied");assert.equal(stored.appliedSchemaVersionId,result.draft.id);}
    assert.equal(fixture.store.getOntologyCandidate(tag.id).status,"auto_confirmed");
    assert.equal(fixture.store.getOntologyCandidate(older.id).status,"superseded");assert.equal(fixture.store.getOntologyCandidate(older.id).supersededById,customer.id);
    assert.equal(fixture.store.getPublishedOntologySchema(fixture.source.id),null);
  } finally { fixture.store.close(); }
});

test("draft preview returns a real diff and requires an explicit human conflict resolution",async()=>{
  const fixture=await createFixture();
  try {
    const semanticSchemas=createSemanticSchemaService({store:fixture.store});
    const base=semanticSchemas.saveDraft(fixture.source.id,{name:"sales",displayName:"销售",objectTypes:[objectCandidate().payload],linkTypes:[]},"editor-a");
    fixture.store.publishOntologySchemaVersion(base.id,"editor-a");
    const config={ontologyAi:{mode:"auto_draft",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{model:"embed-v1"}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,semanticSchemas});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"],domainName:"sales"},"editor-a");
    const input=objectCandidate();input.payload.displayName="核心客户";input.payload.description="人工采用的客户定义";
    const candidate=await service.evaluateAndStore(run.id,input);assert.equal(candidate.status,"auto_confirmed");finishRun(fixture.store,run.id);

    const unresolved=service.preview(run.id,{});
    assert.equal(unresolved.summary.objectsAdded,0);assert.equal(unresolved.summary.unresolvedConflictCount,1);assert.equal(unresolved.diff.summary.total,0);
    assert.deepEqual(unresolved.conflicts[0].allowedResolutions,["keep_existing","use_candidate"]);
    assert.throws(()=>service.apply(run.id,{},"editor-a"),/未处理的 Schema 冲突/);

    const revised=service.preview(run.id,{conflictResolutions:{[candidate.id]:"use_candidate"}});
    assert.equal(revised.summary.unresolvedConflictCount,0);assert.equal(revised.summary.resolvedConflictCount,1);assert.equal(revised.summary.candidateCount,1);
    assert.equal(revised.diff.summary.changed,1);assert.equal(revised.diff.changes[0].path,"objectTypes.customer");
    const result=service.apply(run.id,{conflictResolutions:{[candidate.id]:"use_candidate"}},"editor-a");
    assert.equal(result.draft.schema.objectTypes[0].displayName,"核心客户");assert.equal(fixture.store.getOntologyCandidate(candidate.id).status,"applied");
  } finally { fixture.store.close(); }
});

test("a published base version change blocks applying a completed generation run",async()=>{
  const fixture=await createFixture();
  try {
    const semanticSchemas=createSemanticSchemaService({store:fixture.store});
    const base=semanticSchemas.saveDraft(fixture.source.id,{name:"sales",displayName:"销售",objectTypes:[objectCandidate().payload],linkTypes:[]},"editor-a");
    fixture.store.publishOntologySchemaVersion(base.id,"editor-a");
    const config={ontologyAi:{mode:"auto_draft",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{model:"embed-v1"}};
    const scorer={score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})};
    const service=createOntologyCandidateService({store:fixture.store,config,scorer,semanticSchemas});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["sales_order"],domainName:"sales"},"editor-a");
    assert.equal(run.baseSchemaVersionId,base.id);assert.equal(run.scope.publishedSchemaVersionIdAtStart,base.id);
    await service.evaluateAndStore(run.id,orderCandidate());finishRun(fixture.store,run.id);
    const next=fixture.store.createOntologySchemaVersion({sourceId:fixture.source.id,schemaName:"sales",schema:{...base.schema,displayName:"新销售模型"},checksum:"next",validation:{ok:true,errors:[],warnings:[]},createdBy:"editor-b"});
    fixture.store.publishOntologySchemaVersion(next.id,"editor-b");
    assert.throws(()=>service.apply(run.id,{},"editor-a"),/当前发布 Schema 已变化/);
    assert.equal(fixture.store.listOntologySchemaVersions(fixture.source.id).length,2);
  } finally { fixture.store.close(); }
});

test("generation selects verified knowledge by embedding top-K while retaining hard table matches",async()=>{
  const fixture=await createFixture();
  try{
    for(let index=0;index<35;index++)fixture.store.upsertKnowledge({sourceId:fixture.source.id,pageType:"term",slug:`page-${index}`,title:`知识 ${index}`,content:`内容 ${index}`,tablesJson:JSON.stringify(index===34?["crm_customer"]:[]),verified:1});
    const pageVectors=new Map(Array.from({length:35},(_,index)=>[`term:page-${index}`,[Math.max(0,1-index/40),index/40]]));let selected=[];
    const embeddingIndex={enabled:()=>true,loadVectors:()=>({pageVectors,tableVectors:new Map()}),embedQuestion:async()=>[1,0]};
    const generator={generateObjects:async({knowledgePages})=>{selected=knowledgePages;return generationResult([]);},generateLinks:async()=>({...generationResult([]),eligibleRelationCount:0})};
    const service=createOntologyCandidateService({store:fixture.store,config:{ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{}},generator,embeddingIndex});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"],domainName:"crm"},"editor-a");const result=await service.runGeneration({payload:{runId:run.id}});
    assert.equal(selected.length,30);assert.ok(selected.some((page)=>page.slug==="page-34"),"hard table match must survive top-K truncation");assert.equal(result.knowledgeRetrievalMode,"embedding_top_k");
  }finally{fixture.store.close();}
});

test("generation recalls a bounded term-anchor top-N with embeddings",async()=>{
  const fixture=await createFixture();
  try{
    for(let index=0;index<101;index++)fixture.store.upsertTermAnchor({vocabulary:"corp",canonicalId:index===100?"TARGET":`NOISE_${index}`,prefLabelZh:index===100?"客户主体":`无关术语 ${index}`,kind:"object"});
    let selected=[];
    const generator={generateObjects:async({catalog})=>{selected=catalog.termAnchors;return generationResult([]);},generateLinks:async()=>({...generationResult([]),eligibleRelationCount:0})};
    const embeddingFetchImpl=async(_url,init)=>{const body=JSON.parse(init.body);const inputs=body.input;return new Response(JSON.stringify({data:inputs.map((value,index)=>({index,embedding:String(value).includes("客户主体")?[1,0]:[0,1]}))}),{status:200,headers:{"content-type":"application/json"}});};
    const service=createOntologyCandidateService({store:fixture.store,config:{ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{baseUrl:"https://embed.test/v1",apiKey:"key",model:"embed-v1"}},generator,embeddingFetchImpl});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"],domainName:"crm"},"editor-a");const result=await service.runGeneration({payload:{runId:run.id}});
    assert.equal(selected.length,100);assert.ok(selected.some((anchor)=>anchor.canonicalId==="TARGET"));assert.equal(result.termAnchorRetrievalMode,"embedding_top_n");assert.equal(result.termAnchorCount,100);
  }finally{fixture.store.close();}
});

test("new generation runs snapshot the adopted per-source threshold",async()=>{
  const fixture=await createFixture();
  try{
    fixture.store.updateSourceOntologyAutoConfirmScore({sourceId:fixture.source.id,autoConfirmScore:88,evidenceRunIds:["calibration-run"],actor:"admin-a"});
    const service=createOntologyCandidateService({store:fixture.store,config:{ontologyAi:{mode:"review",autoConfirmScore:80,maxTables:20,maxFields:600},llm:{},embedding:{}}});
    const run=service.createRun({sourceId:fixture.source.id,tableNames:["crm_customer"],domainName:"crm"},"editor-a");assert.equal(run.scope.autoConfirmScore,88);
  }finally{fixture.store.close();}
});

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-ontology-candidate-service-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"candidate-test",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:100,grade:"A",active:1,comment:"客户主体"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,comment:"客户编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"name",dataType:"varchar",nullable:0,comment:"客户名称"});
  store.upsertTable({sourceId:source.id,tableName:"sales_order",rowEstimate:500,grade:"A",active:1,comment:"销售订单"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"order_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,comment:"订单编号"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"customer_id",dataType:"bigint",nullable:0,isIndexed:1,comment:"客户编号"});
  store.upsertTable({sourceId:source.id,tableName:"customer_tag",rowEstimate:50,grade:"B",active:1,comment:"客户标签"});
  store.upsertColumn({sourceId:source.id,tableName:"customer_tag",columnName:"tag_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,comment:"标签编号"});
  const relation=store.upsertRelation({sourceId:source.id,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
  return {store,source,relation};
}

function objectCandidate() {
  return {candidateType:"object",modelConfidence:.99,evidence:[],payload:{apiName:"customer",displayName:"客户",description:"客户主体",primaryKey:"customer_id",freshness:"realtime",properties:[
    {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,freshness:"hourly",mapping:{table:"crm_customer",column:"customer_id"}},
    {apiName:"name",displayName:"客户名称",type:"string",required:true,mapping:{table:"crm_customer",column:"name"}},
  ]}};
}

function orderCandidate() { return {candidateType:"object",modelConfidence:.95,evidence:[],payload:{apiName:"order",displayName:"订单",description:"销售订单",primaryKey:"order_id",properties:[
  {apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},
  {apiName:"customer_id",displayName:"客户编号",type:"integer",required:false,mapping:{table:"sales_order",column:"customer_id"}},
]}}; }
function tagCandidate() { return {candidateType:"object",modelConfidence:.9,evidence:[],payload:{apiName:"tag",displayName:"标签",description:"客户标签",primaryKey:"tag_id",properties:[{apiName:"tag_id",displayName:"标签编号",type:"integer",required:true,mapping:{table:"customer_tag",column:"tag_id"}}]}}; }
function linkCandidate(relationId,customer,order) { return {candidateType:"link",sourceStableKey:customer.stableKey,targetStableKey:order.stableKey,modelConfidence:.9,evidence:[{kind:"physical_relation",refId:`relation:${relationId}`,verified:true}],payload:{apiName:"customer_orders",displayName:"客户订单",description:"客户拥有的订单",source:"customer",target:"order",cardinality:"one_to_many",relationKind:"references",relationMappings:[{relationId}]}}; }
function finishRun(store,id) { const started=store.transitionOntologyGenerationRun({id,expectedStatus:"queued",status:"running",progress:90});assert.equal(started.ok,true);const finished=store.transitionOntologyGenerationRun({id,expectedStatus:"running",status:"succeeded",progress:100});assert.equal(finished.ok,true); }
function generationResult(candidates) { return {candidates,calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[]}; }
