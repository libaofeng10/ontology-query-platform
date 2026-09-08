import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { createStore } from "../src/store.mjs";
import { createSourceOntologyBuildService } from "../src/source-ontology-build-service.mjs";
import { createOntologyDomainModelingService } from "../src/ontology-domain-modeling-service.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";
import { createTaskService } from "../src/task-service.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { evalSetChecksum } from "../src/evaluation-evidence.mjs";

async function fixture({mode="review",pausePlan=Promise.resolve(),firstBuild=false,candidateTransform=(candidate)=>candidate,onGenerate=()=>{},similarity=()=>.9,splitDomains=false,generateLinks=null}={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-source-build-"));
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"source-build-test-secret",nodeEnv:"test",claudeBridge:null,
    llm:{baseUrl:"",apiKey:"",model:""},embedding:{enabled:false},profiling:{enabled:false},
    ontologyAi:{mode,criticEnabled:false,maxTables:20,maxFields:600,auditDir:join(root,"audit")},
    ontologyCandidateScorer:{score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:similarity(candidate)})},
    apiIdentities:[{name:"viewer",role:"viewer",token:"viewer",sourceIds:[1]},{name:"editor",role:"editor",token:"editor",sourceIds:"*"}],
    connector:{close:async()=>{},query:async()=>[[],[]],explain:async()=>[]},
    rateLimits:{queryPerMinute:100,readPerMinute:1000,writePerMinute:1000},
    ontologyDomainPlanner:{plan:async()=>{
      await pausePlan;
      const tables=app.store.listTables(1).filter((table)=>["A","B"].includes(table.grade)&&!app.store.excludedTableNames(1).has(table.tableName));
      if(splitDomains)return {domains:tables.map(table=>({id:table.tableName,domainKey:table.tableName,name:table.tableName,batchIndex:1,batchCount:1,tables:[table]}))};
      return {domains:[{id:"selected-domain",domainKey:"selected",name:"已选业务域",batchIndex:1,batchCount:1,tables}]};
    }},
    ontologyCandidateGenerator:{...(generateLinks?{generateLinks}:{}),generateObjects:async({run,onCandidate,phase="auto",knowledgePages=[]})=>{
      await onGenerate({run,phase,knowledgePages});
      const items=[];
      for(const table of run.scope.tableNames){
        const column=app.store.listColumns(1,table).find((item)=>item.isPrimary)||app.store.listColumns(1,table)[0];
        items.push(await onCandidate(candidateTransform({candidateType:"object",mainTable:table,payload:{apiName:`built_${table}`,displayName:"自动构建的客户",description:"从选定的数据表构建",primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table,column:column.columnName}}]},evidence:[{kind:"physical_table",refId:`table:${table}`,verified:true}],contractErrors:[],modelConfidence:.95},{run,phase,knowledgePages})));
      }
      return {candidates:items,calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[]};
    }},
  });
  if(firstBuild){app.store.db.prepare("DELETE FROM ds_ontology_publication WHERE source_id=1").run();app.store.db.prepare("DELETE FROM ds_ontology_schema_version WHERE source_id=1").run();}
  const selections=app.store.listTables(1).map((table)=>({tableName:table.tableName,included:table.tableName==="crm_customer"}));
  return {app,selections,close:async()=>{await app.close();await rm(root,{recursive:true,force:true});}};
}

