import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { Context } from "@deepseek-ai/cordis";
import Loader, { Group } from "@deepseek-ai/cordis-plugin-loader";
import Include from "@deepseek-ai/cordis-plugin-include";
import Agents from "@deepseek-ai/dsh-agent";
import AgentPresets from "@deepseek-ai/dsh-agent-preset-registry";
import SessionProjections from "@deepseek-ai/dsh-session-projection";
import { STOCK_ENGINE } from "../adapter.js";
import { installPresetGate } from "../gate.js";

// Run through test:compat41. Real registry/Loader/Include, no model or user profile.
for (const include of [false, true]) {
  test(`direct registry registration takes over ${include ? "included" : "inline"} compaction groups`, async (t) => {
    const ctx = new Context();
    const directory = mkdtempSync(join(tmpdir(), "spine-preset-group-"));
    t.after(async () => {
      await ctx.fiber.dispose();
      rmSync(directory, { recursive: true, force: true });
    });
    const warnings = [];
    ctx.logger = { info() {}, debug() {}, warn: (line) => warnings.push(line), error: (error) => warnings.push(String(error)) };
    await ctx.plugin(Loader).await();
    ctx.loader.builtins.group = { apply: Group, inject: ["loader"] };
    await ctx.plugin(SessionProjections).await();
    await ctx.plugin(Agents).await();
    await ctx.plugin(AgentPresets, { default: "fixture" }).await();
    const mounted = [];
    ctx.loader.internal = {
      async import(name) {
        if (name === "include-fixture") return { default: Include };
        assert.ok([STOCK_ENGINE, "dsh-live-compact", "command-fixture", "pruner-fixture"].includes(name), name);
        return { apply(owner, config) {
          mounted.push({ name, config });
          if (name === STOCK_ENGINE || name === "dsh-live-compact") owner.provide("compaction", { name });
        } };
      },
    };
    let enabled = true;
    const gate = ctx.plugin((owner) => installPresetGate(owner, {
      takeoverPresets: { get: () => enabled }, minTokens: 9000, thresholdRatio: 0.8, retainTokens: 8192,
    }));
    await gate.await();
    const rows = [{
      id: "compaction", name: "cordis:group", group: true,
      isolate: { compaction: true },
      config: [
        { id: "compaction-basic", name: STOCK_ENGINE, config: { thresholdRatio: 0.2, retainRatio: 0.05 } },
        { id: "command-compact", name: "command-fixture" },
        { id: "tool-result-pruner", name: "pruner-fixture" },
      ],
    }];
    const original = structuredClone(rows);
    const file = join(directory, "agent.cordis.yml");
    writeFileSync(file, JSON.stringify(rows));
    const plugins = include
      ? [{ id: "fixture-plugins", name: "include-fixture", config: { path: pathToFileURL(file).href } }]
      : rows;
    await ctx.agentPresets.register({ id: "fixture", plugins });
    assert.deepEqual((await ctx.agentPresets.list()).map((row) => row.id), ["fixture"]);
    assert.deepEqual(mounted.map((row) => row.name).sort(), ["command-fixture", "dsh-live-compact", "pruner-fixture"]);
    const engine = mounted.find((row) => row.name === "dsh-live-compact");
    assert.equal(engine.config.minTokens, 9000);
    assert.equal(engine.config.thresholdRatio, 0.2);
    assert.equal(engine.config.retainRatio, 0.05);
    assert.equal(engine.config.retainTokens, undefined);
    assert.deepEqual(rows, original);
    assert.equal(ctx.get("compaction"), undefined, "the preset engine must not leak into the host realm");

    enabled = false;
    await ctx.agentPresets.register({ id: "disabled", plugins });
    assert.equal(mounted.filter((row) => row.name === STOCK_ENGINE).length, 1);
    assert.equal(mounted.filter((row) => row.name === "dsh-live-compact").length, 1);
    enabled = true;
    await gate.dispose();
    await ctx.agentPresets.register({ id: "disposed", plugins });
    assert.equal(mounted.filter((row) => row.name === STOCK_ENGINE).length, 2);
    assert.equal(warnings.length, 0, warnings.join("\n"));
  });
}
