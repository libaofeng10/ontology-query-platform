export type NavId = "query" | "sources" | "discovery" | "questions" | "modeling" | "knowledge" | "graph" | "evaluation" | "audit" | "settings";

export type QueryColumn = { key:string; label:string; type:"text"|"number"|"percent" };
export type QueryRow = Record<string,string|number|null>;
export type QueryResultSet = { name:string; columns:QueryColumn[]; rows:QueryRow[]; rowCount:number; mayBeTruncated?:boolean };
export type QueryIntent = { version:string; rawQuestion:string; normalizedQuestion:string; subjects:string[]; entities:Array<{type:string;text:string;sourceText:string;immutable:boolean;span:{start:number;end:number}}>; filters:Array<{kind:string;operator:string;value:string;immutable:boolean;sourceText:string}>; timeRange:{kind:string;sourceText:string;start:string;endExclusive:string}|null; scope:{exhaustive:boolean;products:string[]}; ambiguities:Array<{code:string;message:string;blocking:boolean}>; retrievalTerms:string[] };
export type SemanticQueryPlan = {
  rootObject:string;
  dimensions:Array<{property:string;alias:string}>;
  metrics:Array<{aggregation:"count"|"count_distinct"|"sum"|"avg"|"min"|"max";property:string|null;alias:string}>;
  filters:Array<{property:string;operator:string;value?:unknown}>;
  timeDimension:{property:string;grain:"day"|"week"|"month"|"quarter"|"year";alias:string}|null;
  orderBy:Array<{field:string;direction:"asc"|"desc"}>;
  limit:number;
};
export type SemanticQueryPath = {
  rootObject:string; objects:string[]; links:string[];
  relations:Array<{id:number;fromTable:string;fromCol:string;toTable:string;toCol:string}>;
};
export type QueryToolTrace = { tool:string; phase?:string; thought:string; argsHash:string; durationMs:number; ok:boolean; summary:string; stage?:string; errorCode?:string; failureClass?:string; retryable?:boolean; sql?:string; pages?:string[]; tables?:Array<{name:string;fieldCount:number}>; sample?:{table:string;columns:string[]}; entity?:{type:string;value:string;candidateCount:number} };
export type QueryStreamEvent =
  | {type:"step";step:number;status:"started"|"completed"|"failed";durationMs?:number}
  | {type:"thought";step:number;text:string}
  | {type:"tool_call";step:number;tool:string;sql?:string;tables?:string[];sample?:{table:string;columns:string[]}}
  | {type:"tool_result";step:number;tool:string;ok:boolean;summary:string;durationMs:number;sql?:string;pages?:string[];tables?:Array<{name:string;fieldCount:number}>;sample?:{table:string;columns:string[]}}
  | {type:"final"|"refused"|"clarification";result:QueryResponse};
export type Evidence = {
  pages:string[]; rules:string[]; tables:string[]; joins?:string[]; sql:string; durationMs:number; scannedRows:number;
  sqls?:Array<{name:string;sql:string;tables:string[];joins:string[];scannedRows:number;durationMs:number;rowCount:number}>;
  coverage?:"semantic"|"structural"|"session"|"demo"; retrievalMode?:"lexical"|"hybrid";
  planningMode?:"semantic"|"legacy"|"agent"|"demo"; ontologySchemaVersion?:number;
  queryPlan?:SemanticQueryPlan; semanticPath?:SemanticQueryPath; semanticFallbackReason?:string; agentFallbackReason?:string; planningAttempts?:number;
  zeroResultProbe?:{findings:Array<{table:string;filterColumn:string;siblingColumn:string;value:string;matchCount:number}>;probedAt:string};
  iterations?:number; toolTrace?:QueryToolTrace[]; stateTransitions?:Array<{from:string;to:string;step:number}>; budgetFallback?:boolean; resultDelivery?:"preview"|"direct"; clarifications?:Array<{question:string;answer:string}>; tokenUsage?:{promptTokens:number;completionTokens:number;totalTokens:number;available:boolean}; queryIntent?:QueryIntent; agentRollout?:{configuredMode:"off"|"prefer"|"required";effectiveMode:"off"|"prefer"|"required";trafficPercent:number;bucket:number|null;reason:string}; resultCompleteness?:{complete:boolean;mayBeTruncated:boolean;incompleteResultSets:string[];reason?:string};
};
export type QueryAnswer = { id:string; sessionId?:string; question:string; conclusion:string; delta?:string; columns:QueryColumn[]; rows:QueryRow[]; resultSets?:QueryResultSet[]; chart:{type:"line"|"bar"|"pie";xKey:string;yKey:string}|null; evidence:Evidence };
export type QueryRefusal = { refused:true; reason:string; errorCode?:string; failureClass?:string; sessionId?:string; missingTerm?:string; missingConfiguration?:string[]; missingFacets?:string[]; attemptedSql?:string; planningMode?:"semantic"|"legacy"|"agent"; planningAttempts?:number; toolTrace?:QueryToolTrace[]; clarifications?:Array<{question:string;answer:string}> };
export type QueryClarification = { clarification:{pendingId:string;question:string;options:string[];allowFreeText:boolean;expiresAt:string}; sessionId:string; planningMode:"agent"; planningAttempts:number; toolTrace:QueryToolTrace[]; tokenUsage?:{promptTokens:number;completionTokens:number;totalTokens:number;available:boolean} };
export type QueryResponse = QueryAnswer|QueryRefusal|QueryClarification;
export type QuerySession = { id:string; sourceId:number; userName:string; title:string; messageCount:number; createdAt:string; updatedAt:string };
export type QuerySessionMessage = { id:number; sessionId:string; role:"user"|"assistant"; auditId?:number|null; content:{text?:string}|QueryResponse; createdAt:string };
export type QuerySessionDetail = Omit<QuerySession,"messageCount"> & { context:Record<string,unknown>; messages:QuerySessionMessage[]; pendingClarification?:{question:string;response:QueryClarification} };

