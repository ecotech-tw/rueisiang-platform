import { createDatabase, ensureAssistantDefaults, seedPayoutStores, syncSystemRoles } from "@rueisiang/db";
import { ASSISTANT_KEY, DEFAULT_ASSISTANT_PROMPT, OPEN_METEO_TOOL_KEY } from "@rueisiang/assistant";
import {
  customers,
  inventoryItems,
  layoutElements,
  productCategories,
  userRoles,
  users,
  warehouseSettings,
  zones,
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
  { name: "陳美玲", phone: "0922 333 444", email: "chen@example.com", address: "新北市板橋區文化路一段 25 號", channel: "manual", tags: [], status: "active", sync: "local_only" },
  { name: "林大同", phone: "0933 555 666", email: "lin@example.com", address: "台中市西屯區台灣大道三段 99 號", channel: "cyberbiz", tags: ["批發"], status: "active", sync: "failed" },
  { name: "", phone: "0944 777 888", email: "", address: "", channel: "cyberbiz", tags: [], status: "active", sync: "synced" },
  { name: "黃美華", phone: "0955 999 000", email: "huang@example.com", address: "高雄市前鎮區中山二路 5 號", channel: "manual", tags: ["需追蹤"], status: "blocked", sync: "local_only" },
] as const;

export async function seedDevData(d1: LocalD1): Promise<void> {
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);
  await ensureAssistantDefaults(db, {
    assistantKey: ASSISTANT_KEY,
    defaultPrompt: DEFAULT_ASSISTANT_PROMPT,
    toolKeys: [OPEN_METEO_TOOL_KEY],
  });
  await seedPayoutStores(db);
  await seedDevCustomers(db);
  await seedDevWarehouse(db);

  const existing = await db.select({ id: users.id }).from(users).limit(1);
  if (existing.length) return;

  for (const account of DEV_ACCOUNTS) {
    const id = `dev-${account.email}`;
    await db.insert(users).values({
      id,
      email: account.email,
      name: account.name,
      status: account.email === "left@ecotech.tw" ? "disabled" : "active",
      lastLoginAt: "2026-08-17 09:12:44",
    });
    if (account.role) await db.insert(userRoles).values({ userId: id, roleId: account.role });
  }
}

/** 與帳號分開判斷，這樣舊的 local.sqlite 也會補上客戶資料。 */
async function seedDevCustomers(db: ReturnType<typeof createDatabase>): Promise<void> {
  const existing = await db.select({ id: customers.id }).from(customers).limit(1);
  if (existing.length) return;

  let index = 0;
  for (const customer of DEV_CUSTOMERS) {
    index += 1;
    await db.insert(customers).values({
      id: `dev-customer-${index}`,
      phone: customer.phone,
      normalizedPhone: customer.phone.replace(/\D/g, ""),
      name: customer.name,
      email: customer.email,
      address: customer.address,
      sourceChannel: customer.channel,
      status: customer.status,
      cyberbizTagsJson: JSON.stringify(customer.tags),
      cyberbizCustomerId: customer.channel === "cyberbiz" ? `cb-${index}` : null,
      syncStatus: customer.sync,
      syncError: customer.sync === "failed" ? "CYBERBIZ 回 429，稍後重試" : null,
      blockedAt: customer.status === "blocked" ? "2026-08-01 09:00:00" : null,
    });
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
  const existing = await db.select({ id: zones.id }).from(zones).limit(1);
  if (existing.length) return;

  await db.insert(warehouseSettings).values({ id: "main", canvasWidth: 1600, canvasHeight: 900 });
  await db.insert(productCategories).values([...DEV_CATEGORIES]);
  await db.insert(zones).values([...DEV_ZONES]);
  await db.insert(layoutElements).values([
    { id: "dev-el-1", label: "出貨口", color: "rose", x: 66, y: 10, width: 14, height: 12 },
    { id: "dev-el-2", label: "走道", color: "slate", x: 8, y: 34, width: 52, height: 8 },
  ]);
  await db.insert(inventoryItems).values([...DEV_ITEMS]);
}
