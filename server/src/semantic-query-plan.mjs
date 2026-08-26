import { buildQueryColumnSemantics, columnSemanticKind } from "./query-column-semantics.mjs";

const API_NAME_PATTERN=/^[a-z][a-z0-9_]*$/;
const AGGREGATIONS=new Set(["count","count_distinct","sum","avg","min","max"]);
const FILTER_OPERATORS=new Set(["eq","neq","gt","gte","lt","lte","in","not_in","between","contains","is_null","not_null"]);
const TIME_GRAINS=new Set(["day","week","month","quarter","year"]);

export function validateSemanticQueryPlan(input,schema) {
  const errors=[];
  const raw=isRecord(input?.plan)?input.plan:isRecord(input)?input:{};
  if(!isRecord(input)) add(errors,"QUERY_PLAN_INVALID","$","Query Plan 必须是 JSON 对象");
  const model=createModel(schema);
  const plan={
    rootObject:text(raw.rootObject),
    dimensions:[],
    metrics:[],
    filters:[],
    timeDimension:null,
    orderBy:[],
    limit:normalizeLimit(raw.limit,errors),
  };
  if(!model.objects.has(plan.rootObject)) add(errors,"QUERY_PLAN_ROOT_NOT_FOUND","rootObject",`根对象 ${plan.rootObject||"(空)"} 不存在`);

  const dimensions=Array.isArray(raw.dimensions)?raw.dimensions:[];
  if(raw.dimensions!=null&&!Array.isArray(raw.dimensions)) add(errors,"QUERY_PLAN_DIMENSIONS_INVALID","dimensions","dimensions 必须是数组");
  if(dimensions.length>20) add(errors,"QUERY_PLAN_LIMIT_EXCEEDED","dimensions","dimensions 最多允许 20 项");
  for(const [index,item] of dimensions.slice(0,20).entries()) {
    const property=typeof item==="string"?text(item):text(item?.property);
    const alias=typeof item==="string"?lastPart(property):text(item?.alias)||lastPart(property);
    resolveProperty(model,property,`dimensions[${index}].property`,errors);
    validateAlias(alias,`dimensions[${index}].alias`,errors);
    plan.dimensions.push({property,alias});
  }

  const metrics=Array.isArray(raw.metrics)?raw.metrics:[];
  if(raw.metrics!=null&&!Array.isArray(raw.metrics)) add(errors,"QUERY_PLAN_METRICS_INVALID","metrics","metrics 必须是数组");
  if(metrics.length>20) add(errors,"QUERY_PLAN_LIMIT_EXCEEDED","metrics","metrics 最多允许 20 项");
  for(const [index,item] of metrics.slice(0,20).entries()) {
    const aggregation=text(item?.aggregation).toLowerCase();
    const property=text(item?.property);
    const alias=text(item?.alias)||text(item?.apiName)||`${aggregation||"metric"}_${lastPart(property)||"all"}`;
    if(!AGGREGATIONS.has(aggregation)) add(errors,"QUERY_PLAN_AGGREGATION_INVALID",`metrics[${index}].aggregation`,`不支持的聚合 ${aggregation||"(空)"}`);
    if(aggregation!=="count"&&!property) add(errors,"QUERY_PLAN_METRIC_PROPERTY_REQUIRED",`metrics[${index}].property`,`${aggregation||"该聚合"} 必须指定属性`);
    if(property) resolveProperty(model,property,`metrics[${index}].property`,errors);
    validateAlias(alias,`metrics[${index}].alias`,errors);
    plan.metrics.push({aggregation,property:property||null,alias});
  }

  const filters=Array.isArray(raw.filters)?raw.filters:[];
  if(raw.filters!=null&&!Array.isArray(raw.filters)) add(errors,"QUERY_PLAN_FILTERS_INVALID","filters","filters 必须是数组");
  if(filters.length>30) add(errors,"QUERY_PLAN_LIMIT_EXCEEDED","filters","filters 最多允许 30 项");
  for(const [index,item] of filters.slice(0,30).entries()) {
    const property=text(item?.property);
    const operator=text(item?.operator).toLowerCase();
    const propertyInfo=resolveProperty(model,property,`filters[${index}].property`,errors);
    if(!FILTER_OPERATORS.has(operator)) add(errors,"QUERY_PLAN_FILTER_OPERATOR_INVALID",`filters[${index}].operator`,`不支持的过滤操作 ${operator||"(空)"}`);
    validateFilterValue(operator,item?.value,propertyInfo,`filters[${index}].value`,errors);
    plan.filters.push({property,operator,value:item?.value});
  }

  if(raw.timeDimension!=null) {
    if(!isRecord(raw.timeDimension)) add(errors,"QUERY_PLAN_TIME_INVALID","timeDimension","timeDimension 必须是对象或 null");
    else {
      const property=text(raw.timeDimension.property);
      const grain=text(raw.timeDimension.grain).toLowerCase();
      const alias=text(raw.timeDimension.alias)||grain||"time_period";
      const propertyInfo=resolveProperty(model,property,"timeDimension.property",errors);
      if(propertyInfo&&!new Set(["date","datetime"]).has(propertyInfo.property.type)) add(errors,"QUERY_PLAN_TIME_TYPE_INVALID","timeDimension.property",`${property} 不是日期或时间属性`);
      if(!TIME_GRAINS.has(grain)) add(errors,"QUERY_PLAN_TIME_GRAIN_INVALID","timeDimension.grain",`不支持的时间粒度 ${grain||"(空)"}`);
      validateAlias(alias,"timeDimension.alias",errors);
      plan.timeDimension={property,grain,alias};
    }
  }

  if(!plan.dimensions.length&&!plan.metrics.length&&!plan.timeDimension) add(errors,"QUERY_PLAN_SELECT_REQUIRED","$","至少需要一个维度、时间维度或指标");
  const outputAliases=new Set([...plan.dimensions.map((item)=>item.alias),...plan.metrics.map((item)=>item.alias),...(plan.timeDimension?[plan.timeDimension.alias]:[])]);
  if(outputAliases.size!==plan.dimensions.length+plan.metrics.length+(plan.timeDimension?1:0)) add(errors,"QUERY_PLAN_ALIAS_DUPLICATE","$","输出别名不能重复");

  const orderBy=Array.isArray(raw.orderBy)?raw.orderBy:[];
  if(raw.orderBy!=null&&!Array.isArray(raw.orderBy)) add(errors,"QUERY_PLAN_ORDER_INVALID","orderBy","orderBy 必须是数组");
  if(orderBy.length>10) add(errors,"QUERY_PLAN_LIMIT_EXCEEDED","orderBy","orderBy 最多允许 10 项");
  for(const [index,item] of orderBy.slice(0,10).entries()) {
    const field=text(item?.field);
    const direction=text(item?.direction).toLowerCase()||"asc";
    if(!outputAliases.has(field)) add(errors,"QUERY_PLAN_ORDER_FIELD_INVALID",`orderBy[${index}].field`,`排序字段 ${field||"(空)"} 必须是输出别名`);
    if(!new Set(["asc","desc"]).has(direction)) add(errors,"QUERY_PLAN_ORDER_DIRECTION_INVALID",`orderBy[${index}].direction`,`排序方向必须是 asc 或 desc`);
    plan.orderBy.push({field,direction});
  }
  const referencedObjects=new Set([plan.rootObject]);
  for(const ref of [
    ...plan.dimensions.map((item)=>item.property),
    ...plan.metrics.map((item)=>item.property).filter(Boolean),
    ...plan.filters.map((item)=>item.property),
    ...(plan.timeDimension?[plan.timeDimension.property]:[]),
  ]) {
    const propertyInfo=model.properties.get(ref);
    if(propertyInfo) referencedObjects.add(propertyInfo.object.apiName);
  }
  if(!errors.some((item)=>item.code==="QUERY_PLAN_ROOT_NOT_FOUND"||item.code==="QUERY_PLAN_PROPERTY_NOT_FOUND")) {
    try {
      const semanticPath=resolveSemanticPath(model,plan.rootObject,referencedObjects);
      validatePathObjectCompatibility(model,semanticPath.objects,errors);
    } catch(error) {
      if(error instanceof SemanticQueryPlanError)add(errors,error.code,"$",error.message);
      else throw error;
    }
  }
  for(const [index,filter] of plan.filters.entries()) {
    const propertyInfo=model.properties.get(filter.property);
    const conflict=propertyInfo&&discriminatorConflict(propertyInfo.object,propertyInfo.property,filter);
    if(conflict) add(errors,"QUERY_PLAN_DISJOINT_CONFLICT",`filters[${index}]`,`过滤条件与子类型 ${propertyInfo.object.apiName} 的判别条件矛盾：${conflict}`);
  }
  return {ok:errors.length===0,plan,errors,summary:{dimensions:plan.dimensions.length,metrics:plan.metrics.length,filters:plan.filters.length}};
}

