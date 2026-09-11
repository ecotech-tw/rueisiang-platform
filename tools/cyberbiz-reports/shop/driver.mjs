#!/usr/bin/env node
/**
 * CYBERBIZ 官網對帳單流程。
 *
 *   node shop/driver.mjs                            # 上個月的兩期
 *   node shop/driver.mjs --month 2026-08            # 指定單月
 *   node shop/driver.mjs --start-month 2026-06 --end-month 2026-08
 *   node shop/driver.mjs --skip-upload              # 只下載與匯入，不碰 Drive
 *   node shop/driver.mjs --skip-ingest              # 只下載與上傳，不寫平台
 *   node shop/driver.mjs --list                     # 只列出後台有哪幾期後結束
 *   node shop/driver.mjs --headless
 *
 * 跟出金表最大的差別：**區間不能自己選**。對帳單是 CYBERBIZ 每半個月自己出的
 * （1–15、16–月底），我們只能挑「要哪幾個月」，然後把那幾個月裡每一期都抓下來。
 * 所以一次執行會處理多份檔案，而每一份是平台那一側的一個「期間」。
 *
 * 還沒結帳的那一期會跳過：它沒有下載鈕，而且卡片上寫的是「預計撥款金額」。把預計
 * 金額當成實際撥款寫進報表，結帳後數字會變，而報表不會自己回頭修。
 */
import path from "node:path";
import {
  driveFolderIdFromUrl,
  ensureDir,
  loadConfig,
  loadEnv,
  log,
  previousMonth,
  redact,
  reportIngestConfig,
  requireEnv,
  skillPath,
} from "../lib/common.mjs";
import { newPage, openBrowser, screenshot } from "../lib/browser.mjs";
import { downloadStatement, listStatements, login, loginOptions, openStatementCenter } from "../lib/cyberbiz.mjs";
import { accessToken, uploadXlsx } from "../lib/drive.mjs";
import { parseShopReport } from "./parser.mjs";

const SHOP_SCOPE_ID = "cyberbiz:channel:shop";
const SHOP_SCOPE_NAME = "官網";

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--month") args.month = argv[++index];
    else if (arg === "--start-month") args.startMonth = argv[++index];
    else if (arg === "--end-month") args.endMonth = argv[++index];
    else if (arg === "--skip-upload") args.skipUpload = true;
    else if (arg === "--skip-ingest") args.skipIngest = true;
    else if (arg === "--list") args.list = true;
    else if (arg === "--headless") args.headless = true;
    else if (arg === "--help" || arg === "-h") args.help = true;
    else throw new Error(`不認得的參數：${arg}`);
  }
  return args;
}

function monthRangeFromArgs(args) {
  if (args.month) return { startMonth: args.month, endMonth: args.month };
  if (args.startMonth || args.endMonth) {
    const startMonth = args.startMonth ?? args.endMonth;
    const endMonth = args.endMonth ?? args.startMonth;
    if (endMonth < startMonth) throw new Error("--end-month 早於 --start-month。");
    return { startMonth, endMonth };
  }
  const month = previousMonth();
  return { startMonth: month, endMonth: month };
}

function assertMonth(value, label) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`${label} 必須是 YYYY-MM：${value}`);
  return value;
}

function statementFilename(period) {
  return `官網對帳單 ${period.start} ~ ${period.end}.xlsx`;
}

