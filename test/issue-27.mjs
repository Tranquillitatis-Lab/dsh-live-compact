import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync,
  rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { saveShadow } from "../index.js";
import { shadowSections } from "../plan.js";
import { captureOwnedToolResult, captureToolResult } from "../raw.js";
import { flushDrainStats, listShadowEntries, readCutStats, rotateShadow, shadowFileBody, withShadowRoot, writeShadowFile } from "../shadow.js";

const LOCK = ".spine-rotation.lock";
const OWNER = ".spine-rotation.owner";
const SHARED = ".spine-rotation.shared";
const RECOVERED = ".spine-rotation.recovered";
const workerURL = new URL("./fixtures/issue-27-worker.mjs", import.meta.url);

function fixture(t) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "spine-27-")));
  const dir = join(base, "shadow");
  mkdirSync(dir);
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const calls = { readdir: [], stat: [], unlink: [] };
  const io = {
    readdir(...args) { calls.readdir.push(args[0]); return readdirSync(...args); },
    stat(path) { calls.stat.push(path); return statSync(path); },
    unlink(path) { calls.unlink.push(path); unlinkSync(path); },
  };
  return { base, dir, calls, io, ordinal: 0 };
}

function configure(t, f, optIn = true, cap = 1000) {
  const values = { DSH_HOME: join(f.base, "home"), SPINE_SHADOW_DIR: f.dir,
    SPINE_SHADOW_SINGLE_PROCESS: optIn ? "1" : undefined, SPINE_SHADOW_MAX_BYTES: String(cap) };
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

function rotation(f, incomingBytes = 0, extra = {}) {
  return rotateShadow({ dir: f.dir, cap: 1000, incomingBytes, ...f.io, ...extra });
}

function backup(f, bytes, { key = "mine", kind = "cut", access = {}, required = true, protectPaths = [] } = {}) {
  const message = { role: "user", content: "x" };
  const overhead = Buffer.byteLength(shadowFileBody(key, shadowSections(message))) - 1;
  message.content = "x".repeat(bytes - overhead);
  const file = join(f.dir, key, `${kind}-${++f.ordinal}-aaaaaaaa.txt`);
  const logs = [];
  const warnings = [];
  saveShadow.call({
    ctx: { logger: { info: (line) => logs.push(line) } },
    warnShadowFull: (...args) => warnings.push(args),
    warnShadowOversize: (...args) => warnings.push(args),
  }, [message], required, file, key, protectPaths, access, f.io);
  return { file, logs, warnings };
}

function plant(f, name, bytes, age = 1) {
  const file = join(f.dir, name);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, "a".repeat(bytes));
  utimesSync(file, age, age);
  return file;
}

function alias(f) {
  const path = join(f.base, "alias");
  symlinkSync(f.dir, path, process.platform === "win32" ? "junction" : "dir");
  return path;
}

function holder(pid = process.pid, id = "a".repeat(48)) {
  return `${JSON.stringify({ v: 1, pid, id })}\n`;
}

function withFsMock(t, name, implementation, action) {
  const mock = t.mock.method(fs, name, implementation(fs[name]));
  syncBuiltinESMExports();
  try { return action(); } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
}

test("lock publication exposes a complete private record with PID and a unique transaction identity", (t) => {
  const f = fixture(t);
  configure(t, f);
  const records = [];
  withFsMock(t, "linkSync", (link) => (source, target) => {
    assert.equal(existsSync(target), false);
    const text = readFileSync(source, "utf8");
    const record = JSON.parse(text);
    assert.equal(record.pid, process.pid);
    assert.match(record.id, /^[0-9a-f]{48}$/);
    assert.equal(text, holder(record.pid, record.id));
    if (process.platform !== "win32") assert.equal(statSync(source).mode & 0o777, 0o600);
    link(source, target);
    assert.equal(readFileSync(target, "utf8"), text);
    records.push(record);
  }, () => {
    for (let i = 0; i < 2; i++) withShadowRoot(f.dir, () => {
      assert.equal(JSON.parse(readFileSync(join(f.dir, LOCK), "utf8")).pid, process.pid);
    });
  });
  assert.equal(records.length, 2);
  assert.notEqual(records[0].id, records[1].id);
  assert.equal(existsSync(join(f.dir, LOCK)), false);
  assert.equal(readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
});

test("failed record flush never publishes a partial lock or runs the action", (t) => {
  const f = fixture(t);
  configure(t, f);
  withFsMock(t, "fsyncSync", () => () => { throw Object.assign(new Error("flush failed"), { code: "EIO" }); }, () => {
    assert.throws(() => withShadowRoot(f.dir, () => assert.fail("unpublished holder admitted")), (error) => error.code === "ESHADOWBUSY");
  });
  assert.equal(existsSync(join(f.dir, LOCK)), false);
  assert.equal(readdirSync(f.dir).some((name) => name.endsWith(".tmp")), false);
});

test("temp cleanup failure after publication retains ownership, releases the lock and permits the next rotation/write", (t) => {
  const f = fixture(t);
  configure(t, f);
  let failed = false;
  withFsMock(t, "unlinkSync", (unlink) => (file) => {
    if (!failed && String(file).startsWith(join(f.dir, LOCK)) && String(file).endsWith(".tmp")) {
      failed = true;
      throw Object.assign(new Error("temporary cleanup denied"), { code: "EACCES" });
    }
    return unlink(file);
  }, () => {
    assert.equal(rotation(f).ok, true);
    assert.equal(failed, true);
    assert.equal(existsSync(join(f.dir, LOCK)), false);
    assert.equal(statSync(backup(f, 120).file).size, 120);
    assert.equal(rotation(f).used, 120);
  });
  assert.equal(existsSync(join(f.dir, LOCK)), false);
});

test("temp cleanup cannot transfer ownership to a replacement lock or cause its removal", (t) => {
  const f = fixture(t);
  configure(t, f);
  const lock = join(f.dir, LOCK);
  const replacement = holder(process.pid, "b".repeat(48));
  withFsMock(t, "unlinkSync", (unlink) => (file) => {
    if (String(file).startsWith(lock) && String(file).endsWith(".tmp")) {
      renameSync(lock, join(f.base, "original-lock"));
      writeFileSync(lock, replacement);
      throw Object.assign(new Error("temporary cleanup denied"), { code: "EACCES" });
    }
    return unlink(file);
  }, () => {
    assert.throws(() => withShadowRoot(f.dir, () => assert.fail("replacement admitted")), (error) => error.code === "ESHADOWBUSY");
  });
  assert.equal(readFileSync(lock, "utf8"), replacement);
});

for (const optIn of [false, true]) {
  test(`one post-publication verification EIO releases only its owned lock (opt-in ${optIn})`, (t) => {
    const f = fixture(t);
    configure(t, f, optIn);
    const lock = join(f.dir, LOCK);
    const failure = Object.assign(new Error("injected verification read failure"), { code: "EIO" });
    let pending = false;
    let failed = false;
    withFsMock(t, "linkSync", (link) => (source, target) => {
      link(source, target);
      if (target === lock && !failed) pending = true;
    }, () => withFsMock(t, "readSync", (read) => (...args) => {
      if (pending) {
        pending = false;
        failed = true;
        throw failure;
      }
      return read(...args);
    }, () => {
      assert.throws(() => withShadowRoot(f.dir, () => assert.fail("failed validation admitted")),
        (error) => error.code === "ESHADOWBUSY" && error.cause === failure);
      assert.equal(failed, true);
      assert.equal(existsSync(lock), false, "failed acquisition leaked its live-PID lock");
      assert.equal(rotation(f).ok, true);
      assert.equal(statSync(backup(f, 120).file).size, 120);
      assert.equal(rotation(f).used, 120);
    }));
  });

  test(`one final-release verification EIO releases only its owned lock (opt-in ${optIn})`, (t) => {
    const f = fixture(t);
    configure(t, f, optIn);
    const failure = Object.assign(new Error("injected release verification failure"), { code: "EIO" });
    let pending = false;
    withFsMock(t, "readSync", (read) => (...args) => {
      if (pending) {
        pending = false;
        throw failure;
      }
      return read(...args);
    }, () => {
      assert.throws(() => withShadowRoot(f.dir, () => { pending = true; }),
        (error) => error.code === "ESHADOWBUSY" && error.cause === failure);
      assert.equal(existsSync(join(f.dir, LOCK)), false, "failed release leaked its live-PID lock");
      assert.equal(rotation(f).ok, true);
      assert.equal(statSync(backup(f, 120).file).size, 120);
    });
  });
}

for (const stage of ["acquisition", "release"]) for (const change of ["inode", "record", "malformed", "unreadable", "root"]) {
  test(`failed ${stage} preserves a ${change} replacement or unverifiable guard`, (t) => {
    const f = fixture(t);
    configure(t, f);
    const lock = join(f.dir, LOCK);
    const old = join(f.base, "original");
    const failure = Object.assign(new Error("injected verification read failure"), { code: "EIO" });
    let pending = false;
    let failed = false;
    let expected;
    let expectedInode;
    let replacementBlocked = false;
    withFsMock(t, "linkSync", (link) => (source, target) => {
      link(source, target);
      if (target === lock && stage === "acquisition") pending = true;
    }, () => withFsMock(t, "readSync", (read) => (...args) => {
      if (pending) {
        pending = false;
        failed = true;
        expected = readFileSync(lock, "utf8");
        if (change === "inode") {
          renameSync(lock, old);
          writeFileSync(lock, expected); // Same bytes/PID/token, different object.
        } else if (change === "record" || change === "malformed") {
          expected = change === "record" ? holder(process.pid, "b".repeat(48)) : "unverifiable";
          writeFileSync(lock, expected); // Same inode, different record.
        } else if (change === "root") {
          try { renameSync(f.dir, old); } catch (error) {
            // Windows may deny moving a directory containing the open guard.
            // In that branch verify cleanup of the unchanged owned lock below.
            assert.equal(process.platform, "win32");
            assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error.code));
            replacementBlocked = true;
          }
          if (!replacementBlocked) {
            mkdirSync(f.dir);
            fs.linkSync(join(old, LOCK), lock); // Even the exact record cannot waive root identity.
          }
        }
        expectedInode = statSync(lock).ino;
        throw failure;
      }
      if (failed && change === "unreadable") throw failure;
      return read(...args);
    }, () => {
      assert.throws(() => withShadowRoot(f.dir, () => {
        if (stage === "acquisition") assert.fail("failed validation admitted");
        pending = true;
      }),
        (error) => error.code === "ESHADOWBUSY" && error.cause === failure);
    }));
    assert.equal(failed, true);
    if (replacementBlocked) {
      assert.equal(existsSync(old), false);
      assert.equal(statSync(f.dir).isDirectory(), true);
      assert.equal(existsSync(lock), false, "unchanged owned guard must be cleaned after read failure");
      assert.equal(rotation(f).ok, true, "OS-blocked replacement must not strand the root");
      return;
    }
    assert.equal(readFileSync(lock, "utf8"), expected);
    assert.equal(statSync(lock).ino, expectedInode);
    if (change === "root") assert.equal(existsSync(join(old, LOCK)), true);
    assert.throws(() => rotation(f), (error) => error.code === "ESHADOWBUSY");
  });
}

