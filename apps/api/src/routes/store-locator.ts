import { findMediaCdnImage, listReportManagementScopes } from "@rueisiang/db";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";
import { mediaCdnUrl } from "../media-cdn.js";

export const storeLocator = new Hono<AppEnv>();

const NORTH_COUNTIES = ["臺北市", "台北市", "新北市", "基隆市", "桃園市", "新竹市", "新竹縣", "宜蘭縣"];

storeLocator.get("/", async (c) => {
  const scopes = await listReportManagementScopes(c.get("db"));
  const eligible = scopes.filter((scope) =>
    scope.scopeKind === "store" && scope.active && !scope.archivedAt
    && scope.storeLocatorCategory && scope.storeLocatorCounty && scope.storeLocatorAddress
    && scope.storeLocatorPinX !== null && scope.storeLocatorPinY !== null,
  );
  const stores = await Promise.all(eligible.map(async (scope) => {
    const image = !scope.storeLocatorImageUrl && scope.storeLocatorImageId ? await findMediaCdnImage(c.get("db"), scope.storeLocatorImageId) : null;
    let imageUrl = scope.storeLocatorImageUrl;
    if (!imageUrl && image && !image.deletedAt && image.objectKey) {
      try { imageUrl = mediaCdnUrl(c.env, image.id); } catch { /* 沒有 CDN 設定時仍提供文字與地圖資訊。 */ }
    }
    const mapUrl = scope.storeLocatorMapUrl || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(scope.storeLocatorAddress)}`;
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
      image: imageUrl,
      mapUrl,
      pinX: scope.storeLocatorPinX,
      pinY: scope.storeLocatorPinY,
    };
  }));
  stores.sort((left, right) => (left.pinY ?? 0) - (right.pinY ?? 0) || left.name.localeCompare(right.name, "zh-Hant"));
  c.header("Cache-Control", "public, max-age=60");
  return c.json({ stores });
});