test("选表后在同一后台任务完成探查与生成，审核和启用仍是明确操作",async()=>{
  const {app,selections,close}=await fixture();
  try{
    const previous=app.store.getPublishedOntologySchema(1);
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    assert.equal(started.status,202);
    const task=await waitForTask(app,started.body.id);
    assert.equal(task.status,"succeeded",task.error);
    assert.equal(task.result.objectCount,1);
    assert.equal(task.result.discovery.totalTables,1);
    assert.ok(task.payload.sourceBuild.discovery);
    assert.deepEqual(task.payload.sourceBuild.plan.domains[0].tables.map((table)=>table.tableName),["crm_customer"]);
    const runs=app.store.listOntologyGenerationRuns(1);
    assert.equal(runs.length,1);
    assert.equal(runs[0].scope.orchestrationId,task.id);
    assert.deepEqual(runs[0].scope.tableNames,["crm_customer"]);
    const candidates=app.store.listOntologyCandidates({runId:runs[0].id});
    assert.equal(candidates.length,1);assert.equal(candidates[0].status,"review_required");
    assert.equal(app.store.getPublishedOntologySchema(1)?.id,previous?.id);
    const status=await api(app,"/api/sources/1/ontology-build",null,"GET","viewer");
    assert.equal(status.status,200);assert.equal(status.body.task.id,task.id);assert.equal(status.body.profilingEnabled,false);
    const workflow=await api(app,`/api/ontology/domain-modeling/${task.id}/summary`,null,"GET");
    assert.equal(workflow.body.reviewRequiredCount,1);
    assert.equal((await api(app,`/api/ontology/domain-modeling/${task.id}/apply`,{})).status,409);
    assert.equal((await api(app,`/api/ontology/candidates/${candidates[0].id}/decision`,{decision:"confirm"})).status,200);
    const preview=await api(app,`/api/ontology/domain-modeling/${task.id}/preview`,{});
    assert.equal(preview.status,200);assert.equal(preview.body.validation.ok,true);
    const conflictResolutions=Object.fromEntries(preview.body.conflicts.map((conflict)=>[conflict.candidateId,conflict.allowedResolutions.includes("use_candidate")?"use_candidate":"keep_existing"]));
    const applied=await api(app,`/api/ontology/domain-modeling/${task.id}/apply`,{conflictResolutions});
    assert.equal(applied.status,201,JSON.stringify(applied.body));assert.equal(applied.body.draft.status,"draft");
    assert.equal(app.store.getPublishedOntologySchema(1)?.id,previous?.id);
  }finally{await close();}
});

test("已有范围被移除时，自动合并后用一份变化摘要确认，保留当前版本",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft"});
  try {
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    assert.equal(started.status,202);
    const task=await waitForTask(app,started.body.id);
    assert.equal(task.status,"succeeded",task.error);
    assert.equal(task.result.autoConfirmedCount,1);assert.equal(task.result.reviewRequiredCount,0);
    const [run]=app.store.listOntologyGenerationRuns(1);
    assert.equal(run.scope.autoConfirmScore,85);
    const [candidate]=app.store.listOntologyCandidates({runId:run.id});
    assert.equal(candidate.score,85);assert.equal(candidate.status,"applied");
    assert.deepEqual(app.ontologyCandidates.listEvents(candidate.id).map((event)=>event.eventType),["auto_route","applied"]);
    const workflow=await api(app,`/api/ontology/domain-modeling/${task.id}/summary`,null,"GET");
    assert.equal(workflow.body.readyForDraft,false);
    assert.equal(task.payload.sourceBuild.phase,"awaiting_change");
    assert.notEqual(app.store.getPublishedOntologySchema(1).id,task.payload.sourceBuild.draftVersionId);
    const preview=await api(app,`/api/ontology/domain-modeling/${task.id}/preview`,{});
    assert.equal(preview.status,200);assert.equal(preview.body.validation.ok,true);
  } finally { await close(); }
});

test("构建期间重复点击复用任务，更改范围或并行探查被阻止",async()=>{
  let release;const pausePlan=new Promise((resolve)=>{release=resolve;});
  const {app,selections,close}=await fixture({pausePlan});
  try{
    const first=await api(app,"/api/sources/1/ontology-build",{selections});
    assert.equal(first.status,202);
    const again=await api(app,"/api/sources/1/ontology-build",{selections:selections.filter((item)=>item.included)});
    assert.equal(again.status,202);assert.equal(again.body.id,first.body.id);
    assert.equal((await api(app,"/api/sources/1/ontology-build",{selections:[{tableName:"sales_order",included:true}]})).status,409);
    assert.equal((await api(app,"/api/sources/1/tables/selection",{selections},"PUT")).status,409);
    assert.equal((await api(app,"/api/sources/1/discover",{})).status,409);
    assert.equal((await api(app,"/api/ontology/generation-runs",{sourceId:1,tableNames:["crm_customer"]})).status,409);
    release();assert.equal((await waitForTask(app,first.body.id)).status,"succeeded");
  }finally{release();await close();}
});

