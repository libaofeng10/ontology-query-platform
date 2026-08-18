export function diffSemanticSchemas(currentInput,baseInput) {
  const current=normalize(currentInput),base=normalize(baseInput);const changes=[];
  if(current.name!==base.name)push(changes,"schema","changed","name",current.displayName||current.name,"breaking",`本体 API Name 由 ${base.name||"(空)"} 变为 ${current.name||"(空)"}`);
  else if(current.displayName!==base.displayName||current.description!==base.description)push(changes,"schema","changed","$",current.displayName||current.name,"compatible","本体展示名称或描述发生变化");
  compareNamed("object",current.objectTypes,base.objectTypes,changes,(item)=>item.apiName,compareObject);
  compareNamed("link",current.linkTypes,base.linkTypes,changes,(item)=>item.apiName,compareLink);
  if(disjointSignature(current)!==disjointSignature(base))push(changes,"disjoint_group","changed","disjointGroups","互斥组","review","手动互斥组发生变化，查询计划门禁行为可能改变","disjoint_group_changed");
  const counts={added:0,removed:0,changed:0,breaking:0,review:0,compatible:0};
  for(const change of changes){counts[change.change]++;counts[change.impact]++;}
  return {ok:true,summary:{...counts,total:changes.length},changes};
}

export function hasSemanticHierarchyChanges(currentInput,baseInput) {
  const current=new Map(normalize(currentInput).objectTypes.map((item)=>[item.apiName,item]));
  const base=new Map(normalize(baseInput).objectTypes.map((item)=>[item.apiName,item]));
  for(const name of new Set([...current.keys(),...base.keys()])) {
    const next=current.get(name),previous=base.get(name);
    const nextSignature=JSON.stringify([next?.parent||null,next?.discriminator||null]);
    const previousSignature=JSON.stringify([previous?.parent||null,previous?.discriminator||null]);
    if(nextSignature!==previousSignature&&(next?.parent||next?.discriminator||previous?.parent||previous?.discriminator))return true;
  }
  return false;
}

export function semanticSubtypeNames(schema) {
  return normalize(schema).objectTypes.filter((item)=>item.parent&&item.discriminator).map((item)=>item.apiName);
}

function compareObject(current,base,changes) {
  const prefix=`objectTypes.${current.apiName}`;
  if(current.primaryKey!==base.primaryKey) push(changes,"object","changed",prefix,current.displayName||current.apiName,"breaking",`主键由 ${base.primaryKey||"(空)"} 变为 ${current.primaryKey||"(空)"}`);
  if((current.parent||null)!==(base.parent||null))push(changes,"object","changed",`${prefix}.parent`,current.displayName||current.apiName,"breaking",`父类型由 ${base.parent||"(无)"} 变为 ${current.parent||"(无)"}`,"object_parent_changed");
  if(discriminatorSignature(current)!==discriminatorSignature(base))push(changes,"object","changed",`${prefix}.discriminator`,current.displayName||current.apiName,"breaking",discriminatorDetail(current,base),"discriminator_changed");
  if(termBindingSignature(current)!==termBindingSignature(base))push(changes,"object","changed",`${prefix}.termBinding`,current.displayName||current.apiName,"compatible","术语锚点绑定发生变化","term_binding_changed");
  else if(metaSignature(current)!==metaSignature(base)) push(changes,"object","changed",prefix,current.displayName||current.apiName,"compatible","展示名称或描述发生变化");
  compareNamed("property",current.properties||[],base.properties||[],changes,(item)=>item.apiName,(next,previous,target)=>compareProperty(current.apiName,next,previous,target),current.apiName);
}

function compareProperty(objectName,current,base,changes) {
  const path=`objectTypes.${objectName}.properties.${current.apiName}`,label=`${objectName}.${current.apiName}`;
  const details=[];
  if(current.type!==base.type)details.push(`类型 ${base.type} → ${current.type}`);
  if(Boolean(current.required)!==Boolean(base.required))details.push(`必填 ${Boolean(base.required)} → ${Boolean(current.required)}`);
  if(mappingSignature(current)!==mappingSignature(base))details.push(`映射 ${mappingLabel(base)} → ${mappingLabel(current)}`);
  if(JSON.stringify(current.constraints||{})!==JSON.stringify(base.constraints||{}))details.push("约束发生变化");
  if(details.length) push(changes,"property","changed",path,label,"breaking",details.join("；"));
  else if(termBindingSignature(current)!==termBindingSignature(base))push(changes,"property","changed",`${path}.termBinding`,label,"compatible","术语锚点绑定发生变化","term_binding_changed");
  else if(metaSignature(current)!==metaSignature(base)) push(changes,"property","changed",path,label,"compatible","展示名称或描述发生变化");
}

