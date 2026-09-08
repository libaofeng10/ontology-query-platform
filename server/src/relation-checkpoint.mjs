import { createHash } from "node:crypto";
import { columnProfileForPrompt } from "./column-profile.mjs";

export const RELATION_CHECKPOINT_VERSION=1;
const MAX_AGE_MS=24*60*60*1000;
export const USAGE_KEYS=["calls","reportedCalls","promptTokens","completionTokens","totalTokens"];
export function addRelationUsage(...values){return Object.fromEntries(USAGE_KEYS.map(key=>[key,values.reduce((total,value)=>total+(Number(value?.[key])||0),0)]));}
export function checkpointHash(value){return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");}

// Credentials and volatile row estimates never become checkpoint identity fields.
export function relationInputFingerprint({schema,source={},eligibleTableNames,model,config={},knowledgePages=[],explicitKeys=new Set(),context={}}){
  const settings={...config};for(const key of ["maxProposalBatches","maxResampleCandidates","overlapConcurrency"])delete settings[key];
  return checkpointHash({version:RELATION_CHECKPOINT_VERSION,
    source:[source.id,source.host,source.port,source.dbName,source.userName],
    tables:schema.tables.map(t=>[t.tableName,t.comment||null]).sort(),
    columns:schema.columns.map(c=>[c.tableName,c.columnName,c.dataType,c.comment||null,c.nullable,c.isPrimary||0,c.isUnique||0,c.isIndexed||0,c.keyConstraints||[],columnProfileForPrompt(c.profile)]).sort(),
    eligible:[...(eligibleTableNames||schema.tables.map(t=>t.tableName))].sort(),explicit:[...explicitKeys].sort(),
    model:model?.identity||null,settings,context,
    knowledge:knowledgePages.filter(p=>p.verified).map(p=>[p.pageType,p.slug,p.title,p.tables,p.content,p.sqlContent]).sort(),
  });
}
export function assertRelationCheckpoint(state,input){
  if(!state||state.version!==RELATION_CHECKPOINT_VERSION||!Array.isArray(state.candidates)||!state.decisions||!Array.isArray(state.reviewed))throw new Error("关系检查点格式不兼容，请重新探查");
  const age=Date.now()-Date.parse(state.createdAt);
  if(!Number.isFinite(age)||age<0||age>MAX_AGE_MS)throw new Error("关系检查点已超过 24 小时有效期，请重新探查");
  if(state.fingerprint!==relationInputFingerprint(input))throw new Error("关系检查点的数据源、选表、结构、知识或模型/采样配置已变化，请重新探查");
}
export function needsRelationResample(candidate,decision,minConfidence=.55){return Boolean(decision&&(decision.decision==="uncertain"||decision.confidence<minConfidence||candidate.dataEvidence?.status!=="sampled"));}
export function relationCheckpointSummary(state){
  if(!state)return null;
  const candidates=state.candidates||[],decisions=state.decisions||{},reviewed=new Set(state.reviewed||[]);
  const pendingSampleCount=candidates.filter(c=>!c.dataEvidence).length;
  const pendingJudgmentCount=candidates.filter(c=>!decisions[c.id]).length;
  const pendingReviewCount=candidates.filter(c=>c.dataEvidence?.history&&!reviewed.has(c.id)).length;
  const pendingResampleCount=candidates.filter(c=>!c.dataEvidence?.history&&needsRelationResample(c,decisions[c.id],state.minConfidence)).length;
  const pendingProposalBatches=Math.max(0,(state.proposal?.plannedBatches||0)-(state.proposal?.completedBatches||0));
  const pendingProposalCandidates=state.proposal?.pendingCandidateCount||0;
  const pending=pendingSampleCount+pendingJudgmentCount+pendingReviewCount+pendingResampleCount+pendingProposalBatches+pendingProposalCandidates;
  const age=Date.now()-Date.parse(state.createdAt),expired=!Number.isFinite(age)||age>MAX_AGE_MS||age<0;
  return {version:state.version,createdAt:state.createdAt,updatedAt:state.updatedAt,expired,
    hasPending:pending>0||!state.proposal||!["completed","disabled"].includes(state.proposal.status),
    canResume:!expired&&(pending>0||!state.proposal||!["completed","disabled"].includes(state.proposal.status)&&!state.proposal.truncatedColumns),
    candidateCount:candidates.length,pendingSampleCount,pendingJudgmentCount,pendingResampleCount,pendingReviewCount,pendingProposalBatches,pendingProposalCandidates};
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
