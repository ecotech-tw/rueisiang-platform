#!/usr/bin/env node
/**
 * 對帳中心的 selector 勘查工具。
 *
 *   node shop/inspect.mjs                      # 只讀，不下載
 *   node shop/inspect.mjs --download 2026-08-16  # 連帶下載那一期，走完整條路
 *
 * CYBERBIZ 改版時跑這支，就知道哪個 selector 掛了。今天這一輪它抓到四個會讓 driver
 * 完全不能用的錯（網址、卡片定位、openBrowser 的回傳、profile 沒關），所以留著。
 *
 * 開一個看得見的瀏覽器直接進對帳中心；被踢到登入頁就等人自己登入，腳本不碰帳密。
 *
 * **下載一定要跟登入在同一次執行裡。** CYBERBIZ 的登入是 session cookie，瀏覽器一關
 * 就沒了，persistent profile 也留不住——分兩次跑的話第二次一定在登入頁。
 */
import { stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { openBrowser } from "../lib/browser.mjs";
import { skillPath } from "../lib/common.mjs";
import { downloadStatement, listStatements } from "../lib/cyberbiz.mjs";
import { parseShopReport } from "./parser.mjs";

const STATEMENTS_URL = "https://rueisiang.cyberbiz.co/admin/statements";
const OUT = skillPath("shop-inspect.json");
const DEADLINE_MS = 60 * 60 * 1000;
const HEARTBEAT_MS = 15 * 1000;

function describe(handle) {
  if (!handle) return null;
  return handle.evaluate((element) => {
    const attrs = {};
    for (const attr of element.attributes) attrs[attr.name] = attr.value;
    return {
      tagName: element.tagName.toLowerCase(),
      text: (element.textContent ?? "").trim().slice(0, 60),
      attrs,
      outerHTML: element.outerHTML.slice(0, 500),
    };
  });
}

const context = await openBrowser({ headless: false, downloadDir: skillPath("downloads", "shop") });
try {
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(STATEMENTS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(3000);

  let body = await page.locator("body").innerText().catch(() => "");
  if (!body.includes("對帳單列表")) {
    console.log("──────────────────────────────────────────────");
    console.log("需要登入。請在這個視窗登入 CYBERBIZ；登入後腳本會自己導到對帳中心。");
    console.log("（帳密只有你會輸入。）");
    console.log("──────────────────────────────────────────────");
    const startedAt = Date.now();
    let lastHeartbeat = 0;
    while (Date.now() - startedAt < DEADLINE_MS) {
      const url = page.url();
      if (!/sign_in/.test(url) && !url.endsWith("/admin")) {
        // 已經登入且離開登入頁，自己導到對帳中心，不用人再點兩下。
      }
      if (!/sign_in/.test(url)) {
        await page.goto(STATEMENTS_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
        await page.waitForTimeout(3000);
        body = await page.locator("body").innerText().catch(() => "");
        if (body.includes("對帳單列表")) break;
      }
      if (Date.now() - lastHeartbeat > HEARTBEAT_MS) {
        lastHeartbeat = Date.now();
        console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${page.url()}`);
      }
      await page.waitForTimeout(2000);
    }
  }

  if (!body.includes("對帳單列表")) {
    console.error("逾時：還是沒進到對帳單列表。");
    process.exitCode = 1;
  } else {
    const result = { url: page.url(), checkedAt: new Date().toISOString() };

    // --download 時不試填月份：填它會展開 datepicker，而那片選單會攔截之後的點擊。
    // 兩件事在同一次執行裡做不來，而月份能不能填上一輪已經驗過了（可以）。
    const probeMonths = !process.argv.includes("--download");
    for (const [key, placeholder] of [["startMonth", "開始月份"], ["endMonth", "結束月份"]]) {
      const field = page.getByPlaceholder(placeholder).first();
      result[`${key}Count`] = await page.getByPlaceholder(placeholder).count();
      if (!result[`${key}Count`]) continue;
      result[key] = await describe(await field.elementHandle());
      if (!probeMonths) continue;
      const filled = await field.fill("2026-08").then(() => true).catch((error) => error.message.slice(0, 120));
      result[`${key}FillOk`] = filled === true;
      if (filled === true) {
        result[`${key}ValueAfterFill`] = await field.inputValue().catch(() => null);
        await field.fill("").catch(() => {});
      } else {
        result[`${key}FillError`] = filled;
      }
      // 點月份欄位會展開 react-datepicker，它整片蓋住畫面，之後要點的東西全部
      // 被攔截——上一輪就是這樣讓下載鈕點不到的。填完一定要收掉。
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(300);
    }

    result.downloadButtons = await page.getByRole("button", { name: "下載對帳單" }).count();
    result.searchButtons = await page.getByRole("button", { name: "搜尋" }).count();
    result.download = await describe(await page.getByRole("button", { name: "下載對帳單" }).first().elementHandle().catch(() => null));

    // 卡片的真實結構：從「撥款金額」往上爬三層，看哪一層才是一整張卡。
    result.cardChain = await page.evaluate(() => {
      const amount = [...document.querySelectorAll("*")]
        .filter((element) => /撥款金額/.test(element.textContent ?? "") && element.children.length === 0)[0];
      if (!amount) return null;
      const chain = [];
      let node = amount;
      for (let step = 0; step < 6 && node; step += 1) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
        chain.push({
          step,
          tag: node.tagName.toLowerCase(),
          className: node.className?.toString?.().slice(0, 80) ?? "",
          hasPeriod: /對帳區間/.test(text),
          hasAmount: /撥款金額/.test(text),
          hasDownload: [...node.querySelectorAll("button")].some((b) => (b.textContent ?? "").trim() === "下載對帳單"),
          textLength: text.length,
          text: text.slice(0, 120),
        });
        node = node.parentElement;
      }
      return chain;
    });

    const statements = await listStatements(page).catch(() => []);
    result.listStatements = statements.map(({ locator: _locator, ...rest }) => rest);

    // 最後一哩：真的按一次下載，把 driver 的整條路走完。下載是唯讀操作，重複下載
    // 同一期只是再拿一份同樣的檔案。
    const downloadIndex = process.argv.indexOf("--download");
    const wantedStart = downloadIndex > 0 ? process.argv[downloadIndex + 1] : null;
    if (wantedStart) {
      const target = statements.find((statement) => statement.start === wantedStart);
      if (!target) {
        result.download = { error: `找不到 ${wantedStart} 起的那一期` };
      } else if (!target.settled) {
        result.download = { error: `${wantedStart} 那期還沒結帳，沒有下載鈕` };
      } else {
        const filePath = path.join(skillPath("downloads", "shop"), `官網對帳單 ${target.start} ~ ${target.end}.xlsx`);
        console.log(`\n按下載：${target.start} ~ ${target.end}（卡片寫撥款 ${target.amount}）`);
        await downloadStatement(page, target, { targetPath: filePath, log: (message) => console.log(`  ${message}`) });
        const size = (await stat(filePath)).size;
        const report = await parseShopReport(filePath);
        result.downloadResult = {
          filePath,
          size,
          cardAmount: target.amount,
          period: report.period,
          revenueAmount: report.revenueAmount,
          settlementAmount: report.settlementAmount,
          skuCount: report.items.length,
          quantity: report.items.reduce((sum, item) => sum + item.quantity, 0),
          salesAmount: report.items.reduce((sum, item) => sum + item.salesAmount, 0),
          charges: report.charges,
          amountMatchesCard: target.amount === report.settlementAmount,
          periodMatchesCard: report.period.start === target.start && report.period.end === target.end,
        };
      }
    }

    await writeFile(OUT, JSON.stringify(result, null, 2), "utf8");
    console.log(`\n寫到 ${OUT}`);
    console.log(JSON.stringify(result, null, 2));
  }
} finally {
  // 一定要關：只有乾淨關閉才會把 cookie 寫回 profile，下一次才不用再登入。
  await context.close();
  console.log("瀏覽器已正常關閉，登入狀態已寫回 profile。");
}