for (const [kind, code] of [["default", "ENOTSUP"], ["shared", "EOPNOTSUPP"], ["dedicated", "ENOSYS"]]) {
  test(`${kind} root with link ${code} uses durable shared full scans and real raw/cut/official writes`, (t) => {
    const f = fixture(t);
    if (kind === "default") {
      f.dir = join(f.base, "home", "compaction-spine", "shadow");
      mkdirSync(f.dir, { recursive: true });
    }
    configure(t, f, kind === "dedicated");
    if (kind === "default") delete process.env.SPINE_SHADOW_DIR;
    plant(f, "cut-1-11111111.txt", 600);
    withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("hardlinks unsupported"), { code }); }, () => {
      for (let i = 0; i < 2; i++) assert.equal(rotation(f).estimated, undefined);
      const raw = captureOwnedToolResult({ dir: join(f.dir, "B"), root: f.dir, toolCallId: "B", text: "b".repeat(320) });
      assert.equal(raw.ok, true);
      assert.equal(readFileSync(raw.path, "utf8"), "b".repeat(320));
      assert.equal(JSON.parse(readFileSync(`${raw.path}.meta.json`, "utf8")).bytes, 320);
      assert.equal(statSync(backup(f, 120).file).size, 120);
      assert.equal(rotation(f).used, 440);
      assert.equal(statSync(backup(f, 120, { kind: "official" }).file).size, 120);
      assert.equal(rotation(f).used, 560);
    });
    assert.equal(existsSync(join(f.dir, SHARED)), true);
    assert.equal(existsSync(join(f.dir, OWNER)), false);
    assert.equal(existsSync(join(f.dir, LOCK)), false);
    assert.equal(rotation(f).estimated, undefined, "restored hardlinks must not restore exclusive estimates");
  });
}

for (const code of ["EPERM", "EACCES", "EIO", "EXDEV", "EINVAL"]) {
  test(`link ${code} is ambiguous and never bypasses coordination`, (t) => {
    const f = fixture(t);
    configure(t, f, false);
    withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("link failed"), { code }); }, () => {
      assert.throws(() => withShadowRoot(f.dir, () => assert.fail("ambiguous link error admitted")), (error) => error.code === "ESHADOWBUSY");
    });
  });
}

test("ENOTSUP from a record flush is not proof of unsupported hardlinks", (t) => {
  const f = fixture(t);
  configure(t, f, false);
  withFsMock(t, "fsyncSync", () => () => { throw Object.assign(new Error("flush unsupported"), { code: "ENOTSUP" }); }, () => {
    assert.throws(() => withShadowRoot(f.dir, () => assert.fail("unflushed record admitted")), (error) => error.code === "ESHADOWBUSY");
  });
});

for (const kind of ["live", "EPERM", "EACCES", "unknown PID", "directory", "malformed", "unreadable"]) {
  test(`unsupported links still refuse ${kind} holders after persisting the shared fence`, (t) => {
    const f = fixture(t);
    configure(t, f);
    const lock = join(f.dir, LOCK);
    if (kind === "directory") mkdirSync(lock);
    else writeFileSync(lock, kind === "malformed" ? "{" : holder());
    if (["EPERM", "EACCES", "unknown PID"].includes(kind)) t.mock.method(process, "kill", () => {
      throw Object.assign(new Error("death unknown"), { code: kind === "unknown PID" ? undefined : kind });
    });
    withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); }, () => {
      withFsMock(t, "openSync", (open) => (file, ...args) => {
        if (kind === "unreadable" && String(file) === lock) throw Object.assign(new Error("holder unreadable"), { code: "EACCES" });
        return open(file, ...args);
      }, () => {
        assert.throws(() => withShadowRoot(f.dir, () => assert.fail("possible exclusive holder bypassed")), (error) => error.code === "ESHADOWBUSY");
      });
    });
    assert.equal(existsSync(lock), true);
    assert.equal(existsSync(join(f.dir, SHARED)), true);
    assert.equal(existsSync(join(f.dir, RECOVERED)), false);
  });
}

for (const stage of ["flush denied", ...(process.platform === "win32" ? [] : ["directory flush denied"]), "holder appears", "fence replaced"]) {
  test(`unsupported-link fallback checks its durable fence before action: ${stage}`, (t) => {
    const f = fixture(t);
    configure(t, f);
    withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); }, () => {
      withFsMock(t, "fsyncSync", (sync) => (fd) => {
        const shared = join(f.dir, SHARED);
        if (stage === "directory flush denied" && fs.fstatSync(fd).isDirectory()) throw new Error("directory flush failed");
        if (existsSync(shared) && statSync(shared).ino === fs.fstatSync(fd).ino) {
          if (stage === "flush denied") throw new Error("shared fence flush failed");
          if (stage === "holder appears") writeFileSync(join(f.dir, LOCK), holder());
          if (stage === "fence replaced") {
            renameSync(shared, join(f.base, "original-fence"));
            writeFileSync(shared, "");
          }
        }
        return sync(fd);
      }, () => {
        assert.throws(() => withShadowRoot(f.dir, () => assert.fail("unsafe fallback action")), (error) => error.code === "ESHADOWBUSY");
      });
    });
  });
}

