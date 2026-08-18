export const QUERY_INTENT_VERSION="1.1";

const SUBJECT_CONCEPTS={
  clue:["线索","进线","clue","lead","clue_time","clue_create_time"],
  account:["账号","账户","用户","account","user","member"],
  customer:["客户","客群","customer","client"],
  order:["订单","下单","order","purchase","transaction"],
  case:["案件","案源","case","matter","legal_case"],
  revenue:["收入","营收","销售额","回款","revenue","sales","amount","payment"],
};

const QUERY_PREFIX=/^(?:请|帮我|麻烦)*(?:查询一下|查一下|统计一下|看一下|看下|了解一下|分析一下|查询|查|统计|看看|分析)/;
const ORGANIZATION_SUFFIX=/(律师事务所|律所|事务所)/;
const SUBJECT_BOUNDARY=/(?:本月|这个月|当月|上月|上个月|本周|这周|上周|今天|今日|昨天|昨日|近\d+(?:天|周|个月|月|年)|所有账号|全部账号|完整账号|全量账号|账号|账户|进线|线索|客户|用户|订单|案件|收入|营收|销售)/;
const LOCATION_ONLY=new Set(["北京","北京市","上海","上海市","天津","天津市","重庆","重庆市","全国"]);

export function parseQueryIntent(question,{now=new Date()}={}) {
  const rawQuestion=String(question||"").trim();
  const normalizedQuestion=rawQuestion.replace(/\s+/g,"").replace(/[？?。！!，,；;：:]/g,"");
  const organization=extractOrganizationEntity(normalizedQuestion);
  const subjects=detectSubjects(normalizedQuestion);
  const timeRange=detectTimeRange(normalizedQuestion,now);
  const exhaustive=/(?:所有|全部|完整|全量|各个).{0,12}(?:账号|账户)|(?:账号|账户).{0,12}(?:所有|全部|完整|全量)/.test(normalizedQuestion);
  const products=[];
  if(/alpha/i.test(normalizedQuestion.replace(/alpha\s*gpt/ig,"")))products.push("alpha");
  if(/alpha\s*gpt|alphagpt/i.test(normalizedQuestion))products.push("alphaGpt");
  const entities=organization?[organization]:[];
  const filters=organization?[{kind:"organization_name",operator:"contains",value:organization.text,immutable:true,sourceText:organization.sourceText}]:[];
  const ambiguities=[];
  if(subjects.length===0)ambiguities.push({code:"SUBJECT_UNKNOWN",message:"未识别出明确的业务对象",blocking:false});
  const intent={
    version:QUERY_INTENT_VERSION,
    rawQuestion,
    normalizedQuestion,
    subjects,
    entities,
    filters,
    timeRange,
    scope:{exhaustive,products},
    ambiguities,
  };
  return {...intent,retrievalTerms:buildRetrievalTerms(intent)};
}

export function buildIntentRetrievalQuestion(intent,fallbackQuestion=intent?.rawQuestion||"") {
  const values=[fallbackQuestion,...(intent?.retrievalTerms||[])].map((value)=>String(value||"").trim()).filter(Boolean);
  return [...new Set(values)].join(" ");
}

