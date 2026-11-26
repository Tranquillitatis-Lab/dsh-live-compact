/**
 * 薄入口。这个文件必须能求值，引擎加载失败也不能把这里抛掉。
 * Thin entry. This file must evaluate even when the engine cannot load.
 *
 * 预检查只解析配置，校验交给实际引擎；构造失败时释放本次注册，不重试原版盖掉报错。
 * Resolve config before construction; let the engine validate it and preserve its actual error.
 */
import { contextProperty, loadBase, loadCompaction, loadSchema, STOCK_ENGINE } from "./adapter.js";
import { configSchema, engineConfig } from "./settings.js";
import { installPresetGate } from "./gate.js";

const CORDIS_INIT = Symbol.for("cordis.init");
const ISOLATE = Symbol.for("cordis.isolate");

let Engine = null;
let Stock = null;
let CompactionEngine = null;
let ManualCompactionError = null;
let loadError = null;
let Schema = null;

if (process.env.SPINE_ENGINE_FAIL === "import") {
  loadError = new Error("spine: engine import refused");
} else {
  try {
    const engine = await import("./index.js");
    Engine = engine.default;
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
  }
}

try {
  const compaction = await loadCompaction();
  CompactionEngine = compaction.CompactionEngine;
  ManualCompactionError = compaction.ManualCompactionError;
} catch (error) {
  loadError ??= error instanceof Error ? error : new Error(String(error));
}

try {
  const stock = await loadBase();
  Stock = stock.BasicCompactionEngine;
} catch (error) {
  if (!loadError) loadError = error instanceof Error ? error : new Error(String(error));
}

// 官方设置界面按这份 schema 自动生成表单。拿不到 schemastery 就退回 stock 的 schema。
try {
  const schema = await loadSchema();
  Schema = configSchema(schema.default, Stock?.Config);
} catch {
  Schema = null;
}

function reasonText(error) {
  return error instanceof Error ? error.message : String(error);
}

export function preflightConfig(config = {}) {
  return engineConfig(config);
}

function compactionRecord(ctx) {
  const key = ctx?.[ISOLATE]?.compaction;
  return key === undefined ? undefined : ctx?.reflect?.store?.[key];
}

function releaseCompaction(ctx, previous, key = ctx?.[ISOLATE]?.compaction) {
  const store = ctx?.reflect?.store;
  const current = key === undefined ? undefined : store?.[key];
  const currentFiber = current?.fiber ?? current?.ctx?.fiber;
  const contextFiber = ctx?.fiber;
  if (!current || current === previous || currentFiber !== contextFiber) return false;
  delete store[key];
  if (contextFiber?.store?.compaction === current) delete contextFiber.store.compaction;
  return true;
}

function detachRootStockCompaction(ctx) {
  const store = ctx?.reflect?.store;
  const current = compactionRecord(ctx);
  const key = ctx?.[ISOLATE]?.compaction;
  const fiber = current?.fiber ?? current?.ctx?.fiber;
  const moduleName = fiber?.entry?.options?.name;
  if (!current || moduleName !== STOCK_ENGINE || fiber === ctx?.fiber) return false;
  if (compactionRecord(ctx) !== current) return false;
  const fiberStore = fiber?.store;
  if (fiberStore?.compaction === current) delete fiberStore.compaction;
  delete store[key];
  return { store, key, current, fiber, fiberStore, uid: fiber?.uid, epoch: fiber?._runner?.epoch };
}

function commitRootStockCompaction(replacement) {
  if (!replacement || replacement.committed) return false;
  const options = replacement.fiber?.entry?.options;
  const disabled = options && Object.getOwnPropertyDescriptor(options, "disabled");
  try {
    // The loader writes unrequested disposals back as disabled. Mark this
    // synchronous notification as intentional without changing its config.
    if (options) options.disabled = true;
    replacement.retirement = Promise.resolve(replacement.fiber?.dispose?.());
    replacement.retirement.catch(() => {});
    replacement.committed = true;
  } finally {
    if (disabled) Object.defineProperty(options, "disabled", disabled);
    else if (options) delete options.disabled;
  }
  return true;
}

