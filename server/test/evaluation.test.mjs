import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildSemanticRepairHints } from "../src/evaluation-repair.mjs";
import { createEvaluationService, equivalentResults } from "../src/evaluation-service.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { createStore } from "../src/store.mjs";

test("result equivalence ignores row order and accepts configured numeric tolerance",()=>{
  const expected=[{month:"2026-01",amount:10.0000001},{month:"2026-02",amount:20}];
  const actual=[{amount:20,month:"2026-02"},{amount:10.0000002,month:"2026-01"}];
  assert.equal(equivalentResults(expected,actual,{tolerance:1e-6}).equal,true);
  assert.equal(equivalentResults(expected,[{amount:21,month:"2026-02"},{amount:10,month:"2026-01"}]).equal,false);
});

test("held-out cases never expose Gold SQL through list or mutation responses",async()=>{
  const {store,service,source}=await fixture();
  const created=service.create(source.id,{setName:"hidden",question:"总额？",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:true});
  assert.equal(created.goldSql,null);assert.equal(created.hasGoldSql,true);
  assert.equal(store.listEvalCases(source.id)[0].goldSql,null);
  assert.match(store.getEvalCase(created.id).goldSql,/SELECT label/);
  store.close();
});

test("manifest import requires approval and is idempotent",async()=>{
  const {store,service,source}=await fixture();const item={setName:"approved-gold",question:"销售总额？",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:true};
  assert.throws(()=>service.importCases(source.id,[item],{manifestStatus:"candidate",minimumCases:1}),/approved/);
  assert.throws(()=>service.importCases(source.id,[item],{manifestStatus:"approved",minimumCases:2}),/至少需要 2 条/);
  const first=service.importCases(source.id,[item],{manifestStatus:"approved",minimumCases:1});const second=service.importCases(source.id,[item],{manifestStatus:"approved",minimumCases:1});
  assert.equal(first[0].id,second[0].id);assert.equal(first[0].goldSql,null);assert.equal(store.listEvalCasesForRun(source.id,"approved-gold").length,1);
  assert.throws(()=>service.importCases(source.id,[{...item,goldSql:"SELECT total FROM sales_summary"}],{manifestStatus:"approved",minimumCases:1}),/定义不同/);store.close();
});

test("evaluation runner records equivalent results and classifies mismatches",async()=>{
  const {store,service,source}=await fixture();
  const semantic=createSemanticSchemaService({store});
  const draft=semantic.saveDraft(source.id,{name:"sales",displayName:"销售模型",objectTypes:[{apiName:"summary",displayName:"销售汇总",primaryKey:"id",properties:[{apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"sales_summary",column:"id"}},{apiName:"label",displayName:"分类",type:"string",required:false,mapping:{table:"sales_summary",column:"label"}},{apiName:"total",displayName:"销售总额",type:"number",required:false,mapping:{table:"sales_summary",column:"total"}}]}],linkTypes:[]},"tester");
  assert.equal(semantic.publish(draft.id,"tester").ok,true);
  service.create(source.id,{setName:"regression",question:"正确问题",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:false});
  service.create(source.id,{setName:"regression",question:"错误问题：销售总额",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:false});
  const progress=[];const result=await service.run({task:{id:"batch-1"},source,payload:{setName:"regression",tolerance:1e-6},onProgress:(item)=>progress.push(item)});
  assert.equal(result.passed,1);assert.equal(result.failed,1);assert.equal(result.failures[0].failureClass,"result_mismatch");
  const runs=store.listEvalRuns(source.id);assert.equal(runs.length,2);const failed=runs.find((item)=>!item.passed);assert.ok(failed.suggestion.includes("反例"));assert.ok(failed.repairHints.some((item)=>item.target==="summary.total"&&item.targetType==="property"));assert.equal(progress.at(-1).progress,100);
  store.close();
});

