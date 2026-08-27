import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createQueryService, _internal } from "../src/query-service.mjs";
import { createSemanticSchemaService } from "../src/semantic-schema-service.mjs";
import { createStore } from "../src/store.mjs";

test("Agent prefer rollout uses a stable cohort bucket while explicit modes bypass sampling",()=>{
  const first=_internal.selectQueryAgentRollout({mode:"prefer",trafficPercent:10,cohortKey:"source:session"});const second=_internal.selectQueryAgentRollout({mode:"prefer",trafficPercent:10,cohortKey:"source:session"});
  assert.deepEqual(first,second);assert.ok(first.bucket>=0&&first.bucket<100);assert.equal(first.effectiveMode,first.bucket<10?"prefer":"off");
  assert.equal(_internal.selectQueryAgentRollout({mode:"prefer",trafficPercent:0,cohortKey:"x"}).effectiveMode,"off");
  assert.equal(_internal.selectQueryAgentRollout({mode:"prefer",trafficPercent:0,cohortKey:"x",explicit:true}).effectiveMode,"prefer");
  assert.equal(_internal.selectQueryAgentRollout({mode:"required",trafficPercent:0,cohortKey:"x"}).effectiveMode,"required");
});

test("ranking limit preflight never silently truncates an explicit Top N",()=>{
  assert.deepEqual(_internal.rankingLimitPreflight({shape:{kind:"ranking",requestedLimit:1_000}},500),{
    code:"INTENT_RANKING_LIMIT_EXCEEDS_MAX",
    reason:"用户要求 Top 1000，超过单次查询安全上限 500；系统不会静默截断为较小排行。",
  });
  assert.equal(_internal.rankingLimitPreflight({shape:{kind:"ranking",requestedLimit:500}},500),null);
  assert.equal(_internal.rankingLimitPreflight({shape:{kind:"detail"}},500),null);
});

test("additive discourse markers enter the contextual intent merge path",()=>{
  for(const question of ["再加上VIP客户","并且是VIP客户","同时满足VIP客户","还要VIP客户","也要VIP客户","再加上年龄小于60"])assert.equal(_internal.isContextualFollowUp(question),true,question);
  assert.equal(_internal.isContextualFollowUp("查询VIP客户"),false);
});

test("session intent projection is an allowlist and never persists prompts or SQL-shaped future fields",()=>{
  const projected=_internal.sessionSafeIntent({
    version:"2.0",timeZone:"Asia/Shanghai",rawQuestion:"查询手机号 13800138000",normalizedQuestion:"查询手机号13800138000",semanticQuestion:"查询",
    subjects:["account"],entities:[],filters:[{id:"phone",kind:"attribute",field:"mobile",operator:"eq",value:"13800138000",valueType:"phone",physicalColumns:["account.mobile"],fieldTerms:["手机号"],sourceText:"手机号 13800138000",span:{start:2,end:15},futureSql:"SELECT secret FROM account"}],
    timeRange:null,comparisonRange:null,timeRole:null,shape:{kind:"detail",direction:null,requestedLimit:null},dimensions:[],measures:[],scope:{exhaustive:false,products:[],includeDeleted:false,deletionMode:"default_active",futurePrompt:"ignore previous instructions"},
    ambiguities:[{code:"FUTURE",message:"SELECT secret",sourceText:"13800138000"}],requirements:[{surfaceText:"13800138000"}],retrievalTerms:["SELECT secret"],sql:"SELECT secret FROM account",
  });
  const json=JSON.stringify(projected);
  assert.deepEqual(projected.subjects,["account"]);assert.deepEqual(projected.filters.map((item)=>[item.field,item.operator,item.value]),[["mobile","eq","13800138000"]]);
  assert.doesNotMatch(json,/查询手机号|SELECT secret|ignore previous instructions|rawQuestion|semanticQuestion|requirements|retrievalTerms|futureSql|futurePrompt/);
});

