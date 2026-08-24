import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { appendAnalysisSheets, readWorkbook, transformShopeeWorkbook, writeZipEntries } from "./lib/xlsx.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "shopee-sales-selftest-"));
try {
  const source = path.join(temp, "source.xlsx");
  const output = path.join(temp, "output.xlsx");
  const rows = Array.from({ length: 3 }, (_, index) => {
    const cells = [];
    const set = (ref, value) => cells.push(`<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`);
    const numeric = (ref, value) => cells.push(`<c r="${ref}"><v>${value}</v></c>`);
    set(`A${index + 1}`, index === 0 ? "訂單編號" : index === 1 ? "A001" : "A001");
    set(`F${index + 1}`, index === 0 ? "日期" : "2026-07-01");
    if (index === 0) { set(`G${index + 1}`, "商品總價"); set(`S${index + 1}`, "手續費"); set(`U${index + 1}`, "處理費"); set(`Z${index + 1}`, "商品ID"); set(`AA${index + 1}`, "規格"); set(`AH${index + 1}`, "數量"); set(`AI${index + 1}`, "退貨"); }
    else { numeric(`G${index + 1}`, 100); numeric(`S${index + 1}`, index === 1 ? 10 : 999); numeric(`U${index + 1}`, 5); set(`Z${index + 1}`, "P001"); set(`AA${index + 1}`, "大"); numeric(`AH${index + 1}`, index === 1 ? 2 : 3); numeric(`AI${index + 1}`, 0); }
    return `<row r="${index + 1}">${cells.join("")}</row>`;
  }).join("");
  const sheet = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:AH3"/><sheetData>${rows}</sheetData></worksheet>`;
  const workbook = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="orders" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const types = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  await writeZipEntries(source, new Map([["[Content_Types].xml", types], ["xl/workbook.xml", workbook], ["xl/_rels/workbook.xml.rels", rels], ["xl/worksheets/sheet1.xml", sheet]]));
  const result = await transformShopeeWorkbook(source, output, { sourceSheet: "orders" });
  if (result.totalPerformance !== 85 || result.totalQuantity !== 5 || result.uniqueOrders !== 1) throw new Error(`selftest 結果不正確：${JSON.stringify(result)}`);
  const checked = await readWorkbook(output);
  if (checked.sheets.map((item) => item.name).join(",") !== "orders,業績計算,商品銷售統計") throw new Error("selftest 分頁不正確");
  console.log("蝦皮報表工具 selftest 全部通過");
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
