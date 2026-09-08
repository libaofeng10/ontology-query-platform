import assert from "node:assert/strict";
import test from "node:test";
import {sampleRelationEvidence,describeRelationEvidence} from "../src/relation-data-evidence.mjs";
import {_internal as discovery} from "../src/discovery-service.mjs";
import {_internal as model} from "../src/relation-model-service.mjs";

const from={tableName:"members",columnNames:["tenant_id","person_id"]};
const to={tableName:"events",columnNames:["tenant_id","person_id"]};
const probe=rows=>sampleRelationEvidence({query:async()=>[rows]},{},from,to,10);

test("compound sampling counts source rows and only matched duplicate groups refute source uniqueness",async()=>{
  let sql;
  const evidence=await sampleRelationEvidence({query:async(_source,query)=>{
    sql=query;
    return [[{value:1,value1:7,matchCount:4,sourceCount:3},{value:1,value1:8,matchCount:0,sourceCount:9},{value:2,value1:7,matchCount:1,sourceCount:1}]];
  }},{},from,to,10);
  assert.match(sql,/FROM `members` AS source_rows/);
  assert.match(sql,/source_rows\.`tenant_id` = sampled\.value AND source_rows\.`person_id` = sampled\.value1/);
  assert.equal(evidence.queryCount,1);
  assert.equal(evidence.sourceMultipleMatchCount,1);
  assert.equal(evidence.sourceMaxMatches,3);
  assert.equal(evidence.multipleMatchCount,1);
  assert.match(describeRelationEvidence({dataEvidence:evidence}),/源端.*1.*3/);
});

test("legacy and unavailable source counts remain unknown, not a zero duplicate claim",async()=>{
  const legacy=await probe([{value:1,value1:7,matchCount:1}]);
  assert.equal(legacy.sourceMultipleMatchCount,null);assert.equal(legacy.sourceMaxMatches,null);
  assert.doesNotMatch(describeRelationEvidence({dataEvidence:legacy}),/源端.*重复/);
  const empty=await probe([]);assert.equal(empty.status,"empty");assert.equal(empty.sourceMultipleMatchCount,null);
  const failed=await sampleRelationEvidence({query:async()=>{throw new Error("unavailable");}},{},from,to,10);
  assert.equal(failed.status,"unavailable");assert.equal(failed.sourceMultipleMatchCount,null);
});

test("malformed or partial source counts cannot become usable multiplicity evidence",async()=>{
  for(const rows of [
    [{value:1,value1:7,matchCount:1,sourceCount:-1}],
    [{value:1,value1:7,matchCount:1,sourceCount:"invalid"}],
    [{value:1,value1:7,matchCount:1,sourceCount:2},{value:1,value1:8,matchCount:1}],
  ])assert.equal((await probe(rows)).reason,"invalid_probe_result");
});

test("source-side matching duplicates correct model cardinality without reversing the relation",()=>{
  const candidate={from:{},to:{},dataEvidence:{status:"sampled",sourceMultipleMatchCount:2,multipleMatchCount:0}};
  assert.equal(discovery.normalizeCardinality("1:N",candidate),"N:N");
  assert.equal(discovery.normalizeCardinality("1:1",candidate),"N:1");
  assert.equal(discovery.normalizeCardinality("N:1",candidate),"N:1");
  candidate.dataEvidence.multipleMatchCount=1;
  assert.equal(discovery.normalizeCardinality("1:1",candidate),"N:N");
});

test("complete uniqueness and legacy evidence retain their established cardinality meaning",()=>{
  assert.equal(discovery.normalizeCardinality("1:1",{from:{},to:{isUnique:true},dataEvidence:{status:"sampled",sourceMultipleMatchCount:2}}),"N:1");
  assert.equal(discovery.normalizeCardinality("N:N",{from:{isUnique:true},to:{isUnique:true}}),"1:1");
  assert.equal(discovery.normalizeCardinality("1:N",{from:{},to:{},dataEvidence:{status:"sampled",multipleMatchCount:5}}),"1:N");
  assert.equal(discovery.normalizeCardinality("1:N",{from:{},to:{},dataEvidence:{status:"unavailable",sourceMultipleMatchCount:3}}),"1:N");
});

test("a failed resample does not erase matching duplicate witnesses from the same analysis",()=>{
  const candidate={from:{},to:{},dataEvidence:{status:"unavailable",history:[{status:"sampled",sourceMultipleMatchCount:3,multipleMatchCount:0}]}};
  assert.equal(discovery.normalizeCardinality("1:N",candidate),"N:N");
  candidate.dataEvidence.history[0].multipleMatchCount=2;
  assert.equal(discovery.normalizeCardinality("N:1",candidate),"N:N");
});

test("model input labels source uniqueness and the two directions of multiplicity",()=>{
  const messages=model.messagesFor([{id:"test",from:{...from,columnName:"tenant_id",isUnique:true},to:{...to,columnName:"tenant_id"},columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"person_id",toCol:"person_id"}],dataEvidence:{status:"sampled",sourceMultipleMatchCount:2,multipleMatchCount:3}}]);
  const candidates=JSON.parse(messages.at(-1).content.split("候选元数据：")[1]);
  assert.equal(candidates[0].from.unique,true);
  assert.match(messages[0].content,/sourceMultipleMatchCount/);
  assert.match(messages[0].content,/multipleMatchCount/);
});
