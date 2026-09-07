import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDiscoveryService, sampleRelationOverlap } from "../src/discovery-service.mjs";
import { createRelationModelService } from "../src/relation-model-service.mjs";
import { generateRelationCandidates } from "../src/relation-candidates.mjs";
import { createStore } from "../src/store.mjs";

const llm={baseUrl:"http://model.test/v1",apiKey:"synthetic-contract-key",model:"synthetic-judge"};
const tables=[{tableName:"customer",rowEstimate:100,comment:"客户"},{tableName:"orders",rowEstimate:1000,comment:"订单"}];
const column=(tableName,columnName,primary=false)=>({tableName,columnName,dataType:"bigint",nullable:"NO",comment:columnName==="customer_id"?"客户编号":"编号",isPrimary:Number(primary),isUnique:Number(primary),isIndexed:1});
const columns=[column("customer","id",true),column("orders","id",true),column("orders","customer_id")];
const candidates=generateRelationCandidates({schema:{tables,columns}});
const decision=(candidateId)=>({candidateId,decision:"relation",confidence:.9,cardinality:"N:1",reason:"订单关联客户"});
const response=(body)=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(body)}}]}),{status:200,headers:{"content-type":"application/json"}});
const requestCandidates=(init)=>JSON.parse(JSON.parse(init.body).messages.at(-1).content.split("候选元数据：")[1]);

test("missing model decisions retry only missing IDs and never fabricate rejections",async()=>{
  const input=[...candidates,{...candidates[0],id:"another"}],requests=[];
  const model=createRelationModelService({llm,fetchImpl:async(_url,init)=>{const batch=requestCandidates(init);requests.push(batch.map(item=>item.candidateId));return response({decisions:requests.length===1?[decision(input[0].id)]:[]});}});
  const result=await model.judge(input);
  assert.deepEqual(requests,[[input[0].id,"another"],["another"]]);
  assert.equal(result.status,"partial");assert.deepEqual(result.decisions,[decision(input[0].id)]);
  assert.deepEqual(result.missingCandidateIds,["another"]);
});

test("duplicate IDs, missing results and invalid confidence remain unjudged",async()=>{
  for(const output of [{},{decisions:[decision(candidates[0].id),decision(candidates[0].id)]},{decisions:[{...decision(candidates[0].id),confidence:2}]},{decisions:[{...decision(candidates[0].id),confidence:"0.9"}]}]){
    let calls=0;const model=createRelationModelService({llm,fetchImpl:async()=>{calls++;return response(output);}});
    const result=await model.judge(candidates);
    assert.equal(result.status,"failed");assert.equal(result.decisions.length,0);assert.equal(calls,2);
  }
});

test("discovery preserves an unanswered candidate and does not reuse failed column profiles",async()=>{
  const root=await mkdtemp(join(tmpdir(),"relation-discovery-repair-")),store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"synthetic",kind:"mysql",host:"synthetic",port:3306,dbName:"synthetic",userName:"ro",credential:"synthetic",isDemo:false});
  let failProfiles=false,missing=false;const requests=[];
  const connector={query:async(_source,sql)=>{
    if(sql.includes("information_schema.TABLES"))return [tables];
    if(sql.includes("information_schema.COLUMNS"))return [columns];
    if(sql.includes("information_schema.KEY_COLUMN_USAGE"))return [[]];
    if(sql.includes("matchCount"))return [[{value:1,matchCount:1},{value:2,matchCount:1}]];
    if(sql.startsWith("SELECT DISTINCT"))return [[{value:1},{value:2}]];
    if(failProfiles)throw new Error("synthetic profile timeout");
    return [sql.includes("FROM `orders`")?[{id:10,customer_id:1},{id:11,customer_id:2}]:[{id:1},{id:2}]];
  }};
  const model=createRelationModelService({llm,fetchImpl:async(_url,init)=>{const batch=requestCandidates(init);requests.push(batch);return response(missing?{}:{decisions:batch.map(item=>decision(item.candidateId))});}});
  const service=createDiscoveryService({store,connector,wikiDir:join(root,"wiki"),config:{llm,profiling:{enabled:true},relationModel:{proposalsEnabled:false}},relationModel:model});
  try{
    await service.discover(source);assert.ok(requests[0][0].from.profile.sampleValues.length);
    missing=true;failProfiles=true;await service.discover(source);
    const last=requests.at(-1)[0];assert.equal(last.from.profile?.sampleValues?.length||0,0,"failed sampling must not reuse the old values");
    assert.equal(store.listRelations(source.id,false,true)[0].status,"review");
    assert.equal(store.listRelations(source.id,false,true)[0].modelConfidence,null);
    assert.match(store.listRelations(source.id,false,true)[0].modelReason,/尚未完成有效判断/);
    assert.equal(store.relationStats(source.id).modelStatus,"failed");assert.equal(store.relationStats(source.id).judgedCount,0);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});

