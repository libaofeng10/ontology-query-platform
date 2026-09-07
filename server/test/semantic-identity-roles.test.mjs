import assert from "node:assert/strict";
import test from "node:test";
import { validateSemanticSchema } from "../src/semantic-schema.mjs";
import { compileSemanticQueryPlan, validateSemanticQueryPlan } from "../src/semantic-query-plan.mjs";
import { buildObjectGenerationScope, normalizeObjectCandidateOutput } from "../src/ontology-candidate-generator.mjs";
import { guardSql } from "../src/sql-guard.mjs";
import { queryResultContractValidation } from "../src/query-scope-coverage.mjs";

const key={name:"PRIMARY",unique:true,members:[{column:"tenant",ordinal:1},{column:"id",ordinal:2}]};
const properties=["tenant","id","manager_id","name"].map(apiName=>({apiName,displayName:apiName,type:apiName==="name"?"string":"integer",required:true,mapping:{table:"staff",column:apiName}}));
const schema={name:"people",displayName:"人员",objectTypes:[{apiName:"employee",displayName:"员工",primaryKey:["tenant","id"],properties}],linkTypes:[{apiName:"reports_to",inverseApiName:"manages",source:"employee",target:"employee",cardinality:"many_to_one",relationMappings:[{relationId:1}]}]};
const catalog={tables:[{tableName:"staff",active:1,grade:"A"}],columnsByTable:{staff:properties.map(property=>({tableName:"staff",columnName:property.apiName,dataType:property.type==="string"?"varchar":"bigint",nullable:0,keyConstraints:["tenant","id"].includes(property.apiName)?[key]:[]}))},relations:[{id:1,fromTable:"staff",fromCol:"tenant",toTable:"staff",toCol:"tenant",columnPairs:[{fromCol:"tenant",toCol:"tenant"},{fromCol:"manager_id",toCol:"id"}],status:"confirmed",cardinality:"N:1"}]};

test("composite object keys validate all members and generator restores omitted key properties",()=>{
  const validation=validateSemanticSchema(schema,catalog);assert.equal(validation.ok,true,JSON.stringify(validation.errors));
  for(const primaryKey of ["id",["tenant","tenant"],["tenant","manager_id"]])assert.equal(validateSemanticSchema({...schema,objectTypes:[{...schema.objectTypes[0],primaryKey}]},catalog).ok,false);
  const scope=buildObjectGenerationScope({catalog,tableNames:["staff"]});
  const result=normalizeObjectCandidateOutput({candidates:[{tableName:"staff",apiName:"employee",properties:[{column:"name"}]}]},{run:{id:"run",scope:{namespace:"hr"}},batch:scope.batches[0],catalog});
  assert.deepEqual(result.candidates[0].payload.primaryKey,["tenant","id"]);
  assert.equal(validateSemanticSchema({...schema,objectTypes:[result.candidates[0].payload]},catalog).ok,true);
});

test("explicit tuple distinct count uses native multi-column equality without concatenation collisions",()=>{
  const compiled=compileSemanticQueryPlan({rootObject:"employee",metrics:[{aggregation:"count_distinct",properties:["employee.tenant","employee.id"],alias:"employees"}]},{schema,catalog});
  assert.match(compiled.sql,/COUNT\(DISTINCT t0\.`tenant`, t0\.`id`\)/);
  assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
});

test("self-reference roles bind employee and manager to separate instances with the entire tuple",()=>{
  const plan={rootObject:"employee",roles:[{name:"manager",from:"employee",link:"reports_to",direction:"forward"}],dimensions:[{property:"employee.name",alias:"employee_name"},{property:"manager.name",alias:"manager_name"}]};
  assert.equal(validateSemanticQueryPlan(plan,schema).ok,true);
  const compiled=compileSemanticQueryPlan(plan,{schema,catalog});
  assert.match(compiled.sql,/t0\.`name` AS `employee_name`/);assert.match(compiled.sql,/t1\.`name` AS `manager_name`/);
  assert.match(compiled.sql,/JOIN `staff` AS t1 ON t0\.`tenant` = t1\.`tenant` AND t0\.`manager_id` = t1\.`id`/);
  assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
  assert.equal(validateSemanticQueryPlan({...plan,roles:[{name:"manager",from:"employee",link:"invented"}]},schema).ok,false);
});

test("inverse and chained roles retain separate instances and cannot omit a compound predicate",()=>{
  const forward={rootObject:"employee",roles:[{name:"manager",from:"employee",link:"reports_to"},{name:"director",from:"manager",link:"reports_to"}],dimensions:[{property:"director.name",alias:"director_name"}]};
  const compiled=compileSemanticQueryPlan(forward,{schema,catalog});assert.match(compiled.sql,/t2\.`name`/);assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
  const partial=compiled.sql.replace("t1.`tenant` = t2.`tenant` AND ","");assert.equal(guardSql(partial,compiled.policy).ok,false);
  const inverse=compileSemanticQueryPlan({rootObject:"employee",roles:[{name:"report",from:"employee",link:"manages"}],dimensions:["report.name"]},{schema,catalog});
  assert.match(inverse.sql,/t1\.`manager_id` = t0\.`id`/);
  assert.equal(validateSemanticQueryPlan({...forward,roles:[{name:"employee",from:"employee",link:"reports_to"}]},schema).ok,false);
});

test("subtype row-domain evidence binds each role independently in both guard and result contract",()=>{
  const kind={apiName:"kind",type:"enum",constraints:{enumValues:["senior","junior"]},mapping:{table:"staff",column:"kind"}};
  const subSchema={...schema,objectTypes:[{...schema.objectTypes[0],properties:[...properties,kind]},{apiName:"senior",parent:"employee",discriminator:{property:"kind",values:["senior"]},properties:[]}],linkTypes:[{...schema.linkTypes[0],source:"senior",target:"senior"}]};
  const subCatalog={...catalog,columnsByTable:{staff:[...catalog.columnsByTable.staff,{columnName:"kind",dataType:"varchar"}]}};
  const compiled=compileSemanticQueryPlan({rootObject:"senior",roles:[{name:"manager",from:"senior",link:"reports_to"}],dimensions:["senior.name",{property:"manager.name",alias:"manager_name"}]},{schema:subSchema,catalog:subCatalog,ontologySchemaVersion:12});
  assert.equal(compiled.semanticContract.rowDomainSlots.length,2);assert.equal(guardSql(compiled.sql,compiled.policy).ok,true);
  const intent={version:"query-intent-test",shape:{kind:"detail",direction:null,requestedLimit:null},requirements:[],filters:[],ambiguities:[]};
  const check=sql=>{const verdict=guardSql(sql,{...compiled.policy,mandatoryFilters:[]});assert.equal(verdict.ok,true,verdict.reason);return queryResultContractValidation(intent,verdict.sql,{usedTables:verdict.tables,verdict,columnsByTable:subCatalog.columnsByTable,semanticContract:compiled.semanticContract});};
  assert.equal(check(compiled.sql).ok,true,JSON.stringify(check(compiled.sql).errors));
  const missing=compiled.sql.replace(/t0\.`kind` = 'senior' AND /,"").replace(/ AND t0\.`kind` = 'senior'/,"");
  assert.equal(guardSql(missing,compiled.policy).ok,false);assert.equal(check(missing).ok,false);
});
