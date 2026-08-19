import { createHash } from "node:crypto";
import { assembleOntologyDraft } from "./ontology-draft-assembler.mjs";
import { assertLosslessOntologyDraft } from "./ontology-draft-integrity.mjs";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";

const ACCEPTED_STATUSES=new Set(["auto_confirmed","confirmed"]);

export function createOntologyDomainDraftService({store,candidates,semanticSchemas}={}) {
  if(!store||!candidates||!semanticSchemas?.validate)throw new Error("全域草稿服务缺少依赖");

  function inspect(orchestrationId) {
    const id=String(orchestrationId||"").trim();
    const task=store.getTask(id);
    if(!task||task.taskType!=="ontology_domain_modeling")throw httpError(404,"全域建模任务不存在");
    const allRuns=store.listOntologyGenerationRuns(task.sourceId,500).filter((run)=>run.scope?.orchestrationId===id);
    const declared=Array.isArray(task.result?.domains)?task.result.domains:[];
    const domainDefinitions=declared.length?declared.map((item,index)=>({
      id:String(item.domainId||item.runId||`domain-${index+1}`),name:String(item.domainName||`业务域 ${index+1}`),declared:item,
    })):uniqueDomains(allRuns);
    const domains=domainDefinitions.map((definition)=>{
      const matching=allRuns.filter((run)=>String(run.scope?.domainPlanId||run.id)===definition.id).sort(newestFirst);
      const succeeded=matching.find((run)=>run.status==="succeeded")||null;
      const active=matching.find((run)=>["queued","running"].includes(run.status))||null;
      const latest=matching[0]||null;
      return {
        id:definition.id,name:succeeded?.scope?.domainName||active?.scope?.domainName||latest?.scope?.domainName||definition.name,
        status:succeeded?"succeeded":active?active.status:"failed",run:succeeded,activeRun:active,
        error:succeeded?null:active?null:latest?.error||definition.declared?.error||"该域尚未成功生成",
      };
    });
    const selectedRuns=domains.map((domain)=>domain.run).filter(Boolean);
    const runCandidates=new Map(selectedRuns.map((run)=>[run.id,store.listOntologyCandidates({runId:run.id,limit:2000})]));
    const allCandidates=selectedRuns.flatMap((run)=>runCandidates.get(run.id)||[]);
    const statusCount=(status)=>allCandidates.filter((candidate)=>status.includes(candidate.status)).length;
    const acceptedCount=statusCount([...ACCEPTED_STATUSES]);
    const reviewRequiredCount=statusCount(["review_required"]);
    const appliedCount=statusCount(["applied"]);
    const failedDomains=domains.filter((domain)=>domain.status==="failed");
    const activeDomains=domains.filter((domain)=>["queued","running"].includes(domain.status));
    const catalogCurrent=selectedRuns.every((run)=>candidates.getRun(run.id).catalogCurrent!==false);
    const nextReviewRun=selectedRuns.map((run)=>({run,pending:(runCandidates.get(run.id)||[]).filter((candidate)=>candidate.status==="review_required").length})).find((item)=>item.pending>0)||null;
    const appliedDraftIds=[...new Set(allCandidates.map((candidate)=>Number(candidate.appliedSchemaVersionId)).filter((value)=>Number.isInteger(value)&&value>0))];
    const draftSchemaVersionId=appliedDraftIds.length===1?appliedDraftIds[0]:null;
    const draftRecord=draftSchemaVersionId?store.getOntologySchemaVersion(draftSchemaVersionId):null;
    const sourceActiveTask=store.findActiveTask(task.sourceId,"ontology_domain_modeling");
    const activeTask=["queued","running"].includes(task.status)?task:sourceActiveTask?.payload?.orchestrationId===id?sourceActiveTask:null;
    const readyForDraft=task.status==="succeeded"&&!draftSchemaVersionId&&!activeTask&&!failedDomains.length&&!activeDomains.length&&catalogCurrent&&reviewRequiredCount===0&&acceptedCount>0;
    const summary={
      orchestrationId:id,sourceId:task.sourceId,taskStatus:task.status,
      domainCount:domains.length,succeededDomainCount:selectedRuns.length,failedDomainCount:failedDomains.length,activeDomainCount:activeDomains.length,
      candidateCount:allCandidates.length,objectCount:allCandidates.filter((candidate)=>candidate.candidateType==="object").length,linkCount:allCandidates.filter((candidate)=>candidate.candidateType==="link").length,
      reviewRequiredCount,acceptedCount,appliedCount,blockedCount:statusCount(["blocked"]),rejectedCount:statusCount(["rejected","superseded"]),
      catalogCurrent,readyForDraft,baseSchemaVersionId:selectedRuns[0]?.baseSchemaVersionId??null,
      nextReviewRun:nextReviewRun?{id:nextReviewRun.run.id,domainName:nextReviewRun.run.scope?.domainName||"未命名业务域",pendingCount:nextReviewRun.pending}:null,
      failedDomains:failedDomains.map((domain)=>({domainId:domain.id,domainName:domain.name,error:domain.error})),
      activeTask:activeTask?{id:activeTask.id,status:activeTask.status,progress:activeTask.progress,total:activeTask.total,currentStep:activeTask.currentStep,updatedAt:activeTask.updatedAt}:null,
      draftSchemaVersionId,draftValidationOk:draftRecord?.validation?.ok??null,
      repairable:Boolean(draftRecord&&!draftRecord.validation?.ok&&!activeTask&&!activeDomains.length&&catalogCurrent&&appliedCount>0),
    };
    return {task,allRuns,domains,selectedRuns,runCandidates,allCandidates,summary};
  }

  function summary(orchestrationId) { return inspect(orchestrationId).summary; }

  function preview(orchestrationId,input={}) {
    const prepared=prepare(orchestrationId,input);
    assertDraftable(prepared.state.summary,input);
    return {schema:prepared.validation.schema,validation:withoutSchema(prepared.validation),diff:prepared.diff,conflicts:prepared.conflicts,excludedCandidateIds:prepared.excludedCandidateIds,summary:prepared.draftSummary,workflow:prepared.state.summary};
  }

  function apply(orchestrationId,input={},actor="system") {
    const prepared=prepare(orchestrationId,input);
    const workflow=prepared.state.summary;
    assertDraftable(workflow,input);
    if(prepared.draftSummary.unresolvedConflictCount)throw httpError(409,"仍有未处理的 Schema 冲突，请完成冲突选择并重新预览");
    if(!prepared.includedCandidates.length)throw httpError(409,"没有可应用的已确认候选");
    assertLosslessOntologyDraft(prepared.assembledSchema,prepared.validation);
    const compactValidation=withoutSchema(prepared.validation);const schema=prepared.validation.schema;
    const runIds=prepared.state.selectedRuns.map((run)=>run.id);
    const draft=store.createOntologyDraftWithCandidates({
      sourceId:workflow.sourceId,runId:runIds[0],runIds,baseSchemaVersionId:prepared.baseSchemaVersionId,
      expectedPublishedSchemaVersionId:prepared.expectedPublishedId,schemaName:schema.name||`source_${workflow.sourceId}`,
      schema,checksum:createHash("sha256").update(JSON.stringify(schema)).digest("hex"),validation:compactValidation,
      createdBy:String(actor||"system"),candidateIds:prepared.includedCandidates.map((candidate)=>candidate.id),
    });
    return {draft:{...draft,validation:compactValidation},validation:compactValidation,diff:prepared.diff,conflicts:prepared.conflicts,excludedCandidateIds:prepared.excludedCandidateIds,summary:prepared.draftSummary,workflow:{...workflow,draftSchemaVersionId:draft.id,readyForDraft:false},partial:workflow.failedDomainCount>0};
  }

  function repair(orchestrationId,actor="system") {
    const state=inspect(orchestrationId);const repairDraftId=state.summary.draftSchemaVersionId;
    if(!repairDraftId)throw httpError(409,"当前全域任务没有可修复的已生成草稿");
    const previous=store.getOntologySchemaVersion(repairDraftId);
    if(!previous)throw httpError(404,"待修复草稿不存在");
    if(previous.validation?.ok)return {draft:previous,validation:previous.validation,repairedFromVersionId:previous.id,reused:true};
    if(!state.summary.repairable)throw httpError(409,"当前草稿暂不可修复，请等待任务完成并确认物理目录未变化");
    const prepared=prepare(orchestrationId,{}, {repairDraftId});
    if(prepared.draftSummary.unresolvedConflictCount)throw httpError(409,"重建草稿仍存在未处理的候选冲突");
    assertLosslessOntologyDraft(prepared.assembledSchema,prepared.validation);
    if(!prepared.validation.ok)throw httpError(422,`重建后的 Schema 仍有 ${prepared.validation.errors.length} 个结构错误：${prepared.validation.errors[0]?.message||"校验失败"}`);
    const compactValidation=withoutSchema(prepared.validation);const schema=prepared.validation.schema;
    const runIds=prepared.state.selectedRuns.map((run)=>run.id);
    const draft=store.createOntologyDraftWithCandidates({
      sourceId:state.summary.sourceId,runId:runIds[0],runIds,baseSchemaVersionId:prepared.baseSchemaVersionId,
      expectedPublishedSchemaVersionId:prepared.expectedPublishedId,repairFromSchemaVersionId:repairDraftId,
      schemaName:schema.name||`source_${state.summary.sourceId}`,schema,checksum:createHash("sha256").update(JSON.stringify(schema)).digest("hex"),validation:compactValidation,
      createdBy:String(actor||"system"),candidateIds:prepared.includedCandidates.map((candidate)=>candidate.id),
    });
    return {draft:{...draft,validation:compactValidation},validation:compactValidation,diff:prepared.diff,summary:prepared.draftSummary,repairedFromVersionId:previous.id,reused:false};
  }

  function failedDomainIds(orchestrationId) { return inspect(orchestrationId).summary.failedDomains.map((domain)=>domain.domainId); }

  function prepare(orchestrationId,input,options={}) {
    const state=inspect(orchestrationId);const runs=state.selectedRuns;
    if(!runs.length)throw httpError(409,"全域任务还没有可合并的成功批次");
    const baseIds=[...new Set(runs.map((run)=>run.baseSchemaVersionId??null))];
    const publishedIds=[...new Set(runs.map((run)=>run.scope?.publishedSchemaVersionIdAtStart??null))];
    if(baseIds.length!==1||publishedIds.length!==1)throw httpError(409,"业务域批次的基础版本不一致，请基于最新版本重新建模");
    const baseSchemaVersionId=baseIds[0];const expectedPublishedId=publishedIds[0];
    const published=store.getPublishedOntologySchema(state.task.sourceId);
    if((published?.id||null)!==expectedPublishedId)throw httpError(409,"当前发布 Schema 已变化，请基于最新版本重新生成全域任务");
    const base=baseSchemaVersionId==null?null:store.getOntologySchemaVersion(baseSchemaVersionId);
    if(baseSchemaVersionId!=null&&(!base||base.sourceId!==state.task.sourceId))throw httpError(409,"基础 Schema 版本不存在或不属于当前数据源");
    for(const run of runs)if(candidates.getRun(run.id).catalogCurrent===false)throw httpError(409,`业务域「${run.scope?.domainName||run.id}」目录已过期，请重新生成`);
    const allCandidateIds=new Set(state.allCandidates.map((candidate)=>candidate.id));
    const excludedCandidateIds=normalizeCandidateIdList(input?.excludeCandidateIds);const unknownExcluded=excludedCandidateIds.filter((id)=>!allCandidateIds.has(id));
    if(unknownExcluded.length)throw httpError(400,`排除列表包含不属于当前全域任务的候选：${unknownExcluded.join("、")}`);
    const conflictResolutions=normalizeConflictResolutions(input?.conflictResolutions);const unknownResolved=Object.keys(conflictResolutions).filter((id)=>!allCandidateIds.has(id));
    if(unknownResolved.length)throw httpError(400,`冲突处理包含不属于当前全域任务的候选：${unknownResolved.join("、")}`);
    const source=store.getSource(state.task.sourceId);
    const emptySchema={name:`source_${state.task.sourceId}_ontology`,displayName:`${source?.name||"数据源"}业务本体`,description:"由全域自动建模汇总生成。",objectTypes:[],linkTypes:[]};
    const originalBase=base?.schema||emptySchema;let schema=structuredClone(originalBase);const includedCandidates=[];const conflicts=[];let renamedLinkCount=0;
    for(const run of runs) {
      const runItems=state.runCandidates.get(run.id)||[];
      const eligibleItems=options.repairDraftId?runItems.filter((candidate)=>(candidate.status==="applied"&&Number(candidate.appliedSchemaVersionId)===Number(options.repairDraftId))||ACCEPTED_STATUSES.has(candidate.status)):runItems;
      const repairResolutions=options.repairDraftId?Object.fromEntries(eligibleItems.map((candidate)=>[candidate.id,candidate.status==="applied"?"use_candidate":"keep_existing"])):conflictResolutions;
      const assembled=assembleOntologyDraft({run,candidates:eligibleItems,baseSchema:schema,excludeCandidateIds:excludedCandidateIds,conflictResolutions:repairResolutions,...(options.repairDraftId?{applicableStatuses:new Set(["applied",...ACCEPTED_STATUSES])}:{})});
      schema=assembled.schema;includedCandidates.push(...assembled.includedCandidates);conflicts.push(...assembled.conflicts);renamedLinkCount+=assembled.renamedLinks?.length||0;
    }
    const validation=semanticSchemas.validate(state.task.sourceId,schema);const diff=diffSemanticSchemas(validation.schema,originalBase);
    const draftSummary={
      objectsAdded:Math.max(0,(validation.schema.objectTypes||[]).length-(originalBase.objectTypes||[]).length),
      propertiesAdded:Math.max(0,propertyCount(validation.schema.objectTypes)-propertyCount(originalBase.objectTypes)),
      linksAdded:Math.max(0,(validation.schema.linkTypes||[]).length-(originalBase.linkTypes||[]).length),
      candidateCount:includedCandidates.length,renamedLinkCount,conflictCount:conflicts.length,resolvedConflictCount:conflicts.filter((item)=>item.resolution!=="unresolved").length,
      unresolvedConflictCount:conflicts.filter((item)=>item.resolution==="unresolved").length,excludedCount:excludedCandidateIds.length,
    };
    return {state,baseSchemaVersionId,expectedPublishedId,includedCandidates,conflicts,excludedCandidateIds,assembledSchema:schema,validation,diff,draftSummary};
  }

  return {summary,preview,apply,repair,failedDomainIds};

  function assertDraftable(workflow,input) {
    if(workflow.activeTask)throw httpError(409,"全域建模或失败域重试仍在进行，请完成后再创建合并草稿");
    if(workflow.activeDomainCount)throw httpError(409,"仍有业务域正在生成，请完成后再创建合并草稿");
    if(workflow.failedDomainCount&&!input?.allowFailedDomains)throw httpError(409,`仍有 ${workflow.failedDomainCount} 个业务域失败；如需生成部分草稿，请明确允许跳过失败域`);
    if(workflow.reviewRequiredCount)throw httpError(409,`仍有 ${workflow.reviewRequiredCount} 个候选待审核，请完成集中审核`);
    if(!workflow.catalogCurrent)throw httpError(409,"部分批次的物理目录已变化，请重新生成后再合并");
  }
}

