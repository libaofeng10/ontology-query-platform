import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";

test("query session API persists turns and isolates them by authenticated user",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-session-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"session-api-secret",
    apiIdentities:[
      {name:"analyst-a",role:"analyst",token:"token-a",sourceIds:"*"},
      {name:"analyst-b",role:"analyst",token:"token-b",sourceIds:"*"},
    ],
    connector,rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  const source=app.store.listSources().find((item)=>item.isDemo);
  try {
    const created=await api(app,"/api/sessions","token-a",{sourceId:source.id});
    assert.equal(created.status,201);assert.equal(created.body.title,"新问数会话");
    const query=await api(app,"/api/query","token-a",{sourceId:source.id,sessionId:created.body.id,question:"查询有效客户"});
    assert.equal(query.status,200);assert.equal(query.body.sessionId,created.body.id);
    const detail=await api(app,`/api/sessions/${created.body.id}`,"token-a",null,"GET");
    assert.equal(detail.status,200);assert.equal(detail.body.title,"查询有效客户");assert.deepEqual(detail.body.messages.map((item)=>item.role),["user","assistant"]);assert.ok(detail.body.messages[1].content.evidence.sql);
    const ownList=await api(app,`/api/sessions?sourceId=${source.id}`,"token-a",null,"GET");
    assert.equal(ownList.body[0].messageCount,2);
    const otherList=await api(app,`/api/sessions?sourceId=${source.id}`,"token-b",null,"GET");
    assert.deepEqual(otherList.body,[]);
    const forbidden=await api(app,`/api/sessions/${created.body.id}`,"token-b",null,"GET");
    assert.equal(forbidden.status,403);
    const removed=await api(app,`/api/sessions/${created.body.id}`,"token-a",null,"DELETE");
    assert.equal(removed.status,200);assert.equal(app.store.getSession(created.body.id),null);
  } finally { await app.close(); }
});

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;
  request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
