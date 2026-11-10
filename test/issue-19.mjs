import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULTS } from "../settings.js";
import { cutCrossesNewerCheckpoint, cutLongReadRound, keptToolRounds, selectCutIndexes } from "../plan.js";
import { drainRewrite } from "../shadow.js";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
const user = (tokens = 100) => ({ type: "user", tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const round = (tokens) => ({ type: "tool", tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const card = () => ({ type: "other", tokens: 200, checkpoint: true, balancedAfter: true, balancedBefore: true });

test("issue 19 constants stay on the published lines", () => {
  assert.equal(DEFAULTS.bigGate, 650000);
  assert.equal(DEFAULTS.chunkMin, 1000);
  assert.equal(DEFAULTS.keepRoundTokens, 32000);
  assert.match(indexSource, /const URGENT_TOKENS = 48000/);
  assert.match(indexSource, /const MAX_TAIL = 2200/);
  assert.equal(indexSource.includes("SPINE_MAX_TOKENS"), false);
});

test("a long read is not kept for three rounds", () => {
  const events = [
    { type: "other", toolCalls: 1 },
    { type: "tool", longRead: true },
    { type: "other", toolCalls: 1 },
    { type: "tool" },
  ];
  const kept = keptToolRounds(events, 3);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].end, 3);
});

test("a long read cut stays inside its round and still cuts an oversized round", () => {
  const kept = [
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 40, balancedBefore: false, balancedAfter: true },
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 40, balancedBefore: false, balancedAfter: true },
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 40, balancedBefore: false, balancedAfter: true },
  ];
  const old = [
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 1800, balancedBefore: false, balancedAfter: true },
  ];
  const longRead = [
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 1600, balancedBefore: false, balancedAfter: true },
  ];
  const items = [...old, ...kept, ...longRead];
  const start = old.length + kept.length;
  const picked = cutLongReadRound(items, start, items.length - 1, {
    engine: "cloud",
    chunkMin: 1000,
    chunkMax: 32000,
    pointerMax: 32000,
  });
  assert.equal(picked.start, start);
  assert.equal(picked.end, items.length - 1);
  assert.equal(picked.start > old.length + kept.length - 1, true);

  const huge = [
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 32000, balancedBefore: false, balancedAfter: false },
    { type: "tool", tokens: 32000, balancedBefore: false, balancedAfter: true },
  ];
  const oversized = cutLongReadRound(huge, 0, huge.length - 1, {
    engine: "cloud",
    chunkMin: 1000,
    chunkMax: 32000,
    pointerMax: 32000,
  });
  assert.equal(oversized.pointerOnly, true);
  assert.equal(oversized.start >= 1, true);
  assert.equal(oversized.end, oversized.start);
});

test("a long read inside a multi-tool round is not kept", () => {
  const events = [
    { type: "other", toolCalls: 2 },
    { type: "tool", longRead: true },
    { type: "tool" },
    { type: "other", toolCalls: 1 },
    { type: "tool" },
  ];
  const kept = keptToolRounds(events, 3);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].end, 4);
});

test("retained rounds restart after the newest checkpoint", () => {
  const events = [
    { type: "other", checkpoint: false, toolCalls: 1 }, { type: "tool" },
    { type: "other", checkpoint: true },
    { type: "other", checkpoint: false, toolCalls: 1 }, { type: "tool" },
    { type: "other", checkpoint: false, toolCalls: 1 }, { type: "tool" },
  ];
  assert.deepEqual(keptToolRounds(events, 3, 2), [{ start: 3, end: 4 }, { start: 5, end: 6 }]);
});

test("ordinary fallback is not rejected by the long-read bound", () => {
  const source = readFileSync(fileURLToPath(new URL("../index.js", import.meta.url)), "utf8");
  assert.equal(source.includes("if (usedLongCut && (picked.start < longSpan.start || picked.end > longSpan.end)) return null;"), true);
  assert.equal(source.includes("if (longSpan && (picked.start < longSpan.start || picked.end > longSpan.end)) return null;"), false);
  const old = selectCutIndexes([
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 1800, balancedBefore: false, balancedAfter: true },
  ], { engine: "cloud", drain: true, chunkMin: 1000, chunkMax: 32000, maxEnd: 1 });
  assert.equal(old.start, 0);
  assert.equal(old.end, 1);
  const blocked = cutLongReadRound([
    { type: "assistant", tokens: 16, balancedBefore: true, balancedAfter: false },
    { type: "tool", tokens: 20000, balancedBefore: false, balancedAfter: false },
    { type: "tool", tokens: 20000, balancedBefore: false, balancedAfter: true },
  ], 0, 2, { engine: "cloud", chunkMin: 1000, chunkMax: 32000, pointerMax: 32000 });
  assert.equal(blocked, null);
});

test("issue 19 drain does not cut left of a newer checkpoint", () => {
  const items = [user(), round(200000), card(), user(), round(8000), user(), round(100), round(100), round(100)];
  const cut = selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 240000, maxEnd: 4 });
  assert.equal(cut.start > 2, true);
  assert.equal(cutCrossesNewerCheckpoint(items, cut.end), false);
  assert.equal(selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 240000, maxEnd: 1 }), null);
});

test("issue 19 four drain cuts charge rewrite once, not four tails", () => {
  const notes = [0, 1, 2, 3].map((index) => ({
    kind: "cut",
    saved: 7800,
    afterPrefix: 210000 - index * 7800,
  }));
  const once = drainRewrite(notes);
  const inflated = notes.reduce((sum, note) => sum + note.afterPrefix, 0);
  assert.equal(once, 210000 - 7800 * 3);
  assert.equal(once < inflated / 2, true);
});

test("issue 19 drain loop does not rescan the log or remeasure at the top", () => {
  const loop = indexSource.slice(indexSource.indexOf("for (let pass = 0; pass < 8; pass += 1)"));
  const body = loop.slice(0, loop.indexOf("state.turnBase"));
  assert.equal(body.includes("snapshotEvents"), false);
  assert.equal(body.includes("collectJobs(agent.session"), false);
  assert.equal(body.includes("this.ctx.tokenMeter.measure(agent.session);\n          if (drain"), false);
});
