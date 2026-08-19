import { findKnowledgeOntologyConflicts, schemaMappedColumns } from "./knowledge-column-refs.mjs";

const API_NAME_PATTERN=/^[a-z][a-z0-9_]*$/;
const NAMESPACE_PATTERN=/^[a-z][a-z0-9_-]*$/;
const PROPERTY_TYPES=new Set(["string","integer","number","boolean","date","datetime","enum"]);
const CARDINALITIES=new Set(["one_to_one","one_to_many","many_to_one","many_to_many"]);
const FRESHNESS_VALUES=new Set(["realtime","hourly","daily","batch"]);
const RELATION_KINDS=new Set(["contains","references","temporal"]);
const TERM_MATCHES=new Set(["exact","close","broader"]);
const DISCRIMINATOR_TYPES=new Set(["enum","string","integer"]);
const MAX_OBJECT_TYPES=1_000;
const MAX_PROPERTIES=20_000;
const MAX_LINK_TYPES=5_000;
const MAX_DISJOINT_GROUPS=50;
const MAX_HIERARCHY_DEPTH=3;

export function validateSemanticSchema(input,catalog={}) {
  const errors=[];
  const warnings=[];
  const raw=isRecord(input)?input:{};
  if(!isRecord(input)) add(errors,"ONTOLOGY_SCHEMA_INVALID","$","Schema 必须是 JSON 对象");
  const schema={
    name:text(raw.name),displayName:text(raw.displayName),description:text(raw.description),
    objectTypes:[],linkTypes:[],disjointGroups:normalizeDisjointGroups(raw.disjointGroups,errors),
  };
  if(!schema.name) add(errors,"ONTOLOGY_NAME_REQUIRED","name","name 必填");
  else if(!API_NAME_PATTERN.test(schema.name)) add(errors,"ONTOLOGY_API_NAME_INVALID","name","name 必须以小写字母开头，且只包含小写字母、数字和下划线");
  if(!schema.displayName) schema.displayName=schema.name;

  const tableByName=new Map((catalog.tables||[]).map((table)=>[table.tableName,table]));
  const columnsByTable=catalog.columnsByTable||{};
  const relationById=new Map((catalog.relations||[]).map((relation)=>[Number(relation.id),relation]));
  const anchors=Array.isArray(catalog.termAnchors)?catalog.termAnchors:[];
  const objectInputs=Array.isArray(raw.objectTypes)?raw.objectTypes:[];
  if(!Array.isArray(raw.objectTypes)||!objectInputs.length) add(errors,"ONTOLOGY_OBJECT_TYPES_REQUIRED","objectTypes","objectTypes 必须是非空数组");
  if(objectInputs.length>MAX_OBJECT_TYPES) add(errors,"ONTOLOGY_LIMIT_EXCEEDED","objectTypes",`Object Type 最多允许 ${MAX_OBJECT_TYPES} 个`);

  const objectByName=new Map();
  let propertyCount=0;
  for(const [objectIndex,objectInput] of objectInputs.slice(0,MAX_OBJECT_TYPES).entries()) {
    const objectPath=`objectTypes[${objectIndex}]`;
    const objectRaw=isRecord(objectInput)?objectInput:{};
    if(!isRecord(objectInput)) add(errors,"ONTOLOGY_OBJECT_INVALID",objectPath,"Object Type 必须是 JSON 对象");
    const namespace=text(objectRaw.namespace);
    const freshness=text(objectRaw.freshness).toLowerCase();
    const parent=text(objectRaw.parent);
    const objectType={
      apiName:text(objectRaw.apiName),displayName:text(objectRaw.displayName),description:text(objectRaw.description),primaryKey:text(objectRaw.primaryKey),
      ...(namespace?{namespace}:{}),...(freshness?{freshness}:{}),...(parent?{parent}:{}),
      ...(objectRaw.discriminator!=null?{discriminator:normalizeDiscriminator(objectRaw.discriminator,`${objectPath}.discriminator`,errors)}:{}),
      ...(objectRaw.termBinding!=null?{termBinding:normalizeTermBinding(objectRaw.termBinding,`${objectPath}.termBinding`,errors)}:{}),
      properties:[],_index:objectIndex,
    };
    validateApiName(objectType.apiName,`${objectPath}.apiName`,"Object Type",errors);
    if(objectType.apiName&&objectByName.has(objectType.apiName)) add(errors,"ONTOLOGY_OBJECT_DUPLICATE",`${objectPath}.apiName`,`Object Type ${objectType.apiName} 重复定义`);
    else if(objectType.apiName) objectByName.set(objectType.apiName,objectType);
    if(!objectType.displayName) objectType.displayName=objectType.apiName;
    if(namespace&&!NAMESPACE_PATTERN.test(namespace)) add(errors,"ONTOLOGY_NAMESPACE_INVALID",`${objectPath}.namespace`,"namespace 必须以小写字母开头，且只包含小写字母、数字、下划线和连字符");
    if(freshness&&!FRESHNESS_VALUES.has(freshness)) add(errors,"ONTOLOGY_FRESHNESS_INVALID",`${objectPath}.freshness`,`freshness 必须是 ${[...FRESHNESS_VALUES].join("、")} 之一`);

    const properties=Array.isArray(objectRaw.properties)?objectRaw.properties:[];
    if(!Array.isArray(objectRaw.properties)||(properties.length===0&&!parent)) add(errors,"ONTOLOGY_PROPERTIES_REQUIRED",`${objectPath}.properties`,parent?"子类型 properties 必须是数组":"properties 必须是非空数组");
    propertyCount+=properties.length;
    const ownPropertyByName=new Map();
    for(const [propertyIndex,propertyInput] of properties.entries()) {
      const propertyPath=`${objectPath}.properties[${propertyIndex}]`;
      const propertyRaw=isRecord(propertyInput)?propertyInput:{};
      if(!isRecord(propertyInput)) add(errors,"ONTOLOGY_PROPERTY_INVALID",propertyPath,"Property 必须是 JSON 对象");
      const propertyFreshness=text(propertyRaw.freshness).toLowerCase();
      const property={
        apiName:text(propertyRaw.apiName),displayName:text(propertyRaw.displayName),description:text(propertyRaw.description),type:text(propertyRaw.type).toLowerCase(),required:Boolean(propertyRaw.required),
        ...(propertyFreshness?{freshness:propertyFreshness}:{}),
        ...(propertyRaw.termBinding!=null?{termBinding:normalizeTermBinding(propertyRaw.termBinding,`${propertyPath}.termBinding`,errors)}:{}),
        constraints:normalizeConstraints(propertyRaw.constraints,propertyRaw.type,`${propertyPath}.constraints`,errors),mapping:normalizeMapping(propertyRaw.mapping),
      };
      validateApiName(property.apiName,`${propertyPath}.apiName`,"Property",errors);
      if(property.apiName&&ownPropertyByName.has(property.apiName)) add(errors,"ONTOLOGY_PROPERTY_DUPLICATE",`${propertyPath}.apiName`,`Property ${objectType.apiName}.${property.apiName} 重复定义`);
      else if(property.apiName) ownPropertyByName.set(property.apiName,property);
      if(!property.displayName) property.displayName=property.apiName;
      if(!PROPERTY_TYPES.has(property.type)) add(errors,"ONTOLOGY_PROPERTY_TYPE_INVALID",`${propertyPath}.type`,`不支持的属性类型 ${property.type||"(空)"}`);
      if(propertyFreshness&&!FRESHNESS_VALUES.has(propertyFreshness)) add(errors,"ONTOLOGY_FRESHNESS_INVALID",`${propertyPath}.freshness`,`freshness 必须是 ${[...FRESHNESS_VALUES].join("、")} 之一`);
      validatePhysicalMapping(property,propertyPath,tableByName,columnsByTable,errors,warnings);
      objectType.properties.push(property);
    }
    objectType._ownPropertyByName=ownPropertyByName;
    schema.objectTypes.push(objectType);
  }
  if(propertyCount>MAX_PROPERTIES) add(errors,"ONTOLOGY_LIMIT_EXCEEDED","objectTypes",`全部 Property 合计最多允许 ${MAX_PROPERTIES} 个`);

  validateHierarchy(schema,objectByName,catalog,errors,warnings);
  validateTermBindings(schema,anchors,errors);
  validateDisjointGroups(schema,objectByName,errors);

  const linkInputs=Array.isArray(raw.linkTypes)?raw.linkTypes:[];
  if(raw.linkTypes!=null&&!Array.isArray(raw.linkTypes)) add(errors,"ONTOLOGY_LINK_TYPES_INVALID","linkTypes","linkTypes 必须是数组");
  if(linkInputs.length>MAX_LINK_TYPES) add(errors,"ONTOLOGY_LIMIT_EXCEEDED","linkTypes",`Link Type 最多允许 ${MAX_LINK_TYPES} 个`);
  const linkNames=new Set();
  const allLinkNames=new Map();
  for(const [linkIndex,linkInput] of linkInputs.slice(0,MAX_LINK_TYPES).entries()) {
    const linkPath=`linkTypes[${linkIndex}]`;
    const linkRaw=isRecord(linkInput)?linkInput:{};
    if(!isRecord(linkInput)) add(errors,"ONTOLOGY_LINK_INVALID",linkPath,"Link Type 必须是 JSON 对象");
    const relationKind=text(linkRaw.relationKind).toLowerCase();
    const inverseApiName=text(linkRaw.inverseApiName);
    const inverseDisplayName=text(linkRaw.inverseDisplayName);
    const linkType={
      apiName:text(linkRaw.apiName),displayName:text(linkRaw.displayName),description:text(linkRaw.description),source:text(linkRaw.source),target:text(linkRaw.target),cardinality:text(linkRaw.cardinality),sourceLabel:text(linkRaw.sourceLabel),targetLabel:text(linkRaw.targetLabel),
      ...(inverseApiName?{inverseApiName,inverseDisplayName:inverseDisplayName||inverseApiName}:{}),...(relationKind?{relationKind}:{}),relationMappings:normalizeRelationMappings(linkRaw.relationMappings),
    };
    validateApiName(linkType.apiName,`${linkPath}.apiName`,"Link Type",errors);
    const duplicateApiName=Boolean(linkType.apiName&&linkNames.has(linkType.apiName));
    if(duplicateApiName) add(errors,"ONTOLOGY_LINK_DUPLICATE",`${linkPath}.apiName`,`Link Type ${linkType.apiName} 重复定义`);
    else if(linkType.apiName)linkNames.add(linkType.apiName);
    if(inverseApiName) validateApiName(inverseApiName,`${linkPath}.inverseApiName`,"反向 Link Type",errors);
    for(const [value,path] of [[duplicateApiName?"":linkType.apiName,`${linkPath}.apiName`],[inverseApiName,`${linkPath}.inverseApiName`]]) if(value) {
      if(allLinkNames.has(value)) add(errors,"ONTOLOGY_LINK_INVERSE_DUPLICATE",path,`关系名称 ${value} 与 ${allLinkNames.get(value)} 重复`);
      else allLinkNames.set(value,path);
    }
    if(!linkType.displayName) linkType.displayName=linkType.apiName;
    if(!CARDINALITIES.has(linkType.cardinality)) add(errors,"ONTOLOGY_CARDINALITY_INVALID",`${linkPath}.cardinality`,`cardinality 必须是 ${[...CARDINALITIES].join("、")} 之一`);
    if(relationKind&&!RELATION_KINDS.has(relationKind)) add(errors,"ONTOLOGY_RELATION_KIND_INVALID",`${linkPath}.relationKind`,`relationKind 必须是 ${[...RELATION_KINDS].join("、")} 之一`);
    const source=objectByName.get(linkType.source);
    const target=objectByName.get(linkType.target);
    if(!source) add(errors,"ONTOLOGY_LINK_SOURCE_NOT_FOUND",`${linkPath}.source`,`源对象类型 ${linkType.source||"(空)"} 不存在`);
    if(!target) add(errors,"ONTOLOGY_LINK_TARGET_NOT_FOUND",`${linkPath}.target`,`目标对象类型 ${linkType.target||"(空)"} 不存在`);
    if(source&&target&&(isAncestor(source,target,objectByName)||isAncestor(target,source,objectByName))) add(errors,"ONTOLOGY_LINK_HIERARCHY_AMBIGUOUS",linkPath,"同一 Link 的两个端点不能同时引用父类型及其子类型");
    if(source&&target&&source===target&&!inverseApiName) warnings.push(issue("ONTOLOGY_LINK_SELF_INVERSE_MISSING",`${linkPath}.inverseApiName`,`自引用关系 ${linkType.apiName} 应显式提供 inverseApiName 以区分两个方向`));
    validateLinkMappings(linkType,linkPath,source,target,relationById,errors,warnings);
    schema.linkTypes.push(linkType);
  }

  for(const objectType of schema.objectTypes) for(const key of Object.keys(objectType)) if(key.startsWith("_")) delete objectType[key];
  if(!schema.disjointGroups.length) delete schema.disjointGroups;
  validateKnowledgeCoverage(schema,catalog,warnings);
  validateDisjointKnowledge(schema,catalog,warnings);
  return {ok:errors.length===0,schema,errors,warnings,summary:{objectTypes:schema.objectTypes.length,properties:propertyCount,linkTypes:schema.linkTypes.length,errorCount:errors.length,warningCount:warnings.length}};
}

