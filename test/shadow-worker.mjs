import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

const root = mkdtempSync(join(tmpdir(), "spine-worker-"));
try {
  const file = join(root, "session", "cut-1-11111111.txt");
  const worker = new Worker(new URL("../shadow-save-worker.mjs", import.meta.url), {
    workerData: {
      shadow: root,
      file,
      body: "# spine-session session\nworker regression\n",
      required: true,
      protectPaths: [],
      sessionKey: "session",
      cap: 1024 * 1024,
      access: {},
      rotationIO: {},
    },
  });
  const message = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  await worker.terminate();
  assert.equal(message.ok, true);
  assert.equal(message.result.ok, true);
  assert.equal(existsSync(file), true);
  assert.equal(readFileSync(file, "utf8").includes("worker regression"), true);
} finally {
  rmSync(root, { recursive: true, force: true });
}
