import { parentPort, workerData } from "node:worker_threads";
import {
  attachShadowAccessFuse, defaultShadowAccessRunner, shadowAccessFused, tightenShadow,
} from "../../shadow.js";

attachShadowAccessFuse(workerData.accessFuse);
parentPort.postMessage({ ready: true, fused: shadowAccessFused() });
parentPort.on("message", ({ action }) => {
  let code;
  let calls = 0;
  let fusedBeforeCheck;
  if (action === "trip") {
    // Simulate the native Windows system-root failure before any OS helper.
    try { defaultShadowAccessRunner({ path: workerData.root, kind: "dir", platform: "win32", env: {} }); }
    catch (error) { code = error.code; }
  } else if (action === "check") {
    const gate = new Int32Array(workerData.checkGate);
    parentPort.postMessage({ waiting: true });
    Atomics.wait(gate, 0, 0, 2000);
    if (Atomics.load(gate, 0) !== 1) throw new Error("fuse test barrier timed out");
    fusedBeforeCheck = shadowAccessFused();
    try {
      tightenShadow(workerData.root, "dir", {
        platform: "win32", env: { SystemRoot: "C:\\Windows" },
        execFile() { calls++; throw new Error("unexpected ACL helper"); },
      });
    } catch (error) { code = error.code; }
  }
  parentPort.postMessage({ fused: shadowAccessFused(), fusedBeforeCheck, code, calls });
});
