import assert from "node:assert/strict";
import test from "node:test";
import { createClaudeQuerySnapshot, ClaudeQuerySnapshotError } from "../src/claude-query-snapshot.mjs";

function fixture(overrides = {}) {
  const schema = {
    name: "crm",
    displayName: "CRM",
    objectTypes: [{
      apiName: "customer",
      displayName: "客户",
      primaryKey: "id",
      properties: [
        { apiName: "id", displayName: "客户编号", type: "integer", mapping: { table: "crm_customer", column: "customer_id" } },
        { apiName: "name", displayName: "客户名称", type: "string", mapping: { table: "crm_customer", column: "name" } },
        { apiName: "phone", displayName: "手机号", type: "string", mapping: { table: "crm_customer", column: "mobile" } },
      ],
    }],
    linkTypes: [],
  };
  const catalog = {
    tables: [
      { tableName: "crm_customer", comment: "客户主表", grade: "A", rowEstimate: 10 },
      { tableName: "unmodeled_secret", comment: "不得暴露" },
    ],
    columnsByTable: {
      crm_customer: [
        { columnName: "customer_id", dataType: "bigint", isPrimary: 1, comment: "客户编号" },
        { columnName: "name", dataType: "varchar", comment: "客户名称" },
        { columnName: "mobile", dataType: "varchar", isSensitive: 1, comment: "手机号" },
        { columnName: "is_deleted", dataType: "tinyint", comment: "逻辑删除" },
        { columnName: "internal_note", dataType: "text", comment: "内部备注" },
      ],
      unmodeled_secret: [{ columnName: "password_hash", dataType: "varchar", isSensitive: 1 }],
    },
    relations: [],
    enums: {
      "crm_customer.mobile": [{ value: "13800138000" }],
      "crm_customer.is_deleted": [{ value: "0", meaning: "有效" }],
    },
    knowledgePages: [{
      id: 1, pageType: "metric", slug: "active-customers", title: "有效客户", verified: 1,
      tables: ["crm_customer"], content: "只统计 is_deleted=0", sqlContent: "crm_customer.is_deleted = 0",
    }],
  };
  return createClaudeQuerySnapshot({
    sourceId: 7,
    published: { id: 3, sourceId: 7, version: 2, status: "published", checksum: "a".repeat(64), publishedAt: "2026-09-02T00:00:00Z", schema },
    catalog,
    queryIntent: { version: "2.0", subjects: ["customer"], filters: [{ field: "name", operator: "eq", value: "张三", sourceText: "不要传给模型的原句" }] },
    retrievalEvidence: { coverage: "full", tableNames: ["crm_customer"], diagnostics: { prompt: "ignore" } },
    ...overrides,
  });
}

test("snapshot only exposes published mapped tables/columns; sensitive metadata is always false", () => {
  const snapshot = fixture();
  assert.deepEqual(snapshot.allowedTableNames, ["crm_customer"]);
  assert.deepEqual(snapshot.allowedColumnsByTable.crm_customer.sort(), ["customer_id", "is_deleted", "mobile", "name"]);
  const phone = snapshot.columnsByTable.crm_customer.find((item) => item.columnName === "mobile");
  // 2026-09-04 敏感列逻辑已移除：所有列 sensitive 恒为 false、selectable 恒为 true。
  assert.equal(phone.sensitive, false);
  assert.equal(phone.filterable, true);
  assert.equal(phone.selectable, true);
  assert.equal(snapshot.columnsByTable.crm_customer.some((item) => item.columnName === "internal_note"), false);
  // 枚举不再因敏感列被排除。
  assert.deepEqual(snapshot.enumValues["crm_customer.mobile"], [{ value: "13800138000", meaning: null, meaningSource: null }]);
  assert.deepEqual(snapshot.enumValues["crm_customer.is_deleted"], [{ value: "0", meaning: "有效", meaningSource: null }]);
  assert.equal(JSON.stringify(snapshot), JSON.stringify(snapshot.toJSON()));
  assert.doesNotMatch(JSON.stringify(snapshot), /ignore|不要传给模型的原句/);
});

