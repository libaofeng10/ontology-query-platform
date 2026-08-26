import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { createApp } from "../src/server.mjs";
import { createQueryService } from "../src/query-service.mjs";
import { _internal as agentInternal } from "../src/query-agent-loop.mjs";
import { createStore } from "../src/store.mjs";

async function appFixture(overrides={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-clarification-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:2}],query:async()=>[[{revenue:88}],[{name:"revenue",type:"number"}]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"clarification-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-clarification",model:"clarification-test"},queryAgentMode:"required",queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,
    ...overrides,
  });
  const source=seed(app.store);return {app,source,connector};
}

function seed(store) {
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"sales",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"sales_order",rowEstimate:10,grade:"A",active:1,comment:"销售订单"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"revenue",dataType:"decimal",isPrimary:0,isSensitive:0,comment:"收入"});
  store.upsertColumn({sourceId:source.id,tableName:"sales_order",columnName:"mobile",dataType:"varchar",isPrimary:0,isSensitive:1,comment:"手机号"});
  store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"收入",title:"收入",aliases:"[]",tablesJson:'["sales_order"]',content:"订单收入，可按含税或不含税口径分析",sqlContent:"汇总收入字段",antiExamples:"不得查询手机号",verified:1,owner:"owner"});
  return source;
}

