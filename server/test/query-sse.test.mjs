import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { createCommerceCatalog } from "./fixtures/commerce-catalog.mjs";
import { createClaudeQueryMcpSession } from "../src/claude-query-mcp.mjs";

async function fixture(run) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-sse-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:1}],query:async()=>[[{customer_id:7}],[{name:"customer_id"}]]};
  const app=createApp({
    claudeBridge:{run},claudeMcpFactory:options=>createClaudeQueryMcpSession({...options,listen:false}),claudeQuery:{model:"test-model",maxBudgetUsd:1},
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"query-sse-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-sse-test",model:"sse-test"},queryAgentMode:"required",queryAgentMaxIterations:5,queryMaxSqlCalls:3,queryMaxScannedRows:100,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,
  });
  const source=createCommerceCatalog(app.store);
  return {app,source,connector};
}

test("SSE streams Claude tool progress and persists final results with audit trace",async()=>{
  const {app,source}=await fixture(async({mcpSession,onEvent})=>{
    onEvent?.({type:"step",status:"started",text:"开始查询"});
    const receipt=await mcpSession.callTool("db_query",{sql:"SELECT customer_id FROM crm_customer"});
    assert.equal(receipt.ok,true,JSON.stringify(receipt));
    return {status:"answered",executionIds:[receipt.executionId],conclusion:"查询到客户编号 7。",toolTrace:mcpSession.trace};
  });
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"});
    assert.equal(response.status,200);assert.match(response.headers["content-type"],/text\/event-stream/);
    const events=parseEvents(response.raw);
    assert.ok(events.some(item=>item.event==="step"&&item.data.status==="started"));
    assert.ok(events.some(item=>item.event==="tool_call"&&item.data.tool==="db_query"));
    const sqlResult=events.find(item=>item.event==="tool_result"&&item.data.tool==="db_query");
    assert.equal(sqlResult.data.ok,true);assert.doesNotMatch(JSON.stringify(sqlResult.data),/"customer_id":7/);
    const final=events.find(item=>item.event==="final").data.result;
    assert.equal(final.conclusion,"查询到客户编号 7。");assert.equal(final.rows[0].customer_id,7);assert.equal("_auditId" in final,false);
    const assistantRow=app.store.db.prepare("SELECT content_json AS contentJson,audit_id AS auditId FROM ds_query_message WHERE role='assistant' ORDER BY id DESC LIMIT 1").get();
    assert.ok(assistantRow.auditId);assert.doesNotMatch(assistantRow.contentJson,/toolTrace/);
    const assistant=app.store.getSessionDetail(final.sessionId).messages.find(item=>item.role==="assistant");
    assert.equal(assistant.auditId,assistantRow.auditId);assert.deepEqual(assistant.content.evidence.toolTrace.map(item=>item.tool),["db_query"]);
  } finally { await app.close(); }
});

test("closing SSE aborts Claude and does not persist a session turn",async()=>{
  let observedSignal;let connectorQueries=0;
  const {app,source,connector}=await fixture(async({signal,onEvent})=>{
    observedSignal=signal;
    onEvent?.({type:"step",status:"started"});
    if(signal.aborted)throw abortError();
    await new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(abortError()),{once:true}));
  });
  app.store.db.prepare("DELETE FROM ds_audit WHERE source_id=?").run(source.id);
  connector.query=async()=>{connectorQueries++;return [[],[]];};
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"},{disconnectOnFirstStep:true});
    assert.equal(response.disconnected,true);assert.equal(observedSignal.aborted,true);assert.equal(connectorQueries,0);
    assert.equal(app.store.listSessions(source.id,"analyst")[0].messageCount,0);
    assert.equal(app.store.listAudits(source.id,10).length,0);
  } finally { await app.close(); }
});

test("SSE emits clarification without persisting an intermediate session turn",async()=>{
  const {app,source}=await fixture(async()=>({status:"clarification",clarification:{question:"有效客户按自然人还是企业口径？",options:["自然人","企业"],allowFreeText:false},toolTrace:[]}));
  try {
    const response=await sseApi(app,{sourceId:source.id,question:"查询有效客户"});const events=parseEvents(response.raw);
    const clarification=events.find(item=>item.event==="clarification");assert.ok(clarification);
    assert.deepEqual(clarification.data.result.clarification.options,["自然人","企业"]);
    assert.equal(events.some(item=>item.event==="final"||item.event==="refused"),false);
    assert.equal(app.store.listSessions(source.id,"analyst")[0].messageCount,0);
  } finally { await app.close(); }
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
