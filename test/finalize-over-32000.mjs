import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import { createAssistantMessage, createSystemMessage, createToolResultMessage, createUserMessage } from "@deepseek-ai/dsh-llm";
import { buildCard, RAIL_TOKENS, selectCutIndexes } from "../plan.js";

const failures = [];
const root = mkdtempSync(join(tmpdir(), "spine-finalize-"));
const envKeys = [
  "SPINE_SHADOW_DIR", "SPINE_ENGINE", "SPINE_CHUNK_MIN", "SPINE_CHUNK_MAX",
  "SPINE_POINTER_TOKENS", "SPINE_MIN_TOKENS", "SPINE_KEEP_ROUNDS", "SPINE_KEEP_ROUND_TOKENS",
];
const savedEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
for (const key of envKeys) delete process.env[key];
process.env.SPINE_SHADOW_DIR = root;
const { default: SpineCompactionEngine } = await import("../index.js");

const oldFacts = [
  "必须保留 ledger.txt，不要删。",
  "口令 KESTREL-4419。",
  "region=cn-north-7",
  "cache layer pinned to sqlite",
];
const logFacts = ["必须保留 journal.json。", "方案 B 使用 sqlite。"];
const assistantProse = "助手正文只作历史说明，不是硬事实。";

function numberedLog() {
  const lines = Array.from({ length: 520 }, (_, index) => `${index + 1}: INFO svc=ledger heartbeat ok`);
  lines[180] = "181: WARN ledger drift turn=3 n=0";
  lines[260] = "261: NOTICE cache layer pinned to sqlite";
  return `<path>/tmp/x/part3.log</path>\n<content>\n${lines.join("\n")}`;
}

async function check(name, fn) {
  try {
    await fn();
    console.log(`ok ${name}`);
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
    console.error(`not ok ${name}`);
    console.error(error);
  }
}

function fixture({ oldTokens = 27000, middleTokens = 300, smallTokens = 300, newestTokens = 15000, recentText = "INFO recent small log", smallName = "read" } = {}) {
  const session = Session.create(`finalize-${Math.random().toString(16).slice(2)}`);
  const prices = new Map();
  const add = (type, data, tokens) => {
    const event = session.append(type, data, { surfaceOp: "append" });
    prices.set(event.seq, tokens);
    return event.seq;
  };
  const user = (text, tokens, source = { kind: "user" }) => add("user/message", createUserMessage({
    content: [{ type: "text", text }], source,
  }), tokens);
  const round = (id, text, tokens, name = "read") => {
    const call = add("assistant/message", { turn: 1, message: createAssistantMessage({
      content: [
        { type: "text", text: assistantProse },
        { type: "tool-call", id, name, arguments: "{}" },
      ], source: { provider: "deepseek-official", model: "deepseek-chat" },
    }) }, 20);
    const result = add("tool/result", { turn: 1, message: createToolResultMessage({
      callId: id, content: [{ type: "text", text }], isError: false,
    }) }, tokens);
    return [call, result];
  };
  const checkpoint = (text, tokens = 500) => user(text, tokens, { kind: "spine-checkpoint", compactionId: `old-${session.seq}` });
  add("system/message", { message: createSystemMessage("fixture system") }, 20);
  const firstUser = user("查看旧日志，继续当前任务。", 80);
  const oldRound = round("call-old", `${logFacts.join("\n")}\n${numberedLog()}`, oldTokens);
  const cardA = buildCard("", "", oldFacts.map((text, index) => ({ role: index < 2 ? "user" : "tool", text })));
  assert.equal(cardA.ok, true);
  const a = checkpoint(cardA.text);
  const middleRound = round("call-middle", "INFO old log tail", middleTokens);
  const cardB = buildCard("", "", [{ role: "user", text: "必须原位保留最新卡 B。" }]);
  const b = checkpoint(cardB.text);
  const smallRound = round("call-small", recentText, smallTokens, smallName);
  round("call-recent-a", "INFO recent A", 20);
  round("call-recent-b", "INFO recent B", 20);
  const lastUser = user("继续当前任务，不要重新执行已完成的调用。", 80);
  const newestRound = round("call-newest", "newest tool result stays verbatim", newestTokens, "shell");
  const tail = add("assistant/message", { turn: 1, message: createAssistantMessage({
    content: [{ type: "text", text: "本轮结束。" }], source: { provider: "deepseek-official", model: "deepseek-chat" },
  }) }, 20);
  const estimateMessage = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 8;
  const measure = () => {
    const nodes = session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq);
      return { seq, tokens: prices.get(seq) ?? estimateMessage(event.type === "user/message" ? event.data : event.data.message) };
    });
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  };
  // 最新卡 B 夹在旧卡 A 和尾部小日志之间。最后 user、最新工具轮都在 B 后面。
  return { session, prices, measure, estimateMessage, firstUser, oldRound, a, middleRound, b, smallRound, lastUser, newestRound, tail };
}

