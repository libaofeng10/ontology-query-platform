import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evalSetChecksum } from "../src/evaluation-evidence.mjs";
import { createOntologyCalibrationService } from "../src/ontology-calibration-service.mjs";
import { ontologyCatalogChecksum } from "../src/ontology-candidate-service.mjs";
import { createStore } from "../src/store.mjs";

test("review-mode labels calibrate the simulated 80-point auto-confirm gate",async()=>{
  const fixture=await createFixture(40);
  try {
    for(const candidate of fixture.candidates){confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");}
    const report=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(report.counts.labeledAuto,40);assert.equal(report.quality.precision,1);assert.equal(report.quality.physicalMappingErrors,0);
    assert.equal(report.draft.validationOk,true);assert.equal(report.draft.publishedCurrent,true);assert.deepEqual(report.evalSets,[{setName:"ontology-pilot",total:10,goldCount:10,heldOutCount:10,ready:true}]);assert.equal(report.evalGate.passed,true);assert.equal(report.evalGate.valid,true);assert.equal(report.runtime.p95LatencyMs,1200);
    assert.equal(report.passed,true);assert.equal(report.decision,"enable_auto_draft");
    const gate=fixture.service.createGate(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id},"editor-a");
    assert.equal(gate.passed,true);assert.equal(gate.runIds.length,1);
    const activated=fixture.service.activate(gate.id,"admin-a");
    assert.equal(activated.gate.activatedBy,"admin-a");assert.deepEqual(fixture.settingUpdates,[{input:{ontologyAi:{mode:"auto_draft"}},actor:"admin-a"}]);
  } finally { fixture.store.close(); }
});

test("calibration report exposes Gold readiness without leaking Held-out SQL",async()=>{
  const fixture=await createFixture(1,{minSamples:1,withEvalGate:false});
  try {
    fixture.store.addEvalCase({sourceId:fixture.source.id,setName:"partial-gold",question:"已有 Gold",goldSql:"SELECT customer_id FROM crm_customer",category:"客户",heldOut:1});
    fixture.store.addEvalCase({sourceId:fixture.source.id,setName:"partial-gold",question:"待补 Gold",goldSql:null,category:"客户",heldOut:0});
    const report=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id});
    assert.deepEqual(report.evalSets,[{setName:"partial-gold",total:2,goldCount:1,heldOutCount:1,ready:false}]);
    assert.equal(Object.hasOwn(report.evalSets[0],"goldSql"),false);
  } finally { fixture.store.close(); }
});

test("calibration remains in review when samples, precision, recall, draft or Gold evidence are missing",async()=>{
  const fixture=await createFixture(39,{withDraft:false,withEvalGate:false});
  try {
    for(const [index,candidate] of fixture.candidates.entries()){
      if(index===0){rejectCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"incorrect",majorModification:true,issueType:"physical_mapping"},"reviewer-b");}
      else {confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");}
    }
    const report=fixture.service.report(fixture.source.id,{manualObjectCount:3,finalObjectCount:10});
    assert.equal(report.counts.labeledAuto,39);assert.equal(report.quality.physicalMappingErrors,1);assert.equal(report.quality.manualObjectRate,.3);
    assert.equal(report.passed,false);assert.match(report.reason,/自动确认双检样本|物理映射错误|草稿 Schema 校验|Gold SQL/);
    const gate=fixture.service.createGate(fixture.source.id,{manualObjectCount:3,finalObjectCount:10},"editor-a");
    assert.equal(gate.decision,"keep_review");assert.throws(()=>fixture.service.activate(gate.id,"admin-a"),/尚未通过/);
  } finally { fixture.store.close(); }
});

test("candidate calibration labels are validated, append-only and latest-label wins",async()=>{
  const fixture=await createFixture(1,{minSamples:1});
  try {
    const candidate=fixture.candidates[0];confirmCandidate(fixture.store,candidate,"reviewer-primary");
    assert.throws(()=>fixture.service.label(candidate.id,{verdict:"unknown"},"editor"),/verdict/);
    assert.throws(()=>fixture.service.label(candidate.id,{verdict:"correct",issueType:"semantic"},"editor"),/准确候选/);
    fixture.service.label(candidate.id,{verdict:"incorrect",issueType:"semantic",note:"名称边界错误"},"editor-a");
    fixture.service.label(candidate.id,{verdict:"correct",note:"复核后确认"},"editor-b");
    const labels=fixture.store.listOntologyCandidateCalibrationLabels(fixture.source.id);
    assert.equal(labels.length,1);assert.equal(labels[0].verdict,"correct");assert.equal(labels[0].labeledBy,"editor-b");
    assert.equal(fixture.store.listOntologyCandidateEvents(candidate.id).filter((event)=>event.eventType==="calibration_labeled").length,2);
  } finally { fixture.store.close(); }
});

