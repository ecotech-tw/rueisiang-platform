import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url));

// 所有工具執行期路徑都以 tools/cyberbiz-monthly-payout 為基準，
// 不依賴啟動 Node 時所在的工作目錄。
export const SKILL_DIR = path.resolve(LIB_DIR, "..");

export function skillPath(...parts) {
  return path.join(SKILL_DIR, ...parts);
}

/** 只認 KEY=VALUE，不做 shell 展開。缺檔就回空物件。 */
export async function loadEnv(file = skillPath(".env")) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

/** 寫回 .env，保留既有註解與順序，只覆寫指定的 key。 */
export async function saveEnv(updates, file = skillPath(".env")) {
  let lines = [];
  try {
    lines = (await fs.readFile(file, "utf8")).split(/\r?\n/);
  } catch {
    lines = [];
  }
  const remaining = new Map(Object.entries(updates));
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return line;
    const eq = trimmed.indexOf("=");
    if (eq < 1) return line;
    const key = trimmed.slice(0, eq).trim();
    if (!remaining.has(key)) return line;
    const value = remaining.get(key);
    remaining.delete(key);
    return `${key}=${value}`;
  });
  for (const [key, value] of remaining) output.push(`${key}=${value}`);
  await fs.writeFile(file, output.join("\n").replace(/\n*$/, "\n"), "utf8");
}

/**
 * 讀設定。店別清單如果有 stores.json 就以它為準，蓋掉 config.json 裡的那一份。
 *
 * 兩個檔案的來源不同：config.json 是這個工具自己的設定（CYBERBIZ 網址、Drive
 * 根目錄、欄位公式），由開發者維護；stores.json 是平台「店別設定」頁存檔時
 * 寫回來的，由同仁維護。
 *
 * 沒有這一段的話，平台上改店別完全不會影響執行——設定頁看起來有存檔，實際上
 * driver 還是照 config.json 跑。那是最難查的一種落差：兩邊都「正常」，只是
 * 講的不是同一件事。
 *
 * stores.json 不存在時行為完全不變，所以還沒用過設定頁的環境不受影響。
 */
export async function loadConfig(file = skillPath("config.json")) {
  const config = JSON.parse(await fs.readFile(file, "utf8"));

  // 跟 config 檔同一個目錄找，而不是寫死 skillPath——測試才有辦法給一份假的。
  const storesFile = path.join(path.dirname(file), "stores.json");
  try {
    const raw = await fs.readFile(storesFile, "utf8");
    const stores = JSON.parse(raw).stores;
    if (Array.isArray(stores) && stores.length) config.stores = stores;
  } catch (error) {
    // 檔案不存在是正常狀態；其他錯誤（例如 JSON 壞掉）要讓人知道，不能默默跑舊的。
    if (error.code !== "ENOENT") throw error;
  }

  return config;
}

export async function saveConfig(config, file = skillPath("config.json")) {
  await fs.writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

/** 從 Google Drive 資料夾連結取出 API 所需的 ID。也接受舊版直接填入的 ID。 */
export function driveFolderIdFromUrl(value = "") {
  const input = String(value ?? "").trim();
  if (!input) return "";
  const pathMatch = /\/folders\/([A-Za-z0-9_-]+)/.exec(input);
  if (pathMatch) return pathMatch[1];
  const queryMatch = /(?:^|[?&])id=([A-Za-z0-9_-]+)/.exec(input);
  if (queryMatch) return queryMatch[1];
  return /^[A-Za-z0-9_-]+$/.test(input) ? input : "";
}

/** 把舊版資料夾 ID 轉成員工容易辨識的 Google Drive 連結。 */
export function driveFolderUrlFromId(value = "") {
  const id = driveFolderIdFromUrl(value);
  return id ? `https://drive.google.com/drive/folders/${id}` : "";
}

/** Asia/Taipei 的「上個月」，回傳 { label: "2026-07", start, end }，日期皆為 YYYY-MM-DD。 */
export function previousMonth(now = new Date()) {
  const taipei = new Date(now.getTime() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth() + 1;
  month -= 1;
  if (month === 0) {
    month = 12;
    year -= 1;
  }
  return monthRange(`${year}-${String(month).padStart(2, "0")}`);
}

/** "2026-07" → { label: "2026-07", start: "2026-07-01", end: "2026-07-31" } */
export function monthRange(month) {
  const match = /^(\d{4})-(\d{2})$/.exec(month ?? "");
  if (!match) throw new Error(`月份格式必須是 YYYY-MM，收到：${month}`);
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  if (monthNumber < 1 || monthNumber > 12) {
    throw new Error(`月份超出範圍：${month}`);
  }
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return {
    label: `${match[1]}-${match[2]}`,
    start: `${match[1]}-${match[2]}-01`,
    end: `${match[1]}-${match[2]}-${String(lastDay).padStart(2, "0")}`,
  };
}

/**
 * YYYY-MM-DD，順便擋掉 2026-02-30 這種日曆上不存在的日期
 * （Date 會自己把它捲到 3/2，所以要比對回推的字串）。
 */
export function isoDate(value, what = "日期") {
  const input = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(input)) {
    const parsed = new Date(`${input}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === input) {
      return input;
    }
  }
  throw new Error(`${what}格式必須是 YYYY-MM-DD，收到：${value ?? ""}`);
}

/**
 * 任意起訖日 → { label, start, end }。
 * 剛好是整個月時 label 仍是 "2026-07"，讓 staging 目錄與報告檔名跟以前一致。
 */
export function dateRange(start, end) {
  const from = isoDate(start, "起日");
  const to = isoDate(end, "迄日");
  if (from > to) throw new Error(`起日不能晚於迄日：${from} ~ ${to}`);
  const whole = monthRange(from.slice(0, 7));
  return {
    label: whole.start === from && whole.end === to ? whole.label : `${from}~${to}`,
    start: from,
    end: to,
  };
}

/** CYBERBIZ 匯出檔名規則，與 browser_workflow.mjs 的 expectedFilenames 一致。 */
export function payoutFilename(storeName, startDate, endDate) {
  return `[${storeName}]每日出金報表${startDate}~${endDate}.xlsx`;
}

/** 商品銷售總表的檔名；與 CYBERBIZ 寄到 Gmail 的附件命名一致。 */
export function salesFilename(storeName, startDate, endDate) {
  return `[${storeName}]商品銷售總表${startDate}~${endDate}.xlsx`;
}

const SECRET_KEYS = [
  "CYBERBIZ_PASSWORD",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REFRESH_TOKEN",
];

/** 任何要印出來的字串都先過這裡，避免密碼或驗證碼外洩到 log 與報告。 */
export function redact(text, env = {}) {
  let output = String(text ?? "");
  for (const key of SECRET_KEYS) {
    const value = env[key];
    if (value && value.length > 3) {
      output = output.split(value).join(`«${key}»`);
    }
  }
  return output.replace(/\b\d{6}\b/g, "«otp»");
}

export function log(message) {
  process.stdout.write(`${message}\n`);
}

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(
      `.env 缺少：${missing.join("、")}（請照 .env.example 補齊）`,
    );
  }
}
