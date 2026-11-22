// 内存实验台入口：实验 A（压缩突发峰值）/ B（dispose 回收）/ C（长跑斜率）。
// 用法:
//   node test/memory/run.mjs --exp A|B|C|all --src baseline|current [尺寸参数]
// 尺寸参数: --sessions --waves --payload-kb --turns --b-sessions --b-turns
//           --b-payload-kb --rounds --c-payload-kb --c-tokens --quick
// 说明:
//  - 缺少 --expose-gc 时自动重启自身；
//  - 每个 (实验, 源码树) 组合在独立子进程中运行，避免模块级单例
//    （shadowWorkers、settings 缓存、resetShadowAccessState）在两棵树之间串场；
//  - 结果逐项落盘 test/memory/results/<exp>-<src>.json，并追加 summary.jsonl；
//  - baseline = test/equivalence/baseline-src（HEAD 4b86453），current = 仓库根。
//  - 全程不设置 NODE_TEST_CONTEXT，保持真实 shadow worker 线程路径。
import { execSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fmtBytes, gcNow, linregSlope, loadSrc, makeFixture, makeRuntime,
  medianSample, sampleMemory, sleep,
} from "./fix.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(dirname(here));
const resultsDir = join(here, "results");
const baselineDir = join(repoRoot, "test", "equivalence", "baseline-src");

function parseArgs(argv) {
  const p = {
    exp: "all", src: "all", child: false, quick: false,
    sessions: 40, waves: 3, payloadKb: 4096, tokensPerRound: 13000,
    bSessions: 3, bTurns: 3, bPayloadKb: 512,
    rounds: 300, cPayloadKb: 64, cTokens: 13000,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === "--exp") p.exp = next();
    else if (arg === "--src") p.src = next();
    else if (arg === "--child") p.child = true;
    else if (arg === "--quick") p.quick = true;
    else if (arg === "--sessions") p.sessions = Number(next());
    else if (arg === "--waves") p.waves = Number(next());
    else if (arg === "--payload-kb") p.payloadKb = Number(next());
    else if (arg === "--tokens") p.tokensPerRound = Number(next());
    else if (arg === "--b-sessions") p.bSessions = Number(next());
    else if (arg === "--b-turns") p.bTurns = Number(next());
    else if (arg === "--b-payload-kb") p.bPayloadKb = Number(next());
    else if (arg === "--rounds") p.rounds = Number(next());
    else if (arg === "--c-payload-kb") p.cPayloadKb = Number(next());
    else if (arg === "--c-tokens") p.cTokens = Number(next());
  }
  if (p.quick) {
    p.sessions = 6; p.waves = 1; p.payloadKb = 256;
    p.bSessions = 2; p.bTurns = 1; p.bPayloadKb = 128;
    p.rounds = 12; p.cPayloadKb = 32;
  }
  return p;
}

// 捕获新增事件（模拟线上 noteEvent/captureOne 数据面，两棵树行为一致）。
function captureSeq(engine, f, seqs) {
  for (const seq of seqs) {
    const event = f.session.eventAt?.(seq);
    if (!event) continue;
    engine.noteEvent(f.session, event);
    if (event.type === "tool/result") engine.captureOne(f.session, event);
  }
}

// 实验 A：N 个会话共享同一 engine/Context（=> 同一 shadow worker），
// 连续 W 波并发 finishTurn，制造 saveShadowAsync 突发。高频采样（不强制 gc）
// 记录主进程 heapUsed/RSS 瞬时峰值。
async function expA(src, p) {
  const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
  try {
    const { engine } = h.engine({}, "local");
    const fixtures = [];
    for (let i = 0; i < p.sessions; i++) {
      const f = h.use(makeFixture({ totalTokens: 24000, id: `mem-a-${i}` }));
      h.capture(engine, f);
      fixtures.push(f);
    }
    const text = "A".repeat(Math.max(1024, p.payloadKb * 1024 - 32));
    gcNow();
    const pre = sampleMemory();
    let peakHeap = 0;
    let peakRss = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
      if (m.rss > peakRss) peakRss = m.rss;
    }, 5);
    timer.unref?.();
    for (let w = 0; w < p.waves; w++) {
      await Promise.all(fixtures.map(async (f) => {
        captureSeq(engine, f, f.round(`burst-${w}`, { name: "read", tokens: p.tokensPerRound, text, turn: w + 2 }));
        await engine.finishTurn(f.agent());
      }));
    }
    clearInterval(timer);
    const post = medianSample({});
    const compactions = fixtures.reduce((n, f) => n + f.summaries().length, 0);
    return {
      exp: "A", src: p.src, date: new Date().toISOString(), node: process.version,
      params: { sessions: p.sessions, waves: p.waves, payloadKb: p.payloadKb, tokensPerRound: p.tokensPerRound },
      preHeapUsed: pre.heapUsed, peakHeapUsed: peakHeap, postGcHeapUsed: post.heapUsed,
      preRss: pre.rss, peakRss: peakRss, postGcRss: post.rss,
      burstDeltaHeap: peakHeap - pre.heapUsed, burstDeltaRss: peakRss - pre.rss,
      compactions, modelCalls: h.modelCalls, warnings: h.warnings.length,
    };
  } finally {
    await h.dispose();
  }
}

