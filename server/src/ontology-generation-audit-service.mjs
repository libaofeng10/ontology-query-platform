import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const TRACE_FILE=/^(?:object|link-(?:auto|supplemental))-\d{3}\.json$/;
const MAX_TRACE_BYTES=5*1024*1024;

export function createOntologyGenerationAuditService({auditDir}={}) {
  if(!auditDir)throw new Error("ontology generation audit service 需要 auditDir");

  async function list(runId) {
    const directory=runDirectory(auditDir,runId);let names=[];
    try{names=await readdir(directory);}catch(error){if(error?.code==="ENOENT")return [];throw error;}
    const items=[];
    for(const fileName of names.filter((name)=>TRACE_FILE.test(name)).sort()){
      const file=join(directory,fileName);const metadata=await stat(file);if(!metadata.isFile()||metadata.size>MAX_TRACE_BYTES)continue;
      const trace=await readTrace(file);items.push(traceSummary(fileName,trace,metadata));
    }
    return items;
  }

  async function get(runId,fileName) {
    const safeFile=String(fileName||"");if(!TRACE_FILE.test(safeFile))throw httpError(400,"模型调用审计文件名无效");
    const file=join(runDirectory(auditDir,runId),safeFile);let metadata;
    try{metadata=await stat(file);}catch(error){if(error?.code==="ENOENT")throw httpError(404,"模型调用审计记录不存在");throw error;}
    if(!metadata.isFile()||metadata.size>MAX_TRACE_BYTES)throw httpError(422,"模型调用审计记录不可读取或超过大小限制");
    const trace=await readTrace(file);return {...traceSummary(safeFile,trace,metadata),messages:Array.isArray(trace.messages)?trace.messages:[],rawOutput:trace.rawOutput??null};
  }

  return {list,get};
}

function runDirectory(root,runId){const id=String(runId||"");if(!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw httpError(400,"生成批次 ID 无效");return join(root,id);}
async function readTrace(file){try{return JSON.parse(await readFile(file,"utf8"));}catch(error){throw httpError(422,`模型调用审计记录损坏：${error?.message||error}`);}}
function traceSummary(fileName,trace,metadata){return {fileName,runId:String(trace.runId||""),batchId:String(trace.batchId||""),modelName:trace.modelName||null,promptVersion:trace.promptVersion||null,durationMs:Number(trace.durationMs||0),usage:trace.usage||null,error:trace.error||null,hasOutput:trace.rawOutput!=null,sizeBytes:metadata.size,updatedAt:metadata.mtime.toISOString()};}
function httpError(status,message){const error=new Error(message);error.status=status;return error;}
