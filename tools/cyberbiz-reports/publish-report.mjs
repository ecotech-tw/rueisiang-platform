#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseSalesReport } from "./sales/parser.mjs";
import { combineCyberbizWorkbook } from "./lib/combined-xlsx.mjs";
import { accessToken, uploadXlsx } from "./lib/drive.mjs";
import { loadConfig, loadEnv, monthRange, skillPath, ensureDir, reportPublishConfig } from "./lib/common.mjs";
import { parsePayoutReport } from "./payout/parser.mjs";
import { publishCyberbizReport } from "./lib/report-publish.mjs";
import { uploadAndVerifyReportWorkbook } from "./lib/report-drive.mjs";

function parseArgs(argv) {
  const args = { storeIds: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--month") args.month = argv[++index];
    else if (arg === "--kind") args.kind = argv[++index];
    else if (arg === "--scope-id") args.scopeId = argv[++index];
    else if (arg === "--scope-name") args.scopeName = argv[++index];
    else if (arg === "--sales-xlsx") args.salesXlsx = argv[++index];
    else if (arg === "--payout-xlsx") args.payoutXlsx = argv[++index];
    else if (arg === "--drive-folder-id") args.driveFolderId = argv[++index];
    else if (arg === "--store-id") args.storeIds.push(argv[++index]);
    else if (arg === "--skip-drive") args.skipDrive = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

function required(args, name) {
  const value = args[name]?.trim();
  if (!value) throw new Error(`缺少 --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}。`);
  return value;
}

function help() {
  console.log([
    "用法：node publish-report.mjs --month YYYY-MM --scope-id <id> --scope-name <name>",
    "  --kind sales|payout|bundle --sales-xlsx <path> --payout-xlsx <path>",
    "  [--store-id <id>]... [--drive-folder-id <id>] [--skip-drive]",
    "",
    "XLSX 已由 CYBERBIZ/Gmail 下載後，這個指令會 parse normalized JSON；bundle 才會產生 combined XLSX、",
    "上傳原始與 normalized 檔到 NAS，先寫 staged；未指定 --skip-drive 時再上傳 Drive 並切 published。",
  ].join("\n"));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();

  const month = required(args, "month");
  const scopeId = required(args, "scopeId");
  const scopeName = required(args, "scopeName");
  const kind = args.kind ?? (args.salesXlsx && args.payoutXlsx ? "bundle" : args.salesXlsx ? "sales" : "payout");
  if (!["sales", "payout", "bundle"].includes(kind)) throw new Error("--kind 必須是 sales、payout 或 bundle。");
  const salesXlsx = args.salesXlsx ? path.resolve(args.salesXlsx) : null;
  const payoutXlsx = args.payoutXlsx ? path.resolve(args.payoutXlsx) : null;
  if ((kind === "sales" || kind === "bundle") && !salesXlsx) throw new Error("sales report 需要 --sales-xlsx。");
  if ((kind === "payout" || kind === "bundle") && !payoutXlsx) throw new Error("payout report 需要 --payout-xlsx。");
  const range = monthRange(month);
  const env = await loadEnv();
  const config = await loadConfig();
  const outputDir = await ensureDir(path.join(skillPath("staging"), "bundle", month, scopeId));

  const salesDocument = salesXlsx ? await parseSalesReport(salesXlsx, {
    scopeType: scopeId === "company" ? "company" : "store",
    scopeId,
    scopeName,
    reportMonth: month,
  }) : null;
  const payoutDocument = payoutXlsx ? await parsePayoutReport(payoutXlsx, {
    scopeType: scopeId === "company" ? "company" : "store",
    scopeId,
    scopeName,
    start: range.start,
    end: range.end,
    firstDataRow: config.firstDataRow,
  }) : null;
  const salesJsonPath = salesDocument ? path.join(outputDir, "sales.normalized.json") : null;
  const payoutJsonPath = payoutDocument ? path.join(outputDir, "payout.normalized.json") : null;
  const combinedPath = salesDocument && payoutXlsx ? path.join(outputDir, "combined.xlsx") : null;
  if (salesDocument && salesJsonPath) await fs.writeFile(salesJsonPath, `${JSON.stringify(salesDocument, null, 2)}\n`, "utf8");
  if (payoutDocument && payoutJsonPath) await fs.writeFile(payoutJsonPath, `${JSON.stringify(payoutDocument, null, 2)}\n`, "utf8");
  if (combinedPath && payoutXlsx && salesDocument) await combineCyberbizWorkbook({ payoutPath: payoutXlsx, outputPath: combinedPath, salesDocument });

  if (!args.skipDrive && !args.driveFolderId) throw new Error("未使用 --skip-drive 時需要 --drive-folder-id。 ");
  const result = await publishCyberbizReport({
    nasUrl: required(env, "NAS_STORAGE_URL"),
    nasToken: required(env, "NAS_STORAGE_TOKEN"),
    apiUrl: reportPublishConfig(env).apiUrl,
    ingestToken: required(env, "CYBERBIZ_REPORT_INGEST_TOKEN"),
    reportMonth: month,
    reportKind: kind,
    scopeType: scopeId === "company" ? "company" : "store",
    scopeId,
    scopeName,
    coverageStart: range.start,
    coverageEnd: range.end,
    storeIdsJson: JSON.stringify(args.storeIds.length ? args.storeIds : (scopeId === "company" ? [] : [scopeId])),
    parserVersion: "cyberbiz-report-v1",
    salesSourcePath: salesXlsx,
    payoutSourcePath: payoutXlsx,
    salesJsonPath,
    payoutJsonPath,
    combinedWorkbookPath: combinedPath,
    afterStaged: args.skipDrive ? undefined : async () => {
      const token = await accessToken(env);
      const drivePath = combinedPath ?? salesXlsx ?? payoutXlsx;
      if (!drivePath) throw new Error("沒有可上傳的 report XLSX。");
      const name = path.basename(drivePath);
      const uploaded = combinedPath
        ? await uploadAndVerifyReportWorkbook({ token, filePath: drivePath, name, folderId: args.driveFolderId, firstDataRow: config.firstDataRow })
        : await uploadXlsx(token, { filePath: drivePath, name, folderId: args.driveFolderId });
      return { driveFileId: uploaded.id, driveUrl: uploaded.webViewLink };
    },
  });
  console.log(JSON.stringify({
    status: result.status,
    reportMonth: result.reportMonth,
    scopeId: result.scopeId,
    sourceChecksum: result.sourceChecksum,
    driveFileId: result.driveFileId,
    nas: {
      salesObjectKey: result.salesObjectKey,
      payoutObjectKey: result.payoutObjectKey,
      combinedWorkbookObjectKey: result.combinedWorkbookObjectKey,
    },
  }, null, 2));
}

try {
  await main();
} catch (error) {
  console.error(`[${error.code ?? "PUBLISH_FAILED"}] ${error.message}`);
  process.exitCode = 1;
}
