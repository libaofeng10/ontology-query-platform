import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { evalSetChecksum } from "../src/evaluation-evidence.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { validateSemanticSchema } from "../src/semantic-schema.mjs";
import { diffSemanticSchemas } from "../src/semantic-schema-diff.mjs";
import { analyzeSemanticSchemaImpact } from "../src/semantic-schema-impact.mjs";
import { createStore } from "../src/store.mjs";

test("full-domain schemas retain hundreds of objects and thousands of properties without truncation",()=>{
  const properties=Array.from({length:12},(_,index)=>({apiName:`field_${index}`,displayName:`字段 ${index}`,type:"string",required:index===0,mapping:{table:"wide_table",column:"id"}}));
  const schema={name:"enterprise",displayName:"企业全域本体",objectTypes:Array.from({length:344},(_,index)=>({apiName:`object_${index}`,displayName:`对象 ${index}`,primaryKey:"field_0",properties})),linkTypes:[]};
  const validation=validateSemanticSchema(schema,{tables:[{tableName:"wide_table",active:1,grade:"A"}],columnsByTable:{wide_table:[{columnName:"id",dataType:"varchar",nullable:0,isSensitive:0}]},relations:[]});
  assert.equal(validation.errors.some((issue)=>issue.code==="ONTOLOGY_LIMIT_EXCEEDED"),false,JSON.stringify(validation.errors.slice(0,3)));
  assert.equal(validation.schema.objectTypes.length,344);
  assert.equal(validation.summary.properties,4_128);
});

test("semantic schema validates typed object mappings and confirmed links",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const validation=service.validate(fixture.source.id,validSchema(fixture.relation.id));
    assert.equal(validation.ok,true,JSON.stringify(validation.errors));
    assert.deepEqual(validation.summary,{objectTypes:2,properties:4,linkTypes:1,errorCount:0,warningCount:0});
    assert.equal(validation.schema.objectTypes[0].displayName,"客户");
    assert.equal(validation.schema.linkTypes[0].cardinality,"one_to_many");
  } finally { fixture.store.close(); }
});

test("semantic schema preserves optional namespace, freshness and relationKind contracts",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.relation.id);
    schema.objectTypes[0].namespace="customer_domain";
    schema.objectTypes[0].freshness="daily";
    schema.objectTypes[0].properties[0].freshness="realtime";
    schema.linkTypes[0].relationKind="references";
    const validation=service.validate(fixture.source.id,schema);
    assert.equal(validation.ok,true,JSON.stringify(validation.errors));
    assert.equal(validation.schema.objectTypes[0].namespace,"customer_domain");
    assert.equal(validation.schema.objectTypes[0].freshness,"daily");
    assert.equal(validation.schema.objectTypes[0].properties[0].freshness,"realtime");
    assert.equal(validation.schema.linkTypes[0].relationKind,"references");

    schema.objectTypes[0].namespace="Bad Namespace";
    schema.objectTypes[0].freshness="weekly";
    schema.linkTypes[0].relationKind="owns";
    const invalid=service.validate(fixture.source.id,schema);
    const codes=new Set(invalid.errors.map((item)=>item.code));
    for(const code of ["ONTOLOGY_NAMESPACE_INVALID","ONTOLOGY_FRESHNESS_INVALID","ONTOLOGY_RELATION_KIND_INVALID"])assert.ok(codes.has(code));
  } finally { fixture.store.close(); }
});

