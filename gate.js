import { createRequire } from "node:module";
import { STOCK_ENGINE as STOCK } from "./adapter.js";
import { configSnapshot, engineConfig } from "./settings.js";

const OURS = "dsh-live-compact";
const PRESET_IDS = new Set(["standard", "ptc", "minimal", "cordis", "preset-standard", "preset-ptc", "preset-minimal", "preset-cordis"]);
const COMPETING_COMPRESSORS = new Set(["bili-native", "billion-context"]);
const COMPETING_FIBER_STATES = new Set([1, 2]); // Cordis 4.1: LOADING=1, ACTIVE=2.
const standDownNotices = new WeakMap();
export const GATE_SERVICE = "liveCompactPresetGate";
export const PRESET_ENGINE_CONFIG = Object.freeze(engineConfig());

/**
 * Return the exact active compressor runtimes that own the session when they
 * are loading or active. Cordis keeps one runtime per plugin callback and
 * exposes every live fiber through `ctx.registry.values()`; a package on disk
 * or a failed/unloading fiber is not an active compressor.
 */
export function activeCompactionPeers(ctx) {
  const peers = [];
  if (process.env.SPINE_STAND_DOWN === "1") peers.push("SPINE_STAND_DOWN");
  const registry = ctx?.registry;
  if (!registry || typeof registry.values !== "function") return peers;
  try {
    for (const runtime of registry.values()) {
      const name = runtime?.name;
      if (!COMPETING_COMPRESSORS.has(name)) continue;
      const active = [...(runtime?.fibers || [])].some((fiber) => COMPETING_FIBER_STATES.has(fiber?.state));
      if (active && !peers.includes(name)) peers.push(name);
    }
  } catch {
    // Cordis 4.1 always exposes an iterable registry. If an older/partial host
    // cannot enumerate it, preserve the single-plugin path and do not guess a
    // competing package from installation state.
  }
  return peers;
}

export function compactionStandDown(ctx) {
  return activeCompactionPeers(ctx).length > 0;
}

export function warnCompactionStandDown(ctx, logger = ctx?.logger) {
  const peers = activeCompactionPeers(ctx);
  if (!peers.length) return peers;
  const root = ctx?.root || ctx;
  const key = peers.join(",");
  if (root && standDownNotices.get(root) === key) return peers;
  if (root) standDownNotices.set(root, key);
  logger?.warn?.(peers[0] === "SPINE_STAND_DOWN"
    ? peers.length === 1
      ? "spine: SPINE_STAND_DOWN=1，但未检测到活跃对端；本插件保持让位，请确认 owner 配置。"
      : `spine: SPINE_STAND_DOWN=1，已有压缩插件接管（${peers.slice(1).join(", ")}），本插件不切、不改预设。`
    : `spine: 已有压缩插件接管（${peers.join(", ")}），本插件不切、不改预设。`);
  return peers;
}

const require = createRequire(import.meta.url);

export function packageLoadable(load = (name) => require(name)) {
  try {
    load(OURS);
    return true;
  } catch (error) {
    // The shell uses top-level await so a failed engine does not fail this package.
    // require() refuses that shape even when import() can load it.
    if (error?.code !== "ERR_REQUIRE_ASYNC_MODULE" && error?.code !== "ERR_REQUIRE_ESM") return false;
    try {
      require.resolve(OURS);
      return true;
    } catch {
      return false;
    }
  }
}

function isPreset(node) {
  if (!node || typeof node !== "object") return false;
  if (PRESET_IDS.has(node.id)) return true;
  return Boolean(node.config && typeof node.config === "object" && !Array.isArray(node.config) && PRESET_IDS.has(node.config.id));
}

function takeoverSelected(config, entry, selector) {
  if (typeof selector === "boolean") return selector;
  if (!Array.isArray(selector)) return Boolean(selector);
  const ids = [
    config?.id,
    config?.config?.id,
    entry?.id,
    entry?.presetId,
    entry?.options?.id,
  ].filter((id) => typeof id === "string");
  return ids.some((id) => selector.includes(id));
}

function outerPresetId(fiber) {
  const seen = new Set();
  const queue = [];
  let found = "";
  const push = (value) => {
    if (value && (typeof value === "object" || typeof value === "function") && !seen.has(value)) queue.push(value);
  };
  try { push(fiber?.parent); } catch {}
  try { push(fiber?.fiber?.parent); } catch {}
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    let ids = [];
    try {
      ids = [
        current?.entry?.options?.id,
        current?.fiber?.entry?.options?.id,
        current?.config?.id,
        current?.id,
      ];
    } catch {}
    const candidate = ids.find((id) => typeof id === "string" && id.length > 0);
    if (candidate) found = candidate;
    try { push(current.parent); } catch {}
    try { push(current.fiber); } catch {}
    try { push(current.parent?.fiber); } catch {}
    try { push(current.fiber?.parent); } catch {}
  }
  return found;
}

