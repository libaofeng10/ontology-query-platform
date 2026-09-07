export async function introspectSchema(connector, source) {
  const [tables] = await connector.query(source, `SELECT TABLE_NAME AS tableName, TABLE_ROWS AS rowEstimate, TABLE_COMMENT AS comment, UPDATE_TIME AS updateTime
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [source.dbName]);
  const [columns] = await connector.query(source, `SELECT c.TABLE_NAME AS tableName,c.COLUMN_NAME AS columnName,c.COLUMN_TYPE AS dataType,c.IS_NULLABLE AS nullable,c.COLUMN_COMMENT AS comment,
    CASE WHEN c.COLUMN_KEY='PRI' AND COALESCE(i.is_single_primary,0)=1 THEN 1 ELSE 0 END AS isPrimary,
    CASE WHEN COALESCE(i.is_unique,0)=1 THEN 1 ELSE 0 END AS isUnique,
    CASE WHEN COALESCE(i.is_indexed,0)=1 THEN 1 ELSE 0 END AS isIndexed,i.key_constraints AS keyConstraints
    FROM information_schema.COLUMNS c
    LEFT JOIN (
      SELECT s.TABLE_SCHEMA,s.TABLE_NAME,s.COLUMN_NAME,
        MAX(CASE WHEN s.NON_UNIQUE=0 AND k.column_count=1 THEN 1 ELSE 0 END) AS is_unique,
        MAX(CASE WHEN s.INDEX_NAME='PRIMARY' AND k.column_count=1 THEN 1 ELSE 0 END) AS is_single_primary,1 AS is_indexed,
        JSON_ARRAYAGG(JSON_OBJECT('name',s.INDEX_NAME,'unique',s.NON_UNIQUE=0,'members',k.members)) AS key_constraints
      FROM information_schema.STATISTICS s JOIN (
        SELECT TABLE_SCHEMA,TABLE_NAME,INDEX_NAME,COUNT(*) AS column_count,
          JSON_ARRAYAGG(JSON_OBJECT('column',COLUMN_NAME,'ordinal',SEQ_IN_INDEX)) AS members
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? GROUP BY TABLE_SCHEMA,TABLE_NAME,INDEX_NAME
      ) k ON k.TABLE_SCHEMA=s.TABLE_SCHEMA AND k.TABLE_NAME=s.TABLE_NAME AND k.INDEX_NAME=s.INDEX_NAME
      GROUP BY s.TABLE_SCHEMA,s.TABLE_NAME,s.COLUMN_NAME
    ) i ON i.TABLE_SCHEMA=c.TABLE_SCHEMA AND i.TABLE_NAME=c.TABLE_NAME AND i.COLUMN_NAME=c.COLUMN_NAME
    WHERE c.TABLE_SCHEMA=? ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION`, [source.dbName,source.dbName]);
  const [foreignKeyColumns] = await connector.query(source, `SELECT TABLE_NAME AS fromTable,COLUMN_NAME AS fromCol,REFERENCED_TABLE_NAME AS toTable,REFERENCED_COLUMN_NAME AS toCol,CONSTRAINT_NAME AS constraintName,ORDINAL_POSITION AS ordinalPosition
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_SCHEMA=TABLE_SCHEMA AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME,CONSTRAINT_NAME,ORDINAL_POSITION`, [source.dbName]);
  const grouped=new Map();
  for(const row of foreignKeyColumns){const key=JSON.stringify([row.fromTable,row.toTable,row.constraintName||`${row.fromCol}:${row.toCol}`]);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}
  const foreignKeys=[...grouped.values()].map(rows=>{rows.sort((a,b)=>(a.ordinalPosition||0)-(b.ordinalPosition||0));return {...rows[0],columnPairs:rows.map(({fromCol,toCol})=>({fromCol,toCol}))};});
  const normalizedColumns=columns.map(column=>{
    const constraints=typeof column.keyConstraints==="string"?JSON.parse(column.keyConstraints):column.keyConstraints||[];
    const keyConstraints=constraints.map(key=>({...key,unique:Boolean(Number(key.unique)),members:(typeof key.members==="string"?JSON.parse(key.members):key.members||[]).sort((a,b)=>a.ordinal-b.ordinal)})).sort((a,b)=>a.name.localeCompare(b.name));
    const scalar=keyConstraints.filter(key=>key.unique&&key.members.length===1&&key.members[0].column===column.columnName);
    return {...column,keyConstraints,...(column.keyConstraints!=null?{isPrimary:Number(scalar.some(key=>key.name==="PRIMARY")),isUnique:Number(scalar.length>0)}:{})};
  });
  for(const relation of foreignKeys){
    const sourceColumns=normalizedColumns.filter(column=>column.tableName===relation.fromTable),pairNames=relation.columnPairs.map(pair=>pair.fromCol).sort();
    const uniqueTuple=sourceColumns.some(column=>column.keyConstraints.some(key=>key.unique&&JSON.stringify(key.members.map(member=>member.column).sort())===JSON.stringify(pairNames)));
    const scalarUnique=pairNames.length===1&&sourceColumns.some(column=>column.columnName===pairNames[0]&&(column.isPrimary||column.isUnique));
    relation.cardinality=uniqueTuple||scalarUnique?"1:1":"N:1";
  }
  return { tables, columns:normalizedColumns, foreignKeys };
}
