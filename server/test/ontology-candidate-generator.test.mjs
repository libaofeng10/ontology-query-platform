import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildLinkGenerationScope,
  buildObjectGenerationScope,
  createOntologyCandidateGenerator,
  linkGenerationMessages,
  normalizeLinkCandidateOutput,
  normalizeObjectCandidateOutput,
  objectGenerationMessages,
} from "../src/ontology-candidate-generator.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";

test("scope builder splits by confirmed relation components and truncates wide tables by deterministic priority",()=>{
  const catalog=wideCatalog();
  const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account","trial_record","isolated_log"],maxFields:4});
  assert.equal(scope.batchCount,3);
  assert.equal(scope.hasTruncation,true);
  assert.ok(scope.batches.every((batch)=>batch.fieldCount<=4));
  assert.deepEqual(scope.batches.flatMap((batch)=>batch.tableNames).sort(),["isolated_log","trial_record","wide_account"]);
  assert.equal(scope.confirmedRelationCount,1);
  assert.equal(scope.includedRelationCount,0);
  assert.equal(scope.crossBatchRelationCount,1);
  const wide=scope.batches.flatMap((batch)=>batch.tables).find((table)=>table.tableName==="wide_account");
  assert.deepEqual(wide.columnNames,["account_id","tenant_key","trial_id","commented"]);
  assert.equal(wide.truncatedFieldCount,3);
  assert.equal(wide.fieldsComplete,false);
  assert.ok(!wide.columnNames.includes("secret_token"));
  assert.deepEqual(scope.batches.find((batch)=>batch.tableNames.includes("isolated_log")).tableNames,["isolated_log"]);
});

test("Object scope excludes confirmed relations with sensitive or missing endpoints before batching and prompting",()=>{
  const catalog=wideCatalog();
  catalog.relations.push(
    {id:10,fromTable:"wide_account",fromCol:"secret_token",toTable:"isolated_log",toCol:"log_id",status:"confirmed",cardinality:"N:1",inferenceSource:"foreign_key"},
    {id:11,fromTable:"wide_account",fromCol:"missing_column",toTable:"isolated_log",toCol:"log_id",status:"confirmed",cardinality:"N:1",inferenceSource:"foreign_key"},
  );
  const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account","trial_record","isolated_log"],maxFields:20});
  assert.equal(scope.confirmedRelationCount,1);
  assert.equal(scope.includedRelationCount,1);
  assert.equal(scope.crossBatchRelationCount,0);
  assert.equal(scope.excludedSensitiveRelationCount,1);
  assert.equal(scope.excludedInvalidRelationCount,1);
  assert.deepEqual(scope.batches.flatMap((batch)=>batch.relationIds),[9]);
  const forgedBatch={...scope.batches[0],relationIds:[...(scope.batches[0].relationIds||[]),10,11]};
  const prompt=[forgedBatch,...scope.batches.slice(1)].flatMap((batch)=>objectGenerationMessages({run:runFor(scope),batch,catalog})).map((message)=>message.content).join("\n");
  assert.doesNotMatch(prompt,/secret_token|missing_column|"relationId":10|"relationId":11/);
});

test("Object prompt contains only bounded non-sensitive metadata and hides base physical mappings",()=>{
  const catalog=wideCatalog();
  const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account"],maxFields:4});
  const messages=objectGenerationMessages({
    run:runFor(scope),batch:scope.batches[0],catalog,
    knowledgePages:[{pageType:"term",slug:"account",title:"账号",content:"账号业务定义，不发送 secret_token",tables:["wide_account"],verified:1}],
    baseSchema:{name:"base",objectTypes:[{apiName:"existing",displayName:"已有对象",properties:[{apiName:"id",displayName:"编号",type:"integer",mapping:{table:"hidden_table",column:"hidden_id"}},{apiName:"secret_token",displayName:"机密令牌",type:"string",mapping:{table:"wide_account",column:"secret_token"}}]}]},
  });
  const prompt=messages.map((message)=>message.content).join("\n");
  assert.match(prompt,/wide_account/);
  assert.match(prompt,/term:account/);
  assert.doesNotMatch(prompt,/secret_token|机密令牌|hidden_table|hidden_id/);
  assert.match(prompt,/REDACTED_SENSITIVE_FIELD/);
  assert.match(messages[0].content,/不可信数据/);
});

