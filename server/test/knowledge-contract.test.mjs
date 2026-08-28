import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { knowledgeIntentConcepts } from "../src/query-intent.mjs";
import { createStore } from "../src/store.mjs";

const RATIO_SQL="COUNT(DISTINCT CASE WHEN rel.is_deleted = 0 THEN rel.clue_id END) / COUNT(DISTINCT clue.id)";

async function fixture() {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-contract-"));
  const store=createStore(join(dir,"store.sqlite"));
  // The save-time semantic validator binds formula predicates against the catalog,
  // so the fixture must register the columns the reference SQL uses.
  for(const sid of [3]) {
    store.upsertTable({sourceId:sid,tableName:"clue",grade:"A",active:1});
    store.upsertTable({sourceId:sid,tableName:"rel",grade:"A",active:1});
    store.upsertColumn({sourceId:sid,tableName:"clue",columnName:"id",dataType:"bigint",isPrimary:1});
    store.upsertColumn({sourceId:sid,tableName:"clue",columnName:"clue_create_time",dataType:"datetime"});
    store.upsertColumn({sourceId:sid,tableName:"rel",columnName:"clue_id",dataType:"bigint"});
    store.upsertColumn({sourceId:sid,tableName:"rel",columnName:"is_deleted",dataType:"tinyint"});
  }
  return {store,service:createKnowledgeService({store,wikiDir:join(dir,"wiki")})};
}

function metricInput(overrides={}) {
  return {
    pageType:"metric",title:"成交率",aliases:["成交率"],tables:["clue","rel"],
    content:"分母是进线的唯一线索，分子是其中成单的唯一线索。",
    sqlContent:RATIO_SQL,verified:true,owner:"editor-a",
    ...overrides,
  };
}

test("a declared contract survives save, Markdown render and sync round-trip",async()=>{
  const {store,service}=await fixture();
  try {
    const saved=await service.save(3,metricInput({contract:{timeRole:"entry",periodColumn:"clue.clue_create_time",grain:"clue"}}));
    assert.deepEqual(saved.contract,{timeRole:"entry",periodColumn:"clue.clue_create_time",grain:"clue"});

    const markdown=await readFile(saved.filePath,"utf8");
    assert.match(markdown,/^contract: \{/m,"声明块必须写入 frontmatter，否则 Markdown 回读会丢失契约");

    // Editing the prose must not drop the contract on the way back in.
    await writeFile(saved.filePath,markdown.replace("分母是进线的唯一线索","分母是统计周期内进线的唯一线索"),"utf8");
    const synced=await service.sync(3);
    assert.equal(synced.imported,1);
    assert.deepEqual(store.getKnowledge(3,"metric",saved.slug).contract,{timeRole:"entry",periodColumn:"clue.clue_create_time",grain:"clue"});
  } finally { store.close(); }
});

test("a page saved without a contract stays contract-free",async()=>{
  const {store,service}=await fixture();
  try {
    const saved=await service.save(3,metricInput());
    assert.equal(saved.contract,undefined);
    assert.doesNotMatch(await readFile(saved.filePath,"utf8"),/^contract:/m);
  } finally { store.close(); }
});

test("a stored contract reaches the derivation layer as declared evidence",async()=>{
  const {store,service}=await fixture();
  try {
    await service.save(3,metricInput({contract:{timeRole:"entry",periodColumn:"clue.clue_create_time",grain:"clue"}}));
    const columns={clue:[{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"clue_create_time",dataType:"datetime"}],rel:[{columnName:"clue_id",dataType:"bigint"},{columnName:"is_deleted",dataType:"tinyint"}]};
    const concept=knowledgeIntentConcepts(store.listKnowledge(3),columns)[0];
    assert.equal(concept.timeRoleDerivation.status,"declared");
    assert.equal(concept.timeRole,"entry");
    assert.equal(concept.metricDefinition.periodColumn,"clue.clue_create_time");
    assert.equal(concept.grainDerivation.status,"declared");
  } finally { store.close(); }
});

test("a malformed contract is rejected at save rather than stored as a half-truth",async()=>{
  const {store,service}=await fixture();
  try {
    await assert.rejects(()=>service.save(3,metricInput({contract:{periodColumn:"clue_create_time"}})),/表名\.列名/);
    await assert.rejects(()=>service.save(3,metricInput({contract:["entry"]})),/contract 必须是对象/);
  } finally { store.close(); }
});

test("unknown contract keys are dropped instead of being trusted later",async()=>{
  const {store,service}=await fixture();
  try {
    const saved=await service.save(3,metricInput({contract:{timeRole:"entry",timeRoll:"completion"}}));
    assert.deepEqual(saved.contract,{timeRole:"entry"});
  } finally { store.close(); }
});