function validateHierarchy(schema,objectByName,catalog,errors,warnings) {
  const state=new Map();
  const visit=(object,stack=[])=>{
    if(state.get(object)==="done") return;
    if(state.get(object)==="visiting") { add(errors,"ONTOLOGY_HIERARCHY_CYCLE",`objectTypes[${object._index}].parent`,`继承链存在环：${[...stack,object.apiName].join(" → ")}`);return; }
    state.set(object,"visiting");
    const parent=object.parent?objectByName.get(object.parent):null;
    if(object.parent&&!parent) add(errors,"ONTOLOGY_PARENT_NOT_FOUND",`objectTypes[${object._index}].parent`,`父类型 ${object.parent} 不存在`);
    if(parent) visit(parent,[...stack,object.apiName]);
    state.set(object,"done");
  };
  for(const object of schema.objectTypes) visit(object);

  const ordered=[...schema.objectTypes].sort((left,right)=>hierarchyDepth(left,objectByName)-hierarchyDepth(right,objectByName));
  for(const object of ordered) {
    const path=`objectTypes[${object._index}]`;
    const chain=hierarchyChain(object,objectByName);
    object._chain=chain;
    object._depth=Math.max(0,chain.length-1);
    if(object._depth>MAX_HIERARCHY_DEPTH) add(errors,"ONTOLOGY_HIERARCHY_TOO_DEEP",`${path}.parent`,`继承深度 ${object._depth} 超过上限 ${MAX_HIERARCHY_DEPTH}`);
    if(object.parent&&!object.discriminator) add(errors,"ONTOLOGY_DISCRIMINATOR_REQUIRED",`${path}.discriminator`,`子类型必须声明 discriminator`);
    if(!object.parent&&object.discriminator) add(errors,"ONTOLOGY_DISCRIMINATOR_REQUIRED",`${path}.parent`,`只有声明 parent 的子类型才能声明 discriminator`);

    const effective=new Map();
    for(const item of chain) for(const property of item.properties||[]) {
      if(effective.has(property.apiName)&&item===object) add(errors,"ONTOLOGY_PROPERTY_SHADOWED",`${path}.properties`,`子类型 ${object.apiName} 不得覆盖继承属性 ${property.apiName}`);
      else if(!effective.has(property.apiName)) effective.set(property.apiName,property);
    }
    object._propertyByName=effective;
    object._tables=new Set([...effective.values()].map((property)=>property.mapping.table).filter(Boolean));
    const parent=object.parent?objectByName.get(object.parent):null;
    if(parent) {
      if(object.primaryKey&&object.primaryKey!==parent.primaryKey) add(errors,"ONTOLOGY_PRIMARY_KEY_INHERITED",`${path}.primaryKey`,`子类型必须继承父类型主键 ${parent.primaryKey}，不支持覆盖`);
      object.primaryKey=parent.primaryKey;
      validateDiscriminator(object,parent,path,catalog,errors,warnings);
    }
    validatePrimaryKey(object,path,catalog.columnsByTable||{},errors);
    validateObjectTableConnectivity(object,path,catalog.relations||[],errors);
    object._discriminators=chain.filter((item)=>item.discriminator).map((item)=>({
      object:item,
      property:item.parent?objectByName.get(item.parent)?._propertyByName?.get(item.discriminator.property):null,
      values:item.discriminator.values,
    })).filter((item)=>item.property);
  }

  const children=Object.groupBy(schema.objectTypes.filter((item)=>item.parent),(item)=>item.parent);
  for(const siblings of Object.values(children)) for(let left=0;left<siblings.length;left++) for(let right=left+1;right<siblings.length;right++) {
    const a=siblings[left],b=siblings[right];
    if(!a.discriminator||!b.discriminator||a.discriminator.property!==b.discriminator.property) continue;
    const overlap=a.discriminator.values.filter((value)=>b.discriminator.values.some((candidate)=>sameValue(value,candidate)));
    if(overlap.length) warnings.push(issue("ONTOLOGY_SIBLING_OVERLAP",`objectTypes[${b._index}].discriminator.values`,`兄弟子类型 ${a.apiName} 与 ${b.apiName} 的判别值重叠：${overlap.join("、")}`));
  }
}

