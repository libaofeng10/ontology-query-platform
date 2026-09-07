import { createHash } from "node:crypto";

export function classifyBuildError(error) {
  const message=String(error?.message||error||"整理未完成");
  if(/401|403|api.?key|unauthori[sz]ed|forbidden|鉴权|认证|凭据|未配置|权限|EACCES|ENOSPC|ENOENT/i.test(message))return {kind:"configuration",retryable:false,message,title:"请管理员检查连接或模型配置"};
  if(/目录.*(变化|过期)|版本.*变化|不存在或已失效|table.*not.*found/i.test(message))return {kind:"catalog",retryable:false,message,title:"数据结构或可用版本已变化，请更新数据范围"};
  if(/timeout|timed out|超时|429|50[234]|ECONNRESET|fetch failed|socket/i.test(message))return {kind:"transient",retryable:true,message,title:"连接暂时未响应，可继续未完成部分"};
  if(/JSON|输出|解析|mapping|映射|candidates/i.test(message))return {kind:"model_output",retryable:true,message,title:"部分业务定义需要重新整理"};
  return {kind:"generation",retryable:true,message,title:"本次整理尚未完成"};
}

export function buildIssueId(value) {return createHash("sha256").update(String(value)).digest("hex").slice(0,16);}

export function groupBuildErrors(domains) {
  const groups=new Map();
  for(const domain of domains) {
    const issue=classifyBuildError(domain.error);
    const key=issue.kind==="configuration"||issue.kind==="transient"?issue.kind:issue.message.replace(/\b[0-9a-f]{8}-[0-9a-f-]+\b/gi,"");
    if(!groups.has(key))groups.set(key,{id:buildIssueId(key),kind:issue.kind,title:issue.title,detail:issue.message,retryable:issue.retryable,tables:[],domains:[]});
    groups.get(key).domains.push(domain.domainName);
  }
  return [...groups.values()];
}
