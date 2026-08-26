import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { retrieveKnowledge } from "../src/knowledge-retrieval.mjs";
import { knowledgeIntentConcepts, parseQueryIntent } from "../src/query-intent.mjs";
import { _internal as serverInternal } from "../src/server.mjs";
import { createStore } from "../src/store.mjs";

test("knowledge service persists validated term pages to SQLite and Markdown", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  const page=await service.save(7,{pageType:"term",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"已实名且未注销。",sqlContent:"cert_status = 1 AND deleted_at IS NULL",antiExamples:"不要用 status。",verified:true,owner:"业务负责人"});
  assert.equal(page.verified,true);
  assert.deepEqual(page.tables,["crm_customer"]);
  const markdown=await readFile(page.filePath,"utf8");
  assert.match(markdown,/type: term/);
  assert.match(markdown,/## SQL 片段/);
  assert.match(markdown,/## 反例/);
  await writeFile(page.filePath,markdown.replace("已实名且未注销。","已实名、未注销且排除测试账号。"),"utf8");
  const synced=await service.sync(7);assert.equal(synced.imported,1);assert.match(store.getKnowledge(7,"term",page.slug).content,/排除测试账号/);
  store.close();
});

test("verified knowledge requires an owner and SQL-bearing types require SQL", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  await assert.rejects(()=>service.save(1,{pageType:"term",title:"客户",content:"定义",sqlContent:"",verified:false}),/必须提供 SQL/);
  await assert.rejects(()=>service.save(1,{pageType:"rule",title:"规则",content:"定义",sqlContent:"x=1",verified:true}),/owner/);
  store.close();
});

test("term-first retrieval selects semantic tables and expands confirmed relations",()=>{
  const pages=[{pageType:"term",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"已实名客户，相关 [[复购率]]",sqlContent:"cert_status=1",antiExamples:"",verified:true},{pageType:"metric",title:"复购率",aliases:[],tables:["crm_customer","sales_order"],content:"下单两次以上",sqlContent:"COUNT(*)",antiExamples:"",verified:true}];
  const tables=[{tableName:"crm_customer",comment:"客户"},{tableName:"sales_order",comment:"订单"},{tableName:"order_log",comment:"日志"}];
  const result=retrieveKnowledge({question:"有效户的复购率",pages,tables,columnsByTable:{crm_customer:[],sales_order:[],order_log:[]},relations:[{fromTable:"sales_order",toTable:"crm_customer"}]});
  assert.equal(result.coverage,"semantic");
  assert.deepEqual(result.tableNames.sort(),["crm_customer","sales_order"]);
  assert.ok(result.pages.some((page)=>page.title==="复购率"));
});

test("a generic law-firm knowledge page cannot suppress the structurally matched clue fact table",()=>{
  const pages=[{pageType:"term",title:"AlphaGPT 律所名称",aliases:["律所名称"],tables:["alpha_account_user"],content:"按律所名称查询账号",sqlContent:"user_office_name LIKE ?",verified:true}];
  const tables=[{tableName:"alpha_account_user",grade:"A",comment:"账号"},{tableName:"alpha_crm_clue",grade:"A",comment:""},{tableName:"law_firm_owner_mapping",grade:"A",comment:"律所映射"},{tableName:"alpha_crm_three_clue_user",grade:"B",comment:"三方线索用户控制表"}];
  const columnsByTable={
    alpha_account_user:[{columnName:"user_office_name",comment:"用户所属律所"}],
    alpha_crm_clue:[{columnName:"clue_id",comment:"线索编号"},{columnName:"office_name",comment:"律所名称"},{columnName:"clue_create_time",comment:"线索进线时间"}],
    law_firm_owner_mapping:[{columnName:"law_firm_name",comment:"律所名称"}],
    alpha_crm_three_clue_user:[{columnName:"user_id",comment:"用户"}],
  };
  const question="查询一下北京大成本月进线的线索 北京大成 律所 机构名称 office_name law_firm firm 线索 进线 clue lead clue_create_time 律所名称 时间 日期 创建时间 进线时间 create_time";
  const result=retrieveKnowledge({question,pages,tables,columnsByTable,relations:[],maxTables:4});
  assert.equal(result.coverage,"semantic");assert.ok(result.tableNames.includes("alpha_account_user"));assert.ok(result.tableNames.includes("alpha_crm_clue"));
  assert.equal(result.diagnostics.tables[0].name,"alpha_crm_clue");
});

test("same-table body-token recall is not authoritative while an exact title or alias facet is",()=>{
  const page={pageType:"term",slug:"alpha-gpt-office",title:"AlphaGPT律所",aliases:["AlphaGpt律所名称"],tables:["alpha_account_user"],content:"AlphaGPT 账号所属律所",sqlContent:"user_office_name LIKE ?",verified:true};
  const tables=[{tableName:"alpha_account_user",grade:"A",comment:"账号"}];
  const columnsByTable={alpha_account_user:[{columnName:"user_id",comment:"账号 ID",isPrimary:1},{columnName:"user_office_name",comment:"用户所属律所"}]};
  const subjectIntent={shape:{kind:"detail"},requirements:[{id:"subject:account",kind:"subject",value:"account",required:true,terms:["账号","账户","account"],anchorTerms:["账号","账户","account"]}]};
  const weak=retrieveKnowledge({question:"查询账号",pages:[page],tables,columnsByTable,relations:[],intent:subjectIntent});
  assert.deepEqual(weak.pages.map((item)=>item.slug),["alpha-gpt-office"],"body token may recall the page");
  assert.deepEqual(weak.diagnostics.facets[0].authoritativePageKeys,[],"body-only recall cannot authorize a knowledge contract on the same table");
  const exactIntent={shape:{kind:"detail"},requirements:[{id:"filter:office",kind:"filter",value:"北京大成",sourceValue:"北京大成",field:"office",fieldSurface:"AlphaGpt律所名称",required:true,operator:"contains",valueType:"string",terms:["AlphaGpt律所名称"],fieldTerms:["AlphaGpt律所名称"],anchorTerms:["AlphaGpt律所名称"]}]};
  const exact=retrieveKnowledge({question:"AlphaGpt律所名称包含北京大成",pages:[page],tables,columnsByTable,relations:[],intent:exactIntent});
  assert.deepEqual(exact.diagnostics.facets[0].authoritativePageKeys,["term:alpha-gpt-office"]);
});