function validateDiscriminator(object,parent,path,catalog,errors,warnings) {
  const discriminator=object.discriminator;
  if(!discriminator) return;
  const property=parent._propertyByName?.get(discriminator.property);
  if(!property||!DISCRIMINATOR_TYPES.has(property.type)) {
    add(errors,"ONTOLOGY_DISCRIMINATOR_PROPERTY_INVALID",`${path}.discriminator.property`,`判别属性 ${discriminator.property||"(空)"} 必须是父类型继承链上的 enum/string/integer 属性`);
    return;
  }
  if(!discriminator.values.length) { add(errors,"ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",`${path}.discriminator.values`,`discriminator.values 必须是非空数组`);return; }
  const declared=property.constraints?.enumValues||[];
  const key=`${property.mapping.table}.${property.mapping.column}`;
  const probed=catalog.enums?.[key]||(catalog.enumsByTable?.[property.mapping.table]||[]).filter((item)=>item.columnName===property.mapping.column).map((item)=>item.value);
  const profile=(catalog.columnsByTable?.[property.mapping.table]||[]).find((item)=>item.columnName===property.mapping.column)?.profile;
  const profileSamples=Array.isArray(profile?.sampleValues)?profile.sampleValues:[];
  const evidence=declared.length?declared:Array.isArray(probed)&&probed.length?probed:profileSamples;
  if(!evidence.length) { warnings.push(issue("ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",`${path}.discriminator.values`,`判别属性 ${key} 缺少枚举或字段画像证据，发布前应完成探查`));return; }
  const invalid=discriminator.values.filter((value)=>!evidence.some((candidate)=>sameValue(value,candidate)));
  if(invalid.length&&profileSamples.length&&!declared.length&&!(Array.isArray(probed)&&probed.length)) warnings.push(issue("ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",`${path}.discriminator.values`,`判别值 ${invalid.join("、")} 未在 ${key} 的有限画像样本中出现；样本不完整，发布前应补充枚举探查`));
  else if(invalid.length) add(errors,"ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",`${path}.discriminator.values`,`判别值 ${invalid.join("、")} 未在 ${key} 的真实取值证据中出现`);
}

