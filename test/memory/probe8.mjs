// 探针8：report.workers 对 unref worker 是否失明；引擎 shadow worker 生命周期曲线。
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wc = () => process.report.getReport().workers?.length ?? -1;
const tc = () => {
  try {
    return Number(execSync(`pwsh -NoProfile -Command "(Get-Process -Id ${process.pid}).Threads.Count"`, { encoding: "utf8" }).trim());
  } catch { return -1; }
};
import { execSync } from "node:child_process";

const w1 = new Worker("setInterval(() => {}, 1000)", { eval: true });
await sleep(200);
console.log("ref worker: report=", wc(), "threads=", tc());
const w2 = new Worker("setInterval(() => {}, 1000)", { eval: true });
w2.unref();
await sleep(200);
console.log("unref worker: report=", wc(), "threads=", tc());
await w1.terminate();
await w2.terminate();
await sleep(200);
console.log("both terminated: report=", wc(), "threads=", tc());

const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe8-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
console.log("engine base: report=", wc(), "threads=", tc());
await engine.finishTurn(f.agent(), undefined, { maintenanceRetry: true });
console.log("after cut+0ms: report=", wc(), "threads=", tc());
await sleep(500);
console.log("after cut+500ms: report=", wc(), "threads=", tc());
await h.dispose();
console.log("post-dispose+0ms: report=", wc(), "threads=", tc());
await sleep(1000);
console.log("post-dispose+1s: report=", wc(), "threads=", tc());
await sleep(2000);
console.log("post-dispose+3s: report=", wc(), "threads=", tc());
process.exit(0);
