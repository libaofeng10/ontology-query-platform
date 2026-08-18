export async function callLlmEmbedding(embedding,inputs,{timeoutMs=30_000,fetchImpl=globalThis.fetch}={}) {
  const issues=embeddingConfigurationIssues(embedding);
  if(issues.length) throw new Error(`Embedding 配置不可用：${issues.join("；")}`);
  const texts=(Array.isArray(inputs)?inputs:[inputs]).map((item)=>String(item??""));
  if(!texts.length) return [];
  const url=/\/embeddings\/?$/.test(embedding.baseUrl)?embedding.baseUrl:`${embedding.baseUrl.replace(/\/$/,"")}/embeddings`;
  let response;
  try {
    response=await fetchImpl(url,{method:"POST",headers:{authorization:`Bearer ${embedding.apiKey}`,"content-type":"application/json"},body:JSON.stringify({model:embedding.model,input:texts,...(embedding.dimensions?{dimensions:embedding.dimensions}:{})}),signal:AbortSignal.timeout(timeoutMs)});
  } catch(error) {
    if(isTimeout(error)) throw new Error(`Embedding 请求超时（${Math.round(timeoutMs/1000)} 秒）`);
    throw new Error(`Embedding 网络请求失败：${String(error?.message||error)}`);
  }
  if(!response.ok) throw new Error(embeddingHttpError(response.status));
  const data=await response.json();
  const items=Array.isArray(data?.data)?data.data:[];
  if(items.length!==texts.length) throw new Error(`Embedding 服务返回数量不匹配：期望 ${texts.length}，实际 ${items.length}`);
  const vectors=[...items].sort((left,right)=>Number(left.index||0)-Number(right.index||0)).map((item)=>item.embedding);
  if(vectors.some((vector)=>!Array.isArray(vector)||!vector.length||vector.some((value)=>!Number.isFinite(value)))) throw new Error("Embedding 服务返回了非法向量");
  return vectors;
}

export function isEmbeddingConfigured(embedding) { return embeddingConfigurationIssues(embedding).length===0; }

export function embeddingConfigurationIssues(embedding) {
  const issues=[];
  if(!String(embedding?.baseUrl||"").trim()) issues.push("未配置 Embedding Base URL");
  if(!String(embedding?.apiKey||"").trim()) issues.push("未配置 Embedding API Key");
  if(!String(embedding?.model||"").trim()) issues.push("未配置 Embedding 模型");
  return issues;
}

function isTimeout(error) { return error?.name==="TimeoutError"||error?.name==="AbortError"||/aborted due to timeout|timed?\s*out/i.test(String(error?.message||error)); }
function embeddingHttpError(status) {
  if(status===401) return "Embedding 鉴权失败（401）：API Key 无效，或与 Base URL 不匹配";
  if(status===403) return "Embedding 无权访问（403）：请检查 API Key 权限和模型授权";
  if(status===404) return "Embedding 地址或模型不存在（404）：请检查 Base URL 与模型名";
  if(status===429) return "Embedding 请求受限（429）：请检查额度或稍后重试";
  if(status>=500) return `Embedding 服务暂时不可用（${status}）`;
  return `Embedding 请求失败（${status}）：请检查模型地址和请求配置`;
}

export const _internal={embeddingHttpError,isTimeout};