async function ingestStatement({ apiUrl, ingestToken, report }, fetcher = fetch) {
  const response = await fetcher(`${apiUrl.replace(/\/$/, "")}/api/internal/cyberbiz-reports/shop-statement`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cyberbiz-report-token": ingestToken },
    body: JSON.stringify({
      scopeId: SHOP_SCOPE_ID,
      scopeName: SHOP_SCOPE_NAME,
      periodStart: report.period.start,
      periodEnd: report.period.end,
      settlementAmount: report.settlementAmount,
      rows: report.items.map((item) => ({
        sku: item.sku,
        productName: item.productName,
        category: item.category,
        quantity: item.quantity,
        salesAmount: item.salesAmount,
      })),
    }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`匯入對帳單失敗（HTTP ${response.status}）：${text.slice(0, 300)}`);
  const payload = text ? JSON.parse(text) : {};
  if (!payload.result?.scopeId) throw new Error("平台沒有回傳有效的匯入結果。");
  return payload.result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(await import("node:fs/promises").then((fs) => fs.readFile(new URL(import.meta.url), "utf8")).then((text) => text.split("*/")[0]));
    return;
  }

  const env = await loadEnv();
  // 所有前置檢查都在開瀏覽器之前：少一顆 secret 就不值得先花幾秒起一個 Chrome。
  // Gmail 在這支只有 2FA 一個用途（對帳單是瀏覽器直接下載的），但不是可選的——
  // runner 每次都是新機器，chrome-profile 不留，所以 CI 上每次都會被要求驗證碼。
  requireEnv(env, [
    "CYBERBIZ_USERNAME", "CYBERBIZ_PASSWORD",
    "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN",
  ]);
  const config = await loadConfig();
  if (!config.cyberbizOrigin) throw new Error("config.json 缺少 cyberbizOrigin。");
  const { startMonth, endMonth } = monthRangeFromArgs(args);
  assertMonth(startMonth, "開始月份");
  assertMonth(endMonth, "結束月份");

  const downloadDir = skillPath("downloads", "shop");
  await ensureDir(downloadDir);
  const context = await openBrowser({ headless: Boolean(args.headless), downloadDir });

  const processed = [];
  const skipped = [];
  let page = null;
  try {
    page = await newPage(context);
    // Gmail API 要的是換過的 access token，不是 .env 裡那顆 refresh token。
    const gmailToken = await accessToken({ ...env, GOOGLE_REFRESH_TOKEN: env.GMAIL_REFRESH_TOKEN });
    await login(page, loginOptions({ env, config, gmailToken }));
    log(`登入完成，抓 ${startMonth} ~ ${endMonth} 的對帳單`);

    await openStatementCenter(page, { origin: config.cyberbizOrigin, startMonth, endMonth, log });
    const statements = await listStatements(page);
    if (!statements.length) {
      await screenshot(page, "shop-statements-empty");
      throw new Error("對帳中心沒有列出任何期間，請看截圖確認畫面。");
    }
    log(`後台列出 ${statements.length} 期：${statements.map((s) => `${s.start}~${s.end}${s.settled ? "" : "（未結帳）"}`).join("、")}`);
    if (args.list) return { statements: statements.map(({ locator: _locator, ...rest }) => rest) };

    const driveToken = args.skipUpload ? null : await accessToken(env);
    // 沒設 shopDriveFolderUrl 就放進通路銷售紀錄的根目錄，跟其他報表同一個地方。
    const folderId = args.skipUpload
      ? null
      : driveFolderIdFromUrl(config.shopDriveFolderUrl ?? config.driveRootFolderUrl ?? "");
    if (!args.skipUpload && !folderId) {
      throw new Error("config.json 缺少 Drive 資料夾（shopDriveFolderUrl 或 driveRootFolderUrl）。");
    }
    const ingestConfig = args.skipIngest ? { enabled: false, missing: [] } : reportIngestConfig(env);
    if (!args.skipIngest && !ingestConfig.enabled) {
      throw new Error(`缺少匯入平台需要的環境變數：${ingestConfig.missing.join("、")}（要略過請加 --skip-ingest）`);
    }
    const ingest = ingestConfig.enabled
      ? { apiUrl: ingestConfig.apiUrl, ingestToken: env.CYBERBIZ_REPORT_INGEST_TOKEN }
      : null;

    for (const statement of statements) {
      if (!statement.settled) {
        // 沒有下載鈕就是還沒結帳；金額欄寫的是「預計撥款」，不能當成實際數字。
        // locator 不要帶進輸出：它會序列化成一坨 Playwright 內部欄位（_guid、_selector），
        // 讓 run log 裡的 JSON 多一堆看不懂的東西。--list 那條路徑也是這樣濾的。
        const { locator: _locator, ...rest } = statement;
        skipped.push({ ...rest, reason: "未結帳" });
        log(`跳過 ${statement.start} ~ ${statement.end}：尚未結帳`);
        continue;
      }
      const filePath = path.join(downloadDir, statementFilename(statement));
      await downloadStatement(page, statement, { targetPath: filePath, log });
      const report = await parseShopReport(filePath);

      // 卡片上的撥款金額是免費的第二來源；跟檔案裡算出來的不一致就是抓錯那一期，
      // 而抓錯的那份會照樣解析成功，只是整期的數字掛到別的期間上。
      if (statement.amount != null && statement.amount !== report.settlementAmount) {
        throw new Error(`卡片上的撥款金額 ${statement.amount} 與檔案裡的 ${report.settlementAmount} 不一致（${statement.start} ~ ${statement.end}）。`);
      }
      if (report.period.start !== statement.start || report.period.end !== statement.end) {
        throw new Error(`下載到的檔案是 ${report.period.start} ~ ${report.period.end}，但卡片是 ${statement.start} ~ ${statement.end}。`);
      }

      const entry = {
        period: report.period,
        revenueAmount: report.revenueAmount,
        settlementAmount: report.settlementAmount,
        itemCount: report.items.length,
        filePath,
      };
      if (driveToken && folderId) {
        const uploaded = await uploadXlsx(driveToken, { filePath, name: statementFilename(statement), folderId });
        entry.driveFileId = uploaded.id;
        log(`上傳 Drive：${uploaded.id}`);
      }
      if (ingest) {
        entry.ingest = await ingestStatement({ ...ingest, report });
        log(`匯入平台：${entry.ingest.itemCount} 個 SKU、營業額 ${entry.ingest.salesAmount}`);
      }
      processed.push(entry);
    }

    /*
     * 一期都沒抓到就當失敗。
     *
     * 「可不可以下載」是看卡片節點裡有沒有下載鈕（見 listStatements）。CYBERBIZ 改版
     * 把按鈕挪到卡片外面的話，每一期都會被判成未結帳，driver 靜靜地什麼都不抓、然後
     * 回綠燈——那是最糟的失敗形狀，因為沒有人會來看一個成功的 run。
     *
     * 真的整段期間都還沒結帳是可能的（例如當月月初就跑），所以訊息要講清楚兩種可能。
     */
    if (!processed.length) {
      await screenshot(page, "shop-nothing-downloadable");
      throw new Error(
        `${startMonth} ~ ${endMonth} 共 ${statements.length} 期，一期都沒有下載鈕。`
        + "可能是都還沒結帳，也可能是後台改版讓我們認不出按鈕了——請看截圖確認。",
      );
    }

    return { statements: processed, skipped };
  } catch (error) {
    // 任何失敗都留一張截圖。這次的 /admin/settlements 打錯字只留下一句 Playwright
    // 逾時，artifact 裡什麼都沒有，只能靠猜——一張圖就會直接看到停在哪一頁。
    if (page) await screenshot(page, "shop-failed").catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

main()
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(async (error) => {
    const env = await loadEnv().catch(() => ({}));
    console.error(redact(error.stack ?? String(error), env));
    process.exitCode = 1;
  });
