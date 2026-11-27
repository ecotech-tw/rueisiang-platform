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
  categoryId: string;
  categoryName: string;
  spentOn: string;
  amountMinor: number;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  payoutMethod: "direct" | "payroll" | null;
  payrollPeriodKey: string | null;
  payrollOption: string | null;
  reviewNote: string;
  reviewerName: string | null;
  reviewedAt: string | null;
  paidAt: string | null;
  revision: number;
  createdAt: string;
  receiptIds: string[];
  duplicateInvoiceCount: number;
  paidFromPettyCash: boolean;
}

/** 報帳單的一次修改：誰改的、哪些欄位從什麼改成什麼（from／to 是伺服器排好的顯示文字）。 */
export interface ExpenseEditRecord {
  id: string;
  at: string;
  editor: "submitter" | "reviewer";
  actorName: string;
  changes: { field: string; label: string; from: string; to: string }[];
}

export interface ExpenseCategory { id: string; name: string; sortOrder: number; archived: boolean; expenseCount: number }

export type LedgerPayer = "all" | "company" | "employee_advance";

export interface LedgerEntry {
  id: string;
  payerKind: "employee_advance" | "company";
  status: "approved" | "paid";
  spentOn: string;
  amountMinor: number;
  categoryId: string;
  categoryName: string;
  scopeId: string | null;
  scopeName: string | null;
  invoiceNumber: string;
  sellerTaxId: string;
  description: string;
  personName: string;
  payoutMethod: "direct" | "payroll" | null;
  payrollPeriodKey: string | null;
  revision: number;
  receiptIds: string[];
}

/** 核准的結果：直接撥款且零用金夠就是 paid；不夠停在 approved，pettyCashShort 讓畫面提示。 */
export interface ApproveResult { id: string; status: "approved" | "paid"; pettyCashShort: boolean }

export interface PettyCashEntry {
  id: string;
  kind: "top_up" | "payout" | "refund";
  amountMinor: number;
  balanceAfterMinor: number;
  expenseId: string | null;
  expenseDescription: string | null;
  /** 增加被更正過的話，每一次的差額與原因（舊的在前）；金額已經是更正後的。 */
  corrections: { id: string; amountMinor: number; note: string; actorName: string; createdAt: string }[];
  note: string;
  actorName: string;
  createdAt: string;
}
export interface PettyCashLedger { balanceMinor: number; entries: PettyCashEntry[] }

export interface CompanyExpenseOptions { categories: { id: string; name: string }[]; scopes: { id: string; name: string }[] }

/** code 讓畫面分得出「發票號碼重複，要確認」跟一般錯誤。 */
export class AccountingApiError extends Error {
  constructor(message: string, public readonly code?: string) { super(message); }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData 讓瀏覽器自己帶 multipart 的 boundary，不能手動設 Content-Type。
  const json = !(init?.body instanceof FormData);
  const response = await fetch(`/api/accounting${path}`, { credentials: "same-origin", ...init, headers: { ...(json ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const result = await response.json() as T & { error?: string; code?: string };
  if (!response.ok) throw new AccountingApiError(result.error ?? `操作失敗（${response.status}）`, result.code);
  return result;
}

export function receiptUrl(expenseId: string, receiptId: string) {
  return `/api/accounting/expenses/${encodeURIComponent(expenseId)}/receipts/${encodeURIComponent(receiptId)}`;
}

export function useAccountingQuery<T>(path: string, enabled = true) {
  return useQuery({ queryKey: ["accounting", path], queryFn: () => request<T>(path), enabled, retry: false });
}

/**
 * 失敗也重抓：409 幾乎都是別的會計先處理了，畫面上的資料已經過期。
 * values 給 FormData 就照原樣送（登記支出要帶照片）。quietCodes 裡的錯誤不跳提示，由畫面自己處理（例如發票重複要確認）。
 */
export function useAccountingWrite<T = { id: string }>(options: { quietCodes?: string[] } = {}) {
  const client = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (input: { path: string; method: string; values: Record<string, unknown> | FormData }) => request<T>(input.path, { method: input.method, body: input.values instanceof FormData ? input.values : JSON.stringify(input.values) }),
    onSettled: () => { void client.invalidateQueries({ queryKey: ["accounting"] }); },
    onError: (error) => {
      if (error instanceof AccountingApiError && error.code && options.quietCodes?.includes(error.code)) return;
      toast.show(error instanceof Error ? error.message : "操作失敗，請稍後再試。", "danger");
    },
  });
}