function validatePrimaryKey(object,path,columnsByTable,errors) {
  if(!object.primaryKey) { add(errors,"ONTOLOGY_PRIMARY_KEY_REQUIRED",`${path}.primaryKey`,`primaryKey 必填`);return; }
  const property=object._propertyByName.get(object.primaryKey);
  if(!property) { add(errors,"ONTOLOGY_PRIMARY_KEY_NOT_FOUND",`${path}.primaryKey`,`主键属性 ${object.primaryKey} 未在可见 properties 中定义`);return; }
  if(!property.required) add(errors,"ONTOLOGY_PRIMARY_KEY_NOT_REQUIRED",`${path}.primaryKey`,`主键属性 ${object.primaryKey} 必须标记 required`);
  if(!property.mapping.table||!property.mapping.column) add(errors,"ONTOLOGY_PRIMARY_KEY_NOT_MAPPED",`${path}.primaryKey`,`主键属性 ${object.primaryKey} 必须映射物理字段`);
  const column=(columnsByTable[property.mapping.table]||[]).find((item)=>item.columnName===property.mapping.column);
  if(column&&!column.isPrimary&&!column.isUnique) add(errors,"ONTOLOGY_PRIMARY_KEY_NOT_UNIQUE",`${path}.primaryKey`,`主键映射 ${property.mapping.table}.${property.mapping.column} 不是已知主键或唯一字段`);
}

