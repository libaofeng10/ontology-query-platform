import sqlParser from "node-sql-parser";

const { Parser } = sqlParser;
const parser = new Parser();
const DANGEROUS_FUNCTIONS = new Set(["sleep","benchmark","load_file","get_lock","release_lock","sys_exec","sys_eval"]);

export function guardSql(sql, policy = {}) {
  if (typeof sql !== "string" || !sql.trim()) return denied("SQL 为空",{code:"EMPTY_SQL"});
  let ast;
  try { ast = parser.astify(sql, { database:"MySQL" }); }
  catch (error) { return denied(`SQL 解析失败：${error.message}`,{code:"SQL_PARSE_ERROR"}); }
  const statements = Array.isArray(ast) ? ast : [ast];
  if (statements.length !== 1) return denied("只允许单条 SQL",{code:"MULTIPLE_STATEMENTS"});
  const statement = statements[0];
  if (statement?.type !== "select") return denied("只允许 SELECT 查询",{code:"NON_SELECT"});
  const hasIntoTarget = statement.into && Object.values(statement.into).some((value)=>value != null);
  if (hasIntoTarget || statement.lock || statement.for_update || /\b(?:INTO\s+(?:OUTFILE|DUMPFILE)|FOR\s+UPDATE|LOCK\s+IN\s+SHARE\s+MODE)\b/i.test(sql)) return denied("禁止写文件或加锁查询");

  const functionNames = collectFunctionNames(statement);
  const dangerous = functionNames.find((name)=>DANGEROUS_FUNCTIONS.has(name));
  if (dangerous) return denied(`禁止危险函数 ${dangerous}`);

  const cte = buildCteInfo(statement);
  if (cte.error) return denied(cte.error);

  const tableNames = getTableNames(sql).filter((table)=>!cte.names.has(normalizeName(table)));
  const allowedTables = new Set((policy.allowedTables || []).map(normalizeName));
  const unknownTables = tableNames.filter((table)=>allowedTables.size && !allowedTables.has(normalizeName(table)));
  if (unknownTables.length) return denied(`表不在白名单：${unknownTables.join(", ")}`, { code:"UNKNOWN_TABLE",tables:tableNames,details:{unknownTables} });

  const aliasContext = buildAliasContext(statement, cte);
  if (aliasContext.error) return denied(aliasContext.error, { tables:tableNames });

  const joinVerdict = validateJoins(statement, policy.allowedRelations || [], aliasContext, cte);
  if (!joinVerdict.ok) return { ...joinVerdict, tables:tableNames };

  const columnVerdict = validateColumns(statement, policy.allowedColumns || {}, policy.forbiddenColumns || [], aliasContext, cte);
  if (!columnVerdict.ok) return { ...columnVerdict, tables:tableNames };

  let enumVerdict;
  try { enumVerdict = validateEnums(statement, policy.enums || {}, aliasContext, cte); }
  catch (error) { if (error instanceof EnumValidationError||error instanceof EnumOwnershipError) return denied(error.message,{code:error.code,tables:tableNames,details:error.details}); throw error; }
  if (!enumVerdict.ok) return { ...enumVerdict, tables:tableNames };

  const mandatoryVerdict=validateMandatoryFilters(statement,policy.mandatoryFilters||[],aliasContext,cte);
  if(!mandatoryVerdict.ok)return {...mandatoryVerdict,tables:tableNames};

  const semanticVerdict=validateValueSemantics(statement,policy.valueKinds||[],policy.columnKinds||{},policy.allowedColumns||{},aliasContext,cte);
  if(!semanticVerdict.ok)return {...semanticVerdict,tables:tableNames};

  const maxRows = Math.max(1, Number(policy.maxRows || 500));
  const limitedAst = structuredClone(statement);
  const requestedLimit=limitCount(statement.limit);
  if (!limitedAst.limit) limitedAst.limit = { seperator:"", value:[{ type:"number", value:maxRows }] };
  else {
    const values = limitedAst.limit.value || [];
    const countNode = values.at(-1);
    if (countNode?.type === "number" && Number(countNode.value) > maxRows) countNode.value=maxRows;
  }
  const safeSql = parser.sqlify(limitedAst, { database:"MySQL" });
  const effectiveLimit=requestedLimit==null?maxRows:Math.min(requestedLimit,maxRows);
  return { ok:true, sql:safeSql, tables:tableNames, joins:joinVerdict.joins, functions:functionNames, ast:statement,limit:{maxRows,effective:effectiveLimit,added:requestedLimit==null,capped:requestedLimit!=null&&requestedLimit>maxRows} };
}