test("选表构建校验角色、数据源和空范围；配置关闭不改变现有范围",async()=>{
  const {app,selections,close}=await fixture();
  try{
    assert.equal((await api(app,"/api/sources/1/ontology-build",{selections},"POST","viewer")).status,403);
    for(const invalid of [[],[{tableName:"crm_customer",included:false}],[{tableName:"crm_customer",included:true},{tableName:"crm_customer",included:false}],[{tableName:"crm_customer"}],[{tableName:"missing_table",included:true}]]){
      assert.equal((await api(app,"/api/sources/1/ontology-build",{selections:invalid})).status,400);
    }
    const other=app.store.createSource({name:"untested",kind:"mysql",host:"db",port:3306,dbName:"other",userName:"ro",credential:"test",isDemo:false});
    assert.equal((await api(app,`/api/sources/${other.id}/ontology-build`,{selections})).status,400);
    assert.equal((await api(app,`/api/sources/${other.id}/ontology-build`,null,"GET","viewer")).status,403);
    assert.equal(app.store.listTasks(1).length,0);
  }finally{await close();}
  const disabled=await fixture({mode:"off"});
  try{
    const before=disabled.app.store.listTables(1).length;
    assert.equal((await api(disabled.app,"/api/sources/1/ontology-build",{selections:disabled.selections})).status,409);
    assert.equal(disabled.app.store.listTables(1).length,before);
    assert.equal(disabled.app.store.listTasks(1).length,0);
  }finally{await disabled.close();}
});

test("重启后复用已完成探查与域计划，不重读数据或重复创建已开始的批次",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-source-build-resume-"));
  const dbPath=join(root,"store.sqlite");let store=createStore(dbPath);
  const source=store.createSource({name:"resume",kind:"mysql",host:"db",port:3306,dbName:"resume",userName:"ro",credential:"test",isDemo:false});
  store.markSourceTest(source.id,true);
  const selections=[{tableName:"customer",included:true}];
  store.createTask({id:"resume",sourceId:source.id,taskType:"ontology_domain_modeling",payloadJson:JSON.stringify({actor:"editor",sourceBuild:{selections}})});
  let discoveries=0,plans=0,created=0,interrupted=true;
  const runs=[];
  const candidates={listRuns:()=>runs,createRun(input){created++;const run={id:"run-one",status:"running",scope:input};runs.push(run);return run;},runGeneration:async()=>{if(interrupted)throw new Error("模拟进程中断");return {objectCount:1};}};
  const modeling=createOntologyDomainModelingService({candidates,domainPlanner:{plan:async()=>{plans++;return {domains:[{id:"stable-plan",name:"客户",tables:[{tableName:"customer"}]}]};}}});
  const discovery={discover:async()=>{discoveries++;return {totalTables:1};}};
  const build=()=>createSourceOntologyBuildService({store,discovery,modeling,tasks:{},config:{ontologyAi:{mode:"review"}}});
  const context=()=>({task:store.getTask("resume"),source:store.getSource(source.id),payload:store.getTask("resume").payload,onProgress:()=>{}});
  try{
    store.startTask("resume");
    await assert.rejects(build().run(context()),/模拟进程中断/);
    store.close();store=createStore(dbPath);
    store.requeueInterruptedTasks();store.startTask("resume");interrupted=false;
    const result=await build().run(context());
    assert.equal(result.objectCount,1);
    assert.equal(discoveries,1);assert.equal(plans,1);assert.equal(created,1);
    assert.equal(result.orchestrationId,"resume");
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test("首次选表一次完成自动合并与启用，同一结构更新不创建新版本",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true});
  try {
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    const task=await waitForTask(app,started.body.id);
    assert.equal(task.status,"succeeded",task.error);
    assert.equal(task.payload.sourceBuild.phase,"ready",JSON.stringify(task.payload.sourceBuild.questions));
    const published=app.store.getPublishedOntologySchema(1);
    assert.equal(published.version,1);
    assert.equal(published.id,task.payload.sourceBuild.publishedVersionId);
    const [candidate]=app.store.listOntologyCandidates({runId:task.result.runIds[0]});
    assert.equal(candidate.status,"applied");
    const state=(await api(app,"/api/sources/1/ontology-build",null,"GET","viewer")).body;
    assert.equal(state.availability.canQuery,true);assert.equal(state.activeVersion.id,published.id);
    assert.equal(state.update.phase,"ready");assert.equal(state.update.questions.length,0);
    const again=await api(app,"/api/sources/1/ontology-build",{selections});
    const unchanged=await waitForTask(app,again.body.id);
    assert.equal(unchanged.payload.sourceBuild.phase,"unchanged",JSON.stringify(unchanged));
    assert.equal(app.store.listOntologySchemaVersions(1).length,1);
    assert.equal(app.store.listOntologyGenerationRuns(1).length,1);
    assert.equal(app.store.listOntologyPublications(1).length,1);
  }finally{await close();}
});