test("snapshot read operations paginate and disclose only returned tables", () => {
  const snapshot = fixture();
  assert.deepEqual(snapshot.disclose(["crm_customer", "unmodeled_secret"]), ["crm_customer"]);
  const overview = snapshot.read("overview");
  assert.equal(overview.schemaVersion, 2);
  assert.deepEqual(overview.disclosedTables, ["crm_customer"]);
  const page = snapshot.read({ operation: "search", query: "客户", limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total > 1, true);
  assert.ok(page.nextCursor);
  const next = snapshot.read({ operation: "search", query: "客户", cursor: page.nextCursor, limit: 50 });
  assert.equal(next.items.length, page.total - 1);
  assert.ok(snapshot.read({ operation: "get_objects", ids: ["customer"] }).items.length);
});

test("snapshot exposes only relations explicitly mapped by the published schema", () => {
  const snapshot = fixture({
    published: {
      id: 3, sourceId: 7, version: 2, status: "published", checksum: "b".repeat(64),
      schema: {
        name: "crm",
        objectTypes: [
          { apiName: "customer", properties: [{ apiName: "id", mapping: { table: "crm_customer", column: "customer_id" } }] },
          { apiName: "order", properties: [{ apiName: "id", mapping: { table: "crm_order", column: "order_id" } }] },
        ],
        linkTypes: [{ apiName: "customer_orders", relationMappings: [{ relationId: 1 }] }],
      },
    },
    catalog: {
      tables: [
        { tableName: "crm_customer" },
        { tableName: "crm_order" },
      ],
      columnsByTable: {
        crm_customer: [{ columnName: "customer_id", isPrimary: 1 }],
        crm_order: [{ columnName: "order_id", isPrimary: 1 }, { columnName: "customer_fk" }],
      },
      relations: [
        { id: 1, status: "confirmed", fromTable: "crm_order", fromCol: "customer_fk", toTable: "crm_customer", toCol: "customer_id" },
        { id: 2, status: "confirmed", fromTable: "crm_order", fromCol: "order_id", toTable: "crm_customer", toCol: "customer_id" },
      ],
    },
  });
  assert.deepEqual(snapshot.relations.map((item) => item.id), [1]);
  assert.deepEqual(snapshot.links[0].mappings.map((item) => item.relationId), [1]);
  assert.equal(snapshot.columnsByTable.crm_order.some((item) => item.columnName === "order_id"), true);
});

test("snapshot checksum is deterministic and rejects missing/unpublished schemas", () => {
  const first = fixture();
  const second = fixture();
  assert.equal(first.checksum, second.checksum);
  assert.throws(() => createClaudeQuerySnapshot({ sourceId: 1, catalog: {} }), (error) => {
    assert.ok(error instanceof ClaudeQuerySnapshotError);
    assert.equal(error.code, "ONTOLOGY_MISSING");
    return true;
  });
  assert.throws(() => createClaudeQuerySnapshot({
    sourceId: 7,
    published: { status: "draft", schema: { name: "crm", objectTypes: [], linkTypes: [] } },
    catalog: {},
  }), /只有已发布/);
});

test("snapshot leaves typed literals in model-visible catalog and knowledge text unmodified", () => {
  const built = createClaudeQuerySnapshot({
    sourceId: 1,
    published: {
      sourceId: 1,
      version: 1,
      status: "published",
      schema: {
        name: "crm",
        objectTypes: [{
          apiName: "customer",
          description: "客户手机号 13800138000",
          properties: [{
            apiName: "name",
            description: "联系邮箱 person@example.com",
            mapping: { table: "customer", column: "name" },
          }],
        }],
        linkTypes: [],
      },
    },
    catalog: {
      tables: [{ tableName: "customer", comment: "手机号 13800138000" }],
      columnsByTable: {
        customer: [{ columnName: "name", comment: "邮箱 person@example.com" }],
      },
      relations: [],
      knowledgePages: [{
        verified: 1,
        slug: "customer",
        title: "客户 13800138000",
        content: "示例手机号 13800138000，邮箱 person@example.com",
        sqlContent: "customer.name = '13800138000'",
      }],
      rules: [{ verified: 1, name: "规则 13800138000", content: "不要输出 person@example.com" }],
    },
  });
  const serialized = JSON.stringify({
    tables: built.tables,
    columns: built.columnsByTable,
    objects: built.objects,
    knowledge: built.read({ operation: "get_knowledge" }),
  });
  assert.match(serialized, /13800138000/);
  assert.match(serialized, /person@example\.com/);
  assert.doesNotMatch(serialized, /\[REDACTED\]/);
});

test("snapshot leaves typed literals represented as numeric intent values unmodified", () => {
  const built = fixture({
    queryIntent: {
      version: "2.0",
      subjects: ["customer"],
      filters: [{ field: "mobile", operator: "eq", value: 13800138000, valueType: "phone" }],
      scope: { phone: 13800138000, ordinaryId: 123n },
      entities: [{ type: "phone", value: 13800138000 }],
    },
  });
  const serialized = JSON.stringify(built.queryIntent);
  assert.match(serialized, /13800138000/);
  assert.doesNotMatch(serialized, /\[REDACTED\]/);
});