test("unsupported links recover a proven-dead exact token durably, retain its lock and tolerate later PID reuse", (t) => {
  const f = fixture(t);
  configure(t, f);
  const lock = join(f.dir, LOCK);
  const text = holder();
  writeFileSync(lock, text);
  const inode = statSync(lock).ino;
  withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); }, () => {
    const probe = t.mock.method(process, "kill", () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
    assert.equal(rotation(f).estimated, undefined);
    probe.mock.restore();
    assert.equal(statSync(backup(f, 120).file).size, 120);
    assert.equal(rotation(f).used, 120);
  });
  assert.equal(readFileSync(lock, "utf8"), text);
  assert.equal(statSync(lock).ino, inode);
  assert.equal(rotation(f).estimated, undefined, "hardlink-capable participants also recognize the recovered token");
});

test("unsupported-link fallback preserves a transaction appearing after admission and refuses its own write", (t) => {
  const f = fixture(t);
  configure(t, f);
  const lock = join(f.dir, LOCK);
  withFsMock(t, "linkSync", () => () => { throw Object.assign(new Error("no hardlinks"), { code: "ENOTSUP" }); }, () => {
    assert.throws(() => withShadowRoot(f.dir, () => {
      writeFileSync(lock, holder());
      writeShadowFile(join(f.dir, "cut-1-11111111.txt"), "refused", {}, { root: f.dir });
    }), (error) => error.code === "ESHADOWBUSY");
  });
  assert.equal(readFileSync(lock, "utf8"), holder());
  assert.equal(existsSync(join(f.dir, "cut-1-11111111.txt")), false);
});

for (const kind of ["old directory", "empty", "truncated", "oversized", "invalid PID", "extra field", "live or reused PID"]) {
  test(`${kind} lock fails closed regardless of age; metadata reads are bounded`, (t) => {
    const f = fixture(t);
    configure(t, f);
    rotation(f); // A former estimate must be retired on contention.
    const lock = join(f.dir, LOCK);
    if (kind === "old directory") mkdirSync(lock);
    else writeFileSync(lock, {
      empty: "", truncated: '{"v":1,"pid":', oversized: "x".repeat(4096),
      "invalid PID": holder(-1), "extra field": holder().trimEnd().replace("}", ',"other":true}') + "\n",
      "live or reused PID": holder(),
    }[kind]);
    utimesSync(lock, 1, 1);
    const before = statSync(lock).ino;
    withFsMock(t, "readSync", (read) => (...args) => {
      assert.ok(args[3] <= 257, "coordination read must be bounded");
      return read(...args);
    }, () => {
      for (let i = 0; i < 2; i++) {
        assert.throws(() => rotation(f), (error) => error.code === "ESHADOWBUSY");
        assert.throws(() => backup(f, 120), (error) => error.code === "ESHADOWBUSY");
      }
    });
    assert.equal(statSync(lock).ino, before);
    assert.equal(existsSync(join(f.dir, RECOVERED)), false);
    assert.equal(listShadowEntries(f.dir).length, 0);
  });
}

for (const code of ["EPERM", "EACCES", undefined]) {
  test(`PID probe ${code || "unknown error"} is not proof of death`, (t) => {
    const f = fixture(t);
    configure(t, f);
    const text = holder();
    writeFileSync(join(f.dir, LOCK), text);
    t.mock.method(process, "kill", () => { throw Object.assign(new Error("probe denied"), { code }); });
    assert.throws(() => rotation(f), (error) => error.code === "ESHADOWBUSY");
    assert.throws(() => backup(f, 120), (error) => error.code === "ESHADOWBUSY");
    assert.equal(readFileSync(join(f.dir, LOCK), "utf8"), text);
    assert.equal(existsSync(join(f.dir, RECOVERED)), false);
    assert.equal(listShadowEntries(f.dir).length, 0);
  });
}

test("a lock replaced during the death probe is preserved and never admitted or recovered", (t) => {
  const f = fixture(t);
  configure(t, f);
  const lock = join(f.dir, LOCK);
  writeFileSync(lock, holder());
  const replacement = holder(process.pid, "b".repeat(48));
  t.mock.method(process, "kill", () => {
    renameSync(lock, join(f.base, "observed-lock"));
    writeFileSync(lock, replacement);
    throw Object.assign(new Error("old holder died"), { code: "ESRCH" });
  });
  assert.throws(() => rotation(f), (error) => error.code === "ESHADOWBUSY");
  assert.equal(readFileSync(lock, "utf8"), replacement);
  assert.equal(existsSync(join(f.dir, RECOVERED)), false);
});

test("recovery requires a durable shared marker and cannot proceed after its flush fails", (t) => {
  const f = fixture(t);
  configure(t, f);
  writeFileSync(join(f.dir, LOCK), holder());
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
  withFsMock(t, "fsyncSync", (sync) => (fd) => {
    if (statSync(join(f.dir, SHARED)).ino === fs.fstatSync(fd).ino) throw new Error("shared flush failed");
    return sync(fd);
  }, () => {
    // Avoid intercepting the attempt's private candidate flush before SHARED
    // exists; pre-existing shared roots need the same durability check.
    writeFileSync(join(f.dir, SHARED), "");
    assert.throws(() => withShadowRoot(f.dir, () => assert.fail("unflushed recovery admitted")), (error) => error.code === "ESHADOWBUSY");
  });
  assert.equal(existsSync(join(f.dir, RECOVERED)), false);
  assert.equal(readFileSync(join(f.dir, LOCK), "utf8"), holder());
});

test("a recovered fence stays shared across module instances and later PID reuse; other live identities remain closed", async (t) => {
  const f = fixture(t);
  configure(t, f);
  const lock = join(f.dir, LOCK);
  writeFileSync(lock, holder());
  const probe = t.mock.method(process, "kill", () => { throw Object.assign(new Error("dead"), { code: "ESRCH" }); });
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(readFileSync(join(f.dir, RECOVERED), "utf8"), holder());
  probe.mock.restore(); // The PID is now live, but the exact old token is proven dead.
  const duplicate = await import(`../shadow.js?recovered=${Date.now()}`);
  for (let i = 0; i < 2; i++) {
    assert.equal(duplicate.rotateShadow({ dir: f.dir, incomingBytes: 0, cap: 1000 }).estimated, undefined);
    assert.equal(statSync(backup(f, 120).file).size, 120);
  }
  renameSync(lock, join(f.base, "dead-fence"));
  writeFileSync(lock, holder(process.pid, "b".repeat(48)));
  assert.throws(() => rotation(f), (error) => error.code === "ESHADOWBUSY");
  assert.equal(readFileSync(lock, "utf8"), holder(process.pid, "b".repeat(48)));
});

test("default DSH_HOME roots, explicit default aliases and undeclared roots always scan; old writers remain visible", (t) => {
  const f = fixture(t);
  configure(t, f, false);
  for (let i = 0; i < 2; i++) assert.equal(rotation(f).estimated, undefined);
  assert.equal(f.calls.readdir.length, 2);
  assert.equal(existsSync(join(f.dir, OWNER)), false);
  // A non-cooperating legacy writer is safe on the unoptimized shared path.
  plant(f, "cut-1-11111111.txt", 600);
  assert.equal(rotation(f).used, 600);
  plant(f, "cut-2-22222222.txt", 320);
  const result = rotation(f, 120);
  assert.equal(result.used, 320);
  assert.equal(result.freed, 600);
  assert.equal(result.used + 120, 440);

  process.env.DSH_HOME = f.base;
  const normal = join(f.base, "compaction-spine", "shadow");
  mkdirSync(normal, { recursive: true });
  process.env.SPINE_SHADOW_SINGLE_PROCESS = "1";
  delete process.env.SPINE_SHADOW_DIR;
  const normalFixture = { ...f, dir: normal };
  const beforeProfiles = f.calls.readdir.length;
  backup(normalFixture, 80, { key: "profile-a" });
  backup(normalFixture, 80, { key: "profile-b" });
  assert.equal(f.calls.readdir.length - beforeProfiles, 5); // root+a, then root+a+b
  assert.equal(rotation(f, 0, { dir: normal }).estimated, undefined);
  assert.equal(rotation(f, 0, { dir: normal }).estimated, undefined);
  const normalAlias = join(f.base, "default-alias");
  symlinkSync(normal, normalAlias, process.platform === "win32" ? "junction" : "dir");
  process.env.SPINE_SHADOW_DIR = normalAlias;
  assert.equal(rotation(f, 0, { dir: normalAlias }).estimated, undefined);
  assert.equal(rotation(f, 0, { dir: normalAlias }).estimated, undefined);
  assert.equal(existsSync(join(normal, OWNER)), false);
});

