import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Icon } from "../../shell/icons.js";
import {
  DEFAULT_FILTERS,
  parseTags,
  useBlockCustomer,
  useCustomers,
  useTagOptions,
  type Customer,
  type CustomerFilters,
  type SavedViewFilters,
} from "./api.js";
import { CustomerForm } from "./CustomerForm.js";
import { SavedViewBar } from "./SavedViewBar.js";
import { usePageTitle } from "../../shell/usePageTitle.js";

const CHANNEL_LABEL: Record<string, string> = { manual: "人工建立", cyberbiz: "CYBERBIZ" };
const SYNC_LABEL: Record<string, string> = {
  local_only: "僅本地",
  synced: "已同步",
  failed: "同步失敗",
};

const SORT_OPTIONS = [
  { value: "updatedAt", label: "最近更新" },
  { value: "createdAt", label: "建立時間" },
  { value: "name", label: "姓名" },
  { value: "phone", label: "電話" },
] as const;

function formatDate(value: string): string {
  if (!value) return "—";
  /*
   * 這一欄有兩種格式：D1 的 CURRENT_TIMESTAMP 是「YYYY-MM-DD HH:MM:SS」而且沒有
   * 時區標記，CYBERBIZ 同步進來的則已經是帶 Z 的 ISO。先前一律補一個 Z，
   * 結果 ISO 那種變成兩個 Z、解析失敗，畫面就直接印出原始字串。
   */
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString("zh-TW", { hour12: false });
}

function CustomerRow({
  customer,
  canWrite,
  canBlock,
  onEdit,
  onBlock,
  busy,
}: {
  customer: Customer;
  canWrite: boolean;
  canBlock: boolean;
  onEdit: () => void;
  onBlock: () => void;
  busy: boolean;
}) {
  const tags = parseTags(customer.cyberbizTagsJson);

  return (
    <tr>
      <td>
        <div className="cell-strong">{customer.name || "未填姓名"}</div>
        <div className="cell-sub">{customer.email || "未填 Email"}</div>
        {tags.length ? (
          <div className="chips tight">
            {tags.slice(0, 3).map((tag) => (
              <span className="chip subtle" key={tag}>{tag}</span>
            ))}
            {tags.length > 3 ? <span className="cell-sub">+{tags.length - 3}</span> : null}
          </div>
        ) : null}
      </td>
      <td className="whitespace-nowrap">{customer.phone}</td>
      <td>
        <span className={`status status-channel-${customer.sourceChannel}`}>
          {CHANNEL_LABEL[customer.sourceChannel] ?? customer.sourceChannel}
        </span>
      </td>
      <td className="cell-sub">{customer.address || "—"}</td>
      <td>
        <span className={`status status-sync-${customer.syncStatus}`}>
          {SYNC_LABEL[customer.syncStatus] ?? customer.syncStatus}
        </span>
        {customer.status === "blocked" ? <span className="status status-disabled">已封鎖</span> : null}
        {customer.syncError ? (
          <div className="cell-sub" title={customer.syncError}>{customer.syncError}</div>
        ) : null}
      </td>
      <td className="cell-sub whitespace-nowrap">{formatDate(customer.updatedAt)}</td>
      {canWrite || canBlock ? (
        <td>
          <div className="row-actions">
            {canWrite ? (
              <button
                type="button"
                className="icon-button"
                onClick={onEdit}
                disabled={busy}
                title="編輯客戶資料"
                aria-label={`編輯 ${customer.name || customer.phone}`}
              >
                <Icon name="edit" />
              </button>
            ) : null}
            {canBlock ? (
              <button
                type="button"
                className={`icon-button${customer.status === "blocked" ? "" : " danger"}`}
                onClick={onBlock}
                disabled={busy}
                title={customer.status === "blocked" ? "解除封鎖這位客戶" : "封鎖這位客戶"}
                aria-label={`${customer.status === "blocked" ? "解除封鎖" : "封鎖"} ${customer.name || customer.phone}`}
              >
                <Icon name={customer.status === "blocked" ? "unblock" : "block"} />
              </button>
            ) : null}
          </div>
        </td>
      ) : null}
    </tr>
  );
}

