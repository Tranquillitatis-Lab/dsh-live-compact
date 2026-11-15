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

