import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { callLlmEmbedding } from "../src/embedding-client.mjs";
import { createEmbeddingIndex, pageText, tableText } from "../src/embedding-index.mjs";

const EMBEDDING={baseUrl:"https://embed.test/v1",apiKey:"embed-key",model:"embed-v1",dimensions:null};

function fakeSettings(overrides={}) {
  return {config:{embedding:{...EMBEDDING,...overrides.embedding},retrieval:{vectorEnabled:true,vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55,...overrides.retrieval}}};
}
function embeddingResponse(vectors) {
  return new Response(JSON.stringify({data:vectors.map((embedding,index)=>({index,embedding}))}),{status:200,headers:{"content-type":"application/json"}});
}

test("callLlmEmbedding posts an openai-compatible request and sorts by index",async()=>{
  let captured=null;
  const fetchImpl=async(url,init)=>{captured={url,body:JSON.parse(init.body),auth:init.headers.authorization};return new Response(JSON.stringify({data:[{index:1,embedding:[0,1]},{index:0,embedding:[1,0]}]}),{status:200});};
  const vectors=await callLlmEmbedding({...EMBEDDING,dimensions:64},["甲","乙"],{fetchImpl});
  assert.equal(captured.url,"https://embed.test/v1/embeddings");
  assert.equal(captured.auth,"Bearer embed-key");
  assert.deepEqual(captured.body,{model:"embed-v1",input:["甲","乙"],dimensions:64});
  assert.deepEqual(vectors,[[1,0],[0,1]]);
  await assert.rejects(callLlmEmbedding(EMBEDDING,["x"],{fetchImpl:async()=>new Response("",{status:401})}),/Embedding 鉴权失败（401）/);
  await assert.rejects(callLlmEmbedding({...EMBEDDING,baseUrl:""},["x"],{fetchImpl}),/未配置 Embedding Base URL/);
});

test("ensurePageEmbedding skips unchanged hashes and reindex rebuilds after model change",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-embedding-"));
  const store=createStore(join(root,"store.sqlite"));
  try {
    const sourceId=1;
    store.upsertKnowledge({sourceId,pageType:"term",slug:"valid-customer",title:"有效客户",aliases:JSON.stringify(["有效户"]),tablesJson:JSON.stringify(["crm_customer"]),content:"近90天下单",sqlContent:"status='active'",verified:1,owner:"tester"});
    const page=store.getKnowledge(sourceId,"term","valid-customer");
    let calls=0;
    const settings=fakeSettings();
    const index=createEmbeddingIndex({store,settings,fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);calls++;return embeddingResponse(body.input.map(()=>[1,0,0]));}});
    await index.ensurePageEmbedding(sourceId,page);
    assert.equal(calls,1);
    await index.ensurePageEmbedding(sourceId,page);
    assert.equal(calls,1);
    assert.equal(store.countEmbeddings(sourceId,"embed-v1"),1);
    assert.equal(index.loadVectors(sourceId).pageVectors.get("term:valid-customer").length,3);

    settings.config.embedding.model="embed-v2";
    assert.equal(index.loadVectors(sourceId),null);
    const result=await index.reindex(sourceId);
    assert.equal(result.model,"embed-v2");
    assert.ok(result.indexed>=1);
    assert.ok(index.loadVectors(sourceId).pageVectors.has("term:valid-customer"));
  } finally { store.close(); }
});

test("reindex reports progress, tolerates batch failures and drops stale refs",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-embedding-reindex-"));
  const store=createStore(join(root,"store.sqlite"));
  try {
    const sourceId=1;
    store.upsertTable({sourceId,tableName:"crm_customer",grade:"A",comment:"客户主表"});
    store.upsertColumn({sourceId,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",comment:"客户编号"});
    store.upsertKnowledge({sourceId,pageType:"term",slug:"valid-customer",title:"有效客户",aliases:"[]",tablesJson:"[]",content:"",sqlContent:"x",verified:0});
    store.upsertEmbedding({sourceId,kind:"page",refKey:"term:removed-page",model:"embed-v1",dims:3,textHash:"stale",vectorJson:"[1,0,0]"});
    const progress=[];
    const index=createEmbeddingIndex({store,settings:fakeSettings(),fetchImpl:async(_url,init)=>embeddingResponse(JSON.parse(init.body).input.map(()=>[0,1,0]))});
    const result=await index.reindex(sourceId,{onProgress:(step)=>progress.push(step)});
    assert.equal(result.total,2);
    assert.equal(result.indexed,2);
    assert.equal(result.failed,0);
    assert.ok(progress.length>=1);
    assert.equal(store.getEmbedding(sourceId,"page","term:removed-page"),undefined);

    const failing=createEmbeddingIndex({store,settings:fakeSettings({embedding:{model:"embed-broken"}}),fetchImpl:async()=>new Response("",{status:500})});
    const failure=await failing.reindex(sourceId);
    assert.equal(failure.failed,2);
    assert.equal(failure.indexed,0);
  } finally { store.close(); }
});

test("index text builders capture titles, aliases, comments and truncate content",()=>{
  const page={pageType:"term",slug:"x",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"长".repeat(2000)};
  const text=pageText(page);
  assert.ok(text.includes("有效客户")&&text.includes("有效户")&&text.includes("crm_customer"));
  assert.ok(text.length<1000);
  const table=tableText({tableName:"crm_customer",comment:"客户主表"},[{columnName:"customer_id",comment:"客户编号"}]);
  assert.ok(table.includes("crm_customer")&&table.includes("客户编号"));
});