function itemsFor(f) {
  return f.session.surface.nodes.map((seq) => {
    const event = f.session.eventAt(seq);
    return {
      type: event.type === "user/message" ? "user" : event.type === "tool/result" ? "tool"
        : event.type === "assistant/message" ? "assistant" : "system",
      checkpoint: event.data?.source?.kind === "spine-checkpoint",
      tokens: f.prices.get(seq),
      balancedBefore: event.type !== "tool/result",
      balancedAfter: event.type !== "assistant/message" || !event.data.message.content.some((block) => block.type === "tool-call"),
    };
  });
}

function snapshot(f) {
  return JSON.stringify({ nodes: f.session.surface.nodes, events: f.session.snapshotEvents() });
}

function continuousFixture(roundCount = 8) {
  const session = Session.create(`finalize-continuous-${Math.random().toString(16).slice(2)}`);
  const prices = new Map();
  const users = [];
  const rounds = [];
  const add = (type, data, tokens) => {
    const event = session.append(type, data, { surfaceOp: "append" });
    prices.set(event.seq, tokens);
    return event.seq;
  };
  add("system/message", { message: createSystemMessage("fixture system") }, 100);
  for (let index = 0; index < roundCount; index += 1) {
    users.push(add("user/message", createUserMessage({
      content: [{ type: "text", text: `连续任务 ${index}，读取本轮日志。` }],
    }), 80));
    const call = add("assistant/message", { turn: index, message: createAssistantMessage({
      content: [
        { type: "text", text: assistantProse },
        { type: "tool-call", id: `continuous-${index}`, name: index < roundCount - 3 ? "read" : "shell", arguments: "{}" },
      ], source: { provider: "deepseek-official", model: "deepseek-chat" },
    }) }, 20);
    const text = `${index}: INFO svc=ledger heartbeat ok\n${"ordinary log line\n".repeat(1000)}`;
    const result = add("tool/result", { turn: index, message: createToolResultMessage({
      callId: `continuous-${index}`, content: [{ type: "text", text }], isError: false,
    }) }, 12000);
    rounds.push([call, result]);
  }
  add("assistant/message", { turn: roundCount, message: createAssistantMessage({
    content: [{ type: "text", text: "本轮结束。" }], source: { provider: "deepseek-official", model: "deepseek-chat" },
  }) }, 20);
  const estimateMessage = (message) => Math.ceil(JSON.stringify(message.content).length / 4) + 8;
  const measure = () => {
    const nodes = session.surface.nodes.map((seq) => {
      const event = session.eventAt(seq);
      return { seq, tokens: prices.get(seq) ?? estimateMessage(event.type === "user/message" ? event.data : event.data.message) };
    });
    return { nodes, totalTokens: nodes.reduce((sum, node) => sum + node.tokens, 0) };
  };
  return {
    session, measure, estimateMessage, users, rounds,
    lastUser: users.at(-1), lastUserText: "连续任务 7，读取本轮日志。",
    oldRounds: rounds.slice(0, -3), recentRounds: rounds.slice(-3),
  };
}