// CTE outputs are tracked as column lineage back to physical columns; computed
// columns (aggregates, expressions) resolve to null and may not participate in
// join conditions. CTE bodies themselves are still fully validated because the
// AST walk descends into statement.with.
function buildCteInfo(statement) {
  const names=new Set();
  const lineage=new Map();
  for (const item of statement.with||[]) {
    const name=normalizeName(item.name?.value??item.name);
    const body=item.stmt?.ast||item.stmt;
    if(!name||body?.type!=="select") return {error:"无法解析 CTE 定义"};
    const local=new Map();
    for(const source of body.from||[]) if(source.table) {
      const table=normalizeName(source.table);
      local.set(normalizeName(source.as||source.table), lineage.has(table)?{cte:table}:table);
    }
    const declared=Array.isArray(item.columns)?item.columns.map((column)=>normalizeName(column?.value??column)):null;
    const columns=new Map();
    for(const [index,column] of (Array.isArray(body.columns)?body.columns:[]).entries()) {
      const output=declared?.[index] ?? normalizeName(column.as||(column.expr?.type==="column_ref"?column.expr.column:""));
      if(!output||output==="*") continue;
      columns.set(output,column.expr?.type==="column_ref"?resolveInCteBody(local,lineage,column.expr):null);
    }
    names.add(name);
    lineage.set(name,columns);
  }
  return {names,lineage};
}

function resolveInCteBody(local,lineage,ref) {
  const column=normalizeName(ref.column);
  const target=ref.table?local.get(normalizeName(ref.table)):local.size===1?[...local.values()][0]:null;
  if(!target) return null;
  if(typeof target==="object") return lineage.get(target.cte)?.get(column)??null;
  return {table:target,column};
}

// One merged alias map across every SELECT scope. The SQL here is machine
// generated, so an alias bound to two different tables is treated as an error
// instead of implementing per-scope resolution.
function buildAliasContext(statement,cte) {
  const aliasToTarget=new Map();
  const physicalTables=new Set();
  for(const select of collectSelects(statement)) {
    for(const source of select.from||[]) {
      if(!source.table) continue;
      const table=normalizeName(source.table);
      const target=cte.names.has(table)?{cte:table}:table;
      if(typeof target==="string")physicalTables.add(target);
      const alias=normalizeName(source.as||source.table);
      const existing=aliasToTarget.get(alias);
      if(existing!==undefined&&!sameTarget(existing,target)) return {error:`别名 ${alias} 在查询中指向多个不同表，请为每个表使用唯一别名`};
      aliasToTarget.set(alias,target);
    }
  }
  return {aliasToTarget,physicalTables};
}

function sameTarget(left,right) {
  if(typeof left==="string"||typeof right==="string") return left===right;
  return left.cte===right.cte;
}

// Resolves a column_ref to a physical {table,column}, {computed:true} for CTE
// computed columns, or null when the reference cannot be resolved (unqualified
// or unknown alias — the column allowlist still applies to those).
function resolvePhysical(ref,aliasContext,cte) {
  if(!ref?.table) {
    if(aliasContext.physicalTables?.size===1)return {table:[...aliasContext.physicalTables][0],column:normalizeName(ref?.column)};
    return null;
  }
  const column=normalizeName(ref.column);
  const target=aliasContext.aliasToTarget.get(normalizeName(ref.table));
  if(target===undefined) return null;
  if(typeof target==="object") {
    const resolved=cte.lineage.get(target.cte)?.get(column);
    return resolved||{computed:true,cte:target.cte,column};
  }
  return {table:target,column};
}

