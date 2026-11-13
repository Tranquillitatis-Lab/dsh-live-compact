import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setImmediate } from "node:timers/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { Session } from "@deepseek-ai/dsh-session";
import { contentHash, pointerFor, PRUNE_MARKER, rawName } from "../raw.js";
import { sessionDir } from "../shadow.js";
import { fixture, runtime } from "./helpers/runtime.mjs";
import { windowsAclCall } from "./helpers/windows-acl.mjs";

test("guarded prune retries the first busy result, caches later captures and publishes only safe cursor progress", (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  engine.writeCaptureCursor(f.session.id, 0);
  const lock = join(h.root, ".spine-rotation.lock");
  writeFileSync(lock, `${JSON.stringify({ v: 1, pid: process.pid, id: "a".repeat(48) })}\n`);
  const captures = [];
  const capture = engine.captureOne.bind(engine);
  engine.captureOne = (session, event) => {
    const id = event.data.message.toolCallId;
    captures.push(id);
    const record = capture(session, event);
    if (id === "long" && record.retryable) unlinkSync(lock);
    return record;
  };
  engine.ensurePruneGuard();
  const before = JSON.stringify(f.session.snapshotEvents());
  ctx.toolResultPruner.pruneSession(f.session);
  assert.equal(h.pruneCalls, 0);
  assert.equal(JSON.stringify(f.session.snapshotEvents()), before);
  assert.equal(engine.captureCursor.get(f.session.id), f.longRound[1]);
  assert.equal(engine.readCaptureCursor(f.session.id), f.longRound[1]);
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long")).retryable, true);
  assert.equal(existsSync(join(sessionDir(h.root, f.session.id), rawName("long"))), false);
  assert.deepEqual(captures, ["long", "short-0", "short-1", "short-2"]);
  for (const id of ["short-0", "short-1", "short-2"]) {
    const raw = engine.rawSeen.get(engine.rawKey(f.session, id));
    assert.equal(raw.ok, true);
    assert.equal(existsSync(`${raw.path}.meta.json`), true);
  }
  const scanned = [];
  const note = engine.noteEvent.bind(engine);
  engine.noteEvent = (session, event) => { scanned.push(event.seq); note(session, event); };
  ctx.toolResultPruner.pruneSession(f.session);
  assert.equal(h.pruneCalls, 1);
  assert.deepEqual(captures, ["long", "short-0", "short-1", "short-2", "long"]);
  assert.deepEqual(scanned, f.session.snapshotEvents().filter((event) => event.seq >= f.longRound[1]).map((event) => event.seq));
  assert.equal(engine.readCaptureCursor(f.session.id), f.session.snapshotEvents().length);
  const raw = engine.rawSeen.get(engine.rawKey(f.session, "long"));
  const meta = JSON.parse(readFileSync(`${raw.path}.meta.json`, "utf8"));
  assert.equal(raw.ok, true);
  assert.equal(meta.sha256, contentHash(readFileSync(raw.path)));
  assert.equal(meta.bytes, statSync(raw.path).size);
  assert.equal(meta.toolCallId, "long");
});

test("a visible busy live event before the recent-three boundary is retried after the lock clears", (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  const lock = join(h.root, ".spine-rotation.lock");
  writeFileSync(lock, `${JSON.stringify({ v: 1, pid: process.pid, id: "a".repeat(48) })}\n`);
  assert.equal(engine.captureOne(f.session, f.session.eventAt(f.longRound[1])).retryable, true);
  unlinkSync(lock);
  engine.ensurePruneGuard();
  ctx.toolResultPruner.pruneSession(f.session);
  assert.equal(h.pruneCalls, 1);
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long")).ok, true);
  assert.equal(engine.readCaptureCursor(f.session.id), f.session.snapshotEvents().length);
});

test("unsupported hardlinks still publish protected atomic capture cursors and permit guarded prune", (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  const mock = t.mock.method(fs, "linkSync", () => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); });
  syncBuiltinESMExports();
  try {
    engine.writeCaptureCursor(f.session.id, 0);
    engine.ensurePruneGuard();
    ctx.toolResultPruner.pruneSession(f.session);
    assert.equal(h.pruneCalls, 1);
    assert.equal(engine.readCaptureCursor(f.session.id), f.session.snapshotEvents().length);
    assert.equal(JSON.parse(readFileSync(engine.captureCursorFile(f.session.id), "utf8")).key, f.session.id);
  } finally { mock.mock.restore(); syncBuiltinESMExports(); }
});

