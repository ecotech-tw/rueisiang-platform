import { and, asc, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import { activityRow } from "./activity.js";
import type { Database } from "./client.js";
import { formatCyberbizProductName } from "./cyberbiz-product-name.js";
import { activityEvents } from "./schema/activity.js";
import {
  customReportProducts,
  cyberbizProductCategories,
  cyberbizProducts,
  inventoryItems,
  productBundleComponents,
  productSkuMappings,
  reportSkuIgnores,
} from "./schema/wms.js";
import { reportProductCategories } from "./schema/report-products.js";
import { cyberbizProducts as targetCyberbizProducts, items as itemMasters } from "./schema/items.js";
import { WmsError, type Actor } from "./wms.js";

/** 外部 SKU 寫入前統一格式，避免大小寫造成兩筆 mapping。 */
export function normalizeExternalSku(value: string): string {
  return value.trim().toUpperCase();
}

/** 通路目前用文字保存；先統一大小寫，未來新增通路不用先改資料庫 enum。 */
export function normalizeProductSkuChannel(value: string): string {
  return value.trim().toLowerCase();
}

/** 從 scope ID 前綴推導這個 scope 自己的通路；沒有前綴的舊資料一律當 legacy。 */
export function reportScopeChannel(scopeId: string): string {
  const [prefix, scopePart] = scopeId.split(":", 2);
  if (!scopePart) return "legacy";
  return normalizeProductSkuChannel(prefix ?? "") || "legacy";
}

/**
 * scope 裡的資料屬於哪個通路：manual scope 只是沒有自動抓取來源，裡面的商品仍然是
 * CYBERBIZ 報表，查 mapping 與標示通路時都當成 cyberbiz。
 *
 * 跟 reportScopeChannel 分成兩個函式，是因為 scope 的「身分」不能跟著改：ingest 用
 * 同通路同名沿用既有 scope，manual 一旦回答 cyberbiz，使用者輸入既有店名新建據點時
 * 就會寫進那家店的 cyberbiz scope，而 sales 是整月覆寫——等於把當月自動匯入的資料
 * 清掉。
 */
export function reportDataChannel(scopeId: string): string {
  const channel = reportScopeChannel(scopeId);
  return channel === "manual" ? "cyberbiz" : channel;
}

/** 蝦皮新報表會把規格 ID 接在商品 ID 後；舊 mapping 仍可能只有商品 ID。 */
export function legacyShopeeExternalSku(value: string): string {
  const separator = value.indexOf("_");
  return separator > 0 ? value.slice(0, separator) : "";
}

export interface ProductSkuMappingRow {
  id: string;
  channel: string;
  externalName: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProductSkuMappingManagementRow extends ProductSkuMappingRow {
  components: ProductBundleComponentManagementRow[];
}

/**
 * 管理頁看到的一列用料。
 *
 * source 讓畫面知道要顯示 WMS 商品下拉還是自訂 SKU 欄位；sku／name／category 兩種來源
 * 都填好，畫面不必再去對照另一份清單。
 */
export interface ProductBundleComponentManagementRow {
  source: "item" | "cyberbiz" | "custom";
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customProductId: string | null;
  sku: string;
  name: string;
  category: string;
  quantity: number;
}

export interface ProductSkuMappingManagementData {
  mappings: ProductSkuMappingManagementRow[];
  categories: string[];
}

/**
 * 一筆外部 SKU 解析出來要寫進報表的內容。
 *
 * 沒有「這筆對應是哪個商品」這種欄位——報表寫哪些 SKU 完全由 components 決定，
 * 一對一商品就是一列用料。
 */
export interface ResolvedProductSku {
  externalName: string;
  components: ResolvedProductSkuComponent[];
}

export interface ResolvedProductSkuComponent {
  /** 自訂用料沒有 WMS 商品，這裡是 null。 */
  inventoryItemId: string | null;
  sku: string;
  name: string;
  category: string;
  quantity: number;
}

const SKU_LOOKUP_BATCH_SIZE = 50;

/**
 * 依 SKU_LOOKUP_BATCH_SIZE 分批送出 IN 查詢。
 *
 * D1 單支 SQL 的 bound parameter 有上限，而報表可能一次帶進數百個用料。本機測試抓不到：
 * node:sqlite 允許 32766 個參數，D1 沒那麼多，所以漏掉分批只會在正式環境炸。
 */
async function inBatches<T, R>(values: T[], run: (batch: T[]) => Promise<R[]>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    results.push(...await run(values.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE)));
  }
  return results;
}

/**
 * SKU 對應管理頁需要的資料。
 *
 * 通路商品名稱存於 mapping；用料的 SKU、名稱與分類一律從 inventory_items 或
 * custom_report_products 即時讀取，管理頁不會顯示過期的複本。items 與 categories
 * 只供選擇用料，不含倉位、數量或其他不相關的倉儲資料。
 */
