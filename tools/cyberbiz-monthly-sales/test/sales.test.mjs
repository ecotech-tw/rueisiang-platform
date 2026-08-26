import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeZipEntries } from "../../cyberbiz-monthly-payout/lib/xlsx.mjs";
import { parseSalesReport } from "../lib/sales.mjs";

function inlineCell(ref, value) {
  return `<c r="${ref}" t="inlineStr"><is><t>${String(value)}</t></is></c>`;
}

function numericCell(ref, value) {
  return `<c r="${ref}"><v>${value}</v></c>`;
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cyberbiz-sales-test-"));
  const filePath = path.join(root, "sales.xlsx");
  const headers = ["廠商", "類別", "SKU", "產品廠商編號", "商品名稱", "售價", "銷售數量", "退回數量", "淨銷售數量", "售額總計", "成本總計", "毛利總計", "毛利率"];
  const headerCells = headers.map((value, index) => inlineCell(`${String.fromCharCode(65 + index)}2`, value)).join("");
  const row3 = [inlineCell("B3", "食品"), inlineCell("C3", "SKU-1"), inlineCell("E3", "商品一"), inlineCell("F3", "100"), inlineCell("G3", "3"), inlineCell("H3", "1"), inlineCell("I3", "2"), inlineCell("J3", "180"), inlineCell("K3", "0"), inlineCell("L3", "180"), inlineCell("M3", "100.00%")].join("");
  const row4 = [inlineCell("B4", "食品"), inlineCell("C4", "SKU-2"), inlineCell("E4", "商品二"), inlineCell("F4", "50"), inlineCell("G4", "2"), inlineCell("H4", "0"), inlineCell("I4", "2"), inlineCell("J4", "90"), inlineCell("K4", "0"), inlineCell("L4", "90"), inlineCell("M4", "100.00%")].join("");
  const row5 = inlineCell("A5", "總計") + [numericCell("G5", 5), numericCell("H5", 1), numericCell("I5", 4), numericCell("J5", 270)].join("");
  const xml = `<worksheet><sheetData>${inlineCell("A1", "日期: 2026-07-01 00:00:00 +0800 ~ 2026-07-31 23:59:59 +0800")}${headerCells}<row r="3">${row3}</row><row r="4">${row4}</row><row r="5">${row5}</row></sheetData></worksheet>`;
  await writeZipEntries(filePath, new Map([["xl/worksheets/sheet1.xml", xml]]));
  return { root, filePath };
}

test("parses monthly sales rows and preserves the report total", async () => {
  const context = await fixture();
  try {
    const document = await parseSalesReport(context.filePath, { scopeId: "store-a", scopeName: "測試店" });
    assert.equal(document.reportMonth, "2026-07");
    assert.equal(document.granularity, "month");
    assert.deepEqual(document.totals, { grossQuantity: 5, returnQuantity: 1, netQuantity: 4, salesAmount: 270 });
    assert.equal(document.rows[0].salesAmount, 180);
    assert.equal(document.rows[0].category, "食品");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

