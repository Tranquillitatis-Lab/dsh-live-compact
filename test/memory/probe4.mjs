// 探针4：30 轮后读取 spine-decisions.jsonl / spine-cuts.jsonl，找出 cut 停止的真实原因。
import { dirname, join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime, gcNow } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const src = await loadSrc(repoRoot);
const rootDir = join(here, ".tmp");
const h = makeRuntime({ src, rootDir });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe4-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
for (let r = 0; r < 30; r++) {
  for (const seq of f.round(`c-${r}`, { name: "read", tokens: 13000, text, turn: r + 2 })) {
    const ev = f.session.eventAt?.(seq);
    if (!ev) continue;
    engine.noteEvent(f.session, ev);
    if (ev.type === "tool/result") engine.captureOne(f.session, ev);
  }
  await engine.finishTurn(f.agent());
  gcNow(2);
}
console.log("cuts =", f.summaries().length);
const dirs = readdirSync(rootDir).filter((d) => d.startsWith("mem-"));
for (const d of dirs) {
  const full = join(rootDir, d);
  let entries = []; try { entries = readdirSync(full); } catch {}
  console.log("runtime dir:", d, "entries:", entries.join(" | "));
  const dec = join(full, "spine-decisions.jsonl");
  try {
    const lines = readFileSync(dec, "utf8").trim().split("\n");
    console.log("decisions 总数:", lines.length, "末 12 条:");
    for (const l of lines.slice(-12)) console.log("  ", l.slice(0, 220));
  } catch (e) { console.log("decisions 读取失败:", e.message); }
  const cuts = join(full, "spine-cuts.jsonl");
  try {
    const lines = readFileSync(cuts, "utf8").trim().split("\n");
    console.log("cuts.jsonl 总数:", lines.length, "末 3 条:");
    for (const l of lines.slice(-3)) console.log("  ", l.slice(0, 200));
  } catch (e) { console.log("cuts 读取失败:", e.message); }
  const sess = join(full, "probe4-0");
  try {
    const se = readdirSync(sess);
    console.log("session shadow 目录条目(", se.length, "):", se.slice(0, 10).join(" | "));
  } catch (e) { console.log("session dir:", e.message); }
}
await h.dispose();
process.exit(0);
