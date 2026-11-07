import assert from "node:assert/strict";
import fs, { existsSync, readFileSync, readdirSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { BasicCompactionEngine } from "@deepseek-ai/dsh-compaction-basic";
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from "@deepseek-ai/dsh-compaction";
import { Session } from "@deepseek-ai/dsh-session";
import { contentHash, pointerFor } from "../raw.js";
import { skipLiveOfficialCompaction } from "../cooldown.js";
import { messageText } from "../plan.js";
import { resetShadowAccessState, sessionDir } from "../shadow.js";
import { fixture, runtime } from "./helpers/runtime.mjs";

const eventHash = (f) => contentHash(JSON.stringify(f.session.snapshotEvents()));
const summaryText = (f) => f.summaries().map((event) => messageText({ content: event.data.summary })).join("\n");
const checkpoints = (f, kind) => f.session.surface.nodes.filter((seq) => f.session.eventAt(seq)?.data?.source?.kind === kind);

test("an incomplete capacity scan after selection preserves the real surface and later maintenance recovers", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  h.capture(engine, f);
  const old = `${h.root}/cut-9-11111111.txt`;
  fs.writeFileSync(old, "x".repeat(900));
  const canonicalOld = fs.realpathSync.native(old);
  process.env.SPINE_SHADOW_MAX_BYTES = "1000";
  const before = eventHash(f);
  const original = fs.statSync;
  const mock = t.mock.method(fs, "statSync", (path, ...args) => {
    if (String(path) === canonicalOld) throw Object.assign(new Error("unreadable backup"), { code: "EACCES" });
    return original(path, ...args);
  });
  syncBuiltinESMExports();
  try { await engine.finishTurn(f.agent()); }
  finally { mock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(eventHash(f), before);
  assert.equal(f.summaries().length, 0);
  assert.ok(h.warnings.some(line => line.includes("scan is incomplete")));
  assert.equal(fs.statSync(old).size, 900);
  process.env.SPINE_SHADOW_MAX_BYTES = "1000000";
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1, h.warnings.join("\n"));
  assert.equal(h.modelCalls, 0);
});

test("positive local cut stays after latest user, preserves prefix bytes and the default three pairs", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ long: { name: "shell" } }));
  const { engine } = h.engine();
  h.capture(engine, f);
  const prefix = f.session.surface.nodes.slice(0, f.session.surface.nodes.indexOf(f.longRound[0]));
  const prefixMessages = JSON.stringify(f.session.deriveMessages().slice(0, prefix.length));
  const protectedSeqs = [...prefix, ...f.rounds.slice(-3).flat()];
  const originals = new Map(protectedSeqs.map((seq) => [seq, JSON.stringify(f.session.eventAt(seq))]));
  assert.ok(toolPairingBalancedBefore(f.session, f.longRound[0]));
  assert.ok(toolPairingBalancedAfter(f.session, f.longRound[1]));
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1, h.warnings.join("\n"));
  const selected = f.summaries()[0].data.shadowedSeqs;
  assert.deepEqual(selected, f.longRound);
  assert.ok(selected.every((seq) => seq > f.lastUser));
  assert.deepEqual(f.session.surface.nodes.slice(0, prefix.length), prefix);
  assert.equal(JSON.stringify(f.session.deriveMessages().slice(0, prefix.length)), prefixMessages);
  for (const seq of protectedSeqs) {
    assert.ok(f.session.surface.nodes.includes(seq));
    assert.equal(JSON.stringify(f.session.eventAt(seq)), originals.get(seq));
  }
  assert.ok(toolPairingBalancedAfter(f.session, f.session.surface.nodes.at(-1)));
  assert.equal(checkpoints(f, "spine-checkpoint").length, 1);
  assert.equal(checkpoints(f, "compact-checkpoint").length, 0);
  assert.equal(summaryText(f).includes(h.root), false);
});

test("real finishTurn permits a newest long read at 20000, skips 19999, and requests no summary model", async (t) => {
  const h = runtime(t);
  const { engine } = h.engine({}, "cloud");
  for (const totalTokens of [19999, 20000]) {
    const f = h.use(fixture({ totalTokens, longLast: true }));
    h.capture(engine, f);
    assert.equal(f.measure().totalTokens, totalTokens);
    const recent = f.rounds.slice(0, 3).flat();
    const before = eventHash(f);
    await engine.finishTurn(f.agent());
    if (totalTokens === 19999) {
      assert.equal(eventHash(f), before);
      assert.equal(f.summaries().length, 0);
    } else {
      assert.equal(f.summaries().length, 1, h.warnings.join("\n"));
      assert.deepEqual(f.summaries()[0].data.shadowedSeqs, f.longRound);
      for (const seq of recent) assert.ok(f.session.surface.nodes.includes(seq));
    }
  }
  assert.equal(h.modelCalls, 0);
});