test("dedicated first scan calibrates; second is estimated; 80 percent, cap and directory changes scan", (t) => {
  const f = fixture(t);
  configure(t, f);
  const file = plant(f, "cut-1-11111111.txt", 600);
  assert.equal(rotation(f, 100).used, 600);
  assert.equal(rotation(f, 100).estimated, true);
  assert.deepEqual(f.calls.readdir, [f.dir]);
  assert.deepEqual(f.calls.stat, [file]);
  assert.equal(rotation(f, 200).estimated, undefined); // exactly 80%, not just over cap
  assert.equal(rotation(f, 1, { cap: 1100 }).estimated, undefined);
  assert.equal(f.calls.readdir.length, 3);
  const other = fixture(t);
  plant(other, "cut-1-11111111.txt", 700);
  process.env.SPINE_SHADOW_DIR = other.dir;
  assert.equal(rotation(other).used, 700);
  assert.equal(rotation(other).estimated, true);
  process.env.SPINE_SHADOW_DIR = f.dir;
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(f.calls.readdir.length, 4);
});

test("exclusive estimates expire at 60000 without renewal by fast returns or actual saves", (t) => {
  const f = fixture(t);
  configure(t, f, true, 5000);
  let tick = 0;
  f.io.now = () => tick;
  rotation(f, 0, { cap: 5000 });
  const scans = f.calls.readdir.length;
  for (let i = 0; i < 8; i++) {
    tick = 50000 + i * 1000;
    backup(f, 80, { kind: i % 2 ? "cut" : "official" });
  }
  tick = 59999;
  assert.equal(rotation(f, 0, { cap: 5000 }).estimated, true);
  assert.equal(f.calls.readdir.length, scans);
  tick = 60000;
  const expired = rotation(f, 0, { cap: 5000 });
  assert.equal(expired.estimated, undefined);
  assert.equal(expired.used, 640);
  assert.ok(f.calls.readdir.length > scans);
  tick = 119999;
  assert.equal(rotation(f, 0, { cap: 5000 }).estimated, true);
  tick = 120000;
  assert.equal(rotation(f, 0, { cap: 5000 }).estimated, undefined);
});

test("calibration lifetime starts when its successful scan completes", (t) => {
  const f = fixture(t);
  configure(t, f);
  let tick = 0;
  const read = f.io.readdir;
  f.io.now = () => tick;
  f.io.readdir = (...args) => { tick += 5000; return read(...args); };
  rotation(f);
  assert.equal(tick, 5000);
  tick = 64999;
  assert.equal(rotation(f).estimated, true);
  tick = 65000;
  assert.equal(rotation(f).estimated, undefined);
});

test("rollback since the last fast observation retires the estimate even after its calibration time", (t) => {
  const f = fixture(t);
  configure(t, f);
  let tick = 0;
  f.io.now = () => tick;
  rotation(f);
  tick = 59000;
  assert.equal(rotation(f).estimated, true);
  tick = 58000;
  assert.equal(rotation(f).estimated, undefined);
  tick = 58001;
  assert.equal(rotation(f).estimated, undefined, "a rollback scan must not publish a fresh lifetime");
  tick = 58002;
  assert.equal(rotation(f).estimated, true);
});

for (const bad of [NaN, Infinity, -1, "throw"]) {
  test(`invalid monotonic clock ${String(bad)} scans without seeding an estimate`, (t) => {
    const f = fixture(t);
    configure(t, f);
    let tick = 0;
    f.io.now = () => { if (tick === "throw") throw new Error("clock unavailable"); return tick; };
    rotation(f);
    tick = bad;
    assert.equal(rotation(f).estimated, undefined);
    assert.equal(rotation(f).estimated, undefined);
    tick = 1000;
    assert.equal(rotation(f).estimated, undefined);
    tick = 1001;
    assert.equal(rotation(f).estimated, true);
  });
}

test("clock failure at calibration completion does not publish a lifetime", (t) => {
  const f = fixture(t);
  configure(t, f);
  let values = [0, NaN];
  f.io.now = () => values.length ? values.shift() : 1000;
  rotation(f);
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(rotation(f).estimated, true);
});

test("expired failed calibration and partial deletion failure cannot refresh a fast path", (t) => {
  const f = fixture(t);
  configure(t, f);
  let tick = 0;
  f.io.now = () => tick;
  rotation(f);
  tick = 60000;
  const failed = rotation(f, 0, { readdir() { throw new Error("scan denied"); } });
  assert.equal(failed.ok, false);
  tick++;
  assert.equal(rotation(f).estimated, undefined);
  const first = plant(f, "cut-1-11111111.txt", 900, 1);
  const last = plant(f, "cut-2-22222222.txt", 100, 2);
  const refused = rotation(f, 1000, { unlink(path) {
    if (path === last) throw new Error("unlink denied");
    return f.io.unlink(path);
  } });
  assert.equal(refused.failed, true);
  assert.equal(existsSync(first), false);
  assert.equal(statSync(last).size, 100);
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(rotation(f).estimated, true);
});

test("shared roots keep full scans regardless of clock validity or elapsed lifetime", (t) => {
  const f = fixture(t);
  configure(t, f, false);
  for (const tick of [0, 1, 60000, NaN]) {
    assert.equal(rotation(f, 0, { now: () => tick }).estimated, undefined);
  }
  assert.equal(f.calls.readdir.length, 4);
});

test("eight actual cut/official saves below 80 percent do no backup readdir/stat after calibration and charge once", (t) => {
  const f = fixture(t);
  configure(t, f, true, 5000);
  const first = backup(f, 80);
  assert.equal(statSync(first.file).size, 80);
  const scans = f.calls.readdir.length;
  const stats = f.calls.stat.length;
  for (let index = 0; index < 8; index++) {
    const result = backup(f, 80, { kind: index % 2 ? "official" : "cut" });
    assert.equal(statSync(result.file).size, 80);
    assert.deepEqual(result.logs, []);
  }
  assert.equal(f.calls.readdir.length - scans, 0);
  assert.equal(f.calls.stat.length - stats, 0);
  const current = rotation(f, 0, { cap: 5000 });
  assert.equal(current.estimated, true);
  assert.equal(current.used, 720);
  assert.equal(listShadowEntries(f.dir).reduce((sum, file) => sum + file.size, 0), 720);
  if (process.platform !== "win32") {
    assert.equal(statSync(first.file).mode & 0o777, 0o600);
    assert.equal(statSync(f.dir).mode & 0o777, 0o700);
  }
});

for (const optIn of [false, true]) {
  test(`real raw burst after calibration rotates 200 x 20KiB at a 2MiB cap (${optIn ? "dedicated" : "shared"})`, (t) => {
    const f = fixture(t);
    const cap = 2 * 1024 * 1024;
    configure(t, f, optIn, cap);
    f.io.now = () => 0;
    assert.equal(rotation(f, 0, { cap }).used, 0);
    const scans = f.calls.readdir.length;
    const records = [];
    for (let i = 0; i < 200; i++) {
      const result = captureOwnedToolResult({ dir: join(f.dir, "mine"), root: f.dir,
        toolCallId: `burst-${i}`, text: "x".repeat(20 * 1024) });
      assert.equal(result.ok, true);
      records.push(result.path);
    }
    const stats = join(f.dir, "spine-stats.json");
    writeShadowFile(stats, "{}\n", {}, { root: f.dir });
    assert.equal(f.calls.readdir.length, scans, "raw capture does not itself call capacity rotation");
    assert.equal(records.reduce((sum, file) => sum + statSync(file).size, 0), 4096000);
    assert.ok(records.reduce((sum, file) => sum + statSync(`${file}.meta.json`).size, 0) > 0);
    assert.ok(statSync(join(f.dir, "mine", "owner")).size > 0);
    assert.ok(statSync(stats).size > 0);
    const rotated = rotation(f, 0, { cap, sessionKey: "mine" });
    assert.equal(rotated.estimated, undefined);
    assert.equal(rotated.ok, true);
    assert.equal(rotated.deleted, 119);
    assert.equal(rotated.used, 1658880);
    assert.ok(f.calls.readdir.length > scans);
    const remaining = records.filter(file => existsSync(file));
    assert.equal(remaining.reduce((sum, file) => sum + statSync(file).size, 0), 1658880);
    for (const file of records.filter(file => !existsSync(file))) {
      assert.equal(existsSync(`${file}.meta.json`), false);
      assert.ok(f.calls.unlink.includes(`${file}.meta.json`));
    }
    assert.equal(existsSync(stats), true, "ancillary files stay outside payload quota and deletion");
  });
}

