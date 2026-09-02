import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQueryService, _internal as queryInternal } from "../src/query-service.mjs";
import { _internal as agentInternal } from "../src/query-agent-loop.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { compileSemanticQueryPlan } from "../src/semantic-query-plan.mjs";
import { createStore } from "../src/store.mjs";

async function createFixture() {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-agent-loop-"));
  const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"客户编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"notes",dataType:"text",isPrimary:0,isSensitive:0,comment:"客户备注"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"mobile",dataType:"varchar",isPrimary:0,isSensitive:1,comment:"手机号"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"有效客户",title:"有效客户",aliases:"[]",tablesJson:'["crm_customer"]',content:"已实名客户",sqlContent:"按客户编号查询",antiExamples:"不得查询手机号",verified:1,owner:"owner"});
  return {store,source};
}

function config(mode="required",overrides={}) {
  return {llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-agent-test",model:"agent-test"},queryAgentMode:mode,queryAgentMaxIterations:8,queryAgentMaxSqlCalls:5,queryAgentMaxScannedRows:1_000,queryMaxRows:100,explainMaxRows:1_000,queryLlmTimeoutMs:5_000,semanticQueryPlanMode:"off",...overrides};
}

function llmResponse(content) {
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:11,completion_tokens:4,total_tokens:15}}),{status:200,headers:{"content-type":"application/json"}});
}

