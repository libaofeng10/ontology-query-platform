import { generateRelationCandidates } from "./relation-candidates.mjs";
import { sampleRelationEvidence } from "./relation-data-evidence.mjs";
import { relationKey, reverseRelation } from "./physical-relation.mjs";
import { RELATION_CHECKPOINT_VERSION,addRelationUsage,assertRelationCheckpoint,needsRelationResample,relationCheckpointSummary,relationInputFingerprint } from "./relation-checkpoint.mjs";

// Discovery and evaluation share a durable pipeline. A continuation grants another
// bounded work window while retaining each candidate's completed evidence.
export async function analyzeRelationCandidates(input){
  const {schema,eligibleTableNames,model,connector,source,config={},knowledgePages=[],explicitKeys=new Set(),onProgress=()=>{},checkpoint=null,onCheckpoint=()=>{},runId=null}=input;
  const started=Date.now(),maxCandidates=Math.max(1,Math.min(600,Number(config.maxCandidates)||600));
  if(checkpoint)assertRelationCheckpoint(checkpoint,input);
  const state=checkpoint?structuredClone(checkpoint):{
    version:RELATION_CHECKPOINT_VERSION,fingerprint:relationInputFingerprint(input),runId,
    createdAt:new Date().toISOString(),candidates:[],decisions:{},reviewed:[],
    minConfidence:Number(config.minConfidence)||.55,usage:addRelationUsage(),queryCount:0,elapsedMs:0,
  };
  if(runId)state.runId=runId;
  const baseElapsed=state.elapsedMs,baseQueries=state.queryCount,baseUsage=state.usage;
  let writes=Promise.resolve();
  const save=()=>{
    state.updatedAt=new Date().toISOString();state.elapsedMs=baseElapsed+Date.now()-started;
    const snapshot=structuredClone(state);
    writes=writes.then(()=>onCheckpoint(snapshot));return writes;
  };
  await save();
  let proposal=state.proposal;
  if(!proposal||!["completed","disabled"].includes(proposal.status)){
    const usageBefore=state.usage;
    proposal=typeof model.propose==="function"&&config.proposalsEnabled!==false
      ?await model.propose({schema,eligibleTableNames,maxCandidates:Math.max(1,Math.floor(maxCandidates/4)),maxBatches:config.maxProposalBatches||12,onProgress,checkpoint:state.proposalCheckpoint,
        onCheckpoint:async value=>{state.proposalCheckpoint=value;state.usage=addRelationUsage(usageBefore,value.usage);await save();}})
      :{status:"disabled",candidates:[],error:null};
    state.usage=addRelationUsage(usageBefore,proposal.usage);state.proposal=proposal;await save();
  }
  const allowed=candidate=>!explicitKeys.has(candidate.key);
  const rules=generateRelationCandidates({schema,eligibleTableNames,maxCandidates}).filter(allowed);
  const ruleKeys=new Set(rules.map(candidate=>candidate.key));
  const proposed=(proposal.candidates||[]).filter(allowed).filter(candidate=>!ruleKeys.has(candidate.key));
  const seen=new Set(state.candidates.map(c=>physicalKey(c)));
  const enrich=side=>({...side,profile:schema.columns.find(c=>c.tableName===side.tableName&&c.columnName===side.columnName)?.profile||null,
    columns:(side.columnNames||[side.columnName]).map(name=>schema.columns.find(c=>c.tableName===side.tableName&&c.columnName===name)).filter(Boolean)});
  for(const candidate of [...rules,...proposed]){
    const key=physicalKey(candidate);if(seen.has(key))continue;seen.add(key);
    state.candidates.push({...candidate,from:enrich(candidate.from),to:enrich(candidate.to)});
  }
  await save();
  const reviewed=new Set(state.reviewed);
  const work=state.candidates.filter(c=>!state.decisions[c.id]||(c.dataEvidence?.history?!reviewed.has(c.id):needsRelationResample(c,state.decisions[c.id],state.minConfidence))).slice(0,maxCandidates);
  const probe=async(candidate,round)=>{
    const evidence=await sampleRelationEvidence(connector,source,candidate.from,candidate.to,Math.min(2000,(Number(config.sampleLimit)||500)*(round?2:1)),{
      timeoutMs:config.overlapTimeoutMs||10_000,stratify:config.stratifiedSampling!==false,columns:schema.columns,maxQueries:config.maxProbeQueries||4,round,
    });
    state.queryCount+=evidence.queryCount||0;
    candidate.dataEvidence=round?{...evidence,history:[{...candidate.dataEvidence,decision:state.decisions[candidate.id]}]}:evidence;
    candidate.overlapRatio=evidence.matchRatio;await save();
  };
  await mapLimit(work.filter(c=>!c.dataEvidence),config.overlapConcurrency||4,c=>probe(c,0));
  const errors=[];
  const judge=async(candidates,review=false)=>{
    if(!candidates.length)return;
    const ids=new Set(candidates.map(c=>c.id)),usageBefore=state.usage;
    const accept=async result=>{
      if(result.modelName)state.modelName=result.modelName;
      for(const decision of result.decisions||[])if(ids.has(decision.candidateId)){
        state.decisions[decision.candidateId]=decision;
        if(review)reviewed.add(decision.candidateId);
      }
      state.reviewed=[...reviewed];state.usage=addRelationUsage(usageBefore,result.usage);await save();
    };
    const result=await model.judge(candidates,{knowledgePages,onProgress,onBatch:accept});
    state.modelName=result.modelName||state.modelName||null;
    state.lastModelStatus=result.status;
    await accept(result);
    if(result.error)errors.push(result.error);
  };
  await judge(work.filter(c=>!state.decisions[c.id]));
  const needsEvidence=work.filter(c=>!c.dataEvidence?.history&&needsRelationResample(c,state.decisions[c.id],state.minConfidence));
  const selected=needsEvidence.slice(0,Math.max(0,Math.min(100,config.maxResampleCandidates??40)));
  if(selected.length)onProgress({completed:0,total:selected.length,current:`为 ${selected.length} 条证据不足的关系补采样并复核`});
  await mapLimit(selected,config.overlapConcurrency||4,c=>probe(c,1));
  await judge(work.filter(c=>c.dataEvidence?.history&&!reviewed.has(c.id)),true);
  const summary=relationCheckpointSummary(state);
  const incomplete=summary.hasPending||!["completed","disabled"].includes(proposal.status);
  const decisions=Object.values(state.decisions);
  const status=incomplete?(decisions.length?"partial":state.lastModelStatus||"failed"):"completed";
  if(proposal.error)errors.push(proposal.error);
  if(summary.pendingResampleCount)errors.push(`${summary.pendingResampleCount} 条关系尚待补采样（本轮预算限制，可继续）`);
  if(summary.pendingJudgmentCount)errors.push(`${summary.pendingJudgmentCount} 条关系尚待有效判断`);
  if(summary.pendingReviewCount)errors.push(`${summary.pendingReviewCount} 条关系已补采样，尚待复核`);
  state.status=status;await save();
  const proposalDiagnostics={...proposal};delete proposalDiagnostics.candidates;delete proposalDiagnostics.checkpoint;
  return {candidates:state.candidates,checkpoint:state,
    modelResult:{status,modelName:state.modelName||null,decisions,missingCandidateIds:state.candidates.filter(c=>!state.decisions[c.id]).map(c=>c.id),error:[...new Set(errors)].join("；")||null},
    diagnostics:{proposal:{...proposalDiagnostics,candidateCount:proposal.candidates?.length||0},usage:state.usage,
      ruleCandidateCount:rules.length,proposalCandidateCount:proposed.length,resampledCount:state.candidates.filter(c=>c.dataEvidence?.history).length,
      pendingResampleCount:summary.pendingResampleCount,pendingReviewCount:summary.pendingReviewCount,checkpoint:summary,
      queryCount:state.queryCount,elapsedMs:state.elapsedMs,
      thisRun:{queryCount:state.queryCount-baseQueries,resampledCount:selected.length,elapsedMs:Date.now()-started,usage:Object.fromEntries(Object.keys(state.usage).map(key=>[key,state.usage[key]-(baseUsage?.[key]||0)]))}}};
}

function physicalKey(candidate){const physical={fromTable:candidate.from.tableName,toTable:candidate.to.tableName,columnPairs:candidate.columnPairs};return [relationKey(physical),relationKey(reverseRelation(physical))].sort()[0];}
async function mapLimit(items,limit,mapper){
  let next=0,failure;
  // Drain in-flight workers after a save failure; no work escapes a failed run.
  await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,Math.min(16,Number(limit)||4)))},async()=>{
    while(!failure&&next<items.length){const item=items[next++];try{await mapper(item);}catch(error){failure=error;}}
  }));
  if(failure)throw failure;
}
