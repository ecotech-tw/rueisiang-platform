#!/usr/bin/env node
/**
 * CYBERBIZ 出金表流程。
 *
 *   node payout/driver.mjs                      # 上個月、config.json 裡所有店
 *   node payout/driver.mjs --month 2026-07      # 指定月份
 *   node payout/driver.mjs --start 2026-07-05 --end 2026-07-20   # 指定起訖日
 *   node payout/driver.mjs --store 台南新光西門   # 只跑一家（可重複）
 *   node payout/driver.mjs --skip-upload        # 只做匯出與取檔，不碰 Drive
 *   node payout/driver.mjs --list-stores        # 印出後台所有 POS 商店後結束
 *   node payout/driver.mjs --headless           # 不開視窗（2FA 或登入卡住時會看不到畫面）
 */
import path from "node:path";
import {
  dateRange,
  ensureDir,
  driveFolderIdFromUrl,
  loadConfig,
  loadEnv,
  log,
  monthRange,
  payoutFilename,
  previousMonth,
  reportIngestConfig,
  redact,
  requireEnv,
  parseStoresInput,
  storeScopeId,
  skillPath,
} from "../lib/common.mjs";
import { newPage, openBrowser, screenshot } from "../lib/browser.mjs";
import { exportPayoutReport, listStores, login, resolveStore } from "../lib/cyberbiz.mjs";
import { downloadAttachment, whoAmI } from "../lib/gmail-api.mjs";
import { parsePayoutReport, verifyPayoutFile } from "./parser.mjs";
import { addPayoutColumns } from "./columns.mjs";
import {
  accessToken,
  findByName,
  getFile,
  uploadXlsx,
  verifyFormulaByTempCopy,
} from "../lib/drive.mjs";
import { terminalSummary, writeMarkdown } from "../lib/report.mjs";
import { ingestCyberbizReport, payoutIngestRows } from "../lib/report-ingest.mjs";

