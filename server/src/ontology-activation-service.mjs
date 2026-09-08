import {createHash,randomUUID} from 'node:crypto';
import {diffSemanticSchemas} from './semantic-schema-diff.mjs';

const ACTIVE=new Set(['queued','running']);
const CATALOG_TASKS=new Set(['discovery','ontology_domain_modeling','ontology_generation','ontology_link_generation']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const tables=schema=>[...new Set((schema?.objectTypes||[]).flatMap(object=>(object.properties||[]).map(property=>property.mapping?.table).filter(Boolean)))].sort();
const material=diff=>diff.changes.filter(change=>change.impact!=='compatible'||change.change==='removed');
const error=(status,message)=>Object.assign(new Error(message),{status});

export function createOntologyActivationService({store,semanticSchemas,tasks}) {
  function assess(source,versionId) {
    const record=store.getOntologySchemaVersion(Number(versionId));
    if(!record||record.sourceId!==source.id)throw error(404,'本体版本不存在或不属于当前数据源');
    const base=store.getPublishedOntologySchema(source.id);
    const jobs=store.listTasks(source.id,500);
    const owner=jobs.find(task=>task.payload?.sourceBuild?.workflowVersion===2&&task.payload.sourceBuild.draftVersionId===record.id);
    const newer=store.listOntologySchemaVersions(source.id).find(version=>version.status==='draft'&&version.version>record.version);
    const active=jobs.find(task=>ACTIVE.has(task.status)&&CATALOG_TASKS.has(task.taskType));
    const blockedScope=tables(record.schema).filter(name=>store.excludedTableNames(source.id).has(name));
    let state='ready',detail='检查通过后，此版本将用于问数。';
    let check=null,retained=null;
    if(record.status!=='draft'){state=record.status==='published'?'published':'historical';detail=record.status==='published'?'此版本已用于问数。':'历史版本请使用恢复操作。';}
    else if(newer){state='superseded';detail=`已有更新的草稿 v${newer.version}，请查看该版本的启用条件。`;}
    else if(active){state='busy';detail='当前数据源正在处理任务，完成后会更新启用条件。';}
    else if(!source.isDemo&&source.lastTestOk!==1){state='blocked';detail='请先在连接设置中通过只读连接测试。';}
    else if(blockedScope.length){state='blocked';detail=`此版本包含未选中的数据表：${blockedScope.join('、')}，请重新核对数据范围。`;}
    else if(owner&&owner.payload.sourceBuild.baseVersionId!==(base?.id??null)){state='blocked';detail='当前使用版本已变化，请基于新版本重新整理此次更新。';}
    else if(owner&&(owner.payload.sourceBuild.questions||[]).some(issue=>issue.kind!=='evaluation')){state='blocked';detail='本次构建仍有待处理问题，请先查看本体结果中的处理入口。';}
    else {
      check=semanticSchemas.inspectPublication(record.id);
      if(!check.ok&&!check.gateRequired){state='invalid';detail='此版本与当前数据结构不一致，需要先修正下列问题。';}
      else if(check.evaluationImpact?.uncoveredChanges.length){state='needs_cases';detail=`仍缺少 ${check.evaluationImpact.uncoveredChanges.length} 项变化的验证用例。重新检查不会自动补充用例。`;}
      else if(check.gateRequired){state='needs_evaluation';const previous=owner?.payload.sourceBuild.questions?.find(issue=>issue.kind==='evaluation'&&issue.id!=='evaluation-coverage');detail=previous?`上次验证未通过：${previous.detail} 修正后可重新运行验证并启用。`:'验证用例已覆盖此次变化，启用前将运行验证；通过后自动用于问数。';}
      if(base&&['needs_cases','needs_evaluation'].includes(state))retained=retentionPreview(record,base);
    }
    const snapshotChecksum=hash({versionId:record.id,draftChecksum:record.checksum,baseId:base?.id??null,baseChecksum:base?.checksum??null,
      state,scope:[...store.excludedTableNames(source.id)].sort(),catalog:check?semanticSchemas.catalog(source.id):null,
      evaluation:check?.evaluationImpact||null,cases:store.listEvalCasesForImpact(source.id),retained:retained?.schema||null,
      workflow:owner?{id:owner.id,status:owner.status,checkpoint:owner.payload.sourceBuild}:null});
    return {record,base,owner,retained,view:{versionId:record.id,version:record.version,state,detail,snapshotChecksum,
      baseVersion:base?.version??null,canActivate:['ready','needs_evaluation'].includes(state),
      supersededBy:newer?{id:newer.id,version:newer.version}:null,
      errors:check?.errors||[],missingChanges:check?.evaluationImpact?.uncoveredChanges||[],affectedSets:check?.evaluationImpact?.affectedSets||[],
      retention:retained?{fieldCount:retained.fields.length,fields:retained.fields}:null}};
  }

  function retentionPreview(record,base) {
    const diff=diffSemanticSchemas(record.schema,base.schema),changes=material(diff);
    // This option restores only omitted properties. It never hides other contract changes.
    if(!changes.length||changes.some(change=>change.kind!=='property'||change.change!=='removed'))return null;
    const schema=structuredClone(record.schema),fields=[];
    for(const change of changes){
      const [,objectName,,propertyName]=change.path.split('.');
      const previous=base.schema.objectTypes.find(object=>object.apiName===objectName);
      const next=schema.objectTypes.find(object=>object.apiName===objectName);
      const property=previous?.properties.find(item=>item.apiName===propertyName);
      if(!next||!property||next.properties.some(item=>item.apiName===propertyName))return null;
      next.properties.push(structuredClone(property));
      fields.push({path:change.path,objectName,objectLabel:next.displayName||objectName,propertyName,label:property.displayName||propertyName});
    }
    const validation=semanticSchemas.validate(record.sourceId,schema);
    if(!validation.ok||material(diffSemanticSchemas(validation.schema,base.schema)).length)return null;
    return {schema:validation.schema,fields};
  }

  function inspect(source,versionId){return assess(source,versionId).view;}

  async function activate(source,input,actor) {
    if(!Number.isSafeInteger(input?.versionId)||!['activate','retain_removed_properties'].includes(input?.mode)||! /^[a-f0-9]{64}$/.test(input?.snapshotChecksum||''))throw error(400,'请先读取版本的启用条件，再选择处理方式');
    const receipt=store.db.transaction(()=>{
      const existing=store.listTasks(source.id,500).find(task=>{
        const action=task.payload?.sourceBuild?.activation;
        return action?.requestedVersionId===input.versionId&&action.mode===input.mode&&action.snapshotChecksum===input.snapshotChecksum;
      });
      if(existing)return {task:existing,version:store.getOntologySchemaVersion(existing.payload.sourceBuild.draftVersionId),reused:true};
      const assessment=assess(source,input.versionId),{record,base,owner,view}=assessment;
      if(input.snapshotChecksum!==view.snapshotChecksum)throw error(409,'版本、数据范围或验证依据已变化，请重新检查启用条件');
      const retain=input.mode==='retain_removed_properties';
      if(retain?!assessment.retained:!view.canActivate)throw error(409,view.detail);
      const version=retain?semanticSchemas.saveDraft(source.id,assessment.retained.schema,actor):record;
      const changes=diffSemanticSchemas(version.schema,base?.schema||{...version.schema,objectTypes:[],linkTypes:[]});
      const changeChecksum=hash([base?.id??null,version.checksum,changes]);
      const checkpoint={...(owner?.payload.sourceBuild||{}),workflowVersion:2,kind:owner?.payload.sourceBuild.kind||'activation',
        baseVersionId:base?.id??null,draftVersionId:version.id,phase:'checking',questions:[],pendingAnswers:[],failure:null,
        selections:owner?.payload.sourceBuild.selections||tables(version.schema).map(tableName=>({tableName,included:true})),
        changes,changeChecksum,approvedChangeChecksum:changeChecksum,
        activation:{requestedVersionId:record.id,resultVersionId:version.id,mode:input.mode,snapshotChecksum:input.snapshotChecksum,actor,at:new Date().toISOString(),retainedFields:retain?assessment.retained.fields:[]},
        events:[...(owner?.payload.sourceBuild.events||[]),{phase:'checking',label:retain?`保留 ${assessment.retained.fields.length} 个已有字段，检查并启用更新`:`检查并启用 v${version.version}`,at:new Date().toISOString()}].slice(-100)};
      const payload={...(owner?.payload||{}),actor,sourceBuild:checkpoint};
      const task=owner?store.resumeTask(owner.id,payload):store.createTask({id:randomUUID(),sourceId:source.id,taskType:'ontology_domain_modeling',payloadJson:JSON.stringify(payload)});
      if(task.status!=='queued'||task.payload.sourceBuild.draftVersionId!==version.id)throw error(409,'构建状态已变化，请刷新后重试');
      return {task,version,reused:false};
    }).immediate();
    // Queuing and saving the chosen draft are atomic; recovery can resume after a crash.
    if(receipt.task.status==='queued')await tasks.resume(receipt.task.id);
    return {task:store.getTask(receipt.task.id),versionId:receipt.version.id,version:receipt.version.version,reused:receipt.reused};
  }
  return {inspect,activate};
}