test("explicit Alpha and AlphaGPT account scopes bind distinct product roots and every required facet covers both",()=>{
  const question="查询北京大成律所 Alpha 和 AlphaGPT 所有账号情况";
  const intent=parseQueryIntent(question);
  const tables=[
    {tableName:"alpha_user",comment:"Alpha 产品账号"},
    {tableName:"alpha_account_user",comment:"AlphaGPT 产品账号"},
    {tableName:"alphagpt_account_history",comment:"AlphaGPT 账号历史"},
  ];
  const columnsByTable={
    alpha_user:[{columnName:"alpha_id",comment:"账号ID",isPrimary:1},{columnName:"office_name",comment:"律所名称"},{columnName:"is_deleted",comment:"逻辑删除"}],
    alpha_account_user:[{columnName:"user_id",comment:"账号ID",isPrimary:1},{columnName:"user_office_name",comment:"用户所属律所"},{columnName:"is_deleted",comment:"逻辑删除"}],
    alphagpt_account_history:[{columnName:"user_id",comment:"账号ID"},{columnName:"office_name",comment:"律所名称"}],
  };
  const retrieval=retrieveKnowledge({question,pages:[],tables,columnsByTable,relations:[],intent,maxTables:8});
  const byKey=(key)=>retrieval.diagnostics.facets.find((facet)=>facet.key===key);
  assert.deepEqual(byKey("product:alpha")?.executionTables,["alpha_user"]);
  assert.deepEqual(byKey("product:alphaGpt")?.executionTables,["alpha_account_user"]);
  assert.deepEqual(byKey("subject:account")?.productScopeIds,["product:alpha","product:alphaGpt"]);
  assert.deepEqual(byKey("entity:organization:北京大成")?.productScopeIds,["product:alpha","product:alphaGpt"]);
  assert.deepEqual(byKey("filter:organization_name:0")?.productScopeIds,["product:alpha","product:alphaGpt"]);
  assert.deepEqual(retrieval.coverageContract.missing,[]);
});

test("simple business filters bind one exact physical column and ambiguous fields fail closed",()=>{
  const intent=parseQueryIntent("本月创建的状态为有效的线索数量",{now:new Date(2026,7,25)});
  const tables=[{tableName:"crm_clue",comment:"线索主表"}];
  const baseColumns=[
    {columnName:"id",comment:"线索ID",isPrimary:1},
    {columnName:"created_at",comment:"线索创建时间"},
    {columnName:"status",comment:"线索状态"},
  ];
  const valid=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:{crm_clue:baseColumns},relations:[],intent});
  const filter=valid.diagnostics.facets.find((item)=>item.key==="filter:status:0");
  assert.equal(filter.covered,true);
  assert.deepEqual(filter.executionColumns,["crm_clue.status"]);
  assert.equal(valid.coverageContract.missing.includes("filter:status:0"),false);

  const ambiguous=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:{crm_clue:[...baseColumns,{columnName:"clue_status",comment:"状态"}]},relations:[],intent});
  const ambiguousFilter=ambiguous.diagnostics.facets.find((item)=>item.key==="filter:status:0");
  assert.equal(ambiguousFilter.covered,false);
  assert.deepEqual(ambiguousFilter.executionColumns,[]);
  assert.ok(ambiguous.coverageContract.missing.includes("filter:status:0"));
});

test("a generic filter stays on its business subject and never borrows a related table's same-named field",()=>{
  const intent=parseQueryIntent("本月创建的状态为有效的线索数量",{now:new Date(2026,7,25)});
  const tables=[{tableName:"crm_clue",comment:"线索主表"},{tableName:"order_record",comment:"订单记录"}];
  const relations=[{id:91,fromTable:"order_record",fromCol:"clue_id",toTable:"crm_clue",toCol:"id",status:"confirmed",confidence:1}];
  const base={
    crm_clue:[{columnName:"id",comment:"线索ID",isPrimary:1},{columnName:"created_at",comment:"线索创建时间"},{columnName:"clue_status",comment:"线索状态"}],
    order_record:[{columnName:"id",comment:"订单ID",isPrimary:1},{columnName:"clue_id",comment:"线索ID"},{columnName:"status",comment:"订单状态"}],
  };
  const retrieval=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:base,relations,intent});
  const filter=retrieval.diagnostics.facets.find((item)=>item.key==="filter:status:0");
  assert.deepEqual(filter.executionTables,["crm_clue"]);
  assert.deepEqual(filter.executionColumns,["crm_clue.clue_status"]);

  const missing=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable:{...base,crm_clue:base.crm_clue.filter((item)=>item.columnName!=="clue_status")},relations,intent});
  const missingFilter=missing.diagnostics.facets.find((item)=>item.key==="filter:status:0");
  assert.equal(missingFilter.covered,false);
  assert.deepEqual(missingFilter.executionColumns,[]);
  assert.ok(missing.coverageContract.missing.includes("filter:status:0"));
});

test("an exact verified filter may reuse a confirmed retrieved closure but never a status-less path",()=>{
  const withRule=(intent)=>{
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
    return intent;
  };
  const intent=withRule(parseQueryIntent("本月线索成单数",{now:new Date(2026,7,25)}));
  const tables=[{tableName:"crm_clue",comment:"线索主表"},{tableName:"deal_event",comment:"线索成单事件"}];
  const columnsByTable={
    crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    deal_event:[{columnName:"clue_id",comment:"线索ID"},{columnName:"completed_at",comment:"成单时间"},{columnName:"event_state",comment:"事件状态",dataType:"varchar"},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const relation={id:191,fromTable:"deal_event",fromCol:"clue_id",toTable:"crm_clue",toCol:"id",confidence:1};
  const retrieve=(status)=>retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations:[{...relation,...(status?{status}:{})}],intent,maxTables:8});

  const confirmed=retrieve("confirmed");
  const filter=confirmed.diagnostics.facets.find((item)=>item.key==="filter:knowledge:event-active:0");
  assert.equal(filter?.covered,true);
  assert.deepEqual(filter?.executionTables,["deal_event"]);
  assert.deepEqual(filter?.executionColumns,["deal_event.event_state"]);
  assert.deepEqual(filter?.paths,[["deal_event","crm_clue"]]);
  assert.deepEqual(filter?.filterBindings.map((item)=>({column:item.column,value:item.value,evidence:item.evidence.kind})),[{column:"deal_event.event_state",value:"ACTIVE",evidence:"verified_knowledge_predicate"}]);

  const unconfirmed=retrieve(null);
  const missing=unconfirmed.diagnostics.facets.find((item)=>item.key==="filter:knowledge:event-active:0");
  assert.equal(missing?.covered,false);
  assert.deepEqual(missing?.selectedTables,[]);
  assert.deepEqual(missing?.paths,[]);
  assert.ok(unconfirmed.coverageContract.missing.includes("filter:knowledge:event-active:0"));
});

test("a shared table with both product labels cannot impersonate two explicit product scopes",()=>{
  const question="Alpha和AlphaGPT线索数量";
  const intent=parseQueryIntent(question);
  const tables=[{tableName:"alpha_shared_clue",comment:"Alpha 与 AlphaGPT 共用线索"}];
  const columnsByTable={alpha_shared_clue:[{columnName:"id",comment:"线索ID",isPrimary:1}]};
  const retrieval=retrieveKnowledge({question,pages:[],tables,columnsByTable,relations:[],intent});
  for(const key of ["product:alpha","product:alphaGpt"]) {
    const facet=retrieval.diagnostics.facets.find((item)=>item.key===key);
    assert.equal(facet?.covered,false);
    assert.deepEqual(facet?.executionTables,[]);
    assert.ok(retrieval.coverageContract.missing.includes(key));
  }
  assert.ok(retrieval.coverageContract.missingDetails.some((item)=>item.reason==="product_scope_incomplete"));
});

