import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { captureToolResult, PRUNE_MARKER } from "../raw.js";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");

test("#62 filters inherited input-type flags before starting the file worker", () => {
  assert.match(indexSource, /execArgv: process\.execArgv\.filter\(\(arg\) => !String\(arg\)\.startsWith\("--input-type="\)\)/);
});

test("#62 already-pruned capture remains retryable", () => {
  const dir = mkdtempSync(join(tmpdir(), "spine-already-pruned-"));
  const result = captureToolResult({ dir, toolCallId: "call-pruned", text: `x ${PRUNE_MARKER}` });
  assert.deepEqual(result, { ok: false, reason: "already-pruned", toolCallId: "call-pruned", retryable: true });
});