export type DataSource = {
  id:number; name:string; kind:"demo"|"mysql"; host:string; port:number; dbName:string; userName:string;
  isDemo:number|boolean; lastTestAt:string|null; lastTestOk:number|null; lastTestError:string|null;
  lastDiscoveryAt:string|null; createdAt:string;
};

export type DiscoveryTable = {
  sourceId:number; tableName:string; rowEstimate:number; grade:"A"|"B"|"C";
  gradeOverride:"A"|"B"|"C"|null; active:number; lastProbeAt:string|null;
  comment:string|null; daysSinceWrite:number|null;
};

export type DiscoverySummary = {
  sourceId:number; tables:DiscoveryTable[]; totalTables:number;
  grades:{A:number;B:number;C:number}; sensitiveFields:number; relations:number; pendingQuestions:number;
  relationDiscovery:{
    explicit:number; modelSuggested:number; confirmed:number; rejected:number;
    modelStatus:"not_run"|"not_configured"|"completed"|"partial"|"failed"|string;
    modelName:string|null; candidateCount:number; judgedCount:number;
    suggestedCount:number; rejectedCount:number; error:string|null; updatedAt:string|null;
  };
  schemaDiff?:SchemaDiff;
};

export type SchemaDiff = {
  changed:boolean; previousVersion:number|null; currentVersion?:number;
  addedTables:string[]; removedTables:string[]; changedTables:string[];
  addedColumns:string[]; removedColumns:string[];
};

export type BackgroundTask = {
  id:string; sourceId:number; taskType:"discovery"|string;
  status:"queued"|"running"|"succeeded"|"failed";
  progress:number; total:number; currentStep:string|null; error:string|null;
  result:DiscoverySummary|EvaluationSummary|EvaluationGateSummary|OntologyDomainModelingResult|null; createdAt:string; startedAt:string|null; finishedAt:string|null;
};
export type SchemaSnapshot = { id:number; sourceId:number; version:number; checksum:string; createdAt:string };

export type OntologyQuestion = {
  id:number; kind:string; scope:"column"|"table"|"global"; tableName:string|null;
  columnName:string|null; question:string; evidence:string; options:string[]; status:string; relationId?:number|null;
};

export type KnowledgePage = {
  id:number|string; sourceId:number; pageType:"term"|"metric"|"join"|"rule"|"table";
  slug:string; title:string; aliases:string[]; tables:string[]; content:string;
  sqlContent:string|null; antiExamples:string|null; verified:boolean; owner:string|null;
  verifiedAt:string|null; updatedAt:string|null; grade?:string;
};

export type OntologyGraphNode = {
  id:string; kind:"table"|"object"|"term"|"metric"|"rule"; title:string; subtitle:string;
  verified:boolean; grade?:"A"|"B"|"C"; tables:string[]; content:string; parent?:string;
  properties?:Array<{apiName:string;displayName:string;type:string;required:boolean;mapping:{table:string;column:string};inherited?:boolean}>;
};
export type OntologyGraphEdge = {
  id:string; source:string; target:string; kind:"join"|"binding"|"wikilink"|"mapping"|"semantic"|"subclass";
  label:string; confirmed:boolean; forwardLabel?:string; inverseLabel?:string|null;
};
export type OntologyGraph = {
  sourceId:number; nodes:OntologyGraphNode[]; edges:OntologyGraphEdge[];
  stats:{tables:number;objects:number;semanticLinks:number;schemaVersion:number|null;terms:number;metrics:number;rules:number;joins:number;confirmedJoins:number};
};

