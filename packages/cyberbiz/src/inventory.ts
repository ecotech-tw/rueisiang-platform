import { cyberbizRequest, type CyberbizConfig, type RequestOptions } from "./http.js";

/**
 * CYBERBIZ 的商品庫存 API。
 *
 * 這一份跟 customers.ts 是同一個官網的兩個不同區塊：那邊管會員，這邊管商品與
 * 庫存數量。共用 http.ts 的重試、錯誤訊息與逾時。
 *
 * 舊系統的 lib/cyberbiz-inventory.ts 有 843 行，其中很大一塊是 Redis 快取。
 * 平台沒有 Redis，快取那一段不搬——這裡只留「跟官網講話」的部分，要不要快取是
 * 呼叫端的問題，不是 client 的。
 */

export interface CyberbizInventoryItem {
  productId: string;
  productName: string;
  variantId: string;
  variantName: string;
  sku: string;
  quantity: number;
  /** 官網那邊的安全庫存。WMS 的 minStock 會跟它對齊。 */
  safetyQuantity: number;
  inventoryManagement: boolean;
  published: boolean;
  /** 空字串代表公司倉；有值代表某家門市的庫存。 */
  posShopId: string;
  posShopName: string;
  updatedAt: string | null;
}

interface RawVariant {
  id?: unknown;
  name?: string;
  sku?: string;
  inventory_quantity?: unknown;
  safety_inventory_quantity?: unknown;
  inventory_management?: unknown;
  updated_at?: string | null;
}

interface RawProduct {
  id?: unknown;
  title?: string;
  published?: unknown;
  updated_at?: string | null;
  pos_shop?: { id?: unknown; name?: string } | null;
  product_variants?: RawVariant[];
}

/**
 * 一個商品可能有很多款式，庫存掛在款式上。攤平成「一列一個款式」——WMS 的
 * 一個品項連結的也是款式（cyberbiz_variant_id），不是商品。
 */
export function flattenProducts(products: RawProduct[]): CyberbizInventoryItem[] {
  return products.flatMap((product) => {
    if (product.id === null || product.id === undefined) return [];
    return (product.product_variants ?? [])
      .filter((variant) => variant.id !== null && variant.id !== undefined)
      .map((variant) => ({
        productId: String(product.id),
        productName: product.title?.trim() || "未命名商品",
        variantId: String(variant.id),
        variantName: variant.name?.trim() || "單一款式",
        sku: variant.sku?.trim() || "",
        quantity: Math.round(Number(variant.inventory_quantity) || 0),
        safetyQuantity: Math.max(0, Math.round(Number(variant.safety_inventory_quantity) || 0)),
        inventoryManagement: Boolean(variant.inventory_management),
        published: Boolean(product.published),
        posShopId:
          product.pos_shop?.id === null || product.pos_shop?.id === undefined
            ? ""
            : String(product.pos_shop.id),
        posShopName: product.pos_shop?.name?.trim() || "",
        updatedAt: variant.updated_at ?? product.updated_at ?? null,
      }));
  });
}

/**
 * 這是公司倉的商品嗎？
 *
 * 官網把門市的庫存也放在同一個商品清單裡，用 pos_shop 區分。WMS 管的是公司倉，
 * 沒有把門市濾掉的話，同一個 SKU 會出現好幾筆、數量還互不相同。
 */
export function isCompanyProduct(item: CyberbizInventoryItem): boolean {
  return item.posShopId === "";
}

function readProducts(payload: unknown): RawProduct[] {
  if (Array.isArray(payload)) return payload as RawProduct[];
  const root = (payload ?? {}) as Record<string, unknown>;
  const candidates = [root.products, root.data];
  for (const candidate of candidates) if (Array.isArray(candidate)) return candidate as RawProduct[];
  return [];
}

/**
 * 一次最多拿幾筆。
 *
 * **50，不是 100。** 官網對超過 50 的 per_page 直接回 500「系統有誤」，不是
 * 悄悄截短——所以這個數字不能亂調大。舊系統用的也是 50。
 */
export const MAX_PAGE_SIZE = 50;

export interface CyberbizInventoryClient {
  /** 拿一頁商品。query 有值就走搜尋端點。 */
  fetchPage(options?: { page?: number; perPage?: number; query?: string }): Promise<CyberbizInventoryItem[]>;
  /** 一個商品的所有款式。更新數量前後都要用它重讀。 */
  fetchProduct(productId: string): Promise<CyberbizInventoryItem[]>;
  /** 把公司倉的數量調整成 target。回報調整前後與是否真的動過。 */
  setCompanyQuantity(input: {
    productId: string;
    variantId: string;
    sku: string;
    targetQuantity: number;
  }): Promise<{ previousQuantity: number; quantity: number; safetyQuantity: number; changed: boolean }>;
}

