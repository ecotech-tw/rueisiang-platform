import { getShopeeSalesSettings, listReportManagementScopes, listShopeeSalesRuns, recordShopeeSalesRun } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/auth.js";
import { shopeeSalesGithub } from "../shopee-sales/github.js";
import { shopeePreviewKey } from "../shopee-sales/preview.js";

const MAX_REPORT_BYTES = 25 * 1024 * 1024;

async function sha256Hex(value: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", value));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isValidDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function previousMonthRange(): { start: string; end: string } {
  const taipei = new Date(Date.now() + 8 * 3600 * 1000);
  let year = taipei.getUTCFullYear();
  let month = taipei.getUTCMonth();
  if (month === 0) { year -= 1; month = 12; }
  const padded = String(month).padStart(2, "0");
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { start: `${year}-${padded}-01`, end: `${year}-${padded}-${lastDay}` };
}

function rangeFromFilename(fileName: string): { start: string; end: string } {
  const match = /(\d{4})(\d{2})(\d{2})[_-](\d{4})(\d{2})(\d{2})/.exec(fileName);
  if (match) {
    const start = `${match[1]}-${match[2]}-${match[3]}`;
    const end = `${match[4]}-${match[5]}-${match[6]}`;
    if (isValidDate(start) && isValidDate(end) && start <= end) return { start, end };
  }
  return previousMonthRange();
}

function readDriveUrl(value: unknown, required: boolean): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url && required) throw new HTTPException(400, { message: "請先設定 Google Drive 資料夾連結。" });
  if (url && !/^https?:\/\/[^\s]*(\/folders\/[\w-]+|[?&]id=[\w-]+)/.test(url)) {
    throw new HTTPException(400, { message: "Google Drive 資料夾連結格式不正確。" });
  }
  return url;
}

function isFile(value: unknown): value is File {
  const candidate = value as { arrayBuffer?: unknown; name?: unknown } | null;
  return Boolean(candidate && typeof candidate.arrayBuffer === "function" && typeof candidate.name === "string");
}

