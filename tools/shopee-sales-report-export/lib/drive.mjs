import fs from "node:fs/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";

async function json(response, what) {
  const text = await response.text();
  if (!response.ok) throw new Error(`${what} 失敗（HTTP ${response.status}）：${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function accessToken(env) {
  const body = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, refresh_token: env.GOOGLE_REFRESH_TOKEN, grant_type: "refresh_token" });
  return (await json(await fetch(TOKEN_URL, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }), "更新 Google access token")).access_token;
}

async function api(token, url, options = {}) {
  return json(await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...(options.headers ?? {}) } }), options.what ?? "Google Drive API");
}

export async function findByName(token, { parentId, name }) {
  const query = [`'${parentId}' in parents`, `name='${name.replace(/'/g, "\\'")}'`, "trashed=false"].join(" and ");
  const result = await api(token, `${DRIVE_API}/files?q=${encodeURIComponent(query)}&fields=files(id,name,webViewLink)&supportsAllDrives=true&includeItemsFromAllDrives=true`, { what: "搜尋 Drive 檔案" });
  return result.files?.[0] ?? null;
}

export async function uploadXlsx(token, { filePath, name, folderId }) {
  const bytes = await fs.readFile(filePath);
  const boundary = `----shopee${Date.now()}`;
  const metadata = JSON.stringify({ name, parents: [folderId] });
  const head = Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`, "utf8");
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return json(await fetch(`${DRIVE_UPLOAD}?uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/related; boundary=${boundary}` }, body: Buffer.concat([head, bytes, tail]) }), "上傳 xlsx 到 Drive");
}
