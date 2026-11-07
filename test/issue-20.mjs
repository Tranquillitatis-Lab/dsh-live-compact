import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import test from "node:test";
import Spine from "../index.js";
import { windowsAclCall } from "./helpers/windows-acl.mjs";
import {
  defaultShadowAccessRunner,
  ensureShadowDir,
  resetShadowAccessState,
  shadowAccessFused,
  tightenShadow,
  windowsSystemRoot,
  win32Tool,
  writeShadowFile,
} from "../shadow.js";

const SID = "S-1-5-21-100-200-300-1001";
const ENV = { SystemRoot: "D:\\WinX" };

function tools(env = ENV) {
  return {
    whoami: win32Tool("whoami.exe", env),
    powershell: win32Tool("WindowsPowerShell\\v1.0\\powershell.exe", env),
  };
}

function fakeExec(calls, env = ENV) {
  const { whoami } = tools(env);
  return (file, args, options) => {
    calls.push({ file, args: [...args], options });
    if (file === whoami) return `"DESKTOP-P0","${SID}"`;
    windowsAclCall(file, args, options, env, SID);
    return "DSH_SHADOW_ACL_OK";
  };
}

test("windows root comes from SystemRoot or windir and rejects a non-drive path", () => {
  assert.equal(windowsSystemRoot({ SYSTEMROOT: "D:/WinX/" }), "D:/WinX");
  assert.equal(windowsSystemRoot({ windir: "E:\\Windows" }), "E:\\Windows");
  assert.equal(windowsSystemRoot({ SystemRoot: "Windows" }), "");
  assert.equal(windowsSystemRoot({ SystemRoot: "\\\\srv\\share" }), "");
  assert.equal(windowsSystemRoot({ SystemRoot: "%SystemRoot%" }), "");
  assert.equal(windowsSystemRoot({}), "");
});