test("semantic repair hints locate object properties and links without exposing physical mappings",()=>{
  const schema={objectTypes:[{apiName:"customer",displayName:"客户",primaryKey:"id",properties:[{apiName:"segment",displayName:"客户分层"}]},{apiName:"order",displayName:"订单",primaryKey:"id",properties:[{apiName:"amount",displayName:"订单金额"}]}],linkTypes:[{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many"}]};
  const hints=buildSemanticRepairHints({schema,question:"按客户分层统计订单金额",failureClass:"result_mismatch",queryPlan:{rootObject:"customer",dimensions:[{property:"customer.segment"}],metrics:[{property:"order.amount",aggregation:"sum"}],filters:[]},semanticPath:{objects:["customer","order"],links:["customer_orders"]}});
  assert.ok(hints.some((item)=>item.targetType==="object"&&item.target==="customer"));
  assert.ok(hints.some((item)=>item.targetType==="property"&&item.target==="order.amount"));
  assert.ok(hints.some((item)=>item.targetType==="link"&&item.target==="customer_orders"));
  assert.doesNotMatch(JSON.stringify(hints),/mapping|warehouse|fact_/i);
});

test("Claude gate executes each question once against Gold and preserves candidate version",async()=>{
  const requests=[];
  const {store,service,source}=await fixture(async input=>{requests.push(input);return {rows:[{label:"全部",total:100}],evidence:{sql:"SELECT label, total FROM sales_summary",planningMode:"claude",tables:["sales_summary"]}};});
  try {
    const semantic=createSemanticSchemaService({store});
    const draft=semantic.saveDraft(source.id,{name:"sales",displayName:"销售",objectTypes:[{apiName:"summary",displayName:"汇总",primaryKey:"id",properties:[{apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"sales_summary",column:"id"}}]}],linkTypes:[]},"tester");
    service.create(source.id,{setName:"gate",question:"汇总",goldSql:"SELECT label, total FROM sales_summary",category:"金额"});
    const result=await service.runGate({task:{id:"claude-gate"},source,payload:{setName:"gate",ontologySchemaVersionId:draft.id},onProgress:()=>{}});
    assert.equal(result.passed,true,result.reason);assert.equal(result.baseline.requestedMode,"gold");assert.equal(result.candidate.claudeExecutionRate,1);
    assert.equal(requests.length,1);assert.equal(requests[0].ontologySchemaVersionId,draft.id);assert.equal("semanticQueryPlanMode" in requests[0],false);
    const gate=store.getEvalGate("claude-gate");assert.equal(gate.decision,"enable_claude");assert.equal(gate.ontologySchemaPublishedAt,null);assert.equal(store.listEvalRuns(source.id).length,1);
  } finally {store.close();}
});

for(const [label,answer,failureClass] of [
  ["clarification",{sessionId:"session",clarification:{pendingId:"pending"}},"clarification"],
  ["truncation",{rows:[{label:"全部",total:100}],evidence:{sql:"SELECT label, total FROM sales_summary",resultCompleteness:{complete:false}}},"result_incomplete"],
]) test(`evaluation does not count ${label} as equivalent`,async()=>{
  const {store,service,source}=await fixture(async()=>answer);
  try {
    service.create(source.id,{setName:"gate",question:"汇总",goldSql:"SELECT label, total FROM sales_summary",category:"金额"});
    const result=await service.run({task:{id:label},source,payload:{setName:"gate"},onProgress:()=>{}});
    assert.equal(result.passed,0);assert.equal(result.failures[0].failureClass,failureClass);
  } finally {store.close();}
});

async function fixture(customAsk){
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-eval-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"test",kind:"mysql",host:"localhost",port:3306,dbName:"db",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"sales_summary",grade:"A",active:1});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"label",dataType:"varchar"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"total",dataType:"decimal"});
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{label:"全部",total:100}],[]]};
  const queries={ask:customAsk||(async({question})=>({id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:question==="正确问题"?100:99}],chart:{type:"bar",xKey:"label",yKey:"total"},evidence:{pages:[],rules:[],tables:["sales_summary"],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1}}))};
  const service=createEvaluationService({store,connector,queries,config:{queryMaxRows:500}});return {store,service,source};
}
