import assert from "node:assert/strict";
import test from "node:test";
import { createOntologyDomainModelingService } from "../src/ontology-domain-modeling-service.mjs";

function domain(id,name,tableName){return {id,domainKey:id,name,description:`${name}说明`,batchIndex:1,batchCount:1,tables:[{tableName}]};}

test("全域自动建模按域顺序生成 Object 与 Link 并汇总人工审核数",async()=>{
  const domains=[domain("crm","客户域","crm_customer"),domain("sales","交易域","sales_order")];
  const runs=[];const calls=[];let active=0;let maxActive=0;
  const candidates={
    listRuns:()=>runs,
    createRun(input,actor,{taskId}){const run={id:`run-${input.domainPlanId}`,status:"queued",scope:{...input,orchestrationId:input.orchestrationId,domainPlanId:input.domainPlanId},taskId,actor};runs.push(run);return run;},
    async runGeneration({payload,onProgress}){active++;maxActive=Math.max(maxActive,active);calls.push(payload.runId);onProgress({progress:50,currentStep:"评分"});await Promise.resolve();active--;const index=calls.length;const run=runs.find((item)=>item.id===payload.runId);run.status="succeeded";return {objectCount:index,linkCount:1,autoConfirmedCount:index,reviewRequiredCount:index-1,blockedCount:0};},
  };
  const service=createOntologyDomainModelingService({domainPlanner:{plan:async()=>({domains})},candidates});
  const progress=[];const result=await service.run({task:{id:"task-all"},source:{id:1},payload:{actor:"editor-a"},onProgress:(step)=>progress.push(step)});
  assert.deepEqual(calls,["run-crm","run-sales"]);assert.equal(maxActive,1);
  assert.equal(result.domainCount,2);assert.equal(result.succeededDomainCount,2);assert.equal(result.objectCount,3);assert.equal(result.linkCount,2);assert.equal(result.reviewRequiredCount,1);
  assert.ok(runs.every((run)=>run.scope.orchestrationId==="task-all"));assert.equal(progress.at(-1).progress,100);assert.match(progress.at(-1).currentStep,/Object 与 Link/);
});

test("单域失败不阻断后续域，恢复时复用同一编排已有批次",async()=>{
  const domains=[domain("bad","异常域","bad_table"),domain("ok","正常域","ok_table")];
  const runs=[{id:"run-bad",status:"succeeded",scope:{orchestrationId:"task-resume",domainPlanId:"bad"}}];
  let createCount=0;
  const candidates={
    listRuns:()=>runs,
    createRun(input){createCount++;const run={id:`run-${input.domainPlanId}`,status:"queued",scope:{...input}};runs.push(run);return run;},
    async runGeneration({payload}){if(payload.runId==="run-bad")throw new Error("模型输出无效");return {objectCount:2,linkCount:1,autoConfirmedCount:2,reviewRequiredCount:0,blockedCount:0};},
  };
  const service=createOntologyDomainModelingService({domainPlanner:{plan:async()=>({domains})},candidates});
  const result=await service.run({task:{id:"task-resume"},source:{id:1},payload:{}});
  assert.equal(createCount,1);assert.equal(result.succeededDomainCount,1);assert.equal(result.failedDomainCount,1);assert.equal(result.domains[0].runId,"run-bad");assert.equal(result.domains[1].runId,"run-ok");
});

test("存在其他活动批次时拒绝启动全域自动建模",()=>{
  const service=createOntologyDomainModelingService({domainPlanner:{plan:async()=>({domains:[]})},candidates:{listRuns:()=>[{id:"active",status:"running",scope:{domainName:"客户域"}}],createRun(){},runGeneration(){}}});
  assert.throws(()=>service.assertReady(1),(error)=>error.status===409&&/客户域/.test(error.message));
});
