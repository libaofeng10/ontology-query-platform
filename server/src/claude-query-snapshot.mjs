import { relationPairs, relationKey } from "./physical-relation.mjs";
import { createHash } from "node:crypto";
import { redactTypedLiterals } from "./query-column-semantics.mjs";

/**
 * Version of the public, request-scoped ontology view exposed to Claude.
 *
 * The snapshot is deliberately a plain-data boundary.  It is built from a
 * published schema and a physical catalog, then all read operations are
 * served from the immutable copy.  A caller can therefore keep using the
 * normal store while a Claude request is in flight without changing what the
 * model reads as metadata. Catalog membership does not restrict SQL execution.
 */
export const CLAUDE_QUERY_SNAPSHOT_VERSION = "claude-query-snapshot-v2";
export const DEFAULT_SNAPSHOT_PAGE_SIZE = 20;
export const MAX_SNAPSHOT_PAGE_SIZE = 50;
export const MAX_SNAPSHOT_TEXT = 8_000;
export const MAX_SNAPSHOT_BYTES = 512_000;

const OPERATION_NAMES = new Set(["overview", "search", "get_tables", "get_objects", "get_relations", "get_knowledge"]);
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;


export class ClaudeQuerySnapshotError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ClaudeQuerySnapshotError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Build a request-scoped snapshot from an already published ontology.
 *
 * Accepted input is intentionally permissive so this module can sit between
 * the existing query context and future catalog services:
 *
 *   createClaudeQuerySnapshot({
 *     sourceId, published, ontologySchema, catalog, context, queryIntent,
 *     retrievalEvidence, initialDisclosedTables,
 *   })
 *
 * `published` may be a store record (`{version, checksum, schema}`) or a
 * schema object itself.  No database or network calls are made here.
 */
export function createClaudeQuerySnapshot(input = {}) {
  const sourceId = normalizeSourceId(input.sourceId ?? input.source?.id);
  const published = resolvePublishedRecord(input) || publishedOntologyFromStore(input.store, sourceId);
  const schema = resolveSchema(input, published);
  if (!schema) {
    throw new ClaudeQuerySnapshotError(
      "ONTOLOGY_MISSING",
      "Claude 问数需要已发布的 Ontology Schema",
      { sourceId },
    );
  }
  if (published?.status && published.status !== "published" && input.allowUnpublished !== true) {
    throw new ClaudeQuerySnapshotError(
      "ONTOLOGY_NOT_PUBLISHED",
      "只有已发布的 Ontology Schema 才能用于 Claude 问数",
      { sourceId, status: published.status },
    );
  }
  if (published?.sourceId != null && sourceId != null && Number(published.sourceId) !== Number(sourceId)) {
    throw new ClaudeQuerySnapshotError(
      "ONTOLOGY_SOURCE_MISMATCH",
      "Ontology Schema 不属于当前数据源",
      { sourceId, schemaSourceId: published.sourceId },
    );
  }

  const catalog = normalizeCatalog(input.catalog ?? input.context ?? catalogFromStore(input.store, sourceId));
  // Physical metadata is guidance for Claude, not an ontology-derived grant.
  const tableNames = new Set(catalog.tables.map((table) => table.tableName));
  const relations = chooseRelations(catalog.relations, tableNames);
  const knowledge = normalizeKnowledge(
    input.knowledge ?? input.context?.knowledge ?? catalog.knowledge,
    tableNames,
  );
  const rules = normalizeRules(
    input.rules ?? input.context?.rules ?? catalog.rules,
    tableNames,
  );
  const columnsByTable = buildPublicColumns({ catalog, schema, tableNames });
  const publicTables = buildPublicTables(catalog.tables, tableNames, columnsByTable);
  const objects = buildPublicObjects(schema, columnsByTable, tableNames);
  const links = buildPublicLinks(schema, relations, tableNames);
  const enumValues = buildPublicEnums(catalog, columnsByTable);
  const queryIntent = null;
  const retrieval = null;
  const executionContract = null;
  const schemaVersion = normalizeVersion(published?.version ?? input.ontologySchemaVersion);
  const schemaVersionId = normalizeVersion(published?.id ?? input.ontologySchemaVersionId);
  const publishedAt = safeText(published?.publishedAt ?? published?.published_at, 128);
  const schemaName = safeText(schema.name ?? published?.schemaName, 200);
  const schemaChecksum = safeChecksum(published?.checksum) || hashJson(schema);

  const payload = {
    kind: "claude-query-snapshot",
    snapshotVersion: CLAUDE_QUERY_SNAPSHOT_VERSION,
    sourceId,
    schemaVersion,
    schemaVersionId,
    schemaName,
    schemaChecksum,
    publishedAt,
    tables: publicTables,
    columnsByTable,
    relations,
    objects,
    links,
    enumValues,
    knowledge,
    rules,
    queryIntent,
    retrieval,
    executionContract,
    allowedTableNames: [...tableNames].sort(),
    allowedColumnsByTable: objectFromSets(Object.fromEntries(
      [...tableNames].sort().map((tableName) => [tableName, new Set((columnsByTable[tableName] || []).map((item) => item.columnName))]),
    )),
  };
  const checksum = hashJson(payload);
  const disclosedTables = new Set(
    [...normalizeNameSet(input.initialDisclosedTables ?? input.disclosedTables)]
      .filter((tableName) => tableNames.has(tableName)),
  );
  const createdAt = new Date().toISOString();

  const snapshot = {
    ...payload,
    checksum,
    createdAt,
    // The Set is intentionally non-enumerable in toJSON, but exposing it on
    // the object makes the MCP adapter cheap and avoids duplicating state.
    disclosedTables,
    read(operationOrRequest = {}, maybeArgs = {}) {
      const request = typeof operationOrRequest === "string"
        ? { operation: operationOrRequest, ...maybeArgs }
        : (operationOrRequest || {});
      return readSnapshot(snapshot, request);
    },
    disclose(tableNamesToDisclose = []) {
      const accepted = [];
      for (const tableName of normalizeNameSet(tableNamesToDisclose)) {
        if (tableNames.has(tableName)) {
          disclosedTables.add(tableName);
          accepted.push(tableName);
        }
      }
      return accepted.sort();
    },
    isTableAllowed(tableName) {
      return tableNames.has(normalizeIdentifier(tableName));
    },
    isColumnAllowed(tableName, columnName) {
      const key = normalizeIdentifier(tableName);
      const column = normalizeIdentifier(columnName);
      return (columnsByTable[key] || []).some((item) => item.columnName === column);
    },
    isSensitiveColumn() { return false; },
    toJSON() {
      return { ...payload, checksum, createdAt };
    },
  };
  return snapshot;
}

