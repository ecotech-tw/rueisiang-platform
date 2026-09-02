import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

const PRODUCT_CATEGORIES_KEY = ["tools", "product-categories"] as const;

export interface ProductCategoryOption {
  id: string;
  name: string;
  color: string;
  skuCount: number;
  customProductCount: number;
  usageCount: number;
}

export interface CyberbizProductCategoryProduct {
  sku: string;
  name: string;
  published: boolean;
  categoryId: string | null;
  categoryName: string | null;
  categoryColor: string | null;
}

export interface CyberbizProductCategoryManagementData {
  products: CyberbizProductCategoryProduct[];
  categories: ProductCategoryOption[];
}

export interface ProductCategoryWriteResult {
  sku: string;
  categoryId: string | null;
  categoryName: string | null;
}

export interface ReportProductCategoryWriteResult {
  id: string;
  name: string;
  color: string;
}

class ProductCategoryApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ProductCategoryApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
    throw new ProductCategoryApiError(
      response.status,
      body?.message ?? body?.error ?? `商品分類操作失敗（${response.status}）。`,
    );
  }
  return (await response.json()) as T;
}

export function useProductCategoryManagement() {
  return useQuery({
    queryKey: PRODUCT_CATEGORIES_KEY,
    queryFn: () => request<CyberbizProductCategoryManagementData>("/api/tools/product-categories"),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSetCyberbizProductCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ sku, categoryId }: { sku: string; categoryId: string | null }) => request<ProductCategoryWriteResult>(
      `/api/tools/product-categories/${encodeURIComponent(sku)}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId }),
      },
    ),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: PRODUCT_CATEGORIES_KEY });
      void client.invalidateQueries({ queryKey: ["reports", "analytics"] });
    },
  });
}

const REPORT_CATEGORY_COLORS = [
  "rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand",
] as const;

export { REPORT_CATEGORY_COLORS };

function invalidateProductCategoryQueries(client: ReturnType<typeof useQueryClient>) {
  void client.invalidateQueries({ queryKey: PRODUCT_CATEGORIES_KEY });
  void client.invalidateQueries({ queryKey: ["reports", "manual", "options"] });
  void client.invalidateQueries({ queryKey: ["reports", "analytics"] });
}

export function useCreateReportProductCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; color: string }) => request<ReportProductCategoryWriteResult>(
      "/api/tools/product-categories",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
    onSuccess: () => invalidateProductCategoryQueries(client),
  });
}

export function useUpdateReportProductCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: { id: string; name: string; color: string }) => request<ReportProductCategoryWriteResult>(
      `/api/tools/product-categories/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    ),
    onSuccess: () => invalidateProductCategoryQueries(client),
  });
}

export function useDeleteReportProductCategory() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => request<{ ok: true }>(
      `/api/tools/product-categories/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
    onSuccess: () => invalidateProductCategoryQueries(client),
  });
}
