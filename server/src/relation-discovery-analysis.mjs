import { generateRelationCandidates } from "./relation-candidates.mjs";
import { sampleRelationEvidence } from "./relation-data-evidence.mjs";
import { relationKey, reverseRelation } from "./physical-relation.mjs";

// The only discovery entry point: proposals, validation, bounded data probes, judgement,
// and one evidence-driven revision. Neither proposing nor judging confirms a JOIN.
export async function analyzeRelationCandidates({schema,eligibleTableNames,model,connector,source,config={},knowledgePages=[],explicitKeys=new Set(),onProgress=()=>{}}){
  const started=Date.now();
  const maxCandidates=Math.max(1,Math.min(600,Number(config.maxCandidates)||600));
  const proposal=typeof model.propose==="function"&&config.proposalsEnabled!==false
    ?await model.propose({schema,eligibleTableNames,maxCandidates:Math.max(1,Math.floor(maxCandidates/4)),maxBatches:config.maxProposalBatches||12,onProgress})
    :{status:"disabled",candidates:[],error:null};
  const allowed=candidate=>!explicitKeys.has(candidate.key);
  const rules=generateRelationCandidates({schema,eligibleTableNames,maxCandidates}).filter(allowed);
  const keys=new Set(rules.map(candidate=>candidate.key));
  const proposed=(proposal.candidates||[]).filter(allowed).filter(candidate=>!keys.has(candidate.key));
  let candidates=[...rules.slice(0,maxCandidates-Math.min(maxCandidates,proposed.length)),...proposed].slice(0,maxCandidates);
  const seen=new Set();
  candidates=candidates.filter(candidate=>{
    const physical={fromTable:candidate.from.tableName,toTable:candidate.to.tableName,columnPairs:candidate.columnPairs};
    const reverse=relationKey(reverseRelation(physical));
    if(seen.has(candidate.key)||seen.has(reverse))return false;seen.add(candidate.key);return true;
  });
  const enrich=side=>({...side,profile:schema.columns.find(column=>column.tableName===side.tableName&&column.columnName===side.columnName)?.profile||null,
    columns:(side.columnNames||[side.columnName]).map(name=>schema.columns.find(column=>column.tableName===side.tableName&&column.columnName===name)).filter(Boolean)});
  candidates=candidates.map(candidate=>({...candidate,from:enrich(candidate.from),to:enrich(candidate.to)}));
  let queryCount=0;
  const probe=async(candidate,round)=>{
    const evidence=await sampleRelationEvidence(connector,source,candidate.from,candidate.to,Math.min(2000,(Number(config.sampleLimit)||500)*(round?2:1)),{
      timeoutMs:config.overlapTimeoutMs||10_000,stratify:config.stratifiedSampling!==false,columns:schema.columns,maxQueries:config.maxProbeQueries||4,round,
    });
    queryCount+=evidence.queryCount||0;return evidence;
  };
  candidates=await mapLimit(candidates,config.overlapConcurrency||4,async candidate=>{const dataEvidence=await probe(candidate,0);return {...candidate,dataEvidence,overlapRatio:dataEvidence.matchRatio};});
  let result=await model.judge(candidates,{knowledgePages,onProgress});
  const usages=[proposal.usage,result.usage];
  const decisions=new Map(result.decisions.map(decision=>[decision.candidateId,decision]));
  const minConfidence=Number(config.minConfidence)||.55;
  const needsEvidence=candidates.filter(candidate=>{
    const decision=decisions.get(candidate.id);
    return decision&&(decision.decision==="uncertain"||decision.confidence<minConfidence||candidate.dataEvidence.status!=="sampled");
  });
  const selected=needsEvidence.slice(0,Math.max(0,Math.min(100,config.maxResampleCandidates??40)));
  if(selected.length){
    onProgress({completed:0,total:selected.length,current:`为 ${selected.length} 条证据不足的关系补采样并复核`});
    const revised=await mapLimit(selected,config.overlapConcurrency||4,async candidate=>{
      const evidence=await probe(candidate,1);
      const dataEvidence={...evidence,history:[{...candidate.dataEvidence,decision:decisions.get(candidate.id)}]};
      Object.assign(candidate,{dataEvidence,overlapRatio:dataEvidence.matchRatio});return candidate;
    });
    const review=await model.judge(revised,{knowledgePages,onProgress});
    usages.push(review.usage);
    for(const decision of review.decisions)decisions.set(decision.candidateId,decision);
    if(review.status!=="completed")result={...result,status:result.decisions.length?"partial":result.status,error:[result.error,review.error||"补采样复核未完成"].filter(Boolean).join("；")};
  }
  const errors=[result.error,proposal.error,needsEvidence.length>selected.length?`${needsEvidence.length-selected.length} 条关系尚待补采样（预算限制）`:null].filter(Boolean);
  const incomplete=!["completed","disabled"].includes(proposal.status)||needsEvidence.length>selected.length;
  return {candidates,modelResult:{...result,decisions:[...decisions.values()],status:incomplete&&result.status==="completed"?"partial":result.status,error:errors.join("；")||null},
    diagnostics:{proposal:{...proposal,candidates:undefined,candidateCount:proposal.candidates?.length||0},usage:Object.fromEntries(["calls","reportedCalls","promptTokens","completionTokens","totalTokens"].map(key=>[key,usages.reduce((sum,usage)=>sum+(Number(usage?.[key])||0),0)])),ruleCandidateCount:rules.length,proposalCandidateCount:proposed.length,resampledCount:selected.length,pendingResampleCount:needsEvidence.length-selected.length,queryCount,elapsedMs:Date.now()-started}};
}

async function mapLimit(items,limit,mapper){const result=new Array(items.length);let next=0;await Promise.all(Array.from({length:Math.min(items.length,Math.max(1,Math.min(16,Number(limit)||4)))},async()=>{while(next<items.length){const index=next++;result[index]=await mapper(items[index]);}}));return result;}
