import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeZipEntries } from "../payout/parser.mjs";
import { statementAmountFromText, statementPeriodFromText } from "../lib/cyberbiz.mjs";
import { parseShopReport } from "../shop/parser.mjs";

function inlineCell(ref, value) {
  return `<c r="${ref}" t="inlineStr"><is><t>${String(value)}</t></is></c>`;
}

function numericCell(ref, value) {
  return `<c r="${ref}"><v>${value}</v></c>`;
}

const ITEM_HEADERS = [
  "訂單編號", "訂單成立時間", "入帳時間", "交易型態", "付款方式", "收款方", "配送方式",
  "商品名稱", "組合商品內容", "款式", "商品編號(SKU)", "產品廠商編號", "商品類別",
  "單價", "數量", "商品總額", "負項", "交易金額",
];

function columnRef(index) {
  return index < 26
    ? String.fromCharCode(65 + index)
    : `${String.fromCharCode(64 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`;
}

/** 依商品拆分的一列；只填 parser 真的會讀的欄位。 */
function itemRow(row, { name, variant = "", sku = "", category = "", quantity, gross, discount, sales }) {
  const at = (header, value, numeric = false) => {
    const ref = `${columnRef(ITEM_HEADERS.indexOf(header))}${row}`;
    return numeric ? numericCell(ref, value) : inlineCell(ref, value);
  };
  return [
    at("訂單編號", "#1"), at("交易型態", "付款"), at("收款方", "CYBERBIZ"),
    at("商品名稱", name), at("款式", variant), at("商品編號(SKU)", sku), at("商品類別", category),
    at("數量", quantity, true), at("商品總額", gross, true), at("負項", discount, true), at("交易金額", sales, true),
  ].join("");
}

