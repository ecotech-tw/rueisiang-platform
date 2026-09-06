/**
 * 統一 CYBERBIZ 商品在後台與報表中的顯示名稱。
 *
 * 這裡刻意接受完整的 CyberbizProduct，而不是只接受兩個字串，讓所有呼叫點都明確
 * 使用商品目錄的資料。
 *
 * **官網的 variantName 本身就已經是「商品名 - 規格」。** 直接把它接在商品名後面，
 * 商品名就會出現兩次：單一款式的商品變成「賦活草本液體皂（賦活草本液體皂 -）」，
 * 有規格的變成「洗護合一組（洗護合一組 - 黑豆液體皂 + 護髮素）」。正式庫裡 143 筆
 * 官網品項全部長這樣，沒有例外。
 *
 * 所以先把重複的商品名前綴切掉，只留真正的規格。單一款式的商品切完會剩下一個
 * 孤零零的連字號（官網那邊規格是空的），那也一併去掉，最後就只剩商品名。
 */
export function formatCyberbizProductName(product: { productName: string; variantName: string }): string {
  const productName = product.productName.trim();
  const variant = variantSpec(productName, product.variantName);
  return variant ? `${productName}（${variant}）` : productName;
}

/**
 * 款式名稱裡真正屬於「規格」的那一段。
 *
 * 前綴不吻合時原樣保留：官網哪天改了格式，寧可顯示得囉唆一點，也不要靠猜測把
 * 使用者看得懂的字切掉。
 */
export function variantSpec(productName: string, variantName: string): string {
  const variant = variantName.trim();
  if (!variant.startsWith(productName)) return variant;
  return variant.slice(productName.length).replace(/^\s*-\s*/, "").replace(/\s*-\s*$/, "").trim();
}