test("restart restores visible raw references before guarded prune and a real local cut", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine: first, ctx: firstContext } = h.engine();
  h.capture(first, f);
  const original = first.rawSeen.get(first.rawKey(f.session, "long"));
  const fullText = readFileSync(original.path, "utf8");
  // Persist a genuinely pruned surface backed by the earlier full raw file.
  const oldResult = f.session.eventAt(f.longRound[1]).data;
  const replacement = f.add("tool/result", { ...oldResult, message: {
    ...oldResult.message, content: [{ type: "text", text: `head\n${PRUNE_MARKER}\ntail` }],
  } }, 3000, { surfaceOp: { op: "replace", startSeq: f.longRound[1], endSeq: f.longRound[1] } });
  f.longRound[1] = replacement;
  first.captureSession(f.session);
  const cursor = first.readCaptureCursor(f.session.id);
  assert.equal(cursor, f.session.snapshotEvents().length);
  const log = join(h.root, "session.json");
  writeFileSync(log, JSON.stringify(f.session.snapshotEvents()));
  await firstContext.fiber.dispose();
  f.session = Session.create(f.session.id, JSON.parse(readFileSync(log, "utf8")));
  h.use(f);
  const { engine, ctx } = h.engine();
  assert.equal(engine.rawSeen.size, 0);
  engine.ensurePruneGuard();
  assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(f.session));
  assert.equal(h.pruneCalls, 1);
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long"))?.ok, true);
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long")).sha256, original.sha256);
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
  assert.deepEqual(f.summaries()[0].data.shadowedSeqs, f.longRound);
  const cuts = readdirSync(sessionDir(h.root, f.session.id)).filter((name) => name.startsWith("cut-") && name.endsWith(".txt"));
  assert.equal(cuts.length, 1);
  const backup = readFileSync(join(sessionDir(h.root, f.session.id), cuts[0]), "utf8");
  assert.equal(backup.includes(fullText.trim()), true);
  assert.equal(backup.includes(PRUNE_MARKER), false);
});

const damageCases = {
  "missing raw": (file) => unlinkSync(file),
  "invalid meta JSON": (file) => writeFileSync(`${file}.meta.json`, "{"),
  "wrong meta ID": (_file, meta) => ({ ...meta, toolCallId: "another-call" }),
  "wrong meta bytes": (_file, meta) => ({ ...meta, bytes: meta.bytes + 1 }),
  "wrong meta hash": (_file, meta) => ({ ...meta, sha256: "0".repeat(64) }),
  "tampered body": (file) => writeFileSync(file, "tampered"),
  "pruned body even with matching hash": (file, meta) => {
    writeFileSync(file, PRUNE_MARKER);
    return { ...meta, bytes: Buffer.byteLength(PRUNE_MARKER), sha256: contentHash(PRUNE_MARKER) };
  },
};
for (const [name, damage] of Object.entries(damageCases)) {
  test(`guarded prune revalidates cached raw/meta after ${name} without overwriting damage`, (t) => {
    const h = runtime(t);
    const f = h.use(fixture());
    const { engine, ctx } = h.engine();
    h.capture(engine, f);
    const raw = engine.rawSeen.get(engine.rawKey(f.session, "long"));
    const changed = damage(raw.path, JSON.parse(readFileSync(`${raw.path}.meta.json`, "utf8")));
    if (changed && typeof changed === "object") writeFileSync(`${raw.path}.meta.json`, JSON.stringify(changed));
    const before = JSON.stringify(f.session.snapshotEvents());
    let captures = 0;
    engine.captureOne = () => { captures++; throw new Error("completed capture must not be replayed"); };
    engine.ensurePruneGuard();
    ctx.toolResultPruner.pruneSession(f.session);
    assert.equal(h.pruneCalls, 0);
    assert.equal(captures, 0);
    assert.equal(JSON.stringify(f.session.snapshotEvents()), before);
    assert.equal(engine.readCaptureCursor(f.session.id), f.session.snapshotEvents().length);
  });

  test(`restart refuses ${name}, leaves the surface intact, and the next session works`, async (t) => {
    const h = runtime(t);
    const f = h.use(fixture());
    const first = h.engine().engine;
    h.capture(first, f);
    const raw = first.rawSeen.get(first.rawKey(f.session, "long"));
    const changed = damage(raw.path, JSON.parse(readFileSync(`${raw.path}.meta.json`, "utf8")));
    if (changed && typeof changed === "object") writeFileSync(`${raw.path}.meta.json`, JSON.stringify(changed));
    const before = JSON.stringify(f.session.snapshotEvents());
    f.session = Session.create(f.session.id, JSON.parse(before));
    h.use(f);
    const { engine, ctx } = h.engine();
    engine.ensurePruneGuard();
    const surface = [...f.session.surface.nodes];
    const eventHash = contentHash(JSON.stringify(f.session.snapshotEvents()));
    assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(f.session));
    assert.equal(h.pruneCalls, 0);
    const refused = engine.rawSeen.get(engine.rawKey(f.session, "long"));
    assert.equal(refused.ok, false);
    assert.equal(pointerFor(refused), "无完整备份 [long]");
    await engine.finishTurn(f.agent());
    assert.equal(f.summaries().length, 0);
    assert.deepEqual(f.session.surface.nodes, surface);
    assert.equal(contentHash(JSON.stringify(f.session.snapshotEvents())), eventHash);
    assert.equal(h.warnings.some((line) => line.includes("prune skipped")), true);
    assert.equal(readdirSync(sessionDir(h.root, f.session.id)).some((name) => name.startsWith("cut-")), false);
    const healthy = h.use(fixture());
    h.capture(engine, healthy);
    assert.doesNotThrow(() => ctx.toolResultPruner.pruneSession(healthy.session));
    assert.equal(h.pruneCalls, 1);
    await engine.finishTurn(healthy.agent());
    assert.equal(healthy.summaries().length, 1);
  });
}

