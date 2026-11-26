import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, base, pwsh, grep, proof] = process.argv.slice(2);
assert.ok(process.versions.electron, "Expected Desktop's embedded Electron runtime");
const { writeShadowFile } = await import(pathToFileURL(modulePath));
const root = mkdtempSync(join(base, "electron-shadow-"));
const fixture = join(base, "grep-fixture.txt");
writeFileSync(fixture, "spawn-control-line\n");
const options = { encoding: "utf8", timeout: 15_000, windowsHide: true };
function testTools() {
  assert.equal(execFileSync(pwsh, ["-NoProfile", "-NonInteractive", "-Command", "Write-Output 'pwsh-ready'"], options).trim(), "pwsh-ready");
  assert.match(execFileSync(grep, ["-n", "spawn-control-line", fixture], options), /1:spawn-control-line/);
}
try {
  testTools();
  const file = join(root, "cut-1-deadbeef.txt");
  writeShadowFile(file, "synthetic backup from signed Desktop Electron", {}, { root });
  assert.match(readFileSync(file, "utf8"), /signed Desktop Electron/);
  for (let i = 0; i < 3; i++) testTools();
  writeFileSync(proof, JSON.stringify({ electron: process.versions.electron, node: process.versions.node,
    arch: process.arch, before: 2, after: 6, shadowWrite: true }) + "\n");
} finally {
  rmSync(root, { recursive: true, force: true });
}