test("the Alpha name fragment inside AlphaGPT never counts as Alpha product coverage",()=>{
  const question="Alpha和AlphaGPT线索数量";
  const intent=parseQueryIntent(question);
  const tables=[{tableName:"alphagpt_clue",comment:"线索主表"}];
  const columnsByTable={alphagpt_clue:[{columnName:"id",comment:"线索ID",isPrimary:1}]};
  const retrieval=retrieveKnowledge({question,pages:[],tables,columnsByTable,relations:[],intent});
  const alpha=retrieval.diagnostics.facets.find((item)=>item.key==="product:alpha");
  const gpt=retrieval.diagnostics.facets.find((item)=>item.key==="product:alphaGpt");
  assert.deepEqual(alpha?.candidates,[]);
  assert.equal(alpha?.covered,false);
  assert.deepEqual(gpt?.executionTables,["alphagpt_clue"]);
  assert.equal(gpt?.covered,true);
  assert.ok(retrieval.coverageContract.missing.includes("product:alpha"));
});

test("intent-facet quotas preserve the requested fact object across business domains",()=>{
  const pages=[{pageType:"term",title:"通用业务对象",aliases:["线索","账号","客户","订单","案件","收入"],tables:["organization_directory"],content:"通用对象名称",sqlContent:"name LIKE ?",verified:true}];
  const tables=[
    {tableName:"crm_clue",comment:"线索主表"},
    {tableName:"alpha_user",comment:"账号用户主表"},
    {tableName:"crm_customer",comment:"客户主表"},
    {tableName:"sales_order",comment:"订单主表"},
    {tableName:"legal_case",comment:"案件主表"},
    {tableName:"finance_revenue",comment:"收入事实表"},
    {tableName:"organization_directory",comment:"机构名称目录"},
  ];
  const columnsByTable={
    crm_clue:[{columnName:"clue_id",comment:"线索编号"}],
    alpha_user:[{columnName:"account_id",comment:"账号编号"}],
    crm_customer:[{columnName:"customer_id",comment:"客户编号"}],
    sales_order:[{columnName:"order_id",comment:"订单编号"}],
    legal_case:[{columnName:"case_id",comment:"案件编号"}],
    finance_revenue:[{columnName:"revenue_amount",comment:"收入金额"}],
    organization_directory:[{columnName:"organization_name",comment:"机构名称"}],
  };
  const scenarios=[
    ["查询线索","subject:clue","crm_clue"],
    ["查询账号","subject:account","alpha_user"],
    ["查询客户","subject:customer","crm_customer"],
    ["查询订单","subject:order","sales_order"],
    ["查询案件","subject:case","legal_case"],
    ["统计收入","subject:revenue","finance_revenue"],
  ];
  for(const [question,facetKey,expectedTable] of scenarios) {
    const intent=parseQueryIntent(question);
    const result=retrieveKnowledge({question,pages,tables,columnsByTable,relations:[],maxTables:4,intent});
    const facet=result.diagnostics.facets.find((item)=>item.key===facetKey);
    assert.equal(facet?.covered,true,question);
    assert.ok(facet.selectedTables.includes(expectedTable),question);
    assert.deepEqual(facet.executionTables,[expectedTable],question);
    assert.ok(result.tableNames.includes(expectedTable),question);
    assert.deepEqual(result.coverageContract.missing,[],question);
  }
  const multiIntent=parseQueryIntent("查询客户、订单、案件和收入");
  const multi=retrieveKnowledge({question:multiIntent.rawQuestion,pages,tables,columnsByTable,relations:[],maxTables:4,intent:multiIntent});
  assert.deepEqual(multi.coverageContract.missing,[]);
  assert.deepEqual(new Set(multi.tableNames),new Set(["crm_customer","sales_order","legal_case","finance_revenue"]));
});

test("retrieval coverage contract reports a missing business-object capability",()=>{
  const intent=parseQueryIntent("查询订单");
  const result=retrieveKnowledge({question:"查询订单",pages:[],tables:[{tableName:"crm_customer",comment:"客户主表"}],columnsByTable:{crm_customer:[{columnName:"customer_id",comment:"客户编号"}]},relations:[],intent});
  assert.deepEqual(result.coverageContract.missing,["subject:order"]);
  assert.equal(result.tableNames.length,0);
});

test("analytical retrieval reserves independent fact dimension and event-time capabilities",()=>{
  const intent=parseQueryIntent("按当前销售负责人统计本月实际成单线索排行",{now:new Date(2026,7,25)});
  const tables=[
    {tableName:"lead_entity",comment:"线索主表"},
    {tableName:"deal_event",comment:"线索成单事件"},
    {tableName:"lead_owner_rel",comment:"线索销售负责人关系"},
    {tableName:"salesperson",comment:"销售人员"},
    {tableName:"unrelated_log",comment:"操作日志"},
  ];
  const columnsByTable={
    lead_entity:[{columnName:"id",comment:"线索主键"},{columnName:"created_at",comment:"线索进线时间"}],
    deal_event:[{columnName:"lead_id",comment:"线索ID"},{columnName:"completed_at",comment:"订单成单时间"}],
    lead_owner_rel:[{columnName:"lead_id",comment:"线索ID"},{columnName:"owner_id",comment:"当前负责销售ID"},{columnName:"owner_name",comment:"销售姓名"}],
    salesperson:[{columnName:"seller_id",comment:"销售ID"},{columnName:"seller_name",comment:"销售姓名"}],
    unrelated_log:[{columnName:"created_at",comment:"创建时间"}],
  };
  const relations=[{fromTable:"deal_event",toTable:"lead_entity",confidence:1},{fromTable:"lead_owner_rel",toTable:"lead_entity",confidence:1},{fromTable:"lead_owner_rel",toTable:"salesperson",confidence:1}];
  const result=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,maxTables:6,intent});
  assert.deepEqual(result.coverageContract.missing,[]);
  assert.ok(result.tableNames.includes("lead_entity"));
  assert.ok(result.tableNames.includes("deal_event"));
  assert.ok(result.tableNames.includes("lead_owner_rel")||result.tableNames.includes("salesperson"));
  const time=result.diagnostics.facets.find((item)=>item.key==="time:current_month");
  assert.deepEqual(time.executionColumns,["deal_event.completed_at"]);
  const dimension=result.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.ok(dimension.labelColumns.some((item)=>/owner_name|seller_name/.test(item)));
  assert.ok(dimension.bindingTables.includes("lead_owner_rel"));
  assert.equal(dimension.bindingTables.includes("lead_entity"),false);
});