export function compileSemanticQueryPlan(input,{schema,catalog,maxRows=500,ontologySchemaVersion=null}) {
  const validation=validateSemanticQueryPlan(input,schema);
  if(!validation.ok) throw new SemanticQueryPlanError("QUERY_PLAN_VALIDATION_FAILED",validation.errors.map((item)=>item.message).join("；"),validation.errors);
  const plan=validation.plan;
  const model=createModel(schema);
  const rootObject=model.objects.get(plan.rootObject);
  const queryColumnSemantics=buildQueryColumnSemantics(catalog.columnsByTable||{});
  const referencedProperties=[
    ...plan.dimensions.map((item)=>item.property),
    ...plan.metrics.map((item)=>item.property).filter(Boolean),
    ...plan.filters.map((item)=>item.property),
    ...(plan.timeDimension?[plan.timeDimension.property]:[]),
  ].map((ref)=>model.properties.get(ref));
  const referencedObjects=new Set([plan.rootObject,...referencedProperties.map((item)=>item.object.apiName)]);
  const semanticPath=resolveSemanticPath(model,plan.rootObject,referencedObjects);
  const relationById=new Map((catalog.relations||[]).map((item)=>[Number(item.id),item]));
  const candidateRelations=new Map();
  for(const linkName of semanticPath.links) {
    const link=model.links.get(linkName);
    for(const mapping of link.relationMappings||[]) {
      const relation=relationById.get(Number(mapping.relationId));
      if(!relation||!isConfirmed(relation)) throw new SemanticQueryPlanError("QUERY_PLAN_RELATION_STALE",`语义关系 ${linkName} 绑定的物理 JOIN 已失效`);
      candidateRelations.set(Number(relation.id),relation);
    }
  }
  for(const objectName of semanticPath.objects) {
    const tables=model.objects.get(objectName).tables;
    for(const relation of catalog.relations||[]) if(isConfirmed(relation)&&tables.has(relation.fromTable)&&tables.has(relation.toTable)) candidateRelations.set(Number(relation.id),relation);
  }

  const primaryProperty=rootObject.properties.get(rootObject.primaryKey);
  if(!primaryProperty?.mapping?.table) throw new SemanticQueryPlanError("QUERY_PLAN_ROOT_MAPPING_MISSING",`根对象 ${rootObject.apiName} 缺少主键映射`);
  const rootTable=primaryProperty.mapping.table;
  const discriminatorSpecs=uniqueDiscriminatorSpecs(semanticPath.objects.flatMap((objectName)=>model.objects.get(objectName).discriminators.map((item)=>({objectName,...item}))));
  const requiredTables=new Set([rootTable,...referencedProperties.map((item)=>item.property.mapping.table),...discriminatorSpecs.map((item)=>item.property.mapping.table)]);
  const physicalPath=resolvePhysicalPath(rootTable,requiredTables,[...candidateRelations.values()]);
  const aliases=new Map([[rootTable,"t0"]]);
  const joins=[];
  const joined=new Set([rootTable]);
  const pending=[...physicalPath.relations];
  while(pending.length) {
    const index=pending.findIndex((relation)=>joined.has(relation.fromTable)!==joined.has(relation.toTable));
    if(index<0) throw new SemanticQueryPlanError("QUERY_PLAN_PHYSICAL_PATH_INVALID","无法生成确定性的物理 JOIN 顺序");
    const relation=pending.splice(index,1)[0];
    const nextTable=joined.has(relation.fromTable)?relation.toTable:relation.fromTable;
    aliases.set(nextTable,`t${aliases.size}`);
    joined.add(nextTable);
    joins.push({relation,nextTable});
  }
  for(const table of requiredTables) if(!joined.has(table)) throw new SemanticQueryPlanError("QUERY_PLAN_TABLE_UNREACHABLE",`映射表 ${table} 无法从根对象连接`);

  const columnInfo=(propertyRef)=>{
    const item=model.properties.get(propertyRef);
    if(!item) throw new SemanticQueryPlanError("QUERY_PLAN_PROPERTY_NOT_FOUND",`属性 ${propertyRef} 不存在`);
    const {table,column}=item.property.mapping;
    const physical=(catalog.columnsByTable?.[table]||[]).find((entry)=>entry.columnName===column);
    if(!physical) throw new SemanticQueryPlanError("QUERY_PLAN_MAPPING_STALE",`属性 ${propertyRef} 的物理映射已失效`);
    if(!aliases.has(table)) throw new SemanticQueryPlanError("QUERY_PLAN_TABLE_UNREACHABLE",`属性 ${propertyRef} 的映射表无法连接`);
    return {item,physical,sql:`${aliases.get(table)}.${quoteId(column)}`};
  };

  const selects=[];
  const groupBy=[];
  for(const dimension of plan.dimensions) {
    const expression=columnInfo(dimension.property).sql;
    selects.push(`${expression} AS ${quoteId(dimension.alias)}`);
    groupBy.push(expression);
  }
  if(plan.timeDimension) {
    const expression=timeExpression(columnInfo(plan.timeDimension.property).sql,plan.timeDimension.grain);
    selects.push(`${expression} AS ${quoteId(plan.timeDimension.alias)}`);
    groupBy.push(expression);
  }
  for(const metric of plan.metrics) selects.push(`${metricExpression(metric,columnInfo)} AS ${quoteId(metric.alias)}`);

  const sqlParts=[`SELECT ${selects.join(", ")}`,`FROM ${quoteId(rootTable)} AS ${aliases.get(rootTable)}`];
  for(const {relation,nextTable} of joins) {
    const table=nextTable;
    const left=`${aliases.get(relation.fromTable)}.${quoteId(relation.fromCol)}`;
    const right=`${aliases.get(relation.toTable)}.${quoteId(relation.toCol)}`;
    sqlParts.push(`JOIN ${quoteId(table)} AS ${aliases.get(table)} ON ${left} = ${right}`);
  }
  const mandatoryFilters=discriminatorSpecs.map((item)=>{
    const {table,column}=item.property.mapping;
    if(!aliases.has(table)) throw new SemanticQueryPlanError("QUERY_PLAN_TABLE_UNREACHABLE",`子类型 ${item.objectName} 的判别字段无法连接`);
    const values=[...item.values];
    const columnSql=`${aliases.get(table)}.${quoteId(column)}`;
    return {object:item.objectName,owner:item.owner,table,column,values,expression:values.length===1?`${columnSql} = ${literal(values[0])}`:`${columnSql} IN (${values.map(literal).join(", ")})`};
  });
  // A planner may restate the subtype discriminator as an ordinary filter.  It
  // is the same immutable ontology requirement, so compile one canonical atom
  // and let the result contract validate that physical row-domain binding.
  const explicitFilters=plan.filters.filter((filter)=>!mandatoryFilters.some((mandatory)=>filterRestatesMandatoryDiscriminator(filter,mandatory,model)));
  const where=[...mandatoryFilters.map((item)=>item.expression),...explicitFilters.map((filter)=>filterExpression(filter,columnInfo))];
  if(where.length) sqlParts.push(`WHERE ${where.join(" AND ")}`);
  if(groupBy.length&&plan.metrics.length) sqlParts.push(`GROUP BY ${groupBy.join(", ")}`);
  else if(groupBy.length&&!plan.metrics.length) sqlParts[0]=`SELECT DISTINCT ${selects.join(", ")}`;
  if(plan.orderBy.length) sqlParts.push(`ORDER BY ${plan.orderBy.map((item)=>`${quoteId(item.field)} ${item.direction.toUpperCase()}`).join(", ")}`);
  const limit=Math.min(Math.max(1,plan.limit),Math.max(1,Number(maxRows)||500));
  sqlParts.push(`LIMIT ${limit}`);

  const usedRelations=joins.map((item)=>item.relation);
  const usedTables=[...aliases.keys()];
  const allowedColumns=Object.fromEntries(usedTables.map((table)=>[table,queryColumnSemantics.allowedColumns[table]||[]]));
  const columnKinds=Object.fromEntries(Object.entries(queryColumnSemantics.columnKinds).filter(([key])=>usedTables.includes(key.split(".")[0])));
  const enums={};
  for(const [key,values] of Object.entries(catalog.enums||{})) {
    const [table,column]=key.split(".");
    if(aliases.has(table)) enums[`${aliases.get(table)}.${column}`]=values;
  }
  return {
    sql:sqlParts.join("\n"),
    plan,
    semanticPath:{...semanticPath,mandatoryFilters:mandatoryFilters.map(publicMandatoryFilter),relations:usedRelations.map((item)=>({id:item.id,fromTable:item.fromTable,fromCol:item.fromCol,toTable:item.toTable,toCol:item.toCol}))},
    semanticContract:semanticRowDomainContract({ontologySchemaVersion,rootObject:plan.rootObject,mandatoryFilters}),
    policy:{allowedTables:usedTables,allowedColumns,columnKinds,allowedRelations:usedRelations,enums,mandatoryFilters:mandatoryFilters.map(publicMandatoryFilter),maxRows:limit},
  };
}

