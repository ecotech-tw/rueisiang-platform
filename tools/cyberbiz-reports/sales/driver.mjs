#!/usr/bin/env node

/**
 * CYBERBIZ 商品銷售報表流程。
 *
 * 每家店將原始 XLSX 上傳 Drive，並把整月商品明細匯入 D1；公司統計由查詢時 aggregate。
 * 商品銷售以月份為最小粒度，因此每家店每月只匯出並解析一份 XLSX。
 */
import path from "node:path";
import {
  accessToken,
  uploadXlsx,
} from "../lib/drive.mjs";
import {
  dateRange,
  ensureDir,
  driveFolderIdFromUrl,
  loadConfig,
  loadEnv,
  log,
  monthRange,
  previousMonth,
  reportIngestConfig,
  redact,
  requireEnv,
  salesFilename,
  scopeIdFromStoreName,
  skillPath,
} from "../lib/common.mjs";
import { newPage, openBrowser, screenshot } from "../lib/browser.mjs";
import { exportSalesReport, listStores, login, resolveStore } from "../lib/cyberbiz.mjs";
import { downloadAttachment, whoAmI } from "../lib/gmail-api.mjs";
import { parseSalesReport } from "./parser.mjs";
import { writeMarkdown, terminalSummary } from "../lib/report.mjs";
import { ingestCyberbizReport } from "../lib/report-ingest.mjs";

