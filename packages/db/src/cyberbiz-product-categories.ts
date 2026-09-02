import { asc, count, eq } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { activityEvents } from "./schema/activity.js";
import {
  customReportProducts,
  cyberbizProductCategories,
  cyberbizProducts,
} from "./schema/wms.js";
import { reportProductCategories } from "./schema/report-products.js";
import { normalizeExternalSku } from "./product-sku-mappings.js";
import { WmsError, type Actor } from "./wms.js";

export interface ProductCategoryOption {
  id: string;
  name: string;
  color: string;
  skuCount: number;
  customProductCount: number;
  usageCount: number;
}

export interface CyberbizProductCategoryProduct {
  sku: string;
  name: string;
  published: boolean;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface CyberbizProductCategoryManagementData {
  products: CyberbizProductCategoryProduct[];
  categories: ProductCategoryOption[];
}

export interface CyberbizProductCategoryWriteResult {
  sku: string;
  categoryId: string | null;
  categoryName: string | null;
}

export interface ReportProductCategoryWriteResult {
  id: string;
  name: string;
  color: string;
}

/** 商品分類的顏色只允許設計系統已經準備好的色階。 */
export const REPORT_PRODUCT_CATEGORY_COLORS = [
  "rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand",
] as const;

function normalizeReportCategoryColor(value: unknown, fallback: string): string {
  const color = String(value ?? "");
  return (REPORT_PRODUCT_CATEGORY_COLORS as readonly string[]).includes(color) ? color : fallback;
}

function requireReportCategoryName(value: unknown): string {
  const name = String(value ?? "").trim().slice(0, 40);
  if (!name) throw new WmsError("invalid", "請填寫商品分類名稱。");
  return name;
}

function displayName(productName: string, variantName: string): string {
  return variantName.trim() ? `${productName}（${variantName}）` : productName;
}

/** 商品分類選項只讀報表自己的主檔；WMS 倉儲分類不會出現在這裡。 */
export async function listProductCategoryOptions(db: Database): Promise<ProductCategoryOption[]> {
  const [categoryRows, skuCountRows, customCountRows] = await Promise.all([
    db.select({
      id: reportProductCategories.id,
      name: reportProductCategories.name,
      color: reportProductCategories.color,
    }).from(reportProductCategories).orderBy(asc(reportProductCategories.name)),
    db.select({
      categoryId: cyberbizProductCategories.categoryId,
      skuCount: count(),
    }).from(cyberbizProductCategories).groupBy(cyberbizProductCategories.categoryId),
    db.select({
      categoryName: customReportProducts.category,
      customProductCount: count(),
    }).from(customReportProducts).groupBy(customReportProducts.category),
  ]);
  const skuCounts = new Map(skuCountRows.map((row) => [row.categoryId, Number(row.skuCount)]));
  const customCounts = new Map(customCountRows.map((row) => [row.categoryName, Number(row.customProductCount)]));
  return categoryRows.map((row) => ({
    ...row,
    skuCount: skuCounts.get(row.id) ?? 0,
    customProductCount: customCounts.get(row.name) ?? 0,
    usageCount: (skuCounts.get(row.id) ?? 0) + (customCounts.get(row.name) ?? 0),
  }));
}

/** 以 CYBERBIZ 商品鏡像為全集，未分類的商品也必須出現在管理頁。 */
export async function listCyberbizProductCategoryManagement(
  db: Database,
): Promise<CyberbizProductCategoryManagementData> {
  const [productRows, categories] = await Promise.all([
    db.select({
      sku: cyberbizProducts.sku,
      productName: cyberbizProducts.productName,
      variantName: cyberbizProducts.variantName,
      published: cyberbizProducts.published,
      categoryId: cyberbizProductCategories.categoryId,
      categoryName: reportProductCategories.name,
      categoryColor: reportProductCategories.color,
    })
      .from(cyberbizProducts)
      .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
      .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
      .orderBy(asc(cyberbizProducts.productName), asc(cyberbizProducts.variantName), asc(cyberbizProducts.sku)),
    listProductCategoryOptions(db),
  ]);

  return {
    products: productRows.map((row) => ({
      sku: row.sku,
      name: displayName(row.productName, row.variantName),
      published: row.published === 1,
      categoryId: row.categoryId ?? null,
      categoryName: row.categoryName ?? null,
      categoryColor: row.categoryColor ?? null,
    })),
    categories,
  };
}

/**
 * 設定一個 CYBERBIZ SKU 的目前分類。
 *
 * 分類名稱不會回寫歷史報表；匯入或人工建立報表時才把當下名稱寫進 report 的 raw snapshot。
 */
export async function setCyberbizProductCategory(
  db: Database,
  input: { sku: string; categoryId: string | null; actor: Actor },
): Promise<CyberbizProductCategoryWriteResult> {
  const sku = normalizeExternalSku(input.sku);
  if (!sku) throw new WmsError("invalid", "請提供要設定分類的 SKU。");

  const [product] = await db.select({ sku: cyberbizProducts.sku })
    .from(cyberbizProducts)
    .where(eq(cyberbizProducts.sku, sku))
    .limit(1);
  if (!product) throw new WmsError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);

  const categoryId = input.categoryId?.trim() || null;
  let categoryName: string | null = null;
  if (categoryId) {
    const [category] = await db.select({ id: reportProductCategories.id, name: reportProductCategories.name })
      .from(reportProductCategories)
      .where(eq(reportProductCategories.id, categoryId))
      .limit(1);
    if (!category) throw new WmsError("not_found", "找不到指定的商品分類。");
    categoryName = category.name;
  }