test("published ontology role semantics select the exact current-attribution path instead of an equal-length BFS path",()=>{
  const intent=parseQueryIntent("按当前销售负责人统计线索数量排行");
  const tables=["t_fact","t_feed","t_role","t_dimension"].map((tableName)=>({tableName,comment:""}));
  const columnsByTable={
    t_fact:[{columnName:"c01",comment:""}],
    t_feed:[{columnName:"c11",comment:""},{columnName:"c12",comment:""}],
    t_role:[{columnName:"c21",comment:""},{columnName:"c22",comment:""},{columnName:"is_deleted",comment:""}],
    t_dimension:[{columnName:"c31",comment:""},{columnName:"c32",comment:""}],
  };
  // Both routes have two hops. The unrelated feed route is deliberately first
  // and more confident so a plain BFS or confidence heuristic chooses it.
  const relations=[
    {id:11,fromTable:"t_dimension",fromCol:"c31",toTable:"t_feed",toCol:"c12",status:"confirmed",confidence:.99},
    {id:12,fromTable:"t_feed",fromCol:"c11",toTable:"t_fact",toCol:"c01",status:"confirmed",confidence:.99},
    {id:21,fromTable:"t_dimension",fromCol:"c31",toTable:"t_role",toCol:"c22",status:"confirmed",confidence:.5608},
    {id:22,fromTable:"t_role",fromCol:"c21",toTable:"t_fact",toCol:"c01",status:"accepted",confidence:.7924},
  ];
  const ontologySchema={name:"sales_v6",objectTypes:[
    {apiName:"clue",displayName:"线索",description:"线索业务对象",primaryKey:"clue_identity",properties:[
      {apiName:"clue_identity",displayName:"线索标识",description:"线索唯一标识",mapping:{table:"t_fact",column:"c01"}},
    ]},
    {apiName:"seller",displayName:"销售人员",description:"销售人员业务对象",primaryKey:"seller_identity",properties:[
      {apiName:"seller_identity",displayName:"销售人员标识",description:"销售人员ID",mapping:{table:"t_dimension",column:"c31"}},
      {apiName:"seller_label",displayName:"销售人员姓名",description:"销售人员可读姓名",mapping:{table:"t_dimension",column:"c32"}},
    ]},
    {apiName:"clue_seller_assignment",displayName:"线索销售归属",description:"维护线索与销售归属",primaryKey:"clue_identity",properties:[
      {apiName:"clue_identity",displayName:"线索标识",description:"被维护归属关系的线索ID",mapping:{table:"t_role",column:"c21"}},
      {apiName:"seller_identity",displayName:"当前销售标识",description:"当前负责跟进该线索的销售人员ID",mapping:{table:"t_role",column:"c22"}},
      {apiName:"validity",displayName:"有效状态",description:"当前归属关系有效性",mapping:{table:"t_role",column:"is_deleted"}},
    ]},
  ],linkTypes:[]};
  const result=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,intent,ontologySchema});
  const dimension=result.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.equal(dimension?.covered,true);
  assert.deepEqual(dimension?.paths,[["t_dimension","t_role","t_fact"]]);
  assert.deepEqual(dimension?.bindingRelationIds,[21,22]);
  assert.deepEqual(dimension?.bindingTables,["t_role"]);
  assert.deepEqual(dimension?.bindingIdentityColumns,["t_role.c22"]);
  assert.deepEqual(dimension?.bindingColumns,["t_role.c22","t_role.c21","t_role.is_deleted"]);
  assert.deepEqual(dimension?.bindingValidityPredicates,[{column:"t_role.is_deleted",operator:"=",valueType:"number",value:"0"}]);
  assert.deepEqual(dimension?.bindingProvenance,{kind:"published_ontology_role_object",schema:"sales_v6",roleObject:"clue_seller_assignment",roleDisplayName:"线索销售归属",subjectObject:"clue",dimensionObject:"seller",attribution:"current",linkTypes:[]});
  assert.ok(dimension?.labelColumns.includes("t_dimension.c32"));
  assert.equal(dimension?.bindingRelationIds.some((id)=>id===11||id===12),false);
});