export type AuditRecord = {
  id:number; userName:string; question:string; retrievedPages:string; sql:string|null;
  verdict:"passed"|"refused"|"failed"|string; failReason:string|null;
  durationMs:number|null; rowCount:number|null; createdAt:string;
  planningMode:"semantic"|"legacy"|"agent"|"demo"|null; ontologySchemaVersion:number|null;
  queryPlan:SemanticQueryPlan|null; semanticPath:SemanticQueryPath|null; semanticFallbackReason:string|null; planningAttempts:number|null;
  iterations:number|null; clarificationCount:number; toolTrace:QueryToolTrace[];
  intentVersion:string|null; intent:QueryIntent|null; promptVersion:string|null; retrievalTrace:Record<string,unknown>|null; failureClass:string|null;
};

export type AuditStats = { total:number; passed:number; blocked:number; averageMs:number };
export type EvalCase = { id:number; setName:string; question:string; goldSql:string|null; hasGoldSql:number|boolean; category:string; heldOut:number };
export type EvalInput = { sourceId:number; setName:string; question:string; goldSql:string; category:string; heldOut:boolean };
export type EvaluationRepairHint = { targetType:"object"|"property"|"link"; target:string; label:string; action:string };
export type EvalRun = { id:number; evalId:number; batchId:string; setName:string; question:string; generatedSql:string|null; passed:number; failReason:string|null; durationMs:number|null; failureClass:string|null; suggestion:string|null; repairHints:EvaluationRepairHint[]; requestedMode:"off"|"prefer"|"single"|"agent_prefer"|"agent_required"|null; planningMode:"semantic"|"legacy"|"agent"|null; comparisonRole:"baseline"|"candidate"|null; ontologySchemaVersion:number|null; semanticPath:SemanticQueryPath|null; tableCount:number|null; planningAttempts:number|null; agentMetrics:{agentExecution:number;iterations:number;toolCalls:number;toolSuccesses:number;clarificationCount:number;budgetFallback:number;repeatedActions:number;intentFailures:number;incompleteFailures:number;totalTokens:number|null}|null; runAt:string };
export type EvaluationSummary = { batchId:string; setName:string; queryAgentMode?:"off"|"prefer"|"required"; total:number; passed:number; failed:number; failures:Array<{evalId:number;question:string;failureClass:string;reason:string;suggestion:string;repairHints:EvaluationRepairHint[]}> };
export type EvaluationGateMetrics = { gateKind?:"agent"; requestedMode:"off"|"prefer"|"single"|"agent_required"; total:number; passed:number; failed:number; refused:number; passRate:number; averageDurationMs:number; joinFailures?:number; semanticExecutions?:number; joinFailureRate?:number; refusalRate:number; semanticExecutionRate?:number; subtypeRootObjects?:string[]; subtypeRootCoverage?:number; averageContextTables?:number; averagePlanningAttempts?:number; agentExecutions?:number; agentExecutionRate?:number; averageIterations?:number; toolCalls?:number; toolSuccesses?:number; toolSuccessRate?:number; clarifications?:number; clarificationRate?:number; budgetFallbacks?:number; budgetFallbackRate?:number; repeatedActions?:number; repeatedActionRate?:number; intentFailures?:number; intentFailureRate?:number; incompleteFailures?:number; incompleteFailureRate?:number; p95DurationMs?:number; tokenCoverage?:number; averageTokens?:number; p95Tokens?:number };
export type EvaluationGate = { id:string; sourceId:number; setName:string; total:number; ontologySchemaVersion:number|null; ontologySchemaPublishedAt?:string|null; evaluationChecksum?:string|null; baseline:EvaluationGateMetrics; candidate:EvaluationGateMetrics; passed:number|boolean; decision:"enable_prefer"|"enable_agent_prefer"|"keep_off"; reason:string; createdAt:string };
export type EvaluationGateSummary = { batchId:string; gateKind?:"agent"; setName:string; total:number; ontologySchemaVersion:number|null; ontologySchemaPublishedAt?:string|null; baseline:EvaluationGateMetrics; candidate:EvaluationGateMetrics; passed:boolean; decision:"enable_prefer"|"enable_agent_prefer"|"keep_off"; reason:string; failures:EvaluationSummary["failures"] };

