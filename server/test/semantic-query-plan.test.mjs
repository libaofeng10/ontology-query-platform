import assert from "node:assert/strict";
import test from "node:test";
import { guardSql } from "../src/sql-guard.mjs";
import { compileSemanticQueryPlan, semanticPlanningView, validateSemanticQueryPlan } from "../src/semantic-query-plan.mjs";

const schema={
  name:"commerce",displayName:"交易语义模型",objectTypes:[
    {apiName:"customer",displayName:"客户",primaryKey:"id",properties:[
      {apiName:"id",displayName:"客户标识",type:"integer",required:true,constraints:{},mapping:{table:"warehouse_customer",column:"customer_pk"}},
      {apiName:"segment",displayName:"客户分层",type:"enum",required:false,constraints:{enumValues:["vip","standard"]},mapping:{table:"warehouse_customer",column:"segment_code"}},
      {apiName:"phone",displayName:"手机号",type:"string",required:false,constraints:{},mapping:{table:"warehouse_customer",column:"phone_cipher"}},
      {apiName:"nickname",displayName:"客户昵称",type:"string",required:false,constraints:{},mapping:{table:"warehouse_customer",column:"nickname"}},
    ]},
    {apiName:"order",displayName:"订单",primaryKey:"id",properties:[
      {apiName:"id",displayName:"订单标识",type:"integer",required:true,constraints:{},mapping:{table:"fact_order",column:"order_pk"}},
      {apiName:"customer_id",displayName:"所属客户",type:"integer",required:true,constraints:{},mapping:{table:"fact_order",column:"buyer_fk"}},
      {apiName:"amount",displayName:"订单金额",type:"number",required:true,constraints:{minimum:0},mapping:{table:"fact_order",column:"gross_amount"}},
      {apiName:"paid_at",displayName:"支付时间",type:"datetime",required:false,constraints:{},mapping:{table:"fact_order",column:"paid_timestamp"}},
    ]},
  ],linkTypes:[{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationMappings:[{relationId:9}]}],
};
const catalog={
  tables:[{tableName:"warehouse_customer",grade:"A",active:1},{tableName:"fact_order",grade:"A",active:1}],
  columnsByTable:{
    warehouse_customer:[{columnName:"customer_pk",isSensitive:0},{columnName:"segment_code",isSensitive:0},{columnName:"phone_cipher",isSensitive:1},{columnName:"nickname",isSensitive:0}],
    fact_order:[{columnName:"order_pk",isSensitive:0},{columnName:"buyer_fk",isSensitive:0},{columnName:"gross_amount",isSensitive:0},{columnName:"paid_timestamp",isSensitive:0}],
  },
  relations:[{id:9,fromTable:"fact_order",fromCol:"buyer_fk",toTable:"warehouse_customer",toCol:"customer_pk",status:"confirmed"}],
  enums:{"warehouse_customer.segment_code":["vip","standard"]},
};

test("semantic Query Plan validates object properties and deterministically compiles confirmed paths",()=>{
  const plan={
    rootObject:"customer",
    dimensions:[{property:"customer.segment",alias:"segment"}],
    metrics:[{aggregation:"sum",property:"order.amount",alias:"revenue"}],
    filters:[{property:"customer.segment",operator:"eq",value:"vip"}],
    timeDimension:{property:"order.paid_at",grain:"month",alias:"paid_month"},
    orderBy:[{field:"revenue",direction:"desc"}],limit:250,
  };
  const validation=validateSemanticQueryPlan(plan,schema);
  assert.equal(validation.ok,true,JSON.stringify(validation.errors));
  const compiled=compileSemanticQueryPlan(plan,{schema,catalog,maxRows:100});
  assert.match(compiled.sql,/FROM `warehouse_customer` AS t0/);
  assert.match(compiled.sql,/JOIN `fact_order` AS t1 ON t1\.`buyer_fk` = t0\.`customer_pk`/);
  assert.match(compiled.sql,/SUM\(t1\.`gross_amount`\) AS `revenue`/);
  assert.match(compiled.sql,/LIMIT 100$/);
  assert.deepEqual(compiled.semanticPath.links,["customer_orders"]);
  assert.deepEqual(compiled.semanticPath.objects,["customer","order"]);
  const verdict=guardSql(compiled.sql,compiled.policy);
  assert.equal(verdict.ok,true,verdict.reason);
});

