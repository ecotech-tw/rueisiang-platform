import { chromium } from "playwright";
import { ensureDir, skillPath } from "./common.mjs";

/**
 * 用技能自己的 Chrome profile（chrome-profile/）開瀏覽器。
 * 用持久化 profile 的理由：CYBERBIZ 與 Gmail 登入狀態可以跨月保留，
 * 而且不會動到使用者日常在用的 Chrome profile（同一個 profile 目錄不能被兩個
 * Chrome 行程同時開啟，若共用會直接啟動失敗）。
 */
export async function openBrowser({ headless = false, downloadDir } = {}) {
  const userDataDir = skillPath("chrome-profile");
  await ensureDir(userDataDir);
  const acceptDownloads = Boolean(downloadDir);
  if (acceptDownloads) await ensureDir(downloadDir);

  /*
   * 用系統安裝的 Google Chrome。GitHub 的 ubuntu-24.04 image 內建 Chrome，
   * 所以本機跟 CI 跑的是同一種瀏覽器——CI 上出的問題本機重現得出來。
   * 沒有 Chrome 的環境（例如自架的精簡容器）設 PAYOUT_BROWSER_CHANNEL=chromium
   * 改用 Playwright 自帶的，但要先跑過 playwright install chromium。
   */
  const channel = process.env.PAYOUT_BROWSER_CHANNEL ?? "chrome";
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    ...(channel === "chromium" ? {} : { channel }),
    viewport: { width: 1440, height: 900 },
    acceptDownloads,
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    args: [
      "--disable-blink-features=AutomationControlled",
      // 容器/CI 的 /dev/shm 通常只有 64MB，不加這個 Chrome 會隨機崩潰
      ...(process.env.CI ? ["--disable-dev-shm-usage", "--no-sandbox"] : []),
    ],
  });
  context.setDefaultTimeout(30000);
  return context;
}

export async function newPage(context, url) {
  const page = context.pages()[0] ?? (await context.newPage());
  if (url) await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

export async function screenshot(page, name, { kind = "shared" } = {}) {
  const dir = await ensureDir(skillPath("screenshots", kind));
  const file = `${dir}/${name}.png`;
  await page.screenshot({ path: file, fullPage: false });
  return file;
}
