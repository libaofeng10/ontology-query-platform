import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createStore } from "../src/store.mjs";
import { createKnowledgeService } from "../src/knowledge-service.mjs";
import { createClaudeQuerySnapshot } from "../src/claude-query-snapshot.mjs";
import { createCapabilityGapService } from "../src/capability-gap-service.mjs";
import { createApp } from "../src/server.mjs";

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-business-"));const store=createStore(join(root,"platform.sqlite"));
  t.after(async()=>{store.close();await rm(root,{recursive:true,force:true});});
  const source=store.createSource({name:"business",kind:"mysql",host:"db",port:3306,dbName:"business",userName:"ro",credential:"unused",isDemo:false});
  for(const tableName of ["customer","orders"]) {
    store.upsertTable({sourceId:source.id,tableName,grade:"A",active:1,comment:tableName});
    store.upsertColumn({sourceId:source.id,tableName,columnName:"id",dataType:"bigint",isPrimary:1});
  }
  const service=createKnowledgeService({store,wikiDir:join(root,"wiki")});
  return {root,store,source,service};
}

test("prose term, metric and rule survive Markdown sync and are readable by Claude; drafts stay out",async t=>{
  const {store,source,service}=await fixture(t);
  for(const pageType of ["term","metric","rule"]) {
    const page=await service.save(source.id,{pageType,title:`业务${pageType}`,content:"按自然月统计发生过实际使用行为的客户，排除内部测试账号。",verified:true,owner:"editor",tables:["customer"]});
    assert.equal(page.sqlContent,null);assert.equal(page.semanticHealth,"ok");
    const md=await readFile(page.filePath,"utf8");
    await writeFile(page.filePath,md.replace("内部测试账号","内部演示账号"));
  }
  await service.save(source.id,{pageType:"term",title:"暂未核实的定义",content:"草稿内容",verified:false});
  const synced=await service.sync(source.id);
  assert.equal(synced.imported,3);assert.deepEqual(synced.errors,[]);
  const snapshot=createClaudeQuerySnapshot({sourceId:source.id,store,published:{status:"published",schema:{objectTypes:[],linkTypes:[]}}});
  const result=snapshot.read({operation:"get_knowledge"});
  assert.equal(result.total,3);assert.ok(result.items.every(page=>page.content.includes("内部演示账号")));
  assert.ok(result.items.every(page=>page.title!=="暂未核实的定义"));
});

test("business listing separates authored definitions from catalog tables, joins and canonical rules",async t=>{
  const {store,source,service}=await fixture(t);
  store.upsertRelation({sourceId:source.id,fromTable:"orders",fromCol:"id",toTable:"customer",toCol:"id",status:"confirmed"});
  store.addRule({sourceId:source.id,name:"金额单位",content:"以分存储",appliesTo:"orders",verified:1});
  await service.save(source.id,{pageType:"term",title:"活跃客户",content:"当月有订单",verified:true,owner:"editor"});
  const business=service.listBusiness(source.id);
  assert.equal(business.length,2);
  assert.ok(business.every(page=>["term","metric","rule"].includes(page.pageType)));
  const rule=business.find(page=>page.origin==="catalog");assert.equal(rule.readOnly,true);assert.equal(rule.content,"以分存储");
  assert.equal(service.list(source.id).filter(page=>page.pageType==="table").length,2,"legacy catalog readers retain their source metadata");
  assert.equal(store.listKnowledge(source.id).length,1,"listing never materializes generated catalog rows as editable knowledge");
  await assert.rejects(()=>service.save(source.id,{pageType:"rule",slug:rule.slug,title:rule.title,content:"按元存储",verified:true,owner:"editor"}),/数据源与本体/);
});

test("neither the editor nor Markdown import can shadow canonical JOIN confirmation",async t=>{
  const {store,source,service}=await fixture(t);
  const relation=store.upsertRelation({sourceId:source.id,fromTable:"orders",fromCol:"id",toTable:"customer",toCol:"id",status:"review"});
  const slug="orders-id-customer-id";
  await assert.rejects(()=>service.save(source.id,{pageType:"join",slug,title:"客户关系",sqlContent:"orders.id = customer.id",verified:true,owner:"editor"}),/避免生成两份定义/);
  const directory=join(service.rootFor(source.id),"joins");await mkdir(directory,{recursive:true});
  await writeFile(join(directory,`${slug}.md`),"---\ntype: join\nowner: editor\nverified: true\n---\n\n# 客户关系\n\n## SQL 片段\n```sql\norders.id = customer.id\n```\n");
  const result=await service.sync(source.id);assert.equal(result.imported,0);assert.equal(result.errors.length,1);
  assert.equal(store.listKnowledge(source.id).length,0);
  assert.equal(store.listRelations(source.id,false,true).find(row=>row.id===relation.id).status,"review");
});