function validatePhysicalMapping(property,path,tableByName,columnsByTable,errors,warnings) {
  const {table,column}=property.mapping;
  if(!table) add(errors,"ONTOLOGY_MAPPING_TABLE_REQUIRED",`${path}.mapping.table`,`属性必须映射物理表`);
  if(!column) add(errors,"ONTOLOGY_MAPPING_COLUMN_REQUIRED",`${path}.mapping.column`,`属性必须映射物理字段`);
  if(!table||!column) return;
  const tableInfo=tableByName.get(table);
  if(!tableInfo) { add(errors,"ONTOLOGY_MAPPING_TABLE_NOT_FOUND",`${path}.mapping.table`,`映射表 ${table} 不存在或已失效`);return; }
  if(tableInfo.active===0||tableInfo.grade==="C") add(errors,"ONTOLOGY_MAPPING_TABLE_UNAVAILABLE",`${path}.mapping.table`,`映射表 ${table} 当前不可用于查询`);
  const columnInfo=(columnsByTable[table]||[]).find((item)=>item.columnName===column);
  if(!columnInfo) { add(errors,"ONTOLOGY_MAPPING_COLUMN_NOT_FOUND",`${path}.mapping.column`,`映射字段 ${table}.${column} 不存在或已失效`);return; }
  if(columnInfo.isSensitive) warnings.push(issue("ONTOLOGY_MAPPING_SENSITIVE_COLUMN",`${path}.mapping.column`,`映射字段 ${table}.${column} 是敏感字段，后续查询仍会被安全护栏阻止`));
  if(property.required&&columnInfo.nullable) warnings.push(issue("ONTOLOGY_REQUIRED_MAPPING_NULLABLE",`${path}.required`,`必填属性映射到可空字段 ${table}.${column}`));
  if(PROPERTY_TYPES.has(property.type)&&!compatibleType(property.type,columnInfo.dataType)) add(errors,"ONTOLOGY_MAPPING_TYPE_MISMATCH",`${path}.type`,`语义类型 ${property.type} 与物理类型 ${columnInfo.dataType} 不兼容`);
}

function validateObjectTableConnectivity(object,path,relations,errors) {
  const tables=[...object._tables];
  if(tables.length<2) return;
  const visited=reachableTables(new Set([tables[0]]),relations.filter(isConfirmedRelation));
  const missing=tables.filter((table)=>!visited.has(table));
  if(missing.length) add(errors,"ONTOLOGY_OBJECT_TABLES_DISCONNECTED",`${path}.properties`,`对象 ${object.apiName} 映射的物理表缺少已确认 JOIN：${missing.join("、")}`);
}

function validateLinkMappings(link,path,source,target,relationById,errors,warnings) {
  if(!link.relationMappings.length) { add(errors,"ONTOLOGY_LINK_MAPPING_REQUIRED",`${path}.relationMappings`,`Link Type 必须绑定至少一条已确认物理 JOIN`);return; }
  const mapped=[];const ids=new Set();
  for(const [index,mapping] of link.relationMappings.entries()) {
    const targetPath=`${path}.relationMappings[${index}].relationId`;
    if(!Number.isInteger(mapping.relationId)||mapping.relationId<=0) { add(errors,"ONTOLOGY_RELATION_ID_INVALID",targetPath,"relationId 必须是正整数");continue; }
    if(ids.has(mapping.relationId)) { add(errors,"ONTOLOGY_RELATION_MAPPING_DUPLICATE",targetPath,`物理 JOIN ${mapping.relationId} 重复绑定`);continue; }
    ids.add(mapping.relationId);
    const relation=relationById.get(mapping.relationId);
    if(!relation) { add(errors,"ONTOLOGY_RELATION_NOT_FOUND",targetPath,`物理 JOIN ${mapping.relationId} 不存在或已失效`);continue; }
    if(!isConfirmedRelation(relation)) { add(errors,"ONTOLOGY_RELATION_NOT_CONFIRMED",targetPath,`物理 JOIN ${mapping.relationId} 尚未确认，当前状态为 ${relation.status||"unknown"}`);continue; }
    mapped.push(relation);
  }
  if(!source||!target||!mapped.length) return;
  const reached=reachableTables(new Set(source._tables),mapped);
  if(![...target._tables].some((table)=>reached.has(table))) add(errors,"ONTOLOGY_LINK_PATH_DISCONNECTED",`${path}.relationMappings`,`物理 JOIN 无法连接 ${link.source} 与 ${link.target}`);
  if(mapped.length===1) {
    const observed=orientedCardinality(mapped[0],source._tables,target._tables);
    if(observed&&link.cardinality&&observed!==link.cardinality) warnings.push(issue("ONTOLOGY_CARDINALITY_MISMATCH",`${path}.cardinality`,`声明基数 ${link.cardinality} 与已探查基数 ${observed} 不一致`));
  }
}

