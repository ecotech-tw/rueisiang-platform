import fs from "node:fs/promises";
import zlib from "node:zlib";

/**
 * 只夠用來驗證 CYBERBIZ 出金表的極簡 xlsx 讀取器。
 * 不引第三方套件的理由：這裡只需要「A1 的日期區間」與「E 欄合計」兩件事，
 * xlsx 就是 zip + XML，自己讀比多一個相依乾淨。
 */
export async function readZipEntries(filePath) {
  const buffer = await fs.readFile(filePath);
  // 找 End of Central Directory（簽章 0x06054b50），從尾端往前掃
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
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
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把 entries（Map<檔名, Buffer>）寫回成 zip。順序保留呼叫端給的順序。 */
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
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 檔名
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(checksum, 14);
    head.writeUInt32LE(deflated.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    local.push(head, nameBuf, deflated);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt32LE(checksum, 16);
    dir.writeUInt32LE(deflated.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nameBuf);
    offset += head.length + nameBuf.length + deflated.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.size, 8);
  eocd.writeUInt16LE(entries.size, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  await fs.writeFile(filePath, Buffer.concat([...local, centralBuf, eocd]));
}

function decodeXmlText(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&amp;/g, "&");
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) => {
    const parts = [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    return decodeXmlText(parts.join(""));
  });
}

/**
 * 工作表名稱 → xl/worksheets/*.xml 的檔名。
 *
 * workbook.xml 的 sheet 順序對應 rId，而 workbook.xml.rels 才知道 rId 指到哪個檔案。
 * 不能假設「第 N 個工作表就是 sheetN.xml」——那個對應只是慣例，不是規格。
 */
function sheetPaths(entries) {
  const workbook = entries.get("xl/workbook.xml")?.toString("utf8") ?? "";
  const rels = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8") ?? "";
  // 屬性順序不保證：CYBERBIZ 的 rels 是 Target 在 Id 前面，Excel 產的是反過來。
  // 所以先抓整個標籤，再各自取屬性，不要把順序寫進 regex。
  const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];
  const targets = new Map();
  for (const [tag] of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(tag, "Id");
    const target = attr(tag, "Target");
    if (id && target) targets.set(id, `xl/${target.replace(/^\/?xl\//, "")}`);
  }
  const paths = new Map();
  for (const [tag] of workbook.matchAll(/<sheet\b[^>]*>/g)) {
    const name = attr(tag, "name");
    const target = targets.get(attr(tag, "r:id") ?? "");
    if (name && target) paths.set(decodeXmlText(name), target);
  }
  return paths;
}

function readCells(xml, shared) {
  const cells = new Map();
  let maxRow = 0;

  // 自閉合的空儲存格（CYBERBIZ 匯出的 <c r="B1" s="0" />）必須單獨處理：
  // 若用「屬性 + 選擇性內容」的寫法，空儲存格會一路吃到下一個 </c>，
  // 把後面那格的值算到自己頭上，整列欄位就錯位了。
  for (const match of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const attrs = match[1];
    const inner = match[2] ?? "";
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1];
    if (!ref) continue;
    const type = /t="([^"]+)"/.exec(attrs)?.[1];
    const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
    const inlineText = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
      .map((t) => t[1])
      .join("");

    let value;
    if (type === "s") value = shared[Number(rawValue)] ?? "";
    else if (type === "inlineStr" || (!rawValue && inlineText)) value = decodeXmlText(inlineText);
    else if (rawValue == null) continue;
    else if (type === "str") value = decodeXmlText(rawValue);
    else value = Number(rawValue);

    cells.set(ref, value);
    maxRow = Math.max(maxRow, Number(/\d+$/.exec(ref)[0]));
  }
  return { cells, maxRow };
}

/** 回傳 { cells: Map<"A1", value>, maxRow } */
export async function readSheet(filePath) {
  const entries = await readZipEntries(filePath);
  const sheetName =
    [...entries.keys()].find((name) => /^xl\/worksheets\/sheet1\.xml$/.test(name)) ??
    [...entries.keys()].find((name) => /^xl\/worksheets\/.*\.xml$/.test(name));
  if (!sheetName) throw new Error("xlsx 裡沒有工作表。");

  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  return readCells(entries.get(sheetName).toString("utf8"), shared);
}

/**
 * 依工作表名稱讀。對帳表有四張表，靠位置抓遲早會抓錯——CYBERBIZ 只要調一次順序，
 * 錯的那份會照樣解析成功，只是數字全錯。
 */
