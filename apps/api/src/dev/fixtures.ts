import { createDatabase, syncSystemRoles } from "@rueisiang/db";
import { userRoles, users } from "@rueisiang/db/schema";
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

export async function seedDevData(d1: LocalD1): Promise<void> {
  const db = createDatabase(d1 as never);
  await syncSystemRoles(db);

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