// worker_threads 存活数：process.report.getReport().workers 在本机 Node v26.7.0
// 实测对 ref/unref worker 均准确（probe7/probe8 验证）；getActiveResourcesInfo 对
// Worker 失明，不可用作线程证据。
function workerThreadCount() {
  try {
    return process.report.getReport().workers?.length ?? -1;
  } catch {
    return -1;
  }
}

// 进程总线程数（pwsh 旁证；采样慢，只在 dispose 前后各取一次）。
function processThreadCount() {
  try {
    return Number(execSync(
      `pwsh -NoProfile -Command "(Get-Process -Id ${process.pid}).Threads.Count"`,
      { encoding: "utf8" },
    ).trim());
  } catch {
    return -1;
  }
}

// 实验 B：少量会话多轮压缩后 dispose，验证：heap 可回收、shadow worker 线程退出、
// disposed 标志复位（仅当前树有）。
async function expB(src, p) {
  let h = makeRuntime({ src, rootDir: join(here, ".tmp") });
  let disposed = false;
  try {
    let engine = h.engine({}, "local").engine;
    const fixtures = [];
    for (let i = 0; i < p.bSessions; i++) {
      const f = h.use(makeFixture({ totalTokens: 24000, id: `mem-b-${i}` }));
      h.capture(engine, f);
      fixtures.push(f);
    }
    let text = "B".repeat(Math.max(1024, p.bPayloadKb * 1024 - 32));
    let peakHeap = 0;
    const timer = setInterval(() => {
      const m = process.memoryUsage();
      if (m.heapUsed > peakHeap) peakHeap = m.heapUsed;
    }, 5);
    timer.unref?.();
    for (let t = 0; t < p.bTurns; t++) {
      for (const f of fixtures) {
        captureSeq(engine, f, f.round(`b-${t}`, { name: "read", tokens: p.tokensPerRound, text, turn: t + 2 }));
      }
      await Promise.all(fixtures.map((f) => engine.finishTurn(f.agent())));
    }
    clearInterval(timer);
    const pre = medianSample({});
    const workersBefore = workerThreadCount();
    const threadsBefore = processThreadCount();
    const disposedFlagBefore = engine.disposed;
    const t0 = performance.now();
    await h.dispose();
    disposed = true;
    let workersAfter = workerThreadCount();
    let workerExitMs = null;
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      workersAfter = workerThreadCount();
      if (workersAfter === 0) {
        workerExitMs = performance.now() - t0;
        break;
      }
      await sleep(25);
    }
    const threadsAfter = processThreadCount();
    fixtures.length = 0;
    h.fixtures.clear();
    const disposedFlagAfter = engine.disposed;
    const warningCount = h.warnings.length;
    const firstWarning = h.warnings[0] ?? null;
    engine = null;
    h = null;
    text = null;
    const post = medianSample({});
    return {
      exp: "B", src: p.src, date: new Date().toISOString(), node: process.version,
      params: { sessions: p.bSessions, turns: p.bTurns, payloadKb: p.bPayloadKb },
      peakHeapUsed: peakHeap, preDisposeHeapUsed: pre.heapUsed, postDisposeHeapUsed: post.heapUsed,
      heapDrop: pre.heapUsed - post.heapUsed,
      preDisposeRss: pre.rss, postDisposeRss: post.rss, rssDrop: pre.rss - post.rss,
      workersBefore, workersAfter, workerExit: workersAfter === 0, workerExitMs,
      threadsBefore, threadsAfter,
      disposedFlagBefore: disposedFlagBefore === undefined ? null : disposedFlagBefore,
      disposedFlagAfter: disposedFlagAfter === undefined ? null : disposedFlagAfter,
      warnings: warningCount, firstWarning,
    };
  } finally {
    if (!disposed && h) await h.dispose();
  }
}

