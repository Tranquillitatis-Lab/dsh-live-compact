import assert from "node:assert/strict";
import fs, {
  existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
  renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Spine from "../index.js";
import { contentHash, rawName, readRawToolResult } from "../raw.js";
import {
  ensureShadowDir, resetShadowAccessState, sessionDir, shadowAccessFused, shadowAccessPlan,
  tightenShadow, win32Tool, writeShadowFile,
} from "../shadow.js";
import { windowsAclCall } from "./helpers/windows-acl.mjs";

const SID = "S-1-5-21-100-200-300-1001";
const ENV = { SystemRoot: "D:\\WinX", Path: "untrusted-path" };

function fixture(t, env = ENV) {
  resetShadowAccessState();
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "spine-acl-")));
  const dir = join(base, "shadow");
  mkdirSync(dir);
  const calls = [];
  const actions = [];
  const access = {
    platform: "win32", env,
    execFile(file, args, options) {
      calls.push({ file, args, options });
      if (file === win32Tool("whoami.exe", env)) return `"DOMAIN\\user","${SID}"\r\n`;
      actions.push(windowsAclCall(file, args, options, env, SID));
      return "DSH_SHADOW_ACL_OK";
    },
  };
  t.after(() => { resetShadowAccessState(); rmSync(base, { recursive: true, force: true }); });
  return { base, dir, calls, actions, access };
}

test("replacement script drops all prior explicit ACEs and checks the whole protected allowlist", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  const { script } = f.actions[0];
  // Structural audit, not a PowerShell interpreter or a native Windows PASS.
  assert.match(script, /\$sids = @\(\$sidText, 'S-1-5-18', 'S-1-5-32-544'\)/);
  assert.match(script, /AccessControlSections\]::Access/g);
  assert.match(script, /\$rules.Count -ne \$expected.Count/);
  assert.match(script, /!\$expected.Remove\(\$rule.IdentityReference.Value\) -or \$rule.IsInherited/);
  for (const field of ["AccessControlType", "FileSystemRights", "InheritanceFlags", "PropagationFlags"]) {
    assert.match(script, new RegExp(`\\$rule\\.${field} -ne`));
  }
  assert.match(script, /FileAttributes\]::ReparsePoint/);
  assert.doesNotMatch(script, /AccessControlSections\]::(?:All|Audit|Owner|Group)/);
  assert.doesNotMatch(script, /\$acl\s*=.*GetAccessControl/);
  assert.match(script, /catch\s*\{[^}]*exit 1/);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).files.includes("shadow.js"), true);
});

test("paths remain environment data and the encoded program stays identical", (t) => {
  const env = { ...ENV, dsh_shadow_acl_path: "stale", DsH_ShAdOw_AcL_sId: "stale" };
  const f = fixture(t, env);
  ensureShadowDir(f.dir, f.access);
  const file = join(f.dir, "quote' ; $(Get-Date) ` Unicode-中.txt");
  writeFileSync(file, "old");
  tightenShadow(file, "file", f.access);
  assert.equal(f.actions[1].path, file);
  assert.equal(f.actions[1].script, f.actions[0].script);
  assert.equal(f.calls[1].args[4], f.calls[2].args[4]);
  assert.equal(f.calls[2].args.some((value) => value.includes(file)), false);
  assert.equal(Object.keys(f.calls[2].options.env).filter((key) => /^dsh_shadow_acl_path$/i.test(key)).length, 1);
  assert.equal(Object.keys(f.calls[2].options.env).filter((key) => /^dsh_shadow_acl_sid$/i.test(key)).length, 1);
});

test("legacy raw and meta files each require replacement even under a confirmed parent; no sweep", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  const toolCallId = "legacy";
  const file = join(f.dir, rawName(toolCallId));
  const text = "synthetic legacy backup";
  writeFileSync(file, text);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId, bytes: Buffer.byteLength(text), sha256: contentHash(text) }));
  const unrelated = join(f.dir, "unrelated.txt");
  writeFileSync(unrelated, "leave alone");
  const result = readRawToolResult({ dir: f.dir, toolCallId, access: f.access });
  assert.equal(result.ok, true);
  assert.deepEqual(f.actions.map(({ path, kind }) => [path, kind]), [[f.dir, "dir"], [file, "file"], [`${file}.meta.json`, "file"]]);
  assert.equal(readRawToolResult({ dir: f.dir, toolCallId, access: f.access }).ok, true);
  assert.equal(f.actions.length, 3);
  assert.equal(readFileSync(unrelated, "utf8"), "leave alone");
});

test("read-only recovery can skip repeated ACL tightening while retaining raw/meta verification", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  f.actions.length = 0;
  const toolCallId = "recovery";
  const file = join(f.dir, rawName(toolCallId));
  const text = "synthetic recovery backup";
  writeFileSync(file, text);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId, bytes: Buffer.byteLength(text), sha256: contentHash(text) }));
  const result = readRawToolResult({ dir: f.dir, toolCallId, access: f.access, tighten: false });
  assert.equal(result.ok, true);
  assert.equal(f.actions.length, 0, "read-only recovery must not spawn per-file ACL work");
  assert.equal(result.sha256, contentHash(text));
});

