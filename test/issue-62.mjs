import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureToolResult, PRUNE_MARKER } from "../raw.js";
import Spine from "../index.js";
import { releaseRootStockCompaction } from "../shell.js";
import { STOCK_ENGINE } from "../adapter.js";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("#62 starts the shadow worker through an eval import bootstrap", () => {
  assert.match(indexSource, /const workerBootstrap = `import\(/);
  assert.match(indexSource, /eval: true/);
  assert.doesNotMatch(indexSource, /execArgv: process\.execArgv\.filter/);
});

test("#62 already-pruned capture is unrecoverable and does not retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-already-pruned-"));
  const result = captureToolResult({ dir, toolCallId: "call-pruned", text: `x ${PRUNE_MARKER}` });
  assert.deepEqual(result, { ok: false, reason: "already-pruned", toolCallId: "call-pruned", unrecoverable: true });
});

test("#62 advances past an already-pruned result and captures later results", () => {
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map([["session-pruned", 0]]);
  engine.persistCapture = false;
  engine.writeCaptureCursor = () => {};
  engine.noteEvent = () => {};
  const captured = [];
  engine.captureOne = (_session, event) => {
    captured.push(event.seq);
    return event.seq === 0 ? { ok: false, reason: "already-pruned", unrecoverable: true } : { ok: true };
  };
  const session = { id: "session-pruned", surface: { nodes: [] }, eventAt() { return undefined; } };
  const events = [0, 1].map((seq) => ({ seq, type: "tool/result", data: { message: { toolCallId: `call-${seq}` } } }));
  const result = engine.captureNewBatch(session, events, { keepRounds: 3 }, { eventLimit: 128, resultLimit: 128 });
  assert.equal(result.done, true);
  assert.deepEqual(captured, [0, 1]);
  assert.equal(engine.captureCursor.get("session-pruned"), 2);
});

test("#62 merges maintenanceRequested when reusing an in-flight catch-up", () => {
  const engine = Object.create(Spine.prototype);
  const task = {
    key: "session-reused",
    agent: null,
    session: null,
    events: [],
    settings: {},
    freezeSnapshot: false,
    maintenanceRequested: false,
  };
  engine.pendingCatchups = new Map([[task.key, task]]);
  engine.pendingCatchupJobs = new Set();
  engine.pendingCuts = new Set();
  engine.surfaceToolIds = () => [];
  engine.queueCaptureCatchup = () => {};
  const agent = { session: { id: task.key, surface: { nodes: [] } } };
  assert.equal(engine.scheduleCaptureCatchup(agent, [], {}, { maintenanceRequested: true }), task);
  assert.equal(task.maintenanceRequested, true);
});

test("desktop bundle fallback releases only the root official engine", () => {
  const isolate = Symbol.for("cordis.isolate");
  const key = Symbol("compaction");
  const store = {};
  const root = { [isolate]: { compaction: key }, reflect: { store }, fiber: {} };
  const stockFiber = {
    entry: { options: { name: STOCK_ENGINE } },
    dispose() { delete store[key]; },
  };
  store[key] = { ctx: { fiber: stockFiber } };
  assert.equal(releaseRootStockCompaction(root), true);
  assert.equal(store[key], undefined);

  const thirdPartyFiber = {
    entry: { options: { id: "compaction-basic", name: "dsh-hypercompact-qq" } },
    dispose() { delete store[key]; },
  };
  store[key] = { ctx: { fiber: thirdPartyFiber } };
  assert.equal(releaseRootStockCompaction(root), false);
  assert.equal(store[key]?.ctx.fiber, thirdPartyFiber);
});
