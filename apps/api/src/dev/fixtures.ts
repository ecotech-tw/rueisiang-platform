import { eq } from "drizzle-orm";
import {
  createDatabase,
  ensureAssistantDefaults,
  insertReportPayoutDaily,
  insertReportSalesMonthly,
  seedPayoutStores,
  syncSystemRoles,
  upsertReportScope,
} from "@rueisiang/db";
import { ASSISTANT_KEY, DEFAULT_ASSISTANT_PROMPT, OPEN_METEO_TOOL_KEY } from "@rueisiang/assistant";
import { DEFAULT_PI_CODEX_MODEL } from "../pi-agent.js";
import {
  crmCustomers,
  crmCustomerTags,
  crmTags,
  scopes,
  itemCategories,
  items as itemMasters,
  cyberbizProductCatalog,
  userRoles,
  users,
  wmsCategories,
  wmsItems,
  wmsLayoutElements,
  wmsLayouts,
  wmsShelves,
  wmsZones,
} from "@rueisiang/db/schema";
import type { LocalD1 } from "../local-d1/d1.js";

/**
 * 本機開發用的假資料。只在資料表是空的時候塞一次，之後你在畫面上做的改動會留著。
 *
 * 刻意涵蓋每一種狀態：不同角色、沒有角色、還沒登入過、被停用的，
 * 這樣光看畫面就能檢查各種情況長什麼樣，不用自己一個一個建。
 */
export const DEV_ACCOUNTS = [
  { email: "eli-lin@ecotech.tw", name: "林瑞翔", role: "role-admin", note: "管理者，什麼都看得到" },
  { email: "wang@ecotech.tw", name: "王小明", role: "role-manager", note: "主管" },
  { email: "chen@ecotech.tw", name: "陳美玲", role: "role-staff", note: "一般同仁" },
  { email: "lin@ecotech.tw", name: "林檢視", role: "role-viewer", note: "檢視者，只有唯讀權限" },
  { email: "none@ecotech.tw", name: "沒有角色", role: null, note: "登得進來但看不到任何項目" },
  { email: "left@ecotech.tw", name: "李離職", role: "role-viewer", note: "已停用，會被擋在門外" },
] as const;

/**
 * 假客戶。涵蓋兩種來源、封鎖與未封鎖、有標籤與沒標籤、資料完整與不完整，
 * 這樣列表的每一種呈現都有東西可看。
 */
const DEV_CUSTOMERS = [
  { name: "王小明", phone: "0912 345 678", email: "wang@example.com", address: "台北市大安區忠孝東路四段 1 號", channel: "cyberbiz", tags: ["VIP", "熟客"], status: "active", sync: "synced" },
  { name: "陳美玲", phone: "0922 333 444", email: "chen@example.com", address: "新北市板橋區文化路一段 25 號", channel: "manual", tags: [], status: "active", sync: "synced" },
  { name: "林大同", phone: "0933 555 666", email: "lin@example.com", address: "台中市西屯區台灣大道三段 99 號", channel: "cyberbiz", tags: ["批發"], status: "active", sync: "failed" },
  { name: "", phone: "0944 777 888", email: "", address: "", channel: "cyberbiz", tags: [], status: "active", sync: "synced" },
  { name: "黃美華", phone: "0955 999 000", email: "huang@example.com", address: "高雄市前鎮區中山二路 5 號", channel: "manual", tags: ["需追蹤"], status: "blocked", sync: "synced" },
] as const;

export async function seedDevData(d1: LocalD1): Promise<void> {
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await ensureAssistantDefaults(db, {
    assistantKey: ASSISTANT_KEY,
    defaultModel: DEFAULT_PI_CODEX_MODEL,
    defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
    toolKeys: [OPEN_METEO_TOOL_KEY],
  });
  await seedPayoutStores(db);
  await seedDevAnalytics(db);
  await seedDevCustomers(db);
  await seedDevWarehouse(db);

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return;

  for (const account of DEV_ACCOUNTS) {
    const id = `dev-${account.email}`;
    await db.insert(users).values({
      id,
      email: account.email,
      googleName: account.name,
      status: account.email === "left@ecotech.tw" ? "disabled" : "active",
      lastLoginAt: "2026-08-17 09:12:44",
    });
    if (account.role) await db.insert(userRoles).values({ userId: id, roleId: account.role });
  }
}

