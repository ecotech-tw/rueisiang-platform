import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

interface PayoutStoreSummary {
  name: string;
  scopeId?: string;
  folder: string;
  folderUrl: string;
}

interface PayoutRunRecord {
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

interface CyberbizReportRunRecord {
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

interface ShopReportRunRecord {
  id: string;
  requestId: string;
  startMonth: string;
  endMonth: string;
  actorEmail: string;
  driveFolderUrl: string;
  driveFolderName: string;
  createdAt: string;
}

export interface ShopReportState {
  /** 對帳單是半月結算的，使用者只挑月份範圍；期間由 CYBERBIZ 決定。 */
  defaultStartMonth: string;
  defaultEndMonth: string;
  configured: boolean;
  githubConfigured: boolean;
  driveFolderUrl: string;
  driveFolderName: string;
  latestRequestId: string | null;
  runs: ShopReportRunRecord[];
}

export function useShopReportState() {
  return useQuery({
    queryKey: ["tools", "shop-report", "state"],
    queryFn: () => call<ShopReportState>("/api/tools/shop-report/state"),
  });
}

export function useRunShopReport() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { startMonth: string; endMonth: string }) =>
      call<{ requestId: string }>("/api/tools/shop-report/run", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["tools", "shop-report"] }),
  });
}

export function useShopReportStatus(requestId: string | null) {
  return useQuery({
    enabled: Boolean(requestId),
    queryKey: ["tools", "shop-report", "status", requestId],
    queryFn: () => call<{ runs: WorkflowRun[]; steps: WorkflowStep[] }>(`/api/tools/shop-report/status?requestId=${encodeURIComponent(requestId!)}`),
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

interface ShopeeSalesSettings {
  id: string;
  driveFolderUrl: string;
  driveFolderName: string;
  updatedAt: string;
}

export interface ShopeeSalesState {
  settings: ShopeeSalesSettings;
  start: string;
  end: string;
  configured: boolean;
  latestRequestId: string | null;
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

/**
 * 通路管理。
 *
 * 名稱、種類、來源、外部店名、Drive 設定與啟用狀態都在同一份資料裡——原本分散在
 * 「店別與報表設定」與「報表管理 → 管理據點」兩個入口，兩邊寫同一個欄位卻互相
 * 看不到對方。
 */
export interface ManagementScope {
  id: string;
  name: string;
  externalName: string;
  sourceType: string;
  scopeKind: "store" | "channel" | "company";
  driveFolderUrl: string;
  driveFolderName: string;
  active: boolean;
  archivedAt: string | null;
}

export function useScopes() {
  return useQuery({
    queryKey: ["tools", "scopes"],
    queryFn: () => call<{ scopes: ManagementScope[] }>("/api/tools/scopes"),
  });
}

export function useSaveScope() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (scope: Partial<ManagementScope> & { id?: string; name: string }) => {
      const { id, archivedAt: _archivedAt, ...payload } = scope;
      return call<{ scope: ManagementScope }>(
        id ? `/api/tools/scopes/${encodeURIComponent(id)}` : "/api/tools/scopes",
        { method: id ? "PATCH" : "POST", body: JSON.stringify(payload) },
      );
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools"] });
      void client.invalidateQueries({ queryKey: ["reports"] });
    },
  });
}

export function useArchiveScope() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      call<{ scope: ManagementScope }>(`/api/tools/scopes/${encodeURIComponent(id)}/archive`, { method: "POST" }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["tools"] });
      void client.invalidateQueries({ queryKey: ["reports"] });
    },
  });
}

export type ReportRunKind = "cyberbiz-payout" | "cyberbiz-sales" | "cyberbiz-shop" | "shopee";

export interface ReportRunListRow {
  id: string;
  requestId: string;
  kind: ReportRunKind;
  scopeNames: string[];
  startDate: string;
  endDate: string;
  periodKind: "month" | "custom";
  status: string;
  actorEmail: string;
  createdAt: string;
}

/** 四種報表共用的執行紀錄。不給 kind 就是全部。 */
export function useReportRuns(kind?: ReportRunKind) {
  return useQuery({
    queryKey: ["tools", "reports", "runs", kind ?? "all"],
    queryFn: () => call<{ runs: ReportRunListRow[] }>(
      `/api/tools/reports/runs${kind ? `?kind=${encodeURIComponent(kind)}` : ""}`,
    ),
  });
}
