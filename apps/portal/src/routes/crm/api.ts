import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface Customer {
  id: string;
  phone: string;
  name: string;
  email: string;
  address: string;
  sourceChannel: string;
  status: string;
  cyberbizCustomerId: string | null;
  cyberbizTagsJson: string;
  syncStatus: string;
  syncError: string | null;
  updatedAt: string;
}

export interface CustomerListResult {
  customers: Customer[];
  total: number;
  page: number;
  pageSize: number;
  stats: { total: number; active: number; blocked: number; incomplete: number };
}

export interface CustomerFilters {
  search: string;
  channel: string;
  status: string;
  tag: string;
  page: number;
  pageSize: number;
  sortField: string;
  sortDirection: "asc" | "desc";
}

export const DEFAULT_FILTERS: CustomerFilters = {
  search: "",
  channel: "all",
  status: "all",
  tag: "all",
  page: 1,
  pageSize: 25,
  sortField: "updatedAt",
  sortDirection: "desc",
};

export function useCustomers(filters: CustomerFilters) {
  const params = new URLSearchParams({
    search: filters.search,
    channel: filters.channel,
    status: filters.status,
    tag: filters.tag,
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    sortField: filters.sortField,
    sortDirection: filters.sortDirection,
  });

  return useQuery({
    queryKey: ["crm", "customers", filters],
    queryFn: async () => {
      const response = await fetch(`/api/crm/customers?${params}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `讀取失敗（${response.status}）`);
      }
      return (await response.json()) as CustomerListResult;
    },
    // 換頁或改篩選時先留著上一批資料，畫面不會整個閃成空白再長回來。
    placeholderData: keepPreviousData,
  });
}

/** 標籤存成 JSON 字串；壞掉的資料不該讓整列炸掉。 */
export function parseTags(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
  } catch {
    return [];
  }
}

export interface CustomerForm {
  phone: string;
  name: string;
  email: string;
  address: string;
  tags: string[];
}

async function write<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `操作失敗（${response.status}）`);
  }
  return (await response.json()) as T;
}

/** 寫入之後整個 crm 的快取都作廢——列表、統計、操作紀錄都可能變了。 */
function useCrmMutation<TInput, TResult>(mutationFn: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => client.invalidateQueries({ queryKey: ["crm"] }),
  });
}

export function useCreateCustomer() {
  return useCrmMutation((input: CustomerForm & { sourceChannel?: string }) =>
    write<{ id: string; linked: boolean }>("/api/crm/customers", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  );
}

export function useUpdateCustomer() {
  return useCrmMutation((input: CustomerForm & { id: string }) =>
    write<{ id: string }>(`/api/crm/customers/${encodeURIComponent(input.id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  );
}

export function useBlockCustomer() {
  return useCrmMutation((input: { id: string; blocked: boolean }) =>
    write<{ id: string; blocked: boolean }>(
      `/api/crm/customers/${encodeURIComponent(input.id)}/block`,
      { method: "POST", body: JSON.stringify({ blocked: input.blocked }) },
    ),
  );
}

/** 一個視圖存的就是列表的篩選條件，只是不含頁碼。 */
export type SavedViewFilters = Omit<CustomerFilters, "page">;

export interface SavedView extends SavedViewFilters {
  id: string;
  name: string;
  createdByEmail: string;
}

export function useSavedViews() {
  return useQuery({
    queryKey: ["crm", "views"],
    queryFn: async () => {
      const response = await fetch("/api/crm/views", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`讀取視圖失敗（${response.status}）`);
      return ((await response.json()) as { views: SavedView[] }).views;
    },
  });
}

export function useCreateSavedView() {
  return useCrmMutation((input: SavedViewFilters & { name: string }) =>
    write<{ id: string }>("/api/crm/views", { method: "POST", body: JSON.stringify(input) }),
  );
}

export function useDeleteSavedView() {
  return useCrmMutation((id: string) =>
    write<{ ok: true }>(`/api/crm/views/${encodeURIComponent(id)}`, { method: "DELETE" }),
  );
}

/**
 * 目前的條件是不是就是這個視圖。
 *
 * 頁碼不比——視圖不存頁碼，翻到第 2 頁不代表就離開了這個視圖。
 */
export function matchesView(filters: CustomerFilters, view: SavedViewFilters): boolean {
  return (
    filters.search === view.search &&
    filters.channel === view.channel &&
    filters.status === view.status &&
    filters.tag === view.tag &&
    filters.sortField === view.sortField &&
    filters.sortDirection === view.sortDirection &&
    filters.pageSize === view.pageSize
  );
}

/** 標籤篩選的選項。沒有 crm:tag:read 的人不會呼叫這支，篩選器也就不顯示。 */
export function useTagOptions(enabled: boolean) {
  return useQuery({
    enabled,
    // 標籤管理頁用的是同一支 API 但存整個回應，鍵值分開才不會兩邊互相蓋掉。
    queryKey: ["crm", "tag-options"],
    queryFn: async () => {
      const response = await fetch("/api/crm/tags", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`讀取標籤失敗（${response.status}）`);
      return ((await response.json()) as { tags: { name: string; customerCount: number }[] }).tags;
    },
  });
}
