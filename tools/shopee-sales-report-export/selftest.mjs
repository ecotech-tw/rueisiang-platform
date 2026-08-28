import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAnalysisSheets, readWorkbook, transformShopeeWorkbook, writeOrdersWorkbook, writeZipEntries } from "./lib/xlsx.mjs";
import { ordersRowsFromOpenApi } from "./lib/open-api.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-sales-selftest-"));
try {
  const source = path.join(temp, "source.xlsx");
  const output = path.join(temp, "output.xlsx");
  const rows = Array.from({ length: 4 }, (_, index) => {
    const cells = [];
    const set = (ref, value) => cells.push(`<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`);
    const numeric = (ref, value) => cells.push(`<c r="${ref}"><v>${value}</v></c>`);
    const secondOrder = index === 3;
    set(`A${index + 1}`, index === 0 ? "訂單編號" : secondOrder ? "A002" : "A001");
    set(`F${index + 1}`, index === 0 ? "日期" : secondOrder ? "2026-07-02" : index === 1 ? "2026-07-01" : "");
    if (index === 0) { set(`G${index + 1}`, "商品總價"); set(`S${index + 1}`, "手續費"); set(`U${index + 1}`, "處理費"); set(`Z${index + 1}`, "商品ID"); set(`AA${index + 1}`, "規格"); set(`AH${index + 1}`, "數量"); set(`AI${index + 1}`, "退貨"); }
    else { numeric(`G${index + 1}`, secondOrder ? 50 : 100); numeric(`S${index + 1}`, secondOrder ? 5 : index === 1 ? 10 : 999); numeric(`U${index + 1}`, 5); set(`Z${index + 1}`, secondOrder ? "P002" : "P001"); set(`AA${index + 1}`, secondOrder ? "小" : "大"); numeric(`AH${index + 1}`, secondOrder ? 1 : index === 1 ? 2 : 3); numeric(`AI${index + 1}`, secondOrder ? 1 : 0); }
    return `<row r="${index + 1}">${cells.join("")}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:AH4"/><sheetData>${rows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="orders" sheetId="1" r:id="rId1"></sheet></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"></Relationship></Relationships>`;
  const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  await writeZipEntries(source, new Map([["[Content_Types].xml", types], ["xl/workbook.xml", workbook], ["xl/_rels/workbook.xml.rels", rels], ["xl/worksheets/sheet1.xml", sheet]]));
  const result = await transformShopeeWorkbook(source, output, { sourceSheet: "orders" });
  if (result.totalPerformance !== 125 || result.totalQuantity !== 6 || result.uniqueOrders !== 2) throw new Error(`selftest 結果不正確：${JSON.stringify(result)}`);
  if (JSON.stringify(result.dailyPayoutRows) !== JSON.stringify([
    { businessDate: "2026-07-01", payoutAmount: 85 },
    { businessDate: "2026-07-02", payoutAmount: 40 },
  ])) throw new Error(`daily payout 結果不正確：${JSON.stringify(result.dailyPayoutRows)}`);
  if (JSON.stringify(result.dailySalesRows) !== JSON.stringify([
    { businessDate: "2026-07-01", sku: "P001", productName: "大", category: "未分類", grossQuantity: 5, returnQuantity: 0, netQuantity: 5, salesAmount: 0 },
    { businessDate: "2026-07-02", sku: "P002", productName: "小", category: "未分類", grossQuantity: 1, returnQuantity: 1, netQuantity: 0, salesAmount: 0 },
  ])) throw new Error(`daily sales 結果不正確：${JSON.stringify(result.dailySalesRows)}`);
  const outsideRange = await transformShopeeWorkbook(source, path.join(temp, "outside-range.xlsx"), {
    sourceSheet: "orders",
    start: "2026-07-03",
    end: "2026-07-03",
  });
  if (outsideRange.uniqueOrders !== 0 || outsideRange.totalQuantity !== 0 || outsideRange.dailyPayoutRows.length !== 0) throw new Error(`日期篩選結果不正確：${JSON.stringify(outsideRange)}`);
  const checked = await readWorkbook(output);
  if (checked.sheets.map((item) => item.name).join(",") !== "orders,業績計算,商品銷售統計") throw new Error("selftest 分頁不正確");

  const fixture = JSON.parse(await fs.readFile(new URL("./test/fixtures/shopee-open-api.json", import.meta.url), "utf8"));
  const apiRows = ordersRowsFromOpenApi(fixture);
  if (apiRows.length !== 4 || apiRows[1]?.[0] !== "260701TEST001" || apiRows[1]?.[5] !== "2026-07-01 08:00" || apiRows[1]?.[19] !== 5) {
    throw new Error(`Open API orders 列不正確：${JSON.stringify(apiRows)}`);
  }
  if (apiRows[3]?.[34] !== 1) throw new Error(`Open API 退貨數量不正確：${JSON.stringify(apiRows[3])}`);
  const apiSource = path.join(temp, "open-api-source.xlsx");
  const apiOutput = path.join(temp, "open-api-output.xlsx");
  await writeOrdersWorkbook(apiSource, apiRows);
  const apiResult = await transformShopeeWorkbook(apiSource, apiOutput, { sourceSheet: "orders", start: "2026-07-01", end: "2026-07-31" });
  if (apiResult.totalPerformance !== 665 || apiResult.totalQuantity !== 4 || apiResult.uniqueOrders !== 2 || apiResult.uniqueProducts !== 3) {
    throw new Error(`Open API report 結果不正確：${JSON.stringify(apiResult)}`);
  }
  const apiChecked = await readWorkbook(apiOutput);
  if (apiChecked.sheets.map((item) => item.name).join(",") !== "orders,業績計算,商品銷售統計") throw new Error("Open API report 分頁不正確");

  const wrappedRows = ordersRowsFromOpenApi({
    order_list: { response: { order_list: fixture.order_list } },
    order_details: { response: { order_list: fixture.order_details } },
    escrow_details: { response: { escrow_list: fixture.escrow_details } },
    return_details: { response: { return_list: fixture.return_details } },
  });
  if (JSON.stringify(wrappedRows) !== JSON.stringify(apiRows)) throw new Error("Open API response wrapper 整理結果不一致");

  const missingProductAmount = structuredClone(fixture);
  delete missingProductAmount.escrow_details[0].order_income.product_amount;
  let missingProductAmountError;
  try {
    ordersRowsFromOpenApi(missingProductAmount);
  } catch (error) {
    missingProductAmountError = error;
  }
  if (!missingProductAmountError || !String(missingProductAmountError.message).includes("商品總價")) throw new Error("缺少商品總價時沒有失敗");
  console.log("蝦皮報表工具 selftest 全部通過");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
