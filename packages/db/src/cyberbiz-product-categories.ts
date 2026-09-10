import { asc, count, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { itemCategories, cyberbizProducts, items } from "./schema/items.js";

export interface ProductCategoryOption {
  id: string;
  name: string;
  color: string;
  skuCount: number;
  customProductCount: number;
  usageCount: number;
}

/** 商品分類選項只讀全平台品項主檔；WMS 倉儲分類不會出現在這裡。 */
export async function listProductCategoryOptions(db: Database): Promise<ProductCategoryOption[]> {
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

