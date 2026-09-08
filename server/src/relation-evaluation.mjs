import { relationKey, relationPairs, reverseRelation } from "./physical-relation.mjs";

export function validateRelationTruth(truth){
  if(truth?.version!=="relation-truth-v1"||typeof truth.complete!=="boolean"||!Array.isArray(truth.tables)||!truth.tables.length||!Array.isArray(truth.relations))throw new Error("真值需要 version=relation-truth-v1、complete、非空 tables 和 relations");
  const tables=new Set(truth.tables),seen=new Set();
  for(const relation of truth.relations){
    relationPairs(relation);
    if(!tables.has(relation.fromTable)||!tables.has(relation.toTable)||!["relation","none"].includes(relation.label))throw new Error("真值关系必须在选表范围内，label 为 relation 或 none");
    const key=undirectedKey(relation);if(seen.has(key))throw new Error("真值中不能重复或反向重复标注同一关系");seen.add(key);
  }
  return truth;
}

export function evaluateRelationDiscovery({truth,candidates=[],predictions=[],threshold=.55,diagnostics={},prices=null}){
  validateRelationTruth(truth);
  if(!Number.isFinite(threshold)||threshold<0||threshold>1)throw new Error("评测阈值必须为 0～1");
  const labels=new Map(truth.relations.map(relation=>[undirectedKey(relation),relation]));
  const positive=[...labels].filter(([,relation])=>relation.label==="relation");
  const proposed=new Set(candidates.map(undirectedKey)),selected=new Map();
  for(const prediction of predictions){
    if(prediction.decision!=="relation"||!Number.isFinite(prediction.confidence)||prediction.confidence<threshold||prediction.confidence>1)continue;
    const key=undirectedKey(prediction),previous=selected.get(key);
    if(!previous||previous.confidence<prediction.confidence)selected.set(key,prediction);
  }
  let truePositiveCount=0,falsePositiveCount=0,unlabelledPredictionCount=0,directionCorrect=0,cardinalityCorrect=0,cardinalityLabelCount=0;
  for(const [key,prediction] of selected){
    const label=labels.get(key);
    if(label?.label==="relation"){
      truePositiveCount++;const sameDirection=relationKey(label)===relationKey(prediction);if(sameDirection)directionCorrect++;
      if(label.cardinality&&label.cardinality!=="unknown"){cardinalityLabelCount++;const observed=sameDirection?prediction.cardinality:reverseCardinality(prediction.cardinality);if(observed===label.cardinality)cardinalityCorrect++;}
    }else if(label?.label==="none"||truth.complete)falsePositiveCount++;else unlabelledPredictionCount++;
  }
  const labelledPrecision=ratio(truePositiveCount,truePositiveCount+falsePositiveCount),labelledRecall=ratio(truePositiveCount,positive.length);
  const usage=diagnostics.usage||null,completeUsage=Boolean(usage?.calls&&usage.calls===usage.reportedCalls);
  const validPrices=prices&&[prices.inputUsdPerMillion,prices.outputUsdPerMillion].every(value=>Number.isFinite(value)&&value>=0);
  return {name:truth.name||"relation-evaluation",truthComplete:truth.complete,threshold,truthPositiveCount:positive.length,predictedPositiveCount:selected.size,truePositiveCount,falsePositiveCount,falseNegativeCount:positive.length-truePositiveCount,unlabelledPredictionCount,
    candidateRecall:ratio(positive.filter(([key])=>proposed.has(key)).length,positive.length),labelledPrecision,labelledRecall,
    precision:unlabelledPredictionCount?null:labelledPrecision,recall:truth.complete?labelledRecall:null,
    directionAccuracy:ratio(directionCorrect,truePositiveCount),cardinalityAccuracy:ratio(cardinalityCorrect,cardinalityLabelCount),
    elapsedMs:Number.isFinite(diagnostics.elapsedMs)?diagnostics.elapsedMs:null,queryCount:diagnostics.queryCount??null,usage,
    tokenCostUsd:completeUsage&&validPrices?(usage.promptTokens*prices.inputUsdPerMillion+usage.completionTokens*prices.outputUsdPerMillion)/1_000_000:null,
    missedRelations:positive.filter(([key])=>!selected.has(key)).map(([,relation])=>relationKey(relation)),
  };
}

export function buildRelationReview({truth,candidates=[],predictions=[],threshold=.55}){
  validateRelationTruth(truth);
  const proposed=new Map(candidates.map(item=>[undirectedKey(item),item]));
  const observed=new Map();for(const item of predictions){const key=undirectedKey(item),prior=observed.get(key);if(!prior||(item.confidence||0)>(prior.confidence||0))observed.set(key,item);}
  const labels=new Map(truth.relations.map(item=>[undirectedKey(item),item]));
  const items=[];
  for(const [key,label] of labels){
    const prediction=observed.get(key),candidate=proposed.get(key);
    let category;
    if(label.label==="relation"){
      if(!candidate)category="not_proposed";
      else if(!prediction||prediction.judgmentComplete===false||!prediction.decision)category="unjudged";
      else if(prediction.decision==="uncertain")category="uncertain";
      else if(prediction.decision==="none")category="model_negative";
      else if(prediction.confidence<threshold)category="below_threshold";
      else{
        const same=relationKey(label)===relationKey(prediction);
        const cardinality=same?prediction.cardinality:reverseCardinality(prediction.cardinality);
        if(!same||label.cardinality&&label.cardinality!=="unknown"&&label.cardinality!==cardinality)category="direction_or_cardinality";
      }
    }else if(prediction?.decision==="relation"&&prediction.confidence>=threshold)category="labelled_negative_conflict";
    if(category)items.push({category,reference:label,prediction:prediction||null,candidate:candidate||null});
  }
  for(const [key,prediction] of observed)if(!labels.has(key)&&prediction.decision==="relation"&&prediction.confidence>=threshold)items.push({category:truth.complete?"unlisted_positive_conflict":"unlabelled_prediction",reference:null,prediction,candidate:proposed.get(key)||null});
  return {version:"relation-review-v1",truthComplete:truth.complete,threshold,
    note:"差异是待核验事项，不自动认定历史标注或模型判断正确；需独立业务证据。",
    counts:Object.fromEntries([...new Set(items.map(item=>item.category))].map(category=>[category,items.filter(item=>item.category===category).length])),items};
}

function undirectedKey(relation){return [relationKey(relation),relationKey(reverseRelation(relation))].sort()[0];}
function reverseCardinality(value){return ({"1:1":"1:1","N:1":"1:N","1:N":"N:1","N:N":"N:N"})[value]||"unknown";}
function ratio(numerator,denominator){return denominator?numerator/denominator:null;}
