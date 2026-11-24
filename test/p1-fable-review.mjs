import assert from "node:assert/strict";
import test from "node:test";
import { buildCard } from "../plan.js";
import { buildSendLess } from "../thunder.js";
import Spine from "../index.js";

test("P1 decision protection ignores ordinary model and region prose", () => {
  const ordinary = buildCard("", "", [{
    role: "assistant",
    text: "当前模型是 claude-3-5，部署区域是 us-east-1。",
  }]);
  assert.equal(ordinary.ok, true);
  assert.deepEqual(ordinary.missing, []);

  const decision = buildCard("", "", [{
    role: "assistant",
    text: "我们采用 claude-3-5 作为本轮模型。",
  }]);
  assert.notEqual(decision.ok, true);
  assert.equal(decision.missing.length, 1);

  const planDecision = buildCard("", "", [{
    role: "assistant",
    text: "我们决定采用方案 B，因为方案 A 会破坏现有缓存前缀。",
  }]);
  assert.notEqual(planDecision.ok, true);
  assert.equal(planDecision.missing.length, 1);
});

test("P1 Thunder send-less facts preserve their source role", () => {
  const prompt = buildSendLess({
    taskLine: "继续当前任务",
    facts: [
      { role: "user", line: "必须保留 ledger.txt。" },
      { role: "tool", line: "部署区域是 cn-north-7。" },
      { role: "unknown", line: "缺少原始备份。" },
    ],
    uncovered: "普通过程文字",
  });
  assert.match(prompt, /- \[user\] 必须保留 ledger\.txt。/);
  assert.match(prompt, /- \[tool\] 部署区域是 cn-north-7。/);
  assert.match(prompt, /- \[unknown\] 缺少原始备份。/);
});

test("issue #68 Thunder budgets Japanese, Korean and Han code points", () => {
  const prose = (uncovered, proseTokens) => buildSendLess({ uncovered, proseTokens })
    .split("Uncovered prose to summarize:\n").at(-1);
  for (const character of ["あ", "カ", "ｰ", "한", "ᄀ", "ㄱ", "汉", "㐀", "﨑", "𠀀"]) {
    assert.equal(prose(character.repeat(4), 2), character.repeat(3), character);
  }
  assert.equal(prose("abcdefgh", 1), "abcd");
  assert.equal(prose("あab", 1), "あa");
  assert.equal(prose("abc😀", 1), "abc");
});

test("P1 turn baseline settles on an early maintenance return", () => {
  const source = String(Spine.prototype.finishTurn);
  assert.equal(
    (source.match(/settleTurnBaseline\(\);\n\s+markCompleted\(\);\n\s+return;/g) || []).length,
    3,
  );
  assert.match(source, /state\.maxTurnGrowth = 0;/);
});
