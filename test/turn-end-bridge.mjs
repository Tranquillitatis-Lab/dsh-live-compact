import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import Spine from "../index.js";
import { DECISIONS_NAME, MAINTENANCE_NAME, STATS_NAME } from "../shadow.js";
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

test("the running host persists a turn-stopping cut before it closes the session", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine({}, "cloud");
  const agent = f.agent();
  agent.status = "running";
  agent.runMaintenance = () => { throw new Error("agent already has active work"); };
  let persisted = [];
  ctx.sessions.flush = async (session) => { persisted = session.snapshotEvents(); };
  f.add("turn/start", { turn: 2 }, 0, {});
  f.user("Run the current task before closing the session.");
  for (let round = 0; round < 8; round += 1) {
    f.round(`before-close-${round}`, { tokens: 4000, turn: 2 });
  }
  h.capture(engine, f);

  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal, 2);

  assert.ok(persisted.some((event) => event.surfaceOp?.op === "replace"), h.warnings.join("\n"));
  const lifecycle = persisted.filter((event) => ["compaction/start", "compaction/end"].includes(event.type));
  assert.deepEqual(lifecycle.map((event) => event.data.turn), [2, 2]);
  assert.ok(!persisted.some((event) => event.type === "turn/end"));
});

test("a capped tool task queues one follow-up in the original session", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  engine.finishTurn = async () => true;
  const agent = f.agent();
  agent.status = "running";
  const queued = [];
  agent.inbox = { nextTurn: queued, nextStep: [] };
  agent.followup = (message) => queued.push(message);
  const signal = new AbortController().signal;
  const addStop = (turn) => f.add("assistant/message", {
    turn,
    message: { content: [{ type: "reasoning", text: "Unfinished work" }] },
    stream: [{ type: "chunk", time: 0, chunk: { type: "finish", reason: { kind: "max-tokens" } } }],
  });

  f.add("turn/start", { turn: 2 }, 0, {});
  f.user("Implement and verify the requested change.");
  f.round("before-limit", { turn: 2 });
  addStop(2);
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 2 });
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 2 });

  assert.equal(queued.length, 1);
  const [recovery] = queued.splice(0);
  assert.equal(recovery.role, "user");
  assert.equal(recovery.source.kind, "spine-output-recovery");
  assert.match(recovery.content[0].text, /original request/);

  f.add("turn/end", { turn: 2, reason: { kind: "max-tokens" } }, 0, {});
  f.add("turn/start", { turn: 3 }, 0, {});
  f.add("user/message", recovery);
  f.round("during-recovery", { turn: 3 });
  addStop(3);
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 3 });
  assert.equal(queued.length, 0);
});

test("a reasoning-only cap before any recovery tool gets one final follow-up", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  engine.finishTurn = async () => true;
  const agent = f.agent();
  agent.status = "running";
  const queued = [];
  agent.inbox = { nextTurn: queued, nextStep: [] };
  agent.followup = (message) => queued.push(message);
  const signal = new AbortController().signal;
  const finishAtLimit = (turn) => f.add("assistant/message", {
    turn,
    message: { content: [{ type: "reasoning", text: "A plan without a tool call." }] },
    stream: [{ type: "chunk", time: 0, chunk: { type: "finish", reason: { kind: "max-tokens" } } }],
  });

  f.add("turn/start", { turn: 2 }, 0, {});
  f.user("Implement and verify the requested change.");
  f.round("inspected-before-limit", { turn: 2 });
  finishAtLimit(2);
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 2 });
  assert.equal(queued.length, 1);
  const [recovery] = queued.splice(0);

  f.add("turn/end", { turn: 2, reason: { kind: "max-tokens" } }, 0, {});
  f.add("turn/start", { turn: 3 }, 0, {});
  f.add("user/message", recovery);
  finishAtLimit(3);
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 3 });
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 3 });
  assert.equal(queued.length, 1);
  const [lastRecovery] = queued.splice(0);
  assert.equal(lastRecovery.source.kind, "spine-output-recovery-final");
  assert.match(lastRecovery.content[0].text, /one small tool call/);

  f.add("turn/end", { turn: 3, reason: { kind: "max-tokens" } }, 0, {});
  f.add("turn/start", { turn: 4 }, 0, {});
  f.add("user/message", lastRecovery);
  finishAtLimit(4);
  await ctx.serial("agent/turn-stopping", { agent, signal, turn: 4 });
  assert.equal(queued.length, 0);
});

