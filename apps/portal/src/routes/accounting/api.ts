import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "../../shell/Toast.js";

export type ExpenseStatus = "pending" | "approved" | "rejected" | "cancelled" | "paid";
export type ExpenseStatusFilter = ExpenseStatus | "all";

export interface ReviewExpense {
  id: string;
  status: ExpenseStatus;
  submitterUserId: string;
  submitterName: string;
  employeeNumber: string;
  categoryName: string;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  payoutMethod: "direct" | "payroll" | null;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  revision: number;
  createdAt: string;
  receiptIds: string[];
  duplicateInvoiceCount: number;
}

export interface ExpenseCategory { id: string; name: string; sortOrder: number; archived: boolean; expenseCount: number }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/accounting${path}`, { credentials: "same-origin", ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? `操作失敗（${response.status}）`);
  return result;
}

export function receiptUrl(expenseId: string, receiptId: string) {
  return `/api/accounting/expenses/${encodeURIComponent(expenseId)}/receipts/${encodeURIComponent(receiptId)}`;
}

export function useAccountingQuery<T>(path: string, enabled = true) {
  return useQuery({ queryKey: ["accounting", path], queryFn: () => request<T>(path), enabled, retry: false });
}

/** 失敗也重抓：409 幾乎都是別的會計先處理了，畫面上的資料已經過期。 */
export function useAccountingWrite<T = { id: string }>() {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> }) => request<T>(input.path, { method: input.method, body: JSON.stringify(input.values) }),
    onSettled: () => { void client.invalidateQueries({ queryKey: ["accounting"] }); },
    onError: (error) => toast.show(error instanceof Error ? error.message : "操作失敗，請稍後再試。", "danger"),
  });
}