function resolvePhysicalInScope(ref,ancestors,aliasContext,cte) {
  if(ref?.table)return resolvePhysical(ref,aliasContext,cte);
  const select=[...(ancestors||[])].reverse().find((item)=>item?.type==="select");
  const sources=(select?.from||[]).filter((item)=>item.table);
  if(sources.length!==1)return resolvePhysical(ref,aliasContext,cte);
  const source=sources[0];
  const table=normalizeName(source.table);
  if(cte.names.has(table)) {
    const resolved=cte.lineage.get(table)?.get(normalizeName(ref?.column));
    return resolved||{computed:true,cte:table,column:normalizeName(ref?.column)};
  }
  return {table,column:normalizeName(ref?.column)};
}

function validateJoins(statement, allowedRelations, aliasContext, cte) {
  const relationByKey = new Map();
  for (const relation of allowedRelations) {
    relationByKey.set(edgeKey(relation.fromTable,relation.fromCol,relation.toTable,relation.toCol),relation);
    relationByKey.set(edgeKey(relation.toTable,relation.toCol,relation.fromTable,relation.fromCol),relation);
  }
  const usedRelations=[];

  for (const select of collectSelects(statement)) {
    for (const [index,source] of (select.from||[]).entries()) {
      if (index>0&&!source.join) return denied("多表查询必须使用显式 JOIN ... ON，且关联关系已确认；禁止逗号连接");
      if (!source.join) continue;
      if (!source.on) return denied(`JOIN ${source.table || "子查询"} 缺少 ON 条件`);
      if (!collectJoinComparisons(source.on).length) return denied(`JOIN ${source.table || "子查询"} 的 ON 条件不是已知字段等值关联`);
    }
  }

  // Every cross-table equality anywhere in the statement (ON, WHERE, HAVING,
  // correlated subqueries) must map to a confirmed relation. Same-table
  // comparisons cannot leak a cross-table relationship and stay permitted.
  let failure=null;
  walk(statement,(node)=>{
    if(failure||node.type!=="binary_expr") return;
    const operator=String(node.operator||"").toUpperCase();
    if(operator==="="&&node.left?.type==="column_ref"&&node.right?.type==="column_ref") { failure=checkColumnPair(node.left,node.right);return; }
    if(!["=","IN","NOT IN"].includes(operator)) return;
    const subquery=subqueryOf(node.right)||subqueryOf(node.left);
    if(subquery) failure=checkSubqueryLink(operator,node.left?.type==="column_ref"?node.left:node.right?.type==="column_ref"?node.right:null,subquery);
  });
  if(failure) return denied(failure);

  return { ok:true,joins:usedRelations.map((relation)=>`${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}`) };

  function checkColumnPair(left,right) {
    const a=resolvePhysical(left,aliasContext,cte);
    const b=resolvePhysical(right,aliasContext,cte);
    if(a?.computed||b?.computed) return `CTE 计算列不能作为关联条件：${(a?.computed?a:b).cte}.${(a?.computed?a:b).column}`;
    if(!a||!b) return null;
    if(a.table===b.table) return null;
    const relation=relationByKey.get(edgeKey(a.table,a.column,b.table,b.column));
    if(!relation) return `使用了未确认的 JOIN：${a.table}.${a.column} = ${b.table}.${b.column}`;
    if(!usedRelations.includes(relation)) usedRelations.push(relation);
    return null;
  }

  function checkSubqueryLink(operator,outerRef,subquery) {
    const isIn=operator!=="=";
    if(!outerRef) return isIn?"IN 子查询必须以明确的物理字段作为外层关联列":null;
    const columns=Array.isArray(subquery.columns)?subquery.columns:[];
    if(columns.length!==1) return "关联子查询必须只返回单列";
    const expr=columns[0].expr;
    if(expr?.type!=="column_ref") return isIn?"IN 子查询的输出必须是明确物理字段":null;
    const innerRef=!expr.table&&(subquery.from||[]).filter((source)=>source.table).length===1
      ?{...expr,table:subquery.from.find((source)=>source.table).as||subquery.from.find((source)=>source.table).table}
      :expr;
    const outer=resolvePhysical(outerRef,aliasContext,cte);
    const inner=resolvePhysical(innerRef,aliasContext,cte);
    if(outer?.computed||inner?.computed) return `CTE 计算列不能作为关联条件：${(outer?.computed?outer:inner).cte}.${(outer?.computed?outer:inner).column}`;
    if(!outer||!inner) return null;
    if(outer.table===inner.table) return null;
    const relation=relationByKey.get(edgeKey(outer.table,outer.column,inner.table,inner.column));
    if(!relation) return `使用了未确认的关联：${outer.table}.${outer.column} = ${inner.table}.${inner.column}`;
    if(!usedRelations.includes(relation)) usedRelations.push(relation);
    return null;
  }
}

