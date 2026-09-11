import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openBrowser } from "../lib/browser.mjs";
import { downloadStatement, listStatements } from "../lib/cyberbiz.mjs";

/*
 * 對帳單是**瀏覽器下載**，不是像出金表那樣寄 Email 再從 Gmail 抓附件。這兩支測試
 * 用一個合成頁面把那條路走完：卡片長得跟後台一樣（區間、撥款金額、下載鈕，以及一張
 * 沒有下載鈕的未結帳卡），驗 listStatements 分得出來、downloadStatement 真的把檔案
 * 存到我們指定的路徑。
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
      <button id="dl-0815">下載對帳單</button>
    </div>
  </div>
  <script>
    // 後台是按鈕觸發下載，不是 <a download>；用同樣的方式模擬。
    for (const [id, name] of [["dl-0831", "20260816-20260831.xlsx"], ["dl-0815", "20260801-20260815.xlsx"]]) {
      document.getElementById(id).addEventListener("click", () => {
        const blob = new Blob(["fake-xlsx-" + name], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = name;
        document.body.appendChild(link);
        link.click();
      });
    }
  </script>
</body>`;

async function withPage(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-shop-dl-"));
  const context = await openBrowser({ headless: true, downloadDir: path.join(root, "downloads") });
  try {
    const page = await context.newPage();
    await page.setContent(CARD_PAGE);
    return await run(page, root);
  } finally {
    await context.close();
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
