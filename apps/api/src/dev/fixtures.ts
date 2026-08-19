import { createDatabase, seedPayoutStores, syncSystemRoles } from "@rueisiang/db";
import { customers, userRoles, users } from "@rueisiang/db/schema";
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
  await seedPayoutStores(db);
  await seedDevCustomers(db);

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
