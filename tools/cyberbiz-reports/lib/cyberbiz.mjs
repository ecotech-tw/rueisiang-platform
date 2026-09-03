import { readTwoFactorCode } from "./gmail-api.mjs";

const MONTHS = new Map(
  [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ].map((name, index) => [name, index + 1]),
);

export function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

/*
 * CYBERBIZ 後台會不定期跳行銷彈窗（例如 2026-08 底開始的「團購獲利新架構」
 * webinar），整片蓋在畫面上。它不是我們要的東西，但 Playwright 的 click 會被
 * 它攔截，症狀是 `locator.click: Timeout 30000ms exceeded`——看錯誤訊息完全
 * 猜不到是彈窗，只能開 artifact 的截圖才知道。
 *
 * 每次導航後都關一次。選擇器故意寫得寬：對方換一套 modal 元件的機率不低，
 * 關不掉時退回按 Escape，再關不掉就放著繼續跑——彈窗不一定會擋到我們要點的
 * 東西，不該因為關不掉就讓整次執行失敗。
 */
const OVERLAY_CLOSE_SELECTORS = [
  '[role="dialog"] button[aria-label*="close" i]',
  '[role="dialog"] button[aria-label*="關閉"]',
  ".modal.show button.close, .modal.in button.close",
  "button[data-dismiss='modal'], button[data-bs-dismiss='modal']",
  ".modal.show .modal-header button, .modal.show [class*='close']",
];

export async function dismissOverlays(page, { log } = {}) {
  for (const selector of OVERLAY_CLOSE_SELECTORS) {
    const button = page.locator(selector).first();
    const visible = await button.isVisible().catch(() => false);
    if (!visible) continue;
    // force：關閉鈕自己有時也被 backdrop 蓋住，正常 click 一樣會逾時
    await button.click({ timeout: 3000, force: true }).catch(() => {});
    await page.waitForTimeout(300);
    log?.(`關掉一個蓋在畫面上的彈窗（${selector}）`);
    return true;
  }

  // 沒有認得的關閉鈕就試 Escape；沒有彈窗時按它也無害
  const blocked = await page
    .locator(".modal.show, .modal.in, [role='dialog']")
    .first()
    .isVisible()
    .catch(() => false);
  if (!blocked) return false;
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  log?.("畫面上有彈窗但找不到關閉鈕，已試過 Escape");
  return true;
}

export const PRODUCT_SALES_REPORT_LINK_NAME = /\u5546\s*\u54c1\s*\u92b7\s*\u552e\s*(?:\u7e3d\s*\u8868|\u5831\s*\u8868)/;

function toPickerInput(iso) {
  return iso.replace(/-/g, "/");
}

function monthKeyOf(iso) {
  const [year, month] = iso.split("-").map(Number);
  return year * 12 + month;
}

/**
 * 登入 CYBERBIZ 後台。已登入就直接回傳。
 * 2FA：送出帳密後若出現驗證碼欄位，從 Gmail 分頁讀取驗證碼填入。
 * 驗證碼與密碼都不會被回傳或寫進 log。
 */
