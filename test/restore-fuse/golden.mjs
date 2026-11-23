#!/usr/bin/env node
// 恢复链路单遍融合：黄金比对自测（新增目录，不改既有测试）。
// 用法：node test/restore-fuse/golden.mjs
// 验证：融合路径（SPINE_RESTORE_FUSED 默认/置 1）与原物化路径（=0）必须产出：
//   1) 逐字节相同的影子备份文件（单元级 + saveShadowAsync/saveFusedRestoreAsync 同步与 worker 路径）；
//   2) 相同的备份声明判定（claimOk ≡ backupClaimOk）；
//   3) 相同的 summarize 摘要文本（本地分支端到端）。
process.env.NODE_TEST_CONTEXT = "1";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = (name) => import(pathToFileURL(join(root, name)).href);
const [index, raw, plan, shadow] = await Promise.all([
  mod("index.js"), mod("raw.js"), mod("plan.js"), mod("shadow.js"),
]);

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) console.log(`PASS ${name}`);
  else { failures += 1; console.log(`FAIL ${name} ${detail}`); }
}
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sameBytes = (a, b) => Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")) === 0;

function makeEngine() {
  const ctx = new Context();
  ctx.logger = { info() {}, debug() {}, warn() {} };
  ctx.sessions = {};
  ctx.sessions.flush = async () => {};
  ctx.tokenMeter = {
    measure: () => ({ nodes: [], totalTokens: 0, totalHeuristicTokens: 0 }),
    estimateMessage: () => 200,
  };
  ctx.llm = new Proxy({}, { get: () => () => { throw new Error("model calls forbidden"); } });
  ctx.provide("toolResultPruner", { pruneSession() {} });
  const engine = new index.default(ctx.isolate("compaction"), { auto: false });
  engine.rawSeenOverride = new Map();
  return engine;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rawDir = mkdtempSync(join(tmpdir(), "spine-golden-raw-"));
let rawSerial = 0;
function makeRecord(text, { corrupt = false } = {}) {
  rawSerial += 1;
  const id = `call-${rawSerial}`;
  const file = join(rawDir, raw.rawName(id));
  const buf = Buffer.from(text, "utf8");
  const sha = raw.contentHash(buf);
  writeFileSync(file, buf);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId: id, sha256: sha, bytes: buf.length, label: "" }));
  if (corrupt) writeFileSync(file, Buffer.concat([buf, Buffer.from("corrupted", "utf8")]));
  return { id, record: { ok: true, existed: true, path: file, bytes: buf.length, sha256: sha, toolCallId: id, label: "" } };
}

