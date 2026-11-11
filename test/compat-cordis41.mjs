import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageVersion = (name) => JSON.parse(readFileSync(require.resolve(`${name}/package.json`), "utf8")).version;
assert.equal(packageVersion("@deepseek-ai/cordis"), "4.1.0", "compat gate requires Cordis 4.1.0");
for (const name of [
  "@deepseek-ai/dsh-brand",
  "@deepseek-ai/dsh-session",
  "@deepseek-ai/dsh-commands",
  "@deepseek-ai/dsh-agent",
  "@deepseek-ai/dsh-token-meter",
  "@deepseek-ai/dsh-compaction-tool-result-pruner",
  "@deepseek-ai/dsh-compaction",
  "@deepseek-ai/dsh-compaction-basic",
  "@deepseek-ai/dsh-llm",
]) assert.equal(packageVersion(name), "0.2.2-rc.1", `compat gate requires ${name}@0.2.2-rc.1`);
const node = process.execPath;
const npmCli = [
  process.env.npm_execpath,
  join(dirname(node), "node_modules/npm/bin/npm-cli.js"),
  join(dirname(node), "../lib/node_modules/npm/bin/npm-cli.js"),
].find(file => file?.endsWith("npm-cli.js") && existsSync(file));
assert.ok(npmCli, "compat gate requires npm-cli.js beside Node or via npm_execpath");
execFileSync(node, ["--test", "test/settings-integration.test.mjs", "test/preset-group.test.mjs"], { cwd: process.cwd(), stdio: "inherit" });
execFileSync(node, [npmCli, "run", "test:gate"], { cwd: process.cwd(), stdio: "inherit" });
console.log("Cordis 4.1.0 / DSH 0.2.2-rc.1 compatibility gate passed");
