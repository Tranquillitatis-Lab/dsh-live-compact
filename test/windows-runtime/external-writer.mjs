import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, countText = "320"] = process.argv.slice(2);
if (!root) throw new Error("usage: external-writer.mjs ROOT [COUNT]");
const count = Number.parseInt(countText, 10);
if (!Number.isInteger(count) || count < 1) throw new Error("invalid mutation count");
const dir = join(root, "external-old-writer");
mkdirSync(dir, { recursive: true });
const stats = { status: "PASS", count, created: 0, overwritten: 0, renamed: 0, deleted: 0, races: 0 };
const pause = () => new Promise((resolve) => setTimeout(resolve, 3));

for (let index = 0; index < count; index += 1) {
  const stem = String(index + 1);
  const file = join(dir, `cut-${stem}-eeeeeeee.txt`);
  const renamed = join(dir, `official-${stem}-eeeeeeee.txt`);
  writeFileSync(file, `# spine-session external-old-writer\nexternal mutation ${index}\n`);
  stats.created += 1;
  if (index % 2 === 0) {
    writeFileSync(file, `# spine-session external-old-writer\nexternal overwrite ${index}\n`);
    stats.overwritten += 1;
  }
  if (index % 3 === 0) {
    try {
      renameSync(file, renamed);
      stats.renamed += 1;
    } catch (error) {
      if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      stats.races += 1;
    }
  }
  if (index % 5 === 0) {
    const target = existsSync(renamed) ? renamed : file;
    try {
      unlinkSync(target);
      stats.deleted += 1;
    } catch (error) {
      if (!['ENOENT', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      stats.races += 1;
    }
  }
  await pause();
}
console.log(JSON.stringify(stats));
