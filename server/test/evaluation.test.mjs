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

test("evaluation runner explicitly forwards the requested Agent mode",async()=>{
  const modes=[];const claudeModes=[];const ask=async({question,queryAgentMode,claudeQueryMode})=>{modes.push(queryAgentMode);claudeModes.push(claudeQueryMode);return {id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:100}],chart:null,evidence:{pages:[],rules:[],tables:["sales_summary"],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1,planningMode:"agent",planningAttempts:2}};};
  const {store,service,source}=await fixture(ask);service.create(source.id,{setName:"agent-run",question:"销售总额",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:false});const result=await service.run({task:{id:"agent-run-1"},source,payload:{setName:"agent-run",queryAgentMode:"required",tolerance:1e-6},onProgress:()=>{}});
  assert.equal(result.queryAgentMode,"required");assert.deepEqual(modes,["required"]);assert.deepEqual(claudeModes,["off"]);assert.equal(store.listEvalRuns(source.id)[0].requestedMode,"agent_required");store.close();
});

test("semantic repair hints locate object properties and links without exposing physical mappings",()=>{
  const schema={objectTypes:[{apiName:"customer",displayName:"客户",primaryKey:"id",properties:[{apiName:"segment",displayName:"客户分层"}]},{apiName:"order",displayName:"订单",primaryKey:"id",properties:[{apiName:"amount",displayName:"订单金额"}]}],linkTypes:[{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many"}]};
  const hints=buildSemanticRepairHints({schema,question:"按客户分层统计订单金额",failureClass:"result_mismatch",queryPlan:{rootObject:"customer",dimensions:[{property:"customer.segment"}],metrics:[{property:"order.amount",aggregation:"sum"}],filters:[]},semanticPath:{objects:["customer","order"],links:["customer_orders"]}});
  assert.ok(hints.some((item)=>item.targetType==="object"&&item.target==="customer"));
  assert.ok(hints.some((item)=>item.targetType==="property"&&item.target==="order.amount"));
  assert.ok(hints.some((item)=>item.targetType==="link"&&item.target==="customer_orders"));
  assert.doesNotMatch(JSON.stringify(hints),/mapping|warehouse|fact_/i);
});

test("semantic evaluation gate compares off and prefer and persists rollout evidence",async()=>{
  const candidateVersions=[];const claudeModes=[];const ask=async({question,semanticQueryPlanMode,ontologySchemaVersionId,claudeQueryMode})=>{claudeModes.push(claudeQueryMode);
    if(semanticQueryPlanMode==="prefer")candidateVersions.push(ontologySchemaVersionId);
    if(semanticQueryPlanMode==="off"&&question==="关联问题")return {refused:true,reason:"系统没有执行不可靠 SQL：JOIN 路径失败",planningMode:"legacy",planningAttempts:2};
    return {id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:100}],chart:null,evidence:{pages:[],rules:[],tables:["sales_summary"],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1,planningMode:semanticQueryPlanMode==="prefer"?"semantic":"legacy",ontologySchemaVersion:1,semanticPath:semanticQueryPlanMode==="prefer"?{rootObject:"summary",objects:["summary"],links:[],relations:[]}:undefined,planningAttempts:1}};
  };
  const {store,service,source}=await fixture(ask);
  const semantic=createSemanticSchemaService({store});
  const draft=semantic.saveDraft(source.id,{name:"sales",displayName:"销售模型",objectTypes:[{apiName:"summary",displayName:"汇总",primaryKey:"id",properties:[{apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"sales_summary",column:"id"}}]}],linkTypes:[]},"tester");
  assert.equal(semantic.publish(draft.id,"tester").ok,true);
  service.create(source.id,{setName:"gate",question:"普通问题",goldSql:"SELECT label, total FROM sales_summary",category:"单表",heldOut:false});
  service.create(source.id,{setName:"gate",question:"关联问题",goldSql:"SELECT label, total FROM sales_summary",category:"关联",heldOut:false});
  const result=await service.runGate({task:{id:"gate-1"},source,payload:{setName:"gate",tolerance:1e-6},onProgress:()=>{}});
  assert.equal(result.passed,true,result.reason);
  assert.equal(result.baseline.passRate,.5);
  assert.equal(result.baseline.joinFailures,1);
  assert.equal(result.candidate.passRate,1);
  assert.equal(result.candidate.joinFailures,0);
  assert.equal(result.candidate.semanticExecutionRate,1);
  const runs=store.listEvalRuns(source.id);assert.equal(runs.length,4);assert.equal(runs.filter((item)=>item.comparisonRole==="candidate").length,2);
  const gate=store.listEvalGates(source.id)[0];assert.equal(gate.decision,"enable_prefer");assert.equal(gate.candidate.semanticExecutions,2);
  assert.equal(gate.ontologySchemaVersion,1);assert.equal(gate.ontologySchemaPublishedAt,store.getOntologySchemaVersion(draft.id).publishedAt);assert.equal(result.ontologySchemaPublishedAt,gate.ontologySchemaPublishedAt);assert.ok(gate.evaluationChecksum);assert.deepEqual(candidateVersions,[draft.id,draft.id]);assert.deepEqual(claudeModes,["off","off","off","off"]);
  store.close();
});