function parseArgs(argv) {
  const args = { stores: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--month") args.month = argv[++i];
    else if (arg === "--start") args.start = argv[++i];
    else if (arg === "--end") args.end = argv[++i];
    else if (arg === "--store") args.stores.push(argv[++i]);
    else if (arg === "--skip-upload") args.skipUpload = true;
    else if (arg === "--list-stores") args.listStores = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    log(
      [
        "用法：node payout/driver.mjs [--month YYYY-MM | --start YYYY-MM-DD --end YYYY-MM-DD]",
        "                     [--store 店名]... [--skip-upload] [--list-stores] [--headless]",
        "月份與起訖日都不給就是上個月。先跑過 setup.mjs 完成 Google 授權、店別清單與 Drive 資料夾設定。",
      ].join("\n"),
    );
    return;
  }

  const config = await loadConfig(undefined, {
    // 平台觸發時店別從 D1 傳進來；手動執行沒有這個輸入，照 config.json 跑。
    storesOverride: parseStoresInput(process.env.REPORT_STORES_JSON),
  });
  const env = await loadEnv();
  requireEnv(env, ["CYBERBIZ_USERNAME", "CYBERBIZ_PASSWORD"]);

  if ((args.start || args.end) && args.month) {
    throw new Error("--month 與 --start/--end 只能擇一。");
  }
  if (Boolean(args.start) !== Boolean(args.end)) {
    throw new Error("--start 與 --end 要一起給。");
  }
  const range = args.start
    ? dateRange(args.start, args.end)
    : args.month
      ? monthRange(args.month)
      : previousMonth();
  const monthly = range.label === range.start.slice(0, 7) && range.end === monthRange(range.label).end;
  const ingestConfig = !args.skipUpload
    ? reportIngestConfig(env)
    : { enabled: false, missing: [], apiUrl: reportIngestConfig(env).apiUrl };
  if (!args.skipUpload && !ingestConfig.enabled) {
    log(`照常匯出並上傳 Drive，但暫不匯入 D1；缺少：${ingestConfig.missing.join("、")}`);
  }
  const recipientEmail = config.recipientEmail || env.CYBERBIZ_2FA_MAILBOX;
  if (!recipientEmail) {
    throw new Error("config.json 的 recipientEmail 或 .env 的 CYBERBIZ_2FA_MAILBOX 至少要有一個。");
  }

  const selected = args.stores.length
    ? config.stores.filter((store) => args.stores.includes(store.name))
    : config.stores;
  const wanted = selected.map((store) => ({
    ...store,
    // 新版設定使用 Drive 連結；保留舊欄位作為相容 fallback。
    driveFolderId: driveFolderIdFromUrl(store.driveFolderUrl || store.driveFolderId),
  }));
  if (!args.listStores) {
    const unknown = args.stores.filter(
      (name) => !config.stores.some((store) => store.name === name),
    );
    if (unknown.length) throw new Error(`config.json 沒有這些店：${unknown.join("、")}`);
    if (!wanted.length) throw new Error("config.json 的 stores 是空的，請先跑 setup.mjs stores。");
  }

  const stagingDir = await ensureDir(
    path.isAbsolute(config.stagingDir)
      ? path.join(config.stagingDir, "payout", range.label)
      : skillPath(config.stagingDir, "payout", range.label),
  );

  const context = await openBrowser({
    headless: Boolean(args.headless),
    downloadDir: stagingDir,
  });
  const run = {
    label: range.label,
    start: range.start,
    end: range.end,
    stores: [],
    finishedAt: "",
  };

  try {
    const page = await newPage(context);

    requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]);
    const gmailToken = await accessToken({ ...env, GOOGLE_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN });
    const mailbox = await whoAmI(gmailToken);
    log(`Gmail 信箱：${mailbox.emailAddress}`);

    log("登入 CYBERBIZ…");
    await login(page, {
      origin: config.cyberbizOrigin,
      username: env.CYBERBIZ_USERNAME,
      password: env.CYBERBIZ_PASSWORD,
      gmailToken,
      twoFactor: config.twoFactor,
    });
    log("已登入後台。");

    if (args.listStores) {
      const stores = await listStores(page, { origin: config.cyberbizOrigin });
      log(`後台共有 ${stores.length} 家 POS 商店：`);
      for (const store of stores) log(`  - ${store.name}`);
      return;
    }

    // Drive：每家店各自對應一個通路資料夾（帳務/通路銷售紀錄/<通路>）
    let token = null;
    if (!args.skipUpload) {
      requireEnv(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
      const missingFolder = wanted.filter((store) => !store.driveFolderId);
      if (missingFolder.length) {
        throw new Error(
          `這些店還沒設定 Google Drive 資料夾連結：${missingFolder.map((s) => s.name).join("、")}` +
            "（請在設定頁填入資料夾連結，或跑 node setup.mjs stores 重新對應）",
        );
      }
      token = await accessToken(env);
      const driveRootFolderId = driveFolderIdFromUrl(
        config.driveRootFolderUrl || config.driveRootFolderId,
      );
      if (driveRootFolderId) {
        run.driveFolderUrl = (await getFile(token, driveRootFolderId)).webViewLink;
      }
    }

    for (const store of wanted) {
      const result = { store: store.name, steps: {}, done: false };
      run.stores.push(result);
      log(`\n── ${store.name} ──`);
      try {
        const storeBase = await resolveStore(page, {
          origin: config.cyberbizOrigin,
          storeName: store.name,
        });
        const { submittedAt } = await exportPayoutReport(page, {
          storeBase,
          recipientEmail,
          startDate: range.start,
          endDate: range.end,
        });
        result.steps.export = "ok";
        log("  匯出已送出，等信…");

        const expectedName = payoutFilename(store.name, range.start, range.end);
        const localPath = await downloadAttachment(gmailToken, {
          expectedName,
          sender: config.attachmentSender,
          downloadDir: stagingDir,
          notBefore: submittedAt,
        });
        result.steps.fetch = "ok";
        result.file = localPath;
        log(`  已取檔：${path.basename(localPath)}`);

        const verified = await verifyPayoutFile(localPath, {
          start: range.start,
          end: range.end,
          firstDataRow: config.firstDataRow,
        });
        result.steps.verify = "ok";
        result.total = verified.total;
        log(`  驗證通過：${verified.rows} 列，出金合計 ${verified.total.toLocaleString("zh-TW")}`);

        // 欄位直接寫進 xlsx（維持與 Drive 上既有檔案相同的格式）
        const injected = await addPayoutColumns(localPath, {
          columns: config.columns,
          headerRow: config.headerRow,
          firstDataRow: config.firstDataRow,
        });
        result.steps.columns = "ok";
        log(
          `  已寫入 ${injected.headers.join("/")} 欄，公式：` +
            `${injected.formulas.map((item) => item.ref).join("、")}（資料到第 ${injected.lastRow} 列）`,
        );

        if (args.skipUpload) {
          result.steps.upload = "skip";
          result.done = true;
          result.note = "--skip-upload";
          continue;
        }

        const fileName = path.basename(localPath);
        const existing = await findByName(token, {
          parentId: store.driveFolderId,
          name: fileName,
        });
        // 自訂區間沿用原本的保守行為，避免洗掉同仁已填的人工欄位；整月重跑則上傳新版本。
        if (existing && !monthly) {
          result.steps.upload = "skip";
          result.sheetUrl = existing.webViewLink;
          result.note = "Drive 已有同名檔案，未覆寫";
          result.done = true;
          log("  Drive 已有同名檔案，跳過上傳。");
          continue;
        }

        const uploadName = existing && monthly
          ? `${fileName.replace(/\.xlsx$/i, "")}-v${Date.now()}.xlsx`
          : fileName;
        const uploaded = await uploadXlsx(token, {
          filePath: localPath,
          name: uploadName,
          folderId: store.driveFolderId,
        });
        result.steps.upload = "ok";
        result.sheetUrl = uploaded.webViewLink;
        result.drive = { driveFileId: uploaded.id, driveUrl: uploaded.webViewLink };
        log(`  已上傳到「${store.driveFolderName ?? store.name}」：${uploadName}`);

        const check = await verifyFormulaByTempCopy(token, uploaded.id, {
          firstDataRow: config.firstDataRow,
        });
        if (!check.count) {
          throw Object.assign(new Error("H 欄公式沒有算出任何值。"), {
            code: "FORMULA_NOT_EVALUATED",
          });
        }
        result.formulaValues = check.count;
        if (monthly && ingestConfig.enabled) {
          const parsed = await parsePayoutReport(localPath, {
            scopeType: "store",
            scopeId: storeScopeId(store),
            scopeName: store.name,
            start: range.start,
            end: range.end,
            firstDataRow: config.firstDataRow,
          });
          await ingestCyberbizReport({
            apiUrl: ingestConfig.apiUrl,
            ingestToken: env.CYBERBIZ_REPORT_INGEST_TOKEN,
            kind: "payout",
            scopeId: storeScopeId(store),
            scopeName: store.name,
            rows: payoutIngestRows(parsed.rows),
          });
          result.steps.ingest = "ok";
        } else {
          result.steps.ingest = "skip";
          result.note = !monthly
            ? "自訂區間只上傳 Drive，未匯入 D1"
            : args.skipUpload
              ? "--skip-upload，未匯入 D1"
              : `未匯入 D1（缺少：${ingestConfig.missing.join("、")}）`;
        }
        result.done = true;
        log(`  公式驗證通過：H 欄算出 ${check.count} 個值（前幾筆 ${check.sample.join("、")}）。`);
      } catch (error) {
        const step = ["export", "fetch", "verify", "columns", "upload", "ingest"].find(
          (key) => !result.steps[key],
        );
        if (step) result.steps[step] = "fail";
        result.error = {
          code: error.code ?? "UNEXPECTED_ERROR",
          message: redact(error.message, env),
        };
        log(`  卡住：[${result.error.code}] ${result.error.message}`);
        try {
          result.screenshot = await screenshot(page, `${range.label}-${store.name}-error`, { kind: "payout" });
        } catch {}
      }
    }
  } finally {
    run.finishedAt = new Date().toISOString();
    if (run.stores.length) {
      const reportsDir = path.isAbsolute(config.reportsDir)
        ? path.join(config.reportsDir, "payout")
        : skillPath(config.reportsDir, "payout");
      run.reportPath = await writeMarkdown(run, reportsDir);
      log(terminalSummary(run));
    }
    await context.close();
  }

  if (run.stores.some((store) => !store.done)) process.exitCode = 1;
}

main().catch((error) => {
  log(`執行失敗：${error.message}`);
  process.exitCode = 1;
});