// 实验 C：单会话连续 M 轮压缩（每轮都会触发 cut + shadow 保存/轮转），
// 每轮 gc 后采样 heapUsed/RSS，用最小二乘斜率判断泄漏。
async function expC(src, p) {
  const h = makeRuntime({ src, rootDir: join(here, ".tmp") });
  try {
    const { engine } = h.engine({}, "local");
    const f = h.use(makeFixture({ totalTokens: 24000, id: "mem-c-0" }));
    h.capture(engine, f);
    const text = "C".repeat(Math.max(1024, p.cPayloadKb * 1024 - 32));
    const series = [];
    for (let r = 0; r < p.rounds; r++) {
      captureSeq(engine, f, f.round(`c-${r}`, { name: "read", tokens: p.cTokens, text, turn: r + 2 }));
      // 会话事件数超过 CAPTURE_EVENT_BATCH(128) 后，finishTurn 默认把捕获追赶交给
      // 后台并直接返回 null（无头夹具没有下一轮来冲洗追赶队列），cut 自此停摆
      // （probe6 实测 r=20 起事件数>128）。maintenanceRetry 对应生产环境"追赶完成后
      // 重跑维护"的路径，使每轮 cut 持续触发。
      await engine.finishTurn(f.agent(), undefined, { maintenanceRetry: true });
      gcNow(2);
      const m = process.memoryUsage();
      series.push({ r, heapUsed: m.heapUsed, rss: m.rss });
    }
    const heaps = series.map((s) => s.heapUsed);
    const rsses = series.map((s) => s.rss);
    const rs = series.map((s) => s.r);
    const half = Math.floor(series.length / 2);
    return {
      exp: "C", src: p.src, date: new Date().toISOString(), node: process.version,
      params: { rounds: p.rounds, payloadKb: p.cPayloadKb, tokensPerRound: p.cTokens },
      firstHeapUsed: heaps[0], lastHeapUsed: heaps[heaps.length - 1],
      minHeapUsed: Math.min(...heaps), maxHeapUsed: Math.max(...heaps),
      slopeHeapPerRound: linregSlope(rs, heaps),
      slopeHeapPerRoundSecondHalf: linregSlope(rs.slice(half), heaps.slice(half)),
      slopeRssPerRound: linregSlope(rs, rsses),
      compactions: f.summaries().length, warnings: h.warnings.length,
      series,
    };
  } finally {
    await h.dispose();
  }
}

function summaryLine(r) {
  if (r.exp === "A") {
    return `A[${r.src}] 峰值heap=${fmtBytes(r.peakHeapUsed)} 峰值RSS=${fmtBytes(r.peakRss)} 压缩=${r.compactions} 警告=${r.warnings}`;
  }
  if (r.exp === "B") {
    return `B[${r.src}] dispose前=${fmtBytes(r.preDisposeHeapUsed)} dispose后=${fmtBytes(r.postDisposeHeapUsed)} 回收=${fmtBytes(r.heapDrop)} worker退出=${r.workerExit ? `是(${Math.round(r.workerExitMs ?? -1)}ms)` : "否"}(worker ${r.workersBefore}->${r.workersAfter}, 线程 ${r.threadsBefore}->${r.threadsAfter}) disposed=${r.disposedFlagAfter}`;
  }
  if (r.exp === "C") {
    return `C[${r.src}] 首轮=${fmtBytes(r.firstHeapUsed)} 末轮=${fmtBytes(r.lastHeapUsed)} 斜率=${r.slopeHeapPerRound.toFixed(0)}B/轮(后半程 ${r.slopeHeapPerRoundSecondHalf.toFixed(0)}) RSS斜率=${r.slopeRssPerRound.toFixed(0)}B/轮 压缩=${r.compactions}`;
  }
  return JSON.stringify(r);
}

