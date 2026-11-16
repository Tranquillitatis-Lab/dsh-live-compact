import assert from "node:assert/strict";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cutCrossesNewerCheckpoint, selectCutIndexes } from "../plan.js";
import { appendDecision, DECISIONS_NAME, drainRewrite, flushDrainStats, isPluginShadowName, readCutStats } from "../shadow.js";

const user = (tokens = 100) => ({ type: "user", tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const round = (tokens, type = "tool") => ({ type, tokens, checkpoint: false, balancedAfter: true, balancedBefore: true });
const card = (tokens = 200) => ({ type: "other", tokens, checkpoint: true, balancedAfter: true, balancedBefore: true });

test("walkOffTail stops at a checkpoint and does not cut older history", () => {
  const items = [
    user(),
    round(20000),
    card(),
    user(),
    round(8000),
    user(),
    round(100),
    round(100),
    round(100),
  ];
  const cut = selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 200000, maxEnd: 4 });
  assert.equal(cut.start > 2, true);
  assert.equal(cut.end, 4);
  assert.equal(cutCrossesNewerCheckpoint(items, cut.end), false);
});

test("a maxEnd left of a newer checkpoint is not a cut", () => {
  const items = [
    user(),
    round(20000),
    card(),
    user(),
    round(8000),
  ];
  assert.equal(selectCutIndexes(items, { engine: "cloud", drain: true, totalTokens: 200000, maxEnd: 1 }), null);
});

