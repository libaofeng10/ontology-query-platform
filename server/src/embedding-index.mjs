import { createHash } from "node:crypto";
import { callLlmEmbedding, isEmbeddingConfigured } from "./embedding-client.mjs";

const BATCH_SIZE=16;

export function createEmbeddingIndex({store,settings,fetchImpl}={}) {
  const embeddingConfig=()=>settings.config.embedding;
  const enabled=()=>Boolean(settings.config.retrieval?.vectorEnabled)&&isEmbeddingConfigured(embeddingConfig());

  async function embed(texts) {
    return callLlmEmbedding(embeddingConfig(),texts,{fetchImpl:fetchImpl||globalThis.fetch});
  }

  async function ensurePageEmbedding(sourceId,page) {
    if(!enabled()||!page?.slug) return;
    const refKey=pageRefKey(page);
    const text=pageText(page);
    const textHash=hash(text);
    const existing=store.getEmbedding(sourceId,"page",refKey);
    if(existing&&existing.textHash===textHash&&existing.model===embeddingConfig().model) return;
    const [vector]=await embed([text]);
    store.upsertEmbedding({sourceId,kind:"page",refKey,model:embeddingConfig().model,dims:vector.length,textHash,vectorJson:JSON.stringify(normalize(vector))});
  }

  function removePageEmbedding(sourceId,pageType,slug) { store.deleteEmbedding(sourceId,"page",`${pageType}:${slug}`); }

  async function reindex(sourceId,{onProgress}={}) {
    if(!isEmbeddingConfigured(embeddingConfig())) throw new Error("Embedding 未配置，无法重建向量索引");
    const model=embeddingConfig().model;
    const pages=store.listKnowledge(sourceId);
    const tables=store.listTables(sourceId).filter((table)=>table.grade!=="C"&&table.active);
    const jobs=[
      ...pages.map((page)=>({kind:"page",refKey:pageRefKey(page),text:pageText(page)})),
      ...tables.map((table)=>({kind:"table",refKey:table.tableName,text:tableText(table,store.listColumns(sourceId,table.tableName))})),
    ];
    const total=jobs.length;
    let indexed=0,skipped=0,failed=0,done=0;
    const pending=[];
    for(const job of jobs) {
      const textHash=hash(job.text);
      const existing=store.getEmbedding(sourceId,job.kind,job.refKey);
      if(existing&&existing.textHash===textHash&&existing.model===model) { skipped++;done++;onProgress?.({done,total,currentStep:`跳过 ${job.refKey}`});continue; }
      pending.push({...job,textHash});
    }
    for(let start=0;start<pending.length;start+=BATCH_SIZE) {
      const batch=pending.slice(start,start+BATCH_SIZE);
      try {
        const vectors=await embed(batch.map((job)=>job.text));
        for(const [index,job] of batch.entries()) {
          store.upsertEmbedding({sourceId,kind:job.kind,refKey:job.refKey,model,dims:vectors[index].length,textHash:job.textHash,vectorJson:JSON.stringify(normalize(vectors[index]))});
          indexed++;
        }
      } catch { failed+=batch.length; }
      done+=batch.length;
      onProgress?.({done,total,currentStep:`向量化 ${Math.min(done,total)}/${total}`});
    }
    store.deleteEmbeddingsNotIn(sourceId,"page",jobs.filter((job)=>job.kind==="page").map((job)=>job.refKey));
    store.deleteEmbeddingsNotIn(sourceId,"table",jobs.filter((job)=>job.kind==="table").map((job)=>job.refKey));
    return {indexed,skipped,failed,total,model};
  }

  function loadVectors(sourceId) {
    if(!enabled()) return null;
    const rows=store.listEmbeddings(sourceId,embeddingConfig().model);
    if(!rows.length) return null;
    const pageVectors=new Map(),tableVectors=new Map();
    for(const row of rows) {
      if(!Array.isArray(row.vector)) continue;
      (row.kind==="page"?pageVectors:tableVectors).set(row.refKey,row.vector);
    }
    return {pageVectors,tableVectors};
  }

  async function embedQuestion(question) {
    if(!enabled()) return null;
    try { const [vector]=await embed([String(question||"").slice(0,512)]);return normalize(vector); }
    catch { return null; }
  }

  return {ensurePageEmbedding,removePageEmbedding,reindex,loadVectors,embedQuestion,enabled};
}

export function pageRefKey(page) { return `${page.pageType}:${page.slug}`; }
export function pageText(page) {
  return [page.title,(page.aliases||[]).join(" "),String(page.content||"").slice(0,800),(page.tables||[]).join(" ")].filter(Boolean).join("\n");
}
export function tableText(table,columns) {
  const body=columns.map((column)=>`${column.columnName} ${column.comment||""}`.trim()).join(", ");
  return [table.tableName,table.comment||"",body].filter(Boolean).join("\n").slice(0,1200);
}

function normalize(vector) {
  const magnitude=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0));
  if(!magnitude) return vector.map(()=>0);
  return vector.map((value)=>value/magnitude);
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