async function runChild(p) {
  if (!global.gc) {
    console.error("子进程缺少 global.gc，请以 --expose-gc 运行");
    process.exitCode = 2;
    return;
  }
  const srcDir = p.src === "baseline" ? baselineDir : repoRoot;
  const src = await loadSrc(srcDir);
  gcNow();
  const base = sampleMemory();
  let result;
  if (p.exp === "A") result = await expA(src, p);
  else if (p.exp === "B") result = await expB(src, p);
  else if (p.exp === "C") result = await expC(src, p);
  else throw new Error(`未知实验 ${p.exp}`);
  result.baseHeapUsed = base.heapUsed;
  result.baseRss = base.rss;
  mkdirSync(resultsDir, { recursive: true });
  const file = join(resultsDir, `${p.exp}-${p.src}.json`);
  writeFileSync(file, JSON.stringify(result, null, 2));
  appendFileSync(join(resultsDir, "summary.jsonl"), JSON.stringify({ ...result, series: undefined }) + "\n");
  console.log(`[mem] ${p.exp}/${p.src} -> ${file}`);
  console.log(`[mem] ${summaryLine(result)}`);
}

function readResult(exp, src) {
  const file = join(resultsDir, `${exp}-${src}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function printComparison(exps, srcs) {
  console.log("\n===== 内存实验对照（baseline vs current）=====");
  if (exps.includes("A")) {
    const b = readResult("A", "baseline");
    const c = readResult("A", "current");
    console.log("-- 实验 A：压缩突发峰值 --");
    for (const r of [b, c]) if (r) console.log(`  ${summaryLine(r)}`);
    if (b && c && b.peakHeapUsed && c.peakHeapUsed) {
      console.log(`  峰值比 current/baseline: heap=${(c.peakHeapUsed / b.peakHeapUsed).toFixed(3)}x  RSS=${(c.peakRss / b.peakRss).toFixed(3)}x（验收：heap ≤ 2x）`);
    }
  }
  if (exps.includes("B")) {
    const b = readResult("B", "baseline");
    const c = readResult("B", "current");
    console.log("-- 实验 B：dispose 回收 --");
    for (const r of [b, c]) if (r) {
      const added = r.preDisposeHeapUsed - (r.baseHeapUsed ?? r.postDisposeHeapUsed);
      const pct = added > 0 ? ((r.heapDrop / added) * 100).toFixed(1) : "n/a";
      console.log(`  ${summaryLine(r)}  回收率(相对实验新增heap)=${pct}%`);
    }
  }
  if (exps.includes("C")) {
    const b = readResult("C", "baseline");
    const c = readResult("C", "current");
    console.log("-- 实验 C：长跑斜率 --");
    for (const r of [b, c]) if (r) console.log(`  ${summaryLine(r)}`);
  }
}

async function runParent(p) {
  mkdirSync(resultsDir, { recursive: true });
  const exps = p.exp === "all" ? ["A", "B", "C"] : [p.exp];
  const srcs = p.src === "all" ? ["baseline", "current"] : [p.src];
  for (const exp of exps) {
    for (const src of srcs) {
      console.log(`\n=== 内存实验 ${exp} / ${src} ===`);
      const args = [
        "--expose-gc", join(here, "run.mjs"),
        "--exp", exp, "--src", src, "--child",
        "--sessions", String(p.sessions), "--waves", String(p.waves),
        "--payload-kb", String(p.payloadKb), "--tokens", String(p.tokensPerRound),
        "--b-sessions", String(p.bSessions), "--b-turns", String(p.bTurns),
        "--b-payload-kb", String(p.bPayloadKb),
        "--rounds", String(p.rounds), "--c-payload-kb", String(p.cPayloadKb),
        "--c-tokens", String(p.cTokens),
      ];
      const r = spawnSync(process.execPath, args, { stdio: "inherit", cwd: repoRoot });
      if (r.status !== 0) console.error(`[mem] ${exp}/${src} 子进程退出码 ${r.status}`);
    }
  }
  printComparison(exps, srcs);
}

async function main() {
  const p = parseArgs(process.argv.slice(2));
  if (p.child) {
    await runChild(p);
    process.exit(process.exitCode ?? 0);
    return;
  }
  if (!global.gc) {
    const r = spawnSync(process.execPath, ["--expose-gc", ...process.argv.slice(1)], { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  await runParent(p);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