test("semantic evaluation gate records subtype rootObject coverage",async()=>{
  const ask=async({question,semanticQueryPlanMode})=>({id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:100}],chart:null,evidence:{pages:[],rules:[],tables:["sales_summary"],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1,planningMode:semanticQueryPlanMode==="prefer"?"semantic":"legacy",ontologySchemaVersion:1,semanticPath:semanticQueryPlanMode==="prefer"?{rootObject:"priority_summary",objects:["priority_summary"],links:[],relations:[]}:undefined,planningAttempts:1}});
  const {store,service,source}=await fixture(ask);
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"summary_type",dataType:"varchar",nullable:0});
  const semantic=createSemanticSchemaService({store});
  const schema={name:"sales",displayName:"销售模型",objectTypes:[
    {apiName:"summary",displayName:"汇总",primaryKey:"id",properties:[{apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"sales_summary",column:"id"}},{apiName:"summary_type",displayName:"汇总类型",type:"enum",required:true,constraints:{enumValues:["priority","normal"]},mapping:{table:"sales_summary",column:"summary_type"}}]},
    {apiName:"priority_summary",displayName:"重点汇总",parent:"summary",discriminator:{property:"summary_type",values:["priority"]},properties:[]},
  ],linkTypes:[]};
  const draft=semantic.saveDraft(source.id,schema,"tester");assert.equal(semantic.publish(draft.id,"tester").ok,true);
  service.create(source.id,{setName:"subtype-gate",question:"重点汇总",goldSql:"SELECT label, total FROM sales_summary",category:"层级",heldOut:false});
  const result=await service.runGate({task:{id:"subtype-gate-1"},source,payload:{setName:"subtype-gate",tolerance:1e-6},onProgress:()=>{}});
  assert.deepEqual(result.candidate.subtypeRootObjects,["priority_summary"]);
  assert.equal(result.candidate.subtypeRootCoverage,1);
  assert.deepEqual(store.getEvalGate("subtype-gate-1").candidate.subtypeRootObjects,["priority_summary"]);
  store.close();
});

