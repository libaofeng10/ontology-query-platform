import type { BackgroundTask, BootstrapData, CapabilityGapBoard, ConnectionTestInput, ConnectionTestResult, DataSource, DiscoverySummary, EvalCase, EvalInput, KnowledgeInput, KnowledgePage, OntologyBulkDecisionResult, OntologyCalibrationGate, OntologyCalibrationLabel, OntologyCalibrationReport, OntologyCandidate, OntologyCandidateEvent, OntologyConflictResolution, OntologyDomainDraftApplyResult, OntologyDomainDraftPreview, OntologyDomainDraftRepairResult, OntologyDomainPlan, OntologyDomainWorkflowSummary, OntologyDraftApplyResult, OntologyDraftPreview, OntologyGenerationRun, OntologyGenerationRunPage, OntologyGenerationScopePlan, OntologyGenerationTraceDetail, OntologyGenerationTraceSummary, OntologyCatalog, QueryResponse, QuerySession, QuerySessionDetail, QueryStreamEvent, RelationDocument, SemanticLinkType, SemanticObjectType, SemanticSchema, SemanticSchemaDiff, SemanticSchemaValidation, SemanticSchemaVersion, SettingsData, SettingsInput, SourceInput, TermAnchor } from "./types";

const API_BASE=process.env.NEXT_PUBLIC_API_BASE_URL??"http://localhost:8787/api";
const ENV_TOKEN=process.env.NEXT_PUBLIC_API_WRITE_TOKEN??"";
const TOKEN_KEY="ontoquery-api-token";let runtimeToken="";
const writeHeaders={"content-type":"application/json"};

export class ApiError extends Error { constructor(message:string,public status:number,public detail?:string,public payload?:unknown){super(message);this.name="ApiError";} }
export function setApiToken(token:string){runtimeToken=token.trim();if(typeof window!=="undefined")window.sessionStorage.setItem(TOKEN_KEY,runtimeToken);}
export function clearApiToken(){runtimeToken="";if(typeof window!=="undefined")window.sessionStorage.removeItem(TOKEN_KEY);}

