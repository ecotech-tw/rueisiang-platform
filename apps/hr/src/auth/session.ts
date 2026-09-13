import { useQuery } from "@tanstack/react-query";
import { API_BASE_URL } from "../config.js";

interface SessionUser {
  id: string;
  email: string;
  name: string;
  pictureUrl: string;
  isEmployee?: boolean;
}

async function fetchSession(): Promise<SessionUser | null> {
  const response = await fetch(`${API_BASE_URL}/auth/me`, { credentials: "include" });
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
  };
}
