import { knowledgeIntentConcepts } from "./query-intent.mjs";

// One validator for every path that writes knowledge pages — human save, machine
// proposal, Markdown sync. The assertions are the consumption-time derivations
// themselves, so "saved as verified" and "usable when queried" can no longer drift
// apart: a page that would silently degrade at query time is caught while the
// author is still looking at it.
//
// Two severities. Hard errors mean the page can never bind correctly (an
// unparseable ratio formula, a reference to a column that does not exist) and
// verified saves are refused. Soft warnings mean the page works but degraded
// (undetermined time role or grain) — the save goes through with
// semanticHealth:"degraded" so the health board can surface it, because refusing
// these would lock operators out of iterating on prose.

export function validateKnowledgeSemantics(page,{columnsByTable={}}={}) {
  const errors=[];
  const warnings=[];
  if(String(page?.pageType)!=="metric")return {ok:true,semanticHealth:"ok",errors,warnings};

  const probe={...page,verified:true,owner:page.owner||"semantic-validation"};
  const concept=knowledgeIntentConcepts([probe],columnsByTable)[0];
  if(!concept){errors.push({code:"CONCEPT_NOT_DERIVED",message:"页面无法推导为可用的指标概念"});return verdict(errors,warnings);}

  if(concept.aggregation==="ratio") {
    const formula=concept.metricDefinition?.formula;
    if(!formula)errors.push({code:"RATIO_FORMULA_UNPARSED",message:"比例指标的参考 SQL 无法解析出分子、分母公式。请检查是否为顶层除法、CASE WHEN 谓词、且仅含 AND 条件"});
    else if(formula.numerator?.predicateBinding==="unsupported"||formula.denominator?.predicateBinding==="unsupported")errors.push({code:"RATIO_PREDICATE_UNSUPPORTED",message:"公式谓词无法绑定到已登记的物理列。请确认表名、列名与数据源目录一致"});
  }
  if(concept.aggregation==="unknown")warnings.push({code:"AGGREGATION_UNKNOWN",message:"无法从参考 SQL 识别聚合方式，查询时该指标只能作为检索线索而非可执行口径"});

  if(concept.timeRoleDerivation?.status==="undetermined")warnings.push({code:"TIME_ROLE_UNDETERMINED",message:`定义同时提到多个业务事件时间（${(concept.timeRoleDerivation.candidates||[]).join("、")}），查询涉及时间范围时将要求用户澄清。补充结构化周期声明（contract.periodColumn）可消除`,candidates:concept.timeRoleDerivation.candidates||[]});
  if(concept.grainDerivation?.status==="undetermined")warnings.push({code:"GRAIN_UNDETERMINED",message:`去重粒度存在多个候选（${(concept.grainDerivation.candidates||[]).join("、")}），建议补充 contract.grain 声明`,candidates:concept.grainDerivation.candidates||[]});

  return verdict(errors,warnings);
}

function verdict(errors,warnings) {
  return {ok:errors.length===0,semanticHealth:errors.length?"invalid":warnings.length?"degraded":"ok",errors,warnings};
}