export const buildClaudeQuerySnapshot = createClaudeQuerySnapshot;

/**
 * Resolve a published schema using a store only when the caller explicitly
 * supplied one.  Snapshot construction stays synchronous and deterministic;
 * this helper is useful for callers that already have a store record.
 */
export function publishedOntologyFromStore(store, sourceId) {
  if (!store?.getPublishedOntologySchema) return null;
  return store.getPublishedOntologySchema(sourceId);
}

function catalogFromStore(store, sourceId) {
  if (!store || sourceId == null || typeof store.listTables !== "function") return {};
  const tables = store.listTables(sourceId) || [];
  const columnsByTable = Object.fromEntries(tables.map((table) => [table.tableName, store.listColumns?.(sourceId, table.tableName) || []]));
  const relations = store.listRelations?.(sourceId, false, true) || [];
  const knowledgePages = store.listKnowledge?.(sourceId) || [];
  const rules = store.listRules?.(sourceId) || [];
  const enums = Object.fromEntries(tables.map((table) => [table.tableName, store.listEnums?.(sourceId, table.tableName) || []]));
  return { tables, columnsByTable, relations, knowledgePages, rules, enums };
}

function resolvePublishedRecord(input) {
  const candidate = input.published ?? input.ontologyRecord ?? input.ontologySchemaVersion;
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.objectTypes || candidate.linkTypes) return { schema: candidate, status: "published" };
  if (candidate.schema) return candidate;
  if (candidate.schemaJson) return { ...candidate, schema: parseJson(candidate.schemaJson, null) };
  return candidate;
}

function resolveSchema(input, published) {
  const direct = input.ontologySchema ?? input.schema ?? published?.schema;
  if (direct && typeof direct === "object") return direct;
  if (typeof direct === "string") return parseJson(direct, null);
  return null;
}