function seedSalesRanking(store) {
  const source=store.createSource({name:"sales-prod",kind:"mysql",host:"db",port:3306,dbName:"sales_prod",userName:"ro",credential:"unused",isDemo:false});
  for(const [tableName,comment] of [["alpha_crm_clue","线索主表"],["alpha_clue_order_rel","线索成单关系"],["alpha_crm_clue_seller_rel","线索当前销售负责人关系"],["seller","销售人员"],["feed_action","销售跟进动态"]])store.upsertTable({sourceId:source.id,tableName,rowEstimate:10,grade:"A",active:1,comment});
  const columns={
    alpha_crm_clue:[["id","线索主键",1],["clue_id","线索业务ID",0],["channel_id","渠道ID",0],["clue_allot_seller_id","当前分配销售ID",0],["is_deleted","删除标记",0]],
    alpha_clue_order_rel:[["crm_clue_id","线索主键",0],["order_time","成单时间",0],["is_deleted","删除标记",0]],
    alpha_crm_clue_seller_rel:[["clue_id","线索业务ID",0],["seller_id","当前负责人销售ID",0],["created_by","关系记录创建人销售ID",0],["is_deleted","当前关系有效标记",0]],
    seller:[["seller_alpha_id","销售ID",1],["seller_alpha_name","销售姓名",0],["team_id","团队ID",0],["is_valid","有效销售标记",0]],
    feed_action:[["base_id","线索动态基础ID",0],["seller_alpha_id","操作销售ID",0]],
  };
  for(const [tableName,items] of Object.entries(columns))for(const [columnName,comment,isPrimary] of items)store.upsertColumn({sourceId:source.id,tableName,columnName,dataType:columnName.includes("time")?"datetime":columnName.includes("name")?"varchar":"bigint",isPrimary,isSensitive:0,comment});
  for(const [fromTable,fromCol,toTable,toCol] of [["alpha_clue_order_rel","crm_clue_id","alpha_crm_clue","id"],["alpha_crm_clue_seller_rel","clue_id","alpha_crm_clue","clue_id"],["alpha_crm_clue_seller_rel","seller_id","seller","seller_alpha_id"],["alpha_crm_clue_seller_rel","created_by","seller","seller_alpha_id"],["alpha_crm_clue_seller_rel","seller_id","seller","team_id"],["alpha_crm_clue_seller_rel","clue_id","alpha_crm_clue","channel_id"],["feed_action","base_id","alpha_crm_clue","clue_id"],["feed_action","seller_alpha_id","seller","seller_alpha_id"]])store.upsertRelation({sourceId:source.id,fromTable,fromCol,toTable,toCol,cardinality:"N:1",confidence:1,status:"confirmed",inferenceSource:"foreign_key"});
  const schema={name:"sales_prod",objectTypes:[
    {apiName:"crm_clue",displayName:"CRM线索",description:"CRM线索主对象，记录当前销售负责人归属",primaryKey:"id",properties:[
      {apiName:"id",displayName:"线索主键",mapping:{table:"alpha_crm_clue",column:"id"}},
      {apiName:"clue_id",displayName:"线索业务ID",mapping:{table:"alpha_crm_clue",column:"clue_id"}},
      {apiName:"channel_id",displayName:"渠道ID",mapping:{table:"alpha_crm_clue",column:"channel_id"}},
      {apiName:"clue_allot_seller_id",displayName:"当前分配销售ID",description:"当前负责跟进线索的销售人员ID",mapping:{table:"alpha_crm_clue",column:"clue_allot_seller_id"}},
    ]},
    {apiName:"orange_army_seller",displayName:"销售人员",primaryKey:"seller_id",properties:[
      {apiName:"seller_id",displayName:"销售ID",mapping:{table:"seller",column:"seller_alpha_id"}},
      {apiName:"seller_name",displayName:"销售姓名",mapping:{table:"seller",column:"seller_alpha_name"}},
      {apiName:"team_id",displayName:"团队ID",mapping:{table:"seller",column:"team_id"}},
      {apiName:"is_valid",displayName:"有效标记",mapping:{table:"seller",column:"is_valid"}},
    ]},
    {apiName:"crm_clue_seller_rel",displayName:"线索销售归属",description:"维护线索与销售人员的归属关系",primaryKey:"clue_id",properties:[
      {apiName:"clue_id",displayName:"线索ID",description:"被分配的线索业务ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"clue_id"}},
      {apiName:"seller_id",displayName:"负责销售ID",description:"当前负责跟进该线索的销售人员ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"seller_id"}},
      {apiName:"created_by",displayName:"创建人销售ID",description:"创建这条归属记录的操作人员ID",mapping:{table:"alpha_crm_clue_seller_rel",column:"created_by"}},
      {apiName:"is_deleted",displayName:"逻辑删除",mapping:{table:"alpha_crm_clue_seller_rel",column:"is_deleted"}},
    ]},
    // This object deliberately contains broad "current/seller/follow-up"
    // prose and an equally short confirmed path. Only the seller reference on
    // the ownership object above states the current-attribution role.
    {apiName:"crm_clue_feed_action",displayName:"线索销售跟进动态",description:"记录当前销售跟进线索的操作事实",primaryKey:"base_id",properties:[
      {apiName:"base_id",displayName:"线索ID",description:"关联的线索业务ID",mapping:{table:"feed_action",column:"base_id"}},
      {apiName:"seller_id",displayName:"操作销售ID",description:"执行操作的销售人员ID",mapping:{table:"feed_action",column:"seller_alpha_id"}},
    ]},
  ],linkTypes:[]};
  const draft=store.createOntologySchemaVersion({sourceId:source.id,schemaName:schema.name,schema,checksum:"sales-prod-test",validation:{ok:true,errors:[],warnings:[]},createdBy:"test"});
  store.publishOntologySchemaVersion(draft.id,"test");
  return source;
}

function llmResponse(content) { return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(content)}}]}),{status:200}); }

