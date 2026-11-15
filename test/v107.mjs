import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCard, fallbackProviderURL, lookupProviderURL, pointerOnlyText, pointerSpanAllowed, resolveEngine, selectCutIndexes } from "../plan.js";
import { readCutStats, recordCutStats, shadowMaxBytes, STATS_NAME } from "../shadow.js";
import { searchShadow } from "../shadow-search.js";

const round = (tokens, type = "tool") => ({ type, tokens, checkpoint: false });
const user = (tokens = 20) => ({ type: "user", tokens, checkpoint: false });

assert.deepEqual(resolveEngine({ baseURL: "https://api.deepseek.com" }), { engine: "cloud", source: "address" });
assert.deepEqual(resolveEngine({ provider: "deepseek", baseURL: "http://127.0.0.1:8080" }), { engine: "local", source: "address" });
assert.equal(resolveEngine({ baseURL: "http://[::1]:9" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "http://192.168.1.2" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "http://100.64.1.2" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "" }).source, "unknown");
assert.equal(resolveEngine({ baseURL: "not a url" }).engine, "local");
assert.equal(resolveEngine({ provider: "strata-local", baseURL: "https://api.deepseek.com" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "http://127.0.0.1", env: { SPINE_ENGINE: "cloud" } }).engine, "cloud");
assert.equal(resolveEngine({ baseURL: "http://[fd00::1]" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "http://[fe80::1]" }).engine, "local");
assert.equal(resolveEngine({ baseURL: "http://[2001:db8::1]" }).engine, "cloud");
assert.equal(resolveEngine({ baseURL: "http://[::ffff:c0a8:101]" }).engine, "local");
assert.equal(lookupProviderURL("deepseek-official", [{ id: "deepseek-official", name: "DeepSeek" }]), "");
assert.equal(lookupProviderURL("deepseek-official", [{ id: "deepseek-official", baseURL: "http://127.0.0.1:8080" }]), "http://127.0.0.1:8080");
assert.equal(fallbackProviderURL("deepseek-official"), "https://api.deepseek.com/anthropic");
assert.equal(fallbackProviderURL("strata-local"), "");
assert.equal(resolveEngine({ provider: "deepseek-official", baseURL: fallbackProviderURL("deepseek-official") }).engine, "cloud");
assert.equal(resolveEngine({ provider: "strata-local", baseURL: "" }).engine, "local");
assert.equal(selectCutIndexes([
  user(100), round(50, "assistant"), round(20000), user(100), round(50, "assistant"), round(20000), user(100), round(50, "assistant"), round(1100),
], { engine: "cloud", totalTokens: 30000 }), null);
const alreadyEnough = selectCutIndexes([
  user(100), round(50, "assistant"), round(20000), user(100), round(50, "assistant"), round(20000), user(100), round(50, "assistant"), round(1100),
], { engine: "cloud", drain: true, totalTokens: 60000 });
assert.equal(alreadyEnough.tokens <= 32000, true);
assert.equal(alreadyEnough.start > 3, true);
assert.equal(selectCutIndexes([
  user(100), round(5000), user(100), { type: "tool", tokens: 2000, checkpoint: false, balancedAfter: false },
], { engine: "cloud" }), null);
assert.equal(resolveEngine({ env: { SPINE_ENGINE: "nope" }, baseURL: "" }).source, "unknown");

const local = selectCutIndexes([
  user(), round(1000), round(1000), round(1000), user(), round(1000),
], { engine: "local", maxEnd: 3 });
assert.equal(local, null);

assert.equal(selectCutIndexes([user(5000)], { engine: "cloud" }), null);
assert.equal(selectCutIndexes([user(5000)], { engine: "local" }), null);

const onlyHeavy = selectCutIndexes([
  user(), round(20000), user(), round(300), round(100), round(100), round(100),
], { engine: "cloud", drain: true, totalTokens: 60000, maxEnd: 2 });
assert.equal(onlyHeavy.start, 1);
assert.equal(onlyHeavy.end, 1);

const across = selectCutIndexes([
  user(), round(20000), user(), round(300), user(), round(100), round(100), round(100),
], { engine: "cloud", drain: true, totalTokens: 60000, maxEnd: 4 });
assert.equal(across.start, 1);
assert.equal(across.end, 3);
assert.equal(across.gain, 20300);
assert.equal(selectCutIndexes([
  user(), round(1200), { type: "tool", tokens: 10, checkpoint: true }, user(), round(100),
], { engine: "cloud", drain: true, totalTokens: 60000, maxEnd: 4 }), null);