test("axiom-lite validates inverse names, discriminated hierarchy, disjoint groups and term anchors",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",dataType:"varchar",nullable:0,comment:"客户类型"});
    fixture.store.upsertEnum({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",value:"enterprise",count:30,ratio:.3});
    fixture.store.upsertEnum({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",value:"individual",count:70,ratio:.7});
    fixture.store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUST",prefLabelZh:"客户",altLabels:["客群"],kind:"object"});
    fixture.store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUST_TYPE",prefLabelZh:"客户类型",kind:"property"});
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.relation.id);
    schema.objectTypes[0].termBinding={vocabulary:"corp",canonicalId:"CUST",match:"exact"};
    schema.objectTypes[0].properties.push({apiName:"customer_type",displayName:"客户类型",type:"enum",required:true,constraints:{enumValues:["enterprise","individual"]},mapping:{table:"crm_customer",column:"customer_type"},termBinding:{vocabulary:"corp",canonicalId:"CUST_TYPE",match:"exact"}});
    schema.objectTypes.push(
      {apiName:"enterprise_customer",displayName:"企业客户",parent:"customer",primaryKey:"",discriminator:{property:"customer_type",values:["enterprise"]},properties:[]},
      {apiName:"individual_customer",displayName:"个人客户",parent:"customer",discriminator:{property:"customer_type",values:["individual"]},properties:[]},
    );
    schema.disjointGroups=[["enterprise_customer","individual_customer"]];
    schema.linkTypes[0].inverseApiName="order_belongs_to_customer";
    schema.linkTypes[0].inverseDisplayName="订单所属客户";
    const validation=service.validate(fixture.source.id,schema);
    assert.equal(validation.ok,true,JSON.stringify(validation.errors));
    assert.equal(validation.schema.objectTypes.find((item)=>item.apiName==="enterprise_customer").primaryKey,"customer_id");
    assert.equal(validation.schema.linkTypes[0].inverseDisplayName,"订单所属客户");

    const invalid=structuredClone(schema);
    invalid.objectTypes.at(-1).discriminator.values=["enterprise"];
    invalid.objectTypes.at(-1).properties=[structuredClone(invalid.objectTypes[0].properties[1])];
    invalid.objectTypes.at(-1).termBinding={vocabulary:"corp",canonicalId:"CUST",match:"exact"};
    invalid.linkTypes[0].inverseApiName=invalid.linkTypes[0].apiName;
    const failed=service.validate(fixture.source.id,invalid);
    const codes=new Set(failed.errors.map((item)=>item.code));
    for(const code of ["ONTOLOGY_PROPERTY_SHADOWED","ONTOLOGY_DISJOINT_UNSATISFIABLE","ONTOLOGY_TERM_EXACT_DUPLICATE","ONTOLOGY_LINK_INVERSE_DUPLICATE"])assert.ok(codes.has(code),`${code} missing from ${[...codes]}`);
    assert.ok(failed.warnings.some((item)=>item.code==="ONTOLOGY_SIBLING_OVERLAP"));
  } finally { fixture.store.close(); }
});

test("self links warn when inverse naming is omitted",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.relation.id);
    schema.linkTypes=[{apiName:"customer_referrer",displayName:"客户推荐",source:"customer",target:"customer",cardinality:"one_to_many",relationMappings:[{relationId:fixture.relation.id}]}];
    const validation=service.validate(fixture.source.id,schema);
    assert.ok(validation.warnings.some((item)=>item.code==="ONTOLOGY_LINK_SELF_INVERSE_MISSING"));
  } finally { fixture.store.close(); }
});

