import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const routeRoots = [
  join(repoRoot, "apps", "hr", "src", "routes"),
  join(repoRoot, "apps", "portal", "src", "routes", "hr"),
];
const appComponentStyles = [
  join(repoRoot, "apps", "hr", "src", "styles", "components.css"),
  join(repoRoot, "apps", "portal", "src", "styles", "components.css"),
];
const sharedStyles = join(repoRoot, "packages", "ui", "components.css");
const sharedPrimitiveSelectors = [
  ".table-scroll",
  ".data-table",
  ".status",
  ".ui-alert",
  ".empty-state",
  ".admin-form",
  ".admin-form.toolbar",
  ".filter-control",
  ".filter-select-control",
  ".pager",
  ".pager-meta",
  ".pager-size",
  ".pager-nav",
  ".pager-page",
  ".sort-header",
  ".segmented-control",
  ".modal-backdrop",
  ".modal-card",
  ".confirm-card",
  ".confirm-body",
  ".panel",
  ".field",
  ".primary-button",
  ".ghost-button",
  ".icon-button",
  ".filter-chip",
  ".chip-action",
  ".link-button",
  ".tooltip-anchor",
  ".tooltip",
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

const sharedSource = await readFile(sharedStyles, "utf8");
for (const selector of sharedPrimitiveSelectors) {
  const selectorPattern = new RegExp(`^${selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*\\{`, "m");
  if (!selectorPattern.test(sharedSource)) {
    failures.push(`${relative(repoRoot, sharedStyles)} is missing ${selector}.`);
  }
  for (const file of appComponentStyles) {
    const source = await readFile(file, "utf8");
    if (selectorPattern.test(source)) {
      failures.push(`${relative(repoRoot, file)} duplicates shared base selector ${selector}.`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`UI contract check passed: ${sharedPrimitiveSelectors.length} shared base selectors and route table wrappers are clean.`);
}
