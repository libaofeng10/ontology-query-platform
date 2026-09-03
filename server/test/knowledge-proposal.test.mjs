import assert from "node:assert/strict";
import test from "node:test";
import { createKnowledgeProposalService, _internal } from "../src/knowledge-proposal-service.mjs";
import { knowledgeIntentConcepts } from "../src/query-intent.mjs";

const COLUMNS_BY_TABLE={
  crm_clue:[
    {columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"},
    {columnName:"is_win_order",dataType:"tinyint",isSensitive:0,comment:"是否成单"},
    {columnName:"order_time",dataType:"datetime",isSensitive:0,comment:"成单时间"},
    {columnName:"create_time",dataType:"datetime",isSensitive:0,comment:"创建时间"},
    {columnName:"owner_cell",dataType:"varchar(32)",isSensitive:1,comment:"负责人手机号"},
  ],
};

function contextFixture() {
  return {
    tables:[{tableName:"crm_clue"}],
    columns:COLUMNS_BY_TABLE,
    relations:[],
    retrieval:{diagnostics:{facets:[{key:"measure:win_rate",kind:"measure",required:true,executionTables:["crm_clue"],bindingTables:[]}]}},
    parseOptions:{concepts:[],filterConcepts:[],rowDomainConcepts:[],protectedTermAliases:[]},
  };
}

test("composeDraftPage renders a page whose formula round-trips through knowledgeIntentConcepts",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  const draft=_internal.composeDraftPage({
    table:"crm_clue",
    numerator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[{column:"is_win_order",operator:"=",value:1}]},
    denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},
    timeColumn:"order_time",
  },{sourceId:1,assetLabel:"成交率",shortlist});
  assert.ok(draft);
  assert.match(draft.page.sqlContent,/COUNT\(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END\) \/ COUNT\(DISTINCT clue_id\)/);
  const concept=knowledgeIntentConcepts([{...draft.page,verified:true,owner:"o"}],COLUMNS_BY_TABLE)[0];
  assert.equal(concept.aggregation,"ratio");
  assert.equal(concept.timeRole,"completion");
  const formula=concept.metricDefinition.formula;
  assert.ok(formula);
  assert.equal(formula.numerator.predicateBinding,"physical");
  assert.deepEqual(formula.numerator.predicates,[{column:"crm_clue.is_win_order",operator:"=",valueType:"number",value:"1"}]);
  const verdict=_internal.validateDraftPage(draft,{question:"查询成交率",context:contextFixture()});
  assert.equal(verdict.ok,true,verdict.reason);
});

