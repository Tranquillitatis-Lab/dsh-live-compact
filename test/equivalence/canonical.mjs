// 等价性验证台：跨进程规范化。
// 目标：消除已知的墙钟/随机噪声（freshShadowFile 文件名、决策 ts、compactionId、
// PID、每次运行的临时根目录），同时完整保留结构性内容（文本、seq、sha256、字节数），
// 让差分只反映真实行为差异。
import { createHash } from "node:crypto";

const ISO_TS = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})/g;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const EPOCH_MS = /\b1[6-9]\d{11}\b/g;
// 折叠 8/16/24/40/48 位十六进制随机段（randomBytes(4/8/24)、uuid 片段、哈希截断）；
// 保留 64 位 sha256——内容哈希是真实观测值，不能折叠。
const HEX_RAND = /\b(?:[0-9a-f]{8}|[0-9a-f]{16}|[0-9a-f]{24}|[0-9a-f]{40}|[0-9a-f]{48})\b/gi;

export function canonicalText(text) {
  return String(text)
    .replace(ISO_TS, "<ISO>")
    .replace(UUID, "<UUID>")
    .replace(EPOCH_MS, "<NOW>")
    .replace(HEX_RAND, "<HEX>");
}

export function canonicalize(value, root) {
  if (typeof value === "string") return canonicalText(root ? stripRoot(value, root) : value);
  if (Array.isArray(value)) return value.map((item) => canonicalize(item, root));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key], root);
    return out;
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function contentHash(text) {
  return createHash("sha256").update(Buffer.from(typeof text === "string" ? text : String(text), "utf8")).digest("hex");
}

// 每次运行 mkdtemp 的根目录名不同；先替换成 <ROOT> 再做文本规范化。
export function stripRoot(text, root) {
  return root ? String(text).split(root).join("<ROOT>") : String(text);
}

// 采集子进程的确定性时钟：Date.now 只随 tick 前进，可用 advance(ms) 推进。
export function patchDeterministicClock({ base = 1700000000000, step = 7 } = {}) {
  const real = Date.now.bind(Date);
  let tick = 0;
  Date.now = () => base + (tick += step);
  return {
    advance(ms) { tick += Math.max(0, ms | 0); },
    restore() { Date.now = real; },
  };
}
