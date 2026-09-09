import {
  PERMISSIONS,
  hashInviteToken,
  hashPassword,
  inviteExpiryFrom,
  newInviteToken,
  verifyPassword,
  type Permission,
  type UserStatus,
} from "@rueisiang/auth";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { hrEmployees } from "./schema/hr-people.js";
import { rolePermissionGrants, roles, userPermissionGrants, userRoleAssignments, users } from "./schema/auth.js";

/**
 * 權限管理頁用到的查詢。與 users.ts 分開：那邊是每次請求都會跑的授權讀取路徑，
 * 這裡是管理者偶爾才用的維護操作，兩者的效能考量與呼叫頻率完全不同。
 */

export interface AssignmentRow {
  roleKey: string;
  roleName: string;
}

export interface AdminUserRow {
  id: string;
  email: string;
  name: string;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
  assignments: AssignmentRow[];
}

export interface RoleRow {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: Permission[];
}

/** 帳號列表。先撈人再撈指派，於記憶體收攏——內部系統 10–50 人，兩次查詢就夠。 */
export async function listUsers(db: Database): Promise<AdminUserRow[]> {
  const rows = await db
    .select({
      id: users.id,
      email: users.email,
      /*
       * 兩個名字都要撈。users.googleName 是 Google 帳號上的姓名，只有 Google 登入
       * 才會寫；走邀請連結設密碼的人那一欄永遠是空的。只看它的話，後台會把
       * 每一個帳密使用者都顯示成「（尚未登入過）」——即使他天天在用。
       */
      name: users.googleName,
      displayName: users.displayName,
      status: users.status,
      lastLoginAt: users.lastLoginAt,
      createdAt: users.createdAt,
    })
    .from(users)
    .orderBy(asc(users.email));

  const granted = await db
    .select({
      userId: userRoleAssignments.userId,
      roleKey: roles.roleKey,
      roleName: roles.name,
    })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .orderBy(asc(roles.roleKey));

  const byUser = new Map<string, AssignmentRow[]>();
  for (const item of granted) {
    const list = byUser.get(item.userId) ?? [];
    list.push({ roleKey: item.roleKey, roleName: item.roleName });
    byUser.set(item.userId, list);
  }

  return rows.map(({ displayName, ...row }) => ({
    ...row,
    // 與 loadAuthUser 同一條規則：自己設的顯示名稱優先，沒設才退回 Google 的姓名。
    name: displayName || row.name,
    status: row.status as UserStatus,
    assignments: byUser.get(row.id) ?? [],
  }));
}

/** 角色與各自的權限。給前端顯示「這個角色實際上能做什麼」。 */
export async function listRoles(db: Database): Promise<RoleRow[]> {
  const rows = await db
    .select({
      id: roles.id,
      key: roles.roleKey,
      name: roles.name,
      description: roles.description,
      isSystem: roles.isSystem,
    })
    .from(roles)
    // 管理員角色排前面，自訂角色接在後面——人找「管理者」的頻率遠高於找自己建的那幾個。
    .orderBy(desc(roles.isSystem), asc(roles.roleKey));

  const granted = await db
    .select({ roleId: rolePermissionGrants.roleId, permission: rolePermissionGrants.permission })
    .from(rolePermissionGrants);

  const byRole = new Map<string, Permission[]>();
  for (const item of granted) {
    const list = byRole.get(item.roleId) ?? [];
    list.push(item.permission as Permission);
    byRole.set(item.roleId, list);
  }

  return rows.map((row) => ({
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    permissions: byRole.get(row.id) ?? [],
  }));
}

export type InviteResult =
  | { kind: "created"; id: string; token: string }
  | { kind: "duplicate" };

/**
 * 邀請一個新帳號。
 *
 * status 停在 invited，要等對方真的完成其中一條登入路才會變成 active——
 * 用 Google 登入（recordLogin 負責）或走邀請連結設密碼（acceptInvitation 負責）。
 * 兩條路都通，邀請當下不綁死走哪一條：新同事手上不一定有公司 Google 帳號，
 * 但發邀請的人當下不會知道。
 *
 * 回傳的 token 是明文，而且**只有這一次拿得到**——資料庫只存雜湊。
 * 呼叫端要立刻把連結交給人，弄丟了只能重發。
 */
