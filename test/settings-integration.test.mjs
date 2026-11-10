import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import { updateVolatile } from "@deepseek-ai/cosmokit";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import Entry from "../shell.js";
import Spine from "../index.js";
import { STOCK_ENGINE } from "../adapter.js";
import Gate, { rewritePresetConfig } from "../gate.js";
import { DEFAULTS, ENV, engineConfig, readSettings } from "../settings.js";

// Only these plugin test variables are read or changed. Never use a real profile.
const envKeys = [...Object.values(ENV), "SPINE_THRESHOLD_RATIO", "SPINE_HEADROOM_TOKENS", "SPINE_RETAIN_TOKENS",
  "SPINE_ENGINE_FAIL", "SPINE_STOCK_FAIL", "SPINE_SHADOW_DIR", "SPINE_THUNDER"];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
const shadow = mkdtempSync(join(tmpdir(), "spine-settings-"));
process.env.SPINE_SHADOW_DIR = shadow;
after(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(shadow, { recursive: true, force: true });
});

let fixtureId = 0;
function fixture(totalTokens = 24000) {
  const session = Session.create(`settings-${++fixtureId}`);
  const prices = new Map();
  const append = (type, data, tokens) => {
    const event = session.append(type, data, { surfaceOp: "append" });
    prices.set(event.seq, tokens);
    return event.seq;
  };
  append("system/message", { message: createSystemMessage("settings integration fixture") }, totalTokens - 3270);
  append("user/message", createUserMessage({ content: [{ type: "text", text: "读取日志并继续任务。" }] }), 80);
  const round = (id, name, tokens) => {
    append("assistant/message", { turn: 1, message: createAssistantMessage({
      content: [{ type: "tool-call", id, name, arguments: "{}" }],
      source: { provider: "test", model: "no-network" },
    }) }, 20);
    return append("tool/result", { turn: 1, message: createToolResultMessage({
      callId: id, content: [{ type: "text", text: "INFO fixture heartbeat ok\n".repeat(name === "read" ? 300 : 1) }], isError: false,
    }) }, tokens);
  };
  const longResult = round("long", "read", 3000);
  for (let index = 0; index < 3; index++) round(`short-${index}`, "shell", 30);
  append("assistant/message", { turn: 1, message: createAssistantMessage({
    content: [{ type: "text", text: "本轮结束。" }], source: { provider: "test", model: "no-network" },
  }) }, 20);
  const estimateMessage = () => 200;
  const measure = () => {
    const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: prices.get(seq) ?? 200 }));
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  };
  const agent = { session, runMaintenance: (fn) => fn(new AbortController().signal) };
  return { session, agent, longResult, measure, estimateMessage };
}

function host(t) {
  const ctx = new Context();
  const fixtures = new Map();
  const warnings = [];
  let modelCalls = 0;
  const forbiddenModelCall = () => { modelCalls++; throw new Error("network/model calls are forbidden"); };
  ctx.logger = { info() {}, debug() {}, warn: (message) => warnings.push(message), error: (error) => warnings.push(String(error)) };
  ctx.provide("sessions", { flush: async () => {}, prune() {} });
  ctx.provide("tokenMeter", {
    measure: (session) => fixtures.get(session).measure(),
    estimateMessage: () => 200,
  });
  ctx.provide("llm", new Proxy({}, { get: () => forbiddenModelCall }));
  t.after(async () => {
    await ctx.fiber.dispose();
    assert.equal(modelCalls, 0, "local cuts must make zero model calls");
    assert.equal(warnings.some((line) => /cut failed|after-turn skipped/.test(line)), false, warnings.join("\n"));
  });
  return {
    ctx, warnings,
    engine(raw = {}, EntryClass = Entry, context = ctx.isolate("compaction")) {
      const config = EntryClass.Config({ auto: false, ...raw });
      const engine = new EntryClass(context, config);
      if (engine instanceof Spine) {
        // Avoid provider discovery, which may inspect real host profile configuration.
        engine.engineFor = () => ({ engine: "local", source: "test-fixture" });
      }
      return { engine, config };
    },
    async finish(engine, f = fixture()) {
      fixtures.set(f.session, f);
      // A live host emits results before idle maintenance. Do not ask restart
      // recovery to invent originals for history this fixture never captured.
      for (const event of f.session.snapshotEvents()) ctx.emit("session/event", f.session, event);
      await engine.finishTurn(f.agent);
      const cut = !f.session.surface.nodes.includes(f.longResult);
      assert.equal(f.session.surface.nodes.some((seq) => f.session.eventAt(seq)?.data?.source?.kind === "spine-checkpoint"), cut);
      return cut;
    },
    preset(explicit = {}) {
      const preset = { id: "standard", plugins: [{ name: STOCK_ENGINE, config: explicit }] };
      return ctx.waterfall(null, "internal/config", preset, () => preset).plugins[0];
    },
  };
}

