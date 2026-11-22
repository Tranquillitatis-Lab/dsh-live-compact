// 锁表硬上界守护测试：断言 shadow.js 的 lockedDirs / lockedFiles 任何时刻
// 不超过 MAX_LOCK_ENTRIES（4096），并覆盖两个释放点：
//   ① staging 临时名在发布（rename）后释放（writeShadowFileLocked 收尾处 releaseLockedFile(target)）；
//   ② rotation 删除分片后释放该分片与其 .meta.json 的锁表条目（rotateShadow 清理循环）。
// 模块私有的锁表通过 module.registerHooks 在加载 shadow.js 时附加一个测试导出来读取，
// 不修改被测源码；test/equivalence/baseline-src 下的基线副本不做注入，保持原样。
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, before, test } from "node:test";

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    const clean = String(url).replace(/\\/g, "/");
    if (clean.endsWith("/shadow.js") && !clean.includes("/baseline-src/")) {
      let source = result.source;
      if (typeof source !== "string") source = Buffer.from(source).toString("utf8");
      source += "\n;export const __lockTestHooks = { lockedDirs, lockedFiles, MAX_LOCK_ENTRIES, rememberLockedEntry, releaseLockedFile };\n";
      result.source = source;
    }
    return result;
  },
});

const shadow = await import("../shadow.js");
const hooks = shadow.__lockTestHooks;
assert.ok(hooks, "锁表测试注入失败：shadow.js 已在本进程被无钩子加载");
const { lockedDirs, lockedFiles, MAX_LOCK_ENTRIES, rememberLockedEntry, releaseLockedFile } = hooks;

// 与 shadow.js releaseLockedFile 的 canonical 规则一致：真实父目录 + 文件名。
const canonicalKey = (path) => join(realpathSync.native(dirname(path)), basename(path));

let root = "";
const sessionKey = "session-lock-bound";
const sessionDirPath = () => join(root, sessionKey);

before(() => {
  root = mkdtempSync(join(tmpdir(), "spine-lock-bound-"));
});

after(() => {
  shadow.resetShadowAccessState();
  if (root) rmSync(root, { recursive: true, force: true });
});

function save(file, body, cap) {
  return shadow.saveShadowTransaction({ shadow: root, file, body, sessionKey, cap });
}

test("MAX_LOCK_ENTRIES 硬上界为 4096", () => {
  assert.equal(MAX_LOCK_ENTRIES, 4096);
});

test("rememberLockedEntry 超界按插入序淘汰，重复 set 不增长", () => {
  const scratch = new Map();
  const total = MAX_LOCK_ENTRIES + 128;
  for (let i = 0; i < total; i++) {
    rememberLockedEntry(scratch, `entry-${i}`, { canonical: `entry-${i}` });
    assert.ok(scratch.size <= MAX_LOCK_ENTRIES, `size=${scratch.size} 超过上界`);
  }
  assert.equal(scratch.size, MAX_LOCK_ENTRIES);
  assert.equal(scratch.has("entry-0"), false, "最旧条目应被淘汰");
  assert.ok(scratch.has(`entry-${total - 1}`), "最新条目应保留");
  // 对已存在键重复 set：不改变插入位置，也不触发淘汰
  const victim = `entry-${total - 1}`;
  rememberLockedEntry(scratch, victim, { canonical: victim });
  assert.equal(scratch.size, MAX_LOCK_ENTRIES);
  assert.ok(scratch.has(victim));
});