// 构造随机会话消息：覆盖 无id/有id、字符串/数组内容、reasoning、
// ok 备份、损坏备份、缺备份、表面带修剪标记 等组合。
function buildCase(seed) {
  const rand = mulberry32(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const messages = [];
  const rawSeen = [];
  const count = 1 + Math.floor(rand() * 12);
  for (let i = 0; i < count; i += 1) {
    const kind = pick(["user", "assistant", "tool-ok", "tool-corrupt", "tool-missing", "tool-pruned-ok", "tool-pruned-bad", "tool-array"]);
    if (kind === "user") {
      messages.push({ role: "user", content: `用户消息 ${i}（seed ${seed}）` });
    } else if (kind === "assistant") {
      messages.push({ role: "assistant", content: [{ type: "text", text: `助手回复 ${i}` }, { type: "reasoning", text: `推理 ${i}: ${"x".repeat(1 + Math.floor(rand() * 40))}` }] });
    } else {
      const pruned = kind.startsWith("tool-pruned");
      const surface = pruned
        ? `头部 ${i}\n[... tool result middle pruned ...]\n尾部 ${i}`
        : `表面结果 ${i}：${"y".repeat(1 + Math.floor(rand() * 60))}`;
      const full = `完整原文 ${i}：${"z".repeat(1 + Math.floor(rand() * 200))}`;
      let entry = null;
      if (kind === "tool-ok" || kind === "tool-pruned-ok") entry = makeRecord(full);
      else if (kind === "tool-corrupt" || kind === "tool-pruned-bad") entry = makeRecord(full, { corrupt: true });
      messages.push({ role: "tool", content: surface, toolCallId: entry ? entry.id : `call-miss-${seed}-${i}` });
      if (entry) rawSeen.push(entry);
    }
  }
  return { messages, rawSeen };
}

function materializedPipeline(engine, messages, key) {
  const restored = engine.restoreRawMessages(messages, key);
  const body = restored.map((message) => plan.shadowSections(message)).join("\n\n");
  return { body: shadow.shadowFileBody(key, body), claimOk: plan.backupClaimOk(restored), restored };
}

function fusedPipeline(engine, messages, key) {
  const fused = engine.restoreShadowBody(messages, key);
  return { body: shadow.shadowFileBody(key, fused.body), claimOk: fused.claimOk };
}

function unitGolden() {
  const engine = makeEngine();
  const key = "golden-unit";
  let mismatch = 0;
  const total = 300;
  for (let seed = 1; seed <= total; seed += 1) {
    const { messages, rawSeen } = buildCase(seed);
    engine.rawSeenOverride = new Map();
    for (const { id, record } of rawSeen) engine.rawSeenOverride.set(`${key}\0${id}`, record);
    const mat = materializedPipeline(engine, messages, key);
    const fus = fusedPipeline(engine, messages, key);
    if (!sameBytes(mat.body, fus.body) || mat.claimOk !== fus.claimOk) {
      mismatch += 1;
      console.log(`  seed ${seed}: body-eq=${sameBytes(mat.body, fus.body)} claim-eq=${mat.claimOk === fus.claimOk}`);
    }
  }
  check(`单元级黄金比对（${total} 组随机用例，restoreShadowBody ≡ restoreRawMessages+shadowBody+backupClaimOk）`, mismatch === 0, `mismatch=${mismatch}`);
}

async function saveGoldenPair(label, build, { worker = false } = {}) {
  if (worker) delete process.env.NODE_TEST_CONTEXT;
  else process.env.NODE_TEST_CONTEXT = "1";
  const { messages, rawSeen, key } = build();
  const dirs = [mkdtempSync(join(tmpdir(), "spine-golden-a-")), mkdtempSync(join(tmpdir(), "spine-golden-b-"))];
  const files = [];
  try {
    for (let i = 0; i < 2; i += 1) {
      process.env.SPINE_SHADOW_DIR = dirs[i];
      shadow.resetShadowAccessState?.();
      const engine = makeEngine();
      for (const { id, record } of rawSeen) engine.rawSeenOverride.set(`${key}\0${id}`, record);
      const file = index.freshShadowFile("golden", key);
      if (i === 0) {
        const restored = engine.restoreRawMessages(messages, key);
        await engine.saveShadowAsync(restored, true, file, key, []);
      } else {
        await engine.saveFusedRestoreAsync(messages, key, true, file, []);
      }
      files.push(readFileSync(file));
    }
    const ok = Buffer.compare(files[0], files[1]) === 0;
    check(`${label}：影子备份逐字节一致（${worker ? "worker 路径" : "同步事务路径"}）`, ok,
      `shaA=${sha256(files[0]).slice(0, 12)} shaB=${sha256(files[1]).slice(0, 12)}`);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
}

async function saveGolden() {
  const mixed = () => {
    const key = "golden-save-mixed";
    const { messages, rawSeen } = buildCase(777);
    return { messages, rawSeen, key };
  };
  await saveGoldenPair("保存路径黄金比对（混合备份场景）", mixed, { worker: false });
  await saveGoldenPair("保存路径黄金比对（混合备份场景）", mixed, { worker: true });
  const empty = () => ({ messages: [], rawSeen: [], key: "golden-save-empty" });
  await saveGoldenPair("保存路径黄金比对（空消息集）", empty, { worker: false });
  const norestore = () => {
    const key = "golden-save-norestore";
    return { messages: [{ role: "user", content: "没有工具结果的消息" }], rawSeen: [], key };
  };
  await saveGoldenPair("保存路径黄金比对（无恢复项）", norestore, { worker: false });
}

async function summarizeOnce({ fused, messages, rawSeen, key }) {
  process.env.SPINE_RESTORE_FUSED = fused ? "1" : "0";
  process.env.NODE_TEST_CONTEXT = "1";
  const dir = mkdtempSync(join(tmpdir(), "spine-golden-sum-"));
  process.env.SPINE_SHADOW_DIR = dir;
  shadow.resetShadowAccessState?.();
  try {
    const engine = makeEngine();
    for (const { id, record } of rawSeen) engine.rawSeenOverride.set(`${key}\0${id}`, record);
    const shadowFile = index.freshShadowFile("golden", key);
    const card = { ok: true, text: "GOLDEN 本地摘要文本", needsBackup: true, shadowFile, rawPaths: [] };
    const result = await engine.summarize({ messages, liveCompact: { card } }, { session: { id: key } }, new AbortController().signal);
    return { text: result.summary[0].text, bytes: readFileSync(shadowFile) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function summarizeGolden() {
  const key = "golden-summarize";
  const { messages, rawSeen } = buildCase(424242);
  const args = { messages, rawSeen, key };
  const off = await summarizeOnce({ fused: false, ...args });
  const on = await summarizeOnce({ fused: true, ...args });
  const unset = await summarizeOnce({ ...args, fused: undefined });
  check("summarize 端到端：摘要文本一致（开关=0 vs =1）", off.text === on.text, JSON.stringify([off.text, on.text]));
  check("summarize 端到端：影子备份逐字节一致（开关=0 vs =1）", Buffer.compare(off.bytes, on.bytes) === 0,
    `shaA=${sha256(off.bytes).slice(0, 12)} shaB=${sha256(on.bytes).slice(0, 12)}`);
  check("summarize 端到端：未设置开关时与融合路径一致（默认启用）",
    unset.text === on.text && Buffer.compare(unset.bytes, on.bytes) === 0);
}

try {
  unitGolden();
  await saveGolden();
  await summarizeGolden();
} finally {
  rmSync(rawDir, { recursive: true, force: true });
}
console.log(failures === 0 ? "\n黄金比对全部通过：融合路径与物化路径字节一致。" : `\n黄金比对失败 ${failures} 项。`);
process.exit(failures === 0 ? 0 : 1);