function salesProdOntologyRetrieval(question) {
  const intent=parseQueryIntent(question,{now:new Date(2026,7,25)});
  const pages=[{pageType:"term",slug:"clue-order-event",title:"线索成单事件",aliases:["线索"],tables:["alpha_clue_order_rel"],content:"线索成单事件记录",sqlContent:"alpha_clue_order_rel.crm_clue_id",verified:true}];
  const tables=[
    {tableName:"alpha_clue_order_rel",comment:"线索成单关系"},
    {tableName:"alpha_crm_clue",comment:"CRM线索主表"},
    {tableName:"alpha_crm_clue_seller_rel",comment:"线索销售归属"},
    {tableName:"seller",comment:"销售人员"},
  ];
  const columnsByTable={
    alpha_clue_order_rel:[{columnName:"crm_clue_id",comment:"CRM线索主键"},{columnName:"order_time",comment:"线索成单时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
    alpha_crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"clue_id",comment:"线索业务ID",isUnique:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    alpha_crm_clue_seller_rel:[{columnName:"clue_id",comment:"线索业务ID"},{columnName:"seller_id",comment:"销售ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
    seller:[{columnName:"seller_alpha_id",comment:"销售ID",isPrimary:1},{columnName:"seller_alpha_name",comment:"销售姓名"}],
  };
  const relations=[
    {id:101,fromTable:"alpha_clue_order_rel",fromCol:"crm_clue_id",toTable:"alpha_crm_clue",toCol:"id",status:"confirmed",confidence:.78},
    {id:102,fromTable:"alpha_crm_clue_seller_rel",fromCol:"clue_id",toTable:"alpha_crm_clue",toCol:"clue_id",status:"confirmed",confidence:.79},
    {id:103,fromTable:"alpha_crm_clue_seller_rel",fromCol:"seller_id",toTable:"seller",toCol:"seller_alpha_id",status:"confirmed",confidence:.56},
  ];
  const ontologySchema={name:"sales_prod_v6",objectTypes:[
    // This same-concept event object sorts before alpha_crm_clue. It must not
    // become the subject anchor merely because it was retrieved first.
    {apiName:"clue_order_event",displayName:"线索成单关系",properties:[
      {apiName:"clue_id",displayName:"线索ID",mapping:{table:"alpha_clue_order_rel",column:"crm_clue_id"}},
    ]},
    {apiName:"crm_clue",displayName:"CRM线索",primaryKey:"id",properties:[
      {apiName:"id",displayName:"线索主键",mapping:{table:"alpha_crm_clue",column:"id"}},
      {apiName:"clue_id",displayName:"线索业务ID",mapping:{table:"alpha_crm_clue",column:"clue_id"}},
    ]},
    // Deliberately omit displayName/description: underscore token boundaries
    // and the mapped table name must still identify the seller dimension.
    {apiName:"orange_army_seller",primaryKey:"seller_id",properties:[
      {apiName:"seller_id",mapping:{table:"seller",column:"seller_alpha_id"}},
      {apiName:"seller_name",mapping:{table:"seller",column:"seller_alpha_name"}},
    ]},
    {apiName:"crm_clue_seller_rel",displayName:"线索销售归属",description:"维护线索与销售人员的归属关系",primaryKey:"clue_id",properties:[
      {apiName:"clue_id",displayName:"线索ID",description:"被分配的线索业务ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"clue_id"}},
      {apiName:"seller_id",displayName:"负责销售ID",description:"当前负责跟进该线索的销售人员ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"seller_id"}},
    ]},
  ],linkTypes:[]};
  return {intent,retrieval:retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,intent,ontologySchema,maxTables:10})};
}

test("sales_prod role path promotes the confirmed clue subject over an earlier same-concept event object",()=>{
  const {retrieval}=salesProdOntologyRetrieval("本月线索，按当前销售负责人做成单排行");
  const subject=retrieval.diagnostics.facets.find((item)=>item.key==="subject:clue");
  const dimension=retrieval.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.deepEqual(subject?.executionTables,["alpha_crm_clue"]);
  assert.equal(subject?.selectedTables[0],"alpha_crm_clue");
  assert.equal(dimension?.covered,true);
  assert.deepEqual(dimension?.paths,[["seller","alpha_crm_clue_seller_rel","alpha_crm_clue"]]);
  assert.deepEqual(dimension?.bindingRelationIds,[103,102]);
  assert.ok(dimension?.labelColumns.includes("seller.seller_alpha_name"));
});

test("published ontology ranks the clue root ahead of equal-scored config, pool, event, record and relation objects",()=>{
  const question="本月线索，销售成单排行";
  const intent=parseQueryIntent(question,{now:new Date(2026,7,25)});
  const tables=[
    {tableName:"alpha_ai_allocate_feishu_group_config",comment:"线索分配飞书群配置"},
    {tableName:"alpha_ai_allocate_pool",comment:"AI线索分配池"},
    {tableName:"alpha_clue_order_rel",comment:"线索成单关系"},
    {tableName:"alpha_crm_clue",comment:"CRM线索主表"},
    {tableName:"alpha_crm_clue_record",comment:"线索记录"},
    {tableName:"alpha_crm_clue_seller_rel",comment:"线索销售归属"},
    {tableName:"seller",comment:"橙军销售人员"},
  ];
  const columnsByTable={
    alpha_ai_allocate_feishu_group_config:[{columnName:"clue_type",comment:"线索类型"},{columnName:"group_id",comment:"群ID"}],
    alpha_ai_allocate_pool:[{columnName:"clue_id",comment:"线索ID"},{columnName:"seller_id",comment:"销售ID"}],
    alpha_clue_order_rel:[{columnName:"crm_clue_id",comment:"CRM线索主键"},{columnName:"order_time",comment:"线索成单时间"}],
    alpha_crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"clue_id",comment:"线索业务ID",isUnique:1}],
    alpha_crm_clue_record:[{columnName:"clue_id",comment:"线索ID"},{columnName:"created_at",comment:"记录时间"}],
    alpha_crm_clue_seller_rel:[{columnName:"clue_id",comment:"线索业务ID"},{columnName:"seller_id",comment:"销售ID"}],
    seller:[{columnName:"seller_alpha_id",comment:"销售ID",isPrimary:1},{columnName:"seller_alpha_name",comment:"销售姓名"}],
  };
  const ontologyObject=(apiName,displayName,table,column)=>({apiName,displayName,primaryKey:column,properties:[{apiName:column,displayName:column,mapping:{table,column}}]});
  const ontologySchema={name:"sales_prod_v6",objectTypes:[
    ontologyObject("ai_allocate_feishu_group_config","线索分配飞书群配置","alpha_ai_allocate_feishu_group_config","clue_type"),
    ontologyObject("ai_allocate_pool","AI线索分配池","alpha_ai_allocate_pool","clue_id"),
    ontologyObject("alpha_clue_order_relation","线索成单关系","alpha_clue_order_rel","crm_clue_id"),
    ontologyObject("crm_clue","CRM线索","alpha_crm_clue","id"),
    ontologyObject("crm_clue_record","线索记录","alpha_crm_clue_record","clue_id"),
    ontologyObject("crm_clue_seller_rel","线索销售归属","alpha_crm_clue_seller_rel","clue_id"),
    ontologyObject("orange_army_seller","橙军销售人员","seller","seller_alpha_id"),
  ],linkTypes:[]};
  const relations=[{id:301,fromTable:"alpha_clue_order_rel",fromCol:"crm_clue_id",toTable:"alpha_crm_clue",toCol:"id",status:"confirmed",confidence:1}];
  const retrieval=retrieveKnowledge({question,pages:[],tables,columnsByTable,relations,intent,ontologySchema,maxTables:12});
  const byKey=(key)=>retrieval.diagnostics.facets.find((item)=>item.key===key);
  const subject=byKey("subject:clue");
  assert.deepEqual(subject?.executionTables,["alpha_crm_clue"]);
  assert.equal(subject?.selectedTables[0],"alpha_crm_clue");
  assert.equal(subject?.candidates[0]?.name,"alpha_crm_clue");
  assert.deepEqual(byKey("measure:won")?.executionTables,["alpha_clue_order_rel"]);
  assert.deepEqual(byKey("time:current_month")?.executionTables,["alpha_clue_order_rel"]);
});

test("an exact ontology root identity outranks a merely canonical physical table name",()=>{
  const question="查询线索";const intent=parseQueryIntent(question);
  const tables=[{tableName:"a_clue_config",comment:"线索配置"},{tableName:"b_clue",comment:"线索事件缓存"},{tableName:"z_fact_store",comment:""}];
  const columnsByTable={a_clue_config:[{columnName:"clue_type",comment:"线索类型"}],b_clue:[{columnName:"event_id",comment:"事件ID"}],z_fact_store:[{columnName:"c01",comment:"",isPrimary:1}]};
  const ontologySchema={name:"semantic_identity",objectTypes:[
    {apiName:"clue_config",displayName:"线索配置",primaryKey:"clue_type",properties:[{apiName:"clue_type",mapping:{table:"a_clue_config",column:"clue_type"}}]},
    {apiName:"clue_event",displayName:"线索事件",primaryKey:"event_id",properties:[{apiName:"event_id",mapping:{table:"b_clue",column:"event_id"}}]},
    {apiName:"crm_clue",displayName:"CRM线索",primaryKey:"id",properties:[{apiName:"id",displayName:"线索主键",mapping:{table:"z_fact_store",column:"c01"}}]},
  ],linkTypes:[]};
  const retrieval=retrieveKnowledge({question,pages:[],tables,columnsByTable,relations:[],intent,ontologySchema});
  const subject=retrieval.diagnostics.facets.find((item)=>item.key==="subject:clue");
  assert.deepEqual(subject?.executionTables,["z_fact_store"]);
  assert.equal(subject?.candidates[0]?.name,"z_fact_store");
});

test("subject structural fallback prefers a declared main object but still permits an auxiliary-only schema",()=>{
  const question="查询线索";const intent=parseQueryIntent(question);
  const auxiliaryTables=[{tableName:"a_clue_config",comment:"线索分配配置"},{tableName:"b_clue_pool",comment:"线索池"}];
  const auxiliaryColumns={a_clue_config:[{columnName:"clue_type",comment:"线索类型"}],b_clue_pool:[{columnName:"clue_id",comment:"线索ID"}]};
  const root={tableName:"z_business_entity",comment:"CRM线索主表，一条线索一行"};
  const retrieval=retrieveKnowledge({
    question,pages:[],tables:[...auxiliaryTables,root],relations:[],intent,
    columnsByTable:{...auxiliaryColumns,z_business_entity:[{columnName:"id",comment:"线索主键",isPrimary:1}]},
  });
  assert.deepEqual(retrieval.diagnostics.facets.find((item)=>item.key==="subject:clue")?.executionTables,["z_business_entity"]);

  const auxiliaryOnly=retrieveKnowledge({question,pages:[],tables:[auxiliaryTables[0]],columnsByTable:{a_clue_config:auxiliaryColumns.a_clue_config},relations:[],intent});
  const subject=auxiliaryOnly.diagnostics.facets.find((item)=>item.key==="subject:clue");
  assert.equal(subject?.covered,true);
  assert.deepEqual(subject?.executionTables,["a_clue_config"]);
});

test("structural execution facets publish exact active-row predicates unless deleted rows were explicitly requested",()=>{
  const active=salesProdOntologyRetrieval("本月线索，按当前销售负责人做成单排行").retrieval;
  const byKind=(retrieval,kind)=>retrieval.diagnostics.facets.find((item)=>item.kind===kind);
  const activePredicate={column:"alpha_crm_clue.is_deleted",operator:"=",valueType:"number",value:"0"};
  const eventPredicate={column:"alpha_clue_order_rel.is_deleted",operator:"=",valueType:"number",value:"0"};
  const bridgePredicate={column:"alpha_crm_clue_seller_rel.is_deleted",operator:"=",valueType:"number",value:"0"};
  assert.deepEqual(byKind(active,"subject")?.executionValidityPredicates,[activePredicate]);
  assert.deepEqual(byKind(active,"measure")?.executionValidityPredicates,[eventPredicate]);
  assert.deepEqual(byKind(active,"time")?.executionValidityPredicates,[eventPredicate]);
  assert.deepEqual(byKind(active,"dimension")?.bindingValidityPredicates,[bridgePredicate]);
  assert.deepEqual(byKind(active,"dimension")?.executionValidityPredicates,[bridgePredicate]);

  const deleted=salesProdOntologyRetrieval("本月已删除线索，按当前销售负责人做成单排行").retrieval;
  assert.deepEqual(byKind(deleted,"subject")?.executionValidityPredicates,[]);
  for(const kind of ["measure","time"])assert.deepEqual(byKind(deleted,kind)?.executionValidityPredicates,[eventPredicate],kind);
  assert.deepEqual(byKind(deleted,"dimension")?.bindingValidityPredicates,[bridgePredicate]);
  assert.deepEqual(byKind(deleted,"dimension")?.executionValidityPredicates,[bridgePredicate]);
});

test("include-deleted relaxes only is_deleted while exact is_valid remains a closed-world row invariant",()=>{
  const tables=[
    {tableName:"crm_clue",comment:"线索主表"},
    {tableName:"clue_audit_log",comment:"线索审计日志"},
  ];
  const columnsByTable={
    crm_clue:[
      {columnName:"id",comment:"线索主键",isPrimary:1},
      {columnName:"is_deleted",comment:"逻辑删除"},
      {columnName:"is_valid",comment:""},
      {columnName:"status",comment:"有效状态"},
      {columnName:"enabled",comment:"是否启用"},
    ],
    clue_audit_log:[{columnName:"clue_id",comment:"线索ID"},{columnName:"is_valid",comment:"审计记录有效标记"}],
  };
  const retrieve=(question)=>{
    const intent=parseQueryIntent(question);
    return retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations:[],intent});
  };
  const subject=(result)=>result.diagnostics.facets.find((item)=>item.key==="subject:clue");
  assert.deepEqual(subject(retrieve("查询线索"))?.executionValidityPredicates,[
    {column:"crm_clue.is_deleted",operator:"=",valueType:"number",value:"0"},
    {column:"crm_clue.is_valid",operator:"=",valueType:"number",value:"1"},
  ]);
  const includeDeleted=subject(retrieve("查询线索，包括已删除"));
  assert.deepEqual(includeDeleted?.executionTables,["crm_clue"]);
  assert.deepEqual(includeDeleted?.executionValidityPredicates,[
    {column:"crm_clue.is_valid",operator:"=",valueType:"number",value:"1"},
  ]);
  assert.equal(includeDeleted?.executionValidityPredicates.some((item)=>item.column.startsWith("clue_audit_log.")||/\.(?:status|enabled)$/.test(item.column)),false);
});