export function semanticPlanningView(schema,catalog=null) {
  const model=createModel(schema);
  return {
    name:schema?.name||"",
    displayName:schema?.displayName||"",
    description:schema?.description||"",
    objectTypes:[...model.objects.values()].map((object)=>({
      apiName:object.apiName,displayName:object.displayName,description:object.description||"",primaryKey:object.primaryKey,...(object.parent?{parent:object.parent,specializes:`${object.parent} (${object.discriminators.map((item)=>`${item.property.apiName} ∈ ${item.values.join(", ")}`).join("; ")})`}:{}),...(object.termBinding?{termBinding:object.termBinding}:{}),
      properties:[...object.properties.values()].map((property)=>{const physical=(catalog?.columnsByTable?.[property.mapping?.table]||[]).find((column)=>column.columnName===property.mapping?.column);return {apiName:property.apiName,displayName:property.displayName,description:property.description||"",type:property.type,required:Boolean(property.required),constraints:property.constraints||{},...(object.ownProperties.has(property.apiName)?{}:{inherited:true}),...(property.termBinding?{termBinding:property.termBinding}:{}),...(physical&&columnSemanticKind(physical)?{semanticKind:columnSemanticKind(physical)}:{})};}),
    })),
    linkTypes:(schema?.linkTypes||[]).map((link)=>({apiName:link.apiName,displayName:link.displayName,description:link.description||`${link.source} 通过 ${link.displayName||link.apiName} 指向 ${link.target}${link.inverseApiName?`；反向为 ${link.inverseDisplayName||link.inverseApiName}`:""}`,source:link.source,target:link.target,cardinality:link.cardinality,...(link.inverseApiName?{inverseApiName:link.inverseApiName,inverseDisplayName:link.inverseDisplayName||link.inverseApiName}: {})})),
  };
}