test("output recovery yields to normal completion, pending input, cancellation and incomplete tool calls", async (t) => {
  const h = runtime(t);
  const { engine, ctx } = h.engine();
  engine.finishTurn = async () => true;
  for (const state of ["completed", "pending", "cancelled", "unanswered-tool", "no-tool-work"]) {
    const f = h.use(fixture());
    const agent = f.agent();
    agent.status = "running";
    const queued = [];
    agent.inbox = { nextTurn: state === "pending" ? [{}] : [], nextStep: [] };
    agent.followup = (message) => queued.push(message);
    const abort = new AbortController();
    if (state === "cancelled") abort.abort();
    f.add("turn/start", { turn: 2 }, 0, {});
    f.user("Implement and verify the requested change.");
    if (state !== "no-tool-work") f.round(`before-${state}`, { turn: 2 });
    const content = state === "unanswered-tool"
      ? [{ type: "tool-call", id: "unanswered", name: "shell", arguments: "{}" }]
      : [{ type: "text", text: "Part of the response." }];
    f.add("assistant/message", {
      turn: 2,
      message: { content },
      stream: [{ type: "chunk", time: 0, chunk: { type: "finish", reason: { kind: state === "completed" ? "stop" : "max-tokens" } } }],
    });
    await ctx.serial("agent/turn-stopping", { agent, signal: abort.signal, turn: 2 });
    assert.equal(queued.length, 0, state);
  }
});

test("a flush failure after a live replacement reports the original persistence error", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine({}, "cloud");
  const agent = f.agent();
  agent.status = "running";
  f.add("turn/start", { turn: 2 }, 0, {});
  f.user("Keep the current task recoverable when the storage write fails.");
  for (let round = 0; round < 8; round += 1) {
    f.round(`before-flush-error-${round}`, { tokens: 4000, turn: 2 });
  }
  h.capture(engine, f);
  ctx.sessions.flush = async (session) => {
    if (session.snapshotEvents().some((event) => event.surfaceOp?.op === "replace")) {
      throw new Error("fixture archive write failed");
    }
  };

  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal, 2);

  assert.equal(f.session.snapshotEvents().filter((event) => event.surfaceOp?.op === "replace").length, 1);
  assert.equal(f.session.snapshotEvents().filter((event) => event.type === "compaction/end").length, 1);
  assert.ok(h.warnings.includes("spine compaction persistence unknown after replacement: fixture archive write failed"),
    h.warnings.join("\n"));
  assert.equal(existsSync(join(h.root, STATS_NAME)), false);
});

test("turn-stopping exposes in-progress maintenance before waiting for capture", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 1000 }));
  const { engine } = h.engine({ minTokens: 20000 });
  const agent = f.agent();
  agent.status = "running";
  f.add("turn/start", { turn: 2 }, 0, {});
  let releaseCapture;
  const blockedCapture = new Promise((resolve) => { releaseCapture = resolve; });
  let enteredCapture;
  const entered = new Promise((resolve) => { enteredCapture = resolve; });
  engine.flushPendingCaptures = () => {
    enteredCapture();
    return blockedCapture;
  };
  const maintenance = engine.runTurnStoppingMaintenance(agent, new AbortController().signal, 2);
  const file = join(h.root, MAINTENANCE_NAME);
  const rows = () => readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  try {
    await entered;
    assert.equal(existsSync(file), true);
    const [started] = rows();
    assert.equal(started.sid, f.session.id);
    assert.equal(started.turn, 2);
    assert.equal(started.result, "started");
  } finally {
    releaseCapture();
    await maintenance;
  }
  const [started, completed] = rows();
  assert.equal(completed.operation, started.operation);
  assert.equal(completed.result, "completed");
  assert.equal(completed.cuts, 0);
});