test("80 percent waterline and cap equality do not trigger premature deletion", (t) => {
  const f = fixture(t);
  configure(t, f);
  f.io.now = () => 0;
  const file = plant(f, "cut-1-11111111.txt", 600);
  rotation(f);
  assert.equal(rotation(f, 199).estimated, true);
  assert.equal(rotation(f, 200).estimated, undefined);
  assert.equal(rotation(f, 400).deleted, 0);
  assert.equal(statSync(file).size, 600);
  const over = rotation(f, 401);
  assert.equal(over.ok, true);
  assert.equal(over.deleted, 1);
  assert.equal(over.freed, 600);
});

test("a missing raw body still attempts its exact paired metadata cleanup once", (t) => {
  const f = fixture(t);
  configure(t, f);
  const file = plant(f, "raw-1111111111111111.txt", 900);
  writeFileSync(`${file}.meta.json`, "{}");
  const result = rotation(f, 200, { unlink(path) {
    if (path === file) {
      f.io.unlink(path);
      throw Object.assign(new Error("already removed"), { code: "ENOENT" });
    }
    return f.io.unlink(path);
  } });
  assert.equal(result.ok, true);
  assert.equal(result.deleted, 1);
  assert.equal(result.freed, 900);
  assert.equal(result.used, 0);
  assert.equal(existsSync(`${file}.meta.json`), false);
  assert.deepEqual(f.calls.unlink, [file, `${file}.meta.json`]);
});

test("UTF-8, Buffer, raw, owner and metadata scopes, overwrite and partial failures are conservatively charged once", (t) => {
  const f = fixture(t);
  configure(t, f);
  assert.equal(rotation(f).used, 0);
  const file = join(f.dir, "cut-1-11111111.txt");
  writeShadowFile(file, "界".repeat(8), {}, { root: f.dir }); // 24
  writeShadowFile(file, Buffer.from("界".repeat(4)), {}, { root: f.dir }); // +12, do not subtract overwrite
  const raw = captureOwnedToolResult({ dir: join(f.dir, "mine"), root: f.dir, toolCallId: "raw", text: "界".repeat(12) });
  assert.equal(raw.ok, true); // +36, no owner/meta charge
  assert.equal(captureToolResult({ dir: join(f.dir, "mine"), root: f.dir, toolCallId: "raw", text: "ignored" }).existed, true);
  assert.equal(rotation(f).used, 72);
  assert.equal(f.calls.readdir.length, 1);
  const failure = join(f.dir, "official-2-22222222.txt");
  assert.throws(() => writeShadowFile(failure, "界".repeat(10), {}, {
    root: f.dir,
    write(fd, body) { writeFileSync(fd, body.slice(0, 1)); throw Object.assign(new Error("partial"), { code: "ENOSPC" }); },
  }), /partial/);
  assert.equal(existsSync(failure), false);
  assert.equal(rotation(f).used, 102); // failed write still charged all 30
  assert.throws(() => writeShadowFile(failure, Buffer.alloc(20), {}, {
    root: f.dir,
    write(fd, body) { writeFileSync(fd, body.subarray(0, 2)); throw new Error("partial again"); },
    unlink() { throw new Error("cleanup denied"); },
  }), /cleanup failed/);
  assert.equal(statSync(failure).size, 2);
  assert.equal(rotation(f).used, 122);
  // Only a full scan can correct overcounting, including external deletions.
  unlinkSync(file);
  const recalibrated = rotation(f, 678);
  assert.equal(recalibrated.estimated, undefined);
  assert.equal(recalibrated.used, 38);
});

test("metadata write failure retains the raw byte charge after successful cleanup", (t) => {
  const f = fixture(t);
  configure(t, f);
  rotation(f);
  assert.throws(() => captureToolResult({ dir: join(f.dir, "mine"), root: f.dir,
    toolCallId: "meta-failure", text: "界".repeat(10), access: { runner({ kind, path }) {
      if (kind === "file" && path.endsWith(".meta.json")) return false;
      return true;
    } },
  }), (error) => error.code === "ESHADOWACCESS");
  assert.equal(listShadowEntries(f.dir).length, 0);
  const current = rotation(f);
  assert.equal(current.estimated, true);
  assert.equal(current.used, 30);
});

test("a normal raw helper infers its configured root before the session directory exists", (t) => {
  const f = fixture(t);
  configure(t, f);
  const dir = join(f.dir, "new-session");
  assert.equal(existsSync(dir), false);
  const raw = captureOwnedToolResult({ dir, toolCallId: "first-raw", text: "界".repeat(10) });
  assert.equal(raw.ok, true);
  assert.equal(existsSync(join(f.dir, OWNER)), true);
  assert.equal(existsSync(join(dir, OWNER)), false);
  assert.equal(rotation(f).used, 30);
  assert.equal(rotation(f).estimated, true);
});

for (const optIn of [false, true]) for (const failedPart of ["root readdir", "session readdir", "root stat", "session stat"]) {
  test(`incomplete ${failedPart} refuses admission and never seeds an estimate (${optIn ? "dedicated" : "shared"})`, (t) => {
    const f = fixture(t);
    configure(t, f, optIn);
    const file = plant(f, failedPart === "root stat" ? "cut-1-11111111.txt" : "dead/cut-1-11111111.txt", 900);
    const bad = failedPart.endsWith("stat") ? { stat(path) {
      if (path === file) throw new Error("EACCES");
      return f.io.stat(path);
    } } : {
      readdir(path, options) {
        if ((failedPart === "root readdir" && path === f.dir) || (failedPart === "session readdir" && path !== f.dir)) throw new Error("EACCES");
        return f.io.readdir(path, options);
      },
    };
    for (const incoming of [0, 200, 1100]) {
      const failed = rotation(f, incoming, bad);
      assert.equal(failed.ok, false, "an unreadable payload cannot establish capacity, including the oversize exception");
      assert.equal(failed.failed, true);
      assert.equal(failed.reason, "scan-incomplete");
      assert.equal(failed.estimated, undefined);
      assert.equal(failed.deleted, 0);
      assert.equal(failed.freed, 0);
      assert.equal(statSync(file).size, 900);
      assert.deepEqual(f.calls.unlink, [], "partial scans must not start deleting");
    }
    const retry = rotation(f, 200);
    assert.equal(retry.estimated, undefined);
    assert.equal(retry.ok, true);
    assert.equal(retry.freed, 900);
    assert.deepEqual(f.calls.unlink, [file]);
  });
}

