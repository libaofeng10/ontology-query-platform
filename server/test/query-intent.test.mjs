import assert from "node:assert/strict";
import test from "node:test";
import { applyIntentClarification, buildIntentRetrievalQuestion, catalogFilterConcepts, DEFAULT_BUSINESS_TIME_ZONE, knowledgeIntentConcepts, knowledgeIntentRowDomains, mergeContextualQueryIntent, parseQueryIntent, queryIntentSqlErrors } from "../src/query-intent.mjs";

test("Alpha 用户识别为账号，机构专名中的词不激活业务规则",()=>{
  const rowDomainConcepts=knowledgeIntentRowDomains([
    {pageType:"term",slug:"law-firm",title:"律师事务所",aliases:[],tables:["office"],verified:true,sqlContent:"organization_type = 1 OR organization_type = 2"},
  ],{office:[{columnName:"organization_type",dataType:"int"}]});
  for(const question of ["查询北京示例律师事务所的Alpha用户","查询 北京示例 律师事务所 的 Alpha 用户"]) {
    const intent=parseQueryIntent(question,{rowDomainConcepts});
    assert.deepEqual(intent.subjects,["account"]);
    assert.equal(intent.filters[0]?.value,"北京示例");
    assert.equal(intent.filters[0]?.attachesTo,"account");
    assert.deepEqual(intent.ambiguities.filter((item)=>item.blocking),[]);
  }
  assert.ok(parseQueryIntent("查询律师事务所的账号",{rowDomainConcepts}).ambiguities.some((item)=>item.code==="KNOWLEDGE_FILTER_BINDING_UNSUPPORTED"),"独立业务术语仍需验证其谓词");
});

test("粘贴的律所系统标识绑定已发布律所 ID，不能丢弃或改绑用户 ID",()=>{
  const tables=[{tableName:"account",comment:"Alpha用户"}];
  const columns={account:[{columnName:"user_key",dataType:"varchar"},{columnName:"office_key",dataType:"varchar"}]};
  const schema={objectTypes:[{apiName:"account",properties:[{apiName:"id",mapping:{table:"account",column:"user_key"}},{apiName:"office_id",displayName:"律所ID",mapping:{table:"account",column:"office_key"}}]}]};
  const options={filterConcepts:catalogFilterConcepts(tables,columns,schema)};
  const id="0123456789ABCDEF0123456789ABCDEF";
  const question=`北京示例律师事务所 示例律师团队 ${id} 帮我查这套系统里面的Alpha用户`;
  const intent=parseQueryIntent(question,options);
  const filter=intent.filters.find((item)=>item.field==="organization_id");
  assert.equal(filter.value,id);
  assert.equal(filter.operator,"eq");
  assert.deepEqual(filter.physicalColumns,["account.office_key"]);
  assert.equal(filter.attachesTo,"account");
  assert.ok(intent.requirements.some((item)=>item.id===filter.id));
  assert.ok(parseQueryIntent(question).ambiguities.some((item)=>item.code==="SYSTEM_ID_BINDING_UNKNOWN"));
  assert.ok(parseQueryIntent(`${question} FEDCBA9876543210FEDCBA9876543210`,options).ambiguities.some((item)=>item.code==="SYSTEM_ID_BINDING_UNKNOWN"));
  const explicit=parseQueryIntent(`北京示例律师事务所这套系统的Alpha用户，account.user_key 等于 ${id}`,options);
  assert.equal(explicit.filters.some((item)=>item.field==="organization_id"),false,"已明确字段的用户 ID 不能重新解释为律所 ID");
  assert.ok(explicit.filters.some((item)=>item.physicalColumns?.includes("account.user_key")&&item.value===id));
});