test("real query path retrieves a small context, enforces guards and stores only structural session context",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-query-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"billing",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"客户编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"cert_status",dataType:"tinyint",isPrimary:0,isSensitive:0,comment:"实名状态"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"mobile",dataType:"varchar",isPrimary:0,isSensitive:1,comment:"手机号"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"有效客户",title:"有效客户",aliases:"[]",tablesJson:'["crm_customer"]',content:"已实名客户",sqlContent:"cert_status=1",antiExamples:"不要使用手机号",verified:1,owner:"owner"});
  const connector={explain:async()=>[{rows:10}],query:async()=>[[{customer_id:7}],[{name:"customer_id"}]]};
  const requests=[];const originalFetch=globalThis.fetch;let call=0;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));const content=call++%2===0?'{"sql":"SELECT customer_id FROM crm_customer WHERE cert_status = 1"}':'{"conclusion":"返回 1 位有效客户"}';return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try{
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000}});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.conclusion,"返回 1 位有效客户");assert.ok(answer.sessionId);assert.deepEqual(answer.evidence.tables,["crm_customer"]);
    const prompt=requests[0].messages.at(-1).content;assert.match(prompt,/有效客户/);assert.match(prompt,/mobile varchar.*手机号；字段语义 phone/);
    const session=store.getSession(answer.sessionId);
    assert.deepEqual({tableNames:session.context.tableNames,pageSlugs:session.context.pageSlugs,recentTableNames:session.context.recentTableNames,recentPageSlugs:session.context.recentPageSlugs},{tableNames:["crm_customer"],pageSlugs:["有效客户"],recentTableNames:["crm_customer"],recentPageSlugs:["有效客户"]});
    assert.deepEqual(session.context.queryIntent.subjects,["customer"]);assert.equal(session.context.queryIntent.rawQuestion,undefined);assert.equal(session.context.queryIntent.requirements,undefined);
    assert.deepEqual(session.context.queryIntent.filters.map((item)=>[item.field,item.operator,item.value]),[["cert_status","eq","1"]]);assert.doesNotMatch(session.contextJson,/查询有效客户|SELECT/);
    store.appendSessionTurn(answer.sessionId,"查询有效客户",answer);
    await service.ask({sourceId:source.id,question:"那它的编号呢？",userName:"tester",sessionId:answer.sessionId});
    assert.match(requests[2].messages.at(-1).content,/用户：查询有效客户/);assert.match(requests[2].messages.at(-1).content,/助手：查询范围：crm_customer\n返回 1 位有效客户/);
  }finally{globalThis.fetch=originalFetch;store.close();}
});

