import fs from "node:fs/promises";
import zlib from "node:zlib";

export async function readZipEntries(filePath) {
  const buffer = await fs.readFile(filePath);
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("不是有效的 xlsx（找不到 zip 目錄）。");
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    entries.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export async function writeZipEntries(filePath, entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const checksum = crc32(raw);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8); head.writeUInt32LE(checksum, 14); head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(raw.length, 22); head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, deflated);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8); dir.writeUInt16LE(8, 10); dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(deflated.length, 20); dir.writeUInt32LE(raw.length, 24); dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(entries.size, 8); eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  await fs.writeFile(filePath, Buffer.concat([...local, centralBuf, eocd]));
}

function decodeXmlText(text) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/&amp;/g, "&");
}

function escapeXml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)].map((match) =>
    decodeXmlText([...match[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?t[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)].map((item) => item[1]).join("")));
}

function parseCells(xml, shared) {
  const cells = new Map();
  for (const match of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g)) {
    const attrs = match[1];
    const inner = match[2] ?? "";
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    const raw = /<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(inner)?.[1];
    const inline = [...inner.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)].map((item) => item[1]).join("");
    if (type === "s") cells.set(ref, decodeXmlText(shared[Number(raw)] ?? ""));
    else if (type === "inlineStr" || (raw == null && inline)) cells.set(ref, decodeXmlText(inline));
    else if (raw != null) cells.set(ref, type === "str" ? decodeXmlText(raw) : Number(raw));
  }
  return cells;
}

function columnNumber(letters) {
  let result = 0;
  for (const char of letters) result = result * 26 + char.charCodeAt(0) - 64;
  return result;
}

function columnLetter(number) {
  let value = number;
  let result = "";
  while (value > 0) {
    const rest = (value - 1) % 26;
    result = String.fromCharCode(65 + rest) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function parseSheet(xml, cells) {
  const maxRow = Math.max(0, ...[...cells.keys()].map((ref) => Number(/\d+$/.exec(ref)?.[0] ?? 0)));
  const maxColumn = Math.max(0, ...[...cells.keys()].map((ref) => columnNumber(/^[A-Z]+/.exec(ref)?.[0] ?? "A")));
  const matrix = Array.from({ length: maxRow }, () => Array(maxColumn).fill(null));
  for (const [ref, value] of cells) {
    const match = /^([A-Z]+)(\d+)$/.exec(ref);
    if (!match) continue;
    matrix[Number(match[2]) - 1][columnNumber(match[1]) - 1] = value;
  }
  return { matrix, maxRow, maxColumn };
}

function relationshipTarget(target) {
  const value = target.replace(/^\//, "");
  return value.startsWith("xl/") ? value : `xl/${value.replace(/^\.\.\//, "")}`;
}

export async function readWorkbook(filePath) {
  const entries = await readZipEntries(filePath);
  const workbookXml = entries.get("xl/workbook.xml")?.toString("utf8");
  const relsXml = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
  if (!workbookXml || !relsXml) throw new Error("xlsx 裡缺少 workbook.xml 或工作表關聯資訊。");
  const rels = new Map([...relsXml.matchAll(/<Relationship\b([^>]*?)(?:\/>|>[\s\S]*?<\/Relationship>)/g)].map((match) => [
    /Id="([^"]+)"/.exec(match[1])?.[1], relationshipTarget(/Target="([^"]+)"/.exec(match[1])?.[1] ?? ""),
  ]));
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  const sheets = [...workbookXml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?sheet>)/g)].map((match) => {
    const attrs = match[1];
    const name = decodeXmlText(/name="([^"]+)"/.exec(attrs)?.[1] ?? "");
    const relationshipId = /r:id="([^"]+)"/.exec(attrs)?.[1] ?? "";
    const path = rels.get(relationshipId);
    if (!path || !entries.has(path)) throw new Error(`找不到工作表「${name}」的內容。`);
    return { name, path };
  });
  const source = sheets[0];
  if (!source) throw new Error("xlsx 裡沒有任何工作表。");
  return { entries, workbookXml, relsXml, sheets, shared, sourceSheet(name = "") {
    const selected = name ? sheets.find((sheet) => sheet.name === name) : sheets.find((sheet) => sheet.name.toLowerCase() === "orders") ?? source;
    if (!selected) throw new Error(`找不到來源工作表「${name}」。`);
    const xml = entries.get(selected.path)?.toString("utf8");
    if (!xml) throw new Error(`讀不到工作表「${selected.name}」。`);
    return { ...selected, ...parseSheet(xml, parseCells(xml, shared)) };
  } };
}

