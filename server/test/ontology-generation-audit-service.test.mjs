import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOntologyGenerationAuditService } from "../src/ontology-generation-audit-service.mjs";

test("generation audit traces are bounded, summarized and protected from path traversal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"ontoquery-generation-audit-service-"));const directory=join(root,"run-1");await mkdir(directory,{recursive:true});
  await writeFile(join(directory,"object-001.json"),JSON.stringify({runId:"run-1",batchId:"object-batch-1",modelName:"model",promptVersion:"v1",messages:[{role:"user",content:"metadata"}],rawOutput:"{\"candidates\":[]}",usage:{totalTokens:7},durationMs:12,error:null}));
  await writeFile(join(directory,"notes.txt"),"ignored");
  const service=createOntologyGenerationAuditService({auditDir:root});
  const items=await service.list("run-1");assert.equal(items.length,1);assert.equal(items[0].fileName,"object-001.json");assert.equal(items[0].hasOutput,true);assert.equal("messages" in items[0],false);
  const detail=await service.get("run-1","object-001.json");assert.equal(detail.messages[0].content,"metadata");assert.equal(detail.rawOutput,'{"candidates":[]}');
  await assert.rejects(service.get("../run-1","object-001.json"),/批次 ID 无效/);
  await assert.rejects(service.get("run-1","..%2Fsecret.json"),/文件名无效/);
  assert.deepEqual(await service.list("missing-run"),[]);
});
