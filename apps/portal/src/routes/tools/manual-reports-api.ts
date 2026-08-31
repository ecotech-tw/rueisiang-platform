import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export type ManualReportKind = "payout" | "sales";
export type ManualRecordSource = "imported" | "manual";
export type ManualSourceFilter = "all" | ManualRecordSource;
export type ManualSkuSource = "custom" | "cyberbiz";

export interface ManualScopeOption {
  id: string;
  name: string;
}

export interface ManualProductOption {
  sku: string;
  name: string;
  published: boolean;
}

export interface ManualOptionsResponse {
  scopes: ManualScopeOption[];
  products: ManualProductOption[];
}

export interface ManualPayoutRow {
  id: string;
  source: ManualRecordSource;
  scopeId: string;
  scopeName: string;
  businessDate: string;
  payoutAmount: number;
  createdByEmail: string;
  updatedByEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManualSalesRow {
  id: string;
  source: ManualRecordSource;
  scopeId: string;
  scopeName: string;
  reportMonth: string;
  skuSource: ManualSkuSource | null;
  sku: string;
  productName: string;
  category: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
  createdByEmail: string;
  updatedByEmail: string;
  createdAt: string;
  updatedAt: string;
}

export interface ManualPayoutInput {
  scopeId: string;
  businessDate: string;
  payoutAmount: number;
}

export interface ManualSalesInput {
  scopeId: string;
  reportMonth: string;
  skuSource: ManualSkuSource;
  sku: string;
  productName?: string;
  category?: string;
  grossQuantity: number;
  returnQuantity: number;
  netQuantity: number;
  salesAmount: number;
}

export interface ManualPayoutQuery {
  page: number;
  pageSize: number;
  search: string;
  scopeId: string;
  source: ManualSourceFilter;
  startDate: string;
  endDate: string;
  sortField: "scope" | "businessDate" | "payoutAmount" | "updatedAt";
  sortDirection: "asc" | "desc";
}

export interface ManualSalesQuery {
  page: number;
  pageSize: number;
  search: string;
  scopeId: string;
  source: ManualSourceFilter;
  startMonth: string;
  endMonth: string;
  sortField: "scope" | "reportMonth" | "sku" | "productName" | "netQuantity" | "salesAmount" | "updatedAt";
  sortDirection: "asc" | "desc";
}

export interface ManualPayoutPage {
  rows: ManualPayoutRow[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ManualSalesPage {
  rows: ManualSalesRow[];
  page: number;
  pageSize: number;
  total: number;
}

export class ManualReportApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ManualReportApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    const errorBody = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ManualReportApiError(
      response.status,
      errorBody?.message ?? errorBody?.error ?? `報表人工修訂操作失敗（${response.status}）。`,
    );
  }
  return (await response.json()) as T;
}

async function write<T>(path: string, method: "POST" | "PATCH" | "DELETE", payload?: unknown): Promise<T> {
  return request<T>(path, {
    method,
    ...(payload === undefined
      ? {}
      : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
  });
}

function invalidateManualQueries(client: ReturnType<typeof useQueryClient>): void {
  void client.invalidateQueries({ queryKey: ["reports", "manual"] });
  void client.invalidateQueries({ queryKey: ["reports", "analytics"] });
}

export function useManualReportOptions(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["reports", "manual", "options"],
    queryFn: () => request<ManualOptionsResponse>("/api/reports/cyberbiz/manual/options"),
    staleTime: 5 * 60 * 1000,
  });
}

function listQuery(params: URLSearchParams, query: {
  page: number;
  pageSize: number;
  search: string;
  scopeId: string;
  source: ManualSourceFilter;
  sortField: string;
  sortDirection: "asc" | "desc";
}) {
  params.set("page", String(query.page));
  params.set("pageSize", String(query.pageSize));
  if (query.search) params.set("search", query.search);
  if (query.scopeId) params.set("scopeId", query.scopeId);
  if (query.source !== "all") params.set("source", query.source);
  params.set("sortField", query.sortField);
  params.set("sortDirection", query.sortDirection);
}

export function useManualPayouts(query: ManualPayoutQuery, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["reports", "manual", "payout", query],
    queryFn: () => {
      const params = new URLSearchParams();
      listQuery(params, query);
      if (query.startDate) params.set("startDate", query.startDate);
      if (query.endDate) params.set("endDate", query.endDate);
      return request<ManualPayoutPage>(`/api/reports/cyberbiz/manual/payout?${params}`);
    },
    placeholderData: keepPreviousData,
  });
}

export function useManualSales(query: ManualSalesQuery, enabled = true) {
  return useQuery({
    enabled,
    queryKey: ["reports", "manual", "sales", query],
    queryFn: () => {
      const params = new URLSearchParams();
      listQuery(params, query);
      if (query.startMonth) params.set("startMonth", query.startMonth);
      if (query.endMonth) params.set("endMonth", query.endMonth);
      return request<ManualSalesPage>(`/api/reports/cyberbiz/manual/sales?${params}`);
    },
    placeholderData: keepPreviousData,
  });
}

export function useCreateManualPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ManualPayoutInput) => write<{ row: ManualPayoutRow }>("/api/reports/cyberbiz/manual/payout", "POST", input),
    onSuccess: () => invalidateManualQueries(client),
  });
}

export function useUpdateManualPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ManualPayoutInput & { id: string }) => write<{ row: ManualPayoutRow }>(
      `/api/reports/cyberbiz/manual/payout/${encodeURIComponent(input.id)}`,
      "PATCH",
      input,
    ),
    onSuccess: () => invalidateManualQueries(client),
  });
}

export function useDeleteManualPayout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => write<{ ok: true }>(
      `/api/reports/cyberbiz/manual/payout/${encodeURIComponent(id)}`,
      "DELETE",
    ),
    onSuccess: () => invalidateManualQueries(client),
  });
}

export function useCreateManualSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ManualSalesInput) => write<{ row: ManualSalesRow }>("/api/reports/cyberbiz/manual/sales", "POST", input),
    onSuccess: () => invalidateManualQueries(client),
  });
}

export function useUpdateManualSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: ManualSalesInput & { id: string }) => write<{ row: ManualSalesRow }>(
      `/api/reports/cyberbiz/manual/sales/${encodeURIComponent(input.id)}`,
      "PATCH",
      input,
    ),
    onSuccess: () => invalidateManualQueries(client),
  });
}

export function useDeleteManualSales() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => write<{ ok: true }>(
      `/api/reports/cyberbiz/manual/sales/${encodeURIComponent(id)}`,
      "DELETE",
    ),
    onSuccess: () => invalidateManualQueries(client),
  });
}