export async function loadProductSkuMappingManagement(
  db: Database,
): Promise<ProductSkuMappingManagementData> {
  const [mappingRows, categoryRows] = await Promise.all([
    db
      .select({
        id: productSkuMappings.id,
        channel: productSkuMappings.channel,
        externalName: productSkuMappings.externalName,
        externalSku: productSkuMappings.externalSku,
        createdAt: productSkuMappings.createdAt,
        updatedAt: productSkuMappings.updatedAt,
      })
      .from(productSkuMappings)
      .orderBy(asc(productSkuMappings.channel), asc(productSkuMappings.externalSku)),
    db.select({ name: reportProductCategories.name }).from(reportProductCategories).orderBy(asc(reportProductCategories.name)),
  ]);

  /*
   * 用料、WMS 商品、自訂商品分三次查，不 join 在一起。
   *
   * inventory_items 與 custom_report_products 都有 sku／name／category，join 起來回傳的
   * 結果會對映錯位（loadWarehouse 的 listCompanyLinks 踩過同一個坑）。分開查再配對沒有
   * 那個問題，而且兩份主檔都很小。
   */
  const componentsByMapping = new Map<string, ProductBundleComponentManagementRow[]>();
  const mappingIds = mappingRows.map((row) => row.id);
  const componentRows: Array<{
    mappingId: string;
    inventoryItemId: string | null;
    cyberbizSku: string | null;
    customProductId: string | null;
    quantity: number;
  }> = [];
  for (let offset = 0; offset < mappingIds.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = mappingIds.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    componentRows.push(...await db
      .select({
        mappingId: productBundleComponents.mappingId,
        inventoryItemId: productBundleComponents.inventoryItemId,
        cyberbizSku: productBundleComponents.cyberbizSku,
        customProductId: productBundleComponents.customProductId,
        quantity: productBundleComponents.quantity,
      })
      .from(productBundleComponents)
      .where(inArray(productBundleComponents.mappingId, batch))
      // 排序要決定性：報表把銷售額放在第一列用料上，順序飄動金額就會在 SKU 之間跳。
      .orderBy(asc(productBundleComponents.mappingId), asc(productBundleComponents.id)));
  }
  const componentItemIds = [...new Set(componentRows.map((row) => row.inventoryItemId).filter((id): id is string => !!id))];
  // 既有資料還有 WMS 用料（UI 已經不提供這個來源），讀取端仍要認得它。
  const itemRows = await inBatches(componentItemIds, (batch) => db
    .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name, category: inventoryItems.category })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, batch)));
  const itemById = new Map(itemRows.map((row) => [row.id, row]));
  const customIds = [...new Set(componentRows.map((row) => row.customProductId).filter((id): id is string => !!id))];
  const customRows = await inBatches(customIds, (batch) => db
    .select({
      id: customReportProducts.id,
      sku: customReportProducts.sku,
      name: customReportProducts.name,
      category: customReportProducts.category,
    })
    .from(customReportProducts)
    .where(inArray(customReportProducts.id, batch)));
  const customById = new Map(customRows.map((row) => [row.id, row]));
  const catalogSkus = [...new Set(componentRows.map((row) => row.cyberbizSku).filter((sku): sku is string => !!sku))];
  const catalogRows = await inBatches(catalogSkus, (batch) => db
    .select({
      ...getTableColumns(cyberbizProducts),
      categoryName: reportProductCategories.name,
    })
    .from(cyberbizProducts)
    .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
    .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
    .where(inArray(cyberbizProducts.sku, batch)));
  const catalogBySku = new Map(catalogRows.map((row) => [
    row.sku,
    {
      sku: row.sku,
      name: formatCyberbizProductName(row),
      category: row.categoryName ?? "未分類",
    },
  ]));
  for (const row of componentRows) {
    const list = componentsByMapping.get(row.mappingId) ?? [];
    const custom = row.customProductId ? customById.get(row.customProductId) : undefined;
    const item = row.inventoryItemId ? itemById.get(row.inventoryItemId) : undefined;
    const catalog = row.cyberbizSku ? catalogBySku.get(row.cyberbizSku) : undefined;
    if (row.cyberbizSku) {
      list.push({
        source: "cyberbiz",
        inventoryItemId: null,
        cyberbizSku: row.cyberbizSku,
        customProductId: null,
        sku: row.cyberbizSku,
        name: catalog?.name ?? "",
        category: catalog?.category ?? "未分類",
        quantity: row.quantity,
      });
      componentsByMapping.set(row.mappingId, list);
      continue;
    }
    list.push(custom
      ? {
        source: "custom",
        inventoryItemId: null,
        cyberbizSku: null,
        customProductId: custom.id,
        sku: custom.sku,
        name: custom.name,
        category: custom.category,
        quantity: row.quantity,
      }
      : {
        source: "item",
        inventoryItemId: row.inventoryItemId,
        cyberbizSku: null,
        customProductId: null,
        sku: item?.sku ?? "",
        name: item?.name ?? "",
        category: item?.category ?? "未分類",
        quantity: row.quantity,
      });
    componentsByMapping.set(row.mappingId, list);
  }

  return {
    mappings: mappingRows.map((row) => ({ ...row, components: componentsByMapping.get(row.id) ?? [] })),
    categories: categoryRows.map((row) => row.name),
  };
}

/**
 * 一列用料的輸入。
 *
 * inventoryItemId 與 customSku 恰有一個要填：前者連到 WMS 商品，後者連到（必要時建立）
 * 報表自訂商品。混用是刻意允許的——禮盒裡可能有入庫的香皂，也可能有不入庫的贈品。
 */
export interface ProductBundleComponentInput {
  inventoryItemId?: string | null;
  cyberbizSku?: string | null;
  customSku?: string | null;
  customName?: string | null;
  customCategory?: string | null;
  quantity: number;
}

interface NormalizedComponent {
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customSku: string | null;
  customName: string;
  customCategory: string;
  quantity: number;
}

