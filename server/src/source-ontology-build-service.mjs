import { relationPairs, formatRelation } from "./physical-relation.mjs";
import { findBridgeRelationPaths, missingBridgePaths } from "./ontology-bridge-paths.mjs";
import { createHash } from "node:crypto";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";
import { buildIssueId, classifyBuildError, groupBuildErrors } from "./ontology-build-issues.mjs";

const CATALOG_TASKS=["discovery","ontology_domain_modeling","ontology_generation","ontology_link_generation"];
const ACTIVE=new Set(["queued","running"]);
const FINISHED=new Set(["ready","unchanged"]);

// The durable user operation owns generation, clarification and activation.
export function createSourceOntologyBuildService({store,discovery,modeling,tasks,config,candidates,drafts,semanticSchemas,evaluation,knowledge}) {
  function assertCatalogIdle(sourceId) {
    if(CATALOG_TASKS.some((type)=>store.findActiveTask(sourceId,type)))throw httpError(409,"当前数据源正在整理，请完成后再修改范围或启动新任务");
  }

  function status(sourceId) {
    const jobs=store.listTasks(sourceId,500).filter((task)=>task.taskType==="ontology_domain_modeling");
    const task=jobs.find((item)=>ACTIVE.has(item.status))||jobs[0]||null;
    const activeVersion=store.getPublishedOntologySchema(sourceId),checkpoint=task?.payload?.sourceBuild;
    const phase=checkpoint?.workflowVersion===2?checkpoint.phase||"queued":task?(ACTIVE.has(task.status)?"generating":"legacy"):"empty";
    const questions=checkpoint?.questions||[];
    return {task,modelingEnabled:config.ontologyAi.mode!=="off",profilingEnabled:Boolean(config.profiling?.enabled),activeVersion,
      availability:{canQuery:Boolean(activeVersion),tableNames:mappedTables(activeVersion?.schema),objectCount:activeVersion?.schema?.objectTypes?.length||0},
      update:task?{id:task.id,phase,busy:ACTIVE.has(task.status),questions,changes:checkpoint?.changes||null,changeChecksum:checkpoint?.changeChecksum||null,
        draftVersionId:checkpoint?.draftVersionId||null,summary:checkpoint?.summary||null,relationCoverage:checkpoint?.relationCoverage||null,events:checkpoint?.events||[],error:checkpoint?.failure||null,
        canResume:checkpoint?.workflowVersion===2&&!ACTIVE.has(task.status)&&!FINISHED.has(phase)&&!questions.some((item)=>item.retryable===false)}:null,
      history:jobs.map((item)=>({id:item.id,createdAt:item.createdAt,finishedAt:item.finishedAt,phase:item.payload?.sourceBuild?.workflowVersion===2?item.payload.sourceBuild.phase:"legacy",
        summary:item.payload?.sourceBuild?.summary||null,versionId:item.payload?.sourceBuild?.publishedVersionId||item.payload?.sourceBuild?.draftVersionId||null,
        selectedTableCount:item.payload?.sourceBuild?.selections?.filter((entry)=>entry.included).length??null})),
      versions:semanticSchemas?.list(sourceId)||[]};
  }

  async function start(source,input,actor) {
    if(!source.isDemo&&source.lastTestOk!==1)throw httpError(400,"真实数据源必须先通过只读连接测试");
    if(config.ontologyAi.mode==="off")throw httpError(409,"AI 本体生成尚未启用，请在设置中开启后再构建");
    let selections=normalizeSelections(input?.selections);
    const active=store.findActiveTask(source.id,"ontology_domain_modeling");
    if(active?.payload?.sourceBuild&&selectionKey(active.payload.sourceBuild.selections)===selectionKey(selections))return active;
    assertCatalogIdle(source.id);modeling.assertReady(source.id);
    const tables=await discovery.previewTables(source),selected=new Set(selections.filter((item)=>item.included).map((item)=>item.tableName));
    const available=new Set(tables.map((item)=>item.tableName)),missing=[...selected].filter((name)=>!available.has(name));
    if(missing.length)throw httpError(400,`所选表已不存在，请刷新表清单：${missing.join("、")}`);
    selections=normalizeSelections(tables.map((table)=>({tableName:table.tableName,included:selected.has(table.tableName)})));
    const pending=store.findActiveTask(source.id,"ontology_domain_modeling");
    if(pending?.payload?.sourceBuild&&selectionKey(pending.payload.sourceBuild.selections)===selectionKey(selections))return pending;
    assertCatalogIdle(source.id);
    return tasks.create({sourceId:source.id,taskType:"ontology_domain_modeling",payload:{actor,sourceBuild:{
      workflowVersion:2,selections,phase:"queued",baseVersionId:store.getPublishedOntologySchema(source.id)?.id??null,
      beforeCatalog:catalogFingerprints(source.id),knowledgeChecksum:knowledgeChecksum(source.id),events:[],questions:[]}}});
  }

  function record(sourceId,id) {
    const task=store.getTask(id);
    if(!task||task.sourceId!==sourceId||task.taskType!=="ontology_domain_modeling")throw httpError(404,"更新记录不存在");
    const checkpoint=task.payload?.sourceBuild||{},busy=ACTIVE.has(task.status),legacy=checkpoint.workflowVersion!==2;
    const phase=legacy?(busy?"generating":task.status==="failed"?"failed":"legacy"):checkpoint.phase||"queued";
    const runs=store.listOntologyGenerationRunsForBuild(sourceId,id);
    const selected=checkpoint.selections?.filter((item)=>item.included).map((item)=>item.tableName);
    return {id,phase,busy,legacy,createdAt:task.createdAt,finishedAt:task.finishedAt,progress:task.progress,currentStep:task.currentStep,
      summary:checkpoint.summary||null,error:checkpoint.failure?.message||task.error||null,questions:checkpoint.questions||[],events:checkpoint.events||[],
      tableNames:selected||[...new Set(runs.flatMap((run)=>run.scope.tableNames||[]))],
      versionId:checkpoint.publishedVersionId||checkpoint.draftVersionId||task.result?.draftSchemaVersionId||null,
      runs:runs.map((run)=>({id:run.id,name:run.scope.domainName||"业务定义整理",tableNames:run.scope.tableNames||[],status:run.status,progress:run.progress,
        objectCount:run.summary.objectCount||0,linkCount:run.summary.linkCount||0,modelName:run.modelName,error:run.error,startedAt:run.startedAt,finishedAt:run.finishedAt}))};
  }

  async function resume(source,input,actor) {
    const task=requiredBuild(source.id,input?.taskId);
    if(ACTIVE.has(task.status)||FINISHED.has(task.payload.sourceBuild.phase))return task;
    assertCatalogIdle(source.id);
    const checkpoint=task.payload.sourceBuild,questions=new Map((checkpoint.questions||[]).map((item)=>[item.id,item]));
    if(input?.answers!=null&&(!Array.isArray(input.answers)||input.answers.length>50))throw httpError(400,"补充说明格式无效");
    const answers=(input?.answers||[]).map((answer)=>{
      const question=questions.get(String(answer.questionId));
      if(!question||!["definition","conflict","relation"].includes(question.kind))throw httpError(400,"待补充的问题已变化，请刷新结果");
      const text=String(answer.text||"").trim(),resolution=answer.resolution;
      if(["conflict","relation"].includes(question.kind)&&!question.options?.some((option)=>option.value===resolution))throw httpError(400,"请选择此次业务定义的处理方式");
      if(question.kind==="definition"&&(!text||text.length>3000))throw httpError(400,"请补充 1 到 3000 字的业务说明");
      return {questionId:question.id,text,resolution,question,actor};
    });
    const approveChangeChecksum=input?.approveChangeChecksum;
    if(approveChangeChecksum&&(approveChangeChecksum!==checkpoint.changeChecksum||checkpoint.phase!=="awaiting_change"))throw httpError(409,"变化摘要已更新，请查看最新内容");
    return tasks.resume(task.id,{...task.payload,actor,sourceBuild:{...checkpoint,pendingAnswers:answers,...(approveChangeChecksum?{approvedChangeChecksum:approveChangeChecksum}:{}),failure:null}});
  }

  function correct(source,input,actor) {
    assertCatalogIdle(source.id);
    const base=store.getPublishedOntologySchema(source.id);
    if(!base||base.id!==Number(input?.versionId))throw httpError(409,"当前可用结果已更新，请刷新后再修改");
    const object=base.schema.objectTypes.find((item)=>item.apiName===input.objectName);
    const target=input.propertyName?object?.properties?.find((item)=>item.apiName===input.propertyName):object;
    if(!target)throw httpError(400,"需要修改的业务对象或字段不存在");
    const displayName=String(input.displayName||"").trim(),description=String(input.description||"").trim();
    if(!displayName||displayName.length>120||!description||description.length>3000)throw httpError(400,"请填写业务名称（最多 120 字）和说明（最多 3000 字）");
    const selections=mappedTables(base.schema).map((tableName)=>({tableName,included:true}));
    return tasks.create({sourceId:source.id,taskType:"ontology_domain_modeling",payload:{actor,sourceBuild:{workflowVersion:2,phase:"queued",kind:"correction",baseVersionId:base.id,selections,events:[],questions:[],correction:{objectName:object.apiName,propertyName:input.propertyName||null,displayName,description}}}});
  }

  async function run(context) {
    const {task,source,payload,onProgress=()=>{}}=context;
    if(payload.sourceBuild.workflowVersion!==2)return runLegacy(context);
    let checkpoint=payload.sourceBuild;
    const save=(next)=>{checkpoint={...checkpoint,...next};store.updateTaskPayload(task.id,{...payload,sourceBuild:checkpoint});};
    const stage=(phase,label,progress)=>{
      const events=checkpoint.phase===phase?checkpoint.events||[]:[...(checkpoint.events||[]),{phase,label,at:new Date().toISOString()}].slice(-100);
      save({phase,events});onProgress({progress,total:100,currentStep:label});
    };
    const result=()=>({...checkpoint.generation,discovery:checkpoint.discovery,phase:checkpoint.phase,summary:checkpoint.summary,publishedVersionId:checkpoint.publishedVersionId});
    const finish=(phase,summary)=>{stage(phase,summary,100);save({summary,questions:[],failure:null});return result();};
    const wait=(phase,questions)=>{stage(phase,phase==="awaiting_change"?"请查看本次业务变化":"等待补充说明或处理问题",90);save({questions});return result();};
    // The draft and checkpoint commit together, including after a process crash.
    const saveDraft=(create)=>{
      const previous=checkpoint;
      try{return store.db.transaction(()=>{const draft=create();save({draftVersionId:draft.id});return draft;}).immediate();}
      catch(error){checkpoint=previous;throw error;}
    };
    try {
      if(checkpoint.draftVersionId&&store.getPublishedOntologySchema(source.id)?.id===checkpoint.draftVersionId){save({publishedVersionId:checkpoint.draftVersionId});return finish("ready",checkpoint.summary||"本次更新已用于问数");}
      assertBase(source.id,checkpoint.baseVersionId);
      for(const answer of checkpoint.pendingAnswers||[]) {
        if(answer.question.kind==="relation") {
          const relation=store.listRelations(source.id,false,true).find(item=>item.id===answer.question.relationId);
          if(!relation||!checkpoint.selections.some(item=>item.included&&item.tableName===relation.fromTable)||!checkpoint.selections.some(item=>item.included&&item.tableName===relation.toTable))throw httpError(409,"待确认关系已变化，请重新读取数据范围");
          store.db.transaction(()=>{
            store.setRelationStatus(relation.id,answer.resolution==="confirm_relation"?"confirmed":"denied");
            for(const question of store.listQuestions(source.id).filter(item=>item.relationId===relation.id))store.answerQuestion(question.id,answer.resolution,answer.actor);
            save({catalogFingerprints:catalogFingerprints(source.id),generationTableNames:checkpoint.selections.filter(item=>item.included).map(item=>item.tableName),plan:null,generation:null});
          }).immediate();
        } else if(answer.question.kind==="conflict") {
          const resolutions={...checkpoint.conflictResolutions};for(const id of answer.question.candidateIds)resolutions[id]=answer.resolution;save({conflictResolutions:resolutions});
        } else {
          await knowledge.save(source.id,{pageType:"term",slug:`ontology-${task.id}-${answer.questionId}`,title:answer.question.title,content:answer.text,tables:answer.question.tables,verified:true,owner:answer.actor});
          save({answeredQuestions:[...new Set([...(checkpoint.answeredQuestions||[]),answer.questionId])]});
        }
      }
      if(checkpoint.pendingAnswers?.length)save({pendingAnswers:[],questions:[]});
      if(checkpoint.kind==="correction"&&!checkpoint.draftVersionId) {
        stage("merging","保存业务说明并检查影响",65);
        const schema=structuredClone(store.getOntologySchemaVersion(checkpoint.baseVersionId).schema),correction=checkpoint.correction;
        const object=schema.objectTypes.find((item)=>item.apiName===correction.objectName),target=correction.propertyName?object.properties.find((item)=>item.apiName===correction.propertyName):object;
        target.displayName=correction.displayName;target.description=correction.description;
        saveDraft(()=>semanticSchemas.saveDraft(source.id,schema,payload.actor));
      } else if(!checkpoint.draftVersionId) {
        if(!checkpoint.discovery) {
          stage("discovering","读取所选数据结构",3);
          store.saveTableSelections(source.id,checkpoint.selections,payload.actor);store.purgeExcludedTables(source.id);
          const discovered=await discovery.discover(source,{tableNames:checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName),onProgress:(step)=>onProgress({...step,total:100,progress:Math.round(Math.min(100,step.progress)*.25),currentStep:`读取数据结构：${step.currentStep}`})});
          const after=catalogFingerprints(source.id),base=checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId):null,existingTables=new Set(mappedTables(base?.schema));
          const previous=store.listTasks(source.id,500).find((item)=>item.id!==task.id&&item.payload?.sourceBuild?.publishedVersionId===checkpoint.baseVersionId&&FINISHED.has(item.payload?.sourceBuild?.phase));
          const known=previous?.payload?.sourceBuild?.catalogFingerprints||checkpoint.beforeCatalog||{},knowledgeChanged=previous&&previous.payload.sourceBuild.knowledgeChecksum!==knowledgeChecksum(source.id);
          const changed=checkpoint.selections.filter((item)=>item.included&&(!base||!existingTables.has(item.tableName)||after[item.tableName]!==known[item.tableName]||knowledgeChanged)).map((item)=>item.tableName);
          save({discovery:discovered,catalogFingerprints:after,generationTableNames:changed});
        }
        const selectedTables=checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName);
        const baseLinks=new Set((checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId)?.schema.linkTypes||[]:[]).flatMap(link=>(link.relationMappings||[]).map(item=>Number(item.relationId))));
        const missingBaseRelations=store.listRelations(source.id,true).filter(item=>selectedTables.includes(item.fromTable)&&selectedTables.includes(item.toTable)&&!baseLinks.has(item.id));
        const bridgePaths=sourceBridgePaths(source.id,selectedTables),baseSchema=checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId)?.schema:null;
        const missingBasePaths=missingBridgePaths(bridgePaths,baseSchema?.linkTypes||[]);
        if(!checkpoint.generation&&(missingBaseRelations.length||missingBasePaths.length))save({generationTableNames:[...new Set([...(checkpoint.generationTableNames||[]),...missingBaseRelations.flatMap(item=>[item.fromTable,item.toTable]),...missingBasePaths.flatMap(item=>[item.fromTable,item.bridgeTable,item.toTable])])]});
        const relationQuestions=physicalRelationIssues(source.id,selectedTables);
        if(relationQuestions.length)return wait("needs_input",relationQuestions);
        if(checkpoint.generation&&JSON.stringify(catalogFingerprints(source.id))!==JSON.stringify(checkpoint.catalogFingerprints))save({catalogFingerprints:catalogFingerprints(source.id),generationTableNames:selectedTables,plan:null,generation:null});
        if(checkpoint.generationTableNames?.length===0) {
          const base=store.getOntologySchemaVersion(checkpoint.baseVersionId),schema=pruneToScope(base.schema,selectedTables),diff=diffSemanticSchemas(schema,base.schema);
          if(!diff.summary.total){save({publishedVersionId:base.id});return finish("unchanged","数据范围和业务定义没有变化，继续使用当前结果");}
          saveDraft(()=>semanticSchemas.saveDraft(source.id,schema,payload.actor));
        } else {
          stage("generating","AI 正在整理业务对象与关系",25);
          const generate=async()=>{
            const generated=await modeling.run({...context,payload:{...payload,collectFailures:true,domainPlanSnapshot:checkpoint.plan,generationTableNames:checkpoint.generationTableNames},
              onPlan:(plan)=>{if(!checkpoint.plan)save({plan});},
              onProgress:(step)=>onProgress({...step,total:100,progress:25+Math.round(Math.min(100,step.progress)*.4)})});
            save({generation:generated});
          };
          if(!checkpoint.generation||checkpoint.generation.failedDomainCount) {
            await generate();
            while(checkpoint.generation.failedDomainCount&&Number(checkpoint.generationRetries||0)<2&&checkpoint.generation.domains.filter((item)=>item.status==="failed").every((item)=>item.retryable)) {
              save({generationRetries:Number(checkpoint.generationRetries||0)+1});
              await new Promise((resolve)=>setTimeout(resolve,250*checkpoint.generationRetries));await generate();
            }
          }
          if(checkpoint.generation.failedDomainCount)return wait("failed",groupBuildErrors(checkpoint.generation.domains.filter((item)=>item.status==="failed")));
          stage("repairing","AI 正在补充证据并修正不确定的定义",68);
          for(const runId of (checkpoint.generation.runIds||[]).filter(id=>store.getOntologyGenerationRun(id)?.scope.scopeKind!=="global_links")) {
            const spent=store.listOntologyGenerationRuns(source.id,500).filter((item)=>item.scope.orchestrationId===task.id).reduce((total,item)=>total+Number(item.summary.repairAttempts||0),0);
            await candidates.refineRun(runId,{remainingRounds:Math.max(0,20-spent),extraRounds:(checkpoint.answeredQuestions||[]).length,onProgress:(step)=>onProgress({...step,total:100,progress:70})});
          }
          const issues=definitionIssues(task.id);if(issues.length)return wait("needs_input",issues);
          const completed=await candidates.completeBuildLinks({sourceId:source.id,orchestrationId:task.id,runIds:checkpoint.generation.runIds||[],tableNames:selectedTables,actor:payload.actor,extraRounds:(checkpoint.answeredQuestions||[]).length,onProgress:step=>onProgress({...step,total:100,progress:75})});
          save({relationCoverage:completed.coverage,generation:{...checkpoint.generation,runIds:[...new Set([...(checkpoint.generation.runIds||[]),...completed.runIds])]}});
          const linkIssues=[...definitionIssues(task.id),...missingLinkIssues(source.id,completed.coverage.missingRelationIds),...missingBridgeIssues(completed.coverage.missingBridgePaths||[])];
          if(linkIssues.length)return wait("needs_input",linkIssues);
          stage("merging","合并业务定义并保留已有说明",78);
          const workflow=drafts.summary(task.id);
          if(workflow.draftSchemaVersionId)save({draftVersionId:workflow.draftSchemaVersionId});
          else {
            const input={conflictResolutions:checkpoint.conflictResolutions||{}},preview=drafts.previewBuild(task.id,input),conflicts=preview.conflicts.filter((item)=>item.resolution==="unresolved");
            if(conflicts.length)return wait("needs_input",conflictIssues(conflicts));
            const missing=selectedTables.filter((table)=>!mappedTables(preview.schema).includes(table));
            if(missing.length)return wait("needs_input",[{id:"scope",kind:"scope",title:"部分所选数据还没有业务定义",detail:`尚未覆盖：${missing.join("、")}。请补充表说明后继续整理。`,tables:missing,retryable:true}]);
            const coveredLinks=new Set((preview.schema.linkTypes||[]).flatMap(link=>(link.relationMappings||[]).map(item=>Number(item.relationId))));
            const expectedLinks=store.listRelations(source.id,true).filter(item=>selectedTables.includes(item.fromTable)&&selectedTables.includes(item.toTable)),missingLinks=expectedLinks.filter(item=>!coveredLinks.has(item.id));
            const missingPaths=missingBridgePaths(bridgePaths,preview.schema.linkTypes||[]);
            save({relationCoverage:{confirmedRelationCount:expectedLinks.length,coveredRelationCount:expectedLinks.length-missingLinks.length,missingRelationIds:missingLinks.map(item=>item.id),bridgePathCount:bridgePaths.length,bridgePathLimitReached:Boolean(bridgePaths.truncated),coveredBridgePathCount:bridgePaths.length-missingPaths.length,missingBridgePaths:missingPaths.map(({pathId,fromTable,toTable,bridgeTable,relationIds})=>({pathId,fromTable,toTable,bridgeTable,relationIds}))}});
            if(missingLinks.length)return wait("needs_input",missingLinkIssues(source.id,missingLinks.map(item=>item.id)));
            if(missingPaths.length)return wait("needs_input",missingBridgeIssues(missingPaths));
            if(!preview.validation.ok)return wait("needs_input",validationIssues(preview.validation));
            if(checkpoint.baseVersionId&&!preview.diff.summary.total){save({publishedVersionId:checkpoint.baseVersionId});return finish("unchanged","业务定义没有变化，继续使用当前结果");}
            saveDraft(()=>drafts.applyBuild(task.id,input,payload.actor).draft);
          }
        }
      }
      stage("checking","检查数据范围与此次更新影响",85);
      const draft=store.getOntologySchemaVersion(checkpoint.draftVersionId),base=checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId):null;
      const changes=diffSemanticSchemas(draft.schema,base?.schema||{...draft.schema,objectTypes:[],linkTypes:[]}),changeChecksum=hash([checkpoint.baseVersionId,draft.checksum,changes]);
      save({changes,changeChecksum});
      // A description correction inherits its version's scope, including interrupted older corrections.
      const expectedTables=checkpoint.kind==="correction"?mappedTables(base?.schema):checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName);
      const missing=expectedTables.filter((tableName)=>!mappedTables(draft.schema).includes(tableName));
      if(missing.length)return wait("needs_input",[{id:"scope",kind:"scope",title:"本次更新尚未覆盖全部所选数据",detail:missing.join("、"),tables:missing,retryable:false}]);
      const changesMeaning=base&&changes.changes.some((item)=>item.impact!=="compatible"||item.change==="removed");
      if(changesMeaning&&checkpoint.kind!=="correction"&&checkpoint.approvedChangeChecksum!==changeChecksum)return wait("awaiting_change",[]);
      let checked=semanticSchemas.preflight(draft.id);
      if(!checked.ok&&!checked.gateRequired)return wait("needs_input",validationIssues(checked));
      if(checked.gateRequired) {
        const impact=checked.evaluationImpact;
        if(impact.uncoveredChanges.length)return wait("needs_input",[{id:"evaluation-coverage",kind:"evaluation",title:"这次变化还缺少验证依据",detail:`请管理员补充已审核的验证用例：${impact.uncoveredChanges.map((item)=>item.label).join("、")}`,tables:[],retryable:true}]);
        stage("evaluating","正在验证受影响的业务问法",90);
        for(const setName of impact.missingSets||[]) {
          assertBase(source.id,checkpoint.baseVersionId);
          const evaluated=await evaluation.runGate({task:{...task,id:`${task.id}-${buildIssueId(setName)}`},source,payload:{setName,ontologySchemaVersionId:draft.id},onProgress:(step)=>onProgress({...step,total:100,progress:90+Math.round(Math.min(100,step.progress)*.07)})});
          if(!evaluated.passed)return wait("needs_input",[{id:`evaluation-${buildIssueId(setName)}`,kind:"evaluation",title:"此次更新未通过业务问法验证",detail:evaluated.reason,tables:[],retryable:true}]);
        }
        checked=semanticSchemas.preflight(draft.id);
        if(!checked.ok)return wait("needs_input",[{id:"evaluation",kind:"evaluation",title:"此次更新的验证尚未通过",detail:"请管理员在执行详情中检查验证结果，当前可用版本继续保留。",tables:[],retryable:true}]);
      }
      stage("activating","检查通过，正在启用",98);assertBase(source.id,checkpoint.baseVersionId);
      const published=semanticSchemas.publish(draft.id,payload.actor,{expectedPublishedId:checkpoint.baseVersionId});
      if(!published?.ok)throw httpError(409,"启用前检查未通过，已保留当前可用结果");
      save({publishedVersionId:draft.id});
      return finish("ready",checkpoint.kind==="correction"?"业务说明已更新并用于问数":`已更新 ${draft.schema.objectTypes.length} 个业务对象，检查通过并用于问数`);
    } catch(error) {
      const failure=classifyBuildError(error);save({failure,questions:[{id:buildIssueId(failure.message),...failure,detail:failure.message,tables:[]}],phase:"failed"});throw error;
    }
  }

  function definitionIssues(orchestrationId) {
    const owner=store.getTask(orchestrationId),currentIds=new Set(owner.payload?.sourceBuild?.generation?.runIds||[]);
    const runs=store.listOntologyGenerationRuns(owner.sourceId,500).filter((item)=>item.scope.orchestrationId===orchestrationId&&item.status==="succeeded"&&(!currentIds.size||currentIds.has(item.id))),issues=new Map();
    for(const run of runs) {
      const all=store.listOntologyCandidates({runId:run.id,limit:2000});
      for(const candidate of all.filter((item)=>["review_required","blocked"].includes(item.status))) {
        const tables=candidate.candidateType==="object"?mappedTables({objectTypes:[candidate.payload]}):run.scope.tableNames;
        const key=candidate.candidateType==="object"?tables.join("|"):`link:${candidate.payload.relationMappings?.map((item)=>item.relationId).sort().join(",")}`;
        const title=candidate.candidateType==="object"?`请补充「${candidate.payload.displayName||tables.join("、")}」的业务含义`:`请说明「${candidate.payload.displayName||"关联关系"}」的用途`;
        if(!issues.has(key))issues.set(key,{id:buildIssueId(key),kind:"definition",title,detail:"AI 已根据现有结构和知识检查；以下定义仍缺少明确依据。补充用途、关键字段或具体口径后，系统会继续整理。",tables,candidateIds:[],definitions:[],retryable:true});
        issues.get(key).candidateIds.push(candidate.id);issues.get(key).definitions.push({name:candidate.payload.displayName,description:candidate.payload.description,reasons:candidate.validation?.errors?.map((item)=>item.message)||[]});
      }
      const covered=new Set(all.filter((item)=>item.candidateType==="object").flatMap((item)=>mappedTables({objectTypes:[item.payload]})));
      for(const table of (run.scope.scopeKind==="global_links"?[]:run.scope.tableNames).filter((name)=>!covered.has(name)))if(!issues.has(table))issues.set(table,{id:buildIssueId(table),kind:"definition",title:`「${table}」存放什么业务数据？`,detail:"模型尚未生成这张表的业务定义，请补充用途或关键字段含义。",tables:[table],candidateIds:[],definitions:[],retryable:true});
    }
    return [...issues.values()];
  }
  function physicalRelationIssues(sourceId,tableNames){
    const tables=new Set(tableNames);
    return store.listRelations(sourceId,false,true).filter(item=>item.status==="review"&&tables.has(item.fromTable)&&tables.has(item.toTable)).map(relation=>({id:`physical-relation:${relation.id}`,kind:"relation",relationId:relation.id,title:"请确认数据之间的业务关系",detail:`${formatRelation(relation)}；${relation.modelReason||relation.structuralReason||"尚缺少明确的业务依据"}`,tables:[...new Set([relation.fromTable,relation.toTable])],retryable:true,options:[{value:"confirm_relation",label:"确认该业务关系"},{value:"deny_relation",label:"这些字段不构成业务关系"}]}));
  }
  function missingLinkIssues(sourceId,ids){
    const wanted=new Set(ids);
    return store.listRelations(sourceId,true).filter(item=>wanted.has(item.id)).map(relation=>({id:buildIssueId(`link:${relation.id}`),kind:"definition",title:"已确认关系尚未形成业务定义",detail:`${formatRelation(relation)}。请补充这条关系的业务名称、用途和两个方向的含义；系统将继续补充关系定义。`,tables:[...new Set([relation.fromTable,relation.toTable])],candidateIds:[],definitions:[],retryable:true}));
  }
  function sourceBridgePaths(sourceId,tableNames){
    const selected=new Set(tableNames);
    return findBridgeRelationPaths({columnsByTable:Object.fromEntries(tableNames.map(table=>[table,store.listColumns(sourceId,table)])),relations:store.listRelations(sourceId,true).filter(relation=>selected.has(relation.fromTable)&&selected.has(relation.toTable))});
  }
  function missingBridgeIssues(paths){return paths.map(path=>({id:buildIssueId(path.pathId),kind:"definition",title:"中间表关联尚未形成业务定义",detail:`${path.fromTable} 经 ${path.bridgeTable} 关联 ${path.toTable}，路径包含关系 ${path.relationIds.join("、")}。请说明这条路径的业务名称和用途，系统将继续补充定义。`,tables:[...new Set([path.fromTable,path.bridgeTable,path.toTable])],candidateIds:[],definitions:[],retryable:true}));}
  function conflictIssues(conflicts) {
    return conflicts.map((conflict)=>{
      const candidate=store.getOntologyCandidate(conflict.candidateId);
      return {id:buildIssueId(`conflict:${conflict.candidateId}`),kind:"conflict",title:`「${candidate.payload.displayName||conflict.existingApiName||"业务关系"}」与现有定义不一致`,
        detail:conflict.reason==="link_endpoint_missing"?"关系引用的业务对象尚未就绪。":"新定义改变了已有主键、字段类型或关联方式，请选择本次更新如何处理。",
        tables:candidate.candidateType==="object"?mappedTables({objectTypes:[candidate.payload]}):[],candidateIds:[candidate.id],retryable:true,
        definitions:[{name:candidate.payload.displayName,description:candidate.payload.description}],options:conflict.allowedResolutions.map((value)=>({value,label:value==="keep_existing"?"保留当前定义":"采用本次新定义"}))};
    });
  }
  function assertBase(sourceId,expected){if((store.getPublishedOntologySchema(sourceId)?.id??null)!==expected)throw httpError(409,"当前可用版本已变化，请重新更新数据范围");}
  function requiredBuild(sourceId,id){const task=store.getTask(String(id||""));if(!task||task.sourceId!==sourceId||task.payload?.sourceBuild?.workflowVersion!==2)throw httpError(404,"本次更新不存在或属于历史生成流程");return task;}
  function catalogFingerprints(sourceId) {
    const relations=store.listRelations(sourceId,false,true);
    return Object.fromEntries(store.listTables(sourceId).map((table)=>[table.tableName,hash({comment:table.comment,grade:table.grade,
      columns:store.listColumns(sourceId,table.tableName).map((column)=>[column.columnName,column.dataType,column.comment,column.nullable,column.isPrimary,column.isUnique,column.keyConstraints||[]]).sort(),
      relations:relations.filter((relation)=>relation.fromTable===table.tableName||relation.toTable===table.tableName).map((relation)=>[relation.id,relation.status,relation.fromTable,relation.fromCol,relation.toTable,relation.toCol,relation.cardinality,relationPairs(relation)]).sort()})]));
  }
  function knowledgeChecksum(sourceId){return hash(store.listKnowledge(sourceId).filter((page)=>page.verified).map((page)=>[page.pageType,page.slug,page.content,page.sqlContent]).sort());}
  async function runLegacy(context) {
    const {task,source,payload,onProgress}=context;let checkpoint=payload.sourceBuild;
    const save=(next)=>{checkpoint={...checkpoint,...next};store.updateTaskPayload(task.id,{...payload,sourceBuild:checkpoint});};
    if(!checkpoint.discovery){store.saveTableSelections(source.id,checkpoint.selections,payload.actor);store.purgeExcludedTables(source.id);save({discovery:await discovery.discover(source,{tableNames:checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName),onProgress})});}
    const generated=await modeling.run({...context,payload:{...payload,domainPlanSnapshot:checkpoint.plan},onPlan:(plan)=>{if(!checkpoint.plan)save({plan});}});
    return {...generated,discovery:checkpoint.discovery};
  }
  return {start,run,status,record,resume,correct,assertCatalogIdle};
}