export class SemanticQueryPlanError extends Error {
  constructor(code,message,details=[]) { super(message);this.name="SemanticQueryPlanError";this.code=code;this.details=details; }
}

function createModel(schema) {
  const objects=new Map();
  const properties=new Map();
  const links=new Map();
  for(const object of schema?.objectTypes||[]) {
    const ownProperties=new Map((object.properties||[]).map((property)=>[property.apiName,property]));
    const normalized={...object,ownProperties,properties:new Map(),tables:new Set(),discriminators:[]};
    objects.set(object.apiName,normalized);
  }
  const resolving=new Set();
  function effective(object) {
    if(object._effective)return object;
    if(resolving.has(object.apiName))return object;
    resolving.add(object.apiName);
    const parent=object.parent?objects.get(object.parent):null;
    if(parent){effective(parent);for(const [name,property] of parent.properties)object.properties.set(name,property);object.primaryKey=object.primaryKey||parent.primaryKey;object.discriminators.push(...parent.discriminators);}
    for(const [name,property] of object.ownProperties)object.properties.set(name,property);
    if(object.discriminator&&parent){const property=parent.properties.get(object.discriminator.property);if(property)object.discriminators.push({owner:object.apiName,property,values:object.discriminator.values||[]});}
    object.tables=new Set([...object.properties.values()].map((item)=>item.mapping?.table).filter(Boolean));
    object._effective=true;resolving.delete(object.apiName);return object;
  }
  for(const object of objects.values()){effective(object);for(const property of object.properties.values())properties.set(`${object.apiName}.${property.apiName}`,{object,property});}
  for(const link of schema?.linkTypes||[]) links.set(link.apiName,link);
  return {objects,properties,links};
}

