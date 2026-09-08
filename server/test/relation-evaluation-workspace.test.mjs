import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,rm,stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openRelationEvaluationWorkspace } from "../src/relation-evaluation-workspace.mjs";
import { buildRelationReview } from "../src/relation-evaluation.mjs";

test("evaluation workspace has exclusive lifetime locking, durable counters and scope checks",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"eval-workspace-test-"));let active;
  try{
    active=openRelationEvaluationWorkspace({directory,fingerprint:"scope-a"});active.save({queryCount:7});
    assert.throws(()=>openRelationEvaluationWorkspace({directory,resume:true,fingerprint:"scope-a"}),/正在运行/);
    active.close();active=null;
    assert.throws(()=>openRelationEvaluationWorkspace({directory,fingerprint:"scope-a"}),/已有记录/);
    assert.throws(()=>openRelationEvaluationWorkspace({directory,resume:true,fingerprint:"scope-b"}),/已变化/);
    active=openRelationEvaluationWorkspace({directory,resume:true,fingerprint:"scope-a"});assert.equal(active.meta.queryCount,7);
    assert.equal((await stat(directory)).mode&0o777,0o700);assert.equal((await stat(join(directory,"store.sqlite"))).mode&0o777,0o600);
  }finally{active?.close();await rm(directory,{recursive:true,force:true});}
});

test("review separates missing candidates, incomplete judgments and unlabelled predictions",()=>{
  const relation=(name,extra={})=>({fromTable:"orders",toTable:"customer",columnPairs:[{fromCol:name,toCol:"id"}],...extra});
  const names=["absent","missing","uncertain","negative","low","direction","known_negative"];
  const truth={version:"relation-truth-v1",complete:false,tables:["orders","customer"],relations:names.map(name=>relation(name,{label:name==="known_negative"?"none":"relation",cardinality:"N:1"}))};
  const candidates=[...names.slice(1),"new"].map(name=>relation(name));
  const predictions=candidates.map(c=>({...c,decision:"relation",confidence:.9,cardinality:"N:1"}));
  Object.assign(predictions[0],{judgmentComplete:false,decision:"uncertain"});
  predictions[1].decision="uncertain";predictions[2].decision="none";predictions[3].confidence=.3;predictions[4].cardinality="1:1";
  const result=buildRelationReview({truth,candidates,predictions});
  for(const category of ["not_proposed","unjudged","uncertain","model_negative","below_threshold","direction_or_cardinality","labelled_negative_conflict","unlabelled_prediction"])assert.equal(result.counts[category],1,category);
  assert.equal(result.truthComplete,false);
});