test("the host's invalid pressure budget is recorded on a cold shadow root", async (t) => {
  const h = runtime(t, { modelTransport: async function* ({ purpose }) {
    assert.equal(purpose, "compaction");
    yield { type: "text-delta", index: 0, text: "The original task remains active after correcting the budget." };
    yield { type: "finish", reason: { kind: "stop" } };
  } });
  const f = h.use(fixture());
  const { engine, ctx } = h.engine({ thresholdRatio: 0.8, retainTokens: 8192, headroomTokens: 65536 });
  const agent = { ...f.agent(), options: {} };
  const config = { provider: "test", model: "no-network", maxTokens: 262144 };
  f.session.requestHeader = () => ({ config });
  ctx.llm.resolveModelInfo = async () => ({ context: { contextWindow: 262144 } });
  const shadow = join(h.root, "later");
  process.env.SPINE_SHADOW_DIR = shadow;
  const checkPressure = () => engine.compactIfNeeded(agent, "pressure", new AbortController().signal);
  const expected = /reserves 262144 completion tokens of its 262144-token context window, leaving no message budget/;

  await assert.rejects(checkPressure, expected);
  assert.equal(existsSync(join(shadow, DECISIONS_NAME)), true);
  await assert.rejects(checkPressure, expected);
  await assert.rejects(checkPressure, expected);
  const decisions = readFileSync(join(shadow, DECISIONS_NAME), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].sid, f.session.id);
  assert.equal(decisions[0].phase, "official-compaction");
  assert.equal(decisions[0].trigger, "pressure");
  assert.equal(decisions[0].result, "rejected");
  assert.equal(decisions[0].reason, "invalid-pressure-config");
  assert.match(decisions[0].detail, expected);
  assert.equal(h.pruneCalls, 0);
  config.maxTokens = 32768;
  assert.equal(await checkPressure(), null);
  config.maxTokens = 262144;
  await assert.rejects(checkPressure, expected);
  assert.equal(readFileSync(join(shadow, DECISIONS_NAME), "utf8").trim().split("\n").length, 2);
  assert.equal(f.summaries().length, 0);

  f.add("turn/start", { turn: 2 }, 0, {});
  f.round("pressure-history", { tokens: 145000, turn: 2 });
  f.round("pressure-tail", { tokens: 10000, turn: 2 });
  config.maxTokens = 32768;
  assert.ok(await checkPressure(), "the corrected model budget must allow official compaction");
  assert.equal(h.modelCalls, 1);
  assert.deepEqual(
    f.session.snapshotEvents().filter((event) => event.type.startsWith("compaction/")).map((event) => event.type),
    ["compaction/start", "compaction/summary", "compaction/end"],
  );
});

test("turn-stopping does not mark a boundary when maintenance fails", async () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "stopping-failed",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    maintenanceJob: null,
    turnEndPending: false,
    turnEndSeq: -1,
    turnEndEvent: null,
    lastStoppingTurnEndSeq: -1,
  };
  const events = [{ seq: 7, type: "turn/end", data: { reason: { kind: "completed" } } }];
  const agent = { session: { id: state.key, snapshotEvents: () => events } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.captureNew = () => {};
  engine.finishTurn = async () => false;
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  assert.equal(state.lastStoppingTurnEndSeq, -1);
  assert.equal(state.turnEndSeq, 7);
});

test("turn-stopping keeps a failed cut retryable", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ totalTokens: 24000 }));
  const { engine, ctx } = h.engine({ minTokens: 20000 }, "cloud");
  h.capture(engine, f);
  const agent = f.agent();
  engine.stateFor(agent);
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  engine.flushPendingCaptures = async () => {};
  ctx.tokenMeter.measure = () => ({ nodes: f.measure().nodes, totalTokens: 60000, totalHeuristicTokens: 60000 });
  engine.commitSelectedSpan = async () => false;
  f.user("失败切刀必须保留下一次边界重试。");
  for (let round = 0; round < 8; round += 1) f.round(`failed-cut-${round}`, { tokens: 4000, turn: 2 });
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  assert.equal(engine.stateFor(agent).lastStoppingTurnEndSeq, -1);
});

test("failed catch-up keeps the stopping owner barrier", () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "failed-owner",
    warming: true,
    pendingMaintenance: true,
    maintenanceOwner: {},
    turnEndPending: false,
  };
  const agent = { session: { id: state.key, snapshotEvents: () => [] } };
  engine.stateFor = () => state;
  engine.pendingCatchups = new Map();
  engine.pendingCatchupJobs = new Set();
  const task = {
    key: state.key,
    agent,
    finished: false,
    failed: true,
    promise: Promise.resolve(),
    resolve() {},
  };
  engine.finishCaptureCatchup(task);
  assert.equal(state.warming, true);
  assert.equal(state.pendingMaintenance, true);
  assert.equal(state.turnEndPending, true);
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