test("phone follow-up keeps the corrected table, rejects id binding and queries the phone column normally",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-sensitive-followup-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"alpha",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:100,grade:"A",active:1,comment:"Alpha用户"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"Alpha用户id"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alp_cell",dataType:"varchar",isSensitive:1,comment:"alpha用户手机号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"expire_time",dataType:"datetime",isSensitive:0,comment:"到期时间"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"is_deleted",dataType:"tinyint",isSensitive:0,comment:"删除标记"});
  store.upsertTable({sourceId:source.id,tableName:"tp_finance",rowEstimate:100,grade:"A",active:1,comment:"财务记录"});
  store.upsertColumn({sourceId:source.id,tableName:"tp_finance",columnName:"CFiWeChatPhone",dataType:"varchar",isSensitive:1,comment:"财务微信手机号"});
  const session=store.createSession({id:"alpha-session",sourceId:source.id,userName:"tester",title:"新问数会话"});
  store.appendSessionTurn(session.id,"alpha_account_user 只有 AlphaGPT，Alpha 用户在 alpha_user",{question:"修正范围",conclusion:"已按 alpha_user 查询。",evidence:{tables:["alpha_user"],pages:[]}});
  store.updateSession(session.id,{tableNames:["alpha_user"],pageSlugs:[],recentTableNames:["alpha_user"],recentPageSlugs:[]});
  const executions=[];const explanations=[];
  const connector={
    explain:async(_source,sql)=>{explanations.push({sql});return [{rows:1}];},
    query:async(_source,sql,params)=>{executions.push({sql,params});return [[{expire_time:"2026-12-31T00:00:00.000Z"}],[{name:"expire_time"}]];},
  };
  const replies=[
    '{"sql":"SELECT expire_time FROM alpha_user WHERE alpha_id = \'13774665233\'"}',
    '{"sql":"SELECT expire_time FROM alpha_user WHERE alp_cell = \'13774665233\' AND is_deleted = 0 LIMIT 1"}',
    '{"conclusion":"该 Alpha 用户到期时间为 2026-12-31。"}',
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:replies.shift()}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1_000,queryAgentMode:"off",semanticQueryPlanMode:"off"}});
    const answer=await service.ask({sourceId:source.id,question:"13774665233是手机号呀",userName:"tester",sessionId:session.id});
    const firstPrompt=requests[0].messages.at(-1).content;assert.match(firstPrompt,/Alpha 用户在 alpha_user/);assert.match(firstPrompt,/alp_cell varchar.*alpha用户手机号；字段语义 phone/);
    assert.match(requests[1].messages.at(-1).content,/值格式识别为 手机号.*alpha_user\.alpha_id/);
    assert.equal(executions.length,1,JSON.stringify({answer,lastPrompt:requests.at(-1)?.messages?.at(-1)?.content}));assert.deepEqual(executions[0].params,[]);assert.match(executions[0].sql,/alp_cell` = '13774665233'/);assert.match(explanations[0].sql,/13774665233/);
    assert.match(answer.evidence.sql,/13774665233/);assert.deepEqual(store.getSession(session.id).context.tableNames,["alpha_user"]);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("exhaustive account questions execute and preserve Alpha and AlphaGPT result sets",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-all-accounts-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"alpha",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"alpha_user",rowEstimate:100,grade:"A",active:1,comment:"Alpha 用户账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alpha_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"Alpha 用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"alp_office_name",dataType:"varchar",isSensitive:0,comment:"所属律所"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_user",columnName:"is_deleted",dataType:"tinyint",isSensitive:0,comment:"删除标记"});
  store.upsertTable({sourceId:source.id,tableName:"alpha_account_user",rowEstimate:100,grade:"A",active:1,comment:"AlphaGPT 产品账号"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"user_id",dataType:"varchar",isPrimary:1,isSensitive:0,comment:"产品用户 ID"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"office_name",dataType:"varchar",isSensitive:0,comment:"所属律所"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"product_key",dataType:"varchar",isSensitive:0,comment:"产品标识"});
  store.upsertColumn({sourceId:source.id,tableName:"alpha_account_user",columnName:"is_deleted",dataType:"tinyint",isSensitive:0,comment:"删除标记"});
  const executions=[];
  const connector={
    explain:async()=>[{rows:1}],
    query:async(_source,sql)=>{executions.push(sql);return /alpha_account_user/i.test(sql)?[[{user_id:"gpt-1",product_key:"alpha_gpt"}],[{name:"user_id"},{name:"product_key"}]]:[[{alpha_id:"alpha-1"}],[{name:"alpha_id"}]];},
  };
  const replies=[
    JSON.stringify({sql:"SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京大成%' AND is_deleted = 0"}),
    JSON.stringify({queries:[
      {name:"Alpha 账号",sql:"SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%大成%' AND alp_office_name LIKE '%北京%' AND is_deleted = 0"},
      {name:"AlphaGPT 全产品账号",sql:"SELECT user_id, product_key FROM alpha_account_user WHERE office_name LIKE '%大成%' AND office_name LIKE '%北京%' AND is_deleted = 0"},
    ]}),
    JSON.stringify({queries:[
      {name:"Alpha 账号",sql:"SELECT alpha_id FROM alpha_user WHERE alp_office_name LIKE '%北京大成%' AND is_deleted = 0"},
      {name:"AlphaGPT 全产品账号",sql:"SELECT user_id, product_key FROM alpha_account_user WHERE office_name LIKE '%北京大成%' AND is_deleted = 0"},
    ]}),
    JSON.stringify({conclusion:"已查询北京大成律所的 Alpha 与 AlphaGPT 全产品账号。"}),
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:replies.shift()}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:200,explainMaxRows:1_000,queryAgentMode:"off",semanticQueryPlanMode:"off"}});
    const answer=await service.ask({sourceId:source.id,question:"查询一下北京大成律所所有账号情况",userName:"tester"});
    const prompt=requests[0].messages.at(-1).content;
    assert.match(prompt,/TABLE alpha_user/);assert.match(prompt,/TABLE alpha_account_user/);assert.match(prompt,/多个相关产品或账号体系/);
    assert.match(requests[1].messages.at(-1).content,/遗漏账号主表：alpha_account_user/);
    assert.match(requests[2].messages.at(-1).content,/机构专名“北京大成”必须作为连续字符串过滤/);assert.equal(answer.evidence.planningAttempts,3);
    assert.equal(executions.length,2);assert.equal(answer.resultSets.length,2);assert.deepEqual(answer.resultSets.map((item)=>[item.name,item.rowCount]),[["Alpha 账号",1],["AlphaGPT 全产品账号",1]]);
    assert.deepEqual(answer.evidence.tables.sort(),["alpha_account_user","alpha_user"]);assert.equal(answer.evidence.sqls.length,2);assert.match(answer.evidence.sql,/Alpha 账号/);assert.match(answer.evidence.sql,/AlphaGPT 全产品账号/);
    assert.deepEqual(answer.rows.map((row)=>row._query_scope),["Alpha 账号","AlphaGPT 全产品账号"]);assert.equal(answer.chart,null);
    assert.deepEqual(store.getSession(answer.sessionId).context.tableNames.sort(),["alpha_account_user","alpha_user"]);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

test("planner without agent escalation never offers needsExploration and recovers when the model returns it anyway",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-query-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"billing",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:10,grade:"A",active:1,comment:"线索"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"});
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{clue_id:1}],[{name:"clue_id"}]]};
  const contents=['{"needsExploration":"想再看看结构"}','{"sql":"SELECT clue_id FROM crm_clue"}','{"conclusion":"共 1 条线索。"}'];
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:contents.shift()}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,queryAgentMode:"off"}});
    const answer=await service.ask({sourceId:source.id,question:"查询线索",userName:"tester"});
    assert.equal(answer.conclusion,"共 1 条线索。");
    assert.doesNotMatch(requests[0].messages.at(-1).content,/needsExploration/);
    assert.match(requests[1].messages.at(-1).content,/没有可用的探索通道/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("planner failures become audited safety refusals instead of API errors",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-query-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"billing",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:10,grade:"A",active:1,comment:"线索"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"});
  const connector={explain:async()=>{throw new Error("must not execute");},query:async()=>{throw new Error("must not execute");}};
  const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async()=>{calls++;const error=new Error("The operation was aborted due to timeout");error.name="TimeoutError";throw error;};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,queryLlmTimeoutMs:10}});
    const result=await service.ask({sourceId:source.id,question:"查询线索",userName:"tester"});
    assert.equal(result.refused,true);assert.match(result.reason,/SQL 规划模型失败.*请求超时/);assert.equal(calls,2);
    const audit=store.listAudits(source.id,1)[0];assert.equal(audit.verdict,"failed");assert.match(audit.failReason,/SQL 规划模型失败/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("DashScope query planning disables thinking and summary failure does not reexecute SQL",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-query-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"billing",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:10,grade:"A",active:1,comment:"线索"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"});
  let queries=0;const connector={explain:async()=>[{rows:1}],query:async()=>{queries++;return [[{clue_id:1}],[{name:"clue_id"}]];}};
  const requests=[];const originalFetch=globalThis.fetch;let calls=0;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));if(calls++===0)return new Response(JSON.stringify({choices:[{message:{content:'{"sql":"SELECT clue_id FROM crm_clue"}'}}]}),{status:200,headers:{"content-type":"application/json"}});const error=new Error("timeout");error.name="TimeoutError";throw error;};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"https://dashscope.aliyuncs.com/compatible-mode/v1",apiKey:"sk-valid",model:"qwen3.8-max"},queryMaxRows:100,explainMaxRows:1000,queryLlmTimeoutMs:10}});
    const result=await service.ask({sourceId:source.id,question:"查询线索",userName:"tester"});
    assert.equal(result.conclusion,"查询已完成，共返回 1 行符合条件的结果。");assert.equal(queries,1);
    assert.equal(requests[0].enable_thinking,false);assert.equal(requests[0].max_tokens,1800);
    assert.equal(requests[1].enable_thinking,false);assert.equal(requests[1].max_tokens,800);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("non-empty detail results cannot be summarized as empty or charted by identifier",()=>{
  const summary=_internal.ensureSummaryConsistency({conclusion:"查询结果中未包含分配给赵一鸣的线索，无法确认。"},65);
  assert.equal(summary.conclusion,"查询已完成，共返回 65 行符合条件的结果。");
  const rows=[{id:775000,clue_id:880000,name:"某线索",clue_allot_seller_id:42}];
  const fields=Object.keys(rows[0]).map((name)=>({name}));
  assert.equal(_internal.inferChart(rows,fields),null);
  const clueRows=Array.from({length:67},(_,index)=>({id:index+1,clue_id:880000+index,name:`线索${index+1}`,product_line_no:"P1",clue_allot_time:"2026-08-13",clue_status:1}));
  const clueFields=Object.keys(clueRows[0]).map((name)=>({name}));
  assert.equal(_internal.inferChart(clueRows,clueFields),null);
  assert.equal(_internal.inferChart([{name:"某线索",clue_status:1}],[{name:"name"},{name:"clue_status"}]),null);
  assert.deepEqual(_internal.inferChart([{month:"2026-08",count:65}],[{name:"month"},{name:"count"}]),{type:"line",xKey:"month",yKey:"count"});
  assert.deepEqual(_internal.inferChart([{segment:"VIP",count:12}],[{name:"segment"},{name:"count"}]),{type:"bar",xKey:"segment",yKey:"count"});
});

test("analytical conclusions only state the executed result envelope",()=>{
  assert.equal(_internal.deterministicAnalyticalConclusion({shape:{kind:"ranking"}},2,1),"排行查询已完成，共返回 2 行结果；具体排名与指标值以结果表为准。");
  assert.equal(_internal.deterministicAnalyticalConclusion({shape:{kind:"aggregate"}},3,2),"统计查询已完成，共返回 2 个结果集、3 行结果；具体指标值以结果表为准。");
  assert.equal(_internal.deterministicAnalyticalConclusion({shape:{kind:"trend"}},0,1),"未查询到符合条件的数据。");
  assert.equal(_internal.deterministicAnalyticalConclusion({shape:{kind:"detail"}},1,1),null);
});

test("published ontology uses semantic Query Plan without exposing physical mappings to the planner",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-semantic-query-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"commerce",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"warehouse_customer",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"warehouse_customer",columnName:"customer_pk",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,isSensitive:0,comment:"标识"});
  store.upsertColumn({sourceId:source.id,tableName:"warehouse_customer",columnName:"segment_code",dataType:"varchar",nullable:1,isSensitive:0,comment:"分层"});
  store.upsertTable({sourceId:source.id,tableName:"fact_order",rowEstimate:100,grade:"A",active:1,comment:"订单"});
  store.upsertColumn({sourceId:source.id,tableName:"fact_order",columnName:"order_pk",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,isSensitive:0,comment:"标识"});
  store.upsertColumn({sourceId:source.id,tableName:"fact_order",columnName:"buyer_fk",dataType:"bigint",nullable:0,isSensitive:0,comment:"客户引用"});
  store.upsertColumn({sourceId:source.id,tableName:"fact_order",columnName:"gross_amount",dataType:"decimal",nullable:0,isSensitive:0,comment:"金额"});
  store.upsertRelation({sourceId:source.id,fromTable:"fact_order",fromCol:"buyer_fk",toTable:"warehouse_customer",toCol:"customer_pk",status:"confirmed",confidence:.99,cardinality:"N:1",inferenceSource:"foreign_key"});
  const relation=store.listRelations(source.id,true)[0];
  const ontology={name:"commerce",displayName:"交易模型",objectTypes:[
    {apiName:"customer",displayName:"客户",primaryKey:"id",properties:[
      {apiName:"id",displayName:"客户标识",type:"integer",required:true,mapping:{table:"warehouse_customer",column:"customer_pk"}},
      {apiName:"segment",displayName:"客户分层",type:"string",required:false,mapping:{table:"warehouse_customer",column:"segment_code"}},
    ]},
    {apiName:"order",displayName:"订单",primaryKey:"id",properties:[
      {apiName:"id",displayName:"订单标识",type:"integer",required:true,mapping:{table:"fact_order",column:"order_pk"}},
      {apiName:"customer_id",displayName:"所属客户",type:"integer",required:true,mapping:{table:"fact_order",column:"buyer_fk"}},
      {apiName:"amount",displayName:"订单金额",type:"number",required:true,mapping:{table:"fact_order",column:"gross_amount"}},
    ]},
  ],linkTypes:[{apiName:"customer_orders",displayName:"客户订单",source:"customer",target:"order",cardinality:"one_to_many",relationMappings:[{relationId:relation.id}]}]};
  const ontologyService=createSemanticSchemaService({store});
  const draft=ontologyService.saveDraft(source.id,ontology,"tester");
  assert.equal(ontologyService.publish(draft.id,"tester").ok,true);
  const candidateSchema=structuredClone(ontology);candidateSchema.description="候选版本";
  const candidateDraft=ontologyService.saveDraft(source.id,candidateSchema,"tester");
  const candidateRuntime=_internal.buildSemanticRuntime(store,source.id,candidateDraft.id);
  assert.equal(candidateRuntime.ok,true);assert.equal(candidateRuntime.published.status,"draft");assert.equal(candidateRuntime.published.version,2);
  store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"订单金额",title:"订单金额",aliases:"[]",tablesJson:'["warehouse_customer","fact_order"]',content:"按客户分层汇总已完成订单金额",sqlContent:"legacy expression",antiExamples:"不要统计测试数据",verified:1,owner:"owner"});
  const connector={explain:async()=>[{rows:100}],query:async()=>[[{segment:"vip",revenue:1200}],[{name:"segment"},{name:"revenue"}]]};
  const requests=[];const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));const content=JSON.stringify({rootObject:"customer",dimensions:[{property:"customer.segment",alias:"segment"}],metrics:[{aggregation:"sum",property:"order.amount",alias:"revenue"}],filters:[],timeDimension:null,orderBy:[{field:"revenue",direction:"desc"}],limit:100});return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"required"}});
    const answer=await service.ask({sourceId:source.id,question:"按客户分层汇总订单金额",userName:"tester"});
    assert.ok(answer.evidence,JSON.stringify(answer));
    assert.equal(answer.evidence.planningMode,"semantic");
    assert.equal(answer.evidence.ontologySchemaVersion,1);
    assert.equal(answer.conclusion,"统计查询已完成，共返回 1 行结果；具体指标值以结果表为准。");
    assert.deepEqual(answer.rows,[{segment:"vip",revenue:1200}]);
    assert.equal(requests.length,1);
    assert.deepEqual(answer.evidence.semanticPath.links,["customer_orders"]);
    assert.match(answer.evidence.sql,/warehouse_customer/);
    const plannerPrompt=requests[0].messages.at(-1).content;
    assert.doesNotMatch(plannerPrompt,/warehouse_customer|fact_order|customer_pk|buyer_fk|gross_amount|legacy expression/);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.planningMode,"semantic");
    assert.equal(audit.ontologySchemaVersion,1);
    assert.equal(audit.queryPlan.metrics[0].alias,"revenue");
    assert.deepEqual(audit.semanticPath.links,["customer_orders"]);
    const candidateAnswer=await service.ask({sourceId:source.id,question:"使用候选版本按客户分层汇总订单金额",userName:"evaluator",ontologySchemaVersionId:candidateDraft.id});
    assert.equal(candidateAnswer.evidence.planningMode,"semantic");
    assert.equal(candidateAnswer.evidence.ontologySchemaVersion,2);
    assert.equal(candidateAnswer.conclusion,"统计查询已完成，共返回 1 行结果；具体指标值以结果表为准。");
    assert.match(candidateAnswer.evidence.sql,/warehouse_customer/);
    assert.equal(requests.length,2);
    assert.doesNotMatch(requests[1].messages.at(-1).content,/warehouse_customer|fact_order|customer_pk|buyer_fk|gross_amount|legacy expression/);
    const candidateAudit=store.listAudits(source.id,1)[0];
    assert.equal(candidateAudit.ontologySchemaVersion,2);
    assert.deepEqual(candidateAudit.semanticPath.links,["customer_orders"]);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("prefer mode safely falls back to the legacy planner and audits the reason",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-semantic-fallback-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"commerce",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"customer_records",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"customer_records",columnName:"customer_pk",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,isSensitive:0,comment:"客户标识"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"客户",title:"客户",aliases:"[]",tablesJson:'["customer_records"]',content:"业务客户",sqlContent:"customer_pk",antiExamples:"",verified:1,owner:"owner"});
  const ontologyService=createSemanticSchemaService({store});
  const draft=ontologyService.saveDraft(source.id,{name:"commerce",displayName:"客户模型",objectTypes:[{apiName:"customer",displayName:"客户",primaryKey:"id",properties:[{apiName:"id",displayName:"客户标识",type:"integer",required:true,mapping:{table:"customer_records",column:"customer_pk"}}]}],linkTypes:[]},"tester");
  assert.equal(ontologyService.publish(draft.id,"tester").ok,true);
  const connector={explain:async()=>[{rows:10}],query:async()=>[[{customer_pk:1}],[{name:"customer_pk"}]]};
  const originalFetch=globalThis.fetch;let call=0;
  globalThis.fetch=async()=>{const content=[
    '{"unsupportedReason":"当前问题需要尚未建模的派生指标"}',
    '{"sql":"SELECT customer_pk FROM customer_records"}',
    '{"conclusion":"返回 1 位客户"}',
  ][call++];return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"prefer"}});
    const answer=await service.ask({sourceId:source.id,question:"查询客户",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"legacy");
    assert.match(answer.evidence.semanticFallbackReason,/尚未建模的派生指标/);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.planningMode,"legacy");
    assert.match(audit.semanticFallbackReason,/尚未建模的派生指标/);
    assert.equal(call,3);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("prefer mode gives a semantic disjoint conflict one self-correction attempt before fallback",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-semantic-correction-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"customer_records",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"customer_records",columnName:"customer_pk",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,comment:"客户标识"});
  store.upsertColumn({sourceId:source.id,tableName:"customer_records",columnName:"segment_code",dataType:"varchar",nullable:0,comment:"客户分层"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"VIP客户",title:"VIP 客户",aliases:"[]",tablesJson:'["customer_records"]',content:"VIP 客户",sqlContent:"",antiExamples:"",verified:1,owner:"owner"});
  const semantic=createSemanticSchemaService({store});
  const schema={name:"crm",displayName:"客户模型",objectTypes:[
    {apiName:"customer",displayName:"客户",primaryKey:"id",properties:[{apiName:"id",displayName:"客户标识",type:"integer",required:true,mapping:{table:"customer_records",column:"customer_pk"}},{apiName:"segment",displayName:"客户分层",type:"enum",required:true,constraints:{enumValues:["vip","standard"]},mapping:{table:"customer_records",column:"segment_code"}}]},
    {apiName:"vip_customer",displayName:"VIP 客户",parent:"customer",discriminator:{property:"segment",values:["vip"]},properties:[]},
  ],linkTypes:[]};
  const draft=semantic.saveDraft(source.id,schema,"tester");assert.equal(semantic.publish(draft.id,"tester").ok,true);
  const replies=[
    {rootObject:"vip_customer",dimensions:[{property:"vip_customer.id",alias:"customer_id"}],metrics:[],filters:[{property:"vip_customer.segment",operator:"eq",value:"standard"}],orderBy:[],limit:100},
    {rootObject:"vip_customer",dimensions:[{property:"vip_customer.id",alias:"customer_id"}],metrics:[],filters:[],orderBy:[],limit:100},
    {conclusion:"返回 1 位 VIP 客户"},
  ];
  const requests=[];const originalFetch=globalThis.fetch;globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(replies.shift())}}]}),{status:200,headers:{"content-type":"application/json"}});};
  const connector={explain:async()=>[{rows:1}],query:async()=>[[{customer_id:1}],[{name:"customer_id"}]]};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"prefer",queryAgentMode:"off"}});
    const answer=await service.ask({sourceId:source.id,question:"查询 VIP 客户",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"semantic");assert.equal(answer.evidence.planningAttempts,2);assert.equal(requests.length,3);
    assert.equal(answer.evidence.resultContract.closedWorldRowDomain,true);
    assert.deepEqual(answer.evidence.resultContract.semanticBinding,{version:"semantic-row-domain-v1",ontologySchemaVersion:1,rootObject:"vip_customer",immutable:true});
    const discriminator=answer.evidence.resultContract.slots.find((item)=>item.kind==="semantic_row_domain");
    assert.equal(discriminator.immutable,true);assert.equal(discriminator.required,true);assert.deepEqual(discriminator.columns,["customer_records.segment_code"]);assert.deepEqual(discriminator.values,[{value:"vip",valueType:"string"}]);
    assert.match(answer.evidence.sql,/segment_code` = 'vip'/);
    assert.match(requests[1].messages.at(-1).content,/上一次计划未通过.*判别条件矛盾/s);
  } finally {globalThis.fetch=originalFetch;store.close();}
});

