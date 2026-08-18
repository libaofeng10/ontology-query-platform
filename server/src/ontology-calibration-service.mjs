import { randomUUID } from "node:crypto";
import { inspectSemanticEvalGate } from "./evaluation-evidence.mjs";
import { ontologyCatalogChecksum } from "./ontology-candidate-service.mjs";

const LABEL_VERDICTS=new Set(["correct","incorrect"]);
const ISSUE_TYPES=new Set(["physical_mapping","sensitive_mapping","unconfirmed_join","duplicate","semantic","missing_object","other"]);
const CALIBRATABLE_STATUSES=new Set(["auto_confirmed","confirmed","rejected","superseded","applied"]);

export function createOntologyCalibrationService({store,config,settings}={}) {
  if(!store)throw new Error("ontology calibration service 需要 store");

  function selectRuns(sourceId,inputRunIds,catalogCache) {
    const all=store.listOntologyGenerationRuns(sourceId,500);const requested=Array.isArray(inputRunIds)?[...new Set(inputRunIds.map((item)=>String(item).trim()).filter(Boolean))]:[];
    if(requested.length){const byId=new Map(all.map((run)=>[run.id,run]));const missing=requested.filter((id)=>!byId.has(id));if(missing.length)throw httpError(400,`校准批次不存在或不属于当前数据源：${missing.join("、")}`);const runs=requested.map((id)=>byId.get(id));if(new Set(runs.map((run)=>run.scoringVersion)).size>1||new Set(runs.map((run)=>run.promptVersion)).size>1)throw httpError(400,"校准批次必须使用相同 scoringVersion 和 promptVersion，v1/v2 不可混算");return {runs,excludedStaleRuns:0};}
    const completed=all.filter((run)=>["succeeded","failed"].includes(run.status));const current=completed.filter((run)=>runCatalogIsCurrent(run,catalogCache));
    const reference=current[0]||completed[0];
    if(!reference)return {runs:[],excludedStaleRuns:0};
    const compatible=completed.filter((run)=>run.scoringVersion===reference.scoringVersion&&run.promptVersion===reference.promptVersion);
    const runs=compatible.filter((run)=>runCatalogIsCurrent(run,catalogCache));
    return {runs,excludedStaleRuns:compatible.length-runs.length};
  }

  function runCatalogIsCurrent(run,catalogCache=new Map()) {
    const selected=new Set(run?.scope?.tableNames||[]);
    const cacheKey=`${run.sourceId}:${[...selected].sort().join("\u0000")}`;
    if(catalogCache.has(cacheKey))return catalogCache.get(cacheKey)===run.catalogChecksum;
    const tables=store.listTables(run.sourceId).filter((table)=>selected.has(table.tableName));
    const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(run.sourceId,table.tableName).map((column)=>config?.profiling?.enabled?column:{...column,profile:null})]));
    const enumsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listEnums(run.sourceId,table.tableName)]));
    const relations=store.listRelations(run.sourceId,false,true).filter((relation)=>selected.has(relation.fromTable)&&selected.has(relation.toTable));
    const checksum=ontologyCatalogChecksum({sourceId:run.sourceId,tables,columnsByTable,enumsByTable,relations});catalogCache.set(cacheKey,checksum);return checksum===run.catalogChecksum;
  }

  function resolveDraft(sourceId,inputId,candidates) {
    const appliedIds=[...new Set(candidates.map((candidate)=>Number(candidate.appliedSchemaVersionId)).filter((id)=>Number.isInteger(id)&&id>0))].sort((left,right)=>right-left);
    const id=inputId==null?(appliedIds[0]||null):Number(inputId);
    if(id==null)return null;
    const draft=store.getOntologySchemaVersion(id);
    if(!draft||draft.sourceId!==sourceId)throw httpError(400,"校准草稿不存在或不属于当前数据源");
    return draft;
  }

  function evalGateEvidence(sourceId,gate,draft) {
    const cases=gate?store.listEvalCasesForRun(sourceId,gate.setName):[];
    return inspectSemanticEvalGate(gate,{sourceId,schemaVersion:draft?.version,schemaPublishedAt:draft?.publishedAt,requirePostPublish:true,cases});
  }

  function resolveEvalGate(sourceId,inputId,draft) {
    if(inputId!=null){const gate=store.getEvalGate(String(inputId));if(!gate||gate.sourceId!==sourceId)throw httpError(400,"Gold SQL 门禁不存在或不属于当前数据源");return gate;}
    if(!draft)return null;
    const matching=store.listEvalGates(sourceId,100).filter((gate)=>Number(gate.ontologySchemaVersion)===Number(draft.version));
    return matching.find((gate)=>evalGateEvidence(sourceId,gate,draft).valid)||matching[0]||null;
  }

  function label(candidateId,input,actor) {
    const candidate=store.getOntologyCandidate(candidateId);
    if(!candidate)throw httpError(404,"候选不存在");
    const run=store.getOntologyGenerationRun(candidate.runId);
    if(!run||!runCatalogIsCurrent(run))throw httpError(409,"候选所属批次的物理目录已变化，请重新生成后再进行校准双检");
    if(!CALIBRATABLE_STATUSES.has(candidate.status))throw httpError(409,"候选必须先完成首轮审核或自动确认，才能进行独立校准双检");
    const labeler=String(actor||"system").trim()||"system";
    if(candidate.reviewedBy&&sameActor(candidate.reviewedBy,labeler))throw httpError(409,"独立校准双检必须由不同于首轮审核人的身份完成");
    const verdict=String(input?.verdict||"").trim().toLowerCase();
    if(!LABEL_VERDICTS.has(verdict))throw httpError(400,"verdict 必须是 correct 或 incorrect");
    const majorModification=input?.majorModification===true;
    const issueType=input?.issueType==null||input.issueType===""?null:String(input.issueType).trim().toLowerCase();
    if(issueType&&!ISSUE_TYPES.has(issueType))throw httpError(400,`issueType 必须是 ${[...ISSUE_TYPES].join("、")} 之一`);
    if(verdict==="correct"&&(majorModification||issueType))throw httpError(400,"准确候选不能同时标记大幅修改或错误类型");
    return store.recordOntologyCandidateCalibration({candidateId:candidate.id,verdict,majorModification,issueType,note:cleanNote(input?.note),actor:labeler});
  }

  function report(sourceId,input={}) {
    const source=store.getSource(Number(sourceId));
    if(!source)throw httpError(404,"数据源不存在");
    const catalogCache=new Map();const selected=selectRuns(source.id,input.runIds,catalogCache);const runs=selected.runs;const staleRunIds=runs.filter((run)=>!runCatalogIsCurrent(run,catalogCache)).map((run)=>run.id);const staleRunIdSet=new Set(staleRunIds);
    const runIds=runs.map((run)=>run.id);const selectedRunIds=new Set(runIds);
    const candidates=store.listOntologyCandidates({sourceId:source.id,limit:2000}).filter((candidate)=>selectedRunIds.has(candidate.runId));
    const explicitLabels=new Map(store.listOntologyCandidateCalibrationLabels(source.id).filter((item)=>selectedRunIds.has(item.runId)&&!staleRunIdSet.has(item.runId)).map((item)=>[item.candidateId,item]));
    const labels=[];const invalidLabels=[];const originalCandidates=new Map();const mergedCandidates=new Set();const editedCandidates=new Set();const withdrawnCandidates=new Set();
    for(const candidate of candidates){const events=store.listOntologyCandidateEvents(candidate.id);const original=events.find((event)=>event.eventType==="auto_route")?.after||candidate;originalCandidates.set(candidate.id,original);if(events.some((event)=>event.eventType==="merged"))mergedCandidates.add(candidate.id);if(events.some((event)=>event.eventType==="edited_and_confirmed"))editedCandidates.add(candidate.id);if(events.some((event)=>event.eventType==="withdrawn"))withdrawnCandidates.add(candidate.id);const explicit=explicitLabels.get(candidate.id);if(explicit){const normalized={...explicit,candidateId:candidate.id,runId:candidate.runId,sourceId:candidate.sourceId};if(calibrationLabelIsIndependent(candidate,normalized))labels.push(normalized);else invalidLabels.push(normalized);}}
    const labelByCandidate=new Map(labels.map((item)=>[item.candidateId,item]));
    const globalAutoThreshold=boundedInteger(config?.ontologyAi?.autoConfirmScore,0,100,80);const sourceSetting=store.getSourceOntologySetting?.(source.id)||null;const autoThreshold=boundedInteger(sourceSetting?.autoConfirmScore,0,100,globalAutoThreshold);
    const autoEligible=candidates.filter((candidate)=>wouldAutoConfirm(originalCandidates.get(candidate.id),autoThreshold));
    const labeledAuto=autoEligible.filter((candidate)=>labelByCandidate.has(candidate.id));
    const correctAuto=labeledAuto.filter((candidate)=>{const item=labelByCandidate.get(candidate.id);return item.verdict==="correct"&&!item.majorModification;});
    const precision=labeledAuto.length?correctAuto.length/labeledAuto.length:null;
    const autoWithdrawnCount=autoEligible.filter((candidate)=>withdrawnCandidates.has(candidate.id)).length;const autoWithdrawnRate=autoEligible.length?autoWithdrawnCount/autoEligible.length:0;
    const relations=new Map(store.listRelations(source.id,false,true).map((relation)=>[Number(relation.id),relation]));
    const sensitiveColumns=new Set(store.listTables(source.id).flatMap((table)=>store.listColumns(source.id,table.tableName).filter((column)=>column.isSensitive).map((column)=>`${table.tableName}.${column.columnName}`)));
    const physicalMappingErrors=labeledAuto.filter((candidate)=>labelByCandidate.get(candidate.id)?.issueType==="physical_mapping").length;
    const sensitiveAutoConfirmed=autoEligible.filter((candidate)=>hasSensitiveMapping(originalCandidates.get(candidate.id),sensitiveColumns)).length;
    const unconfirmedJoinAutoConfirmed=autoEligible.filter((candidate)=>hasUnconfirmedJoin(originalCandidates.get(candidate.id),relations)).length;
    const duplicateCount=mergedCandidates.size;
    const duplicateRate=candidates.length?duplicateCount/candidates.length:0;
    const modifiedCount=editedCandidates.size;
    const humanModificationRate=labels.length?modifiedCount/labels.length:0;
    const majorModificationCount=labels.filter((item)=>item.majorModification).length;
    const majorModificationRate=labels.length?majorModificationCount/labels.length:0;
    const manualObjectCount=nonNegativeInteger(input.manualObjectCount,0,"manualObjectCount");
    const draft=resolveDraft(source.id,input.draftSchemaVersionId,candidates);
    const appliedDraftIds=[...new Set(candidates.map((candidate)=>Number(candidate.appliedSchemaVersionId)).filter((id)=>Number.isInteger(id)&&id>0))];const evidenceDraftIds=[...new Set([...appliedDraftIds,...(draft?.id?[draft.id]:[])])];const appliedDrafts=evidenceDraftIds.map((id)=>store.getOntologySchemaVersion(id)).filter(Boolean);const publishedDrafts=appliedDrafts.filter((item)=>item.status==="published");const validDrafts=appliedDrafts.filter((item)=>item.validation?.ok);
    const draftPublicationRate=appliedDrafts.length?publishedDrafts.length/appliedDrafts.length:null;const schemaValidationPassRate=appliedDrafts.length?validDrafts.length/appliedDrafts.length:null;const currentPublished=store.getPublishedOntologySchema(source.id);const draftPublishedCurrent=Boolean(draft&&draft.status==="published"&&currentPublished?.id===draft.id);
    const acceptedObjectCount=candidates.filter((candidate)=>candidate.candidateType==="object"&&["auto_confirmed","confirmed","applied"].includes(candidate.status)).length;
    const inferredFinal=draft?.validation?.summary?.objectTypes??acceptedObjectCount+manualObjectCount;
    const finalObjectCount=input.finalObjectCount==null?Number(inferredFinal||0):nonNegativeInteger(input.finalObjectCount,0,"finalObjectCount");
    const manualObjectRate=finalObjectCount?manualObjectCount/finalObjectCount:(manualObjectCount?1:0);
    const evalGate=resolveEvalGate(source.id,input.evalGateId,draft);const evalEvidence=evalGateEvidence(source.id,evalGate,draft);
    const evalSets=summarizeEvalSets(store.listEvalCases(source.id));
    const downstream={goldEquivalenceRate:numberOrNull(evalGate?.candidate?.passRate),semanticExecutionRate:numberOrNull(evalGate?.candidate?.semanticExecutionRate),joinFailureRate:numberOrNull(evalGate?.candidate?.joinFailureRate),draftsCreated:appliedDrafts.length,draftsPublished:publishedDrafts.length,draftPublicationRate,schemaValidationPassRate};
    const runtime=runtimeMetrics(runs);
    const thresholds=calibrationThresholds(config?.ontologyAi||{});
    const scoreBuckets=buildScoreBuckets(candidates,originalCandidates,labelByCandidate);
    const issueTypeSummary=[...ISSUE_TYPES].map((issueType)=>{const count=labels.filter((label)=>label.issueType===issueType).length;return {issueType,count,ratio:labels.length?count/labels.length:0};}).filter((item)=>item.count>0).sort((left,right)=>right.count-left.count||left.issueType.localeCompare(right.issueType));
    const ruleSuggestions=issueTypeSummary.filter((item)=>labels.length>=10&&item.ratio>=.2&&["unconfirmed_join","sensitive_mapping"].includes(item.issueType)).map((item)=>({issueType:item.issueType,sampleCount:labels.length,count:item.count,ratio:item.ratio,action:"ensure_forced_review",forcedReviewReason:item.issueType==="unconfirmed_join"?"JOIN_NOT_EXPLICIT_OR_MANUALLY_CONFIRMED":"SENSITIVE_FIELD_MAPPING",scorePenalty:item.issueType==="unconfirmed_join"?10:35}));
    const thresholdSuggestion=suggestAutoConfirmThreshold(candidates,originalCandidates,labelByCandidate,boundedRatio(input.targetPrecision,.9));
    const conditions=[
      condition("catalog_current","校准批次目录新鲜度",staleRunIds.length===0,staleRunIds.length,"= 0 个过期批次"),
      condition("sample_size","自动确认双检样本",labeledAuto.length>=thresholds.minSamples,labeledAuto.length,`>= ${thresholds.minSamples}`),
      condition("precision","自动确认准确率",precision!=null&&precision>=thresholds.minPrecision,precision,`>= ${percent(thresholds.minPrecision)}`),
      condition("physical_mapping","物理映射错误",physicalMappingErrors===0,physicalMappingErrors,"= 0"),
      condition("unconfirmed_join","未确认 JOIN 自动确认",unconfirmedJoinAutoConfirmed===0,unconfirmedJoinAutoConfirmed,"= 0"),
      condition("sensitive_mapping","敏感字段自动确认",sensitiveAutoConfirmed===0,sensitiveAutoConfirmed,"= 0"),
      condition("manual_recall","人工补录对象占比",finalObjectCount>0&&manualObjectRate<=thresholds.maxManualObjectRate,manualObjectRate,`<= ${percent(thresholds.maxManualObjectRate)}`),
      condition("schema_validation","草稿 Schema 校验",Boolean(draft?.validation?.ok),Boolean(draft?.validation?.ok),"通过"),
      condition("draft_published","试点 Schema 发布状态",draftPublishedCurrent,draftPublishedCurrent,"已发布且仍为当前版本"),
      condition("gold_sql","Gold SQL 等价门禁",evalEvidence.valid,evalEvidence.valid,"语义对照通过、绑定当前 Schema 且评测集未变化"),
      condition("failure_rate","生成失败率",runtime.failureRate<=thresholds.maxFailureRate,runtime.failureRate,`<= ${percent(thresholds.maxFailureRate)}`),
      condition("latency","模型调用 P95 延迟",runtime.callCount>0&&runtime.p95LatencyMs<=thresholds.maxP95LatencyMs,runtime.p95LatencyMs,`<= ${thresholds.maxP95LatencyMs}ms`),
      condition("tokens","批次平均 Token",runs.length>0&&runtime.averageTokens<=thresholds.maxAverageTokens,runtime.averageTokens,`<= ${thresholds.maxAverageTokens}`),
    ];
    const passed=conditions.every((item)=>item.passed);
    const failedConditions=conditions.filter((item)=>!item.passed).map((item)=>item.label);
    return {
      sourceId:source.id,runIds,scoringVersion:runs[0]?.scoringVersion||null,promptVersion:runs[0]?.promptVersion||null,
      mode:config?.ontologyAi?.mode||"off",autoConfirmScore:autoThreshold,autoConfirmScoreSource:sourceSetting?"source":"global",thresholds,
      counts:{runs:runs.length,staleRuns:staleRunIds.length,excludedStaleRuns:selected.excludedStaleRuns,candidates:candidates.length,objects:candidates.filter((item)=>item.candidateType==="object").length,links:candidates.filter((item)=>item.candidateType==="link").length,labels:labels.length,invalidLabels:invalidLabels.length,autoEligible:autoEligible.length,labeledAuto:labeledAuto.length,correctAuto:correctAuto.length,unlabeledAuto:autoEligible.length-labeledAuto.length,manualObjectCount,finalObjectCount},
      quality:{precision,physicalMappingErrors,sensitiveAutoConfirmed,unconfirmedJoinAutoConfirmed,autoWithdrawnCount,autoWithdrawnRate,duplicateCount,duplicateRate,modifiedCount,humanModificationRate,majorModificationCount,majorModificationRate,manualObjectRate},
      runtime,downstream,scoreBuckets,issueTypeSummary,ruleSuggestions,thresholdSuggestion,settingDraft:thresholdSuggestion.suggestedScore==null?null:{sourceId:source.id,autoConfirmScore:thresholdSuggestion.suggestedScore,runIds},sourceSetting:sourceSetting?{...sourceSetting,audit:store.listSourceOntologySettingAudit?.(source.id)||[]}:null,draft:{id:draft?.id||null,version:draft?.version||null,validationOk:Boolean(draft?.validation?.ok),publishedCurrent:draftPublishedCurrent},evalSets,evalGate:{id:evalGate?.id||null,passed:Boolean(evalGate?.passed),valid:evalEvidence.valid,setName:evalGate?.setName||null,ontologySchemaVersion:evalGate?.ontologySchemaVersion||null,ontologySchemaPublishedAt:evalGate?.ontologySchemaPublishedAt||null,evaluationChecksum:evalGate?.evaluationChecksum||null,currentEvaluationChecksum:evalEvidence.currentEvaluationChecksum,currentCaseCount:evalEvidence.currentCaseCount,issues:evalEvidence.issues},
      conditions,passed,decision:passed?"enable_auto_draft":"keep_review",reason:passed?"校准门禁全部通过，可以受控启用 auto_draft。":`继续保持 review：${failedConditions.join("、")}尚未满足。`,labels,
    };
  }

  function createGate(sourceId,input,actor) {
    const source=store.getSource(Number(sourceId));if(!source||source.isDemo)throw httpError(400,"校准门禁只能在已通过连接测试的真实数据源上创建");if(source.lastTestOk!==1)throw httpError(409,"真实数据源必须先通过只读连接测试");
    const result=report(sourceId,input);
    return store.saveOntologyCalibrationGate({id:randomUUID(),sourceId:result.sourceId,runIds:result.runIds,draftSchemaVersionId:result.draft.id,evalGateId:result.evalGate.id,manualObjectCount:result.counts.manualObjectCount,finalObjectCount:result.counts.finalObjectCount,metrics:result,passed:result.passed,decision:result.decision,reason:result.reason,createdBy:String(actor||"system")});
  }

  function activate(gateId,actor) {
    const gate=store.getOntologyCalibrationGate(gateId);
    if(!gate)throw httpError(404,"校准门禁不存在");
    if(!gate.passed)throw httpError(409,"校准门禁尚未通过，不能启用 auto_draft");
    const current=report(gate.sourceId,{runIds:gate.runIds,draftSchemaVersionId:gate.draftSchemaVersionId,evalGateId:gate.evalGateId,manualObjectCount:gate.manualObjectCount,finalObjectCount:gate.finalObjectCount});
    if(!current.passed)throw httpError(409,`门禁证据已变化：${current.reason}`);
    const updatedSettings=settings?.update?settings.update({ontologyAi:{mode:"auto_draft"}},String(actor||"system")):null;
    const activated=store.activateOntologyCalibrationGate(gate.id,String(actor||"system"));
    return {gate:activated,settings:updatedSettings};
  }

  function listGates(sourceId) { return store.listOntologyCalibrationGates(Number(sourceId)); }

  function adoptThreshold(sourceId,input,actor) {
    const result=report(sourceId,{runIds:input?.runIds,targetPrecision:input?.targetPrecision});const proposed=Number(input?.autoConfirmScore);
    if(result.thresholdSuggestion.suggestedScore==null)throw httpError(409,"当前标注样本无法给出满足目标 precision 的阈值建议");
    if(!Number.isInteger(proposed)||proposed!==result.thresholdSuggestion.suggestedScore)throw httpError(409,"提交阈值与当前校准建议不一致，请刷新报告后重试");
    return store.updateSourceOntologyAutoConfirmScore({sourceId:result.sourceId,autoConfirmScore:proposed,evidenceRunIds:result.runIds,actor:String(actor||"system")});
  }

  return {label,report,createGate,activate,listGates,adoptThreshold};
}

