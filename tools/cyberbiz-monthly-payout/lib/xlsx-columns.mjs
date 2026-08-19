import { readSheet, readZipEntries, writeZipEntries } from "./xlsx.mjs";

/**
 * 把對帳欄位寫進 CYBERBIZ 匯出的 xlsx。
 *
 * 為什麼是改 xlsx 而不是轉成 Google 試算表：Drive 上既有的出金表本來就是 xlsx，
 * H3 存的是 xlsx 陣列公式 <f t="array" ref="H3:H1000">，Google Sheets 開啟時會運算。
 * 維持同一種格式，人工接手時看到的東西才跟以前一樣。
 *
 * 公式一律用「原樣」寫入，不要加 _xlfn. 前綴：實測 _xlfn.UNIQUE / _xlfn._xlws.FILTER
 * 在 Google Sheets 會變成 #NAME?，直接寫 UNIQUE(...) / FILTER(...) 反而正常運算。
 */

const SHEET_ENTRY = "xl/worksheets/sheet1.xml";

function escapeXml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * 讀出某一列 A 欄實際用的樣式索引。
 * 樣式索引是每個檔案自己的（這份匯出裡 3＝粗體＋灰底的標題樣式、4＝一般資料樣式），
 * 寫死數字會在 CYBERBIZ 改樣式時默默套錯，所以從檔案現有的儲存格抄。
 */
function styleOfCell(xml, ref) {
  const match = new RegExp(`<c r="${ref}"([^>]*)`).exec(xml);
  return match ? (/\ss="(\d+)"/.exec(match[1])?.[1] ?? null) : null;
}

/**
 * 解析欄位設定裡的 style：
 *   未指定 / "none" → 不寫 s 屬性（完全不套樣式）
 *   "header"        → 跟標題列同樣式
 *   "data"          → 跟資料列同樣式
 *   數字            → 直接用該索引
 */
function styleAttr(style, { headerStyle, dataStyle }) {
  if (style == null || style === "none") return "";
  const resolved =
    style === "header" ? headerStyle : style === "data" ? dataStyle : String(style);
  return resolved ? ` s="${resolved}"` : "";
}

/** 把 cells 插進指定 row，若該 row 已有同欄位就先移除舊的（重跑同一家店不會疊出兩份）。 */
function injectIntoRow(xml, rowNumber, cellsXml, letters) {
  const rowPattern = new RegExp(`(<row[^>]*\\sr="${rowNumber}"[^>]*>)([\\s\\S]*?)(</row>)`);
  const match = rowPattern.exec(xml);
  if (!match) {
    const error = new Error(`工作表裡找不到第 ${rowNumber} 列。`);
    error.code = "ROW_NOT_FOUND";
    throw error;
  }
  let inner = match[2];
  for (const letter of letters) {
    inner = inner.replace(
      new RegExp(`<c r="${letter}${rowNumber}"(?:[^>]*/>|[^>]*>[\\s\\S]*?</c>)`, "g"),
      "",
    );
  }
  return xml.replace(rowPattern, `${match[1]}${inner}${cellsXml}${match[3]}`);
}

/**
 * @param {string} filePath 就地改寫
 * @param {object[]} columns config.json 的 columns 陣列
 *   { column, header, formula?, formulaRow?, spillTo? }
 * @returns {{ lastRow, rangeEnd, headers, formulas }}
 */
export async function addPayoutColumns(filePath, {
  columns,
  headerRow = 2,
  firstDataRow = 3,
}) {
  if (!Array.isArray(columns) || !columns.length) {
    throw new Error("config.json 的 columns 必須是非空陣列。");
  }

  const { cells, maxRow } = await readSheet(filePath);

  // 只算真的有關帳時間或收入金額的列，避免把空白列也算進來
  let lastRow = firstDataRow - 1;
  for (let row = firstDataRow; row <= maxRow; row += 1) {
    if (cells.get(`A${row}`) != null || cells.get(`E${row}`) != null) lastRow = row;
  }
  if (lastRow < firstDataRow) {
    const error = new Error("找不到任何出金資料列，不寫入欄位。");
    error.code = "EMPTY_REPORT";
    throw error;
  }

  // 公式範圍一定要超出最後一列資料：最後一天要靠「跟下一列（空白）日期不同」
  // 才判定為當日最後一列，總計列也靠 MATCH(...)+3 落在資料後面一列。
  // 生產檔用的是固定 1000，這裡沿用。
  const rangeEnd = Math.max(1000, lastRow + 100);
  const fill = (text) => String(text).replaceAll("{last}", String(rangeEnd));

  const entries = await readZipEntries(filePath);
  const sheetKey = entries.has(SHEET_ENTRY)
    ? SHEET_ENTRY
    : [...entries.keys()].find((name) => /^xl\/worksheets\/[^/]+\.xml$/.test(name));
  if (!sheetKey) throw new Error("xlsx 裡沒有工作表。");
  let xml = entries.get(sheetKey).toString("utf8");

  // 樣式索引從檔案現有的標題列與第一列資料抄過來
  const headerStyle = styleOfCell(xml, `A${headerRow}`);
  const dataStyle = styleOfCell(xml, `A${firstDataRow}`);
  const styles = { headerStyle, dataStyle };

  // 標題列：預設跟原有標題同樣式，看起來才是同一列
  const withHeader = columns.filter((item) => item.header);
  if (withHeader.length) {
    xml = injectIntoRow(
      xml,
      headerRow,
      withHeader
        .map(
          (item) =>
            `<c r="${item.column}${headerRow}"${styleAttr(item.headerStyle ?? "header", styles)}` +
            ` t="inlineStr"><is><t>${escapeXml(item.header)}</t></is></c>`,
        )
        .join(""),
      withHeader.map((item) => item.column),
    );
  }

  // 公式（同一列可能有多個欄位要寫，先照列分組再一次注入）
  const byRow = new Map();
  for (const item of columns) {
    if (!item.formula) continue;
    const row = item.formulaRow ?? firstDataRow;
    if (!byRow.has(row)) byRow.set(row, []);
    byRow.get(row).push(item);
  }
  const formulas = [];
  for (const [row, items] of byRow) {
    const cellsXml = items
      .map((item) => {
        const ref = `${item.column}${row}:${fill(item.spillTo ?? `${item.column}{last}`)}`;
        formulas.push({ column: item.column, ref });
        // 公式格預設不套任何樣式：原本沿用標題樣式（粗體＋灰底），
        // 算出來的數字整欄看起來像標題列。要套樣式在 config 的欄位加 "style"。
        return (
          `<c r="${item.column}${row}"${styleAttr(item.style, styles)}>` +
          `<f t="array" ref="${ref}">${escapeXml(fill(item.formula))}</f></c>`
        );
      })
      .join("");
    xml = injectIntoRow(xml, row, cellsXml, items.map((item) => item.column));
  }

  entries.set(sheetKey, Buffer.from(xml, "utf8"));
  await writeZipEntries(filePath, entries);

  return {
    lastRow,
    rangeEnd,
    headers: withHeader.map((item) => item.column),
    formulas,
  };
}