function descendantNames(model,parentName) {
  const result=[];
  for(const object of model.objects.values()) if(isAncestorObject(model,parentName,object.apiName)) result.push(object.apiName);
  return result;
}

function isAncestorObject(model,ancestorName,descendantName) {
  const seen=new Set();
  let current=model.objects.get(descendantName);
  while(current?.parent&&!seen.has(current.apiName)) {
    seen.add(current.apiName);
    if(current.parent===ancestorName)return true;
    current=model.objects.get(current.parent);
  }
  return false;
}

function discriminatorConflict(object,property,filter) {
  const discriminator=object.discriminators.find((item)=>item.property.apiName===property.apiName&&item.property.mapping?.table===property.mapping?.table&&item.property.mapping?.column===property.mapping?.column);
  if(!discriminator)return null;
  const allowed=discriminator.values.map(String);
  const values=(Array.isArray(filter.value)?filter.value:[filter.value]).filter((value)=>value!=null).map(String);
  let conflict=false;
  if(filter.operator==="eq")conflict=!allowed.includes(values[0]);
  else if(filter.operator==="in")conflict=!values.some((value)=>allowed.includes(value));
  else if(filter.operator==="neq")conflict=allowed.length===1&&allowed[0]===values[0];
  else if(filter.operator==="not_in")conflict=allowed.every((value)=>values.includes(value));
  else if(filter.operator==="is_null")conflict=true;
  return conflict?`${property.apiName} 仅允许 ${discriminator.values.join("、")}`:null;
}

