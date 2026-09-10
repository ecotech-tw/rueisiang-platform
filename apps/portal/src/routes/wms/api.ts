import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

/**
 * 倉儲的資料存取。
 *
 * 跟 CRM 最大的不同：**只有一支查詢**。`GET /api/wms/warehouse` 一次回完倉位、
 * 商品、分類與畫布設定，所以搜尋、篩選、排序、分頁全都在前端做。
 *
 * 這樣選的理由是倉儲的量級跟客戶不同——客戶有一萬多筆，非得後端分頁不可；
 * 倉庫的品項是幾百筆，一次拉完之後換頁與排序都不必再等網路。而且地圖頁與
 * 庫存頁看的是同一份資料，共用一份快取才不會兩頁各查一次、還可能不一致。
 *
 * 哪天品項真的多到拉不動，再把篩選推回後端——那時要改的只有這個檔案。
 */

export interface ShelfLevel {
  id: string;
  name: string;
}

export interface Zone {
  id: string;
  code: string;
  name: string;
  category: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shelfLevels: ShelfLevel[];
  notes: string;
  imageCount: number;
}

/** 一個品項跟 CYBERBIZ 款式的連結。沒連結時是 null。 */
export interface CyberbizLink {
  cyberbizProductId: string;
  cyberbizVariantId: string;
  sku: string;
  syncStatus: string;
  /** 官網目錄鏡像最後同步時間；庫存同步結果記在 activity_events。 */
  syncedAt: string;
}

export interface InventoryItem {
  id: string;
  source: "cyberbiz" | "custom";
  sku: string | null;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  minStock: number;
  zoneId: string | null;
  shelfLevel: string | null;
  notes: string;
  updatedAt: string;
  /** 連到 CYBERBIZ 的哪一個款式。地圖與庫存頁都要看得出來。 */
  cyberbiz: CyberbizLink | null;
}

export interface ProductCategory {
  id: string;
  name: string;
  color: string;
  parentId?: string | null;
  depth?: number;
}

export interface LayoutElement {
  id: string;
  label: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Warehouse {
  settings: { canvasWidth: number; canvasHeight: number };
  zones: Zone[];
  layoutElements: LayoutElement[];
  categories: ProductCategory[];
  items: InventoryItem[];
}

/** 所有倉儲的快取都掛在這個 key 底下，寫入之後一次失效。 */
const WAREHOUSE_KEY = ["wms", "warehouse"] as const;
const ACTIVITY_KEY = ["wms", "activity"] as const;

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string; message?: string } | null;
  throw new Error(body?.message ?? body?.error ?? `操作失敗（${response.status}）`);
}

export function useWarehouse() {
  return useQuery({
    queryKey: WAREHOUSE_KEY,
    queryFn: async () => {
      const response = await fetch("/api/wms/warehouse", { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json()) as Warehouse;
    },
  });
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

/**
 * 每一支 WMS 寫入都失效商品庫存、SKU 對應與操作紀錄快取。
 *
 * 逐一列出 key 而不是用 ["wms"] 前綴：那個前綴也會命中 ["wms","catalog"]，
 * 而它是代理到 CYBERBIZ API 的，不該被一次倉儲寫入連帶重打。
 *
 * 用 void 不回傳那個 promise：回傳的話 react-query 會等它跑完才呼叫 mutate 層的
 * onSuccess，而那時候該列往往已經因為重新載入而被換掉，通知就再也不會出現。
 * 這是 CRM 那邊踩過的坑。
 */
function useWarehouseMutation<TArgs, TResult>(
  run: (args: TArgs) => Promise<TResult>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WAREHOUSE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["items", "catalog"] });
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
    },
  });
}

export interface ItemForm {
  sku: string;
  name: string;
  category: string;
  quantity: number;
  unit: string;
  minStock: number;
  zoneId: string | null;
  shelfLevel: string | null;
  notes: string;
}

export function useCreateCatalogItem() {
  return useWarehouseMutation((input: ItemForm & { categoryId?: string | null }) =>
    write<{ id: string; sku: string }>("/api/items/catalog", "POST", input),
  );
}