test("missing discriminators on sibling subtypes return validation errors instead of crashing",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.relation.id);
    schema.objectTypes.push(
      {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",properties:[]},
      {apiName:"standard_customer",displayName:"标准客户",parent:"customer",properties:[]},
    );
    let validation;
    assert.doesNotThrow(()=>{validation=service.validate(fixture.source.id,schema);});
    assert.equal(validation.ok,false);
    assert.equal(validation.errors.filter((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_REQUIRED").length,2);
  } finally { fixture.store.close(); }
});

test("column profile samples are warning-only discriminator evidence",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",dataType:"varchar",nullable:0,comment:"客户类型"});
    fixture.store.upsertColumnProfile({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",profile:{sampleValues:["vip"],distinctCount:1,nullRatio:0},sampleSize:10,profileVersion:"v1"});
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.relation.id);
    schema.objectTypes[0].properties.push({apiName:"customer_type",displayName:"客户类型",type:"string",required:true,mapping:{table:"crm_customer",column:"customer_type"}});
    schema.objectTypes.push({apiName:"standard_customer",displayName:"标准客户",parent:"customer",discriminator:{property:"customer_type",values:["standard"]},properties:[]});
    const validation=service.validate(fixture.source.id,schema);
    assert.equal(validation.errors.some((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED"),false,JSON.stringify(validation.errors));
    assert.ok(validation.warnings.some((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED"));
  } finally { fixture.store.close(); }
});

test("axiom-lite validation error matrix covers hierarchy, disjoint and term-binding branches",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",dataType:"varchar",nullable:0,comment:"客户类型"});
    fixture.store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUSTOMER",prefLabelZh:"客户",kind:"object"});
    fixture.store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUSTOMER_TYPE",prefLabelZh:"客户类型",kind:"property"});
    const service=createSemanticSchemaService({store:fixture.store});
    const base=()=>{const schema=validSchema(fixture.relation.id);schema.objectTypes[0].properties.push({apiName:"customer_type",displayName:"客户类型",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"crm_customer",column:"customer_type"}});return schema;};
    const child=(apiName,parent="customer",values=["vip"])=>({apiName,displayName:apiName,parent,discriminator:{property:"customer_type",values},properties:[]});
    const cases=[
      ["ONTOLOGY_PARENT_NOT_FOUND",(schema)=>schema.objectTypes.push(child("orphan_customer","missing_customer"))],
      ["ONTOLOGY_HIERARCHY_CYCLE",(schema)=>schema.objectTypes.push(child("cycle_a","cycle_b"),child("cycle_b","cycle_a"))],
      ["ONTOLOGY_HIERARCHY_TOO_DEEP",(schema)=>schema.objectTypes.push(child("level_1"),child("level_2","level_1"),child("level_3","level_2"),child("level_4","level_3"))],
      ["ONTOLOGY_DISCRIMINATOR_REQUIRED",(schema)=>schema.objectTypes.push({apiName:"missing_discriminator",displayName:"缺判别",parent:"customer",properties:[]})],
      ["ONTOLOGY_DISCRIMINATOR_REQUIRED",(schema)=>{schema.objectTypes[0].discriminator={property:"customer_type",values:["vip"]};}],
      ["ONTOLOGY_DISCRIMINATOR_PROPERTY_INVALID",(schema)=>schema.objectTypes.push({...child("invalid_property"),discriminator:{property:"missing",values:["vip"]}})],
      ["ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",(schema)=>schema.objectTypes.push({...child("invalid_values"),discriminator:{property:"customer_type",values:"vip"}})],
      ["ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",(schema)=>schema.objectTypes.push(child("unknown_value","customer",["unknown"]))],
      ["ONTOLOGY_PRIMARY_KEY_INHERITED",(schema)=>schema.objectTypes.push({...child("overridden_key"),primaryKey:"name"})],
      ["ONTOLOGY_LINK_HIERARCHY_AMBIGUOUS",(schema)=>{schema.objectTypes.push(child("vip_customer"));schema.linkTypes[0].target="vip_customer";}],
      ["ONTOLOGY_DISJOINT_MEMBER_NOT_FOUND",(schema)=>{schema.disjointGroups=[["customer","missing_customer"]];}],
      ["ONTOLOGY_TERM_ANCHOR_NOT_FOUND",(schema)=>{schema.objectTypes[0].termBinding={vocabulary:"corp",canonicalId:"MISSING",match:"exact"};}],
      ["ONTOLOGY_TERM_ANCHOR_KIND_MISMATCH",(schema)=>{schema.objectTypes[0].termBinding={vocabulary:"corp",canonicalId:"CUSTOMER_TYPE",match:"exact"};}],
      ["ONTOLOGY_TERM_BINDING_INVALID",(schema)=>{schema.objectTypes[0].termBinding="invalid";}],
    ];
    for(const [expected,mutate] of cases) {
      const schema=base();mutate(schema);const validation=service.validate(fixture.source.id,schema);
      assert.ok(validation.errors.some((item)=>item.code===expected),`${expected} missing from ${JSON.stringify(validation.errors)}`);
    }
  } finally { fixture.store.close(); }
});

test("duplicate Link apiName does not add a misleading inverse-name error",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});const schema=validSchema(fixture.relation.id);
    schema.linkTypes.push(structuredClone(schema.linkTypes[0]));
    const validation=service.validate(fixture.source.id,schema);
    assert.ok(validation.errors.some((item)=>item.code==="ONTOLOGY_LINK_DUPLICATE"));
    assert.equal(validation.errors.some((item)=>item.code==="ONTOLOGY_LINK_INVERSE_DUPLICATE"),false,JSON.stringify(validation.errors));
  } finally { fixture.store.close(); }
});