test("源码契约：插入只经 rememberLockedEntry，两个释放点存在", () => {
  const source = readFileSync(new URL("../shadow.js", import.meta.url), "utf8");
  assert.match(source, /const MAX_LOCK_ENTRIES = 4096;/);
  assert.match(source, /while \(map\.size > MAX_LOCK_ENTRIES\)/);
  assert.ok(!source.includes("lockedDirs.set("), "lockedDirs 只能经 rememberLockedEntry 插入");
  assert.ok(!source.includes("lockedFiles.set("), "lockedFiles 只能经 rememberLockedEntry 插入");
  // 释放点①：staging 临时名随发布（rename）同步释放
  assert.match(source, /releaseLockedFile\(target\);/);
  // 释放点②：rotation 删除后释放分片与其 meta.json 的条目
  assert.match(source, /releaseLockedFile\(file\.path\);/);
  assert.match(source, /releaseLockedFile\(\`\${file\.path\}\.meta\.json\`\);/);
});

test("保存后锁表只含在盘文件（staging 临时名已随发布释放）", () => {
  const fileA = join(sessionDirPath(), "cut-1001-aaaaaaaa.txt");
  const bodyA = shadow.shadowFileBody(sessionKey, "A".repeat(400));
  const result = save(fileA, bodyA, 1024 * 1024);
  assert.equal(result.ok, true, `保存失败：${JSON.stringify(result.rotation ?? {})}`);
  assert.ok(existsSync(fileA));
  // 锁表中的每个文件键都必须真实存在：若 staging 条目未随 rename 释放，
  // 这里会出现"键在表、文件已消失"的僵尸条目。
  for (const key of lockedFiles.keys()) {
    assert.ok(existsSync(key), `锁表残留失效条目：${key}`);
    assert.ok(!/\.tmp$/i.test(key), `锁表残留 staging 临时名：${key}`);
  }
  assert.ok(lockedFiles.has(canonicalKey(fileA)), "在盘备份应记入锁表");
  assert.ok(lockedDirs.size <= MAX_LOCK_ENTRIES, `lockedDirs.size=${lockedDirs.size}`);
  assert.ok(lockedFiles.size <= MAX_LOCK_ENTRIES, `lockedFiles.size=${lockedFiles.size}`);
});

test("rotation 删除分片后释放其锁表条目（含 meta.json）", () => {
  const fileA = join(sessionDirPath(), "cut-1001-aaaaaaaa.txt");
  const fileB = join(sessionDirPath(), "cut-1002-aaaaaaaa.txt");
  const rawFile = join(sessionDirPath(), "raw-0123456789abcdef.txt");
  const rawMeta = `${rawFile}.meta.json`;
  // 预置一个 raw 分片与其 meta（模拟更早的原文写入），并记入锁表，
  // 使 rotation 清理循环对 shadow.js:1638 / :1648 两处释放的调用可被断言。
  writeFileSync(rawFile, "x".repeat(80));
  writeFileSync(rawMeta, "{}");
  rememberLockedEntry(lockedFiles, canonicalKey(rawFile), { canonical: canonicalKey(rawFile) });
  rememberLockedEntry(lockedFiles, canonicalKey(rawMeta), { canonical: canonicalKey(rawMeta) });
  const bodyB = shadow.shadowFileBody(sessionKey, "B".repeat(60));
  // cap 压到比新分片还小：oversize 路径确定性删除全部可删分片（旧分片 + raw）
  const result = save(fileB, bodyB, Buffer.byteLength(bodyB) - 16);
  assert.equal(result.ok, true, `保存失败：${JSON.stringify(result.rotation ?? {})}`);
  assert.ok((result.rotation?.deleted ?? 0) >= 2, `应至少删除 2 个旧分片：${JSON.stringify(result.rotation ?? {})}`);
  assert.ok(existsSync(fileB), "受保护的最新分片应保留");
  assert.equal(existsSync(fileA), false, "超限旧分片应被 rotation 删除");
  assert.equal(existsSync(rawFile), false, "raw 分片应被 rotation 删除");
  assert.equal(existsSync(rawMeta), false, "raw meta 应随分片清理");
  assert.equal(lockedFiles.has(canonicalKey(fileA)), false, "被删除分片的锁表条目应释放");
  assert.equal(lockedFiles.has(canonicalKey(rawFile)), false, "被删除 raw 的锁表条目应释放");
  assert.equal(lockedFiles.has(canonicalKey(rawMeta)), false, "被删除 meta 的锁表条目应释放");
  assert.ok(lockedFiles.has(canonicalKey(fileB)), "新分片应记入锁表");
  assert.ok(lockedDirs.size <= MAX_LOCK_ENTRIES, `lockedDirs.size=${lockedDirs.size}`);
  assert.ok(lockedFiles.size <= MAX_LOCK_ENTRIES, `lockedFiles.size=${lockedFiles.size}`);
});

test("releaseLockedFile：删除在表键，缺键时幂等无害", () => {
  const probeDir = mkdtempSync(join(tmpdir(), "spine-lock-probe-"));
  const probe = join(probeDir, "probe.bin");
  const key = canonicalKey(probe);
  rememberLockedEntry(lockedFiles, key, { canonical: key });
  assert.ok(lockedFiles.has(key));
  releaseLockedFile(probe);
  assert.equal(lockedFiles.has(key), false);
  assert.doesNotThrow(() => releaseLockedFile(probe), "对不存在键重复释放应无害");
  rmSync(probeDir, { recursive: true, force: true });
});

test("真实锁表在超量插入后仍不超过硬上界", () => {
  const total = MAX_LOCK_ENTRIES + 128;
  for (let i = 0; i < total; i++) {
    rememberLockedEntry(lockedFiles, `synthetic-${i}`, { canonical: `synthetic-${i}` });
  }
  assert.ok(lockedFiles.size <= MAX_LOCK_ENTRIES, `lockedFiles.size=${lockedFiles.size}`);
  assert.ok(lockedDirs.size <= MAX_LOCK_ENTRIES, `lockedDirs.size=${lockedDirs.size}`);
  assert.equal(lockedFiles.has("synthetic-0"), false, "最旧合成条目应被淘汰");
  assert.ok(lockedFiles.has(`synthetic-${total - 1}`), "最新合成条目应保留");
});
