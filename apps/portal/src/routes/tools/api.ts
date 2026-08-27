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

export function useSavePayoutStores() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (stores: Omit<PayoutStore, "id">[]) =>
      call<{ stores: PayoutStore[]; syncedToRepo: boolean; committed: boolean }>(
        "/api/tools/payout/stores",
        { method: "PUT", body: JSON.stringify({ stores }) },
      ),
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

export interface ReportScopeOption {
  id: string;
  name: string;
}

export type ReportRow = Record<string, string | number | null>;

export interface ReportSalesResult {
  status: "ok" | "NO_DATA_FOR_RANGE" | "UNSUPPORTED_GRANULARITY";
  rows: ReportRow[];
  totals: { grossQuantity: number; returnQuantity: number; netQuantity: number; salesAmount: number };
  message?: string;
}

export interface ReportPayoutResult {
  status: "ok" | "NO_DATA_FOR_RANGE";
  rows: ReportRow[];
  totals: { payoutAmount: number };
  message?: string;
}

export interface ReportQueryInput {
  startDate: string;
  endDate: string;
  /** 空字串代表全公司；有值就是單一據點。 */
  scopeId: string;
  groupBy: string[];
}

function reportQueryString(input: ReportQueryInput): string {
  const params = new URLSearchParams({
    startDate: input.startDate,
    endDate: input.endDate,
    scopeType: input.scopeId ? "store" : "company",
    groupBy: input.groupBy.join(","),
  });
  if (input.scopeId) params.set("scopeId", input.scopeId);
  return params.toString();
}

export function useReportScopes() {
  return useQuery({
    queryKey: ["reports", "cyberbiz", "scopes"],
    queryFn: () => call<{ scopes: ReportScopeOption[] }>("/api/reports/cyberbiz/scopes"),
  });
}

export function useReportSales(input: ReportQueryInput, enabled = true) {
  const query = reportQueryString(input);
  return useQuery({
    enabled,
    queryKey: ["reports", "cyberbiz", "sales", query],
    queryFn: () => call<ReportSalesResult>(`/api/reports/cyberbiz/sales?${query}`),
  });
}

export function useReportPayout(input: ReportQueryInput, enabled = true) {
  const query = reportQueryString(input);
  return useQuery({
    enabled,
    queryKey: ["reports", "cyberbiz", "payout", query],
    queryFn: () => call<ReportPayoutResult>(`/api/reports/cyberbiz/payout?${query}`),
  });
}