test("drain batch charges rewrite once", () => {
  const notes = [
    { kind: "cut", saved: 8000, afterPrefix: 200000 },
    { kind: "cut", saved: 7000, afterPrefix: 190000 },
    { kind: "cut", saved: 6000, afterPrefix: 180000 },
    { kind: "cut", saved: 5000, afterPrefix: 170000 },
  ];
  assert.equal(drainRewrite(notes), 200000 - 18000);
  const dir = mkdtempSync(join(tmpdir(), "spine-drain-"));
  try {
    flushDrainStats(dir, notes, { sid: "s", drain: true });
    const stats = readCutStats(dir);
    assert.equal(stats.cuts, 4);
    assert.equal(stats.drains, 1);
    assert.equal(stats.savedTokens, 26000);
    assert.equal(stats.rewriteTokens, 182000);
    const lines = readFileSync(join(dir, "spine-cuts.jsonl"), "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed.filter((line) => line.rewriteCharged > 0).length, 1);
    assert.equal(parsed.some((line) => JSON.stringify(line).includes("必须")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("maintenance decisions append only inside an existing shadow directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-decisions-"));
  const missing = join(dir, "missing");
  try {
    assert.equal(appendDecision(missing, { phase: "engine", engine: "cloud" }), false);
    assert.equal(appendDecision(dir, { sid: "s", phase: "cut-skip", reason: "no-legal-span" }), true);
    const line = JSON.parse(readFileSync(join(dir, "spine-decisions.jsonl"), "utf8"));
    assert.equal(line.v, 1);
    assert.equal(line.sid, "s");
    assert.equal(line.reason, "no-legal-span");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision append refuses to exceed the shadow capacity", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-decision-cap-"));
  const file = join(dir, DECISIONS_NAME);
  const previous = process.env.SPINE_SHADOW_MAX_BYTES;
  const original = "x".repeat(180);
  try {
    process.env.SPINE_SHADOW_MAX_BYTES = "200";
    writeFileSync(file, original);
    assert.equal(appendDecision(dir, { phase: "over-cap" }), false);
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    if (previous === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
    else process.env.SPINE_SHADOW_MAX_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision capacity rotation protects active raw backups", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-decision-raw-protect-"));
  const decision = join(dir, DECISIONS_NAME);
  const raw = join(dir, "raw-0123456789abcdef.txt");
  const previous = process.env.SPINE_SHADOW_MAX_BYTES;
  try {
    process.env.SPINE_SHADOW_MAX_BYTES = "200";
    writeFileSync(decision, "d".repeat(100));
    writeFileSync(raw, "r".repeat(100));
    assert.equal(appendDecision(dir, { phase: "protect-raw" }, { protectPaths: [raw] }), false);
    assert.equal(existsSync(raw), true);
    assert.equal(readFileSync(raw, "utf8"), "r".repeat(100));
  } finally {
    if (previous === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
    else process.env.SPINE_SHADOW_MAX_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision capacity rotation protects the committed card backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-decision-card-protect-"));
  const decision = join(dir, DECISIONS_NAME);
  const card = join(dir, "cut-1-12345678.txt");
  const previous = process.env.SPINE_SHADOW_MAX_BYTES;
  try {
    process.env.SPINE_SHADOW_MAX_BYTES = "200";
    writeFileSync(decision, "d".repeat(100));
    writeFileSync(card, "c".repeat(100));
    assert.equal(appendDecision(dir, { phase: "protect-card" }, { protectPaths: [card] }), false);
    assert.equal(existsSync(card), true);
    assert.equal(readFileSync(card, "utf8"), "c".repeat(100));
  } finally {
    if (previous === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
    else process.env.SPINE_SHADOW_MAX_BYTES = previous;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shared decision capacity remeasures a sibling session write", () => {
  const root = mkdtempSync(join(tmpdir(), "spine-decision-shared-cap-"));
  const first = join(root, "first");
  const sibling = join(root, "sibling");
  const previousDir = process.env.SPINE_SHADOW_DIR;
  const previousSingle = process.env.SPINE_SHADOW_SINGLE_PROCESS;
  const previousCap = process.env.SPINE_SHADOW_MAX_BYTES;
  try {
    mkdirSync(first, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(sibling, "owner"), String(process.pid));
    process.env.SPINE_SHADOW_DIR = root;
    delete process.env.SPINE_SHADOW_SINGLE_PROCESS;
    process.env.SPINE_SHADOW_MAX_BYTES = "256";
    assert.equal(appendDecision(root, { sid: "first", phase: "before-sibling" }), true);
    // The sibling directory already exists, so this write does not change the
    // root mtime. Shared/default roots must still remeasure its bytes.
    writeFileSync(join(sibling, "raw-0123456789abcdef.txt"), "r".repeat(200));
    assert.equal(appendDecision(root, { sid: "first", phase: "after-sibling" }), false);
  } finally {
    if (previousDir === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previousDir;
    if (previousSingle === undefined) delete process.env.SPINE_SHADOW_SINGLE_PROCESS;
    else process.env.SPINE_SHADOW_SINGLE_PROCESS = previousSingle;
    if (previousCap === undefined) delete process.env.SPINE_SHADOW_MAX_BYTES;
    else process.env.SPINE_SHADOW_MAX_BYTES = previousCap;
    rmSync(root, { recursive: true, force: true });
  }
});

test("stats recovers a dead-PID lock and decision logs are rotatable plugin entries", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-stats-lock-"));
  try {
    writeFileSync(join(dir, "spine-stats.lock"), "99999999");
    flushDrainStats(dir, [{ kind: "cut", saved: 4200, afterPrefix: 10000 }], { sid: "s1", drain: true });
    assert.equal(readCutStats(dir).cuts, 1);
    assert.equal(isPluginShadowName(DECISIONS_NAME), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stats recovers a stale empty legacy lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-stats-empty-lock-"));
  const lock = join(dir, "spine-stats.lock");
  try {
    writeFileSync(lock, "");
    const old = new Date(Date.now() - 5000);
    utimesSync(lock, old, old);
    flushDrainStats(dir, [{ kind: "cut", saved: 1800, afterPrefix: 9000 }], { sid: "s2", drain: true });
    assert.equal(readCutStats(dir).cuts, 1);
    assert.equal(existsSync(lock), false, "legacy lock is removed after recovery");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("decision append is coordinated with the shadow root transaction", () => {
  const source = readFileSync(new URL("../shadow.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export function appendDecision"), source.indexOf("export function readCutStats"));
  assert.match(body, /withShadowRoot\(dir/);
  assert.match(body, /O_NOFOLLOW/);
  assert.match(body, /fstatSync\(fd/);
  assert.match(body, /shadowUsage\.bytes \+=/);
});

test("decision append rejects symlink and hardlink targets", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "spine-decision-links-"));
  const outside = join(dir, "outside.jsonl");
  const target = join(dir, DECISIONS_NAME);
  try {
    writeFileSync(outside, "outside\n");
    if (process.platform !== "win32") {
      symlinkSync(outside, target);
      assert.equal(appendDecision(dir, { phase: "symlink" }), false);
      rmSync(target);
    }
    linkSync(outside, target);
    assert.equal(appendDecision(dir, { phase: "hardlink" }), false);
    assert.equal(readFileSync(outside, "utf8"), "outside\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