test("fifty small-result turns remain usable without inventing cross-user aggregation (#11)", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture({ long: { name: "shell", tokens: 400, text: "small result" } }));
  const { engine } = h.engine();
  h.capture(engine, f);
  for (let index = 0; index < 50; index++) {
    f.user(`执行下一小步 ${index}。`);
    const round = f.round(`small-${index}`, { tokens: 400, turn: index + 2 });
    const before = eventHash(f);
    await engine.finishTurn(f.agent());
    assert.equal(eventHash(f), before);
    assert.ok(f.session.surface.nodes.includes(round[1]));
  }
  assert.equal(f.summaries().length, 0);
  assert.equal(h.warnings.some((line) => /failed|skipped:/.test(line)), false);
});

for (const kind of ["compact-checkpoint", "spine-checkpoint"]) {
  test(`terminal commit refuses a ${kind} before backup or replacement`, async (t) => {
    const h = runtime(t);
    const f = h.use(fixture());
    const { engine } = h.engine();
    h.capture(engine, f);
    const marker = f.user("existing checkpoint", { kind });
    const before = eventHash(f);
    const files = readdirSync(h.root, { recursive: true }).sort();
    await assert.rejects(engine.commitSelectedSpan(f.agent(), {
      start: f.longRound[0], end: marker, tokens: 10000,
      card: { ok: true, text: "fixture retained context" },
    }, new AbortController().signal), /boundary|checkpoint/);
    assert.equal(eventHash(f), before);
    assert.deepEqual(readdirSync(h.root, { recursive: true }).sort(), files);
  });
}

test("terminal local commit refuses an old span after a newer genuine user arrives", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  h.capture(engine, f);
  f.user("新的真实用户指令。");
  const before = eventHash(f);
  await assert.rejects(engine.commitSelectedSpan(f.agent(), {
    start: f.longRound[0], end: f.longRound[1], tokens: 3020,
    card: { ok: true, text: "fixture retained context" },
  }, new AbortController().signal), /boundary/);
  assert.equal(eventHash(f), before);
  assert.equal(f.summaries().length, 0);
});

test("terminal commit refuses an unbalanced tool span", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  h.capture(engine, f);
  const before = eventHash(f);
  await assert.rejects(engine.commitSelectedSpan(f.agent(), {
    start: f.longRound[1], end: f.longRound[1], tokens: 3000,
    card: { ok: true, text: "fixture retained context" },
  }, new AbortController().signal), /tool pairing/);
  assert.equal(eventHash(f), before);
});

test("a user arriving while local summarization yields prevents stale replacement", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  h.capture(engine, f);
  const summarize = engine.summarize.bind(engine);
  let latest;
  t.mock.method(engine, "summarize", async (...args) => {
    const result = await summarize(...args);
    latest = f.user("备份后到达的新用户指令。");
    return result;
  });
  await assert.rejects(engine.commitSelectedSpan(f.agent(), {
    start: f.longRound[0], end: f.longRound[1], tokens: 3020,
    card: { ok: true, text: "fixture retained context" },
  }, new AbortController().signal), /boundary/);
  assert.ok(f.session.surface.nodes.includes(latest));
  for (const seq of f.longRound) assert.ok(f.session.surface.nodes.includes(seq));
  assert.equal(f.summaries().length, 0);
});

test("terminal cloud commit retains the existing earlier-user span contract", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine({}, "cloud");
  const earlier = "保留较早用户原文。";
  f.user(earlier);
  const last = f.round("after-earlier", { tokens: 3000, text: "INFO fixture heartbeat ok\n".repeat(300) });
  const latest = f.user("最新用户留在压缩段之外。");
  h.capture(engine, f);
  await engine.commitSelectedSpan(f.agent(), {
    start: f.longRound[0], end: last[1], tokens: 10000,
    card: { ok: true, text: `旧用户原文：${JSON.stringify(earlier)}` },
  }, new AbortController().signal);
  assert.ok(f.session.surface.nodes.includes(latest));
  assert.equal(f.summaries().length, 1);
  assert.ok(summaryText(f).includes(earlier));
});

