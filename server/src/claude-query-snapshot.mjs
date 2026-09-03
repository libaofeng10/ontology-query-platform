import { createHash } from "node:crypto";
import { redactTypedLiterals } from "./query-column-semantics.mjs";

/**
 * Version of the public, request-scoped ontology view exposed to Claude.
 *
 * The snapshot is deliberately a plain-data boundary.  It is built from a
 * published schema and a physical catalog, then all read operations are
 * served from the immutable copy.  A caller can therefore keep using the
 * normal store while a Claude request is in flight without changing what the
 * model is authorised to see.
 */
export const CLAUDE_QUERY_SNAPSHOT_VERSION = "claude-query-snapshot-v1";
export const DEFAULT_SNAPSHOT_PAGE_SIZE = 20;
export const MAX_SNAPSHOT_PAGE_SIZE = 50;
export const MAX_SNAPSHOT_TEXT = 8_000;
export const MAX_SNAPSHOT_BYTES = 512_000;

const OPERATION_NAMES = new Set(["overview", "search", "get_objects", "get_relations", "get_knowledge"]);
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const LOOPBACK_TABLE_COLUMNS = new Set([
  "is_deleted", "deleted", "deleted_at", "delete_flag", "is_delete", "is_valid", "valid", "valid_flag",
  "status", "state", "created_at", "create_time", "updated_at", "update_time", "gmt_create", "gmt_modify",
  "start_time", "end_time", "expire_time", "expired_at", "effective_time", "effective_at",
]);

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
  const selectedTableNames = normalizeNameSet(
    input.allowedTableNames
      ?? input.selectedTableNames
      ?? input.context?.retrieval?.tableNames
      ?? input.context?.tables?.map((item) => item?.tableName),
  );
  const mapped = collectSchemaMappings(schema, catalog, input);
  const tableNames = chooseAllowedTables({
    mappedTableNames: mapped.tables,
    selectedTableNames,
    catalogTables: catalog.tables,
    includeSelectedOnly: input.includeSelectedOnly === true,
  });
  // A physical relation is not automatically public just because both of its
  // endpoint tables are mapped.  The published schema's link mappings are
  // the authoritative relation allow-list; an empty mapping therefore means
  // no joins are disclosed.
  const relations = chooseRelations(catalog.relations, tableNames, mapped.relationIds);
  const relationColumnKeys = new Set();
  for (const relation of relations) {
    relationColumnKeys.add(`${relation.fromTable}.${relation.fromCol}`.toLowerCase());
    relationColumnKeys.add(`${relation.toTable}.${relation.toCol}`.toLowerCase());
  }
  const knowledge = normalizeKnowledge(
    input.knowledge ?? input.context?.knowledge ?? catalog.knowledge,
    tableNames,
  );
  const rules = normalizeRules(
    input.rules ?? input.context?.rules ?? catalog.rules,
    tableNames,
  );
  const knowledgeColumnKeys = collectReferencedColumns([...knowledge, ...rules]);
  const columnsByTable = buildPublicColumns({
    catalog,
    schema,
    mapped,
    tableNames,
    relationColumnKeys,
    knowledgeColumnKeys,
    explicitAllowedColumns: input.allowedColumnsByTable ?? input.context?.allowedColumns,
  });
  const publicTables = buildPublicTables(catalog.tables, tableNames, columnsByTable);
  const objects = buildPublicObjects(schema, columnsByTable, tableNames);
  const links = buildPublicLinks(schema, relations, tableNames);
  const enumValues = buildPublicEnums(catalog, columnsByTable);
  const queryIntent = sanitizeQueryIntent(input.queryIntent ?? input.context?.queryIntent);
  const retrieval = sanitizeRetrieval(input.retrievalEvidence ?? input.context?.retrieval);
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
    isSensitiveColumn(tableName, columnName) {
      const key = normalizeIdentifier(tableName);
      const column = normalizeIdentifier(columnName);
      return Boolean((columnsByTable[key] || []).find((item) => item.columnName === column)?.sensitive);
    },
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