test("ordinary review decisions do not count as independent calibration double-check labels",async()=>{
  const fixture=await createFixture(1,{minSamples:1});
  try {
    const candidate=fixture.candidates[0];
    assert.throws(()=>fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b"),/先完成首轮审核/);
    assert.equal(fixture.store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"confirmed",reviewedBy:"reviewer-a",actor:"reviewer-a",eventType:"confirmed"}).ok,true);
    assert.throws(()=>fixture.service.label(candidate.id,{verdict:"correct"}," REVIEWER-A "),/不同于首轮审核人/);
    fixture.store.recordOntologyCandidateCalibration({candidateId:candidate.id,verdict:"correct",actor:"reviewer-a"});
    const before=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(before.counts.labels,0);assert.equal(before.counts.invalidLabels,1);assert.equal(before.counts.labeledAuto,0);assert.equal(before.conditions.find((item)=>item.id==="sample_size").passed,false);
    fixture.service.label(candidate.id,{verdict:"correct",note:"独立校准复核"},"reviewer-b");
    const after=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(after.counts.labels,1);assert.equal(after.counts.labeledAuto,1);assert.equal(after.conditions.find((item)=>item.id==="sample_size").passed,true);
  } finally { fixture.store.close(); }
});

test("catalog drift excludes stale runs and blocks new calibration labels",async()=>{
  const fixture=await createFixture(1,{minSamples:1});
  try {
    const candidate=fixture.candidates[0];confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:1,comment:"客户编号"});
    assert.throws(()=>fixture.service.label(candidate.id,{verdict:"incorrect",issueType:"sensitive_mapping"},"reviewer-c"),/物理目录已变化/);
    const explicit=fixture.service.report(fixture.source.id,{runIds:[fixture.run.id],draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(explicit.counts.staleRuns,1);assert.equal(explicit.counts.labels,0);assert.equal(explicit.counts.labeledAuto,0);
    assert.equal(explicit.conditions.find((item)=>item.id==="catalog_current").passed,false);assert.equal(explicit.passed,false);
    const automatic=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.deepEqual(automatic.runIds,[]);assert.equal(automatic.counts.staleRuns,0);assert.equal(automatic.counts.excludedStaleRuns,1);assert.equal(automatic.passed,false);
  } finally { fixture.store.close(); }
});

test("calibration report includes draft publication and downstream semantic metrics",async()=>{
  const fixture=await createFixture(1,{minSamples:1,withDraft:false,withEvalGate:false});
  try {
    const candidate=fixture.candidates[0];confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");
    const draft=fixture.store.createOntologyDraftWithCandidates({sourceId:fixture.source.id,runId:fixture.run.id,baseSchemaVersionId:null,expectedPublishedSchemaVersionId:null,schemaName:"crm",schema:{name:"crm",displayName:"CRM",objectTypes:[],linkTypes:[]},checksum:"applied",validation:{ok:true,errors:[],warnings:[],summary:{objectTypes:1,properties:1,linkTypes:0,errorCount:0,warningCount:0}},createdBy:"editor-a",candidateIds:[candidate.id]});
    fixture.store.publishOntologySchemaVersion(draft.id,"editor-a");
    const evalCases=seedEvalCases(fixture.store,fixture.source.id,"gold",10);
    const published=fixture.store.getOntologySchemaVersion(draft.id);const evalGate=fixture.store.saveEvalGate({id:"downstream-gate",sourceId:fixture.source.id,setName:"gold",total:10,ontologySchemaVersion:draft.version,ontologySchemaPublishedAt:published.publishedAt,evaluationChecksum:evalSetChecksum(evalCases),baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:.9,joinFailureRate:.1},passed:1,decision:"enable_prefer",reason:"passed"});
    const report=fixture.service.report(fixture.source.id,{draftSchemaVersionId:draft.id,evalGateId:evalGate.id});
    assert.equal(report.downstream.draftsCreated,1);assert.equal(report.downstream.draftsPublished,1);assert.equal(report.downstream.draftPublicationRate,1);assert.equal(report.downstream.schemaValidationPassRate,1);
    assert.equal(report.downstream.goldEquivalenceRate,1);assert.equal(report.downstream.semanticExecutionRate,.9);assert.equal(report.downstream.joinFailureRate,.1);
  } finally { fixture.store.close(); }
});

