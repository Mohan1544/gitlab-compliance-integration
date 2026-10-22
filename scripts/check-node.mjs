// Fails fast with a clear message on an unsupported Node.js version, instead of a confusing
// error deep inside Vitest, Vite, or node:sqlite. The supported version is pinned in .nvmrc.
import { readFileSync } from "node:fs";

const pinned = readFileSync(new URL("../.nvmrc", import.meta.url), "utf8").trim();
const [requiredMajor] = pinned.split(".").map(Number);
const [major] = process.versions.node.split(".").map(Number);

if (major !== requiredMajor) {
  console.error(`\nThis project requires Node.js ${requiredMajor}.x (tested on ${pinned}); you are running ${process.version}.`);
  console.error(`Install Node.js ${pinned} (for example: nvm install ${pinned} && nvm use ${pinned}) and run the command again.\n`);
  process.exit(1);
}

try {
  await import("node:sqlite");
} catch {
  console.error(`\nNode.js ${process.version} does not provide the built-in node:sqlite module this project uses for storage.\n`);
  process.exit(1);
}