test("knowledge API supplies the authenticated owner and returns only the business collection",async t=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-business-api-"));
  const app=createApp({dbPath:join(root,"platform.sqlite"),wikiDir:join(root,"wiki"),appSecret:"test-secret",nodeEnv:"test",connector:{close:async()=>{}},apiIdentities:[{name:"editor-a",role:"editor",token:"editor-test",sourceIds:"*"},{name:"reader",role:"viewer",token:"reader-test",sourceIds:"*"}],rateLimits:{readPerMinute:100,writePerMinute:100,queryPerMinute:100}});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const source=app.store.createSource({name:"business-api",kind:"mysql",host:"db",port:3306,dbName:"business",userName:"ro",credential:"unused",isDemo:false});
  app.store.upsertTable({sourceId:source.id,tableName:"customer",grade:"A",active:1});
  async function request(method,path,body,token="editor-test") {
    const req=Readable.from(body?[JSON.stringify(body)]:[]);req.method=method;req.url=path;req.headers={authorization:`Bearer ${token}`,"content-type":"application/json"};req.socket={remoteAddress:"127.0.0.1"};
    let text="";const res={statusCode:200,setHeader(){},end(value){text=String(value||"");}};
    await app.handler(req,res);return {status:res.statusCode,body:JSON.parse(text)};
  }
  const input={sourceId:source.id,pageType:"metric",title:"活跃率",content:"当月实际使用客户数占当月可用账号客户数的比例。",verified:true,owner:"forged-owner"};
  const saved=await request("POST","/api/knowledge",input);assert.equal(saved.status,201);assert.equal(saved.body.owner,"editor-a");
  assert.equal((await request("POST","/api/knowledge",input,"reader-test")).status,403);
  const list=await request("GET",`/api/knowledge?sourceId=${source.id}`);assert.equal(list.body.length,1);assert.equal(list.body[0].pageType,"metric");
  const bootstrap=await request("GET",`/api/bootstrap?sourceId=${source.id}`);assert.equal(bootstrap.status,200);assert.equal(bootstrap.body.knowledge.length,1);assert.ok(bootstrap.body.graph.nodes.some(node=>node.kind==="table"));
});

test("legacy failures become history in Claude mode; runtime incidents never become knowledge tasks",async t=>{
  const {store,source}=await fixture(t);
  store.addAudit({sourceId:source.id,question:"旧问题",planningMode:"agent",verdict:"refused",failureClass:"schema_gap",intentJson:JSON.stringify({ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",sourceText:"成交率",blocking:true}]})});
  store.addAudit({sourceId:source.id,question:"连接失败问题",planningMode:"claude",verdict:"failed",failureClass:"execution_error",failReason:"连接超时"});
  const service=createCapabilityGapService({store,currentPlanningMode:()=>"claude"});
  assert.deepEqual(service.listGaps(source.id,{scope:"knowledge"}).gaps,[]);
  const all=service.listGaps(source.id);assert.equal(all.gaps.length,2);
  assert.equal(all.gaps.find(gap=>gap.code==="MEASURE_DEFINITION_REQUIRED").status,"historical");
  assert.equal(all.gaps.find(gap=>gap.code==="CLASS:execution_error").category,"operation");
  assert.equal(store.listAudits(source.id).length,2,"history remains intact");
});

test("later success records replay evidence without approving a business definition or hiding a new failure",async t=>{
  const {store,source}=await fixture(t);
  const error={sourceId:source.id,question:"活跃客户数量",planningMode:"claude",verdict:"failed",failureClass:"execution_error",failReason:"连接超时"};
  store.addAudit(error);store.addAudit({sourceId:source.id,question:error.question,planningMode:"claude",verdict:"passed"});
  const service=createCapabilityGapService({store,currentPlanningMode:()=>"claude"});
  let gap=service.listGaps(source.id).gaps[0];assert.equal(gap.status,"replayed");assert.equal(gap.replayedCount,1);
  store.addAudit({...error,verdict:"refused",failureClass:"schema_gap",intentJson:JSON.stringify({ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",sourceText:"活跃率",blocking:true}]})});
  store.addAudit({sourceId:source.id,question:error.question,planningMode:"claude",verdict:"passed"});
  const business=service.listGaps(source.id,{scope:"knowledge"}).gaps[0];assert.equal(business.status,"open","running SQL cannot approve a reusable definition");
  store.addAudit(error);gap=service.listGaps(source.id).gaps.find(gap=>gap.code==="CLASS:execution_error");assert.equal(gap.status,"open");
  store.addAudit({sourceId:source.id,question:error.question,planningMode:"legacy",verdict:"passed"});
  assert.equal(service.listGaps(source.id).gaps.find(gap=>gap.code==="CLASS:execution_error").status,"open","a different execution mode cannot retire a current Claude failure");
  assert.equal(store.listKnowledge(source.id).length,0);
});

test("a prose metric can resolve a current Claude definition request after explicit activation",async t=>{
  const {store,source,service}=await fixture(t);
  store.addAudit({sourceId:source.id,question:"查询活跃率",planningMode:"claude",verdict:"refused",intentJson:JSON.stringify({ambiguities:[{code:"MEASURE_DEFINITION_REQUIRED",sourceText:"活跃率",blocking:true}]})});
  const gaps=createCapabilityGapService({store,currentPlanningMode:()=>"claude"});
  const page={pageType:"metric",title:"活跃率",content:"当月实际使用客户数除以当月可用账号客户数。"};
  await service.save(source.id,{...page,verified:false});assert.equal(gaps.listGaps(source.id,{scope:"knowledge"}).gaps[0].status,"open");
  await service.save(source.id,{...page,verified:true,owner:"editor"});assert.equal(gaps.listGaps(source.id,{scope:"knowledge"}).gaps[0].status,"resolved");
});
