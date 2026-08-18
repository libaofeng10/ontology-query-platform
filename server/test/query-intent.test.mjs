import assert from "node:assert/strict";
import test from "node:test";
import { buildIntentRetrievalQuestion, parseQueryIntent, queryIntentSqlErrors } from "../src/query-intent.mjs";

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
