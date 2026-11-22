#!/usr/bin/env node
// 用法：node collect.mjs --case=<名称> --src=baseline|current --out=<文件>
// 在干净子进程里驱动单个语料 case，采集规范化后的行为档案（JSON）。
// 采集内容：会话事件、摘要事件、summarize 输入、决策/切割/统计、影子文件全树
// （路径+字节+规范化 sha256+规范化内容）、raw 备份与恢复结果、日志。
// NODE_TEST_CONTEXT=1 让 saveShadowAsync 走同步事务路径，排除 worker 时序噪声；
// worker 路径本身由红线用例覆盖。
process.env.NODE_TEST_CONTEXT = "1";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize, canonicalText, contentHash, patchDeterministicClock, stripRoot } from "./canonical.mjs";
import { loadSrc } from "./harness.mjs";
import { CASES, CORPUS_VERSION, drive } from "./corpus.mjs";

function listFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path); else out.push(path);
    }
  };
  walk(root);
  return out;
}

function relPath(root, path) {
  return relative(root, path).split("\\").join("/");
}

function collectShadowTree(root) {
  return listFiles(root).map((path) => {
    let bytes = null;
    try { bytes = statSync(path).size; } catch { bytes = null; }
    let content = null;
    try { content = readFileSync(path, "utf8"); } catch { content = null; }
    let canonical = null;
    if (content !== null) {
      canonical = basename(path) === "owner" ? "<PID>" : canonicalText(stripRoot(content, root));
    }
    const isOwner = basename(path) === "owner";
    return { path: relPath(root, path), bytes: isOwner ? null : bytes, sha256: canonical === null ? null : contentHash(canonical), content: canonical };
  }).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function parseJsonl(content) {
  if (!content || !content.trim()) return [];
  return content.trim().split("\n").map((line) => {
    try { return JSON.parse(line); } catch { return { unparsed: line }; }
  });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.replace(/^--/, "").split("=");
    return [key, rest.join("=") === "" ? true : rest.join("=")];
  }));
  const caseDef = CASES.find((item) => item.name === args.case);
  if (!caseDef) throw new Error(`未知 case：${args.case}（可用：${CASES.map((item) => item.name).join(", ")}）`);
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = args.src === "baseline" ? join(here, "baseline-src")
    : args.src === "current" ? join(here, "..", "..")
    : String(args.src);
  const clock = patchDeterministicClock();
  const src = await loadSrc(srcDir);
  const { h, f, engine } = await drive(caseDef, { src, clock });
  try {
    const rawSeen = [...engine.rawSeen.entries()].map(([key, record]) => ({
      key,
      toolCallId: record?.toolCallId ?? null,
      ok: record?.ok ?? null,
      reason: record?.reason ?? null,
      recovered: record?.recovered ?? null,
      aclVerified: record?.aclVerified ?? null,
      bytes: record?.bytes ?? null,
      sha256: record?.sha256 ?? null,
      path: record?.path ? relPath(h.root, record.path) : null,
    }));
    const restores = [];
    const restoredIds = new Set();
    for (const [, record] of engine.rawSeen) {
      if (!record?.ok || !record?.path || restoredIds.has(record.toolCallId) || restores.length >= 4) continue;
      restoredIds.add(record.toolCallId);
      let raw = null;
      let meta = null;
      let restored = null;
      try { raw = canonicalText(stripRoot(readFileSync(record.path, "utf8"), h.root)); }
      catch (error) { raw = `读取失败: ${error?.message || error}`; }
      try { meta = canonicalize(JSON.parse(readFileSync(`${record.path}.meta.json`, "utf8")), h.root); }
      catch (error) { meta = { error: String(error?.message || error) }; }
      try {
        let result;
        try { result = await src.raw.readRawToolResult({ dir: dirname(record.path), toolCallId: record.toolCallId }); }
        catch { result = await src.raw.readRawToolResult(dirname(record.path), record.toolCallId); }
        restored = canonicalize(JSON.parse(JSON.stringify(result ?? null)), h.root);
      } catch (error) { restored = { thrown: String(error?.message || error) }; }
      restores.push({ toolCallId: record.toolCallId, raw, meta, restored });
    }
    const shadowTree = collectShadowTree(h.root);
    const decisions = shadowTree.filter((file) => file.path.endsWith("spine-decisions.jsonl"))
      .flatMap((file) => parseJsonl(file.content));
    const cuts = shadowTree.filter((file) => file.path.endsWith("spine-cuts.jsonl"))
      .flatMap((file) => parseJsonl(file.content));
    const stats = shadowTree.filter((file) => file.path.endsWith("spine-stats.json"))
      .map((file) => { try { return JSON.parse(file.content); } catch { return null; } });
    const events = canonicalize(JSON.parse(JSON.stringify(f.session.snapshotEvents())), h.root);
    const summaries = f.summaries().map((event) => ({
      seq: event.seq,
      kind: event.data?.source?.kind ?? event.data?.kind ?? null,
      shadowedSeqs: event.data?.shadowedSeqs ?? null,
      text: canonicalText(src.plan.messageText({ content: event.data?.summary })),
    }));
    const record = {
      meta: { case: caseDef.name, src: String(args.src), corpusVersion: CORPUS_VERSION, node: process.version },
      kind: caseDef.kind || "local",
      env: { ...(caseDef.env || {}) },
      config: { ...(caseDef.config || {}) },
      eventHash: contentHash(JSON.stringify(events)),
      events,
      surface: [...f.session.surface.nodes],
      summaries,
      summarizeInputs: canonicalize(JSON.parse(JSON.stringify(h.summarizeInputs)), h.root),
      decisions,
      cuts,
      stats,
      shadowTree,
      rawSeen,
      restores,
      log: { infos: canonicalize(h.infos, h.root), warnings: canonicalize(h.warnings, h.root) },
    };
    const payload = canonicalize(JSON.parse(JSON.stringify(record)), h.root);
    writeFileSync(String(args.out), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`collected ${caseDef.name} (${args.src}) -> ${args.out}`);
  } finally {
    await h.dispose();
  }
}

main().catch((error) => { console.error(error?.stack || error); process.exit(1); });