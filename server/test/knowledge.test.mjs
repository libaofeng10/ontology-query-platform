import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { _internal as serverInternal } from "../src/server.mjs";
import { createStore } from "../src/store.mjs";

test("knowledge service persists validated term pages to SQLite and Markdown", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  const page=await service.save(7,{pageType:"term",title:"有效客户",aliases:["有效户"],tables:["crm_customer"],content:"已实名且未注销。",sqlContent:"cert_status = 1 AND deleted_at IS NULL",antiExamples:"不要用 status。",verified:true,owner:"业务负责人"});
  assert.equal(page.verified,true);
  assert.deepEqual(page.tables,["crm_customer"]);
  const markdown=await readFile(page.filePath,"utf8");
  assert.match(markdown,/type: term/);
  assert.match(markdown,/## SQL 片段/);
  assert.match(markdown,/## 反例/);
  await writeFile(page.filePath,markdown.replace("已实名且未注销。","已实名、未注销且排除测试账号。"),"utf8");
  const synced=await service.sync(7);assert.equal(synced.imported,1);assert.match(store.getKnowledge(7,"term",page.slug).content,/排除测试账号/);
  store.close();
});

test("verified knowledge requires an owner while prose definitions can be saved without SQL", async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  const prose=await service.save(1,{pageType:"term",title:"客户",content:"定义",sqlContent:"",verified:false});
  assert.equal(prose.content,"定义");
  assert.equal(prose.sqlContent,null);
  await assert.rejects(()=>service.save(1,{pageType:"term",title:"空知识",content:"",sqlContent:"",verified:false}),/请填写业务说明/);
  await assert.rejects(()=>service.save(1,{pageType:"rule",title:"规则",content:"定义",sqlContent:"x=1",verified:true}),/owner/);
  store.close();
});

test("write operations reject a missing or incorrect local token",()=>{
  const runtime={writeToken:"correct-token"};
  assert.throws(()=>serverInternal.requireWrite({headers:{}},runtime),/令牌/);
  assert.throws(()=>serverInternal.requireWrite({headers:{"x-ontoquery-token":"wrong"}},runtime),/令牌/);
  assert.doesNotThrow(()=>serverInternal.requireWrite({headers:{"x-ontoquery-token":"correct-token"}},runtime));
});

test("two relations between the same table pair produce distinct join pages",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"ontoquery-knowledge-"));
  const store=createStore(join(dir,"store.sqlite"));
  const service=createKnowledgeService({store,wikiDir:join(dir,"wiki")});
  store.upsertRelation({sourceId:3,fromTable:"sales_order",fromCol:"created_by",toTable:"sys_user",toCol:"user_id",cardinality:"N:1",confidence:1,overlapRatio:1,status:"confirmed",inferenceSource:"foreign_key"});
  store.upsertRelation({sourceId:3,fromTable:"sales_order",fromCol:"assigned_to",toTable:"sys_user",toCol:"user_id",cardinality:"N:1",confidence:1,overlapRatio:1,status:"confirmed",inferenceSource:"foreign_key"});
  const joins=service.list(3).filter((page)=>page.pageType==="join");
  assert.equal(joins.length,2);
  assert.notEqual(joins[0].slug,joins[1].slug);
  assert.ok(joins.some((page)=>page.sqlContent.includes("created_by")));
  assert.ok(joins.some((page)=>page.sqlContent.includes("assigned_to")));
  store.close();
});