test("agent evaluation gate compares required loop with the single-shot baseline and records cost controls",async()=>{
  const ask=async({question,queryAgentMode})=>{
    const agent=queryAgentMode==="required";return {id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:100}],chart:null,evidence:{pages:[],rules:[],tables:["sales_summary"],joins:[],sql:"SELECT label, total FROM sales_summary",durationMs:agent?120:40,scannedRows:1,planningMode:agent?"agent":"legacy",planningAttempts:agent?2:1,iterations:agent?2:undefined,toolTrace:agent?[{tool:"run_sql",thought:"执行",argsHash:"a",durationMs:10,ok:true,summary:"成功"},{tool:"submit_answer",thought:"提交",argsHash:"b",durationMs:1,ok:true,summary:"成功"}]:undefined,tokenUsage:{promptTokens:agent?160:60,completionTokens:agent?40:20,totalTokens:agent?200:80,available:true}}};
  };
  const {store,service,source}=await fixture(ask);service.create(source.id,{setName:"agent-gate",question:"销售总额",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:false});
  const result=await service.runAgentGate({task:{id:"agent-gate-1"},source,payload:{setName:"agent-gate",tolerance:1e-6},onProgress:()=>{}});
  assert.equal(result.passed,true,result.reason);assert.equal(result.decision,"enable_agent_prefer");assert.equal(result.candidate.passRate,1);assert.equal(result.candidate.agentExecutionRate,1);assert.equal(result.candidate.averageIterations,2);assert.equal(result.candidate.toolSuccessRate,1);assert.equal(result.candidate.clarificationRate,0);assert.equal(result.candidate.budgetFallbackRate,0);assert.equal(result.candidate.averageTokens,200);assert.equal(result.baseline.averageTokens,80);
  const gate=store.listEvalGates(source.id)[0];assert.equal(gate.candidate.gateKind,"agent");assert.equal(gate.ontologySchemaVersion,null);assert.equal(gate.decision,"enable_agent_prefer");
  const runs=store.listEvalRuns(source.id);assert.deepEqual(new Set(runs.map((item)=>item.requestedMode)),new Set(["single","agent_required"]));const candidateRun=runs.find((item)=>item.requestedMode==="agent_required");assert.deepEqual(candidateRun.agentMetrics,{agentExecution:1,iterations:2,toolCalls:2,toolSuccesses:2,clarificationCount:0,budgetFallback:0,repeatedActions:0,intentFailures:0,incompleteFailures:0,totalTokens:200});store.close();
});

test("agent gate keeps off when token evidence is missing even if result accuracy matches",async()=>{
  const ask=async({question,queryAgentMode})=>{const agent=queryAgentMode==="required";return {id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:100}],chart:null,evidence:{pages:[],rules:[],tables:["sales_summary"],joins:[],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1,planningMode:agent?"agent":"legacy",planningAttempts:agent?2:1,iterations:agent?2:undefined,toolTrace:agent?[{tool:"run_sql",thought:"执行",argsHash:"a",durationMs:1,ok:true,summary:"成功"},{tool:"submit_answer",thought:"提交",argsHash:"b",durationMs:1,ok:true,summary:"成功"}]:undefined}};};
  const {store,service,source}=await fixture(ask);service.create(source.id,{setName:"agent-gate-no-usage",question:"销售总额",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:false});
  const result=await service.runAgentGate({task:{id:"agent-gate-no-usage-1"},source,payload:{setName:"agent-gate-no-usage",tolerance:1e-6},onProgress:()=>{}});
  assert.equal(result.passed,false);assert.equal(result.decision,"keep_off");assert.match(result.reason,/token usage 覆盖不完整/);assert.equal(result.baseline.passRate,1);assert.equal(result.candidate.passRate,1);store.close();
});

async function fixture(customAsk){
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-eval-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"test",kind:"mysql",host:"localhost",port:3306,dbName:"db",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"sales_summary",grade:"A",active:1});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"label",dataType:"varchar"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"total",dataType:"decimal"});
  const connector={query:async()=>[[{label:"全部",total:100}],[]]};
  const queries={ask:customAsk||(async({question})=>({id:"q",question,conclusion:"完成",columns:[],rows:[{label:"全部",total:question==="正确问题"?100:99}],chart:{type:"bar",xKey:"label",yKey:"total"},evidence:{pages:[],rules:[],tables:["sales_summary"],sql:"SELECT label, total FROM sales_summary",durationMs:1,scannedRows:1}}))};
  const service=createEvaluationService({store,connector,queries,config:{queryMaxRows:500}});return {store,service,source};
}
