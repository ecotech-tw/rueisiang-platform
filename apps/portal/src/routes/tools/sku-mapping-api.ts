import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * 通路 SKU 對應。
 *
 * 映射資料寫在報表 target schema，但操作入口放在品項管理：通路商品最後要回答的是
 * 「倉庫要扣哪些品項」，不能讓外部商品解析與 SKU 對應各自維護一份清單。
 */
const PRODUCT_SKU_MAPPINGS_KEY = ["tools", "product-sku-mappings"] as const;
const REPORT_SKU_IGNORES_KEY = ["tools", "report-sku-ignores"] as const;

async function readError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { error?: string; message?: string } | null;
  throw new Error(body?.error ?? body?.message ?? `請求失敗（${response.status}）`);
}

async function write<T>(path: string, method: "POST" | "PATCH" | "DELETE", payload?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    ...(payload === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
  });
  if (!response.ok) await readError(response);
  return (await response.json()) as T;
}

/** 每一支寫入都失效對應與忽略清單；用 void 不回傳 promise，理由同 wms/api.ts。 */
function useSkuMappingMutation<TArgs, TResult>(run: (args: TArgs) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: PRODUCT_SKU_MAPPINGS_KEY });
      void queryClient.invalidateQueries({ queryKey: REPORT_SKU_IGNORES_KEY });
    },
  });
}

export interface ProductSkuMapping {
  id: string;
  channel: string;
  externalName: string;
  externalSku: string;
  createdAt: string;
  updatedAt: string;
  components: ProductBundleComponent[];
}

/** 一列用料直接指向全平台品項；source 僅保留供舊資料列表顯示。 */
export interface ProductBundleComponent {
  itemId: string;
  source: "item" | "cyberbiz" | "custom";
  inventoryItemId: string | null;
  cyberbizSku: string | null;
  customProductId: string | null;
  sku: string;
  name: string;
  category: string;
  quantity: number;
}

export interface ProductBundleComponentInput {
  itemId: string;
  quantity: number;
}

export interface ProductSkuMappingItemOption {
  id: string;
  sku: string;
  name: string;
  category: string;
}

export interface UnmappedProductOption {
  channel: string;
  externalSku: string;
  externalName: string;
  rowCount: number;
  lastSeenAt: string;
}

interface ProductSkuMappingData {
  mappings: ProductSkuMapping[];
  categories: string[];
  items: ProductSkuMappingItemOption[];
  unmappedProducts: UnmappedProductOption[];
}

export const PRODUCT_SKU_CHANNEL_OPTIONS = [
  { value: "cyberbiz", label: "CYBERBIZ（官網 / POS）" },
  { value: "shopee", label: "蝦皮" },
] as const;

export function productSkuChannelLabel(channel: string): string {
  return PRODUCT_SKU_CHANNEL_OPTIONS.find((option) => option.value === channel)?.label
    ?? (channel === "legacy" ? "未分類（舊資料）" : channel);
}

export function useProductSkuMappings() {
  return useQuery({
    queryKey: PRODUCT_SKU_MAPPINGS_KEY,
    queryFn: async () => {
      const response = await fetch("/api/tools/product-sku-mappings", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as ProductSkuMappingData;
    },
  });
}

export function useCreateProductSkuMapping() {
  return useSkuMappingMutation(
    (payload: {
      channel?: string;
      externalName: string;
      externalSku: string;
      components: ProductBundleComponentInput[];
    }) => write<{ id: string; channel: string; externalName: string; externalSku: string }>(
      "/api/tools/product-sku-mappings",
      "POST",
      payload,
    ),
  );
}

export function useUpdateProductSkuMapping() {
  return useSkuMappingMutation(
    ({ mappingId, ...payload }: {
      mappingId: string;
      channel?: string;
      externalName: string;
      externalSku: string;
      components: ProductBundleComponentInput[];
    }) => write<{ id: string; channel: string; externalName: string; externalSku: string }>(
      `/api/tools/product-sku-mappings/${mappingId}`,
      "PATCH",
      payload,
    ),
  );
}

export function useDeleteProductSkuMapping() {
  return useSkuMappingMutation(
    ({ mappingId }: { mappingId: string }) =>
      write<{ ok: true }>(`/api/tools/product-sku-mappings/${mappingId}`, "DELETE"),
  );
}

/** 刻意不納入報表的外部 SKU（補寄、已下架這類）。 */
export interface ReportSkuIgnore {
  id: string;
  channel: string;
  externalSku: string;
  reason: string;
  createdAt: string;
}

export function useReportSkuIgnores() {
  return useQuery({
    queryKey: REPORT_SKU_IGNORES_KEY,
    queryFn: async () => {
      const response = await fetch("/api/tools/report-sku-ignores", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as { ignores: ReportSkuIgnore[] };
    },
  });
}

export function useAddReportSkuIgnore() {
  return useSkuMappingMutation(
    (payload: { channel: string; externalSku: string; reason?: string }) =>
      write<ReportSkuIgnore>("/api/tools/report-sku-ignores", "POST", payload),
  );
}

export function useDeleteReportSkuIgnore() {
  return useSkuMappingMutation(
    (id: string) => write<{ ok: true }>(`/api/tools/report-sku-ignores/${id}`, "DELETE"),
  );
}