test("semantic schema aggregates stable errors and refuses invalid publication",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const schema=validSchema(fixture.reviewRelation.id);
    schema.name="Bad Name";
    schema.objectTypes[0].apiName="Customer";
    schema.objectTypes[0].properties[0].required=false;
    schema.objectTypes[1].properties[1].mapping.column="missing_column";
    const validation=service.validate(fixture.source.id,schema);
    const codes=new Set(validation.errors.map((error)=>error.code));
    assert.equal(validation.ok,false);
    for(const code of ["ONTOLOGY_API_NAME_INVALID","ONTOLOGY_PRIMARY_KEY_NOT_REQUIRED","ONTOLOGY_MAPPING_COLUMN_NOT_FOUND","ONTOLOGY_LINK_SOURCE_NOT_FOUND","ONTOLOGY_RELATION_NOT_CONFIRMED"]) assert.ok(codes.has(code),`${code} missing from ${[...codes]}`);

    const draft=service.saveDraft(fixture.source.id,schema,"editor-a");
    assert.equal(draft.status,"draft");
    assert.equal(draft.validation.ok,false);
    const publication=service.publish(draft.id,"editor-a");
    assert.equal(publication.ok,false);
    assert.equal(publication.record.status,"draft");
    assert.equal(service.getPublished(fixture.source.id),null);
  } finally { fixture.store.close(); }
});

test("publishing an ontology version deprecates the previous release",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const first=service.saveDraft(fixture.source.id,validSchema(fixture.relation.id),"editor-a");
    assert.equal(first.version,1);
    assert.equal(service.publish(first.id,"publisher-a").ok,true);

    const nextSchema=validSchema(fixture.relation.id);
    nextSchema.description="第二版业务定义";
    const second=service.saveDraft(fixture.source.id,nextSchema,"editor-b");
    assert.equal(second.version,2);
    const published=service.publish(second.id,"publisher-b");
    assert.equal(published.ok,true);
    assert.equal(published.record.status,"published");
    assert.equal(published.record.publishedBy,"publisher-b");
    assert.equal(service.get(first.id).status,"deprecated");
    assert.equal(service.getPublished(fixture.source.id).id,second.id);
    assert.deepEqual(service.list(fixture.source.id).map((item)=>item.status),["published","deprecated"]);
    const rollback=service.rollback(first.id,"publisher-c");
    assert.equal(rollback.ok,true);assert.equal(rollback.rolledBackFrom,2);
    assert.equal(service.get(first.id).status,"published");assert.equal(service.get(second.id).status,"deprecated");
    assert.deepEqual(fixture.store.listOntologyPublications(fixture.source.id).map((item)=>item.action),["rollback","publish","publish"]);
  } finally { fixture.store.close(); }
});