for (const optIn of [false, true]) for (const failedPart of ["root readdir", "session readdir", "root stat", "session stat"]) {
  test(`failed capacity scan ${failedPart} prevents real required and optional 900 + 200 saves (${optIn ? "dedicated" : "shared"})`, (t) => {
    const f = fixture(t);
    configure(t, f, optIn);
    const old = plant(f, failedPart === "root stat" ? "cut-9-11111111.txt" : "dead/cut-9-11111111.txt", 900);
    const originalIO = { ...f.io };
    f.io.stat = (path) => {
      if (failedPart.endsWith("stat") && path === old) throw Object.assign(new Error("unreadable backup"), { code: "EACCES" });
      return originalIO.stat(path);
    };
    f.io.readdir = (path, options) => {
      if ((failedPart === "root readdir" && path === f.dir) || (failedPart === "session readdir" && path === join(f.dir, "dead"))) {
        throw Object.assign(new Error("unreadable directory"), { code: "EACCES" });
      }
      return originalIO.readdir(path, options);
    };
    assert.throws(() => backup(f, 200), (error) => error.code === "ESHADOWSCAN");
    assert.equal(existsSync(join(f.dir, "mine", "cut-1-aaaaaaaa.txt")), false);
    const optional = backup(f, 200, { required: false, kind: "official" });
    assert.equal(existsSync(optional.file), false);
    assert.equal(listShadowEntries(f.dir).reduce((sum, file) => sum + file.size, 0), 900);
    assert.deepEqual(f.calls.unlink, []);
    Object.assign(f.io, originalIO);
    const healthy = backup(f, 200);
    assert.equal(statSync(healthy.file).size, 200);
    assert.equal(existsSync(old), false);
    assert.equal(rotation(f).used, 200);
  });
}

test("invalid incoming, cap and observed sizes never authorize deletion or backup", (t) => {
  const f = fixture(t);
  configure(t, f);
  const file = plant(f, "cut-1-11111111.txt", 900);
  const cases = [
    ...[NaN, Infinity, -1, 0.5].map(incomingBytes => ({ incomingBytes })),
    ...[NaN, Infinity, 0, -1, Number.MAX_SAFE_INTEGER + 1].map(cap => ({ cap })),
    { stat(path) { const info = statSync(path); info.size = NaN; return info; } },
  ];
  for (const extra of cases) {
    const { incomingBytes = 200, ...options } = extra;
    const result = rotation(f, incomingBytes, options);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid-measurement");
    assert.equal(result.deleted, 0);
    assert.equal(statSync(file).size, 900);
  }
  assert.deepEqual(f.calls.unlink, []);
});

for (const code of ["EPERM", "EACCES", "EIO"]) {
  test(`session owner PID ${code} is protected; only ESRCH proves death`, (t) => {
    const f = fixture(t);
    configure(t, f);
    const file = plant(f, "other/cut-1-11111111.txt", 900);
    const owner = join(f.dir, "other", "owner");
    writeFileSync(owner, "424242");
    let status = code;
    const kill = process.kill;
    t.mock.method(process, "kill", (pid, signal) => {
      if (pid === 424242) throw Object.assign(new Error(status), { code: status });
      return kill(pid, signal);
    });
    let reads = 0;
    withFsMock(t, "readFileSync", (read) => (path, ...args) => {
      if (String(path) === owner) reads++;
      return read(path, ...args);
    }, () => {
      const refused = rotation(f, 200, { sessionKey: "mine" });
      assert.equal(refused.ok, false);
      assert.equal(statSync(file).size, 900);
      assert.deepEqual(f.calls.unlink, []);
      assert.equal(reads, 1, "read owner once to avoid inconsistent classifications");
      status = "ESRCH";
      assert.equal(rotation(f, 200, { sessionKey: "mine" }).ok, true);
      assert.equal(existsSync(file), false);
    });
  });
}

for (const kind of ["unreadable", "empty", "malformed", "negative", "exponent"]) {
  test(`an ${kind} session owner is not evidence of a dead session`, (t) => {
    const f = fixture(t);
    configure(t, f);
    const file = plant(f, "other/cut-1-11111111.txt", 900);
    const owner = join(f.dir, "other", "owner");
    const text = { unreadable: "424242", empty: "", malformed: "unknown", negative: "-1", exponent: "1e3" }[kind];
    writeFileSync(owner, text);
    withFsMock(t, "readFileSync", (read) => (path, ...args) => {
      if (kind === "unreadable" && String(path) === owner) throw Object.assign(new Error("owner denied"), { code: "EACCES" });
      return read(path, ...args);
    }, () => {
      assert.equal(rotation(f, 200, { sessionKey: "mine", alive: () => false }).ok, false);
      assert.equal(statSync(file).size, 900);
      assert.deepEqual(f.calls.unlink, []);
    });
  });
}

test("unknown custom liveness and genuinely missing owners have distinct deletion behavior", (t) => {
  const f = fixture(t);
  configure(t, f);
  const file = plant(f, "other/cut-1-11111111.txt", 900);
  const owner = join(f.dir, "other", "owner");
  writeFileSync(owner, "424242");
  assert.equal(rotation(f, 200, { sessionKey: "mine", alive() { throw new Error("unknown status"); } }).ok, false);
  assert.equal(statSync(file).size, 900);
  unlinkSync(owner);
  assert.equal(rotation(f, 200, { sessionKey: "mine" }).ok, true);
  assert.equal(existsSync(file), false);
});

for (const optIn of [false, true]) {
  for (const kind of ["other-live", "mine", "other-dead"]) {
    test(`raw body cannot override directory ownership: ${kind}, ${optIn ? "dedicated" : "shared"}`, (t) => {
      const f = fixture(t);
      configure(t, f, optIn);
      const key = kind === "mine" ? "mine" : "other";
      const marker = kind === "mine" ? "other" : "mine";
      const first = `# spine-session ${marker}\n`;
      const raw = captureOwnedToolResult({ dir: join(f.dir, key), root: f.dir,
        toolCallId: "body-is-data", text: first + "x".repeat(900 - Buffer.byteLength(first)) });
      assert.equal(raw.ok, true);
      const result = rotation(f, 200, { sessionKey: "mine", alive: () => kind !== "other-dead" });
      const protectedOther = kind === "other-live";
      assert.equal(result.ok, !protectedOther);
      assert.equal(result.deleted, protectedOther ? 0 : 1);
      assert.equal(existsSync(raw.path), protectedOther);
      assert.equal(existsSync(`${raw.path}.meta.json`), protectedOther);
      if (protectedOther) {
        assert.equal(readFileSync(raw.path, "utf8"), first + "x".repeat(900 - Buffer.byteLength(first)));
        assert.deepEqual(f.calls.unlink, []);
        assert.throws(() => backup(f, 200), /backup is full; leaving the span/);
        assert.equal(existsSync(raw.path), true);
        assert.equal(existsSync(`${raw.path}.meta.json`), true);
      }
    });
  }
}

test("original removal order, both protection forms, live owners, raw metadata and unrelated files are preserved", (t) => {
  const f = fixture(t);
  configure(t, f);
  const legacy = plant(f, "cut-1-11111111.txt", 150, 3);
  const dead = plant(f, "dead/raw-1111111111111111.txt", 200, 2);
  const mine = plant(f, "mine/cut-1-22222222.txt", 250, 1);
  const keeper = plant(f, "mine/cut-2-33333333.txt", 100);
  const cited = plant(f, "mine/cut-3-44444444.txt", 100);
  const live = plant(f, "live/cut-1-55555555.txt", 200);
  writeFileSync(join(f.dir, "live", "owner"), "4242");
  writeFileSync(`${dead}.meta.json`, "{}");
  const unrelated = join(f.dir, "notes.txt");
  writeFileSync(unrelated, "unrelated");
  const aliasRoot = alias(f);
  const result = rotation(f, 350, { sessionKey: "mine", protectPath: keeper,
    protectPaths: [join(aliasRoot, "mine", "cut-3-44444444.txt")], alive: (pid) => pid === 4242 });
  assert.deepEqual(result, { ok: true, deleted: 3, freed: 600, used: 400, cap: 1000, oversize: false, failed: false });
  assert.deepEqual(f.calls.unlink, [legacy, dead, `${dead}.meta.json`, mine]);
  for (const file of [keeper, cited, live, unrelated]) assert.equal(existsSync(file), true);
  assert.equal(rotation(f, 100).estimated, true);
  assert.equal(rotation(f, 650, { sessionKey: "other", protectPath: keeper, protectPaths: [cited], alive: (pid) => pid === 4242 }).ok, false);
});