  const [previous] = await db.select({
    categoryId: cyberbizProductCategories.categoryId,
    categoryName: reportProductCategories.name,
  })
    .from(cyberbizProductCategories)
    .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
    .where(eq(cyberbizProductCategories.sku, sku))
    .limit(1);
  const previousId = previous?.categoryId ?? null;
  if (previousId === categoryId) return { sku, categoryId, categoryName: previous?.categoryName ?? categoryName };

  const now = new Date().toISOString();
  await db.batch([
    db.delete(cyberbizProductCategories).where(eq(cyberbizProductCategories.sku, sku)),
    ...(categoryId
      ? [db.insert(cyberbizProductCategories).values({ sku, categoryId, createdAt: now, updatedAt: now })]
      : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "cyberbiz_product_category",
      entityId: sku,
      entityLabel: sku,
      eventType: "cyberbiz_product_category_updated",
      summary: "更新 CYBERBIZ 商品分類",
      field: "category",
      oldValue: previous?.categoryName ?? null,
      newValue: categoryName,
      payload: {
        sku,
        before: { categoryId: previousId, categoryName: previous?.categoryName ?? null },
        after: { categoryId, categoryName },
      },
      actor: input.actor,
      source: "wms",
    })),
  ] as never);

  return { sku, categoryId, categoryName };
}

/** 建立一個報表商品分類。分類名稱是主檔資料，歷史報表快照不會被回寫。 */
export async function createReportProductCategory(
  db: Database,
  input: { name: string; color?: unknown; actor: Actor },
): Promise<ReportProductCategoryWriteResult> {
  const name = requireReportCategoryName(input.name);
  const [duplicate] = await db.select({ id: reportProductCategories.id })
    .from(reportProductCategories)
    .where(eq(reportProductCategories.name, name))
    .limit(1);
  if (duplicate) throw new WmsError("conflict", `商品分類「${name}」已經存在。`);

  const category = {
    id: crypto.randomUUID(),
    name,
    color: normalizeReportCategoryColor(input.color, "rose"),
  };
  await db.batch([
    db.insert(reportProductCategories).values(category),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_product_category",
      entityId: category.id,
      entityLabel: category.name,
      eventType: "report_product_category_created",
      summary: "新增商品分類",
      payload: category,
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return category;
}

/** 修改報表商品分類主檔；自訂商品主檔保存的是名稱，因此改名時一併同步主檔文字。 */
export async function updateReportProductCategory(
  db: Database,
  id: string,
  input: { name?: string; color?: unknown; actor: Actor },
): Promise<ReportProductCategoryWriteResult> {
  const [current] = await db.select().from(reportProductCategories)
    .where(eq(reportProductCategories.id, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這個商品分類。");

  const name = input.name === undefined ? current.name : requireReportCategoryName(input.name);
  if (name !== current.name) {
    const [duplicate] = await db.select({ id: reportProductCategories.id })
      .from(reportProductCategories)
      .where(eq(reportProductCategories.name, name))
      .limit(1);
    if (duplicate && duplicate.id !== id) throw new WmsError("conflict", `商品分類「${name}」已經存在。`);
  }
  const next = { name, color: normalizeReportCategoryColor(input.color, current.color) };
  await db.batch([
    db.update(reportProductCategories)
      .set({ ...next, updatedAt: new Date().toISOString() })
      .where(eq(reportProductCategories.id, id)),
    ...(name !== current.name
      ? [db.update(customReportProducts)
        .set({ category: name, updatedAt: new Date().toISOString() })
        .where(eq(customReportProducts.category, current.name))]
      : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_product_category",
      entityId: id,
      entityLabel: name,
      eventType: "report_product_category_updated",
      summary: name !== current.name ? "重新命名商品分類" : "修改商品分類顏色",
      field: name !== current.name ? "name" : "color",
      oldValue: name !== current.name ? current.name : current.color,
      newValue: name !== current.name ? name : next.color,
      payload: { before: current, after: next },
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { id, ...next };
}

/** 刪除前擋住仍有現行商品使用的分類；歷史 report snapshot 不在這個檢查範圍。 */
export async function deleteReportProductCategory(db: Database, id: string, actor: Actor): Promise<void> {
  const [category] = await db.select().from(reportProductCategories)
    .where(eq(reportProductCategories.id, id)).limit(1);
  if (!category) throw new WmsError("not_found", "找不到這個商品分類。");

  const [skuUsage, customUsage] = await Promise.all([
    db.select({ total: count() }).from(cyberbizProductCategories)
      .where(eq(cyberbizProductCategories.categoryId, id)),
    db.select({ total: count() }).from(customReportProducts)
      .where(eq(customReportProducts.category, category.name)),
  ]);
  const skuCount = Number(skuUsage[0]?.total ?? 0);
  const customCount = Number(customUsage[0]?.total ?? 0);
  if (skuCount || customCount) {
    const usage = [
      skuCount ? `${skuCount} 個 CYBERBIZ SKU` : "",
      customCount ? `${customCount} 個自訂商品主檔` : "",
    ].filter(Boolean).join("、");
    throw new WmsError("conflict", `商品分類「${category.name}」仍被 ${usage} 使用，請先改分其他分類。`);
  }

  await db.batch([
    db.delete(reportProductCategories).where(eq(reportProductCategories.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "report_product_category",
      entityId: id,
      entityLabel: category.name,
      eventType: "report_product_category_deleted",
      summary: "刪除商品分類",
      payload: category,
      actor,
      source: "reports",
    })),
  ] as never);
}