test("semantic schema diff classifies compatible additions and breaking mapping changes",()=>{
  const base=validSchema(1);const current=structuredClone(base);
  current.objectTypes[0].properties.push({apiName:"segment",displayName:"客户分层",type:"string",required:false,mapping:{table:"crm_customer",column:"segment"}});
  current.objectTypes[1].properties[1].mapping.column="buyer_id";
  current.linkTypes=[];
  const diff=diffSemanticSchemas(current,base);
  assert.equal(diff.summary.added,1);assert.equal(diff.summary.removed,1);assert.equal(diff.summary.changed,1);assert.equal(diff.summary.breaking,2);
  assert.ok(diff.changes.some((item)=>item.path==="objectTypes.customer.properties.segment"&&item.impact==="compatible"));
  assert.ok(diff.changes.some((item)=>item.path==="objectTypes.order.properties.customer_id"&&item.impact==="breaking"));
});

test("axiom-lite diff classifies hierarchy as breaking and naming or anchors as compatible",()=>{
  const base=validSchema(1);const current=structuredClone(base);
  current.objectTypes[0].parent="party";
  current.objectTypes[0].discriminator={property:"name",values:["enterprise"]};
  current.objectTypes[0].termBinding={vocabulary:"corp",canonicalId:"CUST",match:"exact"};
  current.linkTypes[0].inverseApiName="order_belongs_to_customer";
  current.disjointGroups=[["customer","order"]];
  const diff=diffSemanticSchemas(current,base);
  assert.ok(diff.changes.some((item)=>item.type==="object_parent_changed"&&item.path==="objectTypes.customer.parent"&&item.impact==="breaking"));
  assert.ok(diff.changes.some((item)=>item.type==="term_binding_changed"&&item.path==="objectTypes.customer.termBinding"&&item.impact==="compatible"));
  assert.ok(diff.changes.some((item)=>item.type==="disjoint_group_changed"&&item.impact==="review"));
  assert.ok(diff.changes.some((item)=>item.type==="link_inverse_changed"&&item.impact==="compatible"));
});

test("schema impact maps breaking semantic changes to dependent evaluation cases without exposing Gold SQL",()=>{
  const base=validSchema(1);const current=structuredClone(base);
  current.objectTypes[1].properties[1].mapping.column="buyer_id";
  const impact=analyzeSemanticSchemaImpact(current,base,{cases:[{id:7,setName:"regression",question:"查询客户订单",category:"关联",goldSql:"SELECT customer_id FROM sales_order"}]});
  assert.equal(impact.summary.breakingChanges,1);
  assert.equal(impact.summary.affectedCases,1);
  assert.deepEqual(impact.affectedSets,["regression"]);
  assert.match(impact.affectedCases[0].reasons.join("；"),/sales_order|customer_id/);
  assert.equal("goldSql" in impact.affectedCases[0],false);
  assert.equal(impact.uncoveredChanges.length,0);
});

test("hierarchy impact propagates discriminator changes to descendant evaluation cases",()=>{
  const base=validSchema(1);
  base.objectTypes[0].properties.push({apiName:"customer_type",displayName:"客户类型",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"crm_customer",column:"customer_type"}});
  base.objectTypes.push(
    {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"customer_type",values:["vip","standard"]},properties:[]},
    {apiName:"gold_customer",displayName:"金牌客户",parent:"vip_customer",discriminator:{property:"customer_type",values:["vip"]},properties:[]},
  );
  const current=structuredClone(base);current.objectTypes.find((item)=>item.apiName==="vip_customer").discriminator.values=["vip"];
  const impact=analyzeSemanticSchemaImpact(current,base,{cases:[{id:8,setName:"hierarchy",question:"查询金牌客户",category:"层级",goldSql:"SELECT customer_id FROM crm_customer"}]});
  assert.equal(impact.summary.requiresEvaluation,true);assert.equal(impact.affectedCases.length,1);assert.match(impact.affectedCases[0].reasons.join("；"),/金牌客户/);
});

