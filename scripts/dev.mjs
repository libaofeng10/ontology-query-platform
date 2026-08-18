import { spawn } from "node:child_process";

const children = [
  spawn("npm", ["run", "dev:api"], { stdio: "inherit", shell: false }),
  spawn("npm", ["run", "dev:web"], { stdio: "inherit", shell: false }),
];

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill(signal);
}

for (const child of children) {
  child.on("exit", (code) => {
    if (!stopping && code !== 0) {
      stop();
      process.exitCode = code ?? 1;
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
