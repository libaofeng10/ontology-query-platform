import { createHash } from "node:crypto";
import { evalSetChecksum, inspectSemanticEvalGate } from "./evaluation-evidence.mjs";
import { validateSemanticSchema } from "./semantic-schema.mjs";
import { analyzeSemanticSchemaImpact } from "./semantic-schema-impact.mjs";
import { hasSemanticHierarchyChanges, semanticSubtypeNames } from "./semantic-schema-diff.mjs";

export function createSemanticSchemaService({store}) {
  function catalog(sourceId) {
    const tables=store.listTables(sourceId);
    const columnsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listColumns(sourceId,table.tableName)]));
    const relations=store.listRelations(sourceId,false,true);
    const knowledgePages=(store.listKnowledge?.(sourceId)||[]).filter((page)=>page.verified);
    const enumsByTable=Object.fromEntries(tables.map((table)=>[table.tableName,store.listEnums(sourceId,table.tableName)]));
    const enums={};
    for(const [tableName,items] of Object.entries(enumsByTable))for(const item of items){if(item.value==="null")continue;(enums[`${tableName}.${item.columnName}`]??=[]).push(item.value);}
    const termAnchors=store.listTermAnchors?.()||[];
    return {tables,columnsByTable,relations,knowledgePages,enums,enumsByTable,termAnchors};
  }

  function validate(sourceId,schema) {
    return validateSemanticSchema(schema,catalog(sourceId));
  }

  function saveDraft(sourceId,schema,userName) {
    const validation=validate(sourceId,schema);
    const content=JSON.stringify(validation.schema);
    const record=store.createOntologySchemaVersion({
      sourceId,
      schemaName:validation.schema.name||`source_${sourceId}`,
      schema:validation.schema,
      checksum:createHash("sha256").update(content).digest("hex"),
      validation:withoutSchema(validation),
      createdBy:userName,
    });
    return {...record,validation:withoutSchema(validation)};
  }

  function publish(id,userName) {
    const record=store.getOntologySchemaVersion(id);
    if(!record) return null;
    if(record.status!=="draft") { const error=new Error("只有草稿版本可以执行普通发布；历史发布版请使用回滚操作");error.status=409;throw error; }
    const validation=validate(record.sourceId,record.schema);
    const compact=withoutSchema(validation);
    store.updateOntologySchemaValidation(record.id,compact);
    if(!validation.ok) return {ok:false,record:store.getOntologySchemaVersion(record.id),...compact};
    const current=store.getPublishedOntologySchema(record.sourceId);
    if(current) {
      const cases=store.listEvalCasesForImpact(record.sourceId);
      const impact=analyzeSemanticSchemaImpact(record.schema,current.schema,{cases,relations:catalog(record.sourceId).relations});
      if(impact.summary.requiresEvaluation) {
        const validGates=[];
        const missingSets=impact.affectedSets.filter((setName)=>{
          const setCases=cases.filter((item)=>item.setName===setName);
          const gate=store.findPassedEvalGate(record.sourceId,setName,record.version,evalSetChecksum(setCases));
          const valid=inspectSemanticEvalGate(gate,{sourceId:record.sourceId,schemaVersion:record.version,cases:setCases}).valid;
          if(valid)validGates.push(gate);
          return !valid;
        });
        const hierarchyChanged=hasSemanticHierarchyChanges(record.schema,current.schema);
        const subtypeNames=new Set(semanticSubtypeNames(record.schema));
        const subtypeRootCoverage=validGates.flatMap((gate)=>gate.candidate?.subtypeRootObjects||[]).filter((name,index,items)=>subtypeNames.has(name)&&items.indexOf(name)===index);
        const subtypeRootCoverageMissing=hierarchyChanged&&!subtypeRootCoverage.length;
        if(impact.uncoveredChanges.length||missingSets.length||subtypeRootCoverageMissing) return {...compact,ok:false,gateRequired:true,record:store.getOntologySchemaVersion(record.id),evaluationImpact:{summary:{...impact.summary,hierarchyChanged,subtypeRootCoverageMissing},affectedCases:impact.affectedCases,affectedSets:impact.affectedSets,uncoveredChanges:impact.uncoveredChanges,missingSets,subtypeRootCoverage}};
      }
    }
    const published=store.publishOntologySchemaVersion(record.id,userName);
    return {ok:true,record:published,...compact};
  }

  function rollback(id,userName) {
    const record=store.getOntologySchemaVersion(id);
    if(!record) return null;
    if(record.status!=="deprecated") { const error=new Error("只有已废弃的历史发布版本可以回滚");error.status=409;throw error; }
    const current=store.getPublishedOntologySchema(record.sourceId);
    if(!current) { const error=new Error("当前没有发布版本，应该使用普通发布操作");error.status=409;throw error; }
    const validation=validate(record.sourceId,record.schema);
    const compact=withoutSchema(validation);
    store.updateOntologySchemaValidation(record.id,compact);
    if(!validation.ok) return {ok:false,record:store.getOntologySchemaVersion(record.id),...compact};
    const published=store.publishOntologySchemaVersion(record.id,userName,"rollback");
    return {ok:true,record:published,rolledBackFrom:current.version,...compact};
  }

  return {
    validate,
    catalog,
    saveDraft,
    publish,
    rollback,
    list:(sourceId)=>store.listOntologySchemaVersions(sourceId),
    get:(id)=>store.getOntologySchemaVersion(id),
    getPublished:(sourceId)=>store.getPublishedOntologySchema(sourceId),
  };
}

function withoutSchema(validation) {
  return {ok:validation.ok,errors:validation.errors,warnings:validation.warnings,summary:validation.summary};
}
