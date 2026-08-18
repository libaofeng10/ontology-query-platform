import assert from "node:assert/strict";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } }, { waitUntil() {}, passThroughOnException() {} });
}

test("server-renders the OntoQuery workspace", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<title>OntoQuery · 本体驱动智能问数平台<\/title>/i);
  assert.match(html, /正在读取平台状态/);
  assert.match(html, /问数工作台/);
  assert.match(html, /数据源/);
  assert.match(html, /本体图谱/);
  assert.match(html, /业务对象建模/);
  assert.match(html, /这里只显示 SQLite 与数据源返回的真实数据/);
  assert.doesNotMatch(html, /7 月有效客户达到|目标已达到|demo-user/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Your site is taking shape/);
});