test("relation overlap checks sampled source values against the complete target",async()=>{
  const queries=[];
  const result=await sampleRelationOverlap({query:async(_source,sql)=>{queries.push(sql);return sql.includes("matchCount")?[[{value:501,matchCount:1},{value:1000,matchCount:2}]]:[sql.includes("FROM `orders`")?[{value:501},{value:1000}]:[{value:1},{value:2}]];}},{},{tableName:"orders",columnName:"customer_id"},{tableName:"customer",columnName:"id"},500);
  assert.equal(result,1);assert.ok(queries.some(sql=>sql.includes("matchCount")));
});

test("semantic references without suffixes, shared primary keys and unindexed targets are eligible",()=>{
  for(const modify of [schema=>{schema.columns[2].columnName="customer";},schema=>{schema.columns[2].isPrimary=1;},schema=>{schema.columns[0].isPrimary=0;schema.columns[0].isUnique=0;schema.columns[0].isIndexed=0;}]){
    const schema=structuredClone({tables,columns});modify(schema);assert.ok(generateRelationCandidates({schema}).some(item=>item.to.tableName==="customer"));
  }
});

test("采样区分重复匹配、空样本、查询失败和超时，并保持可解析的 MySQL 语句",async()=>{
  const {sampleRelationEvidence}=await import("../src/relation-data-evidence.mjs");
  const {default:sqlParser}=await import("node-sql-parser");
  const from={tableName:"orders",columnName:"customer_id"},to={tableName:"customer",columnName:"id"};
  let sql;
  const sampled=await sampleRelationEvidence({query:async(_source,query)=>{sql=query;return [[{value:501,matchCount:2},{value:1000,matchCount:0}]];}},{},from,to,500);
  assert.equal(sampled.matchRatio,.5);assert.equal(sampled.multipleMatchCount,1);assert.equal(sampled.orphanRatio,.5);assert.equal(sampled.scope,"sample");
  assert.match(sql,/MAX_EXECUTION_TIME\([1-9]\d*\)/);
  assert.doesNotThrow(()=>new sqlParser.Parser().astify(sql,{database:"MySQL"}));
  const empty=await sampleRelationEvidence({query:async()=>[[]]},{},from,to,1);assert.equal(empty.status,"empty");assert.equal(empty.matchRatio,null);
  const failed=await sampleRelationEvidence({query:async()=>{throw new Error("test");}},{},from,to,1);assert.equal(failed.reason,"query_failed");assert.equal(failed.matchRatio,null);
  let signal;const timeout=await sampleRelationEvidence({query:async(_source,_sql,_params,s)=>{signal=s;return new Promise(()=>{});}},{},from,to,1,{timeoutMs:100});
  assert.equal(timeout.reason,"timeout");assert.equal(signal.aborted,true);
});