function mappedTables(schema){return [...new Set((schema?.objectTypes||[]).flatMap((object)=>(object.properties||[]).map((property)=>property.mapping?.table).filter(Boolean)))].sort();}
function pruneToScope(schema,tables){const selected=new Set(tables),next=structuredClone(schema);next.objectTypes=next.objectTypes.filter((object)=>(object.properties||[]).every((property)=>selected.has(property.mapping.table)));const names=new Set(next.objectTypes.map((object)=>object.apiName));next.linkTypes=(next.linkTypes||[]).filter((link)=>names.has(link.source)&&names.has(link.target));return next;}
function validationIssues(validation){return [{id:"validation",kind:"validation",title:"部分业务定义与数据结构不一致",detail:(validation.errors||[]).map((item)=>item.message).join("；")||"请管理员检查本次定义",tables:[],retryable:true}];}
function hash(value){return createHash("sha256").update(JSON.stringify(value)).digest("hex");}
function normalizeSelections(value) {
  if(!Array.isArray(value)||!value.length)throw httpError(400,"请选择需要构建本体的数据表");
  const names=new Set(),result=value.map((item)=>{
    if(typeof item?.tableName!=="string"||!item.tableName.trim()||typeof item.included!=="boolean")throw httpError(400,"选表范围必须包含表名和明确的勾选状态");
    const tableName=item.tableName.trim();if(names.has(tableName))throw httpError(400,`选表范围存在重复表：${tableName}`);names.add(tableName);return {tableName,included:item.included};
  }).sort((left,right)=>left.tableName.localeCompare(right.tableName));
  if(!result.some((item)=>item.included))throw httpError(400,"请至少选择一张表");return result;
}
function selectionKey(selections){return JSON.stringify(selections.filter((item)=>item.included).map((item)=>item.tableName).sort());}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