test("ENOENT is freed; unlink failure fails including oversize; oversize exception keeps protected bodies", (t) => {
  const f = fixture(t);
  configure(t, f);
  const gone = plant(f, "cut-1-11111111.txt", 400);
  const keep = plant(f, "cut-2-22222222.txt", 400, 2);
  const result = rotation(f, 300, { unlink(path) {
    assert.equal(path, gone);
    unlinkSync(path);
    throw Object.assign(new Error("gone"), { code: "ENOENT" });
  } });
  assert.deepEqual(result, { ok: true, deleted: 1, freed: 400, used: 400, cap: 1000, oversize: false, failed: false });
  const blocked = rotation(f, 1100, { unlink() { throw new Error("EPERM"); } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.failed, true);
  assert.equal(blocked.oversize, true);
  assert.equal(rotation(f).estimated, undefined);
  const huge = rotation(f, 1100, { protectPath: keep });
  assert.equal(huge.ok, true);
  assert.equal(huge.oversize, true);
  assert.equal(huge.used, 400);
  assert.deepEqual(f.calls.unlink, []);
});

test("rotation log uses post-deletion plus incoming bytes; cut stats/log files stay outside capacity", (t) => {
  const f = fixture(t);
  configure(t, f);
  plant(f, "cut-1-11111111.txt", 900);
  const result = backup(f, 120);
  assert.deepEqual(result.logs, ["spine: shadow 轮换 删除 1 个文件，腾出 900 字节，用量 120/1000"]);
  flushDrainStats(f.dir, [{ kind: "cut", saved: 50, afterPrefix: 25 }], { sid: "s" });
  assert.equal(readCutStats(f.dir).savedTokens, 50);
  assert.equal(readCutStats(f.dir).rewriteTokens, 25);
  assert.equal(readCutStats(f.dir).cuts, 1);
  assert.equal(readFileSync(join(f.dir, "spine-cuts.jsonl"), "utf8").trim().split("\n").length, 1);
  assert.equal(rotation(f).used, 120);
});

test("save refuses a protected full root, preserves originals and keeps the existing oversize warning/exception", (t) => {
  const f = fixture(t);
  configure(t, f);
  const live = plant(f, "live/cut-1-11111111.txt", 900);
  writeFileSync(join(f.dir, "live", "owner"), String(process.pid));
  const skipped = backup(f, 120, { required: false });
  assert.equal(existsSync(skipped.file), false);
  assert.deepEqual(skipped.warnings, [["mine", f.dir, 900, 1000]]);
  assert.equal(statSync(live).size, 900);
  assert.throws(() => backup(f, 120), /backup is full; leaving the span/);
  const huge = backup(f, 1100);
  assert.equal(statSync(huge.file).size, 1100);
  assert.deepEqual(huge.warnings, [["mine", 1000]]);
  assert.equal(statSync(live).size, 900);
});

test("raw metadata unlink failure stays outside cap and does not change successful rotation counters", (t) => {
  const f = fixture(t);
  configure(t, f);
  const raw = plant(f, "raw-1111111111111111.txt", 900);
  writeFileSync(`${raw}.meta.json`, "{}");
  const result = rotation(f, 200, { unlink(path) {
    f.calls.unlink.push(path);
    if (path.endsWith(".meta.json")) throw new Error("metadata locked");
    unlinkSync(path);
  } });
  assert.deepEqual(result, { ok: true, deleted: 1, freed: 900, used: 0, cap: 1000, oversize: false, failed: false });
  assert.deepEqual(f.calls.unlink, [raw, `${raw}.meta.json`]);
  assert.equal(rotation(f).estimated, true);
  assert.equal(rotation(f).used, 0);
});

test("canonical aliases share a lease; replacement at the same path and retargeted aliases recalibrate", (t) => {
  const f = fixture(t);
  configure(t, f);
  plant(f, "cut-1-11111111.txt", 120);
  rotation(f);
  const linked = alias(f);
  process.env.SPINE_SHADOW_DIR = linked;
  assert.equal(rotation(f, 0, { dir: linked }).estimated, true);
  renameSync(f.dir, join(f.base, "old"));
  mkdirSync(f.dir);
  plant(f, "cut-2-22222222.txt", 900);
  const changed = rotation(f, 200, { dir: linked });
  assert.equal(changed.estimated, undefined);
  assert.equal(changed.freed, 900);
  const other = fixture(t);
  plant(other, "cut-1-11111111.txt", 600);
  unlinkSync(linked);
  symlinkSync(other.dir, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal(rotation(f, 0, { dir: linked }).used, 600);
  assert.equal(rotation(f, 0, { dir: linked }).estimated, true);
});

test("different module instances, unknown ownership and no-opt-in participants permanently retire estimates", async (t) => {
  const f = fixture(t);
  configure(t, f);
  rotation(f);
  const duplicate = await import(`../shadow.js?issue27=${Date.now()}`);
  duplicate.writeShadowFile(join(f.dir, "raw-1111111111111111.txt"), "abc", {}, { root: f.dir });
  assert.equal(existsSync(join(f.dir, SHARED)), true);
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(rotation(f).estimated, undefined);
  const unknown = fixture(t);
  process.env.SPINE_SHADOW_DIR = unknown.dir;
  writeFileSync(join(unknown.dir, OWNER), "unknown-pid-or-partial-marker");
  assert.equal(rotation(unknown).estimated, undefined);
  assert.equal(rotation(unknown).estimated, undefined);
  assert.equal(existsSync(join(unknown.dir, SHARED)), true);
  const noOptIn = fixture(t);
  process.env.SPINE_SHADOW_DIR = noOptIn.dir;
  rotation(noOptIn);
  delete process.env.SPINE_SHADOW_SINGLE_PROCESS;
  writeShadowFile(join(noOptIn.dir, "cut-1-11111111.txt"), "x", {}, { root: noOptIn.dir });
  process.env.SPINE_SHADOW_SINGLE_PROCESS = "1";
  assert.equal(rotation(noOptIn).estimated, undefined);
});

test("directory replacement during a failed body write cannot unlink a replacement file or release another lock", (t) => {
  const f = fixture(t);
  configure(t, f);
  rotation(f);
  const file = join(f.dir, "cut-1-11111111.txt");
  const old = join(f.base, "old");
  let replacementBlocked = false;
  assert.throws(() => writeShadowFile(file, "private payload", { runner({ kind }) {
    if (kind === "file") {
      try { renameSync(f.dir, old); } catch (error) {
        assert.equal(process.platform, "win32");
        assert.ok(["EPERM", "EACCES", "EBUSY"].includes(error.code));
        replacementBlocked = true;
        throw error;
      }
      mkdirSync(f.dir);
      writeFileSync(file, "replacement");
      mkdirSync(join(f.dir, LOCK));
    }
    return true;
  } }, { root: f.dir }), (error) => replacementBlocked
    ? error.code === "ESHADOWACCESS" && ["EPERM", "EACCES", "EBUSY"].includes(error.cause?.code)
    : error.code === "ESHADOWBUSY");
  if (replacementBlocked) {
    assert.equal(existsSync(old), false);
    assert.equal(existsSync(file), false, "failed initial body must be removed from the unchanged root");
    assert.equal(existsSync(join(f.dir, LOCK)), false);
    assert.equal(statSync(backup(f, 120).file).size, 120);
    return;
  }
  assert.equal(readFileSync(file, "utf8"), "replacement");
  assert.equal(existsSync(join(f.dir, LOCK)), true);
  assert.equal(existsSync(join(old, LOCK)), true);
  assert.equal(readFileSync(join(old, "cut-1-11111111.txt"), "utf8"), "");
});

// Each child has a persistent inbox, so no barrier event can be lost while the
// parent awaits a different process. Timeouts are deadlock guards, not metrics.
function child(t, root, optIn, defaultRoot = false) {
  const proc = fork(workerURL, [JSON.stringify({ root, optIn, defaultRoot })], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const inbox = [];
  const waiters = [];
  let stderr = "";
  proc.stderr.on("data", (data) => { stderr += data; });
  proc.on("message", (message) => {
    const index = waiters.findIndex((waiter) => waiter.event === message.event && (!waiter.command || waiter.command === message.command));
    if (index < 0) inbox.push(message); else waiters.splice(index, 1)[0].resolve(message);
  });
  const exit = once(proc, "exit");
  t.after(async () => { if (proc.exitCode === null && proc.signalCode === null) proc.kill(); await exit; assert.equal(stderr, ""); });
  const take = (event, command) => {
    const index = inbox.findIndex((message) => message.event === event && (!command || command === message.command));
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve) => waiters.push({ event, command, resolve }));
  };
  return { proc, exit, take, async request(command, args = {}) {
    proc.send({ command, ...args });
    return take("result", command);
  } };
}

for (const useAlias of [false, true]) {
  test(`two OS processes with late raw writer${useAlias ? " via alias" : ""}: 600 + 320 + 120 finishes at 440`, { timeout: 15000 }, async (t) => {
    const f = fixture(t);
    configure(t, f);
    const a = child(t, f.dir, true);
    const b = child(t, useAlias ? alias(f) : f.dir, false);
    const readyA = await a.take("ready");
    const readyB = await b.take("ready");
    assert.notEqual(readyA.pid, readyB.pid);
    const calibrated = await a.request("calibrate");
    assert.equal(calibrated.result.used, 600);
    assert.equal(calibrated.result.estimated, undefined);
    const raw = await b.request("raw");
    assert.equal(raw.result.ok, true);
    assert.equal(raw.result.bytes, 320);
    const saved = await a.request("save");
    assert.equal(saved.error, undefined);
    assert.equal(saved.result.bytes, 120);
    assert.deepEqual(saved.result.logs, ["spine: shadow 轮换 删除 1 个文件，腾出 600 字节，用量 440/1000"]);
    const state = await a.request("inspect");
    assert.equal(state.result.rotation.estimated, undefined);
    assert.equal(state.result.bytes, 440);
    assert.equal(state.result.rotation.used, 440);
    assert.equal(existsSync(join(f.dir, SHARED)), true);
    b.proc.send({ command: "exit" });
    await b.exit;
    assert.equal((await a.request("inspect")).result.rotation.estimated, undefined);
  });
}

test("OS process arriving between capacity admission and body write is denied; next rotation scans", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  configure(t, f);
  const a = child(t, f.dir, true);
  const b = child(t, alias(f), false);
  await a.take("ready");
  await b.take("ready");
  await a.request("calibrate");
  const barrier = join(f.base, "release");
  const saving = a.request("save", { barrier });
  await a.take("admitted");
  assert.equal(existsSync(join(f.dir, LOCK)), true);
  const holder = JSON.parse(readFileSync(join(f.dir, LOCK), "utf8"));
  assert.equal(holder.pid, a.proc.pid);
  assert.match(holder.id, /^[0-9a-f]{48}$/);
  utimesSync(join(f.dir, LOCK), 1, 1); // A paused live holder never expires.
  const blocked = await b.request("raw");
  assert.equal(blocked.error.code, "ESHADOWBUSY");
  assert.equal((await b.request("inspect")).error.code, "ESHADOWBUSY");
  assert.equal(existsSync(join(f.dir, RECOVERED)), false);
  assert.equal(listShadowEntries(f.dir).filter((file) => file.name.startsWith("raw-")).length, 0);
  writeFileSync(barrier, "go");
  assert.equal((await saving).result.bytes, 120);
  const state = await a.request("inspect");
  assert.equal(state.result.rotation.estimated, undefined);
  assert.equal(state.result.bytes, 720);
  assert.equal((await b.request("raw")).result.ok, true);
});

