import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateEnumMeaningQuestions, parseCommentEnumCandidates } from "../src/enum-meaning-candidates.mjs";
import { createStore } from "../src/store.mjs";

test("comment mappings parse across the common separator styles and skip prose",()=>{
  assert.deepEqual(
    parseCommentEnumCandidates("数据来源 -1：未知 0：百度  1腾讯： 2：抖音 3：自有 4：巨量").map((item)=>item.value),
    ["-1","0","2","3","4"],
    "写反的 1腾讯： 不得被猜成映射",
  );
  assert.deepEqual(parseCommentEnumCandidates("是否删除 0-否 1-是"),[{value:"0",meaning:"否"},{value:"1",meaning:"是"}]);
  assert.deepEqual(parseCommentEnumCandidates("用户手机号"),[]);
  assert.deepEqual(parseCommentEnumCandidates("限额 5000:元"),[],"单个数字冒号不构成字典");
  assert.deepEqual(parseCommentEnumCandidates(""),[]);
});

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-enum-meaning-"));
  const store=createStore(join(dir,"store.sqlite"));
  store.upsertTable({sourceId:9,tableName:"clue",grade:"A",active:1});
  store.upsertColumn({sourceId:9,tableName:"clue",columnName:"source_data_channel",dataType:"tinyint",comment:"数据来源 -1：未知 0：百度 2：抖音"});
  store.upsertColumn({sourceId:9,tableName:"clue",columnName:"remark",dataType:"varchar",comment:"备注"});
  for(const value of ["-1","0","2"])store.upsertEnum({sourceId:9,tableName:"clue",columnName:"source_data_channel",value,count:10,ratio:0.3});
  return store;
}

test("questions are generated only for observed, meaning-less values and answers land as human meanings",async()=>{
  const store=await fixture();
  try {
    const first=generateEnumMeaningQuestions(store,9);
    assert.equal(first.created,3);
    const questions=store.listQuestions(9).filter((item)=>item.kind==="枚举含义");
    assert.equal(questions.length,3);
    const douyin=questions.find((item)=>String(item.enumValue)==="2");
    assert.match(douyin.question,/抖音/);
    assert.match(douyin.evidence,/不会用于查询取值绑定/);
    assert.deepEqual(douyin.options,["抖音","补充说明"]);

    // Re-running discovery must not double-ask.
    assert.equal(generateEnumMeaningQuestions(store,9).created,3,"addQuestion 以 (表,列,值) 去重，重复生成不新增行");
    assert.equal(store.listQuestions(9).filter((item)=>item.kind==="枚举含义").length,3);

    // A confirmed answer becomes the meaning the binding layer trusts.
    const result=store.answerEnumQuestion(douyin.id,"抖音","editor-a");
    assert.equal(result.ok,true);
    const row=store.listEnums(9,"clue").find((item)=>item.columnName==="source_data_channel"&&String(item.value)==="2");
    assert.equal(row.meaning,"抖音");
    assert.equal(row.meaningSource,"human");

    // listQuestions only returns pending rows, so the answered one drops out and
    // regeneration must not resurrect it (its value now has a meaning).
    assert.equal(store.listQuestions(9).filter((item)=>item.kind==="枚举含义").length,2);
    generateEnumMeaningQuestions(store,9);
    assert.equal(store.listQuestions(9).filter((item)=>item.kind==="枚举含义").length,2);
  } finally { store.close(); }
});

test("values named by the comment but absent from the dictionary are not asked about",async()=>{
  // The comment maps value 9 but the probe never observed it; asking would demand
  // a confirmation about data that may not exist.
  const store=await fixture();
  try {
    store.upsertColumn({sourceId:9,tableName:"clue",columnName:"source_data_channel",dataType:"tinyint",comment:"数据来源 0：百度 9：神秘渠道"});
    const {created}=generateEnumMeaningQuestions(store,9);
    const questions=store.listQuestions(9).filter((item)=>item.kind==="枚举含义");
    assert.equal(questions.some((item)=>String(item.enumValue)==="9"),false);
    assert.equal(created,questions.length);
  } finally { store.close(); }
});
