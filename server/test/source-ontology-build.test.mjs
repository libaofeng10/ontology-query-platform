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

async function fixture({mode="review",pausePlan=Promise.resolve()}={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-source-build-"));
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"source-build-test-secret",nodeEnv:"test",claudeBridge:null,
    llm:{baseUrl:"",apiKey:"",model:""},embedding:{enabled:false},profiling:{enabled:false},
    ontologyAi:{mode,criticEnabled:false,maxTables:20,maxFields:600,auditDir:join(root,"audit")},
    ontologyCandidateScorer:{score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:.9})},
    apiIdentities:[{name:"viewer",role:"viewer",token:"viewer",sourceIds:[1]},{name:"editor",role:"editor",token:"editor",sourceIds:"*"}],
    connector:{close:async()=>{},query:async()=>[[],[]],explain:async()=>[]},
    rateLimits:{queryPerMinute:100,readPerMinute:1000,writePerMinute:1000},
    ontologyDomainPlanner:{plan:async()=>{
      await pausePlan;
      const tables=app.store.listTables(1).filter((table)=>["A","B"].includes(table.grade)&&!app.store.excludedTableNames(1).has(table.tableName));
      return {domains:[{id:"selected-domain",domainKey:"selected",name:"已选业务域",batchIndex:1,batchCount:1,tables}]};
    }},
    ontologyCandidateGenerator:{generateObjects:async({run,onCandidate})=>{
      const items=[];
      for(const table of run.scope.tableNames){
        const column=app.store.listColumns(1,table).find((item)=>item.isPrimary)||app.store.listColumns(1,table)[0];
        items.push(await onCandidate({candidateType:"object",mainTable:table,payload:{apiName:`built_${table}`,displayName:"自动构建的客户",description:"从选定的数据表构建",primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table,column:column.columnName}}]},evidence:[{kind:"physical_table",refId:`table:${table}`,verified:true}],contractErrors:[],modelConfidence:.95}));
      }
      return {candidates:items,calls:[],tokenUsage:{promptTokens:0,completionTokens:0,totalTokens:0},normalizationIssues:[]};
    }},
  });
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

test("自动确认模式下，选表构建的 85 分候选直接进入本体预览",async()=>{
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
    assert.equal(candidate.score,85);assert.equal(candidate.status,"auto_confirmed");
    assert.deepEqual(app.ontologyCandidates.listEvents(candidate.id).map((event)=>event.eventType),["auto_route"]);
    const workflow=await api(app,`/api/ontology/domain-modeling/${task.id}/summary`,null,"GET");
    assert.equal(workflow.body.readyForDraft,true);
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

async function api(app,path,body,method="POST",token="editor") {
  const request=Readable.from(body==null?[]:[JSON.stringify(body)]);
  Object.assign(request,{url:path,method,headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},socket:{remoteAddress:"127.0.0.1"}});
  let raw="";const response={statusCode:200,setHeader(){},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
async function waitForTask(app,id){for(let index=0;index<300;index++){const task=app.store.getTask(id);if(!["queued","running"].includes(task.status))return task;await new Promise((resolve)=>setTimeout(resolve,10));}throw new Error("任务等待超时");}
