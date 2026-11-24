import type { Database } from "./client.js";
import { findMediaCdnImage } from "./media-cdn.js";
import { listReportManagementScopes } from "./report-manual.js";

const NORTH_COUNTIES = ["臺北市", "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "宜蘭縣"];

/** API 與 CDN 共用公開投影，不能讓快照有另一套公開條件或夾帶管理欄位。 */
export async function buildPublicStoreLocator(db: Database, imageUrl: (id: string) => string) {
  const scopes = await listReportManagementScopes(db);
  const eligible = scopes.filter((scope) =>
    scope.scopeKind === "store" && scope.active && !scope.archivedAt
    && scope.storeLocatorCategory && scope.storeLocatorCounty && scope.storeLocatorAddress
    && scope.storeLocatorPinX !== null && scope.storeLocatorPinY !== null,
  );
  const stores = await Promise.all(eligible.map(async (scope) => {
    const image = !scope.storeLocatorImageUrl && scope.storeLocatorImageId ? await findMediaCdnImage(db, scope.storeLocatorImageId) : null;
    let imageSource = scope.storeLocatorImageUrl;
    if (!imageSource && image && !image.deletedAt && image.objectKey) {
      try { imageSource = imageUrl(image.id); } catch { /* 未設定圖片 CDN 時仍提供文字與地圖。 */ }
    }
    return {
      id: scope.id,
      region: NORTH_COUNTIES.includes(scope.storeLocatorCounty) ? "north" : "south",
      category: scope.storeLocatorCategory,
      label: `${scope.storeLocatorCounty}｜${scope.name}`,
      shortName: scope.name,
      name: scope.name,
      county: scope.storeLocatorCounty,
      address: scope.storeLocatorAddress,
      floorNote: scope.storeLocatorFloorNote,
      hours: scope.storeLocatorHours,
      phone: scope.storeLocatorPhone,
      highlight: scope.storeLocatorHighlight,
      image: imageSource,
      mapUrl: scope.storeLocatorMapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(scope.storeLocatorAddress)}`,
      pinX: scope.storeLocatorPinX,
      pinY: scope.storeLocatorPinY,
    };
  }));
  stores.sort((left, right) => (left.pinY ?? 0) - (right.pinY ?? 0) || left.name.localeCompare(right.name, "zh-Hant"));
  return { stores };
}
