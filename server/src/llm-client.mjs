export async function callLlmJson(llm,messages,{timeoutMs=60_000,fetchImpl=globalThis.fetch,extraBody={},signal}={}) {
  const traced=await callLlmJsonWithTrace(llm,messages,{timeoutMs,fetchImpl,extraBody,signal});
  if(traced.value&&typeof traced.value==="object"&&!Array.isArray(traced.value))traced.value.__usage=traced.usage;
  return traced.value;
}

export async function callLlmJsonWithTrace(llm,messages,{timeoutMs=60_000,fetchImpl=globalThis.fetch,extraBody={},signal}={}) {
  const data=await requestChatCompletion(llm,messages,{timeoutMs,fetchImpl,extraBody:{response_format:{type:"json_object"},...extraBody},signal});
  const rawContent=data.choices?.[0]?.message?.content;
  const usage=normalizeUsage(data.usage);
  if(!rawContent) throw traceError("LLM 未返回内容",rawContent,usage);
  try {
    const value=JSON.parse(rawContent);
    if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("root_not_object");
    return {value,rawContent,usage};
  } catch { throw traceError("LLM 未返回合法 JSON",rawContent,usage); }
}

export async function callLlmTools(llm,messages,tools,options={}) {
  const definitions=normalizeToolDefinitions(tools);
  const protocol={
    response:{thought:"面向用户的一句中文进度说明",tool:"工具名",args:"与工具 inputSchema 匹配的 JSON 对象"},
    tools:definitions,
  };
  const requestMessages=[
    {role:"system",content:`你必须且只能调用一个已提供的工具，禁止直接作答。若当前服务以 JSON 内容表达工具动作，必须严格遵守此协议且不要输出 Markdown 或额外文本：${JSON.stringify(protocol)}`},
    ...messages,
  ];
  const nativeTools=definitions.map((tool)=>({type:"function",function:{name:tool.name,description:tool.description,parameters:tool.inputSchema}}));
  const {timeoutMs=60_000,fetchImpl=globalThis.fetch,extraBody={},signal}=options;
  const data=await requestChatCompletion(llm,requestMessages,{timeoutMs,fetchImpl,extraBody:{tools:nativeTools,tool_choice:"required",...extraBody},signal});
  const message=data.choices?.[0]?.message;
  let action;
  try { action=normalizeToolAction(message); } catch(error) { throw protocolFormatError(error.message); }
  const usage=normalizeUsage(data.usage);
  // In the JSON-content mode message.content is the JSON action itself, so it cannot double
  // as the thought fallback; a missing thought there is a format violation. Native tool_calls
  // often carry no content at all, so demanding one there would break compliant models.
  const thought=String(action.thought||(action.jsonProtocol?"":message?.content)||"").trim();
  if(!thought&&action.jsonProtocol) throw protocolFormatError("LLM 工具动作缺少 thought（协议要求每轮提供一句进度说明）");
  const tool=String(action.tool||"").trim();
  if(!tool) throw protocolFormatError("LLM 未返回工具动作（required 模式要求每轮调用一个授权工具）");
  if(!definitions.some((item)=>item.name===tool)) { const error=new Error(`LLM 请求了未授权工具：${tool}`);error.code="LLM_TOOL_UNAUTHORIZED";throw error; }
  let args;
  try { args=parseToolArguments(action.args); } catch(error) { throw protocolFormatError(error.message); }
  return {thought:thought||"正在分析。",tool,args,usage};
}

export function isLlmConfigured(llm) { return llmConfigurationIssues(llm).length===0; }

export function llmConfigurationIssues(llm) {
  const issues=[];
  if(!String(llm?.baseUrl||"").trim()) issues.push("未配置 LLM_BASE_URL");
  const apiKey=String(llm?.apiKey||"").trim();
  if(!apiKey) issues.push("未配置 LLM_API_KEY");
  else if(isPlaceholder(apiKey)) issues.push("LLM_API_KEY 仍是示例占位符，请填写真实 API Key 并重启服务");
  if(!String(llm?.model||"").trim()) issues.push("未配置 LLM_MODEL");
  return issues;
}

function isPlaceholder(value) { return /^(?:replace[-_ ]with|replace[-_ ]me|your[-_ ]|example[-_ ]|test[-_ ]|api[-_ ]key)/i.test(value)||/^<.+>$/.test(value); }
function isTimeout(error) { return error?.name==="TimeoutError"||error?.name==="AbortError"||/aborted due to timeout|timed?\s*out/i.test(String(error?.message||error)); }
function llmHttpError(status) {
  if(status===401) return "LLM 鉴权失败（401）：API Key 无效，或 API Key 与 Base URL、地域、计费方案不匹配";
  if(status===403) return "LLM 无权访问（403）：请检查 API Key 权限、模型授权和账户状态";
  if(status===404) return "LLM 地址或模型不存在（404）：请检查 LLM_BASE_URL 与 LLM_MODEL";
  if(status===429) return "LLM 请求受限（429）：请检查额度、并发限制或稍后重试";
  if(status>=500) return `LLM 服务暂时不可用（${status}）`;
  return `LLM 请求失败（${status}）：请检查模型地址和请求配置`;
}

