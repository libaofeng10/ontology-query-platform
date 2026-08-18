import mysql from "mysql2/promise";
import { decryptCredential } from "./crypto.mjs";

export function createConnector({ appSecret, timeoutMs, mysqlClient=mysql }) {
  const pools = new Map();
  const resolveTimeout = () => { const value=typeof timeoutMs==="function"?Number(timeoutMs()):Number(timeoutMs); return Number.isFinite(value)&&value>0?value:30_000; };

  function configFor(source) {
    return {
      host:source.host, port:source.port, database:source.dbName, user:source.userName,
      password:decryptCredential(source.credential,appSecret), waitForConnections:true,
      connectionLimit:3, queueLimit:10, connectTimeout:Math.min(resolveTimeout(),10_000),
      enableKeepAlive:true, multipleStatements:false, timezone:"Z", dateStrings:true,
    };
  }

  function poolFor(source) {
    if (!pools.has(source.id)) pools.set(source.id, mysqlClient.createPool(configFor(source)));
    return pools.get(source.id);
  }

  async function test(source) {
    if (source.isDemo) return { ok:true, readOnly:true, server:"demo", latencyMs:1 };
    const started = Date.now();
    const pool = poolFor(source);
    const connection = await pool.getConnection();
    let writeDenied = false;
    let readOnlyVariable = null;
    try {
      const [rows] = await connection.query("SELECT VERSION() AS version, @@global.read_only AS global_read_only");
      readOnlyVariable = Boolean(rows[0]?.global_read_only);
      try {
        await connection.query("CREATE TEMPORARY TABLE ontoquery_readonly_probe (id INT)");
        await connection.query("DROP TEMPORARY TABLE IF EXISTS ontoquery_readonly_probe");
      } catch { writeDenied = true; }
      if (!writeDenied) throw new Error("账号拥有 CREATE TEMPORARY TABLE 权限，不满足物理只读要求");
      return { ok:true, readOnly:true, server:rows[0]?.version, globalReadOnly:readOnlyVariable, latencyMs:Date.now()-started };
    } finally { connection.release(); }
  }

  async function query(source, sql, params = [], signal) {
    if (source.isDemo) throw new Error("演示数据源不接受任意 SQL 执行");
    const pool = poolFor(source);
    for(let attempt=0;attempt<2;attempt++) {
      try { return await executeOnce(pool,sql,params,signal,resolveTimeout()); }
      catch(error) {
        if(attempt===0&&!signal?.aborted&&isTransientConnectionError(error)) continue;
        throw error;
      }
    }
    throw new Error("数据库查询重试失败");
  }

  async function explain(source, sql, signal) {
    const [rows] = await query(source, `EXPLAIN ${sql}`, [], signal);
    return rows;
  }

  async function close() { await Promise.all([...pools.values()].map((pool)=>pool.end())); pools.clear(); }
  async function invalidate(sourceId) { const pool=pools.get(Number(sourceId));if(pool){pools.delete(Number(sourceId));await pool.end();} }
  return { poolFor, test, query, explain, invalidate, close };
}

async function executeOnce(pool,sql,params,signal,timeoutMs) {
  if(signal?.aborted) throw abortError();
  const connection=await pool.getConnection();
  let timer;
  let timedOut=false;
  let aborted=false;
  const abort=()=>{aborted=true;connection.destroy();};
  signal?.addEventListener("abort",abort,{once:true});
  try {
    const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{timedOut=true;connection.destroy();reject(timeoutError(timeoutMs));},timeoutMs);});
    return await Promise.race([connection.execute(sql,params),deadline]);
  } catch(error) {
    if(timedOut) throw timeoutError(timeoutMs);
    if(aborted||signal?.aborted) throw abortError();
    if(isTransientConnectionError(error)) connection.destroy();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort",abort);
    if(!timedOut&&!aborted&&connection.connection?._closing!==true) connection.release();
  }
}

function isTransientConnectionError(error) { return ["ECONNRESET","EPIPE","ETIMEDOUT","PROTOCOL_CONNECTION_LOST"].includes(error?.code); }
function timeoutError(timeoutMs) { const error=new Error(`数据库查询超过 ${timeoutMs}ms，已终止`);error.code="QUERY_TIMEOUT";return error; }
function abortError() { const error=new Error("数据库查询已取消");error.name="AbortError";error.code="ABORT_ERR";return error; }