export function getBootstrap(sourceId?:number){return request<BootstrapData>(`/bootstrap${sourceId?`?sourceId=${sourceId}`:""}`);}
export function listCapabilityGaps(sourceId:number){return request<CapabilityGapBoard>(`/capability-gaps?sourceId=${sourceId}`);}
export function createSource(input:SourceInput){return request<DataSource>("/sources",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)},15_000);}
export function testSource(sourceId:number){return request<{ok:boolean;readOnly:boolean;server:string;latencyMs:number}>(`/sources/${sourceId}/test`,{method:"POST",headers:writeHeaders},20_000);}
export function rotateSourceCredential(sourceId:number,password:string){return request<{ok:boolean;sourceId:number;requiresRetest:boolean}>(`/sources/${sourceId}/credential`,{method:"POST",headers:writeHeaders,body:JSON.stringify({password})},20_000);}
export function discoverSource(sourceId:number){return request<BackgroundTask>(`/sources/${sourceId}/discover`,{method:"POST",headers:writeHeaders},20_000);}
export function getTask(taskId:string){return request<BackgroundTask>(`/tasks/${encodeURIComponent(taskId)}`);}
export function setTableGrade(sourceId:number,tableName:string,grade:"A"|"B"|"C"){return request<DiscoverySummary>(`/sources/${sourceId}/tables/${encodeURIComponent(tableName)}/grade`,{method:"POST",headers:writeHeaders,body:JSON.stringify({grade})});}
export function askQuestion(question:string,sourceId:number,sessionId?:string,options:{onEvent?:(event:QueryStreamEvent)=>void;signal?:AbortSignal}={}){return streamQuery({question,sourceId,sessionId},options);}
export function continueQuestion(answer:string,sourceId:number,sessionId:string,pendingId:string,options:{onEvent?:(event:QueryStreamEvent)=>void;signal?:AbortSignal}={}){return streamQuery({question:answer,sourceId,sessionId,pendingId},options);}
export function listQuerySessions(sourceId:number){return request<QuerySession[]>(`/sessions?sourceId=${sourceId}`);}
export function createQuerySession(sourceId:number){return request<QuerySession>("/sessions",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId})});}
export function getQuerySession(sessionId:string){return request<QuerySessionDetail>(`/sessions/${encodeURIComponent(sessionId)}`);}
export function deleteQuerySession(sessionId:string){return request<{ok:boolean;id:string}>(`/sessions/${encodeURIComponent(sessionId)}`,{method:"DELETE"});}
export function answerQuestion(id:number,answer:string){return request<{ok:boolean;remaining:number}>(`/questions/${id}/answer`,{method:"POST",headers:writeHeaders,body:JSON.stringify({answer,applyScope:"suggested"})},30_000);}
export function saveKnowledge(input:KnowledgeInput){return request<KnowledgePage>("/knowledge",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)},20_000);}
export function syncKnowledge(sourceId:number){return request<{scanned:number;imported:number;unchanged:number;skipped:number;errors:Array<{file:string;error:string}>}>("/knowledge/sync",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId})},30_000);}
export function listRelationDocuments(sourceId:number){return request<RelationDocument[]>(`/sources/${sourceId}/relation-docs`);}
export function uploadRelationDocument(sourceId:number,filename:string,content:string){return request<RelationDocument>(`/sources/${sourceId}/relation-docs`,{method:"POST",headers:writeHeaders,body:JSON.stringify({filename,content})},300_000);}
export function listOntologySchemas(sourceId:number){return request<SemanticSchemaVersion[]>(`/ontology/schemas?sourceId=${sourceId}`);}
export function getOntologyCatalog(sourceId:number){return request<OntologyCatalog>(`/ontology/catalog?sourceId=${sourceId}`);}
export function listTermAnchors(vocabulary?:string){return request<TermAnchor[]>(`/ontology/term-anchors${vocabulary?`?vocabulary=${encodeURIComponent(vocabulary)}`:""}`);}
export function saveTermAnchors(items:Array<Partial<TermAnchor>&{vocabulary:string;canonicalId:string}>){return request<{count:number;items:TermAnchor[]}>("/ontology/term-anchors",{method:"POST",headers:writeHeaders,body:JSON.stringify({items})});}
export function importTermAnchors(vocabulary:string,csv:string){return request<{count:number;items:TermAnchor[]}>("/ontology/term-anchors/import",{method:"POST",headers:writeHeaders,body:JSON.stringify({vocabulary,csv})});}
export function getOntologySchema(id:number){return request<SemanticSchemaVersion>(`/ontology/schemas/${id}`);}
export function getOntologySchemaDiff(id:number,against:number){return request<SemanticSchemaDiff>(`/ontology/schemas/${id}/diff?against=${against}`);}
export function getPublishedOntologySchema(sourceId:number){return request<SemanticSchemaVersion>(`/ontology/published?sourceId=${sourceId}`);}
export function validateOntologySchema(sourceId:number,schema:SemanticSchema){return request<SemanticSchemaValidation>("/ontology/validate",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,schema})});}
export function saveOntologySchema(sourceId:number,schema:SemanticSchema){return request<SemanticSchemaVersion>("/ontology/schemas",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,schema})});}
export function publishOntologySchema(id:number){return request<{ok:boolean;record:SemanticSchemaVersion}&SemanticSchemaValidation>(`/ontology/schemas/${id}/publish`,{method:"POST",headers:writeHeaders,body:"{}"});}
export function rollbackOntologySchema(id:number){return request<{ok:boolean;record:SemanticSchemaVersion;rolledBackFrom:number}&SemanticSchemaValidation>(`/ontology/schemas/${id}/rollback`,{method:"POST",headers:writeHeaders,body:"{}"});}
export function planOntologyGenerationScope(input:{sourceId:number;tableNames:string[]}){return request<OntologyGenerationScopePlan>("/ontology/generation-scope",{method:"POST",headers:writeHeaders,body:JSON.stringify({mode:"selected_tables",...input})},20_000);}
export function planOntologyDomains(sourceId:number,refresh=false){return request<OntologyDomainPlan>(`/ontology/domain-plan?sourceId=${sourceId}${refresh?"&refresh=1":""}`,{},refresh?90_000:15_000);}
export function startOntologyDomainModeling(sourceId:number,options:{refreshDomainPlan?:boolean;domainIds?:string[];orchestrationId?:string|null}={}){return request<BackgroundTask>("/ontology/domain-modeling",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,refreshDomainPlan:options.refreshDomainPlan!==false,domainIds:options.domainIds||[],orchestrationId:options.orchestrationId||null})},20_000);}
export function getOntologyDomainWorkflow(orchestrationId:string){return request<OntologyDomainWorkflowSummary>(`/ontology/domain-modeling/${encodeURIComponent(orchestrationId)}/summary`);}
export function retryFailedOntologyDomains(orchestrationId:string){return request<BackgroundTask>(`/ontology/domain-modeling/${encodeURIComponent(orchestrationId)}/retry-failed`,{method:"POST",headers:writeHeaders,body:"{}"},20_000);}
export function previewOntologyDomainDraft(orchestrationId:string,conflictResolutions:Record<string,OntologyConflictResolution>={},allowFailedDomains=false){return request<OntologyDomainDraftPreview>(`/ontology/domain-modeling/${encodeURIComponent(orchestrationId)}/preview`,{method:"POST",headers:writeHeaders,body:JSON.stringify({conflictResolutions,allowFailedDomains})},30_000);}
export function applyOntologyDomainDraft(orchestrationId:string,conflictResolutions:Record<string,OntologyConflictResolution>={},allowFailedDomains=false){return request<OntologyDomainDraftApplyResult>(`/ontology/domain-modeling/${encodeURIComponent(orchestrationId)}/apply`,{method:"POST",headers:writeHeaders,body:JSON.stringify({conflictResolutions,allowFailedDomains})},30_000);}
export function repairOntologyDomainDraft(orchestrationId:string){return request<OntologyDomainDraftRepairResult>(`/ontology/domain-modeling/${encodeURIComponent(orchestrationId)}/repair`,{method:"POST",headers:writeHeaders,body:"{}"},60_000);}
export function createOntologyGenerationRun(input:{sourceId:number;tableNames:string[];domainName:string;domainDescription?:string;baseSchemaVersionId?:number|null}){return request<OntologyGenerationRun>("/ontology/generation-runs",{method:"POST",headers:writeHeaders,body:JSON.stringify({mode:"selected_tables",...input})},20_000);}
export function listOntologyGenerationRuns(sourceId:number,page=1,pageSize=20){return request<OntologyGenerationRunPage>(`/ontology/generation-runs?sourceId=${sourceId}&page=${page}&pageSize=${pageSize}`);}
export function getOntologyGenerationRun(id:string){return request<OntologyGenerationRun>(`/ontology/generation-runs/${encodeURIComponent(id)}`);}
export function listOntologyGenerationTraces(id:string){return request<OntologyGenerationTraceSummary[]>(`/ontology/generation-runs/${encodeURIComponent(id)}/traces`);}
export function getOntologyGenerationTrace(id:string,fileName:string){return request<OntologyGenerationTraceDetail>(`/ontology/generation-runs/${encodeURIComponent(id)}/traces/${encodeURIComponent(fileName)}`);}
export function listOntologyCandidates(sourceId:number,runId?:string){const query=new URLSearchParams({sourceId:String(sourceId)});if(runId)query.set("runId",runId);return request<OntologyCandidate[]>(`/ontology/candidates?${query}`);}
export function listOntologyCandidateEvents(id:string){return request<OntologyCandidateEvent[]>(`/ontology/candidates/${encodeURIComponent(id)}/events`);}
export function decideOntologyCandidate(id:string,decision:"confirm"|"reject"|"withdraw",candidate?:SemanticObjectType|SemanticLinkType,note?:string){return request<OntologyCandidate>(`/ontology/candidates/${encodeURIComponent(id)}/decision`,{method:"POST",headers:writeHeaders,body:JSON.stringify({decision,...(candidate?{candidate}:{}),...(note?{note}: {})})});}
export function bulkDecideOntologyCandidates(sourceId:number,candidateIds:string[],decision:"confirm"|"reject"|"withdraw",note?:string){return request<OntologyBulkDecisionResult>("/ontology/candidates/bulk-decision",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,candidateIds,decision,...(note?{note}:{})})},30_000);}
export function mergeOntologyCandidate(id:string,intoCandidateId:string,note?:string){return request<{candidate:OntologyCandidate;retainedCandidate:OntologyCandidate}>(`/ontology/candidates/${encodeURIComponent(id)}/merge`,{method:"POST",headers:writeHeaders,body:JSON.stringify({intoCandidateId,note})});}
export function labelOntologyCandidate(id:string,input:{verdict:"correct"|"incorrect";majorModification?:boolean;issueType?:OntologyCalibrationLabel["issueType"];note?:string}){return request<OntologyCalibrationLabel>(`/ontology/candidates/${encodeURIComponent(id)}/calibration`,{method:"POST",headers:writeHeaders,body:JSON.stringify(input)});}
export function getOntologyCalibrationReport(sourceId:number,manualObjectCount=0){return request<OntologyCalibrationReport>(`/ontology/calibration?sourceId=${sourceId}&manualObjectCount=${manualObjectCount}`);}
export function createOntologyCalibrationGate(input:{sourceId:number;manualObjectCount:number;finalObjectCount?:number;runIds?:string[];draftSchemaVersionId?:number;evalGateId?:string}){return request<OntologyCalibrationGate>("/ontology/calibration/gates",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)});}
export function listOntologyCalibrationGates(sourceId:number){return request<OntologyCalibrationGate[]>(`/ontology/calibration/gates?sourceId=${sourceId}`);}
export function activateOntologyCalibrationGate(id:string){return request<{gate:OntologyCalibrationGate;settings:SettingsData}>(`/ontology/calibration/gates/${encodeURIComponent(id)}/activate`,{method:"POST",headers:writeHeaders,body:"{}"});}
export function adoptOntologyAutoConfirmThreshold(input:{sourceId:number;autoConfirmScore:number;runIds:string[];targetPrecision?:number}){return request<{sourceId:number;autoConfirmScore:number;updatedBy:string|null;updatedAt:string}>("/ontology/calibration/threshold/adopt",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)});}
export function generateSupplementalOntologyLinks(runId:string){return request<BackgroundTask>(`/ontology/generation-runs/${encodeURIComponent(runId)}/links`,{method:"POST",headers:writeHeaders,body:"{}"},20_000);}
export function previewOntologyDraft(runId:string,excludeCandidateIds:string[],conflictResolutions:Record<string,OntologyConflictResolution>={}){return request<OntologyDraftPreview>(`/ontology/generation-runs/${encodeURIComponent(runId)}/preview`,{method:"POST",headers:writeHeaders,body:JSON.stringify({excludeCandidateIds,conflictResolutions})},20_000);}
export function applyOntologyDraft(runId:string,excludeCandidateIds:string[],conflictResolutions:Record<string,OntologyConflictResolution>={}){return request<OntologyDraftApplyResult>(`/ontology/generation-runs/${encodeURIComponent(runId)}/apply`,{method:"POST",headers:writeHeaders,body:JSON.stringify({excludeCandidateIds,conflictResolutions})},20_000);}
export function saveEvalCase(input:EvalInput,id?:number){return request<EvalCase>(id?`/eval/cases/${id}`:"/eval/cases",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)},20_000);}
export function archiveEvalCase(id:number){return request<{ok:boolean;id:number}>(`/eval/cases/${id}/archive`,{method:"POST",headers:writeHeaders});}
export function runEvaluation(sourceId:number,setName:string,queryAgentMode:"off"|"prefer"|"required"="off"){return request<BackgroundTask>("/eval/run",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,setName,tolerance:1e-6,queryAgentMode})},20_000);}
export function runEvaluationGate(sourceId:number,setName:string,ontologySchemaVersionId?:number){return request<BackgroundTask>("/eval/gate",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,setName,tolerance:1e-6,gateKind:"semantic",ontologySchemaVersionId})},20_000);}
export function runAgentEvaluationGate(sourceId:number,setName:string){return request<BackgroundTask>("/eval/gate",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId,setName,tolerance:1e-6,gateKind:"agent"})},20_000);}
export function getSettings(){return request<SettingsData>("/settings");}
export function updateSettings(input:SettingsInput){return request<SettingsData>("/settings",{method:"PUT",headers:writeHeaders,body:JSON.stringify(input)},20_000);}
export function testLlmSettings(input:ConnectionTestInput){return request<ConnectionTestResult>("/settings/test-llm",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)},30_000);}
export function testEmbeddingSettings(input:ConnectionTestInput){return request<ConnectionTestResult>("/settings/test-embedding",{method:"POST",headers:writeHeaders,body:JSON.stringify(input)},30_000);}
export function reindexEmbeddings(sourceId:number){return request<BackgroundTask>("/settings/reindex-embeddings",{method:"POST",headers:writeHeaders,body:JSON.stringify({sourceId})},20_000);}

