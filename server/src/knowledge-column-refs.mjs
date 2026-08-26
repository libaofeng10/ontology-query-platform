// 从已验证知识页文本中提取其绑定表真实存在的字段引用。
// 只认可与目录字段名精确匹配的标识符 token，避免把普通词当字段。
export function extractKnowledgeColumnRefs(page, columnsByTable = {}) {
  const boundTables = (page?.tables || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!boundTables.length) return [];
  const text = `${page?.sqlContent || ""}\n${page?.content || ""}\n${page?.antiExamples || ""}`.toLowerCase();
  // Two-character identifiers such as the ubiquitous primary key `id` are
  // valid physical columns. Exact catalog matching below still prevents an
  // arbitrary short word from becoming a field binding.
  const tokens = new Set(text.match(/[a-z][a-z0-9_]{1,63}/g) || []);
  if (!tokens.size) return [];
  const catalog=new Map(boundTables.map((table)=>[table.toLowerCase(),new Map((columnsByTable[table]||[]).filter((column)=>column.columnName&&!column.isSensitive).map((column)=>[String(column.columnName).toLowerCase(),String(column.columnName)]))]));
  const refs=[];const seen=new Set();
  const add=(table,column)=>{const key=`${table}.${column}`.toLowerCase();if(seen.has(key))return;seen.add(key);refs.push({table,column});};

  // A qualified reference owns its column. Without this pass, a single
  // `entity.id` token would incorrectly bind `id` on every table named by the
  // page, weakening metric-formula validation.
  for(const match of text.matchAll(/\b([a-z][a-z0-9_]{1,63})\s*\.\s*([a-z][a-z0-9_]{1,63})\b/g)) {
    const table=boundTables.find((item)=>item.toLowerCase()===match[1]);
    const column=table?catalog.get(match[1])?.get(match[2]):null;
    if(table&&column)add(table,column);
  }

  // Unqualified identifiers are accepted only when exactly one bound table
  // owns that column. Ambiguous names such as `id` remain unbound until the
  // knowledge definition qualifies them.
  const ownership=new Map();
  for(const table of boundTables)for(const [normalized,column] of catalog.get(table.toLowerCase())||[]) {
    const entries=ownership.get(normalized)||[];entries.push({table,column});ownership.set(normalized,entries);
  }
  for(const token of tokens) {
    const candidates=ownership.get(token)||[];
    if(candidates.length===1)add(candidates[0].table,candidates[0].column);
  }
  return refs;
}

// 找出已验证知识页引用了、但语义模型未映射的字段。
// mappedColumns: Set<"table.column">，schema 中所有属性映射。
export function findKnowledgeOntologyConflicts(pages, columnsByTable, mappedColumns) {
  const mappedTables = new Set([...mappedColumns].map((key) => key.split(".")[0]));
  const conflicts = [];
  for (const page of pages || []) {
    if (!page?.verified) continue;
    // 发布覆盖检查同样只统计知识页的正向定义；antiExamples 中列出的
    // “禁止使用字段”不表示该知识资产依赖该字段。
    for (const ref of extractKnowledgeColumnRefs({...page,antiExamples:""}, columnsByTable)) {
      // 仅当该表已进入语义模型（有任一属性映射到它）而该字段缺席时才算冲突；
      // 表整体不在模型里属于覆盖缺口，另有 LOW_FIELD_COVERAGE 渠道。
      if (!mappedTables.has(ref.table)) continue;
      if (mappedColumns.has(`${ref.table}.${ref.column}`)) continue;
      conflicts.push({ page: page.title, pageType: page.pageType, slug: page.slug, table: ref.table, column: ref.column });
    }
  }
  return conflicts;
}

// 查询期的 hard conflict 比发布期的“字段未覆盖”告警更严格：
// - antiExamples 只是禁止证据，不能被当作知识页的正向字段绑定；
// - join 页描述的是关系/FK，不应用业务属性的一对一映射规则；
// - 只有知识页标题/别名（或结构化 propertyRef）与本体属性能证明是同一
//   业务概念、但正向 SQL 绑定到了同表另一物理列时，才构成硬冲突。
export function findKnowledgeOntologyMappingConflicts(pages, columnsByTable, schema) {
  const properties=ontologyPropertiesByTable(schema);
  const propertiesByRef=new Map([...properties.values()].flat().map((property)=>[property.ref,property]));
  const conflicts=[];
  for(const page of pages||[]) {
    if(!page?.verified||page.pageType==="join")continue;
    const refs=extractKnowledgeColumnRefs({...page,antiExamples:""},columnsByTable);
    const structuredBindings=structuredPropertyBindings(page,refs);
    const multiColumnFormula=new Set(["metric","rule"]).has(page.pageType)&&refs.length>1;
    for(const ref of refs) {
      const refKey=`${ref.table}.${ref.column}`;
      const structuredRef=structuredBindings.get(refKey);
      if(structuredRef) {
        const property=resolveStructuredProperty(propertiesByRef,structuredRef);
        if(property&&property.table===ref.table&&property.column!==ref.column)conflicts.push(mappingConflict(page,ref,{...property,matchKind:"structured_property_ref"}));
        continue;
      }
      // A metric/rule formula commonly references its measure plus status,
      // event-time and soft-delete predicates. Page-level wording cannot tell
      // which ref owns the concept, so a multi-column formula needs an exact
      // ref→property binding before any of its columns may become hard conflict.
      if(multiColumnFormula)continue;
      const refMatchesConcept=page.pageType==="term"&&refs.length===1||knowledgeRefConceptMatch(page,ref,columnsByTable);
      if(!refMatchesConcept)continue;
      const candidates=(properties.get(ref.table)||[]).filter((property)=>property.column!==ref.column).map((property)=>{const match=knowledgePropertyConceptMatch(page,property);return match?{...property,...match}:null;}).filter(Boolean);
      if(!candidates.length)continue;
      const property=candidates.sort((left,right)=>right.matchScore-left.matchScore||left.ref.localeCompare(right.ref))[0];
      conflicts.push(mappingConflict(page,ref,property));
    }
  }
  return conflicts;
}