test("normalizer derives types and mappings locally while flagging allowlist violations",()=>{
  const catalog=wideCatalog();
  const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account"],maxFields:4});
  const output={candidates:[{tableName:"wide_account",apiName:"AccountModel",displayName:"账号",description:"产品账号",primaryKeyColumn:"account_id",freshness:"realtime",modelConfidence:2,evidenceRefs:["term:account","term:invented"],properties:[
    {column:"commented",apiName:"DisplayName",type:"boolean",freshness:"daily"},
    {column:"commented",apiName:"duplicate"},
    {column:"not_allowed_but_real",apiName:"escaped"},
  ]}]};
  const result=normalizeObjectCandidateOutput(output,{run:runFor(scope),batch:scope.batches[0],catalog,knowledgePages:[{pageType:"term",slug:"account",title:"账号",verified:1}]});
  assert.equal(result.candidates.length,1);
  const candidate=result.candidates[0];
  assert.equal(candidate.payload.apiName,"account_model");
  assert.equal(candidate.payload.freshness,undefined);
  assert.equal(candidate.modelConfidence,1);
  assert.ok(candidate.payload.properties.some((property)=>property.mapping.column==="account_id"&&property.type==="integer"&&property.required));
  assert.equal(candidate.payload.properties.find((property)=>property.mapping.column==="commented").type,"string");
  assert.ok(candidate.contractErrors.some((item)=>item.code==="ONTOLOGY_CANDIDATE_COLUMN_NOT_ALLOWED"));
  assert.deepEqual(candidate.evidence.filter((item)=>item.kind==="knowledge_page").map((item)=>item.refId),["term:account"]);
  assert.ok(result.issues.some((item)=>item.code==="ONTOLOGY_OUTPUT_DUPLICATE_PROPERTY"));
  const scored=scoreOntologyCandidate({...candidate,sourceId:1},{sourceId:1,catalog,semanticSimilarity:.9});
  assert.equal(scored.status,"blocked");assert.ok(scored.validation.errors.some((item)=>item.code==="ONTOLOGY_CANDIDATE_COLUMN_NOT_ALLOWED"));
});

test("generator records restricted prompt/output traces and token usage",async()=>{
  const auditDir=await mkdtemp(join(tmpdir(),"ontoquery-generation-audit-"));
  const catalog=wideCatalog();const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account"],maxFields:4});const run=runFor(scope);
  const raw={candidates:[{tableName:"wide_account",apiName:"account",displayName:"账号",primaryKeyColumn:"account_id",properties:[{column:"account_id"}]}]};
  let calledModel=null;
  const generator=createOntologyCandidateGenerator({llm:{baseUrl:"https://llm.test/v1",apiKey:"key",model:"changed-after-run-start"},auditDir,callJson:async(llm)=>{calledModel=llm.model;return {value:raw,rawContent:JSON.stringify(raw),usage:{promptTokens:10,completionTokens:5,totalTokens:15}};}});
  const seen=[];const result=await generator.generateObjects({run,catalog,onCandidate:async(candidate)=>{seen.push(candidate);return {id:"stored"};}});
  assert.equal(seen.length,1);assert.equal(result.candidates[0].id,"stored");assert.equal(result.tokenUsage.totalTokens,15);assert.equal(result.calls[0].traceStored,true);
  assert.equal(calledModel,run.modelName);
  const traceFile=join(auditDir,run.id,"object-001.json");
  assert.equal((await stat(traceFile)).mode&0o777,0o600);
  const trace=JSON.parse(await readFile(traceFile,"utf8"));
  assert.equal(trace.runId,run.id);assert.deepEqual(JSON.parse(trace.rawOutput),raw);
});