test("calibration invalidates a saved gate when the Gold set changes before activation",async()=>{
  const fixture=await createFixture(1,{minSamples:1});
  try {
    const candidate=fixture.candidates[0];confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");
    const snapshot=fixture.service.createGate(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id},"editor-a");assert.equal(snapshot.passed,true);
    const changed=fixture.evalCases[0];fixture.store.updateEvalCase(changed.id,{setName:changed.setName,question:`${changed.question}（口径已更新）`,goldSql:changed.goldSql,category:changed.category,heldOut:changed.heldOut});
    const report=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(report.evalGate.valid,false);assert.ok(report.evalGate.issues.some((item)=>item.code==="evaluation_set_stale"));assert.equal(report.conditions.find((item)=>item.id==="gold_sql").passed,false);assert.equal(report.passed,false);
    assert.throws(()=>fixture.service.activate(snapshot.id,"admin-a"),/门禁证据已变化/);
  } finally { fixture.store.close(); }
});

test("calibration requires the pilot Schema to be the current published version",async()=>{
  const fixture=await createFixture(1,{minSamples:1,publishDraft:false});
  try {
    const candidate=fixture.candidates[0];confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");
    const report=fixture.service.report(fixture.source.id,{draftSchemaVersionId:fixture.draft.id,evalGateId:fixture.evalGate.id});
    assert.equal(report.evalGate.valid,false);assert.ok(report.evalGate.issues.some((item)=>item.code==="not_post_publish"));assert.equal(report.draft.publishedCurrent,false);assert.equal(report.conditions.find((item)=>item.id==="draft_published").passed,false);assert.equal(report.passed,false);
  } finally { fixture.store.close(); }
});

test("calibration turns repeated issues into rule suggestions and adopts a source threshold with audit",async()=>{
  const fixture=await createFixture(10,{minSamples:1,scores:[80,80,90,90,90,90,90,90,90,90]});
  try{
    for(const [index,candidate] of fixture.candidates.entries()){if(index<2){rejectCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"incorrect",issueType:"sensitive_mapping"},"reviewer-b");}else{confirmCandidate(fixture.store,candidate,"reviewer-a");fixture.service.label(candidate.id,{verdict:"correct"},"reviewer-b");}}
    const report=fixture.service.report(fixture.source.id,{targetPrecision:.9});
    assert.deepEqual(report.ruleSuggestions,[],"historical sensitivity labels cannot reintroduce a review rule");assert.equal(report.thresholdSuggestion.suggestedScore,81);assert.equal(report.autoConfirmScoreSource,"global");
    const adopted=fixture.service.adoptThreshold(fixture.source.id,{runIds:[fixture.run.id],targetPrecision:.9,autoConfirmScore:81},"admin-a");assert.equal(adopted.autoConfirmScore,81);assert.equal(adopted.updatedBy,"admin-a");
    const refreshed=fixture.service.report(fixture.source.id,{runIds:[fixture.run.id]});assert.equal(refreshed.autoConfirmScore,81);assert.equal(refreshed.autoConfirmScoreSource,"source");assert.equal(refreshed.sourceSetting.audit[0].oldValue,null);assert.equal(refreshed.sourceSetting.audit[0].newValue,81);
  }finally{fixture.store.close();}
});

test("explicit calibration selection refuses mixed scoring versions",async()=>{
  const fixture=await createFixture(1,{minSamples:1});
  try{
    fixture.store.createOntologyGenerationRun({id:"calibration-run-v2",sourceId:fixture.source.id,mode:"selected_tables",scope:fixture.run.scope,catalogChecksum:fixture.run.catalogChecksum,promptVersion:fixture.run.promptVersion,scoringVersion:"ontology-candidate-v2",status:"succeeded",createdBy:"editor-a"});
    assert.throws(()=>fixture.service.report(fixture.source.id,{runIds:[fixture.run.id,"calibration-run-v2"]}),/v1\/v2 不可混算/);
  }finally{fixture.store.close();}
});