test("prune revalidation stays read-only after recovery", (t) => {
  const f = fixture(t);
  const previous = process.env.SPINE_SHADOW_DIR;
  process.env.SPINE_SHADOW_DIR = f.dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previous;
  });
  const session = { id: "prune-revalidation" };
  const dir = sessionDir(f.dir, session.id);
  mkdirSync(dir);
  const toolCallId = "prune-revalidation-tool";
  const file = join(dir, rawName(toolCallId));
  const text = "cached raw for prune revalidation";
  writeFileSync(file, text);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId, bytes: Buffer.byteLength(text), sha256: contentHash(text) }));
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map([[`${session.id}\0${toolCallId}`, { ok: true, path: file, bytes: Buffer.byteLength(text), sha256: contentHash(text), toolCallId }]]);
  engine.surfaceToolIds = () => [toolCallId];
  f.actions.length = 0;
  assert.deepEqual([...engine.rawVerifiedSet(session)], [toolCallId]);
  assert.equal(f.actions.length, 0, "prune revalidation must not spawn per-file ACL work");
});

test("recovery entry secures the existing session directory once, not each raw file", (t) => {
  const f = fixture(t);
  const previous = process.env.SPINE_SHADOW_DIR;
  process.env.SPINE_SHADOW_DIR = f.dir;
  t.after(() => {
    if (previous === undefined) delete process.env.SPINE_SHADOW_DIR;
    else process.env.SPINE_SHADOW_DIR = previous;
  });
  const session = { id: "recovery-session" };
  const dir = sessionDir(f.dir, session.id);
  mkdirSync(dir);
  const toolCallId = "recovery-entry";
  const file = join(dir, rawName(toolCallId));
  const text = "existing recovery payload";
  writeFileSync(file, text);
  writeFileSync(`${file}.meta.json`, JSON.stringify({ toolCallId, bytes: Buffer.byteLength(text), sha256: contentHash(text) }));
  const engine = Object.create(Spine.prototype);
  engine.rawSeen = new Map();
  engine.surfaceToolIds = () => [toolCallId];
  engine.recoverVisibleRaw(session, f.access);
  assert.equal(engine.rawSeen.get(`${session.id}\0${toolCallId}`).ok, true);
  assert.deepEqual(f.actions.map(({ kind }) => kind), ["dir"], "recovery should recheck only the session directory ACL");
});

test("fresh exclusive and replacement writes use inherited allowlist without file children or traversal", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  const spy = t.mock.method(fs, "readdirSync", () => assert.fail("backup traversal"));
  syncBuiltinESMExports();
  try {
    const file = join(f.dir, "cut-1-12345678.txt");
    writeShadowFile(file, "first", f.access, { exclusive: true });
    tightenShadow(file, "file", f.access);
    writeShadowFile(file, "replacement", f.access);
    tightenShadow(file, "file", f.access);
    assert.equal(readFileSync(file, "utf8"), "replacement");
    assert.equal(f.calls.length, 2); // one whoami, one directory replacement
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test("a replaced cached file requires its own replacement again", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "raw-1234567812345678.txt");
  writeShadowFile(file, "fresh", f.access, { exclusive: true });
  renameSync(file, join(f.dir, "old.txt")); // Keep old inode allocated.
  writeFileSync(file, "legacy replacement with possible explicit ACEs");
  tightenShadow(file, "file", f.access);
  assert.deepEqual(f.actions.map(({ kind }) => kind), ["dir", "file"]);
});

test("process reset rechecks SID, directory and requested legacy file", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "raw-1234567812345678.txt");
  writeShadowFile(file, "fresh", f.access, { exclusive: true });
  resetShadowAccessState();
  ensureShadowDir(f.dir, f.access);
  tightenShadow(file, "file", f.access);
  assert.equal(f.calls.filter(({ file }) => file === win32Tool("whoami.exe", ENV)).length, 2);
  assert.deepEqual(f.actions.map(({ kind }) => kind), ["dir", "dir", "file"]);
});

for (const sid of ["", "S-2-5-21-1", "S-1-5", "S-1-05-21", "S-1-5-4294967296", "S-1-281474976710656-1", `S-1-5${"-1".repeat(16)}`, `${SID};exit 0`, `${SID}\n`]) {
  test(`invalid SID ${JSON.stringify(sid)} refuses before ACL child and fuses`, (t) => {
    const f = fixture(t);
    assert.throws(() => shadowAccessPlan("win32", sid));
    f.access.execFile = (file) => {
      assert.equal(file, win32Tool("whoami.exe", ENV));
      return `"DOMAIN\\user","${sid}"`;
    };
    assert.throws(() => ensureShadowDir(f.dir, f.access), (error) => error.code === "ESHADOWACCESS" && error.step === "whoami");
    assert.equal(shadowAccessFused(), true);
  });
}