test("a result-changing clarification must bind to the immutable intent before any SQL can run",async()=>{
  const {app,source}=await appFixture();
  const actions=[
    {thought:"先检索收入口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"两种口径都会实质改变结果，需要确认。",tool:"ask_user",args:{question:"收入应按含税还是不含税口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"用户已确认不含税，执行汇总。",tool:"run_sql",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order"}},
    {thought:"提交已经验证的结果。",tool:"submit_answer",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order",conclusion:"不含税收入为 88 元。"}},
    {thought:"沿用当前会话已确认口径执行追问。",tool:"run_sql",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order"}},
    {thought:"提交追问结果。",tool:"submit_answer",args:{sql:"SELECT SUM(revenue) AS revenue FROM sales_order",conclusion:"沿用不含税口径，收入为 88 元。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.equal(first.status,200);assert.equal(first.body.clarification.question,"收入应按含税还是不含税口径？");
    assert.deepEqual(first.body.clarification.options,["含税","不含税"]);assert.equal(first.body.toolTrace.at(-1).tool,"ask_user");
    assert.equal(app.store.listSessions(source.id,"analyst")[0].messageCount,0);
    assert.equal(app.store.listAudits(source.id,1)[0].verdict,"clarified");

    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"不含税"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.refused,true);assert.equal(resumed.body.errorCode,"CLARIFICATION_INTENT_BINDING_REQUIRED");assert.equal(resumed.body.failureClass,"schema_gap");
    assert.match(resumed.body.reason,/未能绑定到已发布的指标、枚举、术语或结构化查询口径/);
    assert.deepEqual(resumed.body.toolTrace.map((item)=>item.tool),["search_context","ask_user"]);assert.equal(requests.length,2,"未结构化的口径不得进入 LLM 或 SQL 执行阶段");
    const messages=app.store.getSessionDetail(first.body.sessionId).messages;assert.equal(messages.length,2);
    assert.equal(messages[0].content.text,"查询收入");assert.equal(messages[1].content.refused,true);

    const secondResume=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"含税"});
    assert.equal(secondResume.status,404);assert.match(secondResume.body.error,/不存在或已失效/);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("a model clarification that leaves structured intent unchanged cannot reuse evidence to execute",async()=>{
  const {app,source}=await appFixture();
  const sql="SELECT SUM(revenue) AS revenue FROM sales_order";
  const actions=[
    {thought:"先检索收入口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"含税与不含税需要用户确认。",tool:"ask_user",args:{question:"收入应按含税还是不含税口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"按已确认口径执行汇总。",tool:"run_sql",args:{sql}},
    {thought:"提交已验证结果。",tool:"submit_answer",args:{sql,conclusion:"不含税收入为 88 元。"}},
  ];
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"不含税"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.refused,true);assert.equal(resumed.body.errorCode,"CLARIFICATION_INTENT_BINDING_REQUIRED");
    assert.deepEqual(resumed.body.toolTrace.map((item)=>item.tool),["search_context","ask_user"]);assert.equal(requests.length,2);
  } finally {globalThis.fetch=originalFetch;await app.close();}
});

test("a parsed seller-attribution clarification invalidates stale evidence and automatically refreshes the resolved contract",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-intent-clarification-"));
  const sql=`SELECT s.seller_alpha_id AS seller_id,
       s.seller_alpha_name AS seller_name,
       COUNT(DISTINCT c.id) AS won_clue_cnt
FROM alpha_crm_clue c
JOIN alpha_clue_order_rel o ON o.crm_clue_id=c.id AND o.is_deleted=0
JOIN alpha_crm_clue_seller_rel r ON r.clue_id=c.clue_id AND r.is_deleted=0
JOIN seller s ON s.seller_alpha_id=r.seller_id AND s.is_valid=1
WHERE c.is_deleted=0
  AND o.order_time >= '2026-08-01'
  AND o.order_time < '2026-09-01'
GROUP BY s.seller_alpha_id,s.seller_alpha_name
ORDER BY won_clue_cnt DESC
LIMIT 50`;
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:2}],query:async()=>[[{seller_id:7,seller_name:"销售甲",won_clue_cnt:2}],[{name:"seller_id"},{name:"seller_name"},{name:"won_clue_cnt"}]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"intent-clarification-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-intent",model:"intent-test"},queryAgentMode:"required",queryAgentTrafficPercent:100,
    queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,semanticQueryPlanMode:"off",
  });
  const source=seedSalesRanking(app.store);let llmCalls=0;const requests=[];
  const actions=[
    {thought:"查看澄清后契约要求的成单、线索、当前归属和销售结构。",tool:"get_schema",args:{tables:["alpha_crm_clue","alpha_clue_order_rel","alpha_crm_clue_seller_rel","seller"]}},
    {thought:"按成单时间、当前负责人、有效行和线索去重执行排行。",tool:"run_sql",args:{sql}},
    {thought:"提交最终契约校验通过的排行。",tool:"submit_answer",args:{sql,conclusion:"销售甲成单线索 2 条。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{llmCalls++;requests.push(JSON.parse(init.body));return llmResponse(actions.shift());};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"本月线索，销售成单排行"});
    assert.equal(first.status,200);assert.equal(llmCalls,0);
    assert.equal(first.body.planningMode,"agent");
    assert.match(first.body.clarification.question,/当前负责人|事件发生时负责人|销售归属/);
    assert.deepEqual(first.body.clarification.options,["当前负责人","事件发生时负责人"]);
    assert.deepEqual(first.body.toolTrace.map((item)=>item.tool),["ask_user"]);
    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"当前负责人"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.refused,undefined);assert.equal(llmCalls,3);
    assert.deepEqual(resumed.body.rows,[{seller_id:7,seller_name:"销售甲",won_clue_cnt:2}]);
    assert.deepEqual(resumed.body.evidence.toolTrace.map((item)=>item.tool),["ask_user","search_context","get_schema","run_sql","submit_answer"]);
    assert.match(resumed.body.evidence.toolTrace[1].thought,/废弃旧证据.*刷新/);
    const clarificationHarness=requests[0].messages.findLast((item)=>String(item.content).startsWith("Harness 工具结果（用户已澄清）"))?.content||"";
    assert.equal(requests[0].messages.some((item)=>item.role==="assistant"),false,"澄清后首个模型请求不得保留旧 assistant/tool 上下文");
    assert.deepEqual(requests[0].messages.slice(-3).map((item)=>item.role),["system","user","user"]);
    assert.match(clarificationHarness,/"priorEvidenceInvalidated":true/);
    assert.match(clarificationHarness,/"evidenceDisposition":"refreshed"/);
    assert.match(clarificationHarness,/"attribution":"current"/);
    assert.match(clarificationHarness,/"refreshedContext":/);
    const contract=resumed.body.evidence.resultContract;
    const sellerSlot=contract.slots.find((item)=>item.id==="dimension:seller");
    const sellerBinding=contract.validations[0].bindings.find((item)=>item.id==="dimension:seller");
    for(const key of ["tables","columns","labelColumns","identityColumns","bindingTables","bindingColumns","bindingRelationIds","bindingValidityPredicates","executionValidityPredicates"])assert.deepEqual(sellerSlot[key],sellerBinding[key],`公开契约与执行校验的 ${key} 必须来自同一快照`);
    assert.ok(sellerSlot.tables.includes("seller"));
    assert.ok(sellerSlot.bindingTables.includes("alpha_crm_clue_seller_rel"));
    assert.ok(sellerSlot.bindingValidityPredicates.some((item)=>item.column==="alpha_crm_clue_seller_rel.is_deleted"&&item.value==="0"));
    assert.ok(sellerSlot.executionValidityPredicates.some((item)=>item.column==="seller.is_valid"&&item.value==="1"));
    assert.equal(resumed.body.evidence.resultContractFingerprint,createHash("sha256").update(JSON.stringify(contract)).digest("hex"));
    const audit=app.store.listAudits(source.id,1)[0];
    assert.equal(audit.verdict,"passed");assert.equal(audit.retrievalTrace.resultContractFingerprint,resumed.body.evidence.resultContractFingerprint);
    assert.deepEqual(audit.retrievalTrace.resultContract,contract);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("event-time seller clarification with no published snapshot role refuses before LLM or datasource execution",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-event-owner-gap-"));
  let llmCalls=0;let explainCalls=0;let queryCalls=0;
  const connector={
    close:async()=>{},test:async()=>({ok:true}),
    explain:async()=>{explainCalls++;return [{rows:1}];},
    query:async()=>{queryCalls++;return [[],[]];},
  };
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"event-owner-gap-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-event-owner",model:"event-owner-test"},queryAgentMode:"required",queryAgentTrafficPercent:100,
    queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,semanticQueryPlanMode:"off",
  });
  const source=seedSalesRanking(app.store);const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{llmCalls++;return llmResponse({thought:"不应进入模型规划。",tool:"refuse",args:{reason:"不应到达。"}});};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"本月线索，销售成单排行"});
    assert.equal(first.status,200);assert.equal(llmCalls,0);assert.ok(first.body.clarification);
    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"事件发生时负责人"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.refused,true);
    assert.equal(resumed.body.errorCode,"INTENT_DIMENSION_ATTRIBUTION_BINDING_MISSING");assert.equal(resumed.body.failureClass,"schema_gap");
    assert.deepEqual(resumed.body.missingFacets,["dimension:seller"]);assert.match(resumed.body.reason,/事件发生时负责人.*快照/);
    assert.deepEqual(resumed.body.toolTrace.map((item)=>[item.tool,item.ok]),[["ask_user",true],["search_context",true]]);
    assert.deepEqual(resumed.body.clarifications,[{question:first.body.clarification.question,answer:"事件发生时负责人"}]);
    assert.equal(llmCalls,0);assert.equal(explainCalls,0);assert.equal(queryCalls,0);
    assert.equal("rows" in resumed.body,false);assert.equal("evidence" in resumed.body,false);assert.equal("attemptedSql" in resumed.body,false);
    assert.doesNotMatch(JSON.stringify(resumed.body),/\b(?:SELECT|FROM|JOIN)\b/i);
  } finally {globalThis.fetch=originalFetch;await app.close();}
});

