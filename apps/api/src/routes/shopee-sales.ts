import { getShopeeSalesSettings, listShopeeSalesRuns, recordShopeeSalesRun, saveShopeeSalesSettings } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/auth.js";
import { shopeeSalesGithub } from "../shopee-sales/github.js";
import { body } from "../request.js";

const MAX_REPORT_BYTES = 25 * 1024 * 1024;

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
    const settings = await getShopeeSalesSettings(c.get("db"));
    const runs = await listShopeeSalesRuns(c.get("db"), 10);
    return c.json({ settings, ...previousMonthRange(), configured: Boolean(shopeeSalesGithub(c.env) && c.env.UPLOADS), latestRequestId: runs[0]?.requestId ?? null, runs });
  })
  .post("/upload", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN，無法觸發執行。" });
    if (!c.env.UPLOADS) throw new HTTPException(503, { message: "平台還沒設定報表暫存空間。" });

    const settings = await getShopeeSalesSettings(c.get("db"));
    const driveFolderUrl = readDriveUrl(settings.driveFolderUrl, true);
    const form = await c.req.formData();
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
      await github.dispatch({ sourceUrl, driveFolderUrl, requestId, start: range.start, end: range.end });
    } catch (error) {
      await c.env.UPLOADS.delete(objectKey);
      throw error;
    }

    const user = c.get("user");
    await recordShopeeSalesRun(c.get("db"), { requestId, startDate: range.start, endDate: range.end, driveFolderUrl, actor: { id: user.id, email: user.email } });
    return c.json({ requestId, start: range.start, end: range.end }, 202);
  })
  .get("/status", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 GITHUB_TOKEN。" });
    return c.json(await github.listRuns(c.req.query("requestId") ?? undefined));
  })
  .get("/settings", requirePermission("tools:payout:config"), async (c) => c.json({ settings: await getShopeeSalesSettings(c.get("db")) }))
  .put("/settings", requirePermission("tools:payout:config"), async (c) => {
    const input = await body(c);
    const driveFolderUrl = readDriveUrl(input.driveFolderUrl, false);
    const driveFolderName = typeof input.driveFolderName === "string" ? input.driveFolderName.trim() : "";
    await saveShopeeSalesSettings(c.get("db"), { driveFolderUrl, driveFolderName });
    return c.json({ settings: await getShopeeSalesSettings(c.get("db")) });
  });