function parseArgs(argv) {
  const args = { stores: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--month") args.month = argv[++index];
    else if (arg === "--start") args.start = argv[++index];
    else if (arg === "--end") args.end = argv[++index];
    else if (arg === "--store") args.stores.push(argv[++index]);
    else if (arg === "--skip-upload") args.skipUpload = true;
    else if (arg === "--list-stores") args.listStores = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

function help() {
  log([
    "用法：node sales/driver.mjs [--month YYYY-MM | --start YYYY-MM-DD --end YYYY-MM-DD]",
    "                         [--store 店名]... [--skip-upload] [--list-stores] [--headless]",
    "原始 XLSX 上傳 Google Drive，整月商品資料匯入 D1；未設定 ingest token 時只上傳 Drive。",
  ].join("\n"));
}

function monthlyRows(document) {
  return document.rows.map((row) => ({
    reportMonth: document.reportMonth,
    sku: row.sku,
    productName: row.productName,
    category: row.category,
    grossQuantity: Math.round(row.grossQuantity),
    returnQuantity: Math.round(row.returnQuantity),
    netQuantity: Math.round(row.netQuantity),
    salesAmount: Math.round(row.salesAmount),
  }));
}

function partialReportError(document) {
  const details = document.skippedRows.map((row) => (
    `第 ${row.row} 列（銷售 ${row.grossQuantity.toLocaleString("zh-TW")}、退回 ${row.returnQuantity.toLocaleString("zh-TW")}、淨 ${row.netQuantity.toLocaleString("zh-TW")}、售額 ${row.salesAmount.toLocaleString("zh-TW")}）`
  )).join("、");
  return {
    code: "PARTIAL_REPORT",
    message: `已略過 ${document.skippedRows.length} 筆缺少 SKU 的資料列：${details}；其餘 ${document.rows.length} 筆可識別商品仍已處理，請人工補正原始報表。`,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return help();
  if ((args.start || args.end) && args.month) throw new Error("--month 與 --start/--end 只能擇一。");
  if (Boolean(args.start) !== Boolean(args.end)) throw new Error("--start 與 --end 要一起給。");

  const config = await loadConfig();
  const env = await loadEnv();
  requireEnv(env, ["CYBERBIZ_USERNAME", "CYBERBIZ_PASSWORD"]);
  const range = args.start ? dateRange(args.start, args.end) : args.month ? monthRange(args.month) : previousMonth();
  const monthly = range.label === range.start.slice(0, 7) && range.end === monthRange(range.label).end;
  const ingestConfig = !args.skipUpload
    ? reportIngestConfig(env)
    : { enabled: false, missing: [], apiUrl: reportIngestConfig(env).apiUrl };
  if (!args.skipUpload && !ingestConfig.enabled) {
    log(`照常匯出並上傳 Drive，但暫不匯入 D1；缺少：${ingestConfig.missing.join("、")}`);
  }
  const recipientEmail = config.recipientEmail || env.CYBERBIZ_2FA_MAILBOX;
  if (!recipientEmail) throw new Error("config.json 的 recipientEmail 或 .env 的 CYBERBIZ_2FA_MAILBOX 至少要有一個。");

  const selected = args.stores.length ? config.stores.filter((store) => args.stores.includes(store.name)) : config.stores;
  const wanted = selected.map((store) => ({ ...store, driveFolderId: driveFolderIdFromUrl(store.driveFolderUrl || store.driveFolderId) }));
  if (!args.listStores) {
    const unknown = args.stores.filter((name) => !config.stores.some((store) => store.name === name));
    if (unknown.length) throw new Error(`config.json 沒有這些店：${unknown.join("、")}`);
    if (!wanted.length) throw new Error("config.json 的 stores 是空的，請先設定店別。");
  }

  const stagingDir = await ensureDir(path.isAbsolute(config.stagingDir) ? path.join(config.stagingDir, "sales", range.label) : skillPath(config.stagingDir, "sales", range.label));
  const context = await openBrowser({ headless: Boolean(args.headless), downloadDir: stagingDir });
  const run = { label: range.label, start: range.start, end: range.end, stores: [], finishedAt: "" };

  try {
    const page = await newPage(context);
    requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
    const gmailToken = await accessToken({ ...env, GOOGLE_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN });
    const mailbox = await whoAmI(gmailToken);
    log(`Gmail 信箱：${mailbox.emailAddress}`);
    await login(page, {
      origin: config.cyberbizOrigin,
      username: env.CYBERBIZ_USERNAME,
      password: env.CYBERBIZ_PASSWORD,
      gmailToken,
      twoFactor: config.twoFactor,
    });

    if (args.listStores) {
      const stores = await listStores(page, { origin: config.cyberbizOrigin });
      for (const store of stores) log(`  - ${store.name}`);
      return;
    }

    let token = null;
    if (!args.skipUpload) {
      requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
      const missing = wanted.filter((store) => !store.driveFolderId);
      if (missing.length) throw new Error(`這些店還沒設定 Google Drive 資料夾：${missing.map((store) => store.name).join("、")}`);
      token = await accessToken(env);
    }

    for (const store of wanted) {
      const result = { store: store.name, steps: {}, done: false, status: "running" };
      run.stores.push(result);
      try {
        const storeBase = await resolveStore(page, { origin: config.cyberbizOrigin, storeName: store.name });
        const { submittedAt } = await exportSalesReport(page, {
          storeBase,
          recipientEmail,
          startDate: range.start,
          endDate: range.end,
          reportPath: config.salesReportPath,
        });
        result.steps.export = "ok";
        const localPath = await downloadAttachment(gmailToken, {
          expectedName: salesFilename(store.name, range.start, range.end),
          sender: config.attachmentSender,
          downloadDir: stagingDir,
          notBefore: submittedAt,
        });
        result.steps.fetch = "ok";
        const document = range.start.slice(0, 7) === range.end.slice(0, 7)
          ? await parseSalesReport(localPath, {
            scopeType: "store",
            scopeId: scopeIdFromStoreName(store.name),
            scopeName: store.name,
            reportMonth: range.start.slice(0, 7),
            start: range.start,
            end: range.end,
            allowEmpty: true,
          })
          : null;
        result.steps.verify = "ok";
        if (document) result.total = document.totals;

        if (token) {
          const uploaded = await uploadXlsx(token, { filePath: localPath, name: path.basename(localPath), folderId: store.driveFolderId });
          result.steps.upload = "ok";
          result.sheetUrl = uploaded.webViewLink;
        } else {
          result.steps.upload = "skip";
        }

        if (monthly && ingestConfig.enabled) {
          if (!document) throw new Error("完整月份沒有取得可匯入的商品銷售報表。");
          const ingested = await ingestCyberbizReport({
            apiUrl: ingestConfig.apiUrl,
            ingestToken: env.CYBERBIZ_REPORT_INGEST_TOKEN,
            kind: "sales",
            scopeId: scopeIdFromStoreName(store.name),
            scopeName: store.name,
            reportMonth: document.reportMonth,
            rows: monthlyRows(document),
          });
          /*
           * 對不到對應的 SKU 是略過而不是整份失敗，所以這裡要把它們講出來。
           * 不講的話那些營收會安靜地少掉，而且沒有人知道要回來補對應。
           */
          const skipped = ingested?.skippedSkus ?? [];
          if (skipped.length) {
            result.steps.ingest = "partial";
            result.skippedSkus = skipped;
            result.note = `略過 ${skipped.length} 個未對應 SKU：${skipped.join("、")}`;
          } else {
            result.steps.ingest = "ok";
          }
        } else {
          result.steps.ingest = "skip";
          result.note = !monthly
            ? "自訂區間只上傳 Drive，未匯入 D1"
            : args.skipUpload
              ? "--skip-upload，未匯入 D1"
              : `未匯入 D1（缺少：${ingestConfig.missing.join("、")}）`;
        }
        if (document?.skippedRows?.length) {
          result.error = partialReportError(document);
          result.status = "partial";
          result.done = false;
        } else {
          result.status = "done";
          result.done = true;
        }
      } catch (error) {
        result.status = "failed";
        const step = ["export", "fetch", "verify", "upload", "ingest"].find((key) => !result.steps[key]);
        if (step) result.steps[step] = "fail";
        result.error = { code: error.code ?? "UNEXPECTED_ERROR", message: redact(error.message, env) };
        log(`${store.name}：${result.error.message}`);
        try { result.screenshot = await screenshot(page, `${range.label}-${store.name}-sales-error`, { kind: "sales" }); } catch {}
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    if (run.stores.length) {
      const reportsDir = path.isAbsolute(config.reportsDir) ? path.join(config.reportsDir, "sales") : skillPath(config.reportsDir, "sales");
      run.reportPath = await writeMarkdown(run, reportsDir, { kind: "sales" });
      log(terminalSummary(run, { kind: "sales" }));
    }
    await context.close();
  }

  if (run.stores.some((store) => !store.done)) process.exitCode = 1;
}

main().catch((error) => {
  log(`執行失敗：${redact(error.message, {})}`);
  process.exitCode = 1;
});