// Retrieval facets are business capabilities, not physical table mappings. The
// retrieval layer gives every required facet its own candidate quota so a strong
// organization or time match cannot crowd the requested business object out of
// one global ranking.
export function buildIntentRetrievalFacets(intent) {
  const facets=[];
  for(const subject of intent?.subjects||[]) {
    const terms=SUBJECT_CONCEPTS[subject]||[subject];
    const quota=intent?.scope?.exhaustive&&!intent?.scope?.products?.length?4:Math.max(2,intent?.scope?.products?.length||0);
    facets.push({key:`subject:${subject}`,kind:"subject",value:subject,required:true,quota,allowMultiple:Boolean(intent?.scope?.exhaustive||(intent?.scope?.products?.length||0)>1),anchorTerms:[...terms],terms:[...terms]});
  }
  for(const entityItem of intent?.entities||[]) {
    if(entityItem.type!=="organization")continue;
    facets.push({key:`entity:organization:${entityItem.text}`,kind:"entity",value:entityItem.text,required:true,terms:[entityItem.text,"律所","律师事务所","机构","组织","office","law_firm","firm","organization","org"]});
  }
  if(intent?.timeRange)facets.push({key:`time:${intent.timeRange.kind}`,kind:"time",value:intent.timeRange.kind,required:true,terms:[intent.timeRange.sourceText,"时间","日期","创建时间","发生时间","time","date","create_time","created_at","gmt_create"]});
  for(const product of intent?.scope?.products||[])facets.push({key:`product:${product}`,kind:"product",value:product,required:true,quota:2,anchorTerms:[product,product.toLowerCase()],terms:[product,product.toLowerCase(),"产品","product"]});
  if(intent?.scope?.exhaustive&&!intent?.scope?.products?.length)facets.push({key:"scope:exhaustive",kind:"scope",value:"exhaustive",required:false,terms:["所有","全部","完整","全量","多产品","多体系","all","complete","product"]});
  return facets;
}

export function queryIntentSqlErrors(intent,sql) {
  const errors=[];
  const text=String(sql||"");
  for(const entity of intent?.entities||[]) {
    if(entity.type!=="organization"||!entity.text)continue;
    if(!text.includes(entity.text))errors.push({
      code:"INTENT_ENTITY_DROPPED",
      stage:"intent",
      retryable:true,
      message:`机构专名“${entity.text}”必须作为连续字符串过滤（例如 LIKE '%${entity.text}%'），不能遗漏、改写或拆成多个条件`,
      details:{entityType:entity.type,expected:entity.text},
    });
  }
  if(intent?.timeRange?.kind==="current_month"&&!hasCurrentMonthPredicate(text,intent.timeRange))errors.push({
    code:"INTENT_TIME_DROPPED",
    stage:"intent",
    retryable:true,
    message:`问题中的时间约束“${intent.timeRange.sourceText}”没有体现在 SQL 过滤条件中`,
    details:{timeRange:intent.timeRange},
  });
  if(intent?.timeRange?.kind==="previous_month"&&!hasPreviousMonthPredicate(text,intent.timeRange))errors.push({
    code:"INTENT_TIME_DROPPED",
    stage:"intent",
    retryable:true,
    message:`问题中的时间约束“${intent.timeRange.sourceText}”没有体现在 SQL 过滤条件中`,
    details:{timeRange:intent.timeRange},
  });
  return errors;
}

function extractOrganizationEntity(text) {
  const suffix=text.match(ORGANIZATION_SUFFIX);
  if(suffix?.index!=null) {
    const prefix=cleanEntityPrefix(text.slice(0,suffix.index));
    if(validOrganizationCandidate(prefix))return entity(prefix,`${prefix}${suffix[0]}`,text.indexOf(prefix));
    return null;
  }
  const withoutPrefix=text.replace(QUERY_PREFIX,"").replace(/^(?:请|帮我|麻烦|一下)+/,"");
  const boundary=withoutPrefix.search(SUBJECT_BOUNDARY);
  if(boundary<=0)return null;
  const candidate=cleanEntityPrefix(withoutPrefix.slice(0,boundary));
  return validOrganizationCandidate(candidate,{implicit:true})?entity(candidate,candidate,text.indexOf(candidate)):null;
}

function cleanEntityPrefix(value) {
  return String(value||"").replace(QUERY_PREFIX,"").replace(/^(?:请|帮我|麻烦|一下)+/,"").replace(/的$/," ").trim();
}

