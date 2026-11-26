import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

// This subprocess controls the real index.js pool through the builtin Worker
// seam. Production code and public exports need no test-only hooks.
const require = createRequire(import.meta.url);
const threads = require("node:worker_threads");
const workers = [];
let retired;
class FakeWorker extends EventEmitter {
  constructor() { super(); this.posts = []; workers.push(this); }
  postMessage(message) { this.posts.push(message); }
  terminate() { retired?.(); return Promise.resolve(1); }
  complete(index) {
    const request = this.posts[index];
    this.emit("message", { id: request.id, ok: true, result: { ok: true, file: request.payload.file } });
  }
}
threads.Worker = FakeWorker;
syncBuiltinESMExports();
const deadline = setTimeout(() => { throw new Error("worker lifecycle did not settle"); }, 4000);
try {
  const { default: Engine } = await import("../../index.js");
  const root = join(tmpdir(), `spine-pool-lifecycle-${process.pid}`);
  process.env.SPINE_SHADOW_DIR = root;
  const host = { ctx: { logger: { warn() {}, info() {} } } };
  const save = (name) => Engine.prototype.saveShadowAsync.call(host, [], true, join(root, name), "test");
  const first = save("first.txt");
  const old = workers[0];
  old.complete(0);
  await first;
  await new Promise((resolve) => { retired = resolve; });
  retired = null;

  const second = save("second.txt");
  const replacement = workers[1];
  old.emit("exit", 1);
  const third = save("third.txt");
  assert.equal(workers.length, 2, "old worker exit must preserve its replacement");
  assert.equal(replacement.posts.length, 2);
  replacement.complete(0);
  replacement.complete(1);
  await Promise.all([second, third]);

  replacement.emit("exit", 0);
  const pending = save("pending.txt");
  assert.equal(workers.length, 3, "an idle exited worker must be replaced");
  workers[2].emit("exit", 0);
  await assert.rejects(pending, { code: "ESHADOWWORKER" });
  const final = save("final.txt");
  assert.equal(workers.length, 4, "a failed worker must be replaced");
  workers[3].complete(0);
  await final;
  workers[3].emit("exit", 0);
  console.log("pass shadow pool lifecycle");
} finally {
  clearTimeout(deadline);
}
