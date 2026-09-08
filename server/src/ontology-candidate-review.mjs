import { createHash } from "node:crypto";
import { diffSemanticSchemas } from "./semantic-schema-diff.mjs";

const RISK_LABELS={
  MODIFIES_BASE_SCHEMA:"本次定义改变了已有本体，需要核对具体差异。",
  SENSITIVE_FIELD_MAPPING:"包含已标记为敏感的字段，请核对这些字段的业务用途。",
  EVIDENCE_CONFLICT:"现有依据存在冲突，需要明确采用的业务口径。",
  CATALOG_FIELDS_TRUNCATED:"生成时没有纳入全部字段，需要核对覆盖范围。",
  LOW_FIELD_COVERAGE:"当前定义覆盖的字段不足主表的一半，需要核对是否遗漏业务所需字段。",
  JOIN_NOT_EXPLICIT_OR_MANUALLY_CONFIRMED:"关联缺少明确的物理约束或已确认关系依据。",
  TEMPORAL_EVIDENCE_MISSING:"时间关系缺少两端时间字段的依据。",
  RELATION_KIND_EVIDENCE_MISMATCH:"业务关系类型与已有基数依据不一致。",
  TERM_BINDING_CONFLICT:"与已有术语绑定存在差异，需要核对业务含义。",
  SEMANTIC_CRITIC_FLAGGED:"业务语义检查发现了需要核实的问题。",
};

// Bind a decision to the definition, its evidence, policy, catalog and base version.
// Status/timestamps are excluded so the decision remains identifiable after commit.
export function candidateReviewChecksum(candidate,run,baseVersion) {
  return createHash("sha256").update(JSON.stringify(canonical({version:1,
    base:{id:baseVersion?.id??null,schema:baseVersion?.schema??null},
    run:{id:run.id,sourceId:run.sourceId,catalogChecksum:run.catalogChecksum,scope:run.scope,scoringVersion:run.scoringVersion},
    candidate:Object.fromEntries(["id","runId","sourceId","candidateType","stableKey","payload","evidence","validation","score","scoreBreakdown","forcedReviewReasons"].map(key=>[key,candidate[key]??null])),
  }))).digest("hex");
}

export function previousCandidateDefinition(candidate,baseVersion) {
  const items=candidate.candidateType==="object"?baseVersion?.schema?.objectTypes:baseVersion?.schema?.linkTypes;
  return items?.find(item=>item.apiName===candidate.payload?.apiName)||null;
}