test("a resume failure audits the resolved intent and refreshed evidence instead of reviving the pending snapshot",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-resume-snapshot-failure-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:1}],query:async()=>[[],[]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"resume-snapshot-secret",connector,nodeEnv:"test",
    apiIdentities:[{name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"}],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-resume-failure",model:"resume-failure-test"},queryAgentMode:"required",queryAgentTrafficPercent:100,
    queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100,queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,semanticQueryPlanMode:"off",
  });
  const source=seedSalesRanking(app.store);let llmCalls=0;const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{llmCalls++;throw new Error("模拟澄清恢复后的模型故障");};
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"本月线索，销售成单排行"});
    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"当前负责人"});
    assert.equal(resumed.status,200);assert.equal(resumed.body.refused,true);assert.equal(llmCalls,1);
    const audit=app.store.listAudits(source.id,1)[0];
    assert.equal(audit.verdict,"failed");
    assert.equal(audit.intent.requirements.find((item)=>item.id==="dimension:seller").attribution,"current");
    const sellerSlot=audit.retrievalTrace.resultContract.slots.find((item)=>item.id==="dimension:seller");
    assert.ok(sellerSlot.tables.includes("seller"));assert.ok(sellerSlot.bindingTables.includes("alpha_crm_clue_seller_rel"));
    assert.equal(audit.retrievalTrace.evidenceCount,1);assert.ok(audit.retrievalTrace.selectedTables.includes("seller"));
  } finally {globalThis.fetch=originalFetch;await app.close();}
});

