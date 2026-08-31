import { and, asc, eq, ne } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { isCompanyReportStoreScopeId, isValidReportDate } from "./report-data.js";
import { activityEvents } from "./schema/activity.js";
import {
  reportManualPayoutDaily,
  reportManualSalesMonthly,
  reportScopes,
  type ReportManualPayoutDaily,
  type ReportManualSalesMonthly,
  type ReportManualSkuSource,
} from "./schema/reports.js";
import { cyberbizProducts } from "./schema/wms.js";
import { normalizeExternalSku } from "./product-sku-mappings.js";

export interface ReportManualActor {
  id: string;
  email: string;
}

export type ReportManualErrorKind = "invalid" | "not_found" | "conflict";

export class ReportManualError extends Error {
  constructor(
    readonly kind: ReportManualErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "ReportManualError";
  }
}

export interface ReportManualPayoutInput {
  scopeId: string;
  businessDate: string;
  payoutAmount: number;
  actor: ReportManualActor;
}

export interface ReportManualSalesInput {
  scopeId: string;
  reportMonth: string;
  skuSource: ReportManualSkuSource;
  sku: string;
  productName?: string;
  category?: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  actor: ReportManualActor;
}

export type ReportManualPayoutRow = ReportManualPayoutDaily & { scopeName: string };
export type ReportManualSalesRow = ReportManualSalesMonthly & { scopeName: string };

function safeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value)) throw new ReportManualError("invalid", `${label}必須是安全整數。`);
  return value;
}

async function requireScope(db: Database, scopeId: string) {
  const id = scopeId.trim();
  if (!id) throw new ReportManualError("invalid", "請選擇據點。");
  const [scope] = await db.select({ id: reportScopes.id, name: reportScopes.name })
    .from(reportScopes)
    .where(and(
      eq(reportScopes.id, id),
      eq(reportScopes.scopeKind, "store"),
      eq(reportScopes.active, 1),
    ))
    .limit(1);
  if (!scope || !isCompanyReportStoreScopeId(scope.id)) {
    throw new ReportManualError("not_found", "找不到可納入公司報表的啟用據點。");
  }
  return scope;
}

async function preparePayout(
  db: Database,
  input: Omit<ReportManualPayoutInput, "actor">,
) {
  const scope = await requireScope(db, input.scopeId);
  const businessDate = input.businessDate.trim();
  if (!isValidReportDate(businessDate)) {
    throw new ReportManualError("invalid", "出金日期必須是有效的 YYYY-MM-DD。");
  }
  const payoutAmount = safeInteger(input.payoutAmount, "出金金額");
  return { scope, scopeId: scope.id, businessDate, payoutAmount };
}

async function prepareSales(
  db: Database,
  input: Omit<ReportManualSalesInput, "actor">,
) {
  const scope = await requireScope(db, input.scopeId);
  const reportMonth = input.reportMonth.trim();
  if (!/^\d{4}-(0[1-9]|1[0-2])$/u.test(reportMonth)) {
    throw new ReportManualError("invalid", "商品銷售月份必須是有效的 YYYY-MM。");
  }
  if (input.skuSource !== "custom" && input.skuSource !== "cyberbiz") {
    throw new ReportManualError("invalid", "SKU 來源不正確。");
  }
  const sku = normalizeExternalSku(input.sku);
  if (!sku) throw new ReportManualError("invalid", "請填寫 SKU。");

  let productName = (input.productName ?? "").trim();
  let category = (input.category ?? "").trim() || "未分類";
  if (input.skuSource === "cyberbiz") {
    const [product] = await db.select({
      productName: cyberbizProducts.productName,
      variantName: cyberbizProducts.variantName,
    }).from(cyberbizProducts).where(eq(cyberbizProducts.sku, sku)).limit(1);
    if (!product) throw new ReportManualError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);
    productName = product.variantName ? `${product.productName}（${product.variantName}）` : product.productName;
    category = "未分類";
  } else if (!productName) {
    throw new ReportManualError("invalid", "自訂 SKU 必須填寫商品名稱。");
  }

  return {
    scope,
    scopeId: scope.id,
    reportMonth,
    skuSource: input.skuSource,
    sku,
    productName: productName || sku,
    category,
    grossQuantity: safeInteger(input.grossQuantity, "銷售數量"),
    returnQuantity: safeInteger(input.returnQuantity, "退貨數量"),
    netQuantity: safeInteger(input.netQuantity, "淨銷售數量"),
    salesAmount: safeInteger(input.salesAmount, "銷售金額"),
  };
}

function payoutLabel(scopeName: string, businessDate: string): string {
  return `出金 · ${scopeName} · ${businessDate}`;
}

function salesLabel(scopeName: string, reportMonth: string, sku: string): string {
  return `商品銷售 · ${scopeName} · ${reportMonth} · ${sku}`;
}

function payoutPayload(row: { scopeId: string; businessDate: string; payoutAmount: number }) {
  return {
    reportKind: "payout",
    scopeId: row.scopeId,
    businessDate: row.businessDate,
    payoutAmount: row.payoutAmount,
  };
}

