// Resolve every mapped relation into one continuous, ordered path. This never
// selects a convenient subset of the Link's constraints.
export function orientRelationPath(relations,sourceTables,targetTables,{reverse=false}={}) {
  if(!relations.length||relations.length>8)return null;
  const ordered=reverse?[...relations].reverse():relations;
  const target=new Set(targetTables);
  function walk(table,remaining,path){
    if(!remaining.length)return target.has(table)?path:null;
    for(const [index,relation] of remaining.entries()){
      const options=[];
      if(relation.fromTable===table)options.push({relation,fromTable:table,toTable:relation.toTable,reversed:false});
      if(relation.toTable===table)options.push({relation,fromTable:table,toTable:relation.fromTable,reversed:true});
      if(reverse)options.reverse();
      for(const step of options){const result=walk(step.toTable,remaining.filter((_,i)=>i!==index),[...path,step]);if(result)return result;}
    }
    return null;
  }
  for(const table of sourceTables){const result=walk(table,ordered,[]);if(result)return result;}
  return null;
}
