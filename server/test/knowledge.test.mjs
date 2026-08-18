import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { retrieveKnowledge } from "../src/knowledge-retrieval.mjs";
import { parseQueryIntent } from "../src/query-intent.mjs";
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
