import { parentPort, workerData } from "node:worker_threads";
import { saveShadowTransaction } from "./shadow.js";

try {
  const result = saveShadowTransaction(workerData);
  parentPort.postMessage({ ok: true, result });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: {
      name: error?.name || "Error",
      message: error?.message || String(error),
      code: error?.code,
    },
  });
}
