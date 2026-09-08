import assert from "node:assert/strict";
import test from "node:test";
import { createOntologyCandidateVerifier, mechanicalVerification, validateVerification, verificationInput, verificationMessages } from "../src/ontology-candidate-verifier.mjs";
import { ontologyCandidateCriticInternal } from "../src/ontology-candidate-critic.mjs";

const input={candidateId:"c1",candidateType:"link",risks:[],requirements:["definition"],requiredRelationIds:["relation:1"],requiredEndpointIds:["endpoint:customer","endpoint:order"],evidence:[{id:"relation:1",kind:"confirmed_relation",status:"confirmed"},{id:"endpoint:customer",kind:"accepted_object",hasMeaning:true},{id:"endpoint:order",kind:"accepted_object",hasMeaning:true}]};
const supported=value=>({candidateId:value.candidateId,decision:"supported",explanation:"订单的客户字段绑定已确认客户标识，两端定义与字段说明一致。",question:null,supports:value.requirements.map(claim=>({claim,evidenceIds:value.evidence.map(item=>item.id),reason:"物理关联及两端定义支撑此业务含义。"}))});

test("正向核验必须覆盖全部关联、端点和风险，不能只判断没有矛盾",()=>{
  assert.equal(validateVerification(supported(input),input).decision,"supported");
  for(const raw of [{consistent:true},{decision:"supported",explanation:"没有明显矛盾"},{...supported(input),supports:[]},{...supported(input),question:"客户指账号还是联系人？"}])assert.equal(validateVerification(raw,input).decision,"system_error");
  const missing=supported(input);missing.supports[0].evidenceIds.pop();assert.equal(validateVerification(missing,input).decision,"system_error");
  const fabricated=supported(input);fabricated.supports[0].evidenceIds.push("knowledge:invented");assert.equal(validateVerification(fabricated,input).decision,"system_error");
  const risk={...input,risks:["MODIFIES_BASE_SCHEMA"],requirements:["definition","MODIFIES_BASE_SCHEMA"]};assert.equal(validateVerification(supported(input),risk).decision,"system_error");
  assert.equal(validateVerification(supported(risk),risk).decision,"system_error","变更必须比对当前版本");
});

test("模型不能覆盖物理结构约束，真实业务问题必须具体且引用证据",()=>{
  const unsafe={...input,risks:["TEMPORAL_EVIDENCE_MISSING"],requirements:["definition","TEMPORAL_EVIDENCE_MISSING"]};
  assert.equal(validateVerification(supported(unsafe),unsafe).decision,"system_error");
  assert.equal(mechanicalVerification({status:"review_required",validation:{ok:true}},unsafe).decision,"system_repair");
  assert.equal(validateVerification({...supported(input),decision:"business_question",question:"请补充业务说明"},input).decision,"system_error");
  assert.equal(validateVerification({...supported(input),decision:"business_question",question:"订单客户指下单账号还是实际付款人？两个字段分别记录了不同主体。"},input).decision,"business_question");
});

test("模型漏项、重复、未知 ID 及服务失败均为系统任务，不会默认为通过",async()=>{
  for(const results of [[],[supported(input),supported(input)],[{...supported(input),candidateId:"unknown"}],null]){
    const verifier=createOntologyCandidateVerifier({llm:{baseUrl:"https://model.test",apiKey:"key",model:"model"},callJson:async()=>({results})});
    assert.equal((await verifier.inspect([input])).results.get("c1").decision,"system_error");
  }
  const offline=createOntologyCandidateVerifier({llm:{}});assert.match((await offline.inspect([input])).results.get("c1").explanation,/尚未配置/);
  const critic=ontologyCandidateCriticInternal.normalize({results:[{candidateId:"duplicate",consistent:true},{candidateId:"duplicate",consistent:false}]},new Set(["missing","duplicate"]));
  assert.ok(critic.every(item=>item.consistent===null));
  assert.match(verificationMessages([])[0].content,/不可信数据/);
});

test("核验分批计量，保留已完成批次而隔离失败批次",async()=>{
  let calls=0;
  const verifier=createOntologyCandidateVerifier({llm:{baseUrl:"https://model.test",apiKey:"key",model:"model"},callJson:async(_llm,messages)=>{
    calls++;if(calls===2)throw new Error("网络错误");
    const batch=JSON.parse(messages[1].content.match(/<untrusted_input>(.*)<\/untrusted_input>/)[1]);return {results:batch.map(supported),__usage:{promptTokens:10,completionTokens:20,totalTokens:30}};
  }});
  const result=await verifier.inspect(Array.from({length:5},(_,i)=>({...input,candidateId:`c${i}`})));
  assert.equal(result.calls,2);assert.equal(result.tokenUsage.totalTokens,30);assert.equal(result.results.get("c0").decision,"supported");assert.equal(result.results.get("c4").decision,"system_error");
});

test("核验提示说明双向标签的语义，不向模型暴露内部证据权重标记",()=>{
  const messages=verificationMessages([input]),serialized=JSON.parse(messages[1].content.match(/<untrusted_input>(.*)<\/untrusted_input>/)[1]);
  assert.ok(serialized[0].evidence.every(item=>!Object.hasOwn(item,"hasMeaning")));
  assert.match(messages[0].content,/sourceLabel 是源到目标的关系名称/);assert.match(messages[0].content,/不是端点对象名称/);
  assert.match(messages[0].content,/低匹配率本身不能推翻已确认关系/);
});

test("跨域补边与已有定义同名但映射不同属于系统命名修复",()=>{
  const current={...input,definition:{apiName:"links",relationMappings:[{relationId:1}]},evidence:[...input.evidence,{id:"published_definition",kind:"published_definition",definition:{apiName:"links",relationMappings:[{relationId:2}]}}]};
  const candidate={status:"review_required",candidateType:"link",validation:{ok:true},payload:current.definition};
  assert.equal(mechanicalVerification(candidate,current,{run:{scope:{scopeKind:"global_links"}}}).decision,"system_repair");
  assert.equal(mechanicalVerification(candidate,current,{run:{scope:{}}}),null,"普通定义修改不擅自决定新增路径");
});

test("证据由目录构造，丢弃业务样本和未验证知识，版本变化使结论失效",()=>{
  const candidate={id:"c1",candidateType:"object",payload:{apiName:"customer",properties:[{mapping:{table:"customer",column:"id"}}]},evidence:[],validation:{ok:true}};
  const context={run:{id:"run",scope:{},sourceId:2},base:null,acceptedObjects:[],catalog:{tables:[{tableName:"customer",comment:"客户"}],columnsByTable:{customer:[{columnName:"id",comment:"客户编号",profile:{sampleValues:["PRIVATE_SAMPLE"]}}]},relations:[]},knowledgePages:[{id:1,verified:false,tables:["customer"],content:"UNVERIFIED"},{id:2,verified:true,tables:["customer"],content:"一行一个客户",checksum:"k1"}]};
  const before=verificationInput(candidate,context);assert.doesNotMatch(JSON.stringify(before),/PRIVATE_SAMPLE|UNVERIFIED/);
  candidate.evidence=[{kind:"automatic_verification",inputChecksum:before.inputChecksum}];assert.equal(verificationInput(candidate,context).inputChecksum,before.inputChecksum);
  context.knowledgePages[1].content="客户可拥有多个账号";assert.notEqual(verificationInput(candidate,context).inputChecksum,before.inputChecksum);
});
