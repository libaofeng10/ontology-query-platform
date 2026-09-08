import assert from "node:assert/strict";
import test from "node:test";
import { analyzeRelationCandidates } from "../src/relation-discovery-analysis.mjs";
import { proposeRelations } from "../src/relation-proposal.mjs";
import { createRelationModelService } from "../src/relation-model-service.mjs";
import { createStore } from "../src/store.mjs";

const schema={tables:[{tableName:"orders"},{tableName:"customer"}],columns:[
  {tableName:"orders",columnName:"customer_id",dataType:"bigint"},
  {tableName:"orders",columnName:"billing_customer_id",dataType:"bigint",comment:"客户"},
  {tableName:"customer",columnName:"id",dataType:"bigint",isPrimary:1},
],foreignKeys:[]};
const decision=(candidate,kind="uncertain")=>({candidateId:candidate.id,decision:kind,confidence:kind==="relation"?.9:.4,cardinality:"N:1",reason:"测试证据"});
const connector={query:async()=>[[{value:1,matchCount:1}]]};
const input={schema,source:{id:1,host:"db",dbName:"test",userName:"ro"},connector,config:{proposalsEnabled:false,stratifiedSampling:false,maxResampleCandidates:0}};

test("resume spends only remaining resample budget, preserves evidence and is idempotent",async()=>{
  let saved,queries=0;const judged=[];
  const options={...input,connector:{query:async(...args)=>{queries++;return connector.query(...args);}},onCheckpoint:async state=>{saved=structuredClone(state);},model:{judge:async candidates=>{judged.push(candidates.map(c=>c.id));return {status:"completed",decisions:candidates.map(c=>decision(c,c.dataEvidence.history?"relation":"uncertain"))};}}};
  const first=await analyzeRelationCandidates(options);const count=first.candidates.length;
  assert.ok(count>=2);assert.equal(first.diagnostics.pendingResampleCount,count);assert.ok(saved);
  const firstQueries=queries;
  const next=await analyzeRelationCandidates({...options,checkpoint:saved,config:{...input.config,maxResampleCandidates:1}});
  assert.equal(next.diagnostics.pendingResampleCount,count-1);assert.equal(judged[1].length,1);
  assert.equal(queries-firstQueries,firstQueries/count,"only one new sample");
  const last=await analyzeRelationCandidates({...options,checkpoint:saved,config:{...input.config,maxResampleCandidates:100}});
  assert.equal(last.modelResult.status,"completed");assert.equal(last.diagnostics.pendingResampleCount,0);
  const calls=judged.length,finishedQueries=queries;
  await analyzeRelationCandidates({...options,checkpoint:saved});
  assert.equal(judged.length,calls);assert.equal(queries,finishedQueries);
  assert.ok(last.candidates.every(c=>c.dataEvidence.history.length===1));
});

test("a missing review is retried without sampling or replaying completed first judgments",async()=>{
  let saved,queries=0,calls=0;
  const options={...input,config:{...input.config,maxResampleCandidates:100},connector:{query:async(...args)=>{queries++;return connector.query(...args);}},onCheckpoint:s=>{saved=s;},model:{judge:async candidates=>{calls++;return calls===2?{status:"failed",decisions:[],error:"临时故障"}:{status:"completed",decisions:candidates.map(c=>decision(c,calls>2?"relation":"uncertain"))};}}};
  const first=await analyzeRelationCandidates(options);assert.equal(first.modelResult.status,"partial");
  const before=queries;const resumed=await analyzeRelationCandidates({...options,checkpoint:saved});
  assert.equal(queries,before);assert.equal(calls,3);assert.equal(resumed.modelResult.status,"completed");
});

test("resume rejects changed source, schema, scope, model and stale checkpoints before querying",async()=>{
  let saved;const model={identity:{model:"model-a"},judge:async candidates=>({status:"completed",decisions:candidates.map(c=>decision(c))})};
  await analyzeRelationCandidates({...input,model,onCheckpoint:s=>{saved=s;}});
  assert.ok(saved);
  for(const changed of [{source:{...input.source,dbName:"other"}},{schema:{...schema,columns:schema.columns.slice(1)}},{eligibleTableNames:["orders"]},{model:{...model,identity:{model:"model-b"}}},{checkpoint:{...saved,createdAt:"2000-01-01T00:00:00Z"}}]){
    await assert.rejects(analyzeRelationCandidates({...input,model,checkpoint:saved,...changed,connector:{query:()=>assert.fail("stale input queried")}}),/检查点/);
  }
});

