import { asc, count, eq } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatCyberbizProductName } from "./cyberbiz-product-name.js";
import { activityEvents } from "./schema/activity.js";
import { itemCategories, cyberbizProducts, items } from "./schema/items.js";
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

async function listTargetProductCategoryOptions(db: Database): Promise<ProductCategoryOption[]> {
  const [categoryRows, cyberbizCounts, customCounts] = await Promise.all([
    db.select({ id: itemCategories.id, name: itemCategories.name, color: itemCategories.color })
      .from(itemCategories)
      .orderBy(asc(itemCategories.name)),
    db.select({ categoryId: items.categoryId, total: count() })
      .from(items)
      .innerJoin(cyberbizProducts, eq(cyberbizProducts.itemId, items.id))
      .groupBy(items.categoryId),
    db.select({ categoryId: items.categoryId, total: count() })
      .from(items)
      .where(eq(items.source, "custom"))
      .groupBy(items.categoryId),
  ]);
  const skuCounts = new Map(cyberbizCounts.map((row) => [row.categoryId ?? "", Number(row.total)]));
  const customProductCounts = new Map(customCounts.map((row) => [row.categoryId ?? "", Number(row.total)]));
  return categoryRows.map((row) => ({
    ...row,
    skuCount: skuCounts.get(row.id) ?? 0,
    customProductCount: customProductCounts.get(row.id) ?? 0,
    usageCount: (skuCounts.get(row.id) ?? 0) + (customProductCounts.get(row.id) ?? 0),
  }));
}

/** 商品分類選項只讀全平台品項主檔；WMS 倉儲分類不會出現在這裡。 */
export async function listProductCategoryOptions(db: Database): Promise<ProductCategoryOption[]> {
  return listTargetProductCategoryOptions(db);
}

/** 以 CYBERBIZ 商品鏡像為全集，未分類的商品也必須出現在管理頁。 */
export async function listCyberbizProductCategoryManagement(
  db: Database,
): Promise<CyberbizProductCategoryManagementData> {
  const [productRows, categories] = await Promise.all([
    db.select({
      sku: items.sku,
      productName: cyberbizProducts.productName,
      variantName: cyberbizProducts.variantName,
      published: cyberbizProducts.published,
      categoryId: items.categoryId,
      categoryName: itemCategories.name,
      categoryColor: itemCategories.color,
    })
      .from(cyberbizProducts)
      .innerJoin(items, eq(items.id, cyberbizProducts.itemId))
      .leftJoin(itemCategories, eq(itemCategories.id, items.categoryId))
      .orderBy(asc(cyberbizProducts.productName), asc(cyberbizProducts.variantName), asc(items.sku)),
    listProductCategoryOptions(db),
  ]);
  return {
    products: productRows.map((row) => ({
      sku: row.sku,
      name: formatCyberbizProductName(row),
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

  const [product] = await db.select({ id: items.id, sku: items.sku, categoryId: items.categoryId })
    .from(cyberbizProducts)
    .innerJoin(items, eq(items.id, cyberbizProducts.itemId))
    .where(eq(items.sku, sku))
    .limit(1);
  if (!product) throw new WmsError("not_found", `找不到 CYBERBIZ SKU「${sku}」。`);

  const categoryId = input.categoryId?.trim() || null;
  let categoryName: string | null = null;
  if (categoryId) {
    const [category] = await db.select({ id: itemCategories.id, name: itemCategories.name })
      .from(itemCategories)
      .where(eq(itemCategories.id, categoryId))
      .limit(1);
    if (!category) throw new WmsError("not_found", "找不到指定的商品分類。");
    categoryName = category.name;
  }
  if (product.categoryId === categoryId) return { sku, categoryId, categoryName };

  await db.batch([
    db.update(items).set({ categoryId, updatedAt: new Date().toISOString() }).where(eq(items.id, product.id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "cyberbiz_product_category",
      entityId: sku,
      entityLabel: sku,
      eventType: "cyberbiz_product_category_updated",
      summary: "更新 CYBERBIZ 商品分類",
      field: "category",
      oldValue: product.categoryId,
      newValue: categoryName,
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
  const [duplicate] = await db.select({ id: itemCategories.id })
    .from(itemCategories)
    .where(eq(itemCategories.name, name))
    .limit(1);
  if (duplicate) throw new WmsError("conflict", `商品分類「${name}」已經存在。`);

  const category = {
    id: crypto.randomUUID(),
    depth: 0,
    parentId: null,
    parentDepth: null,
    name,
    color: normalizeReportCategoryColor(input.color, "rose"),
    sortOrder: 0,
    active: 1,
  };
  await db.batch([
    db.insert(itemCategories).values(category),
    db.insert(activityEvents).values(activityRow({
      entityType: "item_category",
      entityId: category.id,
      entityLabel: category.name,
      eventType: "report_product_category_created",
      summary: "新增商品分類",
      payload: category,
      actor: input.actor,
      source: "reports",
    })),
  ] as never);
  return { id: category.id, name: category.name, color: category.color };
}

/** 修改報表商品分類主檔；品項以外鍵指向分類，不需複製同步名稱。 */
export async function updateReportProductCategory(
  db: Database,
  id: string,
  input: { name?: string; color?: unknown; actor: Actor },
): Promise<ReportProductCategoryWriteResult> {
  const [current] = await db.select().from(itemCategories).where(eq(itemCategories.id, id)).limit(1);
  if (!current) throw new WmsError("not_found", "找不到這個商品分類。");
  const name = input.name === undefined ? current.name : requireReportCategoryName(input.name);
  if (name !== current.name) {
    const [duplicate] = await db.select({ id: itemCategories.id })
      .from(itemCategories)
      .where(eq(itemCategories.name, name))
      .limit(1);
    if (duplicate && duplicate.id !== id) throw new WmsError("conflict", `商品分類「${name}」已經存在。`);
  }
  const next = { name, color: normalizeReportCategoryColor(input.color, current.color) };
  await db.batch([
    db.update(itemCategories).set({ ...next, updatedAt: new Date().toISOString() }).where(eq(itemCategories.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "item_category",
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

/** 刪除前擋住仍有現行品項使用的分類；歷史 report snapshot 不在這個檢查範圍。 */
export async function deleteReportProductCategory(db: Database, id: string, actor: Actor): Promise<void> {
  const [category] = await db.select().from(itemCategories).where(eq(itemCategories.id, id)).limit(1);
  if (!category) throw new WmsError("not_found", "找不到這個商品分類。");
  const [usage] = await db.select({ total: count() }).from(items).where(eq(items.categoryId, id));
  if (Number(usage?.total ?? 0)) {
    throw new WmsError("conflict", `商品分類「${category.name}」仍被 ${Number(usage?.total ?? 0)} 個品項使用，請先改分其他分類。`);
  }
  await db.batch([
    db.delete(itemCategories).where(eq(itemCategories.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "item_category",
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
