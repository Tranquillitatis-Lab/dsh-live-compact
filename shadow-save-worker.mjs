import { parentPort, workerData } from "node:worker_threads";
import { saveShadowTransaction } from "./shadow.js";

async function handle(id, payload) {
  try {
    const result = saveShadowTransaction(payload);
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
if (workerData) handle(0, workerData);
parentPort.on("message", ({ id, payload }) => {
  queue = queue.then(() => handle(id, payload));
});
