import { useMemo, useState } from "react";
import { useSession } from "../../auth/session.js";
import { ConfirmDialog } from "../../shell/ConfirmDialog.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
import { useToast } from "../../shell/Toast.js";
import { usePageTitle } from "../../shell/usePageTitle.js";
import { Alert, Button, FilterInput, FilterSelect, PageHeader, Panel } from "../../ui/index.js";
import {
  useDeleteItem,
  useWarehouse,
  type InventoryItem,
  type ProductCategory,
  type Zone,
} from "./api.js";
import { CountDialog } from "./CountDialog.js";
import { ItemForm } from "./ItemForm.js";
import { EnrollItemDialog } from "./EnrollItemDialog.js";

const PAGE_SIZES = [10, 25, 50, 100] as const;

interface Filters {
  search: string;
  category: string;
  zone: string;
  /** all／low：只看低於安全庫存的。 */
  stock: string;
  page: number;
  pageSize: number;
  sortField: string;
  sortDirection: "asc" | "desc";
}

const DEFAULT_FILTERS: Filters = {
  search: "",
  category: "all",
  zone: "all",
  stock: "all",
  page: 1,
  pageSize: 25,
  sortField: "name",
  sortDirection: "asc",
};

/** 未指定倉位的商品用這個值篩選。空字串會跟「全部」混淆，所以給它一個名字。 */
const NO_ZONE = "__none__";

function isLow(item: InventoryItem): boolean {
  return item.quantity < item.minStock;
}

/**
 * 一列商品在哪裡。
 *
 * 倉位被刪掉、或商品沒指定倉位時都會走到「未指定」——地圖上找不到的東西，
 * 在這一欄至少要看得出來是「還沒放」而不是空白。
 */
function placeOf(item: InventoryItem, zones: Zone[]): string {
  const zone = zones.find((candidate) => candidate.id === item.zoneId);
  if (!zone) return "未指定";
  const level = zone.shelfLevels.find((candidate) => candidate.id === item.shelfLevel);
  return level ? `${zone.code}・${level.name}` : zone.code;
}