test("guarded prune does not trust a replacement raw/meta pair over the first captured hash", (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const { engine, ctx } = h.engine();
  h.capture(engine, f);
  const raw = engine.rawSeen.get(engine.rawKey(f.session, "long"));
  const body = "substituted text";
  writeFileSync(raw.path, body);
  writeFileSync(`${raw.path}.meta.json`, JSON.stringify({ toolCallId: "long", sha256: contentHash(body), bytes: Buffer.byteLength(body) }));
  engine.ensurePruneGuard();
  ctx.toolResultPruner.pruneSession(f.session);
  assert.equal(h.pruneCalls, 0);
});

test("recovery reads exact visible IDs, never enumerates backups or recaptures skipped history", (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const first = h.engine().engine;
  h.capture(first, f);
  // A replaced round remains in the event log but must not be recovered.
  f.add("user/message", f.session.eventAt(f.lastUser).data, 80,
    { surfaceOp: { op: "replace", startSeq: f.longRound[0], endSeq: f.longRound[1] } });
  first.captureSession(f.session);
  const { engine } = h.engine();
  const reads = [];
  const read = fs.readFileSync;
  let captures = 0;
  engine.captureOne = () => { captures++; throw new Error("historical recapture"); };
  const readMock = t.mock.method(fs, "readFileSync", (file, ...args) => { reads.push(String(file)); return read(file, ...args); });
  const scanMock = t.mock.method(fs, "readdirSync", () => { throw new Error("backup enumeration forbidden"); });
  syncBuiltinESMExports();
  try { engine.captureSession(f.session); }
  finally { readMock.mock.restore(); scanMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(captures, 0);
  assert.equal(reads.some((path) => path.includes(rawName("long"))), false);
  for (const id of ["short-0", "short-1", "short-2"]) {
    assert.equal(engine.rawSeen.get(engine.rawKey(f.session, id))?.ok, true);
  }
  assert.equal(engine.rawSeen.has(engine.rawKey(f.session, "long")), false);
});

test("legacy cursor migration, malformed/reset cursors and protected atomic files", (t) => {
  const h = runtime(t);
  const { engine } = h.engine();
  const legacy = join(h.root, "spine-capture.json");
  writeFileSync(legacy, JSON.stringify({ sessions: { old: 17, other: 99 } }));
  assert.equal(engine.readCaptureCursor("old"), 17);
  engine.writeCaptureCursor("old", 20);
  assert.equal(engine.readCaptureCursor("old"), 20);
  assert.equal(engine.readCaptureCursor("other"), 99);
  assert.deepEqual(JSON.parse(readFileSync(legacy, "utf8")).sessions, { old: 17, other: 99 });
  for (const body of ["{", JSON.stringify({ v: 1, key: "wrong", cursor: 7 }), JSON.stringify({ v: 1, key: "old", cursor: -1 })]) {
    writeFileSync(engine.captureCursorFile("old"), body);
    assert.equal(engine.readCaptureCursor("old"), null, "an invalid new cursor must not resurrect stale legacy state");
  }
  engine.writeCaptureCursor("old", 3);
  assert.equal(engine.readCaptureCursor("old"), 3, "reset may move the cursor backwards");
  for (const bad of [NaN, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) engine.writeCaptureCursor("old", bad);
  assert.equal(engine.readCaptureCursor("old"), 3);
  const denied = { platform: "darwin", runner: () => false };
  assert.equal(engine.readCaptureCursor("old", denied), null);
  assert.doesNotThrow(() => engine.writeCaptureCursor("old", 100, denied));
  assert.equal(engine.readCaptureCursor("old"), 3, "permission refusal must retain the last published cursor");
  if (process.platform !== "win32") {
    const dir = sessionDir(h.root, "old");
    chmodSync(engine.captureCursorFile("old"), 0o644);
    assert.equal(engine.readCaptureCursor("old"), 3);
    assert.equal(statSync(engine.captureCursorFile("old")).mode & 0o777, 0o600);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  }
  const failed = engine.captureCursorFile("old");
  const fileMock = t.mock.method(fs, "renameSync", () => { throw Object.assign(new Error("rename denied"), { code: "EACCES" }); });
  syncBuiltinESMExports();
  try { assert.doesNotThrow(() => engine.writeCaptureCursor("old", 4)); }
  finally { fileMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(JSON.parse(readFileSync(failed, "utf8")).cursor, 3);
  assert.equal(readdirSync(sessionDir(h.root, "old")).some((name) => name.endsWith(".tmp")), false);
});

test("stale or malformed cursor limits recapture to the default three results", (t) => {
  const h = runtime(t);
  for (const cursor of [9999, -1, "bad"]) {
    const f = h.use(fixture());
    const { engine } = h.engine();
    mkdirSync(sessionDir(h.root, f.session.id), { recursive: true });
    writeFileSync(engine.captureCursorFile(f.session.id), JSON.stringify({ v: 1, key: f.session.id, cursor }));
    const captured = [];
    const capture = engine.captureOne.bind(engine);
    engine.captureOne = (session, event) => { captured.push(event.data.message.toolCallId); return capture(session, event); };
    engine.captureSession(f.session);
    assert.deepEqual(captured, ["short-0", "short-1", "short-2"]);
    assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long")).ok, false);
    engine.ensurePruneGuard();
    assert.doesNotThrow(() => engine.ctx.get("toolResultPruner").pruneSession(f.session));
    assert.equal(h.pruneCalls, 0);
  }
});

for (const failure of ["file permission", "partial write"]) {
  test(`cursor ${failure} failure closes and removes its temp without replacing the published value`, (t) => {
    const h = runtime(t);
    const { engine } = h.engine();
    const key = "failed-cursor";
    engine.writeCaptureCursor(key, 299);
    let fd;
    const open = fs.openSync;
    const write = fs.writeFileSync;
    const openMock = t.mock.method(fs, "openSync", (...args) => (fd = open(...args)));
    const writeMock = t.mock.method(fs, "writeFileSync", (...args) => {
      write(args[0], "{");
      throw Object.assign(new Error("partial write failed"), { code: "EIO" });
    });
    const access = failure === "file permission" ? { runner: ({ kind }) => kind !== "file" } : {};
    syncBuiltinESMExports();
    try { assert.doesNotThrow(() => engine.writeCaptureCursor(key, 300, access)); }
    finally { openMock.mock.restore(); writeMock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(engine.readCaptureCursor(key), 299);
    assert.equal(Number.isInteger(fd), true);
    assert.throws(() => fs.fstatSync(fd), (error) => error.code === "EBADF");
    assert.deepEqual(readdirSync(sessionDir(h.root, key)), [engine.captureCursorFile(key).split(/[\\/]/).at(-1)]);
  });
}

test("cursor temps inherit the secured Windows session ACL before creation", (t) => {
  const h = runtime(t);
  const { engine } = h.engine();
  const key = "windows-cursor";
  const dir = sessionDir(h.root, key);
  const grants = [];
  const sid = "S-1-5-21-100-200-300-1001";
  const env = { SystemRoot: "D:\\WinX" };
  const access = { platform: "win32", env, execFile(file, args, options) {
    if (file.endsWith("whoami.exe")) return `"DESKTOP","${sid}"`;
    grants.push(windowsAclCall(file, args, options, env, sid));
    return "DSH_SHADOW_ACL_OK";
  } };
  const open = fs.openSync;
  let creates = 0;
  const openMock = t.mock.method(fs, "openSync", (file, flags, mode) => {
    assert.equal(dirname(String(file)), dir);
    assert.deepEqual(grants.map(({ path, kind }) => ({ path, kind })), [
      { path: fs.realpathSync.native(h.root), kind: "dir" }, { path: fs.realpathSync.native(dir), kind: "dir" },
    ], "both directory ACLs must precede temp creation");
    assert.equal(flags, "wx");
    assert.equal(mode, 0o600);
    creates++;
    return open(file, flags, mode);
  });
  syncBuiltinESMExports();
  try {
    engine.writeCaptureCursor(key, 299, access);
    engine.writeCaptureCursor(key, 300, access);
  } finally { openMock.mock.restore(); syncBuiltinESMExports(); }
  assert.equal(creates, 2);
  assert.equal(engine.readCaptureCursor(key, access), 300);
  assert.equal(readdirSync(dir).some((name) => name.endsWith(".tmp")), false);
  assert.deepEqual(h.warnings, []);
});

test("a stale cursor recaptures three results and restores valid older visible backups", async (t) => {
  const h = runtime(t);
  const f = h.use(fixture());
  const first = h.engine().engine;
  h.capture(first, f);
  first.writeCaptureCursor(f.session.id, 9999);
  const { engine, ctx } = h.engine();
  const captured = [];
  const capture = engine.captureOne.bind(engine);
  engine.captureOne = (session, event) => { captured.push(event.data.message.toolCallId); return capture(session, event); };
  engine.ensurePruneGuard();
  ctx.toolResultPruner.pruneSession(f.session);
  assert.deepEqual(captured, ["short-0", "short-1", "short-2"]);
  assert.equal(h.pruneCalls, 1);
  assert.equal(engine.rawSeen.get(engine.rawKey(f.session, "long"))?.ok, true);
  await engine.finishTurn(f.agent());
  assert.equal(f.summaries().length, 1);
});

test("cursor publication persists while another process holds the payload rotation lock", { timeout: 15000 }, async (t) => {
  const h = runtime(t);
  const { engine } = h.engine();
  const key = "cursor-participant";
  engine.writeCaptureCursor(key, 299);
  const dir = sessionDir(h.root, key);
  const payloadDir = sessionDir(h.root, "payload-participant");
  const payload = join(payloadDir, "cut-1-aaaaaaaa.txt");
  const lock = join(h.root, ".spine-rotation.lock");
  const release = join(h.root, "release-holder");
  const shadowURL = new URL("../shadow.js", import.meta.url).href;
  const script = `
    import { existsSync } from 'node:fs';
    import { ensureShadowDir, withShadowRoot, writeShadowFile } from ${JSON.stringify(shadowURL)};
    ensureShadowDir(${JSON.stringify(h.root)});
    withShadowRoot(${JSON.stringify(h.root)}, () => {
      writeShadowFile(${JSON.stringify(payload)}, 'payload stays unchanged');
      process.send('locked');
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10000;
      while (!existsSync(${JSON.stringify(release)})) {
        if (Date.now() > deadline) throw new Error('holder was not released');
        Atomics.wait(wait, 0, 0, 5);
      }
    });
    process.disconnect();`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("..", import.meta.url), env: { SPINE_SHADOW_DIR: h.root }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`payload holder exit ${code}: ${stderr}`)));
  });
  try {
    const ready = new Promise((resolve) => child.once("message", resolve));
    assert.equal(await Promise.race([ready, exited.then(() => assert.fail("holder exited before locking"))]), "locked");
    assert.notEqual(child.pid, process.pid);
    assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, child.pid);
    const snapshot = (file) => {
      const { dev, ino, size, mtimeMs, ctimeMs } = statSync(file);
      return { dev, ino, size, mtimeMs, ctimeMs, body: readFileSync(file, "utf8") };
    };
    const beforeLock = snapshot(lock);
    const beforePayload = snapshot(payload);
    const rootNames = readdirSync(h.root).sort();
    const payloadNames = readdirSync(payloadDir).sort();
    const cursorNames = readdirSync(dir).sort();
    const opens = [];
    const open = fs.openSync;
    const openMock = t.mock.method(fs, "openSync", (file, flags, mode) => {
      opens.push({ file: String(file), flags, mode });
      return open(file, flags, mode);
    });
    const scanMock = t.mock.method(fs, "readdirSync", () => { assert.fail("cursor publication must not scan directories"); });
    syncBuiltinESMExports();
    try { engine.writeCaptureCursor(key, 300); }
    finally { openMock.mock.restore(); scanMock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(engine.readCaptureCursor(key), 300);
    assert.equal(opens.length, 1, "only the cursor temporary file may be opened");
    assert.equal(dirname(opens[0].file), dir);
    assert.ok(opens[0].file.endsWith(".tmp"));
    assert.equal(opens[0].flags, "wx");
    assert.equal(opens[0].mode, 0o600);
    assert.deepEqual(snapshot(lock), beforeLock);
    assert.deepEqual(snapshot(payload), beforePayload);
    assert.deepEqual(readdirSync(h.root).sort(), rootNames);
    assert.deepEqual(readdirSync(payloadDir).sort(), payloadNames);
    assert.deepEqual(readdirSync(dir).sort(), cursorNames);
    assert.deepEqual(h.warnings, []);
  } finally {
    writeFileSync(release, "go");
    await exited;
  }
  assert.equal(existsSync(lock), false, "the holder still releases its own lock");
});

