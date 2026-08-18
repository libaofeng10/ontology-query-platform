import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { createOntologyGraphService } from "../src/ontology-graph-service.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { createStore } from "../src/store.mjs";

test("ontology graph combines published business objects, physical mappings and knowledge bindings",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-graph-"));const store=createStore(join(dir,"store.sqlite"));
  for(const [name,grade,active] of [["crm_customer","A",1],["sales_order","A",1],["old_backup","C",0]])store.upsertTable({sourceId:9,tableName:name,grade,active,comment:name});
  store.upsertColumn({sourceId:9,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0});
  store.upsertColumn({sourceId:9,tableName:"crm_customer",columnName:"customer_type",dataType:"varchar",nullable:0});
  store.upsertColumn({sourceId:9,tableName:"sales_order",columnName:"order_id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0});
  store.upsertColumn({sourceId:9,tableName:"sales_order",columnName:"customer_id",dataType:"bigint",isIndexed:1,nullable:0});
  const relation=store.upsertRelation({sourceId:9,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:1,status:"confirmed"});
  const semantic=createSemanticSchemaService({store});
  const draft=semantic.saveDraft(9,{
    name:"sales",displayName:"销售本体",description:"客户与订单",
    objectTypes:[
      {apiName:"customer",displayName:"客户",primaryKey:"customer_id",properties:[{apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}},{apiName:"customer_type",displayName:"客户类型",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"crm_customer",column:"customer_type"}}]},
      {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"customer_type",values:["vip"]},properties:[]},
      {apiName:"order",displayName:"订单",primaryKey:"order_id",properties:[{apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},{apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"sales_order",column:"customer_id"}}]},
    ],
    linkTypes:[{apiName:"places_order",displayName:"客户下单",source:"customer",target:"order",cardinality:"one_to_many",relationMappings:[{relationId:relation.id}]}],
  },"editor-a");
  assert.equal(semantic.publish(draft.id,"editor-a").ok,true);
  const knowledge=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  await knowledge.save(9,{pageType:"term",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"已实名客户，相关 [[复购率]]",sqlContent:"cert_status = 1",verified:true,owner:"owner"});
  await knowledge.save(9,{pageType:"metric",title:"复购率",tables:["crm_customer","sales_order"],content:"两次及以上下单",sqlContent:"COUNT(*)",verified:true,owner:"owner"});
  const graph=createOntologyGraphService({store,knowledge}).build(9);
  assert.equal(graph.stats.tables,2);assert.equal(graph.stats.objects,3);assert.equal(graph.stats.semanticLinks,1);assert.equal(graph.stats.schemaVersion,1);
  assert.equal(graph.stats.terms,1);assert.equal(graph.stats.metrics,1);assert.equal(graph.stats.confirmedJoins,1);
  assert.ok(graph.nodes.some((node)=>node.id==="object:customer"&&node.properties.length===2));
  assert.ok(graph.edges.some((edge)=>edge.kind==="semantic"&&edge.source==="object:customer"&&edge.target==="object:order"));
  assert.ok(graph.edges.some((edge)=>edge.kind==="subclass"&&edge.source==="object:vip_customer"&&edge.target==="object:customer"));
  assert.ok(graph.nodes.find((node)=>node.id==="object:vip_customer").properties.every((property)=>property.inherited));
  assert.ok(graph.edges.some((edge)=>edge.kind==="mapping"&&edge.source==="object:order"&&edge.target==="table:sales_order"));
  assert.ok(graph.edges.some((edge)=>edge.kind==="join"&&edge.confirmed));
  assert.ok(graph.edges.some((edge)=>edge.kind==="binding"&&edge.source==="term:有效客户"&&edge.target==="table:crm_customer"));
  assert.ok(graph.edges.some((edge)=>edge.kind==="binding"&&edge.source==="term:有效客户"&&edge.target==="object:customer"));
  assert.ok(graph.edges.some((edge)=>edge.kind==="wikilink"&&edge.target==="metric:复购率"));
  assert.equal(graph.nodes.some((node)=>node.id==="table:old_backup"),false);
  store.close();
});
