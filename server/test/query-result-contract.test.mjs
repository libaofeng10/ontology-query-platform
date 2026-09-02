import assert from "node:assert/strict";
import test from "node:test";
import { applyIntentClarification, catalogFilterConcepts, knowledgeIntentConcepts, knowledgeIntentRowDomains, mergeContextualQueryIntent, parseQueryIntent } from "../src/query-intent.mjs";
import { retrieveKnowledge } from "../src/knowledge-retrieval.mjs";
import { queryResultContractValidation } from "../src/query-scope-coverage.mjs";
import { buildQueryResultContract, validateQueryRunSet } from "../src/query-result-contract.mjs";
import { guardSql } from "../src/sql-guard.mjs";
import { compileSemanticQueryPlan } from "../src/semantic-query-plan.mjs";

const tables=[
  {tableName:"lead_entity",comment:"线索主表"},
  {tableName:"deal_event",comment:"线索成单事件"},
  {tableName:"lead_owner_rel",comment:"线索销售负责人关系"},
];
const columnsByTable={
  lead_entity:[
    {columnName:"id",comment:"线索主键",isPrimary:1},
    {columnName:"created_at",comment:"线索进线时间"},
    {columnName:"allocated_owner_id",comment:"线索分配人ID"},
    {columnName:"is_won",comment:"是否赢单"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ],
  deal_event:[
    {columnName:"id",comment:"事件主键",isPrimary:1},
    {columnName:"lead_id",comment:"线索ID"},
    {columnName:"completed_at",comment:"订单成单时间"},
  ],
  lead_owner_rel:[
    {columnName:"lead_id",comment:"线索ID"},
    {columnName:"owner_id",comment:"当前负责销售ID"},
    {columnName:"owner_name",comment:"销售姓名"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ],
};
const relations=[
  {id:1,fromTable:"deal_event",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",status:"confirmed",confidence:1},
  {id:2,fromTable:"lead_owner_rel",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",status:"confirmed",confidence:1},
];
const policy={
  allowedTables:tables.map((item)=>item.tableName),
  allowedColumns:Object.fromEntries(Object.entries(columnsByTable).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),
  allowedRelations:relations,
  maxRows:100,
};

function fixture({clarified=true}={}) {
  let intent=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  if(clarified)intent=applyIntentClarification(intent,"按当前负责人统计");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  return {intent,retrieval};
}

function validate(sql,options) {
  const {intent,retrieval}=fixture(options);
  const verdict=guardSql(sql,policy);
  assert.equal(verdict.ok,true,verdict.reason);
  return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
}

const correctSql=`SELECT r.owner_id, MAX(r.owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_lead_count
FROM deal_event e
JOIN lead_entity l ON l.id = e.lead_id
JOIN lead_owner_rel r ON r.lead_id = l.id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted = 0 AND r.is_deleted = 0
GROUP BY r.owner_id
ORDER BY won_lead_count DESC
LIMIT 50`;

test("result contract accepts a ranking only when event time dimension label grain and ordering all align",()=>{
  const result=validate(correctSql);
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  assert.deepEqual(result.shape.whereColumns,["deal_event.completed_at","lead_entity.is_deleted","lead_owner_rel.is_deleted"]);
  assert.deepEqual(result.shape.aggregates.find((item)=>item.alias==="won_lead_count"),{name:"count",distinct:true,columns:["lead_entity.id"],alias:"won_lead_count"});
});

test("result contract blocks a correct join that binds the month to entity creation time",()=>{
  const wrong=correctSql.replaceAll("e.completed_at","l.created_at");
  const result=validate(wrong);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
});

test("result contract blocks physical row count when the business grain requires distinct entities",()=>{
  const wrong=correctSql.replace("COUNT(DISTINCT l.id)","COUNT(*)");
  const result=validate(wrong);
  assert.equal(result.ok,false);
  assert.ok(result.errors.some((item)=>item.code==="INTENT_MEASURE_MISMATCH"||item.code==="INTENT_MEASURE_GRAIN_MISMATCH"));
});

test("result contract blocks ID-only rankings and ordering by a dimension",()=>{
  const withoutLabel=correctSql.replace("r.owner_id, MAX(r.owner_name) AS owner_name, ","r.owner_id, ");
  const labelResult=validate(withoutLabel);
  assert.ok(labelResult.errors.some((item)=>item.code==="INTENT_DIMENSION_LABEL_MISSING"));
  const wrongOrder=correctSql.replace("ORDER BY won_lead_count DESC","ORDER BY r.owner_id DESC");
  const orderResult=validate(wrongOrder);
  assert.ok(orderResult.errors.some((item)=>item.code==="INTENT_RANKING_ORDER_MISMATCH"));
});

test("result contract requires material business ambiguities to be clarified before execution",()=>{
  const result=validate(correctSql,{clarified:false});
  assert.equal(result.ok,false);
  assert.equal(result.errors[0].code,"INTENT_CLARIFICATION_REQUIRED");
});

test("result contract does not let a pre-clarification attribution facet impersonate the clarified role",()=>{
  let intent=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  intent=applyIntentClarification(intent,"按成单时负责人统计");
  const retrieval={diagnostics:{facets:[
    {key:"dimension:seller",attribution:null,executionTables:["wrong_owner_rel"],executionColumns:["wrong_owner_rel.owner_id"],bindingTables:["wrong_owner_rel"],bindingColumns:["wrong_owner_rel.owner_id"],bindingRelationIds:[999]},
    {key:"dimension:seller",attribution:"event_time",executionTables:["deal_event"],executionColumns:["deal_event.closing_owner_id"],bindingTables:["deal_event"],bindingColumns:["deal_event.closing_owner_id"],bindingRelationIds:[1]},
  ]}};
  const dimension=buildQueryResultContract(intent,retrieval).slots.find((item)=>item.id==="dimension:seller");
  assert.deepEqual(dimension.tables,["deal_event"]);
  assert.deepEqual(dimension.bindingTables,["deal_event"]);
  assert.deepEqual(dimension.bindingRelationIds,[1]);
});

test("multi-product result runs enforce validity only for each run's active table",()=>{
  const accountTables=[{tableName:"account_alpha",comment:"Alpha账号"},{tableName:"account_gpt",comment:"GPT账号"}];
  const accountColumns={
    account_alpha:[{columnName:"id",comment:"账号ID",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    account_gpt:[{columnName:"id",comment:"账号ID",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const accountPolicy={allowedTables:accountTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(accountColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:[],maxRows:100};
  const intent=parseQueryIntent("查询所有账号情况");
  const retrieval={diagnostics:{facets:[{
    key:"subject:account",kind:"subject",required:true,covered:true,
    executionTables:["account_alpha","account_gpt"],executionColumns:["account_alpha.id","account_gpt.id"],
    executionValidityPredicates:[
      {column:"account_alpha.is_deleted",operator:"=",valueType:"number",value:"0"},
      {column:"account_gpt.is_deleted",operator:"=",valueType:"number",value:"0"},
    ],
  }]}};
  assert.equal(buildQueryResultContract(intent,retrieval).slots[0].executionValidityPredicates.length,2);
  const check=(sql)=>{const verdict=guardSql(sql,accountPolicy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:accountColumns});};
  assert.equal(check("SELECT a.id FROM account_alpha a WHERE a.is_deleted=0").ok,true);
  assert.equal(check("SELECT g.id FROM account_gpt g WHERE g.is_deleted=0").ok,true);
  assert.ok(check("SELECT a.id FROM account_alpha a").errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));
});

test("explicit Alpha and AlphaGPT scopes require server-proven coverage from both products",()=>{
  const productTables=[{tableName:"alpha_clue",comment:"Alpha线索"},{tableName:"alphagpt_clue",comment:"AlphaGPT线索"}];
  const productColumns={
    alpha_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    alphagpt_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const productPolicy={allowedTables:productTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(productColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:[],maxRows:100};
  const intent=parseQueryIntent("Alpha和AlphaGPT线索数量");
  assert.deepEqual(intent.scope.products,["alpha","alphaGpt"]);
  const retrieval={diagnostics:{facets:[
    {key:"subject:clue",kind:"subject",required:true,covered:true,executionTables:["alpha_clue","alphagpt_clue"],executionColumns:["alpha_clue.id","alphagpt_clue.id"],executionValidityPredicates:[{column:"alpha_clue.is_deleted",operator:"=",valueType:"number",value:"0"},{column:"alphagpt_clue.is_deleted",operator:"=",valueType:"number",value:"0"}]},
    {key:"measure:count",kind:"measure",required:true,covered:true,executionTables:["alpha_clue","alphagpt_clue"],executionColumns:["alpha_clue.id","alphagpt_clue.id"]},
    {key:"product:alpha",kind:"product",required:true,covered:true,executionTables:["alpha_clue"],executionColumns:["alpha_clue.id"]},
    {key:"product:alphaGpt",kind:"product",required:true,covered:true,executionTables:["alphagpt_clue"],executionColumns:["alphagpt_clue.id"]},
  ]}};
  const contract=buildQueryResultContract(intent,retrieval);
  const run=(sql)=>{const verdict=guardSql(sql,productPolicy);assert.equal(verdict.ok,true,verdict.reason);return {name:"untrusted model label",verdict,contractValidation:queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:productColumns})};};
  const alpha=run("SELECT COUNT(DISTINCT a.id) AS clue_count FROM alpha_clue a WHERE a.is_deleted=0");
  const gpt=run("SELECT COUNT(DISTINCT g.id) AS clue_count FROM alphagpt_clue g WHERE g.is_deleted=0");
  assert.equal(alpha.contractValidation.ok,true,JSON.stringify(alpha.contractValidation.errors));
  assert.equal(gpt.contractValidation.ok,true,JSON.stringify(gpt.contractValidation.errors));
  const incomplete=validateQueryRunSet(contract,[alpha]);
  assert.ok(incomplete.errors.some((item)=>item.code==="INTENT_PRODUCT_SCOPE_INCOMPLETE"),JSON.stringify(incomplete.errors));
  assert.equal(validateQueryRunSet(contract,[alpha,gpt]).ok,true);
  assert.ok(!alpha.contractValidation.coverage.productScopeIds.includes("product:alphaGpt"));
});

test("real multi-product retrieval binds subject measure and time for both products before run-set validation",()=>{
  const productTables=[{tableName:"alpha_clue",comment:"Alpha 线索"},{tableName:"alphagpt_clue",comment:"AlphaGPT 线索"}];
  const productColumns={
    alpha_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"created_at",comment:"线索创建时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
    alphagpt_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"created_at",comment:"线索创建时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const productPolicy={allowedTables:productTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(productColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:[],maxRows:100};
  const intent=parseQueryIntent("Alpha和AlphaGPT本月创建的线索数量",{now:new Date("2026-08-25T04:00:00Z"),timeZone:"Asia/Shanghai"});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:productTables,columnsByTable:productColumns,relations:[],intent,maxTables:8});
  const byKey=(key)=>retrieval.diagnostics.facets.find((facet)=>facet.key===key);
  assert.deepEqual(byKey("product:alpha")?.executionTables,["alpha_clue"]);
  assert.deepEqual(byKey("product:alphaGpt")?.executionTables,["alphagpt_clue"]);
  for(const key of ["subject:clue","measure:count","time:current_month"]) {
    assert.equal(byKey(key)?.covered,true,key);
    assert.deepEqual(byKey(key)?.productScopeIds,["product:alpha","product:alphaGpt"],key);
    assert.deepEqual(byKey(key)?.missingProductScopeIds,[],key);
  }
  assert.deepEqual(retrieval.coverageContract.missing,[]);

  const contract=buildQueryResultContract(intent,retrieval);
  const run=(sql)=>{const verdict=guardSql(sql,productPolicy);assert.equal(verdict.ok,true,verdict.reason);return {name:"模型标签不参与产品覆盖证明",verdict,contractValidation:queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:productColumns})};};
  const alpha=run("SELECT COUNT(DISTINCT a.id) AS clue_count FROM alpha_clue a WHERE a.created_at >= '2026-08-01' AND a.created_at < '2026-09-01' AND a.is_deleted = 0");
  const gpt=run("SELECT COUNT(DISTINCT g.id) AS clue_count FROM alphagpt_clue g WHERE g.created_at >= '2026-08-01' AND g.created_at < '2026-09-01' AND g.is_deleted = 0");
  assert.equal(alpha.contractValidation.ok,true,JSON.stringify(alpha.contractValidation.errors));
  assert.equal(gpt.contractValidation.ok,true,JSON.stringify(gpt.contractValidation.errors));
  assert.deepEqual(alpha.contractValidation.coverage.productScopeIds,["product:alpha"]);
  assert.deepEqual(gpt.contractValidation.coverage.productScopeIds,["product:alphaGpt"]);
  assert.ok(validateQueryRunSet(contract,[alpha]).errors.some((item)=>item.code==="INTENT_PRODUCT_SCOPE_INCOMPLETE"));
  assert.equal(validateQueryRunSet(contract,[alpha,gpt]).ok,true);
});

test("product scope validation rejects a missing binding and a mixed-product result run before execution",()=>{
  const intent=parseQueryIntent("Alpha和AlphaGPT线索数量");
  const columns={alpha_shared_clue:[{columnName:"id",comment:"线索ID",isPrimary:1}]};
  const policy={allowedTables:["alpha_shared_clue"],allowedColumns:{alpha_shared_clue:["id"]},allowedRelations:[],maxRows:100};
  const retrieval=retrieveKnowledge({
    question:intent.rawQuestion,pages:[],intent,relations:[],columnsByTable:columns,
    tables:[{tableName:"alpha_shared_clue",comment:"Alpha 与 AlphaGPT 共用线索"}],
  });
  const verdict=guardSql("SELECT COUNT(DISTINCT s.id) AS clue_count FROM alpha_shared_clue s",policy);
  assert.equal(verdict.ok,true,verdict.reason);
  const validation=queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:columns});
  assert.equal(validation.ok,false);
  assert.ok(validation.errors.some((item)=>item.code==="INTENT_PRODUCT_BINDING_MISSING"));
  assert.ok(validation.errors.some((item)=>item.code==="INTENT_PRODUCT_SCOPE_MISMATCH"));
});

test("closed-world row-domain validation stays enabled for explicit entities filters and products",()=>{
  const base=parseQueryIntent("本月线索成单数",{now:new Date(2026,7,25)});
  const entityIntent={...base,entities:[{text:"北京大成",kind:"organization"}]};
  const filterIntent={...base,filters:[{field:"organization",operator:"contains",value:"北京大成"}]};
  const productIntent={...base,scope:{...base.scope,products:["alpha"]}};
  assert.equal(buildQueryResultContract(entityIntent,[]).closedWorldRowDomain,true);
  assert.equal(buildQueryResultContract(filterIntent,[]).closedWorldRowDomain,true);
  assert.equal(buildQueryResultContract(productIntent,[]).closedWorldRowDomain,true);
  assert.equal(buildQueryResultContract(base,[]).closedWorldRowDomain,true);
});

test("published subtype discriminators become schema/root-bound immutable row-domain slots",()=>{
  const schema={name:"crm",objectTypes:[
    {apiName:"customer",primaryKey:"id",properties:[
      {apiName:"id",type:"integer",mapping:{table:"customer_record",column:"customer_id"}},
      {apiName:"segment",type:"enum",constraints:{enumValues:["vip","standard"]},mapping:{table:"customer_record",column:"segment_code"}},
      {apiName:"status",type:"string",mapping:{table:"customer_record",column:"status_code"}},
    ]},
    {apiName:"vip_customer",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]},
  ],linkTypes:[]};
  const catalog={columnsByTable:{customer_record:[{columnName:"customer_id"},{columnName:"segment_code"},{columnName:"status_code"}]},relations:[],enums:{"customer_record.segment_code":["vip","standard"]}};
  const compiled=compileSemanticQueryPlan({rootObject:"vip_customer",dimensions:["vip_customer.id"]},{schema,catalog,maxRows:100,ontologySchemaVersion:12});
  const intent={version:"query-intent-test",shape:{kind:"detail",direction:null,requestedLimit:null},requirements:[],filters:[],ambiguities:[]};
  const contract=buildQueryResultContract(intent,[],compiled.semanticContract);
  const slot=contract.slots.find((item)=>item.kind==="semantic_row_domain");
  assert.equal(contract.closedWorldRowDomain,true);
  assert.deepEqual(contract.semanticBinding,{version:"semantic-row-domain-v1",ontologySchemaVersion:12,rootObject:"vip_customer",immutable:true});
  assert.equal(slot.immutable,true);assert.equal(slot.required,true);assert.equal(slot.ontologySchemaVersion,12);assert.equal(slot.rootObject,"vip_customer");
  assert.deepEqual(slot.columns,["customer_record.segment_code"]);assert.deepEqual(slot.values,[{value:"vip",valueType:"string"}]);

  const permissivePolicy={...compiled.policy,mandatoryFilters:[]};
  const check=(sql,semanticContract=compiled.semanticContract)=>{
    const verdict=guardSql(sql,permissivePolicy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,verdict,columnsByTable:catalog.columnsByTable,semanticContract});
  };
  assert.equal(check(compiled.sql).ok,true,JSON.stringify(check(compiled.sql).errors));
  for(const wrong of [
    "SELECT customer_id FROM customer_record",
    "SELECT customer_id FROM customer_record WHERE segment_code = 'standard'",
    "SELECT customer_id FROM customer_record WHERE status_code = 'vip'",
    "SELECT customer_id FROM customer_record WHERE segment_code = 'vip' AND status_code = 'vip'",
    "SELECT customer_id FROM customer_record WHERE segment_code = 'vip' AND segment_code = 'standard'",
    "SELECT customer_id FROM customer_record WHERE LOWER(segment_code) = 'vip'",
  ]) {
    const result=check(wrong);
    assert.equal(result.ok,false,wrong);
    assert.ok(result.errors.some((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_MISMATCH"||item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(result.errors));
  }
  const withoutBinding=check(compiled.sql,null);
  assert.ok(withoutBinding.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const stale=structuredClone(compiled.semanticContract);stale.ontologySchemaVersion=null;stale.rowDomainSlots[0].ontologySchemaVersion=null;
  assert.ok(check(compiled.sql,stale).errors.some((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_BINDING_INVALID"));
});

test("multi-value subtype discriminators require the exact closed-world value set",()=>{
  const schema={name:"crm",objectTypes:[
    {apiName:"customer",primaryKey:"id",properties:[
      {apiName:"id",type:"integer",mapping:{table:"customer_record",column:"customer_id"}},
      {apiName:"segment",type:"enum",constraints:{enumValues:["vip","gold","standard"]},mapping:{table:"customer_record",column:"segment_code"}},
    ]},
    {apiName:"premium_customer",parent:"customer",discriminator:{property:"segment",values:["vip","gold"]},properties:[]},
  ],linkTypes:[]};
  const catalog={columnsByTable:{customer_record:[{columnName:"customer_id"},{columnName:"segment_code"}]},relations:[],enums:{"customer_record.segment_code":["vip","gold","standard"]}};
  const compiled=compileSemanticQueryPlan({rootObject:"premium_customer",dimensions:["premium_customer.id"]},{schema,catalog,maxRows:100,ontologySchemaVersion:13});
  const intent={shape:{kind:"detail"},requirements:[],filters:[],ambiguities:[]};
  const check=(sql)=>{const verdict=guardSql(sql,{...compiled.policy,mandatoryFilters:[]});assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,verdict,columnsByTable:catalog.columnsByTable,semanticContract:compiled.semanticContract});};
  assert.match(compiled.sql,/segment_code` IN \('vip', 'gold'\)/);
  assert.equal(check(compiled.sql).ok,true,JSON.stringify(check(compiled.sql).errors));
  assert.equal(check("SELECT customer_id FROM customer_record WHERE segment_code IN ('gold', 'vip')").ok,true);
  const narrowed=check("SELECT customer_id FROM customer_record WHERE segment_code IN ('vip')");
  assert.ok(narrowed.errors.some((item)=>item.code==="ONTOLOGY_DISCRIMINATOR_MISMATCH"));
});

test("typed business filters require the exact field operator value and reject any extra row restriction",()=>{
  const filterTables=[{tableName:"filter_clue",comment:"线索主表"}];
  const filterColumns={filter_clue:[
    {columnName:"id",comment:"线索ID",isPrimary:1},
    {columnName:"created_at",comment:"线索创建时间"},
    {columnName:"status",comment:"线索状态"},
    {columnName:"status_label",comment:"展示文本"},
    {columnName:"amount",comment:"订单金额"},
    {columnName:"is_deleted",comment:"逻辑删除"},
  ]};
  const filterPolicy={allowedTables:["filter_clue"],allowedColumns:{filter_clue:filterColumns.filter_clue.map((item)=>item.columnName)},allowedRelations:[],maxRows:100};
  const intent=parseQueryIntent("本月创建的状态为有效且金额大于1000的线索数量",{now:new Date(2026,7,25)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:filterTables,columnsByTable:filterColumns,relations:[],intent});
  assert.deepEqual(retrieval.coverageContract.missing,[]);
  const validateFilter=(sql)=>{
    const verdict=guardSql(sql,filterPolicy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:filterColumns});
  };
  const correct="SELECT COUNT(DISTINCT c.id) AS clue_count FROM filter_clue c WHERE c.created_at >= '2026-08-01' AND c.created_at < '2026-09-01' AND c.status = '有效' AND c.amount > 1000 AND c.is_deleted = 0";
  assert.equal(validateFilter(correct).ok,true,JSON.stringify(validateFilter(correct).errors));
  for(const wrong of [
    correct.replace("c.status = '有效'","c.status_label = '有效'"),
    correct.replace("c.status = '有效'","c.status = '无效'"),
    correct.replace("c.amount > 1000","c.amount >= 1000"),
    correct.replace(" AND c.status = '有效'",""),
    `${correct} AND c.id > 5`,
    correct.replace("c.status = '有效'","LOWER(c.status) = '有效'"),
    correct.replace("c.status = '有效'","TRIM(c.status) = '有效'"),
    correct.replace("c.status = '有效'","c.status + 0 = '有效'"),
    correct.replace("c.created_at >= '2026-08-01' AND c.created_at < '2026-09-01'","YEAR(c.created_at) >= '2026-08-01' AND YEAR(c.created_at) < '2026-09-01'"),
    correct.replace("c.is_deleted = 0","COALESCE(c.is_deleted, 0) = 0"),
  ]) {
    const validation=validateFilter(wrong);
    assert.equal(validation.ok,false,wrong);
    assert.ok(validation.errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"||item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),JSON.stringify(validation.errors));
  }

  const nullIntent=parseQueryIntent("本月创建的状态不为空的线索数量",{now:new Date(2026,7,25)});
  const nullRetrieval=retrieveKnowledge({question:nullIntent.rawQuestion,pages:[],tables:filterTables,columnsByTable:filterColumns,relations:[],intent:nullIntent});
  const nullSql="SELECT COUNT(DISTINCT c.id) AS clue_count FROM filter_clue c WHERE c.created_at >= '2026-08-01' AND c.created_at < '2026-09-01' AND c.status IS NOT NULL AND c.is_deleted = 0";
  const nullVerdict=guardSql(nullSql,filterPolicy);assert.equal(nullVerdict.ok,true,nullVerdict.reason);
  const nullValidation=queryResultContractValidation(nullIntent,nullVerdict.sql,{usedTables:nullVerdict.tables,retrieval:nullRetrieval,verdict:nullVerdict,columnsByTable:filterColumns});
  assert.equal(nullValidation.ok,true,JSON.stringify(nullValidation.errors));
});

test("additive verified terms require every predicate from both assets in the closed row domain",()=>{
  const customerTables=[{tableName:"customer",comment:"客户"}];
  const customerColumns={customer:[
    {columnName:"id",dataType:"bigint",comment:"客户主键",isPrimary:1},
    {columnName:"cert_status",dataType:"int",comment:"认证状态"},
    {columnName:"deleted_at",dataType:"datetime",comment:"删除时间"},
    {columnName:"is_test",dataType:"int",comment:"测试标记"},
    {columnName:"segment",dataType:"int",comment:"客户分层"},
    {columnName:"is_deleted",dataType:"int",comment:"逻辑删除"},
  ]};
  const pages=[
    {pageType:"term",slug:"有效客户",title:"有效客户",aliases:[],tables:["customer"],verified:true,sqlContent:"cert_status = 1 AND deleted_at IS NULL AND is_test = 0"},
    {pageType:"term",slug:"VIP客户",title:"VIP 客户",aliases:["VIP客户"],tables:["customer"],verified:true,sqlContent:"segment = 2"},
  ];
  const rowDomainConcepts=knowledgeIntentRowDomains(pages,customerColumns);
  const prior=parseQueryIntent("有效客户数量",{rowDomainConcepts});
  const intent=mergeContextualQueryIntent(parseQueryIntent("再加上VIP客户",{rowDomainConcepts}),prior);
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages,tables:customerTables,columnsByTable:customerColumns,relations:[],intent});
  const customerPolicy={allowedTables:["customer"],allowedColumns:{customer:customerColumns.customer.map((item)=>item.columnName)},allowedRelations:[],maxRows:100};
  const validateCustomer=(sql)=>{const verdict=guardSql(sql,customerPolicy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:customerColumns});};
  const correct="SELECT COUNT(DISTINCT c.id) AS customer_count FROM customer c WHERE c.cert_status = 1 AND c.deleted_at IS NULL AND c.is_test = 0 AND c.segment = 2 AND c.is_deleted = 0";
  assert.equal(validateCustomer(correct).ok,true);
  for(const missing of [
    correct.replace("c.cert_status = 1 AND ",""),correct.replace(" AND c.deleted_at IS NULL",""),
    correct.replace(" AND c.is_test = 0",""),correct.replace(" AND c.segment = 2",""),
  ]) {
    const validation=validateCustomer(missing);
    assert.equal(validation.ok,false,missing);
    assert.ok(validation.errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"),JSON.stringify(validation.errors));
  }
});

test("a verified filter on a confirmed event closure is mandatory in the result contract",()=>{
  const intent=parseQueryIntent("本月线索成单数",{now:new Date(2026,7,25)});
  const filter={
    id:"filter:knowledge:event-active:0",requirementId:"filter:knowledge:event-active:0",kind:"knowledge_row_domain",
    field:"event_state",fieldSurface:"有效成单事件",fieldTerms:["deal_event.event_state","event_state"],physicalColumns:["deal_event.event_state"],
    operator:"eq",value:"ACTIVE",valueType:"string",valueBinding:"verified_knowledge",immutable:true,attachesTo:"clue",sourceText:"有效成单事件",
    provenance:{level:"verified_knowledge",activation:"global_table_rule",assetId:"rule:event-active"},
  };
  intent.filters.push(filter);
  intent.requirements.push({
    id:filter.requirementId,filterId:filter.id,kind:"filter",value:filter.value,sourceValue:filter.value,field:filter.field,fieldSurface:filter.fieldSurface,
    role:filter.kind,surfaceText:filter.sourceText,required:true,allowMultiple:false,operator:filter.operator,valueType:filter.valueType,attachesTo:filter.attachesTo,
    fieldTerms:filter.fieldTerms,physicalColumns:filter.physicalColumns,valueBinding:filter.valueBinding,provenance:filter.provenance,anchorTerms:filter.fieldTerms,terms:filter.fieldTerms,
  });
  const scopedTables=[{tableName:"crm_clue",comment:"线索主表"},{tableName:"deal_event",comment:"线索成单事件"}];
  const scopedColumns={
    crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    deal_event:[{columnName:"clue_id",comment:"线索ID"},{columnName:"completed_at",comment:"成单时间"},{columnName:"event_state",comment:"事件状态",dataType:"varchar"},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const scopedRelations=[{id:191,fromTable:"deal_event",fromCol:"clue_id",toTable:"crm_clue",toCol:"id",status:"confirmed",confidence:1}];
  const scopedPolicy={allowedTables:scopedTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(scopedColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:scopedRelations,maxRows:100};
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:scopedTables,columnsByTable:scopedColumns,relations:scopedRelations,intent,maxTables:8});
  const check=(sql)=>{const verdict=guardSql(sql,scopedPolicy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:scopedColumns});};
  const correct=`SELECT COUNT(DISTINCT c.id) AS won_count
FROM deal_event e JOIN crm_clue c ON c.id=e.clue_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.event_state='ACTIVE' AND e.is_deleted=0 AND c.is_deleted=0`;
  assert.equal(check(correct).ok,true);
  assert.ok(check(correct.replace("AND e.event_state='ACTIVE' ","")).errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"));
  assert.ok(check(correct.replace("e.event_state='ACTIVE'","e.event_state='INACTIVE'")).errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"));
});

test("a confirmed multi-hop measure path requires every intermediate bridge to stay active",()=>{
  const intent=parseQueryIntent("本月线索成单数",{now:new Date(2026,7,25)});
  const scopedTables=[{tableName:"crm_clue",comment:"线索主表"},{tableName:"clue_event_bridge",comment:"线索与成单事件关系"},{tableName:"deal_event",comment:"成单事件"}];
  const scopedColumns={
    crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    clue_event_bridge:[{columnName:"clue_id",comment:"线索ID"},{columnName:"event_id",comment:"事件ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
    deal_event:[{columnName:"id",comment:"事件ID",isPrimary:1},{columnName:"completed_at",comment:"成单时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const scopedRelations=[
    {id:192,fromTable:"deal_event",fromCol:"id",toTable:"clue_event_bridge",toCol:"event_id",status:"confirmed",confidence:1},
    {id:193,fromTable:"clue_event_bridge",fromCol:"clue_id",toTable:"crm_clue",toCol:"id",status:"confirmed",confidence:1},
  ];
  const scopedPolicy={allowedTables:scopedTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(scopedColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:scopedRelations,maxRows:100};
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:scopedTables,columnsByTable:scopedColumns,relations:scopedRelations,intent,maxTables:8});
  const check=(sql)=>{const verdict=guardSql(sql,scopedPolicy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:scopedColumns});};
  const correct=`SELECT COUNT(DISTINCT c.id) AS won_count
FROM deal_event e JOIN clue_event_bridge b ON b.event_id=e.id JOIN crm_clue c ON c.id=b.clue_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND b.is_deleted=0 AND c.is_deleted=0`;
  assert.equal(check(correct).ok,true);
  const missing=check(correct.replace(" AND b.is_deleted=0",""));
  assert.ok(missing.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));
});

test("detail filters are mandatory and retrieval evidence cannot widen one filter into multiple authorized columns",()=>{
  const detailTables=[{tableName:"detail_clue",comment:"线索主表"}];
  const detailColumns={detail_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"status",comment:"线索状态"},{columnName:"is_deleted",comment:"逻辑删除"}]};
  const detailPolicy={allowedTables:["detail_clue"],allowedColumns:{detail_clue:detailColumns.detail_clue.map((item)=>item.columnName)},allowedRelations:[],maxRows:100};
  const intent=parseQueryIntent("状态为有效的线索明细");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:detailTables,columnsByTable:detailColumns,relations:[],intent});
  const validateDetail=(sql,evidence=retrieval)=>{
    const verdict=guardSql(sql,detailPolicy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval:evidence,verdict,columnsByTable:detailColumns});
  };
  const correct="SELECT c.id, c.status FROM detail_clue c WHERE c.status = '有效' AND c.is_deleted = 0";
  assert.equal(validateDetail(correct).ok,true,JSON.stringify(validateDetail(correct).errors));
  for(const wrong of ["SELECT c.id, c.status FROM detail_clue c WHERE c.is_deleted = 0","SELECT c.id, c.status FROM detail_clue c WHERE c.status = '无效' AND c.is_deleted = 0"])assert.equal(validateDetail(wrong).ok,false,wrong);

  const unstable=[
    {diagnostics:{facets:[{key:"filter:status:0",executionTables:["detail_clue"],executionColumns:["detail_clue.status"]}]}},
    {diagnostics:{facets:[{key:"filter:status:0",executionTables:["detail_clue"],executionColumns:["detail_clue.status_shadow"]}]}},
  ];
  const contract=buildQueryResultContract(intent,unstable);
  assert.deepEqual(contract.slots.find((item)=>item.id==="filter:status:0").columns,[]);
  assert.ok(validateDetail(correct,unstable).errors.some((item)=>item.code==="INTENT_FILTER_BINDING_MISSING"));
});

test("trend contract binds both the range and bucket to the requested event-time role",()=>{
  const intent=parseQueryIntent("本月线索成单数按日趋势",{now:new Date(2026,7,25)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  const correct=`SELECT DATE(e.completed_at) AS event_day, COUNT(DISTINCT l.id) AS won_lead_count
FROM deal_event e
JOIN lead_entity l ON l.id = e.lead_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted = 0
GROUP BY DATE(e.completed_at)
ORDER BY event_day ASC`;
  const verdict=guardSql(correct,policy);
  assert.equal(verdict.ok,true,verdict.reason);
  const valid=queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  assert.equal(valid.ok,true,JSON.stringify(valid.errors));

  const wrongBucket=correct.replaceAll("DATE(e.completed_at)","DATE(l.created_at)");
  const wrongVerdict=guardSql(wrongBucket,policy);
  assert.equal(wrongVerdict.ok,true,wrongVerdict.reason);
  const invalid=queryResultContractValidation(intent,wrongVerdict.sql,{usedTables:wrongVerdict.tables,retrieval,verdict:wrongVerdict,columnsByTable});
  assert.ok(invalid.errors.some((item)=>item.code==="INTENT_TREND_TIME_DIMENSION_MISMATCH"));
});

test("trend without an explicit range requires event-time grouping but not a WHERE predicate",()=>{
  const intent=parseQueryIntent("线索成单数按月趋势",{now:new Date(2026,7,25)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  const sql=`SELECT DATE_FORMAT(e.completed_at, '%Y-%m') AS event_month, COUNT(DISTINCT l.id) AS won_lead_count
FROM deal_event e
JOIN lead_entity l ON l.id = e.lead_id
WHERE l.is_deleted = 0
GROUP BY DATE_FORMAT(e.completed_at, '%Y-%m')
ORDER BY event_month ASC`;
  const verdict=guardSql(sql,policy);
  assert.equal(verdict.ok,true,verdict.reason);
  const result=queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  assert.equal(result.ok,true,JSON.stringify(result.errors));
});

test("verified ratio metrics require the numerator and denominator columns from their definition",()=>{
  const pages=[{pageType:"metric",slug:"lead-conversion",title:"线索转化率",aliases:["转化率"],tables:["lead_entity","deal_event"],content:"按唯一线索去重。",sqlContent:"COUNT(DISTINCT deal_event.lead_id) / COUNT(DISTINCT lead_entity.id)",verified:true}];
  const intent=parseQueryIntent("线索转化率",{concepts:knowledgeIntentConcepts(pages,columnsByTable)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,maxTables:8,intent});
  const validateRatio=(sql)=>{
    const verdict=guardSql(sql,policy);
    assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  };
  const correct=`SELECT COUNT(DISTINCT e.lead_id) / COUNT(DISTINCT l.id) AS conversion_rate
FROM lead_entity l
LEFT JOIN deal_event e ON e.lead_id = l.id
WHERE l.is_deleted = 0`;
  const valid=validateRatio(correct);
  assert.equal(valid.ok,true,JSON.stringify(valid.errors));
  const wrong=correct.replace("COUNT(DISTINCT e.lead_id)","COUNT(DISTINCT e.id)");
  const result=validateRatio(wrong);
  assert.ok(result.errors.some((item)=>item.code==="INTENT_MEASURE_FORMULA_MISMATCH"));
  const reversed=`SELECT COUNT(DISTINCT l.id) / COUNT(DISTINCT e.lead_id) AS conversion_rate
FROM lead_entity l LEFT JOIN deal_event e ON e.lead_id = l.id WHERE l.is_deleted = 0`;
  assert.ok(validateRatio(reversed).errors.some((item)=>item.code==="INTENT_MEASURE_FORMULA_MISMATCH"));
  const wrongAggregation=`SELECT SUM(e.lead_id) / SUM(l.id) AS conversion_rate
FROM lead_entity l LEFT JOIN deal_event e ON e.lead_id = l.id WHERE l.is_deleted = 0`;
  assert.ok(validateRatio(wrongAggregation).errors.some((item)=>item.code==="INTENT_MEASURE_FORMULA_MISMATCH"));
});

test("ratio formula validation preserves conditional numerator predicates",()=>{
  const pages=[{pageType:"metric",slug:"qualified-conversion",title:"认证转化率",aliases:[],tables:["lead_entity"],content:"认证线索占全部线索比例，按唯一线索去重。",sqlContent:"COUNT(DISTINCT CASE WHEN lead_entity.is_won = 1 THEN lead_entity.id END) / COUNT(DISTINCT lead_entity.id)",verified:true}];
  const intent=parseQueryIntent("认证转化率",{concepts:knowledgeIntentConcepts(pages,columnsByTable)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,maxTables:8,intent});
  const check=(condition)=>{
    const sql=`SELECT COUNT(DISTINCT CASE WHEN l.is_won = ${condition} THEN l.id END) / COUNT(DISTINCT l.id) AS conversion_rate FROM lead_entity l`;
    const verdict=guardSql(sql,policy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  };
  const valid=check(1);assert.equal(valid.ok,true,JSON.stringify(valid.errors));
  assert.ok(check(0).errors.some((item)=>item.code==="INTENT_MEASURE_FORMULA_MISMATCH"));
});

test("ratio predicates bind each literal to its physical column instead of comparing a value bag",()=>{
  const pages=[{pageType:"metric",slug:"won-active-rate",title:"有效线索成单率",aliases:[],tables:["lead_entity"],content:"只统计未删除线索，按唯一线索去重。",sqlContent:"COUNT(DISTINCT CASE WHEN lead_entity.is_won = 1 AND lead_entity.is_deleted = 0 THEN lead_entity.id END) / COUNT(DISTINCT CASE WHEN lead_entity.is_deleted = 0 THEN lead_entity.id END)",verified:true}];
  const intent=parseQueryIntent("有效线索成单率",{concepts:knowledgeIntentConcepts(pages,columnsByTable)});
  const formula=intent.requirements.find((item)=>item.kind==="measure")?.metricDefinition?.formula;
  assert.equal(formula?.numerator?.predicateBinding,"physical");
  assert.deepEqual(formula?.numerator?.predicates,[
    {column:"lead_entity.is_deleted",operator:"=",valueType:"number",value:"0"},
    {column:"lead_entity.is_won",operator:"=",valueType:"number",value:"1"},
  ]);
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,maxTables:8,intent});
  const check=(won,deleted)=>{
    const sql=`SELECT COUNT(DISTINCT CASE WHEN l.is_won = ${won} AND l.is_deleted = ${deleted} THEN l.id END) / COUNT(DISTINCT CASE WHEN l.is_deleted = 0 THEN l.id END) AS won_rate FROM lead_entity l WHERE l.is_deleted = 0`;
    const verdict=guardSql(sql,policy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  };
  assert.equal(check(1,0).ok,true);
  const swapped=check(0,1);
  assert.ok(swapped.errors.some((item)=>item.code==="INTENT_MEASURE_FORMULA_MISMATCH"));
});

test("ratio definitions with OR or NOT predicates fail closed",()=>{
  const pages=[{pageType:"metric",slug:"unsupported-rate",title:"复杂条件率",aliases:[],tables:["lead_entity"],content:"复杂条件指标。",sqlContent:"COUNT(DISTINCT CASE WHEN lead_entity.is_won = 1 OR lead_entity.is_deleted = 0 THEN lead_entity.id END) / COUNT(DISTINCT lead_entity.id)",verified:true}];
  const intent=parseQueryIntent("复杂条件率",{concepts:knowledgeIntentConcepts(pages,columnsByTable)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,maxTables:8,intent});
  const sql=`SELECT COUNT(DISTINCT CASE WHEN l.is_won = 1 OR l.is_deleted = 0 THEN l.id END) / COUNT(DISTINCT l.id) AS result_rate FROM lead_entity l WHERE l.is_deleted = 0`;
  const verdict=guardSql(sql,policy);assert.equal(verdict.ok,true,verdict.reason);
  const result=queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  assert.ok(result.errors.some((item)=>item.code==="INTENT_MEASURE_PREDICATE_BINDING_MISSING"));
});

test("equivalent CTE ranking preserves physical lineage for time label grain and ordering",()=>{
  const sql=`WITH base AS (
  SELECT e.completed_at AS event_time, l.id AS lead_id, r.owner_id, r.owner_name
  FROM deal_event e
  JOIN lead_entity l ON l.id = e.lead_id
  JOIN lead_owner_rel r ON r.lead_id = l.id
  WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted = 0 AND r.is_deleted = 0
)
SELECT owner_id, MAX(owner_name) AS owner_name, COUNT(DISTINCT lead_id) AS won_lead_count
FROM base
GROUP BY owner_id
ORDER BY won_lead_count DESC
LIMIT 50`;
  const result=validate(sql);
  assert.equal(result.ok,true,JSON.stringify(result.errors));
  assert.deepEqual(new Set(result.shape.effectiveTables),new Set(["deal_event","lead_entity","lead_owner_rel"]));
  assert.deepEqual(result.shape.aggregates.find((item)=>item.alias==="won_lead_count"),{name:"count",distinct:true,columns:["lead_entity.id"],alias:"won_lead_count"});
});

test("dead CTEs and unrelated subqueries cannot fabricate contract evidence",()=>{
  const deadCte=`WITH unused_event AS (
  SELECT completed_at FROM deal_event
  WHERE completed_at >= '2026-08-01' AND completed_at < '2026-09-01'
)
SELECT r.owner_id, MAX(r.owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_lead_count
FROM lead_entity l
JOIN lead_owner_rel r ON r.lead_id = l.id
WHERE l.created_at >= '2026-08-01' AND l.created_at < '2026-09-01' AND r.is_deleted = 0
GROUP BY r.owner_id
ORDER BY won_lead_count DESC`;
  const deadResult=validate(deadCte);
  assert.ok(deadResult.errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
  assert.equal(deadResult.shape.effectiveTables.includes("deal_event"),false);

  const fakeLabel=correctSql.replace("MAX(r.owner_name) AS owner_name","(SELECT MAX(x.owner_name) FROM lead_owner_rel x) AS owner_name");
  const labelResult=validate(fakeLabel);
  assert.ok(labelResult.errors.some((item)=>item.code==="INTENT_DIMENSION_LABEL_MISSING"));

  const fakeTime=correctSql.replace("e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'","l.created_at >= '2026-08-01' AND l.created_at < '2026-09-01' AND EXISTS (SELECT 1 FROM deal_event x WHERE x.completed_at >= '2026-08-01' AND x.completed_at < '2026-09-01')");
  const timeResult=validate(fakeTime);
  assert.ok(timeResult.errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
});

test("time contract rejects OR ranges and unrecognized dynamic boundaries",()=>{
  const orSql=correctSql.replace("e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'","(e.completed_at >= '2026-08-01' OR e.completed_at < '2026-09-01')");
  assert.ok(validate(orSql).errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
  const dynamicSql=correctSql.replace("e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'","e.completed_at >= NOW() AND e.completed_at < NOW()");
  assert.ok(validate(dynamicSql).errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
  const databaseCalendarSql=correctSql.replace(
    "e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'",
    "e.completed_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01') AND e.completed_at < DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL 1 MONTH), '%Y-%m-01')",
  );
  assert.ok(validate(databaseCalendarSql).errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"),"database-session calendar functions cannot substitute the business-time-zone literals resolved by intent");
});

test("ranking order must bind the validated metric output and preserve explicit Top N",()=>{
  const disguised=correctSql.replace("COUNT(DISTINCT l.id) AS won_lead_count","COUNT(DISTINCT l.id) AS unused_correct, COUNT(*) AS won_lead_count");
  const disguisedResult=validate(disguised);
  assert.ok(disguisedResult.errors.some((item)=>item.code==="INTENT_RANKING_ORDER_MISMATCH"));
  const metricSecond=correctSql.replace("ORDER BY won_lead_count DESC","ORDER BY r.owner_id ASC, won_lead_count DESC");
  assert.ok(validate(metricSecond).errors.some((item)=>item.code==="INTENT_RANKING_ORDER_MISMATCH"));
  const directAggregate=correctSql.replace("ORDER BY won_lead_count DESC","ORDER BY COUNT(DISTINCT l.id) DESC");
  assert.equal(validate(directAggregate).ok,true);
  const ordinalGroup=correctSql.replace("GROUP BY r.owner_id","GROUP BY 1");
  assert.equal(validate(ordinalGroup).ok,true);

  let intent=parseQueryIntent("本月线索销售成单排行 Top 10",{now:new Date(2026,7,25)});
  intent=applyIntentClarification(intent,"按当前负责人统计");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  const verdict=guardSql(correctSql,policy);
  assert.equal(verdict.ok,true,verdict.reason);
  const limited=queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  assert.ok(limited.errors.some((item)=>item.code==="INTENT_RANKING_LIMIT_MISMATCH"));

  const checkTop=(sql)=>{const item=guardSql(sql,policy);assert.equal(item.ok,true,item.reason);return queryResultContractValidation(intent,item.sql,{usedTables:item.tables,retrieval,verdict:item,columnsByTable});};
  assert.equal(checkTop(correctSql.replace("LIMIT 50","LIMIT 10")).ok,true);
  assert.ok(checkTop(correctSql.replace("LIMIT 50","LIMIT 10 OFFSET 1")).errors.some((item)=>item.code==="INTENT_RANKING_LIMIT_MISMATCH"));
  assert.ok(checkTop(correctSql.replace("LIMIT 50","LIMIT 1, 10")).errors.some((item)=>item.code==="INTENT_RANKING_LIMIT_MISMATCH"));

  let top100Intent=parseQueryIntent("本月线索销售成单排行 Top 100",{now:new Date(2026,7,25)});
  top100Intent=applyIntentClarification(top100Intent,"按当前负责人统计");
  const top100Retrieval=retrieveKnowledge({question:top100Intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent:top100Intent});
  const capped=guardSql(correctSql.replace("LIMIT 50","LIMIT 1000"),{...policy,maxRows:100});
  assert.equal(capped.ok,true,capped.reason);assert.equal(capped.limit.effective,100);assert.equal(capped.limit.requested,1000);
  const cappedValidation=queryResultContractValidation(top100Intent,capped.sql,{usedTables:capped.tables,retrieval:top100Retrieval,verdict:capped,columnsByTable});
  assert.ok(cappedValidation.errors.some((item)=>item.code==="INTENT_RANKING_LIMIT_MISMATCH"),"guard cap must not rewrite the model request into a matching Top N contract");
});

test("trend contract rejects the wrong bucket grain and sorting by the metric",()=>{
  const intent=parseQueryIntent("本月线索成单数按日趋势",{now:new Date(2026,7,25)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  const validateTrend=(sql)=>{
    const verdict=guardSql(sql,policy);assert.equal(verdict.ok,true,verdict.reason);
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});
  };
  const monthly=`SELECT DATE_FORMAT(e.completed_at, '%Y-%m') AS event_month, COUNT(DISTINCT l.id) AS won_lead_count
FROM deal_event e JOIN lead_entity l ON l.id = e.lead_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted = 0
GROUP BY DATE_FORMAT(e.completed_at, '%Y-%m') ORDER BY event_month ASC`;
  assert.ok(validateTrend(monthly).errors.some((item)=>item.code==="INTENT_TREND_GRAIN_MISMATCH"));
  const metricOrder=monthly.replaceAll("DATE_FORMAT(e.completed_at, '%Y-%m')","DATE(e.completed_at)").replace("ORDER BY event_month ASC","ORDER BY won_lead_count ASC");
  assert.ok(validateTrend(metricOrder).errors.some((item)=>item.code==="INTENT_TREND_ORDER_MISMATCH"));
  const timeSecond=metricOrder.replace("ORDER BY won_lead_count ASC","ORDER BY won_lead_count DESC, event_month ASC");
  assert.ok(validateTrend(timeSecond).errors.some((item)=>item.code==="INTENT_TREND_ORDER_MISMATCH"));
  const extraGroup=metricOrder.replace("GROUP BY DATE(e.completed_at)","GROUP BY DATE(e.completed_at), l.id").replace("ORDER BY won_lead_count ASC","ORDER BY event_month ASC");
  assert.ok(validateTrend(extraGroup).errors.some((item)=>item.code==="INTENT_TREND_GROUP_ITEM_MISMATCH"));
});

test("current-owner and event-time-owner clarifications bind mutually exclusive attribution paths",()=>{
  const scopedTables=[
    {tableName:"lead_entity",comment:"线索主表"},
    {tableName:"deal_event",comment:"线索成单事件及成单时负责人快照"},
    {tableName:"current_owner_rel",comment:"线索当前负责人关系"},
  ];
  const scopedColumns={
    lead_entity:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"线索逻辑删除"}],
    deal_event:[{columnName:"lead_id",comment:"线索ID"},{columnName:"completed_at",comment:"成单时间"},{columnName:"closing_owner_id",comment:"成单时负责人ID"},{columnName:"closing_owner_name",comment:"成单时负责人姓名"}],
    current_owner_rel:[{columnName:"lead_id",comment:"线索ID"},{columnName:"current_owner_id",comment:"当前负责人ID"},{columnName:"current_owner_name",comment:"当前负责人姓名"},{columnName:"is_deleted",comment:"当前关系逻辑删除"}],
  };
  const scopedRelations=[
    {id:11,fromTable:"deal_event",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",status:"confirmed",confidence:1},
    {id:12,fromTable:"current_owner_rel",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",status:"confirmed",confidence:1},
  ];
  const scopedPolicy={allowedTables:scopedTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(scopedColumns).map(([tableName,columns])=>[tableName,columns.map((item)=>item.columnName)])),allowedRelations:scopedRelations,maxRows:100};
  const base=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  const current=applyIntentClarification(base,"按当前负责人统计");
  const eventTime=applyIntentClarification(base,"按成单时负责人统计");
  const currentSql=`SELECT r.current_owner_id, MAX(r.current_owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_count
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id JOIN current_owner_rel r ON r.lead_id=l.id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0 AND r.is_deleted=0
GROUP BY r.current_owner_id ORDER BY won_count DESC`;
  const eventSql=`SELECT e.closing_owner_id, MAX(e.closing_owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_count
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0
GROUP BY e.closing_owner_id ORDER BY won_count DESC`;
  const check=(intent,sql,{expectedRelationIds=null,actualRelationIds=null,validityPredicates=null,bindingPaths=null}={})=>{
    const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:scopedTables,columnsByTable:scopedColumns,relations:scopedRelations,maxTables:8,intent});
    const facet=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
    if(expectedRelationIds)facet.bindingRelationIds=expectedRelationIds;
    if(validityPredicates)facet.bindingValidityPredicates=validityPredicates;
    if(bindingPaths)facet.paths=bindingPaths;
    const verdict=guardSql(sql,scopedPolicy);assert.equal(verdict.ok,true,verdict.reason);
    if(actualRelationIds)verdict.joinRelationIds=actualRelationIds;
    return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:scopedColumns});
  };
  assert.equal(check(current,currentSql).ok,true);
  assert.ok(check(current,eventSql).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_MISMATCH"));
  assert.equal(check(eventTime,eventSql).ok,true);
  assert.ok(check(eventTime,currentSql).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_MISMATCH"));

  const missingValidity=currentSql.replace(" AND r.is_deleted=0","");
  assert.ok(check(current,missingValidity).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH"));
  const wrongValidity=currentSql.replace("r.is_deleted=0","r.is_deleted=1");
  assert.ok(check(current,wrongValidity).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH"));
  const unrelatedValidity=currentSql.replace("r.is_deleted=0","l.is_deleted=0");
  assert.ok(check(current,unrelatedValidity).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH"));
  const disjunctiveValidity=currentSql.replace("r.is_deleted=0","(r.is_deleted=0 OR r.is_deleted=1)");
  assert.ok(check(current,disjunctiveValidity).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_VALIDITY_MISMATCH"));

  const joinOnValidity=`SELECT r.current_owner_id, MAX(r.current_owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_count
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id JOIN current_owner_rel r ON r.lead_id=l.id AND r.is_deleted=0
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0
GROUP BY r.current_owner_id ORDER BY won_count DESC`;
  assert.equal(check(current,joinOnValidity).ok,true);

  const ontologyBinding={expectedRelationIds:[12],validityPredicates:[{table:"current_owner_rel",column:"is_deleted",operator:"=",value:0}]};
  const currentBound=check(current,currentSql,ontologyBinding);
  assert.equal(currentBound.ok,true,JSON.stringify(currentBound.errors));
  assert.ok(check(current,currentSql,{...ontologyBinding,actualRelationIds:[11]}).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH"));
  const eventBound=check(eventTime,eventSql,{expectedRelationIds:[11],bindingPaths:[["deal_event","lead_entity"]]});
  assert.equal(eventBound.ok,true,JSON.stringify(eventBound.errors));
  assert.ok(check(eventTime,eventSql,{expectedRelationIds:[11,12],bindingPaths:[["deal_event","lead_entity"]]}).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH"));
});

test("current attribution proves the output alias uses only the active ontology path",()=>{
  const pathTables=[
    {tableName:"clue",comment:"CRM线索主表"},
    {tableName:"win_event",comment:"线索成单事件"},
    {tableName:"current_owner_bridge",comment:"线索当前销售归属"},
    {tableName:"seller",comment:"销售人员"},
    {tableName:"feed_activity",comment:"销售动态日志"},
  ];
  const pathColumns={
    clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    win_event:[{columnName:"clue_id",comment:"线索ID"},{columnName:"completed_at",comment:"成单时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
    current_owner_bridge:[{columnName:"clue_id",comment:"线索ID"},{columnName:"seller_id",comment:"当前销售ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
    seller:[{columnName:"id",comment:"销售ID",isPrimary:1},{columnName:"name",comment:"销售姓名"}],
    feed_activity:[{columnName:"clue_id",comment:"动态线索ID"},{columnName:"seller_id",comment:"操作销售ID"}],
  };
  const pathRelations=[
    {id:201,fromTable:"win_event",fromCol:"clue_id",toTable:"clue",toCol:"id",status:"confirmed",confidence:1},
    {id:202,fromTable:"current_owner_bridge",fromCol:"clue_id",toTable:"clue",toCol:"id",status:"confirmed",confidence:1},
    {id:203,fromTable:"current_owner_bridge",fromCol:"seller_id",toTable:"seller",toCol:"id",status:"confirmed",confidence:1},
    {id:204,fromTable:"feed_activity",fromCol:"clue_id",toTable:"clue",toCol:"id",status:"confirmed",confidence:1},
    {id:205,fromTable:"feed_activity",fromCol:"seller_id",toTable:"seller",toCol:"id",status:"confirmed",confidence:1},
  ];
  const pathOntology={name:"alias_path_v1",objectTypes:[
    {apiName:"crm_clue",displayName:"CRM线索",description:"线索业务对象",primaryKey:"id",properties:[{apiName:"id",displayName:"线索ID",description:"线索唯一标识",mapping:{table:"clue",column:"id"}}]},
    {apiName:"sales_seller",displayName:"销售人员",description:"销售维度",primaryKey:"id",properties:[{apiName:"id",displayName:"销售ID",description:"销售唯一标识",mapping:{table:"seller",column:"id"}},{apiName:"name",displayName:"销售姓名",description:"销售可读姓名",mapping:{table:"seller",column:"name"}}]},
    {apiName:"clue_current_owner",displayName:"线索当前销售归属",description:"线索与当前负责销售人员的归属关系",properties:[{apiName:"clue_id",displayName:"线索ID",description:"被分配的线索ID",mapping:{table:"current_owner_bridge",column:"clue_id"}},{apiName:"seller_id",displayName:"当前销售ID",description:"当前负责跟进线索的销售人员ID",mapping:{table:"current_owner_bridge",column:"seller_id"}},{apiName:"is_deleted",displayName:"逻辑删除",mapping:{table:"current_owner_bridge",column:"is_deleted"}}]},
  ],linkTypes:[]};
  const pathPolicy={allowedTables:pathTables.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(pathColumns).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:pathRelations,maxRows:100};
  const base=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  const intent=applyIntentClarification(base,"当前负责人");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:pathTables,columnsByTable:pathColumns,relations:pathRelations,maxTables:10,intent,ontologySchema:pathOntology});
  const dimension=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.deepEqual(dimension.bindingRelationIds,[203,202]);
  const check=(sql)=>{const verdict=guardSql(sql,pathPolicy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:pathColumns});};
  const correct=`SELECT s.id AS seller_id, s.name AS seller_name, COUNT(DISTINCT c.id) AS won_count
FROM win_event e JOIN clue c ON c.id=e.clue_id
JOIN current_owner_bridge b ON b.clue_id=c.id
JOIN seller s ON s.id=b.seller_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND c.is_deleted=0 AND b.is_deleted=0
  GROUP BY s.id,s.name ORDER BY won_count DESC LIMIT 50`;
  assert.equal(check(correct).ok,true);
  const activeCte=`WITH base AS (
SELECT s.id AS seller_id, s.name AS seller_name, c.id AS clue_id
FROM win_event e JOIN clue c ON c.id=e.clue_id
JOIN current_owner_bridge b ON b.clue_id=c.id JOIN seller s ON s.id=b.seller_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND c.is_deleted=0 AND b.is_deleted=0
)
SELECT seller_id, MAX(seller_name) AS seller_name, COUNT(DISTINCT clue_id) AS won_count
FROM base GROUP BY seller_id ORDER BY won_count DESC LIMIT 50`;
  assert.equal(check(activeCte).ok,true,"a referenced CTE must retain its physical alias path and validity lineage");

  const leftPath=correct.replace("JOIN current_owner_bridge b","LEFT JOIN current_owner_bridge b");
  const leftResult=check(leftPath);
  assert.ok(leftResult.errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));
  assert.ok(leftResult.shape.activeJoinEdges.some((item)=>item.joinType==="left"));
  const rightPath=correct.replace("JOIN seller s","RIGHT JOIN seller s");
  assert.ok(check(rightPath).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));

  const dualAlias=`SELECT wrong_s.id AS seller_id, wrong_s.name AS seller_name, COUNT(DISTINCT c.id) AS won_count
FROM win_event e JOIN clue c ON c.id=e.clue_id
JOIN current_owner_bridge b ON b.clue_id=c.id JOIN seller current_s ON current_s.id=b.seller_id
JOIN feed_activity f ON f.clue_id=c.id JOIN seller wrong_s ON wrong_s.id=f.seller_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND c.is_deleted=0 AND b.is_deleted=0
GROUP BY wrong_s.id,wrong_s.name ORDER BY won_count DESC LIMIT 50`;
  assert.ok(check(dualAlias).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));

  const competingPath=`SELECT s.id AS seller_id, s.name AS seller_name, COUNT(DISTINCT c.id) AS won_count
FROM win_event e JOIN clue c ON c.id=e.clue_id
JOIN current_owner_bridge b ON b.clue_id=c.id JOIN seller s ON s.id=b.seller_id
JOIN feed_activity f ON f.clue_id=c.id AND f.seller_id=s.id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND c.is_deleted=0 AND b.is_deleted=0
GROUP BY s.id,s.name ORDER BY won_count DESC LIMIT 50`;
  const competingResult=check(competingPath);
  assert.ok(competingResult.errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_ALIAS_PATH_MISMATCH"));
  assert.ok(competingResult.errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));

  const extraWhere=correct.replace("AND e.is_deleted=0","AND c.id>999 AND e.is_deleted=0");
  assert.ok(check(extraWhere).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const joinLiteral=correct.replace("ON b.clue_id=c.id","ON b.clue_id=c.id AND c.id>999");
  assert.ok(check(joinLiteral).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const having=correct.replace("GROUP BY s.id,s.name ORDER BY","GROUP BY s.id,s.name HAVING COUNT(DISTINCT c.id)>1 ORDER BY");
  assert.ok(check(having).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const extraGroup=correct.replace("GROUP BY s.id,s.name ORDER BY","GROUP BY s.id,s.name,c.id ORDER BY");
  assert.ok(check(extraGroup).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const disjunction=correct.replace("AND c.is_deleted=0","AND (c.is_deleted=0 OR c.id>999)");
  assert.ok(check(disjunction).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const inFilter=correct.replace("AND c.is_deleted=0","AND c.is_deleted=0 AND c.id IN (1,2)");
  assert.ok(check(inFilter).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const notFilter=correct.replace("AND c.is_deleted=0","AND c.is_deleted=0 AND NOT (c.id=999)");
  assert.ok(check(notFilter).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const likeFilter=correct.replace("AND c.is_deleted=0","AND c.is_deleted=0 AND c.id LIKE '9%'");
  assert.ok(check(likeFilter).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const betweenFilter=correct.replace("AND c.is_deleted=0","AND c.is_deleted=0 AND c.id BETWEEN 1 AND 2");
  assert.ok(check(betweenFilter).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const existsFilter=correct.replace("AND c.is_deleted=0","AND c.is_deleted=0 AND EXISTS (SELECT 1 FROM feed_activity fx WHERE fx.clue_id=c.id)");
  assert.ok(check(existsFilter).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const conditionalMetric=correct.replace("COUNT(DISTINCT c.id)","COUNT(DISTINCT CASE WHEN c.id>999 THEN c.id END)");
  assert.ok(check(conditionalMetric).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const conditionalFunctionMetric=correct.replace("COUNT(DISTINCT c.id)","COUNT(DISTINCT IF(c.id>999,c.id,NULL))");
  assert.ok(check(conditionalFunctionMetric).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));

  const activeCteExtra=activeCte.replace("AND e.is_deleted=0","AND c.id>999 AND e.is_deleted=0");
  assert.ok(check(activeCteExtra).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"));
  const deadFilterCte=activeCte.replace("WITH base AS",`WITH unused_filtered AS (
  SELECT cx.id FROM clue cx WHERE cx.id>999
), base AS`);
  assert.equal(check(deadFilterCte).ok,true,"an unreferenced CTE must not narrow the active result row domain");

  const deadCte=`WITH unused_owner AS (
SELECT sx.id FROM current_owner_bridge bx JOIN seller sx ON sx.id=bx.seller_id
)
SELECT s.id AS seller_id, s.name AS seller_name, COUNT(DISTINCT c.id) AS won_count
FROM win_event e JOIN clue c ON c.id=e.clue_id
JOIN current_owner_bridge b ON b.clue_id=c.id
JOIN feed_activity f ON f.clue_id=c.id JOIN seller s ON s.id=f.seller_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01'
AND e.is_deleted=0 AND c.is_deleted=0 AND b.is_deleted=0
GROUP BY s.id,s.name ORDER BY won_count DESC LIMIT 50`;
  assert.ok(check(deadCte).errors.some((item)=>item.code==="INTENT_DIMENSION_ATTRIBUTION_RELATION_MISMATCH"));

  const missingEventValidity=check(correct.replace("AND e.is_deleted=0 ",""));
  assert.ok(missingEventValidity.errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));
  const dummyValidity=correct
    .replace("JOIN current_owner_bridge b", "JOIN clue dummy ON dummy.id=c.id\nJOIN current_owner_bridge b")
    .replace("AND c.is_deleted=0", "AND dummy.is_deleted=0");
  assert.ok(check(dummyValidity).errors.some((item)=>item.code==="INTENT_EXECUTION_VALIDITY_MISMATCH"));
});

test("comparison contract requires independent current and baseline windows and outputs",()=>{
  const intent=parseQueryIntent("本月线索成单数同比",{now:new Date(2026,7,25)});
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:8,intent});
  const check=(sql)=>{const verdict=guardSql(sql,policy);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable});};
  const correct=`SELECT
COUNT(DISTINCT CASE WHEN e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' THEN l.id END) AS current_won,
COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01' AND e.completed_at < '2025-09-01' THEN l.id END) AS prior_won
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id
WHERE e.completed_at >= '2025-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0`;
  const valid=check(correct);assert.equal(valid.ok,true,JSON.stringify(valid.errors));
  const narrowedEnvelope=correct.replace("WHERE e.completed_at >= '2025-08-01'","WHERE e.completed_at >= '2025-08-01' AND e.completed_at >= '2026-08-01'");
  assert.ok(check(narrowedEnvelope).errors.some((item)=>item.code==="INTENT_ROW_DOMAIN_UNAUTHORIZED"),"individually declared time boundaries must not combine into a narrower comparison universe");
  const single=`SELECT COUNT(DISTINCT l.id) AS current_won
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id
WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0`;
  const invalid=check(single);
  assert.ok(invalid.errors.some((item)=>item.code==="INTENT_TIME_ROLE_MISMATCH"));
  assert.ok(invalid.errors.some((item)=>item.code==="INTENT_COMPARISON_OUTPUT_MISSING"));

  const swapped=correct.replace(/SELECT[\s\S]*?FROM deal_event/,`SELECT
COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01' AND e.completed_at < '2025-09-01' THEN l.id END) AS prior_won,
COUNT(DISTINCT CASE WHEN e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' THEN l.id END) AS current_won
FROM deal_event`);
  assert.ok(check(swapped).errors.some((item)=>item.code==="INTENT_COMPARISON_OUTPUT_PERIOD_MISMATCH"));

  const duplicated=correct.replace("COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01'",`COUNT(DISTINCT CASE WHEN e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' THEN l.id END) AS current_won_copy,
COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01'`);
  assert.ok(check(duplicated).errors.some((item)=>item.code==="INTENT_COMPARISON_OUTPUT_PERIOD_MISMATCH"));

  const withDelta=correct.replace("AS prior_won\nFROM",`AS prior_won,
COUNT(DISTINCT CASE WHEN e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' THEN l.id END)
- COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01' AND e.completed_at < '2025-09-01' THEN l.id END) AS delta
FROM`);
  assert.equal(check(withDelta).ok,true);

  const mixedExpression=`COUNT(DISTINCT CASE WHEN e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' THEN l.id END)
+ COUNT(DISTINCT CASE WHEN e.completed_at >= '2025-08-01' AND e.completed_at < '2025-09-01' THEN l.id END)`;
  const mixed=`SELECT ${mixedExpression} AS mixed_a, ${mixedExpression} AS mixed_b
FROM deal_event e JOIN lead_entity l ON l.id=e.lead_id
WHERE e.completed_at >= '2025-08-01' AND e.completed_at < '2026-09-01' AND l.is_deleted=0`;
  assert.ok(check(mixed).errors.some((item)=>item.code==="INTENT_COMPARISON_OUTPUT_PERIOD_MISMATCH"));
});

// T-cross: an operator-less dictionary filter whose closed-set member lives on a
// related dictionary table must bind across a confirmed JOIN, not just on the
// business root. The real production shape is clue.channel_id -> channel.id with
// channel_name carrying the value — a dictionary column the clue table does not
// itself hold. This is the filter cross-table binding (path B).
const DICT_TABLES=[
  {tableName:"alpha_crm_clue",comment:"线索主表"},
  {tableName:"alpha_crm_channel",comment:"渠道"},
];
const DICT_COLUMNS={
  alpha_crm_clue:[
    {columnName:"id",dataType:"bigint",comment:"线索主键",isPrimary:1},
    {columnName:"channel_id",dataType:"bigint",comment:"渠道ID"},
    {columnName:"created_at",dataType:"datetime",comment:"线索创建时间"},
    {columnName:"is_deleted",dataType:"tinyint",comment:"逻辑删除"},
  ],
  alpha_crm_channel:[
    {columnName:"id",dataType:"bigint",comment:"渠道ID",isPrimary:1},
    {columnName:"channel_name",dataType:"varchar",comment:"渠道名称"},
    {columnName:"is_deleted",dataType:"tinyint",comment:"逻辑删除"},
  ],
};
const DICT_RELATIONS=[{id:3494,fromTable:"alpha_crm_clue",fromCol:"channel_id",toTable:"alpha_crm_channel",toCol:"id",status:"confirmed",confidence:1}];
const DICT_ENUMS={"alpha_crm_channel.channel_name":[
  {value:"抖音",meaning:null,meaningSource:null},
  {value:"百度",meaning:null,meaningSource:null},
]};
const DICT_POLICY={allowedTables:DICT_TABLES.map((item)=>item.tableName),allowedColumns:Object.fromEntries(Object.entries(DICT_COLUMNS).map(([table,columns])=>[table,columns.map((item)=>item.columnName)])),allowedRelations:DICT_RELATIONS,maxRows:100};

test("a dictionary member on a confirmed JOIN table binds the filter across that join",()=>{
  const filterConcepts=catalogFilterConcepts(DICT_TABLES,DICT_COLUMNS,null,[],DICT_ENUMS);
  let intent=parseQueryIntent("本月抖音渠道的线索数量",{now:new Date(2026,8,1),filterConcepts});
  // Resolve the time role so the fixture isolates the filter binding; production
  // questions already carry an explicit/derived role. The filter is the target.
  intent=applyIntentClarification(intent,"创建或进入时间");

  // The filter must carry the dictionary column as proof of which physical
  // dictionary column holds the closed-set member.
  const filter=intent.filters.find((item)=>item.field==="channel");
  assert.equal(filter?.value,"抖音");
  assert.ok((filter.physicalColumns||[]).includes("alpha_crm_channel.channel_name"),"catalog member must supply its dictionary column");

  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:DICT_TABLES,columnsByTable:DICT_COLUMNS,relations:DICT_RELATIONS,intent,enumItemsByColumn:DICT_ENUMS,maxTables:12});
  assert.ok(!retrieval.coverageContract.missing.includes("filter:channel:0"),"cross-table dictionary filter must be covered, not a schema_gap");
  const facet=retrieval.diagnostics.facets.find((item)=>item.key==="filter:channel:0");
  assert.equal(facet?.covered,true,"filter facet must be covered");
  assert.ok((facet?.filterBindings||[]).length>0,"filter facet must carry at least one binding");
  assert.deepEqual(facet?.filterBindings.map((binding)=>[binding.column,binding.value,binding.evidence?.kind]),[["alpha_crm_channel.channel_name","抖音","observed_enum_value"]]);

  const check=(sql)=>{const verdict=guardSql(sql,DICT_POLICY);assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,retrieval,verdict,columnsByTable:DICT_COLUMNS});};
  const correct=`SELECT COUNT(DISTINCT c.id) AS clue_count
FROM alpha_crm_clue c JOIN alpha_crm_channel ch ON ch.id=c.channel_id
WHERE c.created_at >= '2026-09-01' AND c.created_at < '2026-10-01'
  AND ch.channel_name='抖音' AND c.is_deleted=0 AND ch.is_deleted=0`;
  assert.equal(check(correct).ok,true,JSON.stringify(check(correct).errors));
  // The value must bind on the dictionary column; it cannot drift to another column.
  const wrongColumn=correct.replace("ch.channel_name='抖音'","c.channel_id=1");
  assert.ok(check(wrongColumn).errors.some((item)=>item.code==="INTENT_FILTER_MISMATCH"));
});

test("a closed-set member that belongs to zero confirmed dictionary tables still fails closed",()=>{
  // Drop the confirmed relation: the dictionary table is no longer reachable, so
  // the filter must remain a schema_gap rather than guess a column.
  const filterConcepts=catalogFilterConcepts(DICT_TABLES,DICT_COLUMNS,null,[],DICT_ENUMS);
  let intent=parseQueryIntent("本月抖音渠道的线索数量",{now:new Date(2026,8,1),filterConcepts});
  intent=applyIntentClarification(intent,"创建或进入时间");
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables:DICT_TABLES,columnsByTable:DICT_COLUMNS,relations:[],intent,enumItemsByColumn:DICT_ENUMS,maxTables:12});
  assert.ok(retrieval.coverageContract.missing.includes("filter:channel:0"),"without a confirmed path the dictionary filter must stay a schema_gap");
});