test("planning view hides physical mappings while every mapped property remains queryable",()=>{
  const view=JSON.stringify(semanticPlanningView(schema,catalog));
  assert.doesNotMatch(view,/warehouse_customer|fact_order|customer_pk|buyer_fk/);
  assert.match(view,/"apiName":"phone".*"semanticKind":"phone"/);
  const invalid=validateSemanticQueryPlan({rootObject:"customer",dimensions:[{property:"customer.missing",alias:"missing"}],metrics:[],filters:[],orderBy:[]},schema);
  assert.equal(invalid.ok,false);
  assert.ok(invalid.errors.some((item)=>item.code==="QUERY_PLAN_PROPERTY_NOT_FOUND"));
  const output=compileSemanticQueryPlan({rootObject:"customer",dimensions:[{property:"customer.phone",alias:"phone"}],metrics:[],filters:[],orderBy:[]},{schema,catalog,maxRows:100});
  assert.match(output.sql,/phone_cipher/);
  const filtered=compileSemanticQueryPlan({rootObject:"customer",dimensions:[{property:"customer.id",alias:"customer_id"}],metrics:[],filters:[{property:"customer.phone",operator:"eq",value:"13774665233"}],orderBy:[]},{schema,catalog,maxRows:100});
  const verdict=guardSql(filtered.sql,{...filtered.policy,valueKinds:[{value:"13774665233",kind:"phone"}]});
  assert.equal(verdict.ok,true,verdict.reason);assert.match(verdict.sql,/13774665233/);
  assert.doesNotThrow(()=>compileSemanticQueryPlan({rootObject:"customer",dimensions:[{property:"customer.id",alias:"customer_id"}],metrics:[],filters:[{property:"customer.phone",operator:"contains",value:"137"}],orderBy:[]},{schema,catalog,maxRows:100}));
});

test("filter literals escape backslashes and quotes so values cannot break out of the string",()=>{
  const plan={rootObject:"customer",dimensions:[{property:"customer.nickname",alias:"nickname"}],metrics:[],filters:[{property:"customer.nickname",operator:"eq",value:"abc\\"}],orderBy:[]};
  const compiled=compileSemanticQueryPlan(plan,{schema,catalog,maxRows:100});
  assert.match(compiled.sql,/= 'abc\\\\'/);
  const quoted=compileSemanticQueryPlan({...plan,filters:[{property:"customer.nickname",operator:"contains",value:"o'brien"}]},{schema,catalog,maxRows:100});
  assert.match(quoted.sql,/LIKE '%o''brien%'/);
});

