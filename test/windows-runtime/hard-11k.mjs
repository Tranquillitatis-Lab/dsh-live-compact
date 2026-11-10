import assert from "node:assert/strict";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { setImmediate as yieldImmediate } from "node:timers/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, shadowRoot] = process.argv.slice(2);
assert.ok(installed && shadowRoot, "usage: hard-11k.mjs INSTALLED_PACKAGE SHADOW_ROOT");
process.env.SPINE_SHADOW_DIR = shadowRoot;
mkdirSync(shadowRoot, { recursive: true });

const shadow = await import(pathToFileURL(join(installed, "shadow.js")).href);
const { rotateShadow, isPluginShadowName } = shadow;
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
assert.equal(results.length, passes);
assert.equal(results.reduce((sum, row) => sum + row.stat, 0) > fileCount, true);
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
  results,
  rootMode: "shared-default-full-scan",
  estimateUsed: false,
  pluginNameCheck: isPluginShadowName("cut-1-00000000.txt"),
}));
