import path from "node:path";
import { log } from "./common.mjs";

/**
 * 蝦皮登入可能要求簡訊或其他兩步驟驗證；這裡只等待登入完成，不嘗試繞過驗證。
 * 持久化 Chrome profile 可以保留蝦皮認得的裝置，但是否再次要求 OTP 由蝦皮風控決定。
 */
async function waitForLogin(page, { headless }) {
  if (!/login|signin/i.test(page.url())) return;
  const username = process.env.SHOPEE_USERNAME;
  const password = process.env.SHOPEE_PASSWORD;
  let submitted = false;
  if (username && password) {
    const accountField = page.locator("input[type=email], input[name*=account i], input[name*=email i], input[type=text]").first();
    const passwordField = page.locator("input[type=password]").first();
    if (await accountField.count() && await passwordField.count()) {
      await accountField.fill(username);
      await passwordField.fill(password);
      const loginButton = page.getByRole("button", { name: /登入|登录|login/i }).last();
      if (await loginButton.count()) {
        submitted = true;
        await loginButton.click();
      }
    }
  }
  if (!/login|signin/i.test(page.url())) return;
  if (submitted) {
    try {
      await page.waitForURL((url) => !/login|signin/i.test(url.toString()), { timeout: 10000 });
      return;
    } catch {
      // 登入後仍停在驗證頁時，下面的 headless/有畫面分支會給出正確提示。
    }
  }
  if (headless) throw Object.assign(new Error("蝦皮需要登入或兩步驟驗證；請先在同一個 Chrome profile 完成登入，再用 --headless 重試。"), { code: "SHOPEE_LOGIN_REQUIRED" });
  log("請在開啟的蝦皮頁面完成登入與簡訊驗證；工具不會代填或繞過驗證。等待登入完成…");
  await page.waitForURL((url) => !/login|signin/i.test(url.toString()), { timeout: 180000 });
}

async function fillDate(page, selector, value, label) {
  if (!selector) return;
  const locator = page.locator(selector).first();
  if (await locator.count() === 0) throw new Error(`找不到${label}欄位：${selector}`);
  await locator.fill(value);
}

export async function exportShopeeReport(page, { reportUrl, start, end, downloadDir, selectors, headless }) {
  await page.goto(reportUrl, { waitUntil: "domcontentloaded" });
  await waitForLogin(page, { headless });
  await fillDate(page, selectors?.startDate, start, "起日");
  await fillDate(page, selectors?.endDate, end, "迄日");
  const button = page.locator(selectors?.exportButton || "button:has-text('匯出')").last();
  if (await button.count() === 0) throw new Error("找不到蝦皮報表的匯出按鈕；請在 config.json 更新 selectors.exportButton。");
  const downloadPromise = page.waitForEvent("download", { timeout: 120000 });
  await button.click();
  const download = await downloadPromise;
  const filePath = path.join(downloadDir, download.suggestedFilename());
  await download.saveAs(filePath);
  return filePath;
}