const DEV_ANALYTICS_SCOPES = [
  { id: "cyberbiz:store:demo-ximen", scopeKind: "store" as const, name: "示範西門店" },
  { id: "cyberbiz:store:demo-xinyi", scopeKind: "store" as const, name: "示範信義店" },
  { id: "cyberbiz:store:demo-paused", scopeKind: "store" as const, name: "示範已歇業店", active: false },
] as const;
const DEV_SHOPEE_SCOPE = { id: "shopee:store:demo-marketplace", scopeKind: "store" as const, name: "蝦皮示範賣場" };

const DEV_AUGUST_MISSING_DAYS = [4, 11, 18, 24] as const;
const DEV_AUGUST_XIMEN = [
  13_800, 16_400, 15_200, null, 18_100, 20_500, 22_900, 19_600, 21_800, 24_700, null,
  27_300, 23_500, 26_400, 30_100, 28_700, 25_300, null, 31_900, 28_600, 34_100, 30_500,
  36_600, null, 33_200, 39_500, 37_800, 35_200, 42_000, 44_600, 48_000,
] as const;
const DEV_AUGUST_XINYI = [
  9_200, 11_800, 10_200, null, 13_400, 15_100, 16_800, 14_300, 15_700, 17_900, null,
  19_600, 17_400, 18_900, 21_500, 20_500, 18_300, null, 22_600, 20_200, 24_300, 21_800,
  25_600, null, 23_400, 27_800, 26_500, 24_900, 29_500, 31_200, 33_800,
] as const;

function trendValues(base: number, step: number, missingDays: readonly number[] = []): Array<number | null> {
  return Array.from({ length: 31 }, (_, index) => {
    const day = index + 1;
    if (missingDays.includes(day)) return null;
    const cycle = [0, 900, -400, 600, 1_200][index % 5] ?? 0;
    return Math.round((base + step * index + cycle) / 100) * 100;
  });
}

function payoutRowsForMonth(scopeId: string, month: string, values: readonly (number | null)[]) {
  return values.flatMap((amount, index) => amount === null ? [] : [{
    scopeId,
    businessDate: `${month}-${String(index + 1).padStart(2, "0")}`,
    payoutAmount: amount,
  }]);
}

const DEV_ANNUAL_PAYOUTS = [
  ["2026-01", 172_000, 118_000],
  ["2026-02", 188_000, 131_000],
  ["2026-03", 214_000, 146_000],
  ["2026-04", 231_000, 155_000],
  ["2026-05", 248_000, 169_000],
  ["2026-06", 263_000, 181_000],
  ["2025-01", 141_000, 98_000],
  ["2025-02", 152_000, 104_000],
  ["2025-03", 166_000, 112_000],
  ["2025-04", 179_000, 121_000],
  ["2025-05", 193_000, 129_000],
  ["2025-06", 205_000, 138_000],
  ["2025-07", 218_000, 147_000],
] as const;

function buildDevPayoutRows() {
  const rows = [
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[0].id, "2026-08", DEV_AUGUST_XIMEN),
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[1].id, "2026-08", DEV_AUGUST_XINYI),
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[0].id, "2026-07", trendValues(11_200, 320)),
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[1].id, "2026-07", trendValues(7_600, 240, [7, 21])),
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[0].id, "2025-08", trendValues(9_800, 240, DEV_AUGUST_MISSING_DAYS)),
    ...payoutRowsForMonth(DEV_ANALYTICS_SCOPES[1].id, "2025-08", trendValues(6_600, 170, DEV_AUGUST_MISSING_DAYS)),
  ];
  for (const [month, ximen, xinyi] of DEV_ANNUAL_PAYOUTS) {
    rows.push(
      { scopeId: DEV_ANALYTICS_SCOPES[0].id, businessDate: `${month}-01`, payoutAmount: ximen },
      { scopeId: DEV_ANALYTICS_SCOPES[1].id, businessDate: `${month}-01`, payoutAmount: xinyi },
    );
  }
  return rows;
}