test("every confirmed intermediate bridge publishes an active-row predicate even when the subject deletion scope is relaxed",()=>{
  const tables=[
    {tableName:"crm_clue",comment:"线索主表"},
    {tableName:"clue_event_bridge",comment:"线索与成单事件关系"},
    {tableName:"deal_event",comment:"成单事件"},
  ];
  const columnsByTable={
    crm_clue:[{columnName:"id",comment:"线索主键",isPrimary:1},{columnName:"is_deleted",comment:"逻辑删除"}],
    clue_event_bridge:[{columnName:"clue_id",comment:"线索ID"},{columnName:"event_id",comment:"事件ID"},{columnName:"is_deleted",comment:"逻辑删除"}],
    deal_event:[{columnName:"id",comment:"事件ID",isPrimary:1},{columnName:"completed_at",comment:"成单时间"},{columnName:"is_deleted",comment:"逻辑删除"}],
  };
  const relations=[
    {id:192,fromTable:"deal_event",fromCol:"id",toTable:"clue_event_bridge",toCol:"event_id",status:"confirmed",confidence:1},
    {id:193,fromTable:"clue_event_bridge",fromCol:"clue_id",toTable:"crm_clue",toCol:"id",status:"confirmed",confidence:1},
  ];
  const retrieve=(question)=>{const intent=parseQueryIntent(question,{now:new Date(2026,7,25)});return retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,intent,maxTables:8});};
  const bridgePredicate={column:"clue_event_bridge.is_deleted",operator:"=",valueType:"number",value:"0"};
  const eventPredicate={column:"deal_event.is_deleted",operator:"=",valueType:"number",value:"0"};
  for(const result of [retrieve("本月线索成单数"),retrieve("本月已删除线索成单数")]) {
    const measure=result.diagnostics.facets.find((item)=>item.key==="measure:won");
    assert.ok(measure?.paths.some((path)=>path.join("/")==="deal_event/clue_event_bridge/crm_clue"));
    assert.deepEqual(measure?.executionValidityPredicates,[bridgePredicate,eventPredicate]);
    assert.ok(result.tableNames.includes("clue_event_bridge"));
  }
});

