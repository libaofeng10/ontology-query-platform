import { createHash } from "node:crypto";
import { callLlmEmbedding } from "./embedding-client.mjs";
import { validateSemanticSchema } from "./semantic-schema.mjs";
import { detectSensitiveValue } from "./column-profile.mjs";

export const ONTOLOGY_CANDIDATE_SCORING_VERSION="ontology-candidate-v3";
export const ONTOLOGY_CANDIDATE_WEIGHTS=Object.freeze({
  physicalMapping:35,
  semanticConsistency:25,
  structuralEvidence:25,
  knowledgeEvidence:10,
  templateMatch:5,
});

const ACCEPTED_OBJECT_STATUSES=new Set(["auto_confirmed","confirmed","applied"]);
const CANDIDATE_TYPES=new Set(["object","link"]);
const TIME_TYPES=new Set(["date","datetime"]);

export function normalizeOntologyNamespace(value) {
  const original=String(value??"").trim().normalize("NFKC").toLowerCase();
  if(!original)return "default";
  const ascii=original.normalize("NFKD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
  if(ascii)return /^[a-z]/.test(ascii)?ascii:`domain_${ascii}`;
  return `domain_${createHash("sha256").update(original).digest("hex").slice(0,12)}`;
}

export function createObjectStableKey({namespace,payload,tableName}={}) {
  const tables=tableName?[String(tableName)]:mappedTables(payload);
  if(tables.length!==1)throw candidateError("ONTOLOGY_OBJECT_SINGLE_TABLE_REQUIRED","Object 候选必须且只能映射一张主表，才能生成 stableKey");
  return `object:${normalizeOntologyNamespace(namespace??payload?.namespace)}:${tables[0]}`;
}

export function createLinkStableKey({namespace,relation,relationId,sourceStableKey,targetStableKey,sourceTables=[],targetTables=[]}={}) {
  const id=Number(relationId??relation?.id);
  if(!Number.isInteger(id)||id<=0)throw candidateError("ONTOLOGY_RELATION_ID_INVALID","Link 候选必须绑定有效 relationId，才能生成 stableKey");
  if(!sourceStableKey||!targetStableKey)throw candidateError("ONTOLOGY_LINK_ENDPOINT_STABLE_KEY_REQUIRED","Link 候选的两个端点必须提供 stableKey");
  let from=String(sourceStableKey);let to=String(targetStableKey);
  const sourceSet=new Set(sourceTables);const targetSet=new Set(targetTables);
  if(relation&&sourceSet.has(relation.toTable)&&targetSet.has(relation.fromTable)) [from,to]=[to,from];
  else if(!relation||!(sourceSet.has(relation.fromTable)&&targetSet.has(relation.toTable))) [from,to]=[from,to].sort();
  return `link:${normalizeOntologyNamespace(namespace)}:${from}:${id}:${to}`;
}

export function createOntologyCandidateStableKey(candidate,context={}) {
  if(candidate?.candidateType==="object")return createObjectStableKey({namespace:candidate.namespace,payload:candidate.payload,tableName:candidate.mainTable});
  if(candidate?.candidateType!=="link")throw candidateError("ONTOLOGY_CANDIDATE_TYPE_INVALID","candidateType 必须是 object 或 link");
  const endpoints=findLinkEndpoints(candidate,context.acceptedObjects||[]);
  const relationId=firstRelationId(candidate.payload);
  const relation=(context.catalog?.relations||[]).find((item)=>Number(item.id)===relationId);
  return createLinkStableKey({
    namespace:candidate.namespace,
    relation,
    relationId,
    sourceStableKey:candidate.sourceStableKey||endpoints.source?.stableKey,
    targetStableKey:candidate.targetStableKey||endpoints.target?.stableKey,
    sourceTables:mappedTables(endpoints.source?.payload),
    targetTables:mappedTables(endpoints.target?.payload),
  });
}

export function scoreOntologyCandidate(candidate,options={}) {
  const catalog=options.catalog||{};
  const candidateType=String(candidate?.candidateType||"");
  const errors=[];const warnings=[];
  let schemaValidation={ok:false,schema:{objectTypes:[],linkTypes:[]},errors:[],warnings:[],summary:{objectTypes:0,properties:0,linkTypes:0,errorCount:0,warningCount:0}};
  let endpoints={};

  if(!CANDIDATE_TYPES.has(candidateType))errors.push(issue("ONTOLOGY_CANDIDATE_TYPE_INVALID","candidateType","candidateType 必须是 object 或 link"));
  else if(!isRecord(candidate.payload))errors.push(issue("ONTOLOGY_CANDIDATE_PAYLOAD_INVALID","payload","候选 payload 必须是 JSON 对象"));
  else if(candidateType==="object") {
    schemaValidation=validateSemanticSchema({name:"candidate_validation",objectTypes:[candidate.payload],linkTypes:[]},catalog);
    errors.push(...schemaValidation.errors);warnings.push(...schemaValidation.warnings);
    const tables=mappedTables(candidate.payload);
    if(tables.length>1)errors.push(issue("ONTOLOGY_OBJECT_MULTIPLE_TABLES","payload.properties","首期 Object 候选只允许映射一张物理表"));
    if(hasCrossSourceMapping(candidate.payload,candidate.sourceId))errors.push(issue("ONTOLOGY_CANDIDATE_CROSS_SOURCE_MAPPING","payload.properties","候选包含其他数据源的物理字段映射"));
  } else if(candidateType==="link") {
    endpoints=findLinkEndpoints(candidate,options.acceptedObjects||[]);
    if(!endpoints.source)errors.push(issue("ONTOLOGY_LINK_SOURCE_CANDIDATE_NOT_FOUND","payload.source","Link 源端点不是本批次已确认 Object 候选"));
    if(!endpoints.target)errors.push(issue("ONTOLOGY_LINK_TARGET_CANDIDATE_NOT_FOUND","payload.target","Link 目标端点不是本批次已确认 Object 候选"));
    for(const endpoint of [endpoints.source,endpoints.target].filter(Boolean)) {
      if(!ACCEPTED_OBJECT_STATUSES.has(endpoint.status))errors.push(issue("ONTOLOGY_LINK_ENDPOINT_NOT_CONFIRMED","payload","Link 端点必须先完成确认"));
      if(Number(endpoint.sourceId)!==Number(candidate.sourceId))errors.push(issue("ONTOLOGY_CANDIDATE_CROSS_SOURCE_MAPPING","payload","Link 端点与候选不属于同一数据源"));
    }
    if(endpoints.source&&endpoints.target) {
      schemaValidation=validateSemanticSchema({name:"candidate_validation",objectTypes:[endpoints.source.payload,endpoints.target.payload],linkTypes:[candidate.payload]},catalog);
      errors.push(...schemaValidation.errors);warnings.push(...schemaValidation.warnings);
    }
  }
  if(options.sourceId!=null&&Number(candidate?.sourceId)!==Number(options.sourceId))errors.push(issue("ONTOLOGY_CANDIDATE_SOURCE_MISMATCH","sourceId","候选所属数据源与生成批次不一致"));
  if(Array.isArray(candidate?.contractErrors))for(const contractIssue of candidate.contractErrors)if(isRecord(contractIssue)&&contractIssue.code)errors.push(issue(String(contractIssue.code),String(contractIssue.path||"payload"),String(contractIssue.message||"候选违反生成契约")));

  let stableKey=null;
  if(CANDIDATE_TYPES.has(candidateType)&&isRecord(candidate?.payload)) {
    try {
      stableKey=createOntologyCandidateStableKey(candidate,{catalog,acceptedObjects:options.acceptedObjects});
      if(candidate.stableKey&&candidate.stableKey!==stableKey)errors.push(issue("ONTOLOGY_CANDIDATE_STABLE_KEY_MISMATCH","stableKey","stableKey 与物理映射及批次输入不一致"));
    } catch(error) { errors.push(issue(error.code||"ONTOLOGY_CANDIDATE_STABLE_KEY_INVALID","stableKey",error.message)); }
  }

  const uniqueErrors=dedupeIssues(errors);const uniqueWarnings=dedupeIssues(warnings);
  const forcedReviewReasons=forcedReview(candidate,{catalog,endpoints,baseSchema:options.baseSchema,warnings:uniqueWarnings});
  const physical=physicalMappingScore(candidate,{catalog,endpoints,errors:uniqueErrors});
  const semantic=semanticConsistencyScore(candidate,{catalog,endpoints,similarity:options.semanticSimilarity,unavailableReason:options.semanticUnavailableReason});
  const structural=structuralEvidenceScore(candidate,{catalog,warnings:uniqueWarnings,errors:uniqueErrors});
  const knowledge=evidenceScore(candidate?.evidence,["knowledge","knowledge_page","gold_sql","query","business_rule"],ONTOLOGY_CANDIDATE_WEIGHTS.knowledgeEvidence);
  const template=evidenceScore(candidate?.evidence,["template"],ONTOLOGY_CANDIDATE_WEIGHTS.templateMatch);
  const rawScore=Math.max(0,Math.min(100,Math.round(physical.score+semantic.score+structural.score+knowledge.score+template.score)));
  const threshold=validThreshold(options.autoConfirmScore,80);
  // 风险信号不再形成第二套“高分但强制人工”的路由规则，而是统一折算到阈值以下。
  // 因而在 auto_draft 模式中，人工队列始终可以解释为“分数低于本批阈值”。
  const score=forcedReviewReasons.length?Math.min(rawScore,Math.max(0,threshold-1)):rawScore;
  const riskAdjustment={score:score-rawScore,max:0,reason:forcedReviewReasons.length?`检测到 ${forcedReviewReasons.length} 项风险信号，分数封顶为自动确认阈值以下`:`未检测到需要降分的风险信号`};
  const route=routeOntologyCandidateScore({score,validationErrors:uniqueErrors,forcedReviewReasons,mode:options.mode,autoConfirmScore:options.autoConfirmScore});
  const validation={
    ok:uniqueErrors.length===0,
    errors:uniqueErrors,
    warnings:uniqueWarnings,
    summary:{...(schemaValidation.summary||{}),errorCount:uniqueErrors.length,warningCount:uniqueWarnings.length},
  };
  return {
    stableKey,
    score,
    scoreBreakdown:{physicalMapping:physical,semanticConsistency:semantic,structuralEvidence:structural,knowledgeEvidence:knowledge,templateMatch:template,riskAdjustment},
    scoringVersion:options.scoringVersion||ONTOLOGY_CANDIDATE_SCORING_VERSION,
    status:route.status,
    forcedReviewReasons,
    routeReason:route.routeReason,
    validation,
  };
}

export function routeOntologyCandidateScore({score,validationErrors=[],forcedReviewReasons=[],mode="auto_draft",autoConfirmScore=80}={}) {
  const threshold=validThreshold(autoConfirmScore,80);
  const normalizedMode=["off","review","auto_draft"].includes(mode)?mode:"auto_draft";
  if(validationErrors.length)return {status:"blocked",routeReason:"validation_error"};
  // 防御直接调用者绕过风险降分；标准评分链路会先把这些候选的展示分降到阈值以下。
  if(forcedReviewReasons.length&&Number(score)>=threshold)return {status:"review_required",routeReason:"risk_score_not_adjusted"};
  if(normalizedMode!=="auto_draft")return {status:"review_required",routeReason:`${normalizedMode}_mode`};
  return Number(score)>=threshold?{status:"auto_confirmed",routeReason:"score_threshold_met"}:{status:"review_required",routeReason:"score_below_threshold"};
}

export function createOntologyCandidateScorer({embedding,embed=callLlmEmbedding,timeoutMs=30_000,fetchImpl=globalThis.fetch}={}) {
  return {
    async score(candidate,options={}) {
      const texts=semanticTexts(candidate,{catalog:options.catalog,acceptedObjects:options.acceptedObjects});
      let semanticSimilarity=null;let semanticUnavailableReason=null;
      if(texts.evidenceText) {
        try {
          const scoringEmbedding={...(embedding||{}),...(options.embeddingModel?{model:options.embeddingModel}:{})};
          const [candidateVector,evidenceVector]=await embed(scoringEmbedding,[texts.candidateText,texts.evidenceText],{timeoutMs,fetchImpl});
          semanticSimilarity=cosineSimilarity(candidateVector,evidenceVector);
        } catch(error) { semanticUnavailableReason=String(error?.message||error); }
      }
      const model=String(options.embeddingModel||embedding?.model||"unconfigured").trim()||"unconfigured";
      return scoreOntologyCandidate(candidate,{...options,semanticSimilarity,semanticUnavailableReason,scoringVersion:`${ONTOLOGY_CANDIDATE_SCORING_VERSION}:embedding=${model}`});
    },
  };
}

export function cosineSimilarity(left,right) {
  if(!Array.isArray(left)||!Array.isArray(right)||!left.length||left.length!==right.length)return 0;
  let dot=0;let leftNorm=0;let rightNorm=0;
  for(let index=0;index<left.length;index++){const a=Number(left[index]);const b=Number(right[index]);if(!Number.isFinite(a)||!Number.isFinite(b))return 0;dot+=a*b;leftNorm+=a*a;rightNorm+=b*b;}
  return leftNorm&&rightNorm?Math.max(-1,Math.min(1,dot/(Math.sqrt(leftNorm)*Math.sqrt(rightNorm)))):0;
}

function physicalMappingScore(candidate,{catalog,endpoints,errors}) {
  const max=ONTOLOGY_CANDIDATE_WEIGHTS.physicalMapping;
  if(errors.some((item)=>/MAPPING|SOURCE|TABLE|COLUMN|LINK_(SOURCE|TARGET|PATH|ENDPOINT)|RELATION_(ID|NOT_FOUND)/.test(item.code)))return {score:0,max,reason:"物理映射或端点校验未通过"};
  const tables=candidate.candidateType==="object"?mappedTables(candidate.payload):[...new Set([...mappedTables(endpoints.source?.payload),...mappedTables(endpoints.target?.payload)])];
  const catalogByName=new Map((catalog.tables||[]).map((item)=>[item.tableName,item]));
  if(!tables.length)return {score:0,max,reason:"没有可验证的物理表"};
  const gradeACount=tables.filter((name)=>catalogByName.get(name)?.grade==="A").length;
  const score=Number((28+7*gradeACount/tables.length).toFixed(2));
  return {score,max,reason:`映射完整，A 级表占比 ${gradeACount}/${tables.length}，按 28–35 分线性计分`};
}

function semanticConsistencyScore(candidate,{catalog,endpoints,similarity,unavailableReason}) {
  const max=ONTOLOGY_CANDIDATE_WEIGHTS.semanticConsistency;
  const texts=semanticTexts(candidate,{catalog,acceptedObjects:[endpoints.source,endpoints.target].filter(Boolean)});
  if(!texts.evidenceText)return {score:15,max,similarity:null,reason:"物理侧注释缺失，按固定中档保底计分"};
  if(unavailableReason)return {score:0,max,similarity:null,reason:"Embedding 不可用，语义项降级为 0 分",degradedReason:String(unavailableReason).slice(0,500)};
  if(!Number.isFinite(similarity))return {score:0,max,similarity:null,reason:"尚未计算可复现的 Embedding 相似度",degradedReason:"semantic_similarity_not_computed"};
  const normalized=Math.max(-1,Math.min(1,Number(similarity)));
  const score=normalized>=0.85?25:normalized>=0.7?22:normalized>=0.55?18:normalized>=0.4?12:normalized>=0.2?6:0;
  return {score,max,similarity:Number(normalized.toFixed(6)),reason:`Embedding 相似度按固定分档计分（${normalized.toFixed(3)}）`};
}

function structuralEvidenceScore(candidate,{catalog,warnings,errors}) {
  const max=ONTOLOGY_CANDIDATE_WEIGHTS.structuralEvidence;
  if(candidate.candidateType==="object") {
    const failed=errors.some((item)=>item.code.startsWith("ONTOLOGY_PRIMARY_KEY"));
    return failed?{score:0,max,reason:"主键结构证据未通过校验"}:{score:max,max,reason:"主键映射为已知主键或唯一字段"};
  }
  const relationIds=(candidate.payload?.relationMappings||[]).map((item)=>Number(isRecord(item)?item.relationId:item)).filter(Number.isInteger);
  const confirmed=relationIds.map((id)=>(catalog.relations||[]).find((item)=>Number(item.id)===id)).filter((item)=>item&&["confirmed","accepted"].includes(item.status));
  if(!confirmed.length||confirmed.length!==relationIds.length)return {score:0,max,reason:"JOIN 路径包含未确认的结构证据"};
  const mismatch=warnings.some((item)=>item.code==="ONTOLOGY_CARDINALITY_MISMATCH");
  if(relationIds.length>1)return {score:mismatch?20:22,max,reason:mismatch?"多段 JOIN 全部已确认，但存在基数不一致":"多段 JOIN 全部已确认且基数一致"};
  if(mismatch)return {score:15,max,reason:"JOIN 已确认，但声明基数与探查结果不一致"};
  return {score:max,max,reason:"单条已确认 JOIN 且基数一致"};
}

function evidenceScore(evidence,kinds,max) {
  const allowed=new Set(kinds);
  const matched=(Array.isArray(evidence)?evidence:[]).filter((item)=>isRecord(item)&&allowed.has(String(item.kind||item.type||""))&&item.verified===true&&Boolean(item.refId||item.id||item.stableKey));
  if(!matched.length)return {score:0,max,reason:"没有已验证证据"};
  const containsGold=matched.some((item)=>String(item.kind||item.type||"")==="gold_sql");
  const score=containsGold||matched.length>=3?max:matched.length===2?Math.min(8,max):Math.min(6,max);
  return {score,max,reason:containsGold?`已绑定 ${matched.length} 条验证证据，包含 Gold SQL`:`已绑定 ${matched.length} 条服务端验证证据`};
}

function forcedReview(candidate,{catalog,endpoints,baseSchema,warnings}) {
  const reasons=[];
  if(warnings.some((item)=>item.code==="ONTOLOGY_MAPPING_SENSITIVE_COLUMN"))reasons.push("SENSITIVE_FIELD_MAPPING");
  if((candidate.evidence||[]).some((item)=>isRecord(item)&&(item.conflict===true||item.kind==="evidence_conflict")))reasons.push("EVIDENCE_CONFLICT");
  if((candidate.evidence||[]).some((item)=>isRecord(item)&&(item.fieldsComplete===false||item.truncated===true)))reasons.push("CATALOG_FIELDS_TRUNCATED");
  if(candidate.candidateType==="link") {
    const relation=(catalog.relations||[]).find((item)=>Number(item.id)===firstRelationId(candidate.payload));
    if(relation&&relation.inferenceSource!=="foreign_key"&&relation.status!=="confirmed")reasons.push("JOIN_NOT_EXPLICIT_OR_MANUALLY_CONFIRMED");
    if(candidate.payload?.relationKind==="temporal"&&(!hasTimeProperty(endpoints.source?.payload)||!hasTimeProperty(endpoints.target?.payload)))reasons.push("TEMPORAL_EVIDENCE_MISSING");
    if(candidate.payload?.relationKind==="contains"&&!(["one_to_one","one_to_many"].includes(candidate.payload?.cardinality)))reasons.push("RELATION_KIND_EVIDENCE_MISMATCH");
  }
  if(modifiesBaseSchema(candidate,baseSchema))reasons.push("MODIFIES_BASE_SCHEMA");
  if(changesConfirmedTermBinding(candidate,baseSchema))reasons.push("TERM_BINDING_CONFLICT");
  if(disjointEvidenceConflict(candidate,baseSchema))reasons.push("EVIDENCE_CONFLICT");
  if(candidate.semanticCriticFlagged===true)reasons.push("SEMANTIC_CRITIC_FLAGGED");
  if(candidate.candidateType==="object"&&lowFieldCoverage(candidate,catalog))reasons.push("LOW_FIELD_COVERAGE");
  return [...new Set(reasons)];
}

// 对象映射的字段数不足主表非敏感字段一半（且表足够宽）时，缺口需要人工确认，
// 否则语义链路会在缺失字段上"合法地答错"。
function lowFieldCoverage(candidate,catalog) {
  const properties=candidate.payload?.properties||[];
  const tables=[...new Set(properties.map((item)=>item?.mapping?.table).filter(Boolean))];
  if(tables.length!==1)return false;
  const available=(catalog.columnsByTable?.[tables[0]]||[]).filter((column)=>!column.isSensitive).length;
  return available>=8&&properties.length/available<.5;
}

function modifiesBaseSchema(candidate,baseSchema) {
  if(!isRecord(baseSchema))return false;
  if(candidate.candidateType==="object") {
    const current=(baseSchema.objectTypes||[]).find((item)=>item.apiName===candidate.payload?.apiName);
    return Boolean(current)&&JSON.stringify(objectCore(current))!==JSON.stringify(objectCore(candidate.payload));
  }
  const current=(baseSchema.linkTypes||[]).find((item)=>item.apiName===candidate.payload?.apiName);
  return Boolean(current)&&JSON.stringify(linkCore(current))!==JSON.stringify(linkCore(candidate.payload));
}

function changesConfirmedTermBinding(candidate,baseSchema) {
  if(!isRecord(baseSchema))return false;
  const current=candidate.candidateType==="object"?(baseSchema.objectTypes||[]).find((item)=>item.apiName===candidate.payload?.apiName):(baseSchema.linkTypes||[]).find((item)=>item.apiName===candidate.payload?.apiName);
  if(!current||candidate.candidateType!=="object")return false;
  if(JSON.stringify(current.termBinding||null)!==JSON.stringify(candidate.payload?.termBinding||null)&&current.termBinding)return true;
  const nextProperties=new Map((candidate.payload?.properties||[]).map((item)=>[item.apiName,item]));
  return (current.properties||[]).some((property)=>property.termBinding&&JSON.stringify(property.termBinding)!==JSON.stringify(nextProperties.get(property.apiName)?.termBinding||null));
}

function disjointEvidenceConflict(candidate,baseSchema) {
  if(candidate.candidateType!=="object"||!isRecord(baseSchema))return false;
  const groups=(baseSchema.disjointGroups||[]).filter((group)=>group.includes(candidate.payload?.apiName));
  if(!groups.length)return false;
  const candidateTables=new Set(mappedTables(candidate.payload));
  for(const group of groups)for(const name of group){
    if(name===candidate.payload.apiName)continue;
    const other=(baseSchema.objectTypes||[]).find((item)=>item.apiName===name);if(!other)continue;
    if(mappedTables(other).some((table)=>candidateTables.has(table))&&!discriminatorsSeparate(candidate.payload,other))return true;
  }
  return false;
}

function discriminatorsSeparate(left,right){if(!left?.discriminator||!right?.discriminator||left.discriminator.property!==right.discriminator.property)return false;return !(left.discriminator.values||[]).some((value)=>(right.discriminator.values||[]).map(String).includes(String(value)));}

function objectCore(object) {
  return {parent:object?.parent||null,discriminator:object?.discriminator||null,termBinding:object?.termBinding||null,primaryKey:object?.primaryKey,properties:(object?.properties||[]).map((item)=>({apiName:item.apiName,type:item.type,required:Boolean(item.required),termBinding:item.termBinding||null,mapping:{table:item.mapping?.table,column:item.mapping?.column}})).sort((a,b)=>String(a.apiName).localeCompare(String(b.apiName)))};
}
function linkCore(link) { return {source:link?.source,target:link?.target,cardinality:link?.cardinality,inverseApiName:link?.inverseApiName||null,inverseDisplayName:link?.inverseDisplayName||null,relationKind:link?.relationKind||null,relationMappings:(link?.relationMappings||[]).map((item)=>Number(isRecord(item)?item.relationId:item)).sort((a,b)=>a-b)}; }

function semanticTexts(candidate,{catalog,acceptedObjects=[]}) {
  const payload=candidate?.payload||{};
  const objectPayloads=candidate?.candidateType==="object"?[payload]:acceptedObjects.map((item)=>item?.payload).filter(Boolean);
  const safeProperties=objectPayloads.flatMap((object)=>(object.properties||[]).filter((property)=>{
    const column=(catalog?.columnsByTable?.[property?.mapping?.table]||[]).find((item)=>item.columnName===property?.mapping?.column);
    return column&&!column.isSensitive;
  }));
  const candidateText=[payload.apiName,payload.displayName,payload.description,...safeProperties.flatMap((item)=>[item.apiName,item.displayName,item.description]),payload.sourceLabel,payload.targetLabel,payload.relationKind].filter(Boolean).join("\n");
  const tables=objectPayloads.flatMap(mappedTables);
  const tableByName=new Map((catalog?.tables||[]).map((item)=>[item.tableName,item]));
  const evidence=[];
  for(const tableName of new Set(tables)) {
    const table=tableByName.get(tableName);if(table?.comment)evidence.push(table.comment);
    const mappedColumns=new Set(safeProperties.filter((property)=>property?.mapping?.table===tableName).map((property)=>property.mapping.column));
    for(const column of catalog?.columnsByTable?.[tableName]||[])if(mappedColumns.has(column.columnName)&&column.comment)evidence.push(column.comment);
  }
  if(evidence.join("\n").length<80)for(const tableName of new Set(tables)){
    const mappedColumns=new Set(safeProperties.filter((property)=>property?.mapping?.table===tableName).map((property)=>property.mapping.column));
    for(const column of catalog?.columnsByTable?.[tableName]||[]){if(!mappedColumns.has(column.columnName)||column.isSensitive)continue;const profile=column.profile;if(profile?.formatPattern)evidence.push(`格式 ${profile.formatPattern}`);for(const value of (profile?.sampleValues||[]).filter((item)=>!detectSensitiveValue(item).sensitive).slice(0,5))evidence.push(`示例 ${value}`);for(const item of (catalog?.enumsByTable?.[tableName]||[]).filter((entry)=>entry.columnName===column.columnName&&!detectSensitiveValue(entry.value).sensitive).slice(0,10))evidence.push(`枚举 ${item.value}${item.meaning?`=${item.meaning}`:""}`);}
  }
  const anchorByKey=new Map((catalog?.termAnchors||[]).map((anchor)=>[`${anchor.vocabulary}\u0000${anchor.canonicalId}`,anchor]));
  for(const entity of [payload,...safeProperties]){
    const binding=entity?.termBinding;if(!binding)continue;const anchor=anchorByKey.get(`${binding.vocabulary}\u0000${binding.canonicalId}`);if(anchor)evidence.push(anchor.prefLabelZh,anchor.prefLabelEn,...(anchor.altLabels||[]));
  }
  return {candidateText,evidenceText:[...new Set(evidence)].join("\n")};
}

function findLinkEndpoints(candidate,acceptedObjects) {
  const items=(acceptedObjects||[]).filter(Boolean);
  const byApiName=new Map(items.map((item)=>[item.payload?.apiName,item]));
  const byStableKey=new Map(items.map((item)=>[item.stableKey,item]));
  return {
    source:byStableKey.get(candidate?.sourceStableKey)||byApiName.get(candidate?.payload?.source),
    target:byStableKey.get(candidate?.targetStableKey)||byApiName.get(candidate?.payload?.target),
  };
}

function mappedTables(payload) { return [...new Set((payload?.properties||[]).map((item)=>String(item?.mapping?.table||"").trim()).filter(Boolean))].sort(); }
function firstRelationId(payload) { const first=payload?.relationMappings?.[0];return Number(isRecord(first)?first.relationId:first); }
function hasTimeProperty(payload) { return (payload?.properties||[]).some((item)=>TIME_TYPES.has(String(item?.type||"").toLowerCase())); }
function hasCrossSourceMapping(payload,sourceId) { return (payload?.properties||[]).some((item)=>item?.mapping?.sourceId!=null&&Number(item.mapping.sourceId)!==Number(sourceId)); }
function validThreshold(value,fallback) { const number=Number(value);return Number.isInteger(number)&&number>=0&&number<=100?number:fallback; }
function dedupeIssues(items) { const seen=new Set();return items.filter((item)=>{const key=`${item.code}:${item.path}`;if(seen.has(key))return false;seen.add(key);return true;}); }
function issue(code,path,message) { return {code,path,message}; }
function isRecord(value) { return Boolean(value)&&typeof value==="object"&&!Array.isArray(value); }
function candidateError(code,message) { const error=new Error(message);error.code=code;return error; }

export const ontologyCandidateScoreInternal={mappedTables,semanticTexts,modifiesBaseSchema};
