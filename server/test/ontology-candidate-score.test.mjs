import assert from "node:assert/strict";
import test from "node:test";
import {
  createLinkStableKey,
  createObjectStableKey,
  createOntologyCandidateScorer,
  routeOntologyCandidateScore,
  scoreOntologyCandidate,
} from "../src/ontology-candidate-score.mjs";

test("candidate routing has no gap at the 80 point boundary",()=>{
  assert.equal(routeOntologyCandidateScore({score:79}).status,"review_required");
  assert.equal(routeOntologyCandidateScore({score:80}).status,"auto_confirmed");
  assert.equal(routeOntologyCandidateScore({score:81}).status,"auto_confirmed");
  assert.equal(routeOntologyCandidateScore({score:90,forcedReviewReasons:["SENSITIVE_FIELD_MAPPING"]}).status,"review_required");
  assert.equal(routeOntologyCandidateScore({score:90,validationErrors:[{code:"x"}]}).status,"blocked");
  assert.equal(routeOntologyCandidateScore({score:100,mode:"review"}).status,"review_required");
});

test("object scoring is deterministic and ignores model self-confidence",()=>{
  const catalog=physicalCatalog();
  const candidate=objectCandidate();
  const first=scoreOntologyCandidate({...candidate,modelConfidence:.1},{sourceId:1,catalog,semanticSimilarity:.9,mode:"auto_draft"});
  const second=scoreOntologyCandidate({...candidate,modelConfidence:.99},{sourceId:1,catalog,semanticSimilarity:.9,mode:"auto_draft"});
  assert.equal(first.score,85);
  assert.equal(first.status,"auto_confirmed");
  assert.deepEqual(first.scoreBreakdown,second.scoreBreakdown);
  assert.equal(first.score,second.score);
  assert.equal(first.stableKey,"object:default:crm_customer");
});

test("v2 physical and knowledge dimensions are continuous",()=>{
  const catalog=physicalCatalog();catalog.tables[1].grade="B";
  const endpoints=acceptedEndpoints();
  const link=linkCandidate();link.evidence=[{kind:"knowledge_page",refId:"term:a",verified:true}];
  const one=scoreOntologyCandidate(link,{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9});
  assert.equal(one.scoreBreakdown.physicalMapping.score,31.5);assert.equal(one.scoreBreakdown.knowledgeEvidence.score,6);
  link.evidence.push({kind:"business_rule",refId:"rule:b",verified:true});
  const two=scoreOntologyCandidate(link,{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9});assert.equal(two.scoreBreakdown.knowledgeEvidence.score,8);
  link.evidence.push({kind:"gold_sql",refId:"gold:c",verified:true});
  const three=scoreOntologyCandidate(link,{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9});assert.equal(three.scoreBreakdown.knowledgeEvidence.score,10);
});

test("semantic critic flags force review without rejecting the candidate",()=>{
  const result=scoreOntologyCandidate({...objectCandidate(),semanticCriticFlagged:true},{sourceId:1,catalog:physicalCatalog(),semanticSimilarity:.9,mode:"auto_draft"});
  assert.equal(result.validation.ok,true);assert.equal(result.status,"review_required");assert.ok(result.forcedReviewReasons.includes("SEMANTIC_CRITIC_FLAGGED"));
});

test("confirmed object and property term bindings are authoritative during rescoring",()=>{
  const catalog=physicalCatalog();
  catalog.termAnchors=[
    {vocabulary:"corp",canonicalId:"CUSTOMER",prefLabelZh:"客户",kind:"object"},
    {vocabulary:"corp",canonicalId:"ACCOUNT",prefLabelZh:"账户",kind:"object"},
    {vocabulary:"corp",canonicalId:"NAME",prefLabelZh:"名称",kind:"property"},
    {vocabulary:"corp",canonicalId:"TITLE",prefLabelZh:"标题",kind:"property"},
  ];
  const base=objectCandidate().payload;base.termBinding={vocabulary:"corp",canonicalId:"CUSTOMER",match:"exact"};base.properties[1].termBinding={vocabulary:"corp",canonicalId:"NAME",match:"exact"};
  const objectChanged=objectCandidate();objectChanged.payload.termBinding={vocabulary:"corp",canonicalId:"ACCOUNT",match:"exact"};objectChanged.payload.properties[1].termBinding={vocabulary:"corp",canonicalId:"NAME",match:"exact"};
  const objectResult=scoreOntologyCandidate(objectChanged,{sourceId:1,catalog,baseSchema:{objectTypes:[base],linkTypes:[]},semanticSimilarity:.9,mode:"auto_draft"});
  assert.ok(objectResult.forcedReviewReasons.includes("TERM_BINDING_CONFLICT"));assert.equal(objectResult.status,"review_required");
  const propertyChanged=objectCandidate();propertyChanged.payload.termBinding={vocabulary:"corp",canonicalId:"CUSTOMER",match:"exact"};propertyChanged.payload.properties[1].termBinding={vocabulary:"corp",canonicalId:"TITLE",match:"exact"};
  const propertyResult=scoreOntologyCandidate(propertyChanged,{sourceId:1,catalog,baseSchema:{objectTypes:[base],linkTypes:[]},semanticSimilarity:.9,mode:"auto_draft"});
  assert.ok(propertyResult.forcedReviewReasons.includes("TERM_BINDING_CONFLICT"));assert.equal(propertyResult.status,"review_required");
});

