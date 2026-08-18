import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";

async function fixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sse-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:1}],query:async()=>[[{customer_id:7}],[{name:"customer_id"}]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"query-sse-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-sse-test",model:"sse-test"},queryAgentMode:"required",queryAgentMaxIterations:5,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,
  });
  const source=app.store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  app.store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  app.store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"客户编号"});
  app.store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"有效客户",title:"有效客户",aliases:"[]",tablesJson:'["crm_customer"]',content:"已实名客户",sqlContent:"按客户编号查询",antiExamples:"",verified:1,owner:"owner"});
  return {app,source,connector};
}

function llmResponse(content) { return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200}); }

test("SSE query streams whitelisted progress, persists the final turn and replays trace from audit",async()=>{
  const {app,source}=await fixture();
  const actions=[
    {thought:"准备查询。 api_key=should-not-leak",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"结果已经验证，可以提交。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 7。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"});
    assert.equal(response.status,200);assert.match(response.headers["content-type"],/text\/event-stream/);
    const events=parseEvents(response.raw);
    assert.ok(events.some((item)=>item.event==="step"&&item.data.status==="started"));
    assert.ok(events.some((item)=>item.event==="thought"&&item.data.text==="准备查询。"));
    assert.ok(events.some((item)=>item.event==="tool_call"&&item.data.tool==="run_sql"&&/SELECT customer_id/.test(item.data.sql)));
    const sqlResult=events.find((item)=>item.event==="tool_result"&&item.data.tool==="run_sql");
    assert.equal(sqlResult.data.ok,true);assert.doesNotMatch(JSON.stringify(sqlResult.data),/"customer_id":7/);
    const final=events.find((item)=>item.event==="final").data.result;
    assert.equal(final.conclusion,"查询到客户编号 7。");assert.equal(final.rows[0].customer_id,7);assert.equal("_auditId" in final,false);
    const assistantRow=app.store.db.prepare("SELECT content_json AS contentJson,audit_id AS auditId FROM ds_query_message WHERE role='assistant' ORDER BY id DESC LIMIT 1").get();
    assert.ok(assistantRow.auditId);assert.doesNotMatch(assistantRow.contentJson,/toolTrace/);
    const detail=app.store.getSessionDetail(final.sessionId);const assistant=detail.messages.find((item)=>item.role==="assistant");
    assert.equal(assistant.auditId,assistantRow.auditId);assert.deepEqual(assistant.content.evidence.toolTrace.map((item)=>item.tool),["run_sql","submit_answer"]);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("closing an SSE response aborts the in-flight LLM call and does not persist a session turn",async()=>{
  const {app,source,connector}=await fixture();
  let observedSignal=null;let connectorQueries=0;app.store.db.prepare("DELETE FROM ds_audit WHERE source_id=?").run(source.id);
  connector.query=async()=>{connectorQueries++;return [[],[]];};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{observedSignal=init.signal;if(init.signal.aborted)throw abortError();await new Promise((_,reject)=>init.signal.addEventListener("abort",()=>reject(abortError()),{once:true}));};
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"},{disconnectOnFirstStep:true});
    assert.equal(response.disconnected,true);assert.equal(observedSignal.aborted,true);assert.equal(connectorQueries,0);
    const sessions=app.store.listSessions(source.id,"analyst");assert.equal(sessions.length,1);assert.equal(sessions[0].messageCount,0);
    assert.equal(app.store.listAudits(source.id,10).length,0);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("SSE emits a clarification terminal event without persisting an intermediate session turn",async()=>{
  const {app,source}=await fixture();
  const actions=[
    {thought:"先检索业务口径。",tool:"search_context",args:{query:"有效客户口径"}},
    {thought:"两种业务口径会改变结果。",tool:"ask_user",args:{question:"有效客户按自然人还是企业口径？",options:["自然人","企业"],allowFreeText:false}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"});const events=parseEvents(response.raw);
    const clarification=events.find((item)=>item.event==="clarification");assert.ok(clarification);
    assert.equal(clarification.data.type,"clarification");assert.deepEqual(clarification.data.result.clarification.options,["自然人","企业"]);
    assert.equal(events.some((item)=>item.event==="final"||item.event==="refused"),false);
    assert.equal(app.store.listSessions(source.id,"analyst")[0].messageCount,0);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

async function sseApi(app,body,{disconnectOnFirstStep=false}={}) {
  const payload=JSON.stringify(body);const request=Readable.from([payload]);request.method="POST";request.url="/api/query";request.headers={authorization:"Bearer token-analyst","content-type":"application/json",accept:"text/event-stream","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  const response=new MockResponse(disconnectOnFirstStep);await app.handler(request,response);return {status:response.statusCode,headers:response.headers,raw:response.raw,disconnected:response.disconnected};
}

class MockResponse extends EventEmitter {
  constructor(disconnectOnFirstStep){super();this.disconnectOnFirstStep=disconnectOnFirstStep;this.statusCode=200;this.headers={};this.raw="";this.writableEnded=false;this.destroyed=false;this.disconnected=false;}
  setHeader(name,value){this.headers[String(name).toLowerCase()]=value;}
  flushHeaders(){}
  write(value){const chunk=String(value);this.raw+=chunk;if(this.disconnectOnFirstStep&&!this.disconnected&&chunk.startsWith("event: step")){this.disconnected=true;this.destroyed=true;this.emit("close");return false;}return true;}
  end(value){if(value)this.raw+=String(value);this.writableEnded=true;this.emit("close");}
}

function parseEvents(raw){return raw.trim().split("\n\n").filter(Boolean).map((block)=>{const lines=block.split("\n");return {event:lines.find((line)=>line.startsWith("event:"))?.slice(6).trim(),data:JSON.parse(lines.find((line)=>line.startsWith("data:"))?.slice(5).trim()||"{}")};});}
function abortError(){const error=new Error("aborted");error.name="AbortError";return error;}