test("agent loop feeds guard failures back to the model, corrects SQL and audits the tool trace",async()=>{
  const {store,source}=await createFixture();
  let queries=0;
  const connector={explain:async()=>[{rows:10}],query:async()=>{queries++;return [[{customer_id:7}],[{name:"customer_id"}]];}};
  const actions=[
    {thought:"先尝试读取全部客户信息。",tool:"run_sql",args:{sql:"SELECT * FROM crm_customer"}},
    {thought:"星号被护栏拦截，改为显式查询客户编号。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"已取得可靠结果，提交结论。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到 1 位有效客户。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"查询到 1 位有效客户。");
    assert.equal(answer.evidence.planningMode,"agent");
    assert.equal(answer.evidence.iterations,3);
    assert.deepEqual(answer.evidence.tokenUsage,{promptTokens:33,completionTokens:12,totalTokens:45,available:true});
    assert.equal(queries,1);
    assert.match(requests[0].messages.map((item)=>item.content).join("\n"),/"name":"mobile".*"semanticKind":"phone"/);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.planningMode,"agent");
    assert.equal(audit.iterations,3);
    assert.deepEqual(audit.toolTrace.map((item)=>[item.tool,item.ok]),[["run_sql",false],["run_sql",true],["submit_answer",true]]);
    assert.match(audit.toolTrace[0].summary,/禁止 SELECT \*/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("agent queries a previously sensitive column normally while retaining phone-field semantics",async()=>{
  const {store,source}=await createFixture();const calls=[];
  const connector={explain:async(_source,sql)=>{calls.push({kind:"explain",sql});return [{rows:1}];},query:async(_source,sql,params)=>{calls.push({kind:"query",sql,params});return [[{customer_id:7,mobile:"13800138000"}],[{name:"customer_id"},{name:"mobile"}]];}};
  const actions=[
    {thought:"按手机号定位客户并返回手机号和客户编号。",tool:"run_sql",args:{sql:"SELECT customer_id, mobile FROM crm_customer WHERE mobile = '13800138000'"}},
    {thought:"提交已执行的查询结果。",tool:"submit_answer",args:{sql:"SELECT customer_id, mobile FROM crm_customer WHERE mobile = '13800138000'",conclusion:"查询到客户编号 7。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config()});const answer=await service.ask({sourceId:source.id,question:"查询手机号13800138000对应的客户编号",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户编号 7。");assert.equal(answer.rows[0].mobile,"13800138000");assert.deepEqual(calls.find((item)=>item.kind==="query").params,[]);assert.ok(calls.every((item)=>item.sql.includes("13800138000")));
    assert.match(requests[0].messages.at(-1).content,/"name":"mobile".*"semanticKind":"phone"/);
    assert.match(answer.evidence.sql,/13800138000/);assert.match(JSON.stringify(store.listAudits(source.id,1)[0].toolTrace),/13800138000/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent rejects splitting a law-firm proper name across multiple LIKE filters",async()=>{
  const {store,source}=await createFixture();
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:10,grade:"A",active:1,comment:"Alpha 用户账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"Alpha 用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alp_office_name",dataType:"varchar",isSensitive:0,comment:"所属律所名称"});
  const splitSql="SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京%' AND alp_office_name LIKE '%大成%'";
  const directSql="SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京大成%'";
  let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{alpha_id:"alpha-1"}],[{name:"alpha_id"}]];}};
  const actions=[
    {thought:"拆分机构名过滤。",tool:"run_sql",args:{sql:splitSql}},
    {thought:"按完整机构专名重新过滤。",tool:"run_sql",args:{sql:directSql}},
    {thought:"提交已验证结果。",tool:"submit_answer",args:{sql:directSql,conclusion:"查询到北京大成律所账号。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询北京大成律所账号情况",userName:"tester"});
    assert.equal(queries,1);
    assert.match(answer.evidence.toolTrace[0].summary,/机构专名“北京大成”必须作为连续字符串过滤/);
    assert.match(answer.evidence.sql,/LIKE '%北京大成%'/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent preserves 北京大成 as an organization for monthly incoming clues and ignores another table's city enum",async()=>{
  const {store,source}=await createFixture();
  store.upsertTable({sourceId:source.id,tableName:"alpha_crm_clue",rowEstimate:10,grade:"A",active:1,comment:"CRM 进线线索"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName:"office_name",dataType:"varchar",isSensitive:0,comment:"律所名称"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName:"city",dataType:"varchar",isSensitive:0,comment:"市"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName:"clue_create_time",dataType:"datetime",isSensitive:0,comment:"线索进线时间"});
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:10,grade:"A",active:1,comment:"Alpha 用户"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"city",dataType:"varchar",isSensitive:0,comment:"城市"});
  store.upsertEnum({sourceId:source.id,tableName:"alpha_user",columnName:"city",value:"北京",count:10,ratio:1});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"进线线索",title:"进线线索",aliases:'["线索"]',tablesJson:'["alpha_crm_clue"]',content:"CRM 收到的进线线索",sqlContent:"按 clue_create_time 统计",antiExamples:"机构名不能当作城市",verified:1,owner:"owner"});
  const wrongSql="SELECT clue_id FROM alpha_crm_clue WHERE city = '北京市'";
  const correctSql="SELECT clue_id, office_name, clue_create_time FROM alpha_crm_clue WHERE office_name LIKE '%北京大成%' AND clue_create_time >= '2026-08-01' AND clue_create_time < '2026-09-01'";
  let queryCalls=0;
  const connector={explain:async()=>[{rows:2}],query:async()=>{queryCalls++;return [[{clue_id:1,office_name:"北京大成",clue_create_time:"2026-08-10"}],[{name:"clue_id"},{name:"office_name"},{name:"clue_create_time"}]];}};
  const actions=[
    {thought:"先按城市尝试。",tool:"run_sql",args:{sql:wrongSql}},
    {thought:"保持机构原文并使用进线时间。",tool:"run_sql",args:{sql:correctSql}},
    {thought:"提交已验证结果。",tool:"submit_answer",args:{sql:correctSql,conclusion:"查询到北京大成本月进线线索。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询一下北京大成本月进线的线索",userName:"tester"});
    assert.equal(queryCalls,1);
    assert.equal(answer.conclusion,"查询到北京大成本月进线线索。");
    assert.equal(answer.evidence.toolTrace[0].errorCode,"INTENT_ENTITY_DROPPED");
    assert.match(answer.evidence.sql,/office_name.*北京大成/i);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.intentVersion,"2.0");
    assert.deepEqual(audit.intent.entities.map((item)=>item.text),["北京大成"]);
    assert.equal(audit.retrievalTrace.selectedTables.includes("alpha_crm_clue"),true);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent blocks an identical repeated action before it consumes another SQL execution",async()=>{
  const {store,source}=await createFixture();let queries=0;
  const badSql="SELECT * FROM crm_customer";const goodSql="SELECT customer_id FROM crm_customer";
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:7}],[{name:"customer_id"}]];}};
  const actions=[
    {thought:"尝试查询。",tool:"run_sql",args:{sql:badSql}},
    {thought:"重复同一查询。",tool:"run_sql",args:{sql:badSql}},
    {thought:"改为明确字段。",tool:"run_sql",args:{sql:goodSql}},
    {thought:"提交结果。",tool:"submit_answer",args:{sql:goodSql,conclusion:"查询到客户。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(queries,1);
    assert.equal(answer.evidence.toolTrace[1].errorCode,"REPEATED_ACTION");
    assert.equal(answer.evidence.toolTrace[1].phase,"EXECUTE");
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("a successful context search is removed from the next tool menu so the loop must advance",async()=>{
  const {store,source}=await createFixture();let queries=0;const requests=[];
  const sql="SELECT customer_id FROM crm_customer";
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:7}],[{name:"customer_id"}]];}};
  const actions=[
    {thought:"先补充检索。",tool:"search_context",args:{query:"有效客户"}},
    {thought:"查看命中表结构。",tool:"get_schema",args:{tables:["crm_customer"]}},
    {thought:"执行已确认查询。",tool:"run_sql",args:{sql}},
    {thought:"提交结果。",tool:"submit_answer",args:{sql,conclusion:"查询到客户。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户。");assert.equal(queries,1);
    assert.ok(requests[0].tools.some((item)=>item.function.name==="search_context"));
    assert.ok(!requests[1].tools.some((item)=>item.function.name==="search_context"));
    assert.deepEqual(answer.evidence.toolTrace.map((item)=>item.tool),["search_context","get_schema","run_sql","submit_answer"]);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("two consecutive repeated actions trip the no-progress circuit breaker",async()=>{
  const {store,source}=await createFixture();let modelCalls=0;
  const repeated={thought:"重复查看相同结构。",tool:"get_schema",args:{tables:["crm_customer"]}};
  const actions=[{...repeated,thought:"查看结构。"},repeated,repeated];
  const connector={explain:async()=>[{rows:1}],query:async()=>{throw new Error("不应执行 SQL");}};
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{modelCalls++;if(!actions.length)throw new Error("熔断后不应继续请求模型");return llmResponse(actions.shift());};
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.refused,true);assert.equal(answer.failureClass,"budget_exhausted");assert.equal(modelCalls,3);
    assert.deepEqual(answer.toolTrace.map((item)=>item.errorCode||null),[null,"REPEATED_ACTION","REPEATED_ACTION_LIMIT"]);
    assert.equal(answer.toolTrace.at(-1).retryable,false);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("unknown clue table failures suggest real catalog tables for deterministic repair",async()=>{
  const {store,source}=await createFixture();store.upsertTable({sourceId:source.id,tableName:"alpha_crm_clue",rowEstimate:10,grade:"A",active:1,comment:"线索主表"});store.upsertColumn({sourceId:source.id,tableName:"alpha_crm_clue",columnName:"clue_id",dataType:"bigint",comment:"线索编号"});
  const wrongSql="SELECT clue_id FROM crm_clue";const rightSql="SELECT clue_id FROM alpha_crm_clue";let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{clue_id:1}],[{name:"clue_id"}]];}};
  const actions=[
    {thought:"尝试线索表。",tool:"run_sql",args:{sql:wrongSql}},
    {thought:"查看建议的真实表。",tool:"get_schema",args:{tables:["alpha_crm_clue"]}},
    {thought:"执行修正查询。",tool:"run_sql",args:{sql:rightSql}},
    {thought:"提交结果。",tool:"submit_answer",args:{sql:rightSql,conclusion:"查询到线索。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"查询线索",userName:"tester"});assert.equal(answer.conclusion,"查询到线索。");assert.equal(queries,1);
    assert.equal(answer.evidence.toolTrace[0].errorCode,"UNKNOWN_TABLE");assert.match(answer.evidence.toolTrace[0].summary,/alpha_crm_clue/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent rejects a valid but unrelated table before executing a business-object query",async()=>{
  const {store,source}=await createFixture();
  store.upsertTable({sourceId:source.id,tableName:"sales_order",rowEstimate:10,grade:"A",active:1,comment:"订单主表"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"order_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"订单编号"});
  const wrongSql="SELECT customer_id FROM crm_customer";
  const rightSql="SELECT order_id FROM sales_order";
  let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{order_id:1}],[{name:"order_id"}]];}};
  const actions=[
    {thought:"先从客户表查询。",tool:"run_sql",args:{sql:wrongSql}},
    {thought:"改用检索契约中的订单事实表。",tool:"run_sql",args:{sql:rightSql}},
    {thought:"提交订单结果。",tool:"submit_answer",args:{sql:rightSql,conclusion:"查询到订单。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"查询订单",userName:"tester"});
    assert.equal(queries,1);assert.equal(answer.conclusion,"查询到订单。");
    assert.equal(answer.evidence.toolTrace[0].errorCode,"INTENT_SUBJECT_DROPPED");
    assert.match(answer.evidence.toolTrace[0].summary,/业务对象/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent result contract rejects an executable analytical shortcut before EXPLAIN and accepts the repaired lineage",async()=>{
  const {store,source}=await createFixture();
  const definitions={
    lead_entity:{comment:"线索主表",columns:[
      ["id","bigint",1,"线索主键"],["created_at","datetime",0,"线索进线时间"],["allocated_owner_id","varchar",0,"线索分配人ID"],["is_won","tinyint",0,"是否赢单"],
    ]},
    deal_event:{comment:"线索成单事件",columns:[["id","bigint",1,"事件主键"],["lead_id","bigint",0,"线索ID"],["completed_at","datetime",0,"订单成单时间"]]},
    lead_owner_rel:{comment:"线索销售负责人关系",columns:[["lead_id","bigint",0,"线索ID"],["owner_id","varchar",0,"当前负责销售ID"],["owner_name","varchar",0,"销售姓名"],["is_deleted","tinyint",0,"逻辑删除"]]},
  };
  for(const [table,{comment,columns}] of Object.entries(definitions)) {
    store.upsertTable({sourceId:source.id,tableName:table,rowEstimate:20,grade:"A",active:1,comment});
    for(const [columnName,dataType,isPrimary,columnComment] of columns)store.upsertColumn({sourceId:source.id,tableName:table,columnName,dataType,isPrimary,isSensitive:0,comment:columnComment});
  }
  store.upsertRelation({sourceId:source.id,fromTable:"deal_event",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
  store.upsertRelation({sourceId:source.id,fromTable:"lead_owner_rel",fromCol:"lead_id",toTable:"lead_entity",toCol:"id",cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
  const wrongSql="SELECT allocated_owner_id AS owner_id, COUNT(*) AS won_count FROM lead_entity WHERE created_at >= '2026-08-01' AND created_at < '2026-09-01' AND is_won = 1 GROUP BY allocated_owner_id ORDER BY won_count DESC";
  const correctSql="SELECT r.owner_id, MAX(r.owner_name) AS owner_name, COUNT(DISTINCT l.id) AS won_count FROM deal_event e JOIN lead_entity l ON l.id = e.lead_id JOIN lead_owner_rel r ON r.lead_id = l.id WHERE e.completed_at >= '2026-08-01' AND e.completed_at < '2026-09-01' AND r.is_deleted = 0 GROUP BY r.owner_id ORDER BY won_count DESC";
  let explains=0;let queries=0;
  const connector={explain:async()=>{explains++;return [{rows:10}];},query:async()=>{queries++;return [[{owner_id:"owner-1",owner_name:"销售甲",won_count:3}],[{name:"owner_id"},{name:"owner_name"},{name:"won_count"}]];}};
  const actions=[
    {thought:"先尝试单表统计。",tool:"run_sql",args:{sql:wrongSql}},
    {thought:"按结果契约改用成单事件、当前负责人和线索去重。",tool:"run_sql",args:{sql:correctSql}},
    {thought:"提交通过契约的排行。",tool:"submit_answer",args:{sql:correctSql,conclusion:"销售乙排名第一，共 999 条成单线索。",delta:"+999"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const answer=await createQueryService({store,connector,config:config()}).ask({sourceId:source.id,question:"按当前销售负责人统计本月实际成单线索排行",userName:"tester"});
    assert.equal(queries,1);assert.equal(explains,1);
    assert.equal(answer.evidence.toolTrace[0].ok,false);
    assert.match(answer.evidence.toolTrace[0].errorCode,/INTENT_(?:MEASURE|TIME_ROLE|DIMENSION)/);
    assert.equal(answer.evidence.resultContract.validations[0].ok,true);
    assert.equal(answer.conclusion,"排行查询已完成，共返回 1 行结果；具体排名与指标值以结果表为准。");
    assert.equal(answer.delta,undefined);
    assert.deepEqual(answer.rows,[{owner_id:"owner-1",owner_name:"销售甲",won_count:3}]);
    assert.doesNotMatch(answer.conclusion,/销售乙|999/);
    assert.match(answer.evidence.sql,/completed_at/);
    assert.match(answer.evidence.sql,/COUNT\(DISTINCT/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("submit_answer rejects SQL that was not successfully executed",async()=>{
  const {store,source}=await createFixture();
  let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:9}],[{name:"customer_id"}]];}};
  const actions=[
    {thought:"执行客户编号查询。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"提交另一条未执行 SQL。",tool:"submit_answer",args:{sql:"SELECT COUNT(customer_id) FROM crm_customer",conclusion:"共有 1 位客户。"}},
    {thought:"改为引用已成功执行的 SQL。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 9。"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户编号 9。");
    assert.equal(queries,1);
    const trace=store.listAudits(source.id,1)[0].toolTrace;
    assert.deepEqual(trace.map((item)=>[item.tool,item.ok]),[["run_sql",true],["submit_answer",false],["submit_answer",true]]);
    assert.match(trace[1].summary,/未匹配/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("submit_answer preserves multiple successful SQL result sets for exhaustive questions",async()=>{
  const {store,source}=await createFixture();const executed=[];
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:10,grade:"A",active:1,comment:"Alpha 用户账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"Alpha 用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alp_office_name",dataType:"varchar",isSensitive:0,comment:"所属律所"});
  store.upsertTable({sourceId:source.id,tableName:"alpha_account_user",rowEstimate:10,grade:"A",active:1,comment:"AlphaGPT 产品账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"user_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"产品用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"office_name",dataType:"varchar",isSensitive:0,comment:"所属律所"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"product_key",dataType:"varchar",isSensitive:0,comment:"产品标识"});
  const connector={explain:async()=>[{rows:1}],query:async(_source,sql)=>{executed.push(sql);if(!/alpha_account_user/i.test(sql))return [[{alpha_id:"alpha-1"}],[{name:"alpha_id"}]];return /product_key/i.test(sql)?[[{user_id:"gpt-1",product_key:"alpha_gpt"}],[{name:"user_id"},{name:"product_key"}]]:[[{user_id:"gpt-1"}],[{name:"user_id"}]];}};
  const firstSql="SELECT alpha_id FROM alpha_user";const incompleteSecondSql="SELECT user_id FROM alpha_account_user";const secondSql="SELECT user_id, product_key FROM alpha_account_user";
  const actions=[
    {thought:"查询 Alpha 范围。",tool:"run_sql",args:{name:"Alpha 账号",sql:firstSql}},
    {thought:"尝试提交当前结果。",tool:"submit_answer",args:{sql:firstSql,conclusion:"已覆盖账号。"}},
    {thought:"查询 AlphaGPT 范围。",tool:"run_sql",args:{name:"AlphaGPT 账号",sql:incompleteSecondSql}},
    {thought:"尝试提交两个范围。",tool:"submit_answer",args:{sqls:[firstSql,incompleteSecondSql],conclusion:"已覆盖两个账号体系。"}},
    {thought:"补充 AlphaGPT 产品维度。",tool:"run_sql",args:{name:"AlphaGPT 账号",sql:secondSql}},
    {thought:"两个账号体系均已验证。",tool:"submit_answer",args:{sqls:[firstSql,secondSql],conclusion:"已覆盖两个账号体系。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config("required")});const answer=await service.ask({sourceId:source.id,question:"查询所有账号情况",userName:"tester"});
    assert.equal(executed.length,3);assert.equal(answer.resultSets.length,2);assert.deepEqual(answer.resultSets.map((item)=>item.name),["Alpha 账号","AlphaGPT 账号"]);assert.equal(answer.resultSets[1].rows[0].product_key,"alpha_gpt");
    assert.deepEqual(answer.rows.map((row)=>row._query_scope),["Alpha 账号","AlphaGPT 账号"]);assert.equal(answer.evidence.sqls.length,2);assert.match(answer.evidence.sql,/AlphaGPT 账号/);
    assert.deepEqual(answer.evidence.toolTrace.map((item)=>[item.tool,item.ok]),[["run_sql",true],["submit_answer",false],["run_sql",true],["submit_answer",false],["run_sql",true],["submit_answer",true]]);assert.match(answer.evidence.toolTrace[1].summary,/遗漏账号主表/);assert.match(answer.evidence.toolTrace[3].summary,/没有返回产品维度/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("budget fallback preserves all complete account result sets instead of only the last SQL",async()=>{
  const {store,source}=await createFixture();
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:10,grade:"A",active:1,comment:"Alpha 用户账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"Alpha 用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alp_office_name",dataType:"varchar",isSensitive:0,comment:"所属律所名称"});
  store.upsertTable({sourceId:source.id,tableName:"alpha_account_user",rowEstimate:10,grade:"A",active:1,comment:"AlphaGPT 产品账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"user_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"产品用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"office_name",dataType:"varchar",isSensitive:0,comment:"律所名称"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"product_key",dataType:"varchar",isSensitive:0,comment:"产品标识"});
  const alphaSql="SELECT alpha_id FROM alpha_user";
  const gptSql="SELECT user_id, product_key FROM alpha_account_user";
  const connector={explain:async()=>[{rows:1}],query:async(_source,sql)=>/alpha_account_user/i.test(sql)?[[{user_id:"gpt-1",product_key:"alpha_gpt"}],[{name:"user_id"},{name:"product_key"}]]:[[{alpha_id:"alpha-1"}],[{name:"alpha_id"}]]};
  const actions=[
    {thought:"查询 Alpha 账号。",tool:"run_sql",args:{name:"Alpha 账号",sql:alphaSql}},
    {thought:"查询 AlphaGPT 账号。",tool:"run_sql",args:{name:"AlphaGPT 账号",sql:gptSql}},
    {thought:"错误地只提交最后一个范围。",tool:"submit_answer",args:{sql:gptSql,conclusion:"已查询账号。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config("required",{queryAgentMaxIterations:3})});
    const answer=await service.ask({sourceId:source.id,question:"查询所有账号情况",userName:"tester"});
    assert.equal(answer.evidence.budgetFallback,true);
    assert.equal(answer.resultSets.length,2);
    assert.deepEqual(answer.resultSets.map((item)=>item.name),["Alpha 账号","AlphaGPT 账号"]);
    assert.deepEqual(answer.rows.map((row)=>row._query_scope),["Alpha 账号","AlphaGPT 账号"]);
    assert.equal(answer.evidence.toolTrace.at(-1).ok,false);
    assert.match(answer.evidence.toolTrace.at(-1).summary,/遗漏账号主表：alpha_user/);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("prefer mode falls back to the legacy pipeline after an agent protocol failure",async()=>{
  const {store,source}=await createFixture();
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:11}],[{name:"customer_id"}]]};
  const replies=[
    {needsExploration:"需要进一步探索客户口径"},
    {thought:"尝试越过白名单。",tool:"raw_database",args:{}}, // semantic violation → immediate termination, no retry
    {sql:"SELECT customer_id FROM crm_customer"},
    {conclusion:"兼容链路返回 1 位客户。"},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(replies.shift());
  try {
    const service=createQueryService({store,connector,config:config("prefer")});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"legacy");
    assert.match(answer.evidence.agentFallbackReason,/未授权工具/);
    const audits=store.listAudits(source.id,2);
    assert.deepEqual(audits.map((item)=>[item.planningMode,item.verdict]),[["legacy","passed"],["agent","failed"]]);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("prefer mode keeps simple queries on the single-shot fast path",async()=>{
  const {store,source}=await createFixture();const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:21}],[{name:"customer_id"}]]};
  const replies=[{sql:"SELECT customer_id FROM crm_customer"},{conclusion:"兼容链路直接返回客户编号 21。"}];let calls=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{calls++;return llmResponse(replies.shift());};
  try {
    const service=createQueryService({store,connector,config:config("prefer")});const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"legacy");assert.equal(calls,2);assert.equal(store.listAudits(source.id,10).some((item)=>item.planningMode==="agent"),false);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("prefer mode upgrades to the agent immediately after the first deterministic guard failure",async()=>{
  const {store,source}=await createFixture();let queries=0;const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:31}],[{name:"customer_id"}]];}};
  const replies=[
    {sql:"SELECT * FROM crm_customer"},
    {thought:"单发 SQL 触发显式字段护栏，改查客户编号。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"结果已验证。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 31。"}},
  ];
  let calls=0;const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{calls++;return llmResponse(replies.shift());};
  try {
    const service=createQueryService({store,connector,config:config("prefer")});const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"agent");assert.equal(answer.conclusion,"查询到客户编号 31。");assert.equal(calls,3);assert.equal(queries,1);
    assert.deepEqual(answer.evidence.toolTrace.map((item)=>item.tool),["run_sql","submit_answer"]);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("sample_data permits every catalog column, remains bounded and does not persist sampled rows",async()=>{
  const {store,source}=await createFixture();
  const sampledRows=Array.from({length:25},(_,index)=>({customer_id:index+1,notes:"采样长文本".repeat(100)}));
  let queryCalls=0;const executed=[];
  const connector={
    explain:async()=>[{rows:8}],
    query:async(_source,sql)=>{executed.push(sql);queryCalls++;if(queryCalls===1)return [[{mobile:"13800138000"}],[{name:"mobile"}]];if(queryCalls===2)return [sampledRows,[{name:"customer_id"},{name:"notes"}]];return [[{customer_id:9}],[{name:"customer_id"}]];},
  };
  const actions=[
    {thought:"先确认手机号格式。",tool:"sample_data",args:{table:"crm_customer",columns:["mobile"],limit:5}},
    {thought:"手机号格式已确认，再看客户编号和备注格式。",tool:"sample_data",args:{table:"crm_customer",columns:["customer_id","notes"],limit:20}},
    {thought:"格式已确认，执行最终查询。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"提交已验证结果。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 9。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户并确认字段格式",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户编号 9。");
    assert.equal(queryCalls,3);
    assert.match(executed[0],/SELECT `mobile` FROM `crm_customer` LIMIT 5/i);
    assert.match(executed[1],/SELECT `customer_id`, `notes` FROM `crm_customer` LIMIT 20/i);
    const sampleResult=parseHarnessResult(requests[2].messages.at(-1).content);
    assert.equal(sampleResult.rows.length,20);
    assert.equal(sampleResult.rows[0].notes.length,201);
    assert.equal(sampleResult.truncated,true);
    const audit=store.listAudits(source.id,1)[0];
    assert.deepEqual(audit.toolTrace.map((item)=>[item.tool,item.ok]),[["sample_data",true],["sample_data",true],["run_sql",true],["submit_answer",true]]);
    assert.doesNotMatch(JSON.stringify(audit.toolTrace),/采样长文本/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("large detail results bypass model row context and pass through answer.rows",async()=>{
  const {store,source}=await createFixture();
  const rows=Array.from({length:1_000},(_,index)=>({customer_id:index+1,notes:`明细-${index}-${"x".repeat(300)}`}));
  const connector={explain:async()=>[{rows:1_000}],query:async()=>[rows,[{name:"customer_id",type:"number"},{name:"notes",type:"text"}]]};
  const actions=[
    {thought:"执行明细查询。",tool:"run_sql",args:{sql:"SELECT customer_id, notes FROM crm_customer"}},
    {thought:"明细由结果通道直接交付，仅概括规模。",tool:"submit_answer",args:{sql:"SELECT customer_id, notes FROM crm_customer",conclusion:"共返回 1000 条客户明细。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config("required",{queryMaxRows:2_000,explainMaxRows:2_000,queryAgentMaxScannedRows:2_000})});
    const answer=await service.ask({sourceId:source.id,question:"列出所有有效客户明细",userName:"tester"});
    assert.equal(answer.rows.length,1_000);
    assert.equal(answer.rows.at(-1).notes,rows.at(-1).notes);
    assert.equal(answer.evidence.resultDelivery,"direct");
    const modelContext=requests[1].messages.map((item)=>item.content).join("\n");
    assert.match(modelContext,/"rowCount":1000/);
    assert.match(modelContext,/"modelRowsOmitted":true/);
    assert.doesNotMatch(modelContext,/明细-999/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("the final iteration is a hard terminal-only budget and falls back to the last successful SQL",async()=>{
  const {store,source}=await createFixture();
  let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:12}],[{name:"customer_id"}]];}};
  const actions=[
    {thought:"先执行一条可靠查询。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"继续执行另一条查询。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer WHERE customer_id = 12"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config("required",{queryAgentMaxIterations:2})});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(queries,1);
    assert.equal(answer.evidence.budgetFallback,true);
    assert.equal(answer.rows[0].customer_id,12);
    assert.deepEqual(answer.evidence.toolTrace.map((item)=>[item.tool,item.ok]),[["run_sql",true],["run_sql",false]]);
    assert.match(answer.evidence.toolTrace[1].summary,/只允许 submit_answer 或 refuse/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("tool result rows are bounded by row, byte and cell limits",()=>{
  const rows=Array.from({length:1_000},(_,index)=>({id:index,description:"长文本".repeat(500)}));
  const result=agentInternal.truncateRows(rows,{maxRows:40,maxBytes:64*1024,maxCellChars:200});
  assert.equal(result.truncated,true);
  assert.ok(result.rows.length<=40);
  assert.ok(result.rows.every((row)=>row.description.length<=201));
  assert.ok(Buffer.byteLength(JSON.stringify(result.rows))<=64*1024);
});

test("unconfirmed direct joins receive a bounded confirmed bridge path hint",()=>{
  const relations=[
    {fromTable:"clue_owner_rel",fromCol:"seller_id",toTable:"seller",toCol:"seller_id"},
    {fromTable:"clue_owner_rel",fromCol:"clue_id",toTable:"crm_clue",toCol:"clue_id"},
    {fromTable:"feed_action",fromCol:"seller_id",toTable:"seller",toCol:"seller_id"},
    {fromTable:"feed_action",fromCol:"clue_id",toTable:"crm_clue",toCol:"clue_id"},
  ];
  const path=agentInternal.suggestConfirmedRelationPath("使用了未确认的 JOIN：seller.seller_id = crm_clue.seller_id",relations,new Set(["clue_owner_rel"]));
  assert.deepEqual(path.tables,["seller","clue_owner_rel","crm_clue"]);
  assert.deepEqual(path.intermediateTables,["clue_owner_rel"]);
  assert.deepEqual(path.joins,["clue_owner_rel.seller_id = seller.seller_id","clue_owner_rel.clue_id = crm_clue.clue_id"]);
});

test("search_context reuses the embedding index for hybrid exploration",async()=>{
  const {store,source}=await createFixture();const connector={explain:async()=>[{rows:1}],query:async()=>[[],[]]};let embedded=0;
  const embeddingIndex={enabled:()=>true,loadVectors:()=>({pageVectors:new Map([["term:有效客户",[1,0]]]),tableVectors:new Map([["crm_customer",[1,0]]])}),embedQuestion:async()=>{embedded++;return [1,0];}};
  const actions=[{thought:"用同义表达继续检索。",tool:"search_context",args:{query:"opaque semantic phrase"}},{thought:"本用例只验证检索，不执行 SQL。",tool:"refuse",args:{reason:"检索验证完成。"}}];const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,embeddingIndex,config:config("required",{retrieval:{vectorWeight:.5,minSimilarity:.2,semanticThreshold:.5}})});const result=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});assert.equal(result.refused,true);assert.ok(embedded>=2);
    const searchResult=parseHarnessResult(requests[1].messages.at(-1).content);assert.equal(searchResult.retrievalMode,"hybrid");assert.equal(searchResult.pages[0].title,"有效客户");assert.deepEqual(searchResult.relatedTables,["crm_customer"]);assert.ok(searchResult.capabilities.some((item)=>item.key==="subject:customer"&&item.executionTables.includes("crm_customer")));
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("agent search_context expands bound term-anchor aliases",async()=>{
  const {store,source}=await createFixture();const connector={explain:async()=>[{rows:1}],query:async()=>[[],[]]};
  store.upsertTermAnchor({vocabulary:"corp",canonicalId:"CUSTOMER",prefLabelZh:"客户",altLabels:["重点客群"],kind:"object"});
  const semantic=createSemanticSchemaService({store});
  const draft=semantic.saveDraft(source.id,{name:"crm",displayName:"客户模型",objectTypes:[{apiName:"customer",displayName:"客户",primaryKey:"id",termBinding:{vocabulary:"corp",canonicalId:"CUSTOMER",match:"exact"},properties:[{apiName:"id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}}]}],linkTypes:[]},"tester");
  assert.equal(semantic.publish(draft.id,"tester").ok,true);
  const actions=[{thought:"按业务行话继续检索。",tool:"search_context",args:{query:"重点客群"}},{thought:"本用例只验证检索扩展。",tool:"refuse",args:{reason:"检索验证完成。"}}];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config("required")});const result=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});assert.equal(result.refused,true);
    const searchResult=parseHarnessResult(requests[1].messages.at(-1).content);
    assert.ok(searchResult.pages.some((page)=>page.title==="有效客户"),JSON.stringify(searchResult));
    assert.deepEqual(searchResult.relatedTables,["crm_customer"]);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("validate_semantic_plan compiles and binds a published ontology plan to the executed SQL",async()=>{
  const {store,source}=await createFixture();
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"segment_code",dataType:"varchar",isPrimary:0,isSensitive:0,comment:"客户分层"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"VIP客户",title:"VIP 客户",aliases:"[]",tablesJson:'["crm_customer"]',content:"VIP 客户",sqlContent:"",antiExamples:"",verified:1,owner:"owner"});
  const semantic=createSemanticSchemaService({store});
  const schema={name:"crm",displayName:"客户模型",objectTypes:[
    {apiName:"customer",displayName:"客户",primaryKey:"id",properties:[{apiName:"id",displayName:"客户编号",type:"integer",required:true,mapping:{table:"crm_customer",column:"customer_id"}},{apiName:"notes",displayName:"客户备注",type:"string",required:false,mapping:{table:"crm_customer",column:"notes"}},{apiName:"segment",displayName:"客户分层",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"crm_customer",column:"segment_code"}}]},
    {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]},
  ],linkTypes:[]};
  const draft=semantic.saveDraft(source.id,schema,"tester");
  assert.equal(semantic.publish(draft.id,"tester").ok,true);
  const runtime=queryInternal.buildSemanticRuntime(store,source.id);
  assert.equal(runtime.ok,true);
  const plan={rootObject:"vip_customer",dimensions:[{property:"vip_customer.id",alias:"customer_id"}],metrics:[],filters:[],timeDimension:null,orderBy:[],limit:100};
  const compiled=compileSemanticQueryPlan(plan,{schema:runtime.published.schema,catalog:runtime.catalog,maxRows:100,ontologySchemaVersion:runtime.published.version});
  const actions=[
    {thought:"先用发布语义模型编译客户查询。",tool:"validate_semantic_plan",args:{plan}},
    {thought:"执行 Harness 返回的确定性 SQL。",tool:"run_sql",args:{sql:compiled.sql}},
    {thought:"提交已验证的语义查询结果。",tool:"submit_answer",args:{sql:compiled.sql,conclusion:"查询到客户编号 42。"}},
  ];
  let executedSql="";
  const connector={explain:async()=>[{rows:1}],query:async(_source,sql)=>{executedSql=sql;return [[{customer_id:42}],[{name:"customer_id"}]];}};
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config("required",{semanticQueryPlanMode:"prefer"})});
    const answer=await service.ask({sourceId:source.id,question:"查询 VIP 客户编号",userName:"tester"});
    assert.equal(executedSql,answer.evidence.sql);
    assert.match(executedSql,/SELECT DISTINCT .*customer_id.*crm_customer.*segment_code` = 'vip'/is);
    assert.equal(answer.evidence.coverage,"semantic");
    assert.equal(answer.evidence.ontologySchemaVersion,1);
    assert.deepEqual(answer.evidence.queryPlan,plan);
    assert.deepEqual(answer.evidence.semanticPath.objects,["vip_customer"]);
    assert.deepEqual(answer.evidence.resultContract.semanticBinding,{version:"semantic-row-domain-v1",ontologySchemaVersion:1,rootObject:"vip_customer",immutable:true});
    assert.deepEqual(answer.evidence.resultContract.slots.find((item)=>item.kind==="semantic_row_domain")?.values,[{value:"vip",valueType:"string"}]);
    assert.deepEqual(answer.evidence.toolTrace.map((item)=>[item.tool,item.ok]),[["validate_semantic_plan",true],["run_sql",true],["submit_answer",true]]);
    const firstPrompt=requests[0].messages.at(-1).content;
    assert.match(firstPrompt,/"semanticModel"/);
    assert.match(firstPrompt,/"apiName":"customer"/);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.ontologySchemaVersion,1);
    assert.deepEqual(audit.queryPlan,plan);
    assert.deepEqual(audit.semanticPath.objects,["vip_customer"]);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

function parseHarnessResult(content) {
  const prefix="Harness 工具结果（可信 JSON）：";
  assert.ok(content.startsWith(prefix));
  return JSON.parse(content.slice(prefix.length));
}

test("sanitized thoughts redact secrets while keeping the key name",()=>{
  const safe=agentInternal.sanitizeThought("正在连接 password=hunter2 的数据源。");
  assert.match(safe,/password=\[REDACTED\]/);
  assert.doesNotMatch(safe,/hunter2|\$1/);
});

test("deterministic intent preflight covers time ranking comparison and filter clarifications",()=>{
  for(const code of ["TIME_RANGE_UNKNOWN","RANKING_DIMENSION_UNKNOWN","RANKING_MEASURE_UNKNOWN","RANKING_LIMIT_INVALID","COMPARISON_BASELINE_UNKNOWN","FILTER_EXPRESSION_UNSUPPORTED"]) {
    const clarification=agentInternal.blockingIntentClarification({ambiguities:[{code,blocking:true,message:`${code} 需要确认`,options:["选项一"]}]});
    assert.ok(clarification,code);
    assert.match(clarification.question,/需要确认/);
  }
  const unresolvable=agentInternal.unresolvableBlockingIntent({ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",blocking:true,message:"缺少指标定义"}]});
  assert.equal(unresolvable.code,"MEASURE_DEFINITION_REQUIRED");
});

test("clarified evidence gaps map missing attribution to a stable deterministic schema error",()=>{
  const eventTimeIntent={requirements:[{id:"dimension:seller",kind:"dimension",value:"seller",attribution:"event_time",required:true}]};
  const gap=agentInternal.clarifiedEvidenceGap(eventTimeIntent,{ok:true,coverageContract:{missing:["dimension:seller"]}});
  assert.deepEqual(gap.missingFacets,["dimension:seller"]);
  assert.equal(gap.errorCode,"INTENT_DIMENSION_ATTRIBUTION_BINDING_MISSING");assert.match(gap.reason,/事件发生时负责人.*快照/);
  const currentCovered={requirements:[{id:"dimension:seller",kind:"dimension",value:"seller",attribution:"current",required:true}]};
  assert.equal(agentInternal.clarifiedEvidenceGap(currentCovered,{ok:true,coverageContract:{missing:[]}}),null);
  assert.equal(agentInternal.clarifiedEvidenceGap(eventTimeIntent,{ok:false,coverageContract:{missing:["dimension:seller"]}}),null,"refresh transport failures follow their existing retry path");
  const generic=agentInternal.clarifiedEvidenceGap({requirements:[{id:"time:completion",kind:"time",required:true}]},{ok:true,coverageContract:{missing:["time:completion"]}});
  assert.equal(generic.errorCode,"INTENT_REQUIRED_RETRIEVAL_FACET_MISSING");assert.deepEqual(generic.missingFacets,["time:completion"]);
});

test("intent evidence fingerprint changes with executable business scope but ignores clarification presentation",()=>{
  const base={
    version:"2.0",rawQuestion:"原问题",normalizedQuestion:"原问题",semanticQuestion:"原问题",
    subjects:["clue"],entities:[],filters:[{id:"filter:status",field:"status",operator:"eq",value:"active",valueType:"string",attachesTo:"clue",immutable:true}],
    timeRange:{start:"2026-08-01",endExclusive:"2026-09-01"},comparisonRange:null,timeRole:{value:"completion"},
    shape:{kind:"ranking",requestedLimit:50},dimensions:[{id:"dimension:seller",value:"seller",attribution:"current"}],
    measures:[{id:"measure:won",value:"won",aggregation:"count_distinct",grain:"clue"}],scope:{products:[],deletionMode:"default_active"},
    requirements:[{id:"subject:clue",kind:"subject",value:"clue"}],retrievalTerms:["线索"],ambiguities:[{code:"EXAMPLE",blocking:true,message:"展示文案"}],
  };
  const fingerprint=agentInternal.intentEvidenceFingerprint(base);
  const presentationOnly=structuredClone(base);
  presentationOnly.rawQuestion="改写后的问题";presentationOnly.normalizedQuestion="改写后的问题";presentationOnly.semanticQuestion="改写后的问题";presentationOnly.ambiguities=[];
  assert.equal(agentInternal.intentEvidenceFingerprint(presentationOnly),fingerprint);
  const mutations=[
    (intent)=>{intent.timeRange.endExclusive="2026-10-01";},
    (intent)=>{intent.dimensions[0].attribution="event_time";},
    (intent)=>{intent.dimensions.push({id:"dimension:product",value:"product"});},
    (intent)=>{intent.filters[0].value="inactive";},
    (intent)=>{intent.scope.products=["alphaGpt"];},
  ];
  for(const mutate of mutations) {
    const changed=structuredClone(base);mutate(changed);
    assert.notEqual(agentInternal.intentEvidenceFingerprint(changed),fingerprint);
  }
});

test("a malformed tool action earns one protocol retry that does not burn an iteration",async()=>{
  const {store,source}=await createFixture();
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:9}],[{name:"customer_id"}]]};
  const actions=[
    {tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}}, // missing thought → format violation, one retry
    {thought:"补上进度说明后重发。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"提交结论。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 9。"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户编号 9。");
    assert.equal(answer.evidence.planningMode,"agent");
    const audit=store.listAudits(source.id,1)[0];
    const retryTraces=audit.toolTrace.filter((item)=>item.tool==="protocol_retry");
    assert.equal(retryTraces.length,1);
    assert.match(retryTraces[0].reason,/thought/);
    // The retry is recorded in the trace but does not consume a reasoning iteration:
    // only the two real actions count.
    assert.equal(audit.iterations,2);
    assert.deepEqual(audit.toolTrace.map((item)=>item.tool),["protocol_retry","run_sql","submit_answer"]);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("an empty tool name earns one protocol retry",async()=>{
  const {store,source}=await createFixture();
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:9}],[{name:"customer_id"}]]};
  const actions=[
    {thought:"忘了写工具名。",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"补上工具名重发。",tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {thought:"提交结论。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"查询到客户编号 9。"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"查询到客户编号 9。");
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.toolTrace.filter((item)=>item.tool==="protocol_retry").length,1);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("two consecutive format violations terminate the loop",async()=>{
  const {store,source}=await createFixture();
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:9}],[{name:"customer_id"}]]};
  const actions=[
    {tool:"run_sql",args:{sql:"SELECT customer_id FROM crm_customer"}},
    {args:{sql:"SELECT customer_id FROM crm_customer"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.refused,true);
    assert.match(answer.reason,/thought|工具动作/);
    assert.equal(store.listAudits(source.id,1)[0].verdict,"failed");
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("requesting an unauthorized tool terminates immediately without a protocol retry",async()=>{
  const {store,source}=await createFixture();
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:9}],[{name:"customer_id"}]]};
  let calls=0;
  const actions=[
    {thought:"试图越权。",tool:"unknown_tool",args:{}},
    {thought:"不该到这里。",tool:"submit_answer",args:{sql:"SELECT customer_id FROM crm_customer",conclusion:"不应产生。"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{calls++;return llmResponse(actions.shift());};
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.refused,true);
    assert.match(answer.reason,/未授权工具/);
    assert.equal(calls,1);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.verdict,"failed");
    assert.equal(audit.toolTrace.some((item)=>item.tool==="protocol_retry"),false);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("a second protocol slip surfaces the already-valid run instead of discarding it",async()=>{
  const {store,source}=await createFixture();
  const sql="SELECT customer_id FROM crm_customer";
  let queries=0;
  const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{customer_id:7}],[{name:"customer_id"}]];}};
  // The model first posts a compliant run, then two consecutive malformed
  // actions, both raw prose that cannot be salvaged into JSON. The loop retries
  // the first slip once; the second must not throw away the earlier good run —
  // the budget fallback surfaces its contract-valid result instead of refusing.
  const prose1='"我直接告诉您结果吧，查询到客户。"';
  const prose2='"结果就是查询到一位客户，编号 7。"';
  const actions=[
    {thought:"执行已确认查询。",tool:"run_sql",args:{sql}},
    prose1,
    prose2,
  ];
  let modelCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{
    modelCalls++;
    const next=actions.shift();
    if(typeof next==="string")return new Response(JSON.stringify({choices:[{message:{content:next}}],usage:{prompt_tokens:11,completion_tokens:4,total_tokens:15}}),{status:200,headers:{"content-type":"application/json"}});
    return llmResponse(next);
  };
  try {
    const service=createQueryService({store,connector,config:config()});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.refused,undefined,"应带出已成功的查询结果而不是拒答");
    assert.equal(answer.evidence.budgetFallback,true);
    assert.equal(answer.rows.length,1);
    assert.equal(queries,1);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.toolTrace.filter((item)=>item.tool==="protocol_retry").length,1);
    assert.ok(audit.toolTrace.some((item)=>item.tool==="run_sql"&&item.ok),"先前成功的 run_sql 不应被丢弃");
  } finally { globalThis.fetch=originalFetch;store.close(); }
});