async function updateFiberConfig(fiber, patch) {
  const key = Object.keys(patch)[0];
  const target = fiber?.config?.[key];
  const volatileWrite = Symbol.for("cosmokit.volatile.write");
  if (target && typeof target === "object" && typeof target[volatileWrite] === "function") {
    updateVolatile(target, Entry.Config(patch)[key]);
    return;
  }
  await fiber.update({ ...fiber.config, ...patch }, true);
}

test("actual schema preserves absence, explicit defaults beat env, zero remains meaningful", () => {
  const env = { SPINE_MIN_TOKENS: "9000", SPINE_CHUNK_MIN: "500", SPINE_POINTER_TOKENS: "7000" };
  const absent = Entry.Config({});
  assert.equal(absent.minTokens.get(), undefined);
  assert.equal(readSettings(absent, env).minTokens, 9000);
  assert.equal(readSettings(Entry.Config({ minTokens: 20000 }), env).minTokens, 20000);
  assert.equal(readSettings(Entry.Config({ chunkMin: 0 }), env).chunkMin, 0);
  assert.equal(readSettings(Entry.Config({ pointerTokens: 0 }), env).pointerTokens, 32000);
  assert.deepEqual(readSettings(absent, {}), { ...DEFAULTS, pointerTokens: 32000 });
});

test("blank and nonnumeric env values fall back safely through actual schema", () => {
  for (const value of ["", " \t ", "invalid"]) {
    const env = Object.fromEntries(Object.values(ENV).map((key) => [key, value]));
    assert.deepEqual(readSettings(Entry.Config({}), env), { ...DEFAULTS, pointerTokens: 32000 });
    assert.equal(engineConfig(Entry.Config({}), { SPINE_THRESHOLD_RATIO: value }).thresholdRatio, 0.8);
  }
});

test("keepRounds schema rejects zero/fractions and legacy invalid values default to three", () => {
  for (const keepRounds of [0, -1, 1.5]) {
    assert.throws(() => Entry.Config({ keepRounds }), /keepRounds/);
    assert.equal(readSettings({ keepRounds }, {}).keepRounds, 3);
    assert.equal(readSettings({}, { SPINE_KEEP_ROUNDS: String(keepRounds) }).keepRounds, 3);
  }
  assert.equal(readSettings(Entry.Config({ keepRounds: 1 }), {}).keepRounds, 1);
});

test("ordinary shell passes full config: 25000 prevents a real cut at 24000", async (t) => {
  const h = host(t);
  const { engine } = h.engine({ minTokens: 25000, chunkMin: 1500, bigGate: 600000, cooldownMs: 100 });
  assert.ok(engine instanceof Spine);
  assert.equal(readSettings(engine.liveConfig).chunkMin, 1500);
  assert.equal(await h.finish(engine), false);
  assert.equal(await h.finish(h.engine().engine), true);
});

test("ordinary shell respects an environment fallback after schema normalization", async (t) => {
  const h = host(t);
  process.env.SPINE_MIN_TOKENS = "25000";
  try {
    assert.equal(await h.finish(h.engine().engine), false);
    assert.equal(await h.finish(h.engine({ minTokens: 20000 }).engine), true);
  } finally { delete process.env.SPINE_MIN_TOKENS; }
});