test("unknown columns, bad operators and time literals are rejected at composition",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  const base={denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},timeColumn:"order_time"};
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"ghost_column",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"clue_id",predicates:[{column:"is_win_order",operator:"LIKE",value:"1"}]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"clue_id",predicates:[{column:"order_time",operator:">",value:"2026-01-01"}]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  assert.equal(_internal.composeDraftPage({...base,table:"ghost_table",numerator:{aggregation:"count",column:"clue_id",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
  // The sensitive column is not in the shortlist column whitelist either.
  assert.equal(_internal.composeDraftPage({...base,table:"crm_clue",numerator:{aggregation:"count",column:"owner_cell",predicates:[]}},{sourceId:1,assetLabel:"成交率",shortlist}),null);
});

test("a hand-written OR predicate fails validation even if composition is bypassed",()=>{
  const draft={
    slug:"cheat",timeColumn:"order_time",table:"crm_clue",
    page:{pageType:"metric",slug:"cheat",title:"成交率",aliases:["成交率"],tables:["crm_clue"],content:"成交率 成单",sqlContent:"SELECT COUNT(DISTINCT CASE WHEN is_win_order = 1 OR is_win_order = 2 THEN clue_id END) / COUNT(DISTINCT clue_id) FROM crm_clue",antiExamples:""},
  };
  const verdict=_internal.validateDraftPage(draft,{question:"查询成交率",context:contextFixture()});
  assert.equal(verdict.ok,false);
  assert.equal(verdict.reason,"predicate_unsupported");
});

test("shortlist excludes sensitive columns and tags event, identity and time roles",()=>{
  const shortlist=_internal.shortlistCandidates(contextFixture());
  assert.equal(shortlist.tables.length,1);
  const [table]=shortlist.tables;
  assert.equal(table.tableName,"crm_clue");
  assert.deepEqual(table.numeratorEvents.map((column)=>column.columnName),["is_win_order","order_time"]);
  assert.deepEqual(table.identities.map((column)=>column.columnName),["clue_id"]);
  assert.deepEqual(table.timeColumns.map((column)=>column.columnName),["order_time","create_time"]);
  assert.equal(table.columns.includes("owner_cell"),false);
  assert.doesNotMatch(JSON.stringify(shortlist),/owner_cell/);
});

test("unimplemented kinds return null without throwing and without calling the LLM",async()=>{
  let llmCalls=0;
  const service=createKnowledgeProposalService({store:{},config:{llm:{}},knowledge:{},evaluation:null,callJson:async()=>{llmCalls++;return {value:{proposals:[]}};}});
  assert.equal(await service.propose("term",{sourceId:1,question:"什么是有效客户",context:contextFixture()}),null);
  assert.equal(llmCalls,0);
});

test("propose returns validated metric drafts and drops unusable formulas",async()=>{
  const callJson=async()=>({value:{proposals:[
    {table:"crm_clue",numerator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[{column:"is_win_order",operator:"=",value:1}]},denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},timeColumn:"order_time",rationale:"以成单标记为分子"},
    {table:"crm_clue",numerator:{aggregation:"count",column:"ghost",predicates:[]},denominator:{aggregation:"count",column:"clue_id",predicates:[]},timeColumn:"order_time",rationale:"引用了不存在的列"},
  ]}});
  const service=createKnowledgeProposalService({store:{},config:{llm:{baseUrl:"http://llm.test",apiKey:"k",model:"m"},queryLlmTimeoutMs:1000},knowledge:{},evaluation:null,callJson});
  const proposal=await service.propose("metric",{sourceId:1,question:"查询成交率",context:contextFixture(),assetLabel:"成交率"});
  assert.ok(proposal);
  assert.equal(proposal.drafts.length,1);
  assert.equal(proposal.drafts[0].table,"crm_clue");
  assert.match(proposal.drafts[0].summary,/成交率 =/);
});

test("confirmProposal saves a verified page with the confirming editor as owner",async()=>{
  const saved=[];const evalCases=[];
  const knowledge={save:async(sourceId,input)=>{saved.push({sourceId,input});return {...input,sourceId};}};
  const store={getKnowledge:()=>null,addEvalCase:(input)=>{evalCases.push(input);}};
  const service=createKnowledgeProposalService({store,config:{llm:{}},knowledge,callJson:async()=>({value:{proposals:[]}})});
  const pending={sourceId:7,question:"查询成交率",drafts:[{slug:"成交率",page:{pageType:"metric",slug:"成交率",title:"成交率",aliases:["成交率"],tables:["crm_clue"],content:"定义",sqlContent:"SELECT 1/2 FROM crm_clue",antiExamples:""}}]};
  const result=await service.confirmProposal(pending,0,{userName:"editor-a"});
  assert.equal(result.verified,true);
  assert.equal(result.owner,"editor-a");
  assert.equal(saved.length,1);
  assert.deepEqual(evalCases,[{sourceId:7,setName:"口径确认",question:"查询成交率",goldSql:null,category:"口径确认",heldOut:0}]);
});

