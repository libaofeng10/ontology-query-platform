import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decryptCredential, encryptCredential } from "../src/crypto.mjs";
import { writeTablePage } from "../src/ontology-writer.mjs";
import { inferRelation } from "../src/relation-inference.mjs";
import { detectSensitiveField } from "../src/sensitive-fields.mjs";
import { guardSql } from "../src/sql-guard.mjs";
import { buildQueryColumnSemantics, detectQuestionValueKinds, redactTypedLiterals } from "../src/query-column-semantics.mjs";
import { gradeTable } from "../src/table-grading.mjs";

test("credentials round-trip with authenticated encryption", () => {
  const encrypted = encryptCredential("not-plain-text", "test secret");
  assert.doesNotMatch(encrypted, /not-plain-text/);
  assert.equal(decryptCredential(encrypted, "test secret"), "not-plain-text");
  assert.throws(() => decryptCredential(encrypted, "wrong secret"));
});

test("sensitive fields are blocked before value probing", () => {
  assert.equal(detectSensitiveField("customer_mobile").sensitive, true);
  assert.equal(detectSensitiveField("email").sensitive, true);
  assert.equal(detectSensitiveField("seller_name").sensitive, true);
  assert.equal(detectSensitiveField("name",[],"客户姓名").sensitive, true);
  assert.equal(detectSensitiveField("unknown", ["13800138000"]).sensitive, true);
  assert.equal(detectSensitiveField("unknown", ["owner@example.com"]).sensitive, true);
  assert.equal(detectSensitiveField("customer_level", ["gold"]).sensitive, false);
});

test("query column semantics exposes every column and adds non-blocking value kinds",()=>{
  const policy=buildQueryColumnSemantics({alpha_user:[{columnName:"alpha_id",dataType:"varchar",isSensitive:0,comment:"用户ID"},{columnName:"alp_cell",dataType:"varchar",isSensitive:1,comment:"alpha用户手机号"},{columnName:"access_token",dataType:"varchar",isSensitive:1,comment:"访问密钥"}]});
  assert.deepEqual(policy.allowedColumns.alpha_user,["alpha_id","alp_cell","access_token"]);assert.equal(policy.columnKinds["alpha_user.alp_cell"],"phone");
  assert.deepEqual(detectQuestionValueKinds("13774665233查询Alpha到期时间"),[{value:"13774665233",kind:"phone"}]);
});

test("typed-literal redaction is a passthrough while value-kind detection still recognizes typed literals",()=>{
  // 2026-09-04 应用户要求全量移除敏感值脱敏：redactTypedLiterals 现在直通，
  // 不再把手机号/身份证/银行卡替换为 [REDACTED]。detectQuestionValueKinds
  // 仍继续识别 typed literal（只是不再用于脱敏/拒答）。
  const fingerprint="0f1e2d3c4b5a69788776655443322110";
  assert.equal(redactTypedLiterals(fingerprint),fingerprint);
  assert.equal(redactTypedLiterals("mobile = '13800138000'"),"mobile = '13800138000'");
  assert.deepEqual(detectQuestionValueKinds("电话 +1 (415) 555-2671，身份证 110105-19491231-002X"),[
    {value:"+1 (415) 555-2671",kind:"phone"},
    {value:"110105-19491231-002X",kind:"china_id"},
  ]);
  assert.equal(redactTypedLiterals("电话 +1 (415) 555-2671，身份证 110105-19491231-002X"),"电话 +1 (415) 555-2671，身份证 110105-19491231-002X");
  assert.equal(redactTypedLiterals("card=6222.0202.0202.0202"),"card=6222.0202.0202.0202");
  assert.equal(redactTypedLiterals(null),"");
  assert.equal(redactTypedLiterals(undefined),"");
});