function withEngineConfig(entry, rootConfig) {
  const previous = entry.config && typeof entry.config === "object" && !Array.isArray(entry.config) ? configSnapshot(entry.config) : {};
  const { takeoverPresets: _takeover, ...root } = configSnapshot(rootConfig);
  const merged = { ...root, ...previous };
  // 较高优先级显式选择 retention 模式时，移除继承的互斥字段。
  if (previous.retainRatio !== undefined && previous.retainTokens === undefined) delete merged.retainTokens;
  if (previous.retainTokens !== undefined && previous.retainRatio === undefined) delete merged.retainRatio;
  return { ...merged, ...engineConfig(merged) };
}

function rewriteEntry(entry, loadable, rootConfig) {
  if (!entry || typeof entry !== "object") return entry;
  const next = { ...entry };
  if (entry.name === STOCK) {
    if (!loadable) return entry;
    next.name = OURS;
    next.config = withEngineConfig(entry, rootConfig);
    return next;
  }
  if (Array.isArray(entry.config)) next.config = entry.config.map((item) => rewriteEntry(item, loadable, rootConfig));
  else if (entry.config && typeof entry.config === "object") next.config = rewriteNode(entry.config, loadable, rootConfig);
  return next;
}

function rewriteNode(node, loadable, rootConfig) {
  if (Array.isArray(node)) return node.map((item) => rewriteEntry(item, loadable, rootConfig));
  if (!node || typeof node !== "object") return node;
  const next = { ...node };
  if (Array.isArray(node.plugins)) next.plugins = node.plugins.map((item) => rewriteEntry(item, loadable, rootConfig));
  if (Array.isArray(node.config)) next.config = node.config.map((item) => rewriteEntry(item, loadable, rootConfig));
  else if (node.config && typeof node.config === "object") next.config = rewriteNode(node.config, loadable, rootConfig);
  return next;
}

export function rewritePresetConfig(config, loadable = packageLoadable(), rootConfig = {}, entry, selector = true) {
  const group = Array.isArray(config) && entry?.group === true && entry.isolate?.compaction === true;
  if (!takeoverSelected(config, entry, selector) || (!isPreset(config) && !group)) return config;
  return rewriteNode(config, loadable, rootConfig);
}

function engineEntry(node) {
  if (!node || typeof node !== "object") return null;
  if (node.name === OURS) return node;
  const nested = [];
  if (Array.isArray(node)) nested.push(...node);
  if (Array.isArray(node.plugins)) nested.push(...node.plugins);
  if (Array.isArray(node.config)) nested.push(...node.config);
  else if (node.config && typeof node.config === "object") nested.push(node.config);
  for (const item of nested) {
    const found = engineEntry(item);
    if (found) return found;
  }
  return null;
}

// A compatibility gate is provisional. The shallowest real entry owns the one
// listener; retain its authority while unloaded so nested/legacy reloads cannot
// silently enable takeover again.
const installedGates = new WeakMap();

function entryDepth(ctx) {
  let depth = 0;
  for (let fiber = ctx.fiber; fiber?.runtime; fiber = fiber.parent.fiber) depth++;
  return depth;
}

export function installPresetGate(ctx, config = {}, { legacy = false } = {}) {
  const depth = entryDepth(ctx);
  const previous = installedGates.get(ctx.root);
  if (previous) {
    if (legacy && !previous.legacy) return;
    if (legacy === previous.legacy && (depth > previous.depth || (depth === previous.depth && previous.active))) return;
    previous.active = false;
    previous.disposeListener?.();
  }
  const gate = { depth, legacy, active: true };
  installedGates.set(ctx.root, gate);
  ctx.effect(() => () => { gate.active = false; });
  const enabled = () => {
    const value = config.takeoverPresets ?? true;
    return typeof value === "boolean" || Array.isArray(value) ? value : value.get();
  };
  const seen = new Set();
  gate.disposeListener = ctx.on("internal/config", function (fiber, next) {
    const resolved = next();
    if (compactionStandDown(ctx)) {
      warnCompactionStandDown(ctx);
      return resolved;
    }
    if (!gate.active) return resolved;
    const selector = enabled();
    if (!selector || (Array.isArray(selector) && selector.length === 0)) return resolved;
    const loadable = packageLoadable();
    const entry = fiber?.entry?.options;
    const presetId = outerPresetId(fiber);
    const selectedEntry = presetId ? { ...entry, presetId } : entry;
    const rewritten = rewritePresetConfig(resolved, loadable, config, selectedEntry, selector);
    const id = rewritten?.id || rewritten?.config?.id || entry?.id;
    if (rewritten !== resolved && id && !seen.has(String(id))) {
      seen.add(String(id));
      const engine = engineEntry(rewritten);
      if (engine) {
        const config = engine.config || {};
        ctx.logger?.info?.(`spine: 预设 ${id} 已换包 ${engine.name} thresholdRatio=${config.thresholdRatio} headroomTokens=${config.headroomTokens} retainTokens=${config.retainTokens} compactionRetries=${config.compactionRetries}`);
      } else if (!loadable) {
        ctx.logger?.warn?.(`spine: 本会话未接管预设 ${id}，仍用原版压缩。`);
      }
    }
    return rewritten;
  }, { global: true });
}

// Legacy entry for existing compositions; new installs only register compaction-spine.
export default class LiveCompactGate {
  constructor(ctx, config) {
    installPresetGate(ctx, config, { legacy: true });
  }
}
