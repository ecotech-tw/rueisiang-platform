#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { dateRange, driveFolderIdFromUrl, ensureDir, loadConfig, loadEnv, log, previousMonth, redact, requireEnv, toolPath } from "./lib/common.mjs";
import { prepareWorkbook } from "./lib/decrypt.mjs";
import { accessToken, findByName, uploadXlsx } from "./lib/drive.mjs";
import { transformShopeeWorkbook } from "./lib/xlsx.mjs";

function parseArgs(argv) {
  const args = {};
  const keyOf = (value) => value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") args.help = true;
    else if (arg === "--skip-upload") args[keyOf(arg.slice(2))] = true;
    else if (arg.startsWith("--")) args[keyOf(arg.slice(2))] = argv[++i];
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

function usage() {
  return [
    "用法：node driver.mjs --input <蝦皮xlsx> --password <密碼> [--output <新xlsx>] [--drive-folder-url <Drive資料夾連結>]",
    "不帶 --start/--end 時預設上個月；--skip-upload 只產出新檔，不連 Drive。",
  ].join("\n");
}

/**
 * 整理一份使用者已下載的蝦皮報表。這個函式由 CLI 與 GitHub Actions 使用，
 * 因此不會嘗試登入蝦皮。
 */
export async function processShopeeWorkbook({ inputPath, password = "", outputPath, driveFolderUrl = "", sourceSheet, start, end, skipUpload = false, config: suppliedConfig, env: suppliedEnv } = {}) {
  if (!inputPath) throw new Error("請提供 inputPath。");
  const config = suppliedConfig ?? await loadConfig();
  const env = suppliedEnv ?? await loadEnv();
  const range = start || end ? dateRange(start, end) : previousMonth();
  const stagingDir = await ensureDir(path.resolve(toolPath(config.stagingDir), range.label));
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath || path.join(stagingDir, `Order.completed.${range.start.replaceAll("-", "")}_${range.end.replaceAll("-", "")}.xlsx`));
  await ensureDir(path.dirname(resolvedOutput));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-sales-report-"));

  try {
    const unlockedPath = path.join(tempDir, "unlocked.xlsx");
    await prepareWorkbook(resolvedInput, unlockedPath, password);
    const summary = await transformShopeeWorkbook(unlockedPath, resolvedOutput, { sourceSheet: sourceSheet || config.sourceSheet });

    let uploaded = null;
    if (!skipUpload) {
      const folderId = driveFolderIdFromUrl(driveFolderUrl || config.driveFolderUrl);
      if (!folderId) throw new Error("請提供 --drive-folder-url，或在 config.json 設定 driveFolderUrl。");
      requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
      const token = await accessToken(env);
      const name = path.basename(resolvedOutput);
      const existing = await findByName(token, { parentId: folderId, name });
      uploaded = existing || await uploadXlsx(token, { filePath: resolvedOutput, name, folderId });
      log(existing ? `Drive 已有同名檔案，未重複上傳：${existing.webViewLink ?? name}` : `已上傳到 Drive：${uploaded.webViewLink ?? name}`);
    }

    await ensureDir(path.resolve(toolPath(config.reportsDir)));
    await fs.writeFile(path.resolve(toolPath(config.reportsDir), `${range.label}-蝦皮銷售報表.md`), [
      `# 蝦皮銷售報表 ${range.label}`, "", `- 對帳區間：${range.start} ~ ${range.end}`, `- 業績合計：${summary.totalPerformance.toLocaleString("zh-TW")}`, `- 商品銷售數量合計：${summary.totalQuantity.toLocaleString("zh-TW")}`, `- 不重複訂單：${summary.uniqueOrders}`, `- 商品組合：${summary.uniqueProducts}`, uploaded?.webViewLink ? `- Drive：${uploaded.webViewLink}` : "- Drive：未上傳", "",
    ].join("\n"), "utf8");

    return { outputPath: resolvedOutput, summary, uploaded, range };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { log(usage()); return; }
  if (!args.input) throw new Error(`請提供 --input。\n${usage()}`);
  const result = await processShopeeWorkbook({
    inputPath: args.input,
    password: args.password ?? "",
    outputPath: args.output,
    driveFolderUrl: args.driveFolderUrl,
    sourceSheet: args.sourceSheet,
    start: args.start,
    end: args.end,
    skipUpload: Boolean(args.skipUpload),
  });
  log(`已產出：${result.outputPath}`);
  log(`業績合計：${result.summary.totalPerformance.toLocaleString("zh-TW")}`);
  log(`商品數量合計：${result.summary.totalQuantity.toLocaleString("zh-TW")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(async (error) => {
    const env = await loadEnv();
    log(`執行失敗：[${error.code ?? "UNEXPECTED_ERROR"}] ${redact(error.message, env)}`);
    process.exitCode = 1;
  });
}
