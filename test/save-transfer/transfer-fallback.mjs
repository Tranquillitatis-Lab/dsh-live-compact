// When the transferList postMessage is refused, the task must fall back to the
// structured-clone path and still succeed; with the switch off no transfer is
// attempted at all.
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { default: Engine } = await import("../../index.js");
const saveShadowBodyAsync = Engine.prototype.saveShadowBodyAsync;
assert.equal(typeof saveShadowBodyAsync, "function");

const nativePostMessage = Worker.prototype.postMessage;
let transferAttempts = 0;
let clonePosts = 0;
Worker.prototype.postMessage = function patchedPostMessage(message, transferList) {
  if (Array.isArray(transferList) && transferList.length > 0) {
    transferAttempts += 1;
    const error = new Error("simulated transfer refusal");
    error.name = "DataCloneError";
    throw error;
  }
  clonePosts += 1;
  return nativePostMessage.call(this, message, transferList);
};

const host = () => ({
  ctx: { logger: { info() {}, warn() {} } },
  warnShadowFull() {},
  warnShadowOversize() {},
});
const body = "transfer-fallback-marker 回退路径\n".repeat(20000);
const previous = new Map([
  ["SPINE_SHADOW_DIR", process.env.SPINE_SHADOW_DIR],
  ["SPINE_SAVE_TRANSFER", process.env.SPINE_SAVE_TRANSFER],
  ["SPINE_SHADOW_MAX_BYTES", process.env.SPINE_SHADOW_MAX_BYTES],
]);
process.env.SPINE_SHADOW_MAX_BYTES = String(256 * 1024 * 1024);

async function run(transfer) {
  const root = mkdtempSync(join(tmpdir(), "spine-save-transfer-fb-"));
  process.env.SPINE_SHADOW_DIR = root;
  process.env.SPINE_SAVE_TRANSFER = transfer;
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
  const refused = await run("1");
  assert.ok(transferAttempts >= 1, "transfer path must have been attempted");
  assert.ok(clonePosts >= 1, "fallback clone post must have happened");
  assert.equal(Buffer.compare(refused, Buffer.from(body, "utf8")), 0, "fallback save bytes must match");
  const attemptsAfterOn = transferAttempts;
  const plain = await run("0");
  assert.equal(transferAttempts, attemptsAfterOn, "switch off must not attempt transfer");
  assert.equal(Buffer.compare(plain, refused), 0, "clone-path bytes must match");
  console.log(`pass save-transfer fallback attempts=${transferAttempts} clonePosts=${clonePosts}`);
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
