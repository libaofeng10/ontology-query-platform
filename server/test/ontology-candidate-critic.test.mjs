import assert from "node:assert/strict";
import test from "node:test";
import { createOntologyCandidateCritic, messagesFor } from "../src/ontology-candidate-critic.mjs";

test("critic batches candidates and normalizes only known ids",async()=>{
  let calls=0;const critic=createOntologyCandidateCritic({llm:{baseUrl:"http://llm.test/v1",apiKey:"key",model:"critic"},callJson:async(_llm,messages)=>{calls++;const body=JSON.parse(messages.at(-1).content.match(/<untrusted_input>(.*)<\/untrusted_input>/)[1]);return {results:body.map((item,index)=>({candidateId:item.candidateId,consistent:index!==0,issue:index===0?"日志表不是业务对象":null})).concat({candidateId:"invented",consistent:false})};}});
  const candidates=Array.from({length:11},(_,index)=>({criticId:`c-${index}`,candidateType:"object",payload:{displayName:`候选 ${index}`,description:"业务定义",properties:[]}}));
  const result=await critic.inspect(candidates,{catalog:{tables:[],columnsByTable:{}}});
  assert.equal(calls,2);assert.equal(result.results.size,11);assert.equal(result.results.get("c-0").consistent,false);assert.equal(result.results.has("invented"),false);
});

test("critic failures degrade to skipped review evidence",async()=>{
  const critic=createOntologyCandidateCritic({llm:{baseUrl:"http://llm.test/v1",apiKey:"key",model:"critic"},callJson:async()=>{throw new Error("critic unavailable");}});
  const result=await critic.inspect([{criticId:"c-1",candidateType:"object",payload:{properties:[]}}],{catalog:{}});assert.equal(result.skipped,true);assert.match(result.error,/unavailable/);
  assert.match(messagesFor([])[0].content,/不可信输入/);
});

test("link critic input includes endpoint mappings and the bound physical relation",async()=>{
  let input;const critic=createOntologyCandidateCritic({llm:{baseUrl:"http://llm.test/v1",apiKey:"key",model:"critic"},callJson:async(_llm,messages)=>{input=JSON.parse(messages.at(-1).content.match(/<untrusted_input>(.*)<\/untrusted_input>/)[1]);return {results:[{candidateId:"link-1",consistent:true}]};}});
  const acceptedObjects=[
    {stableKey:"object:customer",payload:{apiName:"customer",properties:[{mapping:{table:"customers",column:"id"}}]}},
    {stableKey:"object:order",payload:{apiName:"order",properties:[{mapping:{table:"orders",column:"customer_id"}}]}},
  ];
  await critic.inspect([{criticId:"link-1",candidateType:"link",sourceStableKey:"object:customer",targetStableKey:"object:order",payload:{source:"customer",target:"order",relationMappings:[{relationId:7}]}}],{acceptedObjects,catalog:{tables:[{tableName:"customers"},{tableName:"orders"}],columnsByTable:{customers:[{columnName:"id",isSensitive:false}],orders:[{columnName:"customer_id",isSensitive:false}]},relations:[{id:7,fromTable:"orders",fromCol:"customer_id",toTable:"customers",toCol:"id",status:"confirmed",inferenceSource:"foreign_key"}]}});
  assert.deepEqual(input[0].physical.map((item)=>item.tableName),["customers","orders"]);assert.equal(input[0].relations[0].id,7);
});