function validOrganizationCandidate(value,{implicit=false}={}) {
  const length=[...String(value||"")].length;
  if(length<(implicit?4:2)||length>32)return false;
  if(implicit&&!/^(?:北京|上海|广州|深圳|天津|重庆|杭州|南京|成都|武汉|西安|苏州|长沙|郑州|青岛|厦门|济南|合肥|福州|昆明|沈阳|大连|宁波|东莞|佛山|无锡)/.test(value))return false;
  if(/[a-z0-9@]/i.test(value))return false;
  if(LOCATION_ONLY.has(value)||/^(?:所有|全部|各个|每个|某个|该|这个|当前|任意|当地|本地)$/.test(value))return false;
  if(/(?:地区|区域|范围内?|当地|本地|省|市|区|县)$/.test(value))return false;
  return !/^(?:本月|上月|本周|上周|今天|昨天)/.test(value);
}

function entity(text,sourceText,start) {
  return {type:"organization",text,sourceText,immutable:true,span:{start:Math.max(0,start),end:Math.max(0,start)+text.length}};
}

function detectSubjects(text) {
  const subjects=[];
  if(/线索|进线|lead|clue/i.test(text))subjects.push("clue");
  if(/账号|账户|account/i.test(text))subjects.push("account");
  if(/客户|customer/i.test(text))subjects.push("customer");
  if(/订单|order/i.test(text))subjects.push("order");
  if(/案件|案源|\bcase\b|matter/i.test(text))subjects.push("case");
  if(/收入|营收|销售额|回款|revenue|sales/i.test(text))subjects.push("revenue");
  return subjects;
}

function detectTimeRange(text,now) {
  if(/本月|这个月|当月/.test(text))return calendarMonth("current_month",matched(text,/本月|这个月|当月/),now,0);
  if(/上月|上个月/.test(text))return calendarMonth("previous_month",matched(text,/上月|上个月/),now,-1);
  if(/今天|今日/.test(text)){const start=localDate(now);return {kind:"today",sourceText:matched(text,/今天|今日/),start,endExclusive:addDays(start,1)};}
  if(/昨天|昨日/.test(text)){const end=localDate(now);return {kind:"yesterday",sourceText:matched(text,/昨天|昨日/),start:addDays(end,-1),endExclusive:end};}
  return null;
}

function calendarMonth(kind,sourceText,now,offset) {
  const startDate=new Date(now.getFullYear(),now.getMonth()+offset,1);
  const endDate=new Date(now.getFullYear(),now.getMonth()+offset+1,1);
  return {kind,sourceText,start:localDate(startDate),endExclusive:localDate(endDate)};
}

function hasCurrentMonthPredicate(sql,timeRange) {
  return /\b(?:CURDATE|CURRENT_DATE|CURRENT_TIMESTAMP|NOW)\s*\(|\bCURRENT_DATE\b|DATE_FORMAT\s*\(|EXTRACT\s*\(|\bYEAR\s*\(|\bMONTH\s*\(/i.test(sql)||hasExplicitRange(sql,timeRange);
}

function hasPreviousMonthPredicate(sql,timeRange) {
  return /DATE_SUB\s*\(|INTERVAL\s+1\s+MONTH|LAST_DAY\s*\(/i.test(sql)||hasExplicitRange(sql,timeRange);
}

function hasExplicitRange(sql,timeRange) { return String(sql).includes(timeRange.start)&&String(sql).includes(timeRange.endExclusive); }
function localDate(value){const year=value.getFullYear();const month=String(value.getMonth()+1).padStart(2,"0");const day=String(value.getDate()).padStart(2,"0");return `${year}-${month}-${day}`;}
function addDays(value,days){const [year,month,day]=value.split("-").map(Number);return localDate(new Date(year,month-1,day+days));}
function matched(value,pattern){return String(value).match(pattern)?.[0]||"";}

function buildRetrievalTerms(intent) {
  const result=buildIntentRetrievalFacets(intent).flatMap((facet)=>facet.kind==="entity"?[facet.value,facet.terms.slice(1).join(" ")]:[facet.terms.join(" ")]);
  return [...new Set(result)];
}
