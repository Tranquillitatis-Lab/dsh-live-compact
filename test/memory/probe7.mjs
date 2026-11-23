// 探针7：验证 process.report.getReport().workers 能否反映 worker_threads 存活状态。
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime, gcNow } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wc = () => {
  const rep = process.report.getReport();
  const list = rep.workers;
  return Array.isArray(list) ? list.length : String(typeof list);
};
console.log("bare: before=", wc());
const w = new Worker("setInterval(() => {}, 1000)", { eval: true });
await sleep(300);
console.log("bare: spawned=", wc());
await w.terminate();
await sleep(300);
console.log("bare: terminated=", wc());

const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe7-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
console.log("engine: before-cut=", wc());
await engine.finishTurn(f.agent(), undefined, { maintenanceRetry: true });
console.log("engine: after-cut=", wc());
await h.dispose();
console.log("engine: post-dispose+0ms=", wc());
await sleep(1000);
console.log("engine: post-dispose+1s=", wc());
await sleep(2000);
console.log("engine: post-dispose+3s=", wc());
process.exit(0);