/**
 * 更新時可以省略安全庫存。
 *
 * 已連結 CYBERBIZ 的商品以官網為準，後端收不到這個欄位就是「不要動」；送一個
 * 過期的值反而會被判成「要改成不同的值」而擋下來。新增時沒有這個問題，所以只有
 * 更新這條路放寬。
 */
export type ItemUpdate = Omit<ItemForm, "minStock"> & { minStock?: number };

export function useUpdateItem() {
  /*
   * 送出時不帶 quantity——後端的 updateItem 本來就不理它，這裡也不送，
   * 免得日後有人看到 payload 裡有數量就以為改得動。要改數量走盤點。
   */
  return useWarehouseMutation(({ id, quantity: _quantity, ...input }: ItemUpdate & { id: string }) =>
    write<{ ok: true }>(`/api/wms/items/${id}`, "PATCH", input),
  );
}

export function useDeleteItem() {
  return useWarehouseMutation((id: string) => write<{ ok: true }>(`/api/wms/items/${id}`, "DELETE"));
}

export interface CountResult {
  quantity: number;
  changed: boolean;
  /** 盤完低於安全庫存。不是錯誤，但值得在通知裡講一聲。 */
  belowMinimum: boolean;
}

export function useCountItem() {
  return useWarehouseMutation(({ id, quantity, note }: { id: string; quantity: number; note?: string }) =>
    write<CountResult>(`/api/wms/items/${id}/count`, "PATCH", { quantity, note }),
  );
}

/**
 * WMS 使用的色階。與 packages/db 的 WAREHOUSE_CATEGORY_COLORS 同一份清單——那邊加一個，
 * 這裡與 @theme 的 --color-tone-* 都要跟著補。後端會擋掉不認得的值，
 * 所以漏了不會寫進髒資料，只是選不到。
 */
export const WAREHOUSE_CATEGORY_COLORS = [
  "rose", "sky", "mint", "amber", "violet", "teal", "peach", "slate", "lime", "sand",
] as const;

/** 地圖標示仍沿用同一組視覺色階；分類頁使用上面語意更清楚的名稱。 */
export const CATEGORY_COLORS = WAREHOUSE_CATEGORY_COLORS;

export function useCreateWarehouseCategory() {
  return useWarehouseMutation((input: { name: string; color: string }) =>
    write<{ id: string }>("/api/wms/categories", "POST", input),
  );
}

export function useUpdateWarehouseCategory() {
  return useWarehouseMutation(({ id, ...input }: { id: string; name?: string; color?: string }) =>
    write<{ ok: true }>(`/api/wms/categories/${id}`, "PATCH", input),
  );
}

export function useDeleteWarehouseCategory() {
  return useWarehouseMutation((id: string) =>
    write<{ ok: true }>(`/api/wms/categories/${id}`, "DELETE"),
  );
}

// ───────────────────────────── 倉位與地圖 ─────────────────────────────

export interface ZoneForm {
  code: string;
  name: string;
  category: string;
  color: string;
  notes: string;
  shelfLevels: ShelfLevel[];
}

export function useCreateZone() {
  return useWarehouseMutation((input: ZoneForm) => write<{ id: string }>("/api/wms/zones", "POST", input));
}

/**
 * 改倉位。**只送有帶的欄位**——拖曳只送 x/y，後端會保留其他值。
 * 整包送的話，拖一下就會把當下畫面上的所有欄位覆寫回去，包含別人剛改過的。
 */
export function useUpdateZone() {
  return useWarehouseMutation(({ id, ...input }: Partial<ZoneForm> & { id: string; x?: number; y?: number; width?: number; height?: number }) =>
    write<{ ok: true }>(`/api/wms/zones/${id}`, "PATCH", input),
  );
}

export function useDeleteZone() {
  return useWarehouseMutation((id: string) => write<{ ok: true }>(`/api/wms/zones/${id}`, "DELETE"));
}

export interface ElementForm {
  label: string;
  color: string;
}

export function useCreateElement() {
  return useWarehouseMutation((input: ElementForm) =>
    write<{ id: string }>("/api/wms/elements", "POST", input),
  );
}