function normalizeCatalog(input) {
  const raw = input && typeof input === "object" ? input : {};
  const tables = Array.isArray(raw.tables)
    ? raw.tables.map(normalizeTable).filter((item) => item.tableName)
    : [];
  const tableNames = new Set(tables.map((item) => item.tableName));
  const columnsSource = raw.columnsByTable ?? raw.columns ?? raw.allColumns ?? {};
  const columnsByTable = {};
  for (const tableName of tableNames) {
    const items = Array.isArray(columnsSource?.[tableName]) ? columnsSource[tableName] : [];
    columnsByTable[tableName] = items.map((item) => normalizeColumn(item)).filter((item) => item.columnName);
  }
  const relations = (Array.isArray(raw.relations) ? raw.relations : [])
    .map(normalizeRelation)
    .filter((item) => item.fromTable && item.fromCol && item.toTable && item.toCol && tableNames.has(item.fromTable) && tableNames.has(item.toTable));
  const enums = raw.enumsByTable ?? raw.enums ?? {};
  const knowledge = Array.isArray(raw.knowledgePages) ? raw.knowledgePages : (Array.isArray(raw.knowledge) ? raw.knowledge : []);
  const rules = Array.isArray(raw.rules) ? raw.rules : [];
  return { tables, columnsByTable, relations, enums, knowledge, rules };
}

function chooseRelations(catalogRelations, tableNames) {
  const relations = [];
  for (const relation of catalogRelations) {
    // Confirmed relationships remain useful evidence. This list does not
    // restrict the JOIN conditions Claude may generate.
    if (!["confirmed", "accepted"].includes(String(relation.status || "").toLowerCase())) continue;
    if (!tableNames.has(relation.fromTable) || !tableNames.has(relation.toTable)) continue;
    relations.push({
      id: relation.id == null ? null : Number(relation.id),
      fromTable: relation.fromTable,
      fromCol: relation.fromCol,
      toTable: relation.toTable,
      toCol: relation.toCol,
      columnPairs: relationPairs(relation),
      cardinality: safeText(relation.cardinality, 80),
      status: safeText(relation.status, 40),
      confidence: finiteNumber(relation.confidence),
      source: safeText(relation.inferenceSource, 80),
    });
  }
  return dedupeBy(relations, relationKey);
}

function buildPublicColumns({ catalog, schema, tableNames }) {
  const columnsByTable = {};
  for (const tableName of [...tableNames].sort()) {
    const sourceColumns = catalog.columnsByTable[tableName] || [];
    const propertySemantics = propertySemanticsForTable(schema, tableName);
    columnsByTable[tableName] = sourceColumns
      .map((column) => {
        const semantic = propertySemantics.get(column.columnName) || {};
        // 2026-09-04 应用户要求移除敏感列限制：所有列 selectable，
        // 不再从名称/注释推断敏感性。
        const sensitive = false;
        const result = {
          columnName: column.columnName,
          dataType: safeText(column.dataType, 80),
          nullable: column.nullable == null ? null : Boolean(column.nullable),
          isPrimary: Boolean(column.isPrimary),
          ...(column.keyConstraints?.length?{keyConstraints:column.keyConstraints}:{}),
          isUnique: Boolean(column.isUnique),
          isIndexed: Boolean(column.isIndexed),
          comment: safeText(column.comment, MAX_SNAPSHOT_TEXT),
          semanticKind: safeText(semantic.semanticKind || column.semanticKind, 80) || null,
          propertyNames: semantic.propertyNames || [],
          sensitive,
          filterable: true,
          selectable: !sensitive,
        };
        if (semantic.type) result.semanticType = semantic.type;
        if (semantic.description) result.description = safeText(semantic.description, MAX_SNAPSHOT_TEXT);
        return result;
      });
  }
  return columnsByTable;
}

function propertySemanticsForTable(schema, tableName) {
  const result = new Map();
  for (const object of Array.isArray(schema?.objectTypes) ? schema.objectTypes : []) {
    for (const property of Array.isArray(object?.properties) ? object.properties : []) {
      if (normalizeIdentifier(property?.mapping?.table) !== tableName) continue;
      const column = normalizeIdentifier(property?.mapping?.column);
      if (!column) continue;
      const prior = result.get(column) || { propertyNames: [] };
      prior.propertyNames = [...new Set([...prior.propertyNames, safeText(property.apiName, 120), safeText(property.displayName, 200)].filter(Boolean))];
      prior.semanticKind ||= safeText(property.semanticKind, 80) || inferSemanticKind(property);
      prior.type ||= safeText(property.type, 80);
      prior.description ||= safeText(property.description, MAX_SNAPSHOT_TEXT);
      result.set(column, prior);
    }
  }
  return result;
}