function validateBundleComponents(
  components: ProductBundleComponentInput[] | undefined,
): NormalizedComponent[] {
  if (!components?.length) throw new WmsError("invalid", "至少要設定一個組合用料。");
  const seenItems = new Set<string>();
  const seenCyberbiz = new Set<string>();
  const seenCustom = new Set<string>();
  return components.map((component) => {
    const inventoryItemId = typeof component?.inventoryItemId === "string"
      ? component.inventoryItemId.trim()
      : "";
    const cyberbizSku = typeof component?.cyberbizSku === "string"
      ? normalizeExternalSku(component.cyberbizSku)
      : "";
    const customSku = typeof component?.customSku === "string"
      ? normalizeExternalSku(component.customSku)
      : "";
    if (!Number.isSafeInteger(component?.quantity) || component.quantity <= 0) {
      throw new WmsError("invalid", "組合用料的數量必須是大於 0 的整數。");
    }
    const sources = [inventoryItemId, cyberbizSku, customSku].filter(Boolean);
    if (sources.length !== 1) {
      throw new WmsError("invalid", "每一列組合用料只能選擇 WMS 商品、CYBERBIZ 商品或自訂 SKU 其中一種。");
    }
    if (inventoryItemId) {
      if (seenItems.has(inventoryItemId)) {
        throw new WmsError("invalid", "組合用料不可重複設定同一個 WMS 商品。");
      }
      seenItems.add(inventoryItemId);
      return { inventoryItemId, cyberbizSku: null, customSku: null, customName: "", customCategory: "", quantity: component.quantity };
    }
    if (cyberbizSku) {
      if (seenCyberbiz.has(cyberbizSku)) {
        throw new WmsError("invalid", "組合用料不可重複設定同一個 CYBERBIZ 商品。");
      }
      seenCyberbiz.add(cyberbizSku);
      return { inventoryItemId: null, cyberbizSku, customSku: null, customName: "", customCategory: "", quantity: component.quantity };
    }
    if (seenCustom.has(customSku)) {
      throw new WmsError("invalid", "組合用料不可重複設定同一個自訂 SKU。");
    }
    seenCustom.add(customSku);
    const customName = (component.customName ?? "").trim();
    if (!customName) throw new WmsError("invalid", `自訂 SKU「${customSku}」必須填寫商品名稱。`);
    return {
      inventoryItemId: null,
      cyberbizSku: null,
      customSku,
      customName,
      customCategory: (component.customCategory ?? "").trim() || "未分類",
      quantity: component.quantity,
    };
  });
}

interface ComponentRow {
  id: string;
  mappingId: string;
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customProductId: string | null;
  quantity: number;
}

interface CustomProductWrite {
  id: string;
  sku: string;
  name: string;
  category: string;
  exists: boolean;
}

/**
 * 把用料換成可以直接寫入 product_bundle_components 的資料列。
 *
 * 自訂 SKU 以 sku 為識別做 upsert：同一個自訂商品被多個通路的 mapping 指到時只有一份
 * 名稱與分類，報表那一行叫什麼才不會取決於匯入順序。
 */
async function prepareComponentRows(
  db: Database,
  mappingId: string,
  components: NormalizedComponent[],
): Promise<{ rows: ComponentRow[]; customProducts: CustomProductWrite[] }> {
  const itemIds = components.map((component) => component.inventoryItemId).filter((id): id is string => !!id);
  const items = itemIds.length
    ? await db
      .select({ id: inventoryItems.id, sku: inventoryItems.sku })
      .from(inventoryItems)
      .where(inArray(inventoryItems.id, itemIds))
    : [];
  if (items.length !== itemIds.length) {
    throw new WmsError("not_found", "找不到組合用料使用的 WMS 商品。");
  }
  if (items.some((item) => !item.sku)) {
    throw new WmsError("invalid", "請先設定組合用料的 WMS SKU。");
  }

  const customSkus = components.map((component) => component.customSku).filter((sku): sku is string => !!sku);
  /*
   * 自訂 SKU 不能跟任何 WMS 商品的 SKU 重複。
   *
   * 兩邊會寫進同一個 report_sales_monthly.sku 卻帶不同的名稱與分類，報表就有兩個互相
   * 競爭的來源。真的要記錄那個 WMS 商品的話，直接把它選成用料即可。
   */
  const clashing = customSkus.length
    ? await db
      .select({ sku: inventoryItems.sku })
      .from(inventoryItems)
      .where(sql`UPPER(${inventoryItems.sku}) IN (${sql.join(customSkus.map((sku) => sql`${sku}`), sql`, `)})`)
    : [];
  const clash = clashing[0]?.sku;
  if (clash) {
    throw new WmsError("conflict", `自訂 SKU「${normalizeExternalSku(clash)}」已是 WMS 商品的 SKU，請直接選擇那個商品。`);
  }

  const cyberbizSkus = components.map((component) => component.cyberbizSku).filter((sku): sku is string => !!sku);
  if (cyberbizSkus.length) {
    const known = await db
      .select({ sku: cyberbizProducts.sku })
      .from(cyberbizProducts)
      .where(inArray(cyberbizProducts.sku, cyberbizSkus));
    const knownSkus = new Set(known.map((row) => row.sku));
    const missing = cyberbizSkus.find((sku) => !knownSkus.has(sku));
    if (missing) {
      throw new WmsError("not_found", `CYBERBIZ 目錄裡找不到 SKU「${missing}」，請先同步官網商品目錄。`);
    }
  }

  const existingCustom = customSkus.length
    ? await db
      .select({ id: customReportProducts.id, sku: customReportProducts.sku })
      .from(customReportProducts)
      .where(inArray(customReportProducts.sku, customSkus))
    : [];
  const customIdBySku = new Map(existingCustom.map((row) => [row.sku, row.id]));

  const customProducts: CustomProductWrite[] = [];
  /*
   * 序號補零。
   *
   * 兩處讀取都以 id 排序，而 id 是字典序：不補零的話 `:10` 會排在 `:2` 前面，
   * 十個用料以上的組合在管理頁就會照被打亂的順序顯示，重存還會照那個順序重新編號。
   */
  const rows = components.map((component, index) => {
    const rowId = `${mappingId}:${String(index).padStart(3, "0")}`;
    if (component.inventoryItemId) {
      return {
        id: rowId,
        mappingId,
        inventoryItemId: component.inventoryItemId,
        cyberbizSku: null,
        customProductId: null,
        quantity: component.quantity,
      };
    }
    if (component.cyberbizSku) {
      return {
        id: rowId,
        mappingId,
        inventoryItemId: null,
        cyberbizSku: component.cyberbizSku,
        customProductId: null,
        quantity: component.quantity,
      };
    }
    const sku = component.customSku as string;
    const existingId = customIdBySku.get(sku);
    const customProductId = existingId ?? crypto.randomUUID();
    if (!existingId) customIdBySku.set(sku, customProductId);
    customProducts.push({
      id: customProductId,
      sku,
      name: component.customName,
      category: component.customCategory,
      exists: !!existingId,
    });
    return {
      id: rowId,
      mappingId,
      inventoryItemId: null,
      cyberbizSku: null,
      customProductId,
      quantity: component.quantity,
    };
  });
  return { rows, customProducts };
}

