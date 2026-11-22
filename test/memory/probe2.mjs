// 探针2：对照验证 getActiveResourcesInfo 是否报告 Worker；并观察并发会话下的警告文本。
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { loadSrc, makeFixture, makeRuntime } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));

// 对照组：裸 worker_threads
const ctl = new Worker("setInterval(() => {}, 1000);", { eval: true });
await new Promise((res) => ctl.once("online", res));
await new Promise((r) => setTimeout(r, 100));
console.log("对照 Worker 存活时:", JSON.stringify(process.getActiveResourcesInfo()));
ctl.terminate();
await new Promise((r) => setTimeout(r, 50));
console.log("对照 Worker 终止后:", JSON.stringify(process.getActiveResourcesInfo()));

// 引擎组：6 会话并发突发
const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const fixtures = [];
for (let i = 0; i < 6; i++) {
  const f = h.use(makeFixture({ totalTokens: 24000, id: `probe2-${i}` }));
  for (const seq of f.session.snapshotEvents?.() ?? []) {
    const ev = f.session.eventAt?.(seq);
    if (ev) engine.noteEvent(f.session, ev);
  }
  fixtures.push(f);
}
const text = "W".repeat(256 * 1024 - 32);
for (let wave = 0; wave < 2; wave++) {
  await Promise.all(fixtures.map(async (f, i) => {
    const seqs = f.round(`w${wave}-${i}`, { name: "read", tokens: 13000, text, turn: wave + 2 });
    for (const seq of seqs) {
      const ev = f.session.eventAt?.(seq);
      if (!ev) continue;
      engine.noteEvent(f.session, ev);
      if (ev.type === "tool/result") engine.captureOne(f.session, ev);
    }
    await engine.finishTurn(f.agent());
  }));
  const res = process.getActiveResourcesInfo();
  console.log(`wave ${wave}: Worker=${res.filter((x) => x === "Worker").length} all=[${[...new Set(res)].join(",")}]`);
}
console.log("warnings(", h.warnings.length, "):");
for (const wn of h.warnings.slice(0, 12)) console.log("  -", typeof wn === "string" ? wn : JSON.stringify(wn));
try {
  for (const d of readdirSync(join(here, ".tmp"))) {
    const full = join(here, ".tmp", d);
    let names = []; try { names = readdirSync(full); } catch {}
    console.log("tmpdir:", d, "->", names.slice(0, 8).join(" | "));
  }
} catch (e) { console.log("tmpdir fail:", e.message); }
await h.dispose();
console.log("dispose后:", JSON.stringify(process.getActiveResourcesInfo()));
process.exit(0);