export type BootstrapData = {
  sources:DataSource[]; sourceId:number; discovery:DiscoverySummary|null;
  questions:OntologyQuestion[]; knowledge:KnowledgePage[]; audits:AuditRecord[];
  graph:OntologyGraph|null;
  auditStats:AuditStats|null; evalCases:EvalCase[]; evalRuns:EvalRun[]; evalGates:EvaluationGate[];
  tasks:BackgroundTask[]; schemaSnapshots:SchemaSnapshot[];
  identity:{name:string;role:"viewer"|"analyst"|"editor"|"admin"};
};

export type SourceInput = { name:string; host:string; port:number; dbName:string; userName:string; password:string };
export type KnowledgeInput = {
  sourceId:number; pageType:"term"|"metric"|"join"|"rule"; slug?:string; title:string;
  aliases:string[]; tables:string[]; content:string; sqlContent:string;
  antiExamples:string; verified:boolean; owner:string;
};

export type SemanticProperty = {
  apiName:string; displayName:string; description?:string;
  type:"string"|"integer"|"number"|"boolean"|"date"|"datetime"|"enum";
  required:boolean; freshness?:"realtime"|"hourly"|"daily"|"batch";
  termBinding?:TermBinding;
  constraints?:{ minimum?:number; maximum?:number; minLength?:number; maxLength?:number; pattern?:string; enumValues?:string[] };
  mapping:{ table:string; column:string };
};
export type TermBinding={vocabulary:string;canonicalId:string;match:"exact"|"close"|"broader"};
export type TermAnchor={id:number;vocabulary:string;canonicalId:string;prefLabelZh:string|null;prefLabelEn:string|null;altLabels:string[];kind:"object"|"property"|"metric";broaderCanonicalId:string|null;note:string|null;createdAt:string;updatedAt:string};
export type SemanticObjectType = { apiName:string; displayName:string; description?:string; namespace?:string; freshness?:"realtime"|"hourly"|"daily"|"batch"; primaryKey:string; properties:SemanticProperty[];parent?:string;discriminator?:{property:string;values:Array<string|number>};termBinding?:TermBinding };
export type SemanticLinkType = {
  apiName:string; displayName:string; description?:string; source:string; target:string;
  cardinality:"one_to_one"|"one_to_many"|"many_to_one"|"many_to_many";
  sourceLabel?:string; targetLabel?:string; inverseApiName?:string; inverseDisplayName?:string; relationKind?:"contains"|"references"|"temporal"; relationMappings:Array<{relationId:number}>;
};
export type SemanticSchema = { name:string; displayName:string; description?:string; objectTypes:SemanticObjectType[]; linkTypes:SemanticLinkType[];disjointGroups?:string[][] };
export type SemanticSchemaIssue = { code:string; path:string; message:string };
export type SemanticSchemaValidation = {
  ok:boolean; schema?:SemanticSchema; errors:SemanticSchemaIssue[]; warnings:SemanticSchemaIssue[];
  summary:{ objectTypes:number; properties:number; linkTypes:number; errorCount:number; warningCount:number };
};
export type SemanticSchemaVersion = {
  id:number; sourceId:number; version:number; status:"draft"|"published"|"deprecated";
  schemaName:string; schema?:SemanticSchema; checksum:string; validation:SemanticSchemaValidation;
  createdBy:string; createdAt:string; publishedBy:string|null; publishedAt:string|null;
};
export type OntologyCatalogTable = { sourceId:number; tableName:string; rowEstimate:number; grade:"A"|"B"|"C"; gradeOverride:"A"|"B"|"C"|null; active:number; comment:string|null };
export type ColumnProfile={sampleValues:string[];formatPattern:string|null;distinctCount:number;nullRatio:number;minMax:{min:number|string;max:number|string}|null;sensitiveValuesSuppressed:boolean;sampledAt:string;sampleSize:number;profileVersion:string};
export type OntologyCatalogColumn = { sourceId:number; tableName:string; columnName:string; dataType:string; nullable:number; isSensitive:number; comment:string|null; isPrimary:number; isUnique:number; isIndexed:number;profile?:ColumnProfile|null };
export type OntologyCatalogRelation = { id:number; fromTable:string; fromCol:string; toTable:string; toCol:string; cardinality:string|null; confidence:number; status:string; inferenceSource:string|null };
export type OntologyCatalog = { tables:OntologyCatalogTable[]; columnsByTable:Record<string,OntologyCatalogColumn[]>; relations:OntologyCatalogRelation[];termAnchors?:TermAnchor[];enums?:Record<string,string[]> };
export type OntologyGenerationScopePlan = {
  sourceId:number;mode:"selected_tables";tableNames:string[];limits:{maxTables:number;maxFields:number};
  totalNonSensitiveFields:number;includedFieldCount:number;truncatedFieldCount:number;batchCount:number;hasTruncation:boolean;
  confirmedRelationCount:number;includedRelationCount:number;crossBatchRelationCount:number;excludedSensitiveRelationCount:number;excludedInvalidRelationCount:number;
  batches:Array<{id:string;tableNames:string[];fieldCount:number;relationCount:number;tables:Array<{tableName:string;totalNonSensitiveFields:number;includedFieldCount:number;truncatedFieldCount:number;fieldsComplete:boolean}>}>;
};
export type OntologyDomainPlanTable = { tableName:string; comment:string|null; grade:"A"|"B"|null };
export type OntologyDomainPlanDomain = { id:string; domainKey:string; name:string; description:string; namingSource:"llm"|"fallback"; tableCount:number; batchIndex:number; batchCount:number; tables:OntologyDomainPlanTable[]; relationCount:number; signal:"relations"|"prefix"|"mixed" };
export type OntologyDomainPlan = { sourceId:number; generatedAt?:string; namingSource?:"llm"|"fallback"; llmError?:string|null; eligibleTableCount?:number; confirmedRelationCount?:number; maxTables?:number; domains:OntologyDomainPlanDomain[]|null; stored:boolean; storedAt?:string; stale?:boolean };
export type OntologyDomainModelingDomainResult={domainId:string;domainName:string;runId:string|null;status:"succeeded"|"failed";error?:string;objectCount:number;linkCount:number;autoConfirmedCount:number;reviewRequiredCount:number;blockedCount:number};
export type OntologyDomainModelingResult={sourceId:number;orchestrationId?:string;domainCount:number;succeededDomainCount:number;failedDomainCount:number;objectCount:number;linkCount:number;autoConfirmedCount:number;reviewRequiredCount:number;blockedCount:number;runIds:string[];domains:OntologyDomainModelingDomainResult[]};
export type SemanticSchemaDiffChange = { type:string;kind:"schema"|"object"|"property"|"link"|"disjoint_group"; change:"added"|"removed"|"changed"; path:string; label:string; impact:"compatible"|"review"|"breaking"; detail:string };export type SemanticSchemaEvaluationImpact = { summary:{breakingChanges:number;reviewChanges:number;affectedCases:number;affectedSets:number;uncoveredChanges:number;requiresEvaluation:boolean;hierarchyChanged?:boolean;subtypeRootCoverageMissing?:boolean;readyToPublish?:boolean}; affectedCases:Array<{id:number;setName:string;question:string;category:string;reasons:string[];changePaths:string[]}>; affectedSets:string[]; uncoveredChanges:Array<{path:string;label:string;impact:"review"|"breaking";detail:string}>; gateEvidence?:Array<{setName:string;passed:boolean;gateId:string|null;createdAt:string|null;subtypeRootObjects?:string[]}>; subtypeRootCoverage?:string[] };
export type SemanticSchemaDiff = { ok:boolean; sourceId:number; currentVersion:number; baseVersion:number; summary:{added:number;removed:number;changed:number;breaking:number;review:number;compatible:number;total:number}; changes:SemanticSchemaDiffChange[]; evaluationImpact?:SemanticSchemaEvaluationImpact };