function cellXml(ref, value) {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
  const text = escapeXml(value);
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${text}</t></is></c>`;
}

function sheetXml(rows) {
  const maxRow = rows.length;
  const maxColumn = Math.max(1, ...rows.map((row) => row.length));
  const body = rows.map((row, rowIndex) => {
    const cells = row.map((value, columnIndex) => cellXml(`${columnLetter(columnIndex + 1)}${rowIndex + 1}`, value)).join("");
    return `<row r="${rowIndex + 1}">${cells}</row>`;
  }).join("");
  const widths = Array.from({ length: maxColumn }, (_, index) => `<col min="${index + 1}" max="${index + 1}" width="${index === 0 ? 34 : 18}" customWidth="1"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${columnLetter(maxColumn)}${maxRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>${widths}</cols><sheetData>${body}</sheetData></worksheet>`;
}

export async function writeOrdersWorkbook(filePath, rows) {
  if (!Array.isArray(rows) || rows.length === 0 || rows.some((row) => !Array.isArray(row))) {
    throw new Error("orders 工作表必須是至少包含一列的二維陣列。");
  }
  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="orders" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`;
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`;
  await writeZipEntries(filePath, new Map([
    ["[Content_Types].xml", contentTypes],
    ["xl/workbook.xml", workbookXml],
    ["xl/_rels/workbook.xml.rels", relsXml],
    ["xl/worksheets/sheet1.xml", sheetXml(rows)],
  ]));
}

function appendBefore(xml, closingTag, content) {
  const index = typeof closingTag === "string" ? xml.lastIndexOf(closingTag) : xml.search(closingTag);
  if (index < 0) throw new Error(`xlsx XML 缺少 ${closingTag}。`);
  return `${xml.slice(0, index)}${content}${xml.slice(index)}`;
}

export async function appendAnalysisSheets(inputPath, outputPath, sheets) {
  const workbook = await readWorkbook(inputPath);
  const entries = new Map(workbook.entries);
  const existingNumbers = [...entries.keys()].map((name) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(name)?.[1]).filter(Boolean).map(Number);
  let sheetNumber = Math.max(0, ...existingNumbers) + 1;
  const relationNumbers = [...workbook.relsXml.matchAll(/Id="rId(\d+)"/g)].map((match) => Number(match[1]));
  let relationNumber = Math.max(0, ...relationNumbers) + 1;
  const sheetNodes = [];
  let workbookXml = workbook.workbookXml;
  let relsXml = workbook.relsXml;
  let contentTypes = entries.get("[Content_Types].xml")?.toString("utf8");
  if (!contentTypes) throw new Error("xlsx 裡缺少 [Content_Types].xml。");

  const namesToReplace = new Set(sheets.map((sheet) => sheet.name));
  const removedRelationshipIds = [];
  workbookXml = workbookXml.replace(/<(?:[A-Za-z_][\w.-]*:)?sheet\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:[A-Za-z_][\w.-]*:)?sheet>)/g, (full, attrs) => {
    const name = decodeXmlText(/name="([^"]+)"/.exec(attrs)?.[1] ?? "");
    const relationshipId = /r:id="([^"]+)"/.exec(attrs)?.[1];
    if (!namesToReplace.has(name)) return full;
    if (relationshipId) removedRelationshipIds.push(relationshipId);
    return "";
  });
  for (const relationshipId of removedRelationshipIds) {
    relsXml = relsXml.replace(new RegExp(`<Relationship\\b[^>]*\\bId="${relationshipId}"[^>]*(?:\\/>|>[\\s\\S]*?<\\/Relationship>)`), "");
  }
  const workbookPrefix = /<([A-Za-z_][\w.-]*):workbook\b/.exec(workbookXml)?.[1] ?? "";
  const sheetPrefix = workbookPrefix ? `${workbookPrefix}:` : "";

  for (const sheet of sheets) {
    const path = `xl/worksheets/sheet${sheetNumber}.xml`;
    const relationshipId = `rId${relationNumber}`;
    entries.set(path, Buffer.from(sheetXml(sheet.rows), "utf8"));
    sheetNodes.push(`<${sheetPrefix}sheet name="${escapeXml(sheet.name)}" sheetId="${sheetNumber}" r:id="${relationshipId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>`);
    relsXml = appendBefore(relsXml, "</Relationships>", `<Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheetNumber}.xml"/>`);
    contentTypes = appendBefore(contentTypes, "</Types>", `<Override PartName="/${path}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    sheetNumber += 1;
    relationNumber += 1;
  }
  workbookXml = appendBefore(workbookXml, new RegExp(`</${sheetPrefix}sheets>`), sheetNodes.join(""));
  entries.set("xl/workbook.xml", Buffer.from(workbookXml, "utf8"));
  entries.set("xl/_rels/workbook.xml.rels", Buffer.from(relsXml, "utf8"));
  entries.set("[Content_Types].xml", Buffer.from(contentTypes, "utf8"));
  await writeZipEntries(outputPath, entries);
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

function number(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  let input = text(value).replace(/,/g, "");
  if (!input) return 0;
  if (/^\(.*\)$/.test(input)) input = `-${input.slice(1, -1)}`;
  const parsed = Number(input.replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function index(letter) {
  return columnNumber(letter) - 1;
}

function dateFromExcelSerial(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1 || value > 100000) return "";
  const date = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000);
  return date.toISOString().slice(0, 10);
}

function reportDate(value) {
  const serialDate = dateFromExcelSerial(value);
  if (serialDate) return serialDate;
  const match = /(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text(value));
  if (!match) return "";
  const result = `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`;
  const parsed = new Date(`${result}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === result ? result : "";
}

function inRange(value, start, end) {
  return !start || Boolean(value && value >= start && value <= end);
}

export async function transformShopeeWorkbook(inputPath, outputPath, { sourceSheet = "", start = "", end = "" } = {}) {
  const workbook = await readWorkbook(inputPath);
  const source = workbook.sourceSheet(sourceSheet);
  const required = Math.max(index("U"), index("AA"), index("AH"));
  if (source.maxColumn <= required) throw new Error(`來源工作表「${source.name}」欄位不足，至少需要 AH 欄。`);
  const iA = index("A"); const iF = index("F"); const iG = index("G"); const iS = index("S"); const iU = index("U");
  const iZ = index("Z"); const iAA = index("AA"); const iAH = index("AH"); const iAI = index("AI");
  if (Boolean(start) !== Boolean(end) || (start && start > end)) throw new Error("蝦皮報表日期區間必須同時提供有效的起訖日。 ");

  const rows = source.matrix.slice(1)
    .map((row, offset) => ({ row, sourceRow: offset + 2 }))
    .filter(({ row }) => row.some((value) => value != null && text(value) !== ""));

  const orderGroups = new Map();
  for (const item of rows) {
    const orderId = text(item.row[iA]);
    if (!orderId) continue;
    if (!orderGroups.has(orderId)) orderGroups.set(orderId, []);
    orderGroups.get(orderId).push(item);
  }
  const itemDates = new Map();
  for (const item of rows) {
    const orderId = text(item.row[iA]);
    if (orderId) continue;
    itemDates.set(item, reportDate(item.row[iF]));
  }
  for (const items of orderGroups.values()) {
    const businessDate = items.map((item) => reportDate(item.row[iF])).find(Boolean) ?? "";
    for (const item of items) itemDates.set(item, businessDate);
  }
  const selectedRows = rows.filter((item) => inRange(itemDates.get(item), start, end));
  const selectedOrders = new Map();
  for (const item of selectedRows) {
    const orderId = text(item.row[iA]);
    if (!orderId) continue;
    if (!selectedOrders.has(orderId)) selectedOrders.set(orderId, []);
    selectedOrders.get(orderId).push(item);
  }
  let duplicateRowCount = 0;
  let inconsistentDuplicateCount = 0;
  const performanceRows = [];
  const performanceRecords = [];
  for (const [orderId, items] of selectedOrders) {
    const first = items[0];
    duplicateRowCount += Math.max(0, items.length - 1);
    const signatures = new Set(items.map(({ row }) => `${number(row[iG])}|${number(row[iS])}|${number(row[iU])}`));
    if (signatures.size > 1) inconsistentDuplicateCount += 1;
    const productTotal = number(first.row[iG]);
    const fee = number(first.row[iS]);
    const processingFee = number(first.row[iU]);
    const businessDate = itemDates.get(first) || reportDate(first.row[iF]);
    const values = [orderId, businessDate || text(first.row[iF]), text(first.row[1]), productTotal, fee, processingFee, productTotal - fee - processingFee, items.length, first.sourceRow];
    performanceRows.push(values);
    performanceRecords.push({ businessDate, performance: productTotal - fee - processingFee });
  }
  const productGroups = new Map();
  for (const item of selectedRows) {
    const productId = text(item.row[iZ]);
    const option = text(item.row[iAA]);
    if (!productId && !option) continue;
    const key = `${productId}\u0000${option}`;
    const group = productGroups.get(key) ?? { productId, option, quantity: 0, returnQuantity: 0, detailRows: 0 };
    group.quantity += number(item.row[iAH]);
    group.returnQuantity += number(item.row[iAI]);
    group.detailRows += 1;
    productGroups.set(key, group);
  }
  const products = [...productGroups.values()].sort((a, b) => b.quantity - a.quantity || a.productId.localeCompare(b.productId) || a.option.localeCompare(b.option));
  const totalPerformance = performanceRows.reduce((sum, row) => sum + number(row[6]), 0);
  const totalQuantity = products.reduce((sum, row) => sum + row.quantity, 0);
  const payoutDaily = new Map();
  for (const row of performanceRecords) {
    if (!row.businessDate) continue;
    payoutDaily.set(row.businessDate, (payoutDaily.get(row.businessDate) ?? 0) + row.performance);
  }
  const salesDaily = new Map();
  for (const item of selectedRows) {
    const businessDate = itemDates.get(item);
    const productId = text(item.row[iZ]);
    if (!businessDate || !productId) continue;
    const key = `${businessDate}\u0000${productId}`;
    const previous = salesDaily.get(key) ?? {
      businessDate,
      sku: productId,
      productName: new Set(),
      category: "未分類",
      grossQuantity: 0,
      returnQuantity: 0,
      netQuantity: 0,
      salesAmount: 0,
    };
    const option = text(item.row[iAA]);
    if (option) previous.productName.add(option);
    previous.grossQuantity += number(item.row[iAH]);
    previous.returnQuantity += number(item.row[iAI]);
    previous.netQuantity = previous.grossQuantity - previous.returnQuantity;
    salesDaily.set(key, previous);
  }
  const performanceSheet = [
    ["業績計算（依訂單編號去重）"],
    ["計算規則：同一個 A 欄訂單編號只採來源第一筆；單筆業績 = G 欄商品總價 − S 欄成交手續費 − U 欄金流與系統處理費。"],
    [],
    ["指標", "數值"],
    ["來源資料列數", rows.length],
    ["不重複訂單數", performanceRows.length],
    ["排除重複列數", duplicateRowCount],
    ["總業績", totalPerformance],
    ["重複訂單金額不一致數", inconsistentDuplicateCount],
    [],
    ["訂單編號", "訂單成立日期", "訂單狀態", "商品總價（G）", "成交手續費（S）", "金流與系統處理費（U）", "業績（G-S-U）", "來源明細列數", "來源列號"],
    ...performanceRows,
  ];
  const productSheet = [
    ["商品銷售統計（商品 ID＋商品選項）"],
    ["統計規則：商品鍵 = Z 欄商品 ID + AA 欄商品選項；商品銷售數量直接加總 AH 欄，AI 退貨數量另列參考。"],
    [],
    ["指標", "數值"],
    ["來源資料列數", rows.length],
    ["商品組合數", products.length],
    ["AH 商品數量總計", totalQuantity],
    ["AI 退貨數量總計", products.reduce((sum, row) => sum + row.returnQuantity, 0)],
    [],
    ["商品鍵（Z＋AA）", "商品 ID（Z）", "商品選項（AA）", "商品銷售數量（AH）", "明細列數", "退貨數量（AI）"],
    ...products.map((item) => [`${item.productId} | ${item.option}`, item.productId, item.option, item.quantity, item.detailRows, item.returnQuantity]),
  ];
  await appendAnalysisSheets(inputPath, outputPath, [
    { name: "業績計算", rows: performanceSheet },
    { name: "商品銷售統計", rows: productSheet },
  ]);
  return {
    sourceSheet: source.name,
    sourceRows: selectedRows.length,
    uniqueOrders: performanceRows.length,
    duplicateRowsExcluded: duplicateRowCount,
    uniqueProducts: products.length,
    totalPerformance,
    totalQuantity,
    dailySalesRows: [...salesDaily.values()].map((row) => ({
      ...row,
      productName: [...row.productName].join(" / "),
      grossQuantity: Math.round(row.grossQuantity),
      returnQuantity: Math.round(row.returnQuantity),
      netQuantity: Math.round(row.netQuantity),
      salesAmount: 0,
    })),
    dailyPayoutRows: [...payoutDaily.entries()].map(([businessDate, payoutAmount]) => ({
      businessDate,
      payoutAmount: Math.round(payoutAmount),
    })),
  };
}