function collectSchemaMappings(schema, catalog, input) {
  const tables = new Set();
  const columns = new Map();
  const relationIds = new Set();
  for (const object of Array.isArray(schema?.objectTypes) ? schema.objectTypes : []) {
    for (const property of Array.isArray(object?.properties) ? object.properties : []) {
      const mapping = property?.mapping;
      const table = normalizeIdentifier(mapping?.table);
      const column = normalizeIdentifier(mapping?.column);
      if (!table || !column) continue;
      tables.add(table);
      (columns.get(table) ?? columns.set(table, new Set()).get(table)).add(column);
    }
  }
  for (const link of Array.isArray(schema?.linkTypes) ? schema.linkTypes : []) {
    for (const item of Array.isArray(link?.relationMappings) ? link.relationMappings : []) {
      const id = Number(item?.relationId ?? item);
      if (Number.isInteger(id) && id > 0) relationIds.add(id);
    }
  }
  // A caller may supply verified physical columns that are not represented by
  // a property (for example a mandatory is_deleted predicate).
  for (const [tableName, names] of Object.entries(input?.mappedColumnsByTable || {})) {
    const table = normalizeIdentifier(tableName);
    if (!table) continue;
    tables.add(table);
    const target = columns.get(table) ?? (columns.set(table, new Set()), columns.get(table));
    for (const name of names || []) target.add(normalizeIdentifier(name));
  }
  // Do not let a malformed schema invent a table absent from the physical
  // catalog.  The schema still contributes its checksum, but no SQL scope.
  const known = new Set(catalog.tables.map((item) => item.tableName));
  for (const table of [...tables]) if (!known.has(table)) tables.delete(table);
  return { tables, columns, relationIds };
}

function chooseAllowedTables({ mappedTableNames, selectedTableNames, catalogTables, includeSelectedOnly }) {
  const known = new Set(catalogTables.map((item) => item.tableName));
  let result = new Set([...mappedTableNames].filter((name) => known.has(name)));
  const selected = new Set([...selectedTableNames].filter((name) => known.has(name)));
  if (selected.size) {
    if (includeSelectedOnly) result = new Set([...result].filter((name) => selected.has(name)));
    else {
      // Retrieval selection is a narrowing hint, but never grants access to an
      // table absent from the published mapping.  This keeps relation closure
      // predictable while allowing a selected mapped table to be used.
      result = new Set([...result].filter((name) => selected.has(name)));
    }
  }
  return result;
}

function chooseRelations(catalogRelations, tableNames, allowedRelationIds = null) {
  const relations = [];
  const relationScope = allowedRelationIds instanceof Set ? allowedRelationIds : null;
  for (const relation of catalogRelations) {
    // A schema link cannot promote a physical relation that governance has
    // left in review/rejected state.  The published schema and the physical
    // relation must both agree before the join endpoint is disclosed.
    if (!["confirmed", "accepted"].includes(String(relation.status || "").toLowerCase())) continue;
    if (!tableNames.has(relation.fromTable) || !tableNames.has(relation.toTable)) continue;
    // When the published schema contains link mappings, only those exact
    // physical relation IDs may cross the snapshot boundary.  Null/unknown
    // IDs are rejected in this restricted mode rather than matched by shape.
    if (relationScope && (!Number.isInteger(relation.id) || !relationScope.has(Number(relation.id)))) continue;
    relations.push({
      id: relation.id == null ? null : Number(relation.id),
      fromTable: relation.fromTable,
      fromCol: relation.fromCol,
      toTable: relation.toTable,
      toCol: relation.toCol,
      cardinality: safeText(relation.cardinality, 80),
      status: safeText(relation.status, 40),
      confidence: finiteNumber(relation.confidence),
      source: safeText(relation.inferenceSource, 80),
    });
  }
  return dedupeBy(relations, (item) => `${item.fromTable}.${item.fromCol}->${item.toTable}.${item.toCol}`);
}

