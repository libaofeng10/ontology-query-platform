// 从已验证知识页文本中提取其绑定表真实存在的字段引用。
// 只认可与目录字段名精确匹配的标识符 token，避免把普通词当字段。
export function extractKnowledgeColumnRefs(page, columnsByTable = {}) {
  const boundTables = (page?.tables || []).map((name) => String(name || "").trim()).filter(Boolean);
  if (!boundTables.length) return [];
  const text = `${page?.sqlContent || ""}\n${page?.content || ""}\n${page?.antiExamples || ""}`.toLowerCase();
  const tokens = new Set(text.match(/[a-z][a-z0-9_]{2,63}/g) || []);
  if (!tokens.size) return [];
  const refs = [];
  for (const table of boundTables) {
    for (const column of columnsByTable[table] || []) {
      const columnName = String(column.columnName || "");
      if (!columnName || column.isSensitive) continue;
      if (tokens.has(columnName.toLowerCase())) refs.push({ table, column: columnName });
    }
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
    for (const ref of extractKnowledgeColumnRefs(page, columnsByTable)) {
      // 仅当该表已进入语义模型（有任一属性映射到它）而该字段缺席时才算冲突；
      // 表整体不在模型里属于覆盖缺口，另有 LOW_FIELD_COVERAGE 渠道。
      if (!mappedTables.has(ref.table)) continue;
      if (mappedColumns.has(`${ref.table}.${ref.column}`)) continue;
      conflicts.push({ page: page.title, pageType: page.pageType, slug: page.slug, table: ref.table, column: ref.column });
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