test("relative calendar ranges use an explicit validated business time zone at the month boundary",()=>{
  const instant=new Date("2026-08-31T16:30:00.000Z");
  const original=process.env.BUSINESS_TIME_ZONE;
  try {
    delete process.env.BUSINESS_TIME_ZONE;
    const shanghai=parseQueryIntent("查询本月线索",{now:instant});
    assert.equal(shanghai.timeZone,"Asia/Shanghai");
    assert.deepEqual(shanghai.timeRange,{kind:"current_month",sourceText:"本月",start:"2026-09-01",endExclusive:"2026-10-01"});

    const utc=parseQueryIntent("查询本月线索",{now:instant,timeZone:"UTC"});
    assert.equal(utc.timeZone,"UTC");
    assert.deepEqual(utc.timeRange,{kind:"current_month",sourceText:"本月",start:"2026-08-01",endExclusive:"2026-09-01"});
    assert.deepEqual(parseQueryIntent("查询上月线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"previous_month",sourceText:"上月",start:"2026-08-01",endExclusive:"2026-09-01"});
    assert.deepEqual(parseQueryIntent("查询上月线索",{now:instant,timeZone:"UTC"}).timeRange,{kind:"previous_month",sourceText:"上月",start:"2026-07-01",endExclusive:"2026-08-01"});

    const invalid=parseQueryIntent("查询本月线索",{now:instant,timeZone:"../../invalid zone"});
    assert.equal(invalid.timeZone,DEFAULT_BUSINESS_TIME_ZONE);
    assert.equal(invalid.timeRange.start,"2026-09-01");

    process.env.BUSINESS_TIME_ZONE="UTC";
    assert.equal(parseQueryIntent("查询本月线索",{now:instant}).timeRange.start,"2026-08-01");
    process.env.BUSINESS_TIME_ZONE="Not/A_Time_Zone";
    assert.equal(parseQueryIntent("查询本月线索",{now:instant}).timeRange.start,"2026-09-01");
  } finally {
    if(original===undefined)delete process.env.BUSINESS_TIME_ZONE;else process.env.BUSINESS_TIME_ZONE=original;
  }
});

test("today yesterday year-over-year and period-over-period stay on business calendar boundaries",()=>{
  const instant=new Date("2026-08-31T16:30:00.000Z");
  assert.deepEqual(parseQueryIntent("查询今天线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"today",sourceText:"今天",start:"2026-09-01",endExclusive:"2026-09-02"});
  assert.deepEqual(parseQueryIntent("查询昨天线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"yesterday",sourceText:"昨天",start:"2026-08-31",endExclusive:"2026-09-01"});
  assert.deepEqual(parseQueryIntent("查询今天线索",{now:instant,timeZone:"UTC"}).timeRange,{kind:"today",sourceText:"今天",start:"2026-08-31",endExclusive:"2026-09-01"});

  const yearOverYear=parseQueryIntent("本月线索成单数同比",{now:instant,timeZone:"Asia/Shanghai"});
  assert.deepEqual(yearOverYear.comparisonRange,{kind:"comparison_year_over_year",sourceText:"同比基准期",start:"2025-09-01",endExclusive:"2025-10-01"});
  const periodOverPeriod=parseQueryIntent("本月线索成单数环比",{now:instant,timeZone:"Asia/Shanghai"});
  assert.deepEqual(periodOverPeriod.comparisonRange,{kind:"comparison_period_over_period",sourceText:"环比基准期",start:"2026-08-01",endExclusive:"2026-09-01"});

  const leapDay=parseQueryIntent("今天线索成单数同比",{now:new Date("2024-02-29T04:00:00.000Z"),timeZone:"Asia/Shanghai"});
  assert.deepEqual(leapDay.timeRange,{kind:"today",sourceText:"今天",start:"2024-02-29",endExclusive:"2024-03-01"});
  assert.deepEqual(leapDay.comparisonRange,{kind:"comparison_year_over_year",sourceText:"同比基准期",start:"2023-02-28",endExclusive:"2023-03-01"});
});

test("current and previous weeks use Monday boundaries in the business time zone",()=>{
  const instant=new Date("2026-08-30T16:30:00.000Z");
  assert.deepEqual(parseQueryIntent("查询本周线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"current_week",sourceText:"本周",start:"2026-08-31",endExclusive:"2026-09-07"});
  assert.deepEqual(parseQueryIntent("查询上周线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"previous_week",sourceText:"上周",start:"2026-08-24",endExclusive:"2026-08-31"});
  assert.deepEqual(parseQueryIntent("查询本周线索",{now:instant,timeZone:"UTC"}).timeRange,{kind:"current_week",sourceText:"本周",start:"2026-08-24",endExclusive:"2026-08-31"});

  const periodOverPeriod=parseQueryIntent("本周线索成单数环比",{now:instant,timeZone:"Asia/Shanghai"});
  assert.deepEqual(periodOverPeriod.comparisonRange,{kind:"comparison_period_over_period",sourceText:"环比基准期",start:"2026-08-24",endExclusive:"2026-08-31"});

  const currentWeek=parseQueryIntent("查询本周线索",{now:instant,timeZone:"Asia/Shanghai"});
  assert.ok(queryIntentSqlErrors(currentWeek,"SELECT clue_id FROM alpha_crm_clue").some((item)=>item.code==="INTENT_TIME_DROPPED"));
  assert.equal(queryIntentSqlErrors(currentWeek,"SELECT clue_id FROM alpha_crm_clue WHERE clue_create_time >= '2026-08-31' AND clue_create_time < '2026-09-07'").some((item)=>item.code==="INTENT_TIME_DROPPED"),false);
});

test("quarter and year ranges stay correct across a business-calendar year boundary",()=>{
  const instant=new Date("2026-12-31T16:30:00.000Z");
  assert.deepEqual(parseQueryIntent("本季度线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"current_quarter",sourceText:"本季度",start:"2027-01-01",endExclusive:"2027-04-01"});
  assert.deepEqual(parseQueryIntent("上季度线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"previous_quarter",sourceText:"上季度",start:"2026-10-01",endExclusive:"2027-01-01"});
  assert.deepEqual(parseQueryIntent("今年线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"current_year",sourceText:"今年",start:"2027-01-01",endExclusive:"2028-01-01"});
  assert.deepEqual(parseQueryIntent("去年线索",{now:instant,timeZone:"Asia/Shanghai"}).timeRange,{kind:"previous_year",sourceText:"去年",start:"2026-01-01",endExclusive:"2027-01-01"});
  assert.deepEqual(parseQueryIntent("本季度线索",{now:instant,timeZone:"UTC"}).timeRange,{kind:"current_quarter",sourceText:"本季度",start:"2026-10-01",endExclusive:"2027-01-01"});

  const quarterComparison=parseQueryIntent("本季度线索成单数环比",{now:instant,timeZone:"Asia/Shanghai"});
  assert.deepEqual(quarterComparison.comparisonRange,{kind:"comparison_period_over_period",sourceText:"环比基准期",start:"2026-10-01",endExclusive:"2027-01-01"});
});

test("rolling day week month and year ranges include today and cross years safely",()=>{
  const now=new Date("2027-01-01T16:30:00.000Z");
  assert.deepEqual(parseQueryIntent("近7天线索",{now,timeZone:"Asia/Shanghai"}).timeRange,{kind:"rolling_days",sourceText:"近7天",start:"2026-12-27",endExclusive:"2027-01-03"});
  assert.deepEqual(parseQueryIntent("近2周线索",{now,timeZone:"Asia/Shanghai"}).timeRange,{kind:"rolling_weeks",sourceText:"近2周",start:"2026-12-20",endExclusive:"2027-01-03"});
  assert.deepEqual(parseQueryIntent("近3个月线索",{now,timeZone:"Asia/Shanghai"}).timeRange,{kind:"rolling_months",sourceText:"近3个月",start:"2026-10-03",endExclusive:"2027-01-03"});
  assert.deepEqual(parseQueryIntent("近2年线索",{now,timeZone:"Asia/Shanghai"}).timeRange,{kind:"rolling_years",sourceText:"近2年",start:"2025-01-03",endExclusive:"2027-01-03"});

  const comparison=parseQueryIntent("近7天线索成单数环比",{now,timeZone:"Asia/Shanghai"});
  assert.deepEqual(comparison.comparisonRange,{kind:"comparison_period_over_period",sourceText:"环比基准期",start:"2026-12-20",endExclusive:"2026-12-27"});
});

test("explicit Chinese day month year and inclusive date pairs become half-open ranges",()=>{
  assert.deepEqual(parseQueryIntent("2026年8月线索").timeRange,{kind:"explicit_month",sourceText:"2026年8月",start:"2026-08-01",endExclusive:"2026-09-01"});
  assert.deepEqual(parseQueryIntent("2026年线索").timeRange,{kind:"explicit_year",sourceText:"2026年",start:"2026-01-01",endExclusive:"2027-01-01"});
  assert.deepEqual(parseQueryIntent("2024年2月29日线索").timeRange,{kind:"explicit_day",sourceText:"2024年2月29日",start:"2024-02-29",endExclusive:"2024-03-01"});
  assert.deepEqual(parseQueryIntent("从2026年12月20日到2027年1月5日的线索").timeRange,{kind:"explicit_date_range",sourceText:"2026年12月20日到2027年1月5日",start:"2026-12-20",endExclusive:"2027-01-06"});
  assert.deepEqual(parseQueryIntent("2026年1月1日与2026年1月1日之间的线索").timeRange,{kind:"explicit_date_range",sourceText:"2026年1月1日与2026年1月1日",start:"2026-01-01",endExclusive:"2026-01-02"});

  const leapComparison=parseQueryIntent("2024年2月29日线索成单数同比");
  assert.deepEqual(leapComparison.comparisonRange,{kind:"comparison_year_over_year",sourceText:"同比基准期",start:"2023-02-28",endExclusive:"2023-03-01"});
});

test("unsupported or invalid explicit time wording blocks instead of silently dropping the range",()=>{
  for(const question of ["近0天线索","近-2周线索","近1.5个月线索","近三年线索","近2000年线索","近999999999999999999999天线索","2026年13月线索","2026年2月30日线索","2026年12月31日到2026年1月1日线索","2026年8月到9月线索","2026年8月1日到31日线索","上半年线索","截至今天的线索","本月和上月线索","8月线索","2026-08-01线索"]) {
    const intent=parseQueryIntent(question);
    assert.equal(intent.timeRange,null,question);
    assert.ok(intent.ambiguities.some((item)=>item.code==="TIME_RANGE_UNKNOWN"&&item.blocking),question);
  }

  for(const question of ["线索数量","按月统计线索趋势","按成单时间统计线索","查询北京今日头条律师事务所账号","查询北京未来科技律所账号"]) {
    const intent=parseQueryIntent(question);
    assert.equal(intent.timeRange,null,question);
    assert.equal(intent.ambiguities.some((item)=>item.code==="TIME_RANGE_UNKNOWN"),false,question);
  }

  const prior=parseQueryIntent("本月线索");
  const invalidFollowUp=parseQueryIntent("那上半年呢");
  const merged=mergeContextualQueryIntent(invalidFollowUp,prior);
  assert.equal(merged.timeRange,null);
  assert.ok(merged.ambiguities.some((item)=>item.code==="TIME_RANGE_UNKNOWN"&&item.blocking));

  const needsClarification=parseQueryIntent("上半年线索成单数",{now:new Date("2026-08-26T00:00:00.000Z"),timeZone:"Asia/Shanghai"});
  const clarified=applyIntentClarification(needsClarification,"本季度",{now:new Date("2026-08-26T00:00:00.000Z")});
  assert.deepEqual(clarified.timeRange,{kind:"current_quarter",sourceText:"本季度",start:"2026-07-01",endExclusive:"2026-10-01"});
  assert.equal(clarified.ambiguities.some((item)=>item.code==="TIME_RANGE_UNKNOWN"),false);
  assert.equal(clarified.timeRole.value,"completion");
});

test("query intent preserves an implicit law-firm entity, month and clue subject",()=>{
  const intent=parseQueryIntent("查询一下北京大成本月进线的线索",{now:new Date(2026,7,18)});
  assert.deepEqual(intent.entities.map((item)=>item.text),["北京大成"]);
  assert.deepEqual(intent.subjects,["clue"]);
  assert.deepEqual(intent.timeRange,{kind:"current_month",sourceText:"本月",start:"2026-08-01",endExclusive:"2026-09-01"});
  assert.match(buildIntentRetrievalQuestion(intent),/clue_create_time/);
  assert.match(queryIntentSqlErrors(intent,"SELECT id FROM alpha_crm_clue WHERE city='北京市'")[0].message,/北京大成/);
  assert.equal(queryIntentSqlErrors(intent,"SELECT id FROM alpha_crm_clue WHERE office_name LIKE '%北京大成%' AND clue_create_time >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')").length,0);
});

test("query intent does not mistake a region-only phrase for an organization",()=>{
  const intent=parseQueryIntent("查询北京地区本月进线线索",{now:new Date(2026,7,18)});
  assert.deepEqual(intent.entities,[]);
  assert.equal(intent.timeRange.kind,"current_month");
});

test("query intent marks exhaustive account scope and explicit products",()=>{
  const intent=parseQueryIntent("查询北京大成律所 Alpha 和 AlphaGPT 所有账号情况");
  assert.equal(intent.scope.exhaustive,true);
  assert.deepEqual(intent.scope.products,["alpha","alphaGpt"]);
  assert.deepEqual(intent.entities.map((item)=>item.text),["北京大成"]);
});

test("query intent recognizes case and revenue as first-class business objects",()=>{
  assert.deepEqual(parseQueryIntent("查询本月案件").subjects,["case"]);
  assert.deepEqual(parseQueryIntent("统计订单收入").subjects,["order","revenue"]);
});

test("query intent models ranking measure dimension grain and event-time role independently",()=>{
  const intent=parseQueryIntent("本月线索，销售成单排行",{now:new Date(2026,7,25)});
  assert.equal(intent.version,"2.0");
  assert.deepEqual(intent.shape,{kind:"ranking",direction:"desc",requestedLimit:null});
  assert.deepEqual(intent.dimensions.map((item)=>item.value),["seller"]);
  assert.deepEqual(intent.measures.map((item)=>[item.value,item.aggregation,item.grain]),[["won","count_distinct","clue"]]);
  assert.equal(intent.timeRole.value,"completion");
  assert.deepEqual(intent.requirements.map((item)=>item.id),["subject:clue","dimension:seller","measure:won","time:current_month"]);
  assert.deepEqual(intent.ambiguities.filter((item)=>item.blocking).map((item)=>item.code),["DIMENSION_ATTRIBUTION_AMBIGUOUS"]);
  assert.match(buildIntentRetrievalQuestion(intent),/seller_name/);
  assert.match(buildIntentRetrievalQuestion(intent),/order_time/);
});

test("ranking keeps the complete Top N token and blocks invalid limits",()=>{
  const top1000=parseQueryIntent("本月线索销售成单排行 Top 1000",{now:new Date(2026,7,25)});
  assert.equal(top1000.shape.requestedLimit,1_000);
  assert.equal(top1000.shape.requestedLimitInvalid,undefined);
  assert.equal(parseQueryIntent("本月线索销售成单前1000名",{now:new Date(2026,7,25)}).shape.requestedLimit,1_000);
  const invalid=parseQueryIntent("本月线索销售成单排行 Top 0",{now:new Date(2026,7,25)});
  assert.equal(invalid.shape.requestedLimit,null);
  assert.equal(invalid.shape.requestedLimitInvalid,"0");
  assert.ok(invalid.ambiguities.some((item)=>item.code==="RANKING_LIMIT_INVALID"&&item.blocking));
});

test("query intent keeps entry time separate from completion time and avoids treating sales amount as a seller",()=>{
  const entered=parseQueryIntent("本月进线线索数量按渠道排行",{now:new Date(2026,7,25)});
  assert.equal(entered.timeRole.value,"entry");
  assert.deepEqual(entered.dimensions.map((item)=>item.value),["channel"]);
  assert.deepEqual(entered.measures.map((item)=>item.value),["count"]);
  const revenue=parseQueryIntent("本月销售额按产品排行",{now:new Date(2026,7,25)});
  assert.deepEqual(revenue.dimensions.map((item)=>item.value),["product"]);
  assert.equal(revenue.dimensions.some((item)=>item.value==="seller"),false);
  assert.equal(revenue.measures.some((item)=>item.value==="revenue"),true);
});

test("business clarification resolves attribution without discarding other immutable requirements",()=>{
  const intent=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  const resolved=applyIntentClarification(intent,"按当前负责人统计");
  assert.equal(resolved.dimensions[0].attribution,"current");
  assert.equal(resolved.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"),false);
  assert.equal(resolved.requirements.find((item)=>item.id==="dimension:seller").role,"attribution:current");
  assert.equal(resolved.timeRole.value,"completion");
  assert.equal(resolved.measures[0].grain,"clue");
  assert.match(buildIntentRetrievalQuestion(resolved),/当前负责人/);
  assert.match(buildIntentRetrievalQuestion(resolved),/active_owner/);
  const eventTime=applyIntentClarification(intent,"事件发生时负责人");
  assert.match(buildIntentRetrievalQuestion(eventTime),/负责人快照/);
  assert.match(buildIntentRetrievalQuestion(eventTime),/owner_snapshot/);
});

test("seller-attribution clarification respects negation and keeps dual affirmative scopes blocking",()=>{
  const base=parseQueryIntent("本月线索销售成单排行",{now:new Date(2026,7,25)});
  const eventTime=applyIntentClarification(base,"不是当前负责人，按成单时负责人");
  assert.equal(eventTime.dimensions[0].attribution,"event_time");
  assert.equal(eventTime.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"),false);
  const current=applyIntentClarification(base,"不要成单时负责人，按当前负责人");
  assert.equal(current.dimensions[0].attribution,"current");
  assert.equal(current.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"),false);
  const dual=applyIntentClarification(base,"当前负责人和成单时负责人都要");
  assert.equal(dual.dimensions[0].attribution,null);
  assert.ok(dual.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"&&item.blocking));
  const initial=parseQueryIntent("本月线索，不是当前负责人，按成单时负责人统计成单排行",{now:new Date(2026,7,25)});
  assert.equal(initial.dimensions.find((item)=>item.value==="seller")?.attribution,"event_time");
});

test("ordinary business filters become immutable typed requirements instead of disappearing",()=>{
  const intent=parseQueryIntent("本月创建的状态为有效且金额大于1000的线索数量",{now:new Date(2026,7,25)});
  assert.deepEqual(intent.filters.map((item)=>({field:item.field,operator:item.operator,value:item.value,valueType:item.valueType})),[
    {field:"status",operator:"eq",value:"有效",valueType:"string"},
    {field:"amount",operator:"gt",value:"1000",valueType:"number"},
  ]);
  assert.deepEqual(intent.requirements.filter((item)=>item.kind==="filter").map((item)=>({id:item.id,operator:item.operator,value:item.value,valueType:item.valueType})),[
    {id:"filter:status:0",operator:"eq",value:"有效",valueType:"string"},
    {id:"filter:amount:1",operator:"gt",value:"1000",valueType:"number"},
  ]);
  assert.match(buildIntentRetrievalQuestion(intent),/status/);
  assert.match(buildIntentRetrievalQuestion(intent),/order_amount/);
  assert.equal(intent.ambiguities.some((item)=>item.code.startsWith("FILTER_")),false);
});

test("unsupported multi-value and malformed filters block instead of shrinking the row domain",()=>{
  for(const question of ["本月创建的状态为有效或待跟进的线索数量","本月创建的状态在有效和待跟进中的线索数量","本月创建的金额大于很多的线索数量","本月创建的状态大于有效的线索数量"]) {
    const intent=parseQueryIntent(question,{now:new Date(2026,7,25)});
    assert.ok(intent.ambiguities.some((item)=>item.blocking&&item.code.startsWith("FILTER_")),question);
  }
  const clarified=applyIntentClarification(parseQueryIntent("本月创建的状态为有效或待跟进的线索数量",{now:new Date(2026,7,25)}),"只筛选状态为有效");
  assert.deepEqual(clarified.filters.filter((item)=>item.kind==="attribute").map((item)=>[item.field,item.operator,item.value]),[["status","eq","有效"]]);
  assert.equal(clarified.ambiguities.some((item)=>item.code.startsWith("FILTER_")),false);
});

test("filter negation survives punctuation normalization and contextual filters merge by field",()=>{
  const negated=parseQueryIntent("本月创建的状态!=无效的线索数量",{now:new Date(2026,7,25)});
  assert.deepEqual(negated.filters.map((item)=>[item.field,item.operator,item.value]),[["status","neq","无效"]]);

  const prior=parseQueryIntent("北京大成律所本月创建的状态为有效的线索数量",{now:new Date(2026,7,25)});
  const followUp=parseQueryIntent("那金额大于1000的线索数量",{now:new Date(2026,7,25)});
  const merged=mergeContextualQueryIntent(followUp,prior);
  assert.deepEqual(merged.entities.map((item)=>item.text),["北京大成"]);
  assert.deepEqual(merged.filters.map((item)=>[item.field,item.operator,item.value]),[
    ["organization_name","contains","北京大成"],
    ["status","eq","有效"],
    ["amount","gt","1000"],
  ]);

  const replacement=mergeContextualQueryIntent(parseQueryIntent("那状态为无效的线索数量"),prior);
  assert.deepEqual(replacement.filters.filter((item)=>item.field==="status").map((item)=>item.value),["无效"]);
});

test("additive follow-ups conjoin prior verified terms while replacement follow-ups switch the term",()=>{
  const columns={customer:[
    {columnName:"cert_status",dataType:"int"},{columnName:"deleted_at",dataType:"datetime"},
    {columnName:"is_test",dataType:"int"},{columnName:"segment",dataType:"varchar"},
  ]};
  const rowDomainConcepts=knowledgeIntentRowDomains([
    {pageType:"term",slug:"effective",title:"有效客户",aliases:["有效客户"],tables:["customer"],verified:true,sqlContent:"cert_status = 1 AND deleted_at IS NULL AND is_test = 0"},
    {pageType:"term",slug:"vip",title:"VIP 客户",aliases:["VIP客户"],tables:["customer"],verified:true,sqlContent:"segment = 'vip'"},
  ],columns);
  const options={rowDomainConcepts};
  const prior=parseQueryIntent("有效客户数量",options);

  for(const question of ["再加上VIP客户","并且是VIP客户","同时满足VIP客户","还要VIP客户","也要VIP客户"]) {
    const merged=mergeContextualQueryIntent(parseQueryIntent(question,options),prior);
    assert.deepEqual(merged.filters.map((item)=>[item.field,item.value]),[
      ["cert_status","1"],["deleted_at",null],["is_test","0"],["segment","vip"],
    ],question);
    assert.equal(merged.ambiguities.some((item)=>item.blocking),false,question);
  }

  for(const question of ["那VIP客户呢","改查VIP客户"]) {
    const merged=mergeContextualQueryIntent(parseQueryIntent(question,options),prior);
    assert.deepEqual(merged.filters.map((item)=>[item.field,item.value]),[["segment","vip"]],question);
  }
});

test("Chinese knowledge assets keep distinct stable IDs and group every predicate by asset",()=>{
  const columns={customer:[
    {columnName:"cert_status",dataType:"int"},{columnName:"deleted_at",dataType:"datetime"},
    {columnName:"is_test",dataType:"int"},{columnName:"segment",dataType:"varchar"},
  ]};
  const pages=[
    {pageType:"term",slug:"有效客户",title:"有效客户",aliases:[],tables:["customer"],verified:true,checksum:"effective-v1",sqlContent:"cert_status = 1 AND deleted_at IS NULL AND is_test = 0"},
    {pageType:"term",slug:"重点客户",title:"重点客户",aliases:[],tables:["customer"],verified:true,checksum:"priority-v1",sqlContent:"segment = 'priority'"},
  ];
  const first=knowledgeIntentRowDomains(pages,columns);
  const second=knowledgeIntentRowDomains(structuredClone(pages),columns);
  const assetIds=first.map((item)=>item.evidence.assetId);
  assert.equal(new Set(assetIds).size,2);
  assert.deepEqual(second.map((item)=>item.evidence.assetId),assetIds);
  for(const concept of first) {
    assert.ok(concept.filters.length>0);
    assert.equal(new Set(concept.filters.map((item)=>item.provenance.assetId)).size,1);
    assert.equal(concept.filters.every((item)=>item.id.startsWith(`filter:knowledge:${concept.evidence.assetId}:`)),true);
    assert.deepEqual(second.find((item)=>item.evidence.assetId===concept.evidence.assetId).filters.map((item)=>item.id),concept.filters.map((item)=>item.id));
  }
});

test("additive range filters retain both bounds and contradictory bounds block",()=>{
  const options={filterConcepts:[{fieldId:"age",value:"age",aliases:["年龄"],terms:["年龄"],physicalColumns:["customer.age"],numeric:true}]};
  const prior=parseQueryIntent("年龄大于等于18的客户数量",options);
  const additive=mergeContextualQueryIntent(parseQueryIntent("再加上年龄小于60",options),prior);
  assert.deepEqual(additive.filters.map((item)=>[item.operator,item.value]),[["gte","18"],["lt","60"]]);
  assert.equal(additive.ambiguities.some((item)=>item.code==="FILTER_CONTRACT_CONFLICT"),false);

  const contradictory=mergeContextualQueryIntent(parseQueryIntent("再加上年龄小于18",options),prior);
  assert.deepEqual(contradictory.filters.map((item)=>[item.operator,item.value]),[["gte","18"],["lt","18"]]);
  assert.ok(contradictory.ambiguities.some((item)=>item.blocking&&item.code==="FILTER_CONTRACT_CONFLICT"));

  const replacement=mergeContextualQueryIntent(parseQueryIntent("改为年龄小于60",options),prior);
  assert.deepEqual(replacement.filters.map((item)=>[item.operator,item.value]),[["lt","60"]]);

  const priorStatus=parseQueryIntent("状态为无效的线索数量");
  const selfContained=mergeContextualQueryIntent(parseQueryIntent("那状态为有效并且渠道为抖音的线索数量"),priorStatus);
  assert.deepEqual(selfContained.filters.map((item)=>[item.field,item.value]),[["status","有效"],["channel","抖音"]]);
  assert.equal(selfContained.ambiguities.some((item)=>item.code==="FILTER_CONTRACT_CONFLICT"),false);
});

test("copula questions are not frozen as filters while concrete copula values remain filters",()=>{
  for(const question of ["那现在是多少？","金额是多少","客户状态是什么","客户状态不是什么","那负责人是谁","产品是哪个","那现在是什么状态","客户是什么状态","现在不是谁负责"]) {
    const intent=parseQueryIntent(question);
    assert.deepEqual(intent.filters,[],question);
    assert.equal(intent.ambiguities.some((item)=>item.blocking&&item.code.startsWith("FILTER_")),false,question);
  }
  assert.deepEqual(parseQueryIntent("状态是有效的客户数量").filters.map((item)=>[item.field,item.operator,item.value]),[["status","eq","有效"]]);
  assert.deepEqual(parseQueryIntent("状态不是有效的客户数量").filters.map((item)=>[item.field,item.operator,item.value]),[["status","neq","有效"]]);
});

test("ranking dimension measure limit and comparison baseline clarifications close deterministically",()=>{
  const missingDimension=parseQueryIntent("本月线索成单排行",{now:new Date(2026,7,25)});
  const dimensionResolved=applyIntentClarification(missingDimension,"按销售排行");
  assert.deepEqual(dimensionResolved.dimensions.map((item)=>item.value),["seller"]);
  assert.equal(dimensionResolved.ambiguities.some((item)=>item.code==="RANKING_DIMENSION_UNKNOWN"),false);
  assert.ok(dimensionResolved.ambiguities.some((item)=>item.code==="DIMENSION_ATTRIBUTION_AMBIGUOUS"));

  const missingMeasure=parseQueryIntent("本月线索销售排行",{now:new Date(2026,7,25)});
  const measureResolved=applyIntentClarification(missingMeasure,"按线索成单数排行");
  assert.deepEqual(measureResolved.measures.map((item)=>item.value),["won"]);
  assert.equal(measureResolved.ambiguities.some((item)=>item.code==="RANKING_MEASURE_UNKNOWN"),false);

  const invalidLimit=parseQueryIntent("本月线索销售成单排行 Top 0",{now:new Date(2026,7,25)});
  const limitResolved=applyIntentClarification(invalidLimit,"改为 Top 20");
  assert.equal(limitResolved.shape.requestedLimit,20);
  assert.equal(limitResolved.ambiguities.some((item)=>item.code==="RANKING_LIMIT_INVALID"),false);

  const missingBaseline=parseQueryIntent("本月线索成单数对比",{now:new Date(2026,7,25)});
  const baselineResolved=applyIntentClarification(missingBaseline,"与上月对比");
  assert.deepEqual(baselineResolved.comparisonRange,{kind:"comparison_period_over_period",sourceText:"环比基准期",start:"2026-07-01",endExclusive:"2026-08-01"});
  assert.equal(baselineResolved.ambiguities.some((item)=>item.code==="COMPARISON_BASELINE_UNKNOWN"),false);
});

test("contextual follow-up inherits the prior business measure instead of treating bare 多少 as row count",()=>{
  const prior=parseQueryIntent("查询收入");
  const current=parseQueryIntent("那现在是多少？");
  assert.deepEqual(current.measures,[]);
  const merged=mergeContextualQueryIntent(current,prior);
  assert.deepEqual(merged.subjects,["revenue"]);
  assert.deepEqual(merged.measures.map((item)=>[item.value,item.aggregation]),[["revenue","sum"]]);
  assert.equal(merged.ambiguities.some((item)=>item.code==="MEASURE_GRAIN_AMBIGUOUS"),false);
});

test("trend uses a dedicated event-time bucket instead of inventing a business dimension",()=>{
  const intent=parseQueryIntent("本月线索成单数按日趋势",{now:new Date(2026,7,25)});
  assert.equal(intent.shape.kind,"trend");
  assert.equal(intent.shape.timeGrain,"day");
  assert.deepEqual(intent.dimensions,[]);
  assert.equal(intent.timeRole.value,"completion");
  const time=intent.requirements.find((item)=>item.kind==="time");
  assert.equal(time.role,"completion");
  assert.equal(time.grain,"day");
  assert.deepEqual(time.range,{start:"2026-08-01",endExclusive:"2026-09-01"});
});

test("verified metric knowledge becomes an executable ratio definition instead of a name hint",()=>{
  const pages=[{pageType:"metric",slug:"lead-conversion",title:"线索转化率",aliases:["转化率"],tables:["lead_entity","deal_event"],content:"按唯一线索去重。",sqlContent:"COUNT(DISTINCT deal_event.lead_id) / COUNT(DISTINCT lead_entity.id)",verified:true}];
  const columns={lead_entity:[{columnName:"id"}],deal_event:[{columnName:"lead_id"}]};
  const concepts=knowledgeIntentConcepts(pages,columns);
  const intent=parseQueryIntent("线索转化率",{concepts});
  assert.equal(intent.measures.length,1);
  assert.equal(intent.measures[0].aggregation,"ratio");
  assert.equal(intent.measures[0].evidence.level,"verified_knowledge");
  assert.deepEqual([...intent.measures[0].metricDefinition.columns].sort(),["deal_event.lead_id","lead_entity.id"]);
  assert.equal(intent.requirements.find((item)=>item.kind==="measure").metricDefinition.source,"metric:lead-conversion");
});

test("rate wording fails closed without a verified definition and never degrades to won count",()=>{
  for(const question of ["本月线索成单率","本月客户复购率","账号激活率"]) {
    const intent=parseQueryIntent(question,{now:new Date(2026,7,25)});
    assert.equal(intent.measures.length,1,question);
    assert.equal(intent.measures[0].aggregation,"ratio",question);
    assert.ok(intent.ambiguities.some((item)=>item.code==="MEASURE_DEFINITION_REQUIRED"&&item.blocking),question);
  }
});

test("verified metric definitions bind to their matching measure and duplicate aliases block",()=>{
  const columns={lead_entity:[{columnName:"id"}],deal_event:[{columnName:"lead_id"}],sales_order:[{columnName:"revenue"}]};
  const conversion={pageType:"metric",slug:"lead-conversion",title:"线索转化率",aliases:["转化率"],tables:["lead_entity","deal_event"],content:"按唯一线索去重。",sqlContent:"COUNT(DISTINCT deal_event.lead_id) / COUNT(DISTINCT lead_entity.id)",verified:true};
  const intent=parseQueryIntent("收入和线索转化率",{concepts:knowledgeIntentConcepts([conversion],columns)});
  assert.deepEqual(intent.measures.map((item)=>item.aggregation),["sum","ratio"]);
  assert.equal(intent.measures[0].metricDefinition,undefined);
  assert.equal(intent.measures[1].metricDefinition.source,"metric:lead-conversion");

  const duplicate={...conversion,slug:"qualified-conversion",title:"认证转化率",aliases:["转化率"]};
  const ambiguous=parseQueryIntent("线索转化率",{concepts:knowledgeIntentConcepts([conversion,duplicate],columns)});
  assert.ok(ambiguous.ambiguities.some((item)=>item.code==="METRIC_AMBIGUOUS"&&item.blocking));
  assert.equal(ambiguous.measures[0].metricDefinition,null);
});

test("metric CASE expressions do not become legal-case grain",()=>{
  const pages=[{pageType:"metric",slug:"repeat-rate",title:"复购率",aliases:[],tables:["customer_fact"],content:"复购客户占比",sqlContent:"COUNT(DISTINCT CASE WHEN order_count >= 2 THEN customer_id END) / COUNT(DISTINCT customer_id)",verified:true}];
  const concepts=knowledgeIntentConcepts(pages,{customer_fact:[{columnName:"order_count"},{columnName:"customer_id"}]});
  assert.equal(concepts[0].grain,"customer");
});

test("verified metric predicates bind each literal to one physical field",()=>{
  const pages=[{pageType:"metric",slug:"won-rate",title:"成单率",aliases:[],tables:["lead_entity"],content:"有效线索中的成单线索占比。",sqlContent:"COUNT(DISTINCT CASE WHEN lead_entity.is_won = 1 AND lead_entity.is_deleted = 0 THEN lead_entity.id END) / COUNT(DISTINCT CASE WHEN lead_entity.is_deleted = 0 THEN lead_entity.id END)",verified:true}];
  const concepts=knowledgeIntentConcepts(pages,{lead_entity:[{columnName:"id"},{columnName:"is_won"},{columnName:"is_deleted"}]});
  const formula=concepts[0].metricDefinition.formula;
  assert.equal(formula.numerator.predicateBinding,"physical");
  assert.deepEqual(formula.numerator.predicates,[
    {column:"lead_entity.is_deleted",operator:"=",valueType:"number",value:"0"},
    {column:"lead_entity.is_won",operator:"=",valueType:"number",value:"1"},
  ]);
  assert.deepEqual(formula.denominator.predicates,[{column:"lead_entity.is_deleted",operator:"=",valueType:"number",value:"0"}]);
  const unsupported=knowledgeIntentConcepts([{...pages[0],sqlContent:pages[0].sqlContent.replace(" AND "," OR ")}],{lead_entity:[{columnName:"id"},{columnName:"is_won"},{columnName:"is_deleted"}]})[0];
  assert.equal(unsupported.metricDefinition.formula.numerator.predicateBinding,"unsupported");
});

test("trend requires an explicit bucket and can resolve time role without a date range",()=>{
  const unknown=parseQueryIntent("线索数量趋势");
  assert.ok(unknown.ambiguities.some((item)=>item.code==="TIME_GRAIN_UNKNOWN"));
  assert.ok(unknown.ambiguities.some((item)=>item.code==="TIME_ROLE_UNKNOWN"));
  const resolved=applyIntentClarification(unknown,"按进线时间、按月统计");
  assert.equal(resolved.shape.timeGrain,"month");
  assert.equal(resolved.timeRole.value,"entry");
  assert.equal(resolved.ambiguities.some((item)=>item.code==="TIME_GRAIN_UNKNOWN"||item.code==="TIME_ROLE_UNKNOWN"),false);
});

test("同比 intent carries an explicit baseline window instead of degrading to one period",()=>{
  const intent=parseQueryIntent("本月线索成单数同比",{now:new Date(2026,7,25)});
  assert.equal(intent.shape.kind,"comparison");
  assert.equal(intent.shape.comparisonMode,"year_over_year");
  assert.deepEqual(intent.comparisonRange,{kind:"comparison_year_over_year",sourceText:"同比基准期",start:"2025-08-01",endExclusive:"2025-09-01"});
  assert.deepEqual(intent.requirements.filter((item)=>item.kind==="time").map((item)=>item.range),[
    {start:"2026-08-01",endExclusive:"2026-09-01"},
    {start:"2025-08-01",endExclusive:"2025-09-01"},
  ]);

  const followUp=parseQueryIntent("那本周呢",{now:new Date("2026-08-26T00:00:00.000Z"),timeZone:"Asia/Shanghai"});
  const merged=mergeContextualQueryIntent(followUp,intent);
  assert.deepEqual(merged.timeRange,{kind:"current_week",sourceText:"本周",start:"2026-08-24",endExclusive:"2026-08-31"});
  assert.deepEqual(merged.comparisonRange,{kind:"comparison_year_over_year",sourceText:"同比基准期",start:"2025-08-24",endExclusive:"2025-08-31"});
  assert.equal(merged.ambiguities.some((item)=>item.code==="COMPARISON_BASELINE_UNKNOWN"),false);
});

// T6: an operator-less “抖音渠道” is provable when 抖音 is a registered member of
// that field's dictionary. Before this, the parser never recognized the phrasing
// and the filter never reached the binding layer that resolves 抖音 to its code.
const CHANNEL_TABLES=[{tableName:"clue",comment:"线索表"}];
const CHANNEL_COLUMNS={clue:[
  {columnName:"id",dataType:"bigint",isPrimary:1},
  {columnName:"source_data_channel",dataType:"tinyint",comment:"数据来源"},
  {columnName:"owner_cell",dataType:"varchar",comment:"负责人手机号",isSensitive:1},
]};
const CHANNEL_ENUMS={"clue.source_data_channel":[
  {value:"0",meaning:"百度",meaningSource:"human"},
  {value:"2",meaning:"抖音",meaningSource:"human"},
  {value:"3",meaning:null,meaningSource:null},
]};

function channelConcepts(enums=CHANNEL_ENUMS) {
  return catalogFilterConcepts(CHANNEL_TABLES,CHANNEL_COLUMNS,null,[],enums);
}

test("a confirmed enum meaning becomes parser vocabulary, and only a confirmed one",()=>{
  const concept=channelConcepts().find((item)=>item.aliases[0]==="数据来源");
  assert.deepEqual(concept.memberValues,["抖音","百度"],"未确认含义的取值 3 不得进入词表");

  // 2026-09-04 敏感列逻辑已移除：isSensitive 恒为 false，之前被标记为
  // 敏感的列（负责人手机号）现在正常参与词表构建，其原始文本取值直接
  // 成为可解析的词面（数字型取值仍需确认含义才会进入词表，规则不变）。
  const formerlySensitive=channelConcepts({"clue.owner_cell":[{value:"老王的客户",meaning:null,meaningSource:null}]}).find((item)=>item.aliases[0]==="负责人手机号");
  assert.deepEqual(formerlySensitive.memberValues,["老王的客户"],"敏感标记移除后原始文本取值可进入解析词表");
});

test("an operator-less member value parses into a declared filter instead of a rejection",()=>{
  const filterConcepts=channelConcepts();
  const intent=parseQueryIntent("本月抖音数据来源的线索数量",{now:new Date(2026,7,25),filterConcepts});
  assert.deepEqual(intent.filters.map((item)=>[item.operator,item.value]),[["eq","抖音"]]);
  assert.deepEqual(intent.filters[0].physicalColumns,["clue.source_data_channel"]);
  assert.equal(intent.ambiguities.some((item)=>String(item.code).startsWith("FILTER_")),false,"闭集内可证的筛选不得再产生筛选类歧义");

  // Field-first phrasing is the same proof.
  assert.deepEqual(parseQueryIntent("数据来源抖音的线索数量",{filterConcepts}).filters.map((item)=>item.value),["抖音"]);

  // The production shape: “渠道” is a static field concept with no dictionary of
  // its own — membership licenses the adjacency, and the binding layer proves
  // (or fails closed on) the actual column pairing.
  const channel=parseQueryIntent("本月抖音渠道的线索数量",{now:new Date(2026,7,25),filterConcepts});
  assert.deepEqual(channel.filters.map((item)=>[item.field,item.operator,item.value]),[["channel","eq","抖音"]]);
});

test("a value outside the dictionary is still refused rather than guessed",()=>{
  const filterConcepts=channelConcepts();
  const intent=parseQueryIntent("本月快手数据来源的线索数量",{now:new Date(2026,7,25),filterConcepts});
  assert.deepEqual(intent.filters,[],"词表外的值不得被猜成等值筛选");

  // An explicit operator keeps its own normalization path and its own value.
  assert.deepEqual(parseQueryIntent("数据来源为抖音的线索数量",{filterConcepts}).filters.map((item)=>[item.operator,item.value]),[["eq","抖音"]]);
});
