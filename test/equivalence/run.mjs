#!/usr/bin/env node
// 等价性验证台：编排器。
//   node test/equivalence/run.mjs baseline   采集全部语料基线 + 自校验（基线必须可复现）
//   node test/equivalence/run.mjs compare    当前工作树 vs 基线 逐 case 差分
//   node test/equivalence/run.mjs redlines   红线断言（当前树）
//   node test/equivalence/run.mjs all        redlines + compare
// 退出码 0 = 全部通过；非 0 = 存在失败，禁止据此放行行为变更。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CASES, CORPUS_VERSION } from "./corpus.mjs";
import { compareCase } from "./differ.mjs";
import { runRedlines } from "./redlines.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const forkRoot = join(here, "..", "..");
const baselineDir = join(here, "baselines");
const workDir = join(here, "work");

function collectSync(name, srcKind, out) {
  const result = spawnSync(process.execPath,
    [join(here, "collect.mjs"), `--case=${name}`, `--src=${srcKind}`, `--out=${out}`],
    { encoding: "utf8", cwd: forkRoot, timeout: 180000 });
  if (result.status !== 0) {
    throw new Error(`collect 失败 case=${name} src=${srcKind} exit=${result.status}\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return JSON.parse(readFileSync(out, "utf8"));
}

async function cmdBaseline() {
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  let head = "";
  try { head = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: forkRoot }).stdout.trim(); } catch { head = "unknown"; }
  const manifest = { corpusVersion: CORPUS_VERSION, head, cases: {} };
  let failed = false;
  for (const caseDef of CASES) {
    const outFile = join(baselineDir, `${caseDef.name}.json`);
    try {
      const first = collectSync(caseDef.name, "baseline", outFile);
      const selfFile = join(workDir, `selfcheck-${caseDef.name}.json`);
      const second = collectSync(caseDef.name, "baseline", selfFile);
      const { failures } = compareCase(first, second, { caseName: caseDef.name });
      if (failures.length > 0) {
        failed = true;
        console.error(`SELF-CHECK FAIL ${caseDef.name}：基线两次采集不一致（${failures.length} 处），差分不可信：`);
        for (const diff of failures.slice(0, 10)) console.error(`  - ${diff.path}`);
        continue;
      }
      manifest.cases[caseDef.name] = {
        file: `${caseDef.name}.json`,
        sha256: createHash("sha256").update(readFileSync(outFile)).digest("hex"),
      };
      console.log(`baseline OK ${caseDef.name}（自校验复现一致）`);
    } catch (error) {
      failed = true;
      console.error(`baseline FAIL ${caseDef.name}：${error.message}`);
    }
  }
  manifest.ok = !failed;
  writeFileSync(join(baselineDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  if (failed) { console.error("基线采集未全部通过。"); return 1; }
  console.log(`基线完成：${CASES.length} 个 case，HEAD=${head}，清单在 test/equivalence/baselines/manifest.json`);
  return 0;
}

function loadBaseline(name) {
  const file = join(baselineDir, `${name}.json`);
  if (!existsSync(file)) throw new Error(`缺少基线：${file}（先运行 node test/equivalence/run.mjs baseline）`);
  return JSON.parse(readFileSync(file, "utf8"));
}

function cmdCompare() {
  mkdirSync(workDir, { recursive: true });
  const entries = JSON.parse(readFileSync(join(here, "whitelist.json"), "utf8")).entries || [];
  let failed = false;
  for (const caseDef of CASES) {
    const currentFile = join(workDir, `current-${caseDef.name}.json`);
    try {
      collectSync(caseDef.name, "current", currentFile);
      const baseline = loadBaseline(caseDef.name);
      const current = JSON.parse(readFileSync(currentFile, "utf8"));
      const { failures } = compareCase(baseline, current, { caseName: caseDef.name, entries });
      if (failures.length > 0) {
        failed = true;
        console.error(`DIFF FAIL ${caseDef.name}：${failures.length} 处差异：`);
        for (const diff of failures.slice(0, 10)) {
          console.error(`  - ${diff.path}`);
          console.error(`      基线: ${JSON.stringify(diff.baseline)}`);
          console.error(`      当前: ${JSON.stringify(diff.current)}`);
        }
      } else {
        console.log(`DIFF PASS ${caseDef.name}`);
      }
    } catch (error) {
      failed = true;
      console.error(`DIFF FAIL ${caseDef.name}：${error.message}`);
    }
  }
  return failed ? 1 : 0;
}

async function cmdRedlines() {
  const { results } = await runRedlines({ srcDir: forkRoot });
  const failures = results.filter((item) => !item.ok);
  console.log(failures.length === 0 ? `红线全部通过（${results.length} 项）` : `红线失败 ${failures.length}/${results.length} 项`);
  return failures.length === 0 ? 0 : 1;
}

async function main() {
  const mode = process.argv[2] || "";
  if (mode === "baseline") return cmdBaseline();
  if (mode === "compare") return cmdCompare();
  if (mode === "redlines") return cmdRedlines();
  if (mode === "all") {
    const a = await cmdRedlines();
    const b = cmdCompare();
    return a === 0 && b === 0 ? 0 : 1;
  }
  console.error("用法：node test/equivalence/run.mjs <baseline|compare|redlines|all>");
  return 2;
}

main().then((code) => process.exit(code)).catch((error) => { console.error(error?.stack || error); process.exit(1); });
