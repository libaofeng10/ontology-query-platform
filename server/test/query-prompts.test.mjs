import assert from "node:assert/strict";
import test from "node:test";
import { QUERY_PROMPT_DEFAULTS, QUERY_PROMPT_SPECS, renderQueryPrompt, validateQueryPrompt } from "../src/query-prompts.mjs";
import { _internal as queryInternal } from "../src/query-service.mjs";
import { _internal as agentInternal } from "../src/query-agent-loop.mjs";

test("all query prompt defaults contain their declared variables",()=>{
  for(const [key,spec] of Object.entries(QUERY_PROMPT_SPECS)) {
    assert.equal(validateQueryPrompt(key,QUERY_PROMPT_DEFAULTS[key]),QUERY_PROMPT_DEFAULTS[key].trim());
    for(const variable of spec.required)assert.match(spec.default,new RegExp(`\\{\\{${variable}\\}\\}`));
  }
});

test("query prompt renderer replaces variables and leaves no declared placeholders",()=>{
  const rendered=renderQueryPrompt("问题={{question}}；行数={{rowCount}}；空={{missing}}",{question:"所有账号",rowCount:2});
  assert.equal(rendered,"问题=所有账号；行数=2；空=");
});

test("query prompt validation rejects blank, oversized, unknown, and missing variables",()=>{
  assert.throws(()=>validateQueryPrompt("agentQuestion","   "),/不能为空/);
  assert.throws(()=>validateQueryPrompt("agentQuestion",`{{context}}${"x".repeat(40_001)}`),/不能超过 40000/);
  assert.throws(()=>validateQueryPrompt("agentQuestion","{{context}} {{badName}}"),/未知变量/);
  assert.throws(()=>validateQueryPrompt("agentQuestion","没有变量"),/缺少必需变量/);
});

test("every query model stage uses the supplied custom template",async()=>{
  const llm={baseUrl:"http://prompt.test/v1",apiKey:"secret",model:"prompt-model"};
  const requests=[];
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return new Response(JSON.stringify({choices:[{message:{content:"{}"}}]}),{status:200});};
  try {
    const context={tables:[],columns:{},relations:[],rules:[],knowledge:[]};
    await queryInternal.planSql(llm,"问题",context,[],"",1_000,undefined,false,`LEGACY_MARK\n${QUERY_PROMPT_DEFAULTS.legacySqlPlanner}`);
    await queryInternal.planSemanticQuery(llm,"问题",{objectTypes:[],linkTypes:[]},{},context,[],"",1_000,undefined,`SEMANTIC_MARK\n${QUERY_PROMPT_DEFAULTS.semanticPlanner}`);
    await queryInternal.summarize(llm,"问题","SELECT 1",[{value:1}],1_000,undefined,`SUMMARY_MARK\n${QUERY_PROMPT_DEFAULTS.resultSummary}`);
    assert.match(requests[0].messages.at(-1).content,/LEGACY_MARK/);
    assert.match(requests[1].messages.at(-1).content,/SEMANTIC_MARK/);
    assert.match(requests[2].messages.at(-1).content,/SUMMARY_MARK/);
    assert.match(agentInternal.agentSystemPrompt({maxIterations:8,maxSqlCalls:5,maxScannedRows:100},`AGENT_MARK {{maxIterations}} {{maxSqlCalls}} {{maxScannedRows}}`),/AGENT_MARK 8 5 100/);
    assert.match(agentInternal.agentQuestionPrompt("问题",context,[],null,"QUESTION_MARK {{context}}"),/QUESTION_MARK.*"question":"问题"/);
  } finally { globalThis.fetch=originalFetch; }
});