export async function inviteUser(
  db: Database,
  input: { email: string; invitedBy: string },
): Promise<InviteResult> {
  const email = input.email.trim().toLowerCase();

  const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) return { kind: "duplicate" };

  const id = `user-${crypto.randomUUID()}`;
  const token = newInviteToken();
  await db.insert(users).values({
    id,
    email,
    invitedBy: input.invitedBy,
    invitationTokenHash: await hashInviteToken(token),
    invitationExpiresAt: inviteExpiryFrom(new Date()),
  });
  return { kind: "created", id, token };
}

/**
 * 重發邀請連結。舊的立刻失效——換新 token 而不是延長舊的到期日。
 *
 * 已經啟用的帳號不給重發：那條連結會讓人設一組新密碼，等同於一個不需要驗證
 * 就能改密碼的後門。要協助已啟用的人重設密碼是另一件事，不能混用這條路。
 */
export type ReinviteResult =
  | { kind: "ok"; token: string }
  | { kind: "not-found" }
  | { kind: "already-active" };

export async function regenerateInvitation(db: Database, userId: string): Promise<ReinviteResult> {
  const [row] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return { kind: "not-found" };
  if (row.status === "active") return { kind: "already-active" };

  const token = newInviteToken();
  await db
    .update(users)
    .set({
      invitationTokenHash: await hashInviteToken(token),
      invitationExpiresAt: inviteExpiryFrom(new Date()),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(users.id, userId));
  return { kind: "ok", token };
}

export type InviteLookup =
  | { kind: "ok"; id: string; email: string }
  | { kind: "invalid" };

/**
 * 拿邀請 token 換帳號。
 *
 * 過期、已停用、找不到，一律回同一種 invalid：對還沒登入的人吐出
 * 「這個帳號存在但停用了」是在白送情報。
 */
export async function findInvitation(db: Database, token: string): Promise<InviteLookup> {
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      expiresAt: users.invitationExpiresAt,
    })
    .from(users)
    .where(eq(users.invitationTokenHash, await hashInviteToken(token)))
    .limit(1);

  if (!row || row.status === "disabled") return { kind: "invalid" };
  if (!row.expiresAt || new Date(row.expiresAt).getTime() <= Date.now()) return { kind: "invalid" };
  return { kind: "ok", id: row.id, email: row.email };
}

/**
 * 走邀請連結設密碼。設完就把 token 清掉——一條連結只能用一次，
 * 留著等於讓任何看過那個網址的人隨時能改密碼。
 */
export async function acceptInvitation(
  db: Database,
  input: { token: string; password: string; displayName?: string },
): Promise<InviteLookup> {
  const found = await findInvitation(db, input.token);
  if (found.kind !== "ok") return found;

  const now = new Date().toISOString();
  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(input.password),
      passwordSetAt: now,
      // 設完密碼會直接發 session，那一刻就是這個人的第一次登入。
      lastLoginAt: now,
      invitationTokenHash: null,
      invitationExpiresAt: null,
      status: "active",
      ...(input.displayName ? { displayName: input.displayName } : {}),
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(users.id, found.id));

  return found;
}

/**
 * 帳密登入。
 *
 * 三種失敗（查無此人、還沒設密碼、密碼錯）都回 null，由路由統一講一句
 * 含糊的錯誤——分開講等於送人一支帳號列舉工具。
 */
export async function authenticateWithPassword(
  db: Database,
  email: string,
  password: string,
): Promise<{ id: string; email: string } | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !password) return null;

  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      status: users.status,
      passwordHash: users.passwordHash,
    })
    .from(users)
    .where(eq(users.email, normalized))
    .limit(1);

  if (!row || row.status !== "active" || !row.passwordHash) return null;
  if (!(await verifyPassword(password, row.passwordHash))) return null;

  /*
   * 記錄最後登入時間。Google 那條路由 recordLogin 負責，帳密這條原本什麼都沒寫——
   * 結果後台的「最後登入」對帳密使用者永遠是「—」，看起來像沒人在用這個帳號。
   */
  await db
    .update(users)
    .set({ lastLoginAt: new Date().toISOString(), updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(users.id, row.id));

  return { id: row.id, email: row.email };
}

