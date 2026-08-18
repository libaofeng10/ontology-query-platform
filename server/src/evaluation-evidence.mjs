import { createHash } from "node:crypto";

export function evalSetChecksum(cases=[]) {
  return createHash("sha256").update(JSON.stringify((cases||[]).map((item)=>[item.id,item.question,item.goldSql,item.category,item.heldOut]))).digest("hex");
}

export function inspectSemanticEvalGate(gate,{sourceId,schemaVersion,schemaPublishedAt=null,requirePostPublish=false,cases=[]}={}) {
  const currentCases=Array.isArray(cases)?cases:[];
  const currentEvaluationChecksum=evalSetChecksum(currentCases);
  const issues=[];
  if(!gate)return evidence(false,[issue("missing","尚未选择或生成 Gold SQL 语义门禁")],currentCases,currentEvaluationChecksum);
  if(Number(gate.sourceId)!==Number(sourceId))issues.push(issue("source_mismatch","Gold SQL 门禁不属于当前数据源"));
  if(!Number.isInteger(Number(schemaVersion))||Number(gate.ontologySchemaVersion)!==Number(schemaVersion))issues.push(issue("schema_mismatch","Gold SQL 门禁未绑定当前试点 Schema 版本"));
  if(requirePostPublish&&(!schemaPublishedAt||gate.ontologySchemaPublishedAt!==schemaPublishedAt))issues.push(issue("not_post_publish","Gold SQL 门禁不是基于当前 Schema 发布状态运行的发布后验证"));
  if(!gate.passed||gate.decision!=="enable_prefer")issues.push(issue("not_passed","Gold SQL 语义对照门禁尚未通过"));
  if(gate.baseline?.requestedMode!=="off"||gate.candidate?.requestedMode!=="prefer"||gate.candidate?.gateKind==="agent")issues.push(issue("wrong_gate_kind","必须使用 off 对 prefer 的语义 Query Plan 对照门禁"));
  if(!currentCases.length)issues.push(issue("empty_set","Gold SQL 评测集不存在或没有有效用例"));
  if(currentCases.some((item)=>!String(item.goldSql||"").trim()))issues.push(issue("missing_gold_sql","当前评测集存在缺少 Gold SQL 的用例"));
  if(Number(gate.total)!==currentCases.length)issues.push(issue("case_count_mismatch","Gold SQL 门禁用例数与当前评测集不一致"));
  if(!gate.evaluationChecksum||gate.evaluationChecksum!==currentEvaluationChecksum)issues.push(issue("evaluation_set_stale","Gold SQL 评测集在门禁运行后已变化，请重新执行门禁"));
  if(!Number.isFinite(Number(gate.baseline?.passRate))||!Number.isFinite(Number(gate.candidate?.passRate)))issues.push(issue("metrics_incomplete","Gold SQL 门禁缺少结果等价率指标"));
  if(!(Number(gate.candidate?.semanticExecutionRate)>0))issues.push(issue("semantic_not_executed","候选组没有真实进入语义 Query Plan"));
  return evidence(issues.length===0,issues,currentCases,currentEvaluationChecksum);
}

function evidence(valid,issues,cases,currentEvaluationChecksum) {
  return {valid:Boolean(valid),issues,currentCaseCount:cases.length,currentEvaluationChecksum};
}
function issue(code,message) { return {code,message}; }