async function fixture({
  start = "2026/08/16",
  end = "2026/08/31",
  collected = 1000,
  refund = 0,
  merchant = 0,
  fee = 100,
  settlement = 900,
  rows = [
    { name: "商品甲", variant: "500mL", sku: "SKU-A", category: "一般", quantity: 2, gross: 960, discount: -80, sales: 880 },
    { name: "運費", quantity: 1, gross: 120, discount: 0, sales: 120 },
  ],
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-shop-test-"));
  const filePath = path.join(root, "shop.xlsx");
  const period = `對帳區間：${start} ~ ${end}`;

  const summaryRows = [
    inlineCell("A1", period),
    inlineCell("B3", "本期代收金額") + numericCell("C3", collected),
    inlineCell("B4", "本期退款金額") + numericCell("C4", refund),
    inlineCell("B7", "本期商家自行收款淨額") + numericCell("C7", merchant),
    inlineCell("B9", "金流手續費") + numericCell("C9", 60),
    inlineCell("B10", "系統維護費") + numericCell("C10", 10),
    inlineCell("B11", "人工退款手續費") + numericCell("C11", 0),
    inlineCell("B12", "本期使用Cyber幣") + numericCell("C12", 30),
    inlineCell("B13", "本期費用淨額") + numericCell("C13", fee),
    inlineCell("B15", "本期撥款金額") + numericCell("C15", settlement),
  ].join("");

  const headerCells = ITEM_HEADERS.map((value, index) => inlineCell(`${columnRef(index)}2`, value)).join("");
  const dataRows = rows.map((row, index) => `<row r="${index + 3}">${itemRow(index + 3, row)}</row>`).join("");

  await writeZipEntries(filePath, new Map([
    ["xl/workbook.xml", `<workbook xmlns:r="x"><sheets><sheet sheetId="1" name="對帳總表" r:id="rId1"/><sheet sheetId="2" name="訂單明細（依商品拆分）" r:id="rId2"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/><Relationship Target="worksheets/sheet2.xml" Id="rId2"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData>${summaryRows}</sheetData></worksheet>`],
    ["xl/worksheets/sheet2.xml", `<worksheet><sheetData>${inlineCell("A1", period)}${headerCells}${dataRows}</sheetData></worksheet>`],
  ]));
  return { root, filePath };
}

test("解析半月對帳表：期間、營業額、撥款與逐 SKU 金額", async () => {
  const { root, filePath } = await fixture();
  try {
    const report = await parseShopReport(filePath);
    assert.deepEqual(report.period, { start: "2026-08-16", end: "2026-08-31", reportMonth: "2026-08" });
    assert.equal(report.revenueAmount, 1000);
    assert.equal(report.settlementAmount, 900);
    assert.equal(report.items.reduce((sum, item) => sum + item.salesAmount, 0), 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("沒有 SKU 的收費列補上穩定 SKU，Σ 商品才等於營業額", async () => {
  const { root, filePath } = await fixture();
  try {
    const report = await parseShopReport(filePath);
    assert.deepEqual(report.charges, [{ sku: "CYBERBIZ-CHARGE-運費", salesAmount: 120 }]);
    const shipping = report.items.find((item) => item.sku === "CYBERBIZ-CHARGE-運費");
    assert.equal(shipping.salesAmount, 120);
    assert.equal(shipping.productName, "運費");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("款式併進商品名稱，同一個 SKU 跨訂單會合併", async () => {
  const { root, filePath } = await fixture({
    collected: 1000,
    rows: [
      { name: "商品甲", variant: "500mL", sku: "SKU-A", quantity: 2, gross: 600, discount: 0, sales: 600 },
      { name: "商品甲", variant: "500mL", sku: "SKU-A", quantity: 1, gross: 400, discount: 0, sales: 400 },
    ],
  });
  try {
    const report = await parseShopReport(filePath);
    assert.equal(report.items.length, 1);
    assert.deepEqual(
      { sku: report.items[0].sku, quantity: report.items[0].quantity, salesAmount: report.items[0].salesAmount, productName: report.items[0].productName },
      { sku: "SKU-A", quantity: 3, salesAmount: 1000, productName: "商品甲（500mL）" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("拆分表金額對不上代收金額就整份拒絕", async () => {
  // 少一列的情境：欄位認錯或漏列時，報表會安靜地少一筆錢，所以必須當場失敗。
  const { root, filePath } = await fixture({ collected: 1200 });
  try {
    await assert.rejects(parseShopReport(filePath), /與對帳總表的本期代收金額 1200 不一致/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("撥款金額算不出來就整份拒絕", async () => {
  const { root, filePath } = await fixture({ settlement: 800 });
  try {
    await assert.rejects(parseShopReport(filePath), /撥款金額對不上/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("退款是負數，會從收款淨額扣掉", async () => {
  const { root, filePath } = await fixture({ refund: -200, settlement: 700 });
  try {
    const report = await parseShopReport(filePath);
    assert.equal(report.settlementAmount, 700);
    // 營業額只看代收與自行收款；退款反映在撥款，不從營業額扣。
    assert.equal(report.revenueAmount, 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("貨到付款的自行收款要算進營業額", async () => {
  const { root, filePath } = await fixture({ merchant: 500, settlement: 1400 });
  try {
    const report = await parseShopReport(filePath);
    assert.equal(report.revenueAmount, 1500);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("對帳區間跨月就拒絕——月加總會把兩個月混在一起", async () => {
  const { root, filePath } = await fixture({ start: "2026/08/16", end: "2026/09/15" });
  try {
    await assert.rejects(parseShopReport(filePath), /對帳區間跨月/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("找不到需要的工作表就說清楚實際有哪些", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-shop-test-"));
  const filePath = path.join(root, "shop.xlsx");
  await writeZipEntries(filePath, new Map([
    ["xl/workbook.xml", `<workbook xmlns:r="x"><sheets><sheet sheetId="1" name="別的表" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Target="worksheets/sheet1.xml" Id="rId1"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData></sheetData></worksheet>`],
  ]));
  try {
    await assert.rejects(parseShopReport(filePath), /找不到工作表「對帳總表」，實際有：別的表/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/*
 * 對帳中心卡片的文字解析。
 *
 * 這兩個函式決定 driver 抓哪一期、以及要不要相信卡片上的金額，所以用真的畫面文字
 * 釘住：截圖上那三張卡分別是已確認、已確認、處理中。
 */
test("卡片文字：抓得出對帳區間", () => {
  assert.deepEqual(statementPeriodFromText("對帳區間 2026/08/16 ~ 2026/08/31 展開明細"), {
    start: "2026-08-16",
    end: "2026-08-31",
  });
  assert.equal(statementPeriodFromText("對帳區間 展開明細"), null);
});

test("卡片文字：撥款金額抓得出來，預計撥款也抓得出來", () => {
  assert.equal(statementAmountFromText("撥款金額 ? NT$64,559 帳款已確認"), 64559);
  // 「預計撥款金額」也會被抓到，所以能不能下載一律看按鈕，不看金額文字。
  assert.equal(statementAmountFromText("預計撥款金額 ? NT$36,216 本期對帳單處理中"), 36216);
  assert.equal(statementAmountFromText("對帳區間 2026/09/01 ~ 2026/09/15"), null);
});
