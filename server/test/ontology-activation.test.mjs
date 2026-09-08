import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import test from 'node:test';
import {createApp} from '../src/server.mjs';
import {createSemanticSchemaService} from '../src/semantic-schema-service.mjs';
import {createOntologyActivationService} from '../src/ontology-activation-service.mjs';
import {createSourceOntologyBuildService} from '../src/source-ontology-build-service.mjs';
import {createTaskService} from '../src/task-service.mjs';
import {evalSetChecksum} from '../src/evaluation-evidence.mjs';

async function fixture(t,{owner=true,transform=schema=>schema}={}) {
  const root=await mkdtemp(join(tmpdir(),'ontoquery-activation-'));
  let modelCalls=0;
  const app=createApp({dbPath:join(root,'store.sqlite'),wikiDir:join(root,'wiki'),appSecret:'activation-test-secret',nodeEnv:'test',claudeBridge:null,
    llm:{baseUrl:'',apiKey:'',model:''},embedding:{enabled:false},profiling:{enabled:false},ontologyAi:{mode:'auto_draft',auditDir:join(root,'audit')},
    ontologyCandidateVerifier:false,ontologyCandidateGenerator:{generateObjects:async()=>{modelCalls++;throw Error('activation must reuse its draft');}},
    apiIdentities:[{name:'viewer',role:'viewer',token:'viewer',sourceIds:[2]},{name:'outsider',role:'editor',token:'outsider',sourceIds:[1]},{name:'editor',role:'editor',token:'editor',sourceIds:'*'}],
    connector:{close:async()=>{},query:async()=>[[],[]],explain:async()=>[]},rateLimits:{queryPerMinute:100,readPerMinute:1000,writePerMinute:1000}});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  const {store}=app,source=store.createSource({name:'activation',kind:'mysql',host:'db',port:3306,dbName:'activation',userName:'ro',credential:'encrypted',isDemo:true});
  for(const table of ['customers','orders'])store.upsertTable({sourceId:source.id,tableName:table,rowEstimate:10,grade:'A',active:1,comment:table});
  for(const [table,column,primary,dataType] of [['customers','id',1,'bigint'],['customers','nickname',0,'varchar'],['orders','id',1,'bigint'],['orders','customer_id',0,'bigint']])store.upsertColumn({sourceId:source.id,tableName:table,columnName:column,dataType,isPrimary:primary,isUnique:primary,nullable:!primary?1:0,comment:column});
  store.upsertRelation({sourceId:source.id,fromTable:'orders',fromCol:'customer_id',toTable:'customers',toCol:'id',cardinality:'N:1',confidence:1,status:'confirmed',inferenceSource:'foreign_key'});
  const relation=store.listRelations(source.id,true)[0];
  const schema={name:'commerce',displayName:'客户订单',description:'测试本体',objectTypes:[
    {apiName:'customer',displayName:'客户档案',primaryKey:'id',properties:[{apiName:'id',displayName:'客户编号',type:'integer',required:true,mapping:{table:'customers',column:'id'}},{apiName:'nickname',displayName:'客户昵称',description:'客户可选昵称',type:'string',required:false,mapping:{table:'customers',column:'nickname'}}]},
    {apiName:'order',displayName:'订单',primaryKey:'id',properties:[{apiName:'id',displayName:'订单编号',type:'integer',required:true,mapping:{table:'orders',column:'id'}},{apiName:'customer_id',displayName:'客户编号',type:'integer',required:false,mapping:{table:'orders',column:'customer_id'}}]}
  ],linkTypes:[]};
  const schemas=createSemanticSchemaService({store}),saved=schemas.saveDraft(source.id,schema,'fixture');
  assert.equal(schemas.publish(saved.id,'fixture').ok,true);
  const base=store.getPublishedOntologySchema(source.id),next=structuredClone(base.schema);
  next.objectTypes[0].properties=next.objectTypes[0].properties.filter(item=>item.apiName!=='nickname');
  next.linkTypes.push({apiName:'customer_orders',displayName:'客户订单',source:'customer',target:'order',cardinality:'one_to_many',relationMappings:[{relationId:relation.id}]});
  const draft=schemas.saveDraft(source.id,transform(next),'fixture');
  assert.equal(draft.validation.ok,true,JSON.stringify(draft.validation.errors));
  const reviews={'prior-business-review':{resolution:'use_candidate',reviewChecksum:'existing-exact-review',reviewedBy:'user'}};
  const taskId=owner?randomUUID():null;
  if(owner){store.createTask({id:taskId,sourceId:source.id,taskType:'ontology_domain_modeling',payloadJson:JSON.stringify({actor:'fixture',sourceBuild:{workflowVersion:2,baseVersionId:base.id,draftVersionId:draft.id,phase:'needs_input',selections:['customers','orders'].map(tableName=>({tableName,included:true})),candidateReviews:reviews,events:[],questions:[{id:'evaluation-coverage',kind:'evaluation',detail:'需要验证客户昵称的移除'}]}})});store.completeTask(taskId,{phase:'needs_input'});}
  return {app,store,source,schemas,base,draft,taskId,reviews,modelCalls:()=>modelCalls};
}
const digest=db=>createHash('sha256').update(db.serialize()).digest('hex');
const path=(source,suffix)=>`/api/sources/${source.id}/ontology-build/${suffix}`;
const inspect=f=>api(f.app,path(f.source,`activation?versionId=${f.draft.id}`),null,'GET','viewer');
const input=(f,info,mode='activate')=>({versionId:f.draft.id,mode,snapshotChecksum:info.snapshotChecksum});

