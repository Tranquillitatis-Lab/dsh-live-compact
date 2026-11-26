#!/usr/bin/env node
// 等价性验证台：红线断言。
// 这些不变量与具体实现无关，基线树与当前树都必须全部成立；任何修复不得破坏它们：
//   R1 常量：DEFAULT_COOLDOWN_MS=300000、DEFAULTS、ENGINE_DEFAULTS、
//      worker 超时/恢复/闲置 = 30000/60000/60000(win)。
//   R2 backup-before-prune：raw.js 头部不变量声明；切割后备份存在、内容哈希一致。
//   R3 verifiedRaw：备份缺失 → 拒绝切割（finishTurn=false + "raw backup missing" 警告），会话事件不变。
//   R4 writeShadowFile：tmp+rename 原子发布；写入失败不留目标文件、不留 *.tmp。
//   R5 saveShadowAsync：并发派发按序完成、全部落盘（背压不丢任务，走真实 worker 路径）。
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { contentHash, patchDeterministicClock } from "./canonical.mjs";
import { loadSrc, makeFixture, makeRuntime } from "./harness.mjs";

async function runRedlines({ srcDir } = {}) {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, ok: true });
      console.log(`红线 PASS ${name}`);
    } catch (error) {
      results.push({ name, ok: false, detail: String(error?.message || error) });
      console.error(`红线 FAIL ${name}：${error?.message || error}`);
    }
  };
  const src = await loadSrc(srcDir);

  await check("R1 常量：DEFAULT_COOLDOWN_MS=300000", () => {
    assert.equal(src.cooldown.DEFAULT_COOLDOWN_MS, 300000);
    assert.match(readFileSync(join(srcDir, "cooldown.js"), "utf8"), /DEFAULT_COOLDOWN_MS\s*=\s*300000/);
  });

  await check("R1 常量：DEFAULTS 关键值", () => {
    const { DEFAULTS } = src.settings;
    assert.equal(DEFAULTS.minTokens, 20000);
    assert.equal(DEFAULTS.keepRounds, 3);
    assert.equal(DEFAULTS.keepRoundTokens, 32000);
    assert.equal(DEFAULTS.pointerTokens, 0);
    assert.equal(DEFAULTS.chunkMin, 1000);
    assert.equal(DEFAULTS.chunkMax, 32000);
    assert.equal(DEFAULTS.bigGate, 650000);
    assert.equal(DEFAULTS.cooldownMs, 0);
  });

  await check("R1 常量：ENGINE_DEFAULTS 关键值", () => {
    const { ENGINE_DEFAULTS } = src.settings;
    assert.equal(ENGINE_DEFAULTS.thresholdRatio, 0.8);
    assert.equal(ENGINE_DEFAULTS.headroomTokens, 65536);
    assert.equal(ENGINE_DEFAULTS.retainTokens, 8192);
    assert.equal(ENGINE_DEFAULTS.compactionRetries, 0);
  });

  await check("R1 常量：worker 超时/恢复/闲置", () => {
    const source = readFileSync(join(srcDir, "index.js"), "utf8");
    assert.match(source, /SHADOW_WORKER_TIMEOUT_MS\s*=\s*30000/);
    assert.match(source, /SHADOW_WORKER_RECOVERY_MS\s*=\s*60000/);
    assert.match(source, /SHADOW_WORKER_IDLE_MS\s*=\s*process\.platform\s*===\s*"win32"\s*\?\s*60000\s*:\s*500/);
  });

  await check("R2 raw.js 头部 backup-before-prune 声明", () => {
    const head = readFileSync(join(srcDir, "raw.js"), "utf8").slice(0, 800);
    assert.match(head, /工具原文/);
    assert.match(head, /只写一次/);
    assert.match(head, /官方修剪器/);
  });

  await check("R2 行为：切割后备份存在且哈希一致", async () => {
    const clock = patchDeterministicClock();
    const h = makeRuntime({ src });
    try {
      const { engine } = h.engine({}, "local");
      const f = h.use(makeFixture({ totalTokens: 24000 }));
      h.capture(engine, f);
      await engine.finishTurn(f.agent());
      const okRecords = [...engine.rawSeen.values()].filter((record) => record?.ok);
      assert.ok(okRecords.length > 0, "rawSeen 中没有任何成功备份");
      for (const record of okRecords) {
        const body = readFileSync(record.path, "utf8");
        assert.equal(contentHash(body), record.sha256, `备份内容哈希不一致：${record.path}`);
        const meta = JSON.parse(readFileSync(`${record.path}.meta.json`, "utf8"));
        assert.equal(meta.sha256, record.sha256, `meta.sha256 与记录不一致：${record.path}`);
        assert.equal(meta.bytes, record.bytes, `meta.bytes 与记录不一致：${record.path}`);
        assert.equal(meta.toolCallId, record.toolCallId, `meta.toolCallId 与记录不一致：${record.path}`);
      }
    } finally {
      clock.restore();
      await h.dispose();
    }
  });

  await check("R3 verifiedRaw：备份缺失必须拒切且不改会话", async () => {
    const clock = patchDeterministicClock();
    const h = makeRuntime({ src });
    try {
      const { engine } = h.engine({}, "local");
      const f = h.use(makeFixture({ totalTokens: 20000 }));
      h.capture(engine, f);
      await engine.finishTurn(f.agent());
      let lastSeq = Math.max(...f.session.snapshotEvents().map((event) => event.seq));
      // 同一 toolCallId 携带不同内容 → 第二次备份被拒（duplicate-tool-call-id），
      // rawSeen 里该 id 变为 !ok；再补几轮增长把 vanish 轮推进切割窗口。
      f.round("vanish-1", { tokens: 12000, text: "INFO vanish probe first body" });
      f.round("vanish-1", { tokens: 12000, text: "INFO vanish probe second body" });
      f.round("grow-1", { tokens: 8000, text: "INFO grow one" });
      f.round("grow-2", { tokens: 8000, text: "INFO grow two" });
      f.round("grow-3", { tokens: 8000, text: "INFO grow three" });
      for (const event of f.session.snapshotEvents()) {
        if (event.seq <= lastSeq) continue;
        engine.noteEvent(f.session, event);
        if (event.type === "tool/result") engine.captureOne(f.session, event);
        lastSeq = Math.max(lastSeq, event.seq);
      }
      const refused = [...engine.rawSeen.values()].find((record) => record?.toolCallId === "vanish-1");
      assert.ok(refused, "未找到 vanish-1 的 rawSeen 记录");
      assert.equal(refused.ok, false, "重复 toolCallId 的第二次备份必须被拒");
      const before = JSON.stringify(f.session.snapshotEvents());
      const cut = await engine.finishTurn(f.agent());
      assert.equal(cut, false, "备份缺失的切割必须被拒（finishTurn 返回 false）");
      assert.equal(JSON.stringify(f.session.snapshotEvents()), before, "失败的切割不得改动会话事件");
      assert.ok(
        h.warnings.some((text) => String(text).includes("spine: raw backup missing before cut: vanish-1")),
        "必须记录 raw backup missing before cut 警告",
      );
    } finally {
      clock.restore();
      await h.dispose();
    }
  });

  await check("R4 writeShadowFile：tmp+rename 原子性，失败不留残骸", async () => {
    const clock = patchDeterministicClock();
    const h = makeRuntime({ src });
    try {
      const dir = join(h.root, "atomicity");
      const target = join(dir, "cut-0001-atomic.txt");
      src.shadow.writeShadowFile(target, "正常内容", {}, { root: h.root });
      assert.equal(readFileSync(target, "utf8"), "正常内容");
      rmSync(target, { force: true });
      const injected = () => { throw new Error("injected write failure"); };
      let threw = null;
      try {
        src.shadow.writeShadowFile(target, "不该写进去的内容", {}, { root: h.root, write: injected });
      } catch (error) { threw = error; }
      assert.ok(threw, "写入失败必须抛错");
      assert.match(String(threw?.message || threw), /injected write failure/);
      assert.ok(!existsSync(target), "失败后不得留下目标文件");
      const leftovers = readdirSync(dir).filter((name) => name.endsWith(".tmp"));
      assert.deepEqual(leftovers, [], "失败后不得留下 *.tmp 暂存文件");
    } finally {
      clock.restore();
      await h.dispose();
    }
  });

  await check("R5 saveShadowAsync：40 路并发 FIFO 完成且不丢任务", async () => {
    const clock = patchDeterministicClock();
    const h = makeRuntime({ src });
    try {
      const { engine } = h.engine({}, "local");
      const total = 40;
      const done = [];
      const jobs = [];
      for (let index = 0; index < total; index++) {
        const file = join(h.root, "fifo-session", `cut-${String(index).padStart(4, "0")}-fifo.txt`);
        jobs.push(engine.saveShadowAsync(
          [{ role: "user", content: [{ type: "text", text: `fifo 消息 ${index}` }] }],
          true, file, "fifo-session",
        ).then(() => { done.push(index); }));
      }
      await Promise.all(jobs);
      assert.equal(done.length, total, `完成任务数 ${done.length} != ${total}`);
      assert.deepEqual(done, Array.from({ length: total }, (_, index) => index), "完成顺序必须等于派发顺序");
      for (let index = 0; index < total; index++) {
        const file = join(h.root, "fifo-session", `cut-${String(index).padStart(4, "0")}-fifo.txt`);
        assert.ok(existsSync(file), `缺少第 ${index} 个影子文件`);
        assert.match(readFileSync(file, "utf8"), new RegExp(`fifo 消息 ${index}`));
      }
    } finally {
      clock.restore();
      await h.dispose();
    }
  });

  return { results, failures: results.filter((item) => !item.ok).length };
}

export { runRedlines };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  runRedlines({ srcDir }).then(({ failures }) => process.exit(failures === 0 ? 0 : 1));
}
