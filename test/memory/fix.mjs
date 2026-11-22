// 内存实验台：参数化 harness 与内存采样工具。
// 与 test/equivalence/harness.mjs 同构（makeFixture/makeRuntime 行为一致），差异点：
//  - shadow 根目录落在 test/memory/.tmp/ 下（不越出工作区），dispose 时清理；
//  - 多会话可共享同一个 engine/Context（共用同一 shadow worker，天然形成保存突发队列）；
//  - 附带 gc 采样、中位数、线性回归、Worker 计数等度量工具。
// 运行约束：
//  - 必须 node --expose-gc（run.mjs 缺少该参数时会自动重启自身）；
//  - 不得设置 NODE_TEST_CONTEXT：设置后 saveShadowAsync 退化为同步保存，
//    绕开被测的 shadow worker 线程与背压逻辑，实验结果失效。
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import { Session } from "@deepseek-ai/dsh-session";
import {
  createAssistantMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from "@deepseek-ai/dsh-llm";

export async function loadSrc(srcDir) {
  const mod = (name) => import(pathToFileURL(join(srcDir, name)).href);
  const [index, settings, shadow, raw, plan, cooldown] = await Promise.all([
    mod("index.js"), mod("settings.js"), mod("shadow.js"), mod("raw.js"), mod("plan.js"), mod("cooldown.js"),
  ]);
  return { srcDir, Spine: index.default, index, settings, shadow, raw, plan, cooldown };
}

let serial = 0;

export function makeFixture({ totalTokens = 24000, id = `mem-${++serial}`, session = Session.create(id) } = {}) {
  const prices = new Map();
  const f = { session, prices, rounds: [] };
  f.add = (type, data, tokens = 20, options = { surfaceOp: "append" }) => {
    if (type === "assistant/message") data = { step: 0, stream: [], ...data };
    const event = f.session.append(type, data, options);
    prices.set(event.seq, tokens);
    return event.seq;
  };
  f.user = (text, source = { kind: "user" }) =>
    f.add("user/message", createUserMessage({ content: [{ type: "text", text }], source }), 80);
  f.round = (id, { name = "shell", text = "INFO fixture heartbeat ok", tokens = 30, command = "echo fixture", turn = 1, prose = "", isError = false } = {}) => {
    const call = f.add("assistant/message", { turn, message: createAssistantMessage({
      content: [...(prose ? [{ type: "text", text: prose }] : []), { type: "tool-call", id, name,
        arguments: JSON.stringify(name === "read" ? { file_path: "ledger.txt" } : { command }) }],
      source: { provider: "test", model: "no-network" },
    }) });
    const result = f.add("tool/result", { turn, message: createToolResultMessage({
      callId: id, content: [{ type: "text", text }], isError,
    }) }, tokens);
    const round = [call, result];
    f.rounds.push(round);
    return round;
  };
  f.measure = () => {
    const nodes = f.session.surface.nodes.map((seq) => ({ seq, tokens: prices.get(seq) ?? 200, heuristicTokens: prices.get(seq) ?? 200 }));
    const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0);
    return { nodes, totalTokens, totalHeuristicTokens: totalTokens };
  };
  f.agent = () => ({ session: f.session, runMaintenance: (fn) => fn(new AbortController().signal) });
  f.summaries = () => f.session.snapshotEvents().filter((event) => event.type === "compaction/summary");
  f.add("system/message", { message: createSystemMessage("runtime fixture") }, totalTokens - 3270);
  f.lastUser = f.user("读取日志并继续当前任务。");
  for (let index = 0; index < 3; index++) f.round(`short-${index}`);
  f.add("assistant/message", { turn: 1, message: createAssistantMessage({
    content: [{ type: "text", text: "本轮结束。" }], source: { provider: "test", model: "no-network" },
  }) });
  return f;
}

export function makeRuntime({ src, rootDir } = {}) {
  const { resetShadowAccessState } = src.shadow;
  const keys = [...Object.values(src.settings.ENV), "SPINE_SHADOW_DIR", "SPINE_THUNDER", "SPINE_ENGINE_FAIL",
    "SPINE_SHADOW_MAX_BYTES", "SPINE_SHADOW_MAX_MB"];
  const saved = new Map(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  mkdirSync(rootDir, { recursive: true });
  const root = mkdtempSync(join(rootDir, "mem-"));
  process.env.SPINE_SHADOW_DIR = root;
  resetShadowAccessState();
  const contexts = [];
  const fixtures = new Map();
  const h = { root, fixtures, warnings: [], infos: [], modelCalls: 0 };
  h.engine = (config = {}, engineKind = "local", Engine = src.Spine) => {
    const ctx = new Context();
    contexts.push(ctx);
    ctx.logger = { info: (line) => h.infos.push(line), debug() {}, warn: (line) => h.warnings.push(line) };
    ctx.sessions = {};
    ctx.sessions.flush = async () => {};
    ctx.tokenMeter = { measure: (session) => fixtures.get(session).measure(), estimateMessage: () => 200 };
    ctx.llm = new Proxy({}, { get: () => () => { h.modelCalls++; throw new Error("model calls forbidden"); } });
    ctx.provide("toolResultPruner", { pruneSession() {} });
    const engine = new Engine(ctx.isolate("compaction"), { auto: false, ...config });
    engine.engineFor = () => ({ engine: engineKind, source: "fixture" });
    return { engine, ctx };
  };
  h.use = (f) => { fixtures.set(f.session, f); return f; };
  h.capture = (engine, f) => {
    for (const event of f.session.snapshotEvents()) {
      engine.noteEvent(f.session, event);
      if (event.type === "tool/result") engine.captureOne(f.session, event);
    }
    engine.captureSession(f.session);
  };
  h.dispose = async () => {
    for (const ctx of contexts) await ctx.fiber.dispose();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    resetShadowAccessState();
    rmSync(root, { recursive: true, force: true });
  };
  return h;
}

// ---- 内存度量工具 ----

export function gcNow(passes = 3) {
  if (typeof global.gc !== "function") throw new Error("内存实验台必须以 node --expose-gc 运行");
  for (let i = 0; i < passes; i++) global.gc();
}

export function sampleMemory() {
  const m = process.memoryUsage();
  return { ts: Date.now(), heapUsed: m.heapUsed, heapTotal: m.heapTotal, rss: m.rss, external: m.external, arrayBuffers: m.arrayBuffers };
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (!n) return 0;
  return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

// 多轮 gc 后取中位数，压制单次 gc 的抖动。
export function medianSample({ passes = 3, rounds = 3 } = {}) {
  const heaps = [];
  const rsses = [];
  for (let i = 0; i < rounds; i++) {
    gcNow(passes);
    const m = process.memoryUsage();
    heaps.push(m.heapUsed);
    rsses.push(m.rss);
  }
  return { ts: Date.now(), heapUsed: median(heaps), rss: median(rsses) };
}

export function linregSlope(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    den += dx * dx;
  }
  return den === 0 ? 0 : num / den;
}

export function countWorkers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "Worker").length;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function fmtBytes(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  if (abs >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)}GiB`;
  if (abs >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(2)}MiB`;
  if (abs >= 1024) return `${(n / 1024).toFixed(1)}KiB`;
  return `${n}B`;
}