test("a rejected ontology role edge cannot become an attribution path or fall back to another confirmed route",()=>{
  const intent=parseQueryIntent("按当前销售负责人统计线索数量排行");
  const tables=["t_fact","t_feed","t_role","t_dimension"].map((tableName)=>({tableName,comment:""}));
  const columnsByTable={
    t_fact:[{columnName:"c01",comment:""}],t_feed:[{columnName:"c11",comment:""},{columnName:"c12",comment:""}],
    t_role:[{columnName:"c21",comment:""},{columnName:"c22",comment:""},{columnName:"is_current",comment:""}],
    t_dimension:[{columnName:"c31",comment:""},{columnName:"c32",comment:""}],
  };
  const relations=[
    {id:11,fromTable:"t_dimension",fromCol:"c31",toTable:"t_feed",toCol:"c12",status:"confirmed",confidence:.99},
    {id:12,fromTable:"t_feed",fromCol:"c11",toTable:"t_fact",toCol:"c01",status:"confirmed",confidence:.99},
    {id:21,fromTable:"t_dimension",fromCol:"c31",toTable:"t_role",toCol:"c22",status:"rejected",confidence:1},
    {id:22,fromTable:"t_role",fromCol:"c21",toTable:"t_fact",toCol:"c01",status:"confirmed",confidence:1},
  ];
  const ontologySchema={name:"sales_v6",objectTypes:[
    {apiName:"clue",displayName:"线索",description:"线索业务对象",primaryKey:"identity",properties:[{apiName:"identity",displayName:"线索标识",description:"线索ID",mapping:{table:"t_fact",column:"c01"}}]},
    {apiName:"seller",displayName:"销售人员",description:"销售人员业务对象",primaryKey:"identity",properties:[{apiName:"identity",displayName:"销售标识",description:"销售人员ID",mapping:{table:"t_dimension",column:"c31"}},{apiName:"label",displayName:"销售姓名",description:"销售人员姓名",mapping:{table:"t_dimension",column:"c32"}}]},
    {apiName:"assignment",displayName:"线索销售归属",description:"维护线索与销售归属",primaryKey:"clue_ref",properties:[{apiName:"clue_ref",displayName:"线索引用",description:"线索ID",mapping:{table:"t_role",column:"c21"}},{apiName:"seller_ref",displayName:"当前销售引用",description:"当前负责跟进该线索的销售人员ID",mapping:{table:"t_role",column:"c22"}},{apiName:"validity",displayName:"当前有效",description:"当前归属有效状态",mapping:{table:"t_role",column:"is_current"}}]},
  ],linkTypes:[]};
  const result=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations,intent,ontologySchema});
  const dimension=result.diagnostics.facets.find((item)=>item.key==="dimension:seller");
  assert.equal(dimension?.covered,false);
  assert.deepEqual(dimension?.selectedTables,[]);
  assert.deepEqual(dimension?.bindingRelationIds,[]);
  assert.deepEqual(dimension?.bindingTables,[]);
  assert.ok(result.coverageContract.missing.includes("dimension:seller"));
  assert.equal(dimension?.paths.some((path)=>path.includes("t_feed")),false);
});

test("analytical retrieval does not call subject plus a generic creation timestamp complete",()=>{
  const intent=parseQueryIntent("按当前销售负责人统计本月实际成单线索排行",{now:new Date(2026,7,25)});
  const tables=[{tableName:"lead_entity",comment:"线索主表"},{tableName:"lead_owner_rel",comment:"线索销售负责人关系"}];
  const columnsByTable={lead_entity:[{columnName:"id",comment:"线索主键"},{columnName:"created_at",comment:"线索进线时间"}],lead_owner_rel:[{columnName:"lead_id",comment:"线索ID"},{columnName:"owner_name",comment:"销售姓名"}]};
  const result=retrieveKnowledge({question:intent.rawQuestion,pages:[],tables,columnsByTable,relations:[],intent});
  assert.ok(result.coverageContract.missing.includes("measure:won"));
  assert.ok(result.coverageContract.missing.includes("time:current_month"));
});

test("unverified or fieldless pages cannot fabricate semantic analytical coverage",()=>{
  const intent=parseQueryIntent("本月线索成单数",{now:new Date(2026,7,25)});
  const pages=[{pageType:"term",slug:"generic-lead",title:"线索",aliases:[],tables:["lead_entity"],content:"未审核说明",sqlContent:"",verified:false}];
  const tables=[{tableName:"lead_entity",comment:"线索主表"}];
  const columnsByTable={lead_entity:[{columnName:"id",comment:"线索主键"},{columnName:"created_at",comment:"线索创建时间"}]};
  const result=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations:[],intent});
  assert.equal(result.coverage,"structural");
  assert.ok(result.coverageContract.missing.includes("measure:won"));
  assert.ok(result.coverageContract.missing.includes("time:current_month"));
});

test("an unrelated verified page cannot consume the event-time facet slot",()=>{
  const intent=parseQueryIntent("本月线索，销售成单排行",{now:new Date(2026,7,25)});
  const pages=[{
    pageType:"term",slug:"account-law-firm",title:"销售账号",aliases:["销售"],
    tables:["alpha_account_user"],content:"销售账号律所及创建时间",sqlContent:"alpha_account_user.user_office_name LIKE ?",verified:true,
  }];
  const tables=[
    {tableName:"alpha_crm_clue",comment:"线索主表"},
    {tableName:"alpha_clue_order_rel",comment:"线索订单关系"},
    {tableName:"alpha_account_user",comment:"账号主表"},
    {tableName:"seller",comment:"销售人员"},
  ];
  const columnsByTable={
    alpha_crm_clue:[{columnName:"clue_id",comment:"线索ID"}],
    alpha_clue_order_rel:[{columnName:"crm_clue_id",comment:"线索ID"},{columnName:"order_time",comment:"成单时间"}],
    alpha_account_user:[{columnName:"user_office_name",comment:"用户所属律所"},{columnName:"created_at",comment:"账号创建时间"}],
    seller:[{columnName:"seller_alpha_id",comment:"销售ID"},{columnName:"seller_alpha_name",comment:"销售姓名"}],
  };
  const relations=[{fromTable:"alpha_clue_order_rel",toTable:"alpha_crm_clue"},{fromTable:"seller",toTable:"alpha_crm_clue"}];
  const result=retrieveKnowledge({question:intent.rawQuestion,pages,tables,columnsByTable,relations,maxTables:4,intent});
  const time=result.diagnostics.facets.find((item)=>item.key==="time:current_month");
  assert.ok(result.pages.some((page)=>page.slug==="account-law-firm"));
  assert.equal(time?.covered,true);
  assert.deepEqual(time?.selectedTables,["alpha_clue_order_rel"]);
  assert.deepEqual(time?.executionColumns,["alpha_clue_order_rel.order_time"]);
  assert.equal(time?.candidates.some((item)=>item.name==="alpha_account_user"),false);
  assert.equal(result.coverageContract.missing.includes("time:current_month"),false);
});