function ItemRow({
  item,
  zones,
  categories,
  canWrite,
  canCount,
  onEdit,
  onCount,
  onDelete,
  busy,
}: {
  item: InventoryItem;
  zones: Zone[];
  categories: ProductCategory[];
  canWrite: boolean;
  canCount: boolean;
  onEdit: () => void;
  onCount: () => void;
  onDelete: () => void;
  busy: boolean;
}) {
  const category = categories.find((candidate) => candidate.name === item.category);
  const low = isLow(item);

  return (
    <tr>
      <td data-label="商品">
        <div className="cell-strong">{item.name}</div>
        <div className="cell-sub">{item.sku || "沒有 SKU"}</div>
      </td>
      <td data-label="分類">
        {/* 顏色沿用分類自己的設定，跟分類管理頁看到的一致。 */}
        <span className={`status status-tone-${category?.color ?? "slate"}`}>{item.category}</span>
      </td>
      <td data-label="位置" className="whitespace-nowrap">{placeOf(item, zones)}</td>
      {/*
        * 數字與單位包在同一個 span 裡。手機版的 td 是兩欄 grid，拆成兩個元素的話
        * 單位會被當成下一個 grid item 掉到下一列去——「40」跟「個」分家。
        */}
      <td data-label="數量" className="numeric">
        <span className={low ? "stock-low" : undefined}>
          {item.quantity.toLocaleString("zh-TW")}
          <span className="cell-sub"> {item.unit}</span>
        </span>
      </td>
      <td data-label="安全庫存" className="numeric cell-sub">{item.minStock.toLocaleString("zh-TW")}</td>
      <td data-label="狀態">
        {low ? <span className="status status-sync-failed">需要補貨</span> : <span className="status quiet">正常</span>}
        {/*
          * 有連結才顯示，沒連結不顯示「未連結」——大部分商品本來就不連，
          * 每一列都掛一個「未連結」只是把整欄變成雜訊。同步失敗才要跳出來。
          */}
        {item.cyberbiz ? (
          <span
            className={`status ${item.cyberbiz.syncStatus === "failed" ? "status-sync-failed" : "status-sync-synced"}`}
            title={item.cyberbiz.lastError || `已連結 CYBERBIZ 款式 ${item.cyberbiz.cyberbizVariantId}`}
          >
            {item.cyberbiz.syncStatus === "failed" ? "同步失敗" : "CYBERBIZ"}
          </span>
        ) : null}
      </td>
      {canWrite || canCount ? (
        <td data-label="操作">
          <div className="row-actions">
            {canCount ? (
              <Button
                variant="secondary"
                className="count-action"
                onClick={onCount}
                disabled={busy}
                title="盤點這項商品"
                aria-label={`盤點 ${item.name}`}
              >
                盤點
              </Button>
            ) : null}
            {canWrite ? (
              <>
                <Button
                  variant="icon"
                  icon="edit"
                  onClick={onEdit}
                  disabled={busy}
                  title="編輯商品資料"
                  aria-label={`編輯 ${item.name}`}
                />
                <Button
                  variant="icon"
                  className="danger"
                  icon="trash"
                  onClick={onDelete}
                  disabled={busy}
                  title="刪除這項商品"
                  aria-label={`刪除 ${item.name}`}
                />
              </>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

export function Inventory() {
  usePageTitle("商品庫存");
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | "new" | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [counting, setCounting] = useState<InventoryItem | null>(null);
  const [deleting, setDeleting] = useState<InventoryItem | null>(null);

  const query = useWarehouse();
  const remove = useDeleteItem();
  const toast = useToast();
  const { permissions } = useSession();
  const canWrite = permissions.has("wms:inventory:write");
  const canCount = permissions.has("wms:inventory:count");

  const zones = query.data?.zones ?? [];
  const categories = query.data?.categories ?? [];
  const items = query.data?.items ?? [];

  /*
   * 篩選、排序、分頁都在這裡做——後端一次回完整份資料，見 api.ts 的說明。
   * 用 useMemo 是因為每次打字都會重跑一遍，而排序在幾百筆上不是免費的。
   */
  const filtered = useMemo(() => {
    const term = filters.search.trim().toLowerCase();
    const result = items.filter((item) => {
      if (filters.category !== "all" && item.category !== filters.category) return false;
      if (filters.zone === NO_ZONE ? item.zoneId !== null : filters.zone !== "all" && item.zoneId !== filters.zone) {
        return false;
      }
      if (filters.stock === "low" && !isLow(item)) return false;
      if (!term) return true;
      // 備註也一起搜：「破損」「暫放」這種線索常常只寫在那裡。
      return [item.name, item.sku ?? "", item.category, item.notes]
        .some((value) => value.toLowerCase().includes(term));
    });

    const direction = filters.sortDirection === "asc" ? 1 : -1;
    return [...result].sort((a, b) => {
      switch (filters.sortField) {
        case "quantity":
          return (a.quantity - b.quantity) * direction;
        case "minStock":
          return (a.minStock - b.minStock) * direction;
        case "sku":
          // 沒有 SKU 的一律排到最後，不管升冪降冪——它們不是「最小的 SKU」。
          if (!a.sku || !b.sku) return a.sku ? -1 : b.sku ? 1 : 0;
          return a.sku.localeCompare(b.sku) * direction;
        default:
          return a.name.localeCompare(b.name, "zh-TW") * direction;
      }
    });
  }, [items, filters.search, filters.category, filters.zone, filters.stock, filters.sortField, filters.sortDirection]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / filters.pageSize));
  // 篩選變窄之後頁碼可能落在範圍外，夾回來而不是顯示一頁空的。
  const page = Math.min(filters.page, totalPages);
  const visible = filtered.slice((page - 1) * filters.pageSize, page * filters.pageSize);

  const lowCount = items.filter(isLow).length;
  const activeFilterCount = [filters.category, filters.zone, filters.stock].filter(
    (value) => value !== "all",
  ).length;

  function update(patch: Partial<Filters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  return (
    <div className="page fills">
      <PageHeader
        title="商品庫存"
        description={
          <>
              倉庫裡有什麼、放在哪、還剩多少。
              {lowCount ? `目前有 ${lowCount} 項需要補貨。` : null}
          </>
        }
        actions={canWrite ? (
          <div className="row-actions">
            <Button variant="secondary" onClick={() => setEnrolling(true)}>從品項主檔納入</Button>
            <Button
              icon="plus"
              className="add-action"
              onClick={() => setEditing("new")}
              aria-label="新增商品"
            >
              <span>新增商品</span>
            </Button>
          </div>
          ) : null}
      />

      <Panel className="grows">
        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <FilterInput
            label="搜尋"
            className="search-input"
            type="search"
            placeholder="搜尋名稱、SKU、分類或備註"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <Button
            variant="secondary"
            icon="filter"
            className={`filter-toggle${showFilters ? " active" : ""}`}
            aria-expanded={showFilters}
            onClick={() => setShowFilters((open) => !open)}
          >
            篩選
            {activeFilterCount ? <span className="filter-count">{activeFilterCount}</span> : null}
          </Button>
          {activeFilterCount ? (
            <Button
              variant="link"
              onClick={() => update({ category: "all", zone: "all", stock: "all" })}
            >
              清除篩選
            </Button>
          ) : null}

          <div className={`filter-fields${showFilters ? " open" : ""}`}>
            <FilterSelect
              label="分類"
              value={filters.category}
              onChange={(event) => update({ category: event.target.value })}
              options={[
                { value: "all", label: "全部分類" },
                ...categories.map((category) => ({ value: category.name, label: category.name })),
              ]}
            />
            <FilterSelect
              label="倉位"
              value={filters.zone}
              onChange={(event) => update({ zone: event.target.value })}
              options={[
                { value: "all", label: "全部倉位" },
                ...zones.map((zone) => ({ value: zone.id, label: `${zone.code} ${zone.name}` })),
                { value: NO_ZONE, label: "未指定倉位" },
              ]}
            />
            <FilterSelect
              label="庫存狀態"
              value={filters.stock}
              onChange={(event) => update({ stock: event.target.value })}
              options={[
                { value: "all", label: "全部狀態" },
                { value: "low", label: "需要補貨" },
              ]}
            />
          </div>
        </form>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {remove.error ? <Alert tone="danger">{remove.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <SortableHeader label="商品" field="name" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} />
                <th>分類</th>
                <th>位置</th>
                <SortableHeader label="數量" field="quantity" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} className="numeric" />
                <SortableHeader label="安全庫存" field="minStock" active={filters.sortField} direction={filters.sortDirection} onSort={(sortField, sortDirection) => update({ sortField, sortDirection })} className="numeric" />
                <th>狀態</th>
                {canWrite || canCount ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  zones={zones}
                  categories={categories}
                  canWrite={canWrite}
                  canCount={canCount}
                  busy={remove.isPending}
                  onEdit={() => setEditing(item)}
                  onCount={() => setCounting(item)}
                  onDelete={() => setDeleting(item)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}

        {query.data && filtered.length === 0 ? (
          <p className="muted table-note">
            {items.length === 0
              ? "還沒有任何商品。先在倉儲分類管理建一個分類，再回來新增商品。"
              : "沒有符合條件的商品，調整一下搜尋或篩選看看。"}
          </p>
        ) : null}

        {filtered.length > 0 ? (
          <Pager
            page={page}
            pageSize={filters.pageSize}
            pageSizes={PAGE_SIZES}
            totalPages={totalPages}
            totalLabel={`共 ${filtered.length.toLocaleString("zh-TW")} 項`}
            onPage={(next) => setFilters((current) => ({ ...current, page: next }))}
            onPageSize={(pageSize) => update({ pageSize })}
          />
        ) : null}
      </Panel>

      {editing ? (
        <ItemForm
          /*
           * 用 id 去現有清單裡拿最新的那一份，不要直接用 state 裡的物件。
           *
           * state 裡的是「打開對話框那一刻」的快照。連結 CYBERBIZ 之後清單會重新
           * 載入，但快照不會跟著變——畫面上就會看起來像沒成功（實際上資料庫已經
           * 寫進去了）。找不到就退回快照：那代表這一項剛被別人刪掉。
           */
          item={
            editing === "new"
              ? undefined
              : items.find((candidate) => candidate.id === editing.id) ?? editing
          }
          zones={zones}
          categories={categories}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {enrolling ? <EnrollItemDialog categories={categories} zones={zones} onClose={() => setEnrolling(false)} onSuccess={() => { void query.refetch(); }} /> : null}
      {counting ? <CountDialog item={counting} onClose={() => setCounting(null)} /> : null}

      {deleting ? (
        <ConfirmDialog
          title="刪除這項商品？"
          confirmLabel="刪除"
          pending={remove.isPending}
          onCancel={() => setDeleting(null)}
          onConfirm={() =>
            remove.mutate(deleting.id, {
              onSuccess: () => {
                toast.show(`已刪除「${deleting.name}」`);
                setDeleting(null);
              },
            })
          }
        >
          <p>
            <strong>{deleting.name}</strong>
            {deleting.sku ? `（${deleting.sku}）` : ""}
            會被移除，它的操作紀錄會留著。
          </p>
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
