// SPINE_SAVE_TRANSFER: transfer=1 (transferList zero-copy) must produce
// byte-identical shadow files to transfer=0 (structured clone) for the same body.
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
const body = "transfer-basic-marker 零拷贝一致性\n".repeat(30000);
const previous = new Map([
  ["SPINE_SHADOW_DIR", process.env.SPINE_SHADOW_DIR],
  ["SPINE_SAVE_TRANSFER", process.env.SPINE_SAVE_TRANSFER],
  ["SPINE_SHADOW_MAX_BYTES", process.env.SPINE_SHADOW_MAX_BYTES],
]);
process.env.SPINE_SHADOW_MAX_BYTES = String(256 * 1024 * 1024);

async function run(transfer) {
  const root = mkdtempSync(join(tmpdir(), "spine-save-transfer-"));
  process.env.SPINE_SHADOW_DIR = root;
  process.env.SPINE_SAVE_TRANSFER = transfer ? "1" : "0";
  try {
    const file = join(root, "session", "cut-1-11111111.txt");
    const result = await saveShadowBodyAsync.call(host(), body, true, file, "session", [], {});
    assert.equal(result?.ok, true, `transfer=${transfer} save must succeed`);
    return readFileSync(file);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

let failed = false;
try {
  const cloned = await run(false);
  const transferred = await run(true);
  assert.ok(cloned.byteLength > 500000, "body must be large enough to matter");
  assert.equal(Buffer.compare(cloned, transferred), 0, "transferred save must be byte-identical to the clone save");
  assert.equal(Buffer.compare(transferred, Buffer.from(body, "utf8")), 0, "file bytes must equal the body string");
  console.log(`pass save-transfer basic bytes=${transferred.byteLength}`);
} catch (error) {
  failed = true;
  console.error(error?.stack || error);
} finally {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
await new Promise((resolve) => setTimeout(resolve, 100));
process.exit(failed ? 1 : 0);
