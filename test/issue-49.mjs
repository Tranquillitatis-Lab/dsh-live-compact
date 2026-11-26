import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Spine from "../index.js";

test("#49 pre-step barrier is registered before the stock pressure hook", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf('ctx.on("agent/pre-step"'), source.indexOf('ctx.on("agent/turn-stopping"'));
  assert.match(body, /prepend: true/);
});

test("#49 deferred catch-up never enters a serialized maintenance gate", async () => {
  const engine = Object.create(Spine.prototype);
  engine.standDown = () => false;
  engine.stateFor = () => ({ key: "session-a", warming: false });
  engine.liveConfig = {};
  engine.pendingCaptures = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: false, promise: new Promise(() => {}) });
  let maintenanceCalls = 0;
  const agent = {
    session: { id: "session-a", snapshotEvents: () => Array.from({ length: 129 }, (_, seq) => ({ seq })) },
    runMaintenance: async () => { maintenanceCalls += 1; },
  };
  await engine.finishTurn(agent, undefined, { deferCapture: true });
  assert.equal(maintenanceCalls, 0);
});

test("#49 permanent capture blocks keep the cursor at the failed event", () => {
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map([["session-a", 0]]);
  engine.persistCapture = false;
  engine.writeCaptureCursor = () => {};
  engine.captureOne = () => ({ ok: false, reason: "duplicate-tool-call-id", retryable: false });
  const session = { id: "session-a", surface: { nodes: [] }, eventAt() { return undefined; } };
  const event = { seq: 0, type: "tool/result", data: { message: { toolCallId: "reused" } } };
  const result = engine.captureNewBatch(session, [event], { keepRounds: 3 }, { eventLimit: 128, resultLimit: 128 });
  assert.equal(result.blocked, true);
  assert.equal(result.done, false);
  assert.equal(engine.captureCursor.get("session-a"), 0);
});

test("#49 a session flush does not wait for another session's pending capture", async () => {
  const engine = Object.create(Spine.prototype);
  let releaseOther;
  const otherPending = new Promise((resolve) => { releaseOther = resolve; });
  let currentFinished = false;
  engine.pendingCaptureJobs = new Map([
    ["session-a\0tool-a", otherPending],
    ["session-b\0tool-b", Promise.resolve().then(() => { currentFinished = true; })],
  ]);
  engine.surfaceToolIds = (session) => session.id === "session-b" ? ["tool-b"] : ["tool-a"];
  const current = { id: "session-b" };
  const result = await Promise.race([
    engine.flushPendingCaptures(current).then(() => "finished"),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 100)),
  ]);
  releaseOther();
  assert.equal(result, "finished");
  assert.equal(currentFinished, true);
});
