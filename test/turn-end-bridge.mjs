import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import Spine from "../index.js";
import { fixture, runtime } from "./helpers/runtime.mjs";

test("20 completed user tasks on turn/end produce repeated cloud cuts", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  // Real CLI agents can expose whenIdle() without ever resolving it after a
  // completed/disposed turn. A turn/end bridge must not depend on that hook.
  agent.whenIdle = () => new Promise(() => {});
  let measured = 60000;
  const cuts = [];
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push({ start: chunk.start, end: chunk.end });
    measured -= 5000;
    return true;
  };
  for (let task = 0; task < 20; task += 1) {
    f.user(`任务 ${task}：继续当前工作。`);
    for (let round = 0; round < 4; round += 1) {
      f.round(`task-${task}-round-${round}`, { tokens: 4000, turn: task + 2 });
    }
    const end = f.add("turn/end", { turn: task + 2, reason: { kind: "completed" } }, 0, {});
    ctx.emit("session/event", f.session, f.session.eventAt(end));
    for (let pass = 0; pass < 8; pass += 1) await setImmediate();
  }
  for (let pass = 0; pass < 20; pass += 1) await setImmediate();
  assert.ok(cuts.length > 1, `expected repeated cuts, got ${cuts.length}`);
});

test("drain grows a legal tail into the larger low-water span", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: 60000, totalHeuristicTokens: 60000 });
  const chunks = [];
  engine.commitSelectedSpan = async (_agent, chunk) => {
    chunks.push(chunk.tokens);
    return false;
  };
  f.user("保持低水位，优先整理更大的旧工具段。");
  for (let round = 0; round < 8; round += 1) {
    f.round(`large-span-${round}`, { tokens: 4000, turn: 2 });
  }
  for (let round = 0; round < 3; round += 1) {
    f.round(`kept-span-${round}`, { tokens: 200, turn: 2 });
  }
  await engine.finishTurn(agent, f.session.snapshotEvents(), { skipCapture: true });
  assert.equal(chunks.length, 1);
  assert.ok(chunks[0] >= 12000, `expected a larger low-water span, got ${chunks[0]} tokens`);
});

test("turn/end bridge keeps a boundary published after the callback", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  let measured = 60000;
  const cuts = [];
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push(chunk);
    measured -= 5000;
    return true;
  };
  f.user("任务边界发布时序回归。");
  f.round("boundary-round", { tokens: 4000, turn: 2 });
  const end = f.add("turn/end", { turn: 2, reason: { kind: "completed" } }, 0, {});
  const originalSnapshot = agent.session.snapshotEvents.bind(agent.session);
  let hidden = end;
  agent.session.snapshotEvents = () => originalSnapshot().filter((event) => event.seq !== hidden);
  ctx.emit("session/event", f.session, f.session.eventAt(end));
  for (let pass = 0; pass < 8; pass += 1) await setImmediate();
  hidden = null;
  for (let pass = 0; pass < 20; pass += 1) await setImmediate();
  assert.ok(cuts.length >= 1, `expected a cut with an unpublished boundary, got ${cuts.length}`);
});

test("turn-stopping runs maintenance before a disposed CLI agent can swallow it", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: 60000, totalHeuristicTokens: 60000 });
  const chunks = [];
  engine.commitSelectedSpan = async (_agent, chunk) => {
    chunks.push(chunk.tokens);
    return false;
  };
  f.user("turn stopping should preserve the live maintenance owner");
  for (let round = 0; round < 8; round += 1) f.round(`stopping-${round}`, { tokens: 4000, turn: 2 });
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  assert.ok(chunks.length >= 1, `expected a turn-stopping cut, got ${chunks.length}`);
});

test("late turn-stopping cleanup does not clear a newer maintenance owner", async () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "late-owner",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    turnEndPending: false,
    turnEndSeq: -1,
  };
  let releaseCatchup;
  const catchup = new Promise((resolve) => { releaseCatchup = resolve; });
  const agent = {
    session: { id: "late-owner", snapshotEvents: () => Array.from({ length: 129 }, (_, seq) => ({ seq })) },
  };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: false, promise: catchup });
  engine.finishTurn = async () => {};
  const oldRun = engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  await setImmediate();
  const newOwner = {};
  const newAbort = new AbortController();
  state.maintenanceOwner = newOwner;
  state.maintenanceAbort = newAbort;
  state.warming = true;
  state.pendingMaintenance = true;
  releaseCatchup();
  await oldRun;
  assert.equal(state.maintenanceOwner, newOwner);
  assert.equal(state.maintenanceAbort, newAbort);
  assert.equal(state.warming, true);
  assert.equal(state.pendingMaintenance, true);
});

test("pre-step timeout keeps the running maintenance fenced", async () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "prestep-timeout",
    warming: true,
    pendingMaintenance: true,
    maintenanceAbort: new AbortController(),
    maintenanceJob: new Promise(() => {}),
  };
  const agent = { session: { id: state.key } };
  engine.stateFor = () => state;
  engine.pendingCatchups = new Map();
  engine.prestepWaitTimeoutMs = 5;
  engine.recordDecision = () => {};
  engine.ctx = { logger: { warn() {} } };
  await engine.waitForMaintenance(agent);
  assert.equal(state.warming, true);
  assert.equal(state.pendingMaintenance, true);
  assert.ok(state.maintenanceAbort.signal.aborted);
  assert.ok(state.maintenanceJob);
});

