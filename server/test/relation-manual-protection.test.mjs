import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createStore} from "../src/store.mjs";
import {createDiscoveryService} from "../src/discovery-service.mjs";
import {reverseRelation} from "../src/physical-relation.mjs";

const relation={sourceId:1,fromTable:"orders",fromCol:"customer_id",toTable:"customer",toCol:"id",cardinality:"N:N",status:"confirmed",confidence:.98,inferenceSource:"document",modelReason:"已核验的业务定义",dataEvidence:{status:"sampled",sampleSize:7,matchRatio:.8}};

test("model rediscovery preserves the complete confirmed definition and its directional evidence",()=>{
  const store=createStore(":memory:");
  try{
    const known=store.upsertRelation(relation);
    const returned=store.upsertRelation({...relation,inferenceSource:"model",status:"review",cardinality:"N:1",confidence:.7,modelReason:"新的模型推测",dataEvidence:{status:"sampled",sampleSize:20,matchRatio:1}});
    assert.deepEqual(returned,known);
    assert.deepEqual(store.getRelationByKey(1,"orders","customer_id","customer","id"),known);
  }finally{store.close();}
});

test("reversed full tuples reuse confirmed or denied decisions, but a partial tuple stays distinct",()=>{
  for(const status of ["accepted","confirmed","denied"]){
    const store=createStore(":memory:");
    try{
      const full={...relation,status,columnPairs:[{fromCol:"tenant_id",toCol:"tenant_id"},{fromCol:"customer_id",toCol:"id"}]};
      const known=store.upsertRelation(full),reverse=reverseRelation(full);
      const returned=store.upsertRelation({...reverse,sourceId:1,inferenceSource:"model",status:"review",cardinality:"1:N",confidence:.6});
      assert.equal(returned.id,known.id);assert.equal(returned.status,status);assert.equal(store.listRelations(1,false,true).length,1);
      const partial=store.upsertRelation({...reverse,sourceId:1,columnPairs:[{fromCol:"id",toCol:"customer_id"}],inferenceSource:"model",status:"review"});
      assert.notEqual(partial.id,known.id);assert.equal(partial.status,"review");
    }finally{store.close();}
  }
});

test("real discovery retires duplicate model/document review rows and never asks to reconfirm the inverse",async()=>{
  for(const duplicateOrigin of ["model","document"])for(const modelCompleted of [true,false]){
    const root=await mkdtemp(join(tmpdir(),"manual-relation-discovery-")),store=createStore(join(root,"db.sqlite"));
    const source=store.createSource({name:"test",host:"test",dbName:"test",userName:"ro",credential:"test"});
    const tables=[{tableName:"orders",rowEstimate:20},{tableName:"customer",rowEstimate:10}];
    const columns=[{tableName:"orders",columnName:"customer_id",dataType:"bigint",nullable:"NO",isIndexed:1},{tableName:"customer",columnName:"id",dataType:"bigint",nullable:"NO",isPrimary:1,isIndexed:1}];
    const duplicate=store.upsertRelation({...relation,sourceId:source.id,status:"review",inferenceSource:duplicateOrigin});
    const known=store.upsertRelation({...reverseRelation(relation),sourceId:source.id,status:"confirmed",inferenceSource:"document",cardinality:"1:N"});
    store.addQuestion({sourceId:source.id,kind:"JOIN 路径",scope:"table",relationId:duplicate.id,question:"确认该关系？",evidence:"旧候选"});
    const connector={query:async(_source,sql)=>{if(sql.includes("information_schema.TABLES"))return [tables];if(sql.includes("information_schema.COLUMNS"))return [columns];if(sql.includes("information_schema."))return [[]];return [[{value:1,matchCount:1,customer_id:1,id:1}]];}};
    const model={judge:async candidates=>({status:modelCompleted?"completed":"partial",decisions:modelCompleted?candidates.map(c=>({candidateId:c.id,decision:"relation",confidence:.99,cardinality:"N:1",reason:"模型重判"})):[]})};
    try{
      const service=createDiscoveryService({store,connector,wikiDir:join(root,"wiki"),relationModel:model,config:{profiling:{enabled:false},relationModel:{proposalsEnabled:false,stratifiedSampling:false}}});
      await service.discover(source);
      const active=store.listRelations(source.id,false,true);
      assert.deepEqual(active.map(r=>r.id),[known.id],duplicateOrigin);assert.equal(active[0].cardinality,"1:N");
      assert.equal(store.listQuestions(source.id).filter(q=>q.kind==="JOIN 路径").length,0);
    }finally{store.close();await rm(root,{recursive:true,force:true});}
  }
});

test("a removed foreign key is not treated as a human confirmation when the model rediscovers it",()=>{
  const store=createStore(":memory:");
  try{
    const old=store.upsertRelation({...relation,inferenceSource:"foreign_key",constraintName:"fk_customer"});
    const candidate=store.upsertRelation({...relation,inferenceSource:"model",status:"review",cardinality:"N:1"});
    assert.equal(candidate.id,old.id);assert.equal(candidate.status,"review");assert.equal(candidate.inferenceSource,"model");assert.equal(candidate.constraintName,null);
  }finally{store.close();}
});