test("stock defaults and env precedence also survive actual schema and root preset forwarding", (t) => {
  const h = host(t);
  const defaults = h.engine().engine.config;
  assert.equal(defaults.thresholdRatio, 0.8);
  assert.equal(defaults.headroomTokens, 65536);
  assert.equal(defaults.retainTokens, 8192);
  assert.equal(defaults.compactionRetries, 0);
  process.env.SPINE_HEADROOM_TOKENS = "16384";
  try {
    assert.equal(h.engine().engine.config.headroomTokens, 16384);
    assert.equal(h.preset().config.headroomTokens, 16384);
    assert.equal(h.engine({ headroomTokens: 65536 }).engine.config.headroomTokens, 65536);
    assert.equal(h.preset({ headroomTokens: 32768 }).config.headroomTokens, 32768);
    process.env.SPINE_HEADROOM_TOKENS = " ";
    assert.equal(h.preset().config.headroomTokens, 65536);
  } finally { delete process.env.SPINE_HEADROOM_TOKENS; }
});

test("real entry and direct Spine resolve low thresholds and legacy retention identically", (t) => {
  const h = host(t);
  const cases = [
    { thresholdRatio: 0.1 },
    { thresholdRatio: 0.05 },
    { thresholdRatio: 0.1, retainRatio: 0.05 },
    { thresholdRatio: 0.1, retainTokens: 4096, maxTokens: 2048 },
    { thresholdRatio: 0.1, modelPolicies: [{ provider: "test", model: "local", thresholdRatio: 0.05 }] },
    { thresholdRatio: 0.1, ...stockFields, retainRatio: 0.05 },
  ];
  for (const raw of cases) {
    const config = Entry.Config(raw);
    const direct = new Spine(h.ctx.isolate("compaction"), config);
    const entry = new Entry(h.ctx.isolate("compaction"), config);
    assert.ok(entry instanceof Spine, JSON.stringify(raw));
    assert.deepEqual(entry.config, direct.config);
    assert.equal(entry.config.auto, true);
    if (raw.retainRatio === undefined && raw.retainTokens === undefined) assert.equal(entry.config.retainTokens, 8192);
  }
  process.env.SPINE_THRESHOLD_RATIO = "0.1";
  process.env.SPINE_RETAIN_TOKENS = "4096";
  try {
    const { engine } = h.engine();
    assert.ok(engine instanceof Spine);
    assert.equal(engine.config.thresholdRatio, 0.1);
    assert.equal(engine.config.retainTokens, 4096);
    assert.equal(h.engine({ retainRatio: 0.05 }).engine.config.retainTokens, undefined);
  } finally {
    delete process.env.SPINE_THRESHOLD_RATIO;
    delete process.env.SPINE_RETAIN_TOKENS;
  }
});

test("real entry preserves native stock errors and releases only its failed service", async (t) => {
  const h = host(t);
  const healthyContext = h.ctx.isolate("compaction");
  const healthy = h.engine({}, Entry, healthyContext).engine;
  const cases = [
    { thresholdRatio: 0.1, retainRatio: 0.2 },
    { thresholdRatio: 0.1, retainRatio: 0.2, typoStockField: 1 },
    { thresholdRatio: 0.1, retainRatio: 0.2, summarizationProvider: "test" },
    { retainRatio: 0.1, retainTokens: 8192 },
    { thresholdRatio: 2 },
    { headroomTokens: 0 },
    { modelPolicies: [stockFields.modelPolicies[0], stockFields.modelPolicies[0]] },
    { modelPolicies: [{ provider: "test", model: "local", retainRatio: 0.9 }] },
  ];
  for (const raw of cases) {
    const config = Entry.Config({ auto: false, ...raw });
    let expected;
    assert.throws(() => new Spine(h.ctx.isolate("compaction"), config), (error) => {
      expected = error.message;
      return true;
    });
    const context = h.ctx.isolate("compaction");
    const unavailable = new Entry(context, config);
    assert.equal(unavailable.reason, expected);
    assert.equal(context.get("compaction", false).reason, expected);
    await assert.rejects(unavailable.compactNow(), (error) => error.message.endsWith(expected));
    assert.equal(healthyContext.get("compaction", false).config, healthy.config);
  }
});