test("clarification pending expires by TTL and is invalidated by a new question in the same session",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:15});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
    {thought:"新问题无需继续。",tool:"refuse",args:{reason:"当前问题不在已确认范围内。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const expiredPending=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    await new Promise((resolve)=>setTimeout(resolve,25));
    const expired=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,pendingId:expiredPending.body.clarification.pendingId,question:"不含税"});
    assert.equal(expired.status,410);assert.match(expired.body.error,/已过期/);

    const invalidatedPending=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,question:"再次查询收入"});
    const replacement=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,question:"换一个新问题"});
    assert.equal(replacement.body.refused,true);
    const invalidated=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:expiredPending.body.sessionId,pendingId:invalidatedPending.body.clarification.pendingId,question:"含税"});
    assert.equal(invalidated.status,404);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("ask_user rejects SQL and table identifiers but field sensitivity does not limit business questions",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-clarification-guard-"));const store=createStore(join(root,"store.sqlite"));const source=seed(store);
  const connector={explain:async()=>[{rows:1}],query:async()=>[[],[]]};
  const catalog=agentInternal.buildCatalog(store,source.id,100);
  assert.match(agentInternal.clarificationContentError("是否从 sales_order 查询收入？",catalog),/物理表名/);
  assert.equal(agentInternal.clarificationContentError("是否按手机号区分口径？",catalog),null);
  assert.equal(agentInternal.clarificationContentError("是否按 mobile 字段区分口径？",catalog),null);
  assert.equal(agentInternal.clarificationContentError("收入应按含税还是不含税口径？",catalog),null);
  const actions=[
    {thought:"先自行探索。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"尝试询问技术细节。",tool:"ask_user",args:{question:"是否从 sales_order SELECT revenue？",options:["是","否"],allowFreeText:false}},
    {thought:"尝试询问敏感字段。",tool:"ask_user",args:{question:"是否按手机号区分口径？",options:[],allowFreeText:true}},
    {thought:"无法安全澄清。",tool:"refuse",args:{reason:"现有业务信息不足以可靠回答。"}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"sk",model:"test"},queryAgentMode:"required",queryAgentMaxIterations:4,queryAgentMaxSqlCalls:2,queryAgentMaxScannedRows:10,queryMaxRows:100,explainMaxRows:10,queryLlmTimeoutMs:5_000,semanticQueryPlanMode:"off"}});
    const result=await service.ask({sourceId:source.id,question:"查询收入",userName:"tester"});
    assert.equal(result.refused,true);assert.equal("clarification" in result,false);
    assert.deepEqual(result.toolTrace.map((item)=>[item.tool,item.ok]),[["search_context",true],["ask_user",false],["ask_user",false],["refuse",true]]);
    assert.match(result.toolTrace[1].summary,/SQL|物理表名/);assert.match(result.toolTrace[2].summary,/最多只能调用一次/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("session detail exposes a live pending clarification for page-refresh recovery",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:60_000});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.equal(first.status,200);assert.ok(first.body.clarification);

    const detail=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.equal(detail.status,200);
    assert.equal(detail.body.pendingClarification.question,"查询收入");
    assert.equal(detail.body.pendingClarification.response.clarification.pendingId,first.body.clarification.pendingId);
    assert.deepEqual(detail.body.pendingClarification.response.toolTrace.map((item)=>item.tool),["search_context","ask_user"]);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

test("expired pending is removed by lazy sweep and disappears from session detail",async()=>{
  const {app,source}=await appFixture({queryAgentPendingTtlMs:15});
  const actions=[
    {thought:"先检索口径。",tool:"search_context",args:{query:"收入口径"}},
    {thought:"需要确认口径。",tool:"ask_user",args:{question:"收入使用哪个业务口径？",options:["含税","不含税"],allowFreeText:false}},
  ];
  const originalFetch=globalThis.fetch;globalThis.fetch=async()=>llmResponse(actions.shift());
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询收入"});
    assert.ok(first.body.clarification);
    const live=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.ok(live.body.pendingClarification);
    await new Promise((resolve)=>setTimeout(resolve,25));
    const after=await api(app,`/api/sessions/${first.body.sessionId}`,"token-analyst",null,"GET");
    assert.equal(after.status,200);assert.equal(after.body.pendingClarification,undefined);
  } finally { globalThis.fetch=originalFetch;await app.close(); }
});

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);const request=Readable.from(payload?[payload]:[]);request.method=method;request.url=path;request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};request.socket={remoteAddress:"127.0.0.1"};
  let raw="";const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}