function buildPublicTables(tables, tableNames, columnsByTable) {
  return tables
    .filter((table) => tableNames.has(table.tableName))
    .map((table) => ({
      tableName: table.tableName,
      comment: safeText(table.comment, MAX_SNAPSHOT_TEXT),
      rowEstimate: finiteNumber(table.rowEstimate),
      grade: safeText(table.grade, 20),
      columnCount: (columnsByTable[table.tableName] || []).length,
    }))
    .sort((a, b) => a.tableName.localeCompare(b.tableName));
}

function buildPublicObjects(schema, columnsByTable, tableNames) {
  const objects = [];
  for (const object of Array.isArray(schema?.objectTypes) ? schema.objectTypes : []) {
    const properties = [];
    for (const property of Array.isArray(object?.properties) ? object.properties : []) {
      const table = normalizeIdentifier(property?.mapping?.table);
      const column = normalizeIdentifier(property?.mapping?.column);
      if (!tableNames.has(table) || !columnsByTable[table]?.some((item) => item.columnName === column)) continue;
      const physical = columnsByTable[table].find((item) => item.columnName === column);
      properties.push({
        apiName: safeText(property.apiName, 120),
        displayName: safeText(property.displayName, 200),
        description: safeText(property.description, MAX_SNAPSHOT_TEXT),
        type: safeText(property.type, 80),
        required: Boolean(property.required),
        table,
        column,
        sensitive: Boolean(physical?.sensitive),
        selectable: Boolean(physical?.selectable),
        filterable: Boolean(physical?.filterable),
        constraints: sanitizeConstraints(property.constraints),
      });
    }
    if (!properties.length) continue;
    objects.push({
      apiName: safeText(object.apiName, 120),
      displayName: safeText(object.displayName, 200),
      description: safeText(object.description, MAX_SNAPSHOT_TEXT),
      primaryKey: Array.isArray(object.primaryKey)?object.primaryKey.map(name=>safeText(name,120)):safeText(object.primaryKey,120),
      parent: safeText(object.parent, 120),
      properties,
    });
  }
  return objects.sort((a, b) => a.apiName.localeCompare(b.apiName));
}

function buildPublicLinks(schema, relations, tableNames) {
  const relationById = new Map(relations.filter((item) => item.id != null).map((item) => [Number(item.id), item]));
  const links = [];
  for (const link of Array.isArray(schema?.linkTypes) ? schema.linkTypes : []) {
    const mappings = [];
    for (const item of Array.isArray(link?.relationMappings) ? link.relationMappings : []) {
      const relation = relationById.get(Number(item?.relationId ?? item));
      if (!relation) continue;
      mappings.push({
        relationId: relation.id,
        fromTable: relation.fromTable,
        fromCol: relation.fromCol,
        toTable: relation.toTable,
        toCol: relation.toCol,
      columnPairs: relationPairs(relation),
      });
    }
    if (!mappings.length) continue;
    links.push({
      apiName: safeText(link.apiName, 120),
      displayName: safeText(link.displayName, 200),
      description: safeText(link.description, MAX_SNAPSHOT_TEXT),
      source: safeText(link.source, 120),
      target: safeText(link.target, 120),
      cardinality: safeText(link.cardinality, 80),
      mappings,
    });
  }
  return links.filter((link) => link.mappings.every((item) => tableNames.has(item.fromTable) && tableNames.has(item.toTable)));
}

function buildPublicEnums(catalog, columnsByTable) {
  const result = {};
  for (const [tableName, columns] of Object.entries(columnsByTable)) {
    for (const column of columns) {
      const values = enumValuesFor(catalog.enums, tableName, column.columnName);
      if (!values.length) continue;
      result[`${tableName}.${column.columnName}`] = values.slice(0, 200).map((item) => ({
        value: safeText(item.value ?? item, 500),
        meaning: safeText(item.meaning, 1_000) || null,
        meaningSource: safeText(item.meaningSource ?? item.meaning_source, 100) || null,
      }));
    }
  }
  return result;
}