function wouldAutoConfirm(candidate,threshold) { return Boolean(candidate?.validation?.ok)&&Number(candidate?.score)>=threshold&&!(candidate?.forcedReviewReasons||[]).length; }
function calibrationLabelIsIndependent(candidate,label) { return CALIBRATABLE_STATUSES.has(candidate?.status)&&(!candidate?.reviewedBy||!sameActor(candidate.reviewedBy,label?.labeledBy)); }
function sameActor(left,right) { return String(left||"").trim().normalize("NFKC").toLocaleLowerCase()===String(right||"").trim().normalize("NFKC").toLocaleLowerCase(); }
function hasSensitiveMapping(candidate,sensitiveColumns) { return candidate?.candidateType==="object"&&(candidate.payload?.properties||[]).some((property)=>sensitiveColumns.has(`${property?.mapping?.table}.${property?.mapping?.column}`)); }
function hasUnconfirmedJoin(candidate,relations) { return candidate?.candidateType==="link"&&(candidate.payload?.relationMappings||[]).some((mapping)=>{const relation=relations.get(Number(mapping.relationId));return !relation||relation.inferenceSource!=="foreign_key"&&relation.status!=="confirmed";}); }

function runtimeMetrics(runs) {
  const calls=runs.flatMap((run)=>Array.isArray(run.summary?.modelCalls)?run.summary.modelCalls:[]);const durations=calls.map((call)=>Number(call.durationMs)).filter((value)=>Number.isFinite(value)&&value>=0).sort((left,right)=>left-right);
  const callFailures=calls.filter((call)=>call.error).length;const failedWithoutCalls=runs.filter((run)=>run.status==="failed"&&!(run.summary?.modelCalls||[]).length).length;const attempts=calls.length+failedWithoutCalls;const failures=callFailures+failedWithoutCalls;const totalTokens=runs.reduce((sum,run)=>sum+Number(run.tokenUsage?.totalTokens||0),0);
  return {callCount:calls.length,failures,failureRate:attempts?failures/attempts:0,totalTokens,averageTokens:runs.length?Math.round(totalTokens/runs.length):0,averageLatencyMs:durations.length?Math.round(durations.reduce((sum,value)=>sum+value,0)/durations.length):0,p95LatencyMs:percentile(durations,.95)};
}