function validatePathObjectCompatibility(model,objectNames,errors) {
  for(let left=0;left<objectNames.length;left++) for(let right=left+1;right<objectNames.length;right++) {
    const leftName=objectNames[left],rightName=objectNames[right];
    if(isAncestorObject(model,leftName,rightName)||isAncestorObject(model,rightName,leftName)) {
      add(errors,"QUERY_PLAN_HIERARCHY_MIXED","$",`同一次查询的语义路径不能同时使用父类型与子类型：${leftName}、${rightName}`);
      continue;
    }
    const conflict=disjointObjectConflict(model.objects.get(leftName),model.objects.get(rightName));
    if(conflict)add(errors,"QUERY_PLAN_DISJOINT_CONFLICT","$",`同一次查询的语义路径包含互斥子类型 ${leftName}、${rightName}：判别属性 ${conflict.property.apiName} 的允许值分别为 ${conflict.leftValues.join("、")} 与 ${conflict.rightValues.join("、")}`);
  }
}

function disjointObjectConflict(left,right) {
  if(!left||!right)return null;
  const leftDomains=discriminatorDomains(left);
  const rightDomains=discriminatorDomains(right);
  for(const [key,leftDomain] of leftDomains) {
    const rightDomain=rightDomains.get(key);
    if(!rightDomain)continue;
    if(!leftDomain.values.some((value)=>rightDomain.values.some((candidate)=>sameValue(value,candidate))))return {property:leftDomain.property,leftValues:leftDomain.values,rightValues:rightDomain.values};
  }
  return null;
}

function discriminatorDomains(object) {
  const domains=new Map();
  for(const discriminator of object.discriminators||[]) {
    const mapping=discriminator.property?.mapping;
    if(!mapping?.table||!mapping?.column)continue;
    const key=`${mapping.table}\u0000${mapping.column}`;
    const values=Array.isArray(discriminator.values)?discriminator.values:[];
    const existing=domains.get(key);
    const narrowed=existing?existing.values.filter((value)=>values.some((candidate)=>sameValue(value,candidate))):values;
    domains.set(key,{property:discriminator.property,values:narrowed});
  }
  return domains;
}
function publicMandatoryFilter(item){return {object:item.object,owner:item.owner,table:item.table,column:item.column,values:item.values};}
function uniqueDiscriminatorSpecs(values) {
  const result=new Map();
  for(const item of values) {
    const mapping=item.property?.mapping||{};
    const key=`${item.owner}|${mapping.table}|${mapping.column}|${(item.values||[]).map(typedLiteralKey).sort().join("\u0000")}`;
    if(!result.has(key))result.set(key,item);
  }
  return [...result.values()].sort((left,right)=>left.objectName.localeCompare(right.objectName)||left.owner.localeCompare(right.owner));
}
function filterRestatesMandatoryDiscriminator(filter,mandatory,model) {
  const property=model.properties.get(filter.property)?.property;
  if(!property||property.mapping?.table!==mandatory.table||property.mapping?.column!==mandatory.column)return false;
  const expected=(mandatory.values||[]).map(typedLiteralKey).sort();
  const actual=filter.operator==="eq"?[typedLiteralKey(filter.value)]:filter.operator==="in"&&Array.isArray(filter.value)?filter.value.map(typedLiteralKey).sort():[];
  return expected.length===actual.length&&expected.every((value,index)=>value===actual[index]);
}
function semanticRowDomainContract({ontologySchemaVersion,rootObject,mandatoryFilters}) {
  const slots=mandatoryFilters.map((filter)=>({
    id:`ontology:${ontologySchemaVersion??"unbound"}:${rootObject}:discriminator:${filter.owner}:${filter.table}.${filter.column}`,
    kind:"semantic_row_domain",role:"ontology_subtype_discriminator",required:true,immutable:true,
    source:"published_ontology",ontologySchemaVersion:ontologySchemaVersion??null,rootObject,
    object:filter.object,owner:filter.owner,table:filter.table,column:filter.column,
    columns:[`${filter.table}.${filter.column}`],operator:filter.values.length===1?"eq":"in",
    values:filter.values.map((value)=>({value,valueType:literalValueType(value)})),
  }));
  return {version:"semantic-row-domain-v1",ontologySchemaVersion:ontologySchemaVersion??null,rootObject,immutable:true,rowDomainSlots:slots};
}
function typedLiteralKey(value){return `${literalValueType(value)}:${String(value)}`;}
function literalValueType(value){if(value===null)return "null";if(typeof value==="number")return "number";if(typeof value==="boolean")return "boolean";return "string";}