function buildPublicColumns({ catalog, schema, mapped, tableNames, relationColumnKeys, knowledgeColumnKeys, explicitAllowedColumns }) {
  const columnsByTable = {};
  for (const tableName of [...tableNames].sort()) {
    const sourceColumns = catalog.columnsByTable[tableName] || [];
    const mappedColumns = mapped.columns.get(tableName) || new Set();
    const explicit = normalizeNameSet(explicitAllowedColumns?.[tableName]);
    const propertySemantics = propertySemanticsForTable(schema, tableName);
    const allowed = new Set([...mappedColumns, ...explicit]);
    for (const column of sourceColumns) {
      const key = `${tableName}.${column.columnName}`.toLowerCase();
      if (column.isPrimary || column.isUnique || relationColumnKeys.has(key) || knowledgeColumnKeys.has(key)) allowed.add(column.columnName);
      // Mandatory row-domain fields are useful to the kernel and are not a
      // grant to arbitrary columns.  We include only well-known names.
      if (LOOPBACK_TABLE_COLUMNS.has(column.columnName)) allowed.add(column.columnName);
    }
    columnsByTable[tableName] = sourceColumns
      .filter((column) => allowed.has(column.columnName))
      .map((column) => {
        const semantic = propertySemantics.get(column.columnName) || {};
        const sensitive = Boolean(column.isSensitive || semantic.sensitive || inferredSensitive(column));
        const result = {
          columnName: column.columnName,
          dataType: safeText(column.dataType, 80),
          nullable: column.nullable == null ? null : Boolean(column.nullable),
          isPrimary: Boolean(column.isPrimary),
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
      prior.sensitive ||= Boolean(property.isSensitive || property.sensitive || /手机|电话|邮箱|email|phone|mobile|身份证|证件|银行卡/i.test(`${property.apiName || ""} ${property.displayName || ""}`));
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
        constraints: sanitizeConstraints(property.constraints, physical?.sensitive),
      });
    }
    if (!properties.length) continue;
    objects.push({
      apiName: safeText(object.apiName, 120),
      displayName: safeText(object.displayName, 200),
      description: safeText(object.description, MAX_SNAPSHOT_TEXT),
      primaryKey: safeText(object.primaryKey, 120),
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
      if (column.sensitive) continue;
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
    .slice(0, 200)
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
    .slice(0, 200)
    .map((rule) => ({
      id: rule.id == null ? null : Number(rule.id),
      name: safeText(rule.name, 500),
      appliesTo: [...normalizeNameSet(rule.appliesTo ?? rule.applies_to)].sort(),
      content: safeText(rule.content, MAX_SNAPSHOT_TEXT),
      untrustedData: true,
    }))
    .filter((rule) => rule.name || rule.content);
}

function collectReferencedColumns(items) {
  const result = new Set();
  for (const item of items || []) {
    const text = `${item?.content || ""}\n${item?.sqlContent || ""}`;
    // This intentionally recognises only qualified identifiers.  Unqualified
    // words in prose must not broaden the physical column allowlist.
    const pattern = /`?([A-Za-z_][A-Za-z0-9_$]*)`?\s*\.\s*`?([A-Za-z_][A-Za-z0-9_$]*)`?/g;
    for (const match of text.matchAll(pattern)) result.add(`${match[1].toLowerCase()}.${match[2].toLowerCase()}`);
  }
  return result;
}

function sanitizeQueryIntent(intent) {
  if (!intent || typeof intent !== "object") return null;
  const copy = {
    version: safeText(intent.version, 40),
    subjects: normalizeTextArray(intent.subjects, 20, 100),
    dimensions: normalizeTextArray(intent.dimensions, 30, 100),
    measures: normalizeTextArray(intent.measures, 30, 100),
    timeRole: safeText(intent.timeRole, 100) || null,
    shape: sanitizeData(intent.shape, 2),
    scope: sanitizeData(intent.scope, 2),
    filters: Array.isArray(intent.filters) ? intent.filters.slice(0, 30).map((filter) => ({
      field: safeText(filter?.field, 120),
      operator: safeText(filter?.operator, 40),
      value: sanitizeScalar(filter?.value),
      valueType: safeText(filter?.valueType, 40),
      physicalColumns: normalizeTextArray(filter?.physicalColumns, 10, 200),
    })) : [],
    entities: Array.isArray(intent.entities) ? intent.entities.slice(0, 20).map((entity) => ({
      type: safeText(entity?.type, 80),
      text: safeText(entity?.text, 500),
      value: sanitizeScalar(entity?.value),
    })) : [],
  };
  return removeEmpty(copy);
}

function sanitizeRetrieval(retrieval) {
  if (!retrieval || typeof retrieval !== "object") return null;
  return removeEmpty({
    version: safeText(retrieval.version, 40),
    coverage: safeText(retrieval.coverage, 80),
    retrievalMode: safeText(retrieval.retrievalMode, 80),
    tableNames: normalizeTextArray(retrieval.tableNames, 50, 128),
    diagnostics: sanitizeData(retrieval.diagnostics, 3),
  });
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
      tables: snapshot.tables,
      objects: snapshot.objects.map((object) => ({ apiName: object.apiName, displayName: object.displayName, propertyCount: object.properties.length })),
      relations: snapshot.relations,
      links: snapshot.links,
      disclosedTables: [...snapshot.disclosedTables].sort(),
    };
  }
  if (operation === "search") {
    const query = safeText(request.query, 500).toLowerCase();
    const all = searchableItems(snapshot, query);
    return pagedResult(operation, all, offset, limit, { query });
  }
  if (operation === "get_objects") {
    const wanted = normalizeRequestedIds(request.ids ?? request.objectNames ?? request.objects);
    const all = snapshot.objects.filter((object) => !wanted.size || wanted.has(object.apiName) || wanted.has(object.displayName));
    return pagedResult(operation, all, offset, limit, { ids: [...wanted].sort() });
  }
  if (operation === "get_relations") {
    const wanted = normalizeRequestedIds(request.ids ?? request.relationIds ?? request.relations);
    const all = snapshot.relations.filter((relation) => !wanted.size || wanted.has(String(relation.id)) || wanted.has(`${relation.fromTable}.${relation.fromCol}->${relation.toTable}.${relation.toCol}`));
    return pagedResult(operation, all, offset, limit, { ids: [...wanted].sort() });
  }
  const wanted = normalizeRequestedIds(request.ids ?? request.slugs ?? request.knowledge);
  const all = [...snapshot.knowledge, ...snapshot.rules].filter((item) => !wanted.size || wanted.has(item.slug) || wanted.has(item.name) || wanted.has(String(item.id)));
  return pagedResult(operation, all, offset, limit, { ids: [...wanted].sort() });
}

function searchableItems(snapshot, query) {
  const haystack = (item) => JSON.stringify(item).toLowerCase();
  const items = [
    ...snapshot.tables.map((item) => ({ kind: "table", ...item })),
    ...snapshot.objects.map((item) => ({ kind: "object", ...item })),
    ...snapshot.objects.flatMap((object) => object.properties.map((property) => ({ kind: "property", object: object.apiName, ...property }))),
    ...snapshot.relations.map((item) => ({ kind: "relation", ...item })),
    ...snapshot.knowledge.map((item) => ({ kind: "knowledge", ...item })),
    ...snapshot.rules.map((item) => ({ kind: "rule", ...item })),
  ];
  return query ? items.filter((item) => haystack(item).includes(query)) : items;
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

function inferredSensitive(column) {
  return /手机|电话|邮箱|email|phone|mobile|身份证|证件|银行卡|card_no/i.test(`${column.columnName} ${column.comment}`);
}

function sanitizeConstraints(value, sensitive) {
  if (!value || typeof value !== "object") return {};
  const result = {};
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "pattern"]) if (value[key] != null) result[key] = sensitive && key === "pattern" ? undefined : sanitizeScalar(value[key]);
  if (Array.isArray(value.enumValues) && !sensitive) result.enumValues = normalizeTextArray(value.enumValues, 200, 500);
  return removeEmpty(result);
}

function sanitizeData(value, depth = 0) {
  if (depth > 4) return undefined;
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") return sanitizeScalar(value);
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeData(item, depth + 1)).filter((item) => item !== undefined);
  if (typeof value === "object") {
    const result = {};
    for (const key of Object.keys(value).slice(0, 100)) {
      if (/prompt|instruction|futureSql|rawQuestion|normalizedQuestion|sourceText|secret|token|password|credential/i.test(key)) continue;
      const item = sanitizeData(value[key], depth + 1);
      if (item !== undefined) result[safeText(key, 100)] = item;
    }
    return result;
  }
  return undefined;
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
  return new Set(values.map((item) => safeText(item, 200).toLowerCase()).filter((item) => /^[a-z0-9][a-z0-9._:-]{0,199}$/.test(item)));
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