function customProductWrites(db: Database, customProducts: CustomProductWrite[]) {
  return customProducts.map((product) => (product.exists
    ? db.update(customReportProducts)
      .set({ name: product.name, category: product.category, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(customReportProducts.id, product.id))
    : db.insert(customReportProducts).values({
      id: product.id,
      sku: product.sku,
      name: product.name,
      category: product.category,
    })));
}

/**
 * 外部 SKU 不能遮蔽別的 WMS 商品的正式 SKU。
 *
 * 只有「這筆對應自己沒有用到的商品」才算衝突：組合的外部 SKU 剛好等於某個用料的
 * WMS SKU 沒有歧義，因為 resolveProductSkus 讓明確 mapping 贏過 implicit 的直接比對。
 */
async function requireExternalSkuAvailable(
  db: Database,
  externalSku: string,
  componentItemIds: string[],
  customProductSkus: string[],
): Promise<void> {
  const owners = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`UPPER(${inventoryItems.sku}) = ${externalSku}`);
  const allowed = new Set(componentItemIds);
  if (owners.some((owner) => !allowed.has(owner.id))) {
    throw new WmsError("conflict", `外部 SKU「${externalSku}」與其他商品的 WMS SKU 衝突。`);
  }

  /*
   * 外部 SKU 也不能撞到別筆對應在用的自訂 SKU。
   *
   * 撞到的話報表查那個值會同時命中「這個自訂商品自己的資料列」與「別名指向的用料」，
   * 兩個商品的數字混在一起。自己這筆對應正在用的那個自訂 SKU 不算衝突。
   */
  const [customOwner] = await db
    .select({ sku: customReportProducts.sku, name: customReportProducts.name })
    .from(customReportProducts)
    .where(eq(customReportProducts.sku, externalSku))
    .limit(1);
  if (customOwner && !customProductSkus.includes(customOwner.sku)) {
    throw new WmsError(
      "conflict",
      `外部 SKU「${externalSku}」已是自訂商品主檔「${customOwner.name}」的系統 SKU，請換一個外部 SKU。`,
    );
  }
}

export async function addProductSkuMapping(
  db: Database,
  input: {
    channel?: string;
    externalName: string;
    externalSku: string;
    components: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; externalName: string; externalSku: string }> {
  const channel = normalizeProductSkuChannel(input.channel ?? "legacy");
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const externalName = input.externalName.trim();
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");
  const components = validateBundleComponents(input.components);

  await requireExternalSkuAvailable(
    db,
    externalSku,
    components.map((component) => component.inventoryItemId).filter((id): id is string => !!id),
    components.map((component) => component.customSku).filter((sku): sku is string => !!sku),
  );

  const [existing] = await db
    .select({ id: productSkuMappings.id })
    .from(productSkuMappings)
    .where(and(
      eq(productSkuMappings.channel, channel),
      eq(productSkuMappings.externalSku, externalSku),
    ))
    .limit(1);
  if (existing) {
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經存在，請改用編輯功能。`);
  }

  const id = crypto.randomUUID();
  const { rows, customProducts } = await prepareComponentRows(db, id, components);
  await db.batch([
    db.insert(productSkuMappings).values({ id, channel, externalName, externalSku }),
    ...customProductWrites(db, customProducts),
    db.insert(productBundleComponents).values(rows),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: externalName,
      eventType: "product_sku_mapping_created",
      summary: `新增${channel} 外部 SKU 對應：${externalSku}（${components.length} 個組合用料）`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ] as never);

  return { id, channel, externalName, externalSku };
}

export async function updateProductSkuMapping(
  db: Database,
  input: {
    id: string;
    channel?: string;
    externalName: string;
    externalSku: string;
    components: ProductBundleComponentInput[];
    actor: Actor;
  },
): Promise<{ id: string; channel: string; externalName: string; externalSku: string }> {
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const externalName = input.externalName.trim();
  if (!externalName) throw new WmsError("invalid", "通路商品名稱不可為空。");
  const components = validateBundleComponents(input.components);

  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      channel: productSkuMappings.channel,
      externalName: productSkuMappings.externalName,
      externalSku: productSkuMappings.externalSku,
    })
    .from(productSkuMappings)
    .where(eq(productSkuMappings.id, input.id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");

  const channel = normalizeProductSkuChannel(input.channel ?? mapping.channel);
  if (!channel) throw new WmsError("invalid", "通路不可為空。");

  await requireExternalSkuAvailable(
    db,
    externalSku,
    components.map((component) => component.inventoryItemId).filter((id): id is string => !!id),
    components.map((component) => component.customSku).filter((sku): sku is string => !!sku),
  );

  const [existing] = await db
    .select({ id: productSkuMappings.id })
    .from(productSkuMappings)
    .where(and(
      eq(productSkuMappings.channel, channel),
      eq(productSkuMappings.externalSku, externalSku),
      ne(productSkuMappings.id, input.id),
    ))
    .limit(1);
  if (existing) {
    throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經對應到其他商品。`);
  }

  const { rows, customProducts } = await prepareComponentRows(db, input.id, components);
  await db.batch([
    db.update(productSkuMappings)
      .set({ channel, externalName, externalSku, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(eq(productSkuMappings.id, input.id)),
    db.delete(productBundleComponents).where(eq(productBundleComponents.mappingId, input.id)),
    ...customProductWrites(db, customProducts),
    db.insert(productBundleComponents).values(rows),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: input.id,
      entityLabel: externalName,
      eventType: "product_sku_mapping_updated",
      summary: `更新${channel} 外部 SKU 對應：${externalSku}（${components.length} 個組合用料）`,
      field: mapping.externalSku === externalSku ? "mapping" : "externalSku",
      oldValue: mapping.externalSku,
      newValue: externalSku,
      payload: {
        before: { channel: mapping.channel, externalName: mapping.externalName, externalSku: mapping.externalSku },
        after: { channel, externalName, externalSku, components },
      },
      actor: input.actor,
      source: "wms",
    })),
  ] as never);

  return { id: input.id, channel, externalName, externalSku };
}