function officeStore(dir) {
  const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"account_office",rowEstimate:10,grade:"A",active:1,comment:"账号"});
  store.upsertColumn({sourceId:source.id,tableName:"account_office",columnName:"account_pk",dataType:"bigint",isPrimary:1,isUnique:1,nullable:0,isSensitive:0,comment:"标识"});
  store.upsertColumn({sourceId:source.id,tableName:"account_office",columnName:"office_name",dataType:"varchar(100)",nullable:1,isSensitive:0,comment:"律所名称"});
  store.upsertColumn({sourceId:source.id,tableName:"account_office",columnName:"user_office_name",dataType:"varchar(100)",nullable:1,isSensitive:0,comment:"用户所属律所"});
  const ontologyService=createSemanticSchemaService({store});
  const schema={name:"crm",displayName:"账号模型",objectTypes:[{apiName:"account",displayName:"账号",primaryKey:"id",properties:[
    {apiName:"id",displayName:"标识",type:"integer",required:true,mapping:{table:"account_office",column:"account_pk"}},
    {apiName:"office_name",displayName:"律所名称",type:"string",required:false,mapping:{table:"account_office",column:"office_name"}},
  ]}],linkTypes:[]};
  const draft=ontologyService.saveDraft(source.id,schema,"tester");
  assert.equal(ontologyService.publish(draft.id,"tester").ok,true);
  return {store,source};
}