function validateDisjointGroups(schema,objectByName,errors) {
  for(const [groupIndex,group] of (schema.disjointGroups||[]).entries()) {
    const objects=group.map((name,index)=>{
      const object=objectByName.get(name);
      if(!object) add(errors,"ONTOLOGY_DISJOINT_MEMBER_NOT_FOUND",`disjointGroups[${groupIndex}][${index}]`,`互斥成员 ${name} 不是已定义的 Object Type`);
      return object;
    }).filter(Boolean);
    for(let left=0;left<objects.length;left++) for(let right=left+1;right<objects.length;right++) {
      const a=objects[left],b=objects[right];
      if(![...a._tables].some((table)=>b._tables.has(table))) continue;
      if(!hasDisjointPhysicalEvidence(a,b)) add(errors,"ONTOLOGY_DISJOINT_UNSATISFIABLE",`disjointGroups[${groupIndex}]`,`互斥对象 ${a.apiName} 与 ${b.apiName} 共享物理行集，却没有不相交的判别值证据`);
    }
  }
}

function hasDisjointPhysicalEvidence(a,b) {
  for(const left of a._discriminators||[]) for(const right of b._discriminators||[]) {
    if(left.property.mapping.table===right.property.mapping.table&&left.property.mapping.column===right.property.mapping.column&&!left.values.some((value)=>right.values.some((candidate)=>sameValue(value,candidate)))) return true;
  }
  return false;
}

function validateTermBindings(schema,anchors,errors) {
  const anchorByKey=new Map(anchors.map((anchor)=>[termKey(anchor.vocabulary,anchor.canonicalId),anchor]));
  const exact=new Map();
  for(const object of schema.objectTypes) {
    check(object.termBinding,"object",`objectTypes[${object._index}].termBinding`,object.apiName);
    for(const [index,property] of object.properties.entries()) check(property.termBinding,"property",`objectTypes[${object._index}].properties[${index}].termBinding`,`${object.apiName}.${property.apiName}`);
  }
  function check(binding,kind,path,label) {
    if(!binding) return;
    const key=termKey(binding.vocabulary,binding.canonicalId);
    const anchor=anchorByKey.get(key);
    if(!anchor) { add(errors,"ONTOLOGY_TERM_ANCHOR_NOT_FOUND",path,`术语锚点 ${binding.vocabulary}:${binding.canonicalId} 不存在`);return; }
    if(anchor.kind!==kind) add(errors,"ONTOLOGY_TERM_ANCHOR_KIND_MISMATCH",path,`术语锚点 ${binding.vocabulary}:${binding.canonicalId} 的 kind=${anchor.kind}，不能绑定到 ${kind}`);
    if(binding.match==="exact") {
      if(exact.has(key)) add(errors,"ONTOLOGY_TERM_EXACT_DUPLICATE",path,`精确术语锚点 ${binding.vocabulary}:${binding.canonicalId} 已绑定到 ${exact.get(key)}`);
      else exact.set(key,label);
    }
  }
}

function normalizeDisjointGroups(input,errors) {
  if(input==null) return [];
  if(!Array.isArray(input)) { add(errors,"ONTOLOGY_DISJOINT_GROUP_INVALID","disjointGroups","disjointGroups 必须是数组");return []; }
  if(input.length>MAX_DISJOINT_GROUPS) add(errors,"ONTOLOGY_LIMIT_EXCEEDED","disjointGroups",`互斥组最多允许 ${MAX_DISJOINT_GROUPS} 个`);
  return input.slice(0,MAX_DISJOINT_GROUPS).map((group,index)=>{
    if(!Array.isArray(group)) { add(errors,"ONTOLOGY_DISJOINT_GROUP_INVALID",`disjointGroups[${index}]`,`互斥组必须是数组`);return []; }
    const values=[...new Set(group.map(text).filter(Boolean))];
    if(values.length<2) add(errors,"ONTOLOGY_DISJOINT_GROUP_INVALID",`disjointGroups[${index}]`,`互斥组至少包含两个不同对象`);
    return values;
  });
}

function normalizeDiscriminator(input,path,errors) {
  if(!isRecord(input)) { add(errors,"ONTOLOGY_DISCRIMINATOR_REQUIRED",path,"discriminator 必须是对象");return {property:"",values:[]}; }
  const values=Array.isArray(input.values)?[...new Map(input.values.filter(isDiscriminatorValue).map((value)=>[`${typeof value}:${String(value)}`,value])).values()]:[];
  if(!Array.isArray(input.values)) add(errors,"ONTOLOGY_DISCRIMINATOR_VALUE_UNVERIFIED",`${path}.values`,`values 必须是数组`);
  return {property:text(input.property),values};
}