async function finalize(f, { Engine = SpineCompactionEngine, engine = "cloud", drain = true, baseline = true } = {}) {
  // 只替换宿主服务与 tokenMeter；finishTurn、选刀、buildCard 和 commitSelectedSpan 都跑真实实现。
  const warnings = [];
  const cuts = [];
  const ctx = new Context();
  ctx.tokenMeter = { measure: f.measure, estimateMessage: f.estimateMessage };
  ctx.sessions = { flush: async () => {} };
  ctx.logger = { info() {}, debug() {}, warn: (text) => warnings.push(text) };
  ctx.llm = new Proxy({}, { get() { throw new Error("model calls forbidden"); } });
  const instance = new Engine(ctx.isolate("compaction"), { auto: false });
  instance.engineFor = () => ({ engine, source: "fixture" });
  // Simulate live capture before the first restart cursor is persisted.
  for (const event of f.session.snapshotEvents()) {
    instance.noteEvent(f.session, event);
    if (event.type === "tool/result") instance.captureOne(f.session, event);
  }
  const agent = { session: f.session, runMaintenance: async (fn) => fn(new AbortController().signal) };
  const state = instance.stateFor(agent);
  // 普通云端用零增长；收尾用已记录增长。baseline=false 模拟没有上一轮测量的会话。
  state.turnBase = baseline ? f.measure().totalTokens : null;
  state.maxTurnGrowth = drain ? RAIL_TOKENS : 0;
  instance.commitSelectedSpan = async (...args) => {
    cuts.push(args[1]);
    return Engine.prototype.commitSelectedSpan.apply(instance, args);
  };
  try { await instance.finishTurn(agent); }
  finally { await ctx.fiber.dispose(); }
  assert.equal(warnings.some((text) => /cut failed|after-turn skipped/.test(text)), false, warnings.join("\n"));
  return { cuts, warnings };
}

function assertPreserved(f, seqs, originals) {
  for (const seq of seqs) {
    assert.equal(f.session.surface.nodes.includes(seq), true, `seq ${seq} must stay on surface`);
    assert.equal(JSON.stringify(f.session.eventAt(seq)), originals.get(seq), `seq ${seq} must stay byte-for-byte`);
  }
}