function rollbackRootStockCompaction(replacement) {
  if (!replacement || replacement.committed) return false;
  const { fiber, uid, epoch, key } = replacement;
  const entry = fiber?.entry;
  const scope = replacement.current.ctx?.[ISOLATE];
  if (fiber?.uid === null || fiber?.uid !== uid || fiber?._runner?.epoch !== epoch ||
      (fiber?.state !== undefined && ![1, 2].includes(fiber.state)) ||
      (scope && scope.compaction !== key) || entry?.disabled) return false;
  if (entry?.parent?.tree && (!currentLoaderEntry(entry) || entry.fiber?.ctx?.fiber !== fiber ||
      ![1, 2].includes(entry.parent.ctx?.fiber?.state) || ![1, 2].includes(entry.parent.tree.ctx?.fiber?.state))) return false;
  const current = replacement.store?.[replacement.key];
  if (current !== undefined && current !== replacement.current) return false;
  replacement.store[replacement.key] = replacement.current;
  if (replacement.fiberStore && replacement.fiberStore.compaction === undefined) {
    replacement.fiberStore.compaction = replacement.current;
  }
  return true;
}

export function releaseRootStockCompaction(ctx, { deferDispose = false } = {}) {
  const replacement = detachRootStockCompaction(ctx);
  if (!replacement) return false;
  if (deferDispose) {
    replacement.committed = false;
    replacement.commit = () => commitRootStockCompaction(replacement);
    replacement.rollback = () => rollbackRootStockCompaction(replacement);
    return replacement;
  }
  try { commitRootStockCompaction(replacement); } catch (error) {
    rollbackRootStockCompaction(replacement);
    throw error;
  }
  return true;
}

function currentLoaderEntry(entry) {
  return entry && entry.parent?.tree?.store?.[entry.options?.id] === entry;
}

function configuredRootStock(ctx) {
  const owner = ctx.fiber?.entry;
  if (owner?.options?.id !== "compaction-spine") return undefined;
  const stock = owner.parent?.tree?.store?.["compaction-basic"];
  return stock?.options?.name === STOCK_ENGINE && stock.options.isolate?.compaction !== true && !stock.disabled ? stock : undefined;
}

function sameCompactionRealm(ctx, entry) {
  return ctx[ISOLATE]?.compaction === entry.ctx?.[ISOLATE]?.compaction;
}

function activationCheck(ctx) {
  const fiber = ctx.fiber;
  const entry = fiber?.entry;
  const uid = fiber?.uid;
  const epoch = fiber?._runner?.epoch;
  const scope = ctx[ISOLATE];
  return () => !fiber?.runtime || (uid != null && fiber.uid === uid && fiber._runner?.epoch === epoch &&
    ctx[ISOLATE] === scope && (!entry || (currentLoaderEntry(entry) && !entry.disabled)));
}

function restoreStockOnUnload(ctx, replacement) {
  const entry = replacement.fiber?.entry;
  if (typeof entry?.update !== "function") return;
  const installed = compactionRecord(ctx);
  ctx.effect(() => async () => {
    if (!replacement.committed) return;
    await replacement.retirement;
    const parent = entry.parent?.ctx?.fiber;
    const tree = entry.parent?.tree?.ctx?.fiber;
    if (!currentLoaderEntry(entry) || entry.disabled || ![1, 2].includes(parent?.state) ||
        ![1, 2].includes(tree?.state) ||
        entry.ctx?.[ISOLATE]?.compaction !== ctx[ISOLATE]?.compaction) return;
    const current = compactionRecord(ctx);
    if (current && current !== installed) return;
    releaseCompaction(ctx, replacement.current);
    await entry.update({}, false, true);
    await entry.fiber?.await?.();
  });
}

function visibleTakeover(ctx, reason) {
  const line = `spine: ${MARK}。${reason}`;
  console.error(line);
  try { contextProperty(ctx, "logger")?.warn?.(line); } catch {}
}

const MARK = "本会话未接管";