function validateEnums(statement, dictionaries, aliasContext, cte) {
  const normalized = new Map(Object.entries(dictionaries).map(([key,value])=>{
    const spec=Array.isArray(value)?{values:value,mode:"closed"}:value&&typeof value==="object"?value:{values:[],mode:"unknown"};
    return [key.toLowerCase(),{mode:String(spec.mode||"closed"),values:new Set((spec.values||[]).map(String))}];
  }));
  walkWithAncestors(statement,(node,ancestors)=>{
    if (node.type !== "binary_expr" || !["=","!=","<>","IN"].includes(String(node.operator).toUpperCase())) return;
    const column = node.left?.type === "column_ref" ? node.left : node.right?.type === "column_ref" ? node.right : null;
    const literal = column === node.left ? node.right : node.left;
    if (!column || !literal) return;
    const resolved = resolvePhysicalInScope(column,ancestors,aliasContext,cte);
    if (resolved?.computed) return;
    const columnName = resolved?resolved.column:String(column.column).toLowerCase();
    const tableName = resolved?resolved.table:null;
    const exactKey=`${tableName||column.table||""}.${columnName}`.toLowerCase();
    let dictionary=normalized.get(exactKey)||normalized.get(columnName);
    if(!dictionary&&!column.table&&!resolved) {
      const physical=aliasContext.physicalTables||new Set();
      const candidates=[...normalized.entries()].filter(([key])=>{
        const [table,candidateColumn]=splitColumnKey(key);
        return candidateColumn===columnName&&physical.has(table);
      });
      if(candidates.length>1)throw new EnumOwnershipError(column.column,candidates.map(([key])=>key));
      dictionary=candidates[0]?.[1];
    }
    if (!dictionary||dictionary.mode!=="closed"||!dictionary.values.size) return;
    const values = literal.type === "expr_list" ? (literal.value||[]).map(literalValue) : [literalValue(literal)];
    const invalid = values.filter((value)=>value != null && !dictionary.values.has(String(value)));
    if (invalid.length) throw new EnumValidationError(`${column.table ? `${column.table}.` : ""}${column.column}`,invalid);
  });
  return { ok:true };
}