function enumValuesFor(enums, tableName, columnName) {
  const key = `${tableName}.${columnName}`;
  const raw = enums?.[key] ?? enums?.[tableName]?.[columnName] ?? (Array.isArray(enums?.[tableName]) ? enums[tableName].filter((item) => item?.columnName === columnName) : []);
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.values)) return raw.values;
  }
  return [];
}

function normalizeKnowledge(items, tableNames) {
  return (Array.isArray(items) ? items : [])
    .filter((page) => page?.verified === true || page?.verified === 1 || page?.verified === "1")
    .filter((page) => {
      const names = normalizeNameSet(page.tables ?? parseJson(page.tablesJson, []));
      return !names.size || [...names].some((name) => tableNames.has(name));
    })
    .map((page) => ({
      id: page.id == null ? null : Number(page.id),
      pageType: safeText(page.pageType ?? page.page_type, 80),
      slug: safeText(page.slug, 200),
      title: safeText(page.title, 500),
      aliases: normalizeTextArray(page.aliases ?? parseJson(page.aliasesJson, []), 50, 200),
      tables: [...normalizeNameSet(page.tables ?? parseJson(page.tablesJson, []))].sort(),
      // Knowledge is model input, not executable instruction.  Keep the
      // content useful but bounded and explicitly tagged as untrusted data.
      content: safeText(page.content, MAX_SNAPSHOT_TEXT),
      sqlContent: safeText(page.sqlContent ?? page.sql_content, MAX_SNAPSHOT_TEXT),
      antiExamples: safeText(page.antiExamples ?? page.anti_examples, MAX_SNAPSHOT_TEXT),
      untrustedData: true,
    }))
    .filter((page) => page.slug || page.title || page.content);
}

function normalizeRules(items, tableNames) {
  return (Array.isArray(items) ? items : [])
    .filter((rule) => rule?.verified === true || rule?.verified === 1 || rule?.verified === "1")
    .filter((rule) => {
      const names = normalizeNameSet(rule.appliesTo ?? rule.applies_to);
      return !names.size || [...names].some((name) => tableNames.has(name));
    })
    .map((rule) => ({
      id: rule.id == null ? null : Number(rule.id),
      name: safeText(rule.name, 500),
      appliesTo: [...normalizeNameSet(rule.appliesTo ?? rule.applies_to)].sort(),
      content: safeText(rule.content, MAX_SNAPSHOT_TEXT),
      untrustedData: true,
    }))
    .filter((rule) => rule.name || rule.content);
}

