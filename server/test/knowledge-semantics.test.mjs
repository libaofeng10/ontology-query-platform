import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { validateKnowledgeSemantics } from "../src/knowledge-semantics.mjs";
import { createStore } from "../src/store.mjs";

const COLUMNS={
  clue:[{columnName:"id",dataType:"bigint",isPrimary:1},{columnName:"clue_create_time",dataType:"datetime"},{columnName:"is_win",dataType:"tinyint"}],
};

function metricPage(overrides={}) {
  return {
    pageType:"metric",slug:"rate",title:"成交率",aliases:["成交率"],tables:["clue"],
    content:"分母是统计周期内进线的唯一线索。统计周期固定绑定 clue.clue_create_time。",
    sqlContent:"COUNT(DISTINCT CASE WHEN clue.is_win = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)",
    verified:true,owner:"editor-a",
    ...overrides,
  };
}

test("a healthy metric page validates ok",()=>{
  const result=validateKnowledgeSemantics(metricPage(),{columnsByTable:COLUMNS});
  assert.equal(result.ok,true);
  assert.equal(result.semanticHealth,"ok");
  assert.deepEqual(result.warnings,[]);
});

test("an unparseable ratio formula is a hard error",()=>{
  const result=validateKnowledgeSemantics(metricPage({sqlContent:"COUNT(DISTINCT CASE WHEN clue.is_win = 1 OR clue.is_win = 2 THEN clue.id END) / COUNT(DISTINCT clue.id)"}),{columnsByTable:COLUMNS});
  assert.equal(result.ok,false);
  assert.equal(result.semanticHealth,"invalid");
  assert.ok(result.errors.some((item)=>item.code==="RATIO_PREDICATE_UNSUPPORTED"||item.code==="RATIO_FORMULA_UNPARSED"));
});

test("a ghost column reference is a hard error",()=>{
  const result=validateKnowledgeSemantics(metricPage({sqlContent:"COUNT(DISTINCT CASE WHEN clue.ghost_flag = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"}),{columnsByTable:COLUMNS});
  assert.equal(result.ok,false);
});

test("an undetermined time role is a soft warning, not a rejection",()=>{
  const result=validateKnowledgeSemantics(metricPage({content:"分母是进线的唯一线索，分子是其中成单的唯一线索。"}),{columnsByTable:COLUMNS});
  assert.equal(result.ok,true);
  assert.equal(result.semanticHealth,"degraded");
  const warning=result.warnings.find((item)=>item.code==="TIME_ROLE_UNDETERMINED");
  assert.ok(warning);
  assert.deepEqual(warning.candidates,["entry","completion"]);
  assert.match(warning.message,/contract\.periodColumn/);
});

test("non-metric pages pass through untouched",()=>{
  const result=validateKnowledgeSemantics({pageType:"term",title:"有效客户",sqlContent:"x=1"},{columnsByTable:{}});
  assert.equal(result.ok,true);
  assert.equal(result.semanticHealth,"ok");
});

async function serviceFixture() {
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-semantics-"));
  const store=createStore(join(dir,"store.sqlite"));
  store.upsertTable({sourceId:5,tableName:"clue",grade:"A",active:1});
  for(const column of COLUMNS.clue)store.upsertColumn({sourceId:5,tableName:"clue",...column});
  return {store,service:createKnowledgeService({store,wikiDir:join(dir,"wiki")})};
}

test("saving a broken verified metric page is refused with the validator's reason",async()=>{
  const {store,service}=await serviceFixture();
  try {
    await assert.rejects(
      ()=>service.save(5,metricPage({sqlContent:"COUNT(DISTINCT CASE WHEN clue.ghost = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"})),
      /语义校验/,
    );
    assert.equal(store.getKnowledge(5,"metric","rate"),null,"被拒的页面不得留下半成品");
  } finally { store.close(); }
});

test("a degraded page saves with semanticHealth recorded and warnings returned",async()=>{
  const {store,service}=await serviceFixture();
  try {
    const saved=await service.save(5,metricPage({content:"分母是进线的唯一线索，分子是其中成单的唯一线索。"}));
    assert.equal(saved.semanticHealth,"degraded");
    assert.ok(saved.semanticWarnings.some((item)=>item.code==="TIME_ROLE_UNDETERMINED"));
    assert.equal(store.getKnowledge(5,"metric","rate").semanticHealth,"degraded");
  } finally { store.close(); }
});

test("an unverified draft may save even with hard errors",async()=>{
  // Operators iterate on drafts; only the verified flag makes a page an authority.
  const {store,service}=await serviceFixture();
  try {
    const saved=await service.save(5,metricPage({verified:false,owner:null,sqlContent:"COUNT(DISTINCT CASE WHEN clue.ghost = 1 THEN clue.id END) / COUNT(DISTINCT clue.id)"}));
    assert.equal(saved.semanticHealth,"invalid");
  } finally { store.close(); }
});