test("画像过期时模型只收到状态，不再看到旧值或旧统计",async()=>{
  const {columnProfileForPrompt}=await import("../src/column-profile.mjs");
  const view=columnProfileForPrompt({sampledAt:"2000-01-01T00:00:00Z",sampleValues:["old"],distinctCount:1,nullRatio:0,formatPattern:"old"});
  assert.equal(view.status,"stale");assert.deepEqual(view.sampleValues,[]);assert.equal(view.distinctCount,null);assert.equal(view.formatPattern,null);
});

test("角色字段有业务注释时可召回，通用 id 和范围外表不会进入候选",()=>{
  const schema=structuredClone({tables,columns});schema.columns[2].columnName="buyer_id";schema.columns[2].comment="客户编号，购买客户";
  assert.ok(generateRelationCandidates({schema}).some(item=>item.from.columnName==="buyer_id"&&item.to.tableName==="customer"));
  assert.equal(generateRelationCandidates({schema,eligibleTableNames:["orders"]}).some(item=>item.to.tableName==="customer"),false);
  assert.equal(generateRelationCandidates({schema}).some(item=>item.from.columnName==="id"&&item.to.columnName==="id"),false);
  assert.doesNotThrow(()=>generateRelationCandidates({schema:{tables:[...tables,{tableName:"no_columns"}],columns}}));
});

test("actual discovery carries an LLM-only composite proposal through resampling and atomic review storage",async()=>{
  const root=await mkdtemp(join(tmpdir(),"composite-proposal-discovery-")),store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"synthetic",kind:"mysql",host:"db",port:3306,dbName:"test",userName:"ro",credential:"synthetic",isDemo:false});
  const tables=[{tableName:"ledger",rowEstimate:100},{tableName:"registry",rowEstimate:100}];
  const key={name:"uq_registry",unique:true,members:[{column:"tenant_id",ordinal:1},{column:"code",ordinal:2}]};
  const columns=[{tableName:"ledger",columnName:"tenant_id"},{tableName:"ledger",columnName:"r7"},{tableName:"registry",columnName:"tenant_id",keyConstraints:[key]},{tableName:"registry",columnName:"code",keyConstraints:[key]}].map(column=>({...column,dataType:"bigint",nullable:"NO"}));
  let judgments=0;
  const connector={query:async(_source,sql)=>{
    if(sql.includes("information_schema.TABLES"))return [tables];if(sql.includes("information_schema.COLUMNS"))return [columns];if(sql.includes("information_schema.KEY_COLUMN_USAGE"))return [[]];
    return [sql.includes("matchCount")?[{value:1,value1:7,matchCount:1}]:[{stratum:1}]];
  }};
  const model=createRelationModelService({llm,fetchImpl:async(_url,init)=>{
    const isProposal=JSON.parse(init.body).messages[0].content.includes("关系发现器");
    const result=isProposal?{proposals:[{fromTable:"ledger",toTable:"registry",columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"r7",toCol:"code"}],reason:"r7 是同租户注册项编码"}]}:{decisions:requestCandidates(init).map(item=>({candidateId:item.candidateId,decision:judgments++?"relation":"uncertain",confidence:.9,cardinality:"N:1",reason:"完整元组匹配"}))};
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}],usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120}}),{status:200,headers:{"content-type":"application/json"}});
  }});
  try{
    assert.equal(generateRelationCandidates({schema:{tables,columns}}).length,0);
    await createDiscoveryService({store,connector,wikiDir:join(root,"wiki"),config:{relationModel:{sampleLimit:20}},relationModel:model}).discover(source);
    const relations=store.listRelations(source.id,false,true);assert.equal(relations.length,1);assert.equal(relations[0].columnPairs.length,2);assert.equal(relations[0].status,"review");assert.equal(relations[0].dataEvidence.history.length,1);
    const stats=store.relationStats(source.id);assert.equal(stats.diagnostics.proposalCandidateCount,1);assert.equal(stats.diagnostics.resampledCount,1);assert.equal(stats.diagnostics.usage.calls,3);assert.equal(stats.diagnostics.usage.totalTokens,360);
  }finally{store.close();await rm(root,{recursive:true,force:true});}
});
