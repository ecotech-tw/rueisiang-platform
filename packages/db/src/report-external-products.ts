import { and, asc, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { activityRow } from "./activity.js";
import { activityEvents } from "./schema/activity.js";
import { itemComponents, items as itemMasters } from "./schema/items.js";
import { reportBundleSalesMonthly, reportExternalProducts } from "./schema/reports.js";

export type ReportExternalProductActor = { id: string; email: string };

export class ReportExternalProductError extends Error {
  constructor(
    readonly kind: "invalid" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ReportExternalProductError";
  }
}

export async function listReportExternalProducts(
  db: Database,
  filter?: { sourceType?: string; resolution?: "mapped" | "ignored" },
) {
  return db.select().from(reportExternalProducts)
    .where(and(
      filter?.sourceType ? eq(reportExternalProducts.sourceType, filter.sourceType) : undefined,
      filter?.resolution ? eq(reportExternalProducts.resolution, filter.resolution) : undefined,
    ))
    .orderBy(asc(reportExternalProducts.sourceType), asc(reportExternalProducts.externalKey), asc(reportExternalProducts.externalVariantKey));
}

async function findProduct(db: Database, id: string) {
  const [product] = await db.select().from(reportExternalProducts).where(eq(reportExternalProducts.id, id)).limit(1);
  if (!product) throw new ReportExternalProductError("not_found", "找不到這筆外部商品。");
  return product;
}

async function requireItem(db: Database, itemId: string) {
  const [item] = await db.select({ id: itemMasters.id }).from(itemMasters).where(eq(itemMasters.id, itemId)).limit(1);
  if (!item) throw new ReportExternalProductError("not_found", "找不到指定的品項主檔。");
  return item;
}

export async function resolveReportExternalProduct(
  db: Database,
  input: { id: string; itemId: string; actor: ReportExternalProductActor },
) {
  const id = input.id.trim();
  const itemId = input.itemId.trim();
  if (!id || !itemId) throw new ReportExternalProductError("invalid", "外部商品與品項 ID 不可為空白。");
  const product = await findProduct(db, id);
  await requireItem(db, itemId);
  await db.batch([
    db.update(reportExternalProducts).set({ resolution: "mapped", itemId, ignoredReason: "", updatedAt: new Date().toISOString() }).where(eq(reportExternalProducts.id, id)),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: product.externalName || product.externalKey, eventType: "report_external_product_resolved", summary: `將外部商品「${product.externalName || product.externalKey}」對應到品項`, field: "itemId", newValue: itemId, actor: input.actor, source: "reports" })),
  ] as never);
  const [updated] = await db.select().from(reportExternalProducts).where(eq(reportExternalProducts.id, id));
  return updated!;
}

export async function ignoreReportExternalProduct(
  db: Database,
  input: { id: string; reason?: string; actor: ReportExternalProductActor },
) {
  const id = input.id.trim();
  if (!id) throw new ReportExternalProductError("invalid", "外部商品 ID 不可為空白。");
  const product = await findProduct(db, id);
  const reason = input.reason?.trim() ?? "";
  const generatedBundleId = product.itemId === `report-bundle:${id}` ? product.itemId : null;
  const [bundleHistory] = generatedBundleId
    ? await db.select({ externalSku: reportBundleSalesMonthly.externalSku })
      .from(reportBundleSalesMonthly)
      .where(eq(reportBundleSalesMonthly.itemId, generatedBundleId))
      .limit(1)
    : [];
  await db.batch([
    db.update(reportExternalProducts).set({ resolution: "ignored", itemId: null, ignoredReason: reason, updatedAt: new Date().toISOString() }).where(eq(reportExternalProducts.id, id)),
    ...(generatedBundleId && bundleHistory
      ? [
        db.delete(itemComponents).where(eq(itemComponents.parentItemId, generatedBundleId)),
        db.update(itemMasters).set({ active: 0, updatedAt: new Date().toISOString() }).where(eq(itemMasters.id, generatedBundleId)),
      ]
      : generatedBundleId ? [db.delete(itemMasters).where(eq(itemMasters.id, generatedBundleId))] : []),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: product.externalName || product.externalKey, eventType: "report_external_product_ignored", summary: `忽略外部商品「${product.externalName || product.externalKey}」`, field: "ignoredReason", newValue: reason, actor: input.actor, source: "reports" })),
  ] as never);
  const [updated] = await db.select().from(reportExternalProducts).where(eq(reportExternalProducts.id, id));
  return updated!;
}

/** 取消忽略後刪掉管理列，下一次匯入會重新判定為 mapped／unmapped。 */
export async function unignoreReportExternalProduct(
  db: Database,
  input: { id: string; actor: ReportExternalProductActor },
) {
  const id = input.id.trim();
  if (!id) throw new ReportExternalProductError("invalid", "外部商品 ID 不可為空白。");
  const product = await findProduct(db, id);
  if (product.resolution !== "ignored") throw new ReportExternalProductError("conflict", "這筆外部商品目前不是忽略狀態。");
  await db.batch([
    db.delete(reportExternalProducts).where(eq(reportExternalProducts.id, id)),
    db.insert(activityEvents).values(activityRow({ entityType: "report_manual_entry", entityId: id, entityLabel: product.externalName || product.externalKey, eventType: "report_external_product_unignored", summary: `取消忽略外部商品「${product.externalName || product.externalKey}」`, actor: input.actor, source: "reports" })),
  ] as never);
}
