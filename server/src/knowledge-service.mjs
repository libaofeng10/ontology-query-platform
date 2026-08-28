import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const PAGE_TYPES = new Set(["term", "metric", "join", "rule"]);

export function createKnowledgeService({store,wikiDir,embeddingIndex}) {
  function rootFor(sourceId) { return join(wikiDir,`source-${Number(sourceId)}`); }

  function list(sourceId) {
    const custom=store.listKnowledge(sourceId);
    const pages=[...custom];
    const keys=new Set(custom.map((page)=>`${page.pageType}:${page.slug}`));
    for(const table of store.listTables(sourceId)) {
      if(table.grade==="C") continue;
      pushIfMissing(pages,keys,{id:`table:${table.tableName}`,sourceId,pageType:"table",slug:table.tableName,title:table.comment?`${table.tableName} · ${table.comment}`:table.tableName,aliases:[],tables:[table.tableName],content:table.comment||"数据库探查生成的表结构页面",sqlContent:null,antiExamples:null,verified:false,owner:null,verifiedAt:null,updatedAt:table.lastProbeAt,grade:table.grade});
    }
    for(const relation of store.listRelations(sourceId)) {
      const slug=`${relation.fromTable}-${relation.fromCol}-${relation.toTable}-${relation.toCol}`;
      pushIfMissing(pages,keys,{id:`join:${relation.id}`,sourceId,pageType:"join",slug,title:`${relation.fromTable}.${relation.fromCol} → ${relation.toTable}.${relation.toCol}`,aliases:[],tables:[relation.fromTable,relation.toTable],content:`${relation.cardinality} · 值域重叠 ${relation.overlapRatio==null?"待探针":`${(relation.overlapRatio*100).toFixed(2)}%`}`,sqlContent:`${relation.fromTable}.${relation.fromCol} = ${relation.toTable}.${relation.toCol}`,antiExamples:"N 侧聚合到实体时检查 DISTINCT。",verified:relation.status==="confirmed",owner:null,verifiedAt:null,updatedAt:null});
    }
    for(const rule of store.listRules(sourceId)) {
      const slug=slugify(rule.name);
      pushIfMissing(pages,keys,{id:`rule:${rule.id}`,sourceId,pageType:"rule",slug,title:rule.name,aliases:[],tables:splitAppliesTo(rule.appliesTo),content:"由消歧结果生成的全局业务规则",sqlContent:rule.content,antiExamples:null,verified:Boolean(rule.verified),owner:null,verifiedAt:null,updatedAt:null});
    }
    return pages.sort((a,b)=>typeRank(a.pageType)-typeRank(b.pageType)||Number(b.verified)-Number(a.verified)||a.title.localeCompare(b.title,"zh-CN"));
  }

  function get(sourceId,pageType,slug) { return list(sourceId).find((page)=>page.pageType===pageType&&page.slug===slug)||null; }

  async function save(sourceId,input) {
    const page=validatePage(sourceId,input);
    const root=rootFor(sourceId);
    const file=join(root,`${page.pageType}s`,`${page.slug}.md`);
    const markdown=renderPage(page);
    const checksum=createHash("sha256").update(markdown).digest("hex");
    await mkdir(dirname(file),{recursive:true});
    const temp=`${file}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temp,markdown,"utf8");
    await rename(temp,file);
    const saved=store.upsertKnowledge({...page,aliases:JSON.stringify(page.aliases),tablesJson:JSON.stringify(page.tables),contractJson:page.contract?JSON.stringify(page.contract):null,filePath:file,checksum});
    embeddingIndex?.ensurePageEmbedding(sourceId,saved).catch(()=>{});
    return saved;
  }

  async function remove(sourceId,pageType,slug) {
    const page=store.getKnowledge(sourceId,pageType,slug);
    if(!page) return false;
    if(page.filePath) { try{await unlink(page.filePath);}catch(error){if(error.code!=="ENOENT")throw error;} }
    embeddingIndex?.removePageEmbedding(sourceId,pageType,slug);
    return Boolean(store.deleteKnowledge(sourceId,pageType,slug));
  }

  async function sync(sourceId) {
    const root=rootFor(sourceId);const result={scanned:0,imported:0,unchanged:0,skipped:0,errors:[]};
    for(const pageType of PAGE_TYPES) {
      const directory=join(root,`${pageType}s`);let entries=[];try{entries=await readdir(directory,{withFileTypes:true});}catch(error){if(error.code==="ENOENT")continue;throw error;}
      for(const entry of entries.filter((item)=>item.isFile()&&item.name.endsWith(".md"))) {
        result.scanned++;const file=join(directory,entry.name);
        try {
          const markdown=await readFile(file,"utf8");const parsed=parseMarkdown(markdown,pageType,entry.name);
          if(!Object.hasOwn(parsed.meta,"owner")){result.skipped++;continue;}
          const input={...parsed,pageType,slug:entry.name.slice(0,-3),owner:parsed.meta.owner,verifiedAt:parsed.meta.verified_at};
          const page=validatePage(sourceId,input);const checksum=createHash("sha256").update(markdown).digest("hex");const existing=store.getKnowledge(sourceId,pageType,page.slug);
          if(existing?.checksum===checksum){result.unchanged++;continue;}
          store.upsertKnowledge({...page,aliases:JSON.stringify(page.aliases),tablesJson:JSON.stringify(page.tables),contractJson:page.contract?JSON.stringify(page.contract):null,filePath:file,checksum});result.imported++;
        } catch(error) { result.errors.push({file:entry.name,error:String(error.message||error)}); }
      }
    }
    return result;
  }

  return {list,get,save,remove,sync,rootFor};
}

function validatePage(sourceId,input) {
  const pageType=String(input.pageType||"");
  if(!PAGE_TYPES.has(pageType)) throw httpError(400,"pageType 只允许 term、metric、join、rule");
  const title=String(input.title||"").trim(); if(!title) throw httpError(400,"title 必填");
  const slug=slugify(input.slug||title); if(!slug) throw httpError(400,"无法生成合法 slug");
  const sqlContent=String(input.sqlContent||"").trim();
  if(!sqlContent) throw httpError(400,`${pageType} 页面必须提供 SQL 片段、ON 条件或参考 SQL`);
  const verified=Boolean(input.verified); const owner=String(input.owner||"").trim()||null;
  if(verified&&!owner) throw httpError(400,"verified 页面必须填写 owner");
  const contract=normalizeContract(input.contract);
  return {sourceId:Number(sourceId),pageType,slug,title,aliases:stringArray(input.aliases),tables:stringArray(input.tables),content:String(input.content||"").trim(),sqlContent:sqlContent||null,antiExamples:String(input.antiExamples||"").trim()||null,verified:verified?1:0,owner,verifiedAt:verified?(input.verifiedAt||new Date().toISOString()):null,...(contract?{contract}:{})};
}

function renderPage(page) {
  const sqlTitle=page.pageType==="metric"?"参考 SQL":"SQL 片段";
  return `---
type: ${page.pageType}
aliases: ${JSON.stringify(page.aliases)}
tables: ${JSON.stringify(page.tables)}
verified: ${Boolean(page.verified)}
owner: ${page.owner||""}
verified_at: ${page.verifiedAt||""}${page.contract?`\ncontract: ${JSON.stringify(page.contract)}`:""}
---

# ${page.title}

${page.content||"待补充业务定义。"}

## ${sqlTitle}
\`\`\`sql
${page.sqlContent||""}
\`\`\`

## 相关
${page.tables.map((table)=>`[[${table}]]`).join(" · ")||"待补充。"}

## 反例
${page.antiExamples||"待补充。"}
`;
}

function parseMarkdown(markdown,pageType,fileName) {
  const front=markdown.match(/^---\s*\n([\s\S]*?)\n---\s*\n/);if(!front)throw new Error("缺少 YAML frontmatter");
  const meta=Object.fromEntries(front[1].split(/\r?\n/).map((line)=>{const index=line.indexOf(":");return index<0?[line.trim(),""]:[line.slice(0,index).trim(),line.slice(index+1).trim()];}).filter(([key])=>key));
  if(meta.type&&meta.type!==pageType)throw new Error(`页面类型与目录不一致：${meta.type}`);
  const body=markdown.slice(front[0].length);const title=body.match(/^#\s+(.+)$/m)?.[1]?.trim();if(!title)throw new Error("缺少一级标题");
  const content=(body.split(/^##\s+/m)[0].replace(/^#\s+.+$/m,"").trim());const sqlContent=body.match(/^##\s+(?:SQL 片段|参考 SQL|ON 条件)[^\n]*\n```sql\s*\n([\s\S]*?)\n```/m)?.[1]?.trim()||"";const antiExamples=body.match(/^##\s+反例[^\n]*\n([\s\S]*?)(?=^##\s+|$)/m)?.[1]?.trim()||"";
  return {meta,title,content,sqlContent,antiExamples,aliases:parseArray(meta.aliases),tables:parseArray(meta.tables),verified:/^true$/i.test(meta.verified||"false"),owner:meta.owner||"",contract:parseContract(meta.contract),fileName};
}

function parseArray(value) { if(!value)return [];try{const parsed=JSON.parse(value);return stringArray(parsed);}catch{return stringArray(value.replace(/^\[/,"").replace(/\]$/,"").replaceAll('"',""));} }

// The machine-readable half of a page. Prose stays for human readers; anything the
// harness must enforce is declared here so it never depends on parsing sentences.
// Unknown keys are dropped rather than stored, so a typo cannot silently become a
// contract the harness later trusts.
const CONTRACT_KEYS=["timeRole","periodColumn","grain"];
function normalizeContract(value) {
  if(value==null)return null;
  if(typeof value!=="object"||Array.isArray(value))throw httpError(400,"contract 必须是对象");
  const result={};
  for(const key of CONTRACT_KEYS) {
    if(value[key]==null)continue;
    const text=String(value[key]).trim();
    if(text)result[key]=key==="periodColumn"?text:text.toLowerCase();
  }
  if(result.periodColumn&&!/^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/.test(result.periodColumn))throw httpError(400,"contract.periodColumn 必须是 表名.列名 形式");
  return Object.keys(result).length?result:null;
}
function parseContract(value) { if(!value)return null;try{return normalizeContract(JSON.parse(value));}catch{return null;} }

function pushIfMissing(pages,keys,page){const key=`${page.pageType}:${page.slug}`;if(!keys.has(key)){keys.add(key);pages.push(page);}}
function slugify(value){return String(value).trim().replace(/[\\/:*?"<>|]/g,"-").replace(/\s+/g,"-").slice(0,120);}
function stringArray(value){return Array.isArray(value)?[...new Set(value.map(String).map((item)=>item.trim()).filter(Boolean))]:String(value||"").split(/[,，]/).map((item)=>item.trim()).filter(Boolean);}
function splitAppliesTo(value){return String(value||"").split(/[,，]/).map((item)=>item.trim()).filter(Boolean);}
function typeRank(type){return ({term:1,metric:2,rule:3,join:4,table:5})[type]||9;}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
