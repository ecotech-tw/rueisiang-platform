import process from "node:process";
import { parseSalesReport } from "./lib/sales.mjs";

const [filePath, scopeId = "store", scopeName = ""] = process.argv.slice(2);
if (!filePath) {
  console.error("用法：node parse.mjs <sales.xlsx> [scopeId] [scopeName]");
  process.exitCode = 2;
} else {
  const document = await parseSalesReport(filePath, { scopeId, scopeName });
  console.log(JSON.stringify(document, null, 2));
}
