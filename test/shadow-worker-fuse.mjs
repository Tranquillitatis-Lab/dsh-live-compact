import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  attachShadowAccessFuse, defaultShadowAccessRunner, resetShadowAccessState,
  shadowAccessFuseBuffer, shadowAccessFused,
} from "../shadow.js";

const require = createRequire(import.meta.url);
const threads = require("node:worker_threads");
const NativeWorker = threads.Worker;
const root = mkdtempSync(join(tmpdir(), "spine-worker-fuse-"));
const previousRoot = process.env.SPINE_SHADOW_DIR;
process.env.SPINE_SHADOW_DIR = root;
const probes = [];
const managed = [];
const deadline = setTimeout(() => { throw new Error("shared shadow fuse regression timed out"); }, 10000);
const trip = () => assert.throws(() => defaultShadowAccessRunner({
  path: root, kind: "dir", platform: "win32", env: {},
}), { code: "ESHADOWACCESS" });
const request = async (worker, action) => {
  const response = once(worker, "message");
  worker.postMessage({ action });
  return (await response)[0];
};
async function probe(checkGate) {
  const worker = new NativeWorker(new URL("./fixtures/shadow-fuse-probe.mjs", import.meta.url), {
    workerData: { root, accessFuse: shadowAccessFuseBuffer(), checkGate },
  });
  probes.push(worker);
  const [ready] = await once(worker, "message");
  return { worker, ready };
}

try {
  resetShadowAccessState();
  const checkGate = new SharedArrayBuffer(4);
  const first = await probe(checkGate);
  assert.equal(first.ready.fused, false);
  const waiting = once(first.worker, "message");
  first.worker.postMessage({ action: "check" });
  assert.equal((await waiting)[0].waiting, true, "request reaches the barrier before the fuse trips");
  trip();
  const response = once(first.worker, "message");
  Atomics.store(new Int32Array(checkGate), 0, 1);
  Atomics.notify(new Int32Array(checkGate), 0);
  const [checked] = await response;
  assert.equal(checked.fusedBeforeCheck, true, "an in-flight worker observes parent failure before the next check");
  assert.equal(checked.code, "ESHADOWACCESS");
  assert.equal(checked.calls, 0, "worker refuses before another ACL helper");
  await first.worker.terminate();

  resetShadowAccessState();
  const second = await probe();
  assert.equal((await request(second.worker, "trip")).code, "ESHADOWACCESS");
  assert.equal(shadowAccessFused(), true, "worker failure reaches parent");
  await second.worker.terminate();
  const replacement = await probe();
  assert.equal(replacement.ready.fused, true, "a new worker inherits the existing fuse");
  await replacement.worker.terminate();

  assert.throws(() => attachShadowAccessFuse(new ArrayBuffer(4)), TypeError);
  assert.throws(() => attachShadowAccessFuse(new SharedArrayBuffer(8)), TypeError);
  const merged = new SharedArrayBuffer(4);
  attachShadowAccessFuse(merged);
  assert.equal(Atomics.load(new Int32Array(merged), 0), 1, "attach never clears a previous failure");
  resetShadowAccessState();
  assert.equal(shadowAccessFuseBuffer(), merged, "reset preserves buffer identity");

  // Track actual managed workers without replacing their execution.
  threads.Worker = class extends NativeWorker {
    constructor(...args) { super(...args); managed.push(this); }
  };
  syncBuiltinESMExports();
  const { default: Engine } = await import("../index.js");
  const host = { ctx: { logger: { warn() {}, info() {} } }, warnShadowFull() {}, warnShadowOversize() {} };
  const save = (access) => Engine.prototype.saveShadowAsync.call(
    host, [{ role: "user", content: "fuse must refuse this backup" }], true,
    join(root, "session", "cut-fused-aaaaaaaa.txt"), "session", [], access,
  );
  trip();
  await assert.rejects(save({ platform: "win32", invalid: Symbol("must-not-be-serialized") }), { code: "ESHADOWACCESS" });
  assert.equal(managed.length, 0, "already fused parent never dispatches a worker");

  resetShadowAccessState();
  await assert.rejects(save({ platform: "win32", env: {} }), { code: "ESHADOWACCESS" });
  assert.equal(managed.length, 1);
  assert.equal(shadowAccessFused(), true, "real save worker propagates its fuse immediately");
  await once(managed[0], "exit");
  await assert.rejects(save({ platform: "win32", invalid: Symbol("must-stay-fused") }), { code: "ESHADOWACCESS" });
  assert.equal(managed.length, 1, "idle retirement cannot clear the parent fuse");
  assert.equal(existsSync(join(root, "session", "cut-fused-aaaaaaaa.txt")), false);
  console.log("pass shared shadow fuse: parent/worker barriers, native worker failure, idle retirement");
} finally {
  clearTimeout(deadline);
  await Promise.all([...probes, ...managed].map(worker => worker.terminate()));
  threads.Worker = NativeWorker;
  syncBuiltinESMExports();
  resetShadowAccessState();
  if (previousRoot === undefined) delete process.env.SPINE_SHADOW_DIR;
  else process.env.SPINE_SHADOW_DIR = previousRoot;
  rmSync(root, { recursive: true, force: true });
}
