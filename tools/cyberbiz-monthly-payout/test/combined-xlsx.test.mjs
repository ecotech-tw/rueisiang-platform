import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { combineCyberbizWorkbook } from "../lib/combined-xlsx.mjs";
import { readZipEntries, writeZipEntries } from "../lib/xlsx.mjs";

test("combined workbook appends a sales sheet without dropping the payout workbook", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "cyberbiz-combined-"));
  const base = path.join(temporaryDir, "payout.xlsx");
  const output = path.join(temporaryDir, "combined.xlsx");
  try {
    const salesDocument = {
      schemaVersion: 1,
      kind: "cyberbiz_sales_monthly",
      scopeType: "store",
      scopeId: "store-a",
      scopeName: "測試櫃位",
      reportMonth: "2026-07",
      coverageStart: "2026-07-01",
      coverageEnd: "2026-07-31",
      granularity: "month",
      rows: [{ sku: "SKU-1", productName: "商品一", category: "沐浴", unitPrice: 100, grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 }],
      totals: { grossQuantity: 3, returnQuantity: 1, netQuantity: 2, salesAmount: 180 },
    };
    await writeZipEntries(base, new Map([
      ["xl/worksheets/sheet1.xml", "<worksheet><sheetData><row r=\"1\"><c r=\"A1\"><f>SUM(B1:B2)</f><v>3</v></c></row></sheetData></worksheet>"],
      ["xl/workbook.xml", "<workbook xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\"><sheets><sheet name=\"出金表\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>"],
      ["xl/_rels/workbook.xml.rels", "<Relationships><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>"],
      ["[Content_Types].xml", "<Types><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>"],
    ]));
    const result = await combineCyberbizWorkbook({ payoutPath: base, outputPath: output, salesDocument });
    assert.equal(result.sheetName, "商品銷售總表");
    const entries = await readZipEntries(output);
    assert.match(entries.get("xl/workbook.xml").toString("utf8"), /商品銷售總表/);
    assert.match(entries.get(result.sheetPath).toString("utf8"), /SKU-1/);
    assert.match(entries.get(result.sheetPath).toString("utf8"), /180/);
    assert.match(entries.get("xl/worksheets/sheet1.xml").toString("utf8"), /SUM\(B1:B2\)/);
    assert.equal(entries.get("xl/worksheets/sheet1.xml").toString("utf8"), (await readZipEntries(base)).get("xl/worksheets/sheet1.xml").toString("utf8"));
  } finally {
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});