test("catch-up retry defers behind an active turn-stopping owner", () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "retry-owner",
    warming: false,
    pendingMaintenance: false,
    maintenanceOwner: {},
    turnEndPending: false,
  };
  const agent = { session: { id: state.key } };
  let scheduled = 0;
  engine.stateFor = () => state;
  engine.standDown = () => false;
  engine.scheduleMaintenanceRetry = () => { scheduled += 1; };
  engine.pendingCatchups = new Map([[state.key, {}]]);
  engine.pendingCatchupJobs = new Map();
  const task = {
    key: state.key,
    agent,
    finished: false,
    captureBlocked: true,
    retryRequested: false,
    maintenanceRequested: false,
    promise: Promise.resolve(),
    resolve() {},
  };
  engine.finishCaptureCatchup(task);
  assert.equal(scheduled, 0);
  assert.equal(state.turnEndPending, true);
  assert.equal(state.maintenanceOwner != null, true);
});

test("turn/end does not run a second maintenance pass after turn-stopping handled its boundary", async () => {
  const engine = Object.create(Spine.prototype);
  const event = { seq: 7, type: "turn/end", data: { reason: { kind: "completed" } } };
  const state = {
    key: "same-boundary",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    maintenanceJob: null,
    turnEndPending: false,
    turnEndSeq: -1,
    lastMaintenanceTurnEndSeq: -1,
    lastStoppingTurnEndSeq: -1,
    turnEndScheduled: false,
  };
  const agent = { session: { id: state.key, snapshotEvents: () => [event] } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.captureNew = () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  let finishes = 0;
  engine.finishTurn = async () => { finishes += 1; };
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  engine.scheduleTurnEndMaintenance(agent, event.seq, event);
  await setImmediate();
  assert.equal(finishes, 1);
  assert.equal(state.lastMaintenanceTurnEndSeq, event.seq);
});

test("agent/created seeds the live agent before the first turn/end", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  let measured = 60000;
  const cuts = [];
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push(chunk);
    measured -= 5000;
    return true;
  };
  ctx.emit("agent/created", { agent });
  f.user("首次创建后继续当前任务。");
  for (let round = 0; round < 4; round += 1) f.round(`created-round-${round}`, { tokens: 4000, turn: 2 });
  const end = f.add("turn/end", { turn: 2, reason: { kind: "completed" } }, 0, {});
  ctx.emit("session/event", f.session, f.session.eventAt(end));
  for (let pass = 0; pass < 24; pass += 1) await setImmediate();
  assert.ok(cuts.length >= 1, `expected a cut after agent/created, got ${cuts.length}`);
});

test("max-tokens turn/end is a cuttable DSH boundary", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  let measured = 60000;
  const cuts = [];
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push(chunk);
    measured -= 5000;
    return true;
  };
  f.user("模型输出达到 max-tokens 后仍应收尾维护。");
  for (let round = 0; round < 4; round += 1) f.round(`max-tokens-round-${round}`, { tokens: 4000, turn: 2 });
  const end = f.add("turn/end", { turn: 2, reason: { kind: "other", label: "max-tokens" } }, 0, {});
  ctx.emit("session/event", f.session, f.session.eventAt(end));
  for (let pass = 0; pass < 24; pass += 1) await setImmediate();
  assert.ok(cuts.length >= 1, `expected a cut after max-tokens, got ${cuts.length}`);
});

test("native DSH max-tokens reason also triggers the turn/end bridge", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  let measured = 60000;
  const cuts = [];
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push(chunk);
    measured -= 5000;
    return true;
  };
  f.user("原生 DSH max-tokens reason 边界。");
  for (let round = 0; round < 4; round += 1) f.round(`native-max-tokens-round-${round}`, { tokens: 4000, turn: 2 });
  const end = f.add("turn/end", { turn: 2, reason: { kind: "max-tokens" } }, 0, {});
  ctx.emit("session/event", f.session, f.session.eventAt(end));
  for (let pass = 0; pass < 24; pass += 1) await setImmediate();
  assert.ok(cuts.length >= 1, `expected a cut after native max-tokens, got ${cuts.length}`);
});

test("a newer turn/start does not erase an already-published max-tokens boundary", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  const cuts = [];
  let measured = 60000;
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: measured, totalHeuristicTokens: measured });
  engine.commitSelectedSpan = async (_agent, chunk) => {
    cuts.push(chunk);
    measured -= 5000;
    return true;
  };
  const end = f.add("turn/end", { turn: 2, reason: { kind: "max-tokens" } }, 0, {});
  ctx.emit("session/event", f.session, f.session.eventAt(end));
  f.add("turn/start", { turn: 3 }, 0, {});
  for (let pass = 0; pass < 24; pass += 1) await setImmediate();
  assert.ok(cuts.length >= 1, "the published prior boundary must still be maintained");
});

test("disposed lifecycle cancellation does not abort an already-started cut", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const controller = new AbortController();
  const agent = f.agent();
  agent.runMaintenance = async (task) => {
    const result = task(controller.signal);
    setTimeout(() => controller.abort({ kind: "disposed" }), 5);
    return result;
  };
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: 60000, totalHeuristicTokens: 60000 });
  const cuts = [];
  engine.commitSelectedSpan = async (_agent, chunk, signal) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    signal.throwIfAborted();
    cuts.push(chunk);
    return false;
  };
  await engine.finishTurn(agent, f.session.snapshotEvents(), { skipCapture: true });
  assert.equal(cuts.length, 1, "disposed teardown must not cancel a cut already in flight");
});