test("invalid system root does not spawn and refuses the backup", () => {
  resetShadowAccessState();
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "spine-20-root-"));
  try {
    assert.throws(
      () => ensureShadowDir(dir, {
        platform: "win32",
        env: { SystemRoot: "Windows" },
        execFile(file) {
          calls.push(file);
          return "";
        },
      }),
      (error) => error?.code === "ESHADOWACCESS",
    );
    assert.deepEqual(calls, []);
    assert.equal(shadowAccessFused(), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("a locked directory is granted once and later files do not spawn", () => {
  resetShadowAccessState();
  const calls = [];
  const root = mkdtempSync(join(tmpdir(), "spine-20-lock-"));
  const dir = join(root, "shadow");
  try {
    const access = { platform: "win32", env: ENV, execFile: fakeExec(calls) };
    ensureShadowDir(dir, access);
    ensureShadowDir(dir, access);
    for (let i = 0; i < 8; i += 1) {
      writeShadowFile(join(dir, `raw-${i}.txt`), "secret", access, { exclusive: true });
    }
    writeFileSync(join(dir, "already.txt"), "old");
    writeShadowFile(join(dir, "already.txt"), "new", access);
    assert.equal(calls.filter((call) => call.file === tools().whoami).length, 1);
    assert.equal(calls.filter((call) => call.file === tools().powershell).length, 1);
    assert.equal(calls[1].options.env.DSH_SHADOW_ACL_KIND, "dir");
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("a file DACL is requested separately with no inherited ACEs", () => {
  resetShadowAccessState();
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "spine-20-file-"));
  const file = join(dir, "backup.txt");
  try {
    writeFileSync(file, "");
    defaultShadowAccessRunner({ path: file, kind: "file", platform: "win32", env: ENV, execFile: fakeExec(calls) });
    assert.equal(calls[1].options.env.DSH_SHADOW_ACL_KIND, "file");
    const script = Buffer.from(calls[1].args[4], "base64").toString("utf16le");
    assert.match(script, /\$inheritance = \[Security.AccessControl.InheritanceFlags\]::None/);
    assert.match(script, /if \(\$kind -eq 'dir'\) \{[\s\S]*?ContainerInherit/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("a stale persisted cursor does not recapture the whole log", () => {
  const seen = [];
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map();
  engine.persistCapture = true;
  engine.readCaptureCursor = () => 80;
  engine.writeCaptureCursor = () => {};
  engine.captureOne = (_session, event) => { seen.push(event.seq); };
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({ seq: i, type: "tool/result", data: { message: { toolCallId: `c${i}` } } });
  }
  engine.captureNew({ id: "s" }, events);
  assert.deepEqual(seen, [37, 38, 39]);
});

test("restart does not recapture historical tool results", () => {
  const seen = [];
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.callIndex = new Map();
  engine.captureCursor = new Map();
  engine.captureOne = (_session, event) => { seen.push(event.seq); };
  const events = [];
  for (let i = 0; i < 40; i += 1) {
    events.push({ seq: i, type: "tool/result", data: { message: { toolCallId: `c${i}` } } });
  }
  engine.captureNew({ id: "s" }, events);
  engine.captureNew({ id: "s" }, events);
  assert.deepEqual(seen, [37, 38, 39]);
});

test("replaying many tool results spawns once, not once per result", () => {
  resetShadowAccessState();
  const previous = process.env.SPINE_SHADOW_DIR;
  const dir = mkdtempSync(join(tmpdir(), "spine-20-replay-"));
  process.env.SPINE_SHADOW_DIR = dir;
  const calls = [];
  try {
    const engine = Object.create(Spine.prototype);
    engine.rawSeen = new Map();
    engine.callIndex = new Map();
    engine.ctx = { logger: { warn() {} } };
    const session = { id: "s" };
    const access = { platform: "win32", env: ENV, execFile: fakeExec(calls) };
    for (let i = 0; i < 40; i += 1) {
      const id = `c${i}`;
      engine.noteEvent(session, {
        type: "tool/call",
        data: { turn: 1, callId: id, name: "read", arguments: { file_path: "a.txt" } },
      });
      const record = engine.captureOne(session, {
        type: "tool/result",
        data: { turn: 1, message: { toolCallId: id, content: [{ type: "text", text: "x" }] } },
      }, access);
      assert.equal(record.ok, true);
    }
    assert.equal(calls.filter((call) => call.file === tools().whoami).length, 1);
    assert.equal(calls.filter((call) => call.file === tools().powershell).length, 2);
  } finally {
    if (previous == null) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("a custom runner still tightens each file", () => {
  resetShadowAccessState();
  const kinds = [];
  const root = mkdtempSync(join(tmpdir(), "spine-20-custom-"));
  try {
    const access = {
      platform: "win32",
      runner({ kind }) {
        kinds.push(kind);
        return true;
      },
    };
    ensureShadowDir(root, access);
    ensureShadowDir(root, access);
    writeShadowFile(join(root, "one.txt"), "a", access, { exclusive: true });
    assert.deepEqual(kinds, ["dir", "dir", "dir", "file"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("one permission failure stops later shadow spawns", () => {
  resetShadowAccessState();
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), "spine-20-fuse-"));
  try {
    const access = {
      platform: "win32",
      env: ENV,
      execFile(file) {
        calls.push(file);
        if (file === tools().whoami) return `"DESKTOP-P0","${SID}"`;
        throw Object.assign(new Error("no privilege"), { status: 1300 });
      },
    };
    assert.throws(
      () => ensureShadowDir(dir, access),
      (error) => error?.code === "ESHADOWACCESS",
    );
    assert.throws(
      () => ensureShadowDir(dir, access),
      (error) => error?.code === "ESHADOWACCESS",
    );
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("captureOne refuses a failed backup without throwing", () => {
  resetShadowAccessState();
  const previous = process.env.SPINE_SHADOW_DIR;
  const dir = mkdtempSync(join(tmpdir(), "spine-20-capture-"));
  process.env.SPINE_SHADOW_DIR = dir;
  const warnings = [];
  try {
    const engine = Object.create(Spine.prototype);
    engine.rawSeen = new Map();
    engine.callIndex = new Map();
    engine.ctx = { logger: { warn(message) { warnings.push(message); } } };
    const session = { id: "s" };
    const event = {
      type: "tool/result",
      data: { turn: 1, message: { toolCallId: "c1", content: [{ type: "text", text: "secret" }] } },
    };
    const access = {
      platform: "win32",
      env: ENV,
      execFile(file) {
        if (file === tools().whoami) return `"DESKTOP-P0","${SID}"`;
        throw Object.assign(new Error("no privilege"), { status: 1300 });
      },
    };
    const first = engine.captureOne(session, event, access);
    const second = engine.captureOne(session, event, access);
    assert.equal(first.ok, false);
    assert.equal(second.ok, false);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes("1300"), true);
  } finally {
    if (previous == null) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("a unix permission failure does not fuse later backups", { skip: process.platform === "win32" ? "POSIX chmod mode semantics; Windows ACL has separate gates" : false }, () => {
  resetShadowAccessState();
  const root = mkdtempSync(join(tmpdir(), "spine-20-unix-"));
  try {
    assert.throws(
      () => tightenShadow(join(root, "missing"), "dir", { platform: "darwin" }),
      (error) => error?.code === "ESHADOWACCESS",
    );
    assert.equal(shadowAccessFused(), false);
    const dir = join(root, "ok");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    tightenShadow(dir, "dir", { platform: "darwin" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    ensureShadowDir(join(root, "win"), {
      platform: "win32",
      env: { SystemRoot: "Windows" },
      execFile() { throw new Error("should not spawn"); },
    });
  } catch (error) {
    assert.equal(error?.code, "ESHADOWACCESS");
  } finally {
    const dir = join(root, "after");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    tightenShadow(dir, "dir", { platform: "darwin" });
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(shadowAccessFused(), true);
    rmSync(root, { recursive: true, force: true });
    resetShadowAccessState();
  }
});

test("event and turn hooks catch a shadow failure", () => {
  const source = readFileSync(new URL("../index.js", import.meta.url), "utf8");
  assert.equal(source.includes("noteShadowWarning(ctx.logger, error)"), true);
  assert.equal(source.includes(".catch((error) => noteShadowWarning(this.ctx?.logger, error))"), true);
});