async function api(app,url,body,method='POST',token='editor') {
  const payload=body==null?'':JSON.stringify(body),req=Readable.from(payload?[payload]:[]);
  Object.assign(req,{method,url,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':String(Buffer.byteLength(payload))},socket:{remoteAddress:'127.0.0.1'}});
  let raw='';const res={statusCode:200,setHeader(){},end(value){raw=value?String(value):'';}};
  await app.handler(req,res);return {status:res.statusCode,body:raw?JSON.parse(raw):{}};
}
async function finished(store,id) {
  for(let i=0;i<200;i++){const task=store.getTask(id);if(!['queued','running'].includes(task.status))return task;await new Promise(resolve=>setTimeout(resolve,10));}
  throw Error('activation task did not complete');
}
function addCase(f){return f.store.addEvalCase({sourceId:f.source.id,setName:'reviewed',question:'显示客户昵称',goldSql:'SELECT nickname FROM customers',category:'核心业务',heldOut:0});}
function passGate(f,id=randomUUID()) {
  return f.store.saveEvalGate({id,sourceId:f.source.id,setName:'reviewed',total:1,ontologySchemaVersion:f.draft.version,evaluationChecksum:evalSetChecksum(f.store.listEvalCasesForImpact(f.source.id)),baseline:{requestedMode:'off',passRate:1},candidate:{requestedMode:'prefer',passRate:1,semanticExecutionRate:1},passed:1,decision:'enable_prefer',reason:'test fixture passed'});
}

test('启用检查只读且明确列出移除字段；重复检查不会创建任务或改变发布版本',async t=>{
  const f=await fixture(t),before=digest(f.store.db);
  const first=await inspect(f),again=await inspect(f);
  assert.equal(first.status,200);assert.deepEqual(first.body,again.body);assert.equal(first.body.state,'needs_cases');assert.equal(first.body.canActivate,false);
  assert.deepEqual(first.body.missingChanges.map(item=>item.label),['customer.nickname']);assert.equal(first.body.retention.fieldCount,1);assert.equal(first.body.retention.fields[0].label,'客户昵称');
  assert.match(first.body.detail,/重新检查不会自动补充/);assert.equal(digest(f.store.db),before);assert.equal(f.modelCalls(),0);
});

test('没有用例不能直接启用原草稿，错误明确且不排队',async t=>{
  const f=await fixture(t),info=(await inspect(f)).body,before=digest(f.store.db);
  const result=await api(f.app,path(f.source,'activate'),input(f,info));
  assert.equal(result.status,409);assert.match(JSON.stringify(result.body),/验证用例/);assert.equal(digest(f.store.db),before);
});

test('保留字段后经现有发布检查启用新版本，保留新增关系、旧草稿与已有人工结论，重复点击只发布一次',async t=>{
  const f=await fixture(t),info=(await inspect(f)).body,original=f.store.getOntologySchemaVersion(f.draft.id),relations=f.store.listRelations(f.source.id,false,true);
  const body=input(f,info,'retain_removed_properties');
  const responses=await Promise.all([api(f.app,path(f.source,'activate'),body),api(f.app,path(f.source,'activate'),body)]);
  for(const response of responses)assert.equal(response.status,202,JSON.stringify(response.body));
  assert.equal(responses[0].body.versionId,responses[1].body.versionId);
  const done=await finished(f.store,responses[0].body.task.id);
  assert.equal(done.status,'succeeded',done.error);assert.equal(done.payload.sourceBuild.phase,'ready');
  const published=f.store.getPublishedOntologySchema(f.source.id);
  assert.equal(published.version,f.draft.version+1);assert.deepEqual(published.schema.objectTypes[0].properties,f.base.schema.objectTypes[0].properties);
  assert.deepEqual(published.schema.linkTypes,f.draft.schema.linkTypes);assert.deepEqual(f.store.getOntologySchemaVersion(f.draft.id),original);
  assert.deepEqual(done.payload.sourceBuild.candidateReviews,f.reviews);assert.deepEqual(f.store.listRelations(f.source.id,false,true),relations);
  assert.equal(f.store.listEvalCasesForImpact(f.source.id).length,0);assert.equal(f.modelCalls(),0);
  const replay=await api(f.app,path(f.source,'activate'),body);assert.equal(replay.status,202);assert.equal(replay.body.reused,true);
  assert.equal(f.store.listOntologySchemaVersions(f.source.id).length,3);assert.equal(f.store.listTasks(f.source.id).length,1);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM ds_ontology_publication WHERE source_id=?').get(f.source.id).n,2);
});

test('已有合格验证的原草稿可以直接启用，无需创建兼容版本',async t=>{
  const f=await fixture(t);addCase(f);passGate(f);
  const info=(await inspect(f)).body;assert.equal(info.state,'ready');assert.equal(info.canActivate,true);
  const result=await api(f.app,path(f.source,'activate'),input(f,info));assert.equal(result.status,202);
  const done=await finished(f.store,result.body.task.id);assert.equal(done.payload.sourceBuild.phase,'ready',JSON.stringify(done));
  assert.equal(f.store.getPublishedOntologySchema(f.source.id).id,f.draft.id);assert.equal(f.store.listOntologySchemaVersions(f.source.id).length,2);
});

test('没有构建任务的兼容草稿也可启用，并可调度预先持久化的任务',async t=>{
  const f=await fixture(t,{owner:false,transform:schema=>{schema.objectTypes[0].properties.push({apiName:'nickname',displayName:'客户昵称',description:'客户可选昵称',type:'string',required:false,mapping:{table:'customers',column:'nickname'}});return schema;}});
  const info=(await inspect(f)).body;assert.equal(info.state,'ready');
  const result=await api(f.app,path(f.source,'activate'),input(f,info));assert.equal(result.status,202);
  const done=await finished(f.store,result.body.task.id);assert.equal(done.payload.sourceBuild.phase,'ready');assert.equal(f.store.getPublishedOntologySchema(f.source.id).id,f.draft.id);
});

test('除字段移除之外还有契约变化时不提供保留字段快捷启用',async t=>{
  const f=await fixture(t,{transform:schema=>{schema.objectTypes[1].properties[1].required=true;return schema;}});
  const info=(await inspect(f)).body;assert.equal(info.state,'needs_cases');assert.equal(info.retention,null);
  const result=await api(f.app,path(f.source,'activate'),input(f,info,'retain_removed_properties'));assert.equal(result.status,409);
  assert.equal(f.store.getPublishedOntologySchema(f.source.id).id,f.base.id);
});

test('已有字段在物理目录中已不存在时不能恢复无效映射',async t=>{
  const f=await fixture(t);f.store.db.prepare("UPDATE ds_column SET present=0 WHERE source_id=? AND column_name='nickname'").run(f.source.id);
  const info=(await inspect(f)).body;assert.equal(info.retention,null);assert.equal(info.canActivate,false);
});

test('读取条件后字段说明或 Gold SQL 发生变化，旧操作失效而不改变草稿',async t=>{
  for(const change of ['catalog','case'])await t.test(change,async t=>{
    const f=await fixture(t);let item;if(change==='case')item=addCase(f);
    const info=(await inspect(f)).body;
    if(item)f.store.updateEvalCase(item.id,{...item,goldSql:'SELECT nickname FROM customers WHERE id > 2'});
    else f.store.db.prepare("UPDATE ds_column SET comment='新的字段含义' WHERE source_id=? AND column_name='nickname'").run(f.source.id);
    const before=digest(f.store.db),result=await api(f.app,path(f.source,'activate'),input(f,info,'retain_removed_properties'));
    assert.equal(result.status,409);assert.match(JSON.stringify(result.body),/已变化/);assert.equal(digest(f.store.db),before);
  });
});

test('旧草稿、并行任务、业务待答问题和变更后的发布基线均不能越过检查启用',async t=>{
  for(const kind of ['superseded','busy','question','base'])await t.test(kind,async t=>{
    const f=await fixture(t);
    if(kind==='superseded')f.schemas.saveDraft(f.source.id,f.draft.schema,'newer');
    if(kind==='busy')f.store.createTask({id:randomUUID(),sourceId:f.source.id,taskType:'discovery'});
    if(kind==='question'){const task=f.store.getTask(f.taskId);f.store.resumeTask(task.id,{...task.payload,sourceBuild:{...task.payload.sourceBuild,questions:[{id:'business',kind:'relation',detail:'必须核实关系'}]}});f.store.completeTask(task.id,{phase:'needs_input'});}
    if(kind==='base'){const version=f.schemas.saveDraft(f.source.id,f.base.schema,'changed-base');assert.equal(f.schemas.publish(version.id,'changed-base').ok,true);}
    const info=(await inspect(f)).body;assert.equal(info.canActivate,false);assert.equal(info.retention,null);
    const result=await api(f.app,path(f.source,'activate'),input(f,info,'retain_removed_properties'));assert.equal(result.status,409);
  });
});

test('启用接口遵守编辑权限和数据源隔离，拒绝无效的处理方式',async t=>{
  const f=await fixture(t),info=(await inspect(f)).body;
  assert.equal((await api(f.app,path(f.source,'activate'),input(f,info),'POST','viewer')).status,403);
  assert.equal((await api(f.app,path(f.source,`activation?versionId=${f.draft.id}`),null,'GET','outsider')).status,403);
  const other=f.store.getPublishedOntologySchema(1);assert.equal((await api(f.app,path(f.source,`activation?versionId=${other.id}`),null,'GET')).status,404);
  assert.equal((await api(f.app,path(f.source,'activate'),{...input(f,info),mode:'force_publish'})).status,400);
});

test('保存兼容草稿与入队在同一事务内失败回滚；调度崩溃后相同操作可恢复',async t=>{
  const f=await fixture(t),info=(await inspect(f)).body,body=input(f,info,'retain_removed_properties'),resume=f.store.resumeTask;
  const activation=createOntologyActivationService({store:f.store,semanticSchemas:f.schemas,tasks:{resume:async()=>{throw Error('simulated dispatch crash');}}});
  f.store.resumeTask=()=>{throw Error('simulated queue failure');};
  const before=digest(f.store.db);await assert.rejects(activation.activate(f.source,body,'editor'),/queue failure/);assert.equal(digest(f.store.db),before);
  f.store.resumeTask=resume;
  await assert.rejects(activation.activate(f.source,body,'editor'),/dispatch crash/);
  assert.equal(f.store.getTask(f.taskId).status,'queued');assert.equal(f.store.listOntologySchemaVersions(f.source.id).length,3);
  const retry=await api(f.app,path(f.source,'activate'),body);assert.equal(retry.status,202);assert.equal(retry.body.reused,true);
  const done=await finished(f.store,retry.body.task.id);assert.equal(done.payload.sourceBuild.phase,'ready');assert.equal(f.store.listOntologySchemaVersions(f.source.id).length,3);
});

test('验证失败后检查显示原因并允许真正重跑；重复提交同一次操作不会重跑',async t=>{
  const f=await fixture(t);addCase(f);let calls=0,build;
  const tasks=createTaskService({store:f.store,discovery:{},handlers:{ontology_domain_modeling:context=>build.run(context)}});
  t.after(()=>tasks.close());
  build=createSourceOntologyBuildService({store:f.store,tasks,semanticSchemas:f.schemas,evaluation:{runGate:async context=>{calls++;assert.equal(context.payload.ontologySchemaVersionId,f.draft.id);if(calls===1)return {passed:false,reason:'候选 SQL 结果不等价'};passGate(f);return {passed:true};}}});
  const activation=createOntologyActivationService({store:f.store,semanticSchemas:f.schemas,tasks});
  const first=activation.inspect(f.source,f.draft.id);assert.equal(first.state,'needs_evaluation');
  const body=input(f,first),submitted=await activation.activate(f.source,body,'editor');await finished(f.store,submitted.task.id);
  assert.equal(f.store.getPublishedOntologySchema(f.source.id).id,f.base.id);
  const next=activation.inspect(f.source,f.draft.id);assert.match(next.detail,/候选 SQL 结果不等价/);assert.notEqual(next.snapshotChecksum,first.snapshotChecksum);
  await activation.activate(f.source,body,'editor');assert.equal(calls,1);
  const retry=await activation.activate(f.source,input(f,next),'editor');const done=await finished(f.store,retry.task.id);
  assert.equal(calls,2);assert.equal(done.payload.sourceBuild.phase,'ready');assert.equal(f.store.getPublishedOntologySchema(f.source.id).id,f.draft.id);
});