test("confirmProposal refuses to overwrite an existing verified page",async()=>{
  const store={getKnowledge:()=>({verified:1,title:"成交率"})};
  const service=createKnowledgeProposalService({store,config:{llm:{}},knowledge:{save:async()=>{throw new Error("不应到达");}},callJson:async()=>({value:{proposals:[]}})});
  const pending={sourceId:7,question:"查询成交率",drafts:[{slug:"成交率",page:{pageType:"metric",slug:"成交率",title:"成交率",aliases:[],tables:[],content:"",sqlContent:"SELECT 1",antiExamples:""}}]};
  await assert.rejects(()=>service.confirmProposal(pending,0,{userName:"editor-a"}),/已存在同名的已验证指标页/);
});

// ---------------------------------------------------------------------------
// S9: proposal flow wired into the query pipeline (clarification round-trip).
// ---------------------------------------------------------------------------

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createApp } from "../src/server.mjs";

async function appFixture(overrides={}) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-proposal-api-"));
  const connector={close:async()=>{},test:async()=>({ok:true}),explain:async()=>[{rows:2}],query:async()=>[[{win_rate:0.42}],[{name:"win_rate",type:"number"}]]};
  const app=createApp({
    dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"proposal-secret",connector,nodeEnv:"test",
    apiIdentities:[
      {name:"editor",role:"editor",token:"token-editor",sourceIds:"*"},
      {name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"},
    ],
    rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100},
    llm:{baseUrl:"http://llm.test/v1",apiKey:"sk-proposal",model:"proposal-test"},
    queryAgentMode:"off",queryAgentPendingTtlMs:60_000,queryLlmTimeoutMs:5_000,queryMaxRows:100,explainMaxRows:100,
    ...overrides,
  });
  const source=app.store.createSource({name:"real",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  app.store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:100,grade:"A",active:1,comment:"线索"});
  for(const [columnName,dataType,comment,isPrimary] of [["clue_id","bigint","线索编号",1],["is_win_order","tinyint","是否成单",0],["order_time","datetime","成单时间",0]])
    app.store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName,dataType,comment,isPrimary,isSensitive:0});
  app.store.upsertKnowledge({sourceId:source.id,pageType:"term",slug:"clue",title:"线索",aliases:'["成交","成单"]',tablesJson:'["crm_clue"]',content:"线索与成单口径",sqlContent:"按线索编号统计",antiExamples:"",verified:1,owner:"owner"});
  return {app,source};
}

async function api(app,path,token,body,method="POST") {
  const payload=body==null?"":JSON.stringify(body);
  const request=Readable.from(payload?[payload]:[]);
  request.method=method;request.url=path;
  request.headers={authorization:`Bearer ${token}`,"content-type":"application/json","content-length":String(Buffer.byteLength(payload))};
  request.socket={remoteAddress:"127.0.0.1"};
  let raw="";
  const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
  await app.handler(request,response);
  return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
}

function proposalLlmResponse() {
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({proposals:[{table:"crm_clue",numerator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[{column:"is_win_order",operator:"=",value:1}]},denominator:{aggregation:"count",distinct:true,column:"clue_id",predicates:[]},timeColumn:"order_time",rationale:"以成单标记为分子"}]})}}]}),{status:200});
}

