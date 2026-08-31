import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  deleteReportPayoutDaily,
  isValidReportDate,
  latestReportSalesPeriods,
  listReportScopes,
  updateReportPayoutDaily,
  type Database,
  type ReportGroupBy,
  type ReportScopeKind,
} from "@rueisiang/db";
import type { AppEnv } from "../env.js";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { createCyberbizReportService, CyberbizReportQueryError } from "../cyberbiz-reports.js";

function queryValue(c: { req: { query(name: string): string | undefined } }, name: string): string | undefined {
  const value = c.req.query(name)?.trim();
  return value || undefined;
}

function groupBy(c: { req: { query(name: string): string | undefined } }): ReportGroupBy[] | undefined {
  const value = queryValue(c, "groupBy");
  if (!value) return undefined;
  return value.split(",").map((item) => item.trim()) as ReportGroupBy[];
}

function topSkuBy(c: { req: { query(name: string): string | undefined } }): "salesAmount" | "netQuantity" | undefined {
  const value = queryValue(c, "topSkuBy");
  if (!value) return undefined;
  if (value !== "salesAmount" && value !== "netQuantity") {
    throw new HTTPException(400, { message: "topSkuBy 必須是 salesAmount 或 netQuantity。" });
  }
  return value;
}

function commonQuery(c: { req: { query(name: string): string | undefined } }) {
  const scopeType = queryValue(c, "scopeType") ?? "company";
  if (scopeType !== "company" && scopeType !== "store") {
    throw new HTTPException(400, { message: "scopeType 必須是 company 或 store。" });
  }
  const scopeId = queryValue(c, "scopeId");
  const scopeName = queryValue(c, "scopeName");
  const groups = groupBy(c);
  if (scopeType === "store" && !scopeId && !scopeName) throw new HTTPException(400, { message: "查詢單一櫃位時需要店面名稱。" });
  return {
    period: queryValue(c, "period"),
    startDate: queryValue(c, "startDate"),
    endDate: queryValue(c, "endDate"),
    scopeType: scopeType as ReportScopeKind,
    ...(scopeId ? { scopeId } : {}),
    ...(scopeName ? { scopeName } : {}),
    ...(groups ? { groupBy: groups } : {}),
  };
}

function handleError(error: unknown): never {
  if (error instanceof CyberbizReportQueryError) {
    throw new HTTPException(error.status as 400 | 404 | 409 | 422 | 502 | 503, { message: error.message });
  }
  throw error;
}

function payoutTarget(c: { req: { param(name: string): string | undefined } }): { scopeId: string; businessDate: string } {
  const scopeId = c.req.param("scopeId")?.trim();
  const businessDate = c.req.param("businessDate")?.trim();
  if (!scopeId || !businessDate || !isValidReportDate(businessDate)) {
    throw new HTTPException(400, { message: "日期格式必須是 YYYY-MM-DD。" });
  }
  return { scopeId, businessDate };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPayoutAmount(c: { req: { json(): Promise<unknown> } }): Promise<number> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "請提供有效的 JSON 出金金額。" });
  }
  if (!isRecord(body) || !Number.isSafeInteger(body.payoutAmount)) {
    throw new HTTPException(400, { message: "出金金額必須是安全整數。" });
  }
  return body.payoutAmount as number;
}

async function updatePayout(
  db: Database,
  target: { scopeId: string; businessDate: string },
  payoutAmount: number,
) {
  const row = await updateReportPayoutDaily(db, { ...target, payoutAmount });
  if (!row) throw new HTTPException(404, { message: "找不到指定日期的出金資料。" });
  return row;
}

export const cyberbizReports = new Hono<AppEnv>()
  .use("*", requireAuth)
  .get("/scopes", requirePermission("reports:analytics:read"), async (c) => {
    const scopes = await listReportScopes(c.get("db"), "store");
    const latest = await latestReportSalesPeriods(c.get("db"), scopes.map((scope) => scope.id));
    return c.json({
      latestSalesPeriod: latest.latestPeriod,
      scopes: scopes.map((scope) => ({
        id: scope.id,
        name: scope.name,
        latestSalesPeriod: latest.byScope[scope.id] ?? null,
      })),
    });
  })
  .get("/summary/payout", requirePermission("reports:analytics:read"), async (c) => {
    try {
      return c.json(await createCyberbizReportService(c.get("db")).queryPayoutSummary(commonQuery(c)));
    } catch (error) {
      handleError(error);
    }
  })
  .get("/summary/payout/daily", requirePermission("reports:analytics:read"), async (c) => {
    try {
      return c.json(await createCyberbizReportService(c.get("db")).queryPayout({
        ...commonQuery(c),
        groupBy: ["day"],
      }));
    } catch (error) {
      handleError(error);
    }
  })
  .get("/summary/sales", requirePermission("reports:analytics:read"), async (c) => {
    try {
      const selectedTopSkuBy = topSkuBy(c);
      return c.json(await createCyberbizReportService(c.get("db")).querySalesSummary({
        ...commonQuery(c),
        ...(selectedTopSkuBy ? { topSkuBy: selectedTopSkuBy } : {}),
      }));
    } catch (error) {
      handleError(error);
    }
  })
  .get("/sales", requirePermission("reports:cyberbiz:read"), async (c) => {
    try {
      return c.json(await createCyberbizReportService(c.get("db")).querySales({
        ...commonQuery(c),
        ...(queryValue(c, "sku") ? { sku: queryValue(c, "sku") } : {}),
        ...(queryValue(c, "category") ? { category: queryValue(c, "category") } : {}),
        ...(queryValue(c, "productName") ? { productName: queryValue(c, "productName") } : {}),
      }));
    } catch (error) {
      handleError(error);
    }
  })
  .get("/payout", requirePermission("reports:cyberbiz:read"), async (c) => {
    try {
      return c.json(await createCyberbizReportService(c.get("db")).queryPayout(commonQuery(c)));
    } catch (error) {
      handleError(error);
    }
  })
  .patch("/payout/:scopeId/:businessDate", requirePermission("reports:cyberbiz:write"), async (c) => {
    const target = payoutTarget(c);
    const payoutAmount = await readPayoutAmount(c);
    return c.json({ row: await updatePayout(c.get("db"), target, payoutAmount) });
  })
  .delete("/payout/:scopeId/:businessDate", requirePermission("reports:cyberbiz:write"), async (c) => {
    const target = payoutTarget(c);
    if (!(await deleteReportPayoutDaily(c.get("db"), target))) {
      throw new HTTPException(404, { message: "找不到指定日期的出金資料。" });
    }
    return c.json({ ok: true });
  });
