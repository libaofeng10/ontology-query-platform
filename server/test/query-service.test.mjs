import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { createQueryService } from "../src/query-service.mjs";
import { createClaudeQueryMcpSession } from "../src/claude-query-mcp.mjs";
import { createCommerceCatalog } from "./fixtures/commerce-catalog.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";

function fixture(t,run) {
  const store=createStore(":memory:");t.after(()=>store.close());
  const source=createCommerceCatalog(store);
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:7}],[{name:"customer_id"}]]};
  const service=createQueryService({store,connector,config:{claudeQuery:{model:"test-model",maxBudgetUsd:1},queryMaxRows:100},claudeBridge:run?{run}:null,claudeMcpFactory:options=>createClaudeQueryMcpSession({...options,listen:false})});
  return {store,source,service};
}

async function answered({mcpSession}) {
  const receipt=await mcpSession.callTool("db_query",{sql:"SELECT customer_id FROM crm_customer"});
  assert.equal(receipt.ok,true,receipt.error);
  return {status:"answered",executionIds:[receipt.executionId],conclusion:"客户编号 7",toolTrace:mcpSession.trace};
}

test("missing Claude bridge refuses and records failure without another planner",async t=>{
  const {store,source,service}=fixture(t);
  const result=await service.ask({sourceId:source.id,question:"查询客户"});
  assert.equal(result.refused,true);assert.equal(result.failureClass,"claude_unavailable");
  assert.equal(store.listAudits(source.id,1)[0].verdict,"refused");
});

test("query sessions reject other users and sources",async t=>{
  const {store,source,service}=fixture(t,answered);
  const session=store.createSession({id:"session",sourceId:source.id,userName:"alice"});
  await assert.rejects(service.ask({sourceId:source.id,sessionId:session.id,userName:"bob",question:"查询客户"}),{status:403});
  await assert.rejects(service.ask({sourceId:999,question:"查询客户"}),{status:404});
});

test("Claude clarification resumes once, records both audit outcomes and retains business answer",async t=>{
  let calls=0;
  const {store,source,service}=fixture(t,async options=>{
    if(calls++===0)return {status:"clarification",clarification:{question:"哪类客户？",options:["自然人","企业"],allowFreeText:false}};
    assert.equal(options.context.clarifications[0].answer,"企业");
    return answered(options);
  });
  const first=await service.ask({sourceId:source.id,question:"查询客户",userName:"alice"});
  const request={sourceId:source.id,sessionId:first.sessionId,pendingId:first.clarification.pendingId,userName:"alice",question:"企业"};
  await assert.rejects(service.ask({...request,userName:"bob"}),{status:403});
  const result=await service.ask(request);assert.equal(result.rows[0].customer_id,7);
  assert.deepEqual(result.evidence.clarifications.map(item=>item.answer),["企业"]);
  await assert.rejects(service.ask(request),{status:404});
  assert.ok(store.listAudits(source.id,10).some(item=>item.verdict==="clarified"));
  assert.ok(store.listAudits(source.id,10).some(item=>item.verdict==="passed"));
});

test("evaluation uses the explicitly selected draft snapshot rather than the published version",async t=>{
  let seen;
  const {store,source,service}=fixture(t,async options=>{seen=options.snapshot.schemaVersion;return answered(options);});
  const published=store.getPublishedOntologySchema(source.id);
  const schema=createSemanticSchemaService({store});
  const draft=schema.saveDraft(source.id,{...published.schema,displayName:"候选模型"},"owner");
  const result=await service.ask({sourceId:source.id,question:"查询客户",ontologySchemaVersionId:draft.id});
  assert.equal(result.refused,undefined,result.reason);assert.equal(seen,draft.version);
  assert.equal(store.getPublishedOntologySchema(source.id).id,published.id);
});

test("request registry rejects fabricated executions and keeps distinct result sets",async t=>{
  const {source,service}=fixture(t,async()=>({status:"answered",executionIds:["fabricated"],conclusion:"伪造结果"}));
  const result=await service.ask({sourceId:source.id,question:"查询客户"});
  assert.equal(result.refused,true);assert.equal(result.errorCode,"UNKNOWN_EXECUTION_ID");
});