function validateMandatoryFilters(statement,filters,aliasContext,cte) {
  if(!Array.isArray(filters)||!filters.length)return {ok:true};
  const found=[];
  walkWithAncestors(statement.where,(node,ancestors)=>{
    if(node.type!=="binary_expr")return;
    const operator=String(node.operator||"").toUpperCase();
    let column=null;let valueNode=null;
    if(node.left?.type==="column_ref"){column=node.left;valueNode=node.right;}
    else if(operator==="="&&node.right?.type==="column_ref"){column=node.right;valueNode=node.left;}
    if(!column||!["=","IN"].includes(operator))return;
    const physical=resolvePhysicalInScope(column,ancestors,aliasContext,cte);
    if(!physical||physical.computed)return;
    const nodes=operator==="IN"&&valueNode?.type==="expr_list"?valueNode.value||[]:[valueNode];
    const values=nodes.map(filterLiteral).filter((item)=>item.valid).map((item)=>String(item.value));
    found.push({table:physical.table,column:physical.column,values});
  });
  for(const filter of filters) {
    const allowed=(filter.values||[]).map(String);
    const present=found.some((item)=>normalizeName(item.table)===normalizeName(filter.table)&&normalizeName(item.column)===normalizeName(filter.column)&&item.values.length>0&&item.values.every((value)=>allowed.includes(value)));
    if(!present)return denied(`缺少子类型 ${filter.object||filter.owner||"(未知)"} 的强制判别条件 ${filter.table}.${filter.column}`);
  }
  return {ok:true};
}

function validateColumns(statement,allowedColumns,forbiddenColumns,aliasContext,cte) {
  const allowedEntries=Object.entries(allowedColumns).map(([table,columns])=>[normalizeName(table),new Set(columns.map(normalizeName))]);
  if(!allowedEntries.length&&!forbiddenColumns.length) return {ok:true};
  const allowed=new Map(allowedEntries); const forbidden=new Set(forbiddenColumns.map((value)=>String(value).split(".").map(normalizeName).join(".")));
  const outputAliases=new Set();
  for(const select of collectSelects(statement)) for(const column of select.columns||[]) if(column.as) outputAliases.add(normalizeName(column.as));
  let failure=null;
  walkWithAncestors(statement,(node,ancestors)=>{
    if(failure||node.type!=="column_ref") return;
    let column=normalizeName(node.column);
    if(column==="*") {
      const countStar=ancestors.some((parent)=>parent.type==="aggr_func"&&String(parent.name||"").toLowerCase()==="count");
      if(!countStar) failure="禁止 SELECT *；必须显式选择字段";
      return;
    }
    let table=null;
    const scoped=resolvePhysicalInScope(node,ancestors,aliasContext,cte);
    if(scoped) {
      if(scoped.computed)return;
      table=scoped.table;column=scoped.column;
    } else if(node.table) {
      const resolved=resolvePhysical(node,aliasContext,cte);
      if(resolved?.computed) return; // CTE computed output — its inner expression was validated in the CTE body.
      if(resolved) { table=resolved.table;column=resolved.column; }
      else table=normalizeName(node.table);
    }
    if(!table&&!outputAliases.has(column)) {
      const candidates=allowedEntries.filter(([candidateTable,columns])=>aliasContext.physicalTables?.has(candidateTable)&&columns.has(column)).map(([candidateTable])=>candidateTable);
      if(candidates.length===1)table=candidates[0];
      else if(candidates.length>1){failure=`未限定表的字段 ${column} 同时属于多张表：${candidates.join("、")}；请使用表别名限定`;return;}
    }
    if(table&&forbidden.has(`${table}.${column}`)){failure=`禁止查询敏感字段 ${table}.${column}`;return;}
    if(table&&allowed.has(table)&&!allowed.get(table).has(column)&&!outputAliases.has(column)){failure=`字段不在白名单：${table}.${column}`;return;}
    if(table&&!allowed.has(table)&&!outputAliases.has(column)) return;
    if(!table&&!outputAliases.has(column)) failure=`字段不在当前查询表的白名单：${column}`;
  });
  return failure?denied(failure,{code:/同时属于多张表/.test(failure)?"AMBIGUOUS_COLUMN":"UNKNOWN_COLUMN"}):{ok:true};
}

