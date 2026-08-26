#!/usr/bin/env node

/**
 * CYBERBIZ 商品銷售報表流程。
 *
 * 完整月份：每家店上傳 Drive，另外把 normalized JSON 寫入 NAS 並 publish sales manifest；
 * 全部店別成功時，再產生一份 company aggregate，讓 AI 查公司營收只需一次查詢。
 * 自訂區間：只上傳原始 XLSX 到 Drive，不建立 AI manifest。
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  accessToken,
  getFile,
  uploadXlsx,
} from "./lib/drive.mjs";
import {
  dateRange,
  driveFolderIdFromUrl,
  ensureDir,
  loadConfig,
  loadEnv,
  log,
  monthRange,
  previousMonth,
  reportPublishConfig,
  redact,
  requireEnv,
  salesFilename,
  skillPath,
} from "./lib/common.mjs";
import { newPage, openBrowser, screenshot } from "./lib/browser.mjs";
import { exportSalesReport, listStores, login, resolveStore } from "./lib/cyberbiz.mjs";
import { downloadAttachment, whoAmI } from "./lib/gmail-api.mjs";
import { parseSalesReport } from "../cyberbiz-monthly-sales/lib/sales.mjs";
import { aggregateSalesDocuments } from "../cyberbiz-monthly-sales/lib/aggregate.mjs";
import { publishCyberbizReport } from "./lib/report-publish.mjs";
import { writeMarkdown, terminalSummary } from "./lib/report.mjs";

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

function scopeIdFromStoreName(name) {
  // 用 UTF-8 base64url 保留中文店名的穩定性，同一店名在 API 與 runner 會得到同一個 NAS-safe ID。
  return `store-${Buffer.from(name, "utf8").toString("base64url")}`.slice(0, 100);
}

function help() {
  log([
    "用法：node sales-driver.mjs [--month YYYY-MM | --start YYYY-MM-DD --end YYYY-MM-DD]",
    "                         [--store 店名]... [--skip-upload] [--list-stores] [--headless]",
    "完整月份才會建立 AI manifest；自訂日期只上傳 Google Drive。",
  ].join("\n"));
}

async function publishStore({ env, apiUrl, range, store, localPath, document, drive }) {
  const scopeId = scopeIdFromStoreName(store.name);
  const outputDir = await ensureDir(path.join(skillPath("staging"), range.label, scopeId));
  const jsonPath = path.join(outputDir, "sales.normalized.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return publishCyberbizReport({
    nasUrl: env.NAS_STORAGE_URL,
    nasToken: env.NAS_STORAGE_TOKEN,
    apiUrl,
    ingestToken: env.CYBERBIZ_REPORT_INGEST_TOKEN,
    reportMonth: range.label,
    reportKind: "sales",
    scopeType: "store",
    scopeId,
    scopeName: store.name,
    coverageStart: range.start,
    coverageEnd: range.end,
    storeIdsJson: JSON.stringify([scopeId]),
    parserVersion: "cyberbiz-sales-v1",
    salesSourcePath: localPath,
    salesJsonPath: jsonPath,
    afterStaged: async () => drive,
  });
}

async function publishCompany({ env, apiUrl, range, documents }) {
  const document = aggregateSalesDocuments(documents, {
    scopeName: "公司整體",
    parserVersion: "cyberbiz-sales-company-v1",
  });
  const outputDir = await ensureDir(path.join(skillPath("staging"), range.label, "company"));
  const jsonPath = path.join(outputDir, "sales.normalized.json");
  await fs.writeFile(jsonPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return publishCyberbizReport({
    nasUrl: env.NAS_STORAGE_URL,
    nasToken: env.NAS_STORAGE_TOKEN,
    apiUrl,
    ingestToken: env.CYBERBIZ_REPORT_INGEST_TOKEN,
    reportMonth: range.label,
    reportKind: "sales",
    scopeType: "company",
    scopeId: "company",
    scopeName: "公司整體",
    coverageStart: range.start,
    coverageEnd: range.end,
    storeIdsJson: JSON.stringify(documents.map((item) => item.scopeId)),
    parserVersion: "cyberbiz-sales-company-v1",
    salesJsonPath: jsonPath,
  });
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
  const manifestConfig = monthly && !args.skipUpload
    ? reportPublishConfig(env)
    : { enabled: false, missing: [], apiUrl: reportPublishConfig(env).apiUrl };
  if (monthly && !args.skipUpload && !manifestConfig.enabled) {
    log(`完整月份將照常匯出並上傳 Drive，但暫不建立 AI manifest；缺少：${manifestConfig.missing.join("、")}`);
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

  const stagingDir = await ensureDir(path.isAbsolute(config.stagingDir) ? path.join(config.stagingDir, range.label) : skillPath(config.stagingDir, range.label));
  const context = await openBrowser({ headless: Boolean(args.headless), downloadDir: stagingDir });
  const run = { label: range.label, start: range.start, end: range.end, stores: [], finishedAt: "" };
  const documents = [];

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
      const result = { store: store.name, steps: {}, done: false };
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
        const document = monthly ? await parseSalesReport(localPath, {
          scopeType: "store",
          scopeId: scopeIdFromStoreName(store.name),
          scopeName: store.name,
          reportMonth: range.start.slice(0, 7),
        }) : null;
        result.steps.verify = "ok";
        if (document) result.total = document.totals;

        let drive = null;
        if (token) {
          const uploaded = await uploadXlsx(token, { filePath: localPath, name: path.basename(localPath), folderId: store.driveFolderId });
          drive = { driveFileId: uploaded.id, driveUrl: uploaded.webViewLink };
          result.steps.upload = "ok";
          result.sheetUrl = uploaded.webViewLink;
        } else {
          result.steps.upload = "skip";
        }

        if (monthly && manifestConfig.enabled) {
          if (!drive) throw new Error("完整月份要建立 manifest，必須先上傳 Drive。");
          await publishStore({ env, apiUrl: manifestConfig.apiUrl, range, store, localPath, document, drive });
          result.steps.manifest = "ok";
          documents.push(document);
        } else {
          result.steps.manifest = "skip";
          if (monthly) {
            result.note = args.skipUpload
              ? "--skip-upload，未建立 AI manifest"
              : `未建立 AI manifest（缺少：${manifestConfig.missing.join("、")}）`;
          }
        }
        result.done = true;
      } catch (error) {
        const step = ["export", "fetch", "verify", "upload", "manifest"].find((key) => !result.steps[key]);
        if (step) result.steps[step] = "fail";
        result.error = { code: error.code ?? "UNEXPECTED_ERROR", message: redact(error.message, env) };
        log(`${store.name}：${result.error.message}`);
        try { result.screenshot = await screenshot(page, `${range.label}-${store.name}-sales-error`); } catch {}
      }
    }

    const allSelected = wanted.length === config.stores.length;
    if (monthly && manifestConfig.enabled && allSelected && run.stores.every((store) => store.done) && documents.length === wanted.length) {
      await publishCompany({ env, apiUrl: manifestConfig.apiUrl, range, documents });
      run.companyManifest = "ok";
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    if (run.stores.length) {
      const reportsDir = path.isAbsolute(config.reportsDir) ? config.reportsDir : skillPath(config.reportsDir);
      run.reportPath = await writeMarkdown(run, reportsDir, { kind: "sales" });
      log(terminalSummary(run, { kind: "sales" }));
    }
    await context.close();
  }

  if (run.stores.some((store) => !store.done) || (monthly && manifestConfig.enabled && wanted.length === config.stores.length && run.companyManifest !== "ok")) process.exitCode = 1;
}

main().catch((error) => {
  log(`執行失敗：${redact(error.message, {})}`);
  process.exitCode = 1;
});
