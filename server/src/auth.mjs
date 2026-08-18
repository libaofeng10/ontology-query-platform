import { createHash, timingSafeEqual } from "node:crypto";

const ROLE_LEVEL={viewer:1,analyst:2,editor:3,admin:4};

export function authenticate(req,runtime) {
  const authorization=String(req.headers.authorization||"");
  const token=authorization.toLowerCase().startsWith("bearer ")?authorization.slice(7).trim():String(req.headers["x-ontoquery-token"]||"");
  if(!token)throw httpError(401,"缺少 API 身份令牌");
  const identities=runtime.apiIdentities?.length?runtime.apiIdentities:[{name:"local-admin",role:"admin",token:runtime.writeToken,sourceIds:"*"}];
  const identity=identities.find((item)=>safeEqual(token,String(item.token||"")));
  if(!identity)throw httpError(401,"API 身份令牌无效");
  if(!ROLE_LEVEL[identity.role])throw httpError(500,"API 身份角色配置无效");
  return {name:String(identity.name||identity.role),role:identity.role,sourceIds:normalizeSources(identity.sourceIds),key:createHash("sha256").update(token).digest("hex").slice(0,16)};
}

export function authorize(identity,minimumRole="viewer",sourceId=null) {
  if((ROLE_LEVEL[identity.role]||0)<(ROLE_LEVEL[minimumRole]||99))throw httpError(403,`该操作要求 ${minimumRole} 或更高角色`);
  if(sourceId!=null&&identity.sourceIds!=="*"&&!identity.sourceIds.includes(Number(sourceId)))throw httpError(403,"当前身份无权访问该数据源");
  return identity;
}

export function canAccessSource(identity,sourceId) { return identity.sourceIds==="*"||identity.sourceIds.includes(Number(sourceId)); }

export function createRateLimiter({windowMs=60_000}={}) {
  const buckets=new Map();
  function check(key,limit) {
    const now=Date.now();let bucket=buckets.get(key);
    if(!bucket||bucket.resetAt<=now){bucket={count:0,resetAt:now+windowMs};buckets.set(key,bucket);}
    bucket.count++;
    if(bucket.count>limit){const error=httpError(429,"请求过于频繁，请稍后重试");error.retryAfter=Math.max(1,Math.ceil((bucket.resetAt-now)/1000));throw error;}
    if(buckets.size>10_000)for(const [entry,value] of buckets)if(value.resetAt<=now)buckets.delete(entry);
    return {remaining:Math.max(0,limit-bucket.count),resetAt:bucket.resetAt};
  }
  return {check};
}

function normalizeSources(value) { if(value==null||value==="*")return "*";const items=Array.isArray(value)?value:String(value).split(/[|,]/);return items.map(Number).filter(Number.isFinite); }
function safeEqual(left,right) { const a=Buffer.from(left);const b=Buffer.from(right);return Boolean(left&&right&&a.length===b.length&&timingSafeEqual(a,b)); }
function httpError(status,message) { const error=new Error(message);error.status=status;return error; }
