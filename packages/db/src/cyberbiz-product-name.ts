import type { CyberbizProduct } from "./schema/wms.js";

/**
 * 統一 CYBERBIZ 商品在後台與報表中的顯示名稱。
 *
 * 這裡刻意接受完整的 CyberbizProduct，而不是只接受兩個字串，讓所有呼叫點都明確
 * 使用商品目錄的資料；variantName 為空白時不顯示多餘的括號。
 */
export function formatCyberbizProductName(product: CyberbizProduct): string {
  const productName = product.productName.trim();
  const variantName = product.variantName.trim();
  return variantName ? `${productName}（${variantName}）` : productName;
}
