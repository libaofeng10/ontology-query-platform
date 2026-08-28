import { knowledgeIntentConcepts, catalogFilterConcepts } from "./query-intent.mjs";
import { validateKnowledgeSemantics } from "./knowledge-semantics.mjs";

// Aggregates refused/failed audit rows into a governance backlog of capability gaps.
// Pure read + deterministic recomputation: no new tables, no LLM calls, no replay of
// historical questions — status derives from the same concept builders parseQueryIntent uses,
// so a knowledge page saved today flips its gap to resolved on the next read with zero wiring.

const FAILURE_CLASS_LABELS={
  llm_unconfigured:"LLM 未配置",retrieval_miss:"知识覆盖缺失",schema_gap:"结构映射缺失",ontology_missing:"本体未发布",
  protocol_error:"模型协议异常",enum_dictionary:"枚举字典误拦",policy_block:"安全策略拦截",execution_error:"执行失败",
  intent_error:"意图解析失败",guard_false_positive:"护栏误报",budget_exhausted:"预算耗尽",result_incomplete:"结果不完整",data_quality:"数据质量",
};

const METRIC_GAP_CODES=new Set(["MEASURE_DEFINITION_REQUIRED","METRIC_AMBIGUOUS"]);
const FILTER_GAP_CODES=new Set(["FILTER_FIELD_UNKNOWN","FILTER_VALUE_BINDING_UNKNOWN"]);

export function createCapabilityGapService({store}) {
  function listGaps(sourceId,{limit=500}={}) {
    const audits=store.listAudits(sourceId,limit).filter((row)=>["refused","failed"].includes(row.verdict));
    const resolution=buildResolutionContext(store,sourceId);
    const gaps=[...aggregateGaps(audits),...pageHealthGaps(resolution)];
    for(const gap of gaps)gap.status=gapStatus(gap,resolution);
    gaps.sort((left,right)=>(left.status==="open"?0:1)-(right.status==="open"?0:1)||right.count-left.count||String(right.lastAskedAt||"").localeCompare(String(left.lastAskedAt||"")));
    return {gaps,generatedAt:new Date().toISOString(),auditWindow:audits.length};
  }
  return {listGaps};
}

// A verified page with semantic defects is worse than a missing one: it answers with
// authority it cannot back. Health is recomputed live with the same validator the save
// path uses, so a page fixed via Markdown sync drops off the board on the next read.
// The detail names the specific missing declaration (e.g. contract.periodColumn), which
// is what the acceptance criterion "指向具体页面与具体缺失声明" means.
function pageHealthGaps({knowledgePages,columnsByTable}) {
  const gaps=[];
  for(const page of knowledgePages||[]) {
    if(!page.verified)continue;
    const result=validateKnowledgeSemantics(page,{columnsByTable});
    if(result.semanticHealth==="ok")continue;
    const issue=result.errors?.[0]||result.warnings?.[0]||null;
    gaps.push({
      key:`PAGE:${page.pageType}:${page.slug}`,
      code:result.semanticHealth==="invalid"?"PAGE_SEMANTIC_INVALID":"PAGE_SEMANTIC_DEGRADED",
      assetLabel:page.title,count:1,lastAskedAt:page.updatedAt||null,sampleQuestions:[],
      detail:issue?`${issue.code}：${issue.message}`:null,
      remedy:{action:"edit_knowledge_page",prefill:{pageType:page.pageType,slug:page.slug,title:page.title}},
      status:"open",
    });
  }
  return gaps;
}

function aggregateGaps(audits) {
  const groups=new Map();
  for(const row of audits) {
    for(const descriptor of gapDescriptors(row)) {
      const existing=groups.get(descriptor.key);
      if(existing) {
        existing.count++;
        if(String(row.createdAt||"")>String(existing.lastAskedAt||""))existing.lastAskedAt=row.createdAt||existing.lastAskedAt;
        if(existing.sampleQuestions.length<3&&row.question&&!existing.sampleQuestions.includes(row.question))existing.sampleQuestions.push(row.question);
      } else {
        groups.set(descriptor.key,{
          key:descriptor.key,code:descriptor.code,assetLabel:descriptor.assetLabel,count:1,
          lastAskedAt:row.createdAt||null,sampleQuestions:row.question?[row.question]:[],
          remedy:gapRemedy(descriptor),status:"open",
        });
      }
    }
  }
  return [...groups.values()];
}

