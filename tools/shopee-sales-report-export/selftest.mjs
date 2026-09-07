import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { processShopeeWorkbook } from "./driver.mjs";
import { appendAnalysisSheets, readWorkbook, transformShopeeWorkbook, writeZipEntries } from "./lib/xlsx.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-sales-selftest-"));
try {
  const source = path.join(temp, "source.xlsx");
  const output = path.join(temp, "output.xlsx");
  const sourceRows = [
    { orderId: "訂單編號", date: "日期", status: "訂單狀態", productTotal: "商品總價", fee: "手續費", processingFee: "處理費", productId: "商品ID", option: "規格", modelId: "規格ID", unitPrice: "商品單價", quantity: "數量", returnQuantity: "退貨" },
    { orderId: "A001", date: "2026-07-01", status: "completed", productTotal: 101, fee: 10, processingFee: 5, productId: "P001", option: "大", modelId: "M001", unitPrice: 30, quantity: 2, returnQuantity: 0 },
    { orderId: "", date: "", status: "completed", productTotal: "", fee: "", processingFee: "", productId: "P002", option: "中", modelId: "M002", unitPrice: 41, quantity: 1, returnQuantity: 0 },
    { orderId: "A002", date: "2026-07-02", status: "completed", productTotal: 50, fee: 5, processingFee: 5, productId: "P003", option: "小", modelId: "M003", unitPrice: 50, quantity: 1, returnQuantity: 1 },
  ];
  const rows = sourceRows.map((item, index) => {
    const rowNumber = index + 1;
    const cells = [];
    const set = (ref, value) => cells.push(`<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`);
    const numeric = (ref, value) => cells.push(`<c r="${ref}"><v>${value}</v></c>`);
    set(`A${rowNumber}`, item.orderId);
    set(`B${rowNumber}`, item.status);
    set(`F${rowNumber}`, item.date);
    if (typeof item.productTotal === "number") numeric(`G${rowNumber}`, item.productTotal); else set(`G${rowNumber}`, item.productTotal);
    if (typeof item.fee === "number") numeric(`S${rowNumber}`, item.fee); else set(`S${rowNumber}`, item.fee);
    if (typeof item.processingFee === "number") numeric(`U${rowNumber}`, item.processingFee); else set(`U${rowNumber}`, item.processingFee);
    set(`Z${rowNumber}`, item.productId);
    set(`AA${rowNumber}`, item.option);
    set(`AB${rowNumber}`, item.modelId);
    if (typeof item.unitPrice === "number") numeric(`AE${rowNumber}`, item.unitPrice); else set(`AE${rowNumber}`, item.unitPrice);
    if (typeof item.quantity === "number") numeric(`AH${rowNumber}`, item.quantity); else set(`AH${rowNumber}`, item.quantity);
    if (typeof item.returnQuantity === "number") numeric(`AI${rowNumber}`, item.returnQuantity); else set(`AI${rowNumber}`, item.returnQuantity);
    return `<row r="${rowNumber}">${cells.join("")}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:AI4"/><sheetData>${rows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="orders" sheetId="1" r:id="rId1"></sheet></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"></Relationship></Relationships>`;
  const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  await writeZipEntries(source, new Map([["[Content_Types].xml", types], ["xl/workbook.xml", workbook], ["xl/_rels/workbook.xml.rels", rels], ["xl/worksheets/sheet1.xml", sheet]]));
  const result = await transformShopeeWorkbook(source, output, { sourceSheet: "orders" });
  if (result.totalPerformance !== 126 || result.totalQuantity !== 4 || result.totalSalesAmount !== 151 || result.uniqueOrders !== 2) throw new Error(`selftest 結果不正確：${JSON.stringify(result)}`);
  if (JSON.stringify(result.dailyPayoutRows) !== JSON.stringify([
    { businessDate: "2026-07-01", payoutAmount: 86 },
    { businessDate: "2026-07-02", payoutAmount: 40 },
  ])) throw new Error(`daily payout 結果不正確：${JSON.stringify(result.dailyPayoutRows)}`);
  if (JSON.stringify(result.dailySalesRows) !== JSON.stringify([
    { businessDate: "2026-07-01", sku: "P001_M001", productName: "大", category: "未分類", grossQuantity: 2, returnQuantity: 0, netQuantity: 2, salesAmount: 60 },
    { businessDate: "2026-07-01", sku: "P002_M002", productName: "中", category: "未分類", grossQuantity: 1, returnQuantity: 0, netQuantity: 1, salesAmount: 41 },
    { businessDate: "2026-07-02", sku: "P003_M003", productName: "小", category: "未分類", grossQuantity: 1, returnQuantity: 1, netQuantity: 0, salesAmount: 50 },
  ])) throw new Error(`daily sales 結果不正確：${JSON.stringify(result.dailySalesRows)}`);
  const outsideRange = await transformShopeeWorkbook(source, path.join(temp, "outside-range.xlsx"), {
    sourceSheet: "orders",
    start: "2026-07-03",
    end: "2026-07-03",
  });
  if (outsideRange.uniqueOrders !== 0 || outsideRange.totalQuantity !== 0 || outsideRange.totalSalesAmount !== 0 || outsideRange.dailyPayoutRows.length !== 0) throw new Error(`日期篩選結果不正確：${JSON.stringify(outsideRange)}`);
  const checked = await readWorkbook(output);
  if (checked.sheets.map((item) => item.name).join(",") !== "orders,業績計算,商品銷售統計") throw new Error("selftest 分頁不正確");
  const productSheet = checked.sourceSheet("商品銷售統計").matrix;
  if (productSheet[8]?.[0] !== "商品銷售金額總計（AE×AH）" || productSheet[8]?.[1] !== 151) throw new Error("商品銷售金額沒有寫入統計工作表");
  if (productSheet[10]?.[4] !== "商品銷售金額（AE×AH）" || productSheet[11]?.[4] !== 60) throw new Error("商品銷售金額明細欄位不正確");

  const toolDir = path.dirname(fileURLToPath(import.meta.url));
  const reportsDir = path.relative(toolDir, path.join(temp, "driver-reports"));
  const stagingDir = path.relative(toolDir, path.join(temp, "driver-staging"));
  await processShopeeWorkbook({
    inputPath: source,
    outputPath: path.join(temp, "driver-output.xlsx"),
    skipUpload: true,
    start: "2026-07-01",
    end: "2026-07-31",
    sourceSheet: "orders",
    config: { sourceSheet: "orders", stagingDir, reportsDir, driveFolderUrl: "" },
    env: {},
  });
  const report = await fs.readFile(path.join(temp, "driver-reports", "2026-07-蝦皮銷售報表.md"), "utf8");
  if (!report.includes("商品銷售金額合計：151") || !report.includes("AE 欄商品單價 × AH 欄商品銷售數量")) throw new Error("driver report 沒有寫入商品銷售金額與規則");

  console.log("蝦皮報表工具 selftest 全部通過");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