test("manual disjoint groups force review when a candidate shares an undifferentiated row set",()=>{
  const baseSchema={objectTypes:[{apiName:"blocked_customer",displayName:"受限客户",primaryKey:"customer_id",properties:[{apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}}]}],linkTypes:[],disjointGroups:[["customer","blocked_customer"]]};
  const result=scoreOntologyCandidate(objectCandidate(),{sourceId:1,catalog:physicalCatalog(),baseSchema,semanticSimilarity:.9,mode:"auto_draft"});
  assert.ok(result.forcedReviewReasons.includes("EVIDENCE_CONFLICT"));assert.equal(result.status,"review_required");
});

test("sensitive mappings force review and invalid physical mappings are blocked",()=>{
  const catalog=physicalCatalog();
  catalog.columnsByTable.crm_customer[1].isSensitive=1;
  const sensitive=scoreOntologyCandidate(objectCandidate(),{sourceId:1,catalog,semanticSimilarity:.9});
  assert.equal(sensitive.score,79);
  assert.equal(sensitive.status,"review_required");
  assert.deepEqual(sensitive.forcedReviewReasons,["SENSITIVE_FIELD_MAPPING"]);
  assert.equal(sensitive.scoreBreakdown.riskAdjustment.score,-6);

  const invalid=objectCandidate();
  invalid.payload.properties[1].mapping.column="invented_column";
  const blocked=scoreOntologyCandidate(invalid,{sourceId:1,catalog,semanticSimilarity:.9});
  assert.equal(blocked.status,"blocked");
  assert.ok(blocked.validation.errors.some((item)=>item.code==="ONTOLOGY_MAPPING_COLUMN_NOT_FOUND"));
});

test("embedding outages degrade semantic points without blocking a valid candidate",async()=>{
  const scorer=createOntologyCandidateScorer({embedding:{baseUrl:"https://embed.test/v1",apiKey:"key",model:"embed-v1"},embed:async()=>{throw new Error("embedding unavailable");}});
  const result=await scorer.score(objectCandidate(),{sourceId:1,catalog:physicalCatalog(),mode:"auto_draft"});
  assert.equal(result.scoreBreakdown.semanticConsistency.score,0);
  assert.equal(result.scoreBreakdown.semanticConsistency.degradedReason,"embedding unavailable");
  assert.equal(result.status,"review_required");
  assert.match(result.scoringVersion,/embedding=embed-v1/);
});

test("semantic scoring uses the embedding model snapshotted by the generation run",async()=>{
  let calledModel=null;
  const scorer=createOntologyCandidateScorer({embedding:{baseUrl:"https://embed.test/v1",apiKey:"key",model:"changed-model"},embed:async(config)=>{calledModel=config.model;return [[1,0],[1,0]];}});
  const result=await scorer.score(objectCandidate(),{sourceId:1,catalog:physicalCatalog(),mode:"auto_draft",embeddingModel:"snapshot-model"});
  assert.equal(calledModel,"snapshot-model");assert.match(result.scoringVersion,/embedding=snapshot-model/);
});

test("review or rejected joins block Link candidates before score routing",()=>{
  const catalog=physicalCatalog();
  catalog.relations[0].status="review";
  const endpoints=acceptedEndpoints();
  const result=scoreOntologyCandidate(linkCandidate(),{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9});
  assert.equal(result.status,"blocked");
  assert.ok(result.validation.errors.some((item)=>item.code==="ONTOLOGY_RELATION_NOT_CONFIRMED"));
});

test("relationKind evidence exceptions force Link review even at a high score",()=>{
  const catalog=physicalCatalog();const endpoints=acceptedEndpoints();
  const contains=linkCandidate();contains.payload.relationKind="contains";contains.payload.cardinality="many_to_one";
  const containsResult=scoreOntologyCandidate(contains,{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9,mode:"auto_draft"});
  assert.equal(containsResult.status,"review_required");assert.ok(containsResult.forcedReviewReasons.includes("RELATION_KIND_EVIDENCE_MISMATCH"));
  const temporal=linkCandidate();temporal.payload.relationKind="temporal";
  const temporalResult=scoreOntologyCandidate(temporal,{sourceId:1,catalog,acceptedObjects:endpoints,semanticSimilarity:.9,mode:"auto_draft"});
  assert.equal(temporalResult.status,"review_required");assert.ok(temporalResult.forcedReviewReasons.includes("TEMPORAL_EVIDENCE_MISSING"));
});

