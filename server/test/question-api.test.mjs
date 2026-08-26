import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-question-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]};
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"question-api-secret",apiIdentities:[{name:"data-editor",role:"editor",token:"token-editor",sourceIds:"*"}],connector,rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test"});
  return {app,source:app.store.listSources().find((item)=>item.isDemo)};
}

test("enum answer API only accepts listed options and stale answers cannot overwrite meaning",async()=>{
  const {app,source}=await createFixture();
  try {
    const id=app.store.addQuestion({sourceId:source.id,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"1",question:"状态 1？",evidence:"待人工确认",options:["有效","无效","补充说明"]});
    const forged=await api(app,`/api/questions/${id}/answer`,{answer:"伪造含义"});
    assert.equal(forged.status,400);assert.match(forged.body.error,/options/);assert.equal(app.store.getQuestion(id).status,"pending");

    const accepted=await api(app,`/api/questions/${id}/answer`,{answer:" 有效 "});
    assert.equal(accepted.status,200);assert.equal(accepted.body.ok,true);
    const stale=await api(app,`/api/questions/${id}/answer`,{answer:"无效"});
    assert.equal(stale.status,409);assert.match(stale.body.error,/已被回答|已失效/);
    const meaning=app.store.db.prepare(`SELECT meaning,meaning_source AS meaningSource FROM ds_enum WHERE source_id=? AND table_name='customer' AND column_name='status' AND value='1'`).get(source.id);
    assert.deepEqual(meaning,{meaning:"有效",meaningSource:"human"});
  } finally { await app.close(); }
});

test("enum answer API safely handles supplemental, malformed and unbound questions",async()=>{
  const {app,source}=await createFixture();
  try {
    const supplementId=app.store.addQuestion({sourceId:source.id,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"2",question:"状态 2？",evidence:"待人工确认",options:["有效","补充说明"]});
    assert.equal((await api(app,`/api/questions/${supplementId}/answer`,{answer:"补充说明"})).status,200);
    assert.equal(app.store.db.prepare(`SELECT COUNT(*) AS count FROM ds_enum WHERE source_id=? AND table_name='customer' AND column_name='status' AND value='2'`).get(source.id).count,0);

    const malformedId=app.store.addQuestion({sourceId:source.id,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",enumValue:"3",question:"状态 3？",evidence:"待人工确认",options:["有效"]});
    app.store.db.prepare(`UPDATE ds_question SET options='not-json' WHERE id=?`).run(malformedId);
    const listed=await api(app,`/api/questions?sourceId=${source.id}`,null,"GET");
    assert.equal(listed.status,200);assert.deepEqual(listed.body.find((item)=>item.id===malformedId).options,[]);
    assert.equal((await api(app,`/api/questions/${malformedId}/answer`,{answer:"有效"})).status,400);
    assert.equal(app.store.getQuestion(malformedId).status,"pending");

    const unboundId=app.store.addQuestion({sourceId:source.id,kind:"枚举含义",scope:"column",tableName:"customer",columnName:"status",question:"状态 999 是否有效？",evidence:"没有 enumValue",options:["有效","无效"]});
    const unbound=await api(app,`/api/questions/${unboundId}/answer`,{answer:"有效"});
    assert.equal(unbound.status,409);assert.match(unbound.body.error,/结构化值绑定/);assert.equal(app.store.getQuestion(unboundId).status,"pending");
    assert.equal(app.store.db.prepare(`SELECT COUNT(*) AS count FROM ds_enum WHERE source_id=? AND table_name='customer' AND column_name='status' AND value='999'`).get(source.id).count,0);

    assert.equal((await api(app,`/api/questions/${unboundId}/answer`,{answer:1})).status,400);
  } finally { await app.close(); }
});

async function api(app,path,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;
  request.headers={authorization:"Bearer token-editor","content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
