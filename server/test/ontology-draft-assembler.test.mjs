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

function candidate(id,candidateType,status,stableKey,payload) { return {id,runId:"run-1",sourceId:1,candidateType,status,stableKey,payload}; }
function object(apiName,table,column,displayName) { return {apiName,displayName,description:"",primaryKey:column,properties:[{apiName:column,displayName:column,type:"integer",required:true,constraints:{},mapping:{table,column}}]}; }
