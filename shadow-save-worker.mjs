import { parentPort, workerData } from "node:worker_threads";
import { attachShadowAccessFuse, saveShadowTransaction } from "./shadow.js";

const managed = workerData?.spineWorker === 1;
if (managed) attachShadowAccessFuse(workerData.accessFuse);

// SPINE_SAVE_TRANSFER=1 moves the body across as a transferred ArrayBuffer and
// the arriving view is a plain Uint8Array over memory detached on the sender.
// Wrap it as a zero-copy Buffer view so saveShadowTransaction/writeShadowFile
// keep consuming bytes unchanged. String bodies (structured-clone path and the
// standalone workerData path) and real Buffers pass through untouched.
function normalizeShadowBody(payload) {
  const body = payload?.body;
  if (typeof body === "string" || body == null || Buffer.isBuffer(body)) return payload;
  if (ArrayBuffer.isView(body)) {
    return { ...payload, body: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
  }
  if (body instanceof ArrayBuffer) {
    return { ...payload, body: Buffer.from(body, 0, body.byteLength) };
  }
  return payload;
}

async function handle(id, payload) {
  try {
    const result = saveShadowTransaction(normalizeShadowBody(payload));
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      code: error?.code,
    } });
  }
}

let queue = Promise.resolve();
if (workerData && !managed) handle(0, workerData);
parentPort.on("message", ({ id, payload }) => {
  queue = queue.then(() => handle(id, payload));
});
