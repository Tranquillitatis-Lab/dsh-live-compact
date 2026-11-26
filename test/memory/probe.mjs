// 探针：观察 shadow 保存路径是否真正启用 worker 线程、警告文本、shadow 目录落盘证据。
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe-0" }));
h.capture(engine, f);

function captureSeq(seqs) {
  for (const seq of seqs) {
    const event = f.session.eventAt?.(seq);
    if (!event) continue;
    engine.noteEvent(f.session, event);
    if (event.type === "tool/result") engine.captureOne(f.session, event);
  }
}
function resSnapshot(tag) {
  const res = process.getActiveResourcesInfo();
  const workers = res.filter((x) => x === "Worker").length;
  const timers = res.filter((x) => x === "Timeout").length;
  console.log(`[${tag}] Worker=${workers} Timeout=${timers} types=[${[...new Set(res)].join(",")}]`);
}

// 阶段1：64KB 负载 × 6 轮
let text = "P".repeat(64 * 1024 - 32);
for (let r = 0; r < 6; r++) {
  captureSeq(f.round(`p-${r}`, { name: "read", tokens: 13000, text, turn: r + 2 }));
  await engine.finishTurn(f.agent());
  resSnapshot(`64k round ${r}`);
}
console.log("阶段1 warnings:", JSON.stringify(h.warnings));
console.log("阶段1 infos:", JSON.stringify(h.infos.slice(0, 8)));
try {
  for (const d of readdirSync(join(here, ".tmp"))) {
    const full = join(here, ".tmp", d);
    let names = []; try { names = readdirSync(full); } catch {}
    console.log("tmpdir:", d, "files:", names.length, names.slice(0, 6).join(" | "));
  }
} catch (e) { console.log("tmpdir read fail:", e.message); }

// 阶段2：4MB 负载 × 3 轮
h.warnings.length = 0;
text = "Q".repeat(4 * 1024 * 1024 - 32);
for (let r = 0; r < 3; r++) {
  captureSeq(f.round(`big-${r}`, { name: "read", tokens: 13000, text, turn: r + 10 }));
  await engine.finishTurn(f.agent());
  resSnapshot(`4m round ${r}`);
}
console.log("阶段2 warnings:", JSON.stringify(h.warnings));
await h.dispose();
console.log("dispose后 Worker=", process.getActiveResourcesInfo().filter((x) => x === "Worker").length);
process.exit(0);