export function useUpdateElement() {
  return useWarehouseMutation(({ id, ...input }: Partial<ElementForm> & { id: string; x?: number; y?: number; width?: number; height?: number }) =>
    write<{ ok: true }>(`/api/wms/elements/${id}`, "PATCH", input),
  );
}

export function useDeleteElement() {
  return useWarehouseMutation((id: string) => write<{ ok: true }>(`/api/wms/elements/${id}`, "DELETE"));
}

export function useUpdateSettings() {
  return useWarehouseMutation((input: { canvasWidth: number; canvasHeight: number }) =>
    write<{ canvasWidth: number; canvasHeight: number }>("/api/wms/settings", "PATCH", input),
  );
}

// ───────────────────────────── 倉位照片 ─────────────────────────────

export interface ZoneImage {
  id: string;
  zoneId: string;
  filename: string;
  contentType: string;
  size: number;
  createdAt: string;
}

/**
 * 一個倉位的照片。
 *
 * 不放進 /warehouse 一起回：地圖上只需要知道「有幾張」（那個已經在 imageCount
 * 裡了），完整清單只有打開抽屜的那一個倉位需要。全部一起回的話，每次任何寫入
 * 之後都要重新傳一遍所有倉位的照片索引。
 */
export function useZoneImages(zoneId: string) {
  return useQuery({
    queryKey: ["wms", "zone-images", zoneId],
    queryFn: async () => {
      const response = await fetch(`/api/wms/zones/${zoneId}/images`, { credentials: "same-origin" });
      if (!response.ok) await readError(response);
      return (await response.json() as { images: ZoneImage[] }).images;
    },
  });
}

/** 照片變動要同時失效兩個 key：照片清單本身，以及地圖上的張數。 */
function useZoneImageMutation<TArgs>(run: (args: TArgs) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: WAREHOUSE_KEY });
      void queryClient.invalidateQueries({ queryKey: ["wms", "zone-images"] });
      // 上傳與刪除照片都會寫 activity；收斂前綴之後要自己補上，否則操作紀錄會停在舊資料。
      void queryClient.invalidateQueries({ queryKey: ACTIVITY_KEY });
    },
  });
}

export function useUploadZoneImage() {
  return useZoneImageMutation(async ({ zoneId, file }: { zoneId: string; file: File }) => {
    const form = new FormData();
    form.append("file", file);
    /*
     * 不要自己設 Content-Type：multipart 的 boundary 只有 FormData 自己組得出來，
     * 手動寫一個 multipart/form-data 上去，伺服器那端會解不開。
     */
    const response = await fetch(`/api/wms/zones/${zoneId}/images`, {
      method: "POST",
      credentials: "same-origin",
      body: form,
    });
    if (!response.ok) await readError(response);
    return response.json();
  });
}

export function useDeleteZoneImage() {
  return useZoneImageMutation((id: string) => write<{ ok: true }>(`/api/wms/images/${id}`, "DELETE"));
}

// ───────────────────────── CYBERBIZ 連結 ─────────────────────────

/**
 * 用 SKU 把品項連到官網的款式。
 *
 * 連結是用 **SKU 去官網找**，不是讓人自己貼 product_id／variant_id——那兩個
 * 沒有人記得住，貼錯又不會馬上出事（要等下一次同步才發現數量寫到別的商品上）。
 */
export function useLinkCyberbiz() {
  return useWarehouseMutation(({ id, sku }: { id: string; sku: string }) =>
    write<{ id: string; remote: { productName: string; variantName: string; quantity: number } }>(
      `/api/wms/items/${id}/cyberbiz-link`,
      "POST",
      { sku },
    ),
  );
}

export interface CyberbizSyncResult {
  updated: number;
  unchanged: number;
  failed: number;
  linked: number;
}

/** 從 CYBERBIZ 回讀數量與安全庫存；不帶 itemId 就同步全部已連結品項。 */
export function useSyncCyberbiz() {
  return useWarehouseMutation(({ itemId }: { itemId?: string } = {}) =>
    write<CyberbizSyncResult>("/api/wms/cyberbiz/sync", "POST", itemId ? { itemId } : {}),
  );
}
