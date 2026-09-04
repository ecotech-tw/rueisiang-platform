import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

export interface ReportExternalProduct {
  id: string;
  sourceType: string;
  externalKey: string;
  externalVariantKey: string;
  externalName: string;
  resolution: "mapped" | "ignored";
  itemId: string | null;
  ignoredReason: string;
  updatedAt: string;
}

export interface ExternalProductItem {
  id: string;
  sku: string;
  name: string;
  source: "cyberbiz" | "custom" | "wms";
}

const EXTERNAL_PRODUCTS_KEY = ["tools", "report-external-products"] as const;
const ITEMS_KEY = ["items", "catalog"] as const;

async function readError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { message?: string; error?: string } | null;
  throw new Error(body?.message ?? body?.error ?? `請求失敗（${response.status}）`);
}

async function write<T>(path: string, payload?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as T;
}

export function useReportExternalProducts() {
  return useQuery({
    queryKey: EXTERNAL_PRODUCTS_KEY,
    queryFn: async () => {
      const response = await fetch("/api/reports/cyberbiz/external-products?sourceType=cyberbiz", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as { products: ReportExternalProduct[] };
    },
  });
}

export function useExternalProductItems() {
  return useQuery({
    queryKey: ITEMS_KEY,
    queryFn: async () => {
      const response = await fetch("/api/items/catalog", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as { items: ExternalProductItem[] };
    },
  });
}

function useExternalProductMutation<TArgs>(run: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: EXTERNAL_PRODUCTS_KEY });
      void queryClient.invalidateQueries({ queryKey: ["tools", "analytics"] });
    },
  });
}

export function useResolveReportExternalProduct() {
  return useExternalProductMutation(({ id, itemId }: { id: string; itemId: string }) =>
    write(`/api/reports/cyberbiz/external-products/${id}/resolve`, { itemId }));
}

export function useIgnoreReportExternalProduct() {
  return useExternalProductMutation(({ id, reason }: { id: string; reason?: string }) =>
    write(`/api/reports/cyberbiz/external-products/${id}/ignore`, { reason }));
}

export function useUnignoreReportExternalProduct() {
  return useExternalProductMutation(({ id }: { id: string }) =>
    write(`/api/reports/cyberbiz/external-products/${id}/unignore`));
}
