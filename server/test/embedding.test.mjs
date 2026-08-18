import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { callLlmEmbedding } from "../src/embedding-client.mjs";
import { createEmbeddingIndex, pageText, tableText } from "../src/embedding-index.mjs";
import { retrieveKnowledge } from "../src/knowledge-retrieval.mjs";

const EMBEDDING={baseUrl:"https://embed.test/v1",apiKey:"embed-key",model:"embed-v1",dimensions:null};

function fakeSettings(overrides={}) {
  return {config:{embedding:{...EMBEDDING,...overrides.embedding},retrieval:{vectorEnabled:true,topK:8,vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55,...overrides.retrieval}}};
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

test("hybrid retrieval recalls high-similarity pages lexical scoring misses",()=>{
  const pages=[
    {pageType:"term",slug:"valid-customer",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"近90天下单",verified:true},
    {pageType:"metric",slug:"repurchase-rate",title:"复购率",aliases:[],tables:["sales_order"],content:"再次下单比例",verified:true},
  ];
  const tables=[{tableName:"crm_customer",comment:"客户"},{tableName:"sales_order",comment:"订单"}];
  const question="回头客占多少";
  const lexical=retrieveKnowledge({question,pages,tables,columnsByTable:{},relations:[]});
  assert.equal(lexical.coverage,"none");
  assert.equal(lexical.retrievalMode,"lexical");
  const vector={
    queryVector:[1,0],
    pageVectors:new Map([["metric:repurchase-rate",[0.95,Math.sqrt(1-0.95**2)]],["term:valid-customer",[0.1,Math.sqrt(1-0.1**2)]]]),
    tableVectors:new Map(),
    vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55,
  };
  const hybrid=retrieveKnowledge({question,pages,tables,columnsByTable:{},relations:[],vector});
  assert.equal(hybrid.coverage,"semantic");
  assert.equal(hybrid.retrievalMode,"hybrid");
  assert.deepEqual(hybrid.pages.map((page)=>page.slug),["repurchase-rate"]);
  assert.deepEqual(hybrid.tableNames,["sales_order"]);
});

test("term-anchor aliases expand business slang into bound semantic labels",()=>{
  const pages=[{pageType:"term",slug:"customer",title:"客户",aliases:[],tables:["crm_customer"],content:"客户主体",verified:true}];
  const result=retrieveKnowledge({question:"看一下客群数量",pages,tables:[{tableName:"crm_customer",comment:"客户"}],columnsByTable:{crm_customer:[]},relations:[],termAliases:[{aliases:["客群"],terms:["客户"]}]});
  assert.equal(result.coverage,"semantic");
  assert.deepEqual(result.pages.map((page)=>page.slug),["customer"]);
});

test("low-similarity pure vector hits are dropped so refusal boundaries stay strict",()=>{
  const pages=[{pageType:"term",slug:"valid-customer",title:"有效客户",aliases:[],tables:["crm_customer"],content:"",verified:true}];
  const vector={
    queryVector:[1,0],
    pageVectors:new Map([["term:valid-customer",[0.5,Math.sqrt(0.75)]]]),
    tableVectors:new Map(),
    vectorWeight:0.4,minSimilarity:0.35,semanticThreshold:0.55,
  };
  const result=retrieveKnowledge({question:"完全无关的问题",pages,tables:[],columnsByTable:{},relations:[],vector});
  assert.equal(result.coverage,"none");
  assert.deepEqual(result.pages,[]);
});

test("vector=null keeps hybrid retrieval byte-compatible with the lexical path",()=>{
  const pages=[{pageType:"term",slug:"valid-customer",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"定义",verified:true}];
  const tables=[{tableName:"crm_customer",comment:"客户"}];
  const question="有效客户有多少";
  const before=retrieveKnowledge({question,pages,tables,columnsByTable:{},relations:[]});
  const after=retrieveKnowledge({question,pages,tables,columnsByTable:{},relations:[],vector:null});
  assert.deepEqual({...before,retrievalMode:undefined},{...after,retrievalMode:undefined});
  assert.equal(before.coverage,"semantic");
});
