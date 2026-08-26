import assert from "node:assert/strict";
import test from "node:test";
import { retrieveKnowledge } from "../src/knowledge-retrieval.mjs";
import { applyIntentClarification, parseQueryIntent } from "../src/query-intent.mjs";
import { queryResultContractValidation } from "../src/query-scope-coverage.mjs";
import { guardSql } from "../src/sql-guard.mjs";

const tables=[
  {tableName:"alpha_crm_clue",comment:"CRM线索主表",grade:"A",active:1},
  {tableName:"alpha_clue_order_rel",comment:"线索成单订单关系",grade:"A",active:1},
  {tableName:"alpha_crm_clue_seller_rel",comment:"线索销售归属",grade:"A",active:1},
  {tableName:"seller",comment:"销售人员",grade:"A",active:1},
  {tableName:"feed_action",comment:"销售动态日志",grade:"A",active:1},
  {tableName:"business_opportunity",comment:"CRM商机",grade:"A",active:1},
  {tableName:"sales_process_clue_snapshot",comment:"线索处理快照",grade:"A",active:1},
  {tableName:"clue_stage_history",comment:"线索阶段变更历史",grade:"A",active:1},
];

const columnsByTable={
  alpha_crm_clue:[
    {columnName:"id",comment:"线索主键",isPrimary:1},
    {columnName:"clue_id",comment:"线索业务ID",isUnique:1},
    {columnName:"channel_id",comment:"渠道ID"},
    {columnName:"base_id",comment:"动态基础ID"},
    {columnName:"clue_allot_seller_id",comment:"当前分配销售ID"},
    {columnName:"clue_create_time",comment:"线索创建时间"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ],
  alpha_clue_order_rel:[
    {columnName:"id",comment:"关系主键",isPrimary:1},
    {columnName:"crm_clue_id",comment:"CRM线索主键"},
    {columnName:"order_time",comment:"线索成单时间"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ],
  alpha_crm_clue_seller_rel:[
    {columnName:"clue_id",comment:"线索业务ID"},
    {columnName:"seller_id",comment:"销售ID"},
    {columnName:"created_by",comment:"关系记录创建人销售ID"},
    {columnName:"seller_name",comment:"销售姓名"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ],
  seller:[
    {columnName:"seller_alpha_id",comment:"销售ID",isPrimary:1},
    {columnName:"seller_alpha_name",comment:"销售姓名"},
    {columnName:"team_id",comment:"团队ID"},
  ],
  feed_action:[
    {columnName:"seller_alpha_id",comment:"操作销售ID"},
    {columnName:"base_id",comment:"动态基础ID"},
  ],
  business_opportunity:[{columnName:"clue_id",comment:"来源原始线索ID"},{columnName:"seller_id",comment:"当前商机负责人ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
  sales_process_clue_snapshot:[{columnName:"clue_id",comment:"线索ID"},{columnName:"seller_id",comment:"快照当前负责人ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
  clue_stage_history:[{columnName:"clue_id",comment:"线索ID"},{columnName:"seller_id",comment:"阶段变更当时负责人ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
};

const relations=[
  {id:101,fromTable:"alpha_clue_order_rel",fromCol:"crm_clue_id",toTable:"alpha_crm_clue",toCol:"id",status:"confirmed",confidence:.78},
  {id:102,fromTable:"alpha_crm_clue_seller_rel",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"clue_id",status:"confirmed",confidence:.79},
  {id:103,fromTable:"alpha_crm_clue_seller_rel",fromCol:"seller_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.56},
  // An equally short but semantically wrong current-owner route.
  {id:104,fromTable:"feed_action",fromCol:"seller_alpha_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.73},
  {id:105,fromTable:"feed_action",fromCol:"base_id",toTable:"alpha_crm_clue",toCol:"base_id",status:"confirmed",confidence:.55},
  // Confirmed does not mean semantically authorized for the ownership role.
  {id:106,fromTable:"alpha_crm_clue_seller_rel",fromCol:"created_by",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.99},
  {id:107,fromTable:"alpha_crm_clue_seller_rel",fromCol:"seller_id",toTable:"seller",toCol:"team_id",status:"confirmed",confidence:.99},
  {id:108,fromTable:"alpha_crm_clue_seller_rel",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"channel_id",status:"confirmed",confidence:.99},
  {id:109,fromTable:"business_opportunity",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"clue_id",status:"confirmed",confidence:.99},
  {id:110,fromTable:"business_opportunity",fromCol:"seller_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.99},
  {id:111,fromTable:"sales_process_clue_snapshot",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"clue_id",status:"confirmed",confidence:.99},
  {id:112,fromTable:"sales_process_clue_snapshot",fromCol:"seller_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.99},
  {id:113,fromTable:"clue_stage_history",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"clue_id",status:"confirmed",confidence:.99},
  {id:114,fromTable:"clue_stage_history",fromCol:"seller_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.99},
];

const ontologySchema={name:"sales_prod_v6",objectTypes:[
  {apiName:"crm_clue",displayName:"CRM线索",description:"CRM线索主对象，记录当前销售负责人归属",primaryKey:"id",properties:[
    {apiName:"id",displayName:"线索主键",description:"线索唯一主键",mapping:{table:"alpha_crm_clue",column:"id"}},
    {apiName:"clue_id",displayName:"线索业务ID",description:"线索业务标识",mapping:{table:"alpha_crm_clue",column:"clue_id"}},
    {apiName:"channel_id",displayName:"渠道ID",description:"线索渠道标识",mapping:{table:"alpha_crm_clue",column:"channel_id"}},
    {apiName:"clue_allot_seller_id",displayName:"当前分配销售ID",description:"当前负责跟进线索的销售人员ID",mapping:{table:"alpha_crm_clue",column:"clue_allot_seller_id"}},
  ]},
  {apiName:"orange_army_seller",displayName:"销售人员",description:"负责跟进线索的销售人员",primaryKey:"seller_id",properties:[
    {apiName:"seller_id",displayName:"销售ID",description:"销售人员唯一标识",mapping:{table:"seller",column:"seller_alpha_id"}},
    {apiName:"seller_name",displayName:"销售姓名",description:"销售人员可读姓名",mapping:{table:"seller",column:"seller_alpha_name"}},
    {apiName:"team_id",displayName:"团队ID",description:"销售所属团队标识",mapping:{table:"seller",column:"team_id"}},
  ]},
  {apiName:"crm_clue_seller_rel",displayName:"线索销售归属",description:"维护线索与销售人员的归属关系",primaryKey:"clue_id",properties:[
    {apiName:"clue_id",displayName:"线索ID",description:"被分配的线索业务ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"clue_id"}},
    {apiName:"seller_id",displayName:"负责销售ID",description:"当前负责跟进该线索的销售人员ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"seller_id"}},
    {apiName:"created_by",displayName:"创建人销售ID",description:"创建这条归属记录的操作人员ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"created_by"}},
    {apiName:"is_deleted",displayName:"逻辑删除",description:"归属关系有效记录标记",mapping:{table:"alpha_crm_clue_seller_rel",column:"is_deleted"}},
  ]},
  {apiName:"crm_clue_feed_action",displayName:"线索销售跟进动态",description:"记录当前销售跟进线索的操作事实",primaryKey:"base_id",properties:[
    {apiName:"base_id",displayName:"线索ID",description:"关联的线索业务ID",mapping:{table:"feed_action",column:"base_id"}},
    {apiName:"seller_id",displayName:"操作销售ID",description:"执行操作的销售人员ID",mapping:{table:"feed_action",column:"seller_alpha_id"}},
  ]},
  {apiName:"business_opportunity",displayName:"CRM商机",description:"由原始线索转化而来的销售商机",primaryKey:"clue_id",properties:[
    {apiName:"clue_id",displayName:"来源原始线索ID",description:"商机转化来源的原始线索ID",mapping:{table:"business_opportunity",column:"clue_id"}},
    {apiName:"seller_id",displayName:"负责销售ID",description:"当前负责跟进该商机的销售人员ID",mapping:{table:"business_opportunity",column:"seller_id"}},
    {apiName:"is_deleted",displayName:"逻辑删除",mapping:{table:"business_opportunity",column:"is_deleted"}},
  ]},
  {apiName:"sales_process_clue_snapshot",displayName:"线索处理快照",description:"保存线索处理流程的历史快照",primaryKey:"clue_id",properties:[
    {apiName:"clue_id",displayName:"线索ID",mapping:{table:"sales_process_clue_snapshot",column:"clue_id"}},
    {apiName:"seller_id",displayName:"负责销售ID",description:"快照中的当前负责跟进该线索的销售人员ID",mapping:{table:"sales_process_clue_snapshot",column:"seller_id"}},
    {apiName:"is_deleted",displayName:"逻辑删除",mapping:{table:"sales_process_clue_snapshot",column:"is_deleted"}},
  ]},
  {apiName:"clue_stage_history",displayName:"线索阶段历史",description:"记录线索阶段变更历史",primaryKey:"clue_id",properties:[
    {apiName:"clue_id",displayName:"线索ID",mapping:{table:"clue_stage_history",column:"clue_id"}},
    {apiName:"seller_id",displayName:"当时销售ID",description:"阶段变更当时负责该线索的销售人员ID",mapping:{table:"clue_stage_history",column:"seller_id"}},
    {apiName:"is_deleted",displayName:"逻辑删除",mapping:{table:"clue_stage_history",column:"is_deleted"}},
  ]},
],linkTypes:[]};

const policy={
  allowedTables:tables.map((item)=>item.tableName),
  allowedColumns:Object.fromEntries(Object.entries(columnsByTable).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),
  allowedRelations:relations,
  maxRows:500,
};

function currentOwnerFixture({fixtureColumns=columnsByTable,question="本月线索，销售成单排行"}={}) {
  const base=parseQueryIntent(question,{now:new Date(2026,7,25)});
  const intent=applyIntentClarification(base,"当前负责人");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:fixtureColumns,relations,intent,ontologySchema,maxTables:10});
  const fixturePolicy={...policy,allowedColumns:Object.fromEntries(Object.entries(fixtureColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)]))};
  const check=(sql)=>{
    const verdict=guardSql(sql,fixturePolicy);
    assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:fixtureColumns});
  };
  return {intent,retrieval,check};
}

test("sales ranking contract carries current-owner ontology evidence through retrieval guard and SQL lineage",()=>{
  const {retrieval,check}=currentOwnerFixture();
  const dimension=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.equal(dimension.covered,true,"broad current/seller prose on activity objects must not create an attribution-role ambiguity");
  assert.deepEqual(dimension.bindingRelationIds,[103,102]);
  assert.equal(dimension.bindingRelationIds.some((id)=>[106,107,108,109,110,111,112,113,114].includes(id)),false,"audit columns, non-identity endpoints, another subject and temporal snapshots cannot enter the ownership binding");
  assert.deepEqual(dimension.paths,[["seller","alpha_crm_clue_seller_rel","alpha_crm_clue"]]);
  assert.deepEqual(dimension.bindingValidityPredicates,[{column:"alpha_crm_clue_seller_rel.is_deleted",operator:"=",valueType:"number",value:"0"}]);
  assert.deepEqual(retrieval.diagnostics.facets.find((item)=>item.kind==="subject").executionValidityPredicates,[{column:"alpha_crm_clue.is_deleted",operator:"=",valueType:"number",value:"0"}]);
  assert.deepEqual(retrieval.diagnostics.facets.find((item)=>item.kind==="time").executionValidityPredicates,[{column:"alpha_clue_order_rel.is_deleted",operator:"=",valueType:"number",value:"0"}]);

  const sql=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller s ON s.seller_alpha_id=csr.seller_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  const valid=check(sql);
  assert.equal(valid.ok,true,JSON.stringify(valid.errors));

  const joinOnValidity=check(sql
    .replace(" AND csr.is_deleted=0\nGROUP BY","\nGROUP BY")
    .replace("JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id","JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id AND csr.is_deleted=0"));
  assert.equal(joinOnValidity.ok,true,JSON.stringify(joinOnValidity.errors));

  const missingValidity=check(sql.replace(" AND csr.is_deleted=0",""));
  assert.ok(missingValidity.errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH"));

  const missingClueValidity=check(sql.replace(" AND c.is_deleted=0",""));
  assert.ok(missingClueValidity.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));

  const missingOrderValidity=check(sql.replace("  AND o.is_deleted=0", " "));
  assert.ok(missingOrderValidity.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));

  const wrongPath=check(sql
    .replace("JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id\nJOIN seller s ON s.seller_alpha_id=csr.seller_id","JOIN feed_action f ON f.base_id=c.base_id\nJOIN seller s ON s.seller_alpha_id=f.seller_alpha_id")
    .replace(" AND csr.is_deleted=0",""));
  assert.ok(wrongPath.errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH"));
});

test("current-owner binding rejects audit columns and non-identity relation endpoints",()=>{
  const base=parseQueryIntent("本月线索，销售成单排行",{now:new Date(2026,7,25)});
  const intent=applyIntentClarification(base,"当前负责人");
  const retrieve=(scopedRelations)=>retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations:scopedRelations,intent,ontologySchema,maxTables:10});
  const createdByOnly=retrieve(relations.filter((relation)=>relation.id!==103&&relation.id!==107));
  assert.ok(createdByOnly.coverageContract.missing.includes("dimension:seller"),"created_by → seller identity must not impersonate current seller_id");
  assert.deepEqual(createdByOnly.diagnostics.facets.find((item)=>item.key==="dimension:seller").bindingRelationIds,[]);
  const wrongDimensionEndpoint=retrieve(relations.filter((relation)=>relation.id!==103&&relation.id!==106));
  assert.ok(wrongDimensionEndpoint.coverageContract.missing.includes("dimension:seller"),"seller_id → seller.team_id must not impersonate seller identity");
  const wrongSubjectEndpoint=retrieve(relations.filter((relation)=>relation.id!==102));
  assert.ok(wrongSubjectEndpoint.coverageContract.missing.includes("dimension:seller"),"clue_id → clue.channel_id must not impersonate clue identity");
  const opportunityOwner=retrieve(relations.filter((relation)=>new Set([109,110]).has(relation.id)));
  assert.ok(opportunityOwner.coverageContract.missing.includes("dimension:seller"),"an opportunity owner linked to its source clue is not the clue owner");
  const columnsWithoutCurrentValidity={...columnsByTable,alpha_crm_clue_seller_rel:[
    ...columnsByTable.alpha_crm_clue_seller_rel.filter((column)=>!new Set(["is_deleted","is_current","is_valid"]).has(column.columnName)),
    {columnName:"status",comment:"当前有效状态"},{columnName:"enabled",comment:"是否启用"},
  ]};
  const noCurrentValidity=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:columnsWithoutCurrentValidity,relations,intent,ontologySchema,maxTables:10});
  assert.ok(noCurrentValidity.coverageContract.missing.includes("dimension:seller"),"status/enabled names and comments must not be guessed as a lifecycle invariant");
  const columnsWithExactValidity={...columnsWithoutCurrentValidity,alpha_crm_clue_seller_rel:[
    ...columnsWithoutCurrentValidity.alpha_crm_clue_seller_rel,
    {columnName:"is_valid",comment:""},
  ]};
  const exactValidity=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:columnsWithExactValidity,relations,intent,ontologySchema,maxTables:10});
  const exactDimension=exactValidity.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.equal(exactDimension?.covered,true,"the exact is_valid lifecycle column is executable without prose guessing");
  assert.deepEqual(exactDimension?.bindingValidityPredicates,[{column:"alpha_crm_clue_seller_rel.is_valid",operator:"=",valueType:"number",value:"1"}]);
  const activeOnlySchema=structuredClone(ontologySchema);activeOnlySchema.objectTypes.find((object)=>object.apiName==="crm_clue_seller_rel").properties.find((property)=>property.apiName==="seller_id").description="active seller identity for this clue ownership";
  const activeOnly=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,intent,ontologySchema:activeOnlySchema,maxTables:10});
  assert.ok(activeOnly.coverageContract.missing.includes("dimension:seller"),"bare active is not a current-owner declaration");
});

test("sales ranking closes the row domain against join, predicate, having and conditional-aggregate drift",()=>{
  const {check}=currentOwnerFixture();
  const sql=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller s ON s.seller_alpha_id=csr.seller_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;

  const leftAttribution=check(sql.replace("JOIN alpha_crm_clue_seller_rel csr","LEFT JOIN alpha_crm_clue_seller_rel csr"));
  assert.ok(leftAttribution.errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));

  const extraJoin=check(sql.replace(
    "JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id",
    "JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id\nJOIN feed_action f ON f.base_id=c.base_id",
  ));
  assert.ok(extraJoin.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraJoin.errors));

  const extraWhere=check(sql.replace(" AND c.is_deleted=0"," AND c.is_deleted=0 AND c.id > 999"));
  assert.ok(extraWhere.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraWhere.errors));

  const extraJoinPredicate=check(sql.replace("JOIN alpha_crm_clue c ON c.id=o.crm_clue_id","JOIN alpha_crm_clue c ON c.id=o.crm_clue_id AND c.id > 999"));
  assert.ok(extraJoinPredicate.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraJoinPredicate.errors));

  const extraHaving=check(sql.replace("GROUP BY s.seller_alpha_id,s.seller_alpha_name","GROUP BY s.seller_alpha_id,s.seller_alpha_name\nHAVING COUNT(DISTINCT c.id) > 1"));
  assert.ok(extraHaving.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraHaving.errors));

  const conditionalAggregate=check(sql.replace("COUNT(DISTINCT c.id)","COUNT(DISTINCT CASE WHEN c.id > 999 THEN c.id END)"));
  assert.ok(conditionalAggregate.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(conditionalAggregate.errors));

  const transformedGrain=check(sql.replace("COUNT(DISTINCT c.id)","COUNT(DISTINCT MOD(c.id, 10))"));
  assert.ok(transformedGrain.errors.some((item)=>item.code==="INTENT_MEASURE_EXPRESSION_MISMATCH"),JSON.stringify(transformedGrain.errors));

  const transformedLabel=check(sql
    .replace("s.seller_alpha_name AS seller_name","LEFT(s.seller_alpha_name, 1) AS seller_name")
    .replace("s.seller_alpha_id,s.seller_alpha_name","s.seller_alpha_id,LEFT(s.seller_alpha_name, 1)"));
  assert.ok(transformedLabel.errors.some((item)=>item.code==="INTENT_DIMENSION_LABEL_MISSING"||item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(transformedLabel.errors));

  const labelOnly=check(sql
    .replace("s.seller_alpha_id AS seller_id,\n       ","")
    .replace("s.seller_alpha_id,s.seller_alpha_name","s.seller_alpha_name"));
  assert.ok(labelOnly.errors.some((item)=>item.code==="INTENT_DIMENSION_IDENTITY_MISSING"),JSON.stringify(labelOnly.errors));

  const wrappedOrder=check(sql.replace("ORDER BY win_clue_count DESC","ORDER BY -COUNT(DISTINCT c.id) DESC"));
  assert.ok(wrappedOrder.errors.some((item)=>item.code==="INTENT_RANKING_ORDER_MISMATCH"),JSON.stringify(wrappedOrder.errors));
});