export async function login(page, {
  origin,
  username,
  password,
  gmailToken,
  twoFactor,
}) {
  await page.goto(`${origin}/admin/pos_shops`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissOverlays(page);

  if (!page.url().includes("/user/sign_in")) return { status: "already_signed_in" };

  const email = page.locator("#login-input");
  const pass = page.locator("#password");
  if ((await email.count()) !== 1 || (await pass.count()) !== 1) {
    fail("LOGIN_FORM_UNEXPECTED", "登入頁的欄位跟預期不同，請人工確認畫面。");
  }

  const submittedAt = Date.now();
  await email.fill(username);
  await pass.fill(password);
  await page.getByRole("button", { name: "登入", exact: true }).click();
  await page.waitForTimeout(3000);

  // 2FA：實際欄位是 #otp_attempt（name="user[otp_attempt]"），
  // 頁面會顯示「驗證碼已發送至 <信箱>」
  const codeField = page
    .locator("#otp_attempt, input[autocomplete='one-time-code'], input[name*='otp']")
    .first();
  if ((await codeField.count()) > 0 && (await codeField.isVisible().catch(() => false))) {
    if (!gmailToken) {
      fail("OTP_NO_MAILBOX", "需要 2FA 驗證碼，但沒有 Gmail 授權（跑 node setup.mjs mail）。");
    }
    const code = await readTwoFactorCode(gmailToken, {
      query: twoFactor.gmailSearch,
      codePattern: twoFactor.codePattern,
      notBefore: submittedAt,
    });
    await codeField.fill(code);

    // 勾「記住此裝置 30 天」：Chrome profile 是持久化的，勾了之後接下來
    // 30 天內的執行都不用再等驗證信，省掉整段最不穩的流程。
    const remember = page.locator("#remember_device");
    if ((await remember.count()) > 0 && !(await remember.isChecked().catch(() => true))) {
      await remember.check().catch(() => {});
    }

    await page.getByRole("button", { name: /^(驗證|確認|送出)$/ }).first().click();
    await page.waitForTimeout(3000);
  }

  if (page.url().includes("/user/sign_in")) {
    fail("LOGIN_FAILED", "帳密或 2FA 驗證後仍停留在登入頁。");
  }
  return { status: "signed_in" };
}

/**
 * POS 商店列表是 DataTable，預設一頁只顯示 10 筆（實際有 13 家），
 * 直接讀畫面會漏掉第 2 頁。先把每頁筆數切到最大值。
 */
async function expandTable(page) {
  const lengthSelect = page.locator("select[name='pos-data-table_length'], select[name$='_length']").first();
  if ((await lengthSelect.count()) === 0) return;
  const options = await lengthSelect.evaluate((el) =>
    [...el.options].map((option) => Number(option.value)).filter(Number.isFinite),
  );
  if (!options.length) return;
  await lengthSelect.selectOption(String(Math.max(...options)));
  await page.waitForTimeout(800);
}

/** 讀出後台「POS 商店列表」上的所有商店名稱與連結。 */
export async function listStores(page, { origin }) {
  await page.goto(`${origin}/admin/pos_shops`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await dismissOverlays(page);
  const heading = await page.locator("body").innerText();
  if (!heading.includes("POS 商店")) {
    fail("NOT_SIGNED_IN", "看不到 POS 商店列表，可能尚未登入。");
  }
  await expandTable(page);

  const info = await page
    .locator(".dataTables_info")
    .first()
    .innerText()
    .catch(() => "");
  const total = Number(/of\s+(\d+)\s+entries/.exec(info)?.[1] ?? 0);

  const stores = await page.evaluate(() =>
    [...document.querySelectorAll("a[href^='/admin/pos_shops/']")]
      .filter((a) => /^\/admin\/pos_shops\/\d+$/.test(a.getAttribute("href")))
      .map((a) => ({ name: a.textContent.trim(), href: a.getAttribute("href") }))
      .filter((item) => item.name.length > 0),
  );

  const unique = [...new Map(stores.map((store) => [store.name, store])).values()];
  if (total && unique.length < total) {
    fail(
      "STORE_LIST_TRUNCATED",
      `只讀到 ${unique.length} 家，後台顯示共 ${total} 家（分頁沒展開）。`,
    );
  }
  return unique;
}

/** 找出單一商店的後台路徑，例如 /admin/pos_shops/123 */
export async function resolveStore(page, { origin, storeName }) {
  await page.goto(`${origin}/admin/pos_shops`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await dismissOverlays(page);
  await expandTable(page);
  const search = page.getByRole("textbox", { name: "Search:", exact: true });
  if ((await search.count()) === 1) {
    await search.fill(storeName);
    await search.press("Enter");
    await page.waitForTimeout(800);
  }
  const link = page.getByRole("link", { name: storeName, exact: true });
  const count = await link.count();
  if (count === 0) fail("STORE_NOT_FOUND", `找不到 POS 商店：${storeName}`);
  if (count > 1) fail("STORE_AMBIGUOUS", `符合「${storeName}」的商店有 ${count} 家。`);
  const href = await link.getAttribute("href");
  if (!/^\/admin\/pos_shops\/\d+$/.test(href ?? "")) {
    fail("STORE_LINK_INVALID", `商店連結不正確：${href}`);
  }
  return `${origin}${href}`;
}

/** 讀出目前可見的 bootstrap datepicker 狀態與可點座標。 */
async function visiblePicker(page, targetDay) {
  return page.evaluate((day) => {
    const visible = (elements) =>
      [...elements].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    const picker = visible(document.querySelectorAll(".datepicker-dropdown"));
    if (!picker) return null;
    const center = (element) => {
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    };
    const switcher = visible(picker.querySelectorAll(".datepicker-switch"));
    const target = [...picker.querySelectorAll("td.day")].find(
      (element) =>
        element.textContent.trim() === String(day) &&
        !element.classList.contains("old") &&
        !element.classList.contains("new"),
    );
    return {
      title: switcher?.textContent.trim() ?? "",
      previous: center(visible(picker.querySelectorAll("th.prev"))),
      next: center(visible(picker.querySelectorAll("th.next"))),
      target: center(target),
    };
  }, targetDay);
}

function pickerMonthKey(title) {
  const match = /^([A-Za-z]+)\s+(\d{4})$/.exec(title ?? "");
  const month = match ? MONTHS.get(match[1]) : undefined;
  if (!match || !month) fail("DATEPICKER_ERROR", `無法判讀日期選擇器：${title}`);
  return Number(match[2]) * 12 + month;
}

/**
 * 選日期。直接 fill 會被 datepicker 覆寫回當月，所以一定要開日曆點日期，
 * 點完再 blur 到別的欄位，最後驗證欄位值真的變成目標日期。
 */
async function chooseDate(page, field, blurTarget, iso, label) {
  const day = Number(iso.slice(8, 10));
  const wanted = monthKeyOf(iso);
  const expected = toPickerInput(iso);

  await field.click();
  // 日曆開在哪一個月不一定，所以先讀到實際月份，再依距離給切換次數
  // （多留幾次當緩衝）。額度剛好夠用，切不動的日曆仍然會很快被判失敗。
  let budget = 1;
  for (let attempt = 0; attempt < budget; attempt += 1) {
    const picker = await visiblePicker(page, day);
    if (!picker) fail("DATEPICKER_ERROR", `${label}日期選擇器未開啟。`);
    const current = pickerMonthKey(picker.title);
    if (attempt === 0) budget = Math.abs(current - wanted) + 6;
    if (current === wanted) {
      if (!picker.target) fail("DATEPICKER_ERROR", `${label}找不到 ${iso}。`);
      await page.mouse.click(picker.target.x, picker.target.y);
      await blurTarget.click();
      const actual = await field.inputValue();
      if (actual !== expected) {
        fail("DATE_REVERTED", `${label}日期變成 ${actual || "空白"}，預期 ${expected}。`);
      }
      return;
    }
    const direction = current > wanted ? picker.previous : picker.next;
    if (!direction) fail("DATEPICKER_ERROR", `${label}無法切換月份。`);
    await page.mouse.click(direction.x, direction.y);
    await page.waitForTimeout(150);
  }
  fail("DATEPICKER_ERROR", `${label}切了 ${budget} 次月份仍到不了 ${iso.slice(0, 7)}。`);
}

/**
 * 觸發「每日出金報表」匯出（報表會寄到 recipientEmail）。
 * 回傳 { submittedAt } 供後續比對郵件時間。
 */
export async function exportPayoutReport(page, {
  storeBase,
  recipientEmail,
  startDate,
  endDate,
}) {
  await page.goto(`${storeBase}/stock_reports/petty_cash`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  const text = await page.locator("body").innerText();
  if (!text.includes("每日出金報表")) {
    fail("REPORT_PAGE_MISSING", "找不到「每日出金報表」頁面。");
  }

  const email = page.getByRole("textbox", {
    name: "收件者Email (若留空，則為當前使用者Email)",
    exact: true,
  });
  const startField = page.getByRole("textbox", { name: "開始時間", exact: true });
  const endField = page.getByRole("textbox", { name: "結束時間", exact: true });
  for (const [locator, label] of [
    [email, "收件者"],
    [startField, "開始時間"],
    [endField, "結束時間"],
  ]) {
    if ((await locator.count()) !== 1) {
      fail("UNEXPECTED_PAGE_STATE", `${label}欄位數量不是 1。`);
    }
  }

  await email.fill(recipientEmail);
  await chooseDate(page, startField, email, startDate, "開始");
  await chooseDate(page, endField, email, endDate, "結束");

  const actual = {
    email: await email.inputValue(),
    start: await startField.inputValue(),
    end: await endField.inputValue(),
  };
  if (
    actual.email !== recipientEmail ||
    actual.start !== toPickerInput(startDate) ||
    actual.end !== toPickerInput(endDate)
  ) {
    fail("FILTER_MISMATCH", "匯出條件填寫後與預期不符。", actual);
  }

  const submittedAt = Date.now();
  await page.getByRole("button", { name: "匯出", exact: true }).click();

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(250);
    const current = await page.locator("body").innerText();
    if (current.includes("報表列表")) return { submittedAt };
  }
  fail("EXPORT_NOT_ACCEPTED", "送出匯出後沒有回到報表列表。");
}

/**
 * 從 POS 店別的報表入口頁點選商品銷售報表連結。
 *
 * CYBERBIZ 的報表路徑不是穩定的公開 API，不能只依賴手動抄出的 URL。
 * 觸發「商品銷售報表」時只需要先開啟 `/stock_reports`，再點選後台上的報表連結。
 * 商品銷售總表與出金表共用收件人與日期選擇器。
 */
export async function exportSalesReport(page, {
  storeBase,
  recipientEmail,
  startDate,
  endDate,
  reportPath = "/stock_reports",
}) {
  const reportIndexUrl = `${storeBase}${reportPath}`;
  const response = await page.goto(reportIndexUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1000);
  await dismissOverlays(page);

  const reportLink = page.getByRole("link", {
    name: PRODUCT_SALES_REPORT_LINK_NAME,
  }).first();
  if ((await reportLink.count()) < 1) {
    fail("REPORT_LINK_MISSING", "POS report page does not contain the product sales report link.", {
      reportIndexUrl,
    });
  }
  await reportLink.click();
  await page.waitForTimeout(1000);

  const text = await page.locator("body").innerText();
  if (!text.includes("商品銷售報表") && !text.includes("商品銷售總表")) {
    fail("REPORT_PAGE_MISSING", "找不到「商品銷售報表」頁面，請確認 POS 店別報表頁的連結。", {
      reportPath,
      reportUrl: page.url(),
      status: response?.status() ?? null,
    });
  }

  const email = page.getByRole("textbox", {
    name: "收件者Email (若留空，則為當前使用者Email)",
    exact: true,
  });
  const startField = page.getByRole("textbox", { name: "開始時間", exact: true });
  const endField = page.getByRole("textbox", { name: "結束時間", exact: true });
  for (const [locator, label] of [[email, "收件者"], [startField, "開始時間"], [endField, "結束時間"]]) {
    if ((await locator.count()) !== 1) fail("UNEXPECTED_PAGE_STATE", `${label}欄位數量不是 1。`);
  }

  await email.fill(recipientEmail);
  await chooseDate(page, startField, email, startDate, "開始");
  await chooseDate(page, endField, email, endDate, "結束");
  const actual = { email: await email.inputValue(), start: await startField.inputValue(), end: await endField.inputValue() };
  if (actual.email !== recipientEmail || actual.start !== toPickerInput(startDate) || actual.end !== toPickerInput(endDate)) {
    fail("FILTER_MISMATCH", "商品銷售報表匯出條件與預期不符。", actual);
  }

  const submittedAt = Date.now();
  await page.getByRole("button", { name: "匯出", exact: true }).click();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(250);
    if ((await page.locator("body").innerText()).includes("報表列表")) return { submittedAt };
  }
  fail("EXPORT_NOT_ACCEPTED", "商品銷售報表送出匯出後沒有回到報表列表。");
}
