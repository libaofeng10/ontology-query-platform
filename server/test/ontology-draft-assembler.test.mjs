import assert from "node:assert/strict";
import test from "node:test";
import { assembleOntologyDraft } from "../src/ontology-draft-assembler.mjs";

test("draft assembler merges accepted objects and links without overwriting base definitions",()=>{
  const run={id:"run-1",sourceId:1,scope:{namespace:"sales",domainName:"销售域"}};
  const baseSchema={name:"sales",displayName:"销售模型",objectTypes:[object("customer","crm_customer","customer_id","客户")],linkTypes:[]};
  const candidates=[
    candidate("order","object","confirmed","object:sales:sales_order",object("order","sales_order","order_id","订单")),
    candidate("customer-conflict","object","auto_confirmed","object:sales:customer_copy",object("customer","customer_copy","id","重复客户")),
    candidate("customer-orders","link","auto_confirmed","link:sales:customer:7:order",{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationKind:"references",relationMappings:[{relationId:7}]}),
    candidate("excluded","object","confirmed","object:sales:excluded_table",object("excluded","excluded_table","id","排除对象")),
    candidate("review","object","review_required","object:sales:review_table",object("review","review_table","id","待审核对象")),
  ];
  const result=assembleOntologyDraft({run,candidates,baseSchema,excludeCandidateIds:["excluded"]});
  assert.deepEqual(result.schema.objectTypes.map((item)=>item.apiName),["customer","order"]);
  assert.deepEqual(result.schema.linkTypes.map((item)=>item.apiName),["customer_orders"]);
  assert.deepEqual(result.includedCandidates.map((item)=>item.id),["order","customer-orders"]);
  assert.equal(result.conflicts.length,1);assert.equal(result.conflicts[0].reason,"object_api_name_exists");
  assert.deepEqual(result.summary,{objectsAdded:1,propertiesAdded:1,linksAdded:1,renamedLinkCount:0,candidateCount:2,conflictCount:1,resolvedConflictCount:0,unresolvedConflictCount:1,excludedCount:1});
});

test("draft assembler deterministically disambiguates Link and inverse names across domains",()=>{
  const run={id:"run-1",sourceId:1,scope:{namespace:"sales",domainName:"销售域"}};
  const baseSchema={name:"sales",displayName:"销售模型",objectTypes:[object("customer","crm_customer","id","客户"),object("order","sales_order","id","订单"),object("invoice","sales_invoice","id","发票")],linkTypes:[{apiName:"customer_orders",inverseApiName:"orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationMappings:[]}]};
  const candidates=[candidate("invoice-link","link","confirmed","link:sales:order:8:invoice",{apiName:"orders",inverseApiName:"customer_orders",displayName:"订单发票",source:"order",target:"invoice",cardinality:"one_to_many",relationMappings:[{relationId:8}]})];
  const result=assembleOntologyDraft({run,candidates,baseSchema});
  assert.equal(result.schema.linkTypes[1].apiName,"orders_order_to_invoice");
  assert.equal(result.schema.linkTypes[1].inverseApiName,"customer_orders_invoice_to_order");
  assert.equal(result.summary.renamedLinkCount,2);
  assert.deepEqual(result.renamedLinks.map((item)=>item.field),["apiName","inverseApiName"]);
});

test("draft assembler reports a Link conflict when an endpoint is excluded",()=>{
  const run={id:"run-1",sourceId:1,scope:{namespace:"sales",domainName:"销售域"}};
  const candidates=[
    candidate("customer","object","confirmed","object:sales:crm_customer",object("customer","crm_customer","customer_id","客户")),
    candidate("order","object","confirmed","object:sales:sales_order",object("order","sales_order","order_id","订单")),
    candidate("link","link","confirmed","link:sales:customer:7:order",{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationMappings:[{relationId:7}]}),
  ];
  const result=assembleOntologyDraft({run,candidates,excludeCandidateIds:["order"]});
  assert.deepEqual(result.schema.objectTypes.map((item)=>item.apiName),["customer"]);
  assert.equal(result.schema.linkTypes.length,0);assert.equal(result.conflicts[0].reason,"link_endpoint_missing");
  assert.equal(result.includedCandidates[0].id,"customer");
});

test("增量合并时同名但不同已确认物理路径自动命名，两条关系均保留",()=>{
  const run={id:"run-1",sourceId:1,scope:{namespace:"sales"}};
  const objects=[object("institution","institution","id","机构"),object("customer","customer","id","客户"),object("user","user","id","账号")];
  const link=(target,id)=>({apiName:"institution_leader_user",inverseApiName:"led_institution",displayName:"机构负责人",source:"institution",target,cardinality:"many_to_one",relationKind:"references",relationMappings:[{relationId:id}]});
  const candidates=[candidate("one","link","auto_confirmed","link:1",link("customer",2911)),candidate("two","link","auto_confirmed","link:2",link("user",7139))];
  const baseSchema={name:"sales",objectTypes:objects,linkTypes:[]};
  const result=assembleOntologyDraft({run,candidates,baseSchema,incremental:true});
  assert.equal(result.conflicts.length,0);assert.equal(result.schema.linkTypes.length,2);assert.equal(new Set(result.schema.linkTypes.flatMap(l=>[l.apiName,l.inverseApiName])).size,4);assert.deepEqual(result.schema.linkTypes.flatMap(l=>l.relationMappings.map(m=>m.relationId)),[2911,7139]);
  assert.deepEqual(baseSchema.linkTypes,[]);assert.equal(assembleOntologyDraft({run,candidates,baseSchema}).conflicts.length,1,"显式人工合并模式继续要求处理替换意图");
  const repeated=assembleOntologyDraft({run,candidates:[candidate("repeat","link","auto_confirmed","link:3",link("user",7139))],baseSchema:result.schema,incremental:true});assert.equal(repeated.conflicts.length,0);assert.equal(repeated.schema.linkTypes.length,2,"后续批次同一物理路径不会因旧名称再次冲突");
});

function candidate(id,candidateType,status,stableKey,payload) { return {id,runId:"run-1",sourceId:1,candidateType,status,stableKey,payload}; }
function object(apiName,table,column,displayName) { return {apiName,displayName,description:"",primaryKey:column,properties:[{apiName:column,displayName:column,type:"integer",required:true,constraints:{},mapping:{table,column}}]}; }
