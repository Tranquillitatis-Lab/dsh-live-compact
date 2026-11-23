// With SPINE_SAVE_TRANSFER=1 a tripped shadow fuse must refuse saves before
// dispatch, and after resetShadowAccessState() the transfer path must recover.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultShadowAccessRunner, resetShadowAccessState } from "../../shadow.js";

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
const root = mkdtempSync(join(tmpdir(), "spine-save-transfer-fuse-"));
process.env.SPINE_SHADOW_DIR = root;
const trip = () => assert.throws(() => defaultShadowAccessRunner({
  path: root, kind: "dir", platform: "win32", env: {},
}), { code: "ESHADOWACCESS" });

let failed = false;
try {
  const file = join(root, "session", "cut-fused-cccccccc.txt");
  const body = "fuse-recovery-marker 熔断恢复\n".repeat(20000);
  resetShadowAccessState();
  trip();
  await assert.rejects(
    saveShadowBodyAsync.call(host(), body, true, file, "session", [], { platform: "win32" }),
    { code: "ESHADOWACCESS" },
  );
  assert.equal(existsSync(file), false, "fused save must not write the file");
  resetShadowAccessState();
  const result = await saveShadowBodyAsync.call(host(), body, true, file, "session", [], {});
  assert.equal(result?.ok, true, "recovered save must succeed");
  assert.equal(Buffer.compare(readFileSync(file), Buffer.from(body, "utf8")), 0, "recovered bytes must match");
  console.log("pass save-transfer fuse recovery");
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