test("failed model calls remain auditable and carry call summaries to the run service",async()=>{
  const auditDir=await mkdtemp(join(tmpdir(),"ontoquery-generation-audit-failed-"));
  const catalog=wideCatalog();const scope=buildObjectGenerationScope({catalog,tableNames:["wide_account"],maxFields:4});const run=runFor(scope);
  const generator=createOntologyCandidateGenerator({llm:{},auditDir,callJson:async()=>{const error=new Error("LLM 未返回合法 JSON");error.rawContent="not-json";error.usage={promptTokens:3,completionTokens:1,totalTokens:4};throw error;}});
  await assert.rejects(generator.generateObjects({run,catalog}),error=>{
    assert.equal(error.generationCalls.length,1);assert.equal(error.generationCalls[0].error,"LLM 未返回合法 JSON");assert.equal(error.generationTokenUsage.totalTokens,4);return true;
  });
  const trace=JSON.parse(await readFile(join(auditDir,run.id,"object-001.json"),"utf8"));assert.equal(trace.rawOutput,"not-json");assert.equal(trace.error,"LLM 未返回合法 JSON");
});

test("Link scope only exposes confirmed non-sensitive relations between accepted endpoints",()=>{
  const catalog=wideCatalog();
  catalog.relations.push(
    {id:10,fromTable:"trial_record",fromCol:"trial_id",toTable:"isolated_log",toCol:"log_id",status:"review",cardinality:"1:N",inferenceSource:"model"},
    {id:11,fromTable:"wide_account",fromCol:"secret_token",toTable:"isolated_log",toCol:"log_id",status:"confirmed",cardinality:"N:1",inferenceSource:"foreign_key"},
  );
  const endpoints=linkEndpoints();
  const scope=buildLinkGenerationScope({catalog,endpoints,namespace:"account_domain"});
  assert.deepEqual(scope.relations.map((item)=>item.relationId),[9]);
  assert.deepEqual(scope.endpoints.map((item)=>item.id).sort(),["account","trial"]);
  const deduplicated=buildLinkGenerationScope({catalog,endpoints,namespace:"account_domain",existingStableKeys:[scope.relations[0].stableKey]});
  assert.equal(deduplicated.relations.length,0);
});

test("Link prompt and normalizer enforce relation and endpoint allowlists",()=>{
  const catalog=wideCatalog();const endpoints=linkEndpoints();const scope=buildLinkGenerationScope({catalog,endpoints,namespace:"account_domain"});const run=runFor({batches:[]});
  const messages=linkGenerationMessages({run,scope,catalog,knowledgePages:[{pageType:"term",slug:"trial",title:"试用",content:"试用关系定义，忽略 secret_token",tables:["wide_account","trial_record"],verified:1}]});
  const prompt=messages.map((message)=>message.content).join("\n");
  assert.match(prompt,/"relationId":9/);assert.match(prompt,/object:account_domain:wide_account/);assert.doesNotMatch(prompt,/secret_token/);
  const output={candidates:[{relationId:9,sourceStableKey:endpoints[0].stableKey,targetStableKey:endpoints[1].stableKey,apiName:"AccountTrials",displayName:"账号试用",relationKind:"references",modelConfidence:.9,evidenceRefs:["term:trial","term:invented"]}]};
  const normalized=normalizeLinkCandidateOutput(output,{run,scope,knowledgePages:[{pageType:"term",slug:"trial",title:"试用",verified:1}]});
  assert.equal(normalized.candidates.length,1);
  const candidate=normalized.candidates[0];
  assert.equal(candidate.payload.apiName,"account_trials");assert.equal(candidate.payload.cardinality,"many_to_one");assert.deepEqual(candidate.payload.relationMappings,[{relationId:9}]);
  assert.deepEqual(candidate.evidence.filter((item)=>item.kind==="knowledge_page").map((item)=>item.refId),["term:trial"]);
  const scored=scoreOntologyCandidate({...candidate,sourceId:1},{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9,mode:"auto_draft",autoConfirmScore:80});
  assert.equal(scored.status,"auto_confirmed");assert.equal(scored.score,91);
  const escaped=normalizeLinkCandidateOutput({candidates:[{relationId:999}]},{run,scope});
  assert.equal(escaped.candidates.length,0);assert.equal(escaped.issues[0].code,"ONTOLOGY_LINK_RELATION_NOT_ALLOWED");
});