test("业务说明直接保存自动启用；接入新增表继承人工修改和版本历史",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true});
  try {
    const additionalTable=app.store.listTables(1).find((table)=>table.tableName==="sales_order");
    const additionalColumns=app.store.listColumns(1,"sales_order");
    const first=await api(app,"/api/sources/1/ontology-build",{selections});
    await waitForTask(app,first.body.id);
    const v1=app.store.getPublishedOntologySchema(1),object=v1.schema.objectTypes[0];
    const edited=await api(app,"/api/sources/1/ontology-build/correct",{versionId:v1.id,objectName:object.apiName,displayName:"正式客户",description:"人工明确：已签约且尚在服务期的客户"});
    assert.equal(edited.status,202);
    const edit=await waitForTask(app,edited.body.id);
    assert.equal(edit.payload.sourceBuild.phase,"ready",JSON.stringify(edit));
    const v2=app.store.getPublishedOntologySchema(1);
    assert.equal(v2.version,2);assert.equal(v2.schema.objectTypes[0].description,"人工明确：已签约且尚在服务期的客户");
    assert.equal((await api(app,"/api/sources/1/ontology-build/correct",{versionId:v1.id,objectName:object.apiName,displayName:"过期",description:"不应覆盖"})).status,409);
    const changed=selections.map((item)=>({...item,included:["crm_customer","sales_order"].includes(item.tableName)}));
    // The demo catalog is also its physical database; introduce a table there.
    app.store.upsertTable({...additionalTable,sourceId:1});
    for(const column of additionalColumns)app.store.upsertColumn({...column,sourceId:1,tableName:"sales_order"});
    const next=await api(app,"/api/sources/1/ontology-build",{selections:changed});
    assert.equal(next.status,202,JSON.stringify(next));
    const update=await waitForTask(app,next.body.id);
    assert.equal(update.payload.sourceBuild.phase,"ready",JSON.stringify(update));
    const v3=app.store.getPublishedOntologySchema(1);
    assert.equal(v3.version,3);assert.equal(v3.schema.objectTypes.length,2);
    assert.equal(v3.schema.objectTypes.find((item)=>item.apiName===object.apiName).displayName,"正式客户");
    assert.equal(v3.schema.objectTypes.find((item)=>item.apiName===object.apiName).description,"人工明确：已签约且尚在服务期的客户");
    assert.equal(app.store.getOntologySchemaVersion(v1.id).schema.objectTypes[0].description,"从选定的数据表构建");
  }finally{await close();}
});

test("低分定义先修正两轮，补充一次说明后继续原任务，评分规则不变",async()=>{
  const calls=[];
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true,
    onGenerate:({phase})=>calls.push(phase),
    candidateTransform:(candidate,{knowledgePages})=>({...candidate,payload:{...candidate.payload,description:knowledgePages.some((page)=>page.slug.startsWith("ontology-"))?"业务依据已明确":"待完善"}}),
    similarity:(candidate)=>candidate.payload.description==="待完善"?0:.9});
  try {
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    const task=await waitForTask(app,started.body.id);
    assert.equal(task.payload.sourceBuild.phase,"needs_input",JSON.stringify(task));
    assert.deepEqual(calls,["auto","repair-1","repair-2"]);
    const issue=task.payload.sourceBuild.questions[0];
    assert.equal(task.payload.sourceBuild.questions.length,1);
    assert.equal(app.store.getPublishedOntologySchema(1),null);
    const resumed=await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id,answers:[{questionId:issue.id,text:"这张表记录已签约客户，编号为唯一客户标识"}],autoConfirmScore:0});
    assert.equal(resumed.status,202);assert.equal(resumed.body.id,task.id);
    const finished=await waitForTask(app,task.id);
    assert.equal(finished.payload.sourceBuild.phase,"ready",JSON.stringify(finished));
    assert.deepEqual(calls,["auto","repair-1","repair-2","repair-3"]);
    const [run]=app.store.listOntologyGenerationRuns(1);
    assert.equal(run.scope.autoConfirmScore,85);assert.equal(run.summary.repairAttempts,3);
    assert.equal(app.store.listKnowledge(1).filter((page)=>page.slug.startsWith("ontology-")).length,1);
    assert.equal(app.store.listTasks(1).length,1);assert.equal(app.store.listOntologyPublications(1).length,1);
  }finally{await close();}
});