export async function deleteProductSkuMapping(
  db: Database,
  id: string,
  actor: Actor,
): Promise<void> {
  const [mapping] = await db
    .select({
      id: productSkuMappings.id,
      channel: productSkuMappings.channel,
      externalName: productSkuMappings.externalName,
      externalSku: productSkuMappings.externalSku,
    })
    .from(productSkuMappings)
    .where(eq(productSkuMappings.id, id));
  if (!mapping) throw new WmsError("not_found", "找不到這筆外部 SKU 對應。");

  /*
   * 順手回收沒人再參照的自訂商品主檔。
   *
   * 留著的話它會永久占住那個 SKU：之後把 WMS 商品改成同一個 SKU 會被擋下，而錯誤訊息
   * 叫使用者去改一筆他在畫面上根本看不到、也刪不掉的資料。
   */
  const orphanCandidates = await db
    .select({ customProductId: productBundleComponents.customProductId })
    .from(productBundleComponents)
    .where(eq(productBundleComponents.mappingId, id));
  const candidateIds = [...new Set(orphanCandidates
    .map((row) => row.customProductId)
    .filter((value): value is string => !!value))];
  const stillUsed = candidateIds.length
    ? await db
      .select({ customProductId: productBundleComponents.customProductId })
      .from(productBundleComponents)
      .where(and(
        inArray(productBundleComponents.customProductId, candidateIds),
        ne(productBundleComponents.mappingId, id),
      ))
    : [];
  const usedIds = new Set(stillUsed.map((row) => row.customProductId));
  const orphanIds = candidateIds.filter((customProductId) => !usedIds.has(customProductId));

  await db.batch([
    db.delete(productSkuMappings).where(eq(productSkuMappings.id, id)),
    ...(orphanIds.length
      ? [db.delete(customReportProducts).where(inArray(customReportProducts.id, orphanIds))]
      : []),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: mapping.externalName || mapping.externalSku,
      eventType: "product_sku_mapping_deleted",
      summary: `移除${mapping.channel} 外部 SKU 對應：${mapping.externalSku}`,
      field: "externalSku",
      oldValue: mapping.externalSku,
      actor,
      source: "wms",
    })),
  ]);
}

/**
 * 一次解析整份報表的外部 SKU，避免匯入時逐列查詢 D1。
 *
 * 外部 SKU 剛好就是正式 WMS SKU 時也允許直接命中 inventory_items，讓沒有建 mapping
 * 的商品仍然進得了報表；但只要有明確 mapping 就以 mapping 為準。
 */