const DEV_SALES_PRODUCTS = [
  { sku: "DEMO-THERMO", productName: "雲朵保溫杯", category: "生活用品", grossQuantity: 86, salesAmount: 51_600 },
  { sku: "DEMO-TOTE", productName: "城市帆布袋", category: "生活用品", grossQuantity: 74, salesAmount: 37_000 },
  { sku: "DEMO-CANDLE", productName: "暮光香氛蠟燭", category: "香氛", grossQuantity: 62, salesAmount: 43_400 },
  { sku: "DEMO-TEA", productName: "山嵐茶包禮盒", category: "食品", grossQuantity: 58, salesAmount: 40_600 },
  { sku: "DEMO-SOAP", productName: "植萃沐浴皂", category: "保養", grossQuantity: 53, salesAmount: 23_850 },
  { sku: "DEMO-MUG", productName: "晨光馬克杯", category: "生活用品", grossQuantity: 48, salesAmount: 26_400 },
  { sku: "DEMO-PEN", productName: "霧面簽字筆組", category: "文具", grossQuantity: 45, salesAmount: 13_500 },
  { sku: "DEMO-POUCH", productName: "旅行收納包", category: "生活用品", grossQuantity: 41, salesAmount: 20_500 },
  { sku: "DEMO-SCARF", productName: "薄霧披肩", category: "服飾", grossQuantity: 36, salesAmount: 28_800 },
  { sku: "DEMO-TRAY", productName: "橡木托盤", category: "居家", grossQuantity: 31, salesAmount: 24_800 },
  { sku: "DEMO-MIST", productName: "森林衣物噴霧", category: "香氛", grossQuantity: 28, salesAmount: 16_800 },
  { sku: "DEMO-CARD", productName: "城市明信片組", category: "文具", grossQuantity: 24, salesAmount: 4_800 },
] as const;

function salesRowsForMonth(scopeId: string, reportMonth: string, factor: number) {
  return DEV_SALES_PRODUCTS.map((product, index) => {
    const grossQuantity = Math.max(1, Math.round(product.grossQuantity * factor + (index % 3) * factor));
    const returnQuantity = index % 4 === 0 ? Math.max(1, Math.round(grossQuantity * 0.08)) : index % 5 === 0 ? 1 : 0;
    return {
      scopeId,
      reportMonth,
      sku: product.sku,
      productName: product.productName,
      category: product.category,
      grossQuantity,
      returnQuantity,
      netQuantity: grossQuantity - returnQuantity,
      salesAmount: Math.round((product.salesAmount * factor) / 100) * 100,
    };
  });
}

const DEV_SALES_PERIODS = [
  ["2026-08", 1.24, 0], ["2026-07", 1.08, 1], ["2025-08", 0.92, 0],
  ["2026-01", 0.82, 1], ["2026-02", 0.88, 1], ["2026-03", 0.94, 1],
  ["2026-04", 1.00, 1], ["2026-05", 1.05, 1], ["2026-06", 1.10, 1],
  ["2025-01", 0.68, 1], ["2025-02", 0.72, 1], ["2025-03", 0.77, 1],
  ["2025-04", 0.81, 1], ["2025-05", 0.86, 1], ["2025-06", 0.89, 1], ["2025-07", 0.91, 1],
] as const;

