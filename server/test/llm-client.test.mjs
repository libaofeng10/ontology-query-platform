import assert from "node:assert/strict";
import test from "node:test";
import { callLlmJsonWithTrace, callLlmTools } from "../src/llm-client.mjs";

const llm={baseUrl:"https://model.test/v1",apiKey:"sk-valid-test-key",model:"tool-model"};
const tools=[{
  name:"search_context",
  description:"检索业务上下文",
  inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false},
}];

test("tool calls use the provider-native required mode",async()=>{
  let request;
  const fetchImpl=async(_url,init)=>{
    request=JSON.parse(init.body);
    return new Response(JSON.stringify({
      choices:[{message:{content:"先检索相关业务定义。",tool_calls:[{type:"function",function:{name:"search_context",arguments:'{"query":"新增用户"}'}}]}}],
      usage:{prompt_tokens:12,completion_tokens:5,total_tokens:17},
    }),{status:200});
  };

  const action=await callLlmTools(llm,[{role:"user",content:"查询新增用户"}],tools,{fetchImpl});

  assert.equal(request.tool_choice,"required");
  assert.equal(request.tools[0].function.name,"search_context");
  assert.equal(request.response_format,undefined);
  assert.deepEqual(action,{
    thought:"先检索相关业务定义。",
    tool:"search_context",
    args:{query:"新增用户"},
    usage:{promptTokens:12,completionTokens:5,totalTokens:17},
  });
});

test("tool calls accept wrapped JSON actions from compatible providers",async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({
    thought:"检索用户口径。",
    tool_call:{name:"search_context",arguments:{query:"试用用户"}},
  })}}]}),{status:200});

  const action=await callLlmTools(llm,[],tools,{fetchImpl});

  assert.equal(action.tool,"search_context");
  assert.deepEqual(action.args,{query:"试用用户"});
});

test("tool calls still reject names outside the allowlist",async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{tool_calls:[{type:"function",function:{name:"raw_database",arguments:"{}"}}]}}]}),{status:200});

  await assert.rejects(()=>callLlmTools(llm,[],tools,{fetchImpl}),/未授权工具：raw_database/);
});

test("JSON calls can return raw output and normalized usage for generation audit",async()=>{
  const raw='{"candidates":[]}';
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:raw}}],usage:{prompt_tokens:7,completion_tokens:3,total_tokens:10}}),{status:200});
  const result=await callLlmJsonWithTrace(llm,[{role:"user",content:"generate"}],{fetchImpl});
  assert.deepEqual(result.value,{candidates:[]});assert.equal(result.rawContent,raw);assert.equal(result.usage.totalTokens,10);
});

test("invalid JSON errors retain raw output for restricted audit",async()=>{
  const fetchImpl=async()=>new Response(JSON.stringify({choices:[{message:{content:"not-json"}}],usage:{total_tokens:4}}),{status:200});
  await assert.rejects(()=>callLlmJsonWithTrace(llm,[],{fetchImpl}),error=>{assert.equal(error.rawContent,"not-json");assert.equal(error.usage.totalTokens,4);return /合法 JSON/.test(error.message);});
});