test("a new official checkpoint while local summarization yields retires an older cloud span", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine({}, "cloud");
  h.capture(engine, f);
  const summarize = engine.summarize.bind(engine);
  let official;
  t.mock.method(engine, "summarize", async (...args) => {
    const result = await summarize(...args);
    official = f.user("new official checkpoint", { kind: "compact-checkpoint" });
    return result;
  });
  await assert.rejects(engine.commitSelectedSpan(f.agent(), {
    start: f.longRound[0], end: f.longRound[1], tokens: 3020,
    card: { ok: true, text: "fixture retained context" },
  }, new AbortController().signal), /boundary|checkpoint/);
  assert.ok(f.session.surface.nodes.includes(official));
  for (const seq of f.longRound) assert.ok(f.session.surface.nodes.includes(seq));
  assert.equal(f.summaries().length, 0);
});

test("stock → spine → stock uses genuine transactions; cooldown is once per checkpoint and session", async (t) => {
  const h = runtime(t);
  const stockInputs = [];
  class FixtureStock extends BasicCompactionEngine {
    async summarize(input) {
      stockInputs.push(input.messages.map(messageText).join("\n"));
      return { summary: [{ type: "text", text: "stock fixture summary" }], provider: "fixture", model: "no-network" };
    }
  }
  const stock = h.engine({}, "local", FixtureStock).engine;
  const spine = h.engine().engine;
  const f = h.use(fixture());
  await stock.compactNow(f.agent(), new AbortController().signal);
  const official = checkpoints(f, "compact-checkpoint")[0];
  assert.equal(typeof official, "number");
  const addWork = (name) => {
    f.user("继续当前任务。");
    const long = f.round(name, { name: "read", tokens: 3000, text: "INFO ledger heartbeat ok\n".repeat(300) });
    for (let index = 0; index < 3; index++) f.round(`${name}-short-${index}`);
    return long;
  };
  const long = addWork("after-stock");
  h.capture(spine, f);
  const before = eventHash(f);
  await spine.finishTurn(f.agent());
  assert.equal(eventHash(f), before, "first idle after stock skips");
  await spine.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, long, h.warnings.join("\n"));
  assert.ok(f.session.surface.nodes.includes(official), "spine leaves the stock checkpoint before its cut intact");
  const spineCard = checkpoints(f, "spine-checkpoint")[0];
  assert.equal(typeof spineCard, "number");
  const newer = addWork("after-restart");
  f.session = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())));
  h.use(f);
  const restarted = h.engine().engine;
  await restarted.finishTurn(f.agent());
  assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, newer, "restored official history must not consume the first maintenance");
  const other = h.use(fixture());
  await stock.compactNow(other.agent(), new AbortController().signal);
  const otherHash = eventHash(other);
  await spine.finishTurn(other.agent());
  assert.equal(eventHash(other), otherHash);
  assert.equal(skipLiveOfficialCompaction(other.session), false, "the live official card was consumed for this Session");
  // Real stock selection may include spine checkpoints. Do not promise otherwise.
  const result = await stock.compactNow(f.agent(), new AbortController().signal);
  assert.ok(result.shadowedSeqs.includes(spineCard));
  assert.ok(stockInputs.at(-1).includes("Spine extract."));
  const newOfficial = checkpoints(f, "compact-checkpoint")[0];
  assert.notEqual(newOfficial, official);
  const afterStock = eventHash(f);
  await restarted.finishTurn(f.agent());
  assert.equal(eventHash(f), afterStock);
  assert.equal(skipLiveOfficialCompaction(f.session), false, "the second stock card was consumed independently");
});