export function Customers() {
  usePageTitle("客戶列表");
  const [filters, setFilters] = useState<CustomerFilters>(DEFAULT_FILTERS);
  const [editing, setEditing] = useState<Customer | "new" | null>(null);
  const query = useCustomers(filters);
  const block = useBlockCustomer();
  const { permissions } = useSession();
  const canWrite = permissions.has("crm:customer:write");
  const canBlock = permissions.has("crm:customer:block");
  const tagOptions = useTagOptions(permissions.has("crm:tag:read"));

  /** 改任何篩選條件都要回到第 1 頁，否則會停在一個新條件下不存在的頁碼。 */
  function update(patch: Partial<CustomerFilters>) {
    setFilters((current) => ({ ...current, ...patch, page: patch.page ?? 1 }));
  }

  /** 套用視圖是整組換掉，不是疊加——沒存進視圖的條件要跟著回到預設值。 */
  function applyView(view: SavedViewFilters) {
    setFilters({ ...view, page: 1 });
  }

  const data = query.data;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="page fills">
      <header className="page-head">
        <div className="page-head-row">
          <div>
            <h1>客戶列表</h1>
            <p className="muted">查看、搜尋 CYBERBIZ 與人工建立的客戶資料。</p>
          </div>
          {canWrite ? (
            <button type="button" className="primary-button" onClick={() => setEditing("new")}>
              ＋ 新增客人
            </button>
          ) : null}
        </div>
      </header>

      {data ? (
        <div className="stat-row">
          <div className="stat"><span>全部</span><strong>{data.stats.total}</strong></div>
          <div className="stat"><span>正常</span><strong>{data.stats.active}</strong></div>
          <div className="stat"><span>已封鎖</span><strong>{data.stats.blocked}</strong></div>
          <div className="stat"><span>資料不完整</span><strong>{data.stats.incomplete}</strong></div>
        </div>
      ) : null}

      <section className="panel grows">
        <SavedViewBar filters={filters} onApply={applyView} canManage={permissions.has("crm:view:write")} />

        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <input
            aria-label="搜尋"
            type="search"
            placeholder="搜尋姓名、電話、Email、地址或標籤"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          <select
            aria-label="通路"
            value={filters.channel}
            onChange={(event) => update({ channel: event.target.value })}
          >
            <option value="all">全部通路</option>
            <option value="cyberbiz">CYBERBIZ</option>
            <option value="manual">人工建立</option>
          </select>
          <select
            aria-label="狀態"
            value={filters.status}
            onChange={(event) => update({ status: event.target.value })}
          >
            <option value="all">全部狀態</option>
            <option value="active">正常</option>
            <option value="blocked">已封鎖</option>
          </select>
          {tagOptions.data?.length ? (
            <select
              aria-label="標籤"
              value={filters.tag}
              onChange={(event) => update({ tag: event.target.value })}
            >
              <option value="all">全部標籤</option>
              {tagOptions.data.map((tag) => (
                <option key={tag.name} value={tag.name}>
                  {tag.name}（{tag.customerCount}）
                </option>
              ))}
            </select>
          ) : null}
          <select
            aria-label="排序"
            value={filters.sortField}
            onChange={(event) => update({ sortField: event.target.value })}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select
            aria-label="排序方向"
            value={filters.sortDirection}
            onChange={(event) => update({ sortDirection: event.target.value as "asc" | "desc" })}
          >
            <option value="desc">由新到舊</option>
            <option value="asc">由舊到新</option>
          </select>
          <select
            aria-label="每頁筆數"
            value={String(filters.pageSize)}
            onChange={(event) => update({ pageSize: Number(event.target.value) })}
          >
            {[10, 25, 50, 100].map((size) => (
              <option key={size} value={size}>每頁 {size} 筆</option>
            ))}
          </select>
        </form>

        {query.error ? <p className="form-error" role="alert">{query.error.message}</p> : null}
        {block.error ? <p className="form-error" role="alert">{block.error.message}</p> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>客人</th>
                <th>電話</th>
                <th>通路</th>
                <th>地址</th>
                <th>狀態</th>
                <th>最近更新</th>
                {canWrite || canBlock ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {data?.customers.map((customer) => (
                <CustomerRow
                  key={customer.id}
                  customer={customer}
                  canWrite={canWrite}
                  canBlock={canBlock}
                  busy={block.isPending}
                  onEdit={() => setEditing(customer)}
                  onBlock={() =>
                    block.mutate({ id: customer.id, blocked: customer.status !== "blocked" })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>

        {query.isPending ? <p className="muted table-note">載入中…</p> : null}

        {data && data.customers.length === 0 ? (
          <p className="muted table-note">
            {data.stats.total === 0
              ? "還沒有任何客戶資料。CYBERBIZ 同步搬進來之後，資料會從官網流進這裡。"
              : "沒有符合條件的客戶，調整一下搜尋或篩選看看。"}
          </p>
        ) : null}

        {data && data.total > 0 ? (
          <footer className="pager">
            <span className="cell-sub">
              第 {data.page}／{totalPages} 頁，共 {data.total} 筆
            </span>
            <div className="pager-buttons">
              <button
                type="button"
                className="ghost-button"
                disabled={data.page <= 1}
                onClick={() => update({ page: data.page - 1 })}
              >
                上一頁
              </button>
              <button
                type="button"
                className="ghost-button"
                disabled={data.page >= totalPages}
                onClick={() => update({ page: data.page + 1 })}
              >
                下一頁
              </button>
            </div>
          </footer>
        ) : null}
      </section>

      {editing ? (
        <CustomerForm
          customer={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