function abortError() { const error=new Error("LLM 请求已取消");error.name="AbortError";error.code="ABORT_ERR";return error; }
function protocolFormatError(message) { const error=new Error(message);error.code="LLM_PROTOCOL_FORMAT";return error; }
export function isProtocolFormatError(error) { return error?.code==="LLM_PROTOCOL_FORMAT"; }
function traceError(message,rawContent,usage) { const error=new Error(message);error.rawContent=rawContent??null;error.usage=usage;return error; }
function normalizeUsage(value) { if(!value||typeof value!=="object")return null;const promptTokens=Number(value.prompt_tokens??value.input_tokens??0);const completionTokens=Number(value.completion_tokens??value.output_tokens??0);const totalTokens=Number(value.total_tokens??promptTokens+completionTokens);return {promptTokens:Number.isFinite(promptTokens)?promptTokens:0,completionTokens:Number.isFinite(completionTokens)?completionTokens:0,totalTokens:Number.isFinite(totalTokens)?totalTokens:0}; }

async function requestChatCompletion(llm,messages,{timeoutMs,fetchImpl,extraBody,signal}) {
  const issues=llmConfigurationIssues(llm);
  if(issues.length) throw new Error(`LLM 配置不可用：${issues.join("；")}`);
  const url=/\/chat\/completions\/?$/.test(llm.baseUrl)?llm.baseUrl:`${llm.baseUrl.replace(/\/$/,"")}/chat/completions`;
  let response;
  try {
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs);
    response=await fetchImpl(url,{method:"POST",headers:{authorization:`Bearer ${llm.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:llm.model,messages,temperature:0,...extraBody}),signal:requestSignal});
  } catch(error) {
    if(signal?.aborted) throw abortError();
    if(isTimeout(error)) throw new Error(`LLM 请求超时（${Math.round(timeoutMs/1000)} 秒）`);
    throw new Error(`LLM 网络请求失败：${String(error?.message||error)}`);
  }
  if(!response.ok) throw new Error(llmHttpError(response.status));
  return response.json();
}

function normalizeToolAction(message) {
  if(!message||typeof message!=="object") throw new Error("LLM 未返回工具动作");
  if(Array.isArray(message.tool_calls)&&message.tool_calls.length) {
    if(message.tool_calls.length!==1) throw new Error(`LLM 每轮必须返回一个工具动作，实际返回 ${message.tool_calls.length} 个`);
    const call=message.tool_calls[0];
    return {thought:message.content,tool:call?.function?.name??call?.name,args:call?.function?.arguments??call?.arguments};
  }
  if(message.function_call) return {thought:message.content,tool:message.function_call.name,args:message.function_call.arguments};
  const content=String(message.content||"").trim();
  if(!content) throw new Error("LLM 未返回工具动作");
  let parsed;
  try { parsed=JSON.parse(content); }
  catch { throw new Error("LLM 工具动作不是合法 JSON"); }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)) throw new Error("LLM 工具动作必须是 JSON 对象");
  if(Array.isArray(parsed.tool_calls)) return {...normalizeToolAction({content:parsed.thought,tool_calls:parsed.tool_calls}),jsonProtocol:true};
  const wrapped=objectValue(parsed.tool_call)||objectValue(parsed.function_call)||objectValue(parsed.function)||objectValue(parsed.action)||objectValue(parsed.tool);
  if(wrapped) return {
    jsonProtocol:true,
    thought:parsed.thought??parsed.reasoning,
    tool:wrapped.tool??wrapped.name,
    args:wrapped.args??wrapped.arguments??wrapped.parameters??wrapped.input,
  };
  const actionName=typeof parsed.action==="string"?parsed.action:undefined;
  const toolName=typeof parsed.tool==="string"?parsed.tool:undefined;
  return {
    jsonProtocol:true,
    thought:parsed.thought??parsed.reasoning,
    tool:toolName??actionName??parsed.name,
    args:parsed.args??parsed.arguments??parsed.parameters??parsed.input??parsed.action_input,
  };
}

function parseToolArguments(value) {
  if(value==null||value==="") return {};
  let parsed=value;
  if(typeof value==="string") {
    try { parsed=JSON.parse(value); }
    catch { throw new Error("LLM 工具动作 args 不是合法 JSON"); }
  }
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)) throw new Error("LLM 工具动作 args 必须是 JSON 对象");
  return parsed;
}

function objectValue(value) { return value&&typeof value==="object"&&!Array.isArray(value)?value:null; }

function normalizeToolDefinitions(tools) {
  if(!Array.isArray(tools)||!tools.length) throw new Error("工具定义不能为空");
  const names=new Set();
  return tools.map((tool)=>{
    const name=String(tool?.name||"").trim();
    if(!/^[a-z][a-z0-9_]*$/.test(name)||names.has(name)) throw new Error(`工具名无效或重复：${name||"空工具名"}`);
    names.add(name);
    return {name,description:String(tool.description||""),inputSchema:tool.inputSchema||{type:"object",properties:{},additionalProperties:false}};
  });
}

export const _internal={isPlaceholder,isTimeout,llmHttpError,normalizeToolDefinitions,normalizeToolAction,parseToolArguments};