test("stable keys ignore model names and normalize reverse Link candidates by physical direction",()=>{
  const first=objectCandidate().payload;
  const renamed=structuredClone(first);renamed.apiName="renamed_by_human";renamed.displayName="人工修订名称";
  assert.equal(createObjectStableKey({payload:first}),createObjectStableKey({payload:renamed}));

  const relation=physicalCatalog().relations[0];
  const customer="object:default:crm_customer";const order="object:default:sales_order";
  const forward=createLinkStableKey({relation,sourceStableKey:customer,targetStableKey:order,sourceTables:["crm_customer"],targetTables:["sales_order"]});
  const reverse=createLinkStableKey({relation,sourceStableKey:order,targetStableKey:customer,sourceTables:["sales_order"],targetTables:["crm_customer"]});
  assert.equal(forward,reverse);
  assert.equal(forward,`link:default:${order}:${relation.id}:${customer}`);
});

function objectCandidate() {
  return {candidateType:"object",sourceId:1,payload:{apiName:"customer",displayName:"客户",description:"客户主体",primaryKey:"customer_id",properties:[
    {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}},
    {apiName:"name",displayName:"客户名称",type:"string",required:true,mapping:{table:"crm_customer",column:"name"}},
  ]},evidence:[]};
}

function linkCandidate() {
  return {candidateType:"link",sourceId:1,payload:{apiName:"places_order",displayName:"客户下单",source:"customer",target:"order",cardinality:"one_to_many",relationKind:"references",relationMappings:[{relationId:7}]},evidence:[]};
}

function acceptedEndpoints() {
  return [
    {...objectCandidate(),id:"customer",stableKey:"object:default:crm_customer",status:"auto_confirmed"},
    {candidateType:"object",sourceId:1,id:"order",stableKey:"object:default:sales_order",status:"confirmed",payload:{apiName:"order",displayName:"订单",primaryKey:"order_id",properties:[
      {apiName:"order_id",displayName:"订单编号",type:"integer",required:true,mapping:{table:"sales_order",column:"order_id"}},
      {apiName:"customer_id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"sales_order",column:"customer_id"}},
    ]}},
  ];
}

function physicalCatalog() {
  return {sourceId:1,tables:[
    {sourceId:1,tableName:"crm_customer",grade:"A",active:1,comment:"客户主体"},
    {sourceId:1,tableName:"sales_order",grade:"A",active:1,comment:"销售订单"},
  ],columnsByTable:{
    crm_customer:[
      {sourceId:1,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0,comment:"客户编号"},
      {sourceId:1,tableName:"crm_customer",columnName:"name",dataType:"varchar",nullable:0,isPrimary:0,isUnique:0,isSensitive:0,comment:"客户名称"},
    ],
    sales_order:[
      {sourceId:1,tableName:"sales_order",columnName:"order_id",dataType:"bigint",nullable:0,isPrimary:1,isUnique:1,isSensitive:0,comment:"订单编号"},
      {sourceId:1,tableName:"sales_order",columnName:"customer_id",dataType:"bigint",nullable:0,isPrimary:0,isUnique:0,isSensitive:0,comment:"客户编号"},
    ],
  },relations:[{id:7,sourceId:1,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id",cardinality:"N:1",status:"confirmed",inferenceSource:"foreign_key"}]};
}

test("low field coverage on wide tables forces manual review",()=>{
  const catalog=physicalCatalog();
  // 把 crm_customer 扩成 10 个非敏感字段，候选仅映射 2 个 → 覆盖率 20% < 50%
  for(let index=0;index<8;index++)catalog.columnsByTable.crm_customer.push({sourceId:1,tableName:"crm_customer",columnName:`extra_${index}`,dataType:"varchar",nullable:1,isPrimary:0,isUnique:0,isSensitive:0,comment:""});
  const sparse=scoreOntologyCandidate(objectCandidate(),{sourceId:1,catalog,semanticSimilarity:.9,mode:"auto_draft"});
  assert.ok(sparse.forcedReviewReasons.includes("LOW_FIELD_COVERAGE"));
  assert.equal(sparse.status,"review_required");
  // 窄表（<8 字段）不触发
  const narrow=scoreOntologyCandidate(objectCandidate(),{sourceId:1,catalog:physicalCatalog(),semanticSimilarity:.9,mode:"auto_draft"});
  assert.ok(!narrow.forcedReviewReasons.includes("LOW_FIELD_COVERAGE"));
});
