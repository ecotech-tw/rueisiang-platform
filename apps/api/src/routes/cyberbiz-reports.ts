import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { normalizeCyberbizMonth } from "@rueisiang/db";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { createCyberbizReportService, CyberbizReportQueryError } from "../cyberbiz-reports.js";
import { nasStorageClient } from "../nas-storage.js";

function queryValue(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = c.req.query(name)?.trim();
  return value || undefined;
}

export const cyberbizReports = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/sales", requirePermission("reports:cyberbiz:read"), async (c) => {
    const period = queryValue(c, "period");
    if (!period) throw new HTTPException(400, { message: "請提供 period（YYYY-MM）。" });
    let reportMonth: string;
    try {
      reportMonth = normalizeCyberbizMonth(period);
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : "period 格式不正確。" });
    }

    const scopeType = queryValue(c, "scopeType") ?? "company";
    if (scopeType !== "company" && scopeType !== "store") {
      throw new HTTPException(400, { message: "scopeType 必須是 company 或 store。" });
    }
    const scopeId = queryValue(c, "scopeId");
    if (scopeType === "store" && !scopeId) throw new HTTPException(400, { message: "查詢單一櫃位時需要 scopeId。" });

    try {
      const service = createCyberbizReportService(c.get("db"), nasStorageClient(c.env));
      return c.json(await service.querySales({
        reportMonth,
        scopeType,
        ...(scopeId ? { scopeId } : {}),
        ...(queryValue(c, "startDate") ? { startDate: queryValue(c, "startDate") } : {}),
        ...(queryValue(c, "endDate") ? { endDate: queryValue(c, "endDate") } : {}),
        ...(queryValue(c, "sku") ? { sku: queryValue(c, "sku") } : {}),
        ...(queryValue(c, "category") ? { category: queryValue(c, "category") } : {}),
        ...(queryValue(c, "productName") ? { productName: queryValue(c, "productName") } : {}),
      }));
    } catch (error) {
      if (error instanceof CyberbizReportQueryError) {
        throw new HTTPException(error.status as 400 | 404 | 422 | 502 | 503, { message: error.message });
      }
      throw error;
    }
  })
  .get("/payout", requirePermission("reports:cyberbiz:read"), async (c) => {
    const period = queryValue(c, "period");
    if (!period) throw new HTTPException(400, { message: "請提供 period（YYYY-MM）。" });
    let reportMonth: string;
    try {
      reportMonth = normalizeCyberbizMonth(period);
    } catch (error) {
      throw new HTTPException(400, { message: error instanceof Error ? error.message : "period 格式不正確。" });
    }

    const scopeType = queryValue(c, "scopeType") ?? "company";
    if (scopeType !== "company" && scopeType !== "store") {
      throw new HTTPException(400, { message: "scopeType 必須是 company 或 store。" });
    }
    const scopeId = queryValue(c, "scopeId");
    if (scopeType === "store" && !scopeId) throw new HTTPException(400, { message: "查詢單一櫃位時需要 scopeId。" });

    try {
      const service = createCyberbizReportService(c.get("db"), nasStorageClient(c.env));
      return c.json(await service.queryPayout({
        reportMonth,
        scopeType,
        startDate: queryValue(c, "startDate") ?? "",
        endDate: queryValue(c, "endDate") ?? "",
        ...(scopeId ? { scopeId } : {}),
        ...(queryValue(c, "incomeType") ? { incomeType: queryValue(c, "incomeType") } : {}),
        ...(queryValue(c, "pos") ? { pos: queryValue(c, "pos") } : {}),
        ...(queryValue(c, "operator") ? { operator: queryValue(c, "operator") } : {}),
      }));
    } catch (error) {
      if (error instanceof CyberbizReportQueryError) {
        throw new HTTPException(error.status as 400 | 404 | 422 | 502 | 503, { message: error.message });
      }
      throw error;
    }
  });