export function candidateReviewIssue(candidate,run,baseVersion) {
  const name=candidate.payload?.displayName||candidate.payload?.apiName||"未命名定义";
  const tables=candidate.candidateType==="object"?[...new Set((candidate.payload?.properties||[]).map(p=>p.mapping?.table).filter(Boolean))]:run.scope.tableNames;
  const errors=candidate.validation?.errors||[];
  const reasons=[...new Set([...(candidate.forcedReviewReasons||[]).map(reason=>RISK_LABELS[reason]||"此定义需要专项审核。"),
    ...(candidate.evidence||[]).filter(e=>e.kind==="semantic_critic"&&e.issue).map(e=>String(e.issue).slice(0,1000)),
    ...(candidate.validation?.warnings||[]).map(item=>item.message),
  ])];
  const common={id:`candidate:${candidate.id}`,candidateType:candidate.candidateType,tables,candidateIds:[candidate.id],retryable:true,
    definitions:[{name,description:candidate.payload?.description||"",reasons:errors.length?errors.map(item=>item.message):reasons}],
  };
  if(candidate.status==="blocked"||!candidate.validation?.ok||errors.length)return {...common,kind:"validation",title:`「${name}」未通过结构校验`,
    detail:"请根据下列具体错误修正字段、标识或关联映射，再重试。补充业务说明和人工确认不能代替结构校验。"};
  const previous=previousCandidateDefinition(candidate,baseVersion),changes=previous?definitionDiff(candidate,previous):null;
  const changed=Boolean(previous&&(candidate.forcedReviewReasons||[]).includes("MODIFIES_BASE_SCHEMA"));
  const businessIssue=(candidate.forcedReviewReasons||[]).some(reason=>["SEMANTIC_CRITIC_FLAGGED","EVIDENCE_CONFLICT","TERM_BINDING_CONFLICT"].includes(reason));
  const threshold=run.scope.autoConfirmScore??85;
  return {...common,kind:"candidate_review",reviewKind:changed?"change":businessIssue?"business":"review",
    title:changed?`请确认「${name}」的定义变更`:businessIssue?`请核实「${name}」的业务口径`:`请审核「${name}」的候选定义`,
    detail:changed?"结构校验已通过。请查看与当前版本的差异，选择采用本次定义或保留已有定义；业务口径需要调整时可补充具体说明。":businessIssue?"结构校验已通过，但以下业务依据仍有疑点。请根据实际业务核实当前定义，或补充能解决这些疑点的说明。":`结构校验已通过，当前评分 ${candidate.score} 分，未自动确认（本批门槛 ${threshold} 分或采用人工审核模式）。请审核现有依据；低分本身不代表必须补写业务说明。`,
    reviewChecksum:candidateReviewChecksum(candidate,run,baseVersion),score:candidate.score,threshold,
    evidenceSummary:evidenceSummary(candidate),changes,
    comparison:previous?{baseVersion:baseVersion.version,previousName:previous.displayName||previous.apiName,
      previousPrimaryKey:previous.primaryKey??null,currentPrimaryKey:candidate.payload.primaryKey??null,
      previousFieldCount:previous.properties?.length??null,currentFieldCount:candidate.payload.properties?.length??null}:null,
    clarificationPrompt:businessIssue?reasons.join("；"):"请说明具体需要调整的内容，例如每行代表什么、统计周期、计量单位、有效范围或字段含义。",
    options:[{value:"use_candidate",label:changed?"采用本次定义":"确认当前定义"},
      ...(previous&&sameIdentity(candidate,previous)?[{value:"keep_existing",label:"保留已有定义"}]:[]),
      {value:"supplement_definition",label:"补充具体业务说明"}],
  };
}

function sameIdentity(candidate,previous) {
  if(candidate.candidateType==="object")return JSON.stringify(tables(previous))===JSON.stringify(tables(candidate.payload));
  return previous.source===candidate.payload.source&&previous.target===candidate.payload.target&&
    JSON.stringify(previous.relationMappings)===JSON.stringify(candidate.payload.relationMappings);
}
function tables(payload){return [...new Set((payload.properties||[]).map(p=>p.mapping?.table).filter(Boolean))].sort();}
function definitionDiff(candidate,previous) {
  const objects=candidate.candidateType==="object";
  const diff=diffSemanticSchemas({name:"review",objectTypes:objects?[candidate.payload]:[],linkTypes:objects?[]:[candidate.payload]},
    {name:"review",objectTypes:objects?[previous]:[],linkTypes:objects?[]:[previous]});
  for(const change of diff.changes)if(change.kind==="property"){
    const properties=change.change==="removed"?previous.properties:candidate.payload.properties;
    const property=properties?.find(p=>change.path===`objectTypes.${candidate.payload.apiName}.properties.${p.apiName}`);
    if(property)change.label=property.displayName?`${property.displayName}（${property.apiName}）`:property.apiName;
  }
  return diff;
}
function evidenceSummary(candidate) {
  const knowledge=(candidate.evidence||[]).filter(e=>e.verified===true&&["knowledge","knowledge_page","gold_sql","query","business_rule"].includes(e.kind||e.type));
  const result=["物理映射与标识/关联结构校验已通过",knowledge.length?`已绑定 ${knowledge.length} 条验证过的业务依据`:"尚未绑定验证过的业务知识、规则或标准查询"];
  if(candidate.scoreBreakdown?.semanticConsistency?.degradedReason)result.push("语义评分服务不可用，评分暂不完整；无需通过编写业务说明修复服务故障。");
  return result;
}
function canonical(value){if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==="object")return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));return value;}