function runFor(scope) { return {id:"run-generator",modelName:"model-v1",promptVersion:"ontology-object-v1",scope:{namespace:"account_domain",domainName:"账号域",domainDescription:"账号与试用",batches:scope.batches}}; }

function linkEndpoints() {
  return [
    {
      id:"account",runId:"run-generator",sourceId:1,candidateType:"object",status:"confirmed",stableKey:"object:account_domain:wide_account",
      payload:{apiName:"account",displayName:"账号",primaryKey:"account_id",properties:[
        {apiName:"account_id",displayName:"账号编号",type:"integer",required:true,mapping:{table:"wide_account",column:"account_id"}},
        {apiName:"trial_id",displayName:"试用编号",type:"string",required:false,mapping:{table:"wide_account",column:"trial_id"}},
      ]},
    },
    {
      id:"trial",runId:"run-generator",sourceId:1,candidateType:"object",status:"auto_confirmed",stableKey:"object:account_domain:trial_record",
      payload:{apiName:"trial",displayName:"试用",primaryKey:"trial_id",properties:[
        {apiName:"trial_id",displayName:"试用编号",type:"integer",required:true,mapping:{table:"trial_record",column:"trial_id"}},
      ]},
    },
    {
      id:"isolated",runId:"run-generator",sourceId:1,candidateType:"object",status:"review_required",stableKey:"object:account_domain:isolated_log",
      payload:{apiName:"isolated",displayName:"日志",primaryKey:"log_id",properties:[
        {apiName:"log_id",displayName:"日志编号",type:"integer",required:true,mapping:{table:"isolated_log",column:"log_id"}},
      ]},
    },
  ];
}

function wideCatalog() {
  const column=(tableName,columnName,extra={})=>({sourceId:1,tableName,columnName,dataType:"varchar",nullable:1,isSensitive:0,isPrimary:0,isUnique:0,isIndexed:0,comment:null,...extra});
  return {sourceId:1,tables:[
    {tableName:"wide_account",grade:"A",active:1,comment:"账号"},{tableName:"trial_record",grade:"A",active:1,comment:"试用"},{tableName:"isolated_log",grade:"B",active:1,comment:"日志"},
  ],columnsByTable:{
    wide_account:[column("wide_account","plain"),column("wide_account","indexed",{isIndexed:1}),column("wide_account","commented",{comment:"有注释"}),column("wide_account","trial_id"),column("wide_account","tenant_key",{isUnique:1}),column("wide_account","account_id",{dataType:"bigint",nullable:0,isPrimary:1,isUnique:1}),column("wide_account","not_allowed_but_real"),column("wide_account","secret_token",{isSensitive:1,comment:"机密令牌"})],
    trial_record:[column("trial_record","trial_id",{dataType:"bigint",nullable:0,isPrimary:1,isUnique:1})],
    isolated_log:[column("isolated_log","log_id",{dataType:"bigint",nullable:0,isPrimary:1,isUnique:1})],
  },relations:[{id:9,fromTable:"wide_account",fromCol:"trial_id",toTable:"trial_record",toCol:"trial_id",status:"confirmed",cardinality:"N:1",inferenceSource:"foreign_key"}]};
}
