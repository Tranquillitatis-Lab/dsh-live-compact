// 探针6：定位 cut 停止点 —— 逐轮记录事件数，并测试 maintenanceRetry 是否恢复切割。
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime, gcNow } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
console.log("engine own keys:", Object.keys(engine).filter((k) => /state|catch|pending|worker|warm/i.test(k)).join(","));
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe6-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
for (let r = 0; r < 30; r++) {
  for (const seq of f.round(`c-${r}`, { name: "read", tokens: 13000, text, turn: r + 2 })) {
    const ev = f.session.eventAt?.(seq);
    if (!ev) continue;
    engine.noteEvent(f.session, ev);
    if (ev.type === "tool/result") engine.captureOne(f.session, ev);
  }
  const nEvents = f.session.snapshotEvents().length;
  const opts = r < 20 ? {} : { maintenanceRetry: true };
  const res = await engine.finishTurn(f.agent(), undefined, opts);
  gcNow(2);
  const measure = f.measure();
  console.log(`r=${r} opts=${JSON.stringify(opts)} ret=${res} events=${nEvents} surface=${measure.nodes.length} total=${measure.totalTokens} cuts=${f.summaries().length}`);
}
console.log("warnings:", JSON.stringify(h.warnings.slice(0, 6)));
await h.dispose();
process.exit(0);
