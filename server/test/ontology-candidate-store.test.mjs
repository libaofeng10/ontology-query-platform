import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStore } from "../src/store.mjs";

test("generation runs and candidate audit events persist structured JSON",async()=>{
  const fixture=await createFixture();
  try {
    const run=fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-1"));
    assert.deepEqual(run.scope.tableNames,["crm_customer"]);
    assert.equal(run.status,"queued");
    const candidate=fixture.store.createOntologyCandidate(candidateInput(fixture.source.id,run.id,"candidate-1"));
    assert.equal(candidate.status,"review_required");
    assert.equal(candidate.scoreBreakdown.physicalMapping.score,35);
    assert.equal(fixture.store.listOntologyCandidateEvents(candidate.id)[0].eventType,"auto_route");

    const confirmed=fixture.store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"confirmed",reviewedBy:"editor-a",actor:"editor-a",eventType:"confirmed",note:"业务确认"});
    assert.equal(confirmed.ok,true);
    assert.equal(confirmed.candidate.status,"confirmed");
    assert.ok(confirmed.candidate.reviewedAt);
    const duplicate=fixture.store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"review_required",status:"rejected",actor:"editor-b"});
    assert.equal(duplicate.ok,false);
    assert.equal(duplicate.reason,"status_conflict");
    assert.equal(duplicate.candidate.status,"confirmed");
    const events=fixture.store.listOntologyCandidateEvents(candidate.id);
    assert.deepEqual(events.map((event)=>event.eventType),["auto_route","confirmed"]);
    assert.equal(events[1].before.status,"review_required");
    assert.equal(events[1].after.status,"confirmed");
  } finally { fixture.store.close(); }
});

test("run and stable-key uniqueness constraints prevent concurrent overwrite",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-1"));
    assert.throws(()=>fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-2")),/UNIQUE constraint failed/);
    fixture.store.createOntologyCandidate(candidateInput(fixture.source.id,"run-1","candidate-1"));
    assert.throws(()=>fixture.store.createOntologyCandidate(candidateInput(fixture.source.id,"run-1","candidate-2")),/UNIQUE constraint failed/);
    const finished=fixture.store.transitionOntologyGenerationRun({id:"run-1",expectedStatus:"queued",status:"succeeded",progress:100,summary:{candidateCount:1}});
    assert.equal(finished.ok,true);
    assert.equal(finished.run.summary.candidateCount,1);
    assert.equal(fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-2")).id,"run-2");
  } finally { fixture.store.close(); }
});

test("candidate state machine refuses terminal-state mutations",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-1"));
    const candidate=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-1","candidate-1"),status:"blocked"});
    assert.throws(()=>fixture.store.transitionOntologyCandidate({id:candidate.id,expectedStatus:"blocked",status:"confirmed"}),/不允许候选从 blocked 转为 confirmed/);
    assert.equal(fixture.store.listOntologyCandidateEvents(candidate.id).length,1);
  } finally { fixture.store.close(); }
});

test("draft creation applies candidates and cross-run replacement atomically",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.createOntologyGenerationRun({...runInput(fixture.source.id,"run-old"),status:"succeeded"});
    const older=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-old","candidate-old"),status:"confirmed"});
    fixture.store.createOntologyGenerationRun({...runInput(fixture.source.id,"run-new"),status:"succeeded"});
    const selected=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-new","candidate-new"),status:"confirmed"});
    const conflicting=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-new","candidate-not-ready"),stableKey:"object:default:crm_other",status:"review_required"});
    const draftInput={sourceId:fixture.source.id,runId:"run-new",baseSchemaVersionId:null,expectedPublishedSchemaVersionId:null,schemaName:"crm",schema:{name:"crm",displayName:"CRM",objectTypes:[],linkTypes:[]},checksum:"checksum",validation:{ok:false,errors:[],warnings:[]},createdBy:"editor-a"};
    assert.throws(()=>fixture.store.createOntologyDraftWithCandidates({...draftInput,candidateIds:[selected.id,conflicting.id]}),/候选状态已变化/);
    assert.equal(fixture.store.listOntologySchemaVersions(fixture.source.id).length,0);
    assert.equal(fixture.store.getOntologyCandidate(selected.id).status,"confirmed");

    const draft=fixture.store.createOntologyDraftWithCandidates({...draftInput,candidateIds:[selected.id]});
    assert.equal(draft.status,"draft");assert.equal(fixture.store.getOntologyCandidate(selected.id).appliedSchemaVersionId,draft.id);
    assert.equal(fixture.store.getOntologyCandidate(older.id).status,"superseded");assert.equal(fixture.store.getOntologyCandidate(older.id).supersededById,selected.id);
    assert.equal(fixture.store.getOntologyCandidate(conflicting.id).status,"review_required");
    assert.deepEqual(fixture.store.listOntologyCandidateEvents(selected.id).map((event)=>event.eventType),["auto_route","applied"]);
    assert.deepEqual(fixture.store.listOntologyCandidateEvents(older.id).map((event)=>event.eventType),["auto_route","cross_run_superseded"]);
  } finally { fixture.store.close(); }
});

