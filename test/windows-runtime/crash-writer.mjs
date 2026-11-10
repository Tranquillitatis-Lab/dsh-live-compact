import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [installed, root] = process.argv.slice(2);
if (!installed || !root) throw new Error("usage: crash-writer.mjs INSTALLED ROOT");
process.env.SPINE_SHADOW_DIR = root;
const { withShadowRoot } = await import(pathToFileURL(join(installed, "shadow.js")).href);
withShadowRoot(root, () => {
  process.kill(process.pid, "SIGKILL");
});
