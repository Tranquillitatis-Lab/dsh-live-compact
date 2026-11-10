import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [installed, shadowRoot] = process.argv.slice(2);
assert.ok(installed && shadowRoot, "usage: hard-11k.mjs INSTALLED_PACKAGE SHADOW_ROOT");
process.env.SPINE_SHADOW_DIR = shadowRoot;
mkdirSync(shadowRoot, { recursive: true });

const shadow = await import(pathToFileURL(join(installed, "shadow.js")).href);
const { rotateShadow, isPluginShadowName } = shadow;
const index = await import(pathToFileURL(join(installed, "index.js")).href);
const saveShadowAsync = index.default.prototype.saveShadowAsync;
const sessionCount = 20;
const fileCount = 11078;
const passes = 8;
const cap = 256 * 1024 * 1024;
const filesPerSession = Math.floor(fileCount / sessionCount);
const remainder = fileCount % sessionCount;
let created = 0;
for (let session = 0; session < sessionCount; session += 1) {
  const dir = join(shadowRoot, `session-${String(session + 1).padStart(2, "0")}`);
  mkdirSync(dir, { recursive: true });
  const count = filesPerSession + (session < remainder ? 1 : 0);
  for (let index = 0; index < count; index += 1) {
    const suffix = `${session.toString(16).padStart(2, "0")}${index.toString(16).padStart(6, "0")}`;
    const file = join(dir, `cut-${index + 1}-${suffix}.txt`);
    writeFileSync(file, `# spine-session session-${session + 1}\ntelemetry ${created}\n`);
    created += 1;
  }
}
assert.equal(created, fileCount);

const counters = { readdir: 0, stat: 0 };
const readdir = (...args) => { counters.readdir += 1; return readdirSync(...args); };
const stat = (...args) => { counters.stat += 1; return statSync(...args); };
const durations = [];
const results = [];
let maxGapMs = 0;
let previous = Date.now();
const watchdog = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - previous - 10);
  previous = now;
}, 10);
for (let pass = 0; pass < passes; pass += 1) {
  const beforeRead = counters.readdir;
  const beforeStat = counters.stat;
  const started = performance.now();
  const result = rotateShadow({
    dir: shadowRoot,
    incomingBytes: 0,
    cap,
    readdir,
    stat,
  });
  const elapsedMs = performance.now() - started;
  assert.equal(result.ok, true, `shared scan ${pass + 1} must complete`);
  assert.equal(result.estimated, undefined, "shared root must not use an estimate");
  durations.push(elapsedMs);
  results.push({ pass: pass + 1, elapsedMs: Number(elapsedMs.toFixed(2)), used: result.used, deleted: result.deleted, freed: result.freed, readdir: counters.readdir - beforeRead, stat: counters.stat - beforeStat });
  await yieldImmediate();
}
clearInterval(watchdog);

