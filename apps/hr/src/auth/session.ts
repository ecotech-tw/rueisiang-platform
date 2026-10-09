import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE_URL } from "../config.js";
import { getLiffIdToken, isLiffConfigured } from "./liff.js";

// 綁定 query 的逾時／失敗 refetch 不能清除此頁已開始的 LINE 綁定流程。
let lineLinkRequired = false;

interface SessionUser {
  id: string;
  email: string;
  name: string;
  pictureUrl: string;
  isEmployee?: boolean;
  /** 這次是靠「記住這台手機」認出來的。false 代表只有 12 小時 session。 */
  deviceRemembered: boolean;
  /** 這次登入的裝置憑證來自已驗證的 LINE LIFF 身分。 */
  lineLiffAuthenticated: boolean;
  lineLinkRequired: boolean;
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  return new Error(payload?.error ?? fallback);
}

async function fetchPendingLineIntent(): Promise<boolean> {
  if (!isLiffConfigured()) return false;
  const response = await fetch(`${API_BASE_URL}/hr/liff/link`, { credentials: "include" }).catch(() => null);
  if (!response?.ok) return false;
  const result = await response.json() as { pending?: boolean };
  return Boolean(result.pending);
}

export async function fetchSession(): Promise<SessionUser | null> {
  const lineIdToken = getLiffIdToken();
  if (lineIdToken) {
    const lineSession = await fetch(`${API_BASE_URL}/hr/me/liff-session`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: lineIdToken }),
    });
    if (!lineSession.ok) throw await responseError(lineSession, "LINE 身分驗證失敗，請重新開啟打卡頁。");
    const result = await lineSession.json() as { linked: boolean };
    lineLinkRequired = !result.linked;
  }

  // 裝置 cookie 只送到 /api/hr/me 底下，那條只認 12 小時 session。
  const response = await fetch(`${API_BASE_URL}/hr/me/session`, { credentials: "include" });
  if (response.status === 401 || response.status === 403) return null;
  if (!response.ok) throw new Error("讀取登入狀態失敗。");
  const user = (await response.json()) as SessionUser;

  /*
   * 有 session 但這台還沒記住：剛登入、從平台的帳號選單點過來、或裝置已過期。
   * LIFF linking intent 正等平台登入完成時不要先發一般裝置憑證；其餘照舊記住裝置。
   */
  if (user.lineLiffAuthenticated) lineLinkRequired = false;
  if (!user.deviceRemembered && !lineIdToken) {
    if (await fetchPendingLineIntent()) lineLinkRequired = true;
    if (!lineLinkRequired) {
      await fetch(`${API_BASE_URL}/hr/me/device`, { method: "POST", credentials: "include" }).catch(() => undefined);
    }
  }
  return { ...user, lineLinkRequired };
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
    reload: query.refetch,
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
