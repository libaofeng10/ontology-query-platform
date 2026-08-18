import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { createQueryService } from "../src/query-service.mjs";
import { _internal as agentInternal } from "../src/query-agent-loop.mjs";
import { createStore } from "../src/store.mjs";

async function appFixture(overrides={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-clarification-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:2}],query:async()=>[[{revenue:88}],[{name:"revenue",type:"number"}]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"clarification-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-clarification",model:"clarification-test"},queryAgentMode:"required",queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,
    ...overrides,
  });
  const source=seed(app.store);return {app,source,connector};
}

function seed(store) {
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"sales_order",rowEstimate:10,grade:"A",active:1,comment:"销售订单"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"revenue",dataType:"decimal",isPrimary:0,isSensitive:0,comment:"收入"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"mobile",dataType:"varchar",isPrimary:0,isSensitive:1,comment:"手机号"});
  store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"收入",title:"收入",aliases:"[]",tablesJson:'["sales_order"]',content:"订单收入，可按含税或不含税口径分析",sqlContent:"汇总收入字段",antiExamples:"不得查询手机号",verified:1,owner:"owner"});
  return source;
}

function llmResponse(content) { return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200}); }

test("clarification pauses without persisting a turn, resumes once and reuses the confirmed business scope",async()=>{
  const {app,source}=await appFixture();
  const actions=[
    {thought:"先检索收入口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"两种口径都会实质改变结果，需要确认。",tool:"ask_user",args:{question:"收入应按含税还是不含税口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"用户已确认不含税，执行汇总。",tool:"run_sql",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order"}},
    {thought:"提交已经验证的结果。",tool:"submit_answer",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order",conclusion:"不含税收入为 88 元。"}},
    {thought:"沿用当前会话已确认口径执行追问。",tool:"run_sql",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order"}},
    {thought:"提交追问结果。",tool:"submit_answer",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order",conclusion:"沿用不含税口径，收入为 88 元。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.equal(first.status,200);assert.equal(first.body.clarification.question,"收入应按含税还是不含税口径？");
    assert.deepEqual(first.body.clarification.options,["含税","不含税"]);assert.equal(first.body.toolTrace.at(-1).tool,"ask_user");
    assert.equal(app.store.listSessions(source.id,"analyst")[0].messageCount,0);
    assert.equal(app.store.listAudits(source.id,1)[0].verdict,"clarified");

    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"不含税"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.conclusion,"不含税收入为 88 元。");
    assert.deepEqual(resumed.body.evidence.clarifications,[{question:"收入应按含税还是不含税口径？",answer:"不含税"}]);
    assert.deepEqual(resumed.body.evidence.toolTrace.map((item)=>item.tool),["search_context","ask_user","run_sql","submit_answer"]);
    const messages=app.store.getSessionDetail(first.body.sessionId).messages;assert.equal(messages.length,2);
    assert.equal(messages[0].content.text,"查询收入");assert.equal(messages[1].content.question,"查询收入");
    assert.deepEqual(messages[1].content.evidence.toolTrace.map((item)=>item.tool),["search_context","ask_user","run_sql","submit_answer"]);
    assert.match(app.store.getSessionPlanningHistory(first.body.sessionId)[1].content,/澄清口径：收入应按含税还是不含税口径？ = 不含税/);

    const reused=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,question:"那现在是多少？"});
    assert.equal(reused.body.conclusion,"沿用不含税口径，收入为 88 元。");
    assert.match(requests[4].messages.map((item)=>item.content).join("\n"),/澄清口径.*不含税/);

    const secondResume=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"含税"});
    assert.equal(secondResume.status,404);assert.match(secondResume.body.error,/不存在或已失效/);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("clarification pending expires by TTL and is invalidated by a new question in the same session",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:15});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"新问题无需继续。",tool:"refuse",args:{reason:"当前问题不在已确认范围内。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const expiredPending=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    await new Promise((resolve)=>setTimeout(resolve,25));
    const expired=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,pendingId:expiredPending.body.clarification.pendingId,question:"不含税"});
    assert.equal(expired.status,410);assert.match(expired.body.error,/已过期/);

    const invalidatedPending=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,question:"再次查询收入"});
    const replacement=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,question:"换一个新问题"});
    assert.equal(replacement.body.refused,true);
    const invalidated=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,pendingId:invalidatedPending.body.clarification.pendingId,question:"含税"});
    assert.equal(invalidated.status,404);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("ask_user rejects SQL and table identifiers but field sensitivity does not limit business questions",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-clarification-guard-"));const store=createStore(join(root,"store.sqlite"));const source=seed(store);
  const connector={explain:async()=>[{rows:1}],query:async()=>[[],[]]};
  const catalog=agentInternal.buildCatalog(store,source.id,100);
  assert.match(agentInternal.clarificationContentError("是否从 sales_order 查询收入？",catalog),/物理表名/);
  assert.equal(agentInternal.clarificationContentError("是否按手机号区分口径？",catalog),null);
  assert.equal(agentInternal.clarificationContentError("是否按 mobile 字段区分口径？",catalog),null);
  assert.equal(agentInternal.clarificationContentError("收入应按含税还是不含税口径？",catalog),null);
  const actions=[
    {thought:"先自行探索。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"尝试询问技术细节。",tool:"ask_user",args:{question:"是否从 sales_order SELECT revenue？",options:["是","否"],allowFreeText:false}},
    {thought:"尝试询问敏感字段。",tool:"ask_user",args:{question:"是否按手机号区分口径？",options:[],allowFreeText:true}},
    {thought:"无法安全澄清。",tool:"refuse",args:{reason:"现有业务信息不足以可靠回答。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"sk",model:"test"},queryAgentMode:"required",queryAgentMaxIterations:4,queryAgentMaxSqlCalls:2,queryAgentMaxScannedRows:10,queryMaxRows:100,explainMaxRows:10,queryLlmTimeoutMs:5_000,semanticQueryPlanMode:"off"}});
    const result=await service.ask({sourceId:source.id,question:"查询收入",userName:"tester"});
    assert.equal(result.refused,true);assert.equal("clarification" in result,false);
    assert.deepEqual(result.toolTrace.map((item)=>[item.tool,item.ok]),[["search_context",true],["ask_user",false],["ask_user",false],["refuse",true]]);
    assert.match(result.toolTrace[1].summary,/SQL|物理表名/);assert.match(result.toolTrace[2].summary,/最多只能调用一次/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("session detail exposes a live pending clarification for page-refresh recovery",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:60_000});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.equal(first.status,200);assert.ok(first.body.clarification);

    const detail=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.equal(detail.status,200);
    assert.equal(detail.body.pendingClarification.question,"查询收入");
    assert.equal(detail.body.pendingClarification.response.clarification.pendingId,first.body.clarification.pendingId);
    assert.deepEqual(detail.body.pendingClarification.response.toolTrace.map((item)=>item.tool),["search_context","ask_user"]);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("expired pending is removed by lazy sweep and disappears from session detail",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:15});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.ok(first.body.clarification);
    const live=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.ok(live.body.pendingClarification);
    await new Promise((resolve)=>setTimeout(resolve,25));
    const after=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.equal(after.status,200);assert.equal(after.body.pendingClarification,undefined);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
