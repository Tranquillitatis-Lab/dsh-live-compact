import assert from "node:assert/strict";
import test from "node:test";
import { buildCard, failureKeptLines, pointerOnlyText, toolExcerpt } from "../plan.js";

const tool = (text, extra = {}) => ({ role: "tool", text, isError: true, ...extra });
const card = (spans) => buildCard("", "", spans);
const refused = (value) => {
  assert.equal(value.ok, false);
  assert.equal(value.failureDiagnosticsComplete, false);
  assert.ok(value.missing.some(line => line.includes("failed-tool-diagnostics-not-retained")));
};

test("a failed diagnostic line keeps its suffix when the complete body fits", () => {
  const line = `Error: ${"x".repeat(300)} END_OF_LINE_DIAGNOSTIC`;
  const text = [line, ...Array.from({ length: 13 }, (_, i) => `context ${i}`)].join("\n");
  assert.ok(failureKeptLines(text).includes(line));
  const value = card([tool(text)]);
  assert.equal(value.ok, true);
  assert.equal(value.failureDiagnosticsComplete, true);
  assert.ok(value.text.includes(line));
});

test("framing cannot silently clip a diagnostic that fit the line selection budget", () => {
  const text = `Error: ${"x".repeat(2340)} END_MARKER`;
  assert.equal(failureKeptLines(text).join("\n"), text);
  const span = tool(text, { command: "command ".repeat(20) });
  assert.equal(toolExcerpt([span]).failureDiagnosticsComplete, false);
  refused(card([span]));
});

test("multiple failed tools cannot drop an older failure to fit a shared budget", () => {
  const spans = [tool(`Error: OLDER_FAILURE ${"a".repeat(1400)}`), tool(`Error: NEWER_FAILURE ${"b".repeat(1400)}`)];
  assert.equal(toolExcerpt(spans).failureDiagnosticsComplete, false);
  refused(card(spans));
});

test("over-budget diagnostics stay bounded previews and refuse an executable card", () => {
  const text = ["Error: wrapper failed", ...Array.from({ length: 20 }, (_, i) => `Error: frame ${i} ${"x".repeat(200)}`), "ROOT_CAUSE=missing setting"].join("\n");
  const preview = toolExcerpt([tool(text)]);
  assert.ok(preview.text.length <= 2400);
  assert.equal(preview.failureDiagnosticsComplete, false);
  refused(card([tool(text)]));
});

test("structured nonzero output keeps both streams when they fit", () => {
  const text = JSON.stringify({ exitCode: 23, stdout: { text: "STDOUT_CAUSE=missing setting" }, stderr: { text: "STDERR_CAUSE=wrapper failed" } });
  const value = card([tool(text, { isError: false })]);
  assert.equal(value.ok, true);
  assert.equal(value.failureDiagnosticsComplete, true);
  assert.ok(value.text.includes("STDOUT_CAUSE"));
  assert.ok(value.text.includes("STDERR_CAUSE"));
  assert.ok(value.text.includes("[exit code: 23]"));
});

test("budget-sized structured failures retain diagnostic fields outside both streams", () => {
  const text = JSON.stringify({ exitCode: 23, stderr: { text: "Error: wrapper failed" }, stdout: { text: "ordinary detail ".repeat(50) }, errorDetail: "ROOT_FIELD_SENTINEL" });
  const value = card([tool(text, { isError: false })]);
  assert.equal(value.ok, true);
  assert.equal(value.failureDiagnosticsComplete, true);
  assert.ok(value.text.includes("ROOT_FIELD_SENTINEL"));
  assert.ok(value.text.includes(text), "no unknown JSON field is silently dropped");
});

test("short streams cannot certify an over-budget structured failure as complete", () => {
  const text = JSON.stringify({ exitCode: 23, stderr: { text: "Error: wrapper failed" }, stdout: { text: "short output" }, diagnostic: "other failure context ".repeat(300) });
  refused(card([tool(text, { isError: false })]));
});

test("pointer labels agree with the nonzero-exit failure classifier", () => {
  const span = tool("Error: POINTER_ROOT_CAUSE\n[exit code: 1]", { isError: false, seq: 2, callSeq: 1, name: "shell" });
  assert.ok(pointerOnlyText([span]).includes("result 2 error"));
  assert.ok(card([span]).text.includes("result 2 error"));
});

test("ordinary output mentioning errors stays eligible under the existing unknown-state rule", () => {
  const value = card([tool("File documentation: Error: is an example\n".repeat(100), { isError: false })]);
  assert.equal(value.ok, true);
  assert.equal(value.failureDiagnosticsComplete, true);
});

test("a complete failed diagnostic already retained in live context does not veto the card", () => {
  const text = `Error: diagnostic retained outside the cut\n${"context\n".repeat(500)}`;
  const value = buildCard(text, text, [tool(text)]);
  assert.equal(value.ok, true);
  assert.equal(value.failureDiagnosticsComplete, true);
});
