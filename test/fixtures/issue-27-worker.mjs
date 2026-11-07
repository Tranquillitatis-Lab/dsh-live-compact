// Real OS-process/worker barriers for Issue #27. No host profiles or models.
import { existsSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { saveShadow } from "../../index.js";
import { shadowSections } from "../../plan.js";
import { captureOwnedToolResult } from "../../raw.js";
import { listShadowEntries, rotateShadow, shadowFileBody, withShadowRoot, writeShadowFile } from "../../shadow.js";

const config = isMainThread ? JSON.parse(process.argv[2]) : workerData;
const { root, optIn = false, defaultRoot = false } = config;
if (defaultRoot) delete process.env.SPINE_SHADOW_DIR;
else process.env.SPINE_SHADOW_DIR = root;
process.env.SPINE_SHADOW_MAX_BYTES = "1000";
if (optIn) process.env.SPINE_SHADOW_SINGLE_PROCESS = "1";
else delete process.env.SPINE_SHADOW_SINGLE_PROCESS;
const send = (data) => isMainThread ? process.send(data) : parentPort.postMessage(data);
let scans = 0;
const io = { readdir(...args) { scans++; return readdirSync(...args); }, stat: statSync };
let ordinal = 0;

function save(bytes, barrier) {
  const key = "A";
  const message = { role: "user", content: "x" };
  const overhead = Buffer.byteLength(shadowFileBody(key, shadowSections(message))) - 1;
  message.content = "x".repeat(bytes - overhead);
  const file = join(root, key, `cut-${++ordinal}-aaaaaaaa.txt`);
  const logs = [];
  const access = barrier ? { runner({ kind, path }) {
    if (kind === "file" && path.endsWith(".txt")) {
      send({ event: "admitted", pid: process.pid });
      const wait = new Int32Array(new SharedArrayBuffer(4));
      const deadline = Date.now() + 10000;
      while (!existsSync(barrier)) {
        if (Date.now() > deadline) throw new Error("barrier was not released");
        Atomics.wait(wait, 0, 0, 5);
      }
    }
    return true;
  } } : {};
  saveShadow.call({
    ctx: { logger: { info: (line) => logs.push(line) } },
    warnShadowFull() { throw new Error("unexpected full backup"); },
    warnShadowOversize() { throw new Error("unexpected oversize backup"); },
  }, [message], true, file, key, [], access, io);
  return { bytes: statSync(file).size, logs, scans };
}

function command(message) {
  try {
    let result;
    if (message.command === "calibrate") {
      writeShadowFile(join(root, "cut-1-11111111.txt"), "a".repeat(600), {}, { root });
      result = rotateShadow({ dir: root, incomingBytes: 0, cap: 1000, ...io });
    } else if (message.command === "raw") {
      result = captureOwnedToolResult({ dir: join(root, "B"), root, toolCallId: "B", text: "b".repeat(320) });
    } else if (message.command === "save") {
      result = save(120, message.barrier);
    } else if (message.command === "inspect") {
      const rotation = rotateShadow({ dir: root, incomingBytes: 0, cap: 1000, ...io });
      result = { rotation, bytes: listShadowEntries(root).reduce((sum, file) => sum + file.size, 0), scans };
    } else if (message.command === "crash") {
      withShadowRoot(root, () => process.kill(process.pid, "SIGKILL"));
    } else if (message.command === "exit") {
      process.exit(0);
    } else throw new Error("unknown command");
    send({ event: "result", command: message.command, result, pid: process.pid });
  } catch (error) {
    send({ event: "result", command: message.command, error: { code: error.code, message: error.message }, pid: process.pid });
  }
}

if (isMainThread) {
  process.on("message", command);
  send({ event: "ready", pid: process.pid });
} else {
  command({ command: "raw" });
}
