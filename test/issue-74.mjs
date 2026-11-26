import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import { load as yaml } from "js-yaml";
import LiveCompact from "../shell.js";
import Spine from "../index.js";
import { STOCK_ENGINE } from "../adapter.js";

const LIVE = "dsh-live-compact";
const INIT = Symbol.for("cordis.init");
const STOCK_CONFIG = { thresholdRatio: 0.6, retainRatio: 0.1, auto: true };
const stockRow = () => ({ id: "compaction-basic", name: STOCK_ENGINE, config: { ...STOCK_CONFIG } });
const liveRow = { id: "compaction-spine", name: LIVE, config: { auto: true } };

async function host(t, { importLive, importStock, projections, throwOn } = {}) {
  const ctx = new Context();
  const warnings = [];
  ctx.logger = { info() {}, debug() {}, warn: (line) => warnings.push(String(line)), error() {} };
  for (const service of ["llm", "tokenMeter", "sessions"]) ctx.provide(service, {});
  if (projections) ctx.provide("sessionProjections", projections);
  else await ctx.plugin(SessionProjections).await();
  await ctx.plugin(Loader).await();
  if (throwOn) ctx.on("internal/plugin", (fiber) => {
    if (!fiber.uid || fiber.entry?.options?.name !== LIVE) return;
    const on = fiber.ctx.on;
    Object.defineProperty(fiber.ctx, "on", { value(name, ...args) {
      if (name === throwOn) throw new Error(`fixture failed to register ${name}`);
      return on.call(this, name, ...args);
    } });
  }, { global: true });
  ctx.loader.internal = {
    async import(name) {
      if (name === STOCK_ENGINE) return { default: importStock ? await importStock() : BasicCompactionEngine };
      if (name === LIVE) return { default: importLive ? await importLive() : LiveCompact };
      assert.equal(name, "include-fixture");
      return { default: Include };
    },
  };
  t.after(() => ctx.fiber.dispose());
  return {
    ctx, warnings, owner: () => ctx.get("compaction", false),
    record: () => ctx.reflect.store[ctx[Symbol.for("cordis.isolate")].compaction],
    hookCount: (name) => ctx.events._hooks[name]?.length ?? 0,
  };
}