async function createFixture(candidateCount,{withDraft=true,withEvalGate=true,minSamples=40,publishDraft=true,scores=[]}={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-ontology-calibration-"));const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"calibration-test",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  store.markSourceTest(source.id,true);
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:100,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0,comment:"客户编号"});
  const tables=store.listTables(source.id);const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(source.id,table.tableName)]));
  const catalogChecksum=ontologyCatalogChecksum({sourceId:source.id,tables,columnsByTable,relations:store.listRelations(source.id,false,true)});
  const run=store.createOntologyGenerationRun({id:"calibration-run",sourceId:source.id,mode:"selected_tables",scope:{tableNames:["crm_customer"],namespace:"crm",modelingMode:"review",autoConfirmScore:80},catalogChecksum,modelName:"model-v1",promptVersion:"ontology-object-v1",scoringVersion:"ontology-candidate-score-v1",status:"succeeded",summary:{modelCalls:[{durationMs:1200}]},tokenUsage:{promptTokens:600,completionTokens:400,totalTokens:1000},createdBy:"editor-a"});
  const candidates=[];
  for(let index=0;index<candidateCount;index++)candidates.push(store.createOntologyCandidate({id:`candidate-${index}`,runId:run.id,sourceId:source.id,candidateType:"object",stableKey:`object:crm:crm_customer_${index}`,payload:{apiName:`customer_${index}`,displayName:`客户 ${index}`,primaryKey:"id",properties:[{apiName:"id",displayName:"编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}}]},score:scores[index]??90,scoreBreakdown:{physicalMapping:{score:35,max:35,reason:"ok"}},validation:{ok:true,errors:[],warnings:[]},status:"review_required",forcedReviewReasons:[],actor:"model",eventType:"auto_route"}));
  let draft=withDraft?store.createOntologySchemaVersion({sourceId:source.id,schemaName:"crm",schema:{name:"crm",displayName:"CRM",objectTypes:[],linkTypes:[]},checksum:"draft",validation:{ok:true,errors:[],warnings:[],summary:{objectTypes:candidateCount,properties:candidateCount,linkTypes:0,errorCount:0,warningCount:0}},createdBy:"editor-a"}):null;
  if(draft&&publishDraft){store.publishOntologySchemaVersion(draft.id,"editor-a");draft=store.getOntologySchemaVersion(draft.id);}
  const evalCases=withEvalGate&&draft?seedEvalCases(store,source.id,"ontology-pilot",10):[];
  const evalGate=withEvalGate&&draft?store.saveEvalGate({id:"gold-gate",sourceId:source.id,setName:"ontology-pilot",total:evalCases.length,ontologySchemaVersion:draft.version,ontologySchemaPublishedAt:draft.publishedAt,evaluationChecksum:evalSetChecksum(evalCases),baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0},passed:1,decision:"enable_prefer",reason:"equivalent"}):null;
  const settingUpdates=[];const settings={update:(input,actor)=>{settingUpdates.push({input,actor});return {ontologyAi:{mode:"auto_draft"}};}};
  const config={ontologyAi:{mode:"review",autoConfirmScore:80,calibrationMinSamples:minSamples,calibrationMinPrecision:.95,maxManualObjectRate:.2,maxFailureRate:.05,maxP95LatencyMs:90_000,maxAverageTokens:50_000}};
  const service=createOntologyCalibrationService({store,config,settings});
  return {store,source,run,candidates,draft,evalGate,evalCases,service,settingUpdates};
}

function seedEvalCases(store,sourceId,setName,count){const cases=[];for(let index=0;index<count;index++)cases.push(store.addEvalCase({sourceId,setName,question:`Gold 问题 ${index+1}`,goldSql:"SELECT customer_id FROM crm_customer",category:"客户",heldOut:1}));return cases;}

function confirmCandidate(store,candidate,actor){assert.equal(store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"confirmed",reviewedBy:actor,actor,eventType:"confirmed"}).ok,true);}
function rejectCandidate(store,candidate,actor){assert.equal(store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"rejected",reviewedBy:actor,actor,eventType:"rejected"}).ok,true);}