export const shopeeSales = new Hono<AppEnv>()
  .get("/state", requirePermission("tools:shopee-sales:run"), async (c) => {
    const scopes = (await listReportManagementScopes(c.get("db")))
      .filter((scope) => scope.sourceType === "shopee" && scope.scopeKind === "channel" && scope.active && !scope.archivedAt)
      .map(({ id, name, driveFolderUrl, driveFolderName }) => ({ id, name, driveFolderUrl, driveFolderName }));
    // 只要最新一筆來接回進度；歷次紀錄統一看「執行紀錄」分頁。
    const [latest] = await listShopeeSalesRuns(c.get("db"), 1);
    return c.json({ scopes, ...previousMonthRange(), configured: Boolean(shopeeSalesGithub(c.env) && c.env.UPLOADS), latestRequestId: latest?.requestId ?? null });
  })
  .post("/preview", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN，無法觸發解析。" });
    if (!c.env.UPLOADS) throw new HTTPException(503, { message: "平台還沒設定報表暫存空間。" });

    const form = await c.req.formData();
    const scopeIdValue = form.get("scopeId");
    if (typeof scopeIdValue !== "string" || !scopeIdValue.trim()) throw new HTTPException(400, { message: "請選擇蝦皮通路。" });
    const scope = (await listReportManagementScopes(c.get("db"))).find((candidate) =>
      candidate.id === scopeIdValue.trim()
      && candidate.sourceType === "shopee"
      && candidate.scopeKind === "channel"
      && candidate.active
      && !candidate.archivedAt,
    );
    if (!scope) throw new HTTPException(400, { message: "請選擇啟用中的蝦皮通路。" });
    const driveFolderUrl = readDriveUrl(scope.driveFolderUrl, true);
    const file = form.get("file");
    if (!isFile(file)) throw new HTTPException(400, { message: "請選擇一份蝦皮 xlsx 報表。" });
    if (!/\.xlsx$/i.test(file.name)) throw new HTTPException(400, { message: "目前只接受 .xlsx 檔案。" });
    if (file.size > MAX_REPORT_BYTES) throw new HTTPException(400, { message: `報表不能超過 ${MAX_REPORT_BYTES / 1024 / 1024} MB。` });
    const password = form.get("password");
    if (typeof password !== "string" || !password) throw new HTTPException(400, { message: "請輸入報表密碼。" });

    const requestId = crypto.randomUUID();
    const sourceToken = crypto.randomUUID();
    const previewToken = crypto.randomUUID();
    const range = rangeFromFilename(file.name);
    const fileBytes = await file.arrayBuffer();
    const fileHash = await sha256Hex(fileBytes);
    const passwordHash = await sha256Hex(new TextEncoder().encode(password).buffer as ArrayBuffer);
    const objectKey = `shopee-sales/${requestId}/${sourceToken}.xlsx`;
    const previewKey = shopeePreviewKey(requestId, previewToken);
    const expiresAt = String(Date.now() + 60 * 60 * 1000);
    const baseUrl = c.env.SHOPEE_SOURCE_BASE_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;
    const sourceUrl = `${baseUrl}/api/internal/shopee-sales/source/${requestId}?token=${sourceToken}`;
    const callbackUrl = `${baseUrl}/api/internal/shopee-sales/preview/${requestId}`;
    try {
      await c.env.UPLOADS.put(objectKey, fileBytes, {
        httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        customMetadata: { filename: file.name, password, expiresAt },
      });
      await c.env.UPLOADS.put(previewKey, JSON.stringify({}), {
        httpMetadata: { contentType: "application/json" },
        customMetadata: { fileHash, passwordHash, filename: file.name, scopeId: scope.id, start: range.start, end: range.end, expiresAt },
      });
      await github.dispatch({
        sourceUrl, driveFolderUrl, requestId, start: range.start, end: range.end,
        scopeId: scope.id, scopeName: scope.name, preview: { callbackUrl, token: previewToken },
      });
    } catch (error) {
      await c.env.UPLOADS.delete(objectKey);
      await c.env.UPLOADS.delete(previewKey);
      throw error;
    }
    return c.json({ requestId, previewToken, start: range.start, end: range.end }, 202);
  })
  .delete("/preview/:requestId", requirePermission("tools:shopee-sales:run"), async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.query("token") ?? "";
    if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId) || !/^[A-Za-z0-9-]{16,80}$/.test(token) || !c.env.UPLOADS) {
      return c.json({ ok: true });
    }
    await c.env.UPLOADS.delete(shopeePreviewKey(requestId, token));
    return c.json({ ok: true });
  })
  .get("/preview/:requestId", requirePermission("tools:shopee-sales:run"), async (c) => {
    const requestId = c.req.param("requestId");
    const token = c.req.query("token") ?? "";
    if (!/^[A-Za-z0-9-]{16,80}$/.test(requestId) || !/^[A-Za-z0-9-]{16,80}$/.test(token) || !c.env.UPLOADS) {
      throw new HTTPException(404, { message: "找不到這份蝦皮報表預覽。" });
    }
    const object = await c.env.UPLOADS.get(shopeePreviewKey(requestId, token));
    if (!object) throw new HTTPException(404, { message: "預覽已逾期，請重新選擇報表檔案。" });
    if (Number(object.customMetadata?.expiresAt ?? 0) < Date.now()) {
      await c.env.UPLOADS.delete(shopeePreviewKey(requestId, token));
      throw new HTTPException(410, { message: "預覽已逾期，請重新選擇報表檔案。" });
    }
    const result = JSON.parse(await new Response(object.body).text()) as { preview?: unknown };
    return c.json({ preview: result.preview ?? null });
  })
  .post("/confirm", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN，無法觸發匯入。" });
    if (!c.env.UPLOADS) throw new HTTPException(503, { message: "平台還沒設定報表暫存空間。" });
    const form = await c.req.formData();
    const previewIdValue = form.get("requestId");
    const previewTokenValue = form.get("previewToken");
    const scopeIdValue = form.get("scopeId");
    const previewId = typeof previewIdValue === "string" ? previewIdValue : "";
    const previewToken = typeof previewTokenValue === "string" ? previewTokenValue : "";
    const scopeId = typeof scopeIdValue === "string" ? scopeIdValue.trim() : "";
    const file = form.get("file");
    const password = form.get("password");
    if (!/^[A-Za-z0-9-]{16,80}$/.test(previewId) || !/^[A-Za-z0-9-]{16,80}$/.test(previewToken)) {
      throw new HTTPException(400, { message: "預覽已失效，請重新選擇報表檔案。" });
    }
    if (!isFile(file) || !/\.xlsx$/i.test(file.name)) throw new HTTPException(400, { message: "請選擇一份蝦皮 xlsx 報表。" });
    if (file.size > MAX_REPORT_BYTES) throw new HTTPException(400, { message: `報表不能超過 ${MAX_REPORT_BYTES / 1024 / 1024} MB。` });
    if (typeof password !== "string" || !password) throw new HTTPException(400, { message: "請輸入報表密碼。" });

    const previewKey = shopeePreviewKey(previewId, previewToken);
    const previewObject = await c.env.UPLOADS.get(previewKey);
    if (!previewObject || Number(previewObject.customMetadata?.expiresAt ?? 0) < Date.now()) {
      throw new HTTPException(410, { message: "預覽已逾期，請重新選擇報表檔案。" });
    }
    const metadata = previewObject.customMetadata ?? {};
    if (metadata.scopeId !== scopeId) {
      throw new HTTPException(409, { message: "確認匯入的通路與預覽不一致，請重新選擇通路並解析報表。" });
    }
    const stored = JSON.parse(await new Response(previewObject.body).text()) as { preview?: unknown };
    if (!stored.preview) throw new HTTPException(409, { message: "報表預覽尚未完成，請稍候再試。" });
    const fileBytes = await file.arrayBuffer();
    const fileHash = await sha256Hex(fileBytes);
    const passwordHash = await sha256Hex(new TextEncoder().encode(password).buffer as ArrayBuffer);
    if (fileHash !== metadata.fileHash || passwordHash !== metadata.passwordHash || file.name !== metadata.filename) {
      throw new HTTPException(409, { message: "檔案或密碼與預覽不符，請使用原檔與原密碼，或重新解析。" });
    }
    const start = metadata.start ?? "";
    const end = metadata.end ?? "";
    if (!isValidDate(start) || !isValidDate(end) || start > end) {
      throw new HTTPException(409, { message: "預覽日期區間無效，請重新解析報表。" });
    }
    const scope = (await listReportManagementScopes(c.get("db"))).find((candidate) =>
      candidate.id === scopeId
      && candidate.sourceType === "shopee"
      && candidate.scopeKind === "channel"
      && candidate.active
      && !candidate.archivedAt,
    );
    if (!scope) throw new HTTPException(400, { message: "請選擇啟用中的蝦皮通路。" });
    const driveFolderUrl = readDriveUrl(scope.driveFolderUrl, true);
    const requestId = crypto.randomUUID();
    const sourceToken = crypto.randomUUID();
    const objectKey = `shopee-sales/${requestId}/${sourceToken}.xlsx`;
    const sourceUrl = `${c.env.SHOPEE_SOURCE_BASE_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin}/api/internal/shopee-sales/source/${requestId}?token=${sourceToken}`;
    try {
      await c.env.UPLOADS.put(objectKey, fileBytes, {
        httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        customMetadata: { filename: file.name, password, expiresAt: String(Date.now() + 60 * 60 * 1000) },
      });
      await github.dispatch({ sourceUrl, driveFolderUrl, requestId, start, end, scopeId: scope.id, scopeName: scope.name });
    } catch (error) {
      await c.env.UPLOADS.delete(objectKey);
      throw error;
    }
    const user = c.get("user");
    await recordShopeeSalesRun(c.get("db"), {
      requestId, scopeId: scope.id, startDate: start, endDate: end, driveFolderUrl,
      driveFolderName: scope.driveFolderName, actor: { id: user.id, email: user.email },
    });
    await c.env.UPLOADS.delete(previewKey);
    return c.json({ requestId, start, end }, 202);
  })
  .post("/upload", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN，無法觸發執行。" });
    if (!c.env.UPLOADS) throw new HTTPException(503, { message: "平台還沒設定報表暫存空間。" });

    const form = await c.req.formData();
    const scopeIdValue = form.get("scopeId");
    if (typeof scopeIdValue !== "string" || !scopeIdValue.trim()) throw new HTTPException(400, { message: "請選擇蝦皮通路。" });
    const scope = (await listReportManagementScopes(c.get("db"))).find((candidate) =>
      candidate.id === scopeIdValue.trim()
      && candidate.sourceType === "shopee"
      && candidate.scopeKind === "channel"
      && candidate.active
      && !candidate.archivedAt,
    );
    if (!scope) throw new HTTPException(400, { message: "請選擇啟用中的蝦皮通路。" });
    const driveFolderUrl = readDriveUrl(scope.driveFolderUrl, true);
    const file = form.get("file");
    if (!isFile(file)) throw new HTTPException(400, { message: "請選擇一份蝦皮 xlsx 報表。" });
    if (!/\.xlsx$/i.test(file.name)) throw new HTTPException(400, { message: "目前只接受 .xlsx 檔案。" });
    if (file.size > MAX_REPORT_BYTES) throw new HTTPException(400, { message: `報表不能超過 ${MAX_REPORT_BYTES / 1024 / 1024} MB。` });
    const password = form.get("password");
    if (typeof password !== "string" || !password) throw new HTTPException(400, { message: "請輸入報表密碼。" });

    const requestId = crypto.randomUUID();
    const range = rangeFromFilename(file.name);
    const sourceToken = crypto.randomUUID();
    const objectKey = `shopee-sales/${requestId}/${sourceToken}.xlsx`;
    await c.env.UPLOADS.put(objectKey, await file.arrayBuffer(), {
      httpMetadata: { contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
      customMetadata: { filename: file.name, password, expiresAt: String(Date.now() + 60 * 60 * 1000) },
    });

    const baseUrl = c.env.SHOPEE_SOURCE_BASE_URL?.replace(/\/+$/, "") || new URL(c.req.url).origin;
    const sourceUrl = `${baseUrl}/api/internal/shopee-sales/source/${requestId}?token=${sourceToken}`;
    try {
      await github.dispatch({ sourceUrl, driveFolderUrl, requestId, start: range.start, end: range.end, scopeId: scope.id, scopeName: scope.name });
    } catch (error) {
      await c.env.UPLOADS.delete(objectKey);
      throw error;
    }

    const user = c.get("user");
    await recordShopeeSalesRun(c.get("db"), {
      requestId,
      scopeId: scope.id,
      startDate: range.start,
      endDate: range.end,
      driveFolderUrl,
      driveFolderName: scope.driveFolderName,
      actor: { id: user.id, email: user.email },
    });
    return c.json({ requestId, start: range.start, end: range.end }, 202);
  })
  .get("/status", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN。" });
    return c.json(await github.listRuns(c.req.query("requestId") ?? undefined));
  })
  // Drive 資料夾改在通路管理設定，這裡不再開第二個寫入端。
  .get("/settings", requirePermission("tools:payout:config"), async (c) => c.json({ settings: await getShopeeSalesSettings(c.get("db")) }));