export async function findUser(db: Database, id: string) {
  const [row] = await db
    .select({ id: users.id, email: users.email, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  return row ? { ...row, status: row.status as UserStatus } : null;
}

export async function setUserStatus(db: Database, id: string, status: UserStatus): Promise<void> {
  await db
    .update(users)
    .set({ status, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(users.id, id));
}

/** 這個人是否持有某個角色（不分資料範圍）。用來判斷是不是還剩最後一位管理者。 */
export async function hasRole(db: Database, userId: string, roleKey: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: userRoleAssignments.userId })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .where(and(eq(userRoleAssignments.userId, userId), eq(roles.roleKey, roleKey)))
    .limit(1);
  return Boolean(row);
}

export interface RoleGrant {
  userId: string;
  roleKey: string;
}

/** 指派角色。已經有同一組 (人, 角色) 就當作成功，不重複插入。 */
export async function assignRole(
  db: Database,
  grant: RoleGrant & { grantedBy: string },
): Promise<"ok" | "unknown-role"> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.roleKey, grant.roleKey)).limit(1);
  if (!role) return "unknown-role";

  await db
    .insert(userRoleAssignments)
    .values({ userId: grant.userId, roleId: role.id, grantedBy: grant.grantedBy })
    .onConflictDoNothing();
  return "ok";
}

/** 收回一筆角色指派。回傳是否真的刪到東西，讓呼叫端能回 404。 */
export async function revokeRole(db: Database, grant: RoleGrant): Promise<boolean> {
  const [role] = await db.select({ id: roles.id }).from(roles).where(eq(roles.roleKey, grant.roleKey)).limit(1);
  if (!role) return false;

  const result = await db
    .delete(userRoleAssignments)
    .where(and(eq(userRoleAssignments.userId, grant.userId), eq(userRoleAssignments.roleId, role.id)));
  return (result.meta?.changes ?? 0) > 0;
}

/**
 * ── 角色維護 ──────────────────────────────────────────────────────────────
 *
 * 管理員是不可刪除的固定入口；其他角色都是自訂角色，權限與顯示資訊都可以由
 * 管理者在 UI 調整或刪除。SYSTEM_ROLES 只負責新環境的初始值；重新同步時也不會
 * 覆蓋已經由管理者調整過的非管理員角色。
 */

/** 自訂角色的 key 由系統產生。人只需要取名字，不必再發明一組英數代號。 */
function newRoleKey(): string {
  return `custom-${crypto.randomUUID().slice(0, 8)}`;
}

export type RoleWriteResult =
  | { kind: "ok"; key: string }
  | { kind: "not-found" }
  | { kind: "protected-role" }
  | { kind: "unknown-permission"; permission: string };

const PROTECTED_ROLE_KEY = "admin";

/** 未知的權限鍵值一律擋下來。默默存進去只會讓「設定看起來有給」但實際上不生效。 */
function findUnknownPermission(permissions: readonly string[]): string | null {
  return permissions.find((permission) => !(permission in PERMISSIONS)) ?? null;
}

export async function createRole(
  db: Database,
  input: { name: string; description?: string; permissions: readonly string[] },
): Promise<RoleWriteResult> {
  const unknown = findUnknownPermission(input.permissions);
  if (unknown) return { kind: "unknown-permission", permission: unknown };

  const key = newRoleKey();
  const id = `role-${crypto.randomUUID()}`;
  await db.insert(roles).values({
    id,
    roleKey: key,
    name: input.name.trim(),
    description: (input.description ?? "").trim(),
    isSystem: false,
  });
  await writePermissions(db, id, input.permissions);
  return { kind: "ok", key };
}

export async function updateRole(
  db: Database,
  key: string,
  input: { name?: string; description?: string; permissions?: readonly string[] },
): Promise<RoleWriteResult> {
  if (input.permissions) {
    const unknown = findUnknownPermission(input.permissions);
    if (unknown) return { kind: "unknown-permission", permission: unknown };
  }

  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.roleKey, key))
    .limit(1);
  if (!role) return { kind: "not-found" };
  if (key === PROTECTED_ROLE_KEY) return { kind: "protected-role" };

  const patch: Record<string, string> = {};
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description.trim();
  if (Object.keys(patch).length) {
    await db.update(roles).set(patch).where(eq(roles.id, role.id));
  }
  if (input.permissions) await writePermissions(db, role.id, input.permissions);

  return { kind: "ok", key };
}

/** 整組重寫而不是逐一比對。權限清單很短，差異計算省下的那點 I/O 不值得那份複雜度。 */
async function writePermissions(
  db: Database,
  roleId: string,
  permissions: readonly string[],
): Promise<void> {
  await db.delete(rolePermissionGrants).where(eq(rolePermissionGrants.roleId, roleId));
  if (permissions.length) {
    await db.insert(rolePermissionGrants).values(
      [...new Set(permissions)].map((permission) => ({ roleId, permission })),
    );
  }
}