function normalizeTermBinding(input,path,errors) {
  if(!isRecord(input)) { add(errors,"ONTOLOGY_TERM_BINDING_INVALID",path,"termBinding 必须是对象");return {vocabulary:"",canonicalId:"",match:"exact"}; }
  const binding={vocabulary:text(input.vocabulary),canonicalId:text(input.canonicalId),match:text(input.match).toLowerCase()||"exact"};
  if(!binding.vocabulary||!binding.canonicalId) add(errors,"ONTOLOGY_TERM_BINDING_INVALID",path,"termBinding 必须包含 vocabulary 与 canonicalId");
  if(!TERM_MATCHES.has(binding.match)) add(errors,"ONTOLOGY_TERM_BINDING_INVALID",`${path}.match`,`match 必须是 ${[...TERM_MATCHES].join("、")} 之一`);
  return binding;
}

function normalizeConstraints(input,type,path,errors) {
  if(input==null) return {};
  if(!isRecord(input)) { add(errors,"ONTOLOGY_CONSTRAINTS_INVALID",path,"constraints 必须是 JSON 对象");return {}; }
  const result={};
  for(const key of ["minimum","maximum"]) if(input[key]!=null) { const value=Number(input[key]);if(!Number.isFinite(value)) add(errors,"ONTOLOGY_CONSTRAINT_INVALID",`${path}.${key}`,`${key} 必须是数字`);else result[key]=value; }
  for(const key of ["minLength","maxLength"]) if(input[key]!=null) { const value=Number(input[key]);if(!Number.isInteger(value)||value<0) add(errors,"ONTOLOGY_CONSTRAINT_INVALID",`${path}.${key}`,`${key} 必须是非负整数`);else result[key]=value; }
  if(result.minimum!=null&&result.maximum!=null&&result.minimum>result.maximum) add(errors,"ONTOLOGY_CONSTRAINT_RANGE_INVALID",path,"minimum 不能大于 maximum");
  if(result.minLength!=null&&result.maxLength!=null&&result.minLength>result.maxLength) add(errors,"ONTOLOGY_CONSTRAINT_RANGE_INVALID",path,"minLength 不能大于 maxLength");
  if(input.pattern!=null) { result.pattern=text(input.pattern);try { new RegExp(result.pattern); } catch { add(errors,"ONTOLOGY_CONSTRAINT_PATTERN_INVALID",`${path}.pattern`,`pattern 不是合法正则表达式`); } }
  if(input.enumValues!=null) { if(!Array.isArray(input.enumValues)) add(errors,"ONTOLOGY_ENUM_VALUES_INVALID",`${path}.enumValues`,`enumValues 必须是数组`);else result.enumValues=[...new Set(input.enumValues.map(text).filter(Boolean))]; }
  if(text(type).toLowerCase()==="enum"&&!result.enumValues?.length) add(errors,"ONTOLOGY_ENUM_VALUES_REQUIRED",`${path}.enumValues`,`enum 类型必须声明非空 enumValues`);
  return result;
}

function normalizeMapping(input) { return isRecord(input)?{table:text(input.table),column:text(input.column)}:{table:"",column:""}; }
function normalizeRelationMappings(input) { return Array.isArray(input)?input.map((item)=>({relationId:Number(isRecord(item)?item.relationId:item)})):[]; }
function validateApiName(value,path,label,errors) { if(!value) add(errors,"ONTOLOGY_API_NAME_REQUIRED",path,`${label} apiName 必填`);else if(!API_NAME_PATTERN.test(value)) add(errors,"ONTOLOGY_API_NAME_INVALID",path,`${label} apiName 必须以小写字母开头，且只包含小写字母、数字和下划线`); }

