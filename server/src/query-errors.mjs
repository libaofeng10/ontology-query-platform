export const QUERY_FAILURE_CLASSES=new Set([
  "intent_error","retrieval_miss","schema_gap","guard_false_positive","policy_block","data_quality","execution_error","budget_exhausted","result_incomplete",
]);

export function toolFailure({stage="internal",code="INTERNAL_ERROR",error,retryable=false,details}={}) {
  const message=String(error||"工具执行失败");
  return {ok:false,stage,code,error:message,retryable:Boolean(retryable),failureClass:failureClassFor({stage,code,message}),...(details===undefined?{}:{details})};
}

export function failureClassFor({stage,code,message}={}) {
  const value=String(code||"").toUpperCase();
  if(value.startsWith("INTENT_"))return "intent_error";
  if(value==="RETRIEVAL_MISS")return "retrieval_miss";
  if(value==="SCHEMA_GAP"||value==="UNKNOWN_TABLE"||value==="UNKNOWN_COLUMN"||value==="AMBIGUOUS_COLUMN")return "schema_gap";
  if(value==="ENUM_OWNERSHIP_AMBIGUOUS"||value==="GUARD_FALSE_POSITIVE")return "guard_false_positive";
  if(value==="RESULT_INCOMPLETE"||value==="SCOPE_INCOMPLETE")return "result_incomplete";
  if(value.includes("BUDGET")||stage==="budget")return "budget_exhausted";
  if(stage==="query"||stage==="explain"||value==="EXECUTION_ERROR")return "execution_error";
  if(value.startsWith("DATA_"))return "data_quality";
  if(stage==="guard"||stage==="policy"||/禁止|白名单|未确认/.test(String(message||"")))return "policy_block";
  return "execution_error";
}

export function dominantFailureClass(trace=[],fallback="execution_error") {
  const failures=trace.filter((item)=>!item.ok&&item.failureClass).map((item)=>item.failureClass);
  if(!failures.length)return fallback;
  const priority=["intent_error","guard_false_positive","schema_gap","retrieval_miss","result_incomplete","budget_exhausted","policy_block","data_quality","execution_error"];
  return priority.find((item)=>failures.includes(item))||failures.at(-1)||fallback;
}
