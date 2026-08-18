import type { Permission } from "@rueisiang/auth/permissions";
import { useQuery } from "@tanstack/react-query";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  /** Google 帳號上的姓名，個人資料頁拿它跟顯示名稱對照。 */
  googleName: string;
  pictureUrl: string;
  permissions: Permission[];
  roles: { role: string; scopeType: string; scopeId: string }[];
}

/** 未登入時回 null 而不是丟錯——這是預期中的狀態，不是異常。 */
async function fetchSession(): Promise<SessionUser | null> {
  const response = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("讀取登入狀態失敗。");
  return (await response.json()) as SessionUser;
}

export function useSession() {
  const query = useQuery({
    queryKey: ["session"],
    queryFn: fetchSession,
    retry: false,
    staleTime: 60_000,
  });

  return {
    user: query.data ?? null,
    loading: query.isPending,
    error: query.error,
    /**
     * 前端的權限判斷只影響顯示什麼。真正的把關在 API——
     * 這裡回 true 不代表操作會成功，回 false 也擋不住有心人。
     */
    permissions: new Set<Permission>(query.data?.permissions ?? []),
  };
}

export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
  window.location.href = "/login";
}