test("subtypes inherit properties and links while mandatory discriminators are compiled and guarded",()=>{
  const subtypeSchema=structuredClone(schema);
  subtypeSchema.objectTypes.push({apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",primaryKey:"id",discriminator:{property:"segment",values:["vip"]},properties:[]});
  subtypeSchema.linkTypes[0].inverseApiName="order_belongs_to_customer";
  subtypeSchema.linkTypes[0].inverseDisplayName="订单所属客户";
  const plan={rootObject:"vip_customer",dimensions:[{property:"vip_customer.segment",alias:"segment"}],metrics:[{aggregation:"sum",property:"order.amount",alias:"revenue"}],filters:[],orderBy:[]};
  const validation=validateSemanticQueryPlan(plan,subtypeSchema);
  assert.equal(validation.ok,true,JSON.stringify(validation.errors));
  const compiled=compileSemanticQueryPlan(plan,{schema:subtypeSchema,catalog,maxRows:100,ontologySchemaVersion:7});
  assert.match(compiled.sql,/WHERE t0\.`segment_code` = 'vip'/);
  assert.deepEqual(compiled.policy.mandatoryFilters.map((item)=>item.object),["vip_customer"]);
  assert.deepEqual(compiled.semanticContract,{
    version:"semantic-row-domain-v1",ontologySchemaVersion:7,rootObject:"vip_customer",immutable:true,
    rowDomainSlots:[{
      id:"ontology:7:vip_customer:discriminator:vip_customer:warehouse_customer.segment_code",
      kind:"semantic_row_domain",role:"ontology_subtype_discriminator",required:true,immutable:true,source:"published_ontology",
      ontologySchemaVersion:7,rootObject:"vip_customer",object:"vip_customer",owner:"vip_customer",table:"warehouse_customer",column:"segment_code",
      columns:["warehouse_customer.segment_code"],operator:"eq",values:[{value:"vip",valueType:"string"}],
    }],
  });
  assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
  const unsafe=compiled.sql.replace(/WHERE[^\n]+\n/,"");
  assert.match(guardSql(unsafe,compiled.policy).reason,/缺少子类型 vip_customer/);
  const view=semanticPlanningView(subtypeSchema,catalog);
  const child=view.objectTypes.find((item)=>item.apiName==="vip_customer");
  assert.equal(child.parent,"customer");
  assert.ok(child.properties.some((item)=>item.apiName==="id"&&item.inherited));
  assert.equal(view.linkTypes[0].inverseApiName,"order_belongs_to_customer");
  const restated=compileSemanticQueryPlan({...plan,filters:[{property:"vip_customer.segment",operator:"eq",value:"vip"}]},{schema:subtypeSchema,catalog,maxRows:100,ontologySchemaVersion:7});
  assert.equal((restated.sql.match(/segment_code` = 'vip'/g)||[]).length,1);
});

test("subtype query plans reject contradictory filters and mixed parent-child references",()=>{
  const subtypeSchema=structuredClone(schema);
  subtypeSchema.objectTypes.push({apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",primaryKey:"id",discriminator:{property:"segment",values:["vip"]},properties:[]});
  const conflict=validateSemanticQueryPlan({rootObject:"vip_customer",dimensions:["vip_customer.id"],metrics:[],filters:[{property:"vip_customer.segment",operator:"eq",value:"standard"}],orderBy:[]},subtypeSchema);
  assert.ok(conflict.errors.some((item)=>item.code==="QUERY_PLAN_DISJOINT_CONFLICT"));
  const mixed=validateSemanticQueryPlan({rootObject:"vip_customer",dimensions:["customer.id"],metrics:[],filters:[],orderBy:[]},subtypeSchema);
  assert.ok(mixed.errors.some((item)=>item.code==="QUERY_PLAN_HIERARCHY_MIXED"));
});

test("query plans reject disjoint sibling subtypes before compiling an impossible WHERE clause",()=>{
  const subtypeSchema=structuredClone(schema);
  subtypeSchema.objectTypes.push(
    {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]},
    {apiName:"standard_customer",displayName:"标准客户",parent:"customer",discriminator:{property:"segment",values:["standard"]},properties:[]},
  );
  const plan={rootObject:"order",dimensions:[{property:"vip_customer.id",alias:"vip_id"},{property:"standard_customer.id",alias:"standard_id"}],metrics:[],filters:[],orderBy:[]};
  const validation=validateSemanticQueryPlan(plan,subtypeSchema);
  assert.ok(validation.errors.some((item)=>item.code==="QUERY_PLAN_DISJOINT_CONFLICT"),JSON.stringify(validation.errors));
  assert.throws(()=>compileSemanticQueryPlan(plan,{schema:subtypeSchema,catalog,maxRows:100}),(error)=>error.code==="QUERY_PLAN_VALIDATION_FAILED"&&error.details.some((item)=>item.code==="QUERY_PLAN_DISJOINT_CONFLICT"));
});

test("query plans include intermediate path objects when enforcing the parent-child mixing limit",()=>{
  const subtypeSchema=structuredClone(schema);
  subtypeSchema.objectTypes.push(
    {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]},
    {apiName:"coupon",displayName:"优惠券",primaryKey:"id",properties:[{apiName:"id",displayName:"优惠券标识",type:"integer",required:true,constraints:{},mapping:{table:"coupon",column:"coupon_pk"}}]},
  );
  subtypeSchema.linkTypes.push({apiName:"vip_coupons",displayName:"VIP 优惠券",source:"vip_customer",target:"coupon",cardinality:"one_to_many",relationMappings:[{relationId:10}]});
  const plan={rootObject:"coupon",dimensions:[{property:"customer.nickname",alias:"nickname"}],metrics:[],filters:[],orderBy:[]};
  const validation=validateSemanticQueryPlan(plan,subtypeSchema);
  assert.ok(validation.errors.some((item)=>item.code==="QUERY_PLAN_HIERARCHY_MIXED"),JSON.stringify(validation.errors));
});

test("all contradictory discriminator filter operators are rejected",()=>{
  const subtypeSchema=structuredClone(schema);
  subtypeSchema.objectTypes.push({apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]});
  const cases=[
    {operator:"eq",value:"standard"},
    {operator:"in",value:["standard"]},
    {operator:"neq",value:"vip"},
    {operator:"not_in",value:["vip"]},
    {operator:"is_null"},
  ];
  for(const filter of cases) {
    const validation=validateSemanticQueryPlan({rootObject:"vip_customer",dimensions:["vip_customer.id"],metrics:[],filters:[{property:"vip_customer.segment",...filter}],orderBy:[]},subtypeSchema);
    assert.ok(validation.errors.some((item)=>item.code==="QUERY_PLAN_DISJOINT_CONFLICT"),`${filter.operator}: ${JSON.stringify(validation.errors)}`);
  }
});
