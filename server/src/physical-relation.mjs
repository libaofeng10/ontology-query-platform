export function relationPairs(relation) {
  const pairs=relation.columnPairs??[{fromCol:relation.fromCol,toCol:relation.toCol}];
  if(!Array.isArray(pairs)||!pairs.length||pairs.some(pair=>!validColumn(pair?.fromCol)||!validColumn(pair?.toCol)))throw new Error("物理关系必须包含完整、有效的列等式组");
  if(new Set(pairs.map(pair=>JSON.stringify([pair.fromCol,pair.toCol]))).size!==pairs.length)throw new Error("物理关系列等式重复");
  return pairs.map(({fromCol,toCol})=>({fromCol,toCol}));
}
export function relationKey(relation) {
  const pairs=relationPairs(relation);
  if(pairs.length===1)return `${relation.fromTable}.${pairs[0].fromCol}>${relation.toTable}.${pairs[0].toCol}`;
  return JSON.stringify([relation.fromTable,relation.toTable,pairs.map(pair=>[pair.fromCol,pair.toCol]).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))]);
}
export function reverseRelation(relation){const columnPairs=relationPairs(relation).map(pair=>({fromCol:pair.toCol,toCol:pair.fromCol}));return {...relation,fromTable:relation.toTable,toTable:relation.fromTable,...columnPairs[0],columnPairs};}
export function formatRelation(relation){return relationPairs(relation).map(pair=>`${relation.fromTable}.${pair.fromCol} = ${relation.toTable}.${pair.toCol}`).join(" AND ");}
export function relationColumnsPresent(relation,columns){return relationPairs(relation).every(pair=>columns.has(`${relation.fromTable}.${pair.fromCol}`)&&columns.has(`${relation.toTable}.${pair.toCol}`));}
function validColumn(value){return typeof value==="string"&&value.length>0&&value.length<=64&&!/[\0\r\n]/.test(value);}

export function relationSlug(relation){return relationPairs(relation).length===1?`${relation.fromTable}-${relation.fromCol}-${relation.toTable}-${relation.toCol}`:`relation-${relation.id}`;}