export async function readNamedSheets(filePath, names) {
  const entries = await readZipEntries(filePath);
  const paths = sheetPaths(entries);
  const shared = parseSharedStrings(entries.get("xl/sharedStrings.xml")?.toString("utf8"));
  const result = new Map();
  for (const name of names) {
    const target = paths.get(name);
    if (!target || !entries.has(target)) {
      throw new Error(`對帳表裡找不到工作表「${name}」，實際有：${[...paths.keys()].join("、") || "（無）"}`);
    }
    result.set(name, readCells(entries.get(target).toString("utf8"), shared));
  }
  return result;
}

/**
 * 驗證是不是目標月份的每日出金表，並算出 E 欄（收入金額）合計。
 * A1 形如：「日期: 2026-07-01 00:00:00 +0800 ~ 2026-07-31 23:59:59 +0800」
 */
export async function verifyPayoutFile(filePath, { start, end, firstDataRow = 3 }) {
  const { cells, maxRow } = await readSheet(filePath);
  const header = String(cells.get("A1") ?? "");
  if (!header.includes(start) || !header.includes(end)) {
    const error = new Error(`檔案的日期區間對不上（A1：${header || "空白"}）。`);
    error.code = "RANGE_MISMATCH";
    throw error;
  }
  if (String(cells.get("A2") ?? "") !== "關帳時間") {
    const error = new Error(`第 2 列不是預期的標題列（A2：${cells.get("A2") ?? "空白"}）。`);
    error.code = "HEADER_MISMATCH";
    throw error;
  }

  let total = 0;
  let rows = 0;
  for (let row = firstDataRow; row <= maxRow; row += 1) {
    if (cells.get(`A${row}`) == null) continue;
    rows += 1;
    const value = cells.get(`E${row}`);
    if (typeof value === "number") total += value;
  }
  if (rows === 0) {
    const error = new Error("檔案裡沒有任何出金資料列。");
    error.code = "EMPTY_REPORT";
    throw error;
  }
  return { header, rows, total, maxRow };
}

/**
 * 把每日出金表轉成查詢用的日資料。原始 XLSX 仍由 driver 上傳到 Drive；
 * D1 只接收日期與出金金額，不保留支付方式、POS 或操作人員維度。
 */
export async function parsePayoutReport(filePath, {
  scopeType = "store",
  scopeId,
  scopeName = "",
  start,
  end,
  parserVersion = "cyberbiz-payout-v1",
  firstDataRow = 3,
} = {}) {
  const { cells, maxRow } = await readSheet(filePath);
  const header = String(cells.get("A1") ?? "");
  if (!header.includes(start) || !header.includes(end)) {
    const error = new Error(`出金表的日期區間對不上（A1：${header || "空白"}）。`);
    error.code = "RANGE_MISMATCH";
    throw error;
  }
  if (String(cells.get("A2") ?? "") !== "關帳時間") {
    const error = new Error(`出金表第一欄不是關帳時間（A2：${cells.get("A2") ?? "空白"}）。`);
    error.code = "HEADER_MISMATCH";
    throw error;
  }
  if (!scopeId) throw new Error("出金表 normalized JSON 需要 scopeId。");
  if (!start || !end || start > end) throw new Error("出金表需要有效的 start 與 end。");

  const rows = [];
  for (let row = firstDataRow; row <= maxRow; row += 1) {
    const closeAt = String(cells.get(`A${row}`) ?? "").trim();
    if (!closeAt) continue;
    const date = closeAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start || date > end) {
      const error = new Error(`出金表第 ${row} 列日期不在指定區間：${closeAt}`);
      error.code = "RANGE_MISMATCH";
      throw error;
    }
    const rawAmount = cells.get(`E${row}`);
    const amount = typeof rawAmount === "number" ? rawAmount : Number(String(rawAmount ?? "").replace(/,/g, ""));
    if (!Number.isFinite(amount)) throw new Error(`出金表第 ${row} 列收入金額不是數字。`);
    rows.push({
      date,
      closeAt,
      incomeAmount: amount,
    });
  }
  if (!rows.length) throw new Error("出金表沒有任何資料列。");

  return {
    schemaVersion: 1,
    kind: "cyberbiz_payout_daily",
    scopeType,
    scopeId,
    scopeName,
    reportMonth: start.slice(0, 7),
    coverageStart: start,
    coverageEnd: end,
    granularity: "day",
    rows,
    totals: {
      incomeAmount: rows.reduce((total, item) => total + item.incomeAmount, 0),
      rowCount: rows.length,
    },
    source: { filename: filePath.split(/[\\/]/).at(-1), parserVersion },
  };
}