test("current-owner ranking enforces exact is_valid on its dimension endpoint without lifecycle scope pollution",()=>{
  const fixtureColumns={
    ...columnsByTable,
    seller:[
      ...columnsByTable.seller,
      {columnName:"is_valid",comment:""},
      {columnName:"status",comment:"有效状态"},
      {columnName:"enabled",comment:"是否启用"},
    ],
    feed_action:[...columnsByTable.feed_action,{columnName:"is_valid",comment:"动态记录有效标记"}],
  };
  const {retrieval,check}=currentOwnerFixture({fixtureColumns});
  const dimension=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.deepEqual(dimension.executionTables,["seller"],"the selected dimension endpoint must enter the execution contract");
  assert.ok(dimension.executionValidityPredicates.some((item)=>item.column==="seller.is_valid"&&item.value==="1"));
  assert.equal(dimension.executionValidityPredicates.some((item)=>/feed_action|\.status$|\.enabled$/.test(item.column)),false,"unselected tables and fuzzy lifecycle names cannot expand the contract");
  const sql=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller s ON s.seller_alpha_id=csr.seller_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0 AND s.is_valid=1
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  assert.equal(check(sql).ok,true);
  const missingSellerValidity=check(sql.replace(" AND s.is_valid=1",""));
  assert.ok(missingSellerValidity.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"),JSON.stringify(missingSellerValidity.errors));
  const invalidSeller=check(sql.replace("s.is_valid=1","s.is_valid=0"));
  assert.ok(invalidSeller.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"),JSON.stringify(invalidSeller.errors));
  const unrelatedValidity=check(sql.replace(
    "JOIN seller s ON s.seller_alpha_id=csr.seller_id",
    "JOIN seller s ON s.seller_alpha_id=csr.seller_id\nJOIN feed_action f ON f.base_id=c.base_id AND f.is_valid=1",
  ));
  assert.ok(unrelatedValidity.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(unrelatedValidity.errors));
});

test("organization filters remain closed-world and bind the exact value to the organization field",()=>{
  const fixtureColumns={...columnsByTable,alpha_crm_clue:[...columnsByTable.alpha_crm_clue,{columnName:"organization_name",comment:"线索所属机构名称"}]};
  const {intent,check}=currentOwnerFixture({fixtureColumns,question:"北京盈科律师事务所本月线索销售成单排行"});
  const organization=intent.filters.find((item)=>item.kind==="organization_name")?.value;
  assert.ok(organization);
  const sql=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller s ON s.seller_alpha_id=csr.seller_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND c.organization_name LIKE '%${organization}%'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  assert.equal(check(sql).ok,true,JSON.stringify(check(sql).errors));

  const wrongField=check(sql.replace("c.organization_name", "s.seller_alpha_name"));
  assert.ok(wrongField.errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"),JSON.stringify(wrongField.errors));
  const extraPredicate=check(sql.replace(" AND c.is_deleted=0", " AND c.is_deleted=0 AND c.id > 999"));
  assert.ok(extraPredicate.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraPredicate.errors));
  const extraHaving=check(sql.replace("GROUP BY s.seller_alpha_id,s.seller_alpha_name", "GROUP BY s.seller_alpha_id,s.seller_alpha_name HAVING COUNT(DISTINCT c.id)>1"));
  assert.ok(extraHaving.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraHaving.errors));
  const extraConditional=check(sql.replace("COUNT(DISTINCT c.id)", "COUNT(DISTINCT CASE WHEN c.id>999 THEN c.id END)"));
  assert.ok(extraConditional.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(extraConditional.errors));
});

test("sales ranking rejects a correct-path decoy, a competing seller edge and dead CTE relation evidence",()=>{
  const {check}=currentOwnerFixture();
  const dualAlias=`SELECT wrong_s.seller_alpha_id AS seller_id,
       wrong_s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller current_s ON current_s.seller_alpha_id=csr.seller_id
JOIN feed_action f ON f.base_id=c.base_id
JOIN seller wrong_s ON wrong_s.seller_alpha_id=f.seller_alpha_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0
GROUP BY wrong_s.seller_alpha_id,wrong_s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  assert.ok(check(dualAlias).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));

  const competingEdge=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN alpha_crm_clue_seller_rel csr ON csr.clue_id=c.clue_id
JOIN seller s ON s.seller_alpha_id=csr.seller_id
JOIN feed_action f ON f.base_id=c.base_id AND f.seller_alpha_id=s.seller_alpha_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0 AND csr.is_deleted=0
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  assert.ok(check(competingEdge).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));

  const deadCte=`WITH unused_current_owner AS (
  SELECT s0.seller_alpha_id
  FROM alpha_crm_clue c0
  JOIN alpha_crm_clue_seller_rel csr0 ON csr0.clue_id=c0.clue_id
  JOIN seller s0 ON s0.seller_alpha_id=csr0.seller_id
  WHERE c0.is_deleted=0 AND csr0.is_deleted=0
)
SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS win_clue_count
FROM alpha_clue_order_rel o
JOIN alpha_crm_clue c ON c.id=o.crm_clue_id
JOIN feed_action f ON f.base_id=c.base_id
JOIN seller s ON s.seller_alpha_id=f.seller_alpha_id
WHERE o.order_time >= '2026-08-01' AND o.order_time < '2026-09-01'
  AND o.is_deleted=0 AND c.is_deleted=0
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY win_clue_count DESC LIMIT 50`;
  assert.ok(check(deadCte).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH"));
});

test("event-time owner cannot reuse current, snapshot, or stage-history roles without a completion-event binding",()=>{
  const base=parseQueryIntent("本月线索，销售成单排行",{now:new Date(2026,7,25)});
  const intent=applyIntentClarification(base,"事件发生时负责人");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,intent,ontologySchema,maxTables:10});
  const dimension=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.equal(dimension.attribution,"event_time");
  assert.equal(dimension.covered,false);
  assert.ok(retrieval.coverageContract.missing.includes("dimension:seller"));
  assert.deepEqual(dimension.bindingRelationIds,[]);
});
