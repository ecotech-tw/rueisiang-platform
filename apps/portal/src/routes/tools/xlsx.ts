/**
 * 瀏覽器端的 xlsx 讀取器。
 *
 * 只做「讀出儲存格」這一件事，夠手動上傳用。放在前端而不是 Worker：Worker 讀 xlsx
 * 得自己拆 zip 與解 deflate，而瀏覽器本來就有 DecompressionStream，而且在前端解析
 * 才能做「先預覽再送出」——使用者確認過的東西才會進 D1。
 *
 * 不引入 SheetJS 之類的套件：需要的只有共用字串表與儲存格的值，那份 API 的其餘部分
 * 都用不到，換來的是一個相當大的相依。
 */

interface ZipEntry {
  name: string;
  bytes: Uint8Array;
}

/** 從 central directory 讀出每個檔案，deflate 的用瀏覽器內建的解壓。 */
async function readZip(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // End of central directory 的簽章；註解長度不定，所以從尾巴往前找。
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  if (end < 0) throw new Error("這不是有效的 xlsx 檔案。");

  const count = view.getUint16(end + 10, true);
  let pointer = view.getUint32(end + 16, true);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const method = view.getUint16(localOffset + 8, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = bytes.subarray(start, start + compressedSize);
    entries.push({ name, bytes: method === 0 ? raw : await inflateRaw(raw) });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return new Map(entries.map((entry) => [entry.name, entry.bytes]));
}

async function inflateRaw(input: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([input as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&amp;/g, "&");
}

export type CellValue = string | number;

export interface Sheet {
  /** 以 A1 這種參照當鍵。 */
  cells: Map<string, CellValue>;
  maxRow: number;
  /** 實際有資料的欄位字母，依序。 */
  columns: string[];
}

/**
 * Excel 的序號日期。
 *
 * 1900 年那套曆法把 1900 當成閏年（相容 Lotus 1-2-3 的舊錯誤），所以基準點取
 * 1899-12-30 才會對得上。關帳時間在同一份檔案裡可能是文字也可能是序號，兩種都要吃。
 */
export function excelSerialToDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400 * 1000));
}

/**
 * 把儲存格的值轉成 YYYY-MM-DD；認得文字時間戳與 Excel 序號。
 *
 * 同一份檔案裡兩種格式會混著出現（前半是文字、後半是序號），所以兩種都要吃。
 * 序號限定在合理區間：小數字其實是「數量」之類的欄位被誤選，換算出來會是 1900 年，
 * 那種要當成解析失敗，不能安靜地寫進報表。
 */
export function toBusinessDate(value: CellValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "number") {
    // 約 2009-08 ～ 2064-04；出金報表不會有這個範圍以外的日期。
    if (value < 40000 || value > 60000) return "";
    const date = excelSerialToDate(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString().slice(0, 10);
  }
  const text = value.trim();
  // 整理過的檔案會用 2026.01.02 這種點分隔；純日期沒有時間的列也要認得。
  const match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(text);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${year}-${(month ?? "").padStart(2, "0")}-${(day ?? "").padStart(2, "0")}`;
}

/** 把儲存格的值轉成數字；吃掉千分位與貨幣符號。 */
export function toAmount(value: CellValue | undefined): number | null {
  if (value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = value.replace(/[,\s$NT]/gi, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function readFirstSheet(file: File): Promise<Sheet> {
  const zip = await readZip(await file.arrayBuffer());
  const sharedBytes = zip.get("xl/sharedStrings.xml");
  const shared = sharedBytes
    ? [...new TextDecoder().decode(sharedBytes).matchAll(/<si>([\s\S]*?)<\/si>/g)]
      .map((match) => [...(match[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)]
        .map((text) => decodeXmlText(text[1] ?? "")).join(""))
    : [];

  const sheetBytes = zip.get("xl/worksheets/sheet1.xml");
  if (!sheetBytes) throw new Error("這份 xlsx 裡找不到工作表。");
  const xml = new TextDecoder().decode(sheetBytes);

  const cells = new Map<string, CellValue>();
  const columns = new Set<string>();
  let maxRow = 0;
  for (const match of xml.matchAll(/<c r="([A-Z]+)(\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const [, column, rowText, attrs, inner] = match;
    if (!column || !rowText) continue;
    const row = Number(rowText);
    const isShared = /t="s"/.test(attrs ?? "");
    const isInline = /t="(?:inlineStr|str)"/.test(attrs ?? "");
    const rawValue = /<v>([\s\S]*?)<\/v>/.exec(inner ?? "")?.[1]
      ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(inner ?? "")?.[1];
    if (rawValue === undefined) continue;

    const value: CellValue = isShared
      ? shared[Number(rawValue)] ?? ""
      : isInline
        ? decodeXmlText(rawValue)
        : Number(rawValue);
    if (value === "" || (typeof value === "number" && Number.isNaN(value))) continue;
    cells.set(`${column}${row}`, value);
    columns.add(column);
    if (row > maxRow) maxRow = row;
  }

  return {
    cells,
    maxRow,
    columns: [...columns].sort((a, b) => (a.length - b.length) || a.localeCompare(b)),
  };
}