test("breaking drafts require a current version-bound evaluation gate before publication",async()=>{
  const fixture=await createFixture();
  try {
    const service=createSemanticSchemaService({store:fixture.store});
    const base=service.saveDraft(fixture.source.id,validSchema(fixture.relation.id),"editor");assert.equal(service.publish(base.id,"editor").ok,true);
    const evalCase=fixture.store.addEvalCase({sourceId:fixture.source.id,setName:"regression",question:"查询客户订单",goldSql:"SELECT customer_id FROM sales_order",category:"关联",heldOut:0});
    const next=validSchema(fixture.relation.id);next.objectTypes[1].properties[1].mapping.column="order_id";
    const draft=service.saveDraft(fixture.source.id,next,"editor");
    const directImpact=analyzeSemanticSchemaImpact(draft.schema,service.getPublished(fixture.source.id).schema,{cases:fixture.store.listEvalCasesForImpact(fixture.source.id),relations:fixture.store.listRelations(fixture.source.id,false,true)});assert.equal(directImpact.summary.requiresEvaluation,true,JSON.stringify(directImpact));
    const blocked=service.publish(draft.id,"editor");assert.equal(blocked.ok,false);assert.equal(blocked.gateRequired,true);assert.deepEqual(blocked.evaluationImpact.missingSets,["regression"]);
    const cases=fixture.store.listEvalCasesForImpact(fixture.source.id);const checksum=evalSetChecksum(cases);
    fixture.store.saveEvalGate({id:"gate-versioned",sourceId:fixture.source.id,setName:"regression",total:1,ontologySchemaVersion:draft.version,evaluationChecksum:checksum,baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0},passed:1,decision:"enable_prefer",reason:"passed"});
    fixture.store.updateEvalCase(evalCase.id,{setName:"regression",question:"查询客户订单明细",goldSql:"SELECT customer_id FROM sales_order",category:"关联",heldOut:0});
    const stale=service.publish(draft.id,"editor");assert.equal(stale.gateRequired,true);assert.deepEqual(stale.evaluationImpact.missingSets,["regression"]);
    const updatedCases=fixture.store.listEvalCasesForImpact(fixture.source.id);const updatedChecksum=evalSetChecksum(updatedCases);
    fixture.store.saveEvalGate({id:"gate-versioned-current",sourceId:fixture.source.id,setName:"regression",total:1,ontologySchemaVersion:draft.version,evaluationChecksum:updatedChecksum,baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0},passed:1,decision:"enable_prefer",reason:"passed"});
    const published=service.publish(draft.id,"editor");assert.equal(published.ok,true);assert.equal(published.record.version,draft.version);
  } finally { fixture.store.close(); }
});

test("hierarchy changes require a passed Gold gate with subtype rootObject coverage",async()=>{
  const fixture=await createFixture();
  try {
    fixture.store.upsertColumn({sourceId:fixture.source.id,tableName:"crm_customer",columnName:"customer_type",dataType:"varchar",nullable:0,comment:"客户类型"});
    const service=createSemanticSchemaService({store:fixture.store});
    const baseSchema=validSchema(fixture.relation.id);
    baseSchema.objectTypes[0].properties.push({apiName:"customer_type",displayName:"客户类型",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"crm_customer",column:"customer_type"}});
    baseSchema.objectTypes.push({apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"customer_type",values:["vip"]},properties:[]});
    const base=service.saveDraft(fixture.source.id,baseSchema,"editor");assert.equal(service.publish(base.id,"editor").ok,true);
    fixture.store.addEvalCase({sourceId:fixture.source.id,setName:"hierarchy",question:"查询 VIP 客户",goldSql:"SELECT customer_id FROM crm_customer",category:"层级",heldOut:0});
    const nextSchema=structuredClone(baseSchema);nextSchema.objectTypes.find((item)=>item.apiName==="vip_customer").discriminator.values=["standard"];
    const draft=service.saveDraft(fixture.source.id,nextSchema,"editor");assert.equal(draft.validation.ok,true,JSON.stringify(draft.validation.errors));
    const cases=fixture.store.listEvalCasesForImpact(fixture.source.id);const checksum=evalSetChecksum(cases);
    const gate={id:"hierarchy-gate",sourceId:fixture.source.id,setName:"hierarchy",total:1,ontologySchemaVersion:draft.version,evaluationChecksum:checksum,baseline:{requestedMode:"off",passRate:1},candidate:{requestedMode:"prefer",passRate:1,semanticExecutionRate:1,joinFailureRate:0,subtypeRootObjects:[]},passed:1,decision:"enable_prefer",reason:"passed"};
    fixture.store.saveEvalGate(gate);
    const blocked=service.publish(draft.id,"editor");
    assert.equal(blocked.gateRequired,true);assert.equal(blocked.evaluationImpact.summary.subtypeRootCoverageMissing,true);assert.deepEqual(blocked.evaluationImpact.missingSets,[]);
    fixture.store.saveEvalGate({...gate,candidate:{...gate.candidate,subtypeRootObjects:["vip_customer"],subtypeRootCoverage:1}});
    const published=service.publish(draft.id,"editor");assert.equal(published.ok,true);
  } finally { fixture.store.close(); }
});