const UnavailableCompaction = CompactionEngine
  ? class extends CompactionEngine {
    constructor(ctx, reason) {
      super(ctx);
      this.reason = reason;
      ctx.logger?.warn?.(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${reason}`);
    }

    compactIfNeeded() {
      return Promise.reject(new Error(`spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`));
    }

    compactNow() {
      const message = `spine: ${MARK}。压缩没有装上，这一刀没有执行。${this.reason}`;
      if (ManualCompactionError) return Promise.reject(new ManualCompactionError("summary", message));
      return Promise.reject(new Error(message));
    }
  }
  : null;

export default class LiveCompactEntry {
  static inject = Stock?.inject ?? ["llm", "tokenMeter", "sessions"];
  static Config = Schema || Stock?.Config || Engine?.Config;

  constructor(ctx, config) {
    const isCurrent = activationCheck(ctx);
    const stock = configuredRootStock(ctx);
    if (stock && (stock._initTask || (stock.fiber?.state === 1 && sameCompactionRealm(ctx, stock)))) {
      // Loader mounts siblings in parallel. Wait for the configured stock
      // entry to finish publishing before choosing the owner to replace.
      return { [CORDIS_INIT]: async () => {
        try { await stock._initTask; } catch {} // The loader reports import failures.
        if (!isCurrent() || configuredRootStock(ctx) !== stock) return;
        if (sameCompactionRealm(ctx, stock)) {
          try { await stock.fiber?.await?.(); } catch {} // The loader reports activation failures.
        }
        if (!isCurrent() || configuredRootStock(ctx) !== stock) return;
        const engine = this.activate(ctx, config, isCurrent);
        return engine[CORDIS_INIT]?.();
      } };
    }
    return this.activate(ctx, config, isCurrent);
  }

  activate(ctx, config, isCurrent) {
    const previousCompaction = compactionRecord(ctx);
    let cause = loadError;
    let resolvedConfig;
    let skipStock = process.env.SPINE_ENGINE_FAIL === "construct";
    if (skipStock) cause = new Error("spine: constructor refused");
    if (!loadError && !skipStock) {
      try {
        resolvedConfig = preflightConfig(config);
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        skipStock = true;
      }
    }
    let constructed = false;
    if (!loadError && !skipStock && Engine) {
      let rootStockReplacement = false;
      const rollback = () => {
        releaseCompaction(ctx, previousCompaction, rootStockReplacement?.key);
        rootStockReplacement?.rollback?.();
      };
      const commit = (engine, deferred) => {
        if (!isCurrent()) { rollback(); return; }
        if (deferred) engine.activateAfterInit(resolvedConfig.auto ?? true);
        const commitGate = installPresetGate(ctx, config, { deferCommit: true });
        if (rootStockReplacement) restoreStockOnUnload(ctx, rootStockReplacement);
        rootStockReplacement?.commit?.();
        commitGate?.();
      };
      try {
        rootStockReplacement = releaseRootStockCompaction(ctx, { deferDispose: true });
        if (previousCompaction && !rootStockReplacement) throw new Error("spine: compaction already provided by another engine");
        constructed = true;
        const deferActivation = Boolean(rootStockReplacement && typeof Engine.prototype[CORDIS_INIT] === "function");
        const engine = new Engine(ctx, config, resolvedConfig, { strictActivation: true, deferActivation });
        const initialize = engine[CORDIS_INIT];
        if (typeof initialize === "function") {
          engine[CORDIS_INIT] = async () => {
            try {
              const dispose = await initialize.call(engine);
              commit(engine, deferActivation);
              return dispose;
            } catch (error) {
              rollback();
              visibleTakeover(ctx, reasonText(error));
              throw error;
            }
          };
        } else commit(engine, deferActivation);
        return engine;
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        rollback();
        skipStock = true;
      }
    }
    cause ??= new Error("spine: engine missing");
    if (previousCompaction || (constructed && ctx.fiber?.runtime)) {
      visibleTakeover(ctx, reasonText(cause));
      throw cause;
    }
    if (!skipStock && process.env.SPINE_STOCK_FAIL !== "1" && Stock) {
      try {
        visibleTakeover(ctx, `这一轮用原版压缩。${reasonText(cause)}`);
        return new Stock(ctx, engineConfig(config));
      } catch (error) {
        cause = error instanceof Error ? error : new Error(String(error));
        releaseCompaction(ctx, previousCompaction);
      }
    }
    visibleTakeover(ctx, reasonText(cause));
    if (!UnavailableCompaction) throw new Error(`spine: ${MARK}。压缩接口没有装上。${reasonText(cause)}`);
    return new UnavailableCompaction(ctx, reasonText(cause));
  }
}