test("table grading excludes inactive backup noise and promotes active hubs", () => {
  assert.equal(gradeTable({ tableName:"order_history_bak", rowEstimate:9000000, inboundRelations:0, daysSinceWrite:700 }).grade, "C");
  assert.equal(gradeTable({ tableName:"alpha_user_20230308", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "C");
  assert.equal(gradeTable({ tableName:"alpha_user_copy", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "C");
  assert.equal(gradeTable({ tableName:"alpha_user_copy1", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "C");
  assert.equal(gradeTable({ tableName:"alpha_user_v2", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "C");
  assert.equal(gradeTable({ tableName:"customerCopyArchive", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "C");
  assert.equal(gradeTable({ tableName:"crm_customer", rowEstimate:3000000, inboundRelations:4, daysSinceWrite:1 }).grade, "A");
  assert.equal(gradeTable({ tableName:"anything", gradeOverride:"B" }).grade, "B");
  assert.equal(gradeTable({ tableName:"customer_v2", gradeOverride:"B" }).grade, "B");
});

test("relation inference combines overlap, names, types and cardinality", () => {
  const result = inferRelation({columnName:"customer_id",type:"bigint",unique:false,overlapRatio:.997,cardinality:10000},{columnName:"customer_id",type:"bigint",unique:true,overlapRatio:.997,cardinality:10000});
  assert.equal(result.status, "accepted");
  assert.equal(result.cardinality, "N:1");
});

test("SQL guard permits confirmed aliased joins and adds a limit", () => {
  const verdict = guardSql("SELECT c.customer_id, COUNT(*) n FROM crm_customer c JOIN sales_order o ON c.customer_id = o.customer_id GROUP BY c.customer_id", {allowedTables:["crm_customer","sales_order"],allowedRelations:[{id:41,fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id"}],maxRows:100});
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.sql, /LIMIT 100/i);
  assert.deepEqual(verdict.joins,["sales_order.customer_id = crm_customer.customer_id"]);
  assert.deepEqual(verdict.joinRelationIds,[41]);
  assert.equal(verdict.requestedAst.limit,null);
  assert.deepEqual(verdict.ast.limit.value.map((item)=>Number(item.value)),[100]);
  assert.equal(verdict.limitedAst,verdict.ast);
  assert.deepEqual(verdict.limit,{maxRows:100,requested:null,offset:0,effective:100,added:true,capped:false});
});

test("SQL guard parses every MySQL LIMIT form and caps the count rather than the offset",()=>{
  const policy={allowedTables:["crm_customer"],allowedColumns:{crm_customer:["customer_id"]},maxRows:100};

  const countOnly=guardSql("SELECT customer_id FROM crm_customer LIMIT 25",policy);
  assert.equal(countOnly.ok,true,countOnly.reason);
  assert.deepEqual(countOnly.requestedAst.limit.value.map((item)=>Number(item.value)),[25]);
  assert.deepEqual(countOnly.ast.limit.value.map((item)=>Number(item.value)),[25]);
  assert.deepEqual(countOnly.limit,{maxRows:100,requested:25,offset:0,effective:25,added:false,capped:false});

  const comma=guardSql("SELECT customer_id FROM crm_customer LIMIT 20, 250",policy);
  assert.equal(comma.ok,true,comma.reason);
  assert.equal(comma.requestedAst.limit.seperator,",");
  assert.deepEqual(comma.requestedAst.limit.value.map((item)=>Number(item.value)),[20,250]);
  assert.deepEqual(comma.ast.limit.value.map((item)=>Number(item.value)),[20,100]);
  assert.deepEqual(comma.limit,{maxRows:100,requested:250,offset:20,effective:100,added:false,capped:true});
  assert.match(comma.sql,/LIMIT 20, 100/i);

  const offset=guardSql("SELECT customer_id FROM crm_customer LIMIT 250 OFFSET 20",policy);
  assert.equal(offset.ok,true,offset.reason);
  assert.equal(offset.requestedAst.limit.seperator,"offset");
  assert.deepEqual(offset.requestedAst.limit.value.map((item)=>Number(item.value)),[250,20]);
  assert.deepEqual(offset.ast.limit.value.map((item)=>Number(item.value)),[100,20]);
  assert.deepEqual(offset.limit,{maxRows:100,requested:250,offset:20,effective:100,added:false,capped:true});
  assert.match(offset.sql,/LIMIT 100 OFFSET 20/i);
});

test("SQL guard fails closed on set operations at the root and inside CTEs",()=>{
  const policy={allowedTables:["crm_customer","sales_order"],allowedColumns:{crm_customer:["customer_id"],sales_order:["customer_id"]},maxRows:100};
  const root=guardSql("SELECT customer_id FROM crm_customer UNION ALL SELECT customer_id FROM sales_order",policy);
  assert.equal(root.ok,false);
  assert.equal(root.code,"UNSUPPORTED_SET_OPERATION");

  const cte=guardSql("WITH combined AS (SELECT customer_id FROM crm_customer UNION SELECT customer_id FROM sales_order) SELECT customer_id FROM combined",policy);
  assert.equal(cte.ok,false);
  assert.equal(cte.code,"UNSUPPORTED_SET_OPERATION");
});

test("SQL guard blocks mutations, multiple statements, invented joins, bad enums and dangerous functions", () => {
  const policy={allowedTables:["crm_customer","sales_order"],allowedRelations:[],enums:{"crm_customer.cert_status":["1","2"]}};
  assert.equal(guardSql("DELETE FROM crm_customer",policy).ok,false);
  assert.equal(guardSql("SELECT * FROM crm_customer; SELECT * FROM sales_order",policy).ok,false);
  assert.match(guardSql("SELECT * FROM crm_customer c JOIN sales_order o ON c.customer_id=o.customer_id",policy).reason,/未确认/);
  assert.match(guardSql("SELECT * FROM crm_customer WHERE cert_status=9",policy).reason,/字典外/);
  assert.match(guardSql("SELECT SLEEP(10) FROM crm_customer",policy).reason,/危险函数/);
  assert.match(guardSql("SELECT * FROM unknown_table",policy).reason,/白名单/);
});

test("SQL guard rejects database-qualified tables instead of widening the source boundary", () => {
  const policy = { allowedTables: ["crm_customer"], allowedColumns: { crm_customer: ["customer_id"] }, maxRows: 100 };
  const crossDatabase = guardSql("SELECT customer_id FROM another_database.crm_customer", policy);
  assert.equal(crossDatabase.ok, false);
  assert.equal(crossDatabase.code, "CROSS_DATABASE_FORBIDDEN");
  const quoted = guardSql("SELECT customer_id FROM `another_database`.`crm_customer`", policy);
  assert.equal(quoted.ok, false);
  assert.equal(quoted.code, "CROSS_DATABASE_FORBIDDEN");
  const qualifiedColumn = guardSql("SELECT another_database.crm_customer.customer_id FROM crm_customer", policy);
  assert.equal(qualifiedColumn.ok, false);
  assert.equal(qualifiedColumn.code, "CROSS_DATABASE_FORBIDDEN");
  const nestedQualifiedColumn = guardSql("SELECT customer_id FROM crm_customer WHERE customer_id IN (SELECT another_database.crm_customer.customer_id FROM crm_customer)", policy);
  assert.equal(nestedQualifiedColumn.ok, false);
  assert.equal(nestedQualifiedColumn.code, "CROSS_DATABASE_FORBIDDEN");
});

test("SQL guard never borrows an enum dictionary from another table with the same column name",()=>{
  const policy={
    allowedTables:["alpha_crm_clue","alpha_user"],
    allowedColumns:{alpha_crm_clue:["id","city"],alpha_user:["alpha_id","city"]},
    enums:{"alpha_user.city":["北京"]},
  };
  const clue=guardSql("SELECT id FROM alpha_crm_clue WHERE city = '北京市'",policy);
  assert.equal(clue.ok,true,clue.reason);
  const user=guardSql("SELECT alpha_id FROM alpha_user WHERE city = '北京市'",policy);
  assert.equal(user.ok,false);
  assert.equal(user.code,"ENUM_VALUE_INVALID");
});

test("SQL guard requires table qualification when an unqualified column has multiple owners",()=>{
  const policy={
    allowedTables:["crm_customer","sales_order"],
    allowedColumns:{crm_customer:["customer_id"],sales_order:["order_id","customer_id"]},
    allowedRelations:[{fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id"}],
  };
  const verdict=guardSql("SELECT customer_id FROM crm_customer c JOIN sales_order o ON c.customer_id = o.customer_id",policy);
  assert.equal(verdict.ok,false);
  assert.equal(verdict.code,"AMBIGUOUS_COLUMN");
});

test("SQL guard enforces field allowlists and blocks sensitive columns and SELECT star",()=>{
  const policy={allowedTables:["crm_customer"],allowedColumns:{crm_customer:["customer_id","cert_status"]},forbiddenColumns:["crm_customer.mobile"]};
  assert.equal(guardSql("SELECT customer_id FROM crm_customer",policy).ok,true);
  assert.match(guardSql("SELECT mobile FROM crm_customer",policy).reason,/敏感字段/);
  assert.match(guardSql("SELECT unknown_field FROM crm_customer",policy).reason,/字段不在白名单/);
  assert.match(guardSql("SELECT * FROM crm_customer",policy).reason,/禁止 SELECT \*/);
  assert.equal(guardSql("SELECT COUNT(*) AS n FROM crm_customer",policy).ok,true);
});

test("SQL guard treats every allowed column normally while rejecting value and field semantic mismatch",()=>{
  const policy={allowedTables:["alpha_user"],allowedColumns:{alpha_user:["alpha_id","alp_cell","expire_time","is_deleted"]},columnKinds:{"alpha_user.alp_cell":"phone"},valueKinds:[{value:"13774665233",kind:"phone"}],maxRows:100};
  const filtered=guardSql("SELECT expire_time FROM alpha_user WHERE alp_cell = '13774665233' AND is_deleted = 0",policy);
  assert.equal(filtered.ok,true,filtered.reason);assert.match(filtered.sql,/13774665233/);
  assert.equal(guardSql("SELECT alp_cell FROM alpha_user WHERE alp_cell = '13774665233'",policy).ok,true);
  assert.equal(guardSql("SELECT COUNT(*) n FROM alpha_user WHERE alp_cell LIKE '137%'",policy).ok,true);
  assert.equal(guardSql("SELECT alp_cell, COUNT(*) n FROM alpha_user GROUP BY alp_cell ORDER BY alp_cell",policy).ok,true);
  assert.match(guardSql("SELECT expire_time FROM alpha_user WHERE alpha_id = '13774665233'",policy).reason,/手机号.*alpha_user\.alpha_id/);
});

test("SQL guard rejects comma joins and validates cross-table subquery links against the relation allowlist",()=>{
  const policy={
    allowedTables:["crm_customer","sales_order"],
    allowedColumns:{crm_customer:["customer_id","name"],sales_order:["order_id","customer_id","amount"]},
    allowedRelations:[{fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id"}],
    maxRows:100,
  };
  assert.match(guardSql("SELECT o.order_id FROM sales_order o, crm_customer c WHERE o.customer_id = c.customer_id",policy).reason,/逗号连接/);
  assert.match(guardSql("SELECT o.order_id FROM sales_order o WHERE o.order_id IN (SELECT c.customer_id FROM crm_customer c)",policy).reason,/未确认的关联/);
  assert.equal(guardSql("SELECT o.order_id FROM sales_order o WHERE o.customer_id IN (SELECT c.customer_id FROM crm_customer c)",policy).ok,true);
  assert.match(guardSql("SELECT o.order_id FROM sales_order o WHERE EXISTS (SELECT 1 FROM crm_customer c WHERE c.customer_id = o.order_id)",policy).reason,/未确认的 JOIN/);
  assert.equal(guardSql("SELECT o.order_id FROM sales_order o WHERE EXISTS (SELECT 1 FROM crm_customer c WHERE c.customer_id = o.customer_id)",policy).ok,true);
  assert.equal(guardSql("SELECT o.order_id FROM sales_order o WHERE o.amount = (SELECT MAX(x.amount) FROM sales_order x)",policy).ok,true);
});

test("SQL guard resolves CTE column lineage for allowlists, joins and sensitive columns",()=>{
  const policy={
    allowedTables:["crm_customer","sales_order"],
    allowedColumns:{crm_customer:["customer_id","name"],sales_order:["order_id","customer_id","amount"]},
    forbiddenColumns:["crm_customer.mobile"],
    allowedRelations:[{fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id"}],
    maxRows:100,
  };
  assert.equal(guardSql("WITH t AS (SELECT order_id, amount FROM sales_order) SELECT order_id, amount FROM t",policy).ok,true);
  assert.equal(guardSql("WITH t AS (SELECT customer_id AS cid, amount FROM sales_order) SELECT c.name FROM crm_customer c JOIN t ON t.cid = c.customer_id",policy).ok,true);
  assert.match(guardSql("WITH t AS (SELECT COUNT(*) AS n, customer_id AS cid FROM sales_order GROUP BY customer_id) SELECT c.name FROM crm_customer c JOIN t ON t.n = c.customer_id",policy).reason,/计算列/);
  assert.match(guardSql("WITH t AS (SELECT mobile AS m FROM crm_customer) SELECT m FROM t",policy).reason,/敏感字段/);
  assert.match(guardSql("WITH t AS (SELECT order_id FROM sales_order) SELECT c.name FROM crm_customer c JOIN t ON t.order_id = c.customer_id",policy).reason,/未确认的 JOIN/);
});

test("SQL guard fails closed on derived tables whose output and join lineage are not supported",()=>{
  const policy={
    allowedTables:["lead_entity","lead_owner_rel"],
    allowedColumns:{lead_entity:["id"],lead_owner_rel:["lead_id","owner_name"]},
    allowedRelations:[],
  };
  const sql="SELECT d.owner_name FROM (SELECT lead_id, owner_name FROM lead_owner_rel) d JOIN lead_entity l ON d.lead_id = l.id";
  const result=guardSql(sql,policy);
  assert.equal(result.ok,false);
  assert.equal(result.code,"UNSUPPORTED_DERIVED_TABLE");
});

test("verified ontology pages are never overwritten", async () => {
  const root=await mkdtemp(join(tmpdir(),"ontoquery-wiki-"));
  const table={tableName:"crm_customer",grade:"A",rowEstimate:1,active:1,comment:"客户"};
  const first=await writeTablePage(root,table,[],[],[]);
  assert.equal(first.written,true);
  const verified=(await readFile(first.file,"utf8")).replace("verified: false","verified: true");
  await writeFile(first.file,verified,"utf8");
  const second=await writeTablePage(root,{...table,comment:"不应覆盖"},[],[],[]);
  assert.deepEqual({written:second.written,reason:second.reason},{written:false,reason:"verified_protected"});
  assert.doesNotMatch(await readFile(first.file,"utf8"),/不应覆盖/);
});