export function schemaMappedColumns(schema) {
  const mapped = new Set();
  for (const object of schema?.objectTypes || []) {
    for (const property of object.properties || []) {
      const table = property?.mapping?.table;
      const column = property?.mapping?.column;
      if (table && column) mapped.add(`${table}.${column}`);
    }
  }
  return mapped;
}

function ontologyPropertiesByTable(schema) {
  const result=new Map();
  for(const object of schema?.objectTypes||[])for(const property of object.properties||[]) {
    const table=property?.mapping?.table;const column=property?.mapping?.column;
    if(!table||!column)continue;
    const aliases=Array.isArray(property.aliases)?property.aliases:[];
    const entry={ref:`${object.apiName}.${property.apiName}`,table,column,labels:[property.apiName,property.displayName,...aliases].map(normalizeConceptLabel).filter(Boolean)};
    const list=result.get(table)||[];list.push(entry);result.set(table,list);
  }
  return result;
}

function knowledgePropertyConceptMatch(page,property) {
  const pageLabels=[page?.title,...(page?.aliases||[])].map(normalizeConceptLabel).filter(Boolean);
  let best=0;
  for(const left of pageLabels)for(const right of property.labels||[]) {
    if(left===right)best=Math.max(best,80+Math.min(left.length,20));
    else if(Math.min(left.length,right.length)>=3&&(left.includes(right)||right.includes(left)))best=Math.max(best,40+Math.min(left.length,right.length));
  }
  return best?{matchScore:best,matchKind:"title_or_alias_property_label"}:null;
}

function knowledgeRefConceptMatch(page,ref,columnsByTable) {
  const metadata=(columnsByTable?.[ref.table]||[]).find((column)=>String(column?.columnName).toLowerCase()===String(ref.column).toLowerCase());
  if(!metadata)return false;
  const aliases=Array.isArray(metadata.aliases)?metadata.aliases:[];
  const pageLabels=[page?.title,...(page?.aliases||[])].map(normalizeConceptLabel).filter(Boolean);
  const columnLabels=[metadata.columnName,metadata.comment,metadata.displayName,...aliases].map(normalizeConceptLabel).filter(Boolean);
  return pageLabels.some((left)=>columnLabels.some((right)=>strongConceptLabelMatch(left,right)));
}

function structuredPropertyBindings(page,refs) {
  const result=new Map();
  const add=(physical,propertyRef)=>{
    if(typeof physical!=="string"||typeof propertyRef!=="string")return;
    const normalizedPhysical=physical.trim().toLowerCase();const normalizedProperty=propertyRef.trim();
    if(!normalizedPhysical||!normalizedProperty)return;
    const matches=(refs||[]).filter((ref)=>normalizedPhysical===`${ref.table}.${ref.column}`.toLowerCase()||normalizedPhysical===String(ref.column).toLowerCase());
    if(matches.length===1)result.set(`${matches[0].table}.${matches[0].column}`,normalizedProperty);
  };
  for(const source of [page?.propertyBindings,page?.provenance?.propertyBindings]) {
    if(Array.isArray(source))for(const item of source||[])add(item?.physicalColumn||item?.column||item?.ref,item?.propertyRef||item?.ontologyProperty||item?.semanticProperty||item?.property);
    else if(source&&typeof source==="object")for(const [physical,propertyRef] of Object.entries(source))add(physical,propertyRef);
  }
  const pageProperty=[page?.propertyRef,page?.ontologyProperty,page?.semanticProperty,page?.provenance?.propertyRef].find((item)=>typeof item==="string"&&item.trim());
  const pagePhysical=[page?.physicalColumn,page?.columnRef,page?.provenance?.physicalColumn].find((item)=>typeof item==="string"&&item.trim());
  if(pageProperty&&pagePhysical)add(pagePhysical,pageProperty);
  else if(pageProperty&&refs.length===1)result.set(`${refs[0].table}.${refs[0].column}`,pageProperty.trim());
  return result;
}

function resolveStructuredProperty(propertiesByRef,propertyRef) {
  if(propertiesByRef.has(propertyRef))return propertiesByRef.get(propertyRef);
  const suffix=`.${String(propertyRef).trim()}`;
  const matches=[...propertiesByRef.entries()].filter(([ref])=>ref.endsWith(suffix)).map(([,property])=>property);
  return matches.length===1?matches[0]:null;
}

function mappingConflict(page,ref,property) {return {page:page.title,pageType:page.pageType,slug:page.slug,table:ref.table,column:ref.column,mappedProperty:property.ref,mappedColumn:property.column,evidence:property.matchKind};}

function strongConceptLabelMatch(left,right) {
  if(left===right&&left.length>=2)return true;
  return Math.min(left.length,right.length)>=3&&(left.includes(right)||right.includes(left));
}

function normalizeConceptLabel(value) {return String(value||"").trim().toLowerCase().replace(/[\s_\-./]+/g,"");}
