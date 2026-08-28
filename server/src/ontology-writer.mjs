import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DIRS = ["tables", "terms", "metrics", "joins", "rules"];

export async function ensureOntologyStructure(root) {
  await Promise.all(DIRS.map((dir) => mkdir(join(root, dir), { recursive: true })));
  const schemaPath = join(root, "schema.md");
  await writeProtected(schemaPath, `# OntoQuery Wiki Schema

| Directory | Type | Required |
|---|---|---|
| tables/ | table | table, grade, verified |
| terms/ | term | aliases, tables, verified, SQL 片段 |
| metrics/ | metric | tables, verified, 参考 SQL |
| joins/ | join | from, to, cardinality, verified |
| rules/ | rule | tables, verified, SQL 片段 |
`, false);
}

// An excluded table's page is deleted even if a human marked it verified: exclusion means
// the table left the platform's world, and a verified page for a nonexistent table would
// keep feeding retrieval with dead references.
export async function removeTablePage(root, tableName) {
  try { await unlink(join(root, "tables", `${safeFileName(tableName)}.md`)); return { removed:true }; }
  catch (error) { if (error.code === "ENOENT") return { removed:false }; throw error; }
}

export async function writeTablePage(root, table, columns, enums = [], relations = []) {
  await ensureOntologyStructure(root);
  const file = join(root, "tables", `${safeFileName(table.tableName)}.md`);
  const enumGroups = Object.groupBy(enums, (item) => item.columnName);
  const content = `---
type: table
table: ${table.tableName}
grade: ${table.grade || "B"}
row_scale: ${table.rowEstimate || 0}
active: ${Boolean(table.active)}
last_probe_at: ${table.lastProbeAt || ""}
verified: false
---

# ${table.tableName}${table.comment ? ` ${table.comment}` : ""}

${table.comment || "由数据库结构与探针结果自动生成，等待业务复核。"}

## 字段
| 字段 | 类型 | 说明 | 备注 |
|---|---|---|---|
${columns.map((column) => `| ${column.columnName} | ${column.dataType} | ${column.comment || "待补充"} | ${column.isSensitive ? "敏感字段，不采样" : column.isPrimary ? "主键" : ""} |`).join("\n")}

## 枚举
${Object.entries(enumGroups).length ? Object.entries(enumGroups).map(([column, values]) => `### ${column}\n| 值 | 含义 | 占比 |\n|---|---|---|\n${values.map((value) => `| ${value.value} | ${value.meaning || "待确认"} | ${value.ratio == null ? "—" : `${(value.ratio * 100).toFixed(1)}%`} |`).join("\n")}`).join("\n\n") : "暂无安全可用的低基数枚举探针结果。"}

## 关联
${relations.length ? relations.map((relation) => `[[${relation.fromTable}-${relation.fromCol}-${relation.toTable}-${relation.toCol}]]`).join(" · ") : "暂无已确认关联。"}

## 陷阱
待业务审核补充。自动重建不会覆盖 verified: true 的人工页面。
`;
  return writeProtected(file, content, true);
}

export async function writeJoinPage(root, relation) {
  await ensureOntologyStructure(root);
  const name = `${relation.fromTable}-${relation.fromCol}-${relation.toTable}-${relation.toCol}`;
  return writeProtected(join(root, "joins", `${safeFileName(name)}.md`), `---
type: join
from: ${relation.fromTable}
to: ${relation.toTable}
cardinality: ${relation.cardinality}
confidence: ${relation.status === "confirmed" ? "confirmed" : relation.confidence}
verified: ${relation.status === "confirmed"}
---

# ${name}

## ON 条件
\`\`\`sql
${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}
\`\`\`

## 说明
值域重叠 ${relation.overlapRatio == null ? "待探针" : `${(relation.overlapRatio * 100).toFixed(2)}%`}，当前状态：${relation.status}。

## 陷阱
N 侧聚合到 1 侧实体时，应检查是否需要 COUNT(DISTINCT ...) 防止重复计数。
`, true);
}

export async function writeRulePage(root, rule) {
  await ensureOntologyStructure(root);
  return writeProtected(join(root, "rules", `${safeFileName(rule.name)}.md`), `---
type: rule
tables: [${rule.appliesTo || ""}]
verified: ${Boolean(rule.verified)}
---

# ${rule.name}

## SQL 片段
\`\`\`sql
${rule.content}
\`\`\`

## 说明
该规则由探针证据与人工确认产生；修改后应重跑受影响评测。
`, true);
}

async function writeProtected(file, content, protectVerified) {
  if (protectVerified) {
    try {
      const existing = await readFile(file, "utf8");
      if (/^verified:\s*true\s*$/m.test(existing)) return { file, written:false, reason:"verified_protected" };
    } catch { /* New page. */ }
  }
  await writeFile(file, content, "utf8");
  return { file, written:true };
}

function safeFileName(value) {
  return String(value).replace(/[\\/:*?"<>|]/g, "-").slice(0, 120);
}