test("ontology schema API enforces editor writes and returns 422 validation details",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-semantic-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),query:async()=>[[],[]],explain:async()=>[]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"semantic-api-test-secret",
    apiIdentities:[
      {name:"viewer-a",role:"viewer",token:"viewer-token",sourceIds:"*"},
      {name:"editor-a",role:"editor",token:"editor-token",sourceIds:"*"},
      {name:"admin-a",role:"admin",token:"admin-token",sourceIds:"*"},
    ],
    connector,rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},nodeEnv:"test",
  });
  const demoSource=app.store.listSources().find((item)=>item.isDemo);
  const demoOntology=app.store.getPublishedOntologySchema(demoSource.id);
  assert.equal(demoOntology.validation.ok,true);
  assert.equal(demoOntology.schema.objectTypes.length,3);
  const source=seedPhysicalCatalog(app.store);
  try {
    const relation=app.store.listRelations(source.id,true)[0];
    const schema=validSchema(relation.id);
    const anchorImport=await api(app,"/api/ontology/term-anchors/import","admin-token",{vocabulary:"corp",csv:"canonical_id,name_en,name_zh,category,kind,alt_labels\nCUST,Customer,客户,,object,客群|客户主体"});
    assert.equal(anchorImport.status,201);assert.equal(anchorImport.body.count,1);
    const sensitiveAnchor=await api(app,"/api/ontology/term-anchors/import","admin-token",{vocabulary:"corp",csv:"canonical_id,name_zh,kind,note\nPRIVATE,隐私术语,object,user@example.com"});
    assert.equal(sensitiveAnchor.status,400);assert.match(sensitiveAnchor.body.error,/包含敏感值/);
    const catalog=await api(app,`/api/ontology/catalog?sourceId=${source.id}`,"viewer-token",null,"GET");
    assert.equal(catalog.status,200);
    assert.ok(catalog.body.columnsByTable.crm_customer.some((column)=>column.columnName==="customer_id"));
    assert.ok(catalog.body.relations.some((item)=>item.id===relation.id&&item.status==="confirmed"));
    assert.ok(catalog.body.termAnchors.some((item)=>item.canonicalId==="CUST"&&item.altLabels.includes("客群")));
    const denied=await api(app,"/api/ontology/validate","viewer-token",{sourceId:source.id,schema});
    assert.equal(denied.status,403);

    schema.objectTypes[1].properties[1].mapping.column="missing";
    const draftResponse=await api(app,"/api/ontology/schemas","editor-token",{sourceId:source.id,schema});
    assert.equal(draftResponse.status,201);
    assert.equal(draftResponse.body.validation.ok,false);
    const publishResponse=await api(app,`/api/ontology/schemas/${draftResponse.body.id}/publish`,"editor-token",{});
    assert.equal(publishResponse.status,422);
    assert.equal(publishResponse.body.ok,false);
    assert.ok(publishResponse.body.errors.some((error)=>error.code==="ONTOLOGY_MAPPING_COLUMN_NOT_FOUND"));

    const validDraft=await api(app,"/api/ontology/schemas","editor-token",{sourceId:source.id,schema:validSchema(relation.id)});
    const validPublish=await api(app,`/api/ontology/schemas/${validDraft.body.id}/publish`,"editor-token",{});
    assert.equal(validPublish.status,200);
    const published=await api(app,`/api/ontology/published?sourceId=${source.id}`,"viewer-token",null,"GET");
    assert.equal(published.status,200);
    assert.equal(published.body.id,validDraft.body.id);
    const versions=await api(app,`/api/ontology/schemas?sourceId=${source.id}`,"viewer-token",null,"GET");
    assert.equal(versions.status,200);
    assert.deepEqual(versions.body.map((item)=>item.status),["published","draft"]);
    const nextSchema=validSchema(relation.id);nextSchema.objectTypes[0].displayName="客户主体";
    const nextDraft=await api(app,"/api/ontology/schemas","editor-token",{sourceId:source.id,schema:nextSchema});
    const diff=await api(app,`/api/ontology/schemas/${nextDraft.body.id}/diff?against=${validDraft.body.id}`,"viewer-token",null,"GET");
    assert.equal(diff.status,200);assert.equal(diff.body.summary.compatible,1);assert.equal(diff.body.summary.breaking,0);
    assert.ok(diff.body.changes.some((item)=>item.path==="objectTypes.customer"&&item.change==="changed"));
    assert.equal(diff.body.evaluationImpact.summary.requiresEvaluation,false);
    const nextPublish=await api(app,`/api/ontology/schemas/${nextDraft.body.id}/publish`,"editor-token",{});
    assert.equal(nextPublish.status,200);
    const rollback=await api(app,`/api/ontology/schemas/${validDraft.body.id}/rollback`,"editor-token",{});
    assert.equal(rollback.status,200);assert.equal(rollback.body.record.id,validDraft.body.id);assert.equal(rollback.body.rolledBackFrom,3);
  } finally {
    await app.close();
  }
});

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-semantic-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=seedPhysicalCatalog(store);
  const [relation,reviewRelation]=store.listRelations(source.id,false,true).sort((left,right)=>left.id-right.id);
  return {store,source,relation,reviewRelation};
}

