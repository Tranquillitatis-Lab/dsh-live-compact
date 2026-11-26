// 40 concurrent saves with SPINE_SAVE_TRANSFER=1 exceed the 32-task inflight
// window, so the FIFO waiter queue is exercised; every save must land its own
// file with exact bytes (no task loss, no cross-contamination).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: Engine } = await import("../../index.js");
const saveShadowBodyAsync = Engine.prototype.saveShadowBodyAsync;
assert.equal(typeof saveShadowBodyAsync, "function");

const host = () => ({
  ctx: { logger: { info() {}, warn() {} } },
  warnShadowFull() {},
  warnShadowOversize() {},
});
const previous = new Map([
  ["SPINE_SHADOW_DIR", process.env.SPINE_SHADOW_DIR],
  ["SPINE_SAVE_TRANSFER", process.env.SPINE_SAVE_TRANSFER],
  ["SPINE_SHADOW_MAX_BYTES", process.env.SPINE_SHADOW_MAX_BYTES],
]);
process.env.SPINE_SHADOW_MAX_BYTES = String(256 * 1024 * 1024);
process.env.SPINE_SAVE_TRANSFER = "1";
const root = mkdtempSync(join(tmpdir(), "spine-save-transfer-conc-"));
process.env.SPINE_SHADOW_DIR = root;

let failed = false;
try {
  const total = 40;
  const bodies = [];
  for (let index = 0; index < total; index += 1) {
    const line = `concurrent-${String(index).padStart(2, "0")}-${"x".repeat(48)}\n`;
    bodies.push(line.repeat(Math.ceil((512 * 1024) / line.length)));
  }
  const files = bodies.map((_, index) => join(root, "session", `cut-${index + 1}-${String(10000000 + index)}.txt`));
  const settled = await Promise.all(bodies.map((body, index) =>
    saveShadowBodyAsync.call(host(), body, true, files[index], "session", [], {}).then(
      (result) => ({ index, result }),
      (error) => ({ index, error }),
    )));
  const broken = settled.filter((item) => item.error || item.result?.ok !== true);
  assert.equal(broken.length, 0, `all saves must succeed: ${broken.map((item) => `${item.index}:${item.error?.code || item.error?.message || item.result}`).join(", ")}`);
  for (let index = 0; index < total; index += 1) {
    const written = readFileSync(files[index]);
    assert.equal(Buffer.compare(written, Buffer.from(bodies[index], "utf8")), 0, `file ${index} must match its own body bytes`);
  }
  console.log(`pass save-transfer concurrency total=${total}`);
} catch (error) {
  failed = true;
  console.error(error?.stack || error);
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(failed ? 1 : 0);
