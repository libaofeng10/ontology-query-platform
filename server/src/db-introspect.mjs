export async function introspectSchema(connector, source) {
  const [tables] = await connector.query(source, `SELECT TABLE_NAME AS tableName, TABLE_ROWS AS rowEstimate, TABLE_COMMENT AS comment, UPDATE_TIME AS updateTime
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, [source.dbName]);
  const [columns] = await connector.query(source, `SELECT c.TABLE_NAME AS tableName,c.COLUMN_NAME AS columnName,c.COLUMN_TYPE AS dataType,c.IS_NULLABLE AS nullable,c.COLUMN_COMMENT AS comment,
    CASE WHEN c.COLUMN_KEY='PRI' THEN 1 ELSE 0 END AS isPrimary,
    CASE WHEN COALESCE(i.is_unique,0)=1 THEN 1 ELSE 0 END AS isUnique,
    CASE WHEN COALESCE(i.is_indexed,0)=1 THEN 1 ELSE 0 END AS isIndexed
    FROM information_schema.COLUMNS c
    LEFT JOIN (
      SELECT TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME,MAX(CASE WHEN NON_UNIQUE=0 THEN 1 ELSE 0 END) AS is_unique,1 AS is_indexed
      FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? GROUP BY TABLE_SCHEMA,TABLE_NAME,COLUMN_NAME
    ) i ON i.TABLE_SCHEMA=c.TABLE_SCHEMA AND i.TABLE_NAME=c.TABLE_NAME AND i.COLUMN_NAME=c.COLUMN_NAME
    WHERE c.TABLE_SCHEMA=? ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION`, [source.dbName,source.dbName]);
  const [foreignKeys] = await connector.query(source, `SELECT TABLE_NAME AS fromTable,COLUMN_NAME AS fromCol,REFERENCED_TABLE_NAME AS toTable,REFERENCED_COLUMN_NAME AS toCol
    FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL`, [source.dbName]);
  return { tables, columns, foreignKeys };
}