async function request<T>(path:string,init:RequestInit={},timeoutMs=12_000):Promise<T>{
  let response:Response;
  const token=currentToken();if(!token)throw new ApiError("请输入 API 身份令牌",401);
  const headers=new Headers(init.headers);headers.set("authorization",`Bearer ${token}`);
  try{response=await fetch(`${API_BASE}${path}`,{...init,headers,signal:AbortSignal.timeout(timeoutMs),cache:"no-store"});}
  catch(error){throw new ApiError(error instanceof DOMException&&error.name==="TimeoutError"?"请求超时，请检查服务或数据源状态":"无法连接本地 API，请确认 npm run dev 正在运行",0,String(error));}
  const payload=await response.json().catch(()=>({}));
  if(!response.ok) throw new ApiError(payload.error||`请求失败 (${response.status})`,response.status,payload.detail,payload);
  return payload as T;
}

async function streamQuery(input:{question:string;sourceId:number;sessionId?:string;pendingId?:string},{onEvent,signal}:{onEvent?:(event:QueryStreamEvent)=>void;signal?:AbortSignal}):Promise<QueryResponse>{
  const token=currentToken();if(!token)throw new ApiError("请输入 API 身份令牌",401);
  const headers=new Headers(writeHeaders);headers.set("authorization",`Bearer ${token}`);headers.set("accept","text/event-stream");
  const timeoutSignal=AbortSignal.timeout(4*60_000);const requestSignal=signal?AbortSignal.any([signal,timeoutSignal]):timeoutSignal;
  let response:Response;
  try{response=await fetch(`${API_BASE}/query`,{method:"POST",headers,body:JSON.stringify(input),signal:requestSignal,cache:"no-store"});}
  catch(error){if(signal?.aborted)throw new ApiError("查询已取消",0);throw new ApiError(error instanceof DOMException&&error.name==="TimeoutError"?"查询超时，请缩小问题范围后重试":"无法连接本地 API，请确认 npm run dev 正在运行",0,String(error));}
  if(!response.ok){const payload=await response.json().catch(()=>({}));throw new ApiError(payload.error||`请求失败 (${response.status})`,response.status,payload.detail,payload);}
  if(!String(response.headers.get("content-type")||"").includes("text/event-stream"))return response.json() as Promise<QueryResponse>;
  if(!response.body)throw new ApiError("服务未返回可读取的查询流",0);
  const reader=response.body.getReader();const decoder=new TextDecoder();let buffer="";let finalResult:QueryResponse|null=null;
  while(true){const {done,value}=await reader.read();buffer+=decoder.decode(value||new Uint8Array(),{stream:!done}).replace(/\r\n/g,"\n");let boundary;while((boundary=buffer.indexOf("\n\n"))>=0){const block=buffer.slice(0,boundary);buffer=buffer.slice(boundary+2);const event=parseSseBlock(block);if(!event)continue;onEvent?.(event);if(event.type==="final"||event.type==="refused"||event.type==="clarification")finalResult=event.result;}if(done)break;}
  if(!finalResult)throw new ApiError("查询流在返回最终结果前中断",0);
  return finalResult;
}

function parseSseBlock(block:string):QueryStreamEvent|null{
  let eventName="";const data=[];
  for(const line of block.split("\n")){if(line.startsWith("event:"))eventName=line.slice(6).trim();else if(line.startsWith("data:"))data.push(line.slice(5).trimStart());}
  if(!data.length)return null;
  try{const parsed=JSON.parse(data.join("\n")) as QueryStreamEvent;return parsed.type?parsed:{...parsed,type:eventName} as QueryStreamEvent;}catch{return null;}
}

function currentToken(){if(runtimeToken)return runtimeToken;if(typeof window!=="undefined"){const stored=window.sessionStorage.getItem(TOKEN_KEY);if(stored)return stored;}return ENV_TOKEN;}