test("失败域按原因聚合并有界重试；配置错误不自动重试",async()=>{
  for(const [message,expectedCalls] of [["模型调用超时",3],["401 unauthorized API key",1]]) {
    let calls=0;
    const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true,onGenerate:()=>{calls++;throw new Error(message);}});
    try {
      const first=await api(app,"/api/sources/1/ontology-build",{selections});
      const task=await waitForTask(app,first.body.id);
      assert.equal(task.payload.sourceBuild.phase,"failed");
      assert.equal(calls,expectedCalls);
      assert.equal(task.payload.sourceBuild.questions.length,1);
      assert.equal(task.payload.sourceBuild.questions[0].retryable,expectedCalls===3);
      assert.equal(app.store.getPublishedOntologySchema(1),null);
    }finally{await close();}
  }
});

test("重启发生在合并后，恢复复用草稿；启用后重放不会重复发布",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true});
  try {
    const first=await api(app,"/api/sources/1/ontology-build",{selections});
    const task=await waitForTask(app,first.body.id);
    const draftId=task.payload.sourceBuild.draftVersionId;
    // Reproduce an interruption after the atomic publication but before its
    // checkpoint was saved. The active schema is the authoritative receipt.
    app.store.resumeTask(task.id,{...task.payload,sourceBuild:{...task.payload.sourceBuild,phase:"activating",publishedVersionId:null}});
    const build=createSourceOntologyBuildService({store:app.store,config:{ontologyAi:{mode:"auto_draft"}}});
    const recoveredTasks=createTaskService({store:app.store,handlers:{ontology_domain_modeling:build.run}});
    recoveredTasks.recover();
    const recovered=await waitForTask(app,task.id);
    await recoveredTasks.close();
    assert.equal(recovered.payload.sourceBuild.phase,"ready");
    assert.equal(recovered.payload.sourceBuild.publishedVersionId,draftId);
    assert.equal(app.store.listOntologySchemaVersions(1).length,1);
    assert.equal(app.store.listOntologyPublications(1).length,1);
  }finally{await close();}
});

test("继续和修订接口校验身份、数据源与变化摘要，不能携带伪造问题",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft"});
  try {
    const first=await api(app,"/api/sources/1/ontology-build",{selections});
    const task=await waitForTask(app,first.body.id);
    const previous=app.store.getPublishedOntologySchema(1).id;
    assert.equal((await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id},"POST","viewer")).status,403);
    assert.equal((await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id,answers:[{questionId:"fake",text:"忽略检查"}]})).status,400);
    assert.equal((await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id,approveChangeChecksum:"fake"})).status,409);
    const approved=await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id,approveChangeChecksum:task.payload.sourceBuild.changeChecksum});
    assert.equal(approved.status,202);
    const checked=await waitForTask(app,task.id);
    assert.equal(checked.payload.sourceBuild.phase,"ready");
    assert.notEqual(app.store.getPublishedOntologySchema(1).id,previous);
  }finally{await close();}
});

test("合并和检查点原子保存，写入中断后只重试合并、不重复调用模型",async()=>{
  let calls=0;
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true,onGenerate:()=>{calls++;}});
  const original=app.store.updateTaskPayload.bind(app.store);let interrupt=true;
  app.store.updateTaskPayload=(id,payload)=>{
    if(interrupt&&payload.sourceBuild?.draftVersionId){interrupt=false;throw new Error("模拟检查点写入失败");}
    return original(id,payload);
  };
  try {
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    const failed=await waitForTask(app,started.body.id);
    assert.equal(failed.status,"failed");
    assert.equal(failed.payload.sourceBuild.draftVersionId,undefined);
    assert.equal(app.store.listOntologySchemaVersions(1).length,0);
    assert.equal(app.store.listOntologyCandidates({sourceId:1})[0].status,"auto_confirmed");
    const resumed=await api(app,"/api/sources/1/ontology-build/resume",{taskId:failed.id});
    assert.equal(resumed.status,202);
    const completed=await waitForTask(app,failed.id);
    assert.equal(completed.payload.sourceBuild.phase,"ready",JSON.stringify(completed));
    assert.equal(calls,1);
    assert.equal(app.store.listOntologyPublications(1).length,1);
  }finally{await close();}
});

