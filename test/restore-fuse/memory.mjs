#!/usr/bin/env node
// 恢复链路融合：内存对比探针（新增目录，不改既有测试）。
// 用法：node test/restore-fuse/memory.mjs <fused|materialized> [rounds]
// 在同一构造的大会话上分别以 融合路径(=1)/物化路径(=0) 跑 summarize 本地分支工作负载
// （NODE_TEST_CONTEXT=1 同步事务路径，排除 worker 时序），输出进程峰值 RSS 与末态堆。
const phase = process.argv[2] === "materialized" ? "0" : "1";
const rounds = Number(process.argv[3] || 3);
process.env.SPINE_RESTORE_FUSED = phase;
process.env.NODE_TEST_CONTEXT = "1";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const mod = (name) => import(pathToFileURL(join(root, name)).href);
const [index, raw, shadow] = await Promise.all([mod("index.js"), mod("raw.js"), mod("shadow.js")]);

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

// 大会话：4000 条消息，一半工具结果带 ~2KB 原文备份（恢复需读盘核验），一半普通消息。
const MESSAGES = 4000;
const CHUNK = 2048;
const rawDir = mkdtempSync(join(tmpdir(), "spine-mem-raw-"));
const messages = [];
const rawSeen = [];
for (let i = 0; i < MESSAGES; i += 1) {
  if (i % 2 === 0) {
    const id = `call-${i}`;
    const text = `完整原文 ${i}：${"z".repeat(CHUNK)}`;
    const buf = Buffer.from(text, "utf8");
    const file = join(rawDir, raw.rawName(id));
    writeFileSync(file, buf);
    writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId: id, sha256: raw.contentHash(buf), bytes: buf.length, label: "" }));
    rawSeen.push([id, { ok: true, existed: true, path: file, bytes: buf.length, sha256: raw.contentHash(buf), toolCallId: id, label: "" }]);
    messages.push({ role: "tool", content: `头部 ${i}\n[... tool result middle pruned ...]\n尾部 ${i}`, toolCallId: id });
  } else {
    messages.push({ role: "user", content: `用户消息 ${i}：${"u".repeat(256)}` });
  }
}
const key = "golden-memory";
const card = { ok: true, text: "内存探针本地摘要", needsBackup: true, rawPaths: [] };

const samples = [];
for (let round = 0; round < rounds; round += 1) {
  const dir = mkdtempSync(join(tmpdir(), "spine-mem-run-"));
  process.env.SPINE_SHADOW_DIR = dir;
  shadow.resetShadowAccessState?.();
  const engine = makeEngine();
  for (const [id, record] of rawSeen) engine.rawSeenOverride.set(`${key}\0${id}`, record);
  card.shadowFile = join(dir, "probe-shadow.txt");
  const before = process.memoryUsage().heapUsed;
  await engine.summarize({ messages, liveCompact: { card } }, { session: { id: key } }, new AbortController().signal);
  const after = process.memoryUsage().heapUsed;
  samples.push({ round, before, after, delta: after - before });
  rmSync(dir, { recursive: true, force: true });
}
rmSync(rawDir, { recursive: true, force: true });
const rss = process.resourceUsage().maxRSS * 1024;
console.log(JSON.stringify({
  phase: phase === "0" ? "materialized" : "fused",
  rounds,
  messages: MESSAGES,
  maxRSSBytes: rss,
  heapSamples: samples,
}, null, 2));