const sorted = [...durations].sort((a, b) => a - b);
const percentile = (ratio) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
const workerDurations = [];
let workerMaxGapMs = 0;
let workerPrevious = Date.now();
const workerWatchdog = setInterval(() => {
  const now = Date.now();
  workerMaxGapMs = Math.max(workerMaxGapMs, now - workerPrevious - 10);
  workerPrevious = now;
}, 10);
for (let pass = 0; pass < passes; pass += 1) {
  const started = performance.now();
  const worker = new Worker(new URL("./shadow-save-worker.mjs", pathToFileURL(join(installed, "shadow-save-worker.mjs")).href), {
    workerData: {
      shadow: shadowRoot,
      file: join(shadowRoot, "worker-session", "cut-worker-11111111.txt"),
      body: `# spine-session worker-session\nworker telemetry ${pass}\n`,
      required: true,
      protectPaths: [],
      sessionKey: "worker-session",
      cap,
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
  assert.equal(message.result?.ok, true);
  workerDurations.push(performance.now() - started);
  await yieldImmediate();
}
clearInterval(workerWatchdog);
const workerSorted = [...workerDurations].sort((a, b) => a - b);
const workerPercentile = (ratio) => workerSorted[Math.min(workerSorted.length - 1, Math.ceil(workerSorted.length * ratio) - 1)];
assert.equal(results.length, passes);
assert.equal(results.reduce((sum, row) => sum + row.stat, 0) > fileCount, true);

const externalWriter = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "external-writer.mjs"), shadowRoot, "320"], {
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
let externalStdout = "";
let externalStderr = "";
externalWriter.stdout.on("data", (data) => { externalStdout += data; });
externalWriter.stderr.on("data", (data) => { externalStderr += data; });
let externalMaxGapMs = 0;
let externalPrevious = Date.now();
const externalWatchdog = setInterval(() => {
  const now = Date.now();
  externalMaxGapMs = Math.max(externalMaxGapMs, now - externalPrevious - 10);
  externalPrevious = now;
}, 10);
const externalResults = [];
const externalHost = {
  ctx: { logger: { info() {}, warn() {} } },
  warnShadowFull() {},
  warnShadowOversize() {},
};
process.env.SPINE_SHADOW_DIR = shadowRoot;
process.env.SPINE_SHADOW_MAX_BYTES = String(cap);
for (let pass = 0; pass < passes; pass += 1) {
  const files = Array.from({ length: 2 }, (_, index) => join(shadowRoot, "pooled-external", `cut-${pass + 1}-${index + 1}-ffffffff.txt`));
  const started = performance.now();
  const saved = await Promise.all(files.map((file) => saveShadowAsync.call(
    externalHost,
    [{ role: "user", content: `pooled external pass ${pass}` }],
    true,
    file,
    "pooled-external",
  )));
  for (const result of saved) assert.equal(result.ok, true, "pooled writer transaction under external mutation");
  externalResults.push({ pass: pass + 1, elapsedMs: Number((performance.now() - started).toFixed(2)), files: saved.length });
  await yieldImmediate();
}
clearInterval(externalWatchdog);
const externalExit = await new Promise((resolve, reject) => {
  let settled = false;
  const finish = (code) => {
    if (settled) return;
    settled = true;
    resolve(code);
  };
  externalWriter.once("error", reject);
  // Windows ARM can close one stdio pipe without delivering the child's
  // `close` event before Node decides an unresolved top-level await is exit 13.
  // The process `exit` event is sufficient here because stdout/stderr are
  // bounded diagnostics and are already drained by the listeners above.
  externalWriter.once("exit", (code) => finish(code));
});
assert.equal(externalExit, 0, `external writer exited ${externalExit}: ${externalStderr}`);
const externalSummary = JSON.parse(externalStdout.trim().split(/\r?\n/).at(-1));
assert.equal(externalSummary.status, "PASS");
const invalidFiles = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const file = join(dir, name);
    const info = statSync(file);
    if (info.isDirectory()) walk(file);
    else if (name.endsWith(".tmp") || (name.endsWith(".txt") && info.size === 0)) invalidFiles.push(file);
  }
};
walk(shadowRoot);
assert.deepEqual(invalidFiles, [], "external mutations leave no empty or temporary backup");
const externalRootLockLeaked = existsSync(join(shadowRoot, ".spine-rotation.lock"));
assert.equal(externalRootLockLeaked, false, "external matrix releases root lock");
// Keep the SIGKILL probe out of the event-loop measurements above.  A bounded
// synchronous wait is intentional here: on Windows a spawned child can close
// one stdio handle without delivering the asynchronous exit/close event, which
// otherwise leaves this top-level await unresolved and makes Node exit 13.
const crashResult = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "crash-writer.mjs"), installed, shadowRoot], {
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  timeout: 30000,
  maxBuffer: 1024 * 1024,
});
const crashStderr = crashResult.stderr?.toString() ?? "";
assert.equal(crashResult.error, undefined, `crash writer did not exit cleanly: ${crashResult.error?.message ?? "unknown error"}`);
const crashExit = { code: crashResult.status, signal: crashResult.signal };
assert.ok(crashExit.code !== 0 || crashExit.signal, `crash writer unexpectedly succeeded: ${crashStderr}`);
const crashLock = join(shadowRoot, ".spine-rotation.lock");
assert.equal(existsSync(crashLock), true, "SIGKILL leaves the rotation fence");
const recovered = rotateShadow({ dir: shadowRoot, incomingBytes: 0, cap, readdir, stat });
assert.equal(recovered.ok, true, "post-SIGKILL rotation recovers with a full scan");
assert.equal(recovered.estimated, undefined, "post-SIGKILL rotation stays fail-closed");
const crashTarget = join(shadowRoot, "post-crash", "cut-post-crash-ffffffff.txt");
const crashSaved = await saveShadowAsync.call(
  externalHost,
  [{ role: "user", content: "post crash pooled writer" }],
  true,
  crashTarget,
  "post-crash",
);
assert.equal(crashSaved.ok, true, "pooled writer resumes after SIGKILL recovery");
assert.equal(existsSync(crashTarget), true);
console.log(JSON.stringify({
  stage: "hard-11k",
  status: "PASS",
  sessions: sessionCount,
  files: fileCount,
  passes,
  fullScanCount: passes,
  readdirCalls: counters.readdir,
  statCalls: counters.stat,
  p50Ms: Number(percentile(0.50).toFixed(2)),
  p95Ms: Number(percentile(0.95).toFixed(2)),
  p99Ms: Number(percentile(0.99).toFixed(2)),
  maxGapMs,
  workerPasses: passes,
  workerP50Ms: Number(workerPercentile(0.50).toFixed(2)),
  workerP95Ms: Number(workerPercentile(0.95).toFixed(2)),
  workerP99Ms: Number(workerPercentile(0.99).toFixed(2)),
  workerMaxGapMs,
  externalWriter: {
    ...externalSummary,
    workerPasses: externalResults.length,
    maxWorkerElapsedMs: Math.max(...externalResults.map((row) => row.elapsedMs)),
    maxGapMs: externalMaxGapMs,
    invalidFiles: invalidFiles.length,
    rootLockLeaked: externalRootLockLeaked,
  },
  sigkill: {
    status: "PASS",
    crashExit,
    recoveredUsed: recovered.used,
    recoveredEstimated: recovered.estimated,
    savedAfterCrash: crashSaved.ok,
    fencePresent: existsSync(crashLock),
  },
  results,
  rootMode: "shared-default-full-scan",
  estimateUsed: false,
  pluginNameCheck: isPluginShadowName("cut-1-00000000.txt"),
}));
