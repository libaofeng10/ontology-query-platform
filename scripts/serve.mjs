import { spawn } from "node:child_process";

const children=[
  spawn("npm",["run","start"],{stdio:"inherit",env:{...process.env,PORT:process.env.WEB_PORT||"3000"}}),
  spawn(process.execPath,["server/src/server.mjs"],{stdio:"inherit",env:process.env}),
];
let stopping=false;
function stop(signal="SIGTERM") { if(stopping)return;stopping=true;for(const child of children)if(!child.killed)child.kill(signal); }
for(const child of children)child.on("exit",(code,signal)=>{if(!stopping){console.error(`服务子进程退出：code=${code} signal=${signal||"none"}`);stop();process.exitCode=code||1;}});
process.on("SIGINT",()=>stop("SIGINT"));process.on("SIGTERM",()=>stop("SIGTERM"));