const DEV_SKU_CATEGORIES: Record<string, string> = {
  "DEMO-THERMO": "生活選物",
  "DEMO-TOTE": "生活選物",
  "DEMO-CANDLE": "香氛品味",
  "DEMO-TEA": "風味嚴選",
  "DEMO-SOAP": "沐浴清潔",
  "DEMO-MUG": "生活選物",
  "DEMO-PEN": "文具小物",
  "DEMO-POUCH": "居家日用",
  "DEMO-SCARF": "服飾配件",
  "DEMO-TRAY": "居家日用",
  "DEMO-MIST": "香氛品味",
  "DEMO-CARD": "文具小物",
};

function buildDevSalesRows() {
  return DEV_SALES_PERIODS.flatMap(([month, ximenFactor, xinyiOffset]) => [
    ...salesRowsForMonth(DEV_ANALYTICS_SCOPES[0].id, month, ximenFactor),
    ...salesRowsForMonth(DEV_ANALYTICS_SCOPES[1].id, month, ximenFactor * (xinyiOffset ? 0.72 : 0.78)),
  ]);
}

const DEV_PRODUCT_CATEGORIES = [
  { id: "dev-product-category-life", name: "生活選物", color: "rose" },
  { id: "dev-product-category-fragrance", name: "香氛品味", color: "violet" },
  { id: "dev-product-category-flavor", name: "風味嚴選", color: "amber" },
  { id: "dev-product-category-bath", name: "沐浴清潔", color: "sky" },
  { id: "dev-product-category-stationery", name: "文具小物", color: "teal" },
  { id: "dev-product-category-home", name: "居家日用", color: "mint" },
  { id: "dev-product-category-apparel", name: "服飾配件", color: "peach" },
] as const;

async function seedDevProductCatalog(db: ReturnType<typeof createDatabase>): Promise<void> {
  // 開發資料也走 target schema，否則 compat view 一旦移除，啟動就會重新長出 legacy 依賴。
  await db.insert(itemCategories).values(DEV_PRODUCT_CATEGORIES.map((category) => ({
    id: category.id,
    name: category.name,
    color: category.color,
    depth: 0,
    parentId: null,
    parentDepth: null,
    sortOrder: 0,
    active: 1,
  }))).onConflictDoNothing();

  const existingItems = await db.select({ id: itemMasters.id, sku: itemMasters.sku }).from(itemMasters);
  const itemIdBySku = new Map(existingItems.map((row) => [row.sku, row.id]));
  for (const product of DEV_SALES_PRODUCTS) {
    const itemId = itemIdBySku.get(product.sku) ?? `cb:${product.sku}`;
    if (!itemIdBySku.has(product.sku)) {
      await db.insert(itemMasters).values({
        id: itemId,
        source: "cyberbiz",
        kind: "sellable",
        sku: product.sku,
        name: product.productName,
        active: 1,
      }).onConflictDoNothing();
      itemIdBySku.set(product.sku, itemId);
    }
    await db.insert(cyberbizProductCatalog).values({
      itemId,
      cyberbizProductId: `dev-product-${product.sku}`,
      cyberbizVariantId: `dev-variant-${product.sku}`,
      productName: product.productName,
      variantName: "",
      published: 1,
      rawJson: "{}",
      syncStatus: "synced",
    }).onConflictDoNothing();
  }

  const categoryRows = await db.select({ id: itemCategories.id, name: itemCategories.name }).from(itemCategories);
  const categoryIdByName = new Map(categoryRows.map((category) => [category.name, category.id]));
  for (const [sku, categoryName] of Object.entries(DEV_SKU_CATEGORIES)) {
    const itemId = itemIdBySku.get(sku);
    const categoryId = categoryIdByName.get(categoryName);
    if (itemId && categoryId) {
      await db.update(itemMasters).set({ categoryId }).where(eq(itemMasters.id, itemId));
    }
  }
}