test("zero-result sibling probe remains diagnostic and never authorizes a column-rebinding query",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-zero-probe-"));
  const {store,source}=officeStore(dir);
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"律所",title:"律所",aliases:'["律所名称"]',tablesJson:'["account_office"]',content:"律所维度",sqlContent:"office_name",antiExamples:"",verified:1,owner:"owner"});
  const executed=[];
  const connector={explain:async()=>[{rows:10}],query:async(_source,sql)=>{executed.push(sql);
    if(sql.includes("COUNT(*)"))return [[{match_count:37}],[{name:"match_count"}]];
    if(sql.includes("user_office_name"))return [[{office:"北京大成"}],[{name:"office"}]];
    return [[],[]];
  }};
  const originalFetch=globalThis.fetch;let call=0;
  globalThis.fetch=async()=>{call++;const content=JSON.stringify({rootObject:"account",dimensions:[{property:"account.office_name",alias:"office"}],metrics:[],filters:[{property:"account.office_name",operator:"contains",value:"北京大成"}],timeDimension:null,orderBy:[],limit:100});return new Response(JSON.stringify({choices:[{message:{content}}]}),{status:200,headers:{"content-type":"application/json"}});};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"prefer"}});
    const answer=await service.ask({sourceId:source.id,question:"查询北京大成律所的账号",userName:"tester"});
    assert.equal(answer.evidence.planningMode,"semantic");
    assert.equal(answer.evidence.semanticFallbackReason,undefined);
    assert.equal(answer.evidence.zeroResultProbe.findings[0].siblingColumn,"user_office_name");
    assert.equal(answer.evidence.zeroResultProbe.findings[0].matchCount,37);
    assert.equal(answer.evidence.zeroResultProbe.purpose,"diagnostic_only");
    assert.equal(answer.evidence.zeroResultProbe.authorizesRebinding,false);
    assert.equal(answer.rows.length,0);
    assert.match(answer.conclusion,/当前过滤字段可能与业务口径不符/);
    assert.equal(call,1,"探针不得触发 legacy 规划或结果总结");
    assert.equal(executed.filter((sql)=>sql.includes("COUNT(*)")).length,1);
    assert.equal(executed.filter((sql)=>sql.includes("user_office_name")&&!sql.includes("COUNT(*)")).length,0,"兄弟字段只允许 COUNT 诊断探针，不得执行明细查询");
    assert.match(answer.evidence.sql,/office_name/);
    assert.doesNotMatch(answer.evidence.sql,/user_office_name/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("verified knowledge conflicting with published ontology fails closed before LLM or database access",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-conflict-"));
  const {store,source}=officeStore(dir);
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"律所名称",title:"律所名称",aliases:'["所属律所"]',tablesJson:'["account_office"]',content:"按律所名称查账号时用 user_office_name（用户所属律所）",sqlContent:"user_office_name LIKE CONCAT('%', ?, '%')",antiExamples:"不要用 office_name",verified:1,owner:"owner"});
  let explainCalls=0;let queryCalls=0;
  const connector={explain:async()=>{explainCalls++;return [{rows:10}];},query:async()=>{queryCalls++;return [[{user_office_name:"北京大成"}],[{name:"user_office_name"}]];}};
  const originalFetch=globalThis.fetch;let llmCalls=0;
  globalThis.fetch=async()=>{llmCalls++;throw new Error("知识/本体冲突不得调用 LLM");};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"prefer"}});
    const answer=await service.ask({sourceId:source.id,question:"查询北京大成律所的账号",userName:"tester"});
    assert.equal(answer.refused,true);
    assert.equal(answer.errorCode,"KNOWLEDGE_ONTOLOGY_CONFLICT");
    assert.equal(answer.failureClass,"schema_gap");
    assert.equal(answer.planningMode,"semantic");
    assert.match(answer.reason,/知识页与已发布本体.*冲突/);
    assert.match(answer.reason,/account_office\.user_office_name/);
    assert.equal(llmCalls,0);assert.equal(explainCalls,0);assert.equal(queryCalls,0);
    assert.deepEqual(answer.conflicts.map((item)=>[item.slug,item.table,item.column]),[["律所名称","account_office","user_office_name"]]);
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.verdict,"refused");assert.equal(audit.failureClass,"schema_gap");assert.equal(audit.planningAttempts,0);
    assert.match(audit.failReason,/KNOWLEDGE_ONTOLOGY_CONFLICT/);
    assert.match(audit.semanticFallbackReason,/account_office\.user_office_name/);
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("weak or vector-only knowledge recall outside the required execution closure cannot veto a sales query",()=>{
  const page={verified:true,pageType:"term",slug:"alpha-gpt-office",title:"AlphaGPT律所",aliases:["AlphaGpt律所名称"],tables:["alpha_account_user"],content:"AlphaGPT 账号所属律所",sqlContent:"user_office_name LIKE ?",antiExamples:""};
  const semanticRuntime={ok:true,catalog:{columnsByTable:{
    alpha_crm_clue:[{columnName:"id",isSensitive:0}],
    alpha_account_user:[{columnName:"user_id",isSensitive:0},{columnName:"office_name",isSensitive:0},{columnName:"user_office_name",isSensitive:0}],
  }},published:{schema:{objectTypes:[
    {apiName:"clue",properties:[{apiName:"id",displayName:"线索标识",mapping:{table:"alpha_crm_clue",column:"id"}}]},
    {apiName:"alpha_gpt_account",properties:[{apiName:"id",displayName:"账号标识",mapping:{table:"alpha_account_user",column:"user_id"}},{apiName:"office_name",displayName:"AlphaGPT律所名称",mapping:{table:"alpha_account_user",column:"office_name"}}]},
  ]}}};
  const base={knowledge:[page],queryIntent:{requirements:[{id:"subject:clue",kind:"subject",required:true}]},retrieval:{tableNames:["alpha_crm_clue","alpha_account_user"],diagnostics:{pages:[{key:"term:alpha-gpt-office",lexical:0,semantic:.93}],facets:[{
    key:"subject:clue",kind:"subject",required:true,executionTables:["alpha_crm_clue"],bindingTables:[],paths:[["alpha_crm_clue"]],authoritativePageKeys:[],
  }]}}};
  assert.deepEqual(_internal.scopedKnowledgeOntologyConflicts(base,semanticRuntime),[],"vector-only recall is not an activated knowledge contract");
  const weakRecall={...base,retrieval:{...base.retrieval,diagnostics:{...base.retrieval.diagnostics,pages:[{key:"term:alpha-gpt-office",lexical:.55,semantic:0}],facets:[{...base.retrieval.diagnostics.facets[0],authoritativePageKeys:["term:alpha-gpt-office"]}]}}};
  assert.deepEqual(_internal.scopedKnowledgeOntologyConflicts(weakRecall,semanticRuntime),[],"even a weakly recalled page cannot cross the required facet execution closure");
});

