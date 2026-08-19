import type { Permission } from "./permissions.js";

/**
 * 「全域範圍」的哨兵值，與 packages/db 的 GLOBAL_SCOPE 一致。
 * 目前每一筆角色指派都是全域，這個值存在是為了讓資料表的欄位有明確的預設。
 */
export const GLOBAL_SCOPE = "";

export interface RoleAssignment {
  roleKey: string;
  permissions: readonly Permission[];
}

export type UserStatus = "invited" | "active" | "disabled";

export interface AuthUser {
  id: string;
  email: string;
  /** 實際要顯示的名字：使用者自己設的顯示名稱優先，沒設才是 Google 上的姓名。 */
  name: string;
  /** Google 帳號上的姓名，每次登入覆寫。個人資料頁要拿它跟顯示名稱對照。 */
  googleName: string;
  pictureUrl: string;
  status: UserStatus;
  assignments: readonly RoleAssignment[];
  /**
   * 繞過角色、直接授予這個人的權限。跟角色帶來的取聯集，只加不減。
   * 見 packages/db 的 user_permissions 表頭註解。
   */
  directPermissions: readonly Permission[];
}

/**
 * 只有 active 的帳號有權限。invited（還沒登入過）與 disabled（停權）一律為零。
 *
 * 直接授予的權限也走同一道閘門——停權要能一次關掉這個人的所有權限，
 * 漏掉這裡的話「停用」就會變成只擋角色、擋不住例外授權。
 */
function usableAssignments(user: AuthUser): readonly RoleAssignment[] {
  return user.status === "active" ? user.assignments : [];
}

function usableDirect(user: AuthUser): readonly Permission[] {
  return user.status === "active" ? user.directPermissions : [];
}

/**
 * 這個人有沒有這項權限。
 *
 * 這裡刻意沒有「資料範圍」的參數。原本的設計是角色可以綁在某個店別或倉庫上，
 * 但兩套舊系統的資料都沒有那樣切——CRM 的 customers 沒有店別欄位，WMS 只有
 * 一個倉庫一張地圖。範圍過濾沒有東西可以過濾，留著只會讓 UI 問一個沒有正確
 * 答案的問題，還看起來像是一道實際上不存在的防線。
 *
 * 哪天真的有模組需要（例如專櫃同仁只該看到自己店的客戶），那時的作法是：
 * 先給該資料表加上店別欄位、把過濾接進那條查詢，最後才在 UI 開放那一種範圍。
 * user_roles 的 scope_type / scope_id 欄位仍然留著，不必再開一次 migration。
 */
export function can(user: AuthUser, permission: Permission): boolean {
  if (usableDirect(user).includes(permission)) return true;
  return usableAssignments(user).some((assignment) => assignment.permissions.includes(permission));
}

/** 這個人擁有的所有權限。給前端決定顯示什麼用。 */
export function permissionsOf(user: AuthUser): Permission[] {
  const all = new Set<Permission>(usableDirect(user));
  for (const assignment of usableAssignments(user)) {
    for (const permission of assignment.permissions) all.add(permission);
  }
  return [...all];
}