// One audit row can carry several blocking ambiguities; each becomes its own gap descriptor.
// Rows without an intent fall back to a failure_class + normalized fail_reason fingerprint —
// this path must stay forever: llm_unconfigured rows never have an intent.
function gapDescriptors(row) {
  const blocking=(row.intent?.ambiguities||[]).filter((item)=>item?.blocking);
  if(blocking.length) {
    return blocking.map((ambiguity)=>{
      const label=gapAssetLabel(ambiguity,row.intent);
      return {code:ambiguity.code,assetLabel:label,key:`${ambiguity.code}|${normalizeLabel(label)}`};
    });
  }
  const failureClass=row.failureClass||"execution_error";
  const fingerprint=failReasonFingerprint(row.failReason);
  return [{
    code:`CLASS:${failureClass}`,
    assetLabel:FAILURE_CLASS_LABELS[failureClass]||failureClass,
    key:`CLASS:${failureClass}|${fingerprint}`,
    degraded:true,
  }];
}

function gapAssetLabel(ambiguity,intent) {
  if(ambiguity.sourceText)return String(ambiguity.sourceText).trim();
  if(FILTER_GAP_CODES.has(ambiguity.code)) {
    const filter=(intent?.filters||[]).find((item)=>item.fieldSurface||item.field);
    if(filter)return String(filter.fieldSurface||filter.field);
  }
  return ambiguity.code;
}

// Fingerprints group only; display always uses the original sampleQuestions.
function failReasonFingerprint(reason) {
  return String(reason||"")
    .replace(/["'“”‘’][^"'“”‘’]*["'“”‘’]/g," ")
    .replace(/\b[a-z][a-z0-9_]*_[a-z0-9_]+\b/gi," ")
    .replace(/\d+/g," ")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,60);
}

function gapRemedy(descriptor) {
  if(METRIC_GAP_CODES.has(descriptor.code))return {action:"create_metric_page",prefill:{pageType:"metric",title:descriptor.assetLabel}};
  if(FILTER_GAP_CODES.has(descriptor.code))return {action:"publish_ontology_property",prefill:{field:descriptor.assetLabel}};
  if(descriptor.code==="PRODUCT_SCOPE_REGISTRY_REQUIRED")return {action:"publish_product_registry"};
  if(descriptor.code==="CLASS:llm_unconfigured")return {action:"configure_llm"};
  if(descriptor.code==="CLASS:retrieval_miss")return {action:"create_term_page",prefill:{pageType:"term",title:descriptor.assetLabel}};
  if(descriptor.code==="CLASS:enum_dictionary")return {action:"review_enum_dictionary"};
  if(descriptor.code.startsWith("CLASS:"))return {action:"review_audit"};
  return {action:"create_term_page",prefill:{pageType:"term",title:descriptor.assetLabel}};
}

function buildResolutionContext(store,sourceId) {
  const tables=store.listTables(sourceId).filter((table)=>table.grade!=="C"&&table.active);
  const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));
  const knowledgePages=store.listKnowledge(sourceId);
  const metricConcepts=knowledgeIntentConcepts(knowledgePages,columnsByTable);
  const ontologyRecord=store.getPublishedOntologySchema?.(sourceId)||null;
  const termAnchors=store.listTermAnchors?.()||[];
  const filterConcepts=catalogFilterConcepts(tables,columnsByTable,ontologyRecord?.sourceId===sourceId?ontologyRecord.schema:null,termAnchors);
  return {metricConcepts,filterConcepts,knowledgePages,columnsByTable};
}

function gapStatus(gap,{metricConcepts,filterConcepts}) {
  const target=normalizeLabel(gap.assetLabel);
  if(!target)return "open";
  if(METRIC_GAP_CODES.has(gap.code)) {
    const resolved=metricConcepts.some((concept)=>concept.aggregation!=="unknown"&&(concept.aliases||[]).some((alias)=>normalizeLabel(alias)===target||normalizeLabel(alias).includes(target)));
    return resolved?"resolved":"open";
  }
  if(FILTER_GAP_CODES.has(gap.code)) {
    const resolved=filterConcepts.some((concept)=>(concept.physicalColumns||[]).length>0&&(concept.aliases||[]).some((alias)=>normalizeLabel(alias)===target));
    return resolved?"resolved":"open";
  }
  return "open";
}

function normalizeLabel(value) { return String(value||"").trim().toLowerCase().replace(/[\s“”"'‘’]+/g,""); }

export const _internal={aggregateGaps,gapKey:(descriptor)=>descriptor.key,gapDescriptors,gapRemedy,gapStatus,failReasonFingerprint,buildResolutionContext,pageHealthGaps};
