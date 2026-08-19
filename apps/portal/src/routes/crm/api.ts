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
  page: number;
  pageSize: number;
  sortField: string;
  sortDirection: "asc" | "desc";
}

export const DEFAULT_FILTERS: CustomerFilters = {
  search: "",
  channel: "all",
  status: "all",
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
