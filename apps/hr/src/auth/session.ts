import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "../config.js";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  pictureUrl: string;
  isEmployee?: boolean;
  /** 這次是靠「記住這台手機」認出來的。false 代表只有 12 小時 session。 */
  deviceRemembered: boolean;
}

async function fetchSession(): Promise<SessionUser | null> {
  // 不打 /auth/me：裝置 cookie 只送到 /api/hr/me 底下，那條只認 12 小時 session。
  const response = await fetch(`${API_BASE_URL}/hr/me/session`, { credentials: "include" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("讀取登入狀態失敗。");
  const user = (await response.json()) as SessionUser;

  /*
   * 有 session 但這台還沒記住：剛登入、從平台的帳號選單點過來、或裝置已過期。
   * 三種都在這裡補發，登入頁不用各自處理。失敗也不擋畫面，只是 12 小時後要再登入一次。
   */
  if (!user.deviceRemembered) {
    await fetch(`${API_BASE_URL}/hr/me/device`, { method: "POST", credentials: "include" }).catch(() => undefined);
  }
  return user;
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
  };
}

export function useSignOut() {
  const client = useQueryClient();
  return async () => {
    await fetch(`${API_BASE_URL}/hr/me/device`, { method: "DELETE", credentials: "include" }).catch(() => undefined);
    client.clear();
    window.location.assign("/login");
  };
}