function compareLink(current,base,changes) {
  const path=`linkTypes.${current.apiName}`,details=[];
  for(const key of ["source","target","cardinality"])if(current[key]!==base[key])details.push(`${key} ${base[key]||"(空)"} → ${current[key]||"(空)"}`);
  if(relationSignature(current)!==relationSignature(base))details.push("物理 JOIN 映射发生变化");
  if(details.length) push(changes,"link","changed",path,current.displayName||current.apiName,"breaking",details.join("；"));
  else if(metaSignature(current)!==metaSignature(base)||current.sourceLabel!==base.sourceLabel||current.targetLabel!==base.targetLabel||current.inverseApiName!==base.inverseApiName||current.inverseDisplayName!==base.inverseDisplayName) {
    const inverseChanged=current.inverseApiName!==base.inverseApiName||current.inverseDisplayName!==base.inverseDisplayName;
    push(changes,"link","changed",path,current.displayName||current.apiName,"compatible","展示名称、描述、导航标签或反向命名发生变化",inverseChanged?"link_inverse_changed":"link_metadata_changed");
  }
}

function compareNamed(kind,currentItems,baseItems,changes,keyOf,compare,context="") {
  const current=new Map(currentItems.map((item)=>[keyOf(item),item])),base=new Map(baseItems.map((item)=>[keyOf(item),item]));
  for(const [key,item] of current) {
    const previous=base.get(key);
    if(!previous)push(changes,kind,"added",pathFor(kind,item,context),labelFor(kind,item,context),addedImpact(kind,item),"新增定义");
    else compare(item,previous,changes);
  }
  for(const [key,item] of base)if(!current.has(key))push(changes,kind,"removed",pathFor(kind,item,context),labelFor(kind,item,context),"breaking","删除已有定义");
}

function addedImpact(kind,item){if(kind==="object"&&item.parent)return "review";return kind==="property"&&item.required?"review":"compatible";}
function pathFor(kind,item,context){if(kind==="object")return `objectTypes.${item.apiName}`;if(kind==="link")return `linkTypes.${item.apiName}`;return `objectTypes.${context}.properties.${item.apiName}`;}
function labelFor(kind,item,context){return kind==="property"?`${context}.${item.apiName}`:item.displayName||item.apiName||"未命名";}
function metaSignature(item){return JSON.stringify([item.displayName||"",item.description||""]);}
function mappingSignature(item){return JSON.stringify(item.mapping||{});}
function mappingLabel(item){return item?.mapping?.table&&item?.mapping?.column?`${item.mapping.table}.${item.mapping.column}`:"(未映射)";}
function relationSignature(item){return JSON.stringify((item.relationMappings||[]).map((mapping)=>Number(mapping.relationId)).sort((a,b)=>a-b));}
function termBindingSignature(item){return JSON.stringify(item?.termBinding||null);}
function discriminatorSignature(item){return JSON.stringify(item?.discriminator||null);}
function discriminatorDetail(current,base){const previous=base.discriminator;const next=current.discriminator;if(previous?.property===next?.property&&Array.isArray(previous.values)&&Array.isArray(next.values)&&next.values.every((value)=>previous.values.map(String).includes(String(value)))&&next.values.length<previous.values.length)return `判别值由 ${previous.values.join("、")} 收窄为 ${next.values.join("、")}，实例行集将缩小`;return "判别属性或判别值发生变化";}
function disjointSignature(schema){return JSON.stringify((schema.disjointGroups||[]).map((group)=>[...group].sort()).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))));}
function push(changes,kind,change,path,label,impact,detail,type=`${kind}_${change}`){changes.push({type,kind,change,path,label,impact,detail});}
function normalize(input){return input&&typeof input==="object"?{name:input.name||"",displayName:input.displayName||"",description:input.description||"",objectTypes:Array.isArray(input.objectTypes)?input.objectTypes:[],linkTypes:Array.isArray(input.linkTypes)?input.linkTypes:[],disjointGroups:Array.isArray(input.disjointGroups)?input.disjointGroups:[]}:{name:"",displayName:"",description:"",objectTypes:[],linkTypes:[],disjointGroups:[]};}
