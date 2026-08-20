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

export interface InventoryItem {
  id: string;
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
}

export interface ProductCategory {
  id: string;
  name: string;
  color: string;
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

async function readError(response: Response): Promise<never> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null;
  throw new Error(body?.error ?? `操作失敗（${response.status}）`);
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
 * 每一支寫入都失效同一個 key。
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

export function useCreateItem() {
  return useWarehouseMutation((input: ItemForm) =>
    write<{ id: string }>("/api/wms/items", "POST", input),
  );
}

export function useUpdateItem() {
  /*
   * 送出時不帶 quantity——後端的 updateItem 本來就不理它，這裡也不送，
   * 免得日後有人看到 payload 裡有數量就以為改得動。要改數量走盤點。
   */
  return useWarehouseMutation(({ id, quantity: _quantity, ...input }: ItemForm & { id: string }) =>
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
