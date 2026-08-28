// Column comments in operational databases often carry the value dictionary the
// modeller never registered anywhere else: "数据来源 -1:未知 0:百度 1:腾讯 2:抖音".
// This module parses those mappings into *candidates*. A candidate never binds a
// query by itself — comments go stale and nobody reviews them — it only seeds a
// 枚举含义 disambiguation question whose human answer becomes meaning_source='human',
// the level the binding layer actually trusts. The system must ask for every
// confirmation it demands; before this module it demanded confirmations it had
// never asked anyone for.

const PAIR_PATTERN=/(-?\d+)\s*[:：、.．=-]\s*([^\s:：;；,，|/]{1,24})/g;

// A mapping is only credible when the comment is mostly mappings: a sentence that
// happens to contain "限额 5000:元" should not become a dictionary.
export function parseCommentEnumCandidates(comment) {
  const text=String(comment||"").trim();
  if(!text)return [];
  const seen=new Map();
  for(const [,value,meaning] of text.matchAll(PAIR_PATTERN)) {
    if(!seen.has(value))seen.set(value,meaning.trim());
  }
  if(seen.size<2)return [];
  const mappedChars=[...text.matchAll(PAIR_PATTERN)].reduce((sum,match)=>sum+match[0].length,0);
  if(mappedChars/text.length<0.3)return [];
  return [...seen].map(([value,meaning])=>({value,meaning}));
}

// Generates 枚举含义 questions for columns whose comment names meanings that were
// never confirmed. Deliberately scoped to columns the probe actually registered
// values for: a dictionary nobody queries is noise, and addQuestion dedupes by
// (table, column, enumValue) so re-running discovery never double-asks.
export function generateEnumMeaningQuestions(store,sourceId) {
  let created=0;
  for(const table of store.listTables(sourceId)) {
    const commentByColumn=new Map(store.listColumns(sourceId,table.tableName).map((column)=>[column.columnName,column.comment]));
    const registered=new Map();
    for(const item of store.listEnums(sourceId,table.tableName)) {
      (registered.get(item.columnName)??registered.set(item.columnName,new Map()).get(item.columnName)).set(String(item.value),item);
    }
    for(const [columnName,values] of registered) {
      const candidates=parseCommentEnumCandidates(commentByColumn.get(columnName));
      if(!candidates.length)continue;
      for(const candidate of candidates) {
        const row=values.get(candidate.value);
        if(!row)continue;                                   // value not observed in data
        if(String(row.meaning||"").trim())continue;         // already has a meaning
        store.addQuestion({
          sourceId,kind:"枚举含义",scope:"column",
          tableName:table.tableName,columnName,enumValue:candidate.value,
          question:`${table.tableName}.${columnName} 的取值 ${candidate.value} 是否表示“${candidate.meaning}”？`,
          evidence:`列注释声明：${String(commentByColumn.get(columnName)||"").slice(0,200)}。注释映射未经人工确认，不会用于查询取值绑定。`,
          options:[candidate.meaning,"补充说明"],
        });
        created++;
      }
    }
  }
  return {created};
}