async function seedDevAnalytics(db: ReturnType<typeof createDatabase>): Promise<void> {
  await seedDevProductCatalog(db);
  const [existingCyberbiz] = await db.select({ id: scopes.id }).from(scopes)
    .where(eq(scopes.id, DEV_ANALYTICS_SCOPES[0].id)).limit(1);

  if (!existingCyberbiz) {
    for (const scope of DEV_ANALYTICS_SCOPES) await upsertReportScope(db, scope);
    await insertReportPayoutDaily(db, buildDevPayoutRows());
    await insertReportSalesMonthly(db, buildDevSalesRows());
  }

  // 舊的 local.sqlite 已經有 CYBERBIZ 假資料時，也要補進蝦皮，才能在公司視角
  // 看見跨通路比較；不重灌原有資料，保留開發者在畫面上的修改。
  const [existingShopee] = await db.select({ id: scopes.id }).from(scopes)
    .where(eq(scopes.id, DEV_SHOPEE_SCOPE.id)).limit(1);
  if (!existingShopee) {
    await upsertReportScope(db, DEV_SHOPEE_SCOPE);
    await insertReportSalesMonthly(db, DEV_SALES_PERIODS.flatMap(([month, factor]) => (
      salesRowsForMonth(DEV_SHOPEE_SCOPE.id, month, factor * 0.56)
    )));
  }

}

/** 與帳號分開判斷，這樣舊的 local.sqlite 也會補上客戶資料。 */
async function seedDevCustomers(db: ReturnType<typeof createDatabase>): Promise<void> {
  const existing = await db.select({ id: crmCustomers.id }).from(crmCustomers).limit(1);
  if (existing.length) return;

  let index = 0;
  for (const customer of DEV_CUSTOMERS) {
    index += 1;
    await db.insert(crmCustomers).values({
      id: `dev-customer-${index}`,
      phone: customer.phone,
      normalizedPhone: customer.phone.replace(/\D/g, ""),
      name: customer.name,
      email: customer.email,
      address: customer.address,
      status: customer.status,
      cyberbizCustomerId: customer.channel === "cyberbiz" ? `cb-${index}` : null,
      syncStatus: customer.sync,
      blockedAt: customer.status === "blocked" ? "2026-08-01 09:00:00" : null,
    });
    for (const tagName of customer.tags) {
      const tagId = `dev-tag-${tagName}`;
      await db.insert(crmTags).values({ id: tagId, name: tagName }).onConflictDoNothing();
      await db.insert(crmCustomerTags).values({ customerId: `dev-customer-${index}`, crmTagId: tagId }).onConflictDoNothing();
    }
  }
}

/**
 * 假倉庫。跟客戶一樣分開判斷，舊的 local.sqlite 才會補上。
 *
 * 涵蓋的狀態：有東西與空的倉位、有層與沒指定層的商品、低於安全庫存的、
 * 沒有 SKU 的、沒放進任何倉位的。地圖與庫存兩頁的每一種呈現都有東西可看。
 */
const DEV_ZONES = [
  { id: "dev-zone-a", code: "A-01", name: "備品區", category: "一般備品", color: "mint", x: 8, y: 10, width: 24, height: 20 },
  { id: "dev-zone-b", code: "B-01", name: "包材區", category: "包材", color: "sky", x: 40, y: 10, width: 20, height: 18 },
  { id: "dev-zone-c", code: "C-01", name: "待整理", category: "一般備品", color: "amber", x: 8, y: 45, width: 18, height: 16 },
] as const;

const DEV_CATEGORIES = [
  { id: "dev-cat-1", name: "一般備品", color: "rose" },
  { id: "dev-cat-2", name: "包材", color: "sky" },
  { id: "dev-cat-3", name: "耗材", color: "amber" },
] as const;

