import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBrowser } from "../lib/browser.mjs";
import { confirmStatement, downloadStatement, listStatements } from "../lib/cyberbiz.mjs";

/*
 * 對帳單是**瀏覽器下載**，不是像出金表那樣寄 Email 再從 Gmail 抓附件。這組測試
 * 用一個合成頁面把那條路走完：卡片長得跟後台一樣（區間、撥款金額、下載鈕、確認鈕，以及一張
 * 沒有下載鈕的未結帳卡），驗 listStatements 分得出來、下載與確認操作真的作用在正確卡片。
 *
 * 這裡不碰 CYBERBIZ：後台的 selector 要用真頁面確認，但「按了之後檔案會不會落地」
 * 是我們自己的程式碼，這裡就驗得完。
 */

const CARD_PAGE = `
<!doctype html><meta charset="utf-8"><title>對帳單列表</title>
<body>
  <h1>對帳單列表</h1>
  <div>
    <div class="card">
      <p>對帳區間 2026/09/01 ~ 2026/09/15</p>
      <p>預計撥款金額 ? NT$36,216</p>
      <p>本期對帳單處理中</p>
      <button>訂單明細</button>
    </div>
    <div class="card">
      <p>對帳區間 2026/08/16 ~ 2026/08/31</p>
      <p>撥款金額 ? NT$64,559</p>
      <p>帳款已確認</p>
      <button id="dl-0831">下載對帳單</button>
      <button>訂單明細</button>
    </div>
    <div class="card">
      <p>對帳區間 2026/08/01 ~ 2026/08/15</p>
      <p>撥款金額 ? NT$76,285</p>
      <button id="confirm-0815">確認帳款</button>
      <button id="dl-0815">下載對帳單</button>
    </div>
  </div>
  <script>
    // 後台是按鈕觸發下載，不是 <a download>；用同樣的方式模擬。
    for (const [id, name] of [["dl-0831", "20260816-20260831.xlsx"], ["dl-0815", "20260801-20260815.xlsx"]]) {
      document.getElementById(id).addEventListener("click", () => {
        window.location.href = "/download/" + name;
      });
    }
    document.getElementById("confirm-0815").addEventListener("click", (event) => {
      const card = event.currentTarget.parentElement;
      event.currentTarget.remove();
      const status = document.createElement("p");
      status.textContent = "帳款已確認";
      card.append(status);
    });
  </script>
</body>`;

/*
 * 頁面用一個真的 HTTP server 服務，下載也是真的 Content-Disposition 回應——
 * 後台就是這樣做的（按鈕導到一個回檔案的網址），比原本的 blob 模擬更接近實況。
 *
 * **這裡固定用 Playwright 自帶的 chromium，不用系統 Chrome。**
 * 這台機器的 headless Chrome 在下載完成後會把 page 收掉，於是 download.saveAs 拿到
 * 「Target page, context or browser has been closed」——同一份程式碼換 chromium 就
 * 三條全過，而且真的跑後台（headed、真 Chrome）也是好的。也就是說壞的是「headless
 * Chrome 對這種下載的處理」，不是我們的程式，而測試要驗的是後者。
 *
 * 注意這件事還沒有在 CI 的 headless Chrome 上證明過，見 driver 的說明。
 */
process.env.PAYOUT_BROWSER_CHANNEL = "chromium";

async function withPage(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-shop-dl-"));
  const server = createServer((request, response) => {
    const name = decodeURIComponent(request.url.replace("/download/", ""));
    if (request.url.startsWith("/download/")) {
      response.writeHead(200, {
        "content-type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "content-disposition": `attachment; filename="${name}"`,
      });
      response.end(`fake-xlsx-${name}`);
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(CARD_PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  const context = await openBrowser({ headless: true, downloadDir: path.join(root, "downloads") });
  try {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "domcontentloaded" });
    return await run(page, root);
  } finally {
    await context.close();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

test("listStatements 一期一筆，未結帳的那期標成不可下載", async () => {
  await withPage(async (page) => {
    const statements = await listStatements(page);
    assert.deepEqual(
      statements.map(({ start, end, amount, settled }) => ({ start, end, amount, settled })),
      [
        { start: "2026-08-01", end: "2026-08-15", amount: 76285, settled: true },
        { start: "2026-08-16", end: "2026-08-31", amount: 64559, settled: true },
        // 預計撥款那期抓得到金額，但沒有下載鈕——所以 settled 是 false。
        { start: "2026-09-01", end: "2026-09-15", amount: 36216, settled: false },
      ],
    );
  });
});

test("downloadStatement 把檔案存到我們指定的路徑", async () => {
  await withPage(async (page, root) => {
    const statements = await listStatements(page);
    const target = statements.find((statement) => statement.end === "2026-08-31");
    const filePath = path.join(root, "官網對帳單 2026-08-16 ~ 2026-08-31.xlsx");

    const saved = await downloadStatement(page, target, { targetPath: filePath });

    assert.equal(saved, filePath);
    assert.ok((await stat(filePath)).size > 0, "存下來的檔案是空的");
    assert.match(await readFile(filePath, "utf8"), /20260816-20260831\.xlsx/);
  });
});

test("同一頁下載兩期，兩個檔案各自落地", async () => {
  await withPage(async (page, root) => {
    const statements = (await listStatements(page)).filter((statement) => statement.settled);
    const paths = [];
    for (const statement of statements) {
      const filePath = path.join(root, `${statement.start}_${statement.end}.xlsx`);
      await downloadStatement(page, statement, { targetPath: filePath });
      paths.push(filePath);
    }
    assert.equal(paths.length, 2);
    for (const filePath of paths) assert.ok((await stat(filePath)).size > 0, `${filePath} 是空的`);
  });
});

test("確認帳款只點未確認的期間，重跑與已確認期間都不會重複點擊", async () => {
  await withPage(async (page) => {
    const statements = await listStatements(page);
    const pending = statements.find((statement) => statement.end === "2026-08-15");
    const confirmed = statements.find((statement) => statement.end === "2026-08-31");

    assert.equal(await confirmStatement(page, pending), "clicked");
    assert.equal(await confirmStatement(page, pending), "already_confirmed");
    assert.equal(await confirmStatement(page, confirmed), "already_confirmed");
    assert.equal(await page.getByRole("button", { name: "確認帳款", exact: true }).count(), 0);
    assert.match(await page.locator(".card").filter({ hasText: "2026/08/01" }).innerText(), /帳款已確認/);
  });
});
