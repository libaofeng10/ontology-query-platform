import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";

async function createFixture(extra={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-settings-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"settings-api-secret",
    apiIdentities:[
      {name:"platform-admin",role:"admin",token:"token-admin",sourceIds:"*"},
      {name:"data-editor",role:"editor",token:"token-editor",sourceIds:"*"},
    ],
    connector,rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
    ...extra,
  });
  return app;
}

test("settings API requires admin for reads and writes and hot-applies updates",async()=>{
  const app=await createFixture();
  try {
    assert.equal((await api(app,"/api/settings","token-editor",null,"GET")).status,403);
    assert.equal((await api(app,"/api/settings","token-editor",{llm:{model:"x"}},"PUT")).status,403);
    const view=await api(app,"/api/settings","token-admin",null,"GET");
    assert.equal(view.status,200);
    assert.ok("llm" in view.body&&"embedding" in view.body&&"retrieval" in view.body&&"query" in view.body&&"ontologyAi" in view.body&&"prompts" in view.body);
    assert.equal(view.body.promptMeta.agentQuestion.label,"Agent 初始任务");
    assert.deepEqual(view.body.promptMeta.agentQuestion.variables,["context"]);
    assert.equal(view.body.prompts.agentQuestion,view.body.promptDefaults.agentQuestion);
    const customPrompt="API 自定义提示词：{{context}}";
    const updated=await api(app,"/api/settings","token-admin",{llm:{model:"hot-model",apiKey:"sk-new-key-tail"},retrieval:{topK:5},ontologyAi:{mode:"review",autoConfirmScore:80},prompts:{agentQuestion:customPrompt}},"PUT");
    assert.equal(updated.status,200);
    assert.equal(updated.body.llm.model,"hot-model");
    assert.deepEqual(updated.body.llm.apiKey,{set:true,masked:"****tail"});
    assert.equal(updated.body.retrieval.topK,5);
    assert.equal(updated.body.ontologyAi.mode,"review");
    assert.equal(updated.body.prompts.agentQuestion,customPrompt);
    assert.equal(updated.body.sources["prompts.agentQuestion"],"db");
    const reset=await api(app,"/api/settings","token-admin",{prompts:{agentQuestion:null}},"PUT");
    assert.equal(reset.body.prompts.agentQuestion,reset.body.promptDefaults.agentQuestion);
    assert.equal(reset.body.sources["prompts.agentQuestion"],"default");
    const invalid=await api(app,"/api/settings","token-admin",{retrieval:{vectorWeight:5}},"PUT");
    assert.equal(invalid.status,400);
    assert.match(invalid.body.error,/vectorWeight/);
    const invalidPrompt=await api(app,"/api/settings","token-admin",{prompts:{agentQuestion:"no variable"}},"PUT");
    assert.equal(invalidPrompt.status,400);
    assert.match(invalidPrompt.body.error,/缺少必需变量/);
  } finally { await app.close(); }
});

test("test-llm and test-embedding probe merged candidate configs without saving",async()=>{
  let llmRequest=null,embeddingRequest=null;
  const app=await createFixture({
    llmFetchImpl:async(url,init)=>{llmRequest={url,body:JSON.parse(init.body)};return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'}}]}),{status:200});},
    embeddingFetchImpl:async(url,init)=>{embeddingRequest={url,body:JSON.parse(init.body)};return new Response(JSON.stringify({data:[{index:0,embedding:[0.1,0.2,0.3]}]}),{status:200});},
  });
  try {
    const llm=await api(app,"/api/settings/test-llm","token-admin",{baseUrl:"https://probe.test/v1",apiKey:"sk-probe",model:"probe-model"});
    assert.equal(llm.status,200);
    assert.equal(llm.body.model,"probe-model");
    assert.equal(llmRequest.url,"https://probe.test/v1/chat/completions");
    const embedding=await api(app,"/api/settings/test-embedding","token-admin",{baseUrl:"https://probe.test/v1",apiKey:"sk-probe",model:"embed-probe"});
    assert.equal(embedding.status,200);
    assert.equal(embedding.body.dimensions,3);
    assert.equal(embeddingRequest.body.model,"embed-probe");
    const failed=await api(app,"/api/settings/test-embedding","token-admin",{});
    assert.equal(failed.status,400);
    assert.match(failed.body.error,/Embedding/);
    assert.equal((await api(app,"/api/settings/test-llm","token-editor",{})).status,403);
  } finally { await app.close(); }
});

test("updated llm settings reach the query pipeline without a restart",async()=>{
  let queryModel=null;
  const app=await createFixture({
    llm:{baseUrl:"",apiKey:"",model:""},
  });
  try { await app.close(); } catch { /* fixture only used for shape */ }

  const root=await mkdtemp(join(tmpdir(),"ontoquery-settings-hot-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),query:async()=>[[{total:1}],[{name:"total"}]],explain:async()=>[{rows:1}]};
  const hotApp=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"settings-hot-secret",
    apiIdentities:[{name:"platform-admin",role:"admin",token:"token-admin",sourceIds:"*"}],
    connector,rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  try {
    const updated=await api(hotApp,"/api/settings","token-admin",{llm:{baseUrl:"https://hot.test/v1",apiKey:"sk-hot-model-key",model:"hot-query-model"}},"PUT");
    assert.equal(updated.status,200);
    const view=await api(hotApp,"/api/settings","token-admin",null,"GET");
    assert.equal(view.body.llm.model,"hot-query-model");
    assert.equal(view.body.sources["llm.model"],"db");
    queryModel=view.body.llm.model;
    assert.equal(queryModel,"hot-query-model");
  } finally { await hotApp.close(); }
});

test("embedding reindex is admin-only and returns an async task",async()=>{
  const app=await createFixture({
    embeddingFetchImpl:async(_url,init)=>new Response(JSON.stringify({data:JSON.parse(init.body).input.map((_,index)=>({index,embedding:[1,0]}))}),{status:200}),
  });
  try {
    const source=app.store.listSources().find((item)=>item.isDemo);
    assert.equal((await api(app,"/api/settings/reindex-embeddings","token-editor",{sourceId:source.id})).status,403);
    await api(app,"/api/settings","token-admin",{embedding:{baseUrl:"https://embed.test/v1",apiKey:"sk-embed",model:"embed-v1"}},"PUT");
    const task=await api(app,"/api/settings/reindex-embeddings","token-admin",{sourceId:source.id});
    assert.equal(task.status,202);
    assert.equal(task.body.taskType,"embedding_reindex");
    await waitForTask(app,task.body.id);
    const done=app.store.getTask(task.body.id);
    assert.equal(done.status,"succeeded");
    assert.ok(done.result.total>=1);
  } finally { await app.close(); }
});

async function waitForTask(app,taskId,attempts=100) {
  for(let index=0;index<attempts;index++) {
    const task=app.store.getTask(taskId);
    if(!task||["succeeded","failed"].includes(task.status)) return task;
    await new Promise((resolve)=>setTimeout(resolve,20));
  }
  throw new Error("任务未在预期时间内完成");
}

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;
  request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