export async function resolveProductSkus(
  db: Database,
  externalSkus: string[],
  channel = "legacy",
): Promise<Map<string, ResolvedProductSku>> {
  const normalizedChannel = normalizeProductSkuChannel(channel);
  const wanted = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!wanted.length) return new Map();

  /*
   * 蝦皮新報表的外部 SKU 是「商品ID_規格ID」，舊 mapping 可能只存商品 ID。
   * 兩種都查，最後再讓精確的那筆贏。
   */
  const lookupWanted = [...new Set([
    ...wanted,
    ...(normalizedChannel === "shopee" ? wanted.map(legacyShopeeExternalSku).filter(Boolean) : []),
  ])];
  const lookupChannels = [...new Set([normalizedChannel, "legacy"])];

  const mappings: Array<{ id: string; externalSku: string; channel: string; externalName: string }> = [];
  const directItems: Array<{ id: string; sku: string | null; name: string; category: string }> = [];

  // D1 單支 SQL 的 bound parameter 有上限；報表可能有數百個 SKU，不能一次塞完整份 IN。
  for (let offset = 0; offset < lookupWanted.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = lookupWanted.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    const [batchMappings, batchDirectItems] = await Promise.all([
      db
        .select({
          id: productSkuMappings.id,
          externalSku: productSkuMappings.externalSku,
          channel: productSkuMappings.channel,
          externalName: productSkuMappings.externalName,
        })
        .from(productSkuMappings)
        .where(and(
          inArray(productSkuMappings.externalSku, batch),
          inArray(productSkuMappings.channel, lookupChannels),
        )),
      db
        .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name, category: inventoryItems.category })
        .from(inventoryItems)
        .where(sql`UPPER(${inventoryItems.sku}) IN (${sql.join(batch.map((sku) => sql`${sku}`), sql`, `)})`),
    ]);
    mappings.push(...batchMappings);
    directItems.push(...batchDirectItems);
  }

  const componentsByMapping = new Map<string, ResolvedProductSkuComponent[]>();
  /*
   * 用料解析不出 SKU 就整筆 mapping 視為無法解析，不是跳過那一列。
   *
   * 跳過的話數量會憑空少掉而且不會有任何訊號。整筆視為無法解析的話，匯入端會把它列進
   * skippedSkus 讓人看得到。WMS 商品可以被清空 SKU，所以這種狀態真的會出現。
   */
  const incompleteMappings = new Set<string>();
  const mappingIds = [...new Set(mappings.map((mapping) => mapping.id))];
  const componentRows: Array<{
    mappingId: string;
    inventoryItemId: string | null;
    cyberbizSku: string | null;
    customProductId: string | null;
    quantity: number;
  }> = [];
  for (let offset = 0; offset < mappingIds.length; offset += SKU_LOOKUP_BATCH_SIZE) {
    const batch = mappingIds.slice(offset, offset + SKU_LOOKUP_BATCH_SIZE);
    componentRows.push(...await db
      .select({
        mappingId: productBundleComponents.mappingId,
        inventoryItemId: productBundleComponents.inventoryItemId,
        cyberbizSku: productBundleComponents.cyberbizSku,
        customProductId: productBundleComponents.customProductId,
        quantity: productBundleComponents.quantity,
      })
      .from(productBundleComponents)
      .where(inArray(productBundleComponents.mappingId, batch))
      // 銷售額落在第一列用料上，排序必須決定性，否則重匯會換一個 SKU 收金額。
      .orderBy(asc(productBundleComponents.mappingId), asc(productBundleComponents.id)));
  }
  /*
   * 兩份主檔分開查再配對，不 join。
   *
   * inventory_items 與 custom_report_products 都有 sku／name／category，一起 join 回來的
   * 欄位會對映錯位（loadWarehouse 的註解記過同一個坑）。
   */
  const componentItemIds = [...new Set(componentRows.map((row) => row.inventoryItemId).filter((id): id is string => !!id))];
  const componentCustomIds = [...new Set(componentRows.map((row) => row.customProductId).filter((id): id is string => !!id))];
  const componentItems = await inBatches(componentItemIds, (batch) => db
    .select({ id: inventoryItems.id, sku: inventoryItems.sku, name: inventoryItems.name, category: inventoryItems.category })
    .from(inventoryItems)
    .where(inArray(inventoryItems.id, batch)));
  const componentCustoms = await inBatches(componentCustomIds, (batch) => db
    .select({
      id: customReportProducts.id,
      sku: customReportProducts.sku,
      name: customReportProducts.name,
      category: customReportProducts.category,
    })
    .from(customReportProducts)
    .where(inArray(customReportProducts.id, batch)));
  const componentCatalogSkus = [...new Set(componentRows.map((row) => row.cyberbizSku).filter((sku): sku is string => !!sku))];
  const componentCatalog = await inBatches(componentCatalogSkus, (batch) => db
    .select({
      ...getTableColumns(cyberbizProducts),
      categoryName: reportProductCategories.name,
    })
    .from(cyberbizProducts)
    .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
    .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
    .where(inArray(cyberbizProducts.sku, batch)));
  const itemById = new Map(componentItems.map((row) => [row.id, row]));
  const customById = new Map(componentCustoms.map((row) => [row.id, row]));
  // 官網商品的名稱即時從鏡像讀，不採信任何複本。
  const catalogBySku = new Map(componentCatalog.map((row) => [row.sku, {
    sku: row.sku,
    name: formatCyberbizProductName(row),
    category: row.categoryName ?? "未分類",
  }]));
  for (const component of componentRows) {
    const source = component.cyberbizSku
      ? catalogBySku.get(component.cyberbizSku)
      : component.customProductId
        ? customById.get(component.customProductId)
        : component.inventoryItemId
          ? itemById.get(component.inventoryItemId)
          : undefined;
    if (!source?.sku || !source.name || !source.category) {
      incompleteMappings.add(component.mappingId);
      continue;
    }
    const list = componentsByMapping.get(component.mappingId) ?? [];
    list.push({
      inventoryItemId: component.inventoryItemId,
      sku: source.sku,
      name: source.name,
      category: source.category,
      quantity: component.quantity,
    });
    componentsByMapping.set(component.mappingId, list);
  }

  const resolved = new Map<string, ResolvedProductSku>();
  const resolvedChannels = new Map<string, string>();
  const mappedKeys = new Set(mappings.map((mapping) => normalizeExternalSku(mapping.externalSku)));

  /*
   * 對不到 WMS 也沒有 mapping 時，退回 CYBERBIZ 目錄。
   *
   * 官網有、WMS 沒有的商品（禮盒、贈品、加購）以前會讓整份匯入失敗，得靠人手動 key
   * 一個自訂 SKU 與名稱——十幾個這種 SKU 就擋掉九家店的整個月。CYBERBIZ 是「我們賣
   * 什麼」的真相來源，目錄裡查得到就直接當商品身分用。
   *
   * 排在 directItems 之前寫入，讓 WMS 商品與明確 mapping 都還是贏過它。
   */
  const catalogRows = await inBatches(wanted, (batch) => db
    .select({
      ...getTableColumns(cyberbizProducts),
      categoryName: reportProductCategories.name,
    })
    .from(cyberbizProducts)
    .leftJoin(cyberbizProductCategories, eq(cyberbizProductCategories.sku, cyberbizProducts.sku))
    .leftJoin(reportProductCategories, eq(reportProductCategories.id, cyberbizProductCategories.categoryId))
    .where(inArray(cyberbizProducts.sku, batch)));
  for (const row of catalogRows) {
    if (mappedKeys.has(row.sku)) continue;
    const name = formatCyberbizProductName(row);
    if (!name) continue;
    resolved.set(row.sku, {
      externalName: name,
      components: [{ inventoryItemId: null, sku: row.sku, name, category: row.categoryName ?? "未分類", quantity: 1 }],
    });
  }

  for (const item of directItems) {
    const key = item.sku ? normalizeExternalSku(item.sku) : "";
    // 明確 mapping 優先於「外部 SKU 剛好等於 WMS SKU」的 implicit match。
    if (item.sku && !mappedKeys.has(key)) {
      resolved.set(key, {
        externalName: item.name,
        components: [{ inventoryItemId: item.id, sku: item.sku, name: item.name, category: item.category, quantity: 1 }],
      });
    }
  }
  for (const mapping of mappings) {
    if (incompleteMappings.has(mapping.id)) continue;
    const components = componentsByMapping.get(mapping.id) ?? [];
    if (!components.length) continue;
    const key = normalizeExternalSku(mapping.externalSku);
    const previous = resolved.get(key);
    if (previous && resolvedChannels.get(key) === normalizedChannel && mapping.channel !== normalizedChannel) continue;
    resolved.set(key, { externalName: mapping.externalName, components });
    resolvedChannels.set(key, mapping.channel);
  }
  if (normalizedChannel === "shopee") {
    for (const key of wanted) {
      if (resolved.has(key)) continue;
      const legacyKey = legacyShopeeExternalSku(key);
      const fallback = legacyKey ? resolved.get(legacyKey) : undefined;
      if (fallback) resolved.set(key, fallback);
    }
  }
  return resolved;
}