/**
 * 刪除自訂角色。管理員角色受保護；指派給使用者的那幾列由 FK 的 onDelete cascade
 * 一起帶走，所以呼叫端要先問清楚「這個角色還有幾個人在用」再送出。
 */
export async function deleteRole(db: Database, key: string): Promise<RoleWriteResult> {
  const [role] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.roleKey, key))
    .limit(1);
  if (!role) return { kind: "not-found" };
  if (key === PROTECTED_ROLE_KEY) return { kind: "protected-role" };

  await db.delete(roles).where(eq(roles.id, role.id));
  return { kind: "ok", key };
}

/** 每個角色目前有幾個人持有。刪除前的確認訊息要講得出數字才有意義。 */
export async function countRoleHolders(db: Database): Promise<Record<string, number>> {
  const rows = await db
    .select({ roleKey: roles.roleKey, holders: sql<number>`count(*)` })
    .from(userRoleAssignments)
    .innerJoin(roles, eq(roles.id, userRoleAssignments.roleId))
    .groupBy(roles.roleKey);
  return Object.fromEntries(rows.map((row) => [row.roleKey, Number(row.holders)]));
}

export type DeleteUserResult = "ok" | "not-found" | "still-active" | "employee-linked";

/**
 * 刪除帳號。**啟用中的不能刪**，已停用與還沒登入過的都可以。
 *
 * 原本只放行已停用的，但那讓「邀請時 email 打錯」變成無解：那一列永遠停在
 * invited，既不能刪、也不會有人登入。現在的規則改成「只要不是啟用中的都能刪」，
 * 語意更直接：**還在用的帳號不能刪，其他的可以整理掉。**
 *
 * 啟用中的仍然要先停用。停用可逆、刪除不可逆，中間那一步就是確認——沒有人會
 * 不小心把還在用的帳號清掉。
 *
 * 稽核軌跡不會斷：操作紀錄與出金表執行紀錄存的是當下的 email 快照
 * （activity_events.actor_email、report_runs.actor_email），不是外鍵，所以
 * 「這筆是誰做的」在人被刪掉之後仍然答得出來。角色指派則靠 FK cascade 一起走。
 */
export async function deleteUser(db: Database, id: string): Promise<DeleteUserResult> {
  const [row] = await db
    .select({ id: users.id, status: users.status })
    .from(users)
    .where(eq(users.id, id))
    .limit(1);
  if (!row) return "not-found";
  if (row.status === "active") return "still-active";

  const [employee] = await db.select({ userId: hrEmployees.userId }).from(hrEmployees).where(eq(hrEmployees.userId, id)).limit(1);
  if (employee) return "employee-linked";

  await db.delete(users).where(eq(users.id, id));
  return "ok";
}

/**
 * ── 直接授予的權限 ────────────────────────────────────────────────────────
 *
 * 角色回答「這一類人能做什麼」，這裡回答「這一個人另外還能做什麼」。
 * 只加不減，跟角色帶來的取聯集——理由見 user_permissions 的表頭註解。
 */
export async function listDirectPermissions(db: Database): Promise<Record<string, Permission[]>> {
  const rows = await db
    .select({ userId: userPermissionGrants.userId, permission: userPermissionGrants.permission })
    .from(userPermissionGrants);

  const byUser: Record<string, Permission[]> = {};
  for (const row of rows) {
    (byUser[row.userId] ??= []).push(row.permission as Permission);
  }
  return byUser;
}

export type GrantResult = "ok" | "unknown-permission";

/** 已經有同一組（人, 權限）就當作成功，不重複插入。 */
export async function grantPermission(
  db: Database,
  input: { userId: string; permission: string; grantedBy: string },
): Promise<GrantResult> {
  if (!(input.permission in PERMISSIONS)) return "unknown-permission";

  await db
    .insert(userPermissionGrants)
    .values({
      userId: input.userId,
      permission: input.permission,
      grantedBy: input.grantedBy,
    })
    .onConflictDoNothing();
  return "ok";
}

/**
 * 收回一筆直接授予。回傳有沒有真的刪到——收不回角色帶來的那一份，
 * 所以「按了沒反應」通常代表那個權限其實來自角色，呼叫端要講得出這件事。
 */
export async function revokePermission(
  db: Database,
  input: { userId: string; permission: string },
): Promise<boolean> {
  const result = await db
    .delete(userPermissionGrants)
    .where(
      and(
        eq(userPermissionGrants.userId, input.userId),
        eq(userPermissionGrants.permission, input.permission),
      ),
    );
  return (result.meta?.changes ?? 0) > 0;
}