function validateValueSemantics(statement,valueKinds,columnKinds,allowedColumns,aliasContext,cte) {
  if(!Array.isArray(valueKinds)||!valueKinds.length)return {ok:true};
  const normalizedKinds=new Map(Object.entries(columnKinds).map(([key,kind])=>[normalizeColumnKey(key),String(kind)]));
  let failure=null;
  walkWithAncestors(statement.where,(node,ancestors)=>{
    if(failure||node.type!=="binary_expr")return;
    const predicate=literalPredicate(node);
    if(!predicate)return;
    const key=resolveColumnKey(predicate.column,allowedColumns,aliasContext,cte,ancestors);
    if(!key)return;
    for(const literalNode of predicate.literals){const literal=filterLiteral(literalNode);if(!literal.valid)continue;const expected=valueKindFor(literal.value,valueKinds);if(expected&&normalizedKinds.get(key)!==expected){failure=`值格式识别为 ${kindLabel(expected)}，但过滤字段 ${key} 不是对应类型字段`;return;}}
  });
  return failure?denied(failure):{ok:true};
}

function literalPredicate(node) {
  if(node?.type!=="binary_expr")return null;
  const operator=String(node.operator||"").toUpperCase();
  if(operator==="=") {
    if(node.left?.type==="column_ref")return {operator,column:node.left,literals:[node.right]};
    if(node.right?.type==="column_ref")return {operator,column:node.right,literals:[node.left]};
  }
  if(operator==="IN"&&node.left?.type==="column_ref"&&node.right?.type==="expr_list")return {operator,column:node.left,literals:node.right.value||[]};
  return null;
}

function filterLiteral(node) {
  if(!node||typeof node!=="object")return {valid:false,value:null};
  if(["single_quote_string","double_quote_string","string"].includes(node.type))return {valid:String(node.value).length<=500,value:String(node.value)};
  if(node.type==="number"&&Number.isFinite(Number(node.value)))return {valid:true,value:Number(node.value)};
  if(node.type==="bool")return {valid:true,value:Boolean(node.value)};
  if(node.type==="null")return {valid:true,value:null};
  return {valid:false,value:null};
}

function resolveColumnKey(ref,allowedColumns,aliasContext,cte,ancestors=[]) {
  const resolved=resolvePhysicalInScope(ref,ancestors,aliasContext,cte);
  if(resolved&&!resolved.computed)return `${normalizeName(resolved.table)}.${normalizeName(resolved.column)}`;
  const column=normalizeName(ref?.column);
  if(!column||column==="*")return null;
  if(ref?.table)return `${normalizeName(ref.table)}.${column}`;
  const candidates=Object.entries(allowedColumns).filter(([,columns])=>(columns||[]).map(normalizeName).includes(column)).map(([table])=>`${normalizeName(table)}.${column}`);
  return candidates.length===1?candidates[0]:null;
}

function valueKindFor(value,hints) {
  const raw=String(value);
  for(const hint of hints){const kind=String(hint?.kind||"");if(!kind)continue;if(normalizeSensitiveValue(raw,kind)===normalizeSensitiveValue(hint?.value,kind))return kind;}
  return null;
}
function normalizeSensitiveValue(value,kind){const text=String(value??"").trim();if(kind==="email")return text.toLowerCase();if(["phone","china_id","bank_card"].includes(kind)){let compact=text.replace(/[\s()-]/g,"");if(kind==="phone")compact=compact.replace(/^\+?86/,"");return compact.toUpperCase();}return text;}
function kindLabel(kind){return {phone:"手机号",email:"邮箱",china_id:"身份证",bank_card:"银行卡"}[kind]||kind;}
function normalizeColumnKey(value){const [table,column]=String(value||"").split(".");return `${normalizeName(table)}.${normalizeName(column)}`;}

