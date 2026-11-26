// 探针3v2：逐轮观察 cut 触发与 heap；用 pwsh 采样进程线程数验证 worker 存活/退出。
import { dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadSrc, makeFixture, makeRuntime, gcNow } from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const threadCount = () => {
  try {
    return parseInt(execSync(`pwsh -NoProfile -Command "(Get-Process -Id ${process.pid}).Threads.Count"`, { encoding: "utf8" }).trim(), 10);
  } catch (e) { return -1; }
};
const src = await loadSrc(repoRoot);
const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
const { engine } = h.engine({}, "local");
const f = h.use(makeFixture({ totalTokens: 24000, id: "probe3-0" }));
h.capture(engine, f);
const text = "C".repeat(64 * 1024 - 32);
console.log("启动线程数:", threadCount());
let lastSum = 0, lastInfo = 0;
for (let r = 0; r < 40; r++) {
  for (const seq of f.round(`c-${r}`, { name: "read", tokens: 13000, text, turn: r + 2 })) {
    const ev = f.session.eventAt?.(seq);
    if (!ev) continue;
    engine.noteEvent(f.session, ev);
    if (ev.type === "tool/result") engine.captureOne(f.session, ev);
  }
  await engine.finishTurn(f.agent());
  gcNow(2);
  const m = process.memoryUsage();
  const s = f.summaries().length;
  const infos = h.infos.length;
  if (r < 10 || s !== lastSum || r % 5 === 0) {
    console.log(`r=${r} heap=${(m.heapUsed / 1048576).toFixed(2)}MB cuts=${s}(+${s - lastSum}) infos+${infos - lastInfo} warn=${h.warnings.length} threads=${threadCount()}`);
  }
  lastSum = s; lastInfo = infos;
}
console.log("末段 infos:", JSON.stringify(h.infos.slice(-3)));
console.log("warnings:", JSON.stringify(h.warnings.slice(0, 6)));
const thBefore = threadCount();
await h.dispose();
gcNow(2);
await new Promise((r) => setTimeout(r, 300));
const thAfter = threadCount();
console.log(`线程数: dispose前=${thBefore} dispose后=${thAfter}`);
try {
  const d = readdirSync(join(here, ".tmp"))[0];
  console.log("shadow目录:", d, "条目:", readdirSync(join(here, ".tmp", d)).length);
} catch (e) { console.log("tmpdir:", e.message); }
process.exit(0);