test("manual candidate merge preserves evidence and records both audit sides",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.createOntologyGenerationRun(runInput(fixture.source.id,"run-merge"));
    const retained=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-merge","candidate-retained"),stableKey:"object:default:crm_customer",status:"confirmed",evidence:[{kind:"physical_table",refId:"table:crm_customer",verified:true}]});
    const duplicate=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-merge","candidate-duplicate"),stableKey:"object:default:crm_customer_copy",status:"review_required",evidence:[{kind:"knowledge_page",refId:"term:customer",verified:true}]});
    const result=fixture.store.mergeOntologyCandidates({id:duplicate.id,intoCandidateId:retained.id,actor:"editor-a",note:"同一业务对象"});
    assert.equal(result.candidate.status,"superseded");assert.equal(result.candidate.supersededById,retained.id);assert.equal(result.retainedCandidate.status,"confirmed");assert.equal(result.retainedCandidate.evidence.length,2);
    assert.deepEqual(fixture.store.listOntologyCandidateEvents(duplicate.id).map((event)=>event.eventType),["auto_route","merged"]);
    assert.deepEqual(fixture.store.listOntologyCandidateEvents(retained.id).map((event)=>event.eventType),["auto_route","merge_evidence"]);
  } finally { fixture.store.close(); }
});

test("calibration labels and gate snapshots retain append-only audit evidence",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.createOntologyGenerationRun({...runInput(fixture.source.id,"run-calibration"),status:"succeeded"});
    const candidate=fixture.store.createOntologyCandidate({...candidateInput(fixture.source.id,"run-calibration","candidate-calibration"),status:"auto_confirmed",score:90});
    fixture.store.recordOntologyCandidateCalibration({candidateId:candidate.id,verdict:"incorrect",majorModification:true,issueType:"semantic",note:"需重构",actor:"reviewer-a"});
    fixture.store.recordOntologyCandidateCalibration({candidateId:candidate.id,verdict:"correct",majorModification:false,issueType:null,note:"二次复核",actor:"reviewer-b"});
    const labels=fixture.store.listOntologyCandidateCalibrationLabels(fixture.source.id);assert.equal(labels.length,1);assert.equal(labels[0].verdict,"correct");
    const gate=fixture.store.saveOntologyCalibrationGate({id:"calibration-gate",sourceId:fixture.source.id,runIds:["run-calibration"],manualObjectCount:0,finalObjectCount:1,metrics:{precision:1},passed:true,decision:"enable_auto_draft",reason:"passed",createdBy:"editor-a"});
    assert.equal(gate.passed,true);assert.deepEqual(gate.runIds,["run-calibration"]);assert.equal(gate.metrics.precision,1);
    const activated=fixture.store.activateOntologyCalibrationGate(gate.id,"admin-a");assert.equal(activated.activatedBy,"admin-a");assert.throws(()=>fixture.store.activateOntologyCalibrationGate(gate.id,"admin-b"),/已经启用/);
  } finally { fixture.store.close(); }
});

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-ontology-candidate-store-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"candidate-test",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  return {store,source};
}

function runInput(sourceId,id) {
  return {id,sourceId,mode:"selected_tables",scope:{tableNames:["crm_customer"],namespace:"default"},catalogChecksum:"catalog-v1",modelName:"model-v1",promptVersion:"ontology-object-v1",scoringVersion:"score-v1",createdBy:"editor-a"};
}

function candidateInput(sourceId,runId,id) {
  return {id,runId,sourceId,candidateType:"object",stableKey:"object:default:crm_customer",payload:{apiName:"customer"},evidence:[{kind:"knowledge",refId:"term:customer",verified:true}],score:79,scoreBreakdown:{physicalMapping:{score:35}},validation:{ok:true,errors:[],warnings:[]},status:"review_required",forcedReviewReasons:[],actor:"system",eventType:"auto_route"};
}
