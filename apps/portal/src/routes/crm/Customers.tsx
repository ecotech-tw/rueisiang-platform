import { useState } from "react";
import { useSession } from "../../auth/session.js";
import { Pager } from "../../shell/Pager.js";
import { SortableHeader } from "../../shell/SortableHeader.js";
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
import { Alert, Button, PageHeader, Panel } from "../../ui/index.js";

const CHANNEL_LABEL: Record<string, string> = { manual: "人工建立", cyberbiz: "CYBERBIZ" };
const SYNC_LABEL: Record<string, string> = {
  local_only: "僅本地",
  synced: "已同步",
  failed: "同步失敗",
};

/** 每頁筆數的選項。與後端的 CUSTOMER_PAGE_SIZES 一致。 */
const PAGE_SIZES = [10, 25, 50, 100] as const;

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

  /*
   * data-label 是給手機版用的：窄螢幕時 CSS 把每個 td 變成「標籤 ＋ 值」的一列，
   * 整個 tr 變成一張卡片。用同一份 markup 而不是另外寫一套手機版元件——兩份
   * markup 一定會漂移，而且這裡的差別純粹是排版。
   */
  return (
    <tr>
      <td data-label="客人">
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
      <td data-label="電話" className="whitespace-nowrap">{customer.phone}</td>
      <td data-label="通路">
        <span className={`status status-channel-${customer.sourceChannel}`}>
          {CHANNEL_LABEL[customer.sourceChannel] ?? customer.sourceChannel}
        </span>
      </td>
      <td data-label="地址" className="cell-sub">{customer.address || "—"}</td>
      <td data-label="狀態">
        <span className={`status status-sync-${customer.syncStatus}`}>
          {SYNC_LABEL[customer.syncStatus] ?? customer.syncStatus}
        </span>
        {customer.status === "blocked" ? <span className="status status-disabled">已封鎖</span> : null}
        {customer.syncError ? (
          <div className="cell-sub" title={customer.syncError}>{customer.syncError}</div>
        ) : null}
      </td>
      <td data-label="最近更新" className="cell-sub whitespace-nowrap">{formatDate(customer.updatedAt)}</td>
      {canWrite || canBlock ? (
        <td data-label="操作">
          <div className="row-actions">
            {canWrite ? (
              <Button
                variant="icon"
                icon="edit"
                onClick={onEdit}
                disabled={busy}
                title="編輯客戶資料"
                aria-label={`編輯 ${customer.name || customer.phone}`}
              />
            ) : null}
            {canBlock ? (
              <Button
                variant="icon"
                className={customer.status === "blocked" ? "" : "danger"}
                icon={customer.status === "blocked" ? "unblock" : "block"}
                onClick={onBlock}
                disabled={busy}
                title={customer.status === "blocked" ? "解除封鎖這位客戶" : "封鎖這位客戶"}
                aria-label={`${customer.status === "blocked" ? "解除封鎖" : "封鎖"} ${customer.name || customer.phone}`}
              />
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
  const [showFilters, setShowFilters] = useState(false);
  // 手機上統計預設收起來，把畫面讓給客戶清單。桌機的 CSS 不理這個狀態。

  const query = useCustomers(filters);
  const block = useBlockCustomer();
  const { permissions } = useSession();
  const canWrite = permissions.has("crm:customer:write");
  const canBlock = permissions.has("crm:customer:block");
  const tagOptions = useTagOptions(permissions.has("crm:tag:read"));

  /** 改任何篩選條件都要回到第 1 頁，否則會停在一個新條件下不存在的頁碼。 */
  /*
   * 只算真正在「篩掉資料」的三個。排序與每頁筆數也在同一個面板裡，但它們不會
   * 讓人看不到某些客戶——把它們算進去，數字會在什麼都沒篩的時候就亮著。
   */
  const activeFilterCount = [filters.channel, filters.status, filters.tag].filter(
    (value) => value !== "all",
  ).length;

  /** 點表頭排序。換欄位時 SortableHeader 會給 asc，同一欄再點就翻轉。 */
  function sortBy(sortField: string, sortDirection: "asc" | "desc") {
    update({ sortField, sortDirection });
  }

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
      <PageHeader
        title="客戶列表"
        description="查看、搜尋 CYBERBIZ 與人工建立的客戶資料。"
        actions={canWrite ? (
            <Button
              icon="plus"
              className="add-action"
              onClick={() => setEditing("new")}
              aria-label="新增客人"
            >
              {/* 手機上文字會被 CSS 藏起來，只剩一顆圓形的 ＋。aria-label 補回名稱。 */}
              <span>新增客人</span>
            </Button>
          ) : null}
      />


      <Panel className="grows">
        <SavedViewBar filters={filters} onApply={applyView} canManage={permissions.has("crm:view:write")} />

        <form className="admin-form toolbar" onSubmit={(event) => event.preventDefault()}>
          <input
            className="search-input"
            aria-label="搜尋"
            type="search"
            placeholder="搜尋姓名、電話、Email、地址或標籤"
            value={filters.search}
            onChange={(event) => update({ search: event.target.value })}
          />
          {/*
            * 這顆按鈕只在手機出現（CSS 控制）。窄螢幕放不下三個下拉，收起來時用
            * 數字標出「現在有幾個條件生效中」——那才是收合狀態下最重要的資訊，
            * 不是每個篩選的當前值。桌機直接把下拉攤開，不需要這一步。
            */}
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
              onClick={() => update({ channel: "all", status: "all", tag: "all" })}
            >
              清除篩選
            </Button>
          ) : null}

          {/*
            * 三個下拉直接排在搜尋旁邊。桌機一行放得下，多一顆「篩選」按鈕加一整列
            * 只是把兩次點擊塞進本來就看得到的東西前面。
            * 手機空間不夠才收起來——那顆按鈕與這裡的 open 狀態都只在窄螢幕生效。
            */}
          <div className={`filter-fields${showFilters ? " open" : ""}`}>
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
          </div>
        </form>

        {query.error ? <Alert tone="danger">{query.error.message}</Alert> : null}
        {block.error ? <Alert tone="danger">{block.error.message}</Alert> : null}

        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                {/*
                  * 只有真的排得動的欄位做成可點。通路與狀態是分類，排序沒有意義；
                  * 地址是自由字串，照字典序排也不會有人想看。
                  */}
                <SortableHeader label="客人" field="name" active={filters.sortField} direction={filters.sortDirection} onSort={sortBy} />
                <SortableHeader label="電話" field="phone" active={filters.sortField} direction={filters.sortDirection} onSort={sortBy} />
                <th>通路</th>
                <th>地址</th>
                <th>狀態</th>
                <SortableHeader label="最近更新" field="updatedAt" active={filters.sortField} direction={filters.sortDirection} onSort={sortBy} />
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
          <Pager
            page={data.page}
            pageSize={data.pageSize}
            pageSizes={PAGE_SIZES}
            totalPages={totalPages}
            totalLabel={`共 ${data.total.toLocaleString("zh-TW")} 筆`}
            onPage={(page) => update({ page })}
            onPageSize={(pageSize) => update({ pageSize })}
          />
        ) : null}
      </Panel>

      {editing ? (
        <CustomerForm
          customer={editing === "new" ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}
