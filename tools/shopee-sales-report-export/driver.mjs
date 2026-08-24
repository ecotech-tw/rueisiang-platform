#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    else if (arg === "--skip-upload" || arg === "--export" || arg === "--headless") args[keyOf(arg.slice(2))] = true;
    else if (arg.startsWith("--")) args[keyOf(arg.slice(2))] = argv[++i];
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

function usage() {
  return [
    "用法：node driver.mjs --input <蝦皮xlsx> --password <密碼> [--output <新xlsx>] [--drive-folder-url <Drive資料夾連結>]",
    "     node driver.mjs --export --start YYYY-MM-DD --end YYYY-MM-DD [--drive-folder-url <連結>] [--headless]",
    "不帶 --start/--end 時預設上個月；--skip-upload 只產出新檔，不連 Drive。",
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { log(usage()); return; }
  if (args.input && args.export) throw new Error("--input 與 --export 只能擇一。");
  if (!args.input && !args.export) throw new Error(`請提供 --input 或 --export。\n${usage()}`);
  const config = await loadConfig();
  const env = await loadEnv();
  const range = args.start || args.end ? dateRange(args.start, args.end) : previousMonth();
  const stagingDir = await ensureDir(path.resolve(toolPath(config.stagingDir), range.label));
  const outputPath = path.resolve(args.output || path.join(stagingDir, `Order.completed.${range.start.replaceAll("-", "")}_${range.end.replaceAll("-", "")}.xlsx`));
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-sales-report-"));
  const rawPath = args.input ? path.resolve(args.input) : path.join(stagingDir, "shopee-export.xlsx");
  let context;
  try {
    if (args.export) {
      const { openBrowser } = await import("./lib/browser.mjs");
      const { exportShopeeReport } = await import("./lib/shopee.mjs");
      context = await openBrowser({ headless: Boolean(args.headless), downloadDir: stagingDir });
      const page = context.pages()[0] ?? await context.newPage();
      await exportShopeeReport(page, { reportUrl: config.reportUrl, start: range.start, end: range.end, downloadDir: stagingDir, selectors: config.selectors, headless: Boolean(args.headless) });
      const downloads = (await fs.readdir(stagingDir)).filter((file) => /\.xlsx?$/i.test(file)).sort((a, b) => b.localeCompare(a));
      if (!downloads[0]) throw new Error("蝦皮沒有產生 xlsx 下載檔。");
      await fs.copyFile(path.join(stagingDir, downloads[0]), rawPath);
    }
    const unlockedPath = path.join(tempDir, "unlocked.xlsx");
    await prepareWorkbook(rawPath, unlockedPath, args.password ?? "");
    const summary = await transformShopeeWorkbook(unlockedPath, outputPath, { sourceSheet: args.sourceSheet || config.sourceSheet });
    log(`已產出：${outputPath}`);
    log(`業績合計：${summary.totalPerformance.toLocaleString("zh-TW")}`);
    log(`商品數量合計：${summary.totalQuantity.toLocaleString("zh-TW")}`);

    let uploaded = null;
    if (!args.skipUpload) {
      const folderId = driveFolderIdFromUrl(args.driveFolderUrl || config.driveFolderUrl);
      if (!folderId) throw new Error("請提供 --drive-folder-url，或在 config.json 設定 driveFolderUrl。");
      requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
      const token = await accessToken(env);
      const name = path.basename(outputPath);
      const existing = await findByName(token, { parentId: folderId, name });
      uploaded = existing || await uploadXlsx(token, { filePath: outputPath, name, folderId });
      log(existing ? `Drive 已有同名檔案，未重複上傳：${existing.webViewLink ?? name}` : `已上傳到 Drive：${uploaded.webViewLink ?? name}`);
    }
    await ensureDir(path.resolve(toolPath(config.reportsDir)));
    await fs.writeFile(path.resolve(toolPath(config.reportsDir), `${range.label}-蝦皮銷售報表.md`), [
      `# 蝦皮銷售報表 ${range.label}`, "", `- 對帳區間：${range.start} ~ ${range.end}`, `- 業績合計：${summary.totalPerformance.toLocaleString("zh-TW")}`, `- 商品銷售數量合計：${summary.totalQuantity.toLocaleString("zh-TW")}`, `- 不重複訂單：${summary.uniqueOrders}`, `- 商品組合：${summary.uniqueProducts}`, uploaded?.webViewLink ? `- Drive：${uploaded.webViewLink}` : "- Drive：未上傳", "",
    ].join("\n"), "utf8");
  } catch (error) {
    log(`執行失敗：[${error.code ?? "UNEXPECTED_ERROR"}] ${redact(error.message, env)}`);
    process.exitCode = 1;
  } finally {
    await context?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => { log(`執行失敗：${error.message}`); process.exitCode = 1; });
