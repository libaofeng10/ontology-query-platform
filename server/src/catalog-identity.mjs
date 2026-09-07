// Physical keys are sets of columns; ordinal order is retained for generated identities.
export function uniqueColumnSets(columns) {
  const available=new Set(columns.map(column=>column.columnName)),keys=new Map();
  for(const column of columns){
    if(column.isPrimary||column.isUnique)keys.set(column.columnName,[column.columnName]);
    for(const constraint of column.keyConstraints||[]){
      if(!constraint.unique||!Array.isArray(constraint.members))continue;
      const members=[...constraint.members].sort((a,b)=>a.ordinal-b.ordinal).map(item=>item.column);
      if(members.length&&new Set(members).size===members.length&&members.every(name=>available.has(name)))keys.set([...members].sort().join("\0"),members);
    }
  }
  return [...keys.values()];
}

export function columnsAreUnique(columns,names) {
  return uniqueColumnSets(columns).some(key=>key.every(name=>names.includes(name)));
}

export function primaryKeyProperties(value) {
  return Array.isArray(value)?value:typeof value==="string"&&value?[value]:[];
}

export function canonicalPrimaryKey(value) {
  const names=primaryKeyProperties(value).map(name=>String(name).trim());
  return names.length===1?names[0]:names.length?names:"";
}