test("worker with the same PID participates before writing and disables the parent's estimate", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  configure(t, f);
  rotation(f);
  const worker = new Worker(workerURL, { workerData: { root: alias(f), optIn: true } });
  const exited = once(worker, "exit");
  t.after(() => worker.terminate());
  const [message] = await once(worker, "message");
  assert.equal(message.pid, process.pid);
  assert.equal(message.result.bytes, 320);
  assert.equal((await exited)[0], 0);
  assert.equal(rotation(f).estimated, undefined);
  assert.equal(existsSync(join(f.dir, SHARED)), true);
});

for (const kind of ["default", "shared", "dedicated"]) {
  test(`SIGKILL in ${kind} root leaves a fence: two full rotations and real backups proceed without deletion`, { timeout: 15000 }, async (t) => {
    const f = fixture(t);
    if (kind === "default") {
      f.dir = join(f.base, "home", "compaction-spine", "shadow");
      mkdirSync(f.dir, { recursive: true });
    }
    configure(t, f, kind === "dedicated");
    if (kind === "default") delete process.env.SPINE_SHADOW_DIR;
    const a = child(t, f.dir, kind === "dedicated", kind === "default");
    await a.take("ready");
    assert.equal((await a.request("calibrate")).result.used, 600);
    a.proc.send({ command: "crash" });
    const [exitCode, signal] = await a.exit;
    if (process.platform === "win32") {
      assert.equal(signal, null, "Windows reports force-termination through the exit code");
      assert.ok(Number.isInteger(exitCode) && exitCode !== 0);
    } else assert.equal(signal, "SIGKILL");
    assert.throws(() => process.kill(a.proc.pid, 0), (error) => error.code === "ESRCH");
    const lock = join(f.dir, LOCK);
    const fence = readFileSync(lock, "utf8");
    const inode = statSync(lock).ino;
    assert.equal(JSON.parse(fence).pid, a.proc.pid);
    utimesSync(join(f.dir, "cut-1-11111111.txt"), 1, 1);
    plant(f, "cut-2-22222222.txt", 320, 2);
    for (let i = 0; i < 2; i++) {
      const scans = f.calls.readdir.length;
      const result = rotation(f, 120);
      assert.equal(result.estimated, undefined);
      assert.equal(result.ok, true);
      assert.ok(f.calls.readdir.length > scans);
      assert.equal(result.used, i === 0 ? 320 : 440);
      if (i === 0) assert.equal(result.freed, 600);
      const beforeBackup = f.calls.readdir.length;
      const saved = backup(f, 120);
      assert.equal(statSync(saved.file).size, 120);
      assert.ok(readFileSync(saved.file, "utf8").startsWith("# spine-session mine\n"));
      assert.ok(f.calls.readdir.length > beforeBackup);
      assert.equal(readFileSync(lock, "utf8"), fence);
      assert.equal(statSync(lock).ino, inode);
      assert.equal(existsSync(join(f.dir, SHARED)), true);
      assert.equal(readFileSync(join(f.dir, RECOVERED), "utf8"), fence);
    }
    const raw = captureToolResult({ dir: join(f.dir, "mine"), root: f.dir, toolCallId: "after-crash", text: "after crash" });
    assert.equal(raw.ok, true);
    assert.equal(readFileSync(raw.path, "utf8"), "after crash");
    const b = child(t, f.dir, true, kind === "default");
    await b.take("ready");
    const state = await b.request("inspect");
    assert.equal(state.error, undefined);
    assert.equal(state.result.rotation.estimated, undefined);
    assert.equal(state.result.rotation.used, 571);
    assert.equal((await b.request("save")).result.bytes, 120);
    assert.equal(statSync(lock).ino, inode);
  });
}

test("clean restart reclaims a dead owner after one bounded recalibration", { timeout: 15000 }, async (t) => {
  const f = fixture(t);
  configure(t, f);
  const a = child(t, f.dir, true);
  await a.take("ready");
  await a.request("calibrate");
  a.proc.send({ command: "exit" });
  assert.equal((await a.exit)[0], 0);
  assert.equal(existsSync(join(f.dir, LOCK)), false);
  const first = rotation(f);
  assert.equal(first.used, 600);
  assert.equal(first.estimated, undefined);
  assert.equal(rotation(f).estimated, true);
  assert.equal(existsSync(join(f.dir, SHARED)), false);
});

test("explicit root rejects files outside its counted scope and does not charge a different root", (t) => {
  const f = fixture(t);
  const other = fixture(t);
  configure(t, f);
  rotation(f);
  assert.throws(() => writeShadowFile(join(other.dir, "cut-1-11111111.txt"), "private", {}, { root: f.dir }), (error) => error.code === "ESHADOWBUSY");
  assert.equal(listShadowEntries(other.dir).length, 0);
  writeShadowFile(join(other.dir, "cut-1-11111111.txt"), "private", {}, { root: other.dir });
  const recalibrated = rotation(f);
  assert.equal(recalibrated.estimated, undefined);
  assert.equal(recalibrated.used, 0);
  assert.throws(() => withShadowRoot(f.dir, () => withShadowRoot(other.dir, () => {})), (error) => error.code === "ESHADOWBUSY");
});