test("后台按候选版本执行所需评测，浏览器不参与；缺少依据时保留原版本",async()=>{
  const {app,close}=await fixture();
  try {
    const schemas=createSemanticSchemaService({store:app.store});
    const published=app.store.getPublishedOntologySchema(1),schema=structuredClone(published.schema);
    schema.name="billing_updated";
    const draft=schemas.saveDraft(1,schema,"editor");
    // Root-name changes affect all behavior; there must be independently
    // authored cases, not tests created by the generation model itself.
    app.store.addEvalCase({sourceId:1,setName:"business_checks",question:"有效客户数量",goldSql:"SELECT COUNT(*) FROM crm_customer",category:"客户",heldOut:0});
    const cases=app.store.listEvalCasesForImpact(1);
    const selected=[...new Set(schema.objectTypes.flatMap((object)=>object.properties.map((property)=>property.mapping.table)))].map((tableName)=>({tableName,included:true}));
    const task=app.store.createTask({id:"activation-check",sourceId:1,taskType:"ontology_domain_modeling",payloadJson:JSON.stringify({actor:"editor",sourceBuild:{workflowVersion:2,kind:"correction",phase:"checking",selections:selected,baseVersionId:published.id,draftVersionId:draft.id}})});
    let calls=0;
    const evaluation={runGate:async({task:gateTask,payload})=>{
      calls++;assert.equal(payload.ontologySchemaVersionId,draft.id);assert.equal(payload.setName,"business_checks");
      const setCases=cases.filter((item)=>item.setName===payload.setName);
      app.store.saveEvalGate({id:gateTask.id,sourceId:1,setName:payload.setName,total:setCases.length,ontologySchemaVersion:draft.version,ontologySchemaPublishedAt:null,evaluationChecksum:evalSetChecksum(setCases),baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1},passed:1,decision:"enable_prefer",reason:"approved business cases"});
      return {passed:true};
    }};
    const build=createSourceOntologyBuildService({store:app.store,semanticSchemas:schemas,evaluation,config:{ontologyAi:{mode:"auto_draft"}}});
    app.store.startTask(task.id);
    const result=await build.run({task,source:app.store.getSource(1),payload:task.payload});
    assert.equal(calls,1);
    assert.equal(result.phase,"ready",JSON.stringify(app.store.getTask(task.id)));
    assert.equal(app.store.getPublishedOntologySchema(1).id,draft.id);
  }finally{await close();}
});

test("执行记录按一次更新读取全部调用，隔离数据源且不携带后台载荷",async()=>{
  const {app,selections,close}=await fixture({mode:"auto_draft",firstBuild:true});
  try {
    const started=await api(app,"/api/sources/1/ontology-build",{selections});
    const task=await waitForTask(app,started.body.id);
    const original=app.store.listOntologyGenerationRuns(1)[0];
    // Push the selected build beyond the old unfiltered 500-run window.
    // Use the store API so this fixture is independent of database column order.
    for(let index=0;index<505;index++)app.store.createOntologyGenerationRun({...original,id:`other-${index}`,scope:{...original.scope,orchestrationId:"another-build"}});
    const result=await api(app,`/api/sources/1/ontology-build/records/${task.id}`,null,"GET","viewer");
    assert.equal(result.status,200);
    assert.equal(result.body.phase,"ready");
    assert.equal(result.body.busy,false);
    assert.deepEqual(result.body.tableNames,["crm_customer"]);
    assert.equal(result.body.versionId,app.store.getPublishedOntologySchema(1).id);
    assert.deepEqual(result.body.runs.map((run)=>run.id),[original.id]);
    assert.ok(result.body.events.some((event)=>event.phase==="activating"));
    assert.equal(result.body.payload,undefined);assert.equal(result.body.runs[0].scope,undefined);
    assert.equal((await api(app,`/api/sources/999/ontology-build/records/${task.id}`,null,"GET","viewer")).status,404);
    assert.equal((await api(app,`/api/sources/1/ontology-build/records/missing`,null,"GET","viewer")).status,404);
    const other=app.store.createTask({id:"not-a-build",sourceId:1,taskType:"discovery",payloadJson:"{}"});
    assert.equal((await api(app,`/api/sources/1/ontology-build/records/${other.id}`,null,"GET","viewer")).status,404);
    const legacy=app.store.createTask({id:"legacy-failure",sourceId:1,taskType:"ontology_domain_modeling",payloadJson:"{}"});
    app.store.failTask(legacy.id,"历史模型连接失败");
    const failure=await api(app,`/api/sources/1/ontology-build/records/${legacy.id}`,null,"GET","viewer");
    assert.equal(failure.body.legacy,true);assert.equal(failure.body.phase,"failed");assert.equal(failure.body.error,"历史模型连接失败");
  }finally{await close();}
});