function seedPhysicalCatalog(store) {
  const source=store.createSource({name:"test",kind:"mysql",host:"db",port:3306,dbName:"billing",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:100,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,comment:"客户编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"name",dataType:"varchar",nullable:0,comment:"客户名称"});
  store.upsertTable({sourceId:source.id,tableName:"sales_order",rowEstimate:1000,grade:"A",active:1,comment:"订单"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"order_id",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,comment:"订单编号"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"customer_id",dataType:"bigint",isIndexed:1,nullable:0,comment:"客户编号"});
  store.upsertRelation({sourceId:source.id,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:.99,status:"confirmed",inferenceSource:"foreign_key"});
  store.upsertRelation({sourceId:source.id,fromTable:"sales_order",fromCol:"order_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",confidence:.5,status:"review",inferenceSource:"model"});
  return source;
}

function validSchema(relationId) {
  return {
    name:"billing",displayName:"客户交易本体",description:"客户与订单业务对象",
    objectTypes:[
      {apiName:"customer",displayName:"客户",description:"业务客户",primaryKey:"customer_id",properties:[
        {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}},
        {apiName:"name",displayName:"客户名称",type:"string",required:true,constraints:{minLength:1,maxLength:100},mapping:{table:"crm_customer",column:"name"}},
      ]},
      {apiName:"order",displayName:"订单",description:"销售订单",primaryKey:"order_id",properties:[
        {apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},
        {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"sales_order",column:"customer_id"}},
      ]},
    ],
    linkTypes:[{apiName:"places_order",displayName:"客户下单",source:"customer",target:"order",cardinality:"one_to_many",sourceLabel:"订单",targetLabel:"客户",relationMappings:[{relationId}]}],
  };
}

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);
  request.method=method;
  request.url=path;
  request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};
  request.socket={remoteAddress:"127.0.0.1"};
  let raw="";
  const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);
  return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