function salesPayload(row: {
  scopeId: string;
  reportMonth: string;
  skuSource: ReportManualSkuSource;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}) {
  return {
    reportKind: "sales",
    scopeId: row.scopeId,
    reportMonth: row.reportMonth,
    skuSource: row.skuSource,
    sku: row.sku,
    productName: row.productName,
    category: row.category,
    grossQuantity: row.grossQuantity,
    returnQuantity: row.returnQuantity,
    netQuantity: row.netQuantity,
    salesAmount: row.salesAmount,
  };
}

async function scopeNames(db: Database): Promise<Map<string, string>> {
  return new Map((await db.select({ id: reportScopes.id, name: reportScopes.name }).from(reportScopes))
    .map((scope) => [scope.id, scope.name]));
}

export async function listReportManualPayouts(db: Database): Promise<ReportManualPayoutRow[]> {
  const [rows, names] = await Promise.all([
    db.select().from(reportManualPayoutDaily)
      .orderBy(asc(reportManualPayoutDaily.businessDate), asc(reportManualPayoutDaily.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

export async function listReportManualSales(db: Database): Promise<ReportManualSalesRow[]> {
  const [rows, names] = await Promise.all([
    db.select().from(reportManualSalesMonthly)
      .orderBy(asc(reportManualSalesMonthly.reportMonth), asc(reportManualSalesMonthly.sku), asc(reportManualSalesMonthly.id)),
    scopeNames(db),
  ]);
  return rows.map((row) => ({ ...row, scopeName: names.get(row.scopeId) ?? row.scopeId }));
}

export async function createReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput,
): Promise<ReportManualPayoutRow> {
  const prepared = await preparePayout(db, input);
  const [existing] = await db.select({ id: reportManualPayoutDaily.id })
    .from(reportManualPayoutDaily)
    .where(and(
      eq(reportManualPayoutDaily.scopeId, prepared.scopeId),
      eq(reportManualPayoutDaily.businessDate, prepared.businessDate),
    ))
    .limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點在這個日期已經有人工出金資料，請改用編輯。");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    scopeId: prepared.scopeId,
    businessDate: prepared.businessDate,
    payoutAmount: prepared.payoutAmount,
    createdById: input.actor.id,
    createdByEmail: input.actor.email,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(reportManualPayoutDaily).values(row),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate),
      eventType: "report_manual_payout_created",
      summary: `新增人工出金資料：${prepared.scope.name} ${prepared.businessDate}`,
      field: "payoutAmount",
      newValue: String(prepared.payoutAmount),
      payload: payoutPayload(prepared),
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...row, scopeName: prepared.scope.name };
}

export async function updateReportManualPayout(
  db: Database,
  input: ReportManualPayoutInput & { id: string },
): Promise<ReportManualPayoutRow> {
  const [existing] = await db.select().from(reportManualPayoutDaily)
    .where(eq(reportManualPayoutDaily.id, input.id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const prepared = await preparePayout(db, input);
  const [conflict] = await db.select({ id: reportManualPayoutDaily.id })
    .from(reportManualPayoutDaily)
    .where(and(
      eq(reportManualPayoutDaily.scopeId, prepared.scopeId),
      eq(reportManualPayoutDaily.businessDate, prepared.businessDate),
      ne(reportManualPayoutDaily.id, input.id),
    )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點在這個日期已經有另一筆人工出金資料。");

  const updatedAt = new Date().toISOString();
  const next = {
    ...existing,
    scopeId: prepared.scopeId,
    businessDate: prepared.businessDate,
    payoutAmount: prepared.payoutAmount,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    updatedAt,
  };
  await db.batch([
    db.update(reportManualPayoutDaily).set({
      scopeId: next.scopeId,
      businessDate: next.businessDate,
      payoutAmount: next.payoutAmount,
      updatedById: next.updatedById,
      updatedByEmail: next.updatedByEmail,
      updatedAt: next.updatedAt,
    }).where(eq(reportManualPayoutDaily.id, input.id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: input.id,
      entityLabel: payoutLabel(prepared.scope.name, prepared.businessDate),
      eventType: "report_manual_payout_updated",
      summary: `更新人工出金資料：${prepared.scope.name} ${prepared.businessDate}`,
      field: "payoutAmount",
      oldValue: String(existing.payoutAmount),
      newValue: String(prepared.payoutAmount),
      payload: { before: payoutPayload(existing), after: payoutPayload(prepared) },
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...next, scopeName: prepared.scope.name };
}

export async function deleteReportManualPayout(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const [existing] = await db.select().from(reportManualPayoutDaily)
    .where(eq(reportManualPayoutDaily.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工出金資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualPayoutDaily).where(eq(reportManualPayoutDaily.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: payoutLabel(scopeName, existing.businessDate),
      eventType: "report_manual_payout_deleted",
      summary: `刪除人工出金資料：${scopeName} ${existing.businessDate}`,
      field: "payoutAmount",
      oldValue: String(existing.payoutAmount),
      payload: payoutPayload(existing),
      actor,
      source: "reports",
    })),
  ] as never);
}

export async function createReportManualSales(
  db: Database,
  input: ReportManualSalesInput,
): Promise<ReportManualSalesRow> {
  const prepared = await prepareSales(db, input);
  const [existing] = await db.select({ id: reportManualSalesMonthly.id })
    .from(reportManualSalesMonthly)
    .where(and(
      eq(reportManualSalesMonthly.scopeId, prepared.scopeId),
      eq(reportManualSalesMonthly.reportMonth, prepared.reportMonth),
      eq(reportManualSalesMonthly.sku, prepared.sku),
    )).limit(1);
  if (existing) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有人工商品銷售資料，請改用編輯。");

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const row = {
    id,
    scopeId: prepared.scopeId,
    reportMonth: prepared.reportMonth,
    skuSource: prepared.skuSource,
    sku: prepared.sku,
    productName: prepared.productName,
    category: prepared.category,
    grossQuantity: prepared.grossQuantity,
    returnQuantity: prepared.returnQuantity,
    netQuantity: prepared.netQuantity,
    salesAmount: prepared.salesAmount,
    createdById: input.actor.id,
    createdByEmail: input.actor.email,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    createdAt: now,
    updatedAt: now,
  };
  await db.batch([
    db.insert(reportManualSalesMonthly).values(row),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku),
      eventType: "report_manual_sales_created",
      summary: `新增人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`,
      payload: salesPayload(prepared),
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...row, scopeName: prepared.scope.name };
}

export async function updateReportManualSales(
  db: Database,
  input: ReportManualSalesInput & { id: string },
): Promise<ReportManualSalesRow> {
  const [existing] = await db.select().from(reportManualSalesMonthly)
    .where(eq(reportManualSalesMonthly.id, input.id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const prepared = await prepareSales(db, input);
  const [conflict] = await db.select({ id: reportManualSalesMonthly.id })
    .from(reportManualSalesMonthly)
    .where(and(
      eq(reportManualSalesMonthly.scopeId, prepared.scopeId),
      eq(reportManualSalesMonthly.reportMonth, prepared.reportMonth),
      eq(reportManualSalesMonthly.sku, prepared.sku),
      ne(reportManualSalesMonthly.id, input.id),
    )).limit(1);
  if (conflict) throw new ReportManualError("conflict", "這個據點、月份與 SKU 已經有另一筆人工商品銷售資料。");

  const updatedAt = new Date().toISOString();
  const next = {
    ...existing,
    scopeId: prepared.scopeId,
    reportMonth: prepared.reportMonth,
    skuSource: prepared.skuSource,
    sku: prepared.sku,
    productName: prepared.productName,
    category: prepared.category,
    grossQuantity: prepared.grossQuantity,
    returnQuantity: prepared.returnQuantity,
    netQuantity: prepared.netQuantity,
    salesAmount: prepared.salesAmount,
    updatedById: input.actor.id,
    updatedByEmail: input.actor.email,
    updatedAt,
  };
  await db.batch([
    db.update(reportManualSalesMonthly).set({
      scopeId: next.scopeId,
      reportMonth: next.reportMonth,
      skuSource: next.skuSource,
      sku: next.sku,
      productName: next.productName,
      category: next.category,
      grossQuantity: next.grossQuantity,
      returnQuantity: next.returnQuantity,
      netQuantity: next.netQuantity,
      salesAmount: next.salesAmount,
      updatedById: next.updatedById,
      updatedByEmail: next.updatedByEmail,
      updatedAt: next.updatedAt,
    }).where(eq(reportManualSalesMonthly.id, input.id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: input.id,
      entityLabel: salesLabel(prepared.scope.name, prepared.reportMonth, prepared.sku),
      eventType: "report_manual_sales_updated",
      summary: `更新人工商品銷售資料：${prepared.scope.name} ${prepared.reportMonth} ${prepared.sku}`,
      oldValue: JSON.stringify(salesPayload(existing)),
      newValue: JSON.stringify(salesPayload(prepared)),
      payload: { before: salesPayload(existing), after: salesPayload(prepared) },
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { ...next, scopeName: prepared.scope.name };
}

export async function deleteReportManualSales(db: Database, id: string, actor: ReportManualActor): Promise<void> {
  const [existing] = await db.select().from(reportManualSalesMonthly)
    .where(eq(reportManualSalesMonthly.id, id)).limit(1);
  if (!existing) throw new ReportManualError("not_found", "找不到這筆人工商品銷售資料。");
  const names = await scopeNames(db);
  const scopeName = names.get(existing.scopeId) ?? existing.scopeId;
  await db.batch([
    db.delete(reportManualSalesMonthly).where(eq(reportManualSalesMonthly.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_manual_entry",
      entityId: id,
      entityLabel: salesLabel(scopeName, existing.reportMonth, existing.sku),
      eventType: "report_manual_sales_deleted",
      summary: `刪除人工商品銷售資料：${scopeName} ${existing.reportMonth} ${existing.sku}`,
      oldValue: JSON.stringify(salesPayload(existing)),
      payload: salesPayload(existing),
      actor,
      source: "reports",
    })),
  ] as never);
}
