const GENERIC_TOKENS=new Set(["id","name","type","status","code","data","value"]);

export function buildSemanticRepairHints({schema,question="",failureClass="execution",queryPlan=null,semanticPath=null}={}) {
  if(!schema||!["result_mismatch","join","retrieval","generation","execution"].includes(failureClass))return [];
  const objects=new Map((schema.objectTypes||[]).map((item)=>[item.apiName,item]));
  const links=new Map((schema.linkTypes||[]).map((item)=>[item.apiName,item]));
  const objectNames=new Set();const propertyUses=new Map();const linkNames=new Set();
  const addProperty=(reference,use)=>{if(typeof reference!=="string"||!reference.includes("."))return;const [objectName,propertyName]=reference.split(".");const object=objects.get(objectName);if(!object?.properties?.some((item)=>item.apiName===propertyName))return;objectNames.add(objectName);const uses=propertyUses.get(reference)||new Set();uses.add(use);propertyUses.set(reference,uses);};

  if(queryPlan?.rootObject&&objects.has(queryPlan.rootObject))objectNames.add(queryPlan.rootObject);
  for(const item of queryPlan?.dimensions||[])addProperty(item.property,"维度");
  for(const item of queryPlan?.metrics||[])if(item.property)addProperty(item.property,`${item.aggregation||"聚合"} 指标`);
  for(const item of queryPlan?.filters||[])addProperty(item.property,"过滤条件");
  if(queryPlan?.timeDimension)addProperty(queryPlan.timeDimension.property,`${queryPlan.timeDimension.grain||"时间"}粒度`);
  for(const name of semanticPath?.objects||[])if(objects.has(name))objectNames.add(name);
  for(const name of semanticPath?.links||[])if(links.has(name))linkNames.add(name);

  if(!objectNames.size&&!propertyUses.size&&!linkNames.size) {
    for(const object of objects.values()) {
      if(matches(question,[object.displayName,object.apiName]))objectNames.add(object.apiName);
      for(const property of object.properties||[])if(matches(question,[property.displayName,property.apiName]))addProperty(`${object.apiName}.${property.apiName}`,"问题语义");
    }
    for(const link of links.values())if(matches(question,[link.displayName,link.apiName,link.sourceLabel,link.targetLabel,link.inverseApiName,link.inverseDisplayName]))linkNames.add(link.apiName);
  }
  if(failureClass==="join"&&linkNames.size===0)for(const link of links.values())if(objectNames.has(link.source)||objectNames.has(link.target))linkNames.add(link.apiName);

  const hints=[];
  for(const reference of propertyUses.keys()) {
    const [objectName,propertyName]=reference.split(".");const object=objects.get(objectName);const property=object?.properties?.find((item)=>item.apiName===propertyName);if(!property)continue;
    const uses=[...propertyUses.get(reference)].join("、");
    hints.push({targetType:"property",target:reference,label:`${object.displayName||objectName}.${property.displayName||propertyName}`,action:propertyAction(failureClass,uses)});
  }
  for(const name of linkNames) {
    const link=links.get(name);if(!link)continue;
    hints.push({targetType:"link",target:name,label:link.displayName||name,action:linkAction(failureClass,link)});
  }
  for(const name of objectNames) {
    const object=objects.get(name);if(!object)continue;
    hints.push({targetType:"object",target:name,label:object.displayName||name,action:objectAction(failureClass,object)});
  }
  return uniqueHints(hints).slice(0,12);
}

function propertyAction(failureClass,uses) {
  if(failureClass==="result_mismatch")return `核对该属性的物理映射、数据类型及${uses||"指标/过滤"}口径，确认空值、枚举和聚合规则与 Gold SQL 一致。`;
  if(failureClass==="retrieval")return "补充该属性的业务名称、别名与描述，使问题能够稳定命中这一语义属性。";
  if(failureClass==="join")return "核对该属性所属对象及映射表，确认它位于预期关系路径上。";
  return `检查该属性的映射与${uses||"查询"}约束，修复后重跑失败用例。`;
}

function linkAction(failureClass,link) {
  const scope=`${link.source} → ${link.target}`;
  if(failureClass==="result_mismatch")return `核对 ${scope} 的方向、基数和物理 JOIN 绑定，避免重复计数或漏数。`;
  return `检查 ${scope} 的方向、基数、已确认关系及 relationMappings 是否完整有效。`;
}

function objectAction(failureClass,object) {
  if(failureClass==="result_mismatch")return `核对对象主键 ${object.primaryKey||"(未定义)"}、业务粒度与纳入范围，排查重复行或对象边界偏差。`;
  if(failureClass==="retrieval")return "补充对象业务名称、别名和描述，并确认相关问题词能够命中此对象。";
  return `检查对象主键 ${object.primaryKey||"(未定义)"}、属性集合与业务粒度是否足以支持该问题。`;
}

function matches(question,tokens) { const haystack=normalize(question);return tokens.some((token)=>{const needle=normalize(token);return needle.length>=2&&!GENERIC_TOKENS.has(needle)&&haystack.includes(needle);}); }
function normalize(value) { return String(value||"").toLowerCase().replace(/[\s_.-]+/g,""); }
function uniqueHints(items) { const seen=new Set();return items.filter((item)=>{const key=`${item.targetType}:${item.target}`;if(seen.has(key))return false;seen.add(key);return true;}); }
