import type { Permission, ScopeType } from "./permissions.js";

/** 全域範圍的哨兵值，與 packages/db 的 GLOBAL_SCOPE 一致。 */
export const GLOBAL_SCOPE = "";

export interface RoleAssignment {
  roleKey: string;
  permissions: readonly Permission[];
  /** GLOBAL_SCOPE 代表這個角色在所有資料上都生效。 */
  scopeType: string;
  scopeId: string;
}

export type UserStatus = "invited" | "active" | "disabled";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  pictureUrl: string;
  status: UserStatus;
  assignments: readonly RoleAssignment[];
}

export interface Scope {
  scopeType: ScopeType;
  scopeId: string;
}

/**
 * 查詢要套用的資料範圍。
 *   all  —— 不必過濾
 *   some —— 只能看到 ids 裡的
 *   none —— 完全沒有權限，查詢必須回空集合（不是「不過濾」！）
 */
export type ScopeFilter =
  | { kind: "all" }
  | { kind: "some"; ids: string[] }
  | { kind: "none" };

function isGlobal(assignment: RoleAssignment): boolean {
  return assignment.scopeType === GLOBAL_SCOPE;
}

/** 只有 active 的帳號有權限。invited（還沒登入過）與 disabled（停權）一律為零。 */
function usableAssignments(user: AuthUser): readonly RoleAssignment[] {
  return user.status === "active" ? user.assignments : [];
}

/**
 * 這個人「在任何範圍內」是否擁有該權限。
 * 用來決定 sidebar 要不要顯示某一項——那是外觀判斷，真正的把關在 API。
 */
export function canAnywhere(user: AuthUser, permission: Permission): boolean {
  return usableAssignments(user).some((assignment) => assignment.permissions.includes(permission));
}

/**
 * 這個人在指定範圍內是否擁有該權限。全域指派可以滿足任何範圍。
 * 不給 scope 就等同 canAnywhere。
 */
export function can(user: AuthUser, permission: Permission, scope?: Scope): boolean {
  if (!scope) return canAnywhere(user, permission);
  return usableAssignments(user).some((assignment) => {
    if (!assignment.permissions.includes(permission)) return false;
    if (isGlobal(assignment)) return true;
    return assignment.scopeType === scope.scopeType && assignment.scopeId === scope.scopeId;
  });
}

/**
 * 取得查詢要用的範圍過濾條件。這是「角色＋資料範圍」真正落地的地方——
 * packages/db 的查詢 helper 會吃這個結果，呼叫端不該自己拼條件。
 */
export function scopesFor(
  user: AuthUser,
  permission: Permission,
  scopeType: ScopeType,
): ScopeFilter {
  const relevant = usableAssignments(user).filter((assignment) =>
    assignment.permissions.includes(permission),
  );
  if (!relevant.length) return { kind: "none" };
  if (relevant.some(isGlobal)) return { kind: "all" };

  const ids = [
    ...new Set(
      relevant
        .filter((assignment) => assignment.scopeType === scopeType)
        .map((assignment) => assignment.scopeId),
    ),
  ];
  // 有權限但都落在別種範圍（例如只有倉庫範圍卻在問店別）＝這一類看不到任何東西。
  return ids.length ? { kind: "some", ids } : { kind: "none" };
}

/** 這個人擁有的所有權限（跨範圍聯集）。給前端決定顯示什麼用。 */
export function permissionsOf(user: AuthUser): Permission[] {
  const all = new Set<Permission>();
  for (const assignment of usableAssignments(user)) {
    for (const permission of assignment.permissions) all.add(permission);
  }
  return [...all];
}
