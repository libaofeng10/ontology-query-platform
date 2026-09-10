import { relationPairs, formatRelation } from "./physical-relation.mjs";
import { findBridgeRelationPaths, missingBridgePaths } from "./ontology-bridge-paths.mjs";
import { createHash } from "node:crypto";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";
import { buildIssueId, classifyBuildError, groupBuildErrors } from "./ontology-build-issues.mjs";
import { candidateReviewChecksum, candidateReviewIssue, previousCandidateDefinition } from "./ontology-candidate-review.mjs";

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
    const questions=task?currentQuestions(task):[];
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
    if(source.lastTestOk!==1)throw httpError(400,"真实数据源必须先通过只读连接测试");
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
      summary:checkpoint.summary||null,error:checkpoint.failure?.message||task.error||null,questions:currentQuestions(task),events:checkpoint.events||[],
      tableNames:selected||[...new Set(runs.flatMap((run)=>run.scope.tableNames||[]))],
      versionId:checkpoint.publishedVersionId||checkpoint.draftVersionId||task.result?.draftSchemaVersionId||null,
      runs:runs.map((run)=>({id:run.id,name:run.scope.domainName||"业务定义整理",tableNames:run.scope.tableNames||[],status:run.status,progress:run.progress,
        objectCount:run.summary.objectCount||0,linkCount:run.summary.linkCount||0,modelName:run.modelName,error:run.error,startedAt:run.startedAt,finishedAt:run.finishedAt}))};
  }

  async function resume(source,input,actor) {
    const task=requiredBuild(source.id,input?.taskId);
    if(ACTIVE.has(task.status)||FINISHED.has(task.payload.sourceBuild.phase))return task;
    assertCatalogIdle(source.id);
    const checkpoint=task.payload.sourceBuild,current=currentQuestions(task),questions=new Map(current.map((item)=>[item.id,item]));
    assertBase(source.id,checkpoint.baseVersionId);
    if(input?.answers!=null&&(!Array.isArray(input.answers)||input.answers.length>50))throw httpError(400,"补充说明格式无效");
    if(new Set((input?.answers||[]).map(answer=>String(answer.questionId))).size!==(input?.answers||[]).length)throw httpError(400,"同一问题不能重复提交答案");
    const answers=(input?.answers||[]).map((answer)=>{
      const question=questions.get(String(answer.questionId));
      if(!question||!["definition","conflict","relation","candidate_review"].includes(question.kind))throw httpError(400,"待处理的问题已变化，请刷新结果");
      const text=String(answer.text||"").trim(),resolution=answer.resolution;
      if(["conflict","relation","candidate_review"].includes(question.kind)&&!question.options?.some((option)=>option.value===resolution))throw httpError(400,"请选择此次业务定义的处理方式");
      if(question.kind==="candidate_review"&&answer.reviewChecksum!==question.reviewChecksum)throw httpError(409,"待审核定义或依据已变化，请刷新后重新确认");
      if((question.kind==="definition"||resolution==="supplement_definition")&&(!text||text.length>3000))throw httpError(400,"请补充 1 到 3000 字的业务说明");
      return {questionId:question.id,text,resolution,question,actor};
    });
    if(input?.retryLinkGeneration!=null&&typeof input.retryLinkGeneration!=="boolean")throw httpError(400,"关系补齐重试参数无效");
    const retryLinks=input?.retryLinkGeneration===true;
    if(retryLinks&&((input.answers||[]).length||!current.some(item=>item.kind==="generation"&&item.retryable)||Number(checkpoint.linkRetryPasses||0)>=2))throw httpError(409,"当前关系补齐不可重试，请刷新并查看执行记录");
    if(input?.retryVerification!=null&&typeof input.retryVerification!=="boolean")throw httpError(400,"证据核验重试参数无效");
    const retryVerification=input?.retryVerification===true;
    if(retryVerification&&(retryLinks||(input.answers||[]).length||!current.some(item=>item.kind==="verification"&&item.retryable)||Number(checkpoint.verificationRetryPasses||0)>=2))throw httpError(409,"当前证据核验不可重试，请刷新并查看执行记录");
    const approveChangeChecksum=input?.approveChangeChecksum;
    if(approveChangeChecksum&&(approveChangeChecksum!==checkpoint.changeChecksum||checkpoint.phase!=="awaiting_change"))throw httpError(409,"变化摘要已更新，请查看最新内容");
    return tasks.resume(task.id,{...task.payload,actor,sourceBuild:{...checkpoint,questions:current,pendingAnswers:answers,...(retryLinks?{linkRetryPasses:Number(checkpoint.linkRetryPasses||0)+1}:{}),...(retryVerification?{verificationRetryPasses:Number(checkpoint.verificationRetryPasses||0)+1}:{}),...(approveChangeChecksum?{approvedChangeChecksum:approveChangeChecksum}:{}),failure:null}});
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
        if(answer.question.kind==="candidate_review") {
          const candidate=store.getOntologyCandidate(answer.question.candidateIds[0]);
          const run=candidate&&store.getOntologyGenerationRun(candidate.runId),base=checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId):null;
          if(!candidate||candidate.sourceId!==source.id||run?.scope.orchestrationId!==task.id||candidate.status!=="review_required"||
            candidateReviewChecksum(candidate,run,base)!==answer.question.reviewChecksum)throw httpError(409,"待审核定义或依据已变化，请刷新后重新确认");
          if(answer.resolution==="supplement_definition") {
            await knowledge.save(source.id,{pageType:"term",slug:`ontology-${task.id}-${buildIssueId(answer.questionId)}`,title:answer.question.title,content:answer.text,tables:answer.question.tables,verified:true,owner:answer.actor});
            save({answeredQuestions:[...new Set([...(checkpoint.answeredQuestions||[]),answer.questionId])],
              clarifiedCandidateIds:[...new Set([...(checkpoint.clarifiedCandidateIds||[]),candidate.id])],
              pendingAnswers:checkpoint.pendingAnswers.filter(item=>item.questionId!==answer.questionId)});
          } else {
            const previous=checkpoint;
            const existing=previousCandidateDefinition(candidate,base);
            if(answer.resolution==="keep_existing"&&!existing)throw httpError(409,"已有定义已变化，请刷新后重新审核");
            try {
              await candidates.decide(candidate.id,{decision:"confirm",reviewChecksum:answer.question.reviewChecksum,
                ...(answer.resolution==="keep_existing"?{candidate:existing}:{}),note:answer.resolution==="keep_existing"?"本次构建审核：保留已有定义":"本次构建审核：采用当前候选定义"},answer.actor,{onDecision:()=>{
                  if(store.getTask(task.id)?.status!=="running")throw httpError(409,"本次构建状态已变化，请刷新后重试");
                  save({
                  candidateReviews:{...checkpoint.candidateReviews,[candidate.id]:{reviewChecksum:answer.question.reviewChecksum,resolution:answer.resolution,baseVersionId:checkpoint.baseVersionId,reviewedBy:answer.actor,reviewedAt:new Date().toISOString()}},
                  conflictResolutions:{...checkpoint.conflictResolutions,[candidate.id]:answer.resolution},
                  pendingAnswers:checkpoint.pendingAnswers.filter(item=>item.questionId!==answer.questionId),
                  });
                }});
            } catch(error){checkpoint=previous;throw error;}
          }
        } else if(answer.question.kind==="relation") {
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
        if(!checkpoint.discovery||checkpoint.discovery.relationDiscovery?.checkpoint&&checkpoint.discovery.relationDiscovery.modelStatus!=="completed") {
          stage("discovering","读取所选数据结构",3);
          store.saveTableSelections(source.id,checkpoint.selections,payload.actor);store.purgeExcludedTables(source.id);
          const discovered=await discovery.discover(source,{runId:task.id,resumeRelations:Boolean(checkpoint.discovery),tableNames:checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName),onProgress:(step)=>onProgress({...step,total:100,progress:Math.round(Math.min(100,step.progress)*.25),currentStep:`读取数据结构：${step.currentStep}`})});
          const after=catalogFingerprints(source.id),base=checkpoint.baseVersionId?store.getOntologySchemaVersion(checkpoint.baseVersionId):null,existingTables=new Set(mappedTables(base?.schema));
          const previous=store.listTasks(source.id,500).find((item)=>item.id!==task.id&&item.payload?.sourceBuild?.publishedVersionId===checkpoint.baseVersionId&&FINISHED.has(item.payload?.sourceBuild?.phase));
          const known=previous?.payload?.sourceBuild?.catalogFingerprints||checkpoint.beforeCatalog||{},knowledgeChanged=previous&&previous.payload.sourceBuild.knowledgeChecksum!==knowledgeChecksum(source.id);
          const changed=checkpoint.selections.filter((item)=>item.included&&(!base||!existingTables.has(item.tableName)||after[item.tableName]!==known[item.tableName]||knowledgeChanged)).map((item)=>item.tableName);
          save({discovery:discovered,catalogFingerprints:after,generationTableNames:changed});
        }
        if(checkpoint.discovery?.relationDiscovery?.checkpoint&&checkpoint.discovery.relationDiscovery.modelStatus!=="completed")return wait("needs_input",[{id:"relation-analysis",kind:"validation",title:"关系识别尚未完成",detail:checkpoint.discovery.relationDiscovery.error||"请继续处理尚未完成的关系候选。",tables:[],retryable:true}]);
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
            await candidates.refineRun(runId,{remainingRounds:Math.max(0,20-spent),extraRounds:(checkpoint.answeredQuestions||[]).length,clarifiedCandidateIds:checkpoint.clarifiedCandidateIds||[],onProgress:(step)=>onProgress({...step,total:100,progress:70})});
            await candidates.verifyAndRepairRun?.(runId,{retryPasses:Number(checkpoint.verificationRetryPasses||0),repairBusinessQuestions:true,onProgress:step=>onProgress({...step,total:100,progress:72})});
          }
          const issues=definitionIssues(task.id,{objectsOnly:true});if(issues.length)return wait("needs_input",issues);
          const completed=await candidates.completeBuildLinks({sourceId:source.id,orchestrationId:task.id,runIds:checkpoint.generation.runIds||[],tableNames:selectedTables,actor:payload.actor,extraRounds:(checkpoint.answeredQuestions||[]).length,retryPasses:Number(checkpoint.linkRetryPasses||0),verificationRetryPasses:Number(checkpoint.verificationRetryPasses||0),clarifiedCandidateIds:checkpoint.clarifiedCandidateIds||[],onProgress:step=>onProgress({...step,total:100,progress:75})});
          save({relationCoverage:completed.coverage,generation:{...checkpoint.generation,runIds:[...new Set([...(checkpoint.generation.runIds||[]),...completed.runIds])]}});
          if(checkpoint.clarifiedCandidateIds?.length)save({clarifiedCandidateIds:[]});
          const linkIssues=[...definitionIssues(task.id),...linkGenerationIssues(task.id,completed.coverage)];
          if(linkIssues.length)return wait("needs_input",linkIssues);
          stage("merging","合并业务定义并保留已有说明",78);
          const workflow=drafts.summary(task.id);
          if(workflow.draftSchemaVersionId)save({draftVersionId:workflow.draftSchemaVersionId});
          else {
            const resolutions={...checkpoint.conflictResolutions};
            for(const runId of checkpoint.generation.runIds||[])for(const item of store.listOntologyCandidates({runId,limit:2000}))if(!resolutions[item.id]&&item.status==="auto_confirmed"&&item.forcedReviewReasons?.includes("MODIFIES_BASE_SCHEMA")&&candidates.currentVerification?.(item)?.decision==="supported")resolutions[item.id]="use_candidate";
            const input={conflictResolutions:resolutions},preview=drafts.previewBuild(task.id,input),conflicts=preview.conflicts.filter((item)=>item.resolution==="unresolved");
            if(conflicts.length)return wait("needs_input",conflictIssues(conflicts));
            const missing=selectedTables.filter((table)=>!mappedTables(preview.schema).includes(table));
            if(missing.length)return wait("needs_input",[{id:"scope",kind:"scope",title:"部分所选数据还没有业务定义",detail:`系统合并后尚未覆盖：${missing.join("、")}。请查看执行记录并重试。`,tables:missing,retryable:true}]);
            const coveredLinks=new Set((preview.schema.linkTypes||[]).flatMap(link=>(link.relationMappings||[]).map(item=>Number(item.relationId))));
            const expectedLinks=store.listRelations(source.id,true).filter(item=>selectedTables.includes(item.fromTable)&&selectedTables.includes(item.toTable)),missingLinks=expectedLinks.filter(item=>!coveredLinks.has(item.id));
            const missingPaths=missingBridgePaths(bridgePaths,preview.schema.linkTypes||[]);
            save({relationCoverage:{confirmedRelationCount:expectedLinks.length,coveredRelationCount:expectedLinks.length-missingLinks.length,missingRelationIds:missingLinks.map(item=>item.id),bridgePathCount:bridgePaths.length,bridgePathLimitReached:Boolean(bridgePaths.truncated),coveredBridgePathCount:bridgePaths.length-missingPaths.length,missingBridgePaths:missingPaths.map(({pathId,fromTable,toTable,bridgeTable,relationIds})=>({pathId,fromTable,toTable,bridgeTable,relationIds}))}});
            if(missingLinks.length||missingPaths.length)return wait("needs_input",[{id:"link-merge-coverage",kind:"validation",title:"关系定义合并后覆盖不完整",detail:`合并结果缺少 ${missingLinks.length} 条已确认关系和 ${missingPaths.length} 条中间表路径，请查看执行记录中的映射与冲突。系统需要修复合并结果，无需重复确认物理关系。`,tables:[...new Set(missingLinks.flatMap(item=>[item.fromTable,item.toTable]))],retryable:true}]);
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
        if(impact.uncoveredChanges.length)return wait("needs_input",[{id:"evaluation-coverage",kind:"evaluation",title:"这次变化还缺少验证依据",detail:`需补充已审核的验证用例：${impact.uncoveredChanges.map((item)=>item.label).join("、")}。请在启用条件中选择补充用例或保留已有字段；重新检查不会自动补充用例。`,tables:[],retryable:true}]);
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

  function definitionIssues(orchestrationId,{objectsOnly=false}={}) {
    const owner=store.getTask(orchestrationId),currentIds=new Set(owner.payload?.sourceBuild?.generation?.runIds||[]);
    const runs=store.listOntologyGenerationRuns(owner.sourceId,500).filter((item)=>item.scope.orchestrationId===orchestrationId&&item.status==="succeeded"&&(!currentIds.size||currentIds.has(item.id))),issues=new Map();
    for(const run of runs) {
      const all=store.listOntologyCandidates({runId:run.id,limit:2000});
      for(const candidate of all.filter((item)=>(!objectsOnly||item.candidateType==="object")&&["review_required","blocked"].includes(item.status))) {
        if(candidate.sourceId!==owner.sourceId)continue;
        const base=owner.payload.sourceBuild.baseVersionId?store.getOntologySchemaVersion(owner.payload.sourceBuild.baseVersionId):null;
        issues.set(candidate.id,candidates?.reviewIssue?candidates.reviewIssue(candidate,run,base):candidateReviewIssue(candidate,run,base));
      }
      const covered=new Set(all.filter((item)=>item.candidateType==="object").flatMap((item)=>mappedTables({objectTypes:[item.payload]})));
      for(const table of (run.scope.scopeKind==="global_links"?[]:run.scope.tableNames).filter((name)=>!covered.has(name)))if(!issues.has(table))issues.set(table,{id:buildIssueId(table),kind:"validation",title:`「${table}」尚未生成业务对象`,detail:"自动生成和修正后仍缺少此表的对象定义。请查看执行记录中的生成错误并重试，当前不能据此判断缺少哪项业务知识。",tables:[table],candidateIds:[],definitions:[],retryable:true});
    }
    const all=[...issues.values()],system=all.filter(item=>item.kind==="verification");
    if(!system.length)return all;
    return [...all.filter(item=>item.kind!=="verification"),{id:"evidence-verification",kind:"verification",title:`系统需要核验或修正 ${system.length} 项定义`,
      detail:"系统会先用已确认关系、字段说明和业务知识核验，证据充分的自动通过。模型或结构问题由系统修复；只有仍有具体业务疑点的才需要你回答。",
      tables:[...new Set(system.flatMap(item=>item.tables||[]))],candidateIds:system.flatMap(item=>item.candidateIds),
      definitions:system.map(item=>({name:item.candidateIds[0],description:item.detail,reasons:[]})),retryable:Number(owner.payload.sourceBuild.verificationRetryPasses||0)<2}];
  }
  function currentQuestions(task) {
    const checkpoint=task.payload?.sourceBuild,questions=checkpoint?.questions||[];
    const candidateIssue=item=>["definition","candidate_review","validation","verification"].includes(item.kind)&&item.candidateIds?.length;
    const coverage=checkpoint?.relationCoverage||{};
    const legacyIds=new Set([...(coverage.missingRelationIds||[]).map(id=>buildIssueId(`link:${id}`)),...(coverage.missingBridgePaths||[]).map(path=>buildIssueId(path.pathId))]);
    const coverageIssue=item=>item.kind==="generation"||legacyIds.has(item.id);
    if(checkpoint?.phase!=="needs_input"||!questions.some(item=>candidateIssue(item)||coverageIssue(item)))return questions;
    // Project historical prompts without changing saved decisions or calling a model.
    return [...questions.filter(item=>!candidateIssue(item)&&!coverageIssue(item)),...definitionIssues(task.id).filter(item=>item.candidateIds?.length),
      ...(questions.some(coverageIssue)?linkGenerationIssues(task.id,coverage):[])];
  }
  function linkGenerationIssues(orchestrationId,coverage) {
    const owner=store.getTask(orchestrationId),checkpoint=owner.payload.sourceBuild,ids=new Set(checkpoint.generation?.runIds||[]);
    const runs=store.listOntologyGenerationRunsForBuild(owner.sourceId,orchestrationId).filter(run=>run.status==="succeeded"&&(!ids.size||ids.has(run.id)));
    const pending=runs.flatMap(run=>store.listOntologyCandidates({runId:run.id,candidateType:"link",limit:2000})).filter(item=>["review_required","blocked"].includes(item.status)).map(item=>item.payload);
    const handled=new Set(pending.flatMap(link=>(link.relationMappings||[]).map(item=>Number(item.relationId))));
    const missing=new Set((coverage?.missingRelationIds||[]).filter(id=>!handled.has(Number(id))));
    const relations=store.listRelations(owner.sourceId,true).filter(item=>missing.has(item.id));
    const paths=missingBridgePaths(coverage?.missingBridgePaths||[],pending);
    if(!relations.length&&!paths.length)return [];
    const codes=[...new Set(runs.filter(run=>run.scope.scopeKind==="global_links"&&((run.scope.relationIds||[]).some(id=>missing.has(id))||(run.scope.pathIds||[]).some(id=>paths.some(path=>path.pathId===id)))).flatMap(run=>run.summary.normalizationIssues||[]).map(item=>item.code))];
    const retryable=Number(checkpoint.linkRetryPasses||0)<2;
    return [{id:"link-generation",kind:"generation",title:`系统还需补齐 ${relations.length} 条关系定义${paths.length?`及 ${paths.length} 条中间表路径`:""}`,
      detail:`这些关系已确认，生成阶段尚未产出相应定义。${codes.includes("ONTOLOGY_LINK_RELATION_NOT_ALLOWED")?"部分模型输出使用了不属于本批次的关系标识，已被校验拦截。":""}${retryable?"可重试系统补齐；已有定义和审核结果会保留，无需逐条填写业务说明。":"已达到本次自动补齐及额外重试上限，请查看执行记录中的生成问题。"}`,
      tables:[...new Set([...relations.flatMap(item=>[item.fromTable,item.toTable]),...paths.flatMap(path=>[path.fromTable,path.bridgeTable,path.toTable])])],relationIds:relations.map(item=>item.id),pathIds:paths.map(path=>path.pathId),retryable}];
  }
  function physicalRelationIssues(sourceId,tableNames){
    const tables=new Set(tableNames);
    return store.listRelations(sourceId,false,true).filter(item=>item.status==="review"&&tables.has(item.fromTable)&&tables.has(item.toTable)).map(relation=>({id:`physical-relation:${relation.id}`,kind:"relation",relationId:relation.id,title:"请确认数据之间的业务关系",detail:`${formatRelation(relation)}；${relation.modelReason||relation.structuralReason||"尚缺少明确的业务依据"}`,tables:[...new Set([relation.fromTable,relation.toTable])],retryable:true,options:[{value:"confirm_relation",label:"确认该业务关系"},{value:"deny_relation",label:"这些字段不构成业务关系"}]}));
  }
  function sourceBridgePaths(sourceId,tableNames){
    const selected=new Set(tableNames);
    return findBridgeRelationPaths({columnsByTable:Object.fromEntries(tableNames.map(table=>[table,store.listColumns(sourceId,table)])),relations:store.listRelations(sourceId,true).filter(relation=>selected.has(relation.fromTable)&&selected.has(relation.toTable))});
  }
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
    if(!checkpoint.discovery){store.saveTableSelections(source.id,checkpoint.selections,payload.actor);store.purgeExcludedTables(source.id);save({discovery:await discovery.discover(source,{runId:task.id,tableNames:checkpoint.selections.filter((item)=>item.included).map((item)=>item.tableName),onProgress})});}
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
