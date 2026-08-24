import { getShopeeSalesSettings, listShopeeSalesRuns, recordShopeeSalesRun, saveShopeeSalesSettings } from "@rueisiang/db";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { AppEnv } from "../env.js";
import { requirePermission } from "../middleware/auth.js";
import { shopeeSalesGithub } from "../shopee-sales/github.js";
import { body } from "../request.js";

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

function readDriveUrl(value: unknown, required: boolean): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url && required) throw new HTTPException(400, { message: "請先設定 Google Drive 資料夾連結。" });
  if (url && !/^https?:\/\/[^\s]*(\/folders\/[\w-]+|[?&]id=[\w-]+)/.test(url)) {
    throw new HTTPException(400, { message: "Google Drive 資料夾連結格式不正確。" });
  }
  return url;
}

export const shopeeSales = new Hono<AppEnv>()
  .get("/state", requirePermission("tools:shopee-sales:run"), async (c) => {
    const settings = await getShopeeSalesSettings(c.get("db"));
    const runs = await listShopeeSalesRuns(c.get("db"), 10);
    return c.json({ settings, ...previousMonthRange(), configured: Boolean(shopeeSalesGithub(c.env)), latestRequestId: runs[0]?.requestId ?? null, runs });
  })
  .post("/run", requirePermission("tools:shopee-sales:run"), async (c) => {
    const input = await body(c);
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 SHOPEE_GITHUB_TOKEN，無法觸發執行。" });
    const start = typeof input.start === "string" ? input.start : "";
    const end = typeof input.end === "string" ? input.end : "";
    if (!isValidDate(start) || !isValidDate(end)) throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
    if (start > end) throw new HTTPException(400, { message: "起日不能晚於迄日。" });
    const settings = await getShopeeSalesSettings(c.get("db"));
    const driveFolderUrl = readDriveUrl(input.driveFolderUrl || settings.driveFolderUrl, true);
    const requestId = crypto.randomUUID();
    await github.dispatch({ start, end, driveFolderUrl, requestId });
    const user = c.get("user");
    await recordShopeeSalesRun(c.get("db"), { requestId, startDate: start, endDate: end, driveFolderUrl, actor: { id: user.id, email: user.email } });
    return c.json({ requestId, start, end, driveFolderUrl }, 202);
  })
  .get("/status", requirePermission("tools:shopee-sales:run"), async (c) => {
    const github = shopeeSalesGithub(c.env);
    if (!github) throw new HTTPException(503, { message: "平台還沒設定 SHOPEE_GITHUB_TOKEN。" });
    return c.json(await github.listRuns(c.req.query("requestId") ?? undefined));
  })
  .get("/settings", requirePermission("tools:shopee-sales:config"), async (c) => c.json({ settings: await getShopeeSalesSettings(c.get("db")) }))
  .put("/settings", requirePermission("tools:shopee-sales:config"), async (c) => {
    const input = await body(c);
    const driveFolderUrl = readDriveUrl(input.driveFolderUrl, false);
    const driveFolderName = typeof input.driveFolderName === "string" ? input.driveFolderName.trim() : "";
    await saveShopeeSalesSettings(c.get("db"), { driveFolderUrl, driveFolderName });
    return c.json({ settings: await getShopeeSalesSettings(c.get("db")) });
  });