function readSnapshot(snapshot, request = {}) {
  const operation = safeText(request.operation ?? request.op, 40).toLowerCase();
  if (!OPERATION_NAMES.has(operation)) {
    throw new ClaudeQuerySnapshotError("INVALID_OPERATION", `不支持的 ontology_read operation：${operation || "(空)"}`);
  }
  const limit = boundedInteger(request.limit, DEFAULT_SNAPSHOT_PAGE_SIZE, 1, MAX_SNAPSHOT_PAGE_SIZE);
  const offset = decodeCursor(request.cursor);
  if (operation === "overview") {
    return {
      operation,
      snapshotVersion: snapshot.snapshotVersion,
      sourceId: snapshot.sourceId,
      schemaVersion: snapshot.schemaVersion,
      schemaChecksum: snapshot.schemaChecksum,
      checksum: snapshot.checksum,
      executionContract: snapshot.executionContract,
      tables: snapshot.tables,
      objects: snapshot.objects.map(publicObjectIndex),
      relations: snapshot.relations,
      links: snapshot.links,
      knowledge: snapshot.knowledge.map(publicKnowledgeIndex),
      disclosedTables: [...snapshot.disclosedTables].sort(),
    };
  }
  if (operation === "search") {
    const query = safeText(request.query, 500).toLowerCase();
    const all = searchableItems(snapshot, query);
    return pagedResult(operation, all, offset, limit, { query });
  }
  if (operation === "get_tables") {
    const wanted = normalizeRequestedIds(request.ids);
    const query = safeText(request.query, 500).toLowerCase();
    const all = snapshot.tables.filter((table) => !wanted.size || wanted.has(table.tableName.toLowerCase()))
      .map((table) => ({
        ...table,
        columns: publicColumnsWithEnums(snapshot, table.tableName),
        objects: snapshot.objects.filter((object) => object.properties.some((property) => property.table === table.tableName)).map(publicObjectIndex),
        knowledge: snapshot.knowledge.filter((entry) => !entry.tables.length || entry.tables.includes(table.tableName)).map(publicKnowledgeIndex),
      }));
    return pagedResult(operation, matchSearchTerms(all, query), offset, limit, { ids: [...wanted].sort(), query });
  }
  if (operation === "get_objects") {
    const wanted = normalizeRequestedIds(request.ids ?? request.objectNames ?? request.objects);
    const query = safeText(request.query, 500).toLowerCase();
    const all = snapshot.objects.filter((object) => !wanted.size || wanted.has(object.apiName.toLowerCase()) || wanted.has(object.displayName.toLowerCase()) || object.properties.some((property) => wanted.has(property.table.toLowerCase())));
    const page = pagedResult(operation, matchSearchTerms(all, query), offset, limit, { ids: [...wanted].sort(), query });
    return { ...page, items: page.items.map((object) => ({
      ...object,
      knowledge: snapshot.knowledge.filter((entry) => !entry.tables.length || object.properties.some((property) => entry.tables.includes(property.table))).map(({ slug, title, aliases }) => ({ slug, title, aliases })),
      tables: [...new Set(object.properties.map((property) => property.table))].map((tableName) => ({
        tableName, columns: publicColumnsWithEnums(snapshot, tableName),
      })),
    })) };
  }
  if (operation === "get_relations") {
    const wanted = normalizeRequestedIds(request.ids ?? request.relationIds ?? request.relations);
    const query = safeText(request.query, 500).toLowerCase();
    const all = snapshot.relations.filter((relation) => !wanted.size || wanted.has(String(relation.id)) || wanted.has(`${relation.fromTable}.${relation.fromCol}->${relation.toTable}.${relation.toCol}`.toLowerCase()));
    return pagedResult(operation, matchSearchTerms(all, query), offset, limit, { ids: [...wanted].sort(), query });
  }
  const wanted = normalizeRequestedIds(request.ids ?? request.slugs ?? request.knowledge);
  const query = safeText(request.query, 500).toLowerCase();
  const candidates = [...snapshot.knowledge, ...snapshot.rules].filter((item) => !wanted.size || [item.slug, item.title, item.name, item.id].some((value) => value != null && wanted.has(String(value).toLowerCase())));
  const page = pagedResult(operation, matchSearchTerms(candidates, query), offset, limit, { ids: [...wanted].sort(), query });
  const tableNames = new Set(page.items.flatMap((item) => item.tables || item.appliesTo || []).filter((table) => Object.hasOwn(snapshot.columnsByTable, table)));
  // A definition can redirect the model to another product. Include that
  // product's actual public structure so the knowledge is executable without
  // guessing fields or repeating failed db_query calls to discover them.
  return { ...page,
    objects: snapshot.objects.filter((object) => object.properties.some((property) => tableNames.has(property.table))).map(publicObjectIndex),
    tables: [...tableNames].sort().map((tableName) => ({ tableName, columns: publicColumnsWithEnums(snapshot, tableName) })),
  };
}

function publicObjectIndex(object) {
  return {
    apiName: object.apiName, displayName: object.displayName,
    description: safeText(object.description, 500),
    tableNames: [...new Set(object.properties.map((property) => property.table))],
    propertyCount: object.properties.length,
  };
}

function publicKnowledgeIndex({ slug, title, aliases, tables }) {
  return { slug, title, aliases, tables };
}

function searchableItems(snapshot, query) {
  const items = [
    ...snapshot.tables.map((item) => ({ kind: "table", ...item })),
    ...snapshot.objects.map((item) => ({ kind: "object", ...item })),
    ...snapshot.objects.flatMap((object) => object.properties.map((property) => ({ kind: "property", object: object.apiName, ...property }))),
    ...Object.keys(snapshot.columnsByTable).flatMap((table) => publicColumnsWithEnums(snapshot, table).map((column) => ({ kind: "column", table, ...column }))),
    ...snapshot.relations.map((item) => ({ kind: "relation", ...item })),
    ...snapshot.knowledge.map((item) => ({ kind: "knowledge", ...item })),
    ...snapshot.rules.map((item) => ({ kind: "rule", ...item })),
  ];
  return matchSearchTerms(items, query);
}

