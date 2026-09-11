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

/**
 * 管理中心 → 對帳中心 → 對帳單列表。
 *
 * 跟出金表與商品銷售報表不一樣的地方：
 *
 * - **不是每家店一份，而是整個帳戶一份。** 官網的收款與撥款都在這裡，跟 POS 門市無關。
 * - **一期一張卡，一張卡一個「下載對帳單」。** 區間是系統每半個月自己切的（1–15、
 *   16–月底），不能自己選日期；能選的只有「要看哪幾個月」。
 * - **還沒結帳的那一期沒有下載鈕**，而且金額寫的是「預計撥款金額」。那一期要跳過：
 *   把預計金額當成實際撥款寫進報表，結帳後數字會變，而報表不會自己回頭修。
 * - **直接下載，不寄信。** 出金表是寄 Email 再從 Gmail 抓附件，這裡是瀏覽器下載事件。
 */
const STATEMENT_PERIOD_PATTERN = /(\d{4})\/(\d{2})\/(\d{2})\s*~\s*(\d{4})\/(\d{2})\/(\d{2})/;

export function statementPeriodFromText(text) {
  const match = STATEMENT_PERIOD_PATTERN.exec(text ?? "");
  if (!match) return null;
  return {
    start: `${match[1]}-${match[2]}-${match[3]}`,
    end: `${match[4]}-${match[5]}-${match[6]}`,
  };
}

/** 卡片上的「撥款金額 NT$64,559」；沒結帳的那期寫的是「預計撥款金額」。 */
export function statementAmountFromText(text) {
  const match = /撥款金額[^\d]*([\d,]+)/.exec(text ?? "");
  return match ? Number(match[1].replace(/,/g, "")) : null;
}

export async function openStatementCenter(page, { origin, startMonth, endMonth, log } = {}) {
  await page.goto(`${origin}/admin/settlements`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await dismissOverlays(page, { log });

  let text = await page.locator("body").innerText();
  if (!text.includes("對帳單列表")) {
    // 網址可能改過；退回從側邊選單走一次，比猜第二個網址可靠。
    log?.("直接開 /admin/settlements 沒看到對帳單列表，改從側邊選單進入");
    await page.getByRole("link", { name: "管理中心" }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(500);
    await page.getByRole("link", { name: "對帳中心" }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await dismissOverlays(page, { log });
    text = await page.locator("body").innerText();
  }
  if (!text.includes("對帳單列表")) {
    fail("STATEMENT_PAGE_MISSING", "找不到對帳中心的「對帳單列表」。");
  }

  // 月份篩選是選填：不填就是後台預設列出的那幾期。填了要按搜尋，不然畫面不會變。
  if (startMonth || endMonth) {
    const startField = page.getByPlaceholder("開始月份");
    const endField = page.getByPlaceholder("結束月份");
    if (startMonth) await fillMonthField(page, startField, startMonth);
    if (endMonth) await fillMonthField(page, endField, endMonth);
    const actual = {
      start: startMonth ? await startField.inputValue() : "",
      end: endMonth ? await endField.inputValue() : "",
    };
    if ((startMonth && !actual.start) || (endMonth && !actual.end)) {
      fail("STATEMENT_FILTER_REJECTED", "月份欄位填不進去，可能是日期選擇器不接受直接輸入。", { actual });
    }
    await page.getByRole("button", { name: "搜尋" }).first().click({ timeout: 10000 });
    await page.waitForTimeout(2000);
    await dismissOverlays(page, { log });
  }
}

/**
 * 填月份欄位，然後**把 react-datepicker 關掉**。
 *
 * 點那個欄位會展開月份選單（`.react-datepicker__month-wrapper`），它整片蓋在畫面上，
 * 之後要點的任何東西都會被它攔截。症狀是 `locator.click: Timeout` 而錯誤訊息只說
 * 「某個 div 攔截了 pointer events」——看訊息猜不到是自己剛才打開的日期選單。
 *
 * fill() 之後選單不會自己收，要按 Escape。
 */
async function fillMonthField(page, field, value) {
  await field.fill(value);
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(300);
  // Escape 有時只收掉一層；還在的話點一下空白處。
  const picker = page.locator(".react-datepicker, .react-datepicker__month-wrapper").first();
  if (await picker.isVisible().catch(() => false)) {
    await page.locator("body").click({ position: { x: 5, y: 5 }, timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(300);
  }
}

/**
 * 列出畫面上每一期的對帳單。
 *
 * 用「有沒有下載鈕」判斷能不能抓，而不是看金額文字或帳期狀態的字串——狀態文案
 * （「帳款已確認」「本期對帳單處理中」）是最容易被改掉的東西，按鈕存不存在才是
 * 真正的能力邊界。
 */
export async function listStatements(page) {
  // 卡片必須同時含「對帳區間」與「撥款金額」：後台把標題與日期放在不同節點，
  // 只用「對帳區間」定位會停在標題列——那一列裡沒有金額也沒有下載鈕，於是每一期
  // 都會被判成不可下載，driver 什麼都抓不到（實測就是這樣壞的）。
  const cards = page.locator("div").filter({ hasText: /對帳區間/ }).filter({ hasText: /撥款金額/ });
  const total = await cards.count();
  const seen = new Map();
  for (let index = 0; index < total; index += 1) {
    const card = cards.nth(index);
    const text = await card.innerText().catch(() => '');
    const period = statementPeriodFromText(text);
    if (!period) continue;
    // 同時命中外層容器與卡片本身；取文字最短的那個，也就是最貼近單一期間的節點。
    // 外層容器會含多期的日期，statementPeriodFromText 只取第一個，所以一定要挑最短的。
    const key = `${period.start}~${period.end}`;
    const previous = seen.get(key);
    if (previous && previous.length <= text.length) continue;
    const download = card.getByRole('button', { name: '下載對帳單' });
    seen.set(key, {
      ...period,
      amount: statementAmountFromText(text),
      settled: (await download.count()) > 0,
      length: text.length,
      locator: card,
    });
  }
  return [...seen.values()]
    .map(({ length: _length, ...statement }) => statement)
    .sort((left, right) => left.start.localeCompare(right.start));
}

/**
 * 按一張卡的「下載對帳單」，回傳存下來的檔案路徑。
 *
 * 點之前要先把蓋住畫面的東西處理掉，實測有兩個會攔截 pointer events：
 * 我們自己打開的日期選單（見 fillMonthField），以及 `#new-navbar` 那條 sticky 導覽列
 * ——卡片捲到畫面上緣時會被它蓋住。scrollIntoViewIfNeeded 只保證元素在視窗裡，
 * 不保證沒有東西疊在上面。
 */
export async function downloadStatement(page, statement, { targetPath, log } = {}) {
  const button = statement.locator.getByRole("button", { name: "下載對帳單" }).first();
  await page.keyboard.press("Escape").catch(() => {});
  await dismissOverlays(page, { log });
  await button.scrollIntoViewIfNeeded({ timeout: 10000 }).catch(() => {});
  // 往上捲一點，讓卡片離開 sticky 導覽列的覆蓋範圍。
  await page.mouse.wheel(0, -120).catch(() => {});
  await page.waitForTimeout(300);
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 60000 }),
    button.click({ timeout: 15000 }),
  ]);
  await download.saveAs(targetPath);
  log?.(`下載 ${statement.start} ~ ${statement.end} → ${targetPath}`);
  return targetPath;
}
