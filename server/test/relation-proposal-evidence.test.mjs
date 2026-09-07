import assert from "node:assert/strict";
import test from "node:test";
import { generateRelationCandidates } from "../src/relation-candidates.mjs";
import { createRelationModelService } from "../src/relation-model-service.mjs";
import { sampleRelationEvidence } from "../src/relation-data-evidence.mjs";
import { analyzeRelationCandidates } from "../src/relation-discovery-analysis.mjs";
import { validateRelationProposal } from "../src/relation-candidates.mjs";

const unique={name:"uq_customer",unique:true,members:[{column:"tenant_id",ordinal:1},{column:"code",ordinal:2}]};
const col=(tableName,columnName,extra={})=>({tableName,columnName,dataType:"bigint",...extra});
const schema={tables:[{tableName:"orders"},{tableName:"customer"}],columns:[col("orders","tenant_id"),col("orders","customer_code"),col("customer","tenant_id",{keyConstraints:[unique]}),col("customer","code",{keyConstraints:[unique]})],foreignKeys:[]};
const llm={baseUrl:"http://model.test/v1",apiKey:"synthetic",model:"synthetic"};
const response=body=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(body)}}]}),{status:200,headers:{"content-type":"application/json"}});

test("logical composite candidates preserve tenant and business key without a declared FK",()=>{
  const candidate=generateRelationCandidates({schema}).find(item=>item.from.tableName==="orders"&&item.columnPairs?.length===2);
  assert.ok(candidate);
  assert.deepEqual(candidate.columnPairs,[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"customer_code",toCol:"code"}]);
  assert.equal(candidate.to.isUnique,true);
});

test("uncertainty triggers one different bounded sample and the revision preserves first-round evidence",async()=>{
  const queries=[],judged=[];
  const connector={query:async(_source,sql)=>{queries.push(sql);return [sql.includes("matchCount")?[{value:1,value1:9,matchCount:1}]:[{stratum:1}]];}};
  const model={propose:async()=>({status:"completed",candidates:[]}),judge:async candidates=>{
    judged.push(structuredClone(candidates));return {status:"completed",decisions:candidates.map(candidate=>({candidateId:candidate.id,decision:judged.length===1?"uncertain":"relation",confidence:judged.length===1?.4:.9,cardinality:"N:1",reason:"验证完整租户键"}))};
  }};
  const result=await analyzeRelationCandidates({schema,model,connector,source:{},config:{maxResampleCandidates:1,sampleLimit:10}});
  assert.equal(judged.length,2);assert.equal(result.diagnostics.resampledCount,1);
  assert.equal(result.modelResult.decisions[0].decision,"relation");assert.equal(judged[1][0].dataEvidence.history[0].decision.decision,"uncertain");
  assert.ok(queries.some(sql=>sql.includes("CRC32")));assert.ok(queries.length<=8);
  assert.equal(result.candidates[0].dataEvidence.round,1);
});

test("LLM actively proposes complete pairs and server rejects invented/out-of-scope/type-conflicting columns",async()=>{
  let requests=0;
  const model=createRelationModelService({llm,fetchImpl:async()=>{requests++;return response({proposals:[
    {fromTable:"orders",toTable:"customer",columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"customer_code",toCol:"code"}],reason:"同租户内的客户编码"},
    {fromTable:"orders",toTable:"secret",columnPairs:[{fromCol:"customer_code",toCol:"id"}],reason:"猜测"},
    {fromTable:"orders",toTable:"customer",columnPairs:[{fromCol:"missing",toCol:"code"}],reason:"猜测"},
  ]});}});
  const result=await model.propose({schema,eligibleTableNames:["orders","customer"],maxCandidates:10});
  assert.equal(requests,1);assert.equal(result.candidates.length,1);assert.equal(result.rejectedCount,2);
  assert.equal(result.candidates[0].columnPairs.length,2);assert.equal(result.candidates[0].origin,"model_proposal");
  assert.equal(result.candidates[0].status,undefined,"proposal is not confirmation");
});

test("tuple evidence compares all members and samples tenant, status and time strata within budget",async()=>{
  const queries=[];
  const connector={query:async(_source,sql,params)=>{queries.push({sql,params});
    if(!sql.includes("matchCount"))return [[{stratum:1},{stratum:2}]];
    return [[{value:1,value1:7,matchCount:1},{value:2,value1:7,matchCount:0}]];
  }};
  const evidence=await sampleRelationEvidence(connector,{},
    {tableName:"orders",columnNames:["tenant_id","customer_code"]},
    {tableName:"customer",columnNames:["tenant_id","code"]},40,
    {stratify:true,columns:[...schema.columns,col("orders","status"),col("orders","created_at",{dataType:"datetime"})],maxQueries:7});
  assert.equal(evidence.method,"source_stratified_target_lookup");assert.ok(evidence.strata.some(item=>item.column==="tenant_id"));
  assert.ok(evidence.strata.some(item=>item.column==="status"));assert.ok(evidence.strata.some(item=>item.column==="created_at"));
  assert.ok(queries.length<=7);
  for(const {sql} of queries.filter(item=>item.sql.includes("matchCount"))){
    assert.match(sql,/MAX_EXECUTION_TIME\([1-9]\d*\)/);
    assert.match(sql,/target\.`tenant_id` = sampled\.value/);assert.match(sql,/target\.`code` = sampled\.value1/);
  }
  assert.equal(evidence.sampleSize,2,"duplicate tuples from strata do not multiply sample size");assert.equal(evidence.matchRatio,.5);
  assert.equal(evidence.scope,"sample");
});

test("partial logical keys and type conflicts are rejected before any sampling",()=>{
  const partial={fromTable:"orders",toTable:"customer",columnPairs:[{fromCol:"customer_code",toCol:"code"}],reason:"缺少租户"};
  assert.equal(validateRelationProposal(partial,{schema}),null);
  const wrong=structuredClone(schema);wrong.columns[0].dataType="datetime";
  assert.equal(validateRelationProposal({...partial,columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"customer_code",toCol:"code"}]},{schema:wrong}),null);
});

test("every sampling statement has one server deadline and a server timeout remains unavailable evidence",async()=>{
  const queries=[];
  const connector={query:async(_source,sql)=>{
    queries.push(sql);
    if(sql.includes("matchCount")){const error=new Error("Query execution was interrupted, maximum statement execution time exceeded");error.code="ER_QUERY_TIMEOUT";throw error;}
    return [[{stratum:1}]];
  }};
  const evidence=await sampleRelationEvidence(connector,{},
    {tableName:"orders",columnName:"customer_code"},{tableName:"customer",columnName:"code"},10,
    {timeoutMs:350,stratify:true,columns:[col("orders","status")]});
  assert.equal(queries.length,2);
  for(const sql of queries){
    assert.match(sql,/^\(?SELECT \/\*\+ MAX_EXECUTION_TIME\([1-9]\d*\) \*\//);
    assert.equal(sql.match(/MAX_EXECUTION_TIME/g).length,1);
    assert.ok(Number(sql.match(/MAX_EXECUTION_TIME\((\d+)\)/)[1])<=350);
  }
  assert.equal(evidence.status,"unavailable");assert.equal(evidence.reason,"timeout");assert.equal(evidence.matchRatio,null);
});