// The query service resolves “本月” in the Asia/Shanghai business calendar.
// Derive the SQL range from the same calendar so this regression remains
// stable across month boundaries.
function currentBusinessMonth() {
  const parts=Object.fromEntries(new Intl.DateTimeFormat("en-US-u-ca-iso8601-nu-latn",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit"}).formatToParts(new Date()).filter((item)=>item.type==="year"||item.type==="month").map((item)=>[item.type,item.value]));
  const start=`${parts.year}-${parts.month}-01`;
  const next=new Date(Date.UTC(Number(parts.year),Number(parts.month),1));
  const endExclusive=`${next.getUTCFullYear()}-${String(next.getUTCMonth()+1).padStart(2,"0")}-01`;
  return {start,endExclusive};
}

test("clarification round-trip regression: verdict clarified persists and pendingId resumes",async(t)=>{
  // S9 前置回归：真实库 SELECT DISTINCT verdict 从无 clarified —— 先自证澄清链路可用。
  // 用无法解析的时间范围触发确定性意图澄清（不消耗 LLM）；答复“本月”可被确定性绑定，随后 loop 执行并给出答案。
  const {app,source}=await appFixture({queryAgentMode:"required",queryAgentMaxIterations:6,queryAgentMaxSqlCalls:3,queryAgentMaxScannedRows:100});
  t.after(async()=>{await app.close();});
  const {start,endExclusive}=currentBusinessMonth();
  const sql=`SELECT clue_id FROM crm_clue WHERE order_time >= '${start}' AND order_time < '${endExclusive}'`;
  const replies=[
    {thought:"执行查询。",tool:"run_sql",args:{sql}},
    {thought:"提交结论。",tool:"submit_answer",args:{sql,conclusion:"已按本月口径返回结果。"}},
  ];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(replies.shift())}}]}),{status:200});
  try {
    const first=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询最近那段时间的线索"});
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.ok(first.body.clarification?.pendingId,JSON.stringify(first.body));
    assert.equal(app.store.listAudits(source.id,1)[0].verdict,"clarified");
    const resumed=await api(app,"/api/query","token-analyst",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"本月"});
    assert.equal(resumed.status,200,JSON.stringify(resumed.body));
    assert.equal(resumed.body.refused,undefined,JSON.stringify(resumed.body));
    assert.equal(resumed.body.conclusion?.length>0,true);
    const verdicts=app.store.listAudits(source.id,10).map((item)=>item.verdict);
    assert.ok(verdicts.includes("clarified"));
    assert.ok(verdicts.includes("passed"));
  } finally { globalThis.fetch=originalFetch; }
});

test("metric proposal happy path: editor asks, picks a definition, page lands verified and the query re-runs",async(t)=>{
  const {app,source}=await appFixture({metricProposalEnabled:true});
  t.after(async()=>{await app.close();});
  const llmBodies=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{
    const body=JSON.parse(init.body);llmBodies.push(body);
    const content=String(body.messages.at(-1).content||"");
    if(content.includes("untrusted_input")&&content.includes("proposals"))return proposalLlmResponse();
    if(content.includes("返回 JSON"))return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:"SELECT COUNT(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END) / COUNT(DISTINCT clue_id) AS win_rate FROM crm_clue"})}}]}),{status:200});
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:"SELECT COUNT(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END) / COUNT(DISTINCT clue_id) AS win_rate FROM crm_clue"})}}]}),{status:200});
  };
  try {
    const first=await api(app,"/api/query","token-editor",{sourceId:source.id,question:"查询成交率"});
    assert.equal(first.status,200,JSON.stringify(first.body));
    assert.ok(first.body.clarification,JSON.stringify(first.body));
    assert.match(first.body.clarification.question,/还没有已验证的指标口径/);
    // N drafts + 1 "都不对" option
    assert.equal(first.body.clarification.options.at(-1),"都不对，先保持拒答");
    assert.ok(first.body.clarification.options.length>=2);
    assert.equal(app.store.listAudits(source.id,1)[0].verdict,"clarified");

    const chosen=first.body.clarification.options[0];
    const resumed=await api(app,"/api/query","token-editor",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:chosen});
    assert.equal(resumed.status,200,JSON.stringify(resumed.body));
    assert.equal(resumed.body.refused,undefined,JSON.stringify(resumed.body));
    const savedPage=app.store.listKnowledge(source.id).find((page)=>page.pageType==="metric"&&page.verified);
    assert.ok(savedPage,"确认后必须存在已验证指标页");
    assert.equal(savedPage.owner,"editor");
    // Session records the original question, not the clarification answer.
    const detail=app.store.getSessionDetail(resumed.body.sessionId);
    assert.equal(detail.messages.find((message)=>message.role==="user")?.content?.text,"查询成交率");
    // Confirmation also records an eval case with the original question.
    assert.ok(app.store.listEvalCases(source.id).some((item)=>item.setName==="口径确认"&&item.question==="查询成交率"));
  } finally { globalThis.fetch=originalFetch; }
});