test("three repeated production stock/spine cycles preserve factual inputs across restart without idle recompression", async (t) => {
  const facts = ["部署区域是 cn-north-7。", "禁止发布未经过测试的版本。", "提交状态尚未核实，必须读取仓库确认。"];
  const requests = [];
  const h = runtime(t, { modelTransport: async function* (options) {
    assert.equal(options.purpose, "compaction");
    const input = options.messages.map(messageText).join("\n");
    for (const fact of facts) assert.ok(input.includes(fact), `official model input lost: ${fact}`);
    requests.push(input);
    yield { type: "text-delta", index: 0, text: facts.join("\n") };
    yield { type: "finish", reason: { kind: "stop" } };
  } });
  const f = h.use(fixture({ long: { text: `INFO ledger heartbeat ok\n${facts.join("\n")}\n${"INFO ledger heartbeat ok\n".repeat(300)}` } }));
  const config = { retainTokens: 100, compactionRetries: 0 };
  let { engine } = h.engine(config);
  const agent = () => ({ ...f.agent(), options: { provider: "fixture", model: "fixture-model" } });
  h.capture(engine, f);
  await engine.compactNow(agent(), new AbortController().signal);
  for (let cycle = 0; cycle < 3; cycle++) {
    if (cycle === 1) {
      f.session = Session.create(f.session.id, JSON.parse(JSON.stringify(f.session.snapshotEvents())));
      h.use(f);
      ({ engine } = h.engine(config));
    }
    const oldCards = checkpoints(f, "compact-checkpoint");
    const oldEvents = oldCards.map(seq => JSON.stringify(f.session.eventAt(seq)));
    f.user(`继续第 ${cycle + 1} 阶段任务。`);
    const work = f.round(`cycle-${cycle}`, { name: "read", tokens: 3000, text: "INFO ledger heartbeat ok\n".repeat(300) });
    for (let i = 0; i < 3; i++) f.round(`cycle-${cycle}-tail-${i}`);
    h.capture(engine, f);
    const before = f.summaries().length;
    await engine.finishTurn(agent());
    if (cycle !== 1) {
      assert.equal(f.summaries().length, before, "a live official card skips once");
      await engine.finishTurn(agent());
    }
    assert.equal(f.summaries().length, before + 1, h.warnings.join("\n"));
    assert.deepEqual(f.summaries().at(-1).data.shadowedSeqs, work);
    oldCards.forEach((seq, i) => {
      assert.ok(f.session.surface.nodes.includes(seq));
      assert.equal(JSON.stringify(f.session.eventAt(seq)), oldEvents[i]);
    });
    const text = f.session.deriveMessages().map(messageText).join("\n");
    for (const fact of facts) assert.ok(text.includes(fact));
    const settled = eventHash(f);
    const calls = h.modelCalls;
    await engine.finishTurn(agent());
    await engine.finishTurn(agent());
    assert.equal(eventHash(f), settled);
    assert.equal(h.modelCalls, calls, "idle local maintenance never invokes the summarizer model");
    await engine.compactNow(agent(), new AbortController().signal);
  }
  assert.equal(requests.length, 4);
  assert.equal(h.modelCalls, 4);
});

test("a recognized tool fact survives a real cut; assistant publish prose never becomes execution evidence (#6/#14)", async (t) => {
  const h = runtime(t);
  const fact = "部署区域是 cn-north-7，后续查询都走这个值。";
  const f = h.use(fixture({ long: { text: `${"INFO ledger heartbeat ok\n".repeat(300)}${fact}`, prose: "已提交并推送，已发布。" } }));
  const { engine } = h.engine();
  h.capture(engine, f);
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
  assert.ok(summaryText(f).includes(fact));
  assert.equal(summaryText(f).includes("已提交并推送"), false);
  assert.equal(summaryText(f).includes("已发布"), false);
  assert.equal(summaryText(f).includes(h.root), false);
});

test("an unsupported assistant decision refuses the real cut and remains verbatim (#14)", async (t) => {
  const h = runtime(t);
  const decision = "我们决定采用方案 B，因为方案 A 会破坏现有缓存前缀。";
  const f = h.use(fixture({ long: { prose: decision } }));
  const { engine } = h.engine();
  h.capture(engine, f);
  const before = eventHash(f);
  await engine.finishTurn(f.agent());
  assert.equal(eventHash(f), before);
  assert.equal(f.summaries().length, 0);
  assert.ok(messageText(f.session.eventAt(f.longRound[0]).data.message).includes(decision));
});

test("an open background writer records uncertainty; a later disk write stays authoritative (#6)", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  const file = `${h.root}/ledger.txt`;
  let releaseWrite;
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; }).then(() => {
    fs.writeFileSync(file, "late background write");
    f.add("job/settled", { turn: 2, jobId: "bash-write", status: "completed", toolCall: { callId: "long" } }, 0, {});
  });
  f.add("job/registered", { turn: 1, jobId: "bash-write", label: "write ledger.txt", kind: "bash", toolCall: { callId: "long" } }, 0, {});
  h.capture(engine, f);
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
  assert.ok(summaryText(f).includes("切时未结束，之后的文件以磁盘为准"));
  const cardHash = contentHash(summaryText(f));
  fs.writeFileSync(file, "newer workspace edit");
  releaseWrite();
  await pendingWrite;
  await engine.finishTurn(f.agent());
  assert.equal(readFileSync(file, "utf8"), "late background write");
  assert.equal(contentHash(summaryText(f)), cardHash);
});