function buildScoreBuckets(candidates,originalCandidates,labelByCandidate) {
  const buckets=[[0,59],[60,69],[70,79],[80,89],[90,100]];
  return buckets.map(([min,max])=>{const items=candidates.filter((candidate)=>{const score=Number(originalCandidates.get(candidate.id)?.score??candidate.score);return score>=min&&score<=max;});const labeled=items.filter((item)=>labelByCandidate.has(item.id));const accepted=labeled.filter((item)=>{const label=labelByCandidate.get(item.id);return label.verdict==="correct"&&!label.majorModification;});return {range:`${min}-${max}`,total:items.length,labeled:labeled.length,accepted:accepted.length,acceptanceRate:labeled.length?accepted.length/labeled.length:null};});
}

function suggestAutoConfirmThreshold(candidates,originalCandidates,labelByCandidate,targetPrecision) {
  const labeled=candidates.map((candidate)=>({candidate,original:originalCandidates.get(candidate.id)||candidate,label:labelByCandidate.get(candidate.id)})).filter((item)=>item.label&&item.original?.validation?.ok&&!(item.original?.forcedReviewReasons||[]).length);
  for(let threshold=0;threshold<=100;threshold++){const eligible=labeled.filter((item)=>Number(item.original.score)>=threshold);if(!eligible.length)continue;const correct=eligible.filter((item)=>item.label.verdict==="correct"&&!item.label.majorModification).length;const precision=correct/eligible.length;if(precision>=targetPrecision)return {targetPrecision,suggestedScore:threshold,labeledCount:eligible.length,correctCount:correct,precision};}
  return {targetPrecision,suggestedScore:null,labeledCount:0,correctCount:0,precision:null};
}