test("修改说明只继承当前版本范围，不要求为目录中其他表建模",async()=>{
  const {app,close}=await fixture({mode:"auto_draft"});
  try {
    const base=app.store.getPublishedOntologySchema(1),object=base.schema.objectTypes[0];
    const before=app.store.listTables(1);
    const mapped=[...new Set(base.schema.objectTypes.flatMap((item)=>item.properties.map((property)=>property.mapping.table)))].sort();
    assert.ok(before.length>mapped.length);
    const response=await api(app,"/api/sources/1/ontology-build/correct",{versionId:base.id,objectName:object.apiName,displayName:object.displayName,description:"修订后的业务说明"});
    assert.equal(response.status,202);
    const task=await waitForTask(app,response.body.id);
    assert.equal(task.payload.sourceBuild.phase,"ready",JSON.stringify(task.payload.sourceBuild.questions));
    assert.deepEqual(task.payload.sourceBuild.selections.map((item)=>item.tableName),mapped);
    assert.deepEqual(app.store.listTables(1),before);
    assert.equal(app.store.listOntologyGenerationRuns(1).length,0);
    assert.equal(app.store.getPublishedOntologySchema(1).schema.objectTypes[0].description,"修订后的业务说明");
  }finally{await close();}
});

async function api(app,path,body,method="POST",token="editor") {
  const request=Readable.from(body==null?[]:[JSON.stringify(body)]);
  Object.assign(request,{url:path,method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},socket:{remoteAddress:"127.0.0.1"}});
  let raw="";const response={statusCode:200,setHeader(){},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
async function waitForTask(app,id){for(let index=0;index<300;index++){const task=app.store.getTask(id);if(!["queued","running"].includes(task.status))return task;await new Promise((resolve)=>setTimeout(resolve,10));}throw new Error("任务等待超时");}

function completeLinks({catalog,endpoints,onCandidate}) {
  const byTable=new Map(endpoints.map(item=>[item.payload.properties[0].mapping.table,item]));
  return Promise.all(catalog.relations.filter(item=>["confirmed","accepted"].includes(item.status)&&byTable.has(item.fromTable)&&byTable.has(item.toTable)).map(relation=>{
    const source=byTable.get(relation.fromTable),target=byTable.get(relation.toTable);
    return onCandidate({candidateType:"link",sourceStableKey:source.stableKey,targetStableKey:target.stableKey,modelConfidence:.99,evidence:[{kind:"physical_relation",verified:true,refId:`relation:${relation.id}`}],payload:{apiName:`related_${relation.id}`,displayName:"订单所属客户",description:"订单关联客户",source:source.payload.apiName,target:target.payload.apiName,inverseApiName:`inverse_${relation.id}`,inverseDisplayName:"客户订单",relationKind:"references",cardinality:"many_to_one",relationMappings:[{relationId:relation.id}]}});
  })).then(candidates=>({candidates,calls:[],normalizationIssues:[],tokenUsage:{},eligibleRelationCount:candidates.length}));
}

test("跨域关系进入最终生效草稿，补边运行不要求重复生成对象",async()=>{
  const {app,close}=await fixture({mode:"auto_draft",firstBuild:true,splitDomains:true,generateLinks:completeLinks});
  try{
    const started=await api(app,"/api/sources/1/ontology-build",{selections:[{tableName:"crm_customer",included:true},{tableName:"sales_order",included:true}]});
    const task=await waitForTask(app,started.body.id);
    assert.equal(task.payload.sourceBuild.phase,"ready",JSON.stringify(task.payload.sourceBuild.questions));
    const published=app.store.getPublishedOntologySchema(1);
    assert.equal(published.schema.objectTypes.length,2);assert.equal(published.schema.linkTypes.length,1);
    assert.equal(task.payload.sourceBuild.relationCoverage.coveredRelationCount,1);
    assert.equal(app.store.listOntologyGenerationRuns(1).filter(run=>run.scope.scopeKind==="global_links").length,1);
  }finally{await close();}
});

test("待确认物理关系在对象生成前可见，回答后刷新依据并继续同一构建",async()=>{
  let calls=0;
  const {app,close}=await fixture({mode:"auto_draft",firstBuild:true,splitDomains:true,generateLinks:completeLinks,onGenerate:()=>{calls++;}});
  try{
    const relation=app.store.listRelations(1,true).find(item=>item.fromTable==="sales_order"&&item.toTable==="crm_customer");
    app.store.setRelationStatus(relation.id,"review");
    const started=await api(app,"/api/sources/1/ontology-build",{selections:[{tableName:"crm_customer",included:true},{tableName:"sales_order",included:true}]});
    let task=await waitForTask(app,started.body.id);
    const question=task.payload.sourceBuild.questions.find(item=>item.kind==="relation");
    assert.ok(question,JSON.stringify(task.payload.sourceBuild));assert.equal(calls,0);assert.equal(app.store.getPublishedOntologySchema(1),null);
    const resumed=await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id,answers:[{questionId:question.id,resolution:"confirm_relation"}]});
    assert.equal(resumed.status,202,JSON.stringify(resumed.body));assert.equal(resumed.body.id,task.id);
    task=await waitForTask(app,task.id);assert.equal(task.payload.sourceBuild.phase,"ready",JSON.stringify(task.payload.sourceBuild));
    assert.equal(app.store.listRelations(1,true).find(item=>item.id===relation.id).status,"confirmed");
    assert.equal(app.store.getPublishedOntologySchema(1).schema.linkTypes.length,1);assert.equal(calls,2);
    const before=app.store.listOntologyGenerationRuns(1).length;
    await api(app,"/api/sources/1/ontology-build/resume",{taskId:task.id});await waitForTask(app,task.id);
    assert.equal(app.store.listOntologyGenerationRuns(1).length,before);
  }finally{await close();}
});

