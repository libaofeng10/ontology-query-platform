import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";
import { createOntologyCandidateService } from "../src/ontology-candidate-service.mjs";
import { createOntologyCandidateGenerator } from "../src/ontology-candidate-generator.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";

async function fixture({omit=0}={}) {
  const dir=await mkdtemp(join(tmpdir(),"global-links-")),store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"test",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  for(const tableName of ["orders","customers"]) {
    store.upsertTable({sourceId:source.id,tableName,rowEstimate:100,grade:"A",active:1,comment:tableName});
    for(const columnName of ["id","parent_id"])store.upsertColumn({sourceId:source.id,tableName,columnName,dataType:"bigint",nullable:0,isPrimary:columnName==="id"?1:0,isUnique:columnName==="id"?1:0,comment:columnName});
  }
  const relation=store.upsertRelation({sourceId:source.id,fromTable:"orders",fromCol:"parent_id",toTable:"customers",toCol:"id",cardinality:"N:1",status:"confirmed",inferenceSource:"foreign_key"});
  const self=store.upsertRelation({sourceId:source.id,fromTable:"customers",fromCol:"parent_id",toTable:"customers",toCol:"id",cardinality:"N:1",status:"confirmed",inferenceSource:"foreign_key"});
  let calls=0;
  const realGenerator=createOntologyCandidateGenerator({callJson:async(_llm,messages)=>{
    calls++;
    const input=JSON.parse(messages[1].content.match(/<untrusted_input>(.*)<\/untrusted_input>/s)[1]);
    const candidates=calls<=omit?[]:input.confirmedRelations.map(r=>({relationId:r.relationId,sourceStableKey:r.fromEndpointStableKey,targetStableKey:r.toEndpointStableKey,apiName:`relation_${r.relationId}`,displayName:"所属关系",description:"从记录关联到其所属主体",inverseApiName:`inverse_${r.relationId}`,inverseDisplayName:"所属记录",relationKind:"references",sourceLabel:"所属",targetLabel:"包含",modelConfidence:.99}));
    return {value:{candidates},rawContent:JSON.stringify({candidates}),usage:{}};
  }});
  const generator={...realGenerator,generateObjects:async({run,onCandidate})=>{
    for(const table of run.scope.tableNames)await onCandidate({candidateType:"object",mainTable:table,modelConfidence:.99,payload:{apiName:table,displayName:table,description:table,primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table,column:"id"}}]},evidence:[]});
    return {candidates:[],calls:[],normalizationIssues:[],tokenUsage:{}};
  }};
  const config={ontologyAi:{mode:"auto_draft",autoConfirmScore:85,maxTables:20,maxFields:600},llm:{model:"mock"},embedding:{}};
  const service=createOntologyCandidateService({store,config,generator,scorer:{score:async(c,o)=>scoreOntologyCandidate(c,{...o,semanticSimilarity:1})}});
  const runs=[];
  for(const table of ["orders","customers"]) {
    const run=service.createRun({sourceId:source.id,tableNames:[table],orchestrationId:"build-1",domainPlanId:table,domainName:table},"test");
    await service.runGeneration({payload:{runId:run.id}});runs.push(run.id);
  }
  return {store,service,source,runs,relation,self,get calls(){return calls;},close:async()=>{store.close();await rm(dir,{recursive:true,force:true});}};
}

test("跨批次补边合并已确认端点，自引用被评分接受且续跑不重复调用",async()=>{
  const f=await fixture();try{
    const input={sourceId:f.source.id,orchestrationId:"build-1",runIds:f.runs,tableNames:["orders","customers"]};
    const result=await f.service.completeBuildLinks(input);
    assert.equal(result.coverage.confirmedRelationCount,2);assert.equal(result.coverage.coveredRelationCount,2);assert.deepEqual(result.coverage.missingRelationIds,[]);
    const links=f.store.listOntologyCandidates({sourceId:f.source.id,candidateType:"link"});
    assert.equal(links.length,2);assert.ok(links.every(c=>c.status==="auto_confirmed"),JSON.stringify(links));
    assert.ok(links.some(c=>c.payload.source===c.payload.target));
    const calls=f.calls;await f.service.completeBuildLinks(input);assert.equal(f.calls,calls);
  }finally{await f.close();}
});

test("模型漏掉 Link 会按关系覆盖触发有界补问，耗尽后保留明确缺口",async()=>{
  const f=await fixture({omit:100});try{
    const input={sourceId:f.source.id,orchestrationId:"build-1",runIds:f.runs,tableNames:["orders","customers"]};
    const result=await f.service.completeBuildLinks(input);
    assert.deepEqual(result.coverage.missingRelationIds,[f.relation.id,f.self.id]);
    assert.ok(f.calls<=7,`unbounded calls: ${f.calls}`);
    const calls=f.calls;await f.service.completeBuildLinks(input);assert.equal(f.calls,calls,"无新说明的续跑不能重置补问预算");
  }finally{await f.close();}
});