for (const result of ["", "unexpected output", new Error("readback failed"), Object.assign(new Error("timeout"), { code: "ETIMEDOUT", signal: "SIGTERM" })]) {
  test(`missing readback confirmation or child failure fuses all cached paths: ${String(result)}`, (t) => {
    const f = fixture(t);
    ensureShadowDir(f.dir, f.access);
    const file = join(f.dir, "legacy.txt");
    writeFileSync(file, "old");
    let failures = 0;
    f.access.execFile = () => { failures++; if (result instanceof Error) throw result; return result; };
    assert.throws(() => tightenShadow(file, "file", f.access), (error) => error.code === "ESHADOWACCESS");
    assert.equal(shadowAccessFused(), true);
    assert.throws(() => writeShadowFile(join(f.dir, "new.txt"), "secret", f.access), (error) => error.code === "ESHADOWACCESS");
    assert.equal(existsSync(join(f.dir, "new.txt")), false);
    assert.equal(failures, 1);
  });
}

test("cached directory replacement is refused before a child or secret write", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  renameSync(f.dir, join(f.base, "old"));
  mkdirSync(f.dir);
  assert.throws(() => writeShadowFile(join(f.dir, "cut-1-12345678.txt"), "secret", f.access), (error) => error.code === "ESHADOWACCESS");
  assert.equal(f.calls.length, 2);
  assert.equal(shadowAccessFused(), true);
  assert.equal(existsSync(join(f.dir, "cut-1-12345678.txt")), false);
});

test("stable directory aliases share trust; retargeted aliases fail closed", (t) => {
  const f = fixture(t);
  ensureShadowDir(f.dir, f.access);
  const alias = join(f.base, "alias");
  symlinkSync(f.dir, alias, process.platform === "win32" ? "junction" : "dir");
  ensureShadowDir(alias, f.access);
  writeShadowFile(join(alias, "cut-1-12345678.txt"), "synthetic", f.access, { exclusive: true });
  assert.equal(f.calls.length, 2);
  unlinkSync(alias);
  const other = join(f.base, "other");
  mkdirSync(other);
  symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => ensureShadowDir(alias, f.access), (error) => error.code === "ESHADOWACCESS");
  assert.equal(f.calls.length, 2);
});

test("a retargeted parent alias cannot redirect a legacy file correction", (t) => {
  const f = fixture(t);
  const alias = join(f.base, "alias");
  symlinkSync(f.dir, alias, process.platform === "win32" ? "junction" : "dir");
  ensureShadowDir(alias, f.access);
  unlinkSync(alias);
  const other = join(f.base, "other");
  mkdirSync(other);
  const file = join(other, "legacy.txt");
  writeFileSync(file, "outside requested shadow");
  symlinkSync(other, alias, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => tightenShadow(join(alias, "legacy.txt"), "file", f.access), (error) => error.code === "ESHADOWACCESS");
  assert.equal(f.calls.length, 2);
  assert.equal(readFileSync(file, "utf8"), "outside requested shadow");
});

for (const type of ["symlink", "hardlink"]) {
  test(`${type} file cannot redirect an ACL correction outside the shadow`, { skip: type === "symlink" && process.platform === "win32" }, (t) => {
    const f = fixture(t);
    ensureShadowDir(f.dir, f.access);
    const outside = join(f.base, "outside.txt");
    writeFileSync(outside, "outside");
    const file = join(f.dir, "legacy.txt");
    if (type === "symlink") symlinkSync(outside, file);
    else linkSync(outside, file);
    assert.throws(() => tightenShadow(file, "file", f.access), (error) => error.code === "ESHADOWACCESS");
    assert.equal(readFileSync(outside, "utf8"), "outside");
    assert.equal(f.calls.length, 2);
  });
}

test("ACL target replacement during the child is rejected and not cached", (t) => {
  const f = fixture(t);
  const exec = f.access.execFile;
  f.access.execFile = (file, args, options) => {
    const result = exec(file, args, options);
    if (file !== win32Tool("whoami.exe", ENV)) {
      renameSync(f.dir, join(f.base, "old"));
      mkdirSync(f.dir);
    }
    return result;
  };
  assert.throws(() => ensureShadowDir(f.dir, f.access), (error) => error.code === "ESHADOWACCESS");
  assert.equal(shadowAccessFused(), true);
});

test("failure before secret bytes removes the created empty file", (t) => {
  const f = fixture(t);
  const file = join(f.dir, "cut-1-12345678.txt");
  let written = false;
  assert.throws(() => writeShadowFile(file, "secret", { platform: "win32", runner({ kind, path }) {
    if (kind === "file") {
      assert.equal(readFileSync(path).length, 0);
      throw new Error("permission denied");
    }
    return true;
  } }, { write() { written = true; } }), (error) => error.code === "ESHADOWACCESS");
  assert.equal(written, false);
  assert.equal(existsSync(file), false);
});