test("volatile save and reset affect the next maintenance on the same engine", async (t) => {
  const h = host(t);
  const { engine, config } = h.engine({ minTokens: 25000 });
  assert.equal(await h.finish(engine), false);
  updateVolatile(config.minTokens, Entry.Config({ minTokens: 20000 }).minTokens);
  assert.equal(await h.finish(engine), true);
  process.env.SPINE_MIN_TOKENS = "25000";
  try {
    updateVolatile(config.minTokens, Entry.Config({}).minTokens);
    assert.equal(await h.finish(engine), false, "reset must restore env fallback");
    process.env.SPINE_MIN_TOKENS = " ";
    assert.equal(await h.finish(engine), true, "blank env must restore 20000 default");
  } finally { delete process.env.SPINE_MIN_TOKENS; }
});

test("one maintenance uses a consistent snapshot even if a save occurs while measuring", async (t) => {
  const h = host(t);
  const { engine, config } = h.engine({ minTokens: 25000 });
  const f = fixture();
  const measure = f.measure;
  f.measure = () => {
    updateVolatile(config.minTokens, Entry.Config({ minTokens: 20000 }).minTokens);
    return measure();
  };
  assert.equal(await h.finish(engine, f), false);
  assert.equal(await h.finish(engine), true);
});

test("two engines in one host keep independent settings", async (t) => {
  const h = host(t);
  const a = h.engine({ minTokens: 25000 });
  const b = h.engine({ minTokens: 20000 });
  assert.equal(await h.finish(a.engine), false);
  assert.equal(await h.finish(b.engine), true);
  updateVolatile(b.config.minTokens, Entry.Config({ minTokens: 26000 }).minTokens);
  assert.equal(await h.finish(a.engine), false);
  assert.equal(await h.finish(b.engine), false);
});

test("restart capture uses this engine's keepRounds, including legacy zero fallback", (t) => {
  const h = host(t);
  const run = (keepRounds) => {
    const { engine } = h.engine();
    engine.liveConfig = { keepRounds };
    engine.persistCapture = false;
    const captured = [];
    engine.captureOne = (_session, event) => captured.push(event.seq);
    const events = Array.from({ length: 5 }, (_, seq) => ({ seq, type: "tool/result", data: { message: { toolCallId: `c-${seq}` } } }));
    engine.captureNew({ id: `keep-${keepRounds}` }, events);
    return captured;
  };
  assert.deepEqual(run(1), [4]);
  assert.deepEqual(run(0), [2, 3, 4]);
});

test("shell-installed gate forwards root settings, preset overrides win, old presets stay snapshots", async (t) => {
  const h = host(t);
  const root = h.engine({ minTokens: 25000, chunkMin: 1500, maxTokens: 4096, takeoverPresets: true });
  const first = h.preset();
  assert.equal(first.name, "dsh-live-compact");
  assert.equal(first.config.minTokens, 25000);
  assert.equal(first.config.chunkMin, 1500);
  assert.equal(first.config.maxTokens, 4096);
  const inherited = h.engine(first.config).engine;
  const explicit = h.engine(h.preset({ minTokens: 20000, chunkMin: 0, maxTokens: 2048 }).config).engine;
  assert.equal(explicit.config.maxTokens, 2048);
  assert.equal(await h.finish(inherited), false);
  assert.equal(await h.finish(explicit), true);
  await updateFiberConfig(root, { minTokens: 20000 });
  assert.equal(await h.finish(inherited), false);
  assert.equal(await h.finish(h.engine(h.preset().config).engine), true);
  await updateFiberConfig(root, { takeoverPresets: false });
  assert.equal(h.preset().name, STOCK_ENGINE);
  assert.equal(first.name, "dsh-live-compact");
});

