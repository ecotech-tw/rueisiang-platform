import fs from "node:fs/promises";
import path from "node:path";
import { readZipEntries, writeZipEntries } from "./xlsx.mjs";

const WORKSHEET_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml";

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function cell(ref, value, { numeric = false, style = "" } = {}) {
  if (value == null || value === "") return `<c r="${ref}"${style}/>`;
  if (numeric) return `<c r="${ref}"${style}><v>${escapeXml(value)}</v></c>`;
  return `<c r="${ref}"${style} t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
}

function row(number, cells) {
  return `<row r="${number}">${cells.join("")}</row>`;
}

function nextWorksheet(entries) {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const relationships = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  const ids = [...workbook.matchAll(/sheetId="(\d+)"/g)].map((match) => Number(match[1]));
  const relationshipIds = [...relationships.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  const usedSheetNumbers = [...entries.keys()]
    .map((name) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)?.[1])
    .filter(Boolean)
    .map(Number);
  let sheetNumber = 1;
  while (usedSheetNumbers.includes(sheetNumber)) sheetNumber += 1;
  return {
    workbook,
    relationships,
    sheetNumber,
    sheetId: Math.max(0, ...ids) + 1,
    relationshipId: `rId${Math.max(0, ...relationshipIds) + 1}`,
  };
}

function salesWorksheet(document, sheetName) {
  const headers = ["櫃位", "分類", "SKU", "商品名稱", "售價", "銷售數量", "退回數量", "淨銷售數量", "售額總計", "成本總計", "毛利總計", "毛利率"];
  const headerCells = headers.map((value, index) => cell(`${String.fromCharCode(65 + index)}2`, value));
  const dataRows = document.rows.map((item, index) => {
    const rowNumber = index + 3;
    const values = [
      document.scopeName,
      item.category,
      item.sku,
      item.productName,
      item.unitPrice,
      item.grossQuantity,
      item.returnQuantity,
      item.netQuantity,
      item.salesAmount,
      item.costAmount,
      item.grossProfit,
      item.grossMargin,
    ];
    return row(rowNumber, values.map((value, column) => cell(`${String.fromCharCode(65 + column)}${rowNumber}`, value, {
      numeric: column >= 4,
    })));
  });
  const totalRow = document.rows.length + 3;
  const totals = [
    "總計", "", "", "",
    "",
    document.totals.grossQuantity,
    document.totals.returnQuantity,
    document.totals.netQuantity,
    document.totals.salesAmount,
  ];
  const totalCells = totals.map((value, column) => cell(`${String.fromCharCode(65 + column)}${totalRow}`, value, {
    numeric: column >= 5,
  }));
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:L${totalRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetData>` +
    row(1, [cell("A1", `CYBERBIZ 商品銷售總表｜${document.reportMonth}｜${sheetName}`)]) +
    row(2, headerCells) + dataRows.join("") + row(totalRow, totalCells) +
    `</sheetData></worksheet>`;
}

/**
 * 以出金 XLSX 為 base 新增商品銷售分頁。只增 ZIP entry 與 workbook relationship，
 * 所以 base workbook 原有的工作表、公式、欄位與人工填寫欄位都不會被重新產生。
 */
export async function combineCyberbizWorkbook({ payoutPath, outputPath, salesDocument, sheetName = "商品銷售總表" }) {
  if (!salesDocument || salesDocument.kind !== "cyberbiz_sales_monthly" || !Array.isArray(salesDocument.rows) || !salesDocument.rows.length) {
    throw new Error("combined XLSX 需要有效的 cyberbiz_sales_monthly document。 ");
  }
  const entries = await readZipEntries(payoutPath);
  const { workbook, relationships, sheetNumber, sheetId, relationshipId } = nextWorksheet(entries);
  if (!workbook || !relationships) throw new Error("出金 XLSX 缺少 workbook metadata。 ");
  const sheetPath = `xl/worksheets/sheet${sheetNumber}.xml`;
  const updatedWorkbook = workbook.replace("</sheets>", `<sheet name="${escapeXml(sheetName)}" sheetId="${sheetId}" r:id="${relationshipId}"/></sheets>`);
  const updatedRelationships = relationships.replace(
    "</Relationships>",
    `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNumber}.xml"/></Relationships>`,
  );
  const contentTypes = entries.get("[Content_Types].xml")?.toString("utf8") ?? "";
  if (!contentTypes) throw new Error("出金 XLSX 缺少 content types metadata。 ");
  const updatedContentTypes = contentTypes.replace(
    "</Types>",
    `<Override PartName="/${sheetPath}" ContentType="${WORKSHEET_CONTENT_TYPE}"/></Types>`,
  );
  entries.set("xl/workbook.xml", Buffer.from(updatedWorkbook, "utf8"));
  entries.set("xl/_rels/workbook.xml.rels", Buffer.from(updatedRelationships, "utf8"));
  entries.set("[Content_Types].xml", Buffer.from(updatedContentTypes, "utf8"));
  entries.set(sheetPath, Buffer.from(salesWorksheet(salesDocument, sheetName), "utf8"));
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await writeZipEntries(outputPath, entries);
  return { outputPath, sheetPath, sheetName, sheetNumber };
}