test("two Node processes publish parseable cursors without losing distinct sessions", { timeout: 15000 }, async (t) => {
  const h = runtime(t);
  const { engine } = h.engine();
  const keys = ["cursor.a", "cursora"]; // Same sanitized directory, distinct cursor files.
  const moduleURL = new URL("../index.js", import.meta.url).href;
  const script = `
    import { Context } from '@deepseek-ai/cordis';
    import Spine from ${JSON.stringify(moduleURL)};
    const ctx = new Context(); ctx.logger = { warn() {} };
    const engine = new Spine(ctx.isolate('compaction'), { auto: false });
    process.send('ready');
    process.once('message', async () => {
      for (let i = 1; i <= 300; i++) {
        engine.writeCaptureCursor(process.argv[1], i);
        await new Promise(resolve => setImmediate(resolve));
      }
      await ctx.fiber.dispose(); process.disconnect();
    });`;
  const children = keys.map((key) => spawn(process.execPath, ["--input-type=module", "-e", script, key], {
    cwd: new URL("..", import.meta.url), env: { SPINE_SHADOW_DIR: h.root }, stdio: ["ignore", "ignore", "pipe", "ipc"],
  }));
  t.after(() => { for (const child of children) if (child.exitCode === null) child.kill(); });
  const exits = children.map((child) => new Promise((resolve, reject) => {
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`cursor worker exit ${code}: ${stderr}`)));
  }));
  await Promise.all(children.map((child) => new Promise((resolve) => child.once("message", resolve))));
  for (const child of children) child.send("go");
  let done = false;
  const completion = Promise.all(exits).finally(() => { done = true; });
  let observations = 0;
  while (!done) {
    for (const key of keys) {
      const file = engine.captureCursorFile(key);
      if (!existsSync(file)) continue;
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      assert.equal(parsed.key, key);
      assert.equal(Number.isSafeInteger(parsed.cursor), true);
      observations++;
    }
    await setImmediate();
  }
  await completion;
  assert.ok(observations > 0);
  for (const key of keys) assert.equal(engine.readCaptureCursor(key), 300);
});
