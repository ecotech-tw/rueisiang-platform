import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface PayoutStoreSummary {
  name: string;
  folder: string;
}

export interface PayoutRunRecord {
  id: string;
  requestId: string;
  storesJson: string;
  startDate: string;
  endDate: string;
  actorEmail: string;
  createdAt: string;
}

export interface PayoutState {
  stores: PayoutStoreSummary[];
  defaultStart: string;
  defaultEnd: string;
  /** 後端有沒有 GitHub token。沒有的話畫面要說得出原因，不是等按下去才報錯。 */
  configured: boolean;
  runs: PayoutRunRecord[];
}

export interface WorkflowRun {
  id: number;
  status: string;
  conclusion: string | null;
  url: string;
  title: string;
}

export interface WorkflowStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface PayoutStore {
  id: string;
  name: string;
  driveFolderUrl: string;
  driveFolderName: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body ? { "Content-Type": "application/json" } : undefined,
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
}

export function usePayoutState() {
  return useQuery({
    queryKey: ["tools", "payout", "state"],
    queryFn: () => call<PayoutState>("/api/tools/payout/state"),
  });
}

export function useRunPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { stores: string[]; start: string; end: string }) =>
      call<{ requestId: string }>("/api/tools/payout/run", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "payout", "state"] }),
  });
}

/**
 * 追蹤某一次執行。
 *
 * GitHub 建工作要幾秒，剛送出時清單會是空的——那不是失敗，所以照樣繼續問。
 * 跑完就停：refetchInterval 回 false，不會有分頁在那裡一直空轉。
 */
export function usePayoutStatus(requestId: string | null) {
  return useQuery({
    enabled: Boolean(requestId),
    queryKey: ["tools", "payout", "status", requestId],
    queryFn: () =>
      call<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>(
        `/api/tools/payout/status?requestId=${encodeURIComponent(requestId!)}`,
      ),
    refetchInterval: (query) => {
      const latest = query.state.data?.runs[0];
      return latest && latest.status === "completed" ? false : 5000;
    },
  });
}

export function usePayoutStores() {
  return useQuery({
    queryKey: ["tools", "payout", "stores"],
    queryFn: () => call<{ stores: PayoutStore[] }>("/api/tools/payout/stores"),
  });
}

export function useSavePayoutStores() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (stores: Omit<PayoutStore, "id">[]) =>
      call<{ stores: PayoutStore[] }>("/api/tools/payout/stores", {
        method: "PUT",
        body: JSON.stringify({ stores }),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "payout"] }),
  });
}

/** 執行紀錄裡的店別是 JSON 字串；壞掉的資料不該讓整列炸掉。 */
export function parseStores(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}