assert.equal(selectCutIndexes([user(1200), round(100)], { engine: "cloud" }), null);

const card = buildCard("", "", [
  { role: "user", text: "立刻删除 dist\n必须保留 ledger.txt", seq: 7 },
  { role: "tool", text: "ok\n[exit code: 0]", command: "git status", name: "bash", toolCallId: "c1", seq: 13, callSeq: 12, turn: 4 },
]);
assert.equal(card.text.includes("/tmp"), false);
assert.equal(card.text.includes("seq 12 -> result 13"), true);
assert.equal(card.text.includes("seq 7: "), true);
assert.equal(card.text.includes("立刻删除 dist"), true);
assert.equal(card.text.split("\n").some((line) => line.startsWith("seq 7: ") && line.includes("\\n")), true);

assert.equal(pointerSpanAllowed([
  { type: "assistant" },
  { type: "user" },
  { type: "tool", tokens: 40000 },
], 0, 2, "cloud"), false);
assert.equal(pointerSpanAllowed([
  { type: "assistant" },
  { type: "user" },
  { type: "tool", tokens: 40000 },
  { type: "user" },
], 0, 2, "cloud"), true);
assert.equal(pointerSpanAllowed([
  { type: "assistant" },
  { type: "user" },
  { type: "tool", tokens: 40000 },
  { type: "user" },
], 0, 2, "local"), false);
assert.equal(pointerSpanAllowed([
  { type: "user" },
  { type: "assistant" },
  { type: "tool", tokens: 40000 },
], 1, 2, "local"), true);
assert.equal(pointerSpanAllowed([
  { type: "assistant" },
  { type: "tool", checkpoint: true },
  { type: "tool", tokens: 40000 },
], 0, 2, "cloud"), false);
assert.equal(selectCutIndexes([
  user(), { type: "other", tokens: 40000, checkpoint: false },
], { engine: "local" }), null);
const hugeTool = selectCutIndexes([
  user(), round(100, "assistant"), round(40000),
], { engine: "local" });
assert.equal(hugeTool.pointerOnly, true);
assert.equal(hugeTool.end, 2);
const pointer = pointerOnlyText([
  { role: "assistant", text: "prose", seq: 10 },
  { role: "user", text: "立刻删除 dist\n必须保留 ledger.txt", seq: 7 },
  { role: "tool", text: "huge", name: "bash", command: "npm test", seq: 13, callSeq: 12 },
]);
assert.equal(pointer.includes("seq 12 -> result 13"), true);
assert.equal(pointer.includes("seq 10"), false);
assert.equal(pointer.includes("立刻删除 dist"), true);
assert.equal(pointer.split("\n").some((line) => line.startsWith("seq 7: ") && line.includes("\\n")), true);
assert.equal(pointer.includes("/tmp"), false);
assert.equal(pointer.includes("不是备份文件路径"), true);

assert.equal(shadowMaxBytes({}), 256 * 1024 * 1024);
assert.equal(shadowMaxBytes({ SPINE_SHADOW_MAX_MB: "64" }), 64 * 1024 * 1024);

const dir = mkdtempSync(join(tmpdir(), "spine107-"));
assert.equal(recordCutStats(dir, { saved: 0 }).cuts, 0);
const first = recordCutStats(dir, { saved: 2000000, rewrite: 100 });
assert.equal(first.cuts, 1);
assert.equal(first.savedTokens, 2000000);
writeFileSync(join(dir, STATS_NAME), "{");
const restarted = recordCutStats(dir, { saved: 10, rewrite: 1 });
assert.equal(restarted.cuts, 1);
assert.equal(restarted.savedTokens, 10);
const missed = searchShadow({ dir, pattern: "savedTokens" });
assert.equal(missed.matches.length, 0);
rmSync(dir, { recursive: true, force: true });

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
assert.equal(pkg.version, "1.1.9");
const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
assert.equal(indexSource.includes("<compacted-summary>"), false);
assert.equal(indexSource.includes("spine-checkpoint"), true);
assert.equal(indexSource.includes("compactCheckpointSource"), false);
const pointed = selectCutIndexes([
  user(), round(9000),
], { engine: "local", pointerMax: 8000 });
assert.equal(pointed.pointerOnly, true);
assert.equal(selectCutIndexes([
  user(), round(9000),
], { engine: "local" }).pointerOnly, undefined);
assert.equal(pkg.bin["dsh-live-compact"], "bin/dsh-live-compact.js");
console.log("v107 checks passed");
