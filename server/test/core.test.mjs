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
import { buildQueryColumnSemantics, detectQuestionValueKinds } from "../src/query-column-semantics.mjs";
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
  const verdict = guardSql("SELECT c.customer_id, COUNT(*) n FROM crm_customer c JOIN sales_order o ON c.customer_id = o.customer_id GROUP BY c.customer_id", {allowedTables:["crm_customer","sales_order"],allowedRelations:[{fromTable:"sales_order",fromCol:"customer_id",toTable:"crm_customer",toCol:"customer_id"}],maxRows:100});
  assert.equal(verdict.ok, true, verdict.reason);
  assert.match(verdict.sql, /LIMIT 100/i);
  assert.deepEqual(verdict.joins,["sales_order.customer_id = crm_customer.customer_id"]);
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
