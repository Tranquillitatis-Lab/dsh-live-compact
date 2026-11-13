import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import SpineCompactionEngine from "../index.js";
import { activeCompactionPeers, installPresetGate, rewritePresetConfig } from "../gate.js";
import { STOCK_ENGINE } from "../adapter.js";

function runtimeContext(runtimes = []) {
  const warnings = [];
  const ctx = {
    registry: { values: () => runtimes.values() },
    logger: { warn: (line) => warnings.push(line) },
  };
  ctx.root = ctx;
  return { ctx, warnings };
}

test("active compressor detection only counts bili-native/billion-context loading or active fibers", () => {
  const runtimes = new Map([
    ["gate", { name: "bili-compaction-gate", fibers: [{ state: 2 }] }],
    ["context", { name: "dsh-context", fibers: [{ state: 2 }] }],
    ["failed", { name: "bili-native", fibers: [{ state: 3 }] }],
    ["loading", { name: "billion-context", fibers: [{ state: 1 }] }],
    ["active", { name: "bili-native", fibers: [{ state: 2 }] }],
  ]);
  const { ctx } = runtimeContext(runtimes);
  assert.deepEqual(activeCompactionPeers(ctx), ["billion-context", "bili-native"]);
});

test("preset gate leaves the stock engine untouched while a peer is active", () => {
  const runtimes = new Map([["peer", { name: "bili-native", fibers: [{ state: 2 }] }]]);
  const listeners = [];
  const { ctx, warnings } = runtimeContext(runtimes);
  ctx.fiber = {};
  ctx.effect = () => () => {};
  ctx.on = (name, listener) => { assert.equal(name, "internal/config"); listeners.push(listener); return () => {}; };
  installPresetGate(ctx);
  const original = { id: "standard", plugins: [{ name: STOCK_ENGINE }] };
  const rewritten = listeners[0]({ entry: { options: { id: "standard" } } }, () => original);
  assert.equal(rewritten, original);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bili-native/);
});

test("live engine performs one large local cut alone and becomes a no-op with an active peer", async (t) => {
  const root = new Context();
  const shadowDir = mkdtempSync(join(tmpdir(), "spine-stand-down-"));
  const previousShadow = process.env.SPINE_SHADOW_DIR;
  process.env.SPINE_SHADOW_DIR = shadowDir;
  t.after(async () => {
    await root.fiber.dispose();
    if (previousShadow === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previousShadow;
    rmSync(shadowDir, { recursive: true, force: true });
  });
  root.logger = { info() {}, debug() {}, warn() {} };
  root.sessions = { flush: async () => {} };
  root.tokenMeter = {
    measure: (session) => ({ totalTokens: session.surface.nodes.length * 7000, nodes: session.surface.nodes.map((seq) => ({ seq, tokens: 7000 })) }),
    estimateMessage: () => 20,
  };
  root.llm = { stream: async () => { throw new Error("model call not expected in local cut"); } };
  const engine = new SpineCompactionEngine(root.isolate("compaction"), { auto: false });
  engine.engineFor = () => ({ engine: "local", source: "test" });
  const session = Session.create("stand-down-large");
  session.append("system/message", { content: [{ type: "text", text: "system" }] }, { surfaceOp: "append" });
  for (let index = 0; index < 8; index += 1) {
    session.append("user/message", { content: [{ type: "text", text: `task ${index}` }] }, { surfaceOp: "append" });
    session.append("assistant/message", { message: { content: [{ type: "text", text: `result ${index}` }] } }, { surfaceOp: "append" });
  }
  const agent = { session, runMaintenance: async (fn) => fn(new AbortController().signal) };
  const before = session.snapshotEvents().length;
  await engine.finishTurn(agent);
  assert.ok(session.snapshotEvents().length >= before);

  const peer = root.plugin({ name: "bili-native", apply() {} });
  await peer.await();
  const frozen = JSON.stringify(session.snapshotEvents());
  await engine.finishTurn(agent);
  assert.equal(JSON.stringify(session.snapshotEvents()), frozen);
  assert.equal(await engine.compactIfNeeded(agent, "pressure", new AbortController().signal), null);
  assert.equal(await engine.compactNow(agent, new AbortController().signal), null);
});

test("SPINE_STAND_DOWN forces the same gate", () => {
  const previous = process.env.SPINE_STAND_DOWN;
  process.env.SPINE_STAND_DOWN = "1";
  try {
    const { ctx } = runtimeContext(new Map());
    assert.deepEqual(activeCompactionPeers(ctx), ["SPINE_STAND_DOWN"]);
  } finally {
    if (previous === undefined) delete process.env.SPINE_STAND_DOWN;
    else process.env.SPINE_STAND_DOWN = previous;
  }
});