export function createInventoryClient(
  config: CyberbizConfig,
  options: RequestOptions = {},
): CyberbizInventoryClient {
  const request = (path: string, extra: RequestOptions = {}) =>
    cyberbizRequest(config, path, { ...options, ...extra });

  const fetchProduct = async (productId: string) => {
    const { payload } = await request(`/v1/products/${encodeURIComponent(productId)}`);
    // 單一商品可能被包在 product 底下，也可能就是根物件。
    const root = (payload ?? {}) as Record<string, unknown>;
    const product = (root.product ?? payload) as RawProduct;
    /*
     * **`/v1/products/{id}` 的回應裡沒有 `id`。** 列表端點有，單一商品端點沒有
     * ——它大概覺得你既然是拿 id 來問的，就不必再告訴你一次。
     *
     * 但 flattenProducts 看到沒有 id 的商品會整個丟掉，於是這裡永遠回空陣列，
     * 而呼叫端把「空陣列」讀成「連結失效」。結果是盤點推不上去、官網也同步不
     * 回來，兩個方向一起壞，錯誤訊息還指向完全無辜的 SKU。
     *
     * 用問的時候就知道的那個 id 補上。萬一哪天官網真的開始回 id，以它為準。
     */
    return flattenProducts([{ ...product, id: product.id ?? productId }]);
  };

  return {
    async fetchPage({ page = 1, perPage = MAX_PAGE_SIZE, query = "" } = {}) {
      const params = new URLSearchParams({
        page: String(page),
        per_page: String(Math.min(perPage, MAX_PAGE_SIZE)),
      });
      if (query) params.set("q", query);
      const { payload } = await request(`/v1/products${query ? "/search" : ""}?${params}`);
      return flattenProducts(readProducts(payload));
    },

    fetchProduct,

    /**
     * 調整公司倉的數量。
     *
     * 官網的 API 收的是**差額**（surplus／loss）而不是「設成 N」，所以要先讀現況
     * 算差額。三個步驟一個都不能少：
     *
     * 1. 先讀：不讀就不知道要調多少，而且能順便確認連結還有效。
     * 2. 送差額。
     * 3. **再讀一次驗證**：官網回 200 不代表結果就是我們要的（可能同時有別的
     *    調整、可能它自己夾了值）。對不上就丟錯，讓呼叫端把這個連結標成失敗，
     *    而不是留下一個「以為同步過了」的狀態。
     */
    async setCompanyQuantity({ productId, variantId, sku, targetQuantity }) {
      const target = Math.max(0, Math.round(targetQuantity));
      const wanted = sku.trim().toUpperCase();

      const before = await fetchProduct(productId);
      const current = before.find(
        (item) => isCompanyProduct(item)
          && item.variantId === variantId
          && item.sku.trim().toUpperCase() === wanted,
      );
      if (!current) {
        throw new Error("CYBERBIZ 的商品連結已失效：找不到原本的 product_id、variant_id 與 SKU。");
      }

      const delta = target - current.quantity;
      if (delta === 0) {
        return {
          previousQuantity: current.quantity,
          quantity: target,
          safetyQuantity: current.safetyQuantity,
          changed: false,
        };
      }

      // stock_adjustments 是差額 API，不是冪等的 absolute update。若上游已套用
      // 但 response 遺失，重送同一 delta 會把庫存加倍；模糊失敗交給呼叫端
      // 重新讀取並 reconcile，不能由通用 HTTP client 自動 retry。
      await request("/v1/stock_adjustments", {
        method: "POST",
        retries: 0,
        body: {
          // 0 是公司倉。門市的庫存不歸 WMS 管。
          pos_shop_id: 0,
          items: [{ sku: sku.trim(), quantity: Math.abs(delta), type: delta > 0 ? "surplus" : "loss" }],
        },
      });

      const after = await fetchProduct(productId);
      const verified = after.find((item) => isCompanyProduct(item) && item.variantId === variantId);
      if (!verified || verified.quantity !== target) {
        throw new Error(
          `CYBERBIZ 已接受庫存調整，但重新讀取是 ${verified?.quantity ?? "未知"}，預期 ${target}。`,
        );
      }

      return {
        previousQuantity: current.quantity,
        quantity: target,
        safetyQuantity: verified.safetyQuantity,
        changed: true,
      };
    },
  };
}
