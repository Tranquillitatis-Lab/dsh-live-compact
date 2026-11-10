import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const [installed, shadowRoot] = process.argv.slice(2);
assert.ok(installed && shadowRoot, "usage: hard-9430.mjs INSTALLED_PACKAGE SHADOW_ROOT");
process.env.SPINE_SHADOW_DIR = shadowRoot;
process.env.DSH_HOME = join(shadowRoot, "home");
mkdirSync(shadowRoot, { recursive: true });

const engineModule = await import(pathToFileURL(join(installed, "index.js")).href);
const rawModule = await import(pathToFileURL(join(installed, "raw.js")).href);
const Spine = engineModule.default;
const { contentHash, rawName } = rawModule;

const sessionId = "hard-9430-session";
const eventCount = 9430;
const turnCount = 29;
const existingCount = 86;
const toolIndexes = new Set(Array.from({ length: existingCount }, (_, index) => Math.floor(index * eventCount / existingCount)));
const events = [];
const toolIds = [];
const toolTurns = new Map();
for (let seq = 0; seq < eventCount; seq += 1) {
  const turn = Math.min(turnCount, Math.floor(seq * turnCount / eventCount) + 1);
  if (toolIndexes.has(seq)) {
    const toolCallId = `hard-9430-tool-${String(toolIds.length + 1).padStart(3, "0")}`;
    toolIds.push(toolCallId);
    toolTurns.set(toolCallId, turn);
    events.push({
      seq,
      type: "tool/result",
      data: { turn, message: { toolCallId, content: [{ type: "text", text: `existing raw ${toolCallId}` }], isError: false } },
    });
  } else {
    events.push({ seq, type: "turn/end", data: { turn, reason: { kind: "completed" } } });
  }
}

const sessionDir = join(shadowRoot, sessionId);
mkdirSync(sessionDir, { recursive: true });
for (const [index, toolCallId] of toolIds.entries()) {
  const text = `# spine-session ${sessionId}\nexisting raw ${toolCallId}`;
  const file = join(sessionDir, rawName(toolCallId));
  const bytes = Buffer.byteLength(text);
  const sha256 = contentHash(text);
  writeFileSync(file, text);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId, bytes, sha256, turn: toolTurns.get(toolCallId), name: "read", label: "hard-9430" }));
}

const session = {
  id: sessionId,
  surface: { nodes: events.map((event) => event.seq) },
  eventAt(seq) { return events[seq]; },
  snapshotEvents() { return events; },
};
const ctx = new Context();
ctx.logger = { info() {}, debug() {}, warn() {} };
ctx.sessions = { flush: async () => {} };
ctx.tokenMeter = { measure: () => ({ totalTokens: 0, totalHeuristicTokens: 0, nodes: [] }) };
ctx.llm = new Proxy({}, { get: () => () => { throw new Error("hard-9430 must not call a model"); } });
ctx.provide("toolResultPruner", { pruneSession() {} });
const engine = new Spine(ctx.isolate("compaction"), { auto: false, minTokens: 100000000 });
engine.engineFor = () => ({ engine: "local", source: "hard-9430" });
const agent = { session, runMaintenance(fn) { return fn(new AbortController().signal); } };

let maxGapMs = 0;
let previous = Date.now();
const watchdog = setInterval(() => {
  const now = Date.now();
  maxGapMs = Math.max(maxGapMs, now - previous - 10);
  previous = now;
}, 10);
const started = performance.now();
await engine.finishTurn(agent, events);
const finishReturnMs = performance.now() - started;
const catchupStarted = performance.now();
const deadline = Date.now() + 120000;
while (engine.pendingCatchups.size > 0 && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 10));
}
const catchupMs = performance.now() - catchupStarted;
clearInterval(watchdog);
assert.ok(finishReturnMs < 100, `finishTurn returned in ${finishReturnMs.toFixed(2)}ms`);
assert.ok(catchupMs < 5000, `9430-event catch-up drained in ${catchupMs.toFixed(2)}ms`);
assert.ok(maxGapMs < 1000, `event-loop watchdog gap remained ${maxGapMs.toFixed(2)}ms`);
assert.equal(engine.pendingCatchups.size, 0, "hard 9430 catch-up must drain");
const cursor = engine.captureCursor.get(sessionId) ?? null;
const records = toolIds.map((toolCallId) => engine.rawSeen.get(engine.rawKey(session, toolCallId)));
assert.equal(records.filter((record) => record?.ok).length, existingCount);
assert.equal(records.filter((record) => record?.retryable).length, 0);
assert.equal(cursor, eventCount, "capture cursor must reach the event tail");
console.log(JSON.stringify({ stage: "hard-9430", status: "PASS", events: eventCount, turns: turnCount, existingRaw: existingCount, finishReturnMs: Number(finishReturnMs.toFixed(2)), catchupMs: Number(catchupMs.toFixed(2)), maxGapMs, cursor, rawOk: records.filter((record) => record?.ok).length, retryable: records.filter((record) => record?.retryable).length, arch: process.arch }));
