import fs from "node:fs/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
const SHEET_MIME = "application/vnd.google-apps.spreadsheet";
const FOLDER_MIME = "application/vnd.google-apps.folder";

export const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

async function asJson(response, what) {
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`${what} 失敗（HTTP ${response.status}）：${text.slice(0, 400)}`);
    error.code = "GOOGLE_API_ERROR";
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

/**
 * 用 refresh token 換 access token。
 * Gmail 用的是另一組 token，呼叫端把 GMAIL_REFRESH_TOKEN 覆蓋進 GOOGLE_REFRESH_TOKEN 傳進來。
 */
export async function accessToken(env) {
  if (!env.GOOGLE_REFRESH_TOKEN) {
    throw new Error("缺少 refresh token（跑 node setup.mjs auth / mail）。");
  }
  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: "refresh_token",
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await asJson(response, "更新 Google access token");
  return json.access_token;
}

async function api(token, url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
  return asJson(response, options.what ?? "Google API");
}

export async function getFile(token, fileId) {
  return api(
    token,
    `${DRIVE_API}/files/${fileId}?fields=id,name,mimeType,webViewLink&supportsAllDrives=true`,
    { what: "讀取 Drive 檔案資訊" },
  );
}

/** 在 parentId 底下找同名資料夾，沒有就建立。回傳 folder id。 */
export async function ensureFolder(token, { parentId, name }) {
  const query = [
    `'${parentId}' in parents`,
    `mimeType='${FOLDER_MIME}'`,
    `name='${name.replace(/'/g, "\\'")}'`,
    "trashed=false",
  ].join(" and ");
  const found = await api(
    token,
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)` +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true",
    { what: "搜尋 Drive 資料夾" },
  );
  if (found.files?.length) return found.files[0].id;

  const created = await api(token, `${DRIVE_API}/files?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    what: "建立 Drive 資料夾",
  });
  return created.id;
}

/** 同名檔案已存在就回傳它，避免每月重跑洗出一堆重複檔。 */
export async function findByName(token, { parentId, name }) {
  const query = [
    `'${parentId}' in parents`,
    `name='${name.replace(/'/g, "\\'")}'`,
    "trashed=false",
  ].join(" and ");
  const found = await api(
    token,
    `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,mimeType,webViewLink)` +
      "&supportsAllDrives=true&includeItemsFromAllDrives=true",
    { what: "搜尋 Drive 檔案" },
  );
  return found.files?.[0] ?? null;
}

/**
 * 上傳 xlsx，維持 Office 格式不轉檔。
 * Drive 上既有的出金表本來就是 xlsx，H 欄用的是 xlsx 陣列公式，
 * 轉成 Google 原生試算表反而跟歷史檔案格式不一致。
 */
export async function uploadXlsx(token, { filePath, name, folderId }) {
  const bytes = await fs.readFile(filePath);
  const boundary = `----payout${Date.now()}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const head = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
      `--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`,
    "utf8",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");

  const response = await fetch(
    `${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: Buffer.concat([head, bytes, tail]),
    },
  );
  return asJson(response, "上傳 xlsx 到 Drive");
}

/**
 * 驗證上傳的 xlsx 裡的 H 欄公式真的算得出東西。
 * 做法：複製一份並讓 Drive 轉成 Google 原生試算表（xlsx 本身 Sheets API 讀不了），
 * 用 Sheets API 讀回 H 欄的計算結果，讀完把暫存副本刪掉。
 */
export async function verifyFormulaByTempCopy(token, fileId, { firstDataRow = 3, rows = 400 } = {}) {
  const copy = await api(token, `${DRIVE_API}/files/${fileId}/copy?supportsAllDrives=true`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: `__formula-check-${Date.now()}`, mimeType: SHEET_MIME }),
    what: "複製並轉檔以驗證公式",
  });
  try {
    const sheetTitle = await firstSheetTitle(token, copy.id);
    const values = await readColumn(token, copy.id, {
      sheetTitle,
      range: `H${firstDataRow}:H${firstDataRow + rows}`,
    });
    const computed = values
      .flat()
      .filter((value) => value !== "" && value != null)
      .map(Number)
      .filter((value) => Number.isFinite(value));
    return { count: computed.length, sample: computed.slice(0, 5), sum: computed.at(-1) ?? null };
  } finally {
    await fetch(`${DRIVE_API}/files/${copy.id}?supportsAllDrives=true`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
}

export async function firstSheetTitle(token, spreadsheetId) {
  const meta = await api(
    token,
    `${SHEETS_API}/${spreadsheetId}?fields=sheets.properties(title,sheetId)`,
    { what: "讀取試算表分頁" },
  );
  const sheet = meta.sheets?.[0]?.properties;
  if (!sheet) throw new Error("試算表沒有任何分頁。");
  return sheet.title;
}

/** 讀回 H 欄算出來的值，用來確認公式真的有運算而不是變成純文字。 */
export async function readColumn(token, spreadsheetId, { sheetTitle, range }) {
  const json = await api(
    token,
    `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(`'${sheetTitle}'!${range}`)}`,
    { what: "讀取試算表欄位" },
  );
  return json.values ?? [];
}