function uniqueDomains(runs) {
  const result=[];const seen=new Set();
  for(const run of [...runs].sort(oldestFirst)){const id=String(run.scope?.domainPlanId||run.id);if(seen.has(id))continue;seen.add(id);result.push({id,name:run.scope?.domainName||"未命名业务域",declared:null});}
  return result;
}
function newestFirst(left,right){return String(right.createdAt).localeCompare(String(left.createdAt))||String(right.id).localeCompare(String(left.id));}
function oldestFirst(left,right){return -newestFirst(left,right);}
function propertyCount(objects){return (objects||[]).reduce((sum,object)=>sum+(object?.properties?.length||0),0);}
function normalizeCandidateIdList(value){if(value==null)return [];if(!Array.isArray(value))throw httpError(400,"excludeCandidateIds 必须是数组");return [...new Set(value.map((item)=>String(item).trim()).filter(Boolean))];}
function normalizeConflictResolutions(value){if(value==null)return {};if(!value||typeof value!=="object"||Array.isArray(value))throw httpError(400,"conflictResolutions 必须是对象");const result={};for(const [id,resolution] of Object.entries(value)){if(!["keep_existing","use_candidate"].includes(resolution))throw httpError(400,`候选 ${id} 的冲突处理值无效`);result[String(id)]=resolution;}return result;}
function withoutSchema(validation){return {ok:validation.ok,errors:validation.errors,warnings:validation.warnings,summary:validation.summary};}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