test("raw corruption after selection is rechecked before any cut or backup claim", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine } = h.engine();
  h.capture(engine, f);
  const raw = engine.rawSeen.get(engine.rawKey(f.session, "long"));
  const commit = engine.commitSelectedSpan.bind(engine);
  let attempts = 0;
  engine.commitSelectedSpan = (...args) => {
    attempts++;
    fs.writeFileSync(raw.path, "tampered after selection");
    return commit(...args);
  };
  const before = eventHash(f);
  await engine.finishTurn(f.agent());
  assert.equal(attempts, 1, "the fixture must select a legal span before injecting damage");
  assert.equal(eventHash(f), before);
  assert.equal(f.summaries().length, 0);
  assert.ok(h.warnings.some((line) => line.includes("raw backup missing before cut")));
  assert.equal(readdirSync(sessionDir(h.root, f.session.id)).some((name) => name.startsWith("cut-")), false);
});

test("permission errors in actual event/idle hooks and guarded prune do not escape or poison the next session", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  const capture = engine.captureOne.bind(engine);
  const access = { platform: "win32", env: { SystemRoot: "D:\\WinX" }, execFile(file) {
    if (file.endsWith("whoami.exe")) return '"DESKTOP","S-1-5-21-100-200-300-1001"';
    throw Object.assign(new Error("no privilege"), { status: 1300 });
  } };
  engine.captureOne = (session, event) => capture(session, event, access);
  for (const event of f.session.snapshotEvents()) assert.doesNotThrow(() => ctx.emit("session/event", f.session, event));
  const refused = engine.rawSeen.get(engine.rawKey(f.session, "long"));
  assert.equal(pointerFor(refused), "无完整备份 [long]");
  engine.ensurePruneGuard();
  assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(f.session));
  assert.equal(h.pruneCalls, 0);
  assert.equal(readdirSync(h.root).some((name) => name.startsWith("raw-")), false);
  const files = existsSync(sessionDir(h.root, f.session.id)) ? readdirSync(sessionDir(h.root, f.session.id)) : [];
  assert.ok(files.every((name) => name.startsWith("spine-capture-") && name.endsWith(".json")), "denied capture may leave cursor metadata, never a plaintext payload");
  f.add("turn/end", { turn: 1, reason: { kind: "completed" } }, 0, {});
  const before = eventHash(f);
  assert.doesNotThrow(() => ctx.emit("agent/status", { agent: f.agent(), status: "idle" }));
  for (let i = 0; engine.stateFor(f.agent()).warming && i < 30; i++) await setImmediate();
  assert.equal(engine.stateFor(f.agent()).warming, false);
  assert.equal(eventHash(f), before);
  assert.equal(f.summaries().length, 0);
  assert.ok(h.warnings.some((line) => line.includes("1300")));
  resetShadowAccessState();
  engine.captureOne = capture;
  const healthy = h.use(fixture());
  h.capture(engine, healthy);
  ctx.toolResultPruner.pruneSession(healthy.session);
  await engine.finishTurn(healthy.agent());
  await setImmediate();
  assert.equal(h.pruneCalls, 1);
  assert.equal(healthy.summaries().length, 1);
  assert.deepEqual(unhandled, []);
});

test("permission failure while recovering disk originals leaves prune/cut untouched and a later session usable", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const first = h.engine().engine;
  h.capture(first, f);
  const raw = first.rawSeen.get(first.rawKey(f.session, "long"));
  const { engine, ctx } = h.engine();
  const chmod = fs.chmodSync;
  const deny = t.mock.method(fs, "chmodSync", (path, ...args) => {
    if (path === raw.path) throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    return chmod(path, ...args);
  });
  syncBuiltinESMExports();
  const before = eventHash(f);
  try {
    engine.ensurePruneGuard();
    assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(f.session));
    await engine.finishTurn(f.agent());
  } finally { deny.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(eventHash(f), before);
  assert.equal(h.pruneCalls, 0);
  assert.ok(existsSync(raw.path));
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long")).ok, false);
  const healthy = h.use(fixture());
  h.capture(engine, healthy);
  ctx.toolResultPruner.pruneSession(healthy.session);
  await engine.finishTurn(healthy.agent());
  assert.equal(h.pruneCalls, 1);
  assert.equal(healthy.summaries().length, 1);
});

test("a throwing pruner is contained and host maintenance can subsequently succeed", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  h.capture(engine, f);
  let fail = true;
  ctx.toolResultPruner.pruneSession = () => { if (fail) throw new Error("pruner unavailable"); h.pruneCalls++; };
  engine.ensurePruneGuard();
  assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(f.session));
  assert.ok(h.warnings.some((line) => line.includes("pruner unavailable")));
  fail = false;
  ctx.toolResultPruner.pruneSession(f.session);
  assert.equal(h.pruneCalls, 1);
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
});