export type OntologyGenerationRun = {
  id:string; sourceId:number; taskId:string|null; mode:"selected_tables"|"business_domain";
  scope:{tableNames:string[];domainName?:string;domainDescription?:string;namespace?:string;nonSensitiveFieldCount?:number;batches?:Array<{id:string;tableNames:string[];fieldCount:number}>;limits?:{maxTables:number;maxFields:number};modelingMode?:"off"|"review"|"auto_draft";autoConfirmScore?:number;llmTimeoutMs?:number;publishedSchemaVersionIdAtStart?:number|null;orchestrationId?:string|null;domainPlanId?:string|null;domainKey?:string|null;domainBatchIndex?:number|null;domainBatchCount?:number|null};
  catalogChecksum:string;baseSchemaVersionId:number|null;modelName:string|null;promptVersion:string;scoringVersion:string;
  catalogCurrent?:boolean;
  status:"queued"|"running"|"succeeded"|"failed"|"cancelled";progress:number;
  summary:{tableCount?:number;nonSensitiveFieldCount?:number;includedFieldCount?:number;truncatedFieldCount?:number;batchCount?:number;confirmedRelationCount?:number;includedRelationCount?:number;crossBatchRelationCount?:number;excludedSensitiveRelationCount?:number;excludedInvalidRelationCount?:number;candidateCount?:number;objectCount?:number;linkCount?:number;autoConfirmedCount?:number;reviewRequiredCount?:number;blockedCount?:number;normalizationIssueCount?:number;objectCoveredTableCount?:number;objectMissingTableCount?:number;objectMissingTables?:string[];lastSupplementalLinkError?:string|null};
  tokenUsage:{promptTokens?:number;completionTokens?:number;totalTokens?:number};error:string|null;createdBy:string;createdAt:string;startedAt:string|null;finishedAt:string|null;updatedAt:string;
};
export type OntologyGenerationRunPage={items:OntologyGenerationRun[];total:number;page:number;pageSize:number;totalPages:number};
export type OntologyGenerationTraceSummary={fileName:string;runId:string;batchId:string;modelName:string|null;promptVersion:string|null;durationMs:number;usage:{promptTokens?:number;completionTokens?:number;totalTokens?:number}|null;error:string|null;hasOutput:boolean;sizeBytes:number;updatedAt:string};
export type OntologyGenerationTraceDetail=OntologyGenerationTraceSummary&{messages:Array<{role:string;content:string}>;rawOutput:unknown};
export type OntologyCandidateStatus="generated"|"blocked"|"auto_confirmed"|"review_required"|"confirmed"|"rejected"|"superseded"|"applied";
export type OntologyCandidateScorePart={score:number;max:number;reason:string;similarity?:number|null;degradedReason?:string};
export type OntologyCalibrationLabel={candidateId:string;runId:string;sourceId:number;verdict:"correct"|"incorrect";majorModification:boolean;issueType:"physical_mapping"|"sensitive_mapping"|"unconfirmed_join"|"duplicate"|"semantic"|"missing_object"|"other"|null;note:string|null;labeledBy:string|null;labeledAt:string;derived?:boolean};
export type OntologyCandidate = {
  id:string;runId:string;sourceId:number;candidateType:"object"|"link";stableKey:string;payload:SemanticObjectType|SemanticLinkType;
  evidence:Array<Record<string,unknown>>;modelConfidence:number|null;score:number;
  scoreBreakdown:{physicalMapping?:OntologyCandidateScorePart;semanticConsistency?:OntologyCandidateScorePart;structuralEvidence?:OntologyCandidateScorePart;knowledgeEvidence?:OntologyCandidateScorePart;templateMatch?:OntologyCandidateScorePart;riskAdjustment?:OntologyCandidateScorePart};
  validation:SemanticSchemaValidation;status:OntologyCandidateStatus;forcedReviewReasons:string[];decisionNote:string|null;reviewedBy:string|null;reviewedAt:string|null;appliedSchemaVersionId:number|null;supersededById:string|null;createdAt:string;updatedAt:string;calibration?:OntologyCalibrationLabel|null;
};
export type OntologyCandidateEvent={id:number;candidateId:string;runId:string;sourceId:number;eventType:string;actor:string|null;fromStatus:OntologyCandidateStatus|null;toStatus:OntologyCandidateStatus|null;note:string|null;before:unknown;after:unknown;createdAt:string};
export type OntologyBulkDecisionResult={sourceId:number;decision:"confirm"|"reject"|"withdraw";total:number;succeeded:number;failed:number;results:Array<{id:string;ok:boolean;candidate?:OntologyCandidate;error?:string;status?:number}>};
export type OntologyConflictResolution="keep_existing"|"use_candidate";
export type OntologyDraftConflict={candidateId:string;candidateType:"object"|"link";stableKey:string;reason:string;existingApiName?:string;source?:string;target?:string;allowedResolutions:OntologyConflictResolution[];resolution:OntologyConflictResolution|"unresolved"};
export type OntologyDraftDiff=Pick<SemanticSchemaDiff,"ok"|"summary"|"changes">;
export type OntologyDraftPreview = {schema:SemanticSchema;validation:SemanticSchemaValidation;diff:OntologyDraftDiff;conflicts:OntologyDraftConflict[];excludedCandidateIds:string[];summary:{objectsAdded:number;propertiesAdded:number;linksAdded:number;renamedLinkCount?:number;candidateCount:number;conflictCount:number;resolvedConflictCount:number;unresolvedConflictCount:number;excludedCount:number}};
export type OntologyDraftApplyResult = Omit<OntologyDraftPreview,"schema"> & {draft:SemanticSchemaVersion};
export type OntologyDomainWorkflowSummary={
  orchestrationId:string;sourceId:number;taskStatus:BackgroundTask["status"];
  domainCount:number;succeededDomainCount:number;failedDomainCount:number;activeDomainCount:number;
  candidateCount:number;objectCount:number;linkCount:number;reviewRequiredCount:number;acceptedCount:number;appliedCount:number;blockedCount:number;rejectedCount:number;
  catalogCurrent:boolean;readyForDraft:boolean;baseSchemaVersionId:number|null;draftSchemaVersionId:number|null;draftValidationOk:boolean|null;repairable:boolean;
  activeTask:{id:string;status:BackgroundTask["status"];progress:number;total:number;currentStep:string|null;updatedAt:string}|null;
  nextReviewRun:{id:string;domainName:string;pendingCount:number}|null;
  failedDomains:Array<{domainId:string;domainName:string;error:string}>;
};
export type OntologyDomainDraftPreview=OntologyDraftPreview&{workflow:OntologyDomainWorkflowSummary};
export type OntologyDomainDraftApplyResult=OntologyDraftApplyResult&{workflow:OntologyDomainWorkflowSummary;partial:boolean};
export type OntologyDomainDraftRepairResult={draft:SemanticSchemaVersion;validation:SemanticSchemaValidation;summary?:OntologyDraftPreview["summary"];repairedFromVersionId:number;reused:boolean};
export type OntologyCalibrationCondition={id:string;label:string;passed:boolean;actual:number|boolean|null;target:string};
export type OntologyCalibrationReport={
  sourceId:number;runIds:string[];scoringVersion:string|null;promptVersion:string|null;mode:"off"|"review"|"auto_draft";autoConfirmScore:number;autoConfirmScoreSource:"source"|"global";
  thresholds:{minSamples:number;minPrecision:number;maxManualObjectRate:number;maxFailureRate:number;maxP95LatencyMs:number;maxAverageTokens:number};
  counts:{runs:number;staleRuns:number;excludedStaleRuns:number;candidates:number;objects:number;links:number;labels:number;invalidLabels:number;autoEligible:number;labeledAuto:number;correctAuto:number;unlabeledAuto:number;manualObjectCount:number;finalObjectCount:number};
  quality:{precision:number|null;physicalMappingErrors:number;sensitiveAutoConfirmed:number;unconfirmedJoinAutoConfirmed:number;autoWithdrawnCount:number;autoWithdrawnRate:number;duplicateCount:number;duplicateRate:number;modifiedCount:number;humanModificationRate:number;majorModificationCount:number;majorModificationRate:number;manualObjectRate:number};
  runtime:{callCount:number;failures:number;failureRate:number;totalTokens:number;averageTokens:number;averageLatencyMs:number;p95LatencyMs:number};
  downstream:{goldEquivalenceRate:number|null;semanticExecutionRate:number|null;joinFailureRate:number|null;draftsCreated:number;draftsPublished:number;draftPublicationRate:number|null;schemaValidationPassRate:number|null};
  scoreBuckets:Array<{range:string;total:number;labeled:number;accepted:number;acceptanceRate:number|null}>;
  issueTypeSummary:Array<{issueType:string;count:number;ratio:number}>;ruleSuggestions:Array<{issueType:string;sampleCount:number;count:number;ratio:number;action:string;forcedReviewReason:string;scorePenalty:number}>;
  thresholdSuggestion:{targetPrecision:number;suggestedScore:number|null;labeledCount:number;correctCount:number;precision:number|null};settingDraft:{sourceId:number;autoConfirmScore:number;runIds:string[]}|null;
  sourceSetting:{sourceId:number;autoConfirmScore:number;evidenceRunIds:string[];updatedBy:string|null;updatedAt:string;audit:Array<{id:number;oldValue:number|null;newValue:number;actor:string|null;createdAt:string}>}|null;
  draft:{id:number|null;version:number|null;validationOk:boolean;publishedCurrent:boolean};
  evalSets:Array<{setName:string;total:number;goldCount:number;heldOutCount:number;ready:boolean}>;
  evalGate:{id:string|null;passed:boolean;valid:boolean;setName:string|null;ontologySchemaVersion:number|null;ontologySchemaPublishedAt:string|null;evaluationChecksum:string|null;currentEvaluationChecksum:string;currentCaseCount:number;issues:Array<{code:string;message:string}>};
  conditions:OntologyCalibrationCondition[];passed:boolean;decision:"enable_auto_draft"|"keep_review";reason:string;labels:OntologyCalibrationLabel[];
};
export type OntologyCalibrationGate={id:string;sourceId:number;runIds:string[];draftSchemaVersionId:number|null;evalGateId:string|null;manualObjectCount:number;finalObjectCount:number;metrics:OntologyCalibrationReport;passed:boolean;decision:"enable_auto_draft"|"keep_review";reason:string;createdBy:string;createdAt:string;activatedBy:string|null;activatedAt:string|null};