export interface ReportSkuIgnoreRow {
  id: string;
  channel: string;
  externalSku: string;
  reason: string;
  createdAt: string;
}

/** 目前標記為「不納入報表」的外部 SKU。 */
export async function listReportSkuIgnores(db: Database): Promise<ReportSkuIgnoreRow[]> {
  return db
    .select({
      id: reportSkuIgnores.id,
      channel: reportSkuIgnores.channel,
      externalSku: reportSkuIgnores.externalSku,
      reason: reportSkuIgnores.reason,
      createdAt: reportSkuIgnores.createdAt,
    })
    .from(reportSkuIgnores)
    .orderBy(asc(reportSkuIgnores.channel), asc(reportSkuIgnores.externalSku));
}

export async function addReportSkuIgnore(
  db: Database,
  input: { channel: string; externalSku: string; reason?: string; actor: Actor },
): Promise<ReportSkuIgnoreRow> {
  const channel = normalizeProductSkuChannel(input.channel);
  if (!channel) throw new WmsError("invalid", "通路不可為空。");
  const externalSku = normalizeExternalSku(input.externalSku);
  if (!externalSku) throw new WmsError("invalid", "外部 SKU 不可為空。");
  const reason = (input.reason ?? "").trim();

  const [existing] = await db
    .select({ id: reportSkuIgnores.id })
    .from(reportSkuIgnores)
    .where(and(eq(reportSkuIgnores.channel, channel), eq(reportSkuIgnores.externalSku, externalSku)))
    .limit(1);
  if (existing) throw new WmsError("conflict", `通路「${channel}」的外部 SKU「${externalSku}」已經標記為不納入報表。`);

  const id = crypto.randomUUID();
  await db.batch([
    db.insert(reportSkuIgnores).values({ id, channel, externalSku, reason }),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${channel} · ${externalSku}`,
      eventType: "product_sku_mapping_updated",
      summary: `標記${channel} 外部 SKU「${externalSku}」不納入報表${reason ? `：${reason}` : ""}`,
      field: "externalSku",
      newValue: externalSku,
      actor: input.actor,
      source: "wms",
    })),
  ]);
  // createdAt 由 DB 的 CURRENT_TIMESTAMP 決定；自己組一個 ISO 字串會跟列表回傳的格式不同。
  const [created] = await db
    .select({ createdAt: reportSkuIgnores.createdAt })
    .from(reportSkuIgnores)
    .where(eq(reportSkuIgnores.id, id));
  return { id, channel, externalSku, reason, createdAt: created?.createdAt ?? "" };
}

export async function deleteReportSkuIgnore(db: Database, id: string, actor: Actor): Promise<void> {
  const [row] = await db
    .select({ channel: reportSkuIgnores.channel, externalSku: reportSkuIgnores.externalSku })
    .from(reportSkuIgnores)
    .where(eq(reportSkuIgnores.id, id));
  if (!row) throw new WmsError("not_found", "找不到這筆忽略設定。");

  await db.batch([
    db.delete(reportSkuIgnores).where(eq(reportSkuIgnores.id, id)),
    db.insert(activityEvents).values(activityRow({
      entityType: "product_sku_mapping",
      entityId: id,
      entityLabel: `${row.channel} · ${row.externalSku}`,
      eventType: "product_sku_mapping_updated",
      summary: `取消忽略${row.channel} 外部 SKU「${row.externalSku}」`,
      field: "externalSku",
      oldValue: row.externalSku,
      actor,
      source: "wms",
    })),
  ]);
}

/**
 * 這次匯入要略過的外部 SKU（已標記為不納入報表）。
 *
 * 與 resolveProductSkus 一樣查 [報表通路, "legacy"]，讓還沒標通路的舊設定也生效。
 */
export async function resolveIgnoredSkus(
  db: Database,
  externalSkus: string[],
  channel = "legacy",
): Promise<Set<string>> {
  const normalized = [...new Set(externalSkus.map(normalizeExternalSku).filter(Boolean))];
  if (!normalized.length) return new Set();
  const normalizedChannel = normalizeProductSkuChannel(channel);
  /*
   * 蝦皮的舊格式也要查，與 resolveProductSkus 一致。
   *
   * 以裸商品 ID 記下的忽略設定，擋不住鍵為「商品ID_規格ID」的報表列的話，那個 SKU
   * 會永遠留在提醒清單裡——正好是這個功能要消除的東西。
   */
  const legacyPairs = normalizedChannel === "shopee"
    ? normalized.map((sku) => [sku, legacyShopeeExternalSku(sku)] as const).filter(([, legacy]) => legacy)
    : [];
  const wanted = [...new Set([...normalized, ...legacyPairs.map(([, legacy]) => legacy)])];
  const channels = [...new Set([normalizedChannel, "legacy"])];
  const rows = await inBatches(wanted, (batch) => db
    .select({ externalSku: reportSkuIgnores.externalSku })
    .from(reportSkuIgnores)
    .where(and(
      inArray(reportSkuIgnores.externalSku, batch),
      inArray(reportSkuIgnores.channel, channels),
    )));
  const matched = new Set(rows.map((row) => row.externalSku));
  // 舊格式命中時，把新格式的鍵也標成忽略。
  for (const [sku, legacy] of legacyPairs) {
    if (matched.has(legacy)) matched.add(sku);
  }
  return matched;
}

/**
 * 把官網目錄寫進 D1 鏡像。
 *
 * 只寫進來、不刪：官網下架的商品，歷史報表還指著它的名字。published 標起來就好。
 */
export async function syncCyberbizProducts(
  db: Database,
  items: ReadonlyArray<{
    sku: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName?: string;
    published?: boolean;
  }>,
): Promise<{ synced: number }> {
  const rows = new Map<string, {
    sku: string;
    productId: string;
    variantId: string;
    productName: string;
    variantName: string;
    published: number;
  }>();
  for (const item of items) {
    const sku = normalizeExternalSku(item.sku ?? "");
    if (!sku) continue;
    rows.set(sku, {
      sku,
      productId: String(item.productId ?? ""),
      variantId: String(item.variantId ?? ""),
      productName: (item.productName ?? "").trim(),
      variantName: (item.variantName ?? "").trim(),
      published: item.published === false ? 0 : 1,
    });
  }
  const values = [...rows.values()];
  if (!values.length) return { synced: 0 };

  /*
   * D1 單支語句的參數有上限，分批寫。
   *
   * 不能沿用 SKU_LOOKUP_BATCH_SIZE：那個是給「一個值一個參數」的 IN 查詢用的，這裡
   * 每一列綁 6 個欄位，50 列就是 300 個參數，D1 會直接拒絕（本機 node:sqlite 允許
   * 32k 個參數，測不出來）。
   */
  const INSERT_BATCH_SIZE = 16;
  for (let offset = 0; offset < values.length; offset += INSERT_BATCH_SIZE) {
    const batch = values.slice(offset, offset + INSERT_BATCH_SIZE);
    await db.insert(cyberbizProducts).values(batch).onConflictDoUpdate({
      target: cyberbizProducts.sku,
      set: {
        productId: sql`excluded.product_id`,
        variantId: sql`excluded.variant_id`,
        productName: sql`excluded.product_name`,
        variantName: sql`excluded.variant_name`,
        published: sql`excluded.published`,
        syncedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
  }

  // CYBERBIZ 商品先建立平台品項主檔，再建立延伸資料；不因同步而自動納入倉儲。
  for (const row of values) {
    const name = [row.productName, row.variantName].filter(Boolean).join(" - ") || row.sku;
    const [existing] = await db.select({ id: itemMasters.id }).from(itemMasters)
      .where(and(eq(itemMasters.source, "cyberbiz"), eq(itemMasters.sku, row.sku))).limit(1);
    const itemId = existing?.id ?? crypto.randomUUID();
    await db.insert(itemMasters).values({ id: itemId, source: "cyberbiz", kind: "sellable", sku: row.sku, name, active: 1 })
      .onConflictDoUpdate({ target: [itemMasters.source, itemMasters.sku], set: { name, active: 1, updatedAt: sql`CURRENT_TIMESTAMP` } });
    await db.insert(targetCyberbizProducts).values({
      itemId, cyberbizProductId: row.productId, cyberbizVariantId: row.variantId,
      productName: row.productName, variantName: row.variantName, published: row.published,
      rawJson: "{}", syncStatus: "synced", syncedAt: sql`CURRENT_TIMESTAMP`,
    }).onConflictDoUpdate({ target: targetCyberbizProducts.itemId, set: {
      cyberbizProductId: row.productId, cyberbizVariantId: row.variantId,
      productName: row.productName, variantName: row.variantName, published: row.published,
      syncStatus: "synced", syncedAt: sql`CURRENT_TIMESTAMP`,
    } });
  }
  return { synced: values.length };
}

export interface CyberbizProductOption {
  sku: string;
  name: string;
  published: boolean;
}

export interface CyberbizReportProductOption extends CyberbizProductOption {
  /** 既有通路 mapping 保存的歷史商品名稱，供舊版報表反查 SKU。 */
  aliases: string[];
}

/** 供 SKU 對應頁挑用料；下架的也列出來，舊對應才編輯得動。 */
export async function listCyberbizProducts(db: Database): Promise<CyberbizProductOption[]> {
  const rows = await db
    .select()
    .from(cyberbizProducts)
    .orderBy(asc(cyberbizProducts.productName), asc(cyberbizProducts.sku));
  return rows.map((row) => ({
    sku: row.sku,
    name: formatCyberbizProductName(row),
    published: row.published === 1,
  }));
}

/**
 * 報表匯入用的 CYBERBIZ 商品清單。
 *
 * 舊版商品銷售檔沒有 SKU，只留下匯出當下的商品名稱；這個名稱可能和目前
 * CYBERBIZ 目錄的名稱不同，但既有的通路 mapping 會保留那個歷史名稱，應該
 * 一起提供給瀏覽器做反查。沒有目錄鏡像、但已有有效 mapping 的歷史 SKU 也
 * 保留，讓舊檔不必退回逐列手動輸入。
 */
export async function listCyberbizReportProducts(db: Database): Promise<CyberbizReportProductOption[]> {
  const [catalog, mappings] = await Promise.all([
    listCyberbizProducts(db),
    db
      .select({ sku: productSkuMappings.externalSku, name: productSkuMappings.externalName })
      .from(productSkuMappings)
      .where(inArray(productSkuMappings.channel, ["cyberbiz", "legacy"])),
  ]);

  const products = new Map<string, CyberbizReportProductOption>(catalog.map((product) => [
    normalizeExternalSku(product.sku),
    { ...product, sku: normalizeExternalSku(product.sku), aliases: [] },
  ]));
  for (const mapping of mappings) {
    const sku = normalizeExternalSku(mapping.sku);
    const name = mapping.name.trim();
    if (!sku || !name) continue;
    const product = products.get(sku);
    if (product) {
      if (product.name !== name && !product.aliases.includes(name)) product.aliases.push(name);
      continue;
    }
    products.set(sku, { sku, name, published: false, aliases: [] });
  }

  return [...products.values()].sort((left, right) => (
    left.name.localeCompare(right.name, "zh-TW") || left.sku.localeCompare(right.sku, "en")
  ));
}