test("analyst gets the plain refusal and the proposal LLM is never called",async(t)=>{
  const {app,source}=await appFixture({metricProposalEnabled:true});
  t.after(async()=>{await app.close();});
  let llmCalls=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{llmCalls++;return new Response(JSON.stringify({choices:[{message:{content:"{}"}}]}),{status:200});};
  try {
    const result=await api(app,"/api/query","token-analyst",{sourceId:source.id,question:"查询成交率"});
    assert.equal(result.status,200);
    assert.equal(result.body.refused,true,JSON.stringify(result.body));
    assert.equal(result.body.clarification,undefined);
    assert.equal(llmCalls,0,"analyst 拒答不得触发口径提议 LLM 调用");
  } finally { globalThis.fetch=originalFetch; }
});

test("choosing none-of-these refuses and saves no page",async(t)=>{
  const {app,source}=await appFixture({metricProposalEnabled:true});
  t.after(async()=>{await app.close();});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>proposalLlmResponse();
  try {
    const first=await api(app,"/api/query","token-editor",{sourceId:source.id,question:"查询成交率"});
    assert.ok(first.body.clarification);
    const resumed=await api(app,"/api/query","token-editor",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:"都不对，先保持拒答"});
    assert.equal(resumed.body.refused,true);
    assert.match(resumed.body.reason,/口径提议未被确认/);
    assert.equal(app.store.listKnowledge(source.id).some((page)=>page.pageType==="metric"),false);
  } finally { globalThis.fetch=originalFetch; }
});

test("with the switch off the refusal is byte-identical to the current behavior",async(t)=>{
  const fixtures=await Promise.all([appFixture({metricProposalEnabled:false}),appFixture({})]);
  t.after(async()=>{for(const {app} of fixtures)await app.close();});
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error("开关关闭时不得调用任何 LLM");};
  try {
    const responses=[];
    for(const {app,source} of fixtures){
      const result=await api(app,"/api/query","token-editor",{sourceId:source.id,question:"查询成交率"});
      assert.equal(result.body.refused,true,JSON.stringify(result.body));
      const stable={...result.body};delete stable.sessionId;
      responses.push(stable);
    }
    assert.deepEqual(responses[0],responses[1]);
  } finally { globalThis.fetch=originalFetch; }
});

test("loop guard: a second MEASURE_DEFINITION_REQUIRED after confirmation refuses instead of proposing again",async(t)=>{
  const {app,source}=await appFixture({metricProposalEnabled:true});
  t.after(async()=>{await app.close();});
  const originalFetch=globalThis.fetch;
  // The proposal draft validates locally, but we then sabotage the follow-up ask by
  // returning a proposal call again — _skipMetricProposal must prevent a second
  // clarification, so the retried ask ends in a normal refusal, not a loop.
  let proposalCalls=0;
  globalThis.fetch=async(_url,init)=>{
    const content=String(JSON.parse(init.body).messages.at(-1).content||"");
    if(content.includes("proposals")){proposalCalls++;return proposalLlmResponse();}
    // Legacy planner call for the re-ask: force a refusal-ish planner output.
    return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({needsExploration:"仍需人工口径"})}}]}),{status:200});
  };
  try {
    const first=await api(app,"/api/query","token-editor",{sourceId:source.id,question:"查询成交率"});
    assert.ok(first.body.clarification);
    const resumed=await api(app,"/api/query","token-editor",{sourceId:source.id,sessionId:first.body.sessionId,pendingId:first.body.clarification.pendingId,question:first.body.clarification.options[0]});
    // Whatever the re-ask outcome, it must not be another proposal clarification.
    assert.equal(resumed.body.clarification,undefined,JSON.stringify(resumed.body));
    assert.equal(proposalCalls,1,"确认后的重查不得再次触发口径提议");
  } finally { globalThis.fetch=originalFetch; }
});