class EnumValidationError extends Error { constructor(column,values){super(`枚举字段 ${column} 使用了字典外取值：${values.join(", ")}`);this.name="EnumValidationError";this.code="ENUM_VALUE_INVALID";this.details={column,values};} }
class EnumOwnershipError extends Error { constructor(column,candidates){super(`未限定表的枚举字段 ${column} 无法唯一归属：${candidates.join("、")}`);this.name="EnumOwnershipError";this.code="ENUM_OWNERSHIP_AMBIGUOUS";this.details={column,candidates};} }

function subqueryOf(node) {
  if(!node) return null;
  if(node.ast?.type==="select") return node.ast;
  if(node.type==="expr_list"&&node.value?.length===1&&node.value[0]?.ast?.type==="select") return node.value[0].ast;
  return null;
}

function literalValue(node) { return ["string","single_quote_string","double_quote_string","number","bool","null"].includes(node?.type) ? node.value : null; }
function splitColumnKey(value){const parts=String(value||"").split(".");return [normalizeName(parts.at(-2)||""),normalizeName(parts.at(-1)||"")];}
function limitCount(limit){const node=limit?.value?.at(-1);return node?.type==="number"&&Number.isFinite(Number(node.value))?Number(node.value):null;}
function edgeKey(a,ac,b,bc){return `${normalizeName(a)}.${normalizeName(ac)}>${normalizeName(b)}.${normalizeName(bc)}`;}
function normalizeName(name=""){return String(name).replaceAll("`","").replaceAll("'","").replaceAll('"',"").replaceAll("[","").replaceAll("]","").split(".").at(-1).toLowerCase();}
function denied(reason, extra={}) { return { ok:false, code:extra.code||guardCode(reason),reason, ...extra }; }
function guardCode(reason){const text=String(reason||"");if(/枚举字段/.test(text))return "ENUM_VALUE_INVALID";if(/未确认/.test(text))return "UNCONFIRMED_RELATION";if(/白名单/.test(text))return "UNKNOWN_COLUMN";if(/禁止/.test(text))return "POLICY_VIOLATION";return "GUARD_REJECTED";}

function getTableNames(sql) {
  try { return [...new Set(parser.tableList(sql,{database:"MySQL"}).map((entry)=>entry.split("::").at(-1)).filter(Boolean))]; }
  catch { return []; }
}

function collectSelects(ast) {
  const selections=[];
  walk(ast,(node)=>{if(node.type==="select") selections.push(node);});
  return selections;
}

function collectJoinComparisons(node) {
  const comparisons=[];
  walk(node,(entry)=>{
    if(entry.type==="binary_expr" && entry.operator==="=" && entry.left?.type==="column_ref" && entry.right?.type==="column_ref" && entry.left.table && entry.right.table) comparisons.push({left:entry.left,right:entry.right});
  });
  return comparisons;
}

function collectFunctionNames(ast) {
  const names=[];
  walk(ast,(node)=>{
    if(node.type==="function" || node.type==="aggr_func") {
      const name=typeof node.name==="string"?node.name:node.name?.name?.[0]?.value || node.name?.value || "";
      if(name) names.push(String(name).toLowerCase());
    }
  });
  return [...new Set(names)];
}

function walk(value, visitor, seen=new Set()) {
  if (!value || typeof value!=="object" || seen.has(value)) return;
  seen.add(value); visitor(value);
  for (const child of Object.values(value)) if (child && typeof child==="object") walk(child,visitor,seen);
}

function walkWithAncestors(value,visitor,ancestors=[],seen=new Set()) {
  if(!value||typeof value!=="object"||seen.has(value))return;seen.add(value);visitor(value,ancestors);
  for(const child of Object.values(value))if(child&&typeof child==="object")walkWithAncestors(child,visitor,[...ancestors,value],seen);
}

export const _internal = { validateJoins, validateColumns, validateValueSemantics, collectJoinComparisons, collectFunctionNames, buildCteInfo, buildAliasContext };