test("an exact verified COUNT star metric may use its bound row grain without a physical measure column",()=>{
  const pages=[{
    pageType:"metric",slug:"clue-event-volume",title:"线索事件量",aliases:["事件量"],
    tables:["clue_event_log"],content:"每行是一条线索事件，按事件行统计。",sqlContent:"COUNT(*)",verified:true,
  }];
  const columnsByTable={clue_event_log:[{columnName:"event_uuid",comment:"事件唯一键"},{columnName:"is_deleted",comment:"逻辑删除"}]};
  const intent=parseQueryIntent("统计线索事件量",{concepts:knowledgeIntentConcepts(pages,columnsByTable)});
  const result=retrieveKnowledge({
    question:intent.rawQuestion,pages,tables:[{tableName:"clue_event_log",comment:"线索事件日志"}],
    columnsByTable,relations:[],intent,
  });
  const measure=result.diagnostics.facets.find((item)=>item.kind==="measure");
  assert.equal(intent.measures[0]?.metricDefinition?.rowCount,true);
  assert.equal(measure?.covered,true);
  assert.deepEqual(measure?.executionTables,["clue_event_log"]);
  assert.deepEqual(measure?.executionColumns,[]);
  assert.deepEqual(measure?.executionValidityPredicates,[],"verified metric definitions must not receive guessed row-validity filters");
  assert.deepEqual(result.coverageContract.missing,[]);
});

test("fieldless row-count evidence stays closed when verification or evidence provenance does not match",()=>{
  const page={pageType:"metric",slug:"event-volume",title:"事件量",aliases:[],tables:["event_log"],content:"每行一条事件",sqlContent:"COUNT(*)",verified:false};
  const intent=parseQueryIntent("统计事件量",{concepts:[{
    kind:"measure",value:"event_volume",aliases:["事件量"],aggregation:"count",grain:"event",
    terms:["事件量"],evidence:{level:"verified_knowledge",page:"metric:event-volume"},
    metricDefinition:{aggregation:"count",columns:[],tables:["event_log"],source:"metric:other",rowCount:true},
  }]});
  const result=retrieveKnowledge({question:intent.rawQuestion,pages:[page],tables:[{tableName:"event_log",comment:"事件日志"}],columnsByTable:{event_log:[{columnName:"opaque_uuid",comment:"唯一键"}]},relations:[],intent});
  assert.ok(result.coverageContract.missing.some((key)=>key.startsWith("measure:")));
});

test("a structurally bound custom dimension retains executable and label columns",()=>{
  const intent=parseQueryIntent("按线索等级统计线索数量");
  const result=retrieveKnowledge({
    question:intent.rawQuestion,pages:[],tables:[{tableName:"crm_clue",comment:"线索主表"}],relations:[],intent,
    columnsByTable:{crm_clue:[
      {columnName:"id",comment:"线索主键"},
      {columnName:"level_code",comment:"线索等级编码"},
      {columnName:"level_name",comment:"线索等级名称"},
    ]},
  });
  const dimension=result.diagnostics.facets.find((item)=>item.kind==="dimension");
  assert.equal(dimension?.covered,true);
  assert.ok(dimension?.executionColumns.includes("crm_clue.level_code"));
  assert.ok(dimension?.labelColumns.includes("crm_clue.level_name"));
  assert.deepEqual(result.coverageContract.missing,[]);
});

test("structural retrieval recognizes bilingual business concepts, penalizes copies and expands only one hop",()=>{
  const tables=[
    {tableName:"alpha_crm_clue",comment:"线索主表"},
    {tableName:"alpha_crm_clue_copy1",comment:"线索备份"},
    {tableName:"alpha_crm_clue_seller_rel",comment:""},
    {tableName:"seller",comment:"销售人员"},
    {tableName:"org_team",comment:"组织单元"},
  ];
  const columnsByTable={
    alpha_crm_clue:[{columnName:"clue_id",comment:"线索ID"},{columnName:"clue_allot_time",comment:"分配时间"}],
    alpha_crm_clue_copy1:[{columnName:"clue_id",comment:"线索ID"},{columnName:"clue_allot_time",comment:"分配时间"}],
    alpha_crm_clue_seller_rel:[{columnName:"clue_id",comment:"线索ID"},{columnName:"seller_name",comment:"销售姓名"},{columnName:"gmt_create",comment:"创建时间"}],
    seller:[{columnName:"seller_alpha_id",comment:"销售ID"},{columnName:"seller_alpha_name",comment:"销售姓名"}],
    org_team:[{columnName:"team_id",comment:"组织ID"}],
  };
  const relations=[{fromTable:"alpha_crm_clue_seller_rel",toTable:"alpha_crm_clue"},{fromTable:"alpha_crm_clue",toTable:"seller"},{fromTable:"seller",toTable:"org_team"}];
  const conceptAliases=[{match:"线索|商机线索",terms:["clue"]},{match:"分配|派发|指派",terms:["allot","assign","allocate"]},{match:"销售|负责人",terms:["seller"]}];
  const result=retrieveKnowledge({question:"查询赵一鸣本月分配的线索",pages:[],tables,columnsByTable,relations,maxTables:4,conceptAliases});
  assert.ok(result.tableNames.includes("alpha_crm_clue_seller_rel"));
  assert.ok(result.tableNames.indexOf("alpha_crm_clue_copy1")===-1||result.tableNames.indexOf("alpha_crm_clue_copy1")>result.tableNames.indexOf("alpha_crm_clue"));
  assert.equal(result.tableNames.includes("org_team"),false,"relation expansion must not cascade beyond direct structural matches");
});

test("write operations reject a missing or incorrect local token",()=>{
  const runtime={writeToken:"correct-token"};
  assert.throws(()=>serverInternal.requireWrite({headers:{}},runtime),/令牌/);
  assert.throws(()=>serverInternal.requireWrite({headers:{"x-ontoquery-token":"wrong"}},runtime),/令牌/);
  assert.doesNotThrow(()=>serverInternal.requireWrite({headers:{"x-ontoquery-token":"correct-token"}},runtime));
});

test("two relations between the same table pair produce distinct join pages",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  store.upsertRelation({sourceId:3,fromTable:"sales_order",fromCol:"created_by",toTable:"sys_user",toCol:"user_id",cardinality:"N:1",confidence:1,overlapRatio:1,status:"confirmed",inferenceSource:"foreign_key"});
  store.upsertRelation({sourceId:3,fromTable:"sales_order",fromCol:"assigned_to",toTable:"sys_user",toCol:"user_id",cardinality:"N:1",confidence:1,overlapRatio:1,status:"confirmed",inferenceSource:"foreign_key"});
  const joins=service.list(3).filter((page)=>page.pageType==="join");
  assert.equal(joins.length,2);
  assert.notEqual(joins[0].slug,joins[1].slug);
  assert.ok(joins.some((page)=>page.sqlContent.includes("created_by")));
  assert.ok(joins.some((page)=>page.sqlContent.includes("assigned_to")));
  store.close();
});
