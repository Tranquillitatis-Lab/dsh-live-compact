import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, root] = process.argv.slice(2);
if (!installed || !root) throw new Error("usage: crash-writer.mjs INSTALLED ROOT");
process.env.SPINE_SHADOW_DIR = root;
const { withShadowRoot } = await import(pathToFileURL(join(installed, "shadow.js")).href);
withShadowRoot(root, () => {
  const lock = JSON.parse(readFileSync(join(root, ".spine-rotation.lock"), "utf8"));
  if (lock.pid !== process.pid) throw new Error("crash writer must own the root lock");
  writeFileSync(join(root, "crash-ready.json"), JSON.stringify({ pid: process.pid, lock }));
  process.kill(process.pid, "SIGKILL");
});
import { readFileSync, writeFileSync } from "node:fs";