function summarizeEvalSets(cases) {
  const groups=new Map();
  for(const item of cases||[]){const setName=String(item.setName||"").trim();if(!setName)continue;const group=groups.get(setName)||{setName,total:0,goldCount:0,heldOutCount:0,ready:false};group.total++;if(item.hasGoldSql||item.goldSql)group.goldCount++;if(item.heldOut)group.heldOutCount++;groups.set(setName,group);}
  return [...groups.values()].map((group)=>({...group,ready:group.total>0&&group.goldCount===group.total})).sort((left,right)=>left.setName.localeCompare(right.setName));
}

function calibrationThresholds(config) { return {minSamples:boundedInteger(config.calibrationMinSamples,1,10_000,40),minPrecision:boundedRatio(config.calibrationMinPrecision,.95),maxManualObjectRate:boundedRatio(config.maxManualObjectRate,.2),maxFailureRate:boundedRatio(config.maxFailureRate,.05),maxP95LatencyMs:boundedInteger(config.maxP95LatencyMs,1_000,600_000,90_000),maxAverageTokens:boundedInteger(config.maxAverageTokens,1,10_000_000,50_000)}; }
function condition(id,label,passed,actual,target) { return {id,label,passed:Boolean(passed),actual,target}; }
function percentile(values,ratio) { if(!values.length)return 0;return values[Math.min(values.length-1,Math.max(0,Math.ceil(values.length*ratio)-1))]; }
function percent(value) { return `${Math.round(Number(value)*10000)/100}%`; }
function numberOrNull(value) { const number=Number(value);return Number.isFinite(number)?number:null; }
function boundedRatio(value,fallback) { const number=Number(value);return Number.isFinite(number)&&number>=0&&number<=1?number:fallback; }
function boundedInteger(value,min,max,fallback) { const number=Number(value);return Number.isInteger(number)&&number>=min&&number<=max?number:fallback; }
function nonNegativeInteger(value,fallback,key) { if(value==null||value==="")return fallback;const number=Number(value);if(!Number.isInteger(number)||number<0)throw httpError(400,`${key} 必须是非负整数`);return number; }
function cleanNote(value) { const note=String(value||"").trim();return note?note.slice(0,1000):null; }
function httpError(status,message) { const error=new Error(message);error.status=status;return error; }
