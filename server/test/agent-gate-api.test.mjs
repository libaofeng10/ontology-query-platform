import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";

test("agent gate API runs an off-vs-required background comparison and persists its evidence",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-agent-gate-api-"));
  const rows=[{label:"全部",total:100}];const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:1}],query:async()=>[rows,[{name:"label"},{name:"total"}]]};
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"agent-gate-api-secret",connector,nodeEnv:"test",apiIdentities:[{name:"editor",role:"editor",token:"token-editor",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-agent-gate",model:"agent-gate-test"},semanticQueryPlanMode:"off",queryAgentMode:"off",queryAgentMaxIterations:5,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100});
  const source=app.store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"unused",isDemo:false});app.store.markSourceTest(source.id,true);
  app.store.upsertTable({sourceId:source.id,tableName:"sales_summary",rowEstimate:1,grade:"A",active:1,comment:"销售汇总"});app.store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"label",dataType:"varchar",isSensitive:0,comment:"分类"});app.store.upsertColumn({sourceId:source.id,tableName:"sales_summary",columnName:"total",dataType:"decimal",isSensitive:0,comment:"销售总额"});app.store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"销售总额",title:"销售总额",aliases:"[]",tablesJson:'["sales_summary"]',content:"全部销售金额",sqlContent:"汇总 total",antiExamples:"",verified:1,owner:"owner"});app.store.addEvalCase({sourceId:source.id,setName:"agent-api",question:"销售总额",goldSql:"SELECT label, total FROM sales_summary",category:"金额",heldOut:0});
  const replies=[
    {sql:"SELECT label, total FROM sales_summary"},
    {conclusion:"销售总额为 100。"},
    {thought:"执行销售总额查询。",tool:"run_sql",args:{sql:"SELECT label, total FROM sales_summary"}},
    {thought:"提交已验证结果。",tool:"submit_answer",args:{sql:"SELECT label, total FROM sales_summary",conclusion:"销售总额为 100。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(replies.shift())}}],usage:{prompt_tokens:20,completion_tokens:5,total_tokens:25}}),{status:200});
  try {
    const response=await api(app,"/api/eval/gate","token-editor",{sourceId:source.id,setName:"agent-api",tolerance:1e-6,gateKind:"agent",maxRepeatedActionRate:0.05});assert.equal(response.status,202);assert.equal(response.body.taskType,"evaluation_agent_gate");assert.equal(response.body.payload.maxRepeatedActionRate,0.05);
    const done=await waitForTask(app,response.body.id);assert.equal(done.status,"succeeded",done.error);assert.equal(done.result.gateKind,"agent");assert.equal(done.result.decision,"enable_agent_prefer",JSON.stringify(done.result));assert.equal(done.result.candidate.agentExecutionRate,1);
    const gate=app.store.getEvalGate(response.body.id);assert.equal(gate.passed,1);assert.equal(gate.candidate.averageTokens,50);
    const candidate=app.store.listEvalRuns(source.id).find((item)=>item.requestedMode==="agent_required");assert.equal(candidate.agentMetrics.totalTokens,50);assert.equal(candidate.agentMetrics.toolCalls,2);
  } finally {globalThis.fetch=originalFetch;await app.close();}
});

async function waitForTask(app,id,attempts=100){for(let index=0;index<attempts;index++){const task=app.store.getTask(id);if(task&&["succeeded","failed"].includes(task.status))return task;await new Promise((resolve)=>setTimeout(resolve,10));}throw new Error("Agent 门禁任务未完成");}
async function api(app,path,token,body){const payload=JSON.stringify(body);const request=Readable.from([payload]);request.method="POST";request.url=path;request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};}