test("refusal audits persist a non-empty intent for every pre-planning gate",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-audit-intent-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_customer",rowEstimate:10,grade:"A",active:1,comment:"客户"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_customer",columnName:"customer_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"客户编号"});
  store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"有效客户",title:"有效客户",aliases:"[]",tablesJson:'["crm_customer"]',content:"已实名客户",sqlContent:"按客户编号查询",antiExamples:"",verified:1,owner:"owner"});
  const connector={explain:async()=>[{rows:10}],query:async()=>[[{customer_id:7}],[{name:"customer_id"}]]};
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("拒答路径不得调用 LLM");};
  try {
    const service=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000}});

    // ranking limit refusal
    const ranking=await service.ask({sourceId:source.id,question:"查询有效客户 Top 1000",userName:"tester"});
    assert.equal(ranking.refused,true);
    assert.equal(ranking.failureClass,"policy_block");
    let audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.failureClass,"policy_block");
    assert.ok(audit.intent,"ranking 拒答的 intent_json 必须非空");
    assert.equal(audit.intent.version&&true,true);

    // coverage none refusal
    const miss=await service.ask({sourceId:source.id,question:"统计仓库温度传感器读数",userName:"tester"});
    assert.equal(miss.refused,true);
    assert.equal(miss.failureClass,"retrieval_miss");
    audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.failureClass,"retrieval_miss");
    assert.ok(audit.intent,"coverage none 拒答的 intent_json 必须非空");

    // semantic required but unavailable → ontology_missing
    const semanticService=createQueryService({store,connector,config:{llm:{baseUrl:"http://llm.test/v1",apiKey:"test",model:"test"},queryMaxRows:100,explainMaxRows:1000,semanticQueryPlanMode:"required"}});
    const semantic=await semanticService.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(semantic.refused,true);
    assert.equal(semantic.failureClass,"ontology_missing");
    audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.failureClass,"ontology_missing");
    assert.ok(audit.intent,"semantic 强制拒答的 intent_json 必须非空");
  } finally { globalThis.fetch=originalFetch;store.close(); }
});

test("llm-unconfigured refusals are classified for the gap board without an intent",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-audit-llm-"));const store=createStore(join(dir,"store.sqlite"));
  const source=store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  try {
    const service=createQueryService({store,connector:{},config:{llm:{baseUrl:"",apiKey:"",model:""},queryMaxRows:100,explainMaxRows:1000}});
    const answer=await service.ask({sourceId:source.id,question:"查询有效客户",userName:"tester"});
    assert.equal(answer.refused,true);
    assert.equal(answer.failureClass,"llm_unconfigured");
    const audit=store.listAudits(source.id,1)[0];
    assert.equal(audit.verdict,"refused");
    assert.equal(audit.failureClass,"llm_unconfigured");
    assert.equal(audit.intent,null);
  } finally { store.close(); }
});
