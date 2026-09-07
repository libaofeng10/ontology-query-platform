import assert from "node:assert/strict";
import test from "node:test";
import { evaluateRelationDiscovery } from "../src/relation-evaluation.mjs";

const relation=(fromCol="customer_id",toTable="customer")=>({fromTable:"orders",toTable,columnPairs:[{fromCol,toCol:"id"}]});
const truth={version:"relation-truth-v1",name:"synthetic",complete:true,tables:["orders","customer","unrelated"],relations:[{...relation(),label:"relation",cardinality:"N:1"},{...relation("unrelated_id","unrelated"),label:"none"}]};
test("evaluation separates candidate recall, judgement, direction and cardinality and does not invent performance",()=>{
  const report=evaluateRelationDiscovery({truth,candidates:[relation()],predictions:[{...relation(),decision:"relation",confidence:.9,cardinality:"N:1"},{...relation("unrelated_id","unrelated"),decision:"relation",confidence:.6,cardinality:"N:1"}],diagnostics:{elapsedMs:25}});
  assert.equal(report.candidateRecall,1);assert.equal(report.precision,.5);assert.equal(report.recall,1);assert.equal(report.directionAccuracy,1);assert.equal(report.cardinalityAccuracy,1);
  assert.equal(report.tokenCostUsd,null);assert.equal(report.elapsedMs,25);
  const stricter=evaluateRelationDiscovery({truth,predictions:[{...relation(),decision:"relation",confidence:.9,cardinality:"N:1"},{...relation("unrelated_id","unrelated"),decision:"relation",confidence:.6,cardinality:"N:1"}],threshold:.85});assert.equal(stricter.precision,1);
});

test("partial truth does not turn unlabelled predictions into false positives or claim full recall",()=>{
  const report=evaluateRelationDiscovery({truth:{...truth,complete:false,relations:truth.relations.slice(0,1)},predictions:[{...relation(),decision:"relation",confidence:1},{...relation("unrelated_id","unrelated"),decision:"relation",confidence:1}]});
  assert.equal(report.unlabelledPredictionCount,1);assert.equal(report.precision,null);assert.equal(report.recall,null);assert.equal(report.labelledPrecision,1);assert.equal(report.falsePositiveCount,0);
});

test("tuple equality, inverse direction and duplicate predictions are evaluated atomically",()=>{
  const compound={...relation(),columnPairs:[{fromCol:"tenant",toCol:"tenant"},...relation().columnPairs]};
  const annotated={...truth,relations:[{...compound,label:"relation",cardinality:"N:1"}]};
  const reverse={fromTable:"customer",toTable:"orders",columnPairs:compound.columnPairs.map(pair=>({fromCol:pair.toCol,toCol:pair.fromCol})),decision:"relation",confidence:1,cardinality:"1:N"};
  const report=evaluateRelationDiscovery({truth:annotated,predictions:[reverse,reverse]});assert.equal(report.truePositiveCount,1);assert.equal(report.directionAccuracy,0);assert.equal(report.cardinalityAccuracy,1);
  assert.equal(evaluateRelationDiscovery({truth:annotated,predictions:[{...relation(),decision:"relation",confidence:1}]}).recall,0);
});
