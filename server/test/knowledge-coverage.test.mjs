import assert from "node:assert/strict";
import test from "node:test";
import { coverageByType, missingAssetLines } from "../../app/knowledge-coverage.mjs";

test("coverageByType classifies mixed page types and never merges them into one number",()=>{
  const pages=[
    {pageType:"join",verified:true},{pageType:"join",verified:true},{pageType:"join",verified:false},
    {pageType:"term",verified:true},{pageType:"metric",verified:false},{pageType:"rule",verified:true},
    {pageType:"table",verified:false},{pageType:"unknown",verified:true},
  ];
  const coverage=coverageByType(pages);
  assert.deepEqual(coverage.join,{total:3,verified:2});
  assert.deepEqual(coverage.term,{total:1,verified:1});
  assert.deepEqual(coverage.metric,{total:1,verified:0});
  assert.deepEqual(coverage.rule,{total:1,verified:1});
  assert.deepEqual(coverage.table,{total:1,verified:0});
  assert.deepEqual(coverageByType(undefined).metric,{total:0,verified:0});
});

test("missingAssetLines tolerates absent or malformed missingAssets",()=>{
  assert.deepEqual(missingAssetLines(undefined),[]);
  assert.deepEqual(missingAssetLines(null),[]);
  assert.deepEqual(missingAssetLines("oops"),[]);
  assert.deepEqual(missingAssetLines([null,{},{kind:"metric"},{kind:"metric",label:"  "}]),[]);
  const lines=missingAssetLines([{kind:"metric",label:"成交率"},{kind:"unknown_kind",label:"神秘口径"}]);
  assert.equal(lines[0].text,"缺少『成交率』的指标定义");
  assert.equal(lines[1].text,"缺少『神秘口径』的业务定义");
});
