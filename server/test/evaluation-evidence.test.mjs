import assert from "node:assert/strict";
import test from "node:test";
import { evalSetChecksum, inspectSemanticEvalGate } from "../src/evaluation-evidence.mjs";

test("semantic Gold evidence must be current, schema-bound, and produced by off-vs-prefer execution",()=>{
  const cases=[{id:1,question:"客户数",goldSql:"SELECT COUNT(*) FROM customer",category:"客户",heldOut:1}];
  const gate={id:"semantic-gate",sourceId:2,setName:"gold",total:1,ontologySchemaVersion:3,evaluationChecksum:evalSetChecksum(cases),baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0},passed:1,decision:"enable_prefer"};
  const valid=inspectSemanticEvalGate(gate,{sourceId:2,schemaVersion:3,cases});assert.equal(valid.valid,true);assert.deepEqual(valid.issues,[]);
  const prePublish=inspectSemanticEvalGate(gate,{sourceId:2,schemaVersion:3,schemaPublishedAt:"2026-08-14T00:00:00.000Z",requirePostPublish:true,cases});assert.equal(prePublish.valid,false);assert.ok(prePublish.issues.some((item)=>item.code==="not_post_publish"));
  const postPublish=inspectSemanticEvalGate({...gate,ontologySchemaPublishedAt:"2026-08-14T00:00:00.000Z"},{sourceId:2,schemaVersion:3,schemaPublishedAt:"2026-08-14T00:00:00.000Z",requirePostPublish:true,cases});assert.equal(postPublish.valid,true);
  const stale=inspectSemanticEvalGate(gate,{sourceId:2,schemaVersion:3,cases:[{...cases[0],question:"活跃客户数"}]});assert.equal(stale.valid,false);assert.ok(stale.issues.some((item)=>item.code==="evaluation_set_stale"));
  const agent=inspectSemanticEvalGate({...gate,baseline:{requestedMode:"single",passRate:1},candidate:{gateKind:"agent",requestedMode:"agent_required",passRate:1,semanticExecutionRate:1}},{sourceId:2,schemaVersion:3,cases});assert.equal(agent.valid,false);assert.ok(agent.issues.some((item)=>item.code==="wrong_gate_kind"));
  const wrongSchema=inspectSemanticEvalGate(gate,{sourceId:2,schemaVersion:4,cases});assert.equal(wrongSchema.valid,false);assert.ok(wrongSchema.issues.some((item)=>item.code==="schema_mismatch"));
});
