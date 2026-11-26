// 探针5：逐轮用超时赛跑 finishTurn，判断 cut 停止是「挂起」还是「提前返回」。
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime, gcNow } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
console.log("report keys:", Object.keys(process.report.getReport()).join(","));
const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe5-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let stopped = -1;
for (let r = 0; r < 30; r++) {
  for (const seq of f.round(`c-${r}`, { name: "read", tokens: 13000, text, turn: r + 2 })) {
    const ev = f.session.eventAt?.(seq);
    if (!ev) continue;
    engine.noteEvent(f.session, ev);
    if (ev.type === "tool/result") engine.captureOne(f.session, ev);
  }
  const res = await Promise.race([
    engine.finishTurn(f.agent()).then((v) => `ok:${v}`),
    sleep(3000).then(() => "TIMEOUT"),
  ]);
  gcNow(2);
  const workers = engine.shadowWorkers ? engine.shadowWorkers.size : -1;
  const pending = engine.pendingCaptures ? engine.pendingCaptures.size : -1;
  console.log(`r=${r} finishTurn=${res} cuts=${f.summaries().length} workers=${workers} pending=${pending} warn=${h.warnings.length} infos=${h.infos.length}`);
  if (res === "TIMEOUT") { stopped = r; break; }
}
console.log("warnings:", JSON.stringify(h.warnings.slice(0, 8)));
console.log("last infos:", JSON.stringify(h.infos.slice(-4)));
if (stopped >= 0) {
  await sleep(1000);
  const workers = engine.shadowWorkers ? engine.shadowWorkers.size : -1;
  console.log(`超时后 workers=${workers} pending=${engine.pendingCaptures?.size}`);
  for (const [k, entry] of engine.shadowWorkers ?? []) {
    console.log("worker entry:", k, JSON.stringify(Object.keys(entry)));
  }
}
await h.dispose();
process.exit(0);