export type MaskedSecret = { set:boolean; masked?:string };
export type QueryPromptKey = "agentSystem"|"agentQuestion"|"legacySqlPlanner"|"semanticPlanner"|"resultSummary";
export type QueryPromptMap = Record<QueryPromptKey,string>;
export type QueryPromptMeta = Record<QueryPromptKey,{label:string;description:string;variables:string[]}>;
export type SettingsData = {
  llm:{ baseUrl:string; apiKey:MaskedSecret; model:string };
  embedding:{ baseUrl:string; apiKey:MaskedSecret; model:string; dimensions:number|null };
  retrieval:{ vectorEnabled:boolean; topK:number; vectorWeight:number; minSimilarity:number; semanticThreshold:number };
  profiling:{enabled:boolean;sampleLimit:number;maxTablesPerRefresh:number;timeoutMs:number};
  query:{ semanticQueryPlanMode:"off"|"prefer"|"required"; queryAgentMode:"off"|"prefer"|"required"; queryAgentTrafficPercent:number; queryAgentMaxIterations:number; queryAgentMaxSqlCalls:number; queryAgentMaxScannedRows:number; queryAgentPendingTtlMs:number; queryMaxRows:number; explainMaxRows:number; queryTimeoutMs:number; queryLlmTimeoutMs:number };
  ontologyAi:{mode:"off"|"review"|"auto_draft";autoConfirmScore:number;maxTables:number;maxFields:number;timeoutMs:number;criticEnabled:boolean;calibrationMinSamples:number;calibrationMinPrecision:number;maxManualObjectRate:number;maxFailureRate:number;maxP95LatencyMs:number;maxAverageTokens:number};
  prompts:QueryPromptMap;
  promptMeta:QueryPromptMeta;
  promptDefaults:QueryPromptMap;
  sources:Record<string,"db"|"env"|"default"|"override">;
  locked:string[];
};
export type SettingsInput = {
  llm?:Partial<{ baseUrl:string|null; apiKey:string|null; model:string|null }>;
  embedding?:Partial<{ baseUrl:string|null; apiKey:string|null; model:string|null; dimensions:number|null }>;
  retrieval?:Partial<{ vectorEnabled:boolean; topK:number; vectorWeight:number; minSimilarity:number; semanticThreshold:number }>;
  profiling?:Partial<{enabled:boolean;sampleLimit:number;maxTablesPerRefresh:number;timeoutMs:number}>;
  query?:Partial<{ semanticQueryPlanMode:"off"|"prefer"|"required"; queryAgentMode:"off"|"prefer"|"required"; queryAgentTrafficPercent:number; queryAgentMaxIterations:number; queryAgentMaxSqlCalls:number; queryAgentMaxScannedRows:number; queryAgentPendingTtlMs:number; queryMaxRows:number; explainMaxRows:number; queryTimeoutMs:number; queryLlmTimeoutMs:number }>;
  ontologyAi?:Partial<{mode:"off"|"review"|"auto_draft";autoConfirmScore:number;maxTables:number;maxFields:number;timeoutMs:number;criticEnabled:boolean;calibrationMinSamples:number;calibrationMinPrecision:number;maxManualObjectRate:number;maxFailureRate:number;maxP95LatencyMs:number;maxAverageTokens:number}>;
  prompts?:Partial<Record<QueryPromptKey,string|null>>;
};
export type RelationDocumentAssertion={fromTable:string;fromColumn:string;toTable:string;toColumn:string;cardinality:string|null;evidenceQuote:string|null;accepted:boolean;reason:string|null;relationId:number|null;overlapRatio:number|null};
export type RelationDocument={id:string;sourceId:number;fileName:string;checksum:string;status:"processed"|"failed";assertions:RelationDocumentAssertion[];assertionCount:number;acceptedCount:number;rejectedCount:number;error:string|null;createdBy:string|null;createdAt:string;idempotent?:boolean};
export type ConnectionTestInput = { baseUrl?:string; apiKey?:string; model?:string; dimensions?:number|null };
export type ConnectionTestResult = { ok:boolean; latencyMs?:number; model?:string; dimensions?:number; error?:string };