function resolveSemanticPath(model,rootObject,targets) {
  const adjacency=new Map([...model.objects.keys()].map((name)=>[name,[]]));
  for(const link of model.links.values()) {
    const sources=[link.source,...descendantNames(model,link.source)];
    const targets=[link.target,...descendantNames(model,link.target)];
    for(const source of sources)for(const target of targets){adjacency.get(source)?.push({object:target,link});adjacency.get(target)?.push({object:source,link});}
  }
  const previous=new Map([[rootObject,null]]);
  const queue=[rootObject];
  while(queue.length) {
    const current=queue.shift();
    for(const edge of adjacency.get(current)||[]) if(!previous.has(edge.object)) { previous.set(edge.object,{object:current,link:edge.link});queue.push(edge.object); }
  }
  const objects=new Set([rootObject]);
  const links=new Set();
  for(const target of targets) {
    if(!previous.has(target)) throw new SemanticQueryPlanError("QUERY_PLAN_SEMANTIC_PATH_MISSING",`对象 ${target} 无法从根对象 ${rootObject} 到达`);
    let current=target;
    while(current!==rootObject) {
      const step=previous.get(current);
      objects.add(current);objects.add(step.object);links.add(step.link.apiName);current=step.object;
    }
  }
  return {rootObject,objects:[...objects],links:[...links]};
}

function resolvePhysicalPath(rootTable,requiredTables,relations) {
  const adjacency=new Map();
  for(const relation of relations.sort((left,right)=>Number(left.id)-Number(right.id))) {
    (adjacency.get(relation.fromTable)??adjacency.set(relation.fromTable,[]).get(relation.fromTable)).push({table:relation.toTable,relation});
    (adjacency.get(relation.toTable)??adjacency.set(relation.toTable,[]).get(relation.toTable)).push({table:relation.fromTable,relation});
  }
  const previous=new Map([[rootTable,null]]);
  const queue=[rootTable];
  while(queue.length) {
    const current=queue.shift();
    for(const edge of adjacency.get(current)||[]) if(!previous.has(edge.table)) { previous.set(edge.table,{table:current,relation:edge.relation});queue.push(edge.table); }
  }
  const selected=new Map();
  for(const target of requiredTables) {
    if(!previous.has(target)) throw new SemanticQueryPlanError("QUERY_PLAN_PHYSICAL_PATH_MISSING",`物理表 ${target} 缺少已确认 JOIN 路径`);
    let current=target;
    while(current!==rootTable) { const step=previous.get(current);selected.set(Number(step.relation.id),step.relation);current=step.table; }
  }
  return {relations:[...selected.values()]};
}