test("turn-stopping forwards a late abort and does not hold the caller", async () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "abort-stopping",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    maintenanceJob: null,
    turnEndPending: false,
    turnEndSeq: -1,
  };
  let release;
  const catchup = new Promise((resolve) => { release = resolve; });
  const events = Array.from({ length: 129 }, (_, seq) => ({ seq }));
  const agent = { session: { id: state.key, snapshotEvents: () => events } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.captureNew = () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: false, promise: catchup });
  engine.finishTurn = async () => { throw new Error("finishTurn must not run after abort"); };
  const controller = new AbortController();
  const run = engine.runTurnStoppingMaintenance(agent, controller.signal);
  await setImmediate();
  controller.abort({ kind: "disposed" });
  let timer;
  try {
    await Promise.race([
      run,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("abort was not forwarded")), 100); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(state.maintenanceAbort.signal.aborted, true);
  release();
  await Promise.allSettled([state.maintenanceJob]);
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

test("owner keeps the barrier when catch-up temporarily lacks a completed boundary", () => {
  const engine = Object.create(Spine.prototype);
  const state = {
    key: "owner-boundary-gap",
    warming: true,
    pendingMaintenance: true,
    maintenanceOwner: {},
    turnEndPending: false,
  };
  const agent = { session: { id: state.key, snapshotEvents: () => [] } };
  engine.stateFor = () => state;
  engine.standDown = () => false;
  engine.pendingCatchups = new Map([[state.key, {}]]);
  engine.pendingCatchupJobs = new Map();
  const task = {
    key: state.key,
    agent,
    finished: false,
    captureBlocked: false,
    retryRequested: false,
    maintenanceRequested: false,
    promise: Promise.resolve(),
    resolve() {},
  };
  engine.finishCaptureCatchup(task);
  assert.equal(state.warming, true);
  assert.equal(state.pendingMaintenance, true);
  assert.equal(state.turnEndPending, true);
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
  engine.finishTurn = async () => { finishes += 1; return true; };
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  engine.scheduleTurnEndMaintenance(agent, event.seq, event);
  await setImmediate();
  assert.equal(finishes, 1);
  assert.equal(state.lastMaintenanceTurnEndSeq, event.seq);
});

test("turn/end arriving after turn-stopping is deduplicated by the active turn/start", async () => {
  const engine = Object.create(Spine.prototype);
  const events = [
    { seq: 1, type: "turn/start", data: { turn: 1 } },
    { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
    { seq: 3, type: "turn/start", data: { turn: 2 } },
  ];
  const state = {
    key: "reverse-boundary",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    maintenanceJob: null,
    turnEndPending: false,
    turnEndSeq: -1,
    lastMaintenanceTurnEndSeq: -1,
    lastStoppingTurnEndSeq: -1,
    lastStoppingTurnStartSeq: -1,
    turnEndScheduled: false,
  };
  const agent = { session: { id: state.key, snapshotEvents: () => events } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.captureNew = () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  let finishes = 0;
  engine.finishTurn = async () => { finishes += 1; return true; };
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  events.push({ seq: 4, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
  engine.scheduleTurnEndMaintenance(agent, 4, events.at(-1));
  await setImmediate();
  assert.equal(finishes, 1);
  assert.equal(state.lastMaintenanceTurnEndSeq, 4);
});

test("a newer turn/start does not make an older delayed turn/end run twice", async () => {
  const engine = Object.create(Spine.prototype);
  const events = [{ seq: 1, type: "turn/start", data: { turn: 2 } }];
  const state = {
    key: "delayed-boundary",
    warming: false,
    pendingMaintenance: false,
    maintenanceAbort: null,
    maintenanceOwner: null,
    maintenanceJob: null,
    turnEndPending: false,
    turnEndSeq: -1,
    lastMaintenanceTurnEndSeq: -1,
    lastStoppingTurnEndSeq: -1,
    lastStoppingTurnStartSeq: -1,
    turnEndScheduled: false,
  };
  const agent = { session: { id: state.key, snapshotEvents: () => events } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.liveConfig = {};
  engine.pendingCuts = new Set();
  engine.flushPendingCaptures = async () => {};
  engine.captureNew = () => {};
  engine.scheduleCaptureCatchup = () => ({ finished: true, progressed: false, retryRequested: false });
  let finishes = 0;
  engine.finishTurn = async () => { finishes += 1; return true; };
  await engine.runTurnStoppingMaintenance(agent, new AbortController().signal);
  events.push(
    { seq: 3, type: "turn/start", data: { turn: 3 } },
    { seq: 2, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
  );
  engine.scheduleTurnEndMaintenance(agent, 2, events.at(-1));
  await setImmediate();
  assert.equal(finishes, 1);
  assert.equal(state.lastMaintenanceTurnEndSeq, 2);
});

test("catch-up retry waits for an existing maintenance job instead of spinning", async () => {
  const engine = Object.create(Spine.prototype);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const state = {
    key: "retry-wait",
    warming: true,
    pendingMaintenance: true,
    maintenanceOwner: null,
    maintenanceAbort: null,
    maintenanceJob: pending,
    retryScheduled: false,
    retryWaitingJob: null,
    turnEndPending: false,
    turnEndSeq: 2,
    turnEndEvent: { seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } },
  };
  const agent = { session: { id: state.key, snapshotEvents: () => [state.turnEndEvent] } };
  engine.standDown = () => false;
  engine.stateFor = () => state;
  engine.pendingCuts = new Set();
  engine.finishTurn = async () => true;
  engine.scheduleMaintenanceRetry(agent);
  await setImmediate();
  assert.equal(state.retryWaitingJob, pending);
  release();
  state.maintenanceJob = null;
  await setImmediate();
  await setImmediate();
  assert.equal(state.retryWaitingJob, null);
  assert.equal(state.maintenanceJob, null);
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