const DEV_ITEMS = [
  { id: "dev-item-1", sku: "BOX-M", name: "中型紙箱", category: "包材", quantity: 120, unit: "個", minStock: 50, zoneId: "dev-zone-b", shelfLevel: "top" },
  { id: "dev-item-2", sku: "BOX-L", name: "大型紙箱", category: "包材", quantity: 12, unit: "個", minStock: 30, zoneId: "dev-zone-b", shelfLevel: "middle" },
  { id: "dev-item-3", sku: "TAPE-01", name: "封箱膠帶", category: "耗材", quantity: 48, unit: "捲", minStock: 20, zoneId: "dev-zone-a", shelfLevel: "bottom" },
  { id: "dev-item-4", sku: null, name: "緩衝氣泡紙", category: "包材", quantity: 3, unit: "卷", minStock: 10, zoneId: "dev-zone-a", shelfLevel: null },
  { id: "dev-item-5", sku: "GLOVE-M", name: "工作手套", category: "耗材", quantity: 60, unit: "雙", minStock: 20, zoneId: null, shelfLevel: null },
] as const;

async function seedDevWarehouse(db: ReturnType<typeof createDatabase>): Promise<void> {
  const existing = await db.select({ id: wmsZones.id }).from(wmsZones).limit(1);
  if (existing.length) return;

  const categoryIdByName = new Map(DEV_CATEGORIES.map((category) => [category.name, category.id]));
  await db.insert(wmsCategories).values(DEV_CATEGORIES.map((category) => ({
    id: category.id,
    name: category.name,
    color: category.color,
    active: 1,
  }))).onConflictDoNothing();
  await db.insert(wmsLayouts).values({ id: "layout:main", name: "主倉庫", canvasWidth: 1600, canvasHeight: 900, active: 1 }).onConflictDoNothing();
  await db.insert(wmsZones).values(DEV_ZONES.map((zone) => ({
    id: zone.id,
    code: zone.code,
    name: zone.name,
    color: zone.color,
    notes: "",
    active: 1,
  }))).onConflictDoNothing();

  const shelfIdByZoneAndCode = new Map<string, string>();
  for (const zone of DEV_ZONES) {
    for (const [index, shelf] of [
      { code: "top", name: "上層" },
      { code: "middle", name: "中層" },
      { code: "bottom", name: "底層" },
    ].entries()) {
      const id = `dev-shelf-${zone.id}-${shelf.code}`;
      shelfIdByZoneAndCode.set(`${zone.id}:${shelf.code}`, id);
      await db.insert(wmsShelves).values({ id, zoneId: zone.id, code: shelf.code, name: shelf.name, sortOrder: index, active: 1 }).onConflictDoNothing();
    }
  }
  await db.insert(wmsLayoutElements).values([
    ...DEV_ZONES.map((zone) => ({
      id: `wms-zone:${zone.id}`,
      layoutId: "layout:main",
      elementType: "zone" as const,
      zoneId: zone.id,
      label: zone.name,
      color: zone.color,
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: zone.height,
      zIndex: 0,
    })),
    { id: "dev-el-1", layoutId: "layout:main", elementType: "decoration" as const, zoneId: null, label: "出貨口", color: "rose", x: 66, y: 10, width: 14, height: 12, zIndex: 1 },
    { id: "dev-el-2", layoutId: "layout:main", elementType: "decoration" as const, zoneId: null, label: "走道", color: "slate", x: 8, y: 34, width: 52, height: 8, zIndex: 1 },
  ]).onConflictDoNothing();
  await db.insert(itemMasters).values(DEV_ITEMS.map((item) => ({
    id: item.id,
    source: "custom" as const,
    kind: item.sku ? "sellable" as const : "supply" as const,
    sku: item.sku ?? `WMS-${item.id.slice(-8).toUpperCase()}`,
    name: item.name,
    active: 1,
  }))).onConflictDoNothing();
  await db.insert(wmsItems).values(DEV_ITEMS.map((item) => ({
    itemId: item.id,
    wmsCategoryId: categoryIdByName.get(item.category) ?? null,
    shelfId: item.zoneId && item.shelfLevel ? shelfIdByZoneAndCode.get(`${item.zoneId}:${item.shelfLevel}`) ?? null : null,
    quantity: item.quantity,
    unit: item.unit,
    minStock: item.minStock,
    notes: "",
  }))).onConflictDoNothing();
}
