import { columnsAreUnique, uniqueColumnSets } from "./catalog-identity.mjs";
import { relationPairs, reverseRelation } from "./physical-relation.mjs";

// Co-occurrence alone is not a business relation. Only a bridge whose complete
// endpoint pair is constrained unique can seed this derived Link proposal.
export function findBridgeRelationPaths(catalog,{maxPaths=100}={}){
  const groups=new Map();
  for(const relation of (catalog.relations||[]).filter(item=>["confirmed","accepted"].includes(item.status))){
    if(relation.fromTable===relation.toTable)continue;
    for(const edge of [relation,reverseRelation(relation)]){
      const source=catalog.columnsByTable?.[edge.fromTable]||[],target=catalog.columnsByTable?.[edge.toTable]||[],pairs=relationPairs(edge);
      if(!pairs.every(pair=>source.some(column=>column.columnName===pair.fromCol)&&target.some(column=>column.columnName===pair.toCol))||!columnsAreUnique(target,pairs.map(pair=>pair.toCol)))continue;
      const group=groups.get(edge.fromTable)||[];group.push({relation,edge});groups.set(edge.fromTable,group);
    }
  }
  const paths=[];
  for(const [bridgeTable,group] of groups){
    group.sort((a,b)=>a.relation.id-b.relation.id);
    const columns=catalog.columnsByTable[bridgeTable],keys=uniqueColumnSets(columns);
    for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){
      const left=group[i],right=group[j],leftCols=relationPairs(left.edge).map(pair=>pair.fromCol),rightCols=relationPairs(right.edge).map(pair=>pair.fromCol);
      const joined=[...new Set([...leftCols,...rightCols])];
      if(left.relation.id===right.relation.id||leftCols.every(name=>rightCols.includes(name))&&rightCols.every(name=>leftCols.includes(name)))continue;
      if(!keys.some(key=>key.length===joined.length&&key.every(name=>joined.includes(name)))||columns.some(column=>joined.includes(column.columnName)&&(column.nullable===1||column.nullable==="YES")))continue;
      const leftOne=columnsAreUnique(columns,leftCols),rightOne=columnsAreUnique(columns,rightCols);
      const cardinality=leftOne?(rightOne?"one_to_one":"many_to_one"):(rightOne?"one_to_many":"many_to_many");
      paths.push({pathId:`bridge:${bridgeTable}:${left.relation.id}>${right.relation.id}`,bridgeTable,fromTable:left.edge.toTable,toTable:right.edge.toTable,relationIds:[left.relation.id,right.relation.id],relations:[left.relation,right.relation],cardinality});
      if(paths.length>maxPaths){paths.pop();Object.defineProperty(paths,"truncated",{value:true});return paths;}
    }
  }
  return paths;
}

export function linkPathIdentity(link){
  const ids=(link.relationMappings||[]).map(item=>Number(item.relationId??item));
  if(ids.length===1)return `relation:${ids[0]}`;
  return [JSON.stringify([link.source,ids,link.target]),JSON.stringify([link.target,[...ids].reverse(),link.source])].sort()[0];
}

export function missingBridgePaths(paths,links){
  const signatures=new Set(links.map(link=>(link.relationMappings||[]).map(item=>Number(item.relationId??item)).sort((a,b)=>a-b).join(",")));
  return paths.filter(path=>!signatures.has([...path.relationIds].sort((a,b)=>a-b).join(",")));
}
