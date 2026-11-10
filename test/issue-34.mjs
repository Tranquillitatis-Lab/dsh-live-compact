import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import Spine from "../index.js";
import { fixture, runtime } from "./helpers/runtime.mjs";

test("#34 idle maintenance defers full catch-up to the event loop", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const { engine } = h.engine({ minTokens: 100000 });
  let batches = 0;
  engine.captureNewBatch = () => {
    batches += 1;
    return { done: true, progressed: false, retryable: false, seen: new Set(), nextIndex: 0 };
  };
  engine.recoverVisibleRawBatch = () => ({ done: true, nextIndex: 0, progressed: false });

  await engine.finishTurn(f.agent(), f.session.snapshotEvents(), { deferCapture: true });
  assert.equal(batches, 0, "idle maintenance must return before the full catch-up batch");
  await setImmediate();
  assert.equal(batches, 1, "catch-up must run after the idle maintenance turn yields");
});

test("#34 turn-end maintenance also batches capture before compaction", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const { engine } = h.engine({ minTokens: 100000 });
  let batches = 0;
  engine.captureNew = () => { throw new Error("turn-end must not use synchronous captureNew"); };
  engine.captureNewBatch = () => {
    batches += 1;
    return { done: true, progressed: false, retryable: false, seen: new Set(), nextIndex: 0 };
  };
  engine.recoverVisibleRawBatch = () => ({ done: true, nextIndex: 0, progressed: false });
  await engine.finishTurn(f.agent(), f.session.snapshotEvents());
  assert.equal(batches, 1, "turn-end capture is queued as one bounded batch");
});

test("#34 retries a transient raw lock without leaving catch-up retryable", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const { engine } = h.engine({ minTokens: 100000 });
  let attempts = 0;
  engine.captureNewBatch = () => {
    attempts += 1;
    return attempts === 1
      ? { done: false, progressed: false, retryable: true, seen: new Set(), nextIndex: 0 }
      : { done: true, progressed: true, retryable: false, seen: new Set(), nextIndex: 0 };
  };
  engine.recoverVisibleRawBatch = () => ({ done: true, nextIndex: 0, progressed: false });

  await engine.finishTurn(f.agent(), f.session.snapshotEvents(), { deferCapture: true });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(attempts, 2, "a transient busy capture is retried after yielding");
  assert.equal(engine.pendingCatchups.size, 0, "retryable catch-up settles after the retry succeeds");
});

test("#34 bounds a permanent raw lock and leaves it fail-closed", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const { engine } = h.engine({ minTokens: 100000 });
  let attempts = 0;
  engine.captureNewBatch = () => {
    attempts += 1;
    return { done: false, progressed: false, retryable: true, seen: new Set(), nextIndex: 0 };
  };
  engine.recoverVisibleRawBatch = () => ({ done: true, nextIndex: 0, progressed: false });

  await engine.finishTurn(f.agent(), f.session.snapshotEvents(), { deferCapture: true });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(engine.pendingCatchups.size, 0, "permanent busy capture does not leave a live task");
  assert.equal(attempts, 8, "permanent busy capture is bounded");
});

test("#34 keeps the cursor at the first retryable catch-up result", () => {
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map([["s", 0]]);
  engine.persistCapture = false;
  engine.writeCaptureCursor = () => {};
  engine.captureOne = () => ({ ok: false, retryable: true });
  const session = { id: "s", surface: { nodes: [] }, eventAt() { return undefined; } };
  const events = [
    { seq: 0, type: "tool/result", data: { message: { toolCallId: "busy" } } },
    { seq: 1, type: "tool/result", data: { message: { toolCallId: "later" } } },
  ];

  const result = engine.captureNewBatch(session, events, { keepRounds: 3 }, { eventLimit: 128, resultLimit: 1 });
  assert.equal(result.retryable, true);
  assert.equal(result.done, false);
  assert.equal(engine.captureCursor.get("s"), 0);
});

test("#34 rewinds the batch index when an older visible raw becomes retryable", () => {
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map([["s", 0]]);
  engine.persistCapture = false;
  engine.writeCaptureCursor = () => {};
  const events = Array.from({ length: 260 }, (_, seq) => ({
    seq,
    type: "tool/result",
    data: { message: { toolCallId: `id-${seq}` } },
  }));
  const session = {
    id: "s",
    surface: { nodes: events.map((event) => event.seq) },
    eventAt(seq) { return events[seq]; },
  };
  const captured = [];
  engine.captureOne = (_session, event) => {
    captured.push(event.seq);
    const id = event.data.message.toolCallId;
    const record = { ok: true, toolCallId: id };
    engine.rawSeen.set(engine.rawKey(session, id), record);
    return record;
  };

  const first = engine.captureNewBatch(session, events, { keepRounds: 3 }, { eventLimit: 128, resultLimit: 128, startIndex: 0 });
  assert.equal(first.nextIndex, 128);
  const retryable = { ok: false, retryable: true, toolCallId: "id-10" };
  engine.rawSeen.set(engine.rawKey(session, "id-10"), retryable);
  engine.noteCaptureResult(session, events[10], retryable);
  const second = engine.captureNewBatch(session, events, { keepRounds: 3 }, { eventLimit: 128, resultLimit: 128, startIndex: first.nextIndex });
  assert.equal(captured.includes(10), true, "a retryable older result must be revisited");
  assert.equal(engine.captureCursor.get("s"), 138);
  assert.equal(second.nextIndex, 138);
});

test("#34 idle hook does not wait for an unrelated pending capture", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const { engine, ctx } = h.engine({ minTokens: 100000 });
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const key = engine.rawKey(f.session, "unrelated");
  engine.pendingCaptures.add(pending);
  engine.pendingCaptureJobs.set(key, pending);
  ctx.emit("agent/status", { agent: f.agent(), status: "idle" });
  assert.equal(engine.pendingCaptures.has(pending), true, "idle must not await unrelated capture work");
  release();
  await setImmediate();
});

test("#34 recovers a large visible-ID snapshot without rebuilding it per batch", () => {
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  const ids = Array.from({ length: 15000 }, (_, index) => `id-${index}`);
  for (const id of ids) engine.rawSeen.set(engine.rawKey({ id: "s" }, id), { ok: true });
  engine.surfaceToolIds = () => { throw new Error("visible IDs must use the queued snapshot"); };
  const result = engine.recoverVisibleRawBatch({ id: "s" }, {}, 0, 1, ids);
  assert.equal(result.done, true);
  assert.equal(result.nextIndex, ids.length);
});
