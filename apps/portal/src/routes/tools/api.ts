import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface PayoutStoreSummary {
  name: string;
  scopeId?: string;
  folder: string;
  folderUrl: string;
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
  /** 最近一次執行；重新整理或離開再回來時，畫面靠它自己接回去問狀態。 */
  latestRequestId: string | null;
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
  enabled: boolean;
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

export interface CyberbizReportRunRecord {
  id: string;
  requestId: string;
  reportKind: "sales" | "payout";
  periodKind: "month" | "custom";
  storesJson: string;
  startDate: string;
  endDate: string;
  d1ImportEligible: number;
  actorEmail: string;
  createdAt: string;
}

export interface CyberbizSalesState {
  stores: PayoutStoreSummary[];
  defaultStart: string;
  defaultEnd: string;
  configured: boolean;
  latestRequestId: string | null;
  runs: CyberbizReportRunRecord[];
}

export function useCyberbizSalesState() {
  return useQuery({
    queryKey: ["tools", "cyberbiz-sales", "state"],
    queryFn: () => call<CyberbizSalesState>("/api/tools/cyberbiz-sales/state"),
  });
}

export function useRunCyberbizSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { stores: string[]; start: string; end: string }) =>
      call<{ requestId: string }>("/api/tools/cyberbiz-sales/run", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "cyberbiz-sales"] }),
  });
}

export function useCyberbizSalesStatus(requestId: string | null) {
  return useQuery({
    enabled: Boolean(requestId),
    queryKey: ["tools", "cyberbiz-sales", "status", requestId],
    queryFn: () => call<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>(`/api/tools/cyberbiz-sales/status?requestId=${encodeURIComponent(requestId!)}`),
    refetchInterval: (query) => query.state.data?.runs[0]?.status === "completed" ? false : 5000,
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

export type PayoutStoreDraft = Omit<PayoutStore, "id"> & { id?: string };
export type PayoutStoreSaveInput = Partial<Omit<PayoutStore, "id">> & { id?: string };

export function useSavePayoutStore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (store: PayoutStoreSaveInput) => {
      const { id, ...payload } = store;
      return call<{ store: PayoutStore; syncedToRepo: boolean; committed: boolean }>(
        id ? `/api/tools/payout/stores/${encodeURIComponent(id)}` : "/api/tools/payout/stores",
        {
          method: id ? "PATCH" : "POST",
          body: JSON.stringify(payload),
        },
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools", "payout"] });
      void client.invalidateQueries({ queryKey: ["tools", "cyberbiz-sales"] });
    },
  });
}

export function useDeletePayoutStore() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call<{ ok: true; syncedToRepo: boolean; committed: boolean }>(`/api/tools/payout/stores/${encodeURIComponent(id)}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools", "payout"] });
      void client.invalidateQueries({ queryKey: ["tools", "cyberbiz-sales"] });
    },
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

export interface ShopeeSalesSettings {
  id: string;
  driveFolderUrl: string;
  driveFolderName: string;
  updatedAt: string;
}

export interface ShopeeSalesRunRecord {
  id: string;
  requestId: string;
  startDate: string;
  endDate: string;
  driveFolderUrl: string;
  actorEmail: string;
  createdAt: string;
}

export interface ShopeeSalesState {
  settings: ShopeeSalesSettings;
  start: string;
  end: string;
  configured: boolean;
  latestRequestId: string | null;
  runs: ShopeeSalesRunRecord[];
}

export function useShopeeSalesState() {
  return useQuery({
    queryKey: ["tools", "shopee-sales", "state"],
    queryFn: () => call<ShopeeSalesState>("/api/tools/shopee-sales/state"),
  });
}

export function useRunShopeeSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (input: { file: File; password: string }) => {
      const form = new FormData();
      form.append("file", input.file);
      form.append("password", input.password);
      const response = await fetch("/api/tools/shopee-sales/upload", { method: "POST", credentials: "same-origin", body: form });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `操作失敗（${response.status}）`);
      }
      return (await response.json()) as { requestId: string };
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "shopee-sales"] }),
  });
}

export function useShopeeSalesStatus(requestId: string | null) {
  return useQuery({
    enabled: Boolean(requestId),
    queryKey: ["tools", "shopee-sales", "status", requestId],
    queryFn: () => call<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>(`/api/tools/shopee-sales/status?requestId=${encodeURIComponent(requestId!)}`),
    refetchInterval: (query) => query.state.data?.runs[0]?.status === "completed" ? false : 5000,
  });
}

export function useShopeeSalesSettings() {
  return useQuery({
    queryKey: ["tools", "shopee-sales", "settings"],
    queryFn: () => call<{ settings: ShopeeSalesSettings }>("/api/tools/shopee-sales/settings"),
  });
}

export function useSaveShopeeSalesSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { driveFolderUrl: string; driveFolderName: string }) =>
      call<{ settings: ShopeeSalesSettings }>("/api/tools/shopee-sales/settings", { method: "PUT", body: JSON.stringify(input) }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "shopee-sales"] }),
  });
}
/** 手動上傳出金：可選的既有據點。 */
export function useManualPayoutScopes() {
  return useQuery({
    queryKey: ["tools", "manual-payout", "scopes"],
    queryFn: async () => {
      const response = await fetch("/api/tools/manual-payout/scopes", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`讀取據點失敗（${response.status}）`);
      return (await response.json()) as { scopes: Array<{ id: string; name: string }> };
    },
  });
}

export interface ManualPayoutResult {
  scopeId: string;
  scopeName: string;
  dayCount: number;
  total: number;
  coverageStart: string;
  coverageEnd: string;
}

export function useUploadManualPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      scopeName: string;
      scopeId?: string;
      rows: Array<{ businessDate: string; payoutAmount: number }>;
    }) => {
      const response = await fetch("/api/tools/manual-payout", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(body?.error ?? body?.message ?? `匯入失敗（${response.status}）`);
      }
      return (await response.json()) as ManualPayoutResult;
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools", "manual-payout"] });
      void client.invalidateQueries({ queryKey: ["reports", "analytics"] });
    },
  });
}

/** 手動上傳商品銷售：可選的既有據點。 */
export function useManualSalesScopes() {
  return useQuery({
    queryKey: ["tools", "manual-sales", "scopes"],
    queryFn: () => call<{ scopes: Array<{ id: string; name: string }> }>("/api/tools/manual-sales/scopes"),
  });
}

export interface ManualSalesProduct {
  sku: string;
  name: string;
  published: boolean;
}

/** 舊版合併出金檔只有品名，先讀 CYBERBIZ 目錄才能在預覽階段補回 SKU。 */
export function useManualSalesProducts(enabled: boolean) {
  return useQuery({
    enabled,
    queryKey: ["tools", "manual-sales", "products"],
    queryFn: async () => {
      const response = await fetch("/api/tools/manual-sales/products", { credentials: "same-origin" });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
        throw new Error(body?.error ?? body?.message ?? `讀取商品目錄失敗（${response.status}）`);
      }
      return (await response.json()) as { products: ManualSalesProduct[] };
    },
  });
}

export interface ManualSalesResult {
  kind: "sales";
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  rowCount: number;
  skippedSkus: string[];
}

export function useUploadManualSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (payload: {
      scopeName: string;
      scopeId?: string;
      reportMonth: string;
      rows: Array<{
        sku: string;
        grossQuantity: number;
        returnQuantity: number;
        netQuantity: number;
        salesAmount: number;
      }>;
    }) => call<ManualSalesResult>("/api/tools/manual-sales", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools", "manual-sales"] });
      void client.invalidateQueries({ queryKey: ["reports", "analytics"] });
    },
  });
}