function hierarchyChain(object,objectByName) { const result=[];const seen=new Set();let current=object;while(current&&!seen.has(current)){seen.add(current);result.unshift(current);current=current.parent?objectByName.get(current.parent):null;}return result; }
function hierarchyDepth(object,objectByName) { return Math.max(0,hierarchyChain(object,objectByName).length-1); }
function isAncestor(ancestor,descendant,objectByName) { let current=descendant.parent?objectByName.get(descendant.parent):null;const seen=new Set();while(current&&!seen.has(current)){if(current===ancestor)return true;seen.add(current);current=current.parent?objectByName.get(current.parent):null;}return false; }
function compatibleType(semanticType,sqlType) { const sql=String(sqlType||"").toLowerCase().replace(/\(.*/,"");const integer=/^(tinyint|smallint|mediumint|int|integer|bigint|year)$/.test(sql);const number=integer||/^(decimal|numeric|float|double|real)$/.test(sql);const string=/^(char|varchar|tinytext|text|mediumtext|longtext|enum|set|uuid)$/.test(sql);if(semanticType==="integer")return integer;if(semanticType==="number")return number;if(semanticType==="boolean")return /^(boolean|bool|bit|tinyint)$/.test(sql);if(semanticType==="string")return string;if(semanticType==="enum")return string||integer;if(semanticType==="date")return sql==="date";if(semanticType==="datetime")return /^(datetime|timestamp)$/.test(sql);return false; }
function reachableTables(initial,relations) { const visited=new Set(initial);let changed=true;while(changed){changed=false;for(const relation of relations){if(visited.has(relation.fromTable)&&!visited.has(relation.toTable)){visited.add(relation.toTable);changed=true;}if(visited.has(relation.toTable)&&!visited.has(relation.fromTable)){visited.add(relation.fromTable);changed=true;}}}return visited; }
function orientedCardinality(relation,sourceTables,targetTables) { const physical=normalizeCardinality(relation.cardinality);if(!physical)return null;if(sourceTables.has(relation.fromTable)&&targetTables.has(relation.toTable))return physical;if(sourceTables.has(relation.toTable)&&targetTables.has(relation.fromTable))return reverseCardinality(physical);return null; }
function normalizeCardinality(value) { const normalized=String(value||"").toLowerCase().replaceAll(" ","");return ({"1:1":"one_to_one","1:n":"one_to_many","1:m":"one_to_many","n:1":"many_to_one","m:1":"many_to_one","n:n":"many_to_many","m:n":"many_to_many","n:m":"many_to_many",one_to_one:"one_to_one",one_to_many:"one_to_many",many_to_one:"many_to_one",many_to_many:"many_to_many"})[normalized]||null; }
function reverseCardinality(value) { return ({one_to_one:"one_to_one",one_to_many:"many_to_one",many_to_one:"one_to_many",many_to_many:"many_to_many"})[value]; }
function isConfirmedRelation(relation) { return ["confirmed","accepted"].includes(relation.status); }
function termKey(vocabulary,canonicalId) { return `${text(vocabulary)}\u0000${text(canonicalId)}`; }
function sameValue(left,right) { return String(left)===String(right); }
function isDiscriminatorValue(value) { return typeof value==="string"&&value.length<=500||typeof value==="number"&&Number.isFinite(value); }
function text(value) { return typeof value==="string"?value.trim():""; }
function isRecord(value) { return Boolean(value)&&typeof value==="object"&&!Array.isArray(value); }
function issue(code,path,message) { return {code,path,message}; }
function add(items,code,path,message) { if(items.length<500) items.push(issue(code,path,message)); }

function validateKnowledgeCoverage(schema,catalog,warnings) {
  const pages=catalog?.knowledgePages;
  if(!Array.isArray(pages)||!pages.length) return;
  const conflicts=findKnowledgeOntologyConflicts(pages,catalog.columnsByTable||{},schemaMappedColumns(schema));
  for(const conflict of conflicts.slice(0,20)) warnings.push(issue("ONTOLOGY_KNOWLEDGE_COLUMN_UNMAPPED",`knowledge.${conflict.slug}`,`已验证知识页「${conflict.page}」引用了 ${conflict.table}.${conflict.column}，但该字段未映射为任何属性；语义问数会因此降级到兼容链路`));
}

function validateDisjointKnowledge(schema,catalog,warnings) {
  const pages=(catalog?.knowledgePages||[]).filter((page)=>page.verified);
  if(!pages.length||!schema.disjointGroups?.length)return;
  const objects=new Map(schema.objectTypes.map((object)=>[object.apiName,object]));
  for(const [index,group] of schema.disjointGroups.entries())for(let left=0;left<group.length;left++)for(let right=left+1;right<group.length;right++){
    const a=objects.get(group[left]),b=objects.get(group[right]);if(!a||!b)continue;
    const aNames=[a.apiName,a.displayName].filter(Boolean);const bNames=[b.apiName,b.displayName].filter(Boolean);
    const conflict=pages.find((page)=>matchesAny([page.title,...(page.aliases||[])],aNames)&&matchesAny(extractWikiLinks(`${page.content||""}\n${page.antiExamples||""}`),bNames)||matchesAny([page.title,...(page.aliases||[])],bNames)&&matchesAny(extractWikiLinks(`${page.content||""}\n${page.antiExamples||""}`),aNames));
    if(conflict)warnings.push(issue("ONTOLOGY_DISJOINT_KNOWLEDGE_SYNONYM",`disjointGroups[${index}]`,`已验证知识页「${conflict.title}」把互斥对象 ${a.displayName||a.apiName} 与 ${b.displayName||b.apiName} 直接互指，请补充区分说明`));
  }
}

function extractWikiLinks(value){return [...String(value).matchAll(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g)].map((match)=>match[1].trim());}
function matchesAny(values,candidates){const normalized=new Set(values.map((value)=>String(value||"").trim().toLowerCase()).filter(Boolean));return candidates.some((value)=>normalized.has(String(value).trim().toLowerCase()));}

export const semanticSchemaConstants={propertyTypes:[...PROPERTY_TYPES],cardinalities:[...CARDINALITIES],freshnessValues:[...FRESHNESS_VALUES],relationKinds:[...RELATION_KINDS],termMatches:[...TERM_MATCHES],maxHierarchyDepth:MAX_HIERARCHY_DEPTH};
