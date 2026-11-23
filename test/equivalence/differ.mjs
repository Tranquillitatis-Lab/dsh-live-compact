// 等价性验证台：差分器。
// 规则：对两份采集记录做深比较；默认白名单为空——任何差异都算失败。
// 白名单条目 { case, path } 按点路径前缀豁免（见 whitelist.json）。
// meta 段不参与比较（其中记录了来源树名，按设计就不同）。
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { canonicalize } from "./canonical.mjs";

const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

const trunc = (value) => {
  if (typeof value !== "string") return value;
  return value.length > 220 ? `${value.slice(0, 220)}…(${value.length} chars)` : value;
};

export function diffPaths(a, b, path = "", out = [], depth = 0) {
  if (depth > 32) { out.push({ path: path || "<root>", reason: "depth-limit-exceeded" }); return out; }
  if (isObject(a) && isObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      diffPaths(a[key], b[key], path ? `${path}.${key}` : key, out, depth + 1);
    }
    return out;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const length = Math.max(a.length, b.length);
    for (let index = 0; index < length; index++) diffPaths(a[index], b[index], `${path}[${index}]`, out, depth + 1);
    return out;
  }
  if (a !== b) out.push({ path: path || "<root>", baseline: trunc(a), current: trunc(b) });
  return out;
}

function whitelisted(path, entries) {
  return entries.some((entry) => {
    if (!entry?.path) return false;
    return path === entry.path || path.startsWith(`${entry.path}.`) || path.startsWith(`${entry.path}[`);
  });
}

export function compareCase(baseline, current, { caseName, entries = [] } = {}) {
  const { meta: _baselineMeta, ...baselineRest } = canonicalize(baseline);
  const { meta: _currentMeta, ...currentRest } = canonicalize(current);
  const diffs = diffPaths(baselineRest, currentRest);
  const scoped = entries.filter((entry) => !entry?.case || entry.case === caseName);
  return { diffs, failures: diffs.filter((diff) => !whitelisted(diff.path, scoped)) };
}

export function main(argv = process.argv.slice(2)) {
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const [baselinePath, currentPath] = positional;
  if (!baselinePath || !currentPath) {
    console.error("用法：node differ.mjs <baseline.json> <current.json> [--whitelist=whitelist.json] [--case=名称]");
    return 2;
  }
  const whitelistArg = argv.find((arg) => arg.startsWith("--whitelist="));
  const caseArg = argv.find((arg) => arg.startsWith("--case="));
  const entries = whitelistArg
    ? JSON.parse(readFileSync(whitelistArg.slice("--whitelist=".length), "utf8")).entries || []
    : [];
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const current = JSON.parse(readFileSync(currentPath, "utf8"));
  const { diffs, failures } = compareCase(baseline, current, { caseName: caseArg?.slice("--case=".length), entries });
  if (failures.length === 0) {
    console.log(`PASS ${baseline.meta?.case || caseArg || "(unknown)"}：与基线无行为差异（原始差异 ${diffs.length} 处均被白名单豁免或为 0）`);
    return 0;
  }
  console.error(`FAIL：发现 ${failures.length} 处行为差异（列出前 20 处）`);
  for (const diff of failures.slice(0, 20)) {
    console.error(`  - ${diff.path}`);
    console.error(`      基线: ${JSON.stringify(diff.baseline)}`);
    console.error(`      当前: ${JSON.stringify(diff.current)}`);
  }
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) process.exit(main());