for (const legacyFirst of [true, false]) {
  test(`real Context root owns the sole gate with legacy ${legacyFirst ? "before" : "after"} root, including reload`, async (t) => {
    const h = host(t);
    const listenerCount = () => h.ctx.events._hooks["internal/config"]?.length ?? 0;
    const listenerBaseline = listenerCount();
    const rootScope = h.ctx.isolate("compaction");
    const loadRoot = async () => {
      const fiber = await rootScope.plugin(Entry, { auto: false, takeoverPresets: false, minTokens: 25000 });
      assert.equal(fiber.state, 2, String(fiber._error));
      assert.ok(fiber.ctx.compaction instanceof Spine);
      return fiber;
    };
    const loadLegacy = async () => {
      const fiber = await h.ctx.plugin(Gate, { takeoverPresets: true, minTokens: 12000 });
      assert.equal(fiber.state, 2, String(fiber._error));
      return fiber;
    };
    let legacy;
    let root;
    if (legacyFirst) {
      legacy = await loadLegacy();
      assert.equal(h.preset().config.minTokens, 12000);
      root = await loadRoot();
    } else {
      root = await loadRoot();
      legacy = await loadLegacy();
    }
    assert.equal(listenerCount(), listenerBaseline + 1);
    assert.equal(h.preset().name, STOCK_ENGINE);

    await updateFiberConfig(root, { takeoverPresets: true });
    const inherited = h.preset();
    assert.equal(inherited.name, "dsh-live-compact");
    assert.equal(inherited.config.minTokens, 25000);
    const nestedParent = await h.ctx.plugin(function presetGroup() {});
    const loadNested = async () => {
      const fiber = await nestedParent.ctx.isolate("compaction").plugin(Entry, {
        auto: false, takeoverPresets: true, minTokens: 5000,
      });
      assert.equal(fiber.state, 2, String(fiber._error));
      return fiber;
    };
    const nested = await loadNested();
    assert.equal(h.preset().config.minTokens, 25000, "nested settings cannot become root settings");
    assert.equal(h.preset({ minTokens: 21000 }).config.minTokens, 21000, "explicit preset settings still win");
    await updateFiberConfig(root, { takeoverPresets: false });
    assert.equal(h.preset().name, STOCK_ENGINE);

    await legacy.dispose();
    assert.equal(listenerCount(), listenerBaseline + 1, "disposing the old gate must not remove the root listener");
    legacy = await loadLegacy();
    assert.equal(listenerCount(), listenerBaseline + 1);
    assert.equal(h.preset().name, STOCK_ENGINE);
    await root.dispose();
    assert.equal(listenerCount(), listenerBaseline);
    await nested.dispose();
    await loadNested();
    await legacy.dispose();
    legacy = await loadLegacy();
    assert.equal(listenerCount(), listenerBaseline, "nested/legacy reload cannot replace a disposed root's authority");
    assert.equal(h.preset().name, STOCK_ENGINE);
    root = await loadRoot();
    assert.equal(listenerCount(), listenerBaseline + 1);
    assert.equal(h.preset().name, STOCK_ENGINE);
    assert.equal(inherited.config.minTokens, 25000, "existing presets remain snapshots");
    await root.restart();
    await root.await();
    assert.equal(root.state, 2, String(root._error));
    assert.equal(listenerCount(), listenerBaseline + 1);
    assert.equal(h.preset().name, STOCK_ENGINE);
    await updateFiberConfig(root, { takeoverPresets: true });
    assert.equal(h.preset().config.minTokens, 25000, "reloaded root retains its numeric settings");
  });
}

test("real Context compatibility gate alone keeps its settings across reload", async (t) => {
  const h = host(t);
  const listenerCount = () => h.ctx.events._hooks["internal/config"]?.length ?? 0;
  const listenerBaseline = listenerCount();
  const legacy = await h.ctx.plugin(Gate, { minTokens: 23000 });
  assert.equal(legacy.state, 2, String(legacy._error));
  assert.equal(h.preset().config.minTokens, 23000);
  await legacy.restart();
  await legacy.await();
  assert.equal(legacy.state, 2, String(legacy._error));
  assert.equal(listenerCount(), listenerBaseline + 1);
  assert.equal(h.preset().config.minTokens, 23000);
  await legacy.dispose();
  assert.equal(listenerCount(), listenerBaseline);
  assert.equal(h.preset().name, STOCK_ENGINE);
});

test("real Context root supersedes a nested entry loaded after the compatibility gate", async (t) => {
  const h = host(t);
  const listenerCount = () => h.ctx.events._hooks["internal/config"]?.length ?? 0;
  const listenerBaseline = listenerCount();
  const legacy = await h.ctx.plugin(Gate, { minTokens: 12000 });
  const group = await h.ctx.plugin(function presetGroup() {});
  const nested = await group.ctx.isolate("compaction").plugin(Entry, { auto: false, minTokens: 5000 });
  assert.equal(nested.state, 2, String(nested._error));
  const root = await h.ctx.isolate("compaction").plugin(Entry, {
    auto: false, takeoverPresets: false, minTokens: 25000,
  });
  assert.equal(root.state, 2, String(root._error));
  assert.equal(listenerCount(), listenerBaseline + 1);
  assert.equal(h.preset().name, STOCK_ENGINE);
  await nested.dispose();
  await legacy.dispose();
  await updateFiberConfig(root, { takeoverPresets: true });
  assert.equal(h.preset().config.minTokens, 25000);
  assert.equal(listenerCount(), listenerBaseline + 1);
});