function metricExpression(metric,columnInfo) {
  const expression=metric.property?columnInfo(metric.property).sql:"*";
  if(metric.aggregation==="count_distinct") return `COUNT(DISTINCT ${expression})`;
  return `${metric.aggregation.toUpperCase()}(${expression})`;
}
function timeExpression(expression,grain) {
  if(grain==="day") return `DATE(${expression})`;
  if(grain==="week") return `DATE_FORMAT(${expression}, '%x-W%v')`;
  if(grain==="month") return `DATE_FORMAT(${expression}, '%Y-%m')`;
  if(grain==="quarter") return `CONCAT(YEAR(${expression}), '-Q', QUARTER(${expression}))`;
  return `YEAR(${expression})`;
}
function filterExpression(filter,columnInfo) {
  const column=columnInfo(filter.property).sql;
  const value=filter.value;
  if(filter.operator==="eq") return value===null?`${column} IS NULL`:`${column} = ${literal(value)}`;
  if(filter.operator==="neq") return value===null?`${column} IS NOT NULL`:`${column} <> ${literal(value)}`;
  if(filter.operator==="gt") return `${column} > ${literal(value)}`;
  if(filter.operator==="gte") return `${column} >= ${literal(value)}`;
  if(filter.operator==="lt") return `${column} < ${literal(value)}`;
  if(filter.operator==="lte") return `${column} <= ${literal(value)}`;
  if(filter.operator==="in"||filter.operator==="not_in") return `${column} ${filter.operator==="in"?"IN":"NOT IN"} (${value.map(literal).join(", ")})`;
  if(filter.operator==="between") return `${column} BETWEEN ${literal(value[0])} AND ${literal(value[1])}`;
  if(filter.operator==="contains") return `${column} LIKE ${literal(`%${value}%`)}`;
  return `${column} IS ${filter.operator==="not_null"?"NOT ":""}NULL`;
}
function literal(value) {
  if(value===null) return "NULL";
  if(typeof value==="boolean") return value?"TRUE":"FALSE";
  if(typeof value==="number"&&Number.isFinite(value)) return String(value);
  if(typeof value==="string"&&value.length<=500) return `'${value.replaceAll("\\","\\\\").replaceAll("'","''")}'`;
  throw new SemanticQueryPlanError("QUERY_PLAN_LITERAL_INVALID","过滤值必须是长度不超过 500 的字符串、有限数字、布尔值或 null");
}
function resolveProperty(model,ref,path,errors) {
  const item=model.properties.get(ref);
  if(!item) add(errors,"QUERY_PLAN_PROPERTY_NOT_FOUND",path,`属性 ${ref||"(空)"} 不存在`);
  return item||null;
}
function validateFilterValue(operator,value,propertyInfo,path,errors) {
  if(["is_null","not_null"].includes(operator)) return;
  if(["in","not_in"].includes(operator)&&(!Array.isArray(value)||!value.length)) add(errors,"QUERY_PLAN_FILTER_VALUE_INVALID",path,`${operator} 必须提供非空数组`);
  else if(operator==="between"&&(!Array.isArray(value)||value.length!==2)) add(errors,"QUERY_PLAN_FILTER_VALUE_INVALID",path,"between 必须提供两个边界值");
  else if(!["in","not_in","between"].includes(operator)&&(Array.isArray(value)||!isLiteral(value))) add(errors,"QUERY_PLAN_FILTER_VALUE_INVALID",path,"过滤值类型不合法");
  const values=Array.isArray(value)?value:[value];
  if(values.some((item)=>!isLiteral(item))) add(errors,"QUERY_PLAN_FILTER_VALUE_INVALID",path,"过滤值只允许字符串、有限数字、布尔值或 null");
  const enumValues=propertyInfo?.property?.constraints?.enumValues;
  if(enumValues?.length&&values.some((item)=>item!=null&&!enumValues.map(String).includes(String(item)))) add(errors,"QUERY_PLAN_ENUM_VALUE_INVALID",path,`过滤值不在 ${propertyInfo.object.apiName}.${propertyInfo.property.apiName} 的枚举范围内`);
  if(operator==="contains"&&propertyInfo&&!new Set(["string","enum"]).has(propertyInfo.property.type)) add(errors,"QUERY_PLAN_FILTER_OPERATOR_TYPE_INVALID",path,"contains 只适用于 string 或 enum 属性");
}
function normalizeLimit(value,errors) { if(value==null)return 100;const limit=Number(value);if(!Number.isInteger(limit)||limit<1||limit>500){add(errors,"QUERY_PLAN_ROW_LIMIT_INVALID","limit","limit 必须是 1 到 500 的整数");return 100;}return limit; }
function validateAlias(value,path,errors) { if(!API_NAME_PATTERN.test(value)) add(errors,"QUERY_PLAN_ALIAS_INVALID",path,`别名 ${value||"(空)"} 必须以小写字母开头，且只包含小写字母、数字和下划线`); }
function quoteId(value) { return `\`${String(value).replaceAll("`","``")}\``; }
function isConfirmed(relation) { return ["confirmed","accepted"].includes(relation.status); }
function sameValue(left,right) { return String(left)===String(right); }
function isLiteral(value) { return value===null||typeof value==="string"&&value.length<=500||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value); }
function text(value) { return typeof value==="string"?value.trim():""; }
function lastPart(value) { return String(value||"").split(".").at(-1)||""; }
function isRecord(value) { return Boolean(value)&&typeof value==="object"&&!Array.isArray(value); }
function add(errors,code,path,message) { if(errors.length<200)errors.push({code,path,message}); }

export const semanticQueryPlanConstants={aggregations:[...AGGREGATIONS],filterOperators:[...FILTER_OPERATORS],timeGrains:[...TIME_GRAINS]};
