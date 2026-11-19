import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const routeRoots = [
  join(repoRoot, "apps", "hr", "src", "routes"),
  join(repoRoot, "apps", "portal", "src", "routes", "hr"),
];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) files.push(path);
  }
  return files;
}

const failures = [];
for (const routeRoot of routeRoots) {
  for (const file of await walk(routeRoot)) {
    const source = await readFile(file, "utf8");
    if (/<table\b/i.test(source)) {
      failures.push(`${relative(repoRoot, file)} contains a raw <table>; use DataTable.`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log("UI contract check passed: route table wrappers are clean.");
}