test("nested and legacy preset callers preserve explicit retention mode and don't mutate input", () => {
  const input = { id: "preset-standard", config: { id: "standard", plugins: [{
    name: "cordis:group", config: [{ name: STOCK_ENGINE, config: { retainRatio: 0.1 } }],
  }] } };
  const before = JSON.stringify(input);
  const rewritten = rewritePresetConfig(input, true, Entry.Config({ retainTokens: 8192, minTokens: 25000 }));
  const config = rewritten.config.plugins[0].config[0].config;
  assert.equal(config.retainRatio, 0.1);
  assert.equal(config.retainTokens, undefined);
  assert.equal(config.minTokens, 25000);
  assert.equal(JSON.stringify(input), before);
  assert.equal(rewritePresetConfig({ id: "standard", plugins: [{ name: STOCK_ENGINE }] }, true).plugins[0].config.retainTokens, 8192);
  assert.deepEqual(rewritePresetConfig(input, false), input);
});

const stockFields = {
  retainRatio: 0.12, maxTokens: 4096, summarizationProvider: "test", summarizationModel: "summary",
  maxOverflowRetries: 2, compactionRetries: 2,
  modelPolicies: [{ provider: "test", model: "routed", thresholdRatio: 0.7, retainTokens: 2048,
    maxTokens: 1024, summarizationProvider: "test", summarizationModel: "other-summary", maxOverflowRetries: 3 }],
};

test("plugin preserves host-supported stock fields, native schema and constructor validation", (t) => {
  const h = host(t);
  const { engine } = h.engine(stockFields);
  for (const [key, value] of Object.entries(stockFields)) assert.deepEqual(engine.config[key], value, key);
  assert.equal(engine.config.retainTokens, undefined);
  for (const [key, field] of Object.entries(BasicCompactionEngine.Config.dict)) {
    assert.ok(Entry.Config.dict[key], key);
    assert.equal(Entry.Config.dict[key].meta.volatile, true);
    assert.notEqual(field.meta.volatile, true, "plugin must not mutate stock schema");
  }
  assert.throws(() => Entry.Config({ maxTokens: 0 }), /maxTokens/);
  assert.throws(() => Entry.Config({ modelPolicies: [{ provider: "test" }] }), /model/);
});

test("import failure fallback keeps full validated stock config and rejects unknown/conflicting fields", async (t) => {
  const h = host(t);
  let Fallback;
  process.env.SPINE_ENGINE_FAIL = "import";
  try { ({ default: Fallback } = await import("../shell.js?settings-fallback")); }
  finally { delete process.env.SPINE_ENGINE_FAIL; }
  const healthyContext = h.ctx.isolate("compaction");
  const { engine } = h.engine({ ...stockFields, minTokens: 25000, chunkMin: 1500 }, Fallback, healthyContext);
  assert.ok(engine instanceof BasicCompactionEngine);
  assert.equal(engine instanceof Spine, false);
  for (const [key, value] of Object.entries(stockFields)) assert.deepEqual(engine.config[key], value, key);
  assert.equal(engine.config.retainTokens, undefined);
  const unknown = h.engine({ typoStockField: 1 }, Fallback).engine;
  await assert.rejects(unknown.compactNow(), /unknown key.*typoStockField/);
  const invalid = h.engine({ retainRatio: 0.1, retainTokens: 8192 }, Fallback).engine;
  await assert.rejects(invalid.compactNow(), /mutually exclusive/);
  const duplicate = h.engine({ modelPolicies: [stockFields.modelPolicies[0], stockFields.modelPolicies[0]] }, Fallback).engine;
  await assert.rejects(duplicate.compactNow(), /duplicate model policy/);
  assert.equal(healthyContext.get("compaction", false).config.maxTokens, 4096, "failed construction must preserve other scopes");
});