for (const slow of [STOCK_ENGINE, LIVE]) {
  test(`bundle keeps a single engine with ${slow} imported last and restores stock on disable`, async (t) => {
    const barrier = Promise.withResolvers();
    const slowImport = Promise.withResolvers();
    const load = (name, plugin) => async () => {
      if (name === slow) {
        slowImport.resolve();
        await barrier.promise;
      }
      return plugin;
    };
    const h = await host(t, { importLive: load(LIVE, LiveCompact), importStock: load(STOCK_ENGINE, BasicCompactionEngine) });
    t.after(() => barrier.resolve());
    const directory = mkdtempSync(join(tmpdir(), "spine-issue-74-"));
    t.after(() => rmSync(directory, { force: true, recursive: true }));
    const file = join(directory, "profile.yml");
    writeFileSync(file, JSON.stringify([stockRow()]));
    const patches = yaml(readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8"));
    const include = { id: "include-fixture", name: "include-fixture", config: { path: pathToFileURL(file).href, patches } };
    const loading = h.ctx.loader.root.update([include]);
    await slowImport.promise;
    await setImmediate();
    if (slow === LIVE) assert.ok(h.owner() instanceof BasicCompactionEngine);
    barrier.resolve();
    await loading;
    await h.ctx.loader.await();
    const tree = h.ctx.loader.store[include.id].subtree;
    const stock = tree.store["compaction-basic"];
    const live = tree.store["compaction-spine"];
    assert.ok(h.owner() instanceof Spine);
    assert.equal(live.fiber.state, 2, String(live.fiber._error ?? ""));
    assert.equal(stock.fiber.uid, null);
    assert.equal(stock.disabled, false);
    assert.deepEqual(stock.options.config, STOCK_CONFIG);
    await live.update({ disabled: true }, false, true);
    await h.ctx.loader.await();
    assert.ok(h.owner() instanceof BasicCompactionEngine);
    assert.ok(!(h.owner() instanceof Spine));
    assert.equal(h.owner().config.thresholdRatio, STOCK_CONFIG.thresholdRatio);
    assert.equal(h.owner().config.retainRatio, STOCK_CONFIG.retainRatio);
    assert.deepEqual(stock.options.config, STOCK_CONFIG);
    assert.equal(stock.disabled, false);
    assert.equal(h.warnings.length, 0, h.warnings.join("\n"));
  });
}

for (const failure of ["module", "import", "construct", "after-super", "session/event", "internal/config", "projection"]) {
  test(`preserves the original stock and hooks after ${failure} failure`, async (t) => {
    if (failure === "projection" && typeof BasicCompactionEngine.prototype[INIT] !== "function") return t.skip("alpha stock initialization");
    const previousEnvironment = process.env.SPINE_ENGINE_FAIL;
    t.after(() => {
      if (previousEnvironment === undefined) delete process.env.SPINE_ENGINE_FAIL;
      else process.env.SPINE_ENGINE_FAIL = previousEnvironment;
    });
    let registrations = 0;
    const projections = failure === "projection" ? { register() {
      registrations++;
      return registrations === 1 ? Promise.resolve({}) : Promise.reject(new Error("fixture projection unavailable"));
    } } : undefined;
    const throwOn = ["session/event", "internal/config"].includes(failure) ? failure : undefined;
    const h = await host(t, { projections, throwOn, async importLive() {
      if (failure === "module") throw new Error("fixture module missing");
      if (failure === "import") return (await import("../shell.js?issue-74-import-failure")).default;
      return LiveCompact;
    } });
    await h.ctx.loader.root.update([stockRow()]);
    await h.ctx.loader.await();
    assert.ok(h.owner() instanceof BasicCompactionEngine);
    const original = h.record();
    const events = ["agent/pre-step", "session/event", "internal/config"];
    const counts = events.map(h.hookCount);
    if (["import", "construct", "after-super"].includes(failure)) process.env.SPINE_ENGINE_FAIL = failure;
    else delete process.env.SPINE_ENGINE_FAIL;
    await h.ctx.loader.root.create(structuredClone(liveRow));
    await h.ctx.loader.await();
    assert.ok(h.record() === original, "the original service registration must survive");
    assert.deepEqual(events.map(h.hookCount), counts);
    assert.equal(h.ctx.loader.store["compaction-basic"].disabled, false);
    if (failure !== "module") assert.ok(h.warnings.some((line) => line.includes("本会话未接管")), h.warnings.join("\n"));
    if (failure === "projection") assert.equal(registrations, 2);
  });
}

test("cancelling Live Compact while stock import is pending leaves stock in control", async (t) => {
  const stockImport = Promise.withResolvers();
  const h = await host(t, { importStock: () => stockImport.promise });
  t.after(() => stockImport.resolve(BasicCompactionEngine));
  const loading = h.ctx.loader.root.update([stockRow(), structuredClone(liveRow)]);
  await setImmediate();
  const live = h.ctx.loader.store["compaction-spine"];
  assert.equal(live.fiber?.state, 1);
  const disabling = live.update({ disabled: true }, false, true);
  stockImport.resolve(BasicCompactionEngine);
  await Promise.all([loading, disabling]);
  await h.ctx.loader.await();
  assert.ok(h.owner() instanceof BasicCompactionEngine);
  assert.ok(!(h.owner() instanceof Spine));
  assert.equal(h.ctx.loader.store["compaction-basic"].disabled, false);
});

test("a stock entry disabled during its import does not cause a late takeover", async (t) => {
  const stockImport = Promise.withResolvers();
  const h = await host(t, { importStock: () => stockImport.promise });
  t.after(() => stockImport.resolve(BasicCompactionEngine));
  const loading = h.ctx.loader.root.update([stockRow(), structuredClone(liveRow)]);
  await setImmediate();
  const stock = h.ctx.loader.store["compaction-basic"];
  assert.equal(h.ctx.loader.store["compaction-spine"].fiber?.state, 1);
  await stock.update({ disabled: true }, false, true);
  stockImport.resolve(BasicCompactionEngine);
  await loading;
  await h.ctx.loader.await();
  assert.equal(stock.disabled, true);
  assert.ok(!(h.owner() instanceof Spine));
});

test("stock is the only automatic compactor while the new projection is pending", async (t) => {
  if (typeof BasicCompactionEngine.prototype[INIT] !== "function") return t.skip("alpha stock initialization");
  const incoming = Promise.withResolvers();
  const ready = Promise.withResolvers();
  let calls = 0;
  const h = await host(t, { projections: { register() {
    if (++calls === 1) return Promise.resolve({});
    incoming.resolve();
    return ready.promise;
  } } });
  t.after(() => ready.resolve({}));
  await h.ctx.loader.root.update([stockRow()]);
  await h.ctx.loader.await();
  const preStep = h.hookCount("agent/pre-step");
  await h.ctx.loader.root.create(structuredClone(liveRow));
  await incoming.promise;
  const whilePending = h.hookCount("agent/pre-step");
  ready.resolve({});
  await h.ctx.loader.await();
  assert.equal(whilePending, preStep);
  assert.equal(calls, 2);
  assert.ok(h.owner() instanceof Spine);
});

for (const isolate of [true, "separate-stock"]) {
  test(`root activation does not wait for stock in another compaction realm: ${isolate}`, async (t) => {
    if (typeof BasicCompactionEngine.prototype[INIT] !== "function") return t.skip("alpha stock initialization");
    const pending = Promise.withResolvers();
    const reached = Promise.withResolvers();
    let calls = 0;
    const h = await host(t, { projections: { register() {
      if (++calls !== 1) return Promise.resolve({});
      reached.resolve();
      return pending.promise;
    } } });
    t.after(() => pending.resolve({}));
    await h.ctx.loader.root.create({ ...stockRow(), isolate: { compaction: isolate } });
    await reached.promise;
    await h.ctx.loader.root.create(structuredClone(liveRow));
    await setImmediate();
    const rootWasActive = h.owner() instanceof Spine;
    const stockWasPending = h.ctx.loader.store["compaction-basic"].fiber.state === 1;
    pending.resolve({});
    await h.ctx.loader.await();
    assert.equal(rootWasActive, true);
    assert.equal(stockWasPending, true);
    assert.equal(calls, 2);
  });
}

for (const cancel of [false, true]) {
  test(`rollback does not restore stock disabled during async activation: cancel=${cancel}`, async (t) => {
    if (typeof BasicCompactionEngine.prototype[INIT] !== "function") return t.skip("alpha stock initialization");
    const incoming = Promise.withResolvers();
    const ready = Promise.withResolvers();
    let calls = 0;
    const h = await host(t, { projections: { register() {
      if (++calls === 1) return Promise.resolve({});
      incoming.resolve();
      return ready.promise;
    } } });
    t.after(() => ready.resolve({}));
    await h.ctx.loader.root.update([stockRow()]);
    await h.ctx.loader.await();
    const stock = h.ctx.loader.store["compaction-basic"];
    await h.ctx.loader.root.create(structuredClone(liveRow));
    await incoming.promise;
    await stock.update({ disabled: true }, false, true);
    const live = h.ctx.loader.store["compaction-spine"];
    if (cancel) {
      const stopping = live.update({ disabled: true }, false, true);
      ready.resolve({});
      await stopping;
    } else ready.reject(new Error("fixture projection unavailable"));
    await h.ctx.loader.await();
    assert.equal(stock.disabled, true);
    assert.equal(stock.fiber.uid, null);
    assert.ok(h.record() === undefined, "no disposed service can be published again");
    assert.equal(h.hookCount("agent/pre-step"), 0);
  });
}
