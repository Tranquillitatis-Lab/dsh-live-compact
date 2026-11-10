import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "spine-worker-pool-"));
const previous = new Map([
  ["SPINE_SHADOW_DIR", process.env.SPINE_SHADOW_DIR],
  ["SPINE_SHADOW_MAX_BYTES", process.env.SPINE_SHADOW_MAX_BYTES],
]);
process.env.SPINE_SHADOW_DIR = root;
process.env.SPINE_SHADOW_MAX_BYTES = String(16 * 1024 * 1024);

try {
  const { default: SpineCompactionEngine } = await import("../index.js");
  const saveShadowAsync = SpineCompactionEngine.prototype.saveShadowAsync;
  const logs = [];
  const host = {
    ctx: { logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) } },
    warnShadowFull: (...args) => logs.push(args),
    warnShadowOversize: (...args) => logs.push(args),
  };
  const messages = [{ role: "user", content: "pooled worker regression" }];
  const files = Array.from({ length: 4 }, (_, index) =>
    join(root, "pool-session", `cut-${index + 1}-aaaaaaaa.txt`));

  const results = await Promise.all(files.map((file) => saveShadowAsync.call(
    host,
    messages,
    true,
    file,
    "pool-session",
  )));
  assert.equal(results.length, files.length);
  for (const [index, result] of results.entries()) {
    assert.equal(result.ok, true, `pooled request ${index + 1} completed`);
    assert.equal(result.file, files[index]);
    assert.equal(existsSync(files[index]), true);
    assert.match(readFileSync(files[index], "utf8"), /pooled worker regression/);
  }

  await new Promise((resolve) => setTimeout(resolve, 700));
  const reusedFile = join(root, "pool-session", "cut-reused-bbbbbbbb.txt");
  const reused = await saveShadowAsync.call(host, messages, true, reusedFile, "pool-session");
  assert.equal(reused.ok, true, "idle worker can be recreated and reused");
  assert.equal(existsSync(reusedFile), true);
  assert.match(readFileSync(reusedFile, "utf8"), /pooled worker regression/);
  console.log(`pass shadow worker pool concurrent=${files.length} idle-reuse=true`);
} finally {
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
