import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { latestReportSalesPeriods, listReportScopes, type ReportGroupBy, type ReportScopeKind } from "@rueisiang/db";
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
  });
