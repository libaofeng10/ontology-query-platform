import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createCapabilityGapService, _internal } from "../src/capability-gap-service.mjs";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { describeIntentFacets } from "../src/query-intent.mjs";
import { createStore } from "../src/store.mjs";

async function createFixture() {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-gaps-"));
  const store=createStore(join(root,"store.sqlite"));
  const source=store.createSource({name:"gaps",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"encrypted",isDemo:false});
  store.upsertTable({sourceId:source.id,tableName:"crm_clue",rowEstimate:100,grade:"A",active:1,comment:"线索"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_id",dataType:"bigint",isPrimary:1,isSensitive:0,comment:"线索编号"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"is_win_order",dataType:"tinyint",isSensitive:0,comment:"是否成单"});
  store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"order_time",dataType:"datetime",isSensitive:0,comment:"成单时间"});
  return {store,source};
}

function metricRefusalIntent(sourceText) {
  return JSON.stringify({version:"2.0",ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",message:`比例指标“${sourceText}”缺少已验证的分子、分母和去重口径`,blocking:true,sourceText}]});
}

test("gap aggregation groups repeated metric refusals and caps sample questions at 3",async()=>{
  const {store,source}=await createFixture();
  try {
    for(const question of ["查询成交率","上月成交率是多少","按渠道看成交率","成交率趋势"])
      store.addAudit({userName:"analyst",sourceId:source.id,question,verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("成交率")});
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询已通过的问题",verdict:"passed"});
    const service=createCapabilityGapService({store});
    const {gaps,auditWindow}=service.listGaps(source.id);
    assert.equal(auditWindow,4);
    assert.equal(gaps.length,1);
    assert.equal(gaps[0].code,"MEASURE_DEFINITION_REQUIRED");
    assert.equal(gaps[0].assetLabel,"成交率");
    assert.equal(gaps[0].count,4);
    assert.equal(gaps[0].sampleQuestions.length,3);
    assert.equal(gaps[0].status,"open");
    assert.deepEqual(gaps[0].remedy,{action:"create_metric_page",prefill:{pageType:"metric",title:"成交率"}});
  } finally { store.close(); }
});

test("degraded path merges intent-less audits that differ only in literals",async()=>{
  const {store,source}=await createFixture();
  try {
    for(const reason of [
      '找不到"线索"主表 crm_lead_2024，共扫描 120 张表',
      '找不到"商机线索"主表 crm_lead_2025，共扫描 121 张表',
      '找不到"新线索"主表 legacy_leads，共扫描 98 张表',
    ])
      store.addAudit({userName:"analyst",sourceId:source.id,question:`按线索统计（${reason.slice(0,6)}）`,verdict:"failed",failReason:reason,failureClass:"schema_gap"});
    const service=createCapabilityGapService({store});
    const {gaps}=service.listGaps(source.id);
    assert.equal(gaps.length,1,JSON.stringify(gaps.map((gap)=>gap.key)));
    assert.equal(gaps[0].count,3);
    assert.equal(gaps[0].code,"CLASS:schema_gap");
    // Fingerprints group; display keeps the raw questions.
    assert.equal(gaps[0].sampleQuestions.length,3);
  } finally { store.close(); }
});

test("llm_unconfigured rows always take the degraded path and get a configure remedy",async()=>{
  const {store,source}=await createFixture();
  try {
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询成交率",verdict:"refused",failReason:"真实数据源已连接，但 LLM 配置不可用：未配置 LLM_BASE_URL。",failureClass:"llm_unconfigured"});
    const {gaps}=createCapabilityGapService({store}).listGaps(source.id);
    assert.equal(gaps.length,1);
    assert.equal(gaps[0].assetLabel,"LLM 未配置");
    assert.deepEqual(gaps[0].remedy,{action:"configure_llm"});
    assert.equal(gaps[0].status,"open");
  } finally { store.close(); }
});

test("a verified metric page with a matching alias resolves the gap on the next read",async()=>{
  const {store,source}=await createFixture();
  try {
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询成交率",verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("成交率")});
    const service=createCapabilityGapService({store});
    assert.equal(service.listGaps(source.id).gaps[0].status,"open");

    store.upsertKnowledge({sourceId:source.id,pageType:"metric",slug:"clue-win-rate",title:"线索成交率",aliases:'["成交率"]',tablesJson:'["crm_clue"]',content:"成单线索数除以全部线索数",sqlContent:"COUNT(DISTINCT CASE WHEN is_win_order = 1 THEN clue_id END) / COUNT(DISTINCT clue_id) 按 order_time 归属",antiExamples:"",verified:1,owner:"editor"});
    const after=service.listGaps(source.id).gaps[0];
    assert.equal(after.status,"resolved");
    // resolved gaps sort after open ones
    store.addAudit({userName:"analyst",sourceId:source.id,question:"查询回款率",verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("回款率")});
    const {gaps}=service.listGaps(source.id);
    assert.deepEqual(gaps.map((gap)=>[gap.assetLabel,gap.status]),[["回款率","open"],["成交率","resolved"]]);
  } finally { store.close(); }
});

test("fail reason fingerprints strip literals, numbers and table tokens",()=>{
  const first=_internal.failReasonFingerprint('找不到"线索"主表 crm_lead_2024，共扫描 120 张表');
  const second=_internal.failReasonFingerprint('找不到"商机线索"主表 crm_lead_x，共扫描 3 张表');
  assert.equal(first,second);
  assert.doesNotMatch(first,/crm_lead|120|线索/);
});

test("capability gap API is editor-gated and returns the aggregated board",async(t)=>{
  const {createApp}=await import("../src/server.mjs");
  const {Readable}=await import("node:stream");
  const root=await mkdtemp(join(tmpdir(),"ontoquery-gap-api-"));
  const app=createApp({dbPath:join(root,"store.sqlite"),wikiDir:join(root,"wiki"),appSecret:"gap-api-secret",connector:{close:async()=>{}},nodeEnv:"test",apiIdentities:[
    {name:"editor",role:"editor",token:"token-editor",sourceIds:"*"},
    {name:"analyst",role:"analyst",token:"token-analyst",sourceIds:"*"},
  ],rateLimits:{queryPerMinute:100,writePerMinute:100,readPerMinute:100}});
  t.after(async()=>{await app.close();});
  const source=app.store.createSource({name:"gap-api",kind:"mysql",host:"db",port:3306,dbName:"crm",userName:"ro",credential:"unused",isDemo:false});
  app.store.addAudit({userName:"analyst",sourceId:source.id,question:"查询成交率",verdict:"refused",failReason:"缺少口径",failureClass:"schema_gap",intentJson:metricRefusalIntent("成交率")});

  async function get(path,token){
    const request=Readable.from([]);
    request.method="GET";request.url=path;
    request.headers={authorization:`Bearer ${token}`};
    request.socket={remoteAddress:"127.0.0.1"};
    let raw="";
    const response={statusCode:200,headers:{},setHeader(name,value){this.headers[String(name).toLowerCase()]=value;},end(value){raw=value?String(value):"";}};
    await app.handler(request,response);
    return {status:response.statusCode,body:raw?JSON.parse(raw):{}};
  }

  const denied=await get(`/api/capability-gaps?sourceId=${source.id}`,"token-analyst");
  assert.equal(denied.status,403);
  const board=await get(`/api/capability-gaps?sourceId=${source.id}`,"token-editor");
  assert.equal(board.status,200);
  assert.equal(board.body.gaps.length,1);
  assert.equal(board.body.gaps[0].assetLabel,"成交率");
  assert.ok(board.body.generatedAt);
  assert.equal(board.body.auditWindow,1);
});

test("a verified page whose semantics are invalid becomes an open gap naming the missing declaration",()=>{
  // Built from a plain page object rather than the save path: save refuses a verified
  // invalid page, but Markdown sync and rows written before the validator existed can
  // still produce one, and the board exists precisely to surface those.
  const gaps=_internal.pageHealthGaps({
    knowledgePages:[{pageType:"metric",slug:"rate",title:"成交率",verified:true,tables:["clue"],content:"分母是唯一线索。",sqlContent:"COUNT(DISTINCT CASE WHEN clue.ghost = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"}],
    columnsByTable:{clue:[{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"clue_create_time",dataType:"datetime"}]},
  });
  assert.equal(gaps.length,1);
  assert.equal(gaps[0].code,"PAGE_SEMANTIC_INVALID");
  assert.equal(gaps[0].assetLabel,"成交率");
  assert.equal(gaps[0].status,"open");
  assert.deepEqual(gaps[0].remedy,{action:"edit_knowledge_page",prefill:{pageType:"metric",slug:"rate",title:"成交率"}});
  assert.match(gaps[0].detail,/ghost/,"缺口详情必须指向具体的缺失声明，否则运维不知道该改哪一行");
});

test("healthy and unverified pages stay off the board",()=>{
  const columnsByTable={clue:[{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"clue_create_time",dataType:"datetime"},{columnName:"is_win",dataType:"tinyint"}]};
  const healthy={pageType:"metric",slug:"ok",title:"健康指标",verified:true,tables:["clue"],content:"分母是统计周期内进线的唯一线索。统计周期固定绑定 clue.clue_create_time。",sqlContent:"COUNT(DISTINCT CASE WHEN clue.is_win = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"};
  const draft={...healthy,slug:"draft",title:"草稿",verified:false,sqlContent:"COUNT(DISTINCT CASE WHEN clue.ghost = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"};
  assert.deepEqual(_internal.pageHealthGaps({knowledgePages:[healthy,draft],columnsByTable}),[]);
});

test("a degraded verified page reaches the board through the real service",async()=>{
  const {store,source}=await createFixture();
  try {
    store.upsertColumn({sourceId:source.id,tableName:"crm_clue",columnName:"clue_create_time",dataType:"datetime",isSensitive:0,comment:"进线时间"});
    const wikiDir=join(await mkdtemp(join(tmpdir(),"ontoquery-gap-wiki-")),"wiki");
    const saved=await createKnowledgeService({store,wikiDir}).save(source.id,{
      pageType:"metric",title:"成交率",aliases:["成交率"],tables:["crm_clue"],
      content:"分母是进线的唯一线索，分子是其中成单的唯一线索。",
      sqlContent:"COUNT(DISTINCT CASE WHEN crm_clue.is_win_order = 1 THEN crm_clue.clue_id END) / COUNT(DISTINCT crm_clue.clue_id)",
      verified:true,owner:"editor-a",
    });
    assert.equal(saved.semanticHealth,"degraded","前置条件：这一页必须是已验证但语义降级的");
    const gap=createCapabilityGapService({store}).listGaps(source.id).gaps.find((item)=>item.code==="PAGE_SEMANTIC_DEGRADED");
    assert.ok(gap,"已验证但语义降级的页面必须出现在看板上，否则它会一直静默降级");
    assert.equal(gap.assetLabel,"成交率");
    assert.equal(gap.remedy.action,"edit_knowledge_page");
    assert.equal(gap.remedy.prefill.slug,saved.slug);
    assert.match(gap.detail,/TIME_ROLE_UNDETERMINED/);
  } finally { store.close(); }
});

test("refusal copy renders business surfaces, never internal facet ids",()=>{
  // The gap board and the refusal card are the two places a business user reads
  // machine state; a leaked "filter:channel:0" there is a defect, not cosmetics.
  const intent={requirements:[
    {id:"filter:channel:0",kind:"filter",field:"source_data_channel",fieldSurface:"渠道",value:"抖音"},
    {id:"subject:clue",kind:"subject",value:"clue"},
    {id:"measure:rate",kind:"measure",sourceText:"成交率"},
  ]};
  const described=describeIntentFacets(intent,["filter:channel:0","subject:clue","measure:rate"]);
  assert.deepEqual(described,["筛选「渠道」","业务对象「线索」","指标「成交率」"]);
  for(const text of described) {
    assert.doesNotMatch(text,/:/,"facet id 的冒号形态不得出现在用户可见文案里");
    assert.doesNotMatch(text,/source_data_channel/,"物理列名不得出现在用户可见文案里");
    assert.doesNotMatch(text,/抖音/,"筛选值可能是个人数据，不得进入拒答文案");
  }
});