function matchSearchTerms(items, query) {
  const phrase = query.trim().replace(/\s+/g, " ");
  if (!phrase) return items;
  const terms = [...new Set(phrase.match(/[\p{L}\p{N}_$]+/gu) || [phrase])];
  // This is tool-local keyword search over the authorized snapshot, not a
  // question planner. Rank before paging; unknown terms must not list all data.
  return items.map((item) => {
    const text = JSON.stringify(item).toLowerCase();
    const label = [item.title, item.name, item.apiName, item.displayName, item.slug, item.tableName, item.columnName, ...(item.aliases || [])].filter(Boolean).join(" ").toLowerCase();
    const matched = terms.filter((term) => text.includes(term));
    const score = matched.length * 10 + matched.filter((term) => label.includes(term)).length * 2 + (text.includes(phrase) ? 1 : 0);
    return { item, score };
  }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score).map(({ item }) => item);
}

function publicColumnsWithEnums(snapshot, table) {
  return (snapshot.columnsByTable[table] || []).map((column) => ({
    ...column, enumValues: snapshot.enumValues[`${table}.${column.columnName}`] || [],
  }));
}

function pagedResult(operation, items, offset, limit, extra = {}) {
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + page.length < items.length ? offset + page.length : null;
  return {
    operation,
    ...extra,
    items: page,
    total: items.length,
    nextCursor: nextOffset == null ? null : encodeCursor(nextOffset),
  };
}

function normalizeTable(item = {}) {
  return {
    tableName: normalizeIdentifier(item.tableName ?? item.table_name ?? item.name),
    comment: safeText(item.comment, MAX_SNAPSHOT_TEXT),
    rowEstimate: finiteNumber(item.rowEstimate ?? item.row_estimate),
    grade: safeText(item.grade, 20),
  };
}

function normalizeColumn(item = {}) {
  // Catalogs arrive from both SQLite and external discovery adapters.  Treat
  // explicit false-like values as false, but fail closed for an unknown
  // non-empty flag (for example `yes`/`Y`) so a sensitive column cannot be
  // accidentally exposed because of a representation mismatch.
  const flag = (...values) => values.some(isEnabledFlag);
  return {
    columnName: normalizeIdentifier(item.columnName ?? item.column_name ?? item.name),
    dataType: safeText(item.dataType ?? item.data_type, 80),
    nullable: item.nullable,
    isPrimary: flag(item.isPrimary, item.is_primary),
    ...(Array.isArray(item.keyConstraints)&&item.keyConstraints.length?{keyConstraints:item.keyConstraints}:{}),
    isUnique: flag(item.isUnique, item.is_unique),
    isIndexed: flag(item.isIndexed, item.is_indexed),
    // Accept all historical catalog spellings.  Do not use Boolean(value):
    // the string "0" is a common SQLite representation of false.
    isSensitive: flag(item.isSensitive, item.is_sensitive, item.sensitive),
    semanticKind: safeText(item.semanticKind ?? item.semantic_kind, 80),
    comment: safeText(item.comment, MAX_SNAPSHOT_TEXT),
  };
}

function isEnabledFlag(value) {
  if (value === true || (typeof value === "number" && value > 0)) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off", "null", "undefined", "n"].includes(normalized);
}

function normalizeRelation(item = {}) {
  return {
    id: item.id == null ? null : Number(item.id),
    fromTable: normalizeIdentifier(item.fromTable ?? item.from_table),
    fromCol: normalizeIdentifier(item.fromCol ?? item.from_col),
    toTable: normalizeIdentifier(item.toTable ?? item.to_table),
    toCol: normalizeIdentifier(item.toCol ?? item.to_col),
    columnPairs: relationPairs({...item,fromCol:item.fromCol??item.from_col,toCol:item.toCol??item.to_col}).map(pair=>({fromCol:normalizeIdentifier(pair.fromCol),toCol:normalizeIdentifier(pair.toCol)})),
    cardinality: safeText(item.cardinality, 80),
    status: safeText(item.status, 40).toLowerCase(),
    confidence: finiteNumber(item.confidence),
    inferenceSource: safeText(item.inferenceSource ?? item.inference_source, 80),
  };
}