test("valid proposal overflow survives and a resume consumes it without another model call",async()=>{
  let saved,calls=0;
  const options={schema,maxCandidates:1,onCheckpoint:s=>{saved=s;}};
  const call=async()=>{calls++;return {proposals:["customer_id","billing_customer_id"].map(fromCol=>({fromTable:"orders",toTable:"customer",columnPairs:[{fromCol,toCol:"id"}],reason:"客户角色"}))};};
  const first=await proposeRelations(options,call);
  assert.equal(first.candidates.length,1);assert.equal(first.pendingCandidateCount,1);assert.equal(first.status,"partial");
  const next=await proposeRelations({...options,checkpoint:saved},call);
  assert.equal(calls,1);assert.equal(next.candidates.length,2);assert.equal(next.pendingCandidateCount,0);assert.equal(next.status,"completed");
});

test("completed proposal batches are skipped on resume, including after a failed batch",async()=>{
  const many={tables:Array.from({length:21},(_,i)=>({tableName:`t${i}`})),columns:[],foreignKeys:[]};
  many.columns=many.tables.map(t=>({...t,columnName:"id",dataType:"int"}));
  let saved,calls=0;const options={schema:many,maxBatches:1,onCheckpoint:s=>{saved=s;}};
  await proposeRelations(options,async()=>{calls++;return {proposals:[]};});
  const failed=await proposeRelations({...options,checkpoint:saved},async()=>{calls++;throw new Error("临时故障");});
  assert.equal(failed.completedBatches,1);
  const final=await proposeRelations({...options,checkpoint:saved,maxBatches:10},async()=>{calls++;return {proposals:[]};});
  assert.equal(calls,4);assert.equal(final.status,"completed");assert.equal(final.completedBatches,3);
});

test("judgment save failures propagate without retrying a model request",async()=>{
  let calls=0;const model=createRelationModelService({llm:{baseUrl:"http://model.test/v1",apiKey:"test",model:"test"},fetchImpl:async()=>{calls++;return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({decisions:[decision({id:"c"},"relation")]})}}]}));}});
  await assert.rejects(model.judge([{id:"c",from:{},to:{}}],{onBatch:()=>{throw new Error("checkpoint disk failure");}}),/checkpoint disk failure/);
  assert.equal(calls,1);
});

test("store persists checkpoints and public statistics expose only the summary",()=>{
  const store=createStore(":memory:");
  try{const state={version:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),candidates:[],decisions:{},reviewed:[],minConfidence:.55,secretSentinel:"private evidence",proposal:{status:"partial",plannedBatches:2,completedBatches:1}};
    store.saveRelationCheckpoint(1,state);assert.deepEqual(store.getRelationCheckpoint(1),state);
    const stats=store.relationStats(1);assert.equal(stats.checkpoint.pendingProposalBatches,1);assert.ok(!JSON.stringify(stats).includes("private evidence"));
  }finally{store.close();}
});

test("a restart after a saved model batch judges only the missing candidate IDs",async()=>{
  let saved;
  await assert.rejects(analyzeRelationCandidates({...input,onCheckpoint:s=>{saved=s;},model:{judge:async(candidates,{onBatch})=>{await onBatch({decisions:[decision(candidates[0],"relation")],usage:{calls:1}});throw new Error("process interrupted");}}}),/interrupted/);
  const done=Object.keys(saved.decisions);assert.equal(done.length,1);
  let retried;
  const result=await analyzeRelationCandidates({...input,checkpoint:saved,onCheckpoint:s=>{saved=s;},model:{judge:async candidates=>{retried=candidates.map(c=>c.id);return {status:"completed",decisions:candidates.map(c=>decision(c,"relation")),usage:{calls:1}};}}});
  assert.ok(retried.length);assert.ok(retried.every(id=>!done.includes(id)));assert.equal(result.diagnostics.usage.calls,2);assert.equal(result.diagnostics.thisRun.usage.calls,1);
});

test("proposal checkpoint write errors never cause extra model calls",async()=>{
  let calls=0,saves=0;
  await assert.rejects(proposeRelations({schema,onCheckpoint:()=>{if(++saves>1)throw new Error("disk failure");}},async()=>{calls++;return {proposals:[]};}),/disk failure/);
  assert.equal(calls,1);
});
