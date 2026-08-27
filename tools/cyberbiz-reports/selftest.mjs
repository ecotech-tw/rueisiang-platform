#!/usr/bin/env node
/**
 * 不需要帳密、不開瀏覽器的自我檢查：日期推算、檔名規則、xlsx 驗證、
 * 遮蔽機密、報告產出。改完 lib/ 之後先跑這支，再去碰真的後台。
 *
 *   node selftest.mjs
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {
  loadConfig,
  dateRange,
  driveFolderIdFromUrl,
  driveFolderUrlFromId,
  monthRange,
  payoutFilename,
  previousMonth,
  redact,
} from "./lib/common.mjs";
import { parsePayoutReport, readSheet, readZipEntries, verifyPayoutFile, writeZipEntries } from "./payout/parser.mjs";
import { addPayoutColumns } from "./payout/columns.mjs";
import { terminalSummary, writeMarkdown } from "./lib/report.mjs";

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  process.stdout.write(
    `${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      得到 ${JSON.stringify(actual)}\n      預期 ${JSON.stringify(expected)}`}\n`,
  );
}

function crc32(buf) {
  const table = crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 依真實出金表結構造一份 xlsx（A1 日期區間、第 2 列標題、第 3 列起資料）。 */
async function makeFixture(target, { start, end, rows }) {
  const strings = [];
  const index = new Map();
  const sid = (text) => {
    if (!index.has(text)) {
      index.set(text, strings.length);
      strings.push(text);
    }
    return index.get(text);
  };
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const grid = [
    [`日期: ${start} 00:00:00 +0800 ~ ${end} 23:59:59 +0800`, "", "", "製表日期: 2026-08-01 01:10:40"],
    ["關帳時間", "入庫金額", "零用金變化", "收入類型", "收入金額", "POS機", "操作人員"],
    ...rows,
  ];
  const sheetRows = grid
    .map((row, r) => {
      const cells = row
        .map((value, c) => {
          if (value === "" || value == null) return "";
          const ref = `${String.fromCharCode(65 + c)}${r + 1}`;
          return typeof value === "number"
            ? `<c r="${ref}"><v>${value}</v></c>`
            : `<c r="${ref}" t="s"><v>${sid(value)}</v></c>`;
        })
        .join("");
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join("");

  const files = [
    ["[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'],
    ["xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join("")}</sst>`],
    ["xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`],
  ];

  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = Buffer.from(content, "utf8");
    const deflated = zlib.deflateRawSync(raw);
    const nameBuf = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(8, 8);
    head.writeUInt32LE(crc32(raw), 14);
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
    dir.writeUInt32LE(crc32(raw), 16);
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
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  await fs.writeFile(target, Buffer.concat([...local, centralBuf, eocd]));
}

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "payout-selftest-"));

// 1. 日期推算
check("2026-08-11 的上個月", previousMonth(new Date("2026-08-11T02:00:00Z")), {
  label: "2026-07",
  start: "2026-07-01",
  end: "2026-07-31",
});
check("跨年：2026-01 的上個月", previousMonth(new Date("2026-01-05T02:00:00Z")), {
  label: "2025-12",
  start: "2025-12-01",
  end: "2025-12-31",
});
check("台北時區邊界：UTC 2026-08-31T17:00 已是台北 9/1", previousMonth(new Date("2026-08-31T17:00:00Z")), {
  label: "2026-08",
  start: "2026-08-01",
  end: "2026-08-31",
});
check("閏年二月", monthRange("2028-02").end, "2028-02-29");

// 1b. 自訂區間
check("自訂區間", dateRange("2026-07-05", "2026-07-20"), {
  label: "2026-07-05~2026-07-20",
  start: "2026-07-05",
  end: "2026-07-20",
});
check("剛好整個月時沿用月份標籤", dateRange("2026-07-01", "2026-07-31").label, "2026-07");
check("跨月區間", dateRange("2026-06-15", "2026-07-14").label, "2026-06-15~2026-07-14");
check("同一天", dateRange("2026-07-08", "2026-07-08").label, "2026-07-08~2026-07-08");
for (const [label, start, end] of [
  ["日曆上不存在的日期會擋下來", "2026-02-30", "2026-03-05"],
  ["格式不對會擋下來", "2026/07/05", "2026-07-20"],
  ["起日晚於迄日會擋下來", "2026-07-20", "2026-07-05"],
  ["缺迄日會擋下來", "2026-07-05", ""],
]) {
  let rejected = false;
  try {
    dateRange(start, end);
  } catch {
    rejected = true;
  }
  check(label, rejected, true);
}
check(
  "Drive 連結可解析資料夾 ID",
  driveFolderIdFromUrl("https://drive.google.com/drive/folders/abc_DEF-123?usp=sharing"),
  "abc_DEF-123",
);
check(
  "舊版 Drive ID 可轉成連結",
  driveFolderUrlFromId("abc_DEF-123"),
  "https://drive.google.com/drive/folders/abc_DEF-123",
);

// 2. 檔名規則（要跟 CYBERBIZ 寄出的附件檔名一字不差）
check(
  "出金表檔名",
  payoutFilename("台南新光西門", "2026-07-01", "2026-07-31"),
  "[台南新光西門]每日出金報表2026-07-01~2026-07-31.xlsx",
);

// 3. 機密遮蔽
check(
  "密碼與驗證碼被遮蔽",
  redact("login pw=Hunter2Hunter2 otp 482913", { CYBERBIZ_PASSWORD: "Hunter2Hunter2" }),
  "login pw=«CYBERBIZ_PASSWORD» otp «otp»",
);

// 4. xlsx 驗證
const fixture = path.join(temp, "payout.xlsx");
await makeFixture(fixture, {
  start: "2026-07-01",
  end: "2026-07-31",
  rows: [
    ["2026-07-01 21:57:14", 2040, "0 => 0", "信用卡(不串卡機)", 10903, "POS 1543", "黃麗玉"],
    ["2026-07-01 21:57:14", 2040, "-", "現金 (含多付款方式 (現金))", 2040, "POS 1543", "黃麗玉"],
    ["2026-07-02 21:53:24", 720, "0 => 0", "現金 (含多付款方式 (現金))", 720, "POS 1543", "黃麗玉"],
    ["2026-07-02 21:53:24", 720, "-", "信用卡(不串卡機)", 17498, "POS 1543", "黃麗玉"],
  ],
});
const verified = await verifyPayoutFile(fixture, { start: "2026-07-01", end: "2026-07-31" });
check("出金合計", verified.total, 31161);
check("資料列數", verified.rows, 4);
const normalizedPayout = await parsePayoutReport(fixture, {
  scopeId: "store-a",
  scopeName: "測試店",
  start: "2026-07-01",
  end: "2026-07-31",
});
check("normalized 出金粒度", normalizedPayout.granularity, "day");
check("normalized 出金合計", normalizedPayout.totals.incomeAmount, 31161);

const wrongMonth = path.join(temp, "wrong.xlsx");
await makeFixture(wrongMonth, {
  start: "2026-06-01",
  end: "2026-06-30",
  rows: [["2026-06-01 21:00:00", 100, "0 => 0", "現金", 100, "POS 1", "甲"]],
});
let caught = null;
try {
  await verifyPayoutFile(wrongMonth, { start: "2026-07-01", end: "2026-07-31" });
} catch (error) {
  caught = error.code;
}
check("月份對不上會擋下來", caught, "RANGE_MISMATCH");

// 4b. 自閉合空儲存格不可以吃掉後面那格（CYBERBIZ 匯出就是這種寫法）
const selfClosing = path.join(temp, "self-closing.xlsx");
{
  const sheet =
    '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
    '<row r="1"><c r="A1" t="inlineStr"><is><t>日期: 2026-07-01 00:00:00 +0800 ~ 2026-07-31 23:59:59 +0800</t></is></c>' +
    '<c r="B1" s="0" /><c r="C1" s="0" /><c r="D1" t="inlineStr"><is><t>製表日期: 2026-08-01</t></is></c></row>' +
    '<row r="2"><c r="A2" t="inlineStr"><is><t>關帳時間</t></is></c><c r="E2" t="inlineStr"><is><t>收入金額</t></is></c></row>' +
    '<row r="3"><c r="A3" t="inlineStr"><is><t>2026-07-01 21:00:37</t></is></c><c r="B3" s="0" /><c r="E3"><v>1540</v></c></row>' +
    "</sheetData></worksheet>";
  await writeZipEntries(
    selfClosing,
    new Map([
      ["[Content_Types].xml", Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', "utf8")],
      ["xl/worksheets/sheet1.xml", Buffer.from(sheet, "utf8")],
    ]),
  );
}
const selfClosingCells = (await readSheet(selfClosing)).cells;
check("D1 沒有被 B1 吃掉", selfClosingCells.get("D1"), "製表日期: 2026-08-01");
check("A2 標題正確", selfClosingCells.get("A2"), "關帳時間");
check("E2 標題正確", selfClosingCells.get("E2"), "收入金額");
check("E3 數值正確", selfClosingCells.get("E3"), 1540);

// 5. 報告產出
const run = {
  label: "2026-07",
  start: "2026-07-01",
  end: "2026-07-31",
  finishedAt: new Date().toISOString(),
  driveFolderUrl: "https://drive.google.com/drive/folders/EXAMPLE",
  stores: [
    {
      store: "甲店",
      done: true,
      total: 31161,
      sheetUrl: "https://docs.google.com/spreadsheets/d/EXAMPLE",
      steps: { export: "ok", fetch: "ok", verify: "ok", upload: "ok", columns: "ok" },
    },
    {
      store: "乙店",
      done: false,
      steps: { export: "ok", fetch: "fail" },
      error: { code: "EMAIL_TIMEOUT", message: "\u001b[31m等不到附件。\u001b[0m\nsecond line | detail" },
    },
  ],
};
const reportPath = await writeMarkdown(run, path.join(temp, "reports"));
const markdown = await fs.readFile(reportPath, "utf8");
check("報告含未完成清單", markdown.includes("**乙店**：[EMAIL_TIMEOUT]"), true);
check("報告含出金合計", markdown.includes("31,161"), true);
check("報告表格不會被多行錯誤切斷", markdown.includes("等不到附件。 second line ｜ detail"), true);
check("報告移除終端 ANSI 控制碼", markdown.includes("[31m"), false);
check("終端摘要標示 1/2 完成", terminalSummary({ ...run, reportPath }).includes("完成 1/2 家"), true);
const customRange = dateRange("2026-07-05", "2026-07-20");
const customReportPath = await writeMarkdown(
  { ...run, ...customRange },
  path.join(temp, "reports"),
);
check("自訂區間的報告檔名帶起訖日", path.basename(customReportPath), "2026-07-05~2026-07-20-出金表.md");

const salesReport = {
  ...run,
  stores: [{
    store: "甲店",
    done: true,
    total: { grossQuantity: 12, returnQuantity: 2, netQuantity: 10, salesAmount: 3456 },
    sheetUrl: "https://drive.google.com/file/d/EXAMPLE",
    steps: { export: "ok", fetch: "ok", verify: "ok", upload: "ok", ingest: "ok" },
  }],
};
const salesReportPath = await writeMarkdown(salesReport, path.join(temp, "reports"), { kind: "sales" });
const salesMarkdown = await fs.readFile(salesReportPath, "utf8");
check("商品銷售報告標題正確", salesMarkdown.includes("# CYBERBIZ 商品銷售報表 2026-07"), true);
check("商品銷售報告顯示淨銷售數與售額", salesMarkdown.includes("淨 10／售額 3,456"), true);
check("商品銷售報告不會覆蓋出金報告", path.basename(salesReportPath), "2026-07-商品銷售報表.md");
check("商品銷售終端摘要不會印出 object", terminalSummary(salesReport, { kind: "sales" }).includes("[object Object]"), false);

// 6. config.json 完整性
const config = await loadConfig();

/*
 * stores.json 覆蓋 config.json 的店別。平台的「店別設定」頁存檔時會把這個檔案
 * 寫回 repo；沒有這條路，網頁上改店別不會影響執行，而兩邊看起來都正常。
 */
{
  const dir = path.join(temp, "stores-override");
  await fs.mkdir(dir, { recursive: true });
  const configPath = path.join(dir, "config.json");
  const storesPath = path.join(dir, "stores.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({ stores: [{ name: "設定檔裡的店" }], recipientEmail: "x@y.z" }),
    "utf8",
  );

  const before = await loadConfig(configPath);
  check("沒有 stores.json 時照 config.json 走", before.stores.map((item) => item.name), ["設定檔裡的店"]);

  await fs.writeFile(storesPath, JSON.stringify({ stores: [{ name: "平台存回來的店" }] }), "utf8");
  const after = await loadConfig(configPath);
  check("有 stores.json 就以它為準", after.stores.map((item) => item.name), ["平台存回來的店"]);
  check("其他設定不受影響", after.recipientEmail, "x@y.z");

  // 空清單不算數：平台還沒存過任何店的時候，不該把工具變成一家都不跑。
  await fs.writeFile(storesPath, JSON.stringify({ stores: [] }), "utf8");
  check("空的 stores.json 退回 config.json", (await loadConfig(configPath)).stores.map((item) => item.name), ["設定檔裡的店"]);

  // 壞掉的 JSON 要吵，不能默默照舊的跑——那會讓人以為存檔生效了。
  await fs.writeFile(storesPath, "{ not json", "utf8");
  let threw = false;
  try {
    await loadConfig(configPath);
  } catch {
    threw = true;
  }
  check("stores.json 壞掉時會報錯而不是默默照舊", threw, true);
}
check("config 使用 Drive 連結而非店別 ID", config.stores.every((store) => store.driveFolderUrl && !store.driveFolderId), true);
check("config 使用根資料夾連結而非 ID", Boolean(config.driveRootFolderUrl) && !config.driveRootFolderId, true);
check("config 店別不再含 performance", config.stores.every((store) => !Object.hasOwn(store, "performance")), true);
check("columns 是陣列", Array.isArray(config.columns), true);
check(
  "欄位順序與標題",
  config.columns.map((item) => `${item.column}:${item.header ?? ""}`),
  ["H:公司POS", "I:櫃位POS", "J:備註", "K:人員業績"],
);
const hColumn = config.columns.find((item) => item.column === "H");
const kColumn = config.columns.find((item) => item.column === "K");
check("H 欄公式帶 {last} 佔位", hColumn.formula.includes("{last}"), true);
check("K 欄溢出到 L（人名＋金額兩欄）", kColumn.spillTo.startsWith("L"), true);
check(
  "K 欄公式沒有加 _xlfn 前綴（加了 Google Sheets 會 #NAME?）",
  kColumn.formula.includes("_xlfn"),
  false,
);

// 7. 欄位注入：寫進 xlsx 後要讀得回來，且公式範圍必須超出最後一列資料
const injectTarget = path.join(temp, "inject.xlsx");
await fs.copyFile(fixture, injectTarget);
const injected = await addPayoutColumns(injectTarget, {
  columns: config.columns,
  headerRow: config.headerRow,
  firstDataRow: config.firstDataRow,
});
check("最後一列資料是第 6 列", injected.lastRow, 6);
check("公式範圍留了尾巴", injected.rangeEnd > injected.lastRow, true);
check("寫入的標題欄", injected.headers, ["H", "I", "J", "K"]);
check(
  "公式範圍",
  injected.formulas.map((item) => item.ref),
  [`H3:H${injected.rangeEnd}`, `K3:L${injected.rangeEnd}`],
);

const injectedCells = (await readSheet(injectTarget)).cells;
check("H2 標題", injectedCells.get("H2"), "公司POS");
check("I2 標題", injectedCells.get("I2"), "櫃位POS");
check("J2 標題", injectedCells.get("J2"), "備註");
check("K2 標題", injectedCells.get("K2"), "人員業績");

const injectedXml = (await readZipEntries(injectTarget))
  .get("xl/worksheets/sheet1.xml")
  .toString("utf8");
check(
  "H3 是陣列公式",
  /<c r="H3"[^>]*>\s*<f t="array" ref="H3:H\d+">/.test(injectedXml),
  true,
);
check(
  "K3 是陣列公式且橫跨到 L",
  /<c r="K3"[^>]*>\s*<f t="array" ref="K3:L\d+">/.test(injectedXml),
  true,
);
check("原始資料沒被動到", injectedCells.get("E3"), 10903);

// 樣式：標題跟著原標題列，公式格不套樣式（套了會變粗體＋灰底，整欄像標題）
const styleOf = (ref) => {
  const match = new RegExp(`<c r="${ref}"([^>]*)`).exec(injectedXml);
  return match ? (/\ss="(\d+)"/.exec(match[1])?.[1] ?? null) : "不存在";
};
check("H2 沿用原標題列樣式", styleOf("H2"), styleOf("A2"));
check("K2 沿用原標題列樣式", styleOf("K2"), styleOf("A2"));
check("H3 公式格不帶樣式", styleOf("H3"), null);
check("K3 公式格不帶樣式", styleOf("K3"), null);

// 重跑一次不應該疊出兩份欄位（每月補跑同一家店會發生）
await addPayoutColumns(injectTarget, {
  columns: config.columns,
  headerRow: config.headerRow,
  firstDataRow: config.firstDataRow,
});
const rerunXml = (await readZipEntries(injectTarget))
  .get("xl/worksheets/sheet1.xml")
  .toString("utf8");
for (const ref of ["H2", "I2", "J2", "K2", "H3", "K3"]) {
  check(
    `重複執行不會重複寫入 ${ref}`,
    (rerunXml.match(new RegExp(`<c r="${ref}"`, "g")) ?? []).length,
    1,
  );
}

await fs.rm(temp, { recursive: true, force: true });
process.stdout.write(failures ? `\n${failures} 項失敗\n` : "\n全部通過\n");
process.exitCode = failures ? 1 : 0;