function inferSemanticKind(property) {
  const text = `${property?.apiName || ""} ${property?.displayName || ""}`;
  if (/手机|电话|mobile|phone/i.test(text)) return "phone";
  if (/邮箱|email/i.test(text)) return "email";
  if (/身份证|证件|identity|id_card/i.test(text)) return "identity";
  return "";
}


function sanitizeConstraints(value) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "pattern"]) if (value[key] != null) result[key] = sanitizeScalar(value[key]);
  if (Array.isArray(value.enumValues)) result.enumValues = normalizeTextArray(value.enumValues, 200, 500);
  return removeEmpty(result);
}

function sanitizeScalar(value) {
  if (value == null || typeof value === "boolean") return value;
  if (typeof value === "number" || typeof value === "bigint") {
    // Query-intent and retrieval metadata can carry a typed literal as a
    // native number (or a DB driver's bigint).  Keep ordinary counters and
    // versions useful, but replace values recognised as phone/ID/card
    // literals before the snapshot crosses into the model-visible boundary.
    const text = String(value);
    if (redactTypedLiterals(text) !== text) return "[REDACTED]";
    // JSON.stringify cannot represent bigint.  Keep an ordinary bigint
    // usable in the plain-data snapshot as its decimal text; typed values
    // above are still replaced before this conversion.
    return typeof value === "bigint" ? text : value;
  }
  if (typeof value === "string") return safeText(value, 2_000);
  return undefined;
}

function removeEmpty(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.filter((item) => item !== undefined && item !== null);
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    if (typeof item === "string" && item === "") continue;
    if (Array.isArray(item) && !item.length) continue;
    result[key] = item;
  }
  return result;
}

function normalizeNameSet(value) {
  const values = Array.isArray(value) ? value : value instanceof Set ? [...value] : value == null ? [] : [value];
  return new Set(values.map((item) => normalizeIdentifier(item)).filter(Boolean));
}

function normalizeRequestedIds(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  // Object display names and knowledge slugs may be Chinese. These values
  // only select snapshot entries; physical SQL identifiers have a separate guard.
  return new Set(values.map((item) => safeText(item, 200).toLowerCase()).filter(Boolean));
}

function normalizeTextArray(value, maxItems = 50, maxLength = 200) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.map((item) => safeText(item, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function normalizeIdentifier(value) {
  const text = String(value ?? "").trim().replace(/^`|`$/g, "");
  if (!text || text.length > 128 || text.includes(".") || !SAFE_IDENTIFIER.test(text)) return "";
  return text.toLowerCase();
}

function normalizeSourceId(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : safeText(value, 128);
}

function safeText(value, maxLength = 500) {
  if (value == null) return "";
  // Snapshot text is model-visible metadata (comments, descriptions,
  // verified knowledge/rules and enum meanings).  Redact typed values here so
  // a stale catalog comment or knowledge example cannot become a side channel
  // into the Claude prompt/tool response.  Structural identifiers are already
  // validated separately and do not contain these value patterns in normal
  // operation.
  const text = redactTypedLiterals(stripControl(String(value))).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function stripControl(value) { return [...String(value)].map((char) => { const code = char.codePointAt(0); return code < 0x20 || code === 0x7f ? " " : char; }).join(""); }

function safeChecksum(value) {
  const text = safeText(value, 128);
  return /^[a-f0-9]{32,128}$/i.test(text) ? text : "";
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizeVersion(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : (safeText(value, 100) || null);
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

function parseJson(value, fallback) {
  if (value == null || typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function hashJson(value) {
  const json = stableStringify(value);
  return createHash("sha256").update(json).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function objectFromSets(value) {
  const result = {};
  for (const [key, set] of Object.entries(value || {})) result[key] = [...(set instanceof Set ? set : new Set(set || []))].sort();
  return result;
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => { const key = keyFn(item); if (seen.has(key)) return false; seen.add(key); return true; });
}

function encodeCursor(offset) { return Buffer.from(JSON.stringify({ offset }), "utf8").toString("base64url"); }
function decodeCursor(cursor) {
  if (!cursor) return 0;
  try { const value = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8")); return boundedInteger(value.offset, 0, 0, 1_000_000); } catch { throw new ClaudeQuerySnapshotError("INVALID_CURSOR", "ontology_read cursor 无效"); }
}
