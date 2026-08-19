export function assertLosslessOntologyDraft(inputSchema,validation) {
  const input=counts(inputSchema);const output=counts(validation?.schema);
  const limitErrors=(validation?.errors||[]).filter((issue)=>issue?.code==="ONTOLOGY_LIMIT_EXCEEDED");
  if(limitErrors.length||input.objects!==output.objects||input.properties!==output.properties||input.links!==output.links) {
    const detail=limitErrors.map((issue)=>issue.message).filter(Boolean).join("；")||`聚合前 ${input.objects} 对象/${input.properties} 属性/${input.links} 关系，校验后变为 ${output.objects} 对象/${output.properties} 属性/${output.links} 关系`;
    const error=new Error(`Schema 容量校验会造成定义丢失，已阻止生成草稿：${detail}`);
    error.status=422;error.code="ONTOLOGY_DRAFT_LOSSY_NORMALIZATION";error.validation=validation;
    throw error;
  }
  return {input,output};
}

export function ontologySchemaCounts(schema) { return counts(schema); }

function counts(schema) {
  const objects=Array.isArray(schema?.objectTypes)?schema.objectTypes:[];
  const links=Array.isArray(schema?.linkTypes)?schema.linkTypes:[];
  return {objects:objects.length,properties:objects.reduce((sum,object)=>sum+(Array.isArray(object?.properties)?object.properties.length:0),0),links:links.length};
}
