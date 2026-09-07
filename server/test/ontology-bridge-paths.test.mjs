import assert from "node:assert/strict";
import test from "node:test";
import { buildLinkGenerationScope, normalizeLinkCandidateOutput } from "../src/ontology-candidate-generator.mjs";
import { createOntologyCandidateStableKey } from "../src/ontology-candidate-score.mjs";
import { assembleOntologyDraft } from "../src/ontology-draft-assembler.mjs";
import { compileSemanticQueryPlan } from "../src/semantic-query-plan.mjs";
import { guardSql } from "../src/sql-guard.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../src/store.mjs";
import { createOntologyCandidateService } from "../src/ontology-candidate-service.mjs";
import { createOntologyCandidateGenerator } from "../src/ontology-candidate-generator.mjs";
import { scoreOntologyCandidate } from "../src/ontology-candidate-score.mjs";

const endpoint=(name,table)=>({id:name,stableKey:`object:test:${table}`,candidateType:"object",status:"confirmed",payload:{apiName:name,displayName:name,primaryKey:"id",properties:[{apiName:"id",type:"integer",required:true,mapping:{table,column:"id"}}]}});
const endpoints=[endpoint("student","students"),endpoint("course","courses")];
const unique={name:"uq_enrollment",unique:true,members:[{column:"student_id",ordinal:1},{column:"course_id",ordinal:2}]};
const catalog={tables:["students","courses","enrollments"].map(tableName=>({tableName,active:1})),columnsByTable:{students:[{columnName:"id",isPrimary:1,dataType:"bigint",nullable:0}],courses:[{columnName:"id",isPrimary:1,dataType:"bigint",nullable:0}],enrollments:["student_id","course_id"].map(columnName=>({columnName,dataType:"bigint",nullable:0,keyConstraints:[unique]}))},relations:[{id:1,fromTable:"enrollments",fromCol:"student_id",toTable:"students",toCol:"id",cardinality:"N:1",status:"confirmed"},{id:2,fromTable:"enrollments",fromCol:"course_id",toTable:"courses",toCol:"id",cardinality:"N:1",status:"confirmed"}]};

test("bridge scope proposes a complete business path even without a bridge Object",()=>{
  const scope=buildLinkGenerationScope({catalog,endpoints,namespace:"test"});
  const path=scope.relations.find(item=>item.relationIds?.length===2);assert.ok(path);
  const output=normalizeLinkCandidateOutput({candidates:[{pathId:path.pathId,sourceStableKey:endpoints[0].stableKey,targetStableKey:endpoints[1].stableKey,apiName:"enrolled_in",inverseApiName:"has_students",description:"学生选修课程"}]},{run:{scope:{namespace:"test"}},scope});
  const candidate=output.candidates[0];assert.deepEqual(candidate.payload.relationMappings,[{relationId:1},{relationId:2}]);assert.equal(candidate.payload.cardinality,"many_to_many");
  const schema={name:"learning",objectTypes:endpoints.map(item=>item.payload),linkTypes:[candidate.payload]};
  const compiled=compileSemanticQueryPlan({rootObject:"student",dimensions:[{property:"student.id",alias:"student_id"},{property:"course.id",alias:"course_id"}]},{schema,catalog});
  assert.match(compiled.sql,/JOIN `enrollments`/);assert.match(compiled.sql,/JOIN `courses`/);assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
});

test("global completion persists and resumes a bridge path across separate object runs",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"bridge-completion-")),store=createStore(join(dir,"store.sqlite"));
  try{
    const source=store.createSource({name:"synthetic",kind:"mysql",host:"db",dbName:"school",userName:"ro",credential:"synthetic",port:3306,isDemo:false});
    for(const table of catalog.tables){store.upsertTable({...table,comment:table.tableName,sourceId:source.id,grade:"A"});for(const column of catalog.columnsByTable[table.tableName])store.upsertColumn({...column,comment:column.columnName,tableName:table.tableName,sourceId:source.id});}
    for(const relation of catalog.relations)store.upsertRelation({...relation,sourceId:source.id});
    let calls=0;
    const generator=createOntologyCandidateGenerator({callJson:async(_llm,messages)=>{
      calls++;const input=JSON.parse(messages[1].content.match(/<untrusted_input>(.*)<\/untrusted_input>/s)[1]);
      const candidates=input.endpoints?input.confirmedRelations.map(item=>({...item,apiName:"enrolled_in",inverseApiName:"has_students",displayName:"选修课程",description:"学生通过选课记录参与课程",sourceStableKey:item.fromEndpointStableKey,targetStableKey:item.toEndpointStableKey})):input.tables.map(table=>({tableName:table.tableName,apiName:table.tableName,displayName:table.tableName,description:"业务主体",properties:table.columns.map(column=>({column:column.columnName}))}));
      return {value:{candidates},rawContent:JSON.stringify({candidates}),usage:{}};
    }});
    const service=createOntologyCandidateService({store,generator,config:{ontologyAi:{mode:"auto_draft",autoConfirmScore:85},llm:{model:"synthetic"}},scorer:{score:async(candidate,options)=>scoreOntologyCandidate(candidate,{...options,semanticSimilarity:1})}});
    const runIds=[];
    for(const table of ["students","courses"]){const run=service.createRun({sourceId:source.id,tableNames:[table],domainName:table,orchestrationId:"build"},"test");await service.runGeneration({payload:{runId:run.id}});runIds.push(run.id);}
    const input={sourceId:source.id,orchestrationId:"build",runIds,tableNames:catalog.tables.map(table=>table.tableName)};
    await service.completeBuildLinks(input);
    const candidate=store.listOntologyCandidates({sourceId:source.id,candidateType:"link"})[0];
    assert.equal(candidate.status,"review_required","82 points still requires review at the unchanged 85 threshold");
    await service.decide(candidate.id,{decision:"confirm",expectedStatus:candidate.status},"test");
    const result=await service.completeBuildLinks(input);
    assert.equal(result.coverage.bridgePathCount,1);assert.equal(result.coverage.coveredBridgePathCount,1,JSON.stringify(store.listOntologyCandidates({sourceId:source.id})));
    assert.equal(result.coverage.coveredRelationCount,2);
    const count=calls;await service.completeBuildLinks(input);assert.equal(calls,count);
  }finally{store.close();await rm(dir,{recursive:true,force:true});}
});

test("whole path identity prevents bridge Links from colliding with a direct Link sharing the first edge",()=>{
  const context={catalog,acceptedObjects:[...endpoints,endpoint("enrollment","enrollments")]};
  const link={candidateType:"link",namespace:"test",sourceStableKey:endpoints[0].stableKey,targetStableKey:endpoints[1].stableKey,payload:{apiName:"enrolled_in",source:"student",target:"course",cardinality:"many_to_many",relationMappings:[{relationId:1},{relationId:2}]}};
  const changed={...link,payload:{...link.payload,relationMappings:[{relationId:1},{relationId:3}]}};
  assert.notEqual(createOntologyCandidateStableKey(link,context),createOntologyCandidateStableKey(changed,context));
  const baseSchema={name:"learning",objectTypes:context.acceptedObjects.map(item=>item.payload),linkTypes:[{apiName:"student_records",source:"student",target:"enrollment",cardinality:"one_to_many",relationMappings:[{relationId:1}]}]};
  const result=assembleOntologyDraft({run:{id:"run",sourceId:1},baseSchema,candidates:[{...link,id:"new",runId:"run",sourceId:1,status:"confirmed"}]});
  assert.equal(result.conflicts.length,0);assert.equal(result.schema.linkTypes.length,2);
});
