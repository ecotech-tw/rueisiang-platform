import type { Permission } from "@rueisiang/auth/permissions";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * 權限管理頁的資料層。型別在這裡重寫一份而不是從 @rueisiang/db 匯入——
 * portal 是純前端，不該相依資料庫套件；這些形狀由 API 的回應決定。
 */

export interface Assignment {
  roleKey: string;
  roleName: string;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  assignments: Assignment[];
}

export interface RoleInfo {
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: Permission[];
}

export interface Catalog {
  roles: RoleInfo[];
  permissions: Record<string, string>;
  /** roleKey → 目前有幾個人持有。刪除前的確認訊息要講得出數字。 */
  holders: Record<string, number>;
}

/** API 的錯誤訊息本來就是要給人看的中文，直接往上丟給畫面顯示。 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
}

const USERS_KEY = ["admin", "users"];

export function useUsers() {
  return useQuery({
    queryKey: USERS_KEY,
    queryFn: () => request<{ users: AdminUser[] }>("/api/admin/users").then((data) => data.users),
  });
}

export function useCatalog() {
  return useQuery({
    queryKey: ["admin", "catalog"],
    queryFn: () => request<Catalog>("/api/admin/roles"),
    staleTime: 5 * 60_000,
  });
}

/** 每個異動都重新拉一次列表：管理操作不頻繁，正確性比省一次往返重要。 */
function useAdminMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: USERS_KEY }),
  });
}

export function useInvite() {
  return useAdminMutation((input: { email: string; roleKey?: string }) =>
    request("/api/admin/users", { method: "POST", body: JSON.stringify(input) }),
  );
}

export function useSetStatus() {
  return useAdminMutation((input: { id: string; status: "active" | "disabled" }) =>
    request(`/api/admin/users/${encodeURIComponent(input.id)}`, {
      method: "PATCH",
      body: JSON.stringify({ status: input.status }),
    }),
  );
}

export function useAssignRole() {
  return useAdminMutation((input: { id: string; roleKey: string }) =>
    request(`/api/admin/users/${encodeURIComponent(input.id)}/roles`, {
      method: "POST",
      body: JSON.stringify({ roleKey: input.roleKey }),
    }),
  );
}

/**
 * 把 permissions.ts 的內容重新寫進資料庫。改過權限並部署之後按一次。
 * 這裡要把整個 admin 的快取都作廢——角色目錄與每個人的權限都可能變了。
 */
export function useSyncRoles() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => request("/api/admin/roles/sync", { method: "POST" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
}

export function useRevokeRole() {
  return useAdminMutation((input: { id: string; roleKey: string }) => {
    const params = new URLSearchParams({ roleKey: input.roleKey });
    return request(`/api/admin/users/${encodeURIComponent(input.id)}/roles?${params}`, { method: "DELETE" });
  });
}

/**
 * ── 自訂角色 ──────────────────────────────────────────────────────────────
 *
 * 角色改動會影響「誰能看到什麼」，所以整個 admin 的快取都要作廢，
 * 不是只有角色目錄——帳號列表上顯示的角色名稱也可能跟著變。
 */
function useRoleMutation<TInput>(mutationFn: (input: TInput) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: ["admin"] }),
  });
}

export interface RoleDraft {
  name: string;
  description: string;
  permissions: Permission[];
}

export function useCreateRole() {
  return useRoleMutation((input: RoleDraft) =>
    request("/api/admin/roles", { method: "POST", body: JSON.stringify(input) }),
  );
}

export function useUpdateRole() {
  return useRoleMutation((input: { key: string } & Partial<RoleDraft>) => {
    const { key, ...patch } = input;
    return request(`/api/admin/roles/${encodeURIComponent(key)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
  });
}

export function useDeleteRole() {
  return useRoleMutation((key: string) =>
    request(`/api/admin/roles/${encodeURIComponent(key)}`, { method: "DELETE" }),
  );
}
