import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import { Pager } from "../../shell/Pager.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";

/**
 * CYBERBIZ 的公司倉商品，以及它們跟 WMS 品項的連結狀態。
 *
 * 這一頁看的是**官網**有什麼，不是 WMS 有什麼——所以資料是現拉的（有快取），
 * 不是 /warehouse 那一份。兩邊的交集是「已連結」的那些款式。
 */

interface CatalogItem {
  productId: string;
  productName: string;
  variantId: string;
  variantName: string;
  sku: string;
  quantity: number;
  safetyQuantity: number;
  published: boolean;
  /** 有值代表已經連到 WMS 的哪一個品項。 */
  linkedItemId: string | null;
}

interface CatalogPage {
  items: CatalogItem[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: string;
  /** 這份是讀快取來的還是現拉的。 */
  cached: boolean;
  /** 官網還有沒翻完的頁。 */
  truncated: boolean;
}

const PAGE_SIZES = [25, 50, 100] as const;

interface Filters {
  search: string;
  link: string;
  stock: string;
  page: number;
  pageSize: number;
}

const DEFAULTS: Filters = { search: "", link: "all", stock: "all", page: 1, pageSize: 25 };

function formatTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

export function Cyberbiz() {
  usePageTitle("CYBERBIZ 庫存");
  const [filters, setFilters] = useState<Filters>(DEFAULTS);
  const client = useQueryClient();
  const toast = useToast();
  const { permissions } = useSession();
  const canSync = permissions.has("wms:sync:trigger");

  const query = useQuery({
    queryKey: ["wms", "catalog", filters],
    queryFn: async () => {
      const params = new URLSearchParams({
        search: filters.search,
        link: filters.link,
        stock: filters.stock,
        page: String(filters.page),
        pageSize: String(filters.pageSize),
      });
      const response = await fetch(`/api/wms/cyberbiz/catalog?${params}`, { credentials: "same-origin" });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `讀取失敗（${response.status}）`);
      }
      return (await response.json()) as CatalogPage;
    },
    placeholderData: keepPreviousData,
  });

  /** 重新從官網拉一份，跳過快取。 */
  const refresh = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/wms/cyberbiz/catalog?refresh=1", { credentials: "same-origin" });
      if (!response.ok) throw new Error(`重新讀取失敗（${response.status}）`);
      return response.json();
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["wms", "catalog"] });
    },
  });

  /** 把官網的數量同步進 WMS（只動已連結的品項）。 */
  const sync = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/wms/cyberbiz/sync", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json().catch(() => null) as
        | { updated: number; unchanged: number; failed: number; linked: number; error?: string }
        | null;
      if (!response.ok) throw new Error(body?.error ?? `同步失敗（${response.status}）`);
      return body!;
    },
    onSuccess: (result) => {
      toast.show(
        result.linked === 0
          ? "還沒有任何商品連結到 CYBERBIZ"
          : `同步完成：更新 ${result.updated}、無變化 ${result.unchanged}、失敗 ${result.failed}`,
      );
      void client.invalidateQueries({ queryKey: ["wms"] });
    },
  });

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const error = query.error ?? refresh.error ?? sync.error;

  return (
    <div className="page fills">
      <header className="page-head">
        <div className="page-head-row">
          <div>
            <h1>CYBERBIZ 庫存</h1>
            <p className="muted">
              官網公司倉的商品與數量。門市的庫存不在這裡——那不歸倉儲管。
            </p>
          </div>
          {canSync ? (
            <div className="head-actions">
              <button
                type="button"
                className="ghost-button"
                disabled={refresh.isPending}
                onClick={() => refresh.mutate()}
              >
                {refresh.isPending ? "讀取中…" : "重新讀取官網"}
              </button>
              <button
                type="button"
                className="primary-button with-icon"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                <Icon name="sync" />
                <span>{sync.isPending ? "同步中…" : "同步到庫存"}</span>
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <section className="panel grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <input
            className="search-input"
            aria-label="搜尋"
            type="search"
            placeholder="搜尋商品名稱、款式或 SKU"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <select
            aria-label="連結狀態"
            value={filters.link}
            onChange={(event) => update({ link: event.target.value })}
          >
            <option value="all">全部商品</option>
            <option value="linked">已連結倉儲</option>
            <option value="unlinked">尚未連結</option>
          </select>
          <select
            aria-label="庫存狀態"
            value={filters.stock}
            onChange={(event) => update({ stock: event.target.value })}
          >
            <option value="all">全部庫存</option>
            <option value="available">有庫存</option>
            <option value="low">低於安全庫存</option>
            <option value="zero">零庫存</option>
          </select>
        </form>

        {error ? <p className="form-error" role="alert">{error.message}</p> : null}

        {/*
          * 這份資料是什麼時候拉的要講出來——快取一天，看的人有權知道自己看的是
          * 不是即時的數字。
          */}
        {data ? (
          <p className="muted table-note catalog-note">
            {data.cached ? "讀自快取，" : ""}資料時間 {formatTime(data.fetchedAt)}
            {data.truncated ? "・商品太多，只讀了前面幾頁" : ""}
          </p>
        ) : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>商品</th>
                <th>SKU</th>
                <th className="numeric">官網庫存</th>
                <th className="numeric">安全庫存</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((item) => {
                const low = item.quantity > 0 && item.quantity <= item.safetyQuantity;
                return (
                  <tr key={item.variantId}>
                    <td data-label="商品">
                      <div className="cell-strong">{item.productName}</div>
                      <div className="cell-sub">{item.variantName}</div>
                    </td>
                    <td data-label="SKU" className="whitespace-nowrap">{item.sku || "—"}</td>
                    <td data-label="官網庫存" className="numeric">
                      <span className={item.quantity === 0 || low ? "stock-low" : undefined}>
                        {item.quantity.toLocaleString("zh-TW")}
                      </span>
                    </td>
                    <td data-label="安全庫存" className="numeric cell-sub">
                      {item.safetyQuantity.toLocaleString("zh-TW")}
                    </td>
                    <td data-label="狀態">
                      {item.linkedItemId ? (
                        <span className="status status-sync-synced">已連結倉儲</span>
                      ) : (
                        <span className="status quiet">尚未連結</span>
                      )}
                      {!item.published ? <span className="status quiet">未上架</span> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">讀取官網商品中…</p> : null}

        {data && data.items.length === 0 ? (
          <p className="muted table-note">
            {filters.search || filters.link !== "all" || filters.stock !== "all"
              ? "沒有符合條件的商品。"
              : "官網的公司倉還沒有商品。"}
          </p>
        ) : null}

        {data && data.total > 0 ? (
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            pageSizes={PAGE_SIZES}
            totalPages={totalPages}
            totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 個款式`}
            onPage={(page) => update({ page })}
            onPageSize={(pageSize) => update({ pageSize })}
          />
        ) : null}
      </section>
    </div>
  );
}
