import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [installed, shadowRoot] = process.argv.slice(2);
assert.ok(installed && shadowRoot, "usage: hard-11k.mjs INSTALLED_PACKAGE SHADOW_ROOT");
let phase = "loading";
const enterPhase = (name) => { phase = name; console.error(`HARD11K_PHASE ${name}`); };
process.once("beforeExit", () => {
  if (phase !== "complete") console.error(`HARD11K_UNSETTLED phase=${phase} resources=${JSON.stringify(process.getActiveResourcesInfo())}`);
});
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
enterPhase("fixture");
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
enterPhase("sync-scans");
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
  enterPhase(`one-shot-worker-${pass + 1}`);
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

const externalSummaryFile = join(shadowRoot, "external-writer-summary.json");
const externalWriter = spawn(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "external-writer.mjs"), shadowRoot, "320", externalSummaryFile], {
  stdio: ["ignore", "ignore", "ignore"],
  windowsHide: true,
});
// Install observers before any await: a fast child can finish during the saves.
const externalCompletion = new Promise((resolve) => {
  let settled = false;
  let timedOut = false;
  let reapTimer;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(reapTimer);
    resolve(result);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    externalWriter.kill("SIGKILL");
    reapTimer = setTimeout(() => finish({ timedOut: true, reapTimedOut: true }), 5000);
  }, 30000);
  externalWriter.once("error", (error) => finish({ error }));
  externalWriter.once("exit", (code, signal) => finish({ code, signal, timedOut }));
});
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
  enterPhase(`pooled-external-${pass + 1}`);
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
enterPhase("external-completion");
const externalWait = await externalCompletion;
assert.equal(externalWait.error, undefined, `external writer failed: ${externalWait.error?.message ?? "unknown error"}`);
assert.equal(externalWait.timedOut, false, "external writer summary timed out");
assert.equal(externalWait.code, 0, `external writer exited ${externalWait.code}`);
assert.equal(externalWait.signal, null, "external writer must exit without a signal");
const externalSummary = JSON.parse(readFileSync(externalSummaryFile, "utf8"));
assert.equal(externalSummary.status, "PASS");
assert.equal(externalSummary.created, 320);
assert.equal(externalSummary.overwritten, 160);
assert.equal(externalSummary.renamed + externalSummary.deleted + externalSummary.races, 171);
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
enterPhase("crash-writer");
// Keep the SIGKILL probe out of the event-loop measurements above.  A bounded
// synchronous wait is limited to the crash probe, outside latency measurements.
const crashResult = spawnSync(process.execPath, [join(dirname(fileURLToPath(import.meta.url)), "crash-writer.mjs"), installed, shadowRoot], {
  stdio: ["ignore", "ignore", "pipe"],
  windowsHide: true,
  timeout: 30000,
  maxBuffer: 1024 * 1024,
});
const crashStderr = crashResult.stderr?.toString() ?? "";
assert.equal(crashResult.error, undefined, `crash writer did not exit cleanly: ${crashResult.error?.message ?? "unknown error"}`);
const crashExit = { code: crashResult.status, signal: crashResult.signal };
assert.ok(process.platform === "win32"
  ? crashExit.signal === "SIGKILL" || (Number.isInteger(crashExit.code) && crashExit.code !== 0)
  : crashExit.signal === "SIGKILL", `crash writer did not terminate as expected: ${JSON.stringify(crashExit)} ${crashStderr}`);
const crashLock = join(shadowRoot, ".spine-rotation.lock");
assert.equal(existsSync(crashLock), true, "SIGKILL leaves the rotation fence");
const crashReady = JSON.parse(readFileSync(join(shadowRoot, "crash-ready.json"), "utf8"));
assert.equal(crashReady.pid, crashResult.pid, "crashing child published its own readiness marker");
assert.equal(crashReady.lock.pid, crashResult.pid, "crashing child held the root lock");
assert.deepEqual(JSON.parse(readFileSync(crashLock, "utf8")), crashReady.lock, "crash lock remains unchanged");
assert.equal(crashStderr, "", "crash probe has no unrelated exception");
enterPhase("crash-recovery");
const recovered = rotateShadow({ dir: shadowRoot, incomingBytes: 0, cap, readdir, stat });
assert.equal(recovered.ok, true, "post-SIGKILL rotation recovers with a full scan");
assert.equal(recovered.estimated, undefined, "post-SIGKILL rotation stays fail-closed");
const crashTarget = join(shadowRoot, "post-crash", "cut-post-crash-ffffffff.txt");
enterPhase("post-crash-save");
const crashSaved = await saveShadowAsync.call(
  externalHost,
  [{ role: "user", content: "post crash pooled writer" }],
  true,
  crashTarget,
  "post-crash",
);
assert.equal(crashSaved.ok, true, "pooled writer resumes after SIGKILL recovery");
assert.equal(existsSync(crashTarget), true);
enterPhase("complete");
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
