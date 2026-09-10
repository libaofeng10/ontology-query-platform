import assert from "node:assert/strict";
import test from "node:test";
import { validateSemanticSchema } from "../src/semantic-schema.mjs";
import { buildObjectGenerationScope, normalizeObjectCandidateOutput } from "../src/ontology-candidate-generator.mjs";

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