try {
  await check("T1 ordinary INFO, WARN and path lines stay cuttable and out of Kept", async () => {
    const text = numberedLog();
    const card = buildCard(text, "", [{ role: "tool", text, toolCallId: "call-long-log", known: true, seq: 41 }]);
    assert.equal(card.ok, true);
    assert.deepEqual(card.missing, []);
    assert.equal(card.omittedOrdinaryToolLines > 0, true);
    assert.equal(card.text.length < text.length, true);
    const kept = card.text.split("Kept lines:\n")[1].split("\n工具证据:")[0];
    assert.equal(kept.includes("heartbeat"), false);
    assert.equal(kept.includes("WARN"), false);
    assert.equal(kept.includes("<path>"), false);
    assert.equal(kept.includes("cache layer pinned to sqlite"), true);
  });

  await check("T2 cloud drain cuts the newest legal long log without touching cards or newest round", async () => {
    const f = fixture({ oldTokens: 14500, smallTokens: 2500, recentText: numberedLog() });
    assert.equal(f.measure().totalTokens > RAIL_TOKENS, true);
    const protectedSeqs = f.session.surface.nodes.filter((seq) => !f.smallRound.includes(seq));
    const originals = new Map(protectedSeqs.map((seq) => [seq, JSON.stringify(f.session.eventAt(seq))]));
    const { cuts } = await finalize(f);
    assert.equal(cuts.length, 1);
    assert.equal(cuts[0].card.ok, true);
    const summary = f.session.snapshotEvents().find((event) => event.type === "compaction/summary");
    assert.deepEqual(summary.data.shadowedSeqs, f.smallRound);
    assert.equal(summary.data.shadowedSeqs.includes(f.a), false);
    assert.equal(summary.data.shadowedSeqs.includes(f.b), false);
    assertPreserved(f, protectedSeqs, originals);
    const text = cuts[0].card.text;
    assert.equal(text.length < numberedLog().length, true);
    const kept = text.split("Kept lines:\n")[1].split("\n工具证据:")[0];
    assert.equal(kept.includes("heartbeat"), false);
    assert.equal((text.match(/heartbeat/g) || []).length <= 3, true);
    assert.equal(text.includes(assistantProse), false);
    assert.equal(text.match(/Kept lines:/g).length, 1);
    assert.equal(f.measure().totalTokens <= RAIL_TOKENS, true);
  });

  await check("T3 an undersized newest span stops at cards instead of merging older history", async () => {
    const f = fixture({ oldTokens: 40000 });
    const before = snapshot(f);
    const { cuts, warnings } = await finalize(f);
    assert.equal(cuts.length, 0);
    assert.equal(snapshot(f), before);
    assert.equal(f.measure().totalTokens > RAIL_TOKENS, true);
    assert.equal(warnings.filter((text) => text.includes("no legal span")).length, 1);
    assert.equal(selectCutIndexes(itemsFor(f), {
      engine: "cloud", drain: true, totalTokens: f.measure().totalTokens,
      maxEnd: f.session.surface.nodes.indexOf(f.smallRound[1]),
    }), null);
  });

  await check("T4 measured total at or below 32000 does not cut even with a legal long log", async () => {
    for (const totalTokens of [RAIL_TOKENS - 1, RAIL_TOKENS]) {
      const f = fixture({ oldTokens: 14500, smallTokens: 2500, recentText: numberedLog() });
      const actual = f.measure;
      f.measure = () => ({ ...actual(), totalTokens });
      const before = snapshot(f);
      const { cuts } = await finalize(f);
      assert.equal(cuts.length, 0);
      assert.equal(snapshot(f), before);
    }
  });

  await check("T5 ordinary cloud never cuts and local never crosses the last user", async () => {
    const f = fixture({ oldTokens: 14500, smallTokens: 2500, recentText: numberedLog(), smallName: "shell" });
    const before = snapshot(f);
    const { cuts } = await finalize(f, { drain: false });
    assert.equal(cuts.length, 0);
    assert.equal(snapshot(f), before);
    assert.equal(selectCutIndexes(itemsFor(f), {
      engine: "cloud", drain: false, totalTokens: f.measure().totalTokens,
      maxEnd: f.session.surface.nodes.indexOf(f.smallRound[1]),
    }), null);

    const local = fixture({ oldTokens: 14500, smallTokens: 2500, recentText: numberedLog(), smallName: "shell" });
    const localBefore = snapshot(local);
    const localResult = await finalize(local, { engine: "local" });
    assert.equal(localResult.cuts.length, 0);
    assert.equal(snapshot(local), localBefore);
    assert.equal(selectCutIndexes(itemsFor(local), {
      engine: "local", drain: true, totalTokens: local.measure().totalTokens,
      maxEnd: local.session.surface.nodes.indexOf(local.smallRound[1]),
    }), null);
    assert.equal(selectCutIndexes([
      { type: "tool", tokens: 5000 },
      { type: "user", tokens: 80 },
      { type: "tool", tokens: 15000 },
    ], { engine: "local", drain: true, totalTokens: 40000, maxEnd: 0 }), null);
  });

  await check("T6 continuous 12000-token rounds cut old tools without the last user or newest 3 rounds", async () => {
    const f = continuousFixture();
    assert.equal(f.measure().totalTokens > 48000, true);
    const protectedSeqs = [f.lastUser, ...f.recentRounds.flat()];
    const originals = new Map(protectedSeqs.map((seq) => [seq, JSON.stringify(f.session.eventAt(seq))]));
    const { cuts } = await finalize(f, { drain: false, baseline: false });
    assert.equal(cuts.length > 0, true, "a session without a growth baseline must still drain");
    const summaries = f.session.snapshotEvents().filter((event) => event.type === "compaction/summary");
    assert.equal(summaries.length, cuts.length);
    const cutSeqs = summaries.flatMap((event) => event.data.shadowedSeqs);
    assert.equal(cutSeqs.includes(f.oldRounds.at(-1)[1]), true, "the old tool result before the last user must be selected");
    for (const seq of cutSeqs) {
      assert.equal(seq < f.lastUser, true, `cut seq ${seq} must precede the last user`);
      assert.equal(protectedSeqs.includes(seq), false, `protected seq ${seq} must stay verbatim`);
    }
    for (const chunk of cuts) {
      assert.equal(chunk.card.ok, true);
      assert.equal(chunk.card.text.includes(f.lastUserText), false, "the card must not absorb the last user");
    }
    assertPreserved(f, protectedSeqs, originals);
  });
} finally {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`finalize over 32000 failed: ${failures.length}`);
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log("finalize over 32000 passed (T1-T6)");
}