test("历史版本缺少关系时，结构未变也不能直接报告无需更新",async()=>{
  let calls=0;const {app,close}=await fixture({mode:"auto_draft",firstBuild:true,splitDomains:true,generateLinks:completeLinks,onGenerate:()=>{calls++;}});
  try{
    const selections=[{tableName:"crm_customer",included:true},{tableName:"sales_order",included:true}];
    const first=await api(app,"/api/sources/1/ontology-build",{selections});await waitForTask(app,first.body.id);
    const legacy=app.store.getPublishedOntologySchema(1),schema=structuredClone(legacy.schema);schema.linkTypes=[];
    // A fixture for the old behavior: table coverage was complete but the link was lost.
    app.store.db.prepare("UPDATE ds_ontology_schema_version SET schema_json=? WHERE id=?").run(JSON.stringify(schema),legacy.id);
    const before=calls,started=await api(app,"/api/sources/1/ontology-build",{selections}),task=await waitForTask(app,started.body.id);
    assert.notEqual(task.payload.sourceBuild.phase,"unchanged");assert.ok(calls>before);
    assert.equal(task.payload.sourceBuild.relationCoverage.coveredRelationCount,1);
    assert.equal(app.store.getOntologySchemaVersion(task.payload.sourceBuild.draftVersionId).schema.linkTypes.length,1);
  }finally{await close();}
});

test("incomplete relation discovery pauses the build and continues the same checkpoint before generation",async()=>{
  const store=createStore(":memory:");let discoveries=0,generations=0;
  const source=store.createSource({name:"test",host:"test",dbName:"test",userName:"ro",credential:"test"});
  const payload={sourceBuild:{workflowVersion:2,baseVersionId:null,phase:"queued",selections:[{tableName:"customer",included:true}],events:[],questions:[]}};
  store.createTask({id:"relation-build",sourceId:source.id,taskType:"ontology_domain_modeling",payloadJson:JSON.stringify(payload)});
  const service=createSourceOntologyBuildService({store,config:{ontologyAi:{mode:"auto_draft"}},discovery:{discover:async(_source,options)=>{
    discoveries++;assert.equal(options.runId,"relation-build");assert.equal(options.resumeRelations,discoveries>1);
    return {relationDiscovery:{modelStatus:discoveries===1?"partial":"completed",checkpoint:{canResume:discoveries===1},error:discoveries===1?"还有补采样未完成":null}};
  }},modeling:{run:async()=>{generations++;throw new Error("test stops after reaching generation");}}});
  try{
    store.startTask("relation-build");
    const first=await service.run({task:store.getTask("relation-build"),source,payload});
    assert.equal(first.phase,"needs_input");assert.equal(generations,0);assert.equal(store.getTask("relation-build").payload.sourceBuild.questions[0].id,"relation-analysis");
    const task=store.getTask("relation-build");await assert.rejects(service.run({task,source,payload:task.payload}),/test stops/);
    assert.equal(discoveries,2);assert.equal(generations,1);assert.equal(store.getPublishedOntologySchema(source.id),null);
  }finally{store.close();}
});
