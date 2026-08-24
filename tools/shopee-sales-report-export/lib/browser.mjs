import { chromium } from "playwright";
import { ensureDir, toolPath } from "./common.mjs";

export async function openBrowser({ headless = false, downloadDir } = {}) {
  const userDataDir = toolPath("chrome-profile");
  await ensureDir(userDataDir);
  if (downloadDir) await ensureDir(downloadDir);
  const channel = process.env.SHOPEE_BROWSER_CHANNEL ?? "chrome";
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless,
    ...(channel === "chromium" ? {} : { channel }),
    viewport: { width: 1440, height: 900 },
    acceptDownloads: Boolean(downloadDir),
    locale: "zh-TW",
    timezoneId: "Asia/Taipei",
    args: ["--disable-blink-features=AutomationControlled", ...(process.env.CI ? ["--disable-dev-shm-usage", "--no-sandbox"] : [])],
  });
  context.setDefaultTimeout(30000);
  return context;
}
